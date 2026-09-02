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

const cache = require('./embedcache');   // 复用同一持久化 kv 存储缓存法官打分
const configuredDecisionTtl = Number(process.env.LLM_DECISION_CACHE_TTL_MS);
// 没有金标证明前默认关闭模型判断缓存。显式配置正数时至少 60 秒，避免误填极小值造成抖动。
const DECISION_CACHE_TTL_MS = Number.isFinite(configuredDecisionTtl) && configuredDecisionTtl > 0
  ? Math.max(60_000, configuredDecisionTtl)
  : 0;
const DECISION_CACHE_BYPASS = process.env.LLM_DECISION_CACHE_BYPASS === '1';
const JUDGE_BATCH_SIZE = Math.max(4, Math.min(20, Number(process.env.LLM_JUDGE_BATCH_SIZE) || 8));
const cacheModelId = provider => `${String((provider && provider.baseUrl) || '')}|${String((provider && provider.model) || '')}`;
const getDecisionCache = key => (DECISION_CACHE_BYPASS || !DECISION_CACHE_TTL_MS) ? null : cache.getRawFresh(key, DECISION_CACHE_TTL_MS);
const putDecisionCache = (key, value) => { if (!DECISION_CACHE_BYPASS && DECISION_CACHE_TTL_MS) cache.putRawTimed(key, value); };
const decisionInput = (tag, question, suffix = '') => `${tag}:E${cache.getDecisionEpoch(question)}:${question}${suffix}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a user prompt that embeds the retrieved docs.
 */
function parseSourceDate(value) {
  const m = String(value || '').match(/(20\d{2})[年/_-](\d{1,2})[月/_-](\d{1,2})日?/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateYmd(d) { return d.toISOString().slice(0, 10); }

// 把历史资料里的相对日期直接标成绝对日期。仅靠提示词时，模型仍可能把“下周”照抄成当前计划。
function annotateRelativeDates(text, sourceDate) {
  if (!sourceDate) return text;
  const day = sourceDate.getUTCDay();
  const weekStart = new Date(sourceDate); weekStart.setUTCDate(sourceDate.getUTCDate() - ((day + 6) % 7));
  const nextStart = new Date(weekStart); nextStart.setUTCDate(weekStart.getUTCDate() + 7);
  const nextEnd = new Date(nextStart); nextEnd.setUTCDate(nextStart.getUTCDate() + 6);
  const weekday = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  const today = new Date();
  const absoluteHint = d => {
    const ymd = dateYmd(d);
    return d.getTime() < Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
      ? `${ymd}，该日期已过，只能表述为“原计划于${ymd}”，完成情况未知`
      : ymd;
  };
  let out = String(text || '').replace(/下周([一二三四五六日天])/g, (all, w) => {
    const d = new Date(nextStart); d.setUTCDate(nextStart.getUTCDate() + weekday[w]);
    return `${all}（按资料时间即${absoluteHint(d)}）`;
  });
  out = out.replace(/下周(?![一二三四五六日天（])/g, `下周（按资料时间即${dateYmd(nextStart)}至${dateYmd(nextEnd)}）`);
  return out;
}

function buildPrompt(question, docs) {
  if (!docs || docs.length === 0) {
    return `用户问题：${question}\n\n请用中文回答。`;
  }
  // 给每条资料编号，正文用 [n] 角标引用（编号与下方参考资料列表一一对应）。
  const docText = docs.map((doc, i) => {
    let snippet = (doc.content || '').slice(0, 8000);
    const title = String(doc.title || '').replace(/\s+/g, ' ').slice(0, 160);
    const titleDate = title.match(/20\d{2}[年/_-]\d{1,2}[月/_-]\d{1,2}日?/);
    const rawDate = doc.messageTime || doc.createdAt || doc.updatedAt || doc.time || '';
    let sourceDate = titleDate ? titleDate[0] : '';
    if (!sourceDate && rawDate) {
      const parsed = new Date(typeof rawDate === 'number' && rawDate < 1e12 ? rawDate * 1000 : rawDate);
      if (!Number.isNaN(parsed.getTime())) sourceDate = parsed.toISOString().slice(0, 10);
    }
    const parsedSourceDate = parseSourceDate(sourceDate);
    snippet = annotateRelativeDates(snippet, parsedSourceDate);
    const meta = [title && `标题：${title}`, sourceDate && `资料时间：${sourceDate}`].filter(Boolean).join('；');
    return `资料[${i + 1}]${meta ? `（${meta}）` : ''}：\n${snippet}`;
  }).join('\n\n---\n\n');

  return `以下是检索到的资料（每条前有编号）。请依据资料直接回答用户的问题。\n\n${docText}\n\n用户问题：${question}\n\n回答前硬性自检：直接给结论，不要用“根据资料/根据文档”开头；已经早于当前日期的计划必须写“原计划于…，是否完成暂无更新”，不得写成仍待发生的当前计划；每个事实引用正确编号。`;
}

const SYSTEM_KB = [
  '你是一个智能问答助手。用户会给你若干条带编号的参考资料，请基于这些资料，直接、自然地回答用户的问题，就像正常对话一样。',
  '要求：',
  '1. 直接回答问题本身，不要复述问题。**严禁**用"根据提供的资料""根据资料""根据文档""参考资料显示""资料中提到"这类开场白——直接给结论。',
  '2. 绝对不要在正文里写出文档名/标题（如《xxx》）。引用来源只用数字角标表示。',
  '3. 引用规范：凡是基于某条资料得出的关键句子，在该句**句末标点后**紧跟对应编号角标，形如 [1]；若一句综合多条，写 [1][3]。只在真正用到该资料时标注，不要每句都标、不要编造编号。',
  '4. 回答准确、简洁、有条理，中文。信息不足时如实说明，不要编造。',
  '5. 时效规则：资料中的“本周/下周/明天/当前”等相对时间，只代表该资料产生时的时间点。回答中不得照抄历史相对时间，必须使用资料内标注的绝对日期；若计划日期已经过去且没有更新证据，要明确说“当时/原计划”，不能把历史计划当成当前事实。优先采用时间更新且内容明确的资料。',
].join('\n');
const SYSTEM_GENERAL = [
  '你是"飞书知识问答"的智能助手。核心职责：帮用户从其有权限的飞书文档、知识库、会话里找到答案并带来源。本次没有检索到相关资料，请按下面处理：',
  '1. 若是简单的通用/上下文问题（问候、今天几号/现在几点、简单常识、翻译一个词、简单算术），就自然、简短地回答，别显得答不了。',
  '2. 若问题需要的是用户公司/团队内部的具体信息而你并不掌握，或明显偏离知识问答（让你写长文、闲聊、做无关任务）——不要编造、也不要越俎代庖去当通用聊天机器人。简短说明"没有在你的飞书资料里找到相关内容"，并把用户引导回文档问答：建议换用更具体的关键词、指定某篇文档、或上传相关资料后再问。',
  '中文、简洁、不复述问题、不客套。',
].join('\n');

// 给模型注入"当前日期时间"上下文，让它能回答"今天周几/现在几点/日期"等，而不是说自己没有实时能力。
function nowContextLine() {
  const wk = ['日', '一', '二', '三', '四', '五', '六'];
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `【实时上下文】当前日期时间：${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${wk[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}。` +
    `涉及"今天/现在/日期/星期/几号"等问题时，直接用这个时间回答，不要说自己没有获取实时时间的能力。`;
}

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
// 联网搜索工具格式：智谱要 {type:web_search, web_search:{enable:true}}，其它厂商用通用格式。
function webSearchTools(provider) {
  const isZhipu = /bigmodel\.cn/.test(provider.baseUrl || '');
  return isZhipu
    ? [{ type: 'web_search', web_search: { enable: true, search_result: true } }]
    : [{ type: 'web_search' }];
}

async function* askLLMStream(question, docs, history, provider, webSearch = false) {
  if (!provider.apiKey) {
    throw new Error('未配置 LLM API Key');
  }

  // 有相关资料 → 基于资料的带引用回答；没有相关资料 → 退化为普通大模型问答（基础能力，不因检索为空就拒答）
  const hasDocs = Array.isArray(docs) && docs.length > 0;
  const messages = [
    { role: 'system', content: nowContextLine() + '\n' + (hasDocs ? SYSTEM_KB : SYSTEM_GENERAL) },
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: hasDocs ? buildPrompt(question, docs) : question },
  ];

  // 联网：给模型开 web_search 工具。失败则降级为不带工具的普通生成。
  if (webSearch) {
    try { yield* streamChat(provider, messages, { tools: webSearchTools(provider) }); return; }
    catch (_e) { /* 工具不支持 → 降级 */ }
  }
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
    { role: 'system', content: nowContextLine() + '\n' + SYSTEM_GENERAL },
    ...(history || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  if (webSearch) {
    try {
      yield* streamChat(provider, messages, { tools: webSearchTools(provider) });
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
    { role: 'system', content: nowContextLine() + '\n' + SYSTEM_KB },
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
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('KW', question));
  const cached = getDecisionCache(ckey);
  if (cached != null) return cached;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 512,
        temperature: 0,   // 关键词提取要稳定：同问题同关键词（评测可复现的前提）
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
    const out = kw || question;
    putDecisionCache(ckey, out);
    return out;
  } catch (_e) {
    return question;
  }
}

// 通用查询规划：保留用户原话，同时让当前模型给出高置信纠错、实体全称/简称扩展和关键词。
// 纠错只用于增加检索查询，不改写用户问题；结果按模型+问题缓存，避免重复增加首屏延迟。
async function planSearchQuery(question, provider) {
  const fallback = { keywords: String(question || ''), correctedQuestion: '', expansions: [], confidence: 0 };
  if (!provider || !provider.apiKey) return fallback;
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('QPLAN:v3', question));
  const cached = getDecisionCache(ckey);
  if (cached && typeof cached === 'object') return cached;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model, max_tokens: 320, temperature: 0,
        messages: [
          { role: 'system', content: [
            '你是企业搜索查询规划器。识别用户可能打错的同音字/形近字、简称和实体全称，输出严格JSON，不要解释。',
            '格式：{"keywords":"2到4个核心检索词","correctedQuestion":"高置信纠错后的完整问题或空串","expansions":["可能的规范实体名或全称"],"confidence":0到1}',
            '规则：原词会由系统始终保留；只有非常确定才纠错，不确定就留空；不得改变业务含义；expansions最多3条；不要虚构公司内部专名。',
            '例："云校流水线失败"可纠正为"云效流水线失败"；"CRM权限"可扩展"客户关系管理系统 权限"。',
          ].join('\n') },
          { role: 'user', content: String(question || '') },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    const txt = String(j.choices?.[0]?.message?.content || '');
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : txt);
    const clean = value => String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const out = {
      keywords: clean(parsed.keywords) || fallback.keywords,
      correctedQuestion: confidence >= 0.8 ? clean(parsed.correctedQuestion) : '',
      // 低置信扩展经常把企业简称猜成普通词；低于门槛时交给真实语料发现，不采用模型猜测。
      expansions: confidence >= 0.8
        ? [...new Set((Array.isArray(parsed.expansions) ? parsed.expansions : []).map(clean).filter(Boolean))].slice(0, 3)
        : [],
      confidence,
    };
    putDecisionCache(ckey, out);
    return out;
  } catch (_e) { return fallback; }
}

// 空召回时判断：是"常识/通用"问题(直接答、不弹兜底) 还是"需要企业内部资料"(没找到→引导关注公众号)。
// 返回 true = 需要企业内部资料。失败/无 key 默认 true（宁可多引导，也不误吞真实的"没找到"）。
async function classifyNeedsDoc(question, provider) {
  if (!provider || !provider.apiKey) return true;
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('NEEDDOC2', question));
  const cached = getDecisionCache(ckey);
  if (cached != null) return cached === '1';
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 2,
        temperature: 0,
        messages: [
          { role: 'system', content: '给用户问题分类，只输出一个字母 A 或 B。\nA（常识/闲聊，可直接回答）仅限：问候寒暄、日期/时间/星期、天气、简单算术、翻译一个词、极其明显的公开常识。\nB（需要具体资料才能答）：只要问题涉及任何具体的业务、项目、系统、流程、制度、数据、成本、进度、地名/部门/产品等专有名词，或明显是在问某个组织内部的情况——都归 B。\n拿不准就选 B。只输出 A 或 B。' },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) return true;
    const txt = (await res.json()).choices?.[0]?.message?.content || '';
    const needs = !/a/i.test((txt.trim()[0] || 'b'));   // 首字符 A → 不需要(false)
    putDecisionCache(ckey, needs ? '1' : '0');
    return needs;
  } catch (_e) {
    return true;
  }
}

// 澄清反问：问题太笼统/缺对象、无法有效检索时，返回一句反问帮用户补全；足够具体/常识/寒暄 → 返回 ''。
// 保守：只对真正含糊的短问题反问，避免打扰。失败/无 key → ''（不反问，照常检索）。
async function clarifyQuestion(question, provider) {
  if (!provider || !provider.apiKey) return '';
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('CLARIFY2', question));
  const cached = getDecisionCache(ckey);
  if (cached != null) return cached;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model, max_tokens: 60, temperature: 0,
        messages: [
          { role: 'system', content: '这是企业知识问答。仅当问题**完全没有任何具体对象/主题**、无从检索时，才反问补全（例如"有问题吗""进度呢""怎么样""这个怎么办"）。\n**只要问题里带了一个具体名词/系统/项目/术语（如"云效流水线""澳洲迁移""节点边际成本"），哪怕问得宽泛，也一律输出 OK**，交给检索，不要反问"想了解哪个方面"。\n常识/寒暄/时间日期类也输出 OK。\n反问时给一句简短引导；否则只输出 OK。' },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) return '';
    let txt = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    const out = /^ok\b/i.test(txt) || txt.toUpperCase() === 'OK' ? '' : txt;
    putDecisionCache(ckey, out);
    return out;
  } catch (_e) { return '';
  }
}

// 冲突检测：多篇来源对同一问题若存在**互相矛盾**的说法，返回一句简短说明；无冲突 → ''。
// 只在有 ≥2 篇入选来源时调用。失败/无 key → ''（不误报冲突）。
async function detectConflict(question, docs, provider) {
  if (!provider || !provider.apiKey || !Array.isArray(docs) || docs.length < 2) return '';
  try {
    const src = docs.slice(0, 5).map((d, i) => `【来源${i + 1}】${String(d._anchorText || d.content || '').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model, max_tokens: 120, temperature: 0,
        messages: [
          { role: 'system', content: '判断多篇来源对用户问题是否存在**实质性互相矛盾**（如数值/结论/流程步骤明显不一致，而非只是措辞或详略不同）。\n有矛盾：用一句话点明冲突在哪、分别怎么说（≤60字）。\n无实质矛盾：只输出 NONE。\n宁可判 NONE 也不要把"角度不同/互补"当冲突。' },
          { role: 'user', content: `问题：${question}\n${src}` },
        ],
      }),
    });
    if (!res.ok) return '';
    let txt = ((await res.json()).choices?.[0]?.message?.content || '').trim();
    return /^none\b/i.test(txt) || txt.toUpperCase() === 'NONE' ? '' : txt;
  } catch (_e) { return ''; }
}

