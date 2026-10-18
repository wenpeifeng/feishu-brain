'use strict';

/**
 * test/router.test.js — router 单元测试
 *
 * 使用 mock req/res 对象，无需监听固定端口。
 * 通过 require.cache 覆盖 rag.js，注入 mock runRAGStream。
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

// ── 1. 注入 mock rag（在 require router 之前） ────────────────────────────────
const ragPath = require.resolve('../server/rag');
let ragCalls = 0;
require.cache[ragPath] = {
  id: ragPath,
  filename: ragPath,
  loaded: true,
  exports: {
    async *runRAGStream(_user, _question, _history, _webSearch, _config) {
      ragCalls++;
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
process.env.QUALITY_CASES_FILE = path.join(os.tmpdir(), 'feishu-kb-router-quality-' + process.pid + '.json');
delete process.env.ADMIN_OPEN_IDS;
delete process.env.DEFAULT_LLM_KEY;

const { handleRequest } = require('../server/router');
delete process.env.DEFAULT_LLM_KEY; // auth.js 会加载 .env；本单测强制使用纯关键词上传索引，避免外网依赖。
const { createSession, removeSession, getSession, setLlmConfig } = require('../server/session');
const { createConversation, deleteConversationOwned } = require('../server/store');
const { recordQualityCase } = require('../server/quality');
const kbStore = require('../server/kb');

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
  // ─── 健康检查：无需登录且不返回配置/密钥 ──────────────────────────────────
  {
    const req = mockReq({ method: 'GET', url: '/api/health' });
    const res = mockRes();
    await dispatch(req, res);
    assert.equal(res.statusCode, 200, '健康检查应返回 200');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.service, 'feishu-brain');
    assert.equal(typeof res.json.uptimeSeconds, 'number');
    assert.strictEqual(res.json.config, undefined, '健康检查不得暴露配置');
    console.log('  ✓ /api/health 无需登录且不暴露配置');
  }

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
    setLlmConfig(token, { providerId: 'glm', apiKey: 'sk-must-never-return' });
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

  // ─── 测试 4：开发者检索参数按用户隔离，不污染系统默认或其他用户 ───────────
  {
    const tokenA = createSession({ openId: 'ou_rag_A', name: 'A', userAccessToken: 'a', refreshToken: 'ra', expireAt: Date.now() + 3600000 });
    const tokenB = createSession({ openId: 'ou_rag_B', name: 'B', userAccessToken: 'b', refreshToken: 'rb', expireAt: Date.now() + 3600000 });
    const post = mockReq({ method: 'POST', url: '/api/config', headers: { authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ pageSize: 17 }) });
    await dispatch(post, mockRes());
    const aRes = await dispatch(mockReq({ method: 'GET', url: '/api/config', headers: { authorization: `Bearer ${tokenA}` } }), mockRes());
    const bRes = await dispatch(mockReq({ method: 'GET', url: '/api/config', headers: { authorization: `Bearer ${tokenB}` } }), mockRes());
    assert.equal(aRes.json.config.pageSize, 17);
    assert.equal(bRes.json.config.pageSize, 10);
    removeSession(tokenA); removeSession(tokenB);
    console.log('  ✓ 检索调试参数按用户会话隔离');
  }

  // ─── 测试 5：SSE ask 端点流式输出 references / token / done ─────────────────
  {
    recordQualityCase({ qid: 'qa-own', openId: 'ou_quality_A', question: '我的案例' });
    recordQualityCase({ qid: 'qa-other', openId: 'ou_quality_B', question: '他人案例' });
    const token = createSession({ openId: 'ou_quality_A', name: 'A', userAccessToken: 'a', refreshToken: 'ra', expireAt: Date.now() + 3600000 });
    const list = await dispatch(mockReq({ method: 'GET', url: '/api/quality/cases?status=all', headers: { authorization: `Bearer ${token}` } }), mockRes());
    assert.equal(list.statusCode, 200);
    assert.equal(list.json.scope, 'personal');
    assert.deepEqual(list.json.cases.map(x => x.id), ['qa-own']);
    const patchOther = await dispatch(mockReq({ method: 'PATCH', url: '/api/quality/cases/qa-other', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ status: 'ignored' }) }), mockRes());
    assert.equal(patchOther.statusCode, 404, '普通用户不得标注他人质量案例');
    const org = await dispatch(mockReq({ method: 'GET', url: '/api/analytics/org', headers: { authorization: `Bearer ${token}` } }), mockRes());
    assert.equal(org.statusCode, 403, '未明确配置管理员时不得开放组织数据');
    removeSession(token);
    console.log('  ✓ 质量案例默认按本人隔离，组织数据默认拒绝');
  }

  // ─── 测试 6：上传知识库的正文/更新/删除严格按 owner 隔离 ────────────────────
  {
    const owner = `ou_kb_owner_${process.pid}`;
    const other = `ou_kb_other_${process.pid}`;
    const doc = await kbStore.addDoc(owner, { title: '仅本人资料', content: '只有所有者可以读取和修改。' }, null);
    const tokenOwner = createSession({ openId: owner, name: 'Owner', userAccessToken: 'a', refreshToken: 'ra', expireAt: Date.now() + 3600000 });
    const tokenOther = createSession({ openId: other, name: 'Other', userAccessToken: 'b', refreshToken: 'rb', expireAt: Date.now() + 3600000 });
    try {
      const ownGet = await dispatch(mockReq({ method: 'GET', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOwner}` } }), mockRes());
      assert.equal(ownGet.statusCode, 200);
      assert.equal(ownGet.json.doc.content, '只有所有者可以读取和修改。');
      const otherGet = await dispatch(mockReq({ method: 'GET', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOther}` } }), mockRes());
      assert.equal(otherGet.statusCode, 404, '其他用户读取同一 id 必须表现为不存在');
      const otherPatch = await dispatch(mockReq({
        method: 'PATCH', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOther}` },
        body: JSON.stringify({ title: '越权修改', expectedRevision: 1 }),
      }), mockRes());
      assert.equal(otherPatch.statusCode, 404, '其他用户不得更新文档');
      const otherDelete = await dispatch(mockReq({ method: 'DELETE', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOther}` } }), mockRes());
      assert.equal(otherDelete.statusCode, 404, '其他用户不得删除文档');
      assert.ok(kbStore.getDoc(owner, doc.id), '越权操作后所有者文档仍存在');
      const ownPatch = await dispatch(mockReq({
        method: 'PATCH', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOwner}` },
        body: JSON.stringify({ content: '所有者发布了第二版内容。', expectedRevision: 1 }),
      }), mockRes());
      assert.equal(ownPatch.statusCode, 200, JSON.stringify(ownPatch.json));
      assert.equal(ownPatch.json.doc.revision, 2);
      const stalePatch = await dispatch(mockReq({
        method: 'PATCH', url: `/api/kb/${doc.id}`, headers: { authorization: `Bearer ${tokenOwner}` },
        body: JSON.stringify({ content: '旧页面覆盖', expectedRevision: 1 }),
      }), mockRes());
      assert.equal(stalePatch.statusCode, 409, '过期 revision 必须拒绝');
      assert.equal(kbStore.getDoc(owner, doc.id).content, '所有者发布了第二版内容。');
      console.log('  ✓ 上传知识库正文、增量更新、版本冲突和删除按所有者隔离');
    } finally {
      await kbStore.deleteDoc(owner, doc.id);
      removeSession(tokenOwner); removeSession(tokenOther);
    }
  }

  // ─── 测试 7：SSE ask 端点流式输出 references / token / done ─────────────────
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
    const beforeCalls = ragCalls;
    await dispatch(req, res);

    const output = res.body;
    assert.ok(output.includes('event: references'), `应含 event: references\n实际: ${output}`);
    assert.ok(output.includes('event: token'), `应含 event: token\n实际: ${output}`);
    assert.ok(output.includes('event: done'), `应含 event: done\n实际: ${output}`);
    // 不应出现 sk- 密钥
    assert.ok(!output.match(/sk-[A-Za-z0-9]+/), 'SSE 输出不应含 sk-* 密钥');

    const repeat = mockReq({
      method: 'POST', url: `/api/conversations/${conv.id}/ask`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: '测试问题', webSearch: false }),
    });
    await dispatch(repeat, mockRes());
    assert.equal(ragCalls - beforeCalls, 2, '相同问题重复请求也必须执行两次实时 RAG，不得回放生成答案');
    console.log('  ✓ SSE ask 端点依次输出 references / token / done，重复问题仍实时检索');
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
