// 内置 LLM 厂商目录：只有 id/名称/模型/baseUrl/速度标注，**不含任何密钥**。
// apiKey 由每个用户在设置里自己填写，存进其登录会话（session）；这里只作 baseUrl/model 参考。
const PROVIDERS = [
  { id: 'glm',   name: '智谱GLM-4-Air',   model: 'glm-4-air',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '响应快 · 推荐' },
  { id: 'glm5',  name: '智谱GLM-5.2',     model: 'glm-5.2',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '深度思考 · 较慢' },
  { id: 'kimi',  name: 'Kimi(Moonshot)',  model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',       hint: '深度思考 · 慢' },
  { id: 'agnes', name: 'Agnes',           model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',       hint: '备选' },
];

/**
 * 解析出可直接调用的 provider。apiKey **只**用用户自己在会话里填的，
 * 不再有任何内置/env 兜底——没填 key 就用不了，正是"每登录填一次、缓存"的语义。
 * @param {{ providerId, apiKey, baseUrl?, model? }} config
 */
function resolveProvider(config = {}) {
  const id = config.providerId || 'glm';
  if (id === 'custom') {
    return { id: 'custom', name: '自定义', model: config.model || '', baseUrl: config.baseUrl || '', apiKey: config.apiKey || '' };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p, apiKey: config.apiKey || '' };
}

// 给前端的安全目录：含速度标注 hint，绝不含 key。
function publicProviders() {
  return PROVIDERS.map(({ id, name, model, baseUrl, hint }) => ({ id, name, model, baseUrl, hint }));
}

module.exports = { PROVIDERS, resolveProvider, publicProviders };
