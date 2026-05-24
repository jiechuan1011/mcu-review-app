/*
 * Copyright (c) 2026 微机原理复习宝典
 * docx 源文件 → notes.json
 *
 * 设计原则：零丢失。每个 w:p / w:tbl 都进入输出树，
 * 不裁剪、不汇总；下游算法可决定如何渲染或派生。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC_DOCX = path.resolve(__dirname, '..', '微机原理考试重点速记-1.docx');
const OUT_JSON = path.resolve(__dirname, '..', 'www', 'data', 'notes.json');

/* ---------- 最小 zip 解析（避免引入额外依赖） ---------- */

function readUInt32LE(buf, off) { return buf.readUInt32LE(off); }
function readUInt16LE(buf, off) { return buf.readUInt16LE(off); }

function extractDocumentXml(docxBuf) {
  // 在 ZIP central directory 里找 word/document.xml
  // EOCD signature 0x06054b50
  let eocdOff = -1;
  for (let i = docxBuf.length - 22; i >= Math.max(0, docxBuf.length - 65557); i--) {
    if (readUInt32LE(docxBuf, i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('not a valid zip: EOCD not found');
  const cdSize = readUInt32LE(docxBuf, eocdOff + 12);
  const cdOff = readUInt32LE(docxBuf, eocdOff + 16);

  let p = cdOff;
  const end = cdOff + cdSize;
  while (p < end) {
    if (readUInt32LE(docxBuf, p) !== 0x02014b50) throw new Error('bad central dir signature');
    const method = readUInt16LE(docxBuf, p + 10);
    const compSize = readUInt32LE(docxBuf, p + 20);
    const nameLen = readUInt16LE(docxBuf, p + 28);
    const extraLen = readUInt16LE(docxBuf, p + 30);
    const commentLen = readUInt16LE(docxBuf, p + 32);
    const localHeaderOff = readUInt32LE(docxBuf, p + 42);
    const name = docxBuf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === 'word/document.xml') {
      // 跳到 local file header 读真正的偏移
      const lh = localHeaderOff;
      if (readUInt32LE(docxBuf, lh) !== 0x04034b50) throw new Error('bad local header');
      const lhNameLen = readUInt16LE(docxBuf, lh + 26);
      const lhExtraLen = readUInt16LE(docxBuf, lh + 28);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      const data = docxBuf.slice(dataStart, dataStart + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error('unsupported zip method: ' + method);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('word/document.xml not found in docx');
}

/* ---------- docx → 结构化笔记树 ---------- */

const RE_PARA_OR_TBL = /<w:p[\s>][\s\S]*?<\/w:p>|<w:tbl[\s>][\s\S]*?<\/w:tbl>/g;
const RE_RUN = /<w:r[\s>][\s\S]*?<\/w:r>/g;
const RE_T = /<w:t[^>]*>([^<]*)<\/w:t>/g;
const RE_BR = /<w:br[\s\/>]/g;
const RE_BOLD = /<w:b\s*\/>|<w:b\s+w:val="(?:true|1)"\s*\/?>/;
const RE_STYLE = /<w:pStyle w:val="([^"]+)"/;
const RE_NUM_ID = /<w:numId w:val="([^"]+)"/;
const RE_ILVL = /<w:ilvl w:val="([^"]+)"/;

