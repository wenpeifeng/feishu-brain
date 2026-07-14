# 飞书知识问答复刻 — 设计文档

日期：2026-07-14
状态：待用户评审

## 1. 目标

一比一复刻飞书「知识问答」：用户用**自己的飞书账号 OAuth 登录**，按**各自权限**搜索飞书内所有有权限的文档，读原文后用 LLM 流式总结，展示回答 + 「为你找到 N 篇参考资料」。支持联网搜索、上传补充文档、对话历史（按用户隔离）。

核心原则：**用户尽量少配置**——飞书只需登录一次（OAuth），模型只需下拉选一个内置厂商。

## 2. 现状与要修的 Bug

现有代码是「单用户 + lark-cli spawn」架构，有 3 个 bug：

1. **HOME 覆盖 bug**（`server/lark.js`）：填了 appId 就把 `HOME` 指向项目内空目录 `data/lark-cli-home`（无 user 登录）→ `need_user_authorization`。
2. **`askLLMGeneral` 未定义**：`rag.js` 引用了它，但 `llm.js` 没导出 → 联网搜索必崩。
3. **缺搜索 scope**：`drive +search` 需要 `search:docs:read`，当前 token 没有。

这些在新架构里一并解决（lark-cli 单用户路径改为多用户直连 HTTP）。

## 3. 架构：多用户飞书 OAuth

```
浏览器访问 → 检查 localStorage 里的 sessionToken
  ├─ 无 → 登录页「使用飞书登录」
  │      → GET /api/auth/feishu/login-url → 后端拼 authorize URL
  │      → 跳 open.feishu.cn/open-apis/authen/v1/authorize?app_id&redirect_uri&state
  │      → 用户授权 → 飞书带 code 回调 /api/auth/feishu/callback
  │      → 后端: app_access_token → 用 code 换 user_access_token(+refresh_token)
  │              → 拉 user_info → 建会话 → 302 跳回前端 /?token=xxx&state=原路径
  │      → 前端存 token 到 localStorage，清 URL，进问答页
  └─ 有 → 每个 API 请求带 Authorization: Bearer <sessionToken>
         后端用「该会话对应用户的 user_access_token」直连飞书 OpenAPI 搜索/读文档
         → 天然按该用户权限过滤（越权/私密文档搜不到）✅
```

关键点：**放弃 lark-cli 的单一身份**。每个用户的 `user_access_token` 才能实现按各自权限访问。飞书 API 全部改为后端直连 HTTP（Node 原生 fetch），带 token 自动 refresh。

参考实现：`/Users/wenpeifeng/工作/workspace/auss/lumin-data-tap`（Java 版同款 OAuth 流程，已验证生产可用）。

## 4. 分阶段交付

飞书 app 已定：复用现有「知识库专用cli」`cli_aa832b91a7f8dbdf`（原「暂未使用」app，已改名，已开通大量用户身份 scope，凭证已实测有效并写入 `.env`）。因控制台仍需补 `search:docs:read` + 重定向 URL + 发版，采用分阶段，保证「今天可测完整闭环」：

### v1（本轮，立即可测）
- 修 3 个 bug。
- **登录页 UI**（复刻飞书/lumin 风格「使用飞书登录」）+ 路由拦截（未登录跳登录，登录后跳回）。
- **OAuth 后端全套**（login-url / callback / me / logout / refresh），app_id/secret 走配置。
- **Dev-stub 登录**：未配置专用 app 时，「使用飞书登录」直接以 `文培凤`（当前 lark-cli 已登录账号）建会话，让整套会话/路由/按用户隔离架构**现在就能跑**。
- **搜索→读文档→LLM 流式总结→参考资料渲染** 完整闭环。v1 的搜索后端用 lark-cli（`文培凤` 身份），需一次性 `lark-cli auth login --scope search:docs:read`。
- **模型厂商下拉**（内置 Kimi/通义/Agnes，key 服务端内置，前端只见 `***`）。
- **联网搜索开关**（Kimi 自带联网 + 飞书文档并路，失败降级）。
- **删除 mock 对话**，对话历史按用户 `open_id` 隔离。
- **SSE 流式**。

