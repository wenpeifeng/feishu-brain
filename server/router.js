'use strict';

/**
 * server/router.js — 飞书 OAuth 路由 + 鉴权中间件 + SSE 流式问答 + config
 *
 * 安全约束：
 *   - apiKey / userAccessToken / refreshToken 绝不下发前端、绝不 log
 *   - 对话路由全部用 ownerOpenId 隔离（防 IDOR）
 */

const { buildAuthorizeUrl, signState, verifyState, exchangeCode, refreshUserToken } = require('./auth');
const { createSession, getSession, updateTokens, setLlmConfig, setRagConfig, removeSession } = require('./session');
const {
  createConversation, getConversationsFor, getConversationOwned,
  deleteConversationOwned, addMessage, updateConversationTitleOwned,
  getConfig,
} = require('./store');
const { publicProviders, resolveEmbed, resolveProvider } = require('./providers');
const { addDoc, getDoc, listDocs, updateDoc, reindexAll, deleteDoc } = require('./kb');
const {
  tenantIdOf, orgStoreKey, registerMember, getMembership, isAdmin: isOrgAdmin,
  listMembers, setMemberRole, memberOpenIds,
} = require('./organization');
const { parseFile } = require('./parse');
const mineru = require('./mineru');

// 图片/扫描件 OCR：调外部 OCR API（部署者自带 OCR_API_URL/OCR_API_KEY）。未配置返回 null（懒提醒填 key）。
async function ocrImage(buf) {
  if (!process.env.OCR_API_URL || !process.env.OCR_API_KEY) return null;
  try {
    const r = await fetch(process.env.OCR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OCR_API_KEY },
      body: JSON.stringify({ image: buf.toString('base64') }),
    });
    const j = await r.json().catch(() => ({}));
    return j.text || (j.data && j.data.text) || (j.result && j.result.text) || '';
  } catch (_e) { return null; }
}

async function parseKbUpload(body) {
  const filename = String(body.filename || '文档').slice(0, 200);
  const b64 = String(body.dataBase64 || '');
  if (b64.length > 28 * 1024 * 1024) {
    const e = new Error('文件过大（上限约 20MB）'); e.status = 413; throw e;
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) { const e = new Error('文件为空'); e.status = 400; throw e; }
  let text, kind, parser = '', warning = '';
  const useMinerU = /\.pdf$/i.test(filename) && mineru.enabled();
  if (useMinerU) {
    try {
      const parsed = await mineru.parseToMarkdown(filename, buf);
      return {
        filename,
        text: parsed.text,
        kind: parsed.kind,
        parser: parsed.parser,
        warning: '',
      };
    } catch (e) {
      warning = `本机 MinerU 暂不可用（${e.message}）`;
    }
  }
  try {
    const parsed = await parseFile(filename, buf);
    text = parsed.text; kind = parsed.kind;
    parser = kind === 'pdf' ? 'pdfjs' : kind;
    if (warning && kind === 'pdf') warning += '，已降级为本地文本解析；表格和版式可能不完整';
  } catch (e) {
    if (e.code === 'OCR_NEEDED') {
      if (warning) {
        const err = new Error(`${warning}；该 PDF 没有可提取文本，无法继续降级`);
        err.status = 503;
        err.parserUnavailable = true;
        throw err;
      }
      const ocr = await ocrImage(buf);
      if (ocr && ocr.trim()) { text = ocr; kind = 'ocr'; parser = 'ocr'; }
      else {
        const err = new Error(process.env.OCR_API_KEY ? 'OCR 未识别出文字' : '这是图片/扫描件，需要 OCR：请在服务端配置 OCR_API_URL/OCR_API_KEY 后重试');
        err.status = 400; err.needOcr = !process.env.OCR_API_KEY; throw err;
      }
    } else if (e.code === 'UNSUPPORTED') { e.status = 400; throw e; }
    else throw e;
  }
  if (!text || !text.trim()) { const e = new Error('没能从该文件解析出文字'); e.status = 400; throw e; }
  return { filename, text, kind, parser, warning };
}
const { logQuestion, logFeedback, getSummary, getOrgSummary } = require('./analytics');
const { recordQualityCase, listQualityCases, updateQualityCase, attachQualityFeedback, getQualityMetrics } = require('./quality');
const feishubot = require('./feishubot');
const { runRAGStream } = require('./rag');
const { exportToDoc, listChats, listGroupContacts, sendMessageAsUser, buildShareCard } = require('./feishu');