// ---------------------------------------------------------------------------
// 多轮追问：用对话历史把"省略主语/含指代"的追问改写成脱离上下文也能独立检索的问题。
// 仅用于检索（关键词/召回）；展示与生成仍用用户原话。无历史或失败 → 原样返回。
async function condenseQuery(question, history, provider) {
  if (!provider || !provider.apiKey || !history || !history.length) return question;
  const recent = history.slice(-4)
    .map(m => (m.role === 'user' ? '用户：' : '助手：') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 240))
    .join('\n');
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('COND', question, '|' + recent.slice(-180)));
  const cached = getDecisionCache(ckey);
  if (cached != null) return cached;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model, max_tokens: 120, temperature: 0,
        messages: [
          { role: 'system', content: '把用户的最新问题改写成一个"脱离上下文也能独立检索"的完整问题：用上文里的具体对象替换"它/那个/他/这/上面"等指代，补全省略的主语。只输出改写后的问题本身，不要解释、不要引号。若最新问题本身已完整，就原样输出。' },
          { role: 'user', content: '对话历史：\n' + recent + '\n\n最新问题：' + question },
        ],
      }),
    });
    if (!res.ok) return question;
    const j = await res.json();
    let out = (j.choices?.[0]?.message?.content || '').trim().replace(/^["“']+|["”']+$/g, '').trim();
    out = (out && out.length <= 200) ? out : question;
    putDecisionCache(ckey, out);
    return out;
  } catch (_e) { return question; }
}

