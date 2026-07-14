const { runRAG } = require('./rag');
const { getConfig, updateConfig, getConversations, createConversation, getConversation, deleteConversation, addMessage, updateConversationTitle } = require('./store');
const { MOCK_ANSWER, MOCK_REFERENCES, MOCK_SOURCES } = require('./mock');
const { initLarkCliConfig } = require('./lark');

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Config
 if (url.pathname === '/api/config' && req.method === 'GET') {
   const cfg = getConfig();
   json(res, {
     ok: true,
     config: {
       ...cfg,
       openaiApiKey: cfg.openaiApiKey ? '***' : '',
       appSecret: cfg.appSecret ? '***' : '',
       llmConfigured: !!cfg.openaiApiKey,
       feishuConfigured: !!(cfg.appId && cfg.appSecret),
     },
   });
   return;
 }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (body.appId && body.appSecret) {
        await initLarkCliConfig(body.appId, body.appSecret);
      }
     const cfg = updateConfig(body);
     json(res, {
       ok: true,
       config: {
         ...cfg,
         openaiApiKey: cfg.openaiApiKey ? '***' : '',
         appSecret: cfg.appSecret ? '***' : '',
         llmConfigured: !!cfg.openaiApiKey,
         feishuConfigured: !!(cfg.appId && cfg.appSecret),
       },
     });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // Conversations
  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    const conversations = getConversations().map(c => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }));
    json(res, { ok: true, conversations });
    return;
  }

  if (url.pathname === '/api/conversations' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const conversation = createConversation(body.title || '新对话');
      json(res, { ok: true, conversation });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // Single conversation
  const convMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch && req.method === 'GET') {
    const conversation = getConversation(convMatch[1]);
    if (!conversation) {
      json(res, { ok: false, error: 'Conversation not found' }, 404);
      return;
    }
    json(res, { ok: true, conversation });
    return;
  }

  if (convMatch && req.method === 'DELETE') {
    deleteConversation(convMatch[1]);
    json(res, { ok: true });
    return;
  }

  // Ask in conversation
  const askMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/ask$/);
  if (askMatch && req.method === 'POST') {
    try {
      const conversationId = askMatch[1];
      const conversation = getConversation(conversationId);
      if (!conversation) {
        json(res, { ok: false, error: 'Conversation not found' }, 404);
        return;
      }

      const body = await parseBody(req);
      const question = body.question;

      if (!question || !question.trim()) {
        json(res, { ok: false, error: 'Question is required' }, 400);
        return;
      }

      const userMessage = {
        id: `msg_${Date.now()}_u`,
        role: 'user',
        content: question.trim(),
        timestamp: new Date().toISOString(),
      };
      addMessage(conversationId, userMessage);

      if (conversation.messages.length === 1) {
        updateConversationTitle(conversationId, question.trim().slice(0, 30));
      }

      const useMock = process.env.USE_MOCK === 'true';
      let result;
      if (useMock) {
        result = {
          answer: MOCK_ANSWER,
          references: MOCK_REFERENCES,
          sources: MOCK_SOURCES,
          mock: true,
        };
      } else {
        const history = conversation.messages.slice(0, -1).map(m => ({
          role: m.role,
          content: m.content,
        }));
        result = await runRAG(question.trim(), history, body.webSearch || false);
      }

      const assistantMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: result.answer,
        references: result.references,
        sources: result.sources,
        mock: result.mock || false,
        timestamp: new Date().toISOString(),
      };
      addMessage(conversationId, assistantMessage);

      json(res, { ok: true, ...result });
    } catch (err) {
      console.error('Ask error:', err);
      json(res, {
        ok: false,
        error: err.message,
        larkError: err.larkError,
        hint: '如果这是 lark-cli 认证问题，请尝试在设置中清空飞书 App ID/Secret 以使用全局 lark-cli 配置；或运行 lark-cli auth login；或设置 USE_MOCK=true 使用示例数据。',
      }, 500);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = { handleRequest };
