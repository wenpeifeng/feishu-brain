'use strict';

if (process.argv.includes('--timing')) process.env.RAG_TIMING = '1';
if (process.argv.includes('--cold-decisions')) process.env.LLM_DECISION_CACHE_BYPASS = '1';
require('../server/env');
const fs = require('fs');
const { runRAGStream } = require('../server/rag');
const { resolveProvider } = require('../server/providers');
const { getConfig } = require('../server/store');

(async () => {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const question = args.find(x => !x.startsWith('--')) || '澳储还有需求吗';
  const startedAt = Date.now();
  const sessions = JSON.parse(fs.readFileSync('data/sessions.json', 'utf8'));
  const user = Object.values(sessions).filter(x => x.expireAt > Date.now()).sort((a, b) => b.expireAt - a.expireAt)[0];
  if (!user) throw new Error('没有有效飞书会话');
  const provider = resolveProvider({});
  if (!provider.apiKey) throw new Error('当前环境没有默认模型 Key');
  const cfg = { ...getConfig(), providerId: provider.id, apiKey: provider.apiKey, retrievalOnly: !full, adversarial: false };
  let references = [], related = [], debug = null, answer = '', firstTokenMs = null, conflict = '';
  for await (const ev of runRAGStream(user, question, [], false, cfg)) {
    if (ev.type === 'references') references = ev.references || [];
    if (ev.type === 'relatedEvidence') related = ev.evidence || [];
    if (ev.type === 'debug') debug = ev.debug;
    if (ev.type === 'token') {
      if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
      answer += ev.delta || '';
    }
    if (ev.type === 'answerFinal') answer = ev.text || '';
    if (ev.type === 'conflict') conflict = ev.text || '';
  }
  const out = {
    question,
    mode: full ? 'full' : 'retrieval',
    elapsedMs: Date.now() - startedAt,
    firstTokenMs,
    answer: answer.slice(0, 1200),
    conflict,
    queryPlan: debug && debug.queryPlan,
    references: references.map(x => x.title), related: related.map(x => x.title),
    candidates: (debug && debug.candidates || []).map(x => ({ title: x.title, vector: x.vscore, judge: x.jscore, rank: x.rank, selected: x.selected, passage: x.passage })),
  };
  console.log(JSON.stringify(out, null, 2));
  if (references.some(x => x.title.includes('不涉及澳储'))) throw new Error('低质量局部线索仍进入主参考');
  if (!references.some(x => x.title.includes('第二期') || /2026\/0[67]\/(?:08|24)/.test(x.title))) throw new Error('二期需求直接答案没有进入主参考');
  if (/最新|最近|当前|在做/.test(question) && !references.some(x => /2026\/07\/22/.test(x.title))) {
    throw new Error('状态类问题没有采用当前语料中最新的7月22日周报');
  }
  const direct = (debug && debug.candidates || []).filter(x => /第二期部份需求已经启动|相关需求文档|需求暂时没有和发售电/.test(x.title || ''));
  if (direct.length < 2) throw new Error('候选池没有稳定召回旧算法中的直接聊天证据');
  const launched = (debug && debug.candidates || []).find(x => /第二期部份需求已经启动/.test(x.title || ''));
  if (!launched || !launched.selected) throw new Error('明确写明二期已启动的直接证据没有进入主参考');
  const eligible = debug && Number(debug.eligible || 0);
  if (eligible > references.length && !related.length) throw new Error('法官通过但未参与回答的资料没有进入更多相关结果');
  if (full) {
    if (!answer.trim()) throw new Error('完整链路没有生成回答');
    if (!/(有需求|需求.{0,12}(启动|推进|开发)|第二期.{0,12}(启动|开展))/.test(answer)) throw new Error('回答没有明确覆盖需求仍在推进的核心结论');
    const citations = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
    if (!citations.length) throw new Error('完整回答没有引用角标');
    if (citations.some(n => n < 1 || n > references.length)) throw new Error('回答存在超出参考列表范围的引用角标');
    if (/PRD.{0,10}(计划)?下周/.test(answer) && !/(当时|截至|7月1[45]日|原计划)/.test(answer)) {
      throw new Error('回答把历史资料中的相对时间当成当前计划');
    }
    if (/计划(在|于)?7月20日/.test(answer) && !/原计划(在|于)?7月20日/.test(answer)) {
      throw new Error('回答把已经过去的计划日期写成当前计划');
    }
    if (/^(根据|基于)(提供的)?(资料|文档|参考)/.test(answer.trim())) throw new Error('回答使用了禁止的资料式开场');
  }
  process.exit(0);
})().catch(err => { console.error('live-rag-australia FAILED:', err.message); process.exit(1); });
