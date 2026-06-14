# TeamRoom V2 重构与验收计划

## 当前进度（2026-06-13）

已完成：

- Phase 0：旧强制编排已从当前代码树移除，V2 不生成派发、阶段或终审。
- Phase 1：SQLite 领域表、旧数据幂等迁移、房间与连接档案绑定已落地。
- Phase 2：V2 Adapter 契约与原生 Mock 已落地。
- Phase 3 核心链路：OpenCode `prompt_async`、SSE、显式 idle 完成、子 Session、
  question、permission、interrupt、Compaction 防误完成、断线后快照对账已落地。
- Phase 5 核心链路：原生问题/权限卡持久化、回答原请求、等待期间重启后重新监听原
  Session 已落地。
- Phase 6 第一批：正式页面已切换到 V2 消息、运行、事件、确认、停止和重连接口；
  TeamRoom 不再从页面触发旧的强制审核流程。

当前自动化回归覆盖 16 个场景，包括：

- 简单对话只调用主要助手。
- 运行中补充要求送回原 Session，不新建任务。
- 人工确认暂停并恢复同一任务。
- 确认等待期间重启后重新挂接原 Session。
- Compaction 不会被识别为完成。
- OpenCode 文本输出不会在 session idle 前提前结束。
- 房间连接档案与 SQLite 状态可跨重启恢复。

下一批重点：

- 将已确认的 Airtable 页面稿全部替换到正式 DOM，而不仅是主题和 V2 数据通路。
- TeamRoom 范围内的权限长期允许规则。
- OpenClaw 原生 Gateway V2 Adapter。
- 文件变化索引、写入范围锁、队列与不冲突并行。
- OpenCode 本机真实服务的跨平台集成回归。

## 1. 重构策略

采用“先建立新内核，再逐步接入界面”的方式。旧编排逻辑在迁移完成前保留在独立兼容路径，不继续扩展。

每个阶段必须：

- 有可独立运行的验收场景。
- 不依赖下一阶段才能验证。
- 为失败和恢复路径编写测试。
- 不修改 Agent 的业务 SOP。

## 2. 阶段划分

### Phase 0：冻结旧编排

目标：

- 标记旧 `supervisor dispatch / specialist / review` 为 legacy。
- 新功能不再依赖 `TEAMROOM_DISPATCH_JSON`。
- 保存当前静态界面稿作为产品基准。

首批代码入口：

```text
POST /api/v2/rooms/:roomId/messages
GET  /api/v2/rooms/:roomId/runs
GET  /api/v2/rooms/:roomId/runs/:runId
POST /api/v2/rooms/:roomId/runs/:runId/check
POST /api/v2/rooms/:roomId/runs/:runId/cancel
POST /api/v2/rooms/:roomId/runs/:runId/human-requests/:requestId/response
GET  /api/v2/runtime
```

这些接口与 V1 页面并行存在。V2 消息只直连主要助手，不生成业务阶段；正式界面在 Phase 6 切换到这些接口。

验收：

- 旧模式仍可运行。
- 文档明确新旧边界。

### Phase 1：SQLite 与新领域模型

目标：

- 引入 SQLite。
- 建立 ConnectionProfile、Room、Conversation、TaskRun、Invocation、HumanRequest 和 Event。
- 迁移旧房间、成员、UI 元数据和只读历史。

验收：

- 重启服务后状态与耗时不丢失。
- 旧任务不会被恢复为可执行状态。
- 数据迁移可重复运行。

### Phase 2：底座适配器 V2

目标：

- 建立事件驱动 Adapter 契约。
- 完成能力探测。
- 实现连接、会话、消息、订阅、快照、中断接口。

验收：

- Mock Adapter 能模拟流式、问题、权限、子调用、Compaction、断线和恢复。
- 不通过字符串输出推断调用阶段。

### Phase 3：OpenCode 原生接入

目标：

- 使用 OpenCode 官方 SDK/Server 事件。
- 异步发送消息和长连接事件订阅。
- 转发 question、permission、interrupt。
- 正确识别 session idle、run complete、tool 和 Compaction。

