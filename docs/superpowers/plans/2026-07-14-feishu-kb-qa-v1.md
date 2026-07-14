# 飞书知识问答复刻 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 多用户飞书 OAuth 登录，按各自权限搜索飞书文档 → 读原文 → LLM 流式总结，展示回答+参考资料，对话按用户隔离。

**Architecture:** Node 原生 HTTP，无第三方依赖。前端登录页→飞书 OAuth→回调建会话→每请求带 Bearer token→后端用该用户 user_access_token 直连飞书 OpenAPI 搜索/读文档→OpenAI 兼容 LLM 流式总结（SSE）。

**Tech Stack:** Node >=18 (原生 fetch/http), 无 npm 依赖, 前端原生 JS + SSE。

## Global Constraints

- 飞书 app：`cli_aa832b91a7f8dbdf`（已发布，含 `search:docs:read`）；凭证在 `.env`。
- **越权安全（硬约束）**：搜索/读文档只用当前用户 `userAccessToken`；`app_access_token` 仅用于 OAuth 换 token；对话读写删强制校验 `ownerOpenId === req.user.openId`（否则 403）；密钥不下发前端。
- 无第三方 npm 依赖；纯 Node.js。
- LLM key 内置服务端（`server/providers.js`），前端只见 `***`。
- 回调地址：`http://localhost:3000/api/auth/feishu/callback`。
- 测试不依赖网络端口（`test/api.test.js`），飞书/LLM 用注入 mock。

---

## 文件结构

```
server/
  providers.js  [新] 内置 LLM 厂商目录（含 key）+ resolveProvider(config)
  session.js    [新] 文件持久会话：create/get/remove/updateTokens
  auth.js       [新] OAuth：buildAuthorizeUrl/exchangeCode/refresh/getUserInfo/appToken/verifyState
  feishu.js     [新] 直连 OpenAPI：searchDocs(userToken,q,pageSize)/fetchDoc(userToken,item)
  llm.js        [改] askLLMStream(生成器)/askLLMGeneral；providers 集成
  rag.js        [改] runRAGStream(user, question, history, webSearch) → async generator
  router.js     [改] auth 路由 + requireAuth + SSE ask + providers 到 /api/config
  store.js      [改] conversation 加 ownerOpenId；按 owner 过滤+校验
  lark.js       [删] 移除（不再用 lark-cli）
  mock.js       [删] 移除
public/
  login.html    [新] 飞书登录页
  index.html    [改] 顶部用户信息、provider 下拉、参考资料区、SSE
  app.js        [改] token/路由守卫/SSE 渲染/provider 切换
  style.css     [改] 登录页 + 参考资料样式
```

---

### Task 1: 内置 LLM 厂商目录

**Files:** Create `server/providers.js`; Test `test/providers.test.js`

**Interfaces:**
- Produces: `PROVIDERS` (array of `{id,name,model,baseUrl}`), `resolveProvider(config)` → `{id,name,model,baseUrl,apiKey}`，`publicProviders()` → 不含 key 的列表。

- [ ] **Step 1: 写失败测试**
```js
const { PROVIDERS, resolveProvider, publicProviders } = require('../server/providers');
const assert = require('assert');
// 内置至少 qwen/kimi/agnes
assert.ok(PROVIDERS.find(p => p.id === 'qwen'));
// resolveProvider 带出 key
const r = resolveProvider({ providerId: 'qwen' });
assert.equal(r.model, 'qwen-plus');
assert.ok(r.apiKey && r.apiKey.startsWith('sk-'));
// custom 用用户填的
const c = resolveProvider({ providerId: 'custom', custom: { apiKey: 'sk-x', baseUrl: 'http://x/v1', model: 'm' } });
assert.equal(c.apiKey, 'sk-x');
// publicProviders 不含明文 key
assert.ok(publicProviders().every(p => !p.apiKey));
console.log('providers ok');
```
- [ ] **Step 2: 运行验证失败** `node test/providers.test.js` → Cannot find module
- [ ] **Step 3: 实现**（key 从 env 读，明文只存 gitignored 的 `.env`；已实测可用）
```js
const PROVIDERS = [
  { id: 'qwen',  name: '通义千问(百炼)', model: 'qwen-plus',        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.QWEN_API_KEY || '' },
  { id: 'kimi',  name: 'Kimi(Moonshot)', model: 'kimi-for-coding', baseUrl: 'https://api.kimi.com/coding/v1',                    apiKey: process.env.KIMI_API_KEY || '' },
  { id: 'agnes', name: 'Agnes',          model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',                   apiKey: process.env.AGNES_API_KEY || '' },
];
function resolveProvider(config = {}) {
  const id = config.providerId || process.env.LLM_PROVIDER_ID || 'qwen';
  if (id === 'custom') {
    const c = config.custom || {};
    return { id: 'custom', name: '自定义', model: c.model || '', baseUrl: c.baseUrl || '', apiKey: c.apiKey || '' };
  }
  const p = PROVIDERS.find(x => x.id === id) || PROVIDERS[0];
  return { ...p };
}
function publicProviders() { return PROVIDERS.map(({ apiKey, ...rest }) => rest); }
module.exports = { PROVIDERS, resolveProvider, publicProviders };
```
- [ ] **Step 4: 运行通过** `node test/providers.test.js` → providers ok
- [ ] **Step 5: 提交** `git add server/providers.js test/providers.test.js && git commit -m "feat: 内置LLM厂商目录"`

