'use strict';

/**
 * 定时追踪：让用户"订阅"一个问题，每天固定时间由机器人主动跑一遍问答、把答案推到飞书。
 * 场景：每天早上自动收到「昨天线上有没有故障复盘」「本周迁移进度」的最新答案，不用手动问。
 *
 * 存储：data/tasks.json，按 openId 归属。每个任务 { id, openId, question, hour, minute, enabled, lastRun, createdAt }。
 * 运行由 server/scheduler.js 每 30s 轮询：命中「本地时:分」且今天没跑过（lastRun）就执行。
 * 权限隔离：跑的时候用任务所属用户自己的 user_access_token 检索（和网页/机器人完全一致）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'tasks.json');
const MAX_PER_USER = 20;   // 每人最多 20 个定时任务，防滥用

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_e) { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}
function persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(load(), null, 2)); } catch (_e) { /* 落盘失败不影响主流程 */ }
}

/** 本地日期串（YYYY-M-D）——用作"今天是否已跑"的去重键，与调度用同一时区口径 */
function ymd(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** 新建任务；返回任务对象，或 { error } */
function addTask(openId, { question, hour, minute }) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) return { error: '请填写要追踪的问题' };
  const c = load();
  if (c.filter(t => t.openId === openId).length >= MAX_PER_USER) return { error: `最多只能创建 ${MAX_PER_USER} 个定时任务` };
  const t = {
    id: 't_' + crypto.randomBytes(6).toString('hex'),
    openId,
    question: q,
    hour: clampInt(hour, 0, 23),
    minute: clampInt(minute, 0, 59),
    enabled: true,
    lastRun: '',
    createdAt: Date.now(),
  };
  c.unshift(t);
  persist();
  return t;
}

/** 该用户的全部任务（新建在前） */
function listTasks(openId) {
  return load().filter(t => t.openId === openId);
}

/** 删除（仅本人可删自己的） */
function removeTask(openId, id) {
  const c = load();
  const next = c.filter(t => !(t.id === id && t.openId === openId));
  if (next.length === c.length) return false;
  cache = next;
  persist();
  return true;
}

/** 启用/停用（仅本人） */
function toggleTask(openId, id, enabled) {
  const t = load().find(x => x.id === id && x.openId === openId);
  if (!t) return false;
  t.enabled = !!enabled;
  persist();
  return true;
}

/** 到点该跑的任务：启用中 + 命中本地时:分 + 今天还没跑过 */
function dueTasks(now) {
  const d = new Date(now);
  const hh = d.getHours(), mm = d.getMinutes(), today = ymd(now);
  return load().filter(t => t.enabled && t.hour === hh && t.minute === mm && t.lastRun !== today);
}

/** 标记今天已跑（去重，避免同一分钟内重复触发） */
function markRun(id, now) {
  const t = load().find(x => x.id === id);
  if (t) { t.lastRun = ymd(now); persist(); }
}

module.exports = { addTask, listTasks, removeTask, toggleTask, dueTasks, markRun, ymd, MAX_PER_USER };
