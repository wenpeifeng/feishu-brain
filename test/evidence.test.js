'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectEvidence } = require('../server/evidence');

function d(token, judge, vector, text) {
  return { token, _judgeScore: judge, _score: vector, _anchorText: text };
}

test('同一法官档且分数接近时不被固定三条截断', () => {
  const docs = [
    d('a', 3, .81, '澳储需求已经启动'), d('b', 3, .76, '项目第二期需求说明'),
    d('c', 3, .72, '权限认证需求'), d('d', 3, .69, '节点现货价差需求'),
  ];
  const out = selectEvidence(docs, { min: 2, max: 5, scoreGap: .15 });
  assert.deepEqual(out.selected.map(x => x.token), ['a', 'b', 'c', 'd']);
});

test('明显分数断层进入更多相关结果', () => {
  const out = selectEvidence([d('a', 3, .8, '答案甲'), d('b', 3, .74, '答案乙'), d('c', 3, .51, '远端证据')], { min: 1, max: 5, scoreGap: .15 });
  assert.deepEqual(out.selected.map(x => x.token), ['a', 'b']);
  assert.equal(out.related[0]._evidenceReason, 'score_gap');
});

test('近重复内容不会重复占用最终证据位', () => {
  const same = '澳储第二期需求已经启动，需要先借调资源确认权限认证方案';
  const out = selectEvidence([d('a', 3, .8, same), d('b', 3, .79, same + '。'), d('c', 3, .75, '节点现货价差需要接入')], { min: 1, max: 5, scoreGap: .15 });
  assert.deepEqual(out.selected.map(x => x.token), ['a', 'c']);
  assert.equal(out.related[0]._evidenceReason, 'duplicate');
});

test('同一法官档优先使用证据质量分，不被字面向量分倒置', () => {
  const vague = { ...d('vague', 2, .75, '昨天的需求说明不涉及澳储'), _judgeRank: 42 };
  const direct = { ...d('direct', 2, .62, '澳储第二期需求已经启动'), _judgeRank: 91 };
  const out = selectEvidence([vague, direct], { min: 2, max: 5, scoreGap: .15 });
  assert.deepEqual(out.selected.map(x => x.token), ['direct', 'vague']);
});

test('法官分只做门槛，过闸后不让3分旧线索压住2分直接回答', () => {
  const stale = { ...d('stale', 3, .74, '旧周报提到澳储功能'), _judgeRank: 62 };
  const direct = { ...d('direct', 2, .61, '澳储第二期需求已经启动'), _judgeRank: 92 };
  const out = selectEvidence([stale, direct], { min: 1, max: 5, scoreGap: .35 });
  assert.deepEqual(out.selected.map(x => x.token), ['direct', 'stale']);
});