// ---------------------------------------------------------------------------
// 多查询扩展（query expansion）：把问题改写成几个不同角度的检索式（同义词/上位词/关键实体），
// 提升召回——单一关键词常漏掉换个说法就能命中的文档。失败则回退为空（调用方用原关键词）。
// ---------------------------------------------------------------------------
async function expandQueries(question, provider, n = 3) {
  if (!provider || !provider.apiKey) return [];
  const ckey = cache.keyOf(cacheModelId(provider), decisionInput('EXP:' + n, question));
  const cached = getDecisionCache(ckey);
  if (cached != null) return cached;
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 200,
        temperature: 0,   // 稳定：同问题同扩展查询（评测可复现）
        messages: [
          { role: 'system', content: `把用户问题改写成${n}个不同角度的检索查询词组，用于飞书全文关键词搜索。要求：每行一个查询；每个查询给 2~3 个**用单个空格分隔**的核心关键词（同义词/上位词/关键实体/相关术语均可）；关键词要拆开、不要连写成长短语。只输出查询，不要编号/解释/标点。\n例："电价由哪些部分构成" →\n电价 构成\n电能量价格 输配电价\n上网电价 组成` },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    const txt = j.choices?.[0]?.message?.content || '';
    const out = txt.split(/\n+/)
      .map(x => x.replace(/^[0-9.、\-\s]+/, '').replace(/[，。？！、"'`]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, n);
    putDecisionCache(ckey, out);
    return out;
  } catch (_e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM 相关性法官（reranker）：判断每个候选段落"能否回答该问题"，0~3 分。
// 比双塔余弦/通用 rerank 准得多（推理判断，非相似度）。失败则不误杀（全给高分）。
// ---------------------------------------------------------------------------
const JUDGE_SYSTEM = [
  '你是 RAG 检索的相关性判官。对每个候选段落，评估它对回答用户问题的**证据价值**：它是否包含可用于回答该问题的信息。',
  '候选分两类：DOCUMENT 是文档段落；CHAT 是会话片段。CHAT 中“命中消息”负责表明讨论的问题，“后续回复”负责提供答案。必须结合问答关系理解省略式短答（如“有，大约20%”），不能因为短答没有重复问题关键词而降分；但只有问题、附和、催问或没有信息的回复仍只能给 0~1 分。',
  '评分（0–3）：',
  '  3 = 直接且充分地回答了问题；',
  '  2 = 含与问题直接相关的实质信息，可支撑部分回答；',
  '  1 = 仅与问题同主题/同领域，但不含可用于回答的信息（如：复述或追问同一问题、只表达相同诉求、泛泛提及、仅有标题）；',
  '  0 = 与问题无关，或属于另一主题。',
  '另给 rank（0–100），用于同一 score 档内排序：越能直接、明确、完整地回答当前问题，rank 越高；只是某个局部材料未涉及、仅提供线索或需要较多推断，rank 应更低。不要因为重复了问题关键词就给高 rank。',
  '准则：以"是否提供了可回答问题的信息"为唯一标准，而非词语或话题的重合。DOCUMENT 看段落本身；CHAT 看命中消息与回复共同形成的证据。不确定是否含有效信息时，取较低分。',
  '只输出 JSON 数组，每项 {"i":编号,"score":0到3,"rank":0到100}，无其它文字。',
].join('\n');

function clipText(value, max) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function judgeEvidence(item) {
  if (item && item.source === 'message') {
    const match = clipText(item.matchText || item.text, 500);
    const replies = Array.isArray(item.afterTexts) ? item.afterTexts : [];
    const replyText = replies.length
      ? replies.slice(0, 3).map((t, i) => `后续回复${i + 1}：${clipText(t, 500)}`).join('\n')
      : clipText(item.text, 1400);
    return `类型：CHAT\n命中消息：${match}\n${replyText || '后续回复：（无）'}`;
  }
  return `类型：DOCUMENT\n段落：${clipText(item && item.text, 900)}`;
}

function judgeKey(model, question, item) {
  return cache.keyOf(model, decisionInput('J4', question, '\u0001' + judgeEvidence(item)));
}

async function judgeRelevance(question, items, provider) {
  // items: [{ text }]，返回与 items 等长的分数数组（0~3）。
  // 带缓存：同 (问题,段落) 只判一次 → 确定性、评测反复跑省 token。
  if (!provider || !provider.apiKey || !items.length) return items.map(() => 3);
  const apiModel = provider.model;
  const model = cacheModelId(provider);
  const scores = new Array(items.length);
  const ranks = new Array(items.length);
  const missItems = [], missIdx = [];
  items.forEach((it, i) => {
    const c = getDecisionCache(judgeKey(model, question, it));
    if (c != null && typeof c === 'object') { scores[i] = c.score; ranks[i] = c.rank; }
    else if (c != null) scores[i] = c;
    else { missItems.push(it); missIdx.push(i); }
  });

  if (missItems.length) {
    // 大批候选一次送入当前通用模型会显著拉长尾延迟，也更容易出现 JSON 截断。
    // 固定小批并行只改变执行方式，不裁剪候选、不改变评分标准；任一批失败仍由下方 fail-closed 处理。
    const batches = [];
    for (let start = 0; start < missItems.length; start += JUDGE_BATCH_SIZE) {
      batches.push({ start, items: missItems.slice(start, start + JUDGE_BATCH_SIZE) });
    }
    const judgedBatches = await Promise.all(batches.map(async batch => {
      const list = batch.items.map((it, i) => `[${i}]\n${judgeEvidence(it)}`).join('\n\n');
      let arr = null;
      let failure = 'invalid response';
      try {
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
          body: JSON.stringify({
            model: apiModel, max_tokens: 600, temperature: 0,   // API 模型名与缓存隔离身份严格分开
            messages: [
              { role: 'system', content: JUDGE_SYSTEM },
              { role: 'user', content: `问题：${question}\n候选：\n${list}` },
            ],
          }),
        });
        if (res.ok) {
          const txt = (await res.json()).choices?.[0]?.message?.content || '';
          const m = txt.match(/\[[\s\S]*\]/);
          arr = JSON.parse(m ? m[0] : txt);
        } else failure = `http ${res.status || 'error'}`;
      } catch (e) { arr = null; failure = e && e.message ? e.message : failure; }
      return { ...batch, arr, failure };
    }));

    let failure = 'invalid response';
    for (const batch of judgedBatches) {
      const local = batch.items.map(() => null);
      const localRanks = batch.items.map(() => null);
      if (Array.isArray(batch.arr)) {
        for (const o of batch.arr) {
          const li = Number(o && o.i);
          if (Number.isInteger(li) && li >= 0 && li < batch.items.length) {
            const sc = Number(o.score);
            local[li] = Number.isFinite(sc) ? Math.max(0, Math.min(3, Math.round(sc))) : null;
            const rank = Number(o.rank);
            localRanks[li] = Number.isFinite(rank) ? Math.max(0, Math.min(100, Math.round(rank))) : null;
          }
        }
      } else failure = batch.failure;
      batch.items.forEach((it, li) => {
        if (local[li] != null) {
          const globalMiss = batch.start + li;
          scores[missIdx[globalMiss]] = local[li];
          ranks[missIdx[globalMiss]] = localRanks[li];
          putDecisionCache(judgeKey(model, question, it), { score: local[li], rank: localRanks[li] });
        }
      });
    }
    // 判官不可用时显式失败，让编排层降级到确定性的向量/词法结果。绝不能伪造 3 分，
    // 否则一次超时会让所有粗召回候选突然进入答案，造成线上精度抖动。
    if (missIdx.some(i => scores[i] == null)) throw new Error(`relevance judge unavailable: ${failure}`);
  }
  // 不改变既有“数字数组”接口；细粒度排序分作为非枚举属性提供给编排层，旧调用方不受影响。
  Object.defineProperty(scores, 'ranks', { value: ranks, enumerable: false });
  return scores;
}

// ── 对抗式复核（怀疑者）：对法官判为"边界档"的候选再严判一遍。返回与 items 等长的 boolean 数组。──
// 只用于把"沾边但没真答上"的边界结果剔除，是提精度的二次校验；抱持怀疑、拿不准判 false。
const VERIFY_SYSTEM = [
  '你是严格的相关性复核者。给你一个问题和一段候选内容，判断它是否**确实为回答该问题提供了有效信息**（不是只沾了话题的边）。',
  '候选可能是 CHAT：要把“命中消息”与“后续回复”视为一组问答证据，正确理解“是的”“20%左右”这类依赖上文的短答；有实质答案则为 true，只有问题/附和/无信息回复则为 false。',
  '抱持怀疑：只有当它真的包含可用于回答该问题的信息时才判 true；泛泛相关、只提到话题、只是同类事项、拿不准，一律 false。',
  '只输出 JSON 数组，每项 {"i":编号,"ok":true/false}，无其它文字。',
].join('\n');

function verifyKey(model, question, item) {
  return cache.keyOf(model, decisionInput('V2', question, '\x01' + judgeEvidence(item)));
}

async function verifyRelevance(question, items, provider) {
  if (!provider || !provider.apiKey || !items.length) return items.map(() => true);
  const apiModel = provider.model;
  const model = cacheModelId(provider);
  const out = new Array(items.length);
  const missItems = [], missIdx = [];
  items.forEach((it, i) => {
    const c = getDecisionCache(verifyKey(model, question, it));
    if (c != null) out[i] = c;
    else { missItems.push(it); missIdx.push(i); }
  });
  if (missItems.length) {
    const list = missItems.map((it, i) => `[${i}]\n${judgeEvidence(it)}`).join('\n\n');
    let arr = null;
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: apiModel, max_tokens: 400, temperature: 0,
          messages: [{ role: 'system', content: VERIFY_SYSTEM }, { role: 'user', content: `问题：${question}\n候选：\n${list}` }] }),
      });
      if (res.ok) { const txt = (await res.json()).choices?.[0]?.message?.content || ''; const m = txt.match(/\[[\s\S]*\]/); arr = JSON.parse(m ? m[0] : txt); }
    } catch (_e) { arr = null; }
    const local = missItems.map(() => null);
    if (Array.isArray(arr)) for (const o of arr) { const li = Number(o && o.i); if (Number.isInteger(li) && li >= 0 && li < missItems.length) local[li] = (o.ok === true); }
    missItems.forEach((it, li) => {
      if (local[li] != null) { out[missIdx[li]] = local[li]; putDecisionCache(verifyKey(model, question, it), local[li]); }
      else { out[missIdx[li]] = true; }   // 没判到 → 不误杀，保留
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  askLLM,          // legacy, kept for rag.js compatibility
  askLLMStream,    // Task 5: streaming RAG
  askLLMGeneral,   // Task 5: streaming general / web search
  extractKeywords, // 关键词提取（改善搜索命中）
  planSearchQuery, // 通用错别字/简称/实体查询规划（原查询始终保留）
  classifyNeedsDoc,// 空召回时判断"常识直接答" vs "需公司资料→引导关注"
  clarifyQuestion, // 澄清反问：太笼统的问题先反问补全
  detectConflict,  // 冲突检测：多来源互相矛盾时提示
  condenseQuery,   // 多轮追问：用历史把追问改写成独立检索问题
  expandQueries,   // 多查询扩展（提升召回）
  judgeRelevance,  // LLM 相关性法官（reranker）
  verifyRelevance, // 对抗式复核（边界档二次严判，提精度）
  buildPrompt,     // exposed for testing / Task 6 RAG
};
