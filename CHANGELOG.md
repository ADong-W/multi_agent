# CHANGELOG

这个文件用来记录每个本地 Git 保存点对应的功能状态，方便后续判断应该回退到哪个版本。

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
