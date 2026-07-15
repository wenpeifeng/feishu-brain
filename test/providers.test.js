require('../server/env');
const assert = require('assert');
const { PROVIDERS, resolveProvider, publicProviders } = require('../server/providers');

// 内置 glm/kimi/agnes（qwen 已移除）
assert.ok(PROVIDERS.find(p => p.id === 'glm'), 'has glm');
assert.ok(PROVIDERS.find(p => p.id === 'kimi'), 'has kimi');
assert.ok(PROVIDERS.find(p => p.id === 'agnes'), 'has agnes');
assert.ok(!PROVIDERS.find(p => p.id === 'qwen'), 'qwen 已移除');

// resolveProvider 带出 model/baseUrl；apiKey 只来自 config（无 env 兜底）
const r = resolveProvider({ providerId: 'glm', apiKey: 'my-key' });
assert.equal(r.model, 'glm-4-air');
assert.equal(r.apiKey, 'my-key', 'apiKey 来自 config');
assert.equal(resolveProvider({ providerId: 'glm' }).apiKey, '', '未填 key 时为空(无隐藏兜底)');

// 默认回退到第一个
assert.equal(resolveProvider({}).id, 'glm');

// custom 用用户填的（扁平字段：apiKey/baseUrl/model 直接在 config 上）
const c = resolveProvider({ providerId: 'custom', apiKey: 'sk-x', baseUrl: 'http://x/v1', model: 'm' });
assert.equal(c.apiKey, 'sk-x');
assert.equal(c.baseUrl, 'http://x/v1');

// 用户会话里的 apiKey 优先于 env
const u = resolveProvider({ providerId: 'glm', apiKey: 'sk-user-own' });
assert.equal(u.apiKey, 'sk-user-own', 'session apiKey 应优先');

// publicProviders 不含明文 key，但含速度标注 hint
assert.ok(publicProviders().every(p => !('apiKey' in p)), 'no apiKey leaked');
assert.ok(publicProviders().find(p => p.id === 'glm').hint, 'provider 应有 hint 速度标注');
assert.ok(publicProviders().find(p => p.id === 'glm').name === '智谱GLM-4-Air');

console.log('providers ok');
