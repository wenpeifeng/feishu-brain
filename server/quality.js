'use strict';

const fs = require('fs');
const path = require('path');
const { selectEvidence } = require('./evidence');
const decisionCache = require('./embedcache');

const FILE = process.env.QUALITY_CASES_FILE || path.join(__dirname, '..', 'data', 'quality-cases.json');
const MAX_CASES = 1500;

function readCases() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_e) { return []; }
}

function writeCases(cases) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cases.slice(0, MAX_CASES), null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function cleanEvidence(x, index) {
  return {
    key: String(x.token || x.url || x.title || index),
    title: String(x.title || '未命名资料').slice(0, 160),
    source: String(x.source || x.type || ''),
    url: String(x.url || ''),
    snippet: String(x.snippet || x.passage || '').replace(/\s+/g, ' ').slice(0, 500),
    vectorScore: x.vscore != null ? Number(x.vscore) : (x.score != null ? Number(x.score) : null),
    judgeScore: x.jscore != null ? Number(x.jscore) : (x.judgeScore != null ? Number(x.judgeScore) : null),
    evidenceRank: x.rank != null ? Number(x.rank) : (x.evidenceRank != null ? Number(x.evidenceRank) : null),
    eligible: x.kept !== false,
    selected: !!x.selected,
    recheck: String(x.recheck || ''),
  };
}

function priorityOf(input) {
  if (input.feedback === 'down' || input.noResult || input.conflict) return 'high';
  if (input.confidence && input.confidence.level === 'medium') return 'medium';
  if ((input.relatedEvidence || []).length) return 'medium';
  return 'normal';
}

function recordQualityCase(input) {
  if (!input || !input.qid || !input.question) return null;
  const cases = readCases();
  const candidates = ((input.debug && input.debug.candidates) || []).map(cleanEvidence);
  const selectedKeys = new Set((input.references || []).map((x, i) => String(x.token || x.url || x.title || i)));
  candidates.forEach(c => { if (selectedKeys.has(c.key)) c.selected = true; });
  const item = {
    id: String(input.qid),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.createdAt || new Date().toISOString(),
    openId: String(input.openId || ''),
    tenantId: String(input.tenantId || ''),
    userName: String(input.userName || '').slice(0, 80),
    question: String(input.question).slice(0, 1000),
    answer: String(input.answer || '').slice(0, 8000),
    provider: { id: String((input.provider && input.provider.id) || ''), model: String((input.provider && input.provider.model) || '') },
    references: (input.references || []).map(cleanEvidence),
    relatedEvidence: (input.relatedEvidence || []).map(cleanEvidence),
    candidates,
    trace: {
      recalled: Number((input.debug && input.debug.recalled) || 0),
      read: Number((input.debug && input.debug.read) || 0),
      eligible: Number((input.debug && input.debug.eligible) || 0),
      selected: Number((input.debug && input.debug.selected) || (input.references || []).length),
      method: String((input.debug && input.debug.method) || ''),
      degraded: !!(input.debug && input.debug.degraded),
    },
    signals: {
      noResult: !!input.noResult,
      conflict: String(input.conflict || '').slice(0, 500),
      confidence: input.confidence || null,
      feedback: input.feedback || '',
      feedbackReason: String(input.feedbackReason || '').slice(0, 500),
    },
    priority: priorityOf(input),
    status: 'pending',
    label: { answer: '', note: '', evidence: {} },
  };
  const old = cases.findIndex(x => x.id === item.id);
  if (old >= 0) cases.splice(old, 1);
  cases.unshift(item);
  writeCases(cases);
  return item;
}

function listQualityCases(filters = {}) {
  let cases = readCases();
  if (filters.openId) cases = cases.filter(x => x.openId === String(filters.openId));
  if (Array.isArray(filters.openIds)) {
    const allowed = new Set(filters.openIds.map(String));
    cases = cases.filter(x => allowed.has(String(x.openId)));
  }
  if (filters.tenantId) cases = cases.filter(x => x.tenantId === String(filters.tenantId));
  if (filters.status && filters.status !== 'all') cases = cases.filter(x => x.status === filters.status);
  if (filters.priority && filters.priority !== 'all') cases = cases.filter(x => x.priority === filters.priority);
  const q = String(filters.q || '').toLowerCase();
  if (q) cases = cases.filter(x => x.question.toLowerCase().includes(q));
  let all = readCases();
  if (filters.openId) all = all.filter(x => x.openId === String(filters.openId));
  if (Array.isArray(filters.openIds)) {
    const allowed = new Set(filters.openIds.map(String));
    all = all.filter(x => allowed.has(String(x.openId)));
  }
  if (filters.tenantId) all = all.filter(x => x.tenantId === String(filters.tenantId));
  const summary = {
    total: all.length,
    pending: all.filter(x => x.status === 'pending').length,
    labeled: all.filter(x => x.status === 'labeled').length,
    high: all.filter(x => x.priority === 'high' && x.status === 'pending').length,
  };
  return { cases: cases.slice(0, Math.min(200, Number(filters.limit) || 100)), summary };
}

