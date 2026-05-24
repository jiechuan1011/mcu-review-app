/*
 * Copyright (c) 2026 微机原理复习宝典
 * 早晚复习打卡 TodoList
 *
 * 数据闭环：
 *   早上（00:00 ~ 12:00 生成）：
 *     □ 完成"新概念挖空速记"：3 个未刷过的笔记 subsection
 *     □ 清算昨日错题：所有 mc_cloze_yellow_v1 里 lastTs 落在昨日的 blankId
 *   晚上（>= 12:00 生成）：
 *     □ 自动派生题源 10 道（fill+choice 混合）
 *     □ 全天错题清算：当日 mc_cloze_yellow_v1 中的全部
 *
 * 状态联动：
 *   - 完成挖空任务时调用 DailyReview.markBlankDone(blankId)
 *   - 完成自动题时调用 DailyReview.markQuestionDone(taskKey)
 */

(function (global) {
  'use strict';

  function pickN(arr, n) {
    const a = arr.slice();
    const out = [];
    while (a.length && out.length < n) {
      const i = Math.floor(Math.random() * a.length);
      out.push(a.splice(i, 1)[0]);
    }
    return out;
  }

  function listSubsectionRefs(tree) {
    const refs = [];
    tree.sections.forEach((sec, si) => sec.subsections.forEach((sub, subi) => {
      refs.push({ secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, id: sub.id });
    }));
    return refs;
  }

  function yesterdayWrongs() {
    const yellow = ClozeState.listYellow();
    const dayMs = 24 * 3600 * 1000;
    const now = Date.now();
    const start = now - dayMs;
    const out = [];
    for (const [bid, rec] of Object.entries(yellow)) {
      if (rec.lastTs >= start && rec.lastTs < now - dayMs / 2) out.push({ bid, rec });
    }
    return out;
  }

  function todayWrongs() {
    const yellow = ClozeState.listYellow();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const out = [];
    for (const [bid, rec] of Object.entries(yellow)) {
      if (rec.lastTs >= todayStart.getTime()) out.push({ bid, rec });
    }
    return out;
  }

  const DailyReview = {
    /** 生成或读取今天的 TodoList。idempotent。 */
    ensureToday(tree, generated) {
      const dateKey = ClozeState.todayKey();
      let day = ClozeState.getTodo(dateKey);
      const hour = new Date().getHours();
      const slot = hour < 12 ? 'morning' : 'evening';

      if (day && day[slot] && day[slot].length) return { dateKey, slot, day };

      // 生成 morning
      if (slot === 'morning' || !day || !day.morning) {
        const subs = listSubsectionRefs(tree);
        const pickedSubs = pickN(subs, 3);
        const yWrongs = yesterdayWrongs();
        const tasks = [
          ...pickedSubs.map((s, i) => ({
            id: `m_new_${dateKey}_${i}`,
            kind: 'cloze-subsection',
            title: `挖空速记：${s.subTitle}`,
            payload: { secIdx: s.secIdx, subIdx: s.subIdx, id: s.id },
            done: false, doneTs: 0
          })),
          ...(yWrongs.length ? [{
            id: `m_wrong_${dateKey}`,
            kind: 'wrong-recall',
            title: `唤醒昨日错题（${yWrongs.length} 处）`,
            payload: { blankIds: yWrongs.map(x => x.bid) },
            done: false, doneTs: 0
          }] : [])
        ];
        ClozeState.setTodo(dateKey, 'morning', tasks);
      }

      // 生成 evening
      if (slot === 'evening' && (!day || !day.evening || !day.evening.length)) {
        const allQuestions = [
          ...generated.fillBlank.groups.flatMap(g => g.items.map((q, i) => ({ type: 'fill', q, idx: i, gTitle: g.title }))),
          ...generated.choice.map(q => ({ type: 'choice', q })),
          ...generated.trueFalse.map(q => ({ type: 'tf', q }))
        ];
        const pickedQs = pickN(allQuestions, 10);
        const tWrongs = todayWrongs();
        const tasks = [
          ...pickedQs.map((p, i) => ({
            id: `e_q_${dateKey}_${i}`,
            kind: 'derived-question',
            title: `${p.type === 'fill' ? '填空' : p.type === 'choice' ? '选择' : '判断'}：${(p.q.question || p.q.text).slice(0, 40)}…`,
            payload: { qType: p.type, q: p.q },
            done: false, doneTs: 0
          })),
          ...(tWrongs.length ? [{
            id: `e_wrong_${dateKey}`,
            kind: 'wrong-recall',
            title: `清算今日错题（${tWrongs.length} 处）`,
            payload: { blankIds: tWrongs.map(x => x.bid) },
            done: false, doneTs: 0
          }] : [])
        ];
        ClozeState.setTodo(dateKey, 'evening', tasks);
      }
      day = ClozeState.getTodo(dateKey);
      return { dateKey, slot, day };
    },

    /** 当一个 cloze input 被判正确，检查能否完成"挖空 subsection"任务 */
    markBlankDone(blankId) {
      const dateKey = ClozeState.todayKey();
      const day = ClozeState.getTodo(dateKey);
      if (!day) return;
      ['morning', 'evening'].forEach(slot => {
        (day[slot] || []).forEach(task => {
          if (task.done) return;
          if (task.kind === 'wrong-recall' && task.payload.blankIds.includes(blankId)) {
            const allCleared = task.payload.blankIds.every(b => !ClozeState.isYellow(b));
            if (allCleared) ClozeState.tickTodo(dateKey, slot, task.id);
          }
          if (task.kind === 'cloze-subsection' && blankId.startsWith(`cz_${task.payload.secIdx}_${task.payload.subIdx}_`)) {
            // 检查该 subsection 下所有 cloze input 是否都不是黄色（一次通过）
            const rootSel = `[data-section-id="${task.payload.id ? task.payload.id.split('_').slice(0,2).join('_') : ''}"]`;
            // 退一步：只要这个 subsection 区域内全部输入框都被锁定 (cloze-correct) 即算完成
            const inputs = document.querySelectorAll(`input.cloze-input[data-blank-id^="cz_${task.payload.secIdx}_${task.payload.subIdx}_"]`);
            if (inputs.length === 0) return;
            const allDone = Array.from(inputs).every(el => el.classList.contains('cloze-correct') || el.readOnly);
            if (allDone) ClozeState.tickTodo(dateKey, slot, task.id);
          }
        });
      });
    },

    /** 自动派生题完成时调用 */
    markQuestionDone(taskId) {
      const dateKey = ClozeState.todayKey();
      const day = ClozeState.getTodo(dateKey);
      if (!day) return;
      ['morning', 'evening'].forEach(slot => {
        const task = (day[slot] || []).find(t => t.id === taskId);
        if (task) ClozeState.tickTodo(dateKey, slot, task.id);
      });
    },

    renderHtml(state) {
      const { dateKey, slot, day } = state;
      const formatList = (slotKey, list) => {
        if (!list || !list.length) return `<p class="dr-empty">暂无任务</p>`;
        const total = list.length;
        const done = list.filter(t => t.done).length;
        const items = list.map(t => `
          <li class="dr-item ${t.done ? 'done' : ''}">
            <label>
              <input type="checkbox" ${t.done ? 'checked' : ''}
                onchange="DailyReview._toggle('${slotKey}','${t.id}', this.checked)">
              <span class="dr-text" data-task-kind="${t.kind}">${t.title}</span>
            </label>
          </li>`).join('');
        return `
          <div class="dr-progress">已完成 ${done} / ${total}</div>
          <ul class="dr-list">${items}</ul>`;
      };
      return `
        <div class="dr-board">
          <div class="dr-day">${dateKey} · 当前 ${slot === 'morning' ? '早上' : '晚上'}</div>
          <div class="dr-slot ${slot === 'morning' ? 'active' : ''}">
            <h3>🌅 早上打卡 · 概念速记 + 昨日错题</h3>
            ${formatList('morning', day && day.morning)}
          </div>
          <div class="dr-slot ${slot === 'evening' ? 'active' : ''}">
            <h3>🌙 晚上打卡 · 派生题源 + 今日错题</h3>
            ${formatList('evening', day && day.evening)}
          </div>
        </div>`;
    },

    _toggle(slot, taskId, checked) {
      const dateKey = ClozeState.todayKey();
      if (checked) ClozeState.tickTodo(dateKey, slot, taskId);
      else ClozeState.untickTodo(dateKey, slot, taskId);
    }
  };

  global.DailyReview = DailyReview;
})(window);
