'use strict';

const embedCache = require('./embedcache');

/**
 * server/semantic.js — 语义切块 + 重排（P1 检索准确率地基）
 *
 * 思路（业界 retrieve-then-rerank）：
 *   飞书按关键词把「相关文档」召回来 → 我们把每篇正文切成段落(chunk) →
 *   用 embedding 向量算每段与问题的余弦相似度 → 取全局最相关的若干段，
 *   只把这些「精准段落」喂给 LLM（少噪音、更准），而不是把整篇 8000 字塞进去。
 *
 * 没有可用 embedding（用户选了不支持向量的厂商，或调用失败）时，
 * 自动降级为「词法打分」（CJK unigram+bigram 重叠），依然只喂精准段落。
 *
 * 纯逻辑，无副作用（embed 除外，走 fetch）。所有导出均可单测。
 */

// ---------------------------------------------------------------------------
// 切块
// ---------------------------------------------------------------------------

/**
 * 把长文本切成带偏移量的重叠段落。优先在句末/换行处断开，避免切碎句子。
 * @param {string} text
 * @param {{size?:number, overlap?:number}} opts
 * @returns {Array<{text:string, offset:number}>}
 */
// 滑窗切分：结构上无法再分的长单元用它兜底（在句末/换行处断，带重叠）。
function slidingSplit(s, size, overlap, baseOffset) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const from = i + Math.floor(size * 0.6);
      let brk = -1;
      for (const ch of ['\n', '。', '！', '？', '.', '!', '?', ';', '；']) {
        const idx = s.lastIndexOf(ch, end - 1);
        if (idx >= from && idx > brk) brk = idx;
      }
      if (brk > i) end = brk + 1;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push({ text: piece, offset: baseOffset + i });
    if (end >= s.length) break;
    const next = end - overlap;
    i = next > i ? next : end;   // 保证前进，绝不死循环
  }
  return out;
}

