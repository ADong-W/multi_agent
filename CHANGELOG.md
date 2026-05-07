# CHANGELOG

这个文件用来记录每个本地 Git 保存点对应的功能状态，方便后续判断应该回退到哪个版本。

## Unreleased

暂无。

## teamroom-snapshot-20260507-113112

- Commit: 以 Git tag `teamroom-snapshot-20260507-113112` 指向的提交为准
- Git tag: `teamroom-snapshot-20260507-113112`
- 保存时间: 2026-05-07 11:31 左右
- 提交说明: `Save TeamRoom configurable collaboration workbench version`

### 新增

- 协作室区分两种人的动作：
  - 在右侧任务控制区发布任务。
  - 在中间聊天区参与 agent 协作聊天，补充上下文或发出干预指令。
- 同一协作室同一时间只允许一个当前任务。
- 当前任务处于 `queued`、`running`、`failed` 等非终态时，发布新任务会被阻止。
- 当前任务可以人为终止，终止后可以发布新任务。
- 人在聊天区输入“继续任务 / 继续 / 续跑 / resume / continue”等消息时，会触发当前中断任务续跑。
- 续跑不会重新创建任务，也不会从头再跑已完成阶段，而是从第一个未完成、失败或中断的阶段继续。
- 运行中任务被人为终止后，即使 agent 后续返回结果，也不会覆盖已终止任务状态。
- 当前任务的人类补充消息会注入后续 agent prompt。
- 顶部新增“配置”按钮，点击后进入独立配置工作台。
- 配置工作台支持查看和修改当前 OpenClaw agent 工作区中的 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`MEMORY.md`。
- 修改 OpenClaw agent 文件时会在 `data/openclaw-file-backups/` 下保留原文件备份。
- 配置工作台支持按协作室修改 TeamRoom 协作 prompt 模板。
- 支持配置 Supervisor 派工失败时的兜底方式：不兜底、按关键词/标签匹配、派给全部 specialist。
- 默认兜底派工改为“不兜底派工”：Supervisor 没有明确返回可解析派工 JSON 时，TeamRoom 不再替 Supervisor 自动决定要派给哪些 specialist。
- 修正 Supervisor 返回合法 JSON 且 `subtasks: []` 的语义：这表示 Supervisor 明确决定无需派发子 agent，TeamRoom 不再把空数组当作 JSON 解析失败去触发兜底。
- 支持配置是否需要 Supervisor 最终审核。
- 支持配置注入给 agent 的协作室历史任务数和当前任务消息数，控制上下文长度。
- 支持修改 Supervisor 派工、Specialist 执行、Supervisor 审核、前序 agent 输出拼接、历史任务拼接、人工补充消息拼接等模板。

### 修复

- 修复中间聊天框发出补充消息后，前端只等待 SSE 推送导致消息可能不显示的问题；现在接口会返回新消息事件，前端会立即把它追加到聊天气泡中。
- 增加聊天消息本地待确认显示和去重逻辑，即使当前服务进程还没重启到新版后端，刷新页面后也能先看到自己刚发出的补充消息。
- 优化三栏界面：左侧 agents 按 agent 折叠并独立滚动，中间聊天长气泡可展开/收起，右侧任务流按任务折叠并独立滚动。
- 继续优化折叠区可读性：agent 折叠态显示名称、来源和标签预览；任务展开后的阶段列表也拥有自己的滚动区。
- 修复左下角 agents 列表在折叠布局下被压成细横线的问题，改为自定义可展开 agent 卡片。
- 为前端静态资源增加版本号参数，避免浏览器继续加载旧版 agent 列表脚本或样式。
- 二次修复 agent 卡片塌缩：去掉整卡 `button` 容器，改用普通块级 summary，并给卡片本体设置明确最小高度。
- 修复 agent 展开后详情区不撑开列表空间的问题，将 `Agents` 列表从 grid 改为普通 block 流，展开卡片会把后续卡片推到下方并通过列表滚动查看。
- 调整 Supervisor 派工兜底策略：当总控没有返回可解析派工 JSON 时，不再默认派给所有非总控 agent，而是按任务关键词和 agent 标签保守匹配相关 specialist。
- 将协作室头部的 agent 列表改为两层拓扑图：Supervisor 在上层，子 agent 在下层，并用连线表达协作关系；任务运行时会点亮当前执行 agent 及其连线。
- 优化左侧 Agents 列表折叠态：只展示 agent 名称、状态和拉入按钮，未展开时也能直接把 agent 拉入当前协作室。
- 增强聊天消息 Markdown 渲染：支持 GitHub 风格表格，并为宽表格提供横向滚动。

