'use strict';

/**
 * LLM integration module.
 *
 * Exports:
 *   askLLMStream(question, docs, history, provider) → async generator yielding string deltas
 *   askLLMGeneral(question, history, provider, webSearch) → async generator yielding string deltas
 *   askLLM(question, context, history, config) → string (legacy non-streaming, kept for compat)
 *
 * All providers are OpenAI-compatible (POST ${baseUrl}/chat/completions).
 * Reasoning models (kimi, agnes) emit reasoning_content in delta — we ignore it, only yield content.
 * max_tokens=4096 ensures reasoning budget doesn't starve the actual answer.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a user prompt that embeds the retrieved docs.
 */
function buildPrompt(question, docs) {
  if (!docs || docs.length === 0) {
    return `用户问题：${question}\n\n请用中文回答。`;
  }
  const docText = docs.map((doc, i) => {
    const snippet = doc.content.slice(0, 8000);
    return `文档 ${i + 1}：《${doc.title}》\n${snippet}\n`;
  }).join('\n---\n');

  return `以下是可参考的资料，请据此回答用户的问题。\n\n${docText}\n\n用户问题：${question}`;
}

const SYSTEM_KB = [
  '你是一个智能问答助手。用户会给你一些参考资料，请基于这些资料，直接、自然地回答用户的问题，就像正常对话一样。',
  '要求：',
  '1. 直接回答问题本身，不要复述问题，不要说"根据文档""参考资料显示"这类开场白。',
  '2. 绝对不要在回答里写出文档名/标题（如《xxx》），也不要标注引用来源——来源已单独展示在下方，正文里出现文档名是多余的。',
  '3. 回答准确、简洁、有条理，中文。信息不足时如实说明，不要编造。',
].join('\n');
const SYSTEM_GENERAL = '你是一个智能助手，直接、自然地用中文回答用户问题，不要复述问题、不要多余的客套。';

/**
 * Read SSE lines from a ReadableStream body and yield parsed delta objects.
 * Handles chunks that split across line boundaries.
 *
 * @param {ReadableStream} body - fetch response body
 * @yields {string} - content delta strings (non-empty)
 */
async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process all complete lines in the buffer
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // Malformed line, skip
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta;
        if (!delta) continue;

        // 推理模型：先出 reasoning_content（思考），再出 content（正文）。
        // 两者都流式 yield，前端把思考显示在"深度思考"框里。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'reasoning', text: delta.reasoning_content };
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'answer', text: delta.content };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Core streaming fetch helper.
 * Calls provider's chat/completions endpoint and returns an async generator of string deltas.
 *
 * @param {object} provider - resolved provider {model, baseUrl, apiKey}
 * @param {Array}  messages - OpenAI message array
 * @param {object} extraBody - extra fields merged into request body
 */
async function* streamChat(provider, messages, extraBody = {}) {
  const url = `${provider.baseUrl}/chat/completions`;
  const body = {
    model: provider.model,
    messages,
    // 不发送 temperature：部分模型（如 kimi-for-coding）只允许 temperature=1，
    // 发 0.3 会 400。省略后各厂商用各自默认值，兼容所有内置模型。
    // 推理模型思考会占大量 token，放宽到 8192 避免正文被截断。
    max_tokens: 8192,
    stream: true,
    ...extraBody,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status}`);
  }

  yield* parseSseStream(response.body);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Streaming RAG answer: question + retrieved docs + history.
 *
 * @param {string}   question  - user's question
 * @param {Array}    docs      - retrieved docs [{title, content}]
 * @param {Array}    history   - conversation history [{role, content}]
 * @param {object}   provider  - resolved provider object from providers.js
 * @yields {string} content delta
 */
async function* askLLMStream(question, docs, history, provider) {
  if (!provider.apiKey) {
    throw new Error('未配置 LLM API Key');
  }

  const messages = [
    { role: 'system', content: SYSTEM_KB },
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: buildPrompt(question, docs) },
  ];

  yield* streamChat(provider, messages);
}

/**
 * Streaming general-purpose answer (no docs).
 * When webSearch=true, adds Moonshot web_search tool; degrades gracefully if unsupported.
 *
 * @param {string}  question   - user's question
 * @param {Array}   history    - conversation history [{role, content}]
 * @param {object}  provider   - resolved provider object
 * @param {boolean} webSearch  - whether to request web search
 * @yields {string} content delta
 */
async function* askLLMGeneral(question, history, provider, webSearch = false) {
  if (!provider.apiKey) {
    throw new Error('未配置 LLM API Key');
  }

  const messages = [
    { role: 'system', content: SYSTEM_GENERAL },
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  if (webSearch) {
    try {
      yield* streamChat(provider, messages, { tools: [{ type: 'web_search' }] });
      return;
    } catch (err) {
      // Tools not supported by this provider — degrade to plain chat
    }
  }

  yield* streamChat(provider, messages);
}

// ---------------------------------------------------------------------------
// Legacy non-streaming (kept for backwards compatibility with rag.js / tests)
// ---------------------------------------------------------------------------

function mockAnswer(question, context) {
  if (!context || context.length === 0) {
    return '未找到相关文档内容。';
  }
  const refs = context.map((doc, i) => `${i + 1}. 《${doc.title}》`).join('\n');
  const snippets = context.map((doc, i) =>
    `--- 文档 ${i + 1}：《${doc.title}》 ---\n${doc.content.slice(0, 1200)}...`
  ).join('\n\n');

  return `【当前未配置 LLM API，以下为基于文档内容的关键信息摘录】\n\n` +
    `您的问题是：${question}\n\n` +
    `相关文档：\n${refs}\n\n` +
    `内容摘要：\n${snippets}\n\n` +
    `提示：在配置中心填写 LLM API Key 后，将启用模型总结。`;
}

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
    { role: 'system', content: SYSTEM_KB },
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
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
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------------------------------------------------------------------------
// 关键词提取：飞书搜索是关键词匹配，整句问题会 0 结果。用 LLM 把问题提炼成
// 空格分隔的核心关键词（"南京分公司的地址在哪里？" → "南京分公司 地址"）。
// 非流式、低成本；失败则回退原问题。
// ---------------------------------------------------------------------------
async function extractKeywords(question, provider) {
  if (!provider || !provider.apiKey) return question;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 512,
        messages: [
          { role: 'system', content: '你是搜索关键词提取器。从用户问题里提炼出最核心的 1-2 个专有名词/实体作为检索关键词，用单个空格分隔。要具体、能唯一定位主题；忽略"事项、情况、问题、有哪些、是什么"这类通用词。只输出关键词本身，不要解释、不要标点、不要引号。例：\n"澳洲迁移事项有哪些" → "澳洲 迁移"\n"清分单是什么" → "清分单"\n"南京分公司的地址在哪里" → "南京分公司"' },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) return question;
    const j = await res.json();
    let kw = (j.choices?.[0]?.message?.content || '').trim();
    kw = kw.replace(/[，。？！、"'`]/g, ' ').replace(/\s+/g, ' ').trim();
    return kw || question;
  } catch (_e) {
    return question;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  askLLM,          // legacy, kept for rag.js compatibility
  askLLMStream,    // Task 5: streaming RAG
  askLLMGeneral,   // Task 5: streaming general / web search
  extractKeywords, // 关键词提取（改善搜索命中）
  buildPrompt,     // exposed for testing / Task 6 RAG
};