function updateQualityCase(id, patch, scope) {
  const cases = readCases();
  const filters = typeof scope === 'string' ? { openId: scope } : (scope || {});
  const allowed = Array.isArray(filters.openIds) ? new Set(filters.openIds.map(String)) : null;
  const item = cases.find(x => x.id === id &&
    (!filters.openId || x.openId === String(filters.openId)) &&
    (!filters.tenantId || x.tenantId === String(filters.tenantId)) &&
    (!allowed || allowed.has(String(x.openId))));
  if (!item) return null;
  if (['pending', 'labeled', 'ignored'].includes(patch.status)) item.status = patch.status;
  if (patch.label && typeof patch.label === 'object') {
    const answer = ['correct', 'partial', 'wrong', 'unanswerable'].includes(patch.label.answer) ? patch.label.answer : item.label.answer;
    const evidence = {};
    for (const [key, value] of Object.entries(patch.label.evidence || {})) {
      if (['relevant', 'irrelevant', 'unsure'].includes(value)) evidence[String(key).slice(0, 300)] = value;
    }
    item.label = { answer, note: String(patch.label.note || '').slice(0, 2000), evidence };
  }
  item.updatedAt = new Date().toISOString();
  writeCases(cases);
  return item;
}

function attachQualityFeedback(qid, vote, reason, openId) {
  const cases = readCases();
  const item = cases.find(x => x.id === String(qid) && (!openId || x.openId === String(openId)));
  if (!item) return false;
  item.signals.feedback = vote === 'down' ? 'down' : vote === 'up' ? 'up' : '';
  item.signals.feedbackReason = String(reason || '').slice(0, 500);
  if (vote === 'down') {
    item.priority = 'high';
    // 点踩意味着本次模型决策不可继续复用；按问题提升 epoch，让纠错/法官等缓存立即换 key。
    decisionCache.bumpDecisionEpoch(item.question);
  }
  item.updatedAt = new Date().toISOString();
  writeCases(cases);
  return true;
}

function getQualityMetrics(scope) {
  const filters = typeof scope === 'string' ? { openId: scope } : (scope || {});
  const allowed = Array.isArray(filters.openIds) ? new Set(filters.openIds.map(String)) : null;
  const labeled = readCases().filter(x => x.status === 'labeled' &&
    (!filters.openId || x.openId === String(filters.openId)) &&
    (!filters.tenantId || x.tenantId === String(filters.tenantId)) &&
    (!allowed || allowed.has(String(x.openId))));
  let answerCorrect = 0, answerCount = 0, labeledCandidates = 0;
  for (const x of labeled) {
    if (x.label && x.label.answer) { answerCount++; if (x.label.answer === 'correct') answerCorrect++; }
    labeledCandidates += Object.keys((x.label && x.label.evidence) || {}).length;
  }
  function scoreConfig(opts, useStored) {
    let tp = 0, fp = 0, fn = 0, selectedCount = 0, caseCount = 0;
    for (const x of labeled) {
      const labels = (x.label && x.label.evidence) || {};
      const gold = new Set(Object.keys(labels).filter(k => labels[k] === 'relevant'));
      const judged = Object.keys(labels).filter(k => labels[k] !== 'unsure');
      if (!judged.length) continue;
      const chosen = useStored
        ? (x.candidates || []).filter(c => c.selected).map(c => c.key)
        : selectEvidence((x.candidates || []).filter(c => c.eligible).map(c => ({
          ...c, token: c.key, _anchorText: c.snippet, _score: c.vectorScore, _judgeScore: c.judgeScore, _judgeRank: c.evidenceRank,
        })), opts).selected.map(c => c.key);
      const selected = new Set(chosen.filter(k => labels[k] && labels[k] !== 'unsure'));
      for (const k of selected) { if (gold.has(k)) tp++; else fp++; }
      for (const k of gold) if (!selected.has(k)) fn++;
      selectedCount += selected.size; caseCount++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    return { precision, recall, f1, avgEvidence: caseCount ? selectedCount / caseCount : 0, cases: caseCount };
  }
  const current = scoreConfig(null, true);
  let best = null;
  for (const min of [1, 2]) for (const max of [3, 4, 5, 6]) for (const scoreGap of [.08, .12, .15, .2, .25]) {
    if (min > max) continue;
    const metric = scoreConfig({ min, max, scoreGap }, false);
    // 同等质量时偏向更短上下文；这里仅产出建议，不自动改线上参数。
    const utility = metric.f1 - metric.avgEvidence * .002;
    if (!best || utility > best.utility) best = { min, max, scoreGap, ...metric, utility };
  }
  const ready = labeled.length >= 30 && labeledCandidates >= 100;
  return {
    labeledCases: labeled.length, labeledCandidates, ready,
    gate: { minCases: 30, minCandidates: 100 },
    answerAccuracy: answerCount ? answerCorrect / answerCount : null,
    current,
    recommendation: ready ? best : null,
  };
}

module.exports = { recordQualityCase, listQualityCases, updateQualityCase, attachQualityFeedback, getQualityMetrics };
