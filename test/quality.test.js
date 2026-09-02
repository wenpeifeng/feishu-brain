'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-quality-'));
process.env.QUALITY_CASES_FILE = path.join(dir, 'cases.json');
const quality = require('../server/quality');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('自动采集保留候选轨迹但不保存密钥', () => {
  quality.recordQualityCase({
    qid: 'q1', openId: 'u1', question: '澳储还有需求吗？', answer: '有',
    provider: { id: 'qwen', model: 'qwen-plus', apiKey: 'must-not-save' },
    references: [{ token: 'm1', title: '聊天', source: 'message', snippet: '第二期已启动' }],
    debug: { recalled: 7, read: 6, eligible: 2, selected: 1, candidates: [{ token: 'm1', title: '聊天', source: 'message', kept: true, selected: true, passage: '第二期已启动', vscore: .75, jscore: 3 }] },
  });
  const got = quality.listQualityCases({ status: 'pending' });
  assert.equal(got.cases[0].question, '澳储还有需求吗？');
  assert.equal(got.cases[0].candidates[0].selected, true);
  assert.equal(JSON.stringify(got).includes('must-not-save'), false);
});

test('人工标注后案例进入金标集，点踩会提至高优先级', () => {
  assert.equal(quality.attachQualityFeedback('q1', 'down', '越权', 'u2'), false);
  quality.attachQualityFeedback('q1', 'down', '答案在后两条聊天', 'u1');
  assert.equal(quality.updateQualityCase('q1', { status: 'ignored' }, 'u2'), null);
  const item = quality.updateQualityCase('q1', { status: 'labeled', label: { answer: 'partial', note: '需向后取消息', evidence: { m1: 'relevant' } } }, 'u1');
  assert.equal(item.status, 'labeled');
  assert.equal(item.priority, 'high');
  assert.equal(item.label.evidence.m1, 'relevant');
  assert.equal(quality.listQualityCases({ status: 'labeled' }).summary.labeled, 1);
  assert.equal(quality.listQualityCases({ status: 'labeled', openId: 'u2' }).summary.labeled, 0);
  const metrics = quality.getQualityMetrics();
  assert.equal(metrics.ready, false, '小样本不能给出参数推荐');
  assert.equal(metrics.recommendation, null);
});