// 结构切分：先按空行分段，再在 Q:/问:/标题/编号/【 等结构行前切开，得到"语义单元"。
// 这样 Q&A 文档里每条问答、结构文档里每个小节都成为独立单元，不被定长窗口切碎。
function splitUnits(s) {
  const units = [];
  for (const para of s.split(/\n\s*\n+/)) {
    const t = para.trim();
    if (!t) continue;
    let cur = [];
    for (const ln of t.split('\n')) {
      // 只在"新单元开始"处切：Q:/问:/标题/编号。**不要**在 A:/答: 切——答案必须跟着它的问题。
      if (cur.length && /^\s*(Q[:：]|问[:：]|#{1,6}\s|【|第[一二三四五六七八九十百0-9]{1,3}[、.，]|\d+[.、]\s?)/.test(ln)) {
        units.push(cur.join('\n').trim());
        cur = [];
      }
      cur.push(ln);
    }
    if (cur.length) units.push(cur.join('\n').trim());
  }
  return units.filter(Boolean);
}

function chunkText(text, opts = {}) {
  const size = opts.size || 500;
  const overlap = Math.min(opts.overlap == null ? 100 : opts.overlap, Math.floor(size / 2));
  const s = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return [];
  if (s.length <= size) return [{ text: s, offset: 0 }];

  // 结构感知：每个语义单元（一问一答 / 一个小节 / 一段）**独立成块**，不跨单元打包，
  // 避免多条问答挤在一块导致主题混杂、法官/向量判不准。超长单元退化为滑窗。
  // 只把"过短(<minKeep)且相邻的散段"并入上一块，避免碎片化。
  const minKeep = Math.min(60, Math.floor(size / 4));
  const units = splitUnits(s);
  const chunks = [];
  let searchFrom = 0;
  for (const u of units) {
    const probe = u.slice(0, 16);
    let uOff = probe ? s.indexOf(probe, searchFrom) : -1;
    if (uOff < 0) uOff = searchFrom;
    searchFrom = uOff + 1;

    if (u.length > size) {                       // 超长单元 → 滑窗切
      for (const c of slidingSplit(u, size, overlap, uOff)) chunks.push(c);
      continue;
    }
    const last = chunks[chunks.length - 1];
    const isQAstart = /^\s*(Q[:：]|问[:：]|#{1,6}\s|【)/.test(u);
    // 过短的散段(非Q&A/标题开头)且合并后不超 size → 并入上一块，减少碎片
    if (last && !isQAstart && u.length < minKeep && (last.text.length + u.length + 1) <= size) {
      last.text += '\n' + u;
    } else {
      chunks.push({ text: u, offset: uOff });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 打分：向量余弦 + 词法兜底
// ---------------------------------------------------------------------------

/** 余弦相似度。任一为空返回 0。 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/** CJK 友好分词：拉丁词/数字整取，中文取 unigram + bigram。 */
function tokenize(s) {
  const str = String(s || '').toLowerCase();
  const tokens = [];
  const latin = str.match(/[a-z0-9]+/g);
  if (latin) tokens.push(...latin);
  const cjk = str.match(/[一-龥]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

/** 词法打分：query 词在段落里的命中数，按段落长度归一，抑制长文本偏置。 */
function lexicalScore(queryTokens, text) {
  const set = new Set(queryTokens);
  if (!set.size) return 0;
  const tt = tokenize(text);
  if (!tt.length) return 0;
  let hit = 0;
  for (const t of tt) if (set.has(t)) hit++;
  return hit / Math.sqrt(tt.length);
}

// ---------------------------------------------------------------------------
// Embedding（智谱 embedding-3 等 OpenAI 兼容 /embeddings）
// ---------------------------------------------------------------------------

/**
 * 批量取向量。按 index 对齐返回，与输入顺序一致。
 * @param {string[]} texts
 * @param {{url:string, model:string, apiKey:string}} embedConfig
 * @returns {Promise<number[][]>}
 */
async function embed(texts, embedConfig) {
  if (!embedConfig || !embedConfig.apiKey || !embedConfig.url) throw new Error('no embed config');
  if (!texts.length) return [];
  const model = embedConfig.model;
  // 同名模型可能来自不同端点/版本，向量空间未必兼容；缓存必须同时隔离端点。
  const cacheModel = `${embedConfig.url}|${model}`;
  const out = new Array(texts.length);

  // 先查缓存，只对未命中的文本真正调用 API（省 token/延迟）
  const missTexts = [];
  const missIdx = [];
  texts.forEach((t, i) => {
    const c = embedCache.get(cacheModel, t);
    if (c) out[i] = c;
    else { missTexts.push(t); missIdx.push(i); }
  });

  if (missTexts.length) {
    const res = await fetch(embedConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embedConfig.apiKey}` },
      body: JSON.stringify({ model, input: missTexts }),
    });
    if (!res.ok) throw new Error(`embed http ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`embed err ${JSON.stringify(j.error).slice(0, 120)}`);
    for (const d of (j.data || [])) {
      const gi = missIdx[d.index];
      out[gi] = d.embedding;
      embedCache.put(cacheModel, missTexts[d.index], d.embedding);
    }
  }
  return out;
}

/** 分批 embed，避免单次输入过多。 */
async function batchEmbed(texts, embedConfig, batchSize = 32) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const part = await embed(texts.slice(i, i + batchSize), embedConfig);
    for (const v of part) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 重排主流程
// ---------------------------------------------------------------------------

/**
 * 把召回的文档切块、按与 query 的相似度重排，返回「只含精准段落」的文档列表。
 *
 * @param {string} query
 * @param {Array<{content:string, title?:string}>} docs  已读到正文的文档
 * @param {{embedConfig?:object, topChunks?:number, maxChunks?:number, chunkSize?:number, chunkOverlap?:number}} opts
 * @returns {Promise<{docs:Array, chunks:Array, method:'vector'|'lexical'|'none'}>}
 *   docs: 命中段落的文档（按最佳段落分降序），content 已替换为精准段落拼接，
 *         并带 _score(最佳分) 与 _anchorText(最相关段落原文)。
 */
async function rankDocs(query, docs, opts = {}) {
  const embedConfig = opts.embedConfig || null;
  const topChunks = opts.topChunks || 6;
  const maxChunks = opts.maxChunks || 64;
  const perChunk = { size: opts.chunkSize || 500, overlap: opts.chunkOverlap || 100 };
  const normalizeText = typeof opts.normalizeText === 'function' ? opts.normalizeText : (x => x);

  // 1) 切块，记住每段属于哪篇文档
  let all = [];
  for (let di = 0; di < docs.length; di++) {
    const d = docs[di];
    if (!d || !d.content) continue;
    if (d.source === 'message') {
      // 聊天候选是“命中消息 + 邻近回复”的证据单元。向量用命中消息匹配 query，避免回答文本稀释
      // 高相似问句；法官/生成仍看到完整会话证据，判断后续回复是否真的给出了答案。
      all.push({
        text: String(d.matchText || d.content).trim(),
        evidenceText: String(d.content).trim(),
        offset: 0,
        di,
      });
      continue;
    }
    for (const c of chunkText(d.content, perChunk)) all.push({ text: c.text, evidenceText: c.text, offset: c.offset, di });
  }
  if (!all.length) {
    return { docs: docs.filter(d => d && d.content), chunks: [], method: 'none' };
  }
  // 切块过多时要粗筛出 maxChunks 段再嵌入——**绝不能按位置 slice(0,N)**：那样会把靠后的大文档里
  // 那段精准匹配直接切掉（如《电力交易常用Q&A》56 段，"做策略需要考虑的因素"精准问答排在后面，
  // 被位置截断丢弃 → 该文档只剩次相关段、分数虚低 0.407，反被聊天碎片 0.521 压过）。
  // 改为先按**词法分**粗排，保留最可能相关的 maxChunks 段——精准匹配段词面重合高、必然入选。
  if (all.length > maxChunks) {
    const qTok = tokenize(normalizeText(query));
    const lexical = all.map((c, order) => ({ c, order, lex: lexicalScore(qTok, normalizeText(c.text)) }));
    const better = (a, b) => b.lex - a.lex || a.order - b.order;
    // 先为每篇候选保留词法最相关的一块，再用全局高分块填满余额。否则一篇超长文档能占满
    // maxChunks，让聊天或短文档在向量阶段之前就被静默删除。
    const bestPerDoc = new Map();
    for (const x of lexical) {
      const old = bestPerDoc.get(x.c.di);
      if (!old || better(x, old) < 0) bestPerDoc.set(x.c.di, x);
    }
    const selected = [...bestPerDoc.values()].sort(better).slice(0, maxChunks);
    const selectedOrders = new Set(selected.map(x => x.order));
    if (selected.length < maxChunks) {
      for (const x of lexical.sort(better)) {
        if (selectedOrders.has(x.order)) continue;
        selected.push(x);
        selectedOrders.add(x.order);
        if (selected.length >= maxChunks) break;
      }
    }
    all = selected.sort((a, b) => a.order - b.order).map(x => x.c);
  }

  // 2) 打分：优先向量，失败降级词法
  let scored = null;
  let method = 'lexical';
  if (embedConfig && embedConfig.apiKey) {
    try {
      const [qv] = await embed([normalizeText(query)], embedConfig);
      const vecs = await batchEmbed(all.map(c => normalizeText(c.text)), embedConfig);
      scored = all.map((c, i) => ({ ...c, score: (qv && vecs[i]) ? cosine(qv, vecs[i]) : 0 }));
      method = 'vector';
    } catch (_e) {
      scored = null;   // 落到词法
    }
  }
  if (!scored) {
    const qTokens = tokenize(normalizeText(query));
    scored = all.map(c => ({ ...c, score: lexicalScore(qTokens, normalizeText(c.text)) }));
    method = 'lexical';
  }

  // 3) 分数阈值动态选取（不是固定条数）：保留 ≥ 最高分×比例 且过绝对下限的段落，
  //    弱相关自动丢弃 → 引用篇数随相关度浮动。若全部低于显式阈值就返回空，不能偷偷保底绕过阈值。
  scored.sort((a, b) => b.score - a.score || a.di - b.di || a.offset - b.offset);
  const best = scored[0].score;
  if (best <= 0) {
    // 向量明确给出 0 相似度时应判空；词法 0 可能只是同义表达，仍交给后续 LLM 法官语义判断。
    return { docs: method === 'vector' ? [] : docs.filter(d => d && d.content), chunks: [], method };
  }
  const ratio = opts.keepRatio != null ? opts.keepRatio : 0.62;
  const floor = method === 'vector' ? (opts.vectorFloor != null ? opts.vectorFloor : 0.30) : 0;
  const bar = Math.max(floor, best * ratio);
  const top = scored.filter(c => c.score >= bar).slice(0, topChunks);

  // 4) 段落按文档归组，文档按最佳段落分排序，段内按原文顺序拼接
  const byDoc = new Map();
  for (const c of top) {
    if (!byDoc.has(c.di)) byDoc.set(c.di, { di: c.di, best: c.score, chunks: [] });
    const g = byDoc.get(c.di);
    g.chunks.push(c);
    if (c.score > g.best) g.best = c.score;
  }
  const groups = [...byDoc.values()].sort((a, b) => b.best - a.best);
  const rankedDocs = groups.map(g => {
    const d = docs[g.di];
    const ordered = g.chunks.slice().sort((a, b) => a.offset - b.offset);
    const bestChunk = g.chunks.slice().sort((a, b) => b.score - a.score)[0];
    return {
      ...d,
      content: ordered.map(c => c.evidenceText || c.text).join('\n……\n'),
      _score: g.best,
      _anchorText: bestChunk.evidenceText || bestChunk.text,
    };
  });

  // 调试信息：每篇候选的最高分 + 是否入选（供界面透明展示"为什么检索到它"）
  const bestByDoc = new Map();
  const bestChunkByDoc = new Map();
  for (const c of scored) {
    const cur = bestByDoc.get(c.di);
    if (cur == null || c.score > cur) { bestByDoc.set(c.di, c.score); bestChunkByDoc.set(c.di, c); }
  }
  const keptDis = new Set(groups.map(g => g.di));
  const debug = [...bestByDoc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([di, score]) => ({
      title: (docs[di] && docs[di].title) || '',
      token: (docs[di] && docs[di].token) || '',
      source: (docs[di] && (docs[di].source || docs[di].type)) || '',
      url: (docs[di] && docs[di].url) || '',
      passage: String((bestChunkByDoc.get(di) && (bestChunkByDoc.get(di).evidenceText || bestChunkByDoc.get(di).text)) || '').replace(/\s+/g, ' ').slice(0, 360),
      score: Number(score.toFixed(3)), kept: keptDis.has(di),
    }));

  return { docs: rankedDocs, chunks: top, method, bar: Number(bar.toFixed(3)), debug };
}

module.exports = { chunkText, cosine, tokenize, lexicalScore, embed, batchEmbed, rankDocs };