核心回归场景：

1. 主要助手直接回答。
2. 主要助手原生调用一个协作助手。
3. 协作助手提问并恢复。
4. 权限申请仅本次允许。
5. 权限同类长期允许。
6. Compaction 后继续运行。
7. 断线发生在确认卡出现时。
8. 断线恢复后耗时不归零。

### Phase 4：OpenClaw Gateway 接入

目标：

- 复用原生聊天会话。
- 转发流式输出。
- 观察可用的 A2A 调用。
- 对不可观察能力进行明确降级展示。

验收：

- TeamRoom 不重复发起 OpenClaw A2A。
- 简单问答不触发强制审核。
- 同一对话能持续交流。

### Phase 5：Human in the loop

目标：

- 实现问题卡、确认卡和权限卡。
- 支持部分填写、统一提交。
- 支持补充要求、目标切换和停止纠正。
- 实现 TeamRoom 范围内的权限信任规则。

验收：

- 一个 JSON 确认点只生成一张卡。
- `hint`、`question`、`options` 不错位。
- 重连不会提交空回答。
- 回答只送回原始请求。

### Phase 6：运行投影与前端整合

目标：

- 将已确认的 Airtable 风格界面整合到正式页面。
- 由标准事件驱动对话流、过程气泡、调用树、拓扑、状态与耗时。
- 移除静态演示数据。

验收：

- 右栏顺序为当前进展、文件、用时、历史任务。
- 最终答案不进入灰色系统框。
- 长过程自动分段并收起。
- 窄屏下状态按钮和任务标题不变形。

### Phase 7：文件、锁与任务队列

目标：

- 实现文件区自动选择。
- 实现文件变化检测与索引。
- 实现读写范围和工作区锁。
- 实现 FIFO 队列和手动优先级。

验收：

- 不冲突任务可并行。
- 冲突任务排队。
- 未知范围锁定整个工作区。
- 等待确认的任务不会阻塞不冲突写入。

### Phase 8：恢复、审计与发布

目标：

- 事件游标补发与快照对账。
- 后台审计和前台提前交付。
- 故障诊断、日志脱敏和远程访问认证。
- 更新 README 和部署文档。

验收：

- 服务进程重启后可恢复 TeamRoom 创建的活动会话。
- 不重发任务。
- 状态未知有明确提示和人工操作。
- 完成全量跨平台回归。

## 3. 建议代码结构

```text
src/
  application/
    conversations/
    runs/
    human-requests/
    recovery/
    workspace/
  domain/
    connection-profile.js
    conversation.js
    task-run.js
    invocation.js
    backend-event.js
  adapters/
    contract.js
    opencode/
    openclaw/
    mock/
  infrastructure/
    sqlite/
    event-stream/
    process-manager/
    file-watcher/
```

## 4. 测试策略

### 单元测试

- 状态转换与完成守卫。
- 事件幂等。
- 确认卡规范化。
- 权限规则匹配。
- 文件锁冲突判断。
- 耗时分段计算。

### 契约测试

同一套 Adapter 测试运行在 Mock、OpenCode 和 OpenClaw：

- 会话创建与恢复。
- 流式事件顺序。
- 问题与权限回答。
- 中断。
- 断线重放。

### 集成测试

- 浏览器、TeamRoom、Mock Backend 全链路。
- OpenCode 本机服务全链路。
- OpenClaw Gateway 全链路。

### 视觉测试

- 桌面与移动端。
- 长任务标题。
- 多张确认卡。
- 右栏折叠。
- 断线恢复。
- 首次启动两种文件区状态。

## 5. 实施顺序建议

第一开发批次应完成 Phase 0 至 Phase 3。完成后 TeamRoom 应已经可以作为可靠的 OpenCode 单底座产品运行。

第二批次完成 Phase 4 至 Phase 6，补齐 OpenClaw 与正式 UI。

第三批次完成 Phase 7 至 Phase 8，加入并发、恢复强化和发布能力。

不建议先把静态界面直接绑定到当前 `orchestrator.js`。这会把已经确认要删除的强制工作流再次固化到新界面中。