### v2（专用 app 就绪后切换）
- 填入新 app 的 app_id/app_secret + 配好 redirect URL/scope → 关闭 dev-stub，真·多用户 OAuth 生效。
- 搜索/读文档后端从 lark-cli 切到「每用户 user_access_token 直连 HTTP」。
- 上传文档到飞书云空间（`drive:file:upload`）。
- 分享 / 复制 / 点赞点踩反馈。

> v1 与 v2 的下游（LLM 总结、流式、参考资料渲染、前端）完全共用；只有「搜索/读文档的身份来源」和「登录是否真 OAuth」两处切换。

## 5. 后端模块设计

```
server/
  index.js        HTTP 入口（不变，补静态路由）
  router.js       路由分发（新增 auth 路由 + SSE ask）
  auth.js         [新] 飞书 OAuth：拼 authorize URL、code 换 token、refresh、user_info
  session.js      [新] 会话存储（data/sessions.json 持久化）：token → {openId,name,avatar,userAccessToken,refreshToken,expireAt}
  feishu.js       [新] 飞书 OpenAPI 直连：searchDocs(token,q)、fetchDoc(token,tokenOrUrl)、uploadFile(...)（v2）
  lark.js         [保留/降级] 仅 dev-stub 搜索用 lark-cli；v2 移除
  providers.js    [新] 内置模型厂商目录（含 key，服务端）
  llm.js          总结：askLLM（RAG 流式）、askLLMGeneral（联网，修复导出）
  rag.js          编排：搜索→读 TopK→流式总结→事件
  store.js        配置 + 按用户对话历史（conversations 加 ownerOpenId）
  mock.js         删除或仅测试用
  env.js          不变
```

### 会话与身份中间件
- 每个 `/api/*`（除 auth 与静态）经 `requireAuth`：取 `Authorization: Bearer`，查 session，无效返回 401。
- session 持久化到 `data/sessions.json`，重启不掉线。
- user_access_token 过期时用 refresh_token 静默刷新（`/open-apis/authen/v1/refresh_access_token`）；refresh 也失效则 401 引导重新登录。

## 6. 飞书 OpenAPI 端点

| 用途 | 方法 | 端点 | scope |
|---|---|---|---|
| app_access_token | POST | `/open-apis/auth/v3/app_access_token/internal` | — |
| code 换 user_token | POST | `/open-apis/authen/v1/access_token` | — |
| 刷新 user_token | POST | `/open-apis/authen/v1/refresh_access_token` | — |
| 用户信息 | GET | `/open-apis/authen/v1/user_info` | — |
| 搜索云文档 | POST | 云文档搜索接口（`search:docs:read`）※实现时用 lark-openapi-explorer 确认精确 path/参数 | search:docs:read |
| 读文档内容 | GET | docx/wiki 读取（markdown/raw） | docs:document.content:read / wiki:node:read |
| 上传文件(v2) | POST | 云空间上传 | drive:file:upload |

authorize URL：`https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=<id>&redirect_uri=<encoded>&state=<原路径>`（scope 由 app 控制台配置决定；若用 v2 authorize 可显式带 scope）。

## 7. 内置模型厂商目录（providers.js，key 服务端）

| id | 名称 | model | baseURL | 备注 |
|---|---|---|---|---|
| qwen | 通义千问(百炼) | qwen-plus | https://dashscope.aliyuncs.com/compatible-mode/v1 | 默认，对话最干净 |
| kimi | Kimi(Moonshot) | kimi-for-coding | https://api.kimi.com/coding/v1 | 推理模型，需给足 max_tokens |
| agnes | Agnes | agnes-2.0-flash | https://apihub.agnes-ai.com/v1 | 备选 |
| custom | 自定义 | 用户填 | 用户填 | 手填 key/base/model |

