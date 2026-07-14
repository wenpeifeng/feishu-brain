const { searchDocs, fetchDoc } = require('./lark');
const { askLLM, askLLMGeneral } = require('./llm');
const { getConfig } = require('./store');

async function runRAG(question, conversationHistory = [], webSearch = false) {
  const config = getConfig();

  if (webSearch) {
    const answer = await askLLMGeneral(question, conversationHistory, config);
    return {
      answer,
      references: [],
      sources: [],
    };
  }

  const searchResults = await searchDocs(question, config.pageSize);

  if (searchResults.length === 0) {
    return {
      answer: '未找到相关文档。',
      references: [],
      sources: [],
    };
  }

  const docs = [];
  for (let i = 0; i < Math.min(config.topK, searchResults.length); i++) {
    const item = searchResults[i];
    try {
      const doc = await fetchDoc(item.url || item.token);
      docs.push({
        ...item,
        content: doc.content,
        title: doc.title || item.title,
      });
    } catch (e) {
      console.error(`Failed to fetch doc ${item.url}:`, e.message);
    }
  }

  const answer = await askLLM(question, docs, conversationHistory, config);

  return {
    answer,
    references: searchResults,
    sources: docs.map(d => ({ title: d.title, url: d.url })),
  };
}

module.exports = { runRAG };
