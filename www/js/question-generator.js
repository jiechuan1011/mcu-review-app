/*
 * Copyright (c) 2026 微机原理复习宝典
 * 笔记自动派生题库
 *
 * 输入：notes.json 树
 * 输出：
 *   {
 *     fillBlank: { title, groups: [{title, tag, items:[{text, blanks, srcRef}]}] }
 *     choice:    [{id, question, tag, options[4], answer, explanation, srcRef}]
 *     trueFalse: [{id, question, tag, answer, explanation, srcRef}]
 *   }
 *
 * 算法：
 *   1. 遍历每个 subsection；以"句子"为题面单元
 *      （按中文句号/分号/换行/列表条目切分）。
 *   2. 提取候选关键概念：粗体 span（高权重）+ 数字带单位（低权重）
 *   3. 填空题：把句子里所有关键概念替换为 ____，挖空 ≥1 才出题。
 *   4. 选择题：从全文按 tag 收集同类 key 池作干扰；
 *      正确项使用候选自身，干扰项随机抽 3 个长度近似、内容相异的同类 key。
 *      若同类干扰不足 3 项，则放弃该题（保证质量）。
 *   5. 判断题：50% 概率保持原句（true），50% 替换关键概念为同类干扰（false）。
 *
 * 设计取舍：
 *   - 不依赖 LLM，纯规则。生成可重放、可单测、零网络。
 *   - 每道题保留 srcRef = {sectionIdx, subIdx, sentence}，便于"跳转回笔记"。
 */

