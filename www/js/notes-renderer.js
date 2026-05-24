/*
 * Copyright (c) 2026 微机原理复习宝典
 * notes.json 渲染器 —— 把笔记树渲染成 HTML，并在指定模式下生成挖空 input。
 *
 * 三种渲染模式：
 *   - 'view'       : 标准浏览模式，关键概念仅高亮
 *   - 'cloze'      : 全文高密度挖空（含粗体关键 + 数字/单位/十六进制）
 *   - 'cloze-key'  : 只挖粗体关键概念（防止挖空过密干扰）
 *
 * blankId 形如 cz_{sectionIdx}_{subIdx}_{blockIdx}_{itemIdx}_{spanIdx}_{slotIdx}
 * 同一笔记位置每次生成的 ID 稳定，方便和 ClozeState 错题表对齐。
 */

(function (global) {
  'use strict';

  // 两组挖空候选：
  //   KEY  - 关键挖空模式（cloze-key）也启用：含单位的数字、十六进制
  //   EXTRA - 仅高密度模式（cloze）启用：孤立纯数字
  const CLOZE_KEY_RE = [
    /\b[0-9A-F]{1,5}H\b/g,                                       // 03E8H, FFH
    /\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|kHz|MHz|Hz|位|根|片|级|个|字节|分|题)\b/gi,
    /\b7N\s*\+\s*1\b/g,                                          // 7N+1
    /A\d{1,2}\s*[~～-]\s*A\d{1,2}\b/g                            // A19~A0
  ];
  const CLOZE_EXTRA_RE = [
    /\b\d+(?:\.\d+)?\b/g                                         // 任意纯数字
  ];

  // 引导词识别 —— 与 question-generator 的 isLabelKey 保持一致
  function isLabelKey(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/[：:]\s*$/.test(t)) return true;
    if (/^[⚠🔥★☆▶◆●○✦✧❗❓]/.test(t)) return true;
    if (/提醒|警示|警告|注意|公式$|模板$|步骤$|说明$|总结$|核心做题/.test(t)) return true;
    if (t.length <= 4 && /^(分组|寄存器|默认段|记忆点|方式|名称|特点|分值|说明|大题|题型|端口|地址|功能|备注)$/.test(t)) return true;
    return false;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function inputHtml(blankId, answer, preYellow) {
    const ans = escapeAttr(answer);
    const size = Math.max(2, Math.min(12, answer.length + 1));
    return `<input class="cloze-input" type="text" autocomplete="off" spellcheck="false"`
      + ` data-blank-id="${blankId}" data-answer="${ans}" title="${ans}"`
      + ` size="${size}" placeholder=""${preYellow ? ' data-pre-yellow="1"' : ''}>`;
  }

  // 把单段 plain 文本按 regex 列表挖成 [{text},{blank}]
  function tokenizeForExtras(text, baseBlankId, preYellowFn, regexList) {
    const hits = [];
    for (const re of regexList) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, ans: m[0] });
      }
    }
    // 去重叠：较长 / 较早优先
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const merged = [];
    let lastEnd = -1;
    for (const h of hits) {
      if (h.start >= lastEnd) { merged.push(h); lastEnd = h.end; }
    }
    if (!merged.length) return [{ kind: 'text', text }];

    const out = [];
    let p = 0;
    merged.forEach((h, i) => {
      if (h.start > p) out.push({ kind: 'text', text: text.slice(p, h.start) });
      const blankId = `${baseBlankId}_x${i}`;
      out.push({ kind: 'blank', blankId, answer: h.ans, preYellow: preYellowFn(blankId) });
      p = h.end;
    });
    if (p < text.length) out.push({ kind: 'text', text: text.slice(p) });
    return out;
  }

  /**
   * 把一组 spans (来自 notes.json) 渲染成 HTML。
   * baseBlankId: 该 spans 所在位置的稳定前缀
   * mode: 'view' | 'cloze' | 'cloze-key'
   * preYellowFn(blankId) → 是否预先标黄（错题）
   */
  function renderSpans(spans, baseBlankId, mode, preYellowFn) {
    if (!spans || !spans.length) return '';
    const html = [];
    // 关键挖空：粗体非标签 + 含单位数字。高密度：加上所有数字。
    const extraRegex = mode === 'cloze' ? [...CLOZE_KEY_RE, ...CLOZE_EXTRA_RE]
                     : mode === 'cloze-key' ? CLOZE_KEY_RE
                     : null;
    spans.forEach((sp, idx) => {
      if (sp.kind === 'key') {
        if (mode === 'view' || isLabelKey(sp.text)) {
          html.push(`<span class="key">${escapeHtml(sp.text)}</span>`);
        } else {
          const blankId = `${baseBlankId}_s${idx}`;
          html.push(inputHtml(blankId, sp.text, preYellowFn(blankId)));
        }
      } else {
        if (extraRegex) {
          const parts = tokenizeForExtras(sp.text, `${baseBlankId}_s${idx}`, preYellowFn, extraRegex);
          for (const part of parts) {
            if (part.kind === 'text') html.push(escapeHtml(part.text).replace(/\n/g, '<br>'));
            else html.push(inputHtml(part.blankId, part.answer, part.preYellow));
          }
        } else {
          html.push(escapeHtml(sp.text).replace(/\n/g, '<br>'));
        }
      }
    });
    return html.join('');
  }

  function renderBlock(block, baseId, mode, preYellowFn) {
    if (block.type === 'para') {
      return `<p>${renderSpans(block.spans, baseId + '_p', mode, preYellowFn)}</p>`;
    }
    if (block.type === 'code') {
      const text = escapeHtml(block.text);
      return `<pre class="asm-code">${text}</pre>`;
    }
    if (block.type === 'list') {
      const items = block.items.map((it, i) =>
        `<li>${renderSpans(it.spans, baseId + '_li' + i, mode, preYellowFn)}</li>`
      ).join('');
      return `<ul>${items}</ul>`;
    }
    if (block.type === 'table') {
      let head = '';
      if (block.header) {
        const ths = block.header.map((c, i) =>
          `<th>${renderSpans(c.spans, baseId + '_th' + i, mode, preYellowFn)}</th>`
        ).join('');
        head = `<thead><tr>${ths}</tr></thead>`;
      }
      const body = block.rows.map((row, ri) => {
        const tds = row.map((c, ci) =>
          `<td>${renderSpans(c.spans, baseId + '_r' + ri + 'c' + ci, mode, preYellowFn)}</td>`
        ).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<div class="notes-table-wrap"><table class="notes-table">${head}<tbody>${body}</tbody></table></div>`;
    }
    return '';
  }

  /**
   * 渲染整棵笔记树。
   * 返回 HTML 字符串：每个 section 一张卡片，subsection 展开。
   * 调用方负责把字符串插入 DOM，然后 ClozeTimer.attach(root, callbacks)
   */
  const SECTION_ICONS = ['🖥️', '🔔', '⏱️', '🔌', '💾', '📡', '⚙️', '📝'];
  const SECTION_COLORS = ['#dbeafe', '#fce7f3', '#d1fae5', '#fef3c7', '#ffedd5', '#fce4ec', '#ede9fe', '#e0e7ff'];

  function renderTree(tree, mode, preYellowFn) {
    mode = mode || 'view';
    preYellowFn = preYellowFn || (() => false);
    const out = [];
    if (tree.title) out.push(`<div class="notes-title-bar"><h2>${escapeHtml(tree.title)}</h2><p>${escapeHtml(tree.subtitle || '')}</p></div>`);
    tree.sections.forEach((sec, si) => {
      const baseId = `cz_${si}`;
      const introHtml = sec.intro_blocks.map((b, bi) => renderBlock(b, baseId + '_i' + bi, mode, preYellowFn)).join('');
      const subsHtml = sec.subsections.map((sub, subi) => {
        const subBase = baseId + '_' + subi;
        const blocksHtml = sub.blocks.map((b, bi) => renderBlock(b, subBase + '_b' + bi, mode, preYellowFn)).join('');
        return `
          <div class="notes-subsection">
            <h3>${escapeHtml(sub.title)}</h3>
            <div class="notes-sub-body">${blocksHtml}</div>
          </div>`;
      }).join('');
      out.push(`
        <div class="card notes-card" data-section-id="${sec.id}">
          <button class="topic-btn${si === 0 ? ' open' : ''}" type="button" onclick="toggleNotesSection(this)">
            <span class="icon" style="background:${SECTION_COLORS[si % SECTION_COLORS.length]}">${SECTION_ICONS[si % SECTION_ICONS.length]}</span>
            <span>${escapeHtml(sec.title)}</span>
            <span class="arrow">▶</span>
          </button>
          <div class="topic-content${si === 0 ? ' open' : ''}">
            <div class="topic-inner notes-card-body">
              ${introHtml}${subsHtml}
            </div>
          </div>
        </div>`);
    });
    return out.join('');
  }

  global.NotesRenderer = {
    renderTree,
    renderBlock,
    renderSpans
  };
})(window);
