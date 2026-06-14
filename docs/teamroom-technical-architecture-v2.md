# TeamRoom V2 技术架构

本设计替代旧的“TeamRoom 生成任务图并执行 Supervisor 派发计划”架构。

## 1. 总体架构

```text
Browser UI
  | HTTP + SSE/WebSocket
  v
TeamRoom Application
  +-- Room and Conversation Service
  +-- Run Projection Service
  +-- Human Interaction Bridge
  +-- File and Workspace Service
  +-- Recovery Coordinator
  +-- Permission Policy Service
  +-- SQLite Store
  |
  v
Backend Adapter Contract
  +-- OpenCode Adapter
  +-- OpenClaw Adapter
```

主要变化：

- TeamRoom 不再创建强制业务阶段。
- `Policy Engine` 不再解析 Supervisor Dispatch。
- `Run Projection Service` 根据底座真实事件构建只读调用树。
- 用户消息只发送给目标 Agent 的原生会话。

## 2. 领域对象

### ConnectionProfile

```json
{
  "id": "conn_123",
  "backend": "opencode",
  "name": "本机 OpenCode",
  "baseUrl": "http://127.0.0.1:4096",
  "launchMode": "managed_local",
  "workspaceRoot": "/workspace-fox_supervisor_agent",
  "fileAreaMode": "project_input",
  "fileAreaPath": "/workspace-fox_supervisor_agent/input",
  "capabilities": {},
  "permissionPolicyId": "perm_123"
}
```

### Room

```json
{
  "id": "room_123",
  "connectionProfileId": "conn_123",
  "workspaceId": "ws_123",
  "name": "产品设计协作室",
  "mainAgentId": "fox-supervisor-agent",
  "memberAgentIds": ["fox-supervisor-agent", "form-agent"]
}
```

### Conversation

```json
{
  "id": "conv_123",
  "roomId": "room_123",
  "agentId": "fox-supervisor-agent",
  "backendSessionId": "ses_123",
  "kind": "room_main",
  "status": "active"
}
```

### TaskRun

```json
{
  "id": "run_123",
  "conversationId": "conv_123",
  "rootBackendRunId": "run_backend_123",
  "status": "running",
  "completionConfidence": "confirmed",
  "startedAt": "...",
  "foregroundDeliveredAt": null,
  "settledAt": null
}
```

### AgentInvocation

由底座事件投影生成，不由 TeamRoom 计划生成。

```json
{
  "id": "inv_123",
  "taskRunId": "run_123",
  "parentInvocationId": null,
  "agentId": "fox-supervisor-agent",
  "backendSessionId": "ses_123",
  "backendRunId": "run_backend_123",
  "status": "running"
}
```

### HumanRequest

```json
{
  "id": "human_123",
  "taskRunId": "run_123",
  "invocationId": "inv_456",
  "backendRequestId": "question_123",
  "type": "question",
  "status": "pending",
  "payload": {},
  "createdAt": "...",
  "answeredAt": null
}
```

## 3. 底座适配器契约

旧接口：

```js
listAgents()
runAgent(agentId, input, context)
```

新接口应围绕会话、事件和控制：

```ts
interface BackendAdapter {
  probeConnection(): Promise<BackendCapabilities>;
  listAgents(): Promise<AgentDescriptor[]>;

  createSession(input: CreateSessionInput): Promise<BackendSession>;
  resumeSession(sessionId: string): Promise<BackendSessionSnapshot>;
  sendMessage(input: SendMessageInput): Promise<BackendRunRef>;

  subscribe(input: SubscriptionInput): AsyncIterable<BackendEvent>;
  getSnapshot(input: SnapshotInput): Promise<BackendRunSnapshot>;

  answerQuestion(input: AnswerQuestionInput): Promise<void>;
  answerPermission(input: AnswerPermissionInput): Promise<void>;
  interrupt(input: InterruptInput): Promise<void>;

  listChangedFiles?(input: FileChangeInput): Promise<BackendFileChange[]>;
  startLocalService?(): Promise<ManagedProcessRef>;
  stopLocalService?(): Promise<void>;
}
```

能力必须显式探测：

```json
{
  "streaming": true,
  "questions": true,
  "permissions": true,
  "interrupt": true,
  "childInvocations": true,
  "eventReplay": true,
  "managedLocalStart": true
}
```

UI 和服务层只能使用已声明能力，不能假定两个底座行为一致。

## 4. 标准事件模型

底座事件归一化为：

```text
connection.opened
connection.closed
connection.recovered

session.created
session.idle
session.error

run.started
run.output.delta
run.output.completed
run.completed
run.failed
run.cancelled

invocation.started
invocation.updated
invocation.completed
invocation.failed

tool.started
tool.updated
tool.completed
tool.failed

question.requested
question.answered
permission.requested
permission.answered

compaction.started
compaction.completed

file.detected
file.changed
```

每个事件至少包含：

```json
{
  "eventId": "backend-or-teamroom-event-id",
  "cursor": "replay-cursor",
  "connectionProfileId": "conn_123",
  "backendSessionId": "ses_123",
  "backendRunId": "run_123",
  "parentRunId": null,
  "timestamp": "...",
  "type": "run.output.delta",
  "payload": {}
}
```

事件写入 SQLite 后再推送 UI。UI 断线重连时按最后游标补发。

## 5. 状态机

