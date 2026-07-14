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

const { searchDocs, fetchDoc, enrichReferences } = require('./feishu');
const { askLLMStream, askLLMGeneral, extractKeywords } = require('./llm');
const { resolveProvider, resolveFastProvider } = require('./providers');

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

  // Step 1: 搜索（立刻给"搜索中"反馈）
  yield { type: 'status', text: '正在搜索飞书知识库…' };
  let results;
  try {
    const keywords = await extractKeywords(question, fast);
    results = await searchDocs(userAccessToken, keywords, pageSize);
  } catch (err) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '搜索飞书文档失败：' + (err.message || String(err)) };
    return;
  }
  if (results.length === 0) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '未找到相关文档。' };
    return;
  }

  // 作者/日期富化：并行进行，不阻塞后续阅读与生成（参考资料在最后才展示）
  const enrichP = enrichReferences(userAccessToken, results).catch(() => results);

  // Step 2: 读取最相关的前 topK 篇正文（给"阅读中"反馈）
  yield { type: 'status', text: '正在阅读相关文档…' };
  const topItems = results.slice(0, topK);
  const docs = await Promise.all(
    topItems.map(item =>
      fetchDoc(userAccessToken, item)
        .then(d => ({ ...item, title: d.title || item.title, content: d.content || '' }))
        .catch(() => ({ ...item, content: '' }))
    )
  );

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
  const enriched = await enrichP;
  yield { type: 'references', references: enriched };
  yield { type: 'sources', sources: docs.filter(d => d.content).map(d => ({ title: d.title, url: d.url })) };
}

module.exports = { runRAGStream };
