'use strict';

/**
 * server/rag.js — 流式 RAG 编排（Task 6）
 *
 * 导出：
 *   async function* runRAGStream(user, question, history, webSearch, config)
 *
 * 依赖：
 *   feishu.searchDocs(userAccessToken, query, pageSize) → [{index,title,type,token,url,owner,editTime}]
 *   feishu.fetchDoc(userAccessToken, item) → {title, content}
 *   llm.askLLMStream(question, docs, history, provider) → async generator yielding string deltas
 *   llm.askLLMGeneral(question, history, provider, webSearch) → async generator yielding string deltas
 *   providers.resolveProvider(config) → {id,name,model,baseUrl,apiKey}
 *
 * 安全约束：只用 user.userAccessToken，不使用 app/tenant token。
 * 不 log token 或 apiKey。
 */

const { searchDocs, fetchDoc, enrichReferences, parseFeishuDocUrls, findAnchorBlock } = require('./feishu');
const { askLLMStream, askLLMGeneral, extractKeywords } = require('./llm');
const { resolveProvider, resolveFastProvider } = require('./providers');
const { searchKb } = require('./kb');

/**
 * RAG 流式编排生成器。
 *
 * yield 事件类型：
 *   { type: 'references', references: [...] }  — 参考资料列表（尽早 yield）
 *   { type: 'token', delta: '...' }             — 正文 delta（多次）
 *   { type: 'sources', sources: [{title,url}] } — 结尾
 *
 * @param {{ openId, userAccessToken }} user
 * @param {string} question
 * @param {Array}  history   — [{role,content}]
 * @param {boolean} webSearch
 * @param {object}  config   — { pageSize, topK, providerId, custom, ... }
 */
