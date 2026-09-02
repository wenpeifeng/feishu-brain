'use strict';

const assert = require('assert/strict');
const { oneEditOrLess, titleEntityPrefix, titleSeriesStem, discoverCorpusQueries, applyCorpusCorrection, deriveStatusCoreQuery } = require('../server/query-planner');

assert.equal(oneEditOrLess('云校', '云效'), true);
assert.equal(oneEditOrLess('飞术', '飞书'), true);
assert.equal(oneEditOrLess('审批', '知识'), false);
assert.equal(titleEntityPrefix('云效流水线组周报_2026/07/15'), '云效流水线');
assert.equal(titleSeriesStem('云效流水线组周报_2026/07/15'), '云效流水线组周报');
assert.equal(titleSeriesStem('云效流水线项目资源盘点'), '云效流水线项目资源盘点');

const found = discoverCorpusQueries(
  { keywords: '云校 流水线', correctedQuestion: '', confidence: 0.4 },
  '云校流水线失败了吗',
  [
    { title: '云效流水线组周报_2026/07/15' },
    { title: '云效流水线项目排期' },
    { title: '云效账号申请' },
  ],
  4
);
assert.ok(found.includes('云效'), '应从真实标题发现一字之差的实体写法');
assert.ok(found.includes('云效流水线'), '应从周报标题发现正式实体前缀');
assert.ok(found.includes('云效流水线组周报'), '应从历史标题生成去日期的系列标题查询');
assert.ok(!found.includes('云效账号申请'), '无日期普通标题不得冒充系列查询');
assert.ok(applyCorpusCorrection('云校流水线失败了吗', { keywords: '云校 流水线' }, found).includes('云效'));
assert.equal(
  applyCorpusCorrection('奥储还有需求吗', { keywords: '奥储 需求' }, ['光储', '澳储', '澳洲光储']),
  '澳储还有需求吗',
  '多个一字差候选时，优先与语料正式全称首尾一致的规范简称'
);
assert.deepEqual(discoverCorpusQueries({ keywords: '云校', correctedQuestion: '云效', confidence: .95 }, '', [], 3), [], '模型高置信纠错时不增加二次检索');

assert.deepEqual(
  discoverCorpusQueries(
    { keywords: '澳储 最新需求', correctedQuestion: '', confidence: .5 },
    '澳储最新需求在做的有吗',
    [{ title: '澳储这边第二期部分需求已经启动' }, { title: '澳洲光储组周报_2026/07/22' }],
    3
  ),
  [],
  '语料已直接支持“澳储”时不能把正确简称纠成“澳洲”'
);
assert.equal(deriveStatusCoreQuery('澳储最新需求在做的有吗', '澳储 最新需求'), '澳储 需求');
assert.equal(deriveStatusCoreQuery('云效最近有什么进展', '云效 最近进展'), '', '只剩单个主题词时不做宽泛补搜');
assert.equal(deriveStatusCoreQuery('如何创建功能分支', '创建 功能分支'), '');

[
  ['云效流水线最近有发布计划吗', '云效流水线 最近发布计划', '云效流水线 发布计划'],
  ['RAM账号当前有申请需求吗', 'RAM账号 当前申请需求', 'RAM账号 申请需求'],
  ['节点边际成本最近有计算需求吗', '节点边际成本 最近计算需求', '节点边际成本 计算需求'],
].forEach(([question, keywords, expected]) => {
  assert.equal(deriveStatusCoreQuery(question, keywords), expected, `状态核心查询应与具体业务实体无关：${question}`);
});

console.log('✓ 语料驱动纠错：通用一字差发现与正式标题扩展');