### TaskRun 状态

```text
queued
  -> running
  -> waiting_user
  -> running
  -> foreground_delivered
  -> auditing
  -> completed

running -> recovering
recovering -> running | waiting_user | completed | unknown
running -> failed | cancelled
```

`foreground_delivered` 表示用户已经看到可交付结论，但后台审计仍可继续。

### 完成守卫

仅当以下条件全部为真时进入 `completed`：

```js
rootInvocation.isTerminal
&& allDescendantInvocationsAreTerminal
&& noPendingHumanRequests
&& noRunningTools
&& noPendingRetries
&& noActiveCompaction
&& backendSessionIsIdleOrRunExplicitlyCompleted
```

禁止使用以下信号单独完成：

- 已出现 Assistant 文本。
- HTTP 请求返回。
- Compaction 输出。
- SSE 断开。
- 达到轮询次数。
- 子 Agent 返回“已准备好”。

## 6. OpenCode 接入

目标方式：

- 官方 SDK 或官方 Server API。
- 长连接订阅事件流。
- 异步发送消息，不以同步 HTTP 请求生命周期代表任务生命周期。
- 原生转发 question、permission、interrupt。
- 使用 session/run/part 状态确认完成。

OpenCode 适配器必须维护：

- TeamRoom Conversation 到 OpenCode Session 的映射。
- OpenCode Run/Message/Part 到标准 Invocation/Tool/Event 的映射。
- 事件游标或最近事件 ID。
- Compaction 状态。
- 待处理 question/permission 的原始 ID。

轮询只作为事件流不可用时的降级方案，采用 30s、60s、120s、300s 上限退避；问题和权限可使用更短但有界的专项探测。

## 7. OpenClaw 接入

首版支持 Gateway/WebChat：

- 复用 OpenClaw 原生聊天会话。
- 订阅可获得的流式消息和会话状态。
- 观察原生 A2A 调用；若 Gateway 不暴露完整子调用事件，则明确显示“底座未提供详细协作过程”。
- 不让 TeamRoom 再次调用 specialist 以模拟 A2A。

未来可通过 OpenClaw 插件获得更完整的原生事件，但插件与独立运行模式使用相同标准事件模型。

## 8. Human Interaction Bridge

HumanRequest 必须以底座请求 ID 为幂等键。

处理规则：

1. 收到问题或权限事件。
2. 先持久化 `pending`。
3. 推送 UI 卡片。
4. 用户提交后以事务将其置为 `answering`。
5. 调用对应 Adapter 回答原请求。
6. 成功后置为 `answered`，失败恢复 `pending`。

连接重建不得生成答案。空值只有在底座明确允许且用户明确提交空值时才发送。

结构化 `confirmation_points` 是兼容展示协议，不是 TeamRoom 工作流协议。

## 9. 上下文策略

TeamRoom 不负责重放同一底座会话已有历史。

当主要助手原生调用协作助手时：

- 优先使用底座自身传递的调用输入。
- TeamRoom 只在底座需要显式补充时添加结构化 `handoff_context`。
- `handoff_context` 由当前用户目标、上游相关结果、文件引用和未解决决定构成。
- 每个条目有稳定 ID 和版本；新版本覆盖旧版本，不叠加重复文本。
- 系统事件、重连记录和 UI 状态永不进入 Agent 上下文。

## 10. 恢复与幂等

恢复过程：

```text
连接中断
  -> TaskRun.recovering
  -> 重连底座
  -> 读取事件游标之后的新事件
  -> 获取当前会话快照
  -> 对账 Invocation / HumanRequest / Tool / Compaction
  -> 恢复真实状态
```

关键幂等键：

- 底座事件 ID。
- 底座 Run ID。
- Human Request ID。
- 用户回答提交 ID。
- 文件变化的路径、时间戳和内容摘要。

禁止在恢复流程中重新调用 `sendMessage`。

## 11. SQLite 存储

建议表：

```text
connection_profiles
rooms
room_members
conversations
task_runs
agent_invocations
backend_events
human_requests
permission_rules
files
file_changes
workspace_locks
task_queue
duration_segments
```

事件表追加写；任务、调用与问题表是可查询投影。所有时间使用绝对时间戳计算，前端刷新或服务重启不重置耗时。

## 12. 文件锁与调度

锁粒度：

```text
workspace
file
file-section
```

任务没有写入范围时使用 workspace 写锁。读锁可共享，写锁与重叠读写锁冲突。

调度器只调度用户创建的任务队列，不调度 Agent 内部业务步骤。任务等待用户时保留已声明写锁，释放纯计算资源。

## 13. 安全

- 默认绑定 `127.0.0.1`。
- 远程访问必须认证。
- 认证凭据不写入普通日志或 Agent 上下文。
- 文件 API 只允许访问连接档案配置的工作区和文件区。
- TeamRoom 权限信任规则按连接档案隔离。
- 所有中断、权限回答和文件下载进入审计日志。

## 14. 旧协议兼容

保留：

- `confirmation_points` 展示。
- 可展示的 closure、artifact 和文件信息。
- 旧房间、成员和历史任务的只读迁移。

移除：

- `TEAMROOM_DISPATCH_JSON` 驱动执行。
- `followup_subtasks` 自动执行。
- Payload Correction。
- 强制 Supervisor Review。
- TeamRoom 自动拼接完整历史。
