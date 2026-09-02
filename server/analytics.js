// server/analytics.js — 提问看板 + 反馈闭环的数据层。
// 记录每次提问（问题/命中参考数/时间/提问人）与 👍👎 反馈，用于：
//   - 个人提问历史与统计
//   - 知识盲区检测（命中0篇的问题 = 库里可能缺内容）
//   - FAQ 沉淀（高频问题）
// 隐私：按 openId 归属；看板默认只给本人看自己的（组织级聚合另做，需隐私设计）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'analytics.json');
const MAX = 5000;   // 最多保留最近 5000 条提问

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch (_e) { cache = { questions: [], feedback: {} }; }
  if (!cache.questions) cache.questions = [];
  if (!cache.feedback) cache.feedback = {};
  return cache;
}
function persist() {
  const c = load();
  if (c.questions.length > MAX) c.questions = c.questions.slice(-MAX);
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(c)); } catch (_e) { /* 记录失败不影响主流程 */ }
}

/** 记录一次提问，返回问题 id（供反馈关联） */
function logQuestion(openId, question, refCount, tenantId) {
  const c = load();
  const id = crypto.randomBytes(8).toString('hex');
  c.questions.push({
    id,
    openId: openId || '',
    tenantId: tenantId || '',
    q: String(question || '').slice(0, 300),
    refs: Number(refCount) || 0,
    ts: Date.now(),
  });
  persist();
  return id;
}

/** 记录反馈：vote = 'up' | 'down'；reason = 点踩原因（可空，用于 bad-case 闭环） */
function logFeedback(openId, questionId, vote, reason) {
  if (!questionId || (vote !== 'up' && vote !== 'down')) return false;
  const c = load();
  // 仅本人可对自己的提问反馈
  const q = c.questions.find(x => x.id === questionId);
  if (!q || (openId && q.openId && q.openId !== openId)) return false;
  const entry = { vote, ts: Date.now() };
  if (vote === 'down' && reason) entry.reason = String(reason).slice(0, 200);
  c.feedback[questionId] = entry;
  persist();
  return true;
}

/** 该用户的看板汇总：总数/今日/高频问题(FAQ候选)/知识盲区(命中0)/满意度 */
function getSummary(openId) {
  const c = load();
  const mine = c.questions.filter(x => x.openId === openId);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = mine.filter(x => x.ts >= dayStart.getTime()).length;

  // 高频问题（归一化后计数）
  const norm = s => String(s || '').replace(/[\s?？。.!！,，]/g, '').toLowerCase();
  const freq = new Map();
  for (const x of mine) {
    const k = norm(x.q);
    if (!k) continue;
    if (!freq.has(k)) freq.set(k, { q: x.q, count: 0 });
    freq.get(k).count++;
  }
  const top = [...freq.values()].filter(x => x.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10);

  // 知识盲区：命中 0 篇参考的问题（库里可能缺）
  const gaps = mine.filter(x => x.refs === 0).slice(-20).reverse().map(x => x.q);
  const gapUniq = [...new Set(gaps)].slice(0, 10);

  // 满意度 + 待改进（bad-case：点踩的问题，带原因，供作者定向补资料/修检索）
  let up = 0, down = 0;
  const badcases = [];
  for (const x of mine) {
    const f = c.feedback[x.id];
    if (f && f.vote === 'up') up++;
    if (f && f.vote === 'down') { down++; badcases.push({ q: x.q, reason: f.reason || '', ts: f.ts }); }
  }
  badcases.sort((a, b) => b.ts - a.ts);

  // 近 7 天提问趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const start = d.getTime(), end = start + 86400000;
    trend.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), count: mine.filter(x => x.ts >= start && x.ts < end).length });
  }
  // 知识覆盖率：有命中参考的提问占比
  const answered = mine.filter(x => x.refs > 0).length;
  const coverage = mine.length ? Math.round((answered / mine.length) * 100) : 0;

  return {
    total: mine.length,
    today,
    topQuestions: top,
    gaps: gapUniq,
    feedback: { up, down },
    badcases: badcases.slice(0, 15),
    coverage,
    trend,
    recent: mine.slice(-15).reverse().map(x => ({ q: x.q, refs: x.refs, ts: x.ts })),
  };
}

/** 组织级看板：跨所有用户聚合（管理员视角）。不含个人问题归属，只做汇总统计。 */
function getOrgSummary(openIds) {
  const c = load();
  const allowed = Array.isArray(openIds) ? new Set(openIds.map(String)) : null;
  const all = allowed ? c.questions.filter(x => allowed.has(String(x.openId))) : c.questions;
  const users = new Set(all.map(x => x.openId)).size;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = all.filter(x => x.ts >= dayStart.getTime()).length;

  const norm = s => String(s || '').replace(/[\s?？。.!！,，]/g, '').toLowerCase();
  const freq = new Map();
  for (const x of all) {
    const k = norm(x.q);
    if (!k) continue;
    if (!freq.has(k)) freq.set(k, { q: x.q, count: 0, u: new Set() });
    const f = freq.get(k); f.count++; f.u.add(x.openId);
  }
  const top = [...freq.values()].filter(x => x.count >= 2).sort((a, b) => b.count - a.count)
    .slice(0, 10).map(x => ({ q: x.q, count: x.count, users: x.u.size }));

  const gaps = [...new Set(all.filter(x => x.refs === 0).slice(-60).reverse().map(x => x.q))].slice(0, 12);

  let up = 0, down = 0;
  for (const x of all) { const f = c.feedback[x.id]; if (f && f.vote === 'up') up++; if (f && f.vote === 'down') down++; }

  const answered = all.filter(x => x.refs > 0).length;
  const coverage = all.length ? Math.round((answered / all.length) * 100) : 0;

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const s = d.getTime(), e = s + 86400000;
    trend.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), count: all.filter(x => x.ts >= s && x.ts < e).length });
  }

  return { total: all.length, users, today, coverage, trend, topQuestions: top, gaps, feedback: { up, down } };
}

module.exports = { logQuestion, logFeedback, getSummary, getOrgSummary };
