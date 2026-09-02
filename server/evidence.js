'use strict';

// 把“法官通过”与“最终喂给生成模型”拆成两层：通过项保留为相关结果，
// 最终证据集按分数断层、去重和上限自适应选取，避免固定 Top K 截断同档证据。

function textTokens(doc) {
  const text = String(doc._anchorText || doc.matchText || doc.content || doc.title || '')
    .toLowerCase().replace(/\s+/g, ' ').slice(0, 1200);
  const out = new Set();
  const cjk = text.replace(/[^\u3400-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  (text.match(/[a-z0-9_]{2,}/g) || []).forEach(x => out.add(x));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / (a.size + b.size - common);
}

function selectEvidence(candidates, options = {}) {
  const min = Math.max(1, Number(options.min) || 1);
  const max = Math.max(min, Number(options.max) || 5);
  const scoreGap = options.scoreGap != null ? Number(options.scoreGap) : 0.15;
  const duplicateAt = options.duplicateAt != null ? Number(options.duplicateAt) : 0.78;
  const quality = d => d._judgeRank != null ? Number(d._judgeRank) / 100 : (Number(d._score) || 0);
  // 进入这里的候选都已通过相关性门槛。法官 2/3 分在不同批次容易抖动，只用于“过/不过”，
  // 不再作为主引用排序的最高优先级；否则会把明确的直接回答压到旧周报后面。
  const ordered = (candidates || []).slice().sort((a, b) =>
    quality(b) - quality(a) || (Number(b._score) || 0) - (Number(a._score) || 0));
  if (!ordered.length) return { selected: [], related: [], cutoff: null };

  const bestJudge = Math.max(0, ...ordered.map(x => Number(x._judgeScore) || 0));
  const bestQuality = quality(ordered[0]);
  const selected = [];
  const related = [];
  const selectedTokens = [];

  for (const doc of ordered) {
    const tokens = textTokens(doc);
    const duplicate = selectedTokens.some(old => jaccard(old, tokens) >= duplicateAt);
    const withinGap = bestQuality <= 0 || quality(doc) >= bestQuality - scoreGap;
    const requiredForMinimum = selected.length < min;
    if (selected.length < max && !duplicate && (requiredForMinimum || withinGap)) {
      selected.push(doc);
      selectedTokens.push(tokens);
    } else {
      related.push({ ...doc, _evidenceReason: duplicate ? 'duplicate' : selected.length >= max ? 'limit' : 'score_gap' });
    }
  }
  return {
    selected,
    related,
    cutoff: { bestJudge, bestQuality, scoreGap, min, max },
  };
}

module.exports = { selectEvidence, jaccard };
