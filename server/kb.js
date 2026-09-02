// server/kb.js — 每用户本地知识库（上传的补充文档），按 openId 隔离存储。
// hybrid 检索：上传即切块 + embedding 建索引；查询时 BM25(稀疏) + 向量(稠密) 双路 RRF 融合。
// 这是"我们自有数据"上能完整落地生产级 RAG 召回的地方（飞书文档受其关键词搜索限制，做不到稠密）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chunkText, tokenize, cosine, embed, batchEmbed } = require('./semantic');

const KB_DIR = path.join(__dirname, '..', 'data', 'kb');
const INDEX_SCHEMA_VERSION = 2;
const writeQueues = new Map();

function fileFor(openId) {
  const safe = crypto.createHash('md5').update(String(openId)).digest('hex');
  return path.join(KB_DIR, safe + '.json');
}

function hashOf(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function embeddingIdentity(embedConfig) {
  if (!embedConfig || !embedConfig.apiKey) return '';
  return hashOf(`${String(embedConfig.url || embedConfig.baseUrl || '')}|${String(embedConfig.model || '')}`).slice(0, 20);
}

function normalizeDoc(d) {
  const content = String((d && d.content) || '');
  const chunks = Array.isArray(d && d.chunks) ? d.chunks.map((c, i) => ({
    id: c.id || `${hashOf(c.text).slice(0, 16)}:${i}`,
    hash: c.hash || hashOf(c.text),
    text: String(c.text || ''),
    offset: Number(c.offset) || 0,
    ...(Array.isArray(c.vec) ? { vec: c.vec } : {}),
    embeddingKey: c.embeddingKey || '',
  })) : [];
  return {
    ...d,
    content,
    chunks,
    revision: Math.max(1, Number(d && d.revision) || 1),
    schemaVersion: Number(d && d.schemaVersion) || 1,
    contentHash: (d && d.contentHash) || hashOf(content),
    updatedAt: (d && (d.updatedAt || d.uploadedAt)) || new Date(0).toISOString(),
    index: (d && d.index) || {
      mode: chunks.some(c => c.vec) ? 'legacy_vector' : 'keyword',
      embeddingKey: '',
      chunkCount: chunks.length,
      vectorCount: chunks.filter(c => c.vec).length,
      updatedAt: (d && (d.updatedAt || d.uploadedAt)) || new Date(0).toISOString(),
    },
  };
}

function load(openId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(openId), 'utf-8'));
    return Array.isArray(parsed) ? parsed.map(normalizeDoc) : [];
  } catch (_e) { return []; }
}

function save(openId, docs) {
  fs.mkdirSync(KB_DIR, { recursive: true });
  const target = fileFor(openId);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(docs), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_ignore) { /* best effort */ }
    throw e;
  }
}

function withUserWrite(openId, task) {
  const key = String(openId || '');
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}

