// 内置 LLM 厂商目录：只有 id/名称/模型/baseUrl/速度标注，**不含任何密钥**。
// apiKey 由每个用户在设置里自己填写，存进其登录会话（session）；这里只作 baseUrl/model 参考。
const PROVIDERS = [
  { id: 'glm',   name: '智谱GLM-4-Air',   model: 'glm-4-air',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '响应快 · 推荐' },
  { id: 'glm5',  name: '智谱GLM-5.2',     model: 'glm-5.2',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '深度思考 · 较慢' },
  { id: 'kimi',  name: 'Kimi(Moonshot)',  model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',       hint: '深度思考 · 慢' },
  { id: 'bailian', name: '通义千问(阿里云百炼)', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '公司百炼 · 需标准API-Key(非cc-switch令牌)' },
  { id: 'agnes', name: 'Agnes',           model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',       hint: '备选' },
];

/**
 * 解析出可直接调用的 provider。apiKey **只**用用户自己在会话里填的，
 * 不再有任何内置/env 兜底——没填 key 就用不了，正是"每登录填一次、缓存"的语义。
 * @param {{ providerId, apiKey, baseUrl?, model? }} config
 */
// 测试便利：允许用 env 配一个默认 key（DEFAULT_LLM_PROVIDER + DEFAULT_LLM_KEY），
// 仅当用户没自己填 key、且当前 provider == 默认 provider 时兜底（避免把某厂商的 key 用到另一厂商）。
// 生产环境不设这两个 env → 恢复"每人必须自填、无隐藏兜底"。
function defaultKeyFor(id) {
  const defProvider = process.env.DEFAULT_LLM_PROVIDER || 'glm';
  const defKey = process.env.DEFAULT_LLM_KEY || '';
  return (defKey && id === defProvider) ? defKey : '';
}

function resolveProvider(config = {}) {
  const id = config.providerId || process.env.DEFAULT_LLM_PROVIDER || 'glm';
  if (id === 'custom') {
    return { id: 'custom', name: '自定义', model: config.model || '', baseUrl: config.baseUrl || '', apiKey: config.apiKey || defaultKeyFor('custom') };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p, apiKey: config.apiKey || defaultKeyFor(p.id) };
}

// 给前端的安全目录：含速度标注 hint，绝不含 key。
function publicProviders() {
  return PROVIDERS.map(({ id, name, model, baseUrl, hint }) => ({ id, name, model, baseUrl, hint }));
}

// Embedding（向量重排用）：只有智谱 GLM 系（bigmodel.cn）提供 embedding-3。
// 用**用户自己**的 key（同一个 GLM key 即可调 embedding），无隐藏兜底。
// 用户选了不支持向量的厂商（kimi/agnes/custom）→ 返回 null → 检索自动降级词法重排。
const EMBED_ENDPOINTS = {
  glm:  { url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', model: 'embedding-3' },
  glm5: { url: 'https://open.bigmodel.cn/api/paas/v4/embeddings', model: 'embedding-3' },
  bailian: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', model: 'text-embedding-v3' },
};
// 向量嵌入与"对话用的 LLM"解耦：只要有可用的 GLM key（用户自己的，或默认兜底 key），
// 向量层就用 GLM embedding-3——不因用户对话选了不支持向量的厂商（qwen/kimi/custom）就整片降级词法。
// 优先级：①用户自己填了支持向量厂商的 key → 用它；②否则用"默认厂商"的向量 key（通常 GLM，兜底）。
// 生产不设 DEFAULT_LLM_KEY 时，非向量厂商用户仍会 null → 词法（行为不变）。
function resolveEmbed(config = {}) {
  if (config.apiKey && EMBED_ENDPOINTS[config.providerId]) {
    const e = EMBED_ENDPOINTS[config.providerId];
    return { url: e.url, model: e.model, apiKey: config.apiKey };
  }
  const defId = process.env.DEFAULT_LLM_PROVIDER || 'glm';
  const e = EMBED_ENDPOINTS[defId];
  const apiKey = defaultKeyFor(defId);
  if (!e || !apiKey) return null;
  return { url: e.url, model: e.model, apiKey };
}

module.exports = { PROVIDERS, resolveProvider, publicProviders, resolveEmbed };
