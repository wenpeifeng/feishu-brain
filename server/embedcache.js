'use strict';

/**
 * server/embedcache.js — embedding 结果缓存（按 模型+内容hash）。
 *
 * 目的：同一段文本只 embed 一次。生产上第二个问题命中同文档即免算；
 * 测试上评测集反复跑几乎零 token 消耗。持久化到 data/embed-cache.json。
 *
 * 向量按 5 位小数存储以缩小体积（对余弦相似度无实质影响）。
 * 超过 MAX 条时丢弃最旧的（近似 LRU：按插入顺序）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'embed-cache.json');
const MAX = 20000;

let store = null;
let dirty = false;
let flushTimer = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_e) { store = {}; }
  return store;
}
function keyOf(model, text) {
  return model + ':' + crypto.createHash('sha1').update(String(text)).digest('hex');
}
function get(model, text) {
  return load()[keyOf(model, text)] || null;
}
function put(model, text, vec) {
  const s = load();
  s[keyOf(model, text)] = vec.map(x => Math.round(x * 1e5) / 1e5);
  scheduleFlush();
}
function flush() {
  if (!dirty && store) return;
  const s = load();
  const keys = Object.keys(s);
  if (keys.length > MAX) {
    for (const k of keys.slice(0, keys.length - MAX)) delete s[k];
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, FILE); // 同文件系统原子替换，避免进程中断留下半个 JSON
    dirty = false;
  } catch (_e) { /* 缓存写失败不影响主流程 */ }
}
function stats() {
  return { size: Object.keys(load()).length };
}

// 通用键值（给法官打分等复用同一持久化存储）
function getRaw(key) {
  const s = load();
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null;
}
function putRaw(key, val) {
  load()[key] = val;
  scheduleFlush();
}

// 模型“决策”不是不可变事实。使用带时间戳的独立封装；旧版无时间戳条目一律视为失效，
// 避免一次错误纠错/法官判断被永久复用。Embedding 仍走 get/put，不受此 TTL 影响。
function getRawFresh(key, maxAgeMs, now = Date.now()) {
  const entry = getRaw(key);
  if (!entry || entry.__timedCacheV1 !== true || !Number.isFinite(entry.at)) return null;
  if (maxAgeMs >= 0 && now - entry.at > maxAgeMs) {
    delete load()[key]; scheduleFlush(); return null;
  }
  return entry.value;
}

function putRawTimed(key, value, now = Date.now()) {
  putRaw(key, { __timedCacheV1: true, at: now, value });
}

function decisionEpochKey(question) { return keyOf('__decision_epoch__', String(question || '')); }
function getDecisionEpoch(question) { return Number(getRaw(decisionEpochKey(question))) || 0; }
function bumpDecisionEpoch(question) {
  const next = getDecisionEpoch(question) + 1;
  putRaw(decisionEpochKey(question), next);
  return next;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1500);
  // 缓存落盘不能阻止 CLI/测试进程正常退出。
  if (flushTimer.unref) flushTimer.unref();
}

module.exports = { get, put, getRaw, putRaw, getRawFresh, putRawTimed, getDecisionEpoch, bumpDecisionEpoch, flush, stats, keyOf };