// "转发给同事"名单缓存：openId -> { ts, list }，5 分钟有效（聚合群成员较重）。
const _contactsCache = new Map();
const { addWish } = require('./wishes');
const { addTask, listTasks, removeTask, toggleTask } = require('./tasks');

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

  // 提前 5 分钟刷新，避免请求进行中 token 恰好过期（飞书返回 99991677）
  if (Date.now() > (ctx.expireAt || 0) - 5 * 60 * 1000) {
    try {
      const t = await refreshUserToken(ctx.refreshToken);
      updateTokens(token, t);
      ctx = getSession(token);
    } catch (_err) {
      removeSession(token);
      return null;
    }
  }

  // 组织边界来自飞书 tenant_key；老会话由部署级 tenant 配置迁移。
  // 注册只维护角色元数据，不读取飞书通讯录，也不扩大用户资料权限。
  registerMember(ctx);
  return ctx;
}

// ── CORS 头 ────────────────────────────────────────────────────────────────────

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** 把用户传入的数值夹到合法区间，非法则回退默认值 */
function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function isAdminUser(ctx) {
  return !!ctx && isOrgAdmin(ctx);
}

function kbAccess(ctx, url, write) {
  const scope = url.searchParams.get('scope') === 'organization' ? 'organization' : 'personal';
  const membership = getMembership(ctx);
  const canManage = scope === 'personal' || !!(membership && membership.isAdmin);
  if (write && !canManage) return { scope, canManage, forbidden: true, storeKey: '' };
  return {
    scope,
    canManage,
    storeKey: scope === 'organization' ? orgStoreKey(tenantIdOf(ctx)) : ctx.openId,
  };
}

/** 该用户的脱敏配置：LLM 来自其会话（每人独立），topK/pageSize 用全局默认。绝不回传明文 apiKey */
function sanitizedConfig(ctx) {
  const llm = (ctx && ctx.llm) || {};
  const g = { ...getConfig(), ...((ctx && ctx.rag) || {}) };
  return {
    providerId: llm.providerId || 'glm',
    hasKey: !!llm.apiKey,
    // 密钥只存在服务端会话；即使回给本人也会扩大 XSS/浏览器扩展泄露面。
    apiKey: '',
    custom: { baseUrl: llm.baseUrl || '', model: llm.model || '' },
    topK: g.topK,
    adaptiveEvidence: g.adaptiveEvidence,
    evidenceMin: g.evidenceMin,
    evidenceMax: g.evidenceMax,
    evidenceScoreGap: g.evidenceScoreGap,
    pageSize: g.pageSize,
    readPool: g.readPool,
    minScore: g.minScore,
    judgeMin: g.judgeMin,
    adversarial: g.adversarial,
    chatSearch: g.chatSearch,
    chatSize: g.chatSize,
    chatAfter: g.chatAfter,
    chatBefore: g.chatBefore,
  };
}

/** 组装该用户实际用于问答的完整 config：会话里的 LLM + 全局 topK/pageSize */
function userRagConfig(ctx) {
  const llm = (ctx && ctx.llm) || {};
  const g = { ...getConfig(), ...((ctx && ctx.rag) || {}) };
  return {
    providerId: llm.providerId || 'glm',
    apiKey: llm.apiKey || '',
    baseUrl: llm.baseUrl || '',
    model: llm.model || '',
    topK: g.topK,
    adaptiveEvidence: g.adaptiveEvidence,
    evidenceMin: g.evidenceMin,
    evidenceMax: g.evidenceMax,
    evidenceScoreGap: g.evidenceScoreGap,
    pageSize: g.pageSize,
    readPool: g.readPool,
    minScore: g.minScore,
    judgeMin: g.judgeMin,
    adversarial: g.adversarial,
    chatSearch: g.chatSearch,
    chatSize: g.chatSize,
    chatAfter: g.chatAfter,
    chatBefore: g.chatBefore,
  };
}

