'use strict';

/**
 * test/router.test.js — router 单元测试
 *
 * 使用 mock req/res 对象，无需监听固定端口。
 * 通过 require.cache 覆盖 rag.js，注入 mock runRAGStream。
 */

const assert = require('assert');
const { EventEmitter } = require('events');

// ── 1. 注入 mock rag（在 require router 之前） ────────────────────────────────
const ragPath = require.resolve('../server/rag');
require.cache[ragPath] = {
  id: ragPath,
  filename: ragPath,
  loaded: true,
  exports: {
    async *runRAGStream(_user, _question, _history, _webSearch, _config) {
      yield { type: 'references', references: [{ title: 'doc1', url: 'http://example.com/1' }] };
      yield { type: 'token', delta: 'Hello ' };
      yield { type: 'token', delta: 'world' };
      yield { type: 'sources', sources: [{ title: 'doc1', url: 'http://example.com/1' }] };
    },
  },
};

// 同样 mock auth.js 避免需要真实 FEISHU_APP_SECRET
// （signState/verifyState 会尝试读 env，用真实模块时需要设 env）
process.env.FEISHU_APP_SECRET = 'test-secret-for-unit-tests';
process.env.FEISHU_APP_ID = 'test-app-id';

const { handleRequest } = require('../server/router');
const { createSession, removeSession, getSession } = require('../server/session');
const { createConversation, deleteConversationOwned } = require('../server/store');

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 构造 mock req 对象
 */
function mockReq({ method = 'GET', url, headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', ...headers };

  // 模拟 body 数据流
  process.nextTick(() => {
    if (body !== null) {
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.emit('end');
  });

  return req;
}

/**
 * 构造 mock res 对象，收集输出
 */
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,

    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
    end(chunk) {
      if (chunk) this.chunks.push(chunk);
      this.ended = true;
    },
    get body() {
      return this.chunks.join('');
    },
    get json() {
      try { return JSON.parse(this.body); } catch { return null; }
    },
  };
  return res;
}

/**
 * 发送请求并等待 res.end()
 */
