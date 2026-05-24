/*
 * Copyright (c) 2026 微机原理复习宝典
 * 挖空记忆 / 错题 / 早晚打卡的统一状态层
 *
 * 设计思路：所有可变状态都收敛到一个文件，未来要换 IndexedDB 只改这里。
 * 三类持久化键：
 *   mc_cloze_yellow_v1  : { [blankId]: { wrong:n, correct:n, lastTs, expected, actual } }
 *   mc_cloze_session_v1 : { generatedAt, totalAttempt, totalCorrect }
 *   mc_daily_todo_v1    : { [yyyy-mm-dd]: { morning:[...], evening:[...] } }
 */

(function (global) {
  'use strict';

  const KEY_YELLOW = 'mc_cloze_yellow_v1';
  const KEY_SESSION = 'mc_cloze_session_v1';
  const KEY_TODO = 'mc_daily_todo_v1';

  function safeLoad(key, fallback) {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
    catch (e) { return fallback; }
  }
  function safeSave(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  const ClozeState = {
    /* ---- 标黄错题表 ---- */

    _yellow: safeLoad(KEY_YELLOW, {}),
    listYellow() { return this._yellow; },
    isYellow(blankId) { return !!this._yellow[blankId]; },
    recordResult(blankId, isCorrect, expected, actual) {
      const rec = this._yellow[blankId] || { wrong: 0, correct: 0, lastTs: 0, expected, actual: '' };
      if (isCorrect) {
        rec.correct = (rec.correct || 0) + 1;
        // 连续答对 2 次后退出标黄
        if (rec.correct >= 2) {
          delete this._yellow[blankId];
          safeSave(KEY_YELLOW, this._yellow);
          this._bumpSession(true);
          return { evicted: true };
        }
      } else {
        rec.wrong = (rec.wrong || 0) + 1;
        rec.correct = 0;
        rec.actual = actual || '';
        rec.expected = expected || rec.expected;
      }
      rec.lastTs = Date.now();
      this._yellow[blankId] = rec;
      safeSave(KEY_YELLOW, this._yellow);
      this._bumpSession(isCorrect);
      return { evicted: false };
    },
    clearYellow(blankId) {
      delete this._yellow[blankId];
      safeSave(KEY_YELLOW, this._yellow);
    },

    /* ---- 会话统计：用于看板 ---- */

    _session: safeLoad(KEY_SESSION, { generatedAt: Date.now(), totalAttempt: 0, totalCorrect: 0 }),
    _bumpSession(isCorrect) {
      this._session.totalAttempt++;
      if (isCorrect) this._session.totalCorrect++;
      safeSave(KEY_SESSION, this._session);
    },
    sessionStats() { return Object.assign({}, this._session); },

    /* ---- 早晚打卡 TodoList ---- */

    _todo: safeLoad(KEY_TODO, {}),
    todayKey() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    },
    yesterdayKey() {
      const d = new Date(Date.now() - 24 * 3600 * 1000);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    },
    getTodo(dateKey) {
      return this._todo[dateKey] || null;
    },
    setTodo(dateKey, slot, items) {
      const day = this._todo[dateKey] || { morning: [], evening: [] };
      day[slot] = items;
      this._todo[dateKey] = day;
      safeSave(KEY_TODO, this._todo);
    },
    tickTodo(dateKey, slot, taskId) {
      const day = this._todo[dateKey];
      if (!day) return;
      const list = day[slot] || [];
      const t = list.find(x => x.id === taskId);
      if (t) { t.done = true; t.doneTs = Date.now(); safeSave(KEY_TODO, this._todo); }
    },
    untickTodo(dateKey, slot, taskId) {
      const day = this._todo[dateKey];
      if (!day) return;
      const list = day[slot] || [];
      const t = list.find(x => x.id === taskId);
      if (t) { t.done = false; t.doneTs = 0; safeSave(KEY_TODO, this._todo); }
    },

    /* ---- 工具 ---- */

    purgeAllForTest() {
      localStorage.removeItem(KEY_YELLOW);
      localStorage.removeItem(KEY_SESSION);
      localStorage.removeItem(KEY_TODO);
      this._yellow = {}; this._todo = {};
      this._session = { generatedAt: Date.now(), totalAttempt: 0, totalCorrect: 0 };
    }
  };

  global.ClozeState = ClozeState;
})(window);
