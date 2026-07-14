// Built-in LLM provider catalog. PROVIDERS holds NO secrets — API keys are
// attached only inside resolveProvider(), read from env at call time. This
// keeps the exported catalog safe to serialize toward the frontend.
const PROVIDERS = [
  { id: 'qwen',  name: '通义千问(百炼)', model: 'qwen-plus',        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'kimi',  name: 'Kimi(Moonshot)', model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1' },
  { id: 'agnes', name: 'Agnes',          model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1' },
  { id: 'glm',   name: '智谱GLM (快·推荐)', model: 'glm-4-air',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'glm5',  name: '智谱GLM-5.2 (深度思考·慢)', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
];

// provider id -> env var holding its API key. Never inline the key itself.
const KEY_ENV = { qwen: 'QWEN_API_KEY', kimi: 'KIMI_API_KEY', agnes: 'AGNES_API_KEY', glm: 'GLM_API_KEY', glm5: 'GLM_API_KEY' };

function resolveProvider(config = {}) {
  const id = config.providerId || process.env.LLM_PROVIDER_ID || 'qwen';
  if (id === 'custom') {
    const c = config.custom || {};
    return { id: 'custom', name: '自定义', model: c.model || '', baseUrl: c.baseUrl || '', apiKey: c.apiKey || '' };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p, apiKey: process.env[KEY_ENV[p.id]] || '' };
}

// Safe list for the frontend: id/name/model/baseUrl only, never a key.
function publicProviders() { return PROVIDERS.map(({ id, name, model, baseUrl }) => ({ id, name, model, baseUrl })); }

// 内部快速任务（关键词提取等）用的快模型：优先 qwen（非推理、~0.5s），
// 避免用慢的推理模型（GLM-5.2/kimi）拖慢首屏。无 qwen key 时返回 null。
function resolveFastProvider() {
  const qwen = PROVIDERS.find(p => p.id === 'qwen');
  const key = process.env[KEY_ENV.qwen] || '';
  return (qwen && key) ? { ...qwen, apiKey: key } : null;
}

module.exports = { PROVIDERS, resolveProvider, publicProviders, resolveFastProvider };
