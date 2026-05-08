# OpenClaw TeamRoom

OpenClaw TeamRoom 是一个面向 OpenClaw 风格 agent 工作区的轻量级多 agent 协作驾驶舱。它不是实施设计助手 Agent 本体，也不是普通群聊，而是放在 Supervisor Agent 和专业子 Agent 之上的协作管控层，用来创建协作室、拉入 agents、提交需求、观察任务拆解、派发、回收和最终审核过程。

这个项目特意保持小而轻，方便部署到公司内网：

- 不要求 Docker
- 不依赖数据库服务
- 不需要 Next.js 运行时
- MVP 阶段没有外部 npm 依赖
- 静态 Web UI 由同一个 Node 进程提供
- OpenClaw adapter 可替换

## 为什么需要它

单个 agent 很容易启动，但实施设计类任务真正困难的地方在于“解题”：理解业务需求、判断影响范围、拆解到维度/模型/表单/权限等专业交付件，再把各专业结果收敛成可交付方案。普通群聊可以让人看到消息，但它不定义谁负责拆题、工作如何派发、状态如何追踪，以及什么时候需要 BA 确认。

TeamRoom 默认将一次实施设计协作建模为：

```text
协作室 + Supervisor + 专业子 Agent + 动态任务流 + 事件流
```

默认策略是 `Supervisor 驱动`：任务先交给总控 Agent，由总控 Agent 输出结构化协作计划；TeamRoom 再按计划调用专业子 Agent，并把结果交回总控 Agent 做最终审核。这样业务拆题权仍在 Supervisor，TeamRoom 负责可视化、管控和留痕。

同一个协作室内的任务共享上下文：TeamRoom 会把该协作室内已完成的历史任务摘要注入后续任务；在 OpenClaw Gateway 模式下，同一协作室同一 agent 也会复用同一个 OpenClaw chat session。

同一协作室同一时间只能有一个当前任务。当前任务未完成、失败或中断时，不能直接发布新任务；可以在任务控制区终止任务，或者在聊天区输入“继续任务”来从未完成阶段续跑。

## 快速开始

环境要求：

- Node.js 22 或更高版本

运行本地 mock 版本：

```bash
npm start
```

打开：

```text
http://127.0.0.1:8787
```

默认 mock adapter 会暴露四个演示 agent：

- supervisor-agent
- frontend-agent
- backend-agent
- reviewer-agent

## 连接你本地的 OpenClaw

如果你本地已经启动了 OpenClaw，并希望 TeamRoom 直接使用 OpenClaw 里现有的 agents，可以用 OpenClaw Gateway adapter 启动。

1. 先进入项目文件夹：

```bash
cd xxx/multi_agent
```

2. 执行下列命令，把端口、OpenClaw 地址和 OpenClaw token 换成你自己的：

```bash
TEAMROOM_PORT=<你自己设置一个4位数的端口用于给当前项目使用> \
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=<你的openclaw地址> \
OPENCLAW_TOKEN='<你的openclaw的token>' \
npm start
```

示例：

```bash
TEAMROOM_PORT=8786 \
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN='替换成你的token' \
npm start
```

启动成功后，打开：

```text
http://127.0.0.1:<你设置的端口>
```

比如你设置的是 `TEAMROOM_PORT=8786`，就打开：

```text
http://127.0.0.1:8786
```

## OpenClaw 集成方式

实现里保留了一个很窄的 adapter 边界：

```text
TeamRoom core
  -> adapter.listAgents()
  -> adapter.runAgent(agentId, input, context)
```

在真实 OpenClaw 部署中，可以在 `src/adapters/openclaw-http.js` 中实现这两个调用，或者从 OpenClaw native plugin 中挂载 TeamRoom core。房间、策略、状态和 UI 代码都不需要改变。

## Agent 标签画像

左侧 Agents 列表支持为 OpenClaw 里已有的 agent 分配本地标签。TeamRoom 不会修改 OpenClaw 里的 agent 本体，只会在 `data/teamroom.json` 里保存本地画像：

```json
{
  "roles": ["supervisor", "leader"],
  "capabilities": ["dimension", "model"]
}
```

这些标签会用于：

- UI 展示 agent 的职责边界
- 拉入协作室时写入成员画像
- Supervisor 派工提示中的成员清单
- 通用策略模式下的能力匹配

常用预设包括：总控、维度/模型、表单、权限、规则、集成、作业流。

## 配置工作台

顶部“配置”按钮会打开独立配置工作台，包含两类配置：

- OpenClaw Agent 文件：查看和修改每个 agent 工作区里的 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`MEMORY.md`。
- TeamRoom 协作模板：按协作室修改 Supervisor 派工、Specialist 执行、Supervisor 复核、前序 agent 输出拼接、历史任务拼接和人工补充消息拼接模板。