async function buildIndex(content, embedConfig, previousChunks = [], force = false) {
  const raw = chunkText(String(content || ''), { size: 500, overlap: 100 });
  const embedKey = embeddingIdentity(embedConfig);
  const reusable = new Map();
  if (embedKey && !force) {
    for (const old of previousChunks) {
      if (!Array.isArray(old.vec) || old.embeddingKey !== embedKey) continue;
      const h = old.hash || hashOf(old.text);
      if (!reusable.has(h)) reusable.set(h, []);
      reusable.get(h).push(old);
    }
  }

  const chunks = [];
  const missing = [];
  let reusedCount = 0;
  const occurrence = new Map();
  for (const c of raw) {
    const text = String(c.text || '');
    const hash = hashOf(text);
    const n = occurrence.get(hash) || 0;
    occurrence.set(hash, n + 1);
    const next = { id: `${hash.slice(0, 16)}:${n}`, hash, text, offset: Number(c.offset) || 0, embeddingKey: embedKey };
    const bucket = reusable.get(hash);
    const old = bucket && bucket.find(x => x.text === text);
    if (old) {
      next.vec = old.vec;
      bucket.splice(bucket.indexOf(old), 1);
      reusedCount++;
    } else if (embedKey) {
      missing.push(chunks.length);
    }
    chunks.push(next);
  }

  if (missing.length) {
    let vecs;
    try {
      vecs = await batchEmbed(missing.map(i => chunks[i].text), embedConfig, 32);
    } catch (e) {
      const err = new Error(`向量索引构建失败，旧版本未修改：${e.message || e}`);
      err.code = 'INDEX_BUILD_FAILED';
      throw err;
    }
    if (!Array.isArray(vecs) || vecs.length !== missing.length || vecs.some(v => !Array.isArray(v))) {
      const err = new Error('向量索引返回不完整，旧版本未修改');
      err.code = 'INDEX_BUILD_FAILED';
      throw err;
    }
    missing.forEach((chunkIndex, i) => { chunks[chunkIndex].vec = vecs[i]; });
  }

  const vectorCount = chunks.filter(c => Array.isArray(c.vec)).length;
  return {
    chunks,
    index: {
      mode: embedKey && vectorCount === chunks.length ? 'vector' : 'keyword',
      embeddingKey: embedKey,
      chunkCount: chunks.length,
      vectorCount,
      reusedVectorCount: reusedCount,
      embeddedVectorCount: missing.length,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 新增一篇文档：切块，并（若给了 embedConfig）为每块建向量索引。返回摘要。
 * @param {string} openId
 * @param {{title, content}} doc
 * @param {object|null} embedConfig  智谱等 embedding 配置；为空则只建词法索引（BM25 仍可用）
 */
async function addDoc(openId, { title, content }, embedConfig) {
  if (!openId) throw new Error('openId required');
  return withUserWrite(openId, async () => {
    const text = String(content || '');
    const built = await buildIndex(text, embedConfig);
    const now = new Date().toISOString();
    const doc = {
      id: crypto.randomBytes(8).toString('hex'),
      title: String(title || '未命名文档').slice(0, 120),
      content: text,
      contentHash: hashOf(text),
      chunks: built.chunks,
      index: built.index,
      revision: 1,
      schemaVersion: INDEX_SCHEMA_VERSION,
      uploadedAt: now,
      updatedAt: now,
      embedded: built.index.mode === 'vector',
    };
    const docs = load(openId);
    docs.unshift(doc);
    save(openId, docs);
    return meta(doc);
  });
}

function listDocs(openId) { return load(openId).map(meta); }

function getDoc(openId, id) {
  const doc = load(openId).find(d => d.id === id);
  return doc ? { ...meta(doc), content: doc.content } : null;
}

async function updateDoc(openId, id, patch, embedConfig, opts = {}) {
  if (!openId) throw new Error('openId required');
  return withUserWrite(openId, async () => {
    const docs = load(openId);
    const index = docs.findIndex(d => d.id === id);
    if (index < 0) return null;
    const old = docs[index];
    const expected = opts.expectedRevision == null ? null : Number(opts.expectedRevision);
    if (expected != null && expected !== old.revision) {
      const err = new Error(`文档已更新，请刷新后重试（当前版本 v${old.revision}）`);
      err.code = 'REVISION_CONFLICT';
      err.currentRevision = old.revision;
      throw err;
    }
    const title = patch.title === undefined ? old.title : String(patch.title || '未命名文档').slice(0, 120);
    const content = patch.content === undefined ? old.content : String(patch.content || '');
    const nextHash = hashOf(content);
    const embedKey = embeddingIdentity(embedConfig);
    const indexCurrent = embedKey
      ? old.index && old.index.embeddingKey === embedKey &&
        old.index.chunkCount === old.index.vectorCount && old.index.mode === 'vector'
      : old.index && old.index.mode === 'keyword';
    if (!opts.forceReindex && title === old.title && nextHash === old.contentHash && indexCurrent) {
      return { ...meta(old), unchanged: true };
    }

    const built = await buildIndex(content, embedConfig, old.chunks, !!opts.forceReindex);
    const now = new Date().toISOString();
    const next = {
      ...old,
      title,
      content,
      contentHash: nextHash,
      chunks: built.chunks,
      index: built.index,
      revision: old.revision + 1,
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt: now,
      embedded: built.index.mode === 'vector',
    };
    docs[index] = next;
    save(openId, docs);
    return meta(next);
  });
}

async function reindexAll(openId, embedConfig) {
  const snapshot = listDocs(openId);
  const results = [];
  for (const doc of snapshot) {
    try {
      const next = await updateDoc(openId, doc.id, {}, embedConfig, {
        expectedRevision: doc.revision,
        forceReindex: true,
      });
      results.push({ id: doc.id, ok: true, doc: next });
    } catch (e) {
      results.push({ id: doc.id, ok: false, error: e.message, code: e.code || 'INDEX_ERROR' });
    }
  }
  return {
    total: results.length,
    succeeded: results.filter(x => x.ok).length,
    failed: results.filter(x => !x.ok).length,
    results,
  };
}

async function deleteDoc(openId, id, expectedRevision) {
  return withUserWrite(openId, async () => {
    const docs = load(openId);
    const current = docs.find(d => d.id === id);
    if (!current) return false;
    if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
      const err = new Error(`文档已更新，请刷新后再删除（当前版本 v${current.revision}）`);
      err.code = 'REVISION_CONFLICT';
      err.currentRevision = current.revision;
      throw err;
    }
    save(openId, docs.filter(d => d.id !== id));
    return true;
  });
}

// ── BM25（稀疏检索）：CJK 友好分词，标准 BM25 打分 ─────────────────────────────
function bm25Scores(query, chunkTexts) {
  const qTokens = [...new Set(tokenize(query))];
  const N = chunkTexts.length;
  if (!N || !qTokens.length) return chunkTexts.map(() => 0);
  const docToks = chunkTexts.map(t => tokenize(t));
  const avgdl = docToks.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map();
  for (const toks of docToks) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const k1 = 1.5, b = 0.75;
  return docToks.map(toks => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks.length / avgdl));
    }
    return score;
  });
}

