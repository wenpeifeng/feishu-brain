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

const { searchDocs, fetchDoc } = require('./feishu');
const { askLLMStream, askLLMGeneral } = require('./llm');
const { resolveProvider } = require('./providers');

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
      results = await searchDocs(userAccessToken, question, pageSize);
    } catch (_err) {
      results = [];
    }

    yield { type: 'references', references: results };

    try {
      for await (const delta of askLLMGeneral(question, history, provider, true)) {
        yield { type: 'token', delta };
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

  // Step 1: 搜索飞书文档
  let results;
  try {
    results = await searchDocs(userAccessToken, question, pageSize);
  } catch (err) {
    const msg = err.message || String(err);
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '搜索飞书文档失败：' + msg };
    return;
  }

  // Step 2: 搜索结果为空
  if (results.length === 0) {
    yield { type: 'references', references: [] };
    yield { type: 'token', delta: '未找到相关文档。' };
    return;
  }

  // Step 3: 取前 topK 项，fetchDoc 拿正文
  const topItems = results.slice(0, topK);
  const docs = await Promise.all(
    topItems.map(async item => {
      const { title, content } = await fetchDoc(userAccessToken, item);
      return { ...item, title: title || item.title, content };
    })
  );

  // Step 4: 先 yield references（让前端立刻显示参考资料）
  yield { type: 'references', references: results };

  // Step 5: 流式生成回答
  try {
    for await (const delta of askLLMStream(question, docs, history, provider)) {
      yield { type: 'token', delta };
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('未配置 LLM API Key')) {
      yield { type: 'token', delta: '⚠️ 未配置 LLM API Key，请在设置中选择模型厂商' };
    } else {
      yield { type: 'token', delta: '⚠️ 生成回答时出错：' + msg };
    }
  }

  // Step 6: yield sources（仅含有内容的文档）
  const sources = docs
    .filter(d => d.content)
    .map(d => ({ title: d.title, url: d.url }));
  yield { type: 'sources', sources };
}

module.exports = { runRAGStream };