function dispatch(req, res) {
  return new Promise((resolve, reject) => {
    handleRequest(req, res).then(() => resolve(res)).catch(reject);
    // 超时保护：若连接未结束则 reject，避免测试假通过
    setTimeout(() => {
      if (!res.ended) reject(new Error('SSE dispatch timeout'));
    }, 3000);
  });
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

const cleanup = [];

async function run() {
  // ─── 测试 1：无 token 访问 /api/conversations → 401 ─────────────────────────
  {
    const req = mockReq({ method: 'GET', url: '/api/conversations' });
    const res = mockRes();
    await dispatch(req, res);
    assert.equal(res.statusCode, 401, '无 Authorization 应返回 401');
    const data = res.json;
    assert.equal(data.ok, false, 'ok 应为 false');
    assert.ok(data.error, '应有 error 字段');
    console.log('  ✓ 无 token 访问对话列表 → 401');
  }

  // ─── 测试 2：有效 token 访问 /api/auth/me → 用户信息，不含 userAccessToken ──
  {
    const token = createSession({
      openId: 'ou_T',
      name: 'TestUser',
      avatar: 'https://example.com/avatar.jpg',
      userAccessToken: 'sk-secret-token',
      refreshToken: 'refresh-xyz',
      expireAt: Date.now() + 3_600_000,
    });
    cleanup.push(() => removeSession(token));

    const req = mockReq({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = mockRes();
    await dispatch(req, res);

    assert.equal(res.statusCode, 200, '/api/auth/me 应返回 200');
    const data = res.json;
    assert.equal(data.ok, true, 'ok 应为 true');
    assert.equal(data.user.openId, 'ou_T', 'openId 应为 ou_T');
    assert.equal(data.user.name, 'TestUser', 'name 应为 TestUser');
    assert.strictEqual(data.user.userAccessToken, undefined, 'user 不应含 userAccessToken');
    assert.strictEqual(data.user.token, undefined, 'user 不应含 token 字段');
    console.log('  ✓ /api/auth/me 返回用户信息，不含敏感字段');
  }

  // ─── 测试 3：GET /api/config（需登录）不含 apiKey 明文 ────────────────────────
  {
    const token = createSession({
      openId: 'ou_cfg', name: 'C', userAccessToken: 'sk-secret-token',
      refreshToken: 'r', expireAt: Date.now() + 3600000,
    });
    const req = mockReq({ method: 'GET', url: '/api/config', headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    await dispatch(req, res);

    assert.equal(res.statusCode, 200, '/api/config 应返回 200');
    const body = res.body;
    // 不允许出现 sk- 开头的密钥
    const skMatch = body.match(/sk-[A-Za-z0-9]+/);
    assert.ok(!skMatch, `config 响应不应含 sk-* 密钥，实际: ${body}`);
    const data = res.json;
    assert.equal(data.config.apiKey, '', '未设置时 apiKey 应为空(不泄露 userAccessToken)');
    removeSession(token);
    console.log('  ✓ GET /api/config 需登录且不含 apiKey 明文');
  }

  // ─── 测试 4：SSE ask 端点流式输出 references / token / done ─────────────────
  {
    // 创建用户 session
    const token = createSession({
      openId: 'ou_SSE',
      name: 'SSEUser',
      avatar: '',
      userAccessToken: 'uat-sse-test',
      refreshToken: 'rft-sse-test',
      expireAt: Date.now() + 3_600_000,
    });
    cleanup.push(() => removeSession(token));

    // 创建对话
    const conv = createConversation('ou_SSE', 'SSE测试对话');
    cleanup.push(() => deleteConversationOwned(conv.id, 'ou_SSE'));

    const req = mockReq({
      method: 'POST',
      url: `/api/conversations/${conv.id}/ask`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ question: '测试问题', webSearch: false }),
    });
    const res = mockRes();
    await dispatch(req, res);

    const output = res.body;
    assert.ok(output.includes('event: references'), `应含 event: references\n实际: ${output}`);
    assert.ok(output.includes('event: token'), `应含 event: token\n实际: ${output}`);
    assert.ok(output.includes('event: done'), `应含 event: done\n实际: ${output}`);
    // 不应出现 sk- 密钥
    assert.ok(!output.match(/sk-[A-Za-z0-9]+/), 'SSE 输出不应含 sk-* 密钥');
    console.log('  ✓ SSE ask 端点依次输出 references / token / done');
  }

  // ─── 测试 5：requireAuth 刷新失败 → 401 + 清除会话 ──────────────────────────
  {
    // 造一个已过期的 session
    const expiredToken = createSession({
      openId: 'ou_expired',
      name: 'ExpiredUser',
      avatar: '',
      userAccessToken: 'uat-expired',
      refreshToken: 'rft-expired',
      expireAt: Date.now() - 1000,   // 已过期
    });
    // 不加入 cleanup，由本测试自己验证被清除

    // 需要让 router.js 内部的 refreshUserToken 抛错：
    // 由于 router.js 用了解构 const { refreshUserToken } = require('./auth')，
    // 必须清除 router 缓存并重新注入 auth mock，再重新 require router。
    const authPath = require.resolve('../server/auth');
    const routerPath = require.resolve('../server/router');
    const origAuthCache = require.cache[authPath];
    const origRouterCache = require.cache[routerPath];

    try {
      // 注入 auth stub（refreshUserToken 抛错）
      require.cache[authPath] = {
        id: authPath,
        filename: authPath,
        loaded: true,
        exports: {
          ...origAuthCache.exports,
          refreshUserToken: async function stubRefresh() {
            throw new Error('mock: refresh rejected');
          },
        },
      };
      // 清除 router 缓存，让它重新 require auth（使用 stub）
      delete require.cache[routerPath];
      const { handleRequest: handleRequest2 } = require(routerPath);

      const req = mockReq({
        method: 'GET',
        url: '/api/conversations',
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      const res = mockRes();
      await new Promise((resolve, reject) => {
        handleRequest2(req, res).then(() => resolve(res)).catch(reject);
        setTimeout(() => { if (!res.ended) reject(new Error('SSE dispatch timeout')); }, 3000);
      });

      assert.equal(res.statusCode, 401, '刷新失败应返回 401');
      const data = res.json;
      assert.equal(data.ok, false, 'ok 应为 false');

      // 会话应已被 removeSession 清除
      assert.equal(getSession(expiredToken), null, '刷新失败后会话应被清除');
      console.log('  ✓ requireAuth 刷新失败 → 401 + 会话已清除');
    } finally {
      // 恢复真实 auth 和 router 缓存
      require.cache[authPath] = origAuthCache;
      delete require.cache[routerPath];
      require.cache[routerPath] = origRouterCache;
      // 确保不残留（万一没被清除）
      removeSession(expiredToken);
    }
  }

  // ─── 清理 ─────────────────────────────────────────────────────────────────
  for (const fn of cleanup) fn();

  console.log('router ok');
}

run().catch(err => {
  console.error('router test FAILED:', err);
  process.exit(1);
});
