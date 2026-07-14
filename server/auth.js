/**
 * 飞书 OAuth 服务 (server/auth.js)
 *
 * 端点确认（2026-07）：
 *   code → token : POST /open-apis/authen/v1/access_token
 *     请求头 Authorization: Bearer <app_access_token>
 *     响应：{ code, msg, data: { access_token, refresh_token, expires_in,
 *             open_id, name, avatar_url, ... } }
 *     状态：未废弃，仍推荐（v2 已废弃，官方推 v3 外部OAuth；v1仍为标准内嵌登录路径）
 *
 *   refresh   : POST /open-apis/authen/v1/refresh_access_token
 *     同样结构，响应 data 同上
 *
 * 安全：
 *   - state 用 HMAC-SHA256(app_secret) 签名，防 CSRF 授权码注入
 *   - app_secret / user_access_token 不写日志、不返回前端
 */

require('./env');

const crypto = require('crypto');

const FEISHU = 'https://open.feishu.cn';

// ── 内部工具函数 ──────────────────────────────────────────────────────────────

function redirectUri() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000') +
    (process.env.FEISHU_REDIRECT_PATH || '/api/auth/feishu/callback');
}

function secretKey() {
  return process.env.FEISHU_APP_SECRET || 'dev';
}

// ── State 签名 / 验证（防 CSRF）────────────────────────────────────────────────

/**
 * 将任意 payload 签名为 "<base64url_body>.<base64url_hmac>" 字符串
 * key = FEISHU_APP_SECRET，算法 HMAC-SHA256
 * @param {object} payload
 * @returns {string}
 */
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return body + '.' + sig;
}

/**
 * 验证 state 签名，通过则返回 payload，否则返回 null
 * @param {string} state
 * @returns {object|null}
 */
function verifyState(state) {
  if (!state || !state.includes('.')) return null;
  const [body, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

// ── 授权 URL 构建 ──────────────────────────────────────────────────────────────

/**
 * 拼接飞书 OAuth 授权跳转 URL
 * @param {string} state - 已签名的 state 字符串
 * @returns {string}
 */
function buildAuthorizeUrl(state) {
  const u = new URL(FEISHU + '/open-apis/authen/v1/authorize');
  u.searchParams.set('app_id', process.env.FEISHU_APP_ID || '');
  u.searchParams.set('redirect_uri', redirectUri());
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

// ── App Access Token（带 60s 提前刷新缓存）─────────────────────────────────────

let _appTok = null;
let _appExp = 0;

/**
 * 获取（或复用缓存）app_access_token
 * 提前 60 秒刷新，避免因网络延迟导致使用过期 token
 * @returns {Promise<string>}
 */
async function getAppAccessToken() {
  if (_appTok && Date.now() < _appExp - 60000) return _appTok;

  const r = await fetch(FEISHU + '/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('app_access_token failed: ' + JSON.stringify(j));

  _appTok = j.app_access_token;
  _appExp = Date.now() + (j.expire || 7200) * 1000;
  return _appTok;
}

// ── code → user_access_token ───────────────────────────────────────────────────

/**
 * 用授权码换取用户 token
 *
 * 端点：POST /open-apis/authen/v1/access_token
 * 请求头：Authorization: Bearer <app_access_token>
 * 响应 data 字段：access_token / refresh_token / expires_in / open_id / name / avatar_url
 *
 * @param {string} code - 飞书回调带回的 authorization_code（5分钟有效，一次性）
 * @returns {Promise<{openId, name, avatar, userAccessToken, refreshToken, expireAt}>}
 */
async function exchangeCode(code) {
  const appTok = await getAppAccessToken();

  const r = await fetch(FEISHU + '/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + appTok,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('exchange code failed: ' + JSON.stringify(j));

  const d = j.data;
  return {
    openId: d.open_id,
    name: d.name,
    avatar: d.avatar_url,
    userAccessToken: d.access_token,
    refreshToken: d.refresh_token,
    expireAt: Date.now() + (d.expires_in || 7200) * 1000,
  };
}

// ── 刷新 user_access_token ────────────────────────────────────────────────────

/**
 * 用 refresh_token 刷新用户 token
 *
 * 端点：POST /open-apis/authen/v1/refresh_access_token
 * 请求头：Authorization: Bearer <app_access_token>
 * 响应 data 字段同 exchangeCode；refresh_token 一次性，用后立即失效
 *
 * @param {string} refreshToken
 * @returns {Promise<{userAccessToken, refreshToken, expireAt}>}
 */
async function refreshUserToken(refreshToken) {
  const appTok = await getAppAccessToken();

  const r = await fetch(FEISHU + '/open-apis/authen/v1/refresh_access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + appTok,
    },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('refresh failed: ' + JSON.stringify(j));

  const d = j.data;
  return {
    userAccessToken: d.access_token,
    refreshToken: d.refresh_token,
    expireAt: Date.now() + (d.expires_in || 7200) * 1000,
  };
}

// ── 导出 ──────────────────────────────────────────────────────────────────────

module.exports = {
  buildAuthorizeUrl,
  signState,
  verifyState,
  getAppAccessToken,
  exchangeCode,
  refreshUserToken,
  redirectUri,
};
