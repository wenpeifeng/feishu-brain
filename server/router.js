'use strict';

/**
 * server/router.js — 飞书 OAuth 路由 + 鉴权中间件 + SSE 流式问答 + config
 *
 * 安全约束：
 *   - apiKey / userAccessToken / refreshToken 绝不下发前端、绝不 log
 *   - 对话路由全部用 ownerOpenId 隔离（防 IDOR）
 */

const { buildAuthorizeUrl, signState, verifyState, exchangeCode, refreshUserToken } = require('./auth');
const { createSession, getSession, updateTokens, removeSession } = require('./session');
const {
  createConversation, getConversationsFor, getConversationOwned,
  deleteConversationOwned, addMessage, updateConversationTitleOwned,
  getConfig, updateConfig,
} = require('./store');
const { publicProviders } = require('./providers');
const { runRAGStream } = require('./rag');

// ── 鉴权中间件 ─────────────────────────────────────────────────────────────────

/**
 * 从 Authorization: Bearer <token> 取 session；
 * 若 token 过期则自动刷新；失败返回 null。
 * @param {IncomingMessage} req
 * @returns {Promise<object|null>}
 */
async function requireAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;

  let ctx = getSession(token);
  if (!ctx) return null;

  if (Date.now() > ctx.expireAt) {
    try {
      const t = await refreshUserToken(ctx.refreshToken);
      updateTokens(token, t);
      ctx = getSession(token);
    } catch (_err) {
      removeSession(token);
      return null;
    }
  }

  return ctx;
}

// ── CORS 头 ────────────────────────────────────────────────────────────────────

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** 脱敏 config，绝不含 apiKey 明文 */
function sanitizedConfig() {
  const cfg = getConfig();
  return {
    providerId: cfg.providerId || cfg.llmProvider || '',
    topK: cfg.topK,
    pageSize: cfg.pageSize,
    custom: cfg.custom ? {
      baseUrl: cfg.custom.baseUrl || '',
      model: cfg.custom.model || '',
      // apiKey 用 *** 占位
      apiKey: cfg.custom.apiKey ? '***' : '',
    } : undefined,
  };
}