### 新增 API

```text
POST /api/rooms/:roomId/messages
POST /api/rooms/:roomId/tasks/:taskId/cancel
PUT  /api/rooms/:roomId/policy
GET  /api/config/prompt-templates
GET  /api/openclaw/agents/:agentId/files
PUT  /api/openclaw/agents/:agentId/files/:fileName
```

## teamroom-snapshot-20260506-235836

- Commit: `bad675d`
- Git tag: `teamroom-snapshot-20260506-235836`
- 保存时间: 2026-05-06 23:58 左右
- 提交说明: `Save TeamRoom supervisor cockpit version`

### 版本定位

这一版是 `OpenClaw TeamRoom` 的第一个可回退基线版本，定位为“实施设计 Agent 协作驾驶舱”，不是普通多 agent 群聊，也不是实施设计助手 Agent 本体。

它位于用户 / BA 和 OpenClaw 多 agent 之间，用来做协作室管理、agent 编队、任务派发过程可视化、上下文承接和结果回收。

### 已包含能力

- 轻量 Node.js 单进程服务，不依赖 Docker、数据库或外部 npm 包。
- 静态 Web UI 和后端 API 由同一个服务提供。
- 支持本地 mock adapter。
- 支持 OpenClaw Gateway RPC adapter，可连接 OpenClaw Control UI 使用的 WebSocket Gateway。
- 支持列出 OpenClaw 现有 agents。
- 支持创建协作室。
- 支持删除协作室，并同步删除该协作室下的任务和事件。
- 支持把 OpenClaw agents 拉入协作室。
- 支持给 OpenClaw agents 分配 TeamRoom 本地标签画像。
- 标签画像不会写回 OpenClaw 本体，只保存在 `data/teamroom.json`。
- 支持常用标签预设：总控、维度/模型、表单、权限、规则、集成、作业流。
- 默认协作策略为 `Supervisor 驱动`。
- 任务先交给 Supervisor agent，由 Supervisor 输出结构化派工计划。
- TeamRoom 根据 Supervisor 的派工 JSON 动态生成子 agent 任务阶段。
- 子 agent 完成后，结果交回 Supervisor 做最终审核。
- 同一个协作室内多个任务共享上下文。
- TeamRoom 会把协作室内已完成任务摘要注入后续任务 prompt。
- OpenClaw Gateway 模式下，同一协作室同一 agent 复用同一个 OpenClaw chat session。
- 中间区域是聊天软件风格气泡界面。
- 用户提交需求显示为右侧气泡。
- agent 输出显示为对应 agent 的左侧气泡。
- 派发、运行、完成等过程显示为居中的系统提示。
- agent 输出支持轻量 Markdown 渲染，包括标题、列表、引用、代码块、行内代码、加粗、斜体和链接。
- 提供 Server-Sent Events 实时事件流。
- 提供 JSON 文件本地存储。
- 提供中文 README 和架构/策略设计文档。

### 主要 API

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
POST   /api/rooms/:roomId/tasks
GET    /api/rooms/:roomId/events
```

### 不包含的运行数据

这些文件被 `.gitignore` 排除，没有进入 Git 保存点：

```text
data/teamroom.json
data/openclaw-device.json
backups/
node_modules/
```

也就是说，Git 保存的是代码和文档，不保存你的协作室运行数据、OpenClaw device identity 或本地 token。

### 常用查看命令

查看保存点列表：

```bash
git log --oneline --decorate
```

查看当前有没有未保存修改：

```bash
git status
```

查看这个保存点的文件统计：

```bash
git show --stat teamroom-snapshot-20260506-235836
```

查看这个保存点对应的完整代码变化：

```bash
git show teamroom-snapshot-20260506-235836
```

### 回退提示

如果后续要回到这个版本，可以告诉 Codex：

```text
回退到 teamroom-snapshot-20260506-235836
```

手动命令参考：

```bash
git restore .
git checkout teamroom-snapshot-20260506-235836
```

注意：`git checkout tag` 会进入 detached HEAD 状态。真正回退前，建议先让 Codex 帮你确认当前是否有未保存修改。
