/*
 * Copyright (c) 2026 微机原理复习宝典
 * 5 秒防抖自动评测引擎
 *
 * 行为契约：
 *   1. 用户在 input 中停止输入满 IDLE_MS 毫秒 → 自动判定。
 *   2. IDLE_MS 内重新输入 → 倒计时重置（防抖）。
 *   3. 失焦或 Enter 立即判定，跳过等待。
 *   4. 空内容不触发判定。
 *   5. 已判定为正确（已锁定）的格子不再受输入影响。
 *
 * 用法：
 *   ClozeTimer.attach(rootEl, {
 *     onGrade(blankId, isCorrect, actual, expected) { ... }
 *   });
 *   每个挖空 input 必须有：
 *     - class="cloze-input"
 *     - data-blank-id="cz_xxx"
 *     - data-answer="正确答案"  （多个候选用 | 分隔，比较时去空格/中英文标点统一）
 */

(function (global) {
  'use strict';

  const IDLE_MS = 5000;

  // 归一化：去除首尾空白；半角等价；汉字数字 → 阿拉伯数字（基础几个）
  function normalize(s) {
    if (s == null) return '';
    let v = String(s).trim();
    // 中英文标点对齐
    v = v.replace(/，/g, ',').replace(/：/g, ':').replace(/；/g, ';');
    // 全角字母数字 → 半角
    v = v.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    // 统一空白
    v = v.replace(/\s+/g, '');
    // 大小写不敏感
    return v.toLowerCase();
  }

  function grade(actual, expectedRaw) {
    const actNorm = normalize(actual);
    if (!actNorm) return false;
    const candidates = String(expectedRaw || '').split('|').map(normalize).filter(Boolean);
    if (!candidates.length) return false;
    for (const c of candidates) {
      if (actNorm === c) return true;
      // 数字宽松匹配：去掉单位中常见尾缀 KB/H/B/位/根
      const stripUnit = x => x.replace(/(kb|mb|b|h|位|根|个|片|级)$/i, '');
      if (stripUnit(actNorm) === stripUnit(c)) return true;
    }
    return false;
  }

  const TIMER_KEY = '__czTimer';
  const LOCKED_KEY = '__czLocked';

  function clearPending(input) {
    if (input[TIMER_KEY]) {
      clearTimeout(input[TIMER_KEY]);
      input[TIMER_KEY] = null;
    }
  }

  function ringActive(input) {
    input.classList.add('cloze-pending');
    input.classList.remove('cloze-correct');
    input.classList.remove('cloze-wrong');
  }

  function decideNow(input, callbacks) {
    if (input[LOCKED_KEY]) return;
    const blankId = input.dataset.blankId;
    const expected = input.dataset.answer || '';
    const actual = input.value;
    if (!actual.trim()) {
      input.classList.remove('cloze-pending');
      return;
    }
    clearPending(input);
    input.classList.remove('cloze-pending');
    const ok = grade(actual, expected);
    if (ok) {
      input.classList.add('cloze-correct');
      input.classList.remove('cloze-wrong');
      input[LOCKED_KEY] = true;
      input.setAttribute('readonly', 'readonly');
    } else {
      input.classList.add('cloze-wrong');
      input.classList.remove('cloze-correct');
    }
    if (callbacks && typeof callbacks.onGrade === 'function') {
      callbacks.onGrade(blankId, ok, actual, expected);
    }
  }

  function scheduleDecide(input, callbacks) {
    if (input[LOCKED_KEY]) return;
    clearPending(input);
    if (!input.value.trim()) {
      input.classList.remove('cloze-pending');
      return;
    }
    ringActive(input);
    input[TIMER_KEY] = setTimeout(() => decideNow(input, callbacks), IDLE_MS);
  }

  const ClozeTimer = {
    IDLE_MS,
    grade,
    /** 把一个根容器内所有 .cloze-input 接入计时引擎 */
    attach(rootEl, callbacks) {
      if (!rootEl) return;
      const inputs = rootEl.querySelectorAll('input.cloze-input');
      inputs.forEach(input => this._bindOne(input, callbacks));
    },
    _bindOne(input, callbacks) {
      if (input.__czBound) return;
      input.__czBound = true;
      // 已经被标黄过的：UI 提示
      if (input.dataset.preYellow === '1') {
        input.classList.add('cloze-wrong');
      }
      input.addEventListener('input', () => scheduleDecide(input, callbacks));
      input.addEventListener('blur', () => decideNow(input, callbacks));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); decideNow(input, callbacks); }
      });
      // 用户点击错误格子查看正确答案
      input.addEventListener('click', () => {
        if (input.classList.contains('cloze-wrong')) {
          const t = input.getAttribute('title');
          if (t) {
            // 用 placeholder 透出正确答案，再清一秒
            const oldPh = input.placeholder;
            input.placeholder = t;
            setTimeout(() => { input.placeholder = oldPh; }, 2000);
          }
        }
      });
    },
    /** 解锁某个格子重新作答 */
    unlock(blankId) {
      const el = document.querySelector(`input.cloze-input[data-blank-id="${blankId}"]`);
      if (!el) return;
      el[LOCKED_KEY] = false;
      el.removeAttribute('readonly');
      el.value = '';
      el.classList.remove('cloze-correct', 'cloze-wrong', 'cloze-pending');
    }
  };

  global.ClozeTimer = ClozeTimer;
})(window);