async function* runRAGStream(user, question, history = [], webSearch = false, config = {}) {
  const userAccessToken = user.userAccessToken;
  const pageSize = config.pageSize || 9;
  const topK     = config.topK     || 3;
  const provider = resolveProvider(config);

  // ── webSearch=true 分支：联网问答 ──────────────────────────────────────────
  if (webSearch) {
    // 并行搜索（try/catch 防止 502 等网络错误）
    let results = [];
    try {
      results = await searchAndEnrich(userAccessToken, question, provider, pageSize);
    } catch (_err) {
      results = [];
    }

    yield { type: 'references', references: results };

    try {
      for await (const chunk of askLLMGeneral(question, history, provider, true)) {
        if (chunk.type === 'reasoning') yield { type: 'reasoning', delta: chunk.text };
        else yield { type: 'token', delta: chunk.text };
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('未配置 LLM API Key')) {
        yield { type: 'token', delta: '⚠️ 未配置 LLM API Key，请在设置中选择模型厂商' };
      } else {
        yield { type: 'token', delta: '⚠️ 生成回答时出错：' + msg };
      }
    }

    const sources = results.map(r => ({ title: r.title, url: r.url }));
    yield { type: 'sources', sources };
    return;
  }

  // ── webSearch=false 分支：知识库问答 ──────────────────────────────────────
  // 用状态事件给用户即时反馈（业界做法：不让用户对着空白等），并把慢步骤挪出首屏关键路径。
  const fast = resolveFastProvider() || provider;   // 关键词用快模型，避免慢推理拖首屏

  // Step 0: 若消息里粘了飞书文档链接，直接定位这几篇（"帮我总结这篇文档"场景）
  const urlItems = parseFeishuDocUrls(question);
  const cleanQ = question.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();

  // Step 1: 搜索（立刻给"搜索中"反馈）
  yield { type: 'status', text: urlItems.length ? '正在打开你发的文档…' : '正在搜索知识库…' };

  let searchResults = [];
  let kbResults = [];
  let searchErr = null;
  let keywords = '';   // 供搜索 + 后续深链定位块用
  // 粘了文档链接就只总结那篇（不再关键词搜索，避免搜出一堆不相干的）
  if (!urlItems.length) {
    try { keywords = await extractKeywords(question, fast); } catch (_e) { keywords = question; }
    try {
      if (keywords) searchResults = await searchDocs(userAccessToken, keywords, pageSize);
    } catch (err) { searchErr = err; }
    // 本地知识库（用户上传的补充文档）一起检索
    try { if (keywords) kbResults = searchKb(user.openId, keywords); } catch (_e) { kbResults = []; }

    if (searchErr && !kbResults.length) {
      yield { type: 'references', references: [] };
      yield { type: 'token', delta: '搜索文档失败：' + (searchErr.message || String(searchErr)) };
      return;
    }
  }

  // 合并：链接文档最前（用户明确指定）→ 本地知识库 → 飞书搜索，按 token 去重
  const seen = new Set();
  const results = [];
  for (const r of [...urlItems, ...kbResults, ...searchResults]) {
    if (!r.token || seen.has(r.token)) continue;
    seen.add(r.token);
    results.push(r);
  }
  if (results.length === 0) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '未找到相关文档。' };
    return;
  }

  // 作者/日期富化：并行进行，不阻塞后续阅读与生成（参考资料在最后才展示）
  const enrichP = enrichReferences(userAccessToken, results).catch(() => results);

  // Step 2: 读取正文（给"阅读中"反馈）。优先读能读到正文的类型（docx/wiki/本地KB），
  // 把 mp4/pptx/pdf/sheet 这些读不到正文的排后面，保证 AI 拿到真正的内容。
  yield { type: 'status', text: '正在阅读相关文档…' };
  const READABLE = new Set(['docx', 'wiki', 'doc']);
  const readableFirst = [
    ...results.filter(r => r.source === 'kb' || READABLE.has(r.type)),
    ...results.filter(r => r.source !== 'kb' && !READABLE.has(r.type)),
  ];
  const topItems = readableFirst.slice(0, Math.max(topK, urlItems.length));
  const docs = await Promise.all(
    topItems.map(item => {
      // 本地知识库文档已带正文，无需再拉取
      if (item.source === 'kb' || item.content) {
        return Promise.resolve({ ...item, content: item.content || '' });
      }
      return fetchDoc(userAccessToken, item)
        .then(d => ({ ...item, title: d.title || item.title, content: d.content || '', docId: d.docId || '' }))
        .catch(() => ({ ...item, content: '' }));
    })
  );

  // 深链定位：为读到正文的 docx 文档，找到与问题最匹配的块，构造 ?block_id= 深链，
  // 点参考资料就能跳到文档里最相关的那一段（像飞书自家知识问答）。并行、失败静默降级。
  const anchorKw = keywords || question;
  const anchorByToken = new Map();
  await Promise.all(docs.filter(d => d.docId && d.content && d.url).map(async d => {
    try {
      const blockId = await findAnchorBlock(userAccessToken, d.docId, anchorKw);
      if (blockId) {
        const origin = new URL(d.url).origin;
        anchorByToken.set(d.token, `${origin}/docx/${d.docId}?block_id=${blockId}`);
      }
    } catch (_e) { /* 定位失败就用原链接 */ }
  }));

  // Step 3: 流式生成回答（首个 reasoning/token 一到，前端状态即切换）
  try {
    for await (const chunk of askLLMStream(question, docs, history, provider)) {
      if (chunk.type === 'reasoning') yield { type: 'reasoning', delta: chunk.text };
      else yield { type: 'token', delta: chunk.text };
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('未配置 LLM API Key')) {
      yield { type: 'token', delta: '⚠️ 未配置 LLM API Key，请在设置中选择模型厂商' };
    } else {
      yield { type: 'token', delta: '⚠️ 生成回答时出错：' + msg };
    }
  }

  // Step 4: 参考资料（富化已并行完成）+ 来源
  // 链接文档的标题在 fetchDoc 后才有，回填到参考资料里
  // docx 正文首行通常就是标题，用它兜底链接文档的标题
  const titleByToken = new Map(docs.map(d => [d.token, d.title || (d.content || '').split('\n')[0].trim().slice(0, 60)]));
  const enriched = (await enrichP).map(r => ({
    ...r,
    title: r.title || titleByToken.get(r.token) || '飞书文档',
    url: anchorByToken.get(r.token) || r.url,   // 有定位块就用深链，否则原链接
  }));
  yield { type: 'references', references: enriched };
  yield { type: 'sources', sources: docs.filter(d => d.content).map(d => ({ title: d.title, url: d.url })) };
}

module.exports = { runRAGStream };