function decodeXmlEntities(s) {
  return s
    .replace(/&#10;/g, '\n')
    .replace(/&#9;/g, '\t')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 提取一个 <w:p> / <w:tc> 的 spans：[{kind:'text'|'key', text}]
// 合并相邻同类型片段。关键概念 = 粗体 run。
function paragraphSpans(pXml) {
  const runs = pXml.match(RE_RUN) || [];
  const spans = [];
  for (const r of runs) {
    const isBold = RE_BOLD.test(r);
    RE_T.lastIndex = 0;
    let m;
    let buf = '';
    // 把 <w:br/> 当换行
    const normalized = r.replace(RE_BR, '<w:t>\n</w:t>');
    RE_T.lastIndex = 0;
    while ((m = RE_T.exec(normalized)) !== null) {
      buf += decodeXmlEntities(m[1]);
    }
    if (!buf) continue;
    const kind = isBold ? 'key' : 'text';
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += buf;
    else spans.push({ kind, text: buf });
  }
  return spans;
}

function paragraphPlain(spans) {
  return spans.map(s => s.text).join('');
}

function isHeading(styleVal) {
  // Word 转出来的标题样式是 "1","2","3","4"
  if (!styleVal) return 0;
  if (/^\d$/.test(styleVal)) return Number(styleVal);
  return 0;
}

function classifyParagraph(spans, styleVal, numId, ilvl) {
  const plain = paragraphPlain(spans).trim();
  if (!plain) return { type: 'empty' };

  const h = isHeading(styleVal);
  if (h) return { type: 'heading', level: h, spans, plain };

  if (numId) {
    return { type: 'list-item', level: Number(ilvl || 0), spans, plain };
  }

  // 汇编代码行：包含 OUT/IN/MOV/HLT 且以 ";" 注释结尾 或 全大写助记符
  if (/^(MOV|OUT|IN|HLT|XCHG|ADD|SUB|AND|OR|NOT|CMP|TEST|JZ|JC|JMP|PUSH|POP|INT|RET|CALL)\b/i.test(plain)) {
    return { type: 'code', text: plain, spans };
  }

  return { type: 'para', spans, plain };
}

function parseTable(tblXml) {
  const rows = tblXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
  const grid = rows.map(rowXml => {
    const cells = rowXml.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || [];
    return cells.map(cellXml => {
      const paras = cellXml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
      // 一个单元格内多个段落用 \n 连接，spans 平铺
      const allSpans = [];
      paras.forEach((p, i) => {
        const sp = paragraphSpans(p);
        if (i > 0) allSpans.push({ kind: 'text', text: '\n' });
        allSpans.push(...sp);
      });
      return {
        spans: allSpans,
        plain: paragraphPlain(allSpans).trim()
      };
    });
  });
  // 第一行视为表头（粗体多的那行；若全粗体则就是表头）
  const headerRow = grid[0] || [];
  const headerBoldRatio = headerRow.length
    ? headerRow.filter(c => c.spans.some(s => s.kind === 'key')).length / headerRow.length
    : 0;
  return {
    type: 'table',
    header: headerBoldRatio >= 0.5 ? headerRow : null,
    rows: headerBoldRatio >= 0.5 ? grid.slice(1) : grid
  };
}

function buildTree(documentXml) {
  const bodyM = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyM) throw new Error('w:body not found');
  const body = bodyM[1];

  const items = [];
  RE_PARA_OR_TBL.lastIndex = 0;
  let m;
  while ((m = RE_PARA_OR_TBL.exec(body)) !== null) items.push(m[0]);

  /** 文档结构：
   *  root
   *    title (H1 / 第 0 段)
   *    sections[]: { id, title, intro_blocks[], subsections[] }
   *      subsections[]: { id, title, blocks[] }
   *      blocks: list-item / para / code / table（保留原顺序）
   */
  const tree = {
    sourceFile: '微机原理考试重点速记-1.docx',
    generatedAt: new Date().toISOString(),
    title: '',
    subtitle: '',
    sections: []
  };

  let curSection = null;
  let curSub = null;
  // 同一 numId+ilvl 连续的 list-item 合并为一个 list 块
  let listAccum = null;

  function flushList(target) {
    if (listAccum && target) target.push(listAccum);
    listAccum = null;
  }

  function pushBlock(block) {
    const target = curSub ? curSub.blocks : (curSection ? curSection.intro_blocks : null);
    if (!target) {
      // 文档级前置段落（极少见），挂到 tree.preface
      if (!tree.preface) tree.preface = [];
      flushList(tree.preface);
      tree.preface.push(block);
      return;
    }
    flushList(target);
    target.push(block);
  }

  function pushListItem(item, level) {
    const target = curSub ? curSub.blocks : (curSection ? curSection.intro_blocks : null);
    if (!target) { return; }
    if (!listAccum || listAccum.level !== level) {
      flushList(target);
      listAccum = { type: 'list', level, items: [] };
    }
    listAccum.items.push(item);
  }

  let absIndex = 0;
  for (const raw of items) {
    if (raw.startsWith('<w:tbl')) {
      pushBlock(parseTable(raw));
      absIndex++;
      continue;
    }
    const styleM = raw.match(RE_STYLE);
    const numM = raw.match(RE_NUM_ID);
    const ilvlM = raw.match(RE_ILVL);
    const spans = paragraphSpans(raw);
    const node = classifyParagraph(spans, styleM ? styleM[1] : null, numM ? numM[1] : null, ilvlM ? ilvlM[1] : null);

    if (node.type === 'empty') { absIndex++; continue; }

    if (node.type === 'heading') {
      if (node.level <= 2) {
        // 把第一个出现在文档最前的 H2 之前的孤立粗体段当 title/subtitle
        if (absIndex <= 1 && !tree.title) {
          tree.title = node.plain;
          continue;
        }
        // 切换 section 前，先把当前累积的列表刷入旧 target
        if (listAccum) {
          const old = curSub ? curSub.blocks : (curSection ? curSection.intro_blocks : null);
          if (old) old.push(listAccum);
          listAccum = null;
        }
        curSection = {
          id: 'sec_' + tree.sections.length,
          title: node.plain,
          intro_blocks: [],
          subsections: []
        };
        curSub = null;
        tree.sections.push(curSection);
      } else if (node.level === 3) {
        if (!curSection) {
          curSection = { id: 'sec_orphan', title: '其它', intro_blocks: [], subsections: [] };
          tree.sections.push(curSection);
        }
        // 切换 subsection 前刷新列表
        if (listAccum) {
          const old = curSub ? curSub.blocks : curSection.intro_blocks;
          old.push(listAccum);
          listAccum = null;
        }
        curSub = {
          id: curSection.id + '_sub_' + curSection.subsections.length,
          title: node.plain,
          spans: node.spans,
          blocks: []
        };
        curSection.subsections.push(curSub);
      } else {
        pushBlock({ type: 'para', spans: node.spans });
      }
    } else if (node.type === 'list-item') {
      // 把第 0 段的标题/副标题特殊处理
      if (absIndex <= 1 && !tree.title) {
        tree.title = node.plain; absIndex++; continue;
      }
      pushListItem({ spans: node.spans }, node.level);
    } else if (node.type === 'code') {
      pushBlock({ type: 'code', text: node.text });
    } else {
      // 第 0 段是标题，第 1 段是副标题
      if (absIndex === 0 && !tree.title) {
        tree.title = node.plain; absIndex++; continue;
      }
      if (absIndex === 1 && !tree.subtitle) {
        tree.subtitle = node.plain; absIndex++; continue;
      }
      pushBlock({ type: 'para', spans: node.spans });
    }
    absIndex++;
  }
  // 收尾
  if (curSub) {
    if (listAccum) curSub.blocks.push(listAccum);
  } else if (curSection) {
    if (listAccum) curSection.intro_blocks.push(listAccum);
  }

  return tree;
}

/* ---------- 自检：原始 paragraphs/tables 必须与树里的 spans 数一致 ---------- */

function selfCheck(documentXml, tree) {
  const bodyM = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  const body = bodyM[1];

  // 收集所有源文本（去掉空段），严格按文档原序
  const sourceTexts = [];
  RE_PARA_OR_TBL.lastIndex = 0;
  let mm;
  while ((mm = RE_PARA_OR_TBL.exec(body)) !== null) {
    const node = mm[0];
    if (node.startsWith('<w:tbl')) {
      const rows = node.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
      for (const r of rows) {
        const cells = r.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || [];
        for (const c of cells) {
          const paras = c.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
          for (const p of paras) {
            const plain = paragraphPlain(paragraphSpans(p)).trim();
            if (plain) sourceTexts.push(plain);
          }
        }
      }
    } else {
      const plain = paragraphPlain(paragraphSpans(node)).trim();
      if (plain) sourceTexts.push(plain);
    }
  }

  // 收集所有树文本
  const treeTexts = [];
  const visit = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'list') for (const it of b.items) treeTexts.push(paragraphPlain(it.spans).trim());
      else if (b.type === 'para' || b.type === 'code') treeTexts.push((b.spans ? paragraphPlain(b.spans) : b.text).trim());
      else if (b.type === 'table') {
        if (b.header) for (const c of b.header) treeTexts.push(c.plain);
        for (const row of b.rows) for (const c of row) treeTexts.push(c.plain);
      }
    }
  };
  if (tree.title) treeTexts.push(tree.title);
  if (tree.subtitle) treeTexts.push(tree.subtitle);
  for (const sec of tree.sections) {
    treeTexts.push(sec.title);
    visit(sec.intro_blocks);
    for (const sub of sec.subsections) {
      treeTexts.push(sub.title);
      visit(sub.blocks);
    }
  }

  const srcJoin = sourceTexts.join('\n').replace(/\s+/g, '');
  const treeJoin = treeTexts.filter(Boolean).join('\n').replace(/\s+/g, '');
  // 表格中的 \n 在源里来自 &#10; 已被还原；这里再去空格统一对比
  const ok = srcJoin === treeJoin;
  if (!ok) {
    // 找第一个不一致点便于排查
    let i = 0;
    while (i < Math.min(srcJoin.length, treeJoin.length) && srcJoin[i] === treeJoin[i]) i++;
    console.error('[self-check] mismatch at char', i,
      '\n  src:', srcJoin.slice(Math.max(0, i - 40), i + 40),
      '\n  tree:', treeJoin.slice(Math.max(0, i - 40), i + 40));
    throw new Error('zero-loss self-check FAILED');
  }
  return { sourceTexts: sourceTexts.length, treeTexts: treeTexts.length };
}

