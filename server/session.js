const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// In-memory store: token -> ctx
const sessions = new Map();

// Load persisted sessions on module load
function loadFromDisk() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    for (const [token, ctx] of Object.entries(raw)) {
      sessions.set(token, ctx);
    }
  } catch (e) {
    // Corrupt file — start fresh
  }
}

function saveToDisk() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj = {};
  for (const [token, ctx] of sessions.entries()) {
    // 安全：用户自填的 LLM apiKey 只留在内存，绝不落盘（避免会话文件泄露密钥）。
    // 服务重启后需重新填写——正是"每次登录填一次、缓存"的语义。
    const { llm, ...rest } = ctx;
    obj[token] = llm ? { ...rest, llm: { ...llm, apiKey: '' } } : rest;
  }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

loadFromDisk();

/**
 * Create a new session for a user.
 * @param {{ openId, name, avatar?, userAccessToken, refreshToken, expireAt }} user
 * @returns {string} 32-char hex token
 */
function createSession(user) {
  const token = crypto.randomBytes(16).toString('hex');
  const ctx = {
    token,
    openId: user.openId,
    name: user.name,
    avatar: user.avatar || '',
    tenantKey: user.tenantKey || '',
    tenantName: user.tenantName || '',
    userAccessToken: user.userAccessToken,
    refreshToken: user.refreshToken,
    expireAt: user.expireAt,
    grantedScope: user.grantedScope || '',   // 飞书实际授予的 scope（排查用）
  };
  sessions.set(token, ctx);
  saveToDisk();
  return token;
}

/**
 * Retrieve a session context by token.
 * @param {string} token
 * @returns {{ token, openId, name, avatar, userAccessToken, refreshToken, expireAt } | null}
 */
function getSession(token) {
  return sessions.get(token) || null;
}

/**
 * 按 openId 找该用户最新的有效登录态（机器人按发消息人 openId 复用其网页登录的权限）。
 * @param {string} openId
 * @returns {object|null}
 */
function getSessionByOpenId(openId) {
  if (!openId) return null;
  let best = null;
  for (const ctx of sessions.values()) {
    if (ctx.openId === openId && (ctx.expireAt || 0) > Date.now()) {
      if (!best || (ctx.expireAt || 0) > (best.expireAt || 0)) best = ctx;
    }
  }
  return best;
}

/**
 * 找该用户的会话，忽略过期（定时任务在 access_token 过期后仍需拿 refresh_token 续期）。
 * 优先返回 refresh_token 最新（expireAt 最大）的那个。
 * @param {string} openId
 * @returns {object | null}
 */
function getSessionByOpenIdAny(openId) {
  if (!openId) return null;
  let best = null;
  for (const ctx of sessions.values()) {
    if (ctx.openId === openId && ctx.refreshToken) {
      if (!best || (ctx.expireAt || 0) > (best.expireAt || 0)) best = ctx;
    }
  }
  return best;
}

/**
 * Update token fields for an existing session.
 * @param {string} token
 * @param {{ userAccessToken, refreshToken, expireAt }} updates
 */
function updateTokens(token, { userAccessToken, refreshToken, expireAt }) {
  const ctx = sessions.get(token);
  if (!ctx) return;
  ctx.userAccessToken = userAccessToken;
  ctx.refreshToken = refreshToken;
  ctx.expireAt = expireAt;
  saveToDisk();
}

/**
 * 保存该用户自己的 LLM 配置（厂商 + apiKey）到会话里。随登录态存在，登出/过期即失效。
 * @param {string} token
 * @param {{ providerId, apiKey, baseUrl?, model? }} llm
 */
function setLlmConfig(token, llm) {
  const ctx = sessions.get(token);
  if (!ctx) return null;
  ctx.llm = {
    providerId: llm.providerId || 'qwen',
    apiKey: llm.apiKey || '',
    baseUrl: llm.baseUrl || '',
    model: llm.model || '',
  };
  saveToDisk();
  return ctx.llm;
}

/** 保存该用户自己的检索调试参数；与登录态隔离，不修改系统默认值。 */
function setRagConfig(token, rag) {
  const ctx = sessions.get(token);
  if (!ctx) return null;
  ctx.rag = { ...(ctx.rag || {}), ...(rag || {}) };
  saveToDisk();
  return ctx.rag;
}

/**
 * Remove a session.
 * @param {string} token
 */
function removeSession(token) {
  sessions.delete(token);
  saveToDisk();
}

module.exports = { createSession, getSession, getSessionByOpenId, getSessionByOpenIdAny, updateTokens, setLlmConfig, setRagConfig, removeSession };
