# TeamRoom V2

TeamRoom V2 是一个面向 Agent 协作的轻量中转界面。它不再内置 V1 的强制派工、强制总控审核和 prompt 模板工作台，而是把用户消息、确认点、权限请求、运行进展和文件变化整理成一个可观察的人机协作空间。

当前清理后的主线以 OpenCode 接入为主，保留 Mock 后端用于本地演示和自动化测试。OpenClaw 如需继续支持，应按 V2 backend contract 新增独立适配器，不再复用 V1 编排器。

## 快速启动

普通用户推荐直接双击启动脚本，不需要手动输入命令：

- `启动 TeamRoom.command` / `启动 TeamRoom.cmd`
- `重启 TeamRoom.command` / `重启 TeamRoom.cmd`
- `停止 TeamRoom.command` / `停止 TeamRoom.cmd`

文件后缀说明：

- macOS 使用 `.command`
- Windows 使用 `.cmd`

推荐打包目录：

```text
TeamRoom-Package/
  TeamRoom/
    启动 TeamRoom.command
    启动 TeamRoom.cmd
    ...
  opencode_foxagent/
    opencode.json
    input/
    ...
```

当 `opencode_foxagent` 与 `TeamRoom` 放在同一层目录时，启动脚本会自动识别 OpenCode 项目，并默认使用“由 TeamRoom 启动本机 OpenCode”的方式。若没有识别到项目，首次进入页面后可以在“连接与设置”里选择项目目录。

运行要求：

- Node.js 22 或更高版本
- 如需由 TeamRoom 启动 OpenCode，本机需要已安装 `opencode` 命令

也可以在终端运行：

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:8787
```

## OpenCode 接入方式

普通用户无需阅读本节；本节主要给需要排查运行细节或手动接入 OpenCode 的用户。

推荐方式一：先启动 OpenCode，再让 TeamRoom 连接。

```bash
cd /path/to/opencode-project
opencode serve --hostname 127.0.0.1 --port 4096
```

另开一个终端查看原生运行详情：

```bash
opencode attach http://127.0.0.1:4096
```

TeamRoom 启动：

```bash
TEAMROOM_ADAPTER=opencode \
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/path/to/opencode-project \
npm start
```

推荐方式二：由 TeamRoom 启动本机 OpenCode。首次进入页面时选择“由 TeamRoom 启动本机服务”，并选择 OpenCode 项目文件夹。

如果使用上面的推荐打包目录，并双击 `启动 TeamRoom.command` 或 `启动 TeamRoom.cmd`，TeamRoom 会自动识别 `opencode_foxagent`，通常不需要再手动选择。

## 文件区

如果项目里存在 `input/`，TeamRoom 会优先识别项目文件区。否则使用 TeamRoom 自己的数据目录：

```text
data/files/default
```

## 主要能力

- 显式选择协作室主要 Agent。
- 用户消息默认发给主要 Agent。
- 任务进行中支持补充说明、人工确认、权限确认和中断。
- 展示流式文本、子 Agent 调用、当前进展、文件变化和耗时。
- 支持连接外部 OpenCode 服务，也支持 TeamRoom 管理本机 OpenCode 进程。
- 支持复制 `opencode attach` 命令，用原生 OpenCode TUI 查看详细运行过程。

## V2 API

常用接口：

```text
GET    /api/v2/runtime
POST   /api/v2/runtime/reconnect
GET    /api/v2/setup
PUT    /api/v2/setup
POST   /api/v2/setup/select-workspace
GET    /api/v2/agents
PUT    /api/v2/agents/:agentId/profile
DELETE /api/v2/agents/:agentId/profile
GET    /api/v2/rooms
POST   /api/v2/rooms
GET    /api/v2/rooms/:roomId
DELETE /api/v2/rooms/:roomId
PUT    /api/v2/rooms/:roomId/main-agent
POST   /api/v2/rooms/:roomId/members
DELETE /api/v2/rooms/:roomId/members/:agentId
GET    /api/v2/rooms/:roomId/events
POST   /api/v2/rooms/:roomId/messages
GET    /api/v2/rooms/:roomId/runs
GET    /api/v2/rooms/:roomId/runs/:runId
POST   /api/v2/rooms/:roomId/runs/:runId/messages
POST   /api/v2/rooms/:roomId/runs/:runId/check
POST   /api/v2/rooms/:roomId/runs/:runId/cancel
POST   /api/v2/rooms/:roomId/runs/:runId/human-requests/:requestId/response
```

## 代码位置

```text
src/server.js                         V2 HTTP 服务和 API
src/v2/direct-run-service.js          V2 运行编排，负责消息、确认点、状态和事件
src/v2/adapters/opencode.js           OpenCode Session / SSE 适配器
src/v2/adapters/mock.js               本地演示和测试适配器
src/v2/sqlite-store.js                V2 持久化
src/v2/opencode-process-manager.js    TeamRoom 管理 OpenCode 进程
src/v2/file-area.js                   文件区解析
src/v2/artifact-tracker.js            文件变化跟踪
public/index.html                     正式页面
public/app.js                         前端交互
public/airtable-theme.css             Airtable 风格界面
scripts/teamroom-control.mjs          启动、重启、停止脚本
```

## 检查

```bash
npm run check
npm test
```