- key 来自 cc-switch，内置在服务端，均已实测可用 OpenAI `/chat/completions`。
- 前端 `/api/config` 只返回厂商列表 + 当前选择，**不返回明文 key**（显示 `***`）。
- 切换厂商 = 一个下拉，model/base/key 自动带出。

## 8. 联网搜索

`webSearch=true`：并行 ①飞书文档搜索 ②Kimi 联网（Moonshot `web_search` 工具）；两路结果合并进上下文总结。Kimi 端点不支持工具时降级为「仅飞书 + 提示」，不崩。`webSearch=false`：仅飞书文档。

## 9. SSE 流式协议

`POST /api/conversations/:id/ask`（`Accept: text/event-stream`）：
```
event: references  data: {references:[...]}     # 立即推参考资料
event: token        data: {delta:"..."}          # 逐字
event: done         data: {sources:[...], messageId}
event: error        data: {error, hint}
```
前端用 fetch ReadableStream 解析，打字机渲染。非流式（测试/降级）仍返回整包 JSON。

## 10. 参考资料渲染（复刻飞书）

「为你找到 N 篇参考资料」：序号 + 文档类型图标（docx/sheet/pdf/mindnote…）+ 标题（点击开原文）+ 作者头像/名 + 修改日期。底部「AI 基于你有权限的资料生成，数据保密仅你可见」。

## 11. 数据模型

```
data/sessions.json     : { token: {openId,name,avatar,userAccessToken,refreshToken,expireAt,scope} }
data/conversations.json: [ {id, ownerOpenId, title, createdAt, updatedAt, messages:[...]} ]  # 加 ownerOpenId
data/config.json       : { providerId, custom{...}, topK, pageSize, feishuAppId, feishuAppSecret, ... }
```
现有 mock 对话清空。对话按 `ownerOpenId` 过滤，各人只见自己的。

## 12. 错误处理
- 未登录/会话失效 → 401 → 前端跳登录页。
- 搜索缺 scope → 明确提示「需在飞书应用开通 search:docs:read」。
- LLM key 失效 → 提示切换厂商。
- 飞书 token 过期 → 自动 refresh，失败才 401。

## 13. 测试计划（每功能验证）
- `test/api.test.js` 扩充：session 增删查、providers 目录、rag 编排（mock 飞书/LLM）、SSE 事件序列。不依赖网络端口。
- 手动端到端：dev-stub 登录 → 问「澳洲节点迁移事项」→ 验证 搜索→读文档→流式→参考资料 全链路。
- LLM 厂商切换：下拉切 Kimi/通义/Agnes 各问一次。
- 联网开关 on/off 各验证。

## 14. 飞书开放平台配置指南（app = 知识库专用cli / cli_aa832b91a7f8dbdf）
应用已存在且已开通大量用户身份 scope，凭证已写入 `.env`。剩余控制台操作：
1. 权限管理（https://open.feishu.cn/app/cli_aa832b91a7f8dbdf/auth）→ 确认/补开：`search:docs:read`（核心）、`docs:document.content:read`、`docx:document:readonly`、`wiki:node:read`、`drive:drive.metadata:readonly`、`drive:file:download`、`drive:file:upload`（v2）、`contact:user.base:readonly`、`offline_access`。
2. 安全设置（https://open.feishu.cn/app/cli_aa832b91a7f8dbdf/safe）→ 重定向 URL 加 `http://localhost:3000/api/auth/feishu/callback`。
3. 版本管理与发布（https://open.feishu.cn/app/cli_aa832b91a7f8dbdf/version）→ 创建版本并发布（改权限后必须发版才生效）。
4. 发布生效后把 `.env` 里 `DEV_STUB_LOGIN=false` → 多用户 OAuth 正式生效。

## 15. 开放问题 / 已知待确认
- 云文档搜索精确端点与分页参数：实现时用 `lark-openapi-explorer` 确认。
- Kimi coding 端点是否支持 `web_search` 工具：实现时实测，不支持则降级。
- 上传（v2）目标文件夹与导入为在线文档的策略：v2 细化。
