# 飞书知识库问答 (Feishu KB QA)

基于飞书知识库的 RAG 问答服务。通过 **lark-cli** 搜索并读取飞书文档，再调用**第三方 LLM** 进行总结回答。

## 核心流程

1. 用户在 Web 界面输入问题
2. 后端使用 `lark-cli drive +search` 搜索飞书知识库/云文档
3. 使用 `lark-cli docs +fetch` 读取 TopK 文档原文
4. 将文档内容作为上下文，调用 OpenAI 兼容的 LLM 生成总结回答
5. 前端展示：回答 + 参考资料 + 来源文档

## 特点

- **无需 npm install**，纯 Node.js 实现
- 支持自定义 **lark-cli 路径**和身份（`user`/`bot`）
- 支持自定义**第三方 LLM**（OpenAI 兼容，如 OpenAI、Moonshot 等）
- 对话历史本地 JSON 文件存储
- 提供 Docker 部署支持

## 快速开始

### 环境要求

- Node.js >= 18
- 已安装并配置好 [lark-cli](https://www.npmjs.com/package/lark-cli)

### 1. 配置

复制示例配置文件并编辑：

```bash
cp .env.example .env
```

关键配置项：

```bash
# lark-cli 路径（如果已加入 PATH，可不填）
LARK_CLI_PATH=/Users/you/.npm-global/bin/lark-cli

# 飞书身份：user 可访问个人文档；bot 用于应用级资源
LARK_IDENTITY=user

 # 飞书应用凭证（可选；也可在页面设置里填写，会写入项目独立目录，避免影响全局 lark-cli 配置）
 FEISHU_APP_ID=cli_...
 FEISHU_APP_SECRET=...

 # LLM 配置（支持 OpenAI / Moonshot / 其他兼容 OpenAI API 的模型）
 OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

### 2. 启动

```bash
npm start
# 或
node server/index.js
```

访问 http://localhost:3000

### 使用 Mock 模式测试

Mock 模式下不调用飞书 API，直接返回示例数据，适合验证前端：

```bash
npm run mock
```

## 配置中心

在 Web 界面点击左下角**设置**，可以实时配置：

 - lark-cli 路径
 - 飞书身份（user/bot）
 - 飞书 App ID / App Secret
 - LLM 提供商（openai / moonshot / custom）
 - LLM API Key
 - LLM Base URL
 - 模型名称
 - 搜索数量（pageSize）
 - 参与总结文档数（topK）

 配置保存在 `data/config.json`，会覆盖 `.env` 中的默认值。

 ### 凭证隔离说明

 在页面设置里填写的飞书 App ID / App Secret 会写入项目本地目录 `data/lark-cli-home`，服务运行 lark-cli 时以该目录为 `HOME`，不会覆盖你全局的 lark-cli 配置。适合多人共用服务器或需要区分个人/工作账号的场景。

## Docker 部署

```bash
docker-compose up -d
```

或手动构建：

```bash
docker build -t feishu-kb-qa .
docker run -d -p 3000:3000 -v $(pwd)/data:/app/data feishu-kb-qa
```

## 目录结构

```
feishu-kb-qa/
├── server/           # 后端
│   ├── index.js      # HTTP 服务入口
│   ├── router.js     # API 路由
│   ├── rag.js        # RAG 流程编排
│   ├── lark.js       # lark-cli 封装
│   ├── llm.js        # LLM 客户端
│   ├── store.js      # 配置与对话历史存储
│   ├── mock.js       # 示例数据
│   └── env.js        # 环境变量加载
├── public/           # 前端
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/             # 运行数据（自动创建）
│   ├── config.json
│   └── conversations.json
├── test/             # 测试
│   └── api.test.js
├── Dockerfile
├── docker-compose.yml
├── .env
├── .env.example
└── README.md
```

## 测试

```bash
npm test
```

该测试不依赖网络端口，可直接在 sandbox/CI 中运行。

## 注意事项

- **lark-cli 不是飞书机器人**，它是飞书 OpenAPI 的命令行封装。本服务通过调用 lark-cli 完成搜索和读文档，总结由外部 LLM 完成。
- **个人文档权限**：需要使用 `user` 身份，并确保 lark-cli 已完成 `auth login` 授权。
- **公共/应用资源**：可以使用 `bot` 身份，但需在飞书开发者后台开通相应 scope。
- **macOS Keychain**：在 Terminal 中运行通常可正常访问 Keychain。在某些 sandbox/CI 环境中可能遇到 Keychain 不可访问的问题，可在 Terminal 中执行 `lark-cli config keychain-downgrade` 将凭证降级到本地文件，或设置 `LARK_CLI_PATH` 指向使用文件凭证的 lark-cli。
- **无 LLM Key 时**：服务会返回文档内容摘要，不会生成模型总结。
