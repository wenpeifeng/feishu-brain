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

// custom 用用户填的
const c = resolveProvider({ providerId: 'custom', custom: { apiKey: 'sk-x', baseUrl: 'http://x/v1', model: 'm' } });
assert.equal(c.apiKey, 'sk-x');
assert.equal(c.baseUrl, 'http://x/v1');

// publicProviders 不含明文 key
assert.ok(publicProviders().every(p => !('apiKey' in p)), 'no apiKey leaked');
assert.ok(publicProviders().find(p => p.id === 'qwen').name === '通义千问(百炼)');

console.log('providers ok');
