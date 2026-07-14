async function askLLM(question, context, history = [], config = null) {
  const cfg = config || {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  };

  if (!cfg.openaiApiKey) {
    return mockAnswer(question, context);
  }

  const prompt = buildPrompt(question, context);

  const messages = [
    { role: 'system', content: 'You are a helpful assistant that answers questions based on provided Feishu knowledge base documents. Always cite the document titles in your answer. Answer in Chinese.' },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompt },
  ];

  const response = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function buildPrompt(question, context) {
  const docs = context.map((doc, i) => {
    const snippet = doc.content.slice(0, 8000);
    return `文档 ${i + 1}：《${doc.title}》\n${snippet}\n`;
  }).join('\n---\n');

  return `请根据以下飞书文档内容回答用户问题。请尽量引用文档标题，并给出准确、简洁的回答。\n\n${docs}\n\n用户问题：${question}\n\n请用中文回答。`;
}

function mockAnswer(question, context) {
  if (!context || context.length === 0) {
    return '未找到相关文档内容。';
  }

  const refs = context.map((doc, i) => `${i + 1}. 《${doc.title}》`).join('\n');
  const snippets = context.map((doc, i) => `--- 文档 ${i + 1}：《${doc.title}》 ---\n${doc.content.slice(0, 1200)}...`).join('\n\n');

  return `【当前未配置 LLM API，以下为基于文档内容的关键信息摘录】\n\n` +
    `您的问题是：${question}\n\n` +
    `相关文档：\n${refs}\n\n` +
    `内容摘要：\n${snippets}\n\n` +
    `提示：在配置中心填写 LLM API Key 后，将启用模型总结。`;
}

module.exports = { askLLM };
