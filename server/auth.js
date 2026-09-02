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
  const k = process.env.FEISHU_APP_SECRET;
  if (!k) throw new Error('FEISHU_APP_SECRET is not set');
  return k;
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
  const idx = state.indexOf('.');
  if (idx === -1) return null;
  const body = state.slice(0, idx);
  const sig = state.slice(idx + 1);
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
// 需要向用户申请的 scope。飞书 OAuth 只授予 authorize URL 里显式请求的 user scope，
// 应用后台"开通"某权限 ≠ 用户 token 自动拥有——必须在此请求，用户同意后 token 才带上。
// ⚠️ 只能请求应用后台**已开通**的 scope；请求未开通的会 20027 阻断整个登录。
// 2026-07-15 用户已在控制台开通以下 user scope（sheets/bitable/老doc/人名/群聊消息检索），
// 加入授权列表后需用户**重新登录**才会写进新 token。
// ⚠️ 名字必须与控制台「已开通」的 scope 一字不差，否则 authorize 会 20027 阻断登录。
// 下列均为已从控制台截图/接口报错**确认过确切名字**的：
const DEFAULT_SCOPES = [
  // 已有（一直生效）
  'search:docs:read', 'wiki:wiki:readonly', 'docx:document:readonly',
  'wiki:node:read', 'drive:drive.metadata:readonly',
  // 已确认开通（2026-07-15 截图确认确切名字）
  'sheets:spreadsheet:read', 'sheets:spreadsheet.meta:read', 'contact:user.base:readonly',
  'offline_access',
  // 导出到飞书文档（2026-07-16 截图确认：docx:document / docx:document:create 用户身份已开通）
  'docx:document', 'docx:document:create',
  // 会话/聊天记录检索（2026-07-16 截图确认：search:message / im:message:readonly 用户身份已开通）
  'search:message', 'im:message:readonly',
  // 读取单聊/群消息正文（2026-07-16 截图确认：im:message.p2p_msg:get_as_user 用户身份已开通）
  'im:message.p2p_msg:get_as_user',
  // 列出用户所在的群（分享至会话的选择器用；用户身份已开通，之前 token 没请求过导致 99991679）
  'im:chat:readonly',
  // 「一键以我的名义转发」：官方发消息接口(im/v1/messages)以 user_access_token 发时，鉴权主权限是
  // im:message（获取与发送单聊、群组消息，用户身份），配套 im:message.send_as_user 让发出者显示为本人。
  // 2026-07-17 后台截图确认两者"用户身份·已开通"；im:message 之前没请求导致 99991679 只认 im:message。
  'im:message', 'im:message.send_as_user',
  // 参考资料作者姓名/头像（2026-07-16 用户开通：contact 批量查名要 contact:contact.base:readonly，实测 99991679 点名要它）
  // 注：im:message:send_as_bot 是「应用身份」权限，用 app_access_token 主动发消息，无需放进用户授权 scope（放了会 20027）。
  'contact:contact.base:readonly',
].join(' ');
// 待确认确切名字后再加入（避免写错触发 20027）：老doc / 多维表格 / drive:drive / 群聊消息检索(search:message + im:*)

function buildAuthorizeUrl(state) {
  const u = new URL(FEISHU + '/open-apis/authen/v1/authorize');
  u.searchParams.set('app_id', process.env.FEISHU_APP_ID || '');
  u.searchParams.set('redirect_uri', redirectUri());
  const scope = process.env.FEISHU_SCOPES || DEFAULT_SCOPES;
  if (scope) u.searchParams.set('scope', scope);
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
  if (j.code !== 0) throw new Error(`app_access_token failed: code=${j.code} msg=${j.msg}`);

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
  if (j.code !== 0) throw new Error(`exchange code failed: code=${j.code} msg=${j.msg}`);

  const d = j.data;
  return {
    openId: d.open_id,
    name: d.name,
    avatar: d.avatar_url,
    // 飞书在可用时返回 tenant_key；没有时由组织层使用部署级
    // FEISHU_TENANT_KEY（单租户自建应用）安全兜底。
    tenantKey: d.tenant_key || '',
    tenantName: d.tenant_name || '',
    userAccessToken: d.access_token,
    refreshToken: d.refresh_token,
    expireAt: Date.now() + (d.expires_in || 7200) * 1000,
    grantedScope: d.scope || '',   // 飞书实际授予的 scope，用于排查"开了却没生效"
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
  if (j.code !== 0) throw new Error(`refresh failed: code=${j.code} msg=${j.msg}`);

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
