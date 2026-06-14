# 项目背景

TeamRoom V2 是运行在 Agent 底座上方的人机协作界面。它面向需要长时间运行、多 Agent 调用、人工确认和文件产出的任务，让用户能看到“当前做到哪一步、在等谁、产生了什么文件、用了多久”。

V2 已移除早期 TeamRoom 强制编排流程。TeamRoom 不再替 Agent 固定执行“总控分析、派发子 Agent、汇总审核”，而是把用户消息交给主要助手，由底座和 Agent 自身能力决定是否调用其他 Agent。

当前分支：`dev4_opencode_teamroom`  
状态日期：2026-06-14

## 目标

- 默认支持 OpenCode，保留 Mock 后端用于演示和测试。
- 一个 TeamRoom 实例只连接一种运行底座。
- 用户消息默认发送给协作室的主要助手。
- 支持运行中补充说明、人工确认、权限处理、停止任务和状态检查。
- 展示底座真实文本输出、子 Agent 调用、文件变化、耗时和历史任务。
- 避免把重连、心跳、内部状态、无关历史和冗余 SOP 注入 Agent 上下文。
- 提供面向业务用户的 Airtable 风格界面。

## 当前架构

```text
Browser UI
  | HTTP API + SSE
  v
TeamRoom Node.js Server
  +-- Room / Member / Main Agent
  +-- DirectRunService
  +-- Human Request Bridge
  +-- Runtime Event Projection
  +-- Artifact Tracker
  +-- File Area Resolver
  +-- OpenCode Process Manager
  |
  +-- JSON Store: room members and local agent profiles
  +-- SQLite Store: connection, conversation, run, invocation, request, event
  |
  v
Backend Adapter V2
  +-- OpenCode
  +-- Mock
```

## 已完成工作

- V2 API 已切换到 `/api/v2/*`。
- 旧 V1 编排器、策略引擎、prompt 模板工作台、旧 adapter、旧 OpenClaw agent 文件编辑器和过时预览页已删除。
- 正式页面已整合 Airtable 风格。
- 支持显式设置主要助手。
- 支持连接外部 OpenCode 服务，也支持由 TeamRoom 启动本机 OpenCode。
- 支持复制 `opencode attach` 命令查看原生运行细节。
- 支持流式文本、子调用、问题卡片、权限卡片、补充说明、停止任务、手动检查状态和文件变化追踪。
- 支持启动、重启、停止脚本，方便非技术用户使用。

## 技术决策

- TeamRoom 不强制工作流，只做中转、观察、介入和持久化。
- 任务完成依赖底座状态、子调用状态和待处理人工请求，不能仅凭文本输出或 HTTP 返回判断完成。
- 同一任务内复用原底座 Session，补充说明不创建新任务。
- 文件区优先使用项目 `input/`；不存在时使用 TeamRoom 默认文件区。
- OpenClaw 如需继续接入，应新增 V2 adapter，不再复用旧 V1 adapter。

## 未解决问题

- OpenClaw V2 原生适配器尚未实现。
- 真实 OpenCode 长任务仍需继续做端到端回归。
- 文件来源、修改 Agent、预览和下载之间的关联还可以继续增强。
- 权限长期允许规则仍需落地。
- 多任务并发和写入冲突锁仍需设计实现。

## 关键代码位置

| 位置 | 作用 |
| --- | --- |
| `src/server.js` | HTTP 服务、静态页面、V2 API 和运行服务连接 |
| `src/v2/direct-run-service.js` | 消息提交、任务状态、人工请求、补充要求、恢复和完成处理 |
| `src/v2/adapters/opencode.js` | OpenCode Session、SSE、文本、子调用、问题、权限、Compaction 和完成判断 |
| `src/v2/adapters/mock.js` | 本地演示和自动化测试 Mock 后端 |
| `src/v2/sqlite-store.js` | V2 SQLite 表结构、持久化和迁移 |
| `src/v2/opencode-process-manager.js` | TeamRoom 管理的本机 OpenCode 进程 |
| `src/v2/file-area.js` | 项目 `input/` 探测和默认文件区选择 |
| `src/v2/artifact-tracker.js` | 任务执行期间的文件变化收集 |
| `src/store.js` | 房间成员和 Agent 本地标签 |
| `public/index.html` | 正式页面 DOM |
| `public/app.js` | 前端状态、API、SSE、消息、确认卡、任务详情和交互 |
| `public/airtable-theme.css` | Airtable 风格主题 |
| `scripts/teamroom-control.mjs` | 启动、重启、停止和状态检查脚本 |

## 后续计划

1. 补齐 OpenClaw V2 adapter。
2. 完成真实 OpenCode 长任务回归。
3. 强化文件面板、权限长期允许、任务并发和写入冲突管理。
4. 补充发布部署、安全认证、日志脱敏和备份恢复说明。
