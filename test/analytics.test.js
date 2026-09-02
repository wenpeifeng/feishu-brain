require('../server/env');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, '..', 'data', 'analytics.json');
fs.rmSync(F, { force: true });
delete require.cache[require.resolve('../server/analytics')];
const a = require('../server/analytics');

const q1 = a.logQuestion('u1', '电价是什么', 3);
a.logQuestion('u1', '电价是什么', 3);      // 重复 → FAQ 候选
a.logQuestion('u1', '火星房价多少', 0);    // 命中 0 → 盲区
a.logQuestion('u2', '别人的问题', 2);      // 他人 → 隔离
assert.ok(a.logFeedback('u1', q1, 'up'), '反馈成功');

const s = a.getSummary('u1');
assert.equal(s.total, 3, '按 openId 隔离（不含 u2）');
assert.ok(s.topQuestions.some(x => x.q === '电价是什么' && x.count === 2), '高频问题计数');
assert.ok(s.gaps.includes('火星房价多少'), '知识盲区（命中0）');
assert.equal(s.feedback.up, 1, '满意度统计');
assert.equal(a.logFeedback('u2', q1, 'down'), false, '越权反馈被拒（u2 不能评 u1 的提问）');
assert.equal(a.logFeedback('u1', q1, 'invalid'), false, '非法 vote 被拒');

fs.rmSync(F, { force: true });
console.log('✅ analytics.test.js 通过');
