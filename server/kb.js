// server/kb.js — 每用户本地知识库（上传的补充文档）。按 openId 隔离存储，
// 检索时与飞书文档一起参与关键词匹配（命中即作为参考资料 + 喂给 AI）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KB_DIR = path.join(__dirname, '..', 'data', 'kb');

function fileFor(openId) {
  // openId 里可能有特殊字符，做个安全文件名
  const safe = crypto.createHash('md5').update(String(openId)).digest('hex');
  return path.join(KB_DIR, safe + '.json');
}

function load(openId) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(openId), 'utf-8'));
  } catch (_e) {
    return [];
  }
}

function save(openId, docs) {
  fs.mkdirSync(KB_DIR, { recursive: true });
  fs.writeFileSync(fileFor(openId), JSON.stringify(docs, null, 2), 'utf-8');
}

/** 新增一篇文档，返回不含正文的摘要信息 */
function addDoc(openId, { title, content }) {
  if (!openId) throw new Error('openId required');
  const docs = load(openId);
  const doc = {
    id: crypto.randomBytes(8).toString('hex'),
    title: (title || '未命名文档').slice(0, 120),
    content: content || '',
    uploadedAt: new Date().toISOString(),
  };
  docs.unshift(doc);
  save(openId, docs);
  return meta(doc);
}

function listDocs(openId) {
  return load(openId).map(meta);
}

function deleteDoc(openId, id) {
  const docs = load(openId);
  const next = docs.filter(d => d.id !== id);
  if (next.length === docs.length) return false;
  save(openId, next);
  return true;
}

/** 关键词检索本地知识库：标题/正文命中打分，返回带正文的结果（无需再 fetch） */
function searchKb(openId, query) {
  const kws = String(query || '').split(/\s+/).filter(Boolean);
  if (!kws.length) return [];
  const docs = load(openId);
  const scored = docs
    .map(d => {
      const hay = (d.title + ' ' + d.content);
      const s = kws.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
      return { d, s };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.map(x => ({
    title: x.d.title,
    type: 'kb',
    token: 'kb_' + x.d.id,
    url: '',
    owner: '',
    editTime: (x.d.uploadedAt || '').slice(0, 10),
    source: 'kb',
    content: x.d.content,   // 已带正文
  }));
}

function meta(d) {
  return { id: d.id, title: d.title, uploadedAt: d.uploadedAt, size: (d.content || '').length };
}

module.exports = { addDoc, listDocs, deleteDoc, searchKb };
