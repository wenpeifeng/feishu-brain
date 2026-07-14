// 内置 LLM 厂商目录：只有 id/名称/模型/baseUrl/速度标注，**不含任何密钥**。
// apiKey 由每个用户在设置里自己填写，存进其登录会话（session）；这里只作 baseUrl/model 参考。
// 环境变量里的 key 仅作为本机/owner 的可选兜底（部署给他人时不配 env，即强制每人自填）。
const PROVIDERS = [
  { id: 'qwen',  name: '通义千问(百炼)',   model: 'qwen-plus',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '响应快 · 推荐' },
  { id: 'glm',   name: '智谱GLM-4-Air',   model: 'glm-4-air',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4',            hint: '响应快' },
  { id: 'glm5',  name: '智谱GLM-5.2',     model: 'glm-5.2',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4',            hint: '深度思考 · 较慢' },
  { id: 'kimi',  name: 'Kimi(Moonshot)',  model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',                  hint: '深度思考 · 慢' },
  { id: 'agnes', name: 'Agnes',           model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',                  hint: '备选' },
];

// provider id -> env var（仅 owner 本机兜底；部署给他人时不设 env）
const KEY_ENV = { qwen: 'QWEN_API_KEY', kimi: 'KIMI_API_KEY', agnes: 'AGNES_API_KEY', glm: 'GLM_API_KEY', glm5: 'GLM_API_KEY' };

/**
 * 解析出可直接调用的 provider。
 * @param {{ providerId, apiKey, baseUrl?, model? }} config  用户会话里的 LLM 配置
 * apiKey 优先用用户自填的（config.apiKey），无则回退 env（owner 本机）。
 */
function resolveProvider(config = {}) {
  const id = config.providerId || 'qwen';
  if (id === 'custom') {
    return { id: 'custom', name: '自定义', model: config.model || '', baseUrl: config.baseUrl || '', apiKey: config.apiKey || '' };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p, apiKey: config.apiKey || process.env[KEY_ENV[p.id]] || '' };
}

// 给前端的安全目录：含速度标注 hint，绝不含 key。
function publicProviders() {
  return PROVIDERS.map(({ id, name, model, baseUrl, hint }) => ({ id, name, model, baseUrl, hint }));
}

// 内部快速任务（关键词提取）用的快模型：优先 owner 本机的 qwen（env），没有则返回 null，
// 此时调用方回退用用户自己的 provider。
function resolveFastProvider() {
  const qwen = PROVIDERS.find(p => p.id === 'qwen');
  const key = process.env[KEY_ENV.qwen] || '';
  return (qwen && key) ? { ...qwen, apiKey: key } : null;
}

module.exports = { PROVIDERS, resolveProvider, publicProviders, resolveFastProvider };
