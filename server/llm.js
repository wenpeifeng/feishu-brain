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

  return `请根据以下飞书文档内容回答用户问题。请尽量引用文档标题，并给出准确、简洁的回答。\n\n${docText}\n\n用户问题：${question}\n\n请用中文回答。`;
}

const SYSTEM_KB = '你是一个基于飞书知识库文档的智能问答助手，请用中文回答，并尽量引用相关文档标题。';
const SYSTEM_GENERAL = '你是一个智能助手，请用中文回答问题。';

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

        // Only yield content; ignore reasoning_content
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield delta.content;
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
    temperature: 0.3,
    max_tokens: 4096,
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  askLLM,          // legacy, kept for rag.js compatibility
  askLLMStream,    // Task 5: streaming RAG
  askLLMGeneral,   // Task 5: streaming general / web search
  buildPrompt,     // exposed for testing / Task 6 RAG
};