// ── 主路由 ─────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  setCORSHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 1. GET /api/auth/feishu/login-url ─────────────────────────────────────
  if (url.pathname === '/api/auth/feishu/login-url' && req.method === 'GET') {
    const redirect = url.searchParams.get('redirect') || '/';
    const state = signState({ redirect });
    json(res, { url: buildAuthorizeUrl(state) });
    return;
  }

  // ── 2. GET /api/auth/feishu/callback ──────────────────────────────────────
  if (url.pathname === '/api/auth/feishu/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    const payload = verifyState(state);
    if (!payload) {
      res.writeHead(302, { Location: '/login.html?error=invalid_state' });
      res.end();
      return;
    }

    try {
      const user = await exchangeCode(code);
      const token = createSession(user);
      const dest = `/?token=${encodeURIComponent(token)}&state=${encodeURIComponent(payload.redirect || '/')}`;
      res.writeHead(302, { Location: dest });
      res.end();
    } catch (_err) {
      res.writeHead(302, { Location: '/login.html?error=auth_failed' });
      res.end();
    }
    return;
  }

  // ── 3. GET /api/auth/me ────────────────────────────────────────────────────
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }
    json(res, { ok: true, user: { openId: ctx.openId, name: ctx.name, avatar: ctx.avatar } });
    return;
  }

  // ── 4. POST /api/auth/logout ───────────────────────────────────────────────
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (token) removeSession(token);
    json(res, { ok: true });
    return;
  }

  // ── 5. GET /api/config ─────────────────────────────────────────────────────
  if (url.pathname === '/api/config' && req.method === 'GET') {
    json(res, { ok: true, providers: publicProviders(), config: sanitizedConfig() });
    return;
  }

  // ── 6. POST /api/config ────────────────────────────────────────────────────
  if (url.pathname === '/api/config' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const allowed = {};
      if (body.providerId !== undefined) allowed.providerId = body.providerId;
      if (body.custom !== undefined) allowed.custom = body.custom;
      if (body.topK !== undefined) allowed.topK = body.topK;
      if (body.pageSize !== undefined) allowed.pageSize = body.pageSize;
      updateConfig(allowed);
      json(res, { ok: true, providers: publicProviders(), config: sanitizedConfig() });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 7. GET /api/conversations ──────────────────────────────────────────────
  if (url.pathname === '/api/conversations' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }
    const list = getConversationsFor(ctx.openId).map(c => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }));
    json(res, { ok: true, conversations: list });
    return;
  }

  // ── 8. POST /api/conversations ─────────────────────────────────────────────
  if (url.pathname === '/api/conversations' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }
    try {
      const body = await parseBody(req);
      const conversation = createConversation(ctx.openId, body.title || '新对话');
      json(res, { ok: true, conversation });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 9. GET /api/conversations/:id ─────────────────────────────────────────
  const convMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);

  if (convMatch && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }
    const conversation = getConversationOwned(convMatch[1], ctx.openId);
    if (!conversation) {
      json(res, { ok: false, error: 'Conversation not found' }, 404);
      return;
    }
    json(res, { ok: true, conversation });
    return;
  }

  // ── 10. DELETE /api/conversations/:id ──────────────────────────────────────
  if (convMatch && req.method === 'DELETE') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }
    const ok = deleteConversationOwned(convMatch[1], ctx.openId);
    if (!ok) {
      json(res, { ok: false, error: 'Conversation not found or access denied' }, 404);
      return;
    }
    json(res, { ok: true });
    return;
  }

  // ── 11. POST /api/conversations/:id/ask (SSE) ──────────────────────────────
  const askMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/ask$/);
  if (askMatch && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) {
      json(res, { ok: false, error: '未登录或登录已过期' }, 401);
      return;
    }

    const conversationId = askMatch[1];
    const conversation = getConversationOwned(conversationId, ctx.openId);
    if (!conversation) {
      json(res, { ok: false, error: 'Conversation not found or access denied' }, 404);
      return;
    }

    let body;
    try {
      body = await parseBody(req);
    } catch (_err) {
      json(res, { ok: false, error: 'Invalid request body' }, 400);
      return;
    }

    const question = (body.question || '').trim();
    if (!question) {
      json(res, { ok: false, error: 'Question is required' }, 400);
      return;
    }

    // 存用户消息
    const userMsg = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: question,
      timestamp: new Date().toISOString(),
    };
    addMessage(conversationId, ctx.openId, userMsg);

    // 第一条消息时更新标题
    const freshConv = getConversationOwned(conversationId, ctx.openId);
    if (freshConv && freshConv.messages.length === 1) {
      updateConversationTitleOwned(conversationId, ctx.openId, question.slice(0, 30));
    }

    // SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 组装 history（除最后一条）
    const allMsgs = freshConv ? freshConv.messages : [];
    const history = allMsgs.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    let answer = '';
    let references = [];
    let sources = [];

    try {
      for await (const ev of runRAGStream(ctx, question, history, !!body.webSearch, getConfig())) {
        res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
        if (ev.type === 'token') answer += ev.delta || '';
        if (ev.type === 'references') references = ev.references || [];
        if (ev.type === 'sources') sources = ev.sources || [];
      }

      // 存 assistant 消息
      const asgMsg = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: answer,
        references,
        sources,
        timestamp: new Date().toISOString(),
      };
      addMessage(conversationId, ctx.openId, asgMsg);

      res.write('event: done\ndata: ' + JSON.stringify({ messageId: asgMsg.id }) + '\n\n');
      res.end();
    } catch (err) {
      // 安全：不泄露 token/key
      const hint = err.hint || '请检查配置或稍后重试';
      res.write('event: error\ndata: ' + JSON.stringify({ error: '问答失败', hint }) + '\n\n');
      res.end();
    }
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end('Not found');
}

module.exports = { handleRequest, requireAuth };