/** 由排名列表生成 RRF 贡献（rank 从 0 起）；score>0 才计入。 */
function rrfAccumulate(fuse, orderedIdx, K = 60) {
  orderedIdx.forEach((idx, rank) => { fuse.set(idx, (fuse.get(idx) || 0) + 1 / (K + rank)); });
}

/**
 * hybrid 检索本地知识库：BM25 + 向量(若有) 双路 RRF 融合，返回最相关的若干篇（带正文，供下游精排/法官）。
 * @param {string} openId
 * @param {string} query
 * @param {object|null} embedConfig  用于把 query 向量化做稠密召回；为空则只用 BM25
 * @param {{topDocs?:number}} opts
 * @returns {Promise<Array>}  形如 searchDocs 的条目（source:'kb', 带 content）
 */
async function searchKbHybrid(openId, query, embedConfig, opts = {}) {
  const topDocs = opts.topDocs || 5;
  const docs = load(openId);
  if (!docs.length || !String(query || '').trim()) return [];
  const embedKey = embeddingIdentity(embedConfig);

  // 展平所有块（老数据无 chunks → 现切；无 vec → 只参与 BM25）
  const chunks = [];
  for (const d of docs) {
    const cs = (d.chunks && d.chunks.length) ? d.chunks : chunkText(d.content || '', { size: 500, overlap: 100 });
    for (const c of cs) {
      const compatibleVec = embedKey && c.embeddingKey === embedKey && Array.isArray(c.vec) ? c.vec : null;
      chunks.push({ text: c.text, vec: compatibleVec, doc: d });
    }
  }
  if (!chunks.length) return [];

  // 稀疏：BM25
  const bm = bm25Scores(query, chunks.map(c => c.text));
  const bmOrder = bm.map((s, i) => ({ i, s })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.i);

  // 稠密：query 向量 × 各块向量
  let denseOrder = null;
  if (embedConfig && embedConfig.apiKey && chunks.some(c => c.vec)) {
    try {
      const [qv] = await embed([query], embedConfig);
      if (qv) {
        denseOrder = chunks.map((c, i) => ({ i, s: c.vec ? cosine(qv, c.vec) : -1 }))
          .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.i);
      }
    } catch (_e) { denseOrder = null; }
  }

  // RRF 融合两路排名
  const fuse = new Map();
  rrfAccumulate(fuse, bmOrder);
  if (denseOrder) rrfAccumulate(fuse, denseOrder);
  const ranked = [...fuse.entries()].sort((a, b) => b[1] - a[1]);

  // 取每篇文档最靠前的块，按文档去重，返回 topDocs 篇
  const byDoc = new Map();
  for (const [ci] of ranked) {
    const c = chunks[ci];
    if (!byDoc.has(c.doc.id)) byDoc.set(c.doc.id, c.doc);
    if (byDoc.size >= topDocs * 3) break;   // 早停，避免遍历过多
  }
  return [...byDoc.values()].slice(0, topDocs).map(d => ({
    title: d.title, type: 'kb', token: (opts.scope === 'organization' ? 'kb_org_' : 'kb_') + d.id, url: '',
    owner: '', editTime: (d.updatedAt || d.uploadedAt || '').slice(0, 10), source: 'kb',
    content: d.content, kbRevision: d.revision, contentHash: d.contentHash,
    kbScope: opts.scope === 'organization' ? 'organization' : 'personal',
  }));
}

// 关键词检索（旧接口，保留兼容）：标题/正文命中打分
function searchKb(openId, query) {
  const kws = String(query || '').split(/\s+/).filter(Boolean);
  if (!kws.length) return [];
  const docs = load(openId);
  return docs
    .map(d => ({ d, s: kws.reduce((acc, k) => acc + ((d.title + ' ' + d.content).includes(k) ? 1 : 0), 0) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => ({
      title: x.d.title, type: 'kb', token: 'kb_' + x.d.id, url: '', owner: '',
      editTime: (x.d.uploadedAt || '').slice(0, 10), source: 'kb', content: x.d.content,
    }));
}

function meta(d) {
  const index = d.index || {};
  return {
    id: d.id,
    title: d.title,
    uploadedAt: d.uploadedAt,
    updatedAt: d.updatedAt || d.uploadedAt,
    revision: Math.max(1, Number(d.revision) || 1),
    size: (d.content || '').length,
    // 旧数据没有 embedding identity，不能证明与当前查询向量同空间；必须显式重建后才算可用。
    embedded: index.mode === 'vector',
    indexMode: index.mode || (d.embedded ? 'legacy_vector' : 'keyword'),
    chunkCount: Number(index.chunkCount) || (d.chunks || []).length,
    vectorCount: Number(index.vectorCount) || 0,
    reusedVectorCount: Number(index.reusedVectorCount) || 0,
    embeddedVectorCount: Number(index.embeddedVectorCount) || 0,
  };
}

module.exports = {
  addDoc, getDoc, listDocs, updateDoc, reindexAll, deleteDoc,
  searchKb, searchKbHybrid, bm25Scores, embeddingIdentity,
};