---

### Task 2: 文件持久会话

**Files:** Create `server/session.js`; Test `test/session.test.js`

**Interfaces:**
- Produces: `createSession(user)`→token(hex32)；`getSession(token)`→ctx|null；`updateTokens(token,{userAccessToken,refreshToken,expireAt})`；`removeSession(token)`。ctx = `{token, openId, name, avatar, userAccessToken, refreshToken, expireAt}`。持久化 `data/sessions.json`。

- [ ] **Step 1: 写失败测试**
```js
const s = require('../server/session');
const assert = require('assert');
const t = s.createSession({ openId: 'ou_1', name: 'A', userAccessToken: 'u1', refreshToken: 'r1', expireAt: 1 });
assert.equal(t.length, 32);
assert.equal(s.getSession(t).openId, 'ou_1');
s.updateTokens(t, { userAccessToken: 'u2', refreshToken: 'r2', expireAt: 2 });
assert.equal(s.getSession(t).userAccessToken, 'u2');
s.removeSession(t);
assert.equal(s.getSession(t), null);
console.log('session ok');
```
- [ ] **Step 2: 失败** `node test/session.test.js`
- [ ] **Step 3: 实现** — `crypto.randomBytes(16).toString('hex')` 生成 token；内存 Map + 同步写 `data/sessions.json`；启动时载入。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: 文件持久会话"`

---

### Task 3: 飞书 OAuth 服务

**Files:** Create `server/auth.js`; Test `test/auth.test.js`

**Interfaces:**
- Produces:
  - `buildAuthorizeUrl(state)` → string（`open.feishu.cn/open-apis/authen/v1/authorize?app_id&redirect_uri&state`）
  - `signState(payload)`/`verifyState(state)` → payload|null（HMAC，防 CSRF）
  - `async getAppAccessToken()` → token（60s 提前刷新缓存）
  - `async exchangeCode(code)` → `{openId,name,avatar,userAccessToken,refreshToken,expireAt}`
  - `async refreshUserToken(refreshToken)` → `{userAccessToken,refreshToken,expireAt}`
- Consumes: env `FEISHU_APP_ID/SECRET`, `APP_BASE_URL`, `FEISHU_REDIRECT_PATH`。

- [ ] **Step 1: 写失败测试**（纯函数部分，不打网络）
```js
const a = require('../server/auth');
const assert = require('assert');
process.env.FEISHU_APP_ID = 'cli_test'; process.env.APP_BASE_URL='http://localhost:3000';
const st = a.signState({ redirect: '/x' });
assert.deepEqual(a.verifyState(st).redirect, '/x');
assert.equal(a.verifyState('tampered.sig'), null);
const url = a.buildAuthorizeUrl(st);
assert.ok(url.includes('app_id=cli_test'));
assert.ok(url.includes('redirect_uri=') && url.includes('authen%2Fv1%2Fauthorize') === false);
console.log('auth ok');
```
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现**（关键：token 交换端点）
```js
const crypto = require('crypto');
const FEISHU = 'https://open.feishu.cn';
function redirectUri() { return (process.env.APP_BASE_URL||'http://localhost:3000') + (process.env.FEISHU_REDIRECT_PATH||'/api/auth/feishu/callback'); }
function secretKey() { return process.env.FEISHU_APP_SECRET || 'dev'; }
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyState(state) {
  if (!state || !state.includes('.')) return null;
  const [body, sig] = state.split('.');
  const expect = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}
function buildAuthorizeUrl(state) {
  const u = new URL(FEISHU + '/open-apis/authen/v1/authorize');
  u.searchParams.set('app_id', process.env.FEISHU_APP_ID || '');
  u.searchParams.set('redirect_uri', redirectUri());
  if (state) u.searchParams.set('state', state);
  return u.toString();
}
let _appTok = null, _appExp = 0;
async function getAppAccessToken() {
  if (_appTok && Date.now() < _appExp - 60000) return _appTok;
  const r = await fetch(FEISHU + '/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('app_access_token failed: ' + JSON.stringify(j));
  _appTok = j.app_access_token; _appExp = Date.now() + (j.expire || 7200) * 1000;
  return _appTok;
}
async function exchangeCode(code) {
  const appTok = await getAppAccessToken();
  const r = await fetch(FEISHU + '/open-apis/authen/v1/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appTok },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('exchange code failed: ' + JSON.stringify(j));
  const d = j.data;
  return { openId: d.open_id, name: d.name, avatar: d.avatar_url,
    userAccessToken: d.access_token, refreshToken: d.refresh_token,
    expireAt: Date.now() + (d.expires_in || 7200) * 1000 };
}
async function refreshUserToken(refreshToken) {
  const appTok = await getAppAccessToken();
  const r = await fetch(FEISHU + '/open-apis/authen/v1/refresh_access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appTok },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('refresh failed: ' + JSON.stringify(j));
  const d = j.data;
  return { userAccessToken: d.access_token, refreshToken: d.refresh_token, expireAt: Date.now() + (d.expires_in||7200)*1000 };
}
module.exports = { buildAuthorizeUrl, signState, verifyState, getAppAccessToken, exchangeCode, refreshUserToken, redirectUri };
```
> ⚠️ 执行时用 `lark-openapi-explorer` 复核 `authen/v1/access_token` 响应字段名（open_id/access_token/refresh_token/expires_in）。若飞书已迁 v2 (`authen/v2/oauth/token`)，按实测调整。
- [ ] **Step 4: 通过** `node test/auth.test.js`
- [ ] **Step 5: 提交** `git commit -m "feat: 飞书OAuth服务"`

