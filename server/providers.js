const PROVIDERS = [
  { id: 'qwen',  name: '通义千问(百炼)', model: 'qwen-plus',        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.QWEN_API_KEY || '' },
  { id: 'kimi',  name: 'Kimi(Moonshot)', model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',                    apiKey: process.env.KIMI_API_KEY || '' },
  { id: 'agnes', name: 'Agnes',          model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',                   apiKey: process.env.AGNES_API_KEY || '' },
];

function resolveProvider(config = {}) {
  const id = config.providerId || process.env.LLM_PROVIDER_ID || 'qwen';
  if (id === 'custom') {
    const c = config.custom || {};
    return { id: 'custom', name: '自定义', model: c.model || '', baseUrl: c.baseUrl || '', apiKey: c.apiKey || '' };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p };
}

function publicProviders() { return PROVIDERS.map(({ apiKey, ...rest }) => rest); }

module.exports = { PROVIDERS, resolveProvider, publicProviders };
