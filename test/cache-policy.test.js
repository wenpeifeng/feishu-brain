'use strict';

const assert = require('assert/strict');
const cache = require('../server/embedcache');

const key = cache.keyOf('cache-policy-test', 'wrong-decision-' + Date.now());
cache.putRawTimed(key, { score: 1 }, 1000);
assert.deepEqual(cache.getRawFresh(key, 1000, 1999), { score: 1 }, 'TTL 内可复用模型决策');
assert.equal(cache.getRawFresh(key, 1000, 2001), null, '过期模型决策必须重算');

const legacy = cache.keyOf('cache-policy-test', 'legacy-' + Date.now());
cache.putRaw(legacy, { score: 1 });
assert.equal(cache.getRawFresh(legacy, 1000, 1100), null, '旧版无时间戳决策不得永久沿用');

const question = '需要纠正的错误回答-' + Date.now();
const before = cache.getDecisionEpoch(question);
assert.equal(cache.bumpDecisionEpoch(question), before + 1, '点踩后应切换该问题的决策缓存代次');
assert.equal(cache.getDecisionEpoch(question), before + 1);

console.log('✓ 缓存分级：模型决策有TTL，旧错误缓存自动失效');