---

### Task 4: 飞书文档搜索/读取（直连，按用户权限）

**Files:** Create `server/feishu.js`; Test `test/feishu.test.js`

**Interfaces:**
- Produces: `async searchDocs(userAccessToken, query, pageSize=9)` → `[{title,type,token,url,owner,editTime}]`；`async fetchDoc(userAccessToken, item)` → `{title, content}`。
- **安全**：两函数只接受 userAccessToken；绝不用 app/tenant token。

- [ ] **Step 1: 写测试**（用 fetch 注入 mock 验证：带对的 Authorization 头 + 解析）
```js
// 通过 global.fetch 打桩，断言 Authorization: Bearer <userToken> 且解析 items
```
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现** — 搜索云文档端点（执行时用 lark-openapi-explorer 确认精确 path，`search:docs:read` 对应 `POST /open-apis/suite/docs-api/search/object` 或新 `drive/v1` 搜索），fetchDoc 用 docx raw/markdown 或 wiki 读取；头 `Authorization: Bearer ${userAccessToken}`。解析成统一结构。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: 飞书文档搜索/读取直连"`

---

### Task 5: LLM 流式 + 通用联网

**Files:** Modify `server/llm.js`; Test `test/llm.test.js`

**Interfaces:**
- Produces: `async *askLLMStream(question, docs, history, provider)` → yield delta 字符串；`async *askLLMGeneral(question, history, provider, webSearch)` → yield delta。
- Consumes: provider from Task 1。

- [ ] **Step 1: 测试** — mock fetch 返回 SSE 分块，断言 askLLMStream 逐块 yield 出 content delta；无 key 时抛清晰错误。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现** — 调 `${baseUrl}/chat/completions` 带 `stream:true`，读取 ReadableStream 解析 `data:` 行的 `choices[0].delta.content`（忽略 reasoning_content）；`max_tokens` 给足（如 4096，兼容 kimi 推理）；askLLMGeneral 联网时加 Moonshot `tools:[{type:'web_search'}]`（失败 try/catch 降级为普通 chat）。修复原 `askLLMGeneral` 未导出。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: LLM流式+联网, 修复askLLMGeneral"`

---

### Task 6: RAG 编排（流式，按用户）

**Files:** Modify `server/rag.js`; Test `test/rag.test.js`

**Interfaces:**
- Produces: `async *runRAGStream(user, question, history, webSearch, config)` yields events `{type:'references',references}` / `{type:'token',delta}` / `{type:'sources',sources}`。
- Consumes: `feishu.searchDocs(user.userAccessToken,...)`, `feishu.fetchDoc`, `llm.askLLMStream/askLLMGeneral`, `providers.resolveProvider`。

- [ ] **Step 1: 测试** — 注入 mock feishu+llm，断言事件顺序：先 references，再多个 token，最后 sources；webSearch=true 走 general 分支。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现** — webSearch=false：searchDocs→取 topK fetchDoc→yield references（立即）→askLLMStream 逐 token→yield sources。webSearch=true：并行 searchDocs + askLLMGeneral(web)，先 references 再 token。**只用 user.userAccessToken**。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: RAG流式编排"`

---

### Task 7: 会话隔离的对话存储

