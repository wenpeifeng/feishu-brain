'use strict';

/**
 * 定时追踪调度器：每 30s 轮询一次到点的任务，用任务所属用户自己的登录态跑一遍 RAG，
 * 把答案通过机器人主动推到该用户的飞书。
 *
 * 关键点：
 *  - 权限隔离：用 user_access_token 检索，和网页/机器人一致，不越权。
 *  - token 续期：定时任务在 access_token 过期后才跑，运行前用 refresh_token 续期并回写会话。
 *  - 防重复：同一分钟内 30s 轮询会命中两次，先 markRun 认领再执行，避免重复推送。
 */
const { dueTasks, markRun } = require('./tasks');
const { getSessionByOpenIdAny, updateTokens } = require('./session');
const { refreshUserToken } = require('./auth');
const { runRAGStream } = require('./rag');
const { pushText, formatAnswer, userConfig } = require('./feishubot');
const { logQuestion } = require('./analytics');

const TICK_MS = 30 * 1000;

/** 确保会话 token 未过期；快过期就用 refresh_token 续期并回写。返回可用的 ctx，或 null（无法续期）。 */
async function ensureFreshToken(ctx) {
  if ((ctx.expireAt || 0) > Date.now() + 60 * 1000) return ctx;   // 还有 >1min，直接用
  if (!ctx.refreshToken) return null;
  try {
    const t = await refreshUserToken(ctx.refreshToken);
    updateTokens(ctx.token, t);   // updateTokens 直接改的就是同一个 ctx 引用，改完 ctx 即最新
    return ctx;
  } catch (_e) {
    return null;   // refresh_token 也过期了（>30天没登录）→ 放弃，任务今天不推
  }
}

/** 跑一个任务：检索作答 → 推送。 */
async function runOne(task) {
  const base = getSessionByOpenIdAny(task.openId);
  if (!base) return;                                  // 用户从没登录过 / 已登出
  const ctx = await ensureFreshToken(base);
  if (!ctx) {
    await pushText(task.openId, `⏰ 定时追踪「${task.question}」需要你重新登录飞书知识问答后才能继续，登录态已过期。`).catch(() => {});
    return;
  }

  let answer = '';
  let references = [];
  try {
    for await (const ev of runRAGStream(ctx, task.question, [], false, userConfig(ctx))) {
      if (ev.type === 'token') answer += ev.delta || '';
      if (ev.type === 'answerFinal') answer = ev.text || '';
      if (ev.type === 'references') references = ev.references || [];
    }
  } catch (_e) {
    await pushText(task.openId, `⏰ 定时追踪「${task.question}」这次没跑成功，明天会再试。`).catch(() => {});
    return;
  }

  // 只沉淀匿名化问答统计；定时追踪也必须实时检索，绝不把生成答案写入可回放缓存。
  try { logQuestion(task.openId, task.question, references.length); } catch (_e) { /* ignore */ }

  const hh = String(task.hour).padStart(2, '0'), mm = String(task.minute).padStart(2, '0');
  const head = `⏰ 定时追踪 · 每天 ${hh}:${mm}\n【${task.question}】\n\n`;
  const foot = '\n\n—— 来自「飞书知识问答」，回复我可继续追问';
  await pushText(task.openId, head + formatAnswer(answer, references) + foot).catch(() => {});
}

async function tick() {
  let due;
  try { due = dueTasks(Date.now()); } catch (_e) { return; }
  if (!due.length) return;
  const now = Date.now();
  for (const t of due) markRun(t.id, now);            // 先认领，闭掉 30s 双触发的竞态
  for (const t of due) {
    try { await runOne(t); } catch (_e) { /* 单个任务失败不影响其它 */ }
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('⏰ 定时追踪调度器已启动（每 30s 轮询）');
}

module.exports = { start, tick, runOne };
