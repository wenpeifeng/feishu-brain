require('../server/env');
const assert = require('assert');
const { PROVIDERS, resolveProvider, publicProviders } = require('../server/providers');

// 内置至少 qwen/kimi/agnes
assert.ok(PROVIDERS.find(p => p.id === 'qwen'), 'has qwen');
assert.ok(PROVIDERS.find(p => p.id === 'kimi'), 'has kimi');
assert.ok(PROVIDERS.find(p => p.id === 'agnes'), 'has agnes');

// resolveProvider 带出 key（从 env）
const r = resolveProvider({ providerId: 'qwen' });
assert.equal(r.model, 'qwen-plus');
assert.ok(r.apiKey && r.apiKey.startsWith('sk-'), 'qwen apiKey from env');

// 默认回退到第一个
assert.equal(resolveProvider({}).id, 'qwen');

// custom 用用户填的（扁平字段：apiKey/baseUrl/model 直接在 config 上）
const c = resolveProvider({ providerId: 'custom', apiKey: 'sk-x', baseUrl: 'http://x/v1', model: 'm' });
assert.equal(c.apiKey, 'sk-x');
assert.equal(c.baseUrl, 'http://x/v1');

// 用户会话里的 apiKey 优先于 env
const u = resolveProvider({ providerId: 'qwen', apiKey: 'sk-user-own' });
assert.equal(u.apiKey, 'sk-user-own', 'session apiKey 应优先');

// publicProviders 不含明文 key，但含速度标注 hint
assert.ok(publicProviders().every(p => !('apiKey' in p)), 'no apiKey leaked');
assert.ok(publicProviders().find(p => p.id === 'qwen').hint, 'provider 应有 hint 速度标注');
assert.ok(publicProviders().find(p => p.id === 'qwen').name === '通义千问(百炼)');

console.log('providers ok');