/* ---------- main ---------- */

function main() {
  if (!fs.existsSync(SRC_DOCX)) {
    console.error('source docx not found:', SRC_DOCX);
    process.exit(1);
  }
  const buf = fs.readFileSync(SRC_DOCX);
  const xml = extractDocumentXml(buf);
  const tree = buildTree(xml);
  const stats = selfCheck(xml, tree);

  // 顶层统计供调试
  let nSec = tree.sections.length;
  let nSub = 0, nList = 0, nPara = 0, nCode = 0, nTable = 0, nKeys = 0;
  const countSpansKeys = (spans) => spans ? spans.filter(s => s.kind === 'key').length : 0;
  const visit = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'list') { nList++; for (const it of b.items) nKeys += countSpansKeys(it.spans); }
      else if (b.type === 'para') { nPara++; nKeys += countSpansKeys(b.spans); }
      else if (b.type === 'code') { nCode++; }
      else if (b.type === 'table') {
        nTable++;
        if (b.header) for (const c of b.header) nKeys += countSpansKeys(c.spans);
        for (const row of b.rows) for (const c of row) nKeys += countSpansKeys(c.spans);
      }
    }
  };
  for (const sec of tree.sections) {
    visit(sec.intro_blocks);
    nSub += sec.subsections.length;
    for (const sub of sec.subsections) visit(sub.blocks);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(tree, null, 0), 'utf8');

  console.log('[build-notes] wrote', path.relative(process.cwd(), OUT_JSON));
  console.log('  sections=%d  subsections=%d  lists=%d  paras=%d  code=%d  tables=%d  bold-keys=%d',
    nSec, nSub, nList, nPara, nCode, nTable, nKeys);
  console.log('  self-check: %d source texts == %d tree texts (OK)', stats.sourceTexts, stats.treeTexts);
}

main();
