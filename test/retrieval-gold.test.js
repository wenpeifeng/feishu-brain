'use strict';

const assert = require('assert/strict');
const { _internals } = require('../server/rag');
const { selectEvidence } = require('../server/evidence');

function protect(text, score = 1, rank = 30) {
  return _internals.protectDirectStateEvidence('澳储还有需求吗？', { _anchorText: text }, score, rank);
}

// 真实 case 金标：明确状态必须保留；局部未涉及、跨项目纠正不得误保护。
assert.deepEqual(protect('澳储第二期部分需求已经启动，正在安排开发。'), { score: 2, rank: 80, reason: '原文含明确项目状态' });
assert.equal(protect('澳储移动版 PRD 预计下周一评审。').score, 2);
assert.equal(protect('澳储需求已经取消，项目暂停。').score, 2, '否定状态也是回答，不能被当无关');
assert.equal(protect('昨天这份需求说明未涉及澳储。').score, 1, '局部材料没提到不等于项目状态');
assert.equal(protect('下周排了奥储需求，不过是发售电的。').score, 1, '后文纠正为另一项目时不得保护');
assert.equal(protect('澳洲光储项目 AWS 资源盘点。').score, 1, '同项目但没有需求状态不得保护');
assert.equal(protect('澳储第二期需求已经启动。', 0).score, 0, '法官判0不做规则抬升');

assert.equal(_internals.shouldClarifyQuestion('进度呢？'), true);
assert.equal(_internals.shouldClarifyQuestion('奥储还有需求吗？'), false);
assert.equal(_internals.shouldClarifyQuestion('云效账号怎么申请？'), false);
// 新鲜度档位相对「今天」计算（≤14 天 92 分、≤30 天 86 分、更旧维持 80）。
// 测试日期必须相对当前时间生成：写死绝对日期会随时间双双跌出窗口，断言变成时间炸弹。
function dateAgo(days) {
  const t = new Date(Date.now() - days * 86400000);
  return `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}`;
}
const latestRank = _internals.calibrateEvidenceRank('澳储还有需求吗', { title: `平台各项目组周报_${dateAgo(5)}`, _anchorText: '统一认证模块已完成验收' }, 80);
const olderRank = _internals.calibrateEvidenceRank('澳储还有需求吗', { title: `澳洲光储组周报_${dateAgo(60)}`, _anchorText: '下周计划推进需求' }, 80);
assert.ok(latestRank.value > olderRank.value, '状态题同档证据应优先采用更新资料');

const remotePool = Array.from({ length: 15 }, (_, i) => ({
  token: `old-${i}`, title: `普通资料_${2025 + Math.floor(i / 12)}/01/${String((i % 12) + 1).padStart(2, '0')}`,
}));
remotePool[14] = { token: 'latest-weekly', title: '澳洲光储组周报_2026/07/15' };
const readSet = _internals.selectRemoteReadables(remotePool, 8);
assert.equal(readSet.length, 8);
assert.ok(readSet.some(x => x.token === 'latest-weekly'), '远程读取池必须给最新状态资料保留席位');

const candidates = [
  { token: 'latest', _judgeScore: 3, _judgeRank: 95, _score: .49, _anchorText: '7月15日：移动版PRD下周评审' },
  { token: 'launched', _judgeScore: 2, _judgeRank: 80, _score: .71, _anchorText: '澳储第二期需求已经启动' },
  { token: 'schedule', _judgeScore: 2, _judgeRank: 80, _score: .58, _anchorText: '需求宣讲后给出人员排期' },
  { token: 'weak', _judgeScore: 2, _judgeRank: 45, _score: .73, _anchorText: '下周排了需求，不过是另一个项目' },
];
const picked = selectEvidence(candidates, { min: 2, max: 3, scoreGap: .15 });
assert.deepEqual(picked.selected.map(x => x.token), ['latest', 'launched', 'schedule']);
assert.deepEqual(picked.related.map(x => x.token), ['weak']);
assert.equal(new Set([...picked.selected, ...picked.related].map(x => x.token)).size, candidates.length, '所有过闸证据必须出现在主引用或更多结果中');

const active = _internals.protectDirectStateEvidence(
  '澳储最新需求在做的有吗',
  {
    _anchorText: '[后续回复1] 第二期部分需求已经启动',
    content: '[命中消息] 澳储还有需求吗\n[后续回复1] 第二期部分需求已经启动',
  },
  1,
  30
);
assert.equal(active.score, 2, '“最新/在做”状态问法也应保护同一聊天窗口内的直接事实');

assert.equal(
  _internals.sanitizeAnswerCitations('移动版正在开发 [1]。另有报表需求 [2]。', 1),
  '移动版正在开发 [1]。',
  '只有越界角标支撑的句子必须删除'
);
assert.equal(
  _internals.sanitizeAnswerCitations('需求已启动 [1][2]。', 1),
  '需求已启动 [1]。',
  '同句存在有效引用时只删除越界角标'
);

console.log('✓ 真实澳储金标：状态保护、冲突抑制、分区完整性');