**Files:** Modify `server/store.js`; Test `test/store.test.js`

**Interfaces:**
- Produces: `createConversation(ownerOpenId,title)`；`getConversationsFor(ownerOpenId)`；`getConversationOwned(id,ownerOpenId)`→conv|null（不属于返回 null）；`deleteConversationOwned(id,ownerOpenId)`；`addMessage(id,ownerOpenId,msg)`。
- 清空现有 mock 对话。

- [ ] **Step 1: 测试** — A 建对话，B `getConversationOwned(idOfA,'ou_B')` 返回 null；`getConversationsFor('ou_A')` 只含 A 的。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现** — conversation 加 `ownerOpenId`；所有读写按 owner 过滤/校验；migration：启动清空旧无 owner 数据。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: 对话按用户隔离"`

---

### Task 8: 路由（auth + requireAuth + SSE ask + config）

**Files:** Modify `server/router.js`; Test `test/router.test.js`

**Interfaces:**
- Routes: `GET /api/auth/feishu/login-url?redirect=` → `{url}`；`GET /api/auth/feishu/callback?code&state` → 302 到 `/?token=..&state=..`；`GET /api/auth/me` → 用户信息；`POST /api/auth/logout`；`GET/POST /api/config`（providers 列表，不含 key）；conversations CRUD（requireAuth+owner）；`POST /api/conversations/:id/ask`（SSE）。
- `requireAuth(req)`：取 Bearer→getSession→过期则 refresh→失败 401。

- [ ] **Step 1: 测试** — 无 token 调 /api/conversations 返回 401；me 返回当前用户；ask 走 SSE 输出 references/token/done 事件（注入 mock rag）。
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现** — SSE：`res.writeHead(200,{'Content-Type':'text/event-stream',...})`；for await runRAGStream → `res.write('event: X\ndata: '+JSON.stringify+'\n\n')`；结束存 assistant message（带 references/sources）→ `event: done`。callback：verifyState→exchangeCode→createSession→302。
- [ ] **Step 4: 通过**
- [ ] **Step 5: 提交** `git commit -m "feat: auth+SSE路由与鉴权"`

---

### Task 9: 前端（登录页 + 守卫 + 流式渲染 + provider 下拉）

**Files:** Create `public/login.html`；Modify `public/index.html`, `public/app.js`, `public/style.css`

- [ ] **Step 1:** 登录页 `login.html`：「使用飞书登录」按钮 → `GET /api/auth/feishu/login-url?redirect=` → `location.href=url`。飞书风格卡片。
- [ ] **Step 2:** `app.js` 启动守卫：URL 有 `?token=` 则存 localStorage 并清 URL；无 token 且非登录页 → 跳 `login.html`；调 `/api/auth/me` 渲染顶部用户（头像/名）+ 登出。所有 fetch 带 `Authorization: Bearer`。401 → 清 token 跳登录。
- [ ] **Step 3:** provider 下拉：`/api/config` 取 publicProviders → 下拉；切换 POST 保存 providerId；custom 显示手填框。
- [ ] **Step 4:** SSE 渲染：fetch ask（stream），ReadableStream 解析事件；references 立即渲染「为你找到 N 篇参考资料」（图标+标题链接+作者+日期）；token 打字机追加；done 收尾 + 底部「AI 基于你有权限的资料生成，数据保密仅你可见」。
- [ ] **Step 5:** 删除左侧 mock 对话残留、联网搜索开关联动 webSearch。提交 `git commit -m "feat: 前端登录/流式/参考资料/provider下拉"`

---

### Task 10: 端到端验证

- [ ] **Step 1:** `node test/*.test.js` 全绿。
- [ ] **Step 2:** 起服务 `node server/index.js`，浏览器开 localhost:3000 → 跳登录 → 使用飞书登录 → 授权 → 回到问答页，顶部显示「文培凤」。
- [ ] **Step 3:** 问「澳洲节点迁移事项」→ 验证 参考资料出现→流式回答→来源。截图/记录。
- [ ] **Step 4:** 切 provider（qwen/kimi/agnes）各问一次；联网开关 on/off 各一次。
- [ ] **Step 5:** 越权验证：构造第二身份（或直接单测）确认拿不到他人对话（403/null）。

---

## Self-Review 备注
- 覆盖 spec：OAuth✅ 安全隔离✅ providers✅ SSE✅ 参考资料✅ 联网✅ 对话隔离✅ 测试✅。上传/分享/反馈属 v2，不在本计划。
- 执行时须用 `lark-openapi-explorer` 敲定：①`authen/v1` vs `v2` token 端点字段 ②云文档搜索精确 path/参数 ③文档读取端点（docx/wiki/sheet 分流）。这些是唯一"待实测确认"，其余代码确定。