默认会从 `~/.openclaw` 下寻找 agent 工作区，例如 `workspace-agent_1`。可以用 `OPENCLAW_WORKSPACE_ROOT` 指向其他 OpenClaw 工作区根目录。修改 agent 文件时，TeamRoom 会把原文件备份到 `data/openclaw-file-backups/`。

## 运行模式

Mock 模式：

```bash
TEAMROOM_ADAPTER=mock npm start
```

通用 HTTP adapter 模式：

```bash
TEAMROOM_ADAPTER=openclaw-http \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
npm start
```

OpenClaw Gateway RPC 模式：

```bash
TEAMROOM_ADAPTER=openclaw-gateway \
OPENCLAW_BASE_URL=http://127.0.0.1:18789 \
OPENCLAW_TOKEN=your-openclaw-token \
npm start
```

当你的 OpenClaw 地址打开的是 OpenClaw Control UI 时，优先使用这个模式。它会连接 Control UI 使用的同一个 WebSocket Gateway RPC，并调用 `agents.list`、`chat.send`、`chat.history` 等方法。

OpenClaw Gateway OpenAI-compatible 模式：

```bash
TEAMROOM_ADAPTER=openclaw-responses \
OPENCLAW_BASE_URL=http://127.0.0.1:3000 \
npm start
```

这个模式会从 `/v1/models` 发现现有 OpenClaw agents，然后通过 `/v1/responses` 调用选中的 agent，使用的 model 名称是 `openclaw/<agentId>`。

常用环境变量：

```text
TEAMROOM_HOST=127.0.0.1
TEAMROOM_PORT=8787
TEAMROOM_DATA_FILE=./data/teamroom.json
TEAMROOM_TOKEN=optional-shared-token
TEAMROOM_ADAPTER=mock | openclaw-gateway | openclaw-http | openclaw-responses
OPENCLAW_BASE_URL=http://127.0.0.1:3000
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_DEVICE_FILE=./data/openclaw-device.json
OPENCLAW_WORKSPACE_ROOT=~/.openclaw
OPENCLAW_AGENT_FILE_BACKUP_DIR=./data/openclaw-file-backups
OPENCLAW_AGENTS_PATH=/api/agents
OPENCLAW_RUN_PATH=/api/agents/:agentId/runs
OPENCLAW_MODELS_PATH=/v1/models
OPENCLAW_RESPONSES_PATH=/v1/responses
OPENCLAW_TOKEN=optional-openclaw-token
OPENCLAW_PASSWORD=optional-openclaw-password
```

如果设置了 `TEAMROOM_TOKEN`，API 请求必须发送：

```text
Authorization: Bearer <token>
```

## API

```text
GET    /health
GET    /api/agents
PUT    /api/agents/:agentId/profile
DELETE /api/agents/:agentId/profile
GET    /api/rooms
POST   /api/rooms
GET    /api/rooms/:roomId
DELETE /api/rooms/:roomId
POST   /api/rooms/:roomId/members
DELETE /api/rooms/:roomId/members/:agentId
POST   /api/rooms/:roomId/messages
POST   /api/rooms/:roomId/tasks
POST   /api/rooms/:roomId/tasks/:taskId/cancel
GET    /api/rooms/:roomId/events
GET    /api/config/prompt-templates
GET    /api/openclaw/agents/:agentId/files
PUT    /api/openclaw/agents/:agentId/files/:fileName
```

任务示例：

```bash
curl -X POST http://127.0.0.1:8787/api/rooms/<roomId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"goal":"构建一个轻量的可视化多 agent 协作面板"}'
```

## 文档

- [架构设计](docs/architecture.md)
- [策略设计](docs/policy-design.md)
- [连接 OpenClaw](docs/connect-openclaw.md)
- [Chatbot 对比](docs/chatbot-comparison.md)
- [示例配置](examples/teamroom.yaml)

## 项目结构

```text
public/                 静态 UI
src/
  adapters/             OpenClaw 和 mock adapters
  plugin/               Native plugin 挂载草案
  config.js             运行时配置
  events.js             进程内 SSE hub
  orchestrator.js       任务图执行
  policy.js             Agent 选择策略
  server.js             HTTP API 和静态服务
  store.js              JSON 状态存储
docs/                   设计文档
examples/               示例房间策略
data/                   本地状态
```

## 设计原则

保持协作模型的可复用性，同时不抢专业总控 Agent 的决策权：

```text
TeamRoom 管过程和可视化。
Supervisor 管业务拆题和最终审核。
专业子 Agent 管各自交付件领域。
```

因此 TeamRoom 可以作为公司内部复用和分享的多 agent 协作模式：业务领域可以换，核心经验仍然是“总控拆题、专业执行、过程可观测、人做关键确认”。