// ── 主路由 ─────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  setCORSHeaders(res);

  // 无鉴权、无敏感信息的进程存活检查，供本项目启停脚本和容器健康检查使用。
  if (url.pathname === '/api/health' && req.method === 'GET') {
    json(res, {
      ok: true,
      service: 'feishu-brain',
      uptimeSeconds: Math.floor(process.uptime()),
    });
    return;
  }

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
    const membership = getMembership(ctx);
    json(res, {
      ok: true,
      user: {
        openId: ctx.openId, name: ctx.name, avatar: ctx.avatar,
        role: membership.role, isAdmin: membership.isAdmin,
        organization: membership.organization,
      },
    });
    return;
  }

  // ── 组织管理：成员是“登录过本系统的同租户用户”，无需申请通讯录权限。────────
  if (url.pathname === '/api/organization' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const membership = getMembership(ctx);
    const managed = membership.isAdmin ? listMembers(ctx) : null;
    json(res, {
      ok: true,
      organization: membership.organization,
      role: membership.role,
      isAdmin: membership.isAdmin,
      isOwner: membership.isOwner,
      members: managed ? managed.members : [],
    });
    return;
  }

  const orgMemberMatch = url.pathname.match(/^\/api\/organization\/members\/([^/]+)$/);
  if (orgMemberMatch && req.method === 'PATCH') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const result = setMemberRole(ctx, decodeURIComponent(orgMemberMatch[1]), String(body.role || ''));
      if (!result) { json(res, { ok: false, error: '组织不存在' }, 404); return; }
      json(res, { ok: true, ...result });
    } catch (err) {
      const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : 400;
      json(res, { ok: false, error: err.message }, status);
    }
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

  // ── 5. GET /api/config（需登录，返回该用户自己的配置）───────────────────────
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    json(res, { ok: true, providers: publicProviders(), config: sanitizedConfig(ctx) });
    return;
  }

  // ── 6. POST /api/config（保存该用户自己的 LLM 厂商+apiKey 到会话）──────────────
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      // apiKey 为空字符串时保留原 key（前端不回传明文，避免覆盖成空）
      const prev = ctx.llm || {};
      setLlmConfig(ctx.token, {
        providerId: body.providerId || prev.providerId || 'qwen',
        apiKey: (body.apiKey !== undefined && body.apiKey !== '') ? body.apiKey : (prev.apiKey || ''),
        baseUrl: body.baseUrl !== undefined ? body.baseUrl : (prev.baseUrl || ''),
        model: body.model !== undefined ? body.model : (prev.model || ''),
      });
      // 检索调参（全局，界面可调）：召回数量/读取候选数/相关度阈值
      const g = {};
      if (body.topK !== undefined) g.topK = clampNum(body.topK, 1, 8, 3);
      if (body.adaptiveEvidence !== undefined) g.adaptiveEvidence = !!body.adaptiveEvidence;
      if (body.evidenceMin !== undefined) g.evidenceMin = clampNum(body.evidenceMin, 1, 5, 2);
      if (body.evidenceMax !== undefined) g.evidenceMax = clampNum(body.evidenceMax, 1, 8, 5);
      if (body.evidenceScoreGap !== undefined) g.evidenceScoreGap = clampNum(body.evidenceScoreGap, 0, 0.5, 0.15);
      if (body.pageSize !== undefined) g.pageSize = clampNum(body.pageSize, 1, 30, 10);
      if (body.readPool !== undefined) g.readPool = clampNum(body.readPool, 1, 20, 12);
      if (body.minScore !== undefined) g.minScore = clampNum(body.minScore, 0, 1, 0.4);
      if (body.judgeMin !== undefined) g.judgeMin = clampNum(body.judgeMin, 1, 3, 2);
      if (body.adversarial !== undefined) g.adversarial = !!body.adversarial;
      if (body.chatSearch !== undefined) g.chatSearch = !!body.chatSearch;
      if (body.chatSize !== undefined) g.chatSize = clampNum(body.chatSize, 1, 10, 6);
      if (body.chatAfter !== undefined) g.chatAfter = clampNum(body.chatAfter, 0, 8, 3);
      if (body.chatBefore !== undefined) g.chatBefore = clampNum(body.chatBefore, 0, 4, 0);
      if (Object.keys(g).length) setRagConfig(ctx.token, g);
      json(res, { ok: true, providers: publicProviders(), config: sanitizedConfig(ctx) });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 知识库：scope=personal（本人）/ organization（同租户共享）──────────────
  if (url.pathname === '/api/kb' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, false);
    json(res, { ok: true, docs: listDocs(access.storeKey), scope: access.scope, canManage: access.canManage });
    return;
  }

  // ── 知识库：POST /api/kb（上传一篇文档，body: {title, content}）──────────────
  if (url.pathname === '/api/kb' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    try {
      const body = await parseBody(req);
      if (!body.content || !String(body.content).trim()) {
        json(res, { ok: false, error: '文档内容为空' }, 400);
        return;
      }
      // 上传即建索引：用该用户自己的 embedding（GLM）为每块建向量；无向量则退化为 BM25
      const embedConfig = resolveEmbed(userRagConfig(ctx));
      const doc = await addDoc(access.storeKey, { title: body.title, content: String(body.content) }, embedConfig);
      json(res, { ok: true, doc });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 知识库：POST /api/kb/upload（传文件 base64 → 服务端解析 → 入库）──────────
  // body: { filename, dataBase64 }。docx/xlsx/pptx/txt/md/文本PDF 零 key 解析；
  // 图片/扫描件 PDF 走 OCR（配了 key 才行，否则 needOcr=true 提示用户，不影响其它上传）。
  if (url.pathname === '/api/kb/upload' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    try {
      const body = await parseBody(req);
      const { filename, text, kind, parser, warning } = await parseKbUpload(body);
      const embedConfig = resolveEmbed(userRagConfig(ctx));
      const doc = await addDoc(access.storeKey, { title: filename, content: text }, embedConfig);
      json(res, { ok: true, doc, kind, parser, warning, degraded: !!warning, chars: text.length });
    } catch (err) { json(res, { ok: false, needOcr: !!err.needOcr, error: err.message }, err.status || (err.code === 'INDEX_BUILD_FAILED' ? 503 : 500)); }
    return;
  }

  // ── 知识库：POST /api/kb/reindex（模型变化或修复后重建本人全部索引）─────────
  if (url.pathname === '/api/kb/reindex' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    const result = await reindexAll(access.storeKey, resolveEmbed(userRagConfig(ctx)));
    json(res, { ok: result.failed === 0, ...result }, result.failed ? 207 : 200);
    return;
  }

  // ── 知识库：POST /api/kb/:id/upload（替换文件，仅重建变化块）────────────────
  const kbUploadMatch = url.pathname.match(/^\/api\/kb\/([^/]+)\/upload$/);
  if (kbUploadMatch && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    try {
      const body = await parseBody(req);
      const { filename, text, kind, parser, warning } = await parseKbUpload(body);
      const doc = await updateDoc(
        access.storeKey,
        decodeURIComponent(kbUploadMatch[1]),
        { title: filename, content: text },
        resolveEmbed(userRagConfig(ctx)),
        { expectedRevision: body.expectedRevision },
      );
      if (!doc) { json(res, { ok: false, error: '文档不存在' }, 404); return; }
      json(res, { ok: true, doc, kind, parser, warning, degraded: !!warning, chars: text.length });
    } catch (err) {
      const status = err.status || (err.code === 'REVISION_CONFLICT' ? 409 : err.code === 'INDEX_BUILD_FAILED' ? 503 : 500);
      json(res, { ok: false, needOcr: !!err.needOcr, error: err.message, currentRevision: err.currentRevision }, status);
    }
    return;
  }

  // ── 知识库：GET/PATCH/DELETE /api/kb/:id ───────────────────────────────────
  const kbMatch = url.pathname.match(/^\/api\/kb\/([^/]+)$/);
  if (kbMatch && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, false);
    const doc = getDoc(access.storeKey, decodeURIComponent(kbMatch[1]));
    if (!doc) { json(res, { ok: false, error: '文档不存在' }, 404); return; }
    json(res, { ok: true, doc });
    return;
  }
  if (kbMatch && req.method === 'PATCH') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    try {
      const body = await parseBody(req);
      if (body.content !== undefined && !String(body.content).trim()) {
        json(res, { ok: false, error: '文档内容为空' }, 400); return;
      }
      const doc = await updateDoc(
        access.storeKey,
        decodeURIComponent(kbMatch[1]),
        { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.content !== undefined ? { content: body.content } : {}) },
        resolveEmbed(userRagConfig(ctx)),
        { expectedRevision: body.expectedRevision },
      );
      if (!doc) { json(res, { ok: false, error: '文档不存在' }, 404); return; }
      json(res, { ok: true, doc });
    } catch (err) {
      const status = err.code === 'REVISION_CONFLICT' ? 409 : err.code === 'INDEX_BUILD_FAILED' ? 503 : 500;
      json(res, { ok: false, error: err.message, currentRevision: err.currentRevision }, status);
    }
    return;
  }
  if (kbMatch && req.method === 'DELETE') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const access = kbAccess(ctx, url, true);
    if (access.forbidden) { json(res, { ok: false, error: '仅组织管理员可以维护组织知识库' }, 403); return; }
    try {
      const ok = await deleteDoc(access.storeKey, decodeURIComponent(kbMatch[1]), url.searchParams.get('revision'));
      if (!ok) { json(res, { ok: false, error: '文档不存在' }, 404); return; }
      json(res, { ok: true });
    } catch (err) {
      json(res, { ok: false, error: err.message, currentRevision: err.currentRevision }, err.code === 'REVISION_CONFLICT' ? 409 : 500);
    }
    return;
  }

  // ── 定时追踪：GET /api/tasks（本人全部定时任务）─────────────────────────────
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    json(res, { ok: true, tasks: listTasks(ctx.openId) });
    return;
  }

  // ── 定时追踪：POST /api/tasks（新建，body: {question, hour, minute}）──────────
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const r = addTask(ctx.openId, { question: body.question, hour: body.hour, minute: body.minute });
      if (r && r.error) { json(res, { ok: false, error: r.error }, 400); return; }
      json(res, { ok: true, task: r });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 定时追踪：PATCH /api/tasks/:id（启用/停用，body: {enabled}）───────────────
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const ok = toggleTask(ctx.openId, decodeURIComponent(taskMatch[1]), !!body.enabled);
      json(res, { ok });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 定时追踪：DELETE /api/tasks/:id ────────────────────────────────────────
  if (taskMatch && req.method === 'DELETE') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const ok = removeTask(ctx.openId, decodeURIComponent(taskMatch[1]));
    json(res, { ok });
    return;
  }

  // ── 转发目标：GET /api/chats（列出用户所在的群，供一键转发选择）──────────────
  if (url.pathname === '/api/chats' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const chats = await listChats(ctx.userAccessToken);
      json(res, { ok: true, chats });
    } catch (err) {
      json(res, { ok: false, error: err.message, needReauth: err.code === 99991679 });
    }
    return;
  }

  // ── 转发目标：GET /api/contacts（从用户所在群聚合同事名单，供"转发给指定人"选人）──
  if (url.pathname === '/api/contacts' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const cached = _contactsCache.get(ctx.openId);
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) { json(res, { ok: true, contacts: cached.list }); return; }
      const list = await listGroupContacts(ctx.userAccessToken, ctx.openId);
      _contactsCache.set(ctx.openId, { ts: Date.now(), list });
      json(res, { ok: true, contacts: list });
    } catch (err) {
      json(res, { ok: false, error: err.message, needReauth: err.code === 99991679 });
    }
    return;
  }

  // ── 一键转发：POST /api/share/forward ────────────────────────────────────────
  // 一个动作解决多步：① 用你的账号把答案导出成云文档 ② 以「你本人身份」把文档链接发给指定人/群。
  // 需用户 scope im:message:send。body: { receiveType:'open_id'|'chat_id', receiveId, question, answer, references }
  if (url.pathname === '/api/share/forward' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const a = String(body.answer || '').trim();
      if (!a) { json(res, { ok: false, error: '没有可分享的内容' }, 400); return; }
      const receiveType = body.receiveType === 'chat_id' ? 'chat_id' : 'open_id';
      const receiveId = String(body.receiveId || '').trim() || ctx.openId;   // 缺省发给自己
      // ① 导出成你名下的云文档（点卡片跳到这里）
      const dateStr = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      const doc = await exportToDoc(ctx.userAccessToken, { question: body.question, answer: a, references: body.references, sharer: ctx.name, dateStr });
      // ② 以你本人身份发「分享卡片」：蓝色标题栏 + AI 副标题 + 答案摘要 + 查看文档按钮 + 整卡点击跳文档
      const q = String(body.question || '').trim();
      const card = buildShareCard({ title: q || doc.title, answer: a, url: doc.url, sharer: ctx.name, dateStr });
      const r = await sendMessageAsUser(ctx.userAccessToken, receiveType, receiveId, 'interactive', card);
      if (r && r.code === 0) { json(res, { ok: true, url: doc.url }); return; }
      // 99991679 = 缺 im:message:send（需后台开通 + 重新登录）
      json(res, { ok: false, url: doc.url, error: r && r.msg ? r.msg : '发送失败', needReauth: r && r.code === 99991679 });
    } catch (err) { json(res, { ok: false, error: err.message }, 500); }
    return;
  }

  // ── 提问看板：GET /api/analytics（本人提问统计/盲区/满意度）──────────────────
  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const isAdmin = isAdminUser(ctx);
    json(res, { ok: true, summary: getSummary(ctx.openId), isAdmin });
    return;
  }

  // ── 组织级看板：GET /api/analytics/org（跨用户聚合，仅管理员）──────────────────
  if (url.pathname === '/api/analytics/org' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const isAdmin = isAdminUser(ctx);
    if (!isAdmin) { json(res, { ok: false, error: '仅管理员可见组织看板' }, 403); return; }
    json(res, { ok: true, summary: getOrgSummary(memberOpenIds(ctx)) });
    return;
  }

  // ── 反馈闭环：POST /api/feedback（body: {qid, vote:'up'|'down'}）──────────────
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const ok = logFeedback(ctx.openId, body.qid, body.vote, body.reason);
      try { attachQualityFeedback(body.qid, body.vote, body.reason, ctx.openId); } catch (_e) { /* 质量记录失败不影响反馈 */ }
      json(res, { ok });
    } catch (err) { json(res, { ok: false, error: err.message }, 500); }
    return;
  }

  // ── 检索质量工作台：自动采集案例 + 管理员人工金标 ────────────────────────────
  if (url.pathname === '/api/quality/cases' && req.method === 'GET') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    const isAdmin = isAdminUser(ctx);
    const qualityScope = isAdmin ? { openIds: memberOpenIds(ctx) } : { openId: ctx.openId };
    json(res, { ok: true, ...listQualityCases({
      status: url.searchParams.get('status') || 'pending',
      priority: url.searchParams.get('priority') || 'all',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit') || 100,
      ...qualityScope,
    }), metrics: getQualityMetrics(qualityScope), scope: isAdmin ? 'organization' : 'personal' });
    return;
  }

  const qualityMatch = url.pathname.match(/^\/api\/quality\/cases\/([^/]+)$/);
  if (qualityMatch && req.method === 'PATCH') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const item = updateQualityCase(
        decodeURIComponent(qualityMatch[1]),
        await parseBody(req),
        isAdminUser(ctx) ? { openIds: memberOpenIds(ctx) } : { openId: ctx.openId }
      );
      if (!item) { json(res, { ok: false, error: '案例不存在' }, 404); return; }
      json(res, { ok: true, case: item });
    } catch (err) { json(res, { ok: false, error: err.message }, 500); }
    return;
  }

  // ── 导出到飞书文档：POST /api/export/doc（body: {question, answer}）───────────
  if (url.pathname === '/api/export/doc' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      if (!body.answer || !String(body.answer).trim()) { json(res, { ok: false, error: '没有可导出的答案' }, 400); return; }
      const doc = await exportToDoc(ctx.userAccessToken, { question: body.question, answer: body.answer, references: body.references });
      json(res, { ok: true, url: doc.url, title: doc.title });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 500);
    }
    return;
  }

  // ── 提交反馈 / 许愿：POST /api/wish（body: {type, content}）────────────────────
  if (url.pathname === '/api/wish' && req.method === 'POST') {
    const ctx = await requireAuth(req);
    if (!ctx) { json(res, { ok: false, error: '未登录或登录已过期' }, 401); return; }
    try {
      const body = await parseBody(req);
      const w = addWish(ctx.openId, ctx.name, { type: body.type, content: body.content }, Date.now());
      json(res, { ok: true, id: w.id });
    } catch (err) {
      json(res, { ok: false, error: err.message }, 400);
    }
    return;
  }

  // ── 飞书机器人事件回调：POST /api/feishu/event（飞书调用，无用户鉴权）─────────
  // 处理 URL 验证 challenge + im.message.receive_v1。3 秒内 ACK，异步处理并回复。
  if (url.pathname === '/api/feishu/event' && req.method === 'POST') {
    let raw = '';
    try { raw = await parseRawBody(req); } catch (_e) { raw = ''; }
    const parsed = feishubot.parseInbound(raw, process.env.FEISHU_ENCRYPT_KEY || '');
    if (parsed.type === 'challenge') { json(res, { challenge: parsed.challenge }, 200); return; }
    if (parsed.type === 'event') {
      // 校验 Verification Token（配了才校验）
      const vt = process.env.FEISHU_VERIFICATION_TOKEN || '';
      if (vt && parsed.header && parsed.header.token !== vt) { json(res, {}, 200); return; }
      json(res, {}, 200);                                  // 立刻 ACK，避免飞书 3s 超时重推
      feishubot.handleMessage(parsed, { appBaseUrl: process.env.APP_BASE_URL }).catch(() => {});
      return;
    }
    json(res, {}, 200);
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

    // 实时事实服务禁止回放生成答案：网页问答与定时追踪都必须执行当前检索、重排和生成。
    // 高频问题只进入 analytics / 质量工作台，不自动升级为秒答。

    let answer = '';
    let references = [];
    let sources = [];
    let debug = null;
    let sawReasoning = false;
    let relatedFiles = [];
    let relatedEvidence = [];
    let noResult = false, about = false, conflict = '', confidence = null;

    try {
      for await (const ev of runRAGStream(ctx, question, history, !!body.webSearch, userRagConfig(ctx))) {
        res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
        if (ev.type === 'token') answer += ev.delta || '';
        if (ev.type === 'answerFinal') answer = ev.text || '';
        if (ev.type === 'references') references = ev.references || [];
        if (ev.type === 'sources') sources = ev.sources || [];
        if (ev.type === 'debug') debug = ev.debug || null;
        if (ev.type === 'reasoning') sawReasoning = true;
        if (ev.type === 'relatedFiles') relatedFiles = ev.files || [];
        if (ev.type === 'relatedEvidence') relatedEvidence = ev.evidence || [];
        if (ev.type === 'noresult') noResult = true;
        if (ev.type === 'about') about = true;
        if (ev.type === 'conflict') conflict = ev.text || '';
        if (ev.type === 'confidence') confidence = ev.confidence || null;
      }

      // 提问看板：记录本次提问（命中参考数用于知识盲区检测），qid 供前端反馈
      let qid = '';
      try { qid = logQuestion(ctx.openId, question, references.length, tenantIdOf(ctx)); } catch (_e) { /* 记录失败不影响 */ }

      // 自动沉淀检索轨迹供人工金标：记录模型版本、全部候选、法官通过项和最终证据集。
      // 仅管理员接口可读取；不记录 API Key / access token。
      try {
        const p = resolveProvider(userRagConfig(ctx));
        recordQualityCase({
          qid, openId: ctx.openId, tenantId: tenantIdOf(ctx), userName: ctx.name, question, answer,
          provider: { id: p.id, model: p.model }, references, relatedEvidence, debug,
          noResult, conflict, confidence,
        });
      } catch (_e) { /* 质量采集失败不影响主问答 */ }

      // 存 assistant 消息（含 debug/qid/reasoning，供切换会话后重建检索详情与思考面板）
      const asgMsg = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: answer,
        references,
        sources,
        debug,
        reasoning: sawReasoning,
        relatedFiles,
        relatedEvidence,
        noResult, about, conflict, confidence,   // 存这些信号，切换会话后能重建卡片
        qid,
        timestamp: new Date().toISOString(),
      };
      addMessage(conversationId, ctx.openId, asgMsg);

      // done 再带一次补充证据，防止长 SSE 在浏览器分片边界上漏掉独立事件；前端以此作最终兜底。
      res.write('event: done\ndata: ' + JSON.stringify({ messageId: asgMsg.id, qid, relatedEvidence }) + '\n\n');
      res.end();
    } catch (_err) {
      // 安全：不泄露 token/key，不透传 err.message/err.hint
      res.write('event: error\ndata: ' + JSON.stringify({ error: '问答失败，请稍后重试', hint: '如持续失败，请检查模型配置或重新登录' }) + '\n\n');
      res.end();
    }
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end('Not found');
}

module.exports = { handleRequest, requireAuth };