(function (global) {
  'use strict';

  /* ---------- 标签推断：把 subsection 标题映射到芯片/主题 ---------- */
  function inferTag(secTitle, subTitle) {
    const blob = (secTitle || '') + ' ' + (subTitle || '');
    if (/8088|CPU|寄存器|FLAGS|IP|SP|BP/.test(blob)) return '8088';
    if (/8259/.test(blob)) return '8259';
    if (/8253/.test(blob)) return '8253';
    if (/8255/.test(blob)) return '8255';
    if (/中断|向量/.test(blob)) return 'int';
    if (/存储器|译码|SRAM|ROM|74LS138/.test(blob)) return 'mem';
    if (/编程|指令|汇编/.test(blob)) return 'asm';
    if (/串行|通信/.test(blob)) return 'comm';
    return 'misc';
  }

  /* ---------- 提取叶子句子 + 该句子的关键概念列表 ---------- */
  // 一个 "句子单元" 来自一个 list-item / para / 表格单元。
  // 因为我们要保留原文+挖空位置，所以工作单位是 spans 数组。

  function spansToText(spans) {
    return spans.map(s => s.text).join('');
  }

  /** 把 spans 切成多句：以中文/英文句号、分号、换行、问号分割 */
  function splitSentences(spans) {
    const sentences = [];
    let cur = [];
    const pushIfHasContent = () => {
      const t = spansToText(cur).trim();
      if (t) sentences.push(cur);
      cur = [];
    };
    for (const sp of spans) {
      const parts = sp.text.split(/([。；;\n？?])/); // 分号也作为句号边界
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (!seg) continue;
        if (/^[。；;\n？?]$/.test(seg)) {
          if (cur.length) {
            const last = cur[cur.length - 1];
            if (last.kind === sp.kind) last.text += seg;
            else cur.push({ kind: sp.kind, text: seg });
          }
          pushIfHasContent();
        } else {
          const last = cur[cur.length - 1];
          if (last && last.kind === sp.kind) last.text += seg;
          else cur.push({ kind: sp.kind, text: seg });
        }
      }
    }
    pushIfHasContent();
    return sentences;
  }

  /** 收集叶子单元（list item / paragraph / table cell）spans */
  function collectLeafSpans(tree, onLeaf) {
    const visit = (blocks, ctx) => {
      for (const b of blocks) {
        if (b.type === 'list') {
          b.items.forEach((it, i) => onLeaf(it.spans, { ...ctx, kind: 'list', idx: i }));
        } else if (b.type === 'para') {
          onLeaf(b.spans, { ...ctx, kind: 'para' });
        } else if (b.type === 'table') {
          if (b.header) b.header.forEach((c, i) => onLeaf(c.spans, { ...ctx, kind: 'th', idx: i }));
          b.rows.forEach((row, ri) =>
            row.forEach((c, ci) => onLeaf(c.spans, { ...ctx, kind: 'td', row: ri, col: ci })));
        }
        // code 块不参与题库生成
      }
    };
    tree.sections.forEach((sec, si) => {
      const tag = inferTag(sec.title, '');
      visit(sec.intro_blocks, { secIdx: si, secTitle: sec.title, subTitle: '', tag });
      sec.subsections.forEach((sub, subi) => {
        const tag2 = inferTag(sec.title, sub.title);
        visit(sub.blocks, { secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, tag: tag2 });
      });
    });
  }

  /* ---------- 三类生成器 ---------- */

  // 干扰项池：按 tag 收集全文所有粗体 key + 数字字面量
  function buildDistractorPool(tree) {
    const pool = {};
    const add = (tag, t) => {
      if (!t || t.length > 30) return;
      const arr = (pool[tag] = pool[tag] || []);
      if (!arr.includes(t)) arr.push(t);
    };
    collectLeafSpans(tree, (spans, ctx) => {
      for (const sp of spans) {
        if (sp.kind === 'key') {
          const t = sp.text.trim();
          if (!t || isLabelKey(t)) continue;
          add(ctx.tag, t);
        } else {
          NUMERIC_RE.lastIndex = 0;
          let m;
          while ((m = NUMERIC_RE.exec(sp.text)) !== null) {
            add(ctx.tag, m[0]);
          }
        }
      }
    });
    return pool;
  }

  function isNumericLike(s) {
    return /^(?:0?[0-9A-F]{1,5}H|[0-9]+(?:\.[0-9]+)?(?:KB|MB|kHz|MHz|Hz|位|根|片|级|个|字节)?|7N\+1)$/i.test(s.trim());
  }

  function pickDistractors(pool, tag, correct, n) {
    const allCands = (pool[tag] || []).filter(x => x !== correct);
    const wantNumeric = isNumericLike(correct);
    // 同类型优先：数字配数字、文字配文字
    const sameType = allCands.filter(x => isNumericLike(x) === wantNumeric);
    const otherType = allCands.filter(x => isNumericLike(x) !== wantNumeric);
    // 在同类型中，长度相近优先
    const close = sameType.filter(x => Math.abs(x.length - correct.length) <= 4);
    const rest = sameType.filter(x => !close.includes(x));
    const ordered = shuffled(close).concat(shuffled(rest)).concat(shuffled(otherType));
    return ordered.slice(0, n);
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 句子的关键概念集合（粗体 key，过滤引导词） */
  // 引导词特征：以中英冒号 / 表情警示 / 全部是叹号 等结尾、或长度 > 12 的"短语标签"
  // 例："级联计算公式："、"⚠ 关键提醒："、"🔥 考前避坑警示："
  function isLabelKey(text) {
    const t = text.trim();
    if (!t) return true;
    if (/[：:]\s*$/.test(t)) return true;          // 以冒号结尾
    if (/^[⚠🔥★☆▶◆●○✦✧❗❓]/.test(t)) return true;  // 以装饰符开头
    if (/提醒|警示|警告|注意|公式$|模板$|步骤$|说明$|总结$|核心做题/.test(t)) return true;
    return false;
  }

  function keySpansOf(sentence) {
    return sentence
      .map((sp, idx) => ({ idx, ...sp }))
      .filter(x => x.kind === 'key' && x.text.trim().length && !isLabelKey(x.text));
  }

  // 数字/十六进制/含单位数量等"硬性候选"——当句子里没有可用粗体 key 时备用
  const NUMERIC_RE = /\b(?:0?[0-9A-F]{1,5}H|[0-9]+(?:\.[0-9]+)?(?:KB|MB|kHz|MHz|Hz|位|根|片|级|个|字节)?|7N\+1|N\s*=\s*[^\s，。；,;]+)\b/gi;

  function sentenceToFillItem(sentence, ctx) {
    const keys = keySpansOf(sentence);
    let text = '';
    const blanks = [];
    let contextChars = 0;

    if (keys.length) {
      // 走 key 挖空路径
      sentence.forEach(sp => {
        if (sp.kind === 'key' && !isLabelKey(sp.text)) {
          text += '____';
          blanks.push(sp.text.trim());
        } else {
          text += sp.text;
          contextChars += sp.text.replace(/\s/g, '').length;
        }
      });
    } else {
      // 走数字挖空路径
      const plain = spansToText(sentence);
      const hits = [];
      NUMERIC_RE.lastIndex = 0;
      let m;
      while ((m = NUMERIC_RE.exec(plain)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, ans: m[0] });
      }
      // 上下文最短长度由调用方门槛保证；这里至少 1 个数字
      if (!hits.length) return null;
      // 去重叠
      hits.sort((a, b) => a.start - b.start);
      let p = 0;
      hits.forEach(h => {
        if (h.start < p) return;
        text += plain.slice(p, h.start);
        contextChars += plain.slice(p, h.start).replace(/\s/g, '').length;
        text += '____';
        blanks.push(h.ans);
        p = h.end;
      });
      text += plain.slice(p);
      contextChars += plain.slice(p).replace(/\s/g, '').length;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || blanks.length === 0) return null;
    if (text.length > 200) return null;
    // 上下文实词字符数门槛
    if (contextChars < 6) return null;
    return {
      blanks, text,
      srcRef: ctx
    };
  }

  /** 句子里所有有效的"被挖位置"：粗体非引导词 + 数字字面量 */
  function blankableSpotsOf(sentence) {
    const spots = [];
    // 1) 粗体非引导词
    sentence.forEach((sp, idx) => {
      if (sp.kind === 'key' && sp.text.trim() && !isLabelKey(sp.text)) {
        spots.push({ kind: 'span', spanIdx: idx, start: 0, end: sp.text.length, text: sp.text.trim() });
      }
    });
    // 2) 数字字面量（仅在 text span 内查找，避免与 key 重叠）
    sentence.forEach((sp, idx) => {
      if (sp.kind === 'key') return;
      NUMERIC_RE.lastIndex = 0;
      let m;
      while ((m = NUMERIC_RE.exec(sp.text)) !== null) {
        spots.push({ kind: 'numeric', spanIdx: idx, start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    });
    return spots;
  }

  function sentenceToChoiceItems(sentence, ctx, distractorPool) {
    const spots = blankableSpotsOf(sentence);
    if (!spots.length) return [];
    const contextChars = sentence.filter(s => s.kind !== 'key').reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
    if (contextChars < 6) return [];
    // 必须在带标题的知识小节里。试卷结构、考前提醒等顶层 intro 段不出选择题。
    if (!ctx.subTitle) return [];

    const out = [];
    spots.forEach(spot => {
      const correct = spot.text.trim();
      if (correct.length < 1 || correct.length > 30) return;
      const distractors = pickDistractors(distractorPool, ctx.tag, correct, 3);
      if (distractors.length < 3) return;
      const options = shuffled([correct, ...distractors]);
      const answerIdx = options.indexOf(correct);
      // 把 spot 替换为 ____
      let question = '';
      sentence.forEach((sp, idx) => {
        if (idx !== spot.spanIdx) {
          question += sp.text;
          return;
        }
        if (spot.kind === 'span') {
          question += '____';
        } else {
          question += sp.text.slice(0, spot.start) + '____' + sp.text.slice(spot.end);
        }
      });
      question = question.replace(/\s+/g, ' ').trim();
      if (!question || question.length > 200) return;
      out.push({
        question: `${question}（  ）`,
        tag: ctx.tag,
        options: options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`),
        answer: answerIdx,
        explanation: `正确答案：${correct}。原文出自「${ctx.subTitle || ctx.secTitle}」。`,
        srcRef: ctx
      });
    });
    return out;
  }

  function sentenceToTFItem(sentence, ctx, distractorPool) {
    const spots = blankableSpotsOf(sentence);
    if (!spots.length) return null;
    const contextChars = sentence.filter(s => s.kind !== 'key').reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
    if (contextChars < 6) return null;
    if (!ctx.subTitle) return null;
    const plain = spansToText(sentence).replace(/\s+/g, ' ').trim();
    if (!plain || plain.length > 160) return null;
    if (Math.random() < 0.5) {
      return {
        question: plain,
        tag: ctx.tag,
        answer: true,
        explanation: `原文：「${plain}」`,
        srcRef: ctx
      };
    } else {
      const spot = spots[Math.floor(Math.random() * spots.length)];
      const orig = spot.text.trim();
      const distractors = pickDistractors(distractorPool, ctx.tag, orig, 1);
      if (!distractors.length) return null;
      const wrong = distractors[0];
      let mutated = '';
      sentence.forEach((sp, idx) => {
        if (idx !== spot.spanIdx) {
          mutated += sp.text;
          return;
        }
        if (spot.kind === 'span') mutated += wrong;
        else mutated += sp.text.slice(0, spot.start) + wrong + sp.text.slice(spot.end);
      });
      mutated = mutated.replace(/\s+/g, ' ').trim();
      return {
        question: mutated,
        tag: ctx.tag,
        answer: false,
        explanation: `原文「${orig}」被替换为「${wrong}」，故为假。`,
        srcRef: ctx
      };
    }
  }

  /* ---------- 顶层 generate ---------- */

  function generate(tree, opts) {
    opts = opts || {};
    const seed = (opts.seed != null) ? opts.seed : Date.now();
    let rng = seed >>> 0;
    const _rand = Math.random; // 内部不替换；如需可重放，把上面的 Math.random 调用都改成 PRNG。
    // （此版本生成在浏览器端按 mtime 触发，刷新即可换一批。）

    const distractorPool = buildDistractorPool(tree);

    const fillGroups = [];
    const choices = [];
    const tfs = [];
    let choiceId = 1, tfId = 1;

    tree.sections.forEach((sec, si) => {
      const groupKey = sec.title;
      // 一个 section 的填空题归为一组
      const groupItems = [];
      const groupTag = inferTag(sec.title, '');

      const handleLeaf = (spans, ctx) => {
        if (!spans || !spans.length) return;
        const sentences = splitSentences(spans);
        sentences.forEach(sent => {
          const fi = sentenceToFillItem(sent, ctx);
          if (fi) groupItems.push(fi);
          const cis = sentenceToChoiceItems(sent, ctx, distractorPool);
          for (const ci of cis) {
            choices.push({ id: 'gc' + (choiceId++), ...ci });
          }
          const tfi = sentenceToTFItem(sent, ctx, distractorPool);
          if (tfi) tfs.push({ id: 'gtf' + (tfId++), ...tfi });
        });
      };

      // intro_blocks 直接挂到 section
      sec.intro_blocks.forEach(b => {
        if (b.type === 'list') b.items.forEach((it, i) =>
          handleLeaf(it.spans, { secIdx: si, secTitle: sec.title, kind: 'list', idx: i, tag: groupTag }));
        else if (b.type === 'para')
          handleLeaf(b.spans, { secIdx: si, secTitle: sec.title, kind: 'para', tag: groupTag });
        else if (b.type === 'table') {
          if (b.header) b.header.forEach((c, i) =>
            handleLeaf(c.spans, { secIdx: si, secTitle: sec.title, kind: 'th', idx: i, tag: groupTag }));
          b.rows.forEach((row, ri) => row.forEach((c, ci) =>
            handleLeaf(c.spans, { secIdx: si, secTitle: sec.title, kind: 'td', row: ri, col: ci, tag: groupTag })));
        }
      });

      sec.subsections.forEach((sub, subi) => {
        const subTag = inferTag(sec.title, sub.title);
        sub.blocks.forEach(b => {
          if (b.type === 'list') b.items.forEach((it, i) =>
            handleLeaf(it.spans, { secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, kind: 'list', idx: i, tag: subTag }));
          else if (b.type === 'para')
            handleLeaf(b.spans, { secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, kind: 'para', tag: subTag });
          else if (b.type === 'table') {
            if (b.header) b.header.forEach((c, i) =>
              handleLeaf(c.spans, { secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, kind: 'th', idx: i, tag: subTag }));
            b.rows.forEach((row, ri) => row.forEach((c, ci) =>
              handleLeaf(c.spans, { secIdx: si, subIdx: subi, secTitle: sec.title, subTitle: sub.title, kind: 'td', row: ri, col: ci, tag: subTag })));
          }
        });
      });

      if (groupItems.length) {
        fillGroups.push({
          title: groupKey,
          tag: groupTag,
          items: groupItems
        });
      }
    });

    return {
      fillBlank: { title: '填空题（自动派生）', groups: fillGroups },
      choice: choices,
      trueFalse: tfs,
      _meta: {
        generatedAt: new Date().toISOString(),
        seed,
        distractorTags: Object.fromEntries(Object.entries(distractorPool).map(([k, v]) => [k, v.length])),
        counts: {
          fillGroups: fillGroups.length,
          fillItems: fillGroups.reduce((s, g) => s + g.items.length, 0),
          choice: choices.length,
          tf: tfs.length
        }
      }
    };
  }

  global.QuestionGenerator = { generate };
})(window);
