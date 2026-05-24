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

  // 高密度模式额外挖空的正则：阿拉伯数字+可选单位、十六进制 H 结尾、汉语数字
  const CLOZE_EXTRA = [
    { re: /\b\d+H\b/g, weight: 3 },                       // 03E8H
    { re: /\b\d+(?:KB|MB|B|位|根|片|级|个)\b/gi, weight: 3 },
    { re: /\b[0-9A-F]{2,5}H\b/g, weight: 3 },
    { re: /\b\d+(?:\.\d+)?\b/g, weight: 1 }
  ];

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

  // 把单段 plain 文本按 CLOZE_EXTRA 切成 [{text},{blank}] 序列
  function tokenizeForExtras(text, baseBlankId, preYellowFn) {
    const hits = [];
    for (const { re } of CLOZE_EXTRA) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, ans: m[0] });
      }
    }
    // 去重叠：保留较长 / 较早的
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
    spans.forEach((sp, idx) => {
      if (sp.kind === 'key') {
        if (mode === 'view') {
          html.push(`<span class="key">${escapeHtml(sp.text)}</span>`);
        } else {
          const blankId = `${baseBlankId}_s${idx}`;
          html.push(inputHtml(blankId, sp.text, preYellowFn(blankId)));
        }
      } else {
        // text span
        if (mode === 'cloze') {
          const parts = tokenizeForExtras(sp.text, `${baseBlankId}_s${idx}`, preYellowFn);
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
          <button class="topic-btn" type="button" onclick="toggleNotesSection(this)">
            <span class="icon" style="background:#dbeafe">📘</span>
            <span>${escapeHtml(sec.title)}</span>
            <span class="arrow">▶</span>
          </button>
          <div class="topic-content">
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
