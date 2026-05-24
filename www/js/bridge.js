/*
 * Copyright (c) 2026 微机原理复习宝典
 * 适配层：把笔记派生的题目铸成旧 UI 期望的 window.QUESTIONS / window.NOTES 形状，
 * 并提供启动入口 Bridge.boot()。
 *
 * 旧 UI 期望的 QUESTIONS 形状（来自 www/index.html 原 const）：
 *   {
 *     fillBlank: { title, groups: [{ title, tag, items:[{ blanks:[...], text }] }] },
 *     choice:    [{ id, question, tag, options:[A./B./C./D.], answer, explanation }],
 *     trueFalse: [{ id, question, tag, answer:boolean, explanation }],
 *     shortAnswer:[],  programming:[],  comprehensive:[],  memoryExpansion:[]
 *   }
 *   NOTES 形状：[ { id, icon, color, title, content:html } ]  ← 由 NotesRenderer 折叠版生成
 */

(function (global) {
  'use strict';

  async function loadTree() {
    const res = await fetch('data/notes.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('notes.json load failed: ' + res.status);
    return res.json();
  }

  // 把派生 question generator 输出整形为旧 UI 用的形状
  function shapeQuestions(generated) {
    return {
      fillBlank: generated.fillBlank,
      choice: generated.choice,
      trueFalse: generated.trueFalse,
      shortAnswer: [],
      programming: [],
      comprehensive: [],
      memoryExpansion: []
    };
  }

  // 旧 NOTES：每个 section 一张卡片，sections 里 subsections 全部内联
  function shapeNotes(tree, preYellowFn) {
    const out = [];
    const ICONS = ['🖥️', '🔔', '⏱️', '🔌', '💾', '📡', '⚙️', '📝'];
    const COLORS = ['#dbeafe', '#fce7f3', '#d1fae5', '#fef3c7', '#ffedd5', '#fce4ec', '#ede9fe', '#e0e7ff'];
    tree.sections.forEach((sec, si) => {
      const html = (() => {
        const intro = sec.intro_blocks.map((b, bi) => NotesRenderer.renderBlock(b, `cz_${si}_i${bi}`, 'view', preYellowFn)).join('');
        const subs = sec.subsections.map((sub, subi) => {
          const inner = sub.blocks.map((b, bi) => NotesRenderer.renderBlock(b, `cz_${si}_${subi}_b${bi}`, 'view', preYellowFn)).join('');
          return `<h3>${sub.title.replace(/</g, '&lt;')}</h3>${inner}`;
        }).join('');
        return intro + subs;
      })();
      out.push({
        id: sec.id,
        icon: ICONS[si % ICONS.length],
        color: COLORS[si % COLORS.length],
        title: sec.title,
        content: html
      });
    });
    return out;
  }

  /** 进入挖空模式：把笔记容器内容替换为 cloze 渲染 */
  function enterClozeMode(tree, mode) {
    const container = document.getElementById('notesContainer');
    if (!container) return;
    const preYellowFn = (bid) => ClozeState.isYellow(bid);
    container.innerHTML = NotesRenderer.renderTree(tree, mode || 'cloze-key', preYellowFn);
    ClozeTimer.attach(container, {
      onGrade(blankId, isCorrect, actual, expected) {
        ClozeState.recordResult(blankId, isCorrect, expected, actual);
        DailyReview.markBlankDone(blankId);
        if (typeof updateClozeProgress === 'function') updateClozeProgress();
      }
    });
    if (typeof updateClozeProgress === 'function') updateClozeProgress();
  }

  function exitClozeMode(tree) {
    const container = document.getElementById('notesContainer');
    if (!container) return;
    const preYellowFn = (bid) => ClozeState.isYellow(bid);
    container.innerHTML = NotesRenderer.renderTree(tree, 'view', preYellowFn);
  }

  /** 全局唯一启动入口 */
  async function boot() {
    const tree = await loadTree();
    const generated = QuestionGenerator.generate(tree);
    const questions = shapeQuestions(generated);

    // 暴露给旧 UI
    global.__NOTES_TREE = tree;
    global.__GENERATED = generated;
    global.NOTES = shapeNotes(tree, (bid) => ClozeState.isYellow(bid));
    global.QUESTIONS = questions;
    // 旧版"新题"模块的 5 个键 —— 缺一个就会 .map throw。
    // fill 用 fillBlank.groups 摊平；prog/mem 暂无源头，保持空数组。
    global.GENERATED_POOL = {
      choice: questions.choice,
      fill: questions.fillBlank.groups.flatMap(g =>
        g.items.map(it => ({ text: it.text, blanks: it.blanks, tag: g.tag }))),
      tf: questions.trueFalse,
      prog: [],
      mem: []
    };

    // 暴露切换钩子供 HTML 内联事件调用
    global.Bridge = {
      tree, generated,
      enterCloze: () => enterClozeMode(tree, 'cloze-key'),
      enterClozeDense: () => enterClozeMode(tree, 'cloze'),
      exitCloze: () => exitClozeMode(tree),
      refreshDailyReview() {
        const host = document.getElementById('dailyReviewBoard');
        if (!host) return;
        const state = DailyReview.ensureToday(tree, generated);
        host.innerHTML = DailyReview.renderHtml(state);
      },
      regenerate() {
        const fresh = QuestionGenerator.generate(tree);
        global.__GENERATED = fresh;
        const q = shapeQuestions(fresh);
        global.QUESTIONS = q;
        global.GENERATED_POOL = {
          choice: q.choice,
          fill: q.fillBlank.groups.flatMap(g =>
            g.items.map(it => ({ text: it.text, blanks: it.blanks, tag: g.tag }))),
          tf: q.trueFalse,
          prog: [],
          mem: []
        };
        if (typeof renderPracticeNav === 'function') renderPracticeNav();
        if (typeof switchSection === 'function' && typeof currentSection !== 'undefined') switchSection(currentSection);
      }
    };

    // 派发就绪事件并直接驱动 UI 渲染
    document.dispatchEvent(new CustomEvent('notes-ready', { detail: { tree, generated } }));
    // 兜底：即便监听器还没注册，也直接调用全局函数把 UI 拉起来
    if (typeof global.rerenderNotes === 'function') global.rerenderNotes();
    if (typeof global.renderPracticeNav === 'function') global.renderPracticeNav();
    if (typeof global.switchSection === 'function' && typeof global.currentSection !== 'undefined') {
      global.switchSection(global.currentSection);
    }
    if (typeof global.Bridge.refreshDailyReview === 'function') global.Bridge.refreshDailyReview();
  }

  // start 是模块级的立即启动入口（不依赖 DOMContentLoaded 时序）
  function start() {
    boot().catch(err => {
      console.error('[Bridge.boot] failed:', err);
      const box = document.getElementById('notesContainer');
      if (box) box.innerHTML = `<div class="card" style="padding:20px;color:#b91c1c">加载笔记源失败：${err.message}<br>请先在仓库根目录运行 <code>node scripts/build-notes.js</code></div>`;
    });
  }
  // 外部保留 { boot } 供手动重试
  global.BridgeBoot = start;
  start();
})(window);
