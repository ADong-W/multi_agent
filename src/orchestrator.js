import { createTaskGraph, findSupervisorMember, inferCapabilities, normalizePolicy, selectAgent } from "./policy.js";
import { normalizePromptTemplates, renderTemplate } from "./prompt-templates.js";
import { createId, nowIso } from "./utils.js";

const DEFAULT_AUTO_RETRY_DELAY_MS = 5000;
const DEFAULT_AUTO_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_INTERNAL_WAIT_BACKOFF_MS = [30000, 60000, 120000, 300000];
const DEFAULT_INTERNAL_WAIT_MAX_ATTEMPTS = 5;

export class Orchestrator {
  constructor({ store, events, adapter, options = {} }) {
    this.store = store;
    this.events = events;
    this.adapter = adapter;
    this.autoRetryDelayMs = positiveInt(options.autoRetryDelayMs, DEFAULT_AUTO_RETRY_DELAY_MS);
    this.autoRetryMaxAttempts = positiveInt(options.autoRetryMaxAttempts, DEFAULT_AUTO_RETRY_MAX_ATTEMPTS);
    this.internalWaitBackoffMs = normalizeBackoff(options.internalWaitBackoffMs, DEFAULT_INTERNAL_WAIT_BACKOFF_MS);
    this.internalWaitMaxAttempts = positiveInt(options.internalWaitMaxAttempts, DEFAULT_INTERNAL_WAIT_MAX_ATTEMPTS);
    this.runningTasks = new Set();
    this.busyAgents = new Set();
    this.runtimeApprovals = new Map();
  }

  async submitTask(roomId, request) {
    const room = await this.store.getRoom(roomId);
    if (!room) {
      const error = new Error(`Room not found: ${roomId}`);
      error.statusCode = 404;
      throw error;
    }
    if (!request.goal || !String(request.goal).trim()) {
      const error = new Error("Task goal is required");
      error.statusCode = 400;
      throw error;
    }
    const activeTask = await this.store.getActiveTask(roomId);
    if (activeTask) {
      const error = new Error(`Room already has an active task: ${activeTask.goal}`);
      error.statusCode = 409;
      throw error;
    }

    const policy = normalizePolicy({ ...room.policy, mode: request.strategy || room.policy?.mode });
    const stages = createTaskGraph({
      goal: request.goal,
      policy,
      requestedStages: request.stages
    });

    const task = await this.store.createTask({
      roomId,
      goal: String(request.goal).trim(),
      stages
    });

    await this.events.publish(roomId, "task.created", {
      taskId: task.id,
      goal: task.goal,
      stages: task.stages
    });

    queueMicrotask(() => {
      this.runTask(task.id).catch(async (error) => {
        await this.failTask(task.id, error);
      });
    });

    return task;
  }

  async submitHumanMessage(roomId, request) {
    const room = await this.store.getRoom(roomId);
    if (!room) {
      const error = new Error(`Room not found: ${roomId}`);
      error.statusCode = 404;
      throw error;
    }
    const content = String(request.content || request.message || "").trim();
    if (!content) {
      const error = new Error("Message content is required");
      error.statusCode = 400;
      throw error;
    }

    const activeTask = await this.store.getActiveTask(roomId);
    const event = await this.events.publish(roomId, "message.created", {
      taskId: activeTask?.id,
      author: "human",
      content
    });

    let resumed = false;
    if (activeTask && (activeTask.status === "pending" || shouldResumeFromMessage(content))) {
      resumed = await this.resumeTask(activeTask.id, content);
    }
    return { event, message: { content }, activeTask, resumed };
  }

  async cancelTask(roomId, taskId, reason = "Terminated by human operator.") {
    const task = await this.store.getTask(taskId);
    if (!task || task.roomId !== roomId) {
      const error = new Error(`Task not found: ${taskId}`);
      error.statusCode = 404;
      throw error;
    }
    if (["completed", "cancelled"].includes(task.status)) {
      return task;
    }

    task.status = "cancelled";
    task.cancelRequested = true;
    task.cancelledAt = nowIso();
    task.error = null;
    for (const stage of task.stages || []) {
      if (["queued", "running", "failed"].includes(stage.status)) {
        stage.status = "cancelled";
        stage.error = reason;
        if (stage.startedAt && !stage.cancelledAt && !stage.completedAt && !stage.failedAt) {
          stage.cancelledAt = task.cancelledAt;
        }
      }
      if (stage.assignedAgentId) {
        this.busyAgents.delete(stage.assignedAgentId);
        await this.store.setMemberStatus(roomId, stage.assignedAgentId, "idle");
      }
    }
    await this.store.updateTask(task);
    await this.resolveTaskRuntimeApprovals(task.id, {
      reply: "reject",
      message: reason,
      cancelled: true
    });
    await this.events.publish(roomId, "task.cancelled", {
      taskId: task.id,
      reason
    });
    return task;
  }

  async recoverInternalPendingTasks() {
    const rooms = await this.store.listRooms();
    for (const room of rooms) {
      const task = await this.store.getActiveTask(room.id);
      if (!task || task.status !== "pending" || !isInternalOnlyPendingTask(task)) {
        continue;
      }
      if (this.runningTasks.has(task.id)) {
        continue;
      }

      const delayMs = this.internalWaitDelayForAttempt(1);
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      task.status = "retrying";
      task.error = null;
      task.retryAt = retryAt;
      task.retryReason = task.pendingReason || "待确认项仅包含内部流程状态，自动继续复核。";
      await this.store.updateTask(task);
      await this.events.publish(room.id, "task.wait_scheduled", {
        taskId: task.id,
        reason: task.retryReason,
        waitingPoints: task.confirmationPoints || [],
        attempt: 1,
        maxAttempts: 1,
        delayMs,
        retryAt
      });

      setTimeout(() => {
        this.resumeTask(task.id, "内部流程状态自动恢复：等待 agent 返回、后续派发或执行中状态不需要人工确认。").catch(async (error) => {
          await this.failTask(task.id, error);
        });
      }, delayMs);
    }
  }

  async resumeTask(taskId, humanInstruction = "") {
    const task = await this.store.getTask(taskId);
    if (!task) {
      return false;
    }
    if (["completed", "cancelled"].includes(task.status)) {
      return false;
    }
    if (this.runningTasks.has(taskId)) {
      await this.events.publish(task.roomId, "task.resume_skipped", {
        taskId,
        reason: "Task is already running."
      });
      return false;
    }

    const resumeInstruction = String(humanInstruction || "").trim();
    const wasPending = task.status === "pending";
    task.status = "queued";
    task.error = null;
    task.resumeInstruction = resumeInstruction;
    task.resumeRequestedAt = nowIso();

    if (wasPending) {
      task.pendingResolvedAt = nowIso();
      task.pendingResolution = resumeInstruction;
      task.pendingAt = null;
      task.pendingReason = null;
      task.pendingStageId = null;
      task.confirmationPoints = [];
      task.stages.push(createRuntimeStage({
        type: "supervisor_dispatch",
        title: "Supervisor Dispatch",
        needs: ["supervisor", "planning", "analysis"],
        goal: "基于人工补充信息重新分析原任务，并继续安排后续协作。",
        reason: "Human provided confirmation for a pending task; Supervisor should re-plan with the updated context."
      }));
      renumberStages(task.stages);
    } else {
      for (const stage of task.stages || []) {
        if (["running", "failed"].includes(stage.status)) {
          stage.status = "queued";
          stage.error = null;
          stage.completedAt = null;
          stage.failedAt = null;
          stage.cancelledAt = null;
        }
      }
    }
    await this.store.updateTask(task);
    await this.events.publish(task.roomId, "task.resumed", {
      taskId,
      instruction: task.resumeInstruction
    });

    queueMicrotask(() => {
      this.runTask(task.id).catch(async (error) => {
        await this.failTask(task.id, error);
      });
    });
    return true;
  }

  async requestRuntimeApproval({ roomId, task, stage, member, request }) {
    const approvalId = createId("approval");
    const approval = {
      ...normalizeRuntimeApprovalRequest(request),
      id: approvalId,
      roomId,
      taskId: task.id,
      stageId: stage.id,
      agentId: member.agentId,
      status: "pending",
      createdAt: nowIso()
    };

    approval.promise = new Promise((resolve) => {
      approval.resolve = resolve;
    });
    this.runtimeApprovals.set(approvalId, approval);

    const publicApproval = publicRuntimeApproval(approval);
    stage.runtimeApproval = publicApproval;
    task.runtimeApproval = publicApproval;
    task.status = "approval_pending";
    task.error = null;
    await this.store.updateTask(task);
    await this.events.publish(roomId, "runtime.approval_requested", {
      taskId: task.id,
      stageId: stage.id,
      agentId: member.agentId,
      approval: publicApproval
    });

    return approval.promise;
  }

  async respondRuntimeApproval(roomId, taskId, approvalId, response = {}) {
    const approval = this.runtimeApprovals.get(approvalId);
    if (!approval || approval.roomId !== roomId || approval.taskId !== taskId) {
      const error = new Error(`Runtime approval not found: ${approvalId}`);
      error.statusCode = 404;
      throw error;
    }
    if (approval.status !== "pending") {
      return { approval: publicRuntimeApproval(approval) };
    }

    const normalized = normalizeRuntimeApprovalResponse(approval, response);
    approval.status = normalized.reply === "reject" ? "rejected" : "approved";
    approval.response = normalized;
    approval.resolvedAt = nowIso();
    this.runtimeApprovals.delete(approvalId);

    const task = await this.store.getTask(taskId);
    if (task) {
      task.runtimeApproval = publicRuntimeApproval(approval);
      if (task.status === "approval_pending") {
        task.status = "running";
      }
      const stage = task.stages?.find((item) => item.id === approval.stageId);
      if (stage) {
        stage.runtimeApproval = publicRuntimeApproval(approval);
      }
      await this.store.updateTask(task);
    }

    await this.events.publish(roomId, "runtime.approval_resolved", {
      taskId,
      stageId: approval.stageId,
      agentId: approval.agentId,
      approval: publicRuntimeApproval(approval)
    });

    approval.resolve(normalized);
    return { approval: publicRuntimeApproval(approval) };
  }

  async runTask(taskId) {
    if (this.runningTasks.has(taskId)) {
      return;
    }
    this.runningTasks.add(taskId);

    const task = await this.store.getTask(taskId);
    if (!task || ["completed", "cancelled"].includes(task.status)) {
      this.runningTasks.delete(taskId);
      return;
    }
    const room = await this.store.getRoom(task.roomId);
    if (!room) {
      throw new Error(`Room not found: ${task.roomId}`);
    }
    if (!room.members?.length) {
      throw new Error("Room has no agent members");
    }

    task.status = "running";
    task.startedAt = task.startedAt || nowIso();
    task.cancelRequested = false;
    await this.store.updateTask(task);
    await this.events.publish(room.id, "task.running", { taskId: task.id });

    const previousOutputs = collectCompletedOutputs(task);
    const roomContext = await this.buildRoomContext(room.id, task.id, normalizePolicy(room.policy));
    const assignmentCounts = new Map();
    try {
      let index = firstIncompleteStageIndex(task.stages);
      while (index < task.stages.length) {
        const persisted = await this.store.getTask(task.id);
        if (!persisted || persisted.status === "cancelled" || persisted.cancelRequested) {
          return;
        }
        Object.assign(task, persisted);
        const latestRoom = await this.store.getRoom(room.id);
        const policy = normalizePolicy(latestRoom.policy);
        const stage = task.stages[index];
        if (stage.status === "completed") {
          index += 1;
          continue;
        }
        const member = selectAgent({
          room: latestRoom,
          stage,
          policy,
          index,
          busy: this.busyAgents,
          assignmentCounts
        });

        if (!member) {
          throw new Error(`No agent available for stage: ${stage.title}`);
        }

        stage.assignedAgentId = member.agentId;
        assignmentCounts.set(member.agentId, (assignmentCounts.get(member.agentId) || 0) + 1);
        stage.status = "running";
        stage.startedAt = stage.startedAt || nowIso();
        stage.completedAt = null;
        stage.failedAt = null;
        stage.cancelledAt = null;
        await this.store.updateTask(task);
        await this.store.setMemberStatus(room.id, member.agentId, "running");
        this.busyAgents.add(member.agentId);

        await this.events.publish(room.id, "stage.assigned", {
          taskId: task.id,
          stageId: stage.id,
          stage,
          agentId: member.agentId
        });
        await this.events.publish(room.id, "stage.running", {
          taskId: task.id,
          stageId: stage.id,
          agentId: member.agentId,
          title: stage.title
        });

        const taskMessages = await this.buildTaskMessages(room.id, task.id, policy);
        const input = buildAgentInput({
          room: latestRoom,
          task,
          stage,
          member,
          previousOutputs,
          roomContext,
          taskMessages
        });
        await this.updateStageProgress({
          roomId: room.id,
          task,
          stage,
          label: "已生成阶段任务，准备发送到执行后端。",
          detail: progressDetailForStage(stage)
        });

        let result;
        const streamProgress = createStageStreamHandler({
          publish: (chunk) => this.updateStageProgress({
            roomId: room.id,
            task,
            stage,
            type: "stage.stream",
            label: `${member.agentId} 正在流式输出。`,
            detail: chunk.detail,
            streamSegment: chunk
          })
        });
        try {
          await this.updateStageProgress({
            roomId: room.id,
            task,
            stage,
            type: "stage.awaiting_agent",
            label: `已发送给 ${member.agentId}，等待 Agent 返回。`,
            detail: "TeamRoom 正在等待执行后端返回本阶段结果；长任务期间这里会持续显示运行时长。"
          });
          result = await this.adapter.runAgent(member.agentId, input, {
            roomId: room.id,
            taskId: task.id,
            stageId: stage.id,
            stageType: stage.type,
            goal: task.goal,
            previousOutputs,
            roomContext,
            taskMessages,
            resumeInstruction: task.resumeInstruction || "",
            onProgress: streamProgress.push
          }, {
            onApprovalRequest: (request) => this.requestRuntimeApproval({
              roomId: room.id,
              task,
              stage,
              member,
              request
            })
          });
          await streamProgress.flush();
        } catch (error) {
          await streamProgress.flush();
          const recoveredResult = await this.tryRecoverSupervisorResultAfterConnectionIssue({
            roomId: room.id,
            task,
            stage,
            member,
            error,
            previousOutputs,
            roomContext,
            taskMessages
          });
          if (recoveredResult) {
            result = recoveredResult;
          } else if (isRecoverableOpenClawError(error) && isSupervisorStage(stage)) {
            await this.pauseForSupervisorConnectionRecovery({
              roomId: room.id,
              task,
              stage,
              member,
              error
            });
            return;
          } else {
            const shouldRetry = await this.scheduleAutoRetry({
              roomId: room.id,
              task,
              stage,
              member,
              error
            });
            if (shouldRetry) {
              continue;
            }
            throw error;
          }
        }

        const normalizedResult = normalizeAgentResult(result);
        await this.updateStageProgress({
          roomId: room.id,
          task,
          stage,
          type: "stage.result_received",
          label: `已收到 ${member.agentId} 返回，正在整理阶段结果。`,
          detail: stage.type === "supervisor_review"
            ? "TeamRoom 正在解析总控复核结论，判断是完成、追加派工、等待还是人工确认。"
            : "TeamRoom 正在记录本阶段输出，并准备推进到下一个阶段。"
        });
        const afterRun = await this.store.getTask(task.id);
        if (!afterRun || afterRun.status === "cancelled" || afterRun.cancelRequested) {
          this.busyAgents.delete(member.agentId);
          await this.store.setMemberStatus(room.id, member.agentId, "idle");
          return;
        }
        if (task.status === "approval_pending") {
          task.status = "running";
        }
        task.runtimeApproval = null;
        stage.runtimeApproval = null;

        if (stage.type === "specialist_work" && isAwaitingInternalSupervisorConfirmation(normalizedResult.summary)) {
          const continued = await this.autoContinueSpecialistStage({
            roomId: room.id,
            task,
            stage,
            member,
            result: normalizedResult
          });
          if (continued) {
            continue;
          }
          throw new Error(`${member.agentId} 连续等待内部总控确认，未执行已派发阶段。请检查该 Agent 的系统提示词，确保它收到 TeamRoom 派工后直接执行，而不是等待二次确认。`);
        }

        stage.status = "completed";
        stage.completedAt = nowIso();
        stage.result = normalizedResult;
        stage.progress = {
          label: `已完成 ${displayStageType(stage.type)}。`,
          detail: "阶段结果已写入任务记录。",
          updatedAt: nowIso()
        };
        previousOutputs.push({
          stageId: stage.id,
          title: stage.title,
          agentId: member.agentId,
          result: stage.result
        });

        this.busyAgents.delete(member.agentId);
        await this.store.setMemberStatus(room.id, member.agentId, "idle");
        await this.store.updateTask(task);
        await this.events.publish(room.id, "stage.completed", {
          taskId: task.id,
          stageId: stage.id,
          agentId: member.agentId,
          stage: {
            id: stage.id,
            title: stage.title,
            type: stage.type
          },
          result: stage.result
        });

        if (policy.mode === "supervisor" && stage.type === "supervisor_review") {
          const deliveryDecision = parseSupervisorDeliveryDecision(stage.result?.summary || "");
          if (deliveryDecision.delivered && !task.deliveredAt) {
            await this.markTaskDelivered({
              roomId: room.id,
              task,
              stage,
              deliveryDecision
            });
            if (deliveryDecision.backgroundAuditRequired) {
              const auditStage = createBackgroundAuditStage({
                supervisor: findSupervisorMember(latestRoom.members || []),
                sourceStage: stage
              });
              task.stages.splice(index + 1, 0, auditStage);
              renumberStages(task.stages);
              await this.store.updateTask(task);
              await this.events.publish(room.id, "task.planned", {
                taskId: task.id,
                background: true,
                stages: [{
                  id: auditStage.id,
                  title: auditStage.title,
                  type: auditStage.type,
                  assignedAgentId: auditStage.assignedAgentId,
                  reason: auditStage.reason || ""
                }]
              });
            }
          }

          const reviewDecision = parseSupervisorReviewDecision(stage.result?.summary || "", latestRoom);
          await this.events.publish(room.id, "stage.review_decision", {
            taskId: task.id,
            stageId: stage.id,
            agentId: member.agentId,
            title: stage.title,
            decision: reviewDecisionLabel(reviewDecision),
            reason: reviewDecision.reason || "",
            confirmationPoints: reviewDecision.confirmationPoints || [],
            followUpSubtasks: reviewDecision.followUpSubtasks || [],
            waitingPoints: reviewDecision.waitingPoints || []
          });
          if (reviewDecision.pending) {
            task.status = "pending";
            task.pendingAt = nowIso();
            task.pendingStageId = stage.id;
            task.pendingReason = reviewDecision.reason;
            task.confirmationPoints = reviewDecision.confirmationPoints;
            task.error = null;
            await this.store.updateTask(task);
            await this.events.publish(room.id, "task.pending", {
              taskId: task.id,
              reason: reviewDecision.reason,
              confirmationPoints: reviewDecision.confirmationPoints,
              summary: stage.result?.summary || ""
            });
            return;
          }
          const reviewFollowUpStages = createSupervisorReviewFollowUpStages({
            room: latestRoom,
            task,
            reviewStage: stage,
            reviewDecision
          });
          if (reviewFollowUpStages.length > 0) {
            task.stages.splice(index + 1, 0, ...reviewFollowUpStages);
            renumberStages(task.stages);
            await this.store.updateTask(task);
            await this.events.publish(room.id, "task.planned", {
              taskId: task.id,
              stages: reviewFollowUpStages.map((item) => ({
                id: item.id,
                title: item.title,
                type: item.type,
                assignedAgentId: item.assignedAgentId,
                reason: item.reason || ""
              }))
            });
          }
          if (reviewFollowUpStages.length === 0 && reviewDecision.internalWait) {
            previousOutputs.pop();
            const shouldWait = await this.scheduleInternalWait({
              roomId: room.id,
              task,
              stage,
              member,
              reason: reviewDecision.reason,
              waitingPoints: reviewDecision.waitingPoints
            });
            if (shouldWait) {
              continue;
            }
          }
        }

        if (policy.mode === "supervisor" && stage.type === "background_audit") {
          const auditDecision = parseBackgroundAuditDecision(stage.result?.summary || "");
          if (auditDecision.pending) {
            task.status = "pending";
            task.pendingAt = nowIso();
            task.pendingStageId = stage.id;
            task.pendingReason = auditDecision.reason;
            task.confirmationPoints = auditDecision.confirmationPoints;
            task.error = null;
            await this.store.updateTask(task);
            await this.events.publish(room.id, "task.pending", {
              taskId: task.id,
              reason: auditDecision.reason,
              confirmationPoints: auditDecision.confirmationPoints,
              summary: stage.result?.summary || ""
            });
            return;
          }
          task.auditCompletedAt = nowIso();
          await this.store.updateTask(task);
          await this.events.publish(room.id, "task.audit_completed", {
            taskId: task.id,
            summary: auditDecision.reason || "后台审计完成，未发现需要用户处理的问题。",
            risks: auditDecision.risks || []
          });
        }

        if (policy.mode === "supervisor" && stage.type === "supervisor_dispatch") {
          const dispatchDecision = parseSupervisorDispatchDecision(stage.result?.summary || "", latestRoom);
          if (dispatchDecision.pending) {
            await this.events.publish(room.id, "stage.review_decision", {
              taskId: task.id,
              stageId: stage.id,
              agentId: member.agentId,
              title: stage.title,
              decision: "需要人工确认",
              reason: dispatchDecision.reason || "",
              confirmationPoints: dispatchDecision.confirmationPoints || []
            });
            task.status = "pending";
            task.pendingAt = nowIso();
            task.pendingStageId = stage.id;
            task.pendingReason = dispatchDecision.reason;
            task.confirmationPoints = dispatchDecision.confirmationPoints;
            task.error = null;
            await this.store.updateTask(task);
            await this.events.publish(room.id, "task.pending", {
              taskId: task.id,
              reason: dispatchDecision.reason,
              confirmationPoints: dispatchDecision.confirmationPoints,
              summary: stage.result?.summary || ""
            });
            return;
          }
          if (dispatchDecision.internalWait) {
            previousOutputs.pop();
            const shouldWait = await this.scheduleInternalWait({
              roomId: room.id,
              task,
              stage,
              member,
              reason: dispatchDecision.reason,
              waitingPoints: dispatchDecision.waitingPoints
            });
            if (shouldWait) {
              continue;
            }
          }
          const followUpStages = createSupervisorFollowUpStages({
            room: latestRoom,
            task,
            dispatchStage: stage,
            policy
          });
          if (followUpStages.length > 0) {
            task.stages.splice(index + 1, 0, ...followUpStages);
            renumberStages(task.stages);
            await this.store.updateTask(task);
            await this.events.publish(room.id, "task.planned", {
              taskId: task.id,
              stages: followUpStages.map((item) => ({
                id: item.id,
                title: item.title,
                type: item.type,
                assignedAgentId: item.assignedAgentId,
                reason: item.reason || ""
              }))
            });
          }
        }

        index += 1;
      }

      task.status = "completed";
      task.completedAt = nowIso();
      task.pendingAt = null;
      task.pendingReason = null;
      task.pendingStageId = null;
      task.confirmationPoints = [];
      await this.store.updateTask(task);
      await this.events.publish(room.id, "task.completed", {
        taskId: task.id,
        summary: task.stages.at(-1)?.result?.summary || "Task completed."
      });
    } catch (error) {
      task.status = "failed";
      task.failedAt = nowIso();
      task.error = error.message;
      const runningStage = task.stages.find((stage) => stage.status === "running");
      if (runningStage) {
        runningStage.status = "failed";
        runningStage.failedAt = runningStage.failedAt || task.failedAt;
        runningStage.error = error.message;
        if (runningStage.assignedAgentId) {
          this.busyAgents.delete(runningStage.assignedAgentId);
          await this.store.setMemberStatus(room.id, runningStage.assignedAgentId, "failed");
        }
      }
      await this.store.updateTask(task);
      await this.events.publish(room.id, "task.failed", {
        taskId: task.id,
        error: error.message
      });
    } finally {
      await this.resolveTaskRuntimeApprovals(taskId, {
        reply: "reject",
        message: "Task finished before the runtime approval was resolved.",
        cancelled: true
      });
      this.runningTasks.delete(taskId);
    }
  }

  async resolveTaskRuntimeApprovals(taskId, response) {
    const approvals = [...this.runtimeApprovals.values()]
      .filter((approval) => approval.taskId === taskId && approval.status === "pending");
    for (const approval of approvals) {
      approval.status = "cancelled";
      approval.response = response;
      approval.resolvedAt = nowIso();
      this.runtimeApprovals.delete(approval.id);
      approval.resolve(response);
      await this.events.publish(approval.roomId, "runtime.approval_resolved", {
        taskId: approval.taskId,
        stageId: approval.stageId,
        agentId: approval.agentId,
        approval: publicRuntimeApproval(approval)
      });
    }
  }

  async tryRecoverSupervisorResultAfterConnectionIssue({ roomId, task, stage, member, error, previousOutputs, roomContext, taskMessages }) {
    if (!isRecoverableOpenClawError(error) || !isSupervisorStage(stage) || typeof this.adapter.getLatestResult !== "function") {
      return null;
    }

    try {
      const recovered = await this.adapter.getLatestResult(member.agentId, {
        roomId,
        taskId: task.id,
        stageId: stage.id,
        stageType: stage.type,
        goal: task.goal,
        previousOutputs,
        roomContext,
        taskMessages,
        resumeInstruction: task.resumeInstruction || ""
      });
      if (!recovered) {
        return null;
      }
      const normalized = normalizeAgentResult(recovered);
      if (!isRelevantRecoveredSupervisorResult(normalized.summary, stage)) {
        return null;
      }
      await this.updateStageProgress({
        roomId,
        task,
        stage,
        type: "stage.result_received",
        label: "连接恢复后已读取总控最新输出，正在解析确认点。",
        detail: "TeamRoom 没有重发总控任务，而是优先使用执行后端会话中已返回的总控结果。"
      });
      return normalized;
    } catch {
      return null;
    }
  }

  async pauseForSupervisorConnectionRecovery({ roomId, task, stage, member, error }) {
    this.busyAgents.delete(member.agentId);
    await this.store.setMemberStatus(roomId, member.agentId, "idle");

    const confirmationPoint = {
      id: `CONN-GUARD-${stage.id}`,
      category: "连接恢复保护",
      question: "总控阶段运行时间较长且连接刚刚中断，TeamRoom 无法确认总控是否已经提出需要用户确认的问题。请先确认是否要重跑总控，避免把“未收到回复”误当成用户默认确认。",
      hint: `中断阶段：${stage.title}；错误：${error.message || "执行后端连接异常"}。建议先检查执行后端会话里是否已经出现总控确认点；如果有，请把确认结论发回 TeamRoom。`,
      options: [
        "我已确认没有遗漏的人工确认点，请重跑总控继续判断",
        "我已补充/确认必要信息，请总控基于本条回复继续判断"
      ]
    };

    stage.status = "queued";
    stage.error = error.message || "执行后端连接异常，已暂停等待人工确认。";
    stage.completedAt = null;
    stage.failedAt = null;
    stage.cancelledAt = null;
    task.status = "pending";
    task.error = null;
    task.pendingAt = nowIso();
    task.pendingStageId = stage.id;
    task.pendingReason = "总控连接恢复保护：等待用户确认后再继续，防止自动重连被误判为无回复。";
    task.confirmationPoints = [confirmationPoint];
    task.connectionRecoveryGuard = {
      stageId: stage.id,
      error: error.message || "执行后端连接异常",
      createdAt: nowIso()
    };
    await this.store.updateTask(task);
    await this.events.publish(roomId, "task.pending", {
      taskId: task.id,
      reason: task.pendingReason,
      confirmationPoints: task.confirmationPoints,
      summary: "总控连接中断保护已触发，TeamRoom 已暂停自动续接。"
    });
  }

  async markTaskDelivered({ roomId, task, stage, deliveryDecision }) {
    const deliveredAt = nowIso();
    task.deliveredAt = deliveredAt;
    task.status = deliveryDecision.backgroundAuditRequired ? "auditing" : "delivered";
    task.delivery = {
      summary: deliveryDecision.summary,
      changedArtifacts: deliveryDecision.changedArtifacts || [],
      risks: deliveryDecision.risks || [],
      nextSteps: deliveryDecision.nextSteps || [],
      backgroundAuditRequired: deliveryDecision.backgroundAuditRequired,
      sourceStageId: stage.id
    };
    task.pendingAt = null;
    task.pendingReason = null;
    task.pendingStageId = null;
    task.confirmationPoints = [];
    task.error = null;
    await this.store.updateTask(task);
    await this.events.publish(roomId, "task.delivered", {
      taskId: task.id,
      deliveredAt,
      summary: deliveryDecision.summary,
      changedArtifacts: deliveryDecision.changedArtifacts || [],
      risks: deliveryDecision.risks || [],
      nextSteps: deliveryDecision.nextSteps || [],
      backgroundAuditRequired: deliveryDecision.backgroundAuditRequired
    });
  }

  async scheduleAutoRetry({ roomId, task, stage, member, error }) {
    if (!isRecoverableOpenClawError(error)) {
      return false;
    }
    const retryCount = Number(stage.autoRetryCount || 0);
    if (retryCount >= this.autoRetryMaxAttempts) {
      return false;
    }

    const attempt = retryCount + 1;
    const retryAt = new Date(Date.now() + this.autoRetryDelayMs).toISOString();
    this.busyAgents.delete(member.agentId);
    await this.store.setMemberStatus(roomId, member.agentId, "idle");

    if (typeof this.adapter.resetConnection === "function") {
      await this.adapter.resetConnection().catch(() => {});
    }

    stage.status = "queued";
    stage.error = error.message;
    stage.completedAt = null;
    stage.failedAt = null;
    stage.cancelledAt = null;
    stage.autoRetryCount = attempt;
    stage.retryAt = retryAt;
    task.status = "retrying";
    task.error = error.message;
    task.retryAt = retryAt;
    task.retryReason = error.message;
    await this.store.updateTask(task);
    await this.events.publish(roomId, "task.retry_scheduled", {
      taskId: task.id,
      stageId: stage.id,
      agentId: member.agentId,
      title: stage.title,
      error: error.message,
      attempt,
      maxAttempts: this.autoRetryMaxAttempts,
      delayMs: this.autoRetryDelayMs,
      retryAt
    });

    await sleep(this.autoRetryDelayMs);
    const latest = await this.store.getTask(task.id);
    if (!latest || latest.status === "cancelled" || latest.cancelRequested) {
      return true;
    }
    if (latest.status === "pending" && !isInternalOnlyPendingTask(latest)) {
      return true;
    }
    Object.assign(task, latest);
    task.status = "running";
    task.retryAt = null;
    task.retryReason = null;
    const latestStage = task.stages.find((item) => item.id === stage.id);
    if (latestStage) {
      Object.assign(stage, latestStage);
      stage.retryAt = null;
    }
    await this.store.updateTask(task);
    return true;
  }

  async autoContinueSpecialistStage({ roomId, task, stage, member, result }) {
    const attempt = Number(stage.internalContinueCount || 0) + 1;
    if (attempt > 2) {
      return false;
    }

    this.busyAgents.delete(member.agentId);
    await this.store.setMemberStatus(roomId, member.agentId, "idle");
    stage.status = "queued";
    stage.error = "子 Agent 等待内部总控确认，TeamRoom 已自动下发继续执行指令。";
    stage.completedAt = null;
    stage.failedAt = null;
    stage.cancelledAt = null;
    stage.result = result;
    stage.internalContinueCount = attempt;
    stage.continueInstruction = [
      "总控已授权你执行当前阶段，不需要等待额外的总控确认。",
      "请不要只回复“已准备好”或“等待确认”。",
      "如果当前阶段要求检查、校验、写入或给出修改建议，请现在直接完成该专业工作。",
      "只有存在必须由 BA、业务方或用户做业务决策/事实补充的问题时，才列出人工确认点。"
    ].join("\n");
    stage.progress = {
      label: "检测到 Agent 正在等待内部确认，已自动补发继续执行指令。",
      detail: stage.continueInstruction,
      updatedAt: nowIso()
    };
    await this.store.updateTask(task);
    await this.events.publish(roomId, "stage.auto_continue", {
      taskId: task.id,
      stageId: stage.id,
      agentId: member.agentId,
      title: stage.title,
      attempt,
      reason: stage.error
    });
    return true;
  }

  async updateStageProgress({ roomId, task, stage, type = "stage.progress", label, detail = "", streamSegment = null }) {
    stage.progress = {
      label,
      detail,
      streamSegment,
      updatedAt: nowIso()
    };
    await this.store.updateTask(task);
    await this.events.publish(roomId, type, {
      taskId: task.id,
      stageId: stage.id,
      agentId: stage.assignedAgentId,
      title: stage.title,
      status: stage.status,
      label,
      detail,
      streamSegment
    });
  }

  internalWaitDelayForAttempt(attempt) {
    const index = Math.max(0, Number(attempt || 1) - 1);
    return this.internalWaitBackoffMs[Math.min(index, this.internalWaitBackoffMs.length - 1)];
  }

  async scheduleInternalWait({ roomId, task, stage, member, reason, waitingPoints = [] }) {
    const waitCount = Number(stage.internalWaitCount || 0);
    if (waitCount >= this.internalWaitMaxAttempts) {
      throw new Error("总控多次反馈仍在等待内部 Agent 返回，已停止自动等待。请检查执行后端中对应 Agent 的状态。");
    }

    const attempt = waitCount + 1;
    const delayMs = this.internalWaitDelayForAttempt(attempt);
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.busyAgents.delete(member.agentId);
    await this.store.setMemberStatus(roomId, member.agentId, "idle");

    stage.status = "queued";
    stage.result = null;
    stage.error = null;
    stage.completedAt = null;
    stage.failedAt = null;
    stage.cancelledAt = null;
    stage.internalWaitCount = attempt;
    stage.retryAt = retryAt;
    task.status = "retrying";
    task.error = null;
    task.retryAt = retryAt;
    task.retryReason = reason || "等待内部 Agent 返回结果。";
    await this.store.updateTask(task);
    await this.events.publish(roomId, "task.wait_scheduled", {
      taskId: task.id,
      stageId: stage.id,
      agentId: member.agentId,
      title: stage.title,
      reason: task.retryReason,
      waitingPoints,
      attempt,
      maxAttempts: this.internalWaitMaxAttempts,
      delayMs,
      retryAt
    });

    await sleep(delayMs);
    const latest = await this.store.getTask(task.id);
    if (!latest || latest.status === "cancelled" || latest.cancelRequested) {
      return true;
    }
    if (latest.status === "pending" && !isInternalOnlyPendingTask(latest)) {
      return true;
    }
    Object.assign(task, latest);
    task.status = "running";
    task.retryAt = null;
    task.retryReason = null;
    const latestStage = task.stages.find((item) => item.id === stage.id);
    if (latestStage) {
      Object.assign(stage, latestStage);
      stage.retryAt = null;
    }
    await this.store.updateTask(task);
    return true;
  }

  async failTask(taskId, error) {
    const task = await this.store.getTask(taskId);
    if (!task) {
      return;
    }
    task.status = "failed";
    task.failedAt = nowIso();
    task.error = error.message;
    const runningStage = task.stages?.find((stage) => stage.status === "running");
    if (runningStage) {
      runningStage.status = "failed";
      runningStage.failedAt = runningStage.failedAt || task.failedAt;
      runningStage.error = error.message;
      if (runningStage.assignedAgentId) {
        this.busyAgents.delete(runningStage.assignedAgentId);
        await this.store.setMemberStatus(task.roomId, runningStage.assignedAgentId, "failed");
      }
    }
    await this.store.updateTask(task);
    await this.events.publish(task.roomId, "task.failed", {
      taskId,
      error: error.message
    });
  }

  async buildRoomContext(roomId, currentTaskId, policy = {}) {
    const limit = normalizePolicy(policy).roomContextLimit;
    if (limit <= 0) {
      return [];
    }
    const tasks = await this.store.listTasks(roomId);
    return tasks
      .filter((item) => item.id !== currentTaskId && item.status === "completed")
      .slice(0, limit)
      .reverse()
      .map((item) => {
        const finalStage = [...(item.stages || [])].reverse().find((stage) => stage.result?.summary);
        return {
          taskId: item.id,
          goal: item.goal,
          completedAt: item.completedAt || item.updatedAt,
          summary: finalStage?.result?.summary || "No summary captured."
        };
      });
  }

  async buildTaskMessages(roomId, taskId, policy = {}) {
    const limit = normalizePolicy(policy).taskMessageLimit;
    if (limit <= 0) {
      return [];
    }
    const events = await this.store.listEvents(roomId, 200);
    return events
      .filter((event) => event.type === "message.created")
      .filter((event) => !event.payload?.taskId || event.payload.taskId === taskId)
      .slice(-limit)
      .map((event) => ({
        author: event.payload?.author || "human",
        content: event.payload?.content || "",
        timestamp: event.timestamp
      }));
  }
}

function buildAgentInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages }) {
  if (stage.type === "supervisor_dispatch") {
    return buildSupervisorDispatchInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }
  if (stage.type === "supervisor_chat") {
    return buildSupervisorConversationInput({ room, task, member, roomContext, taskMessages });
  }
  if (stage.type === "specialist_work") {
    return buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }
  if (stage.type === "supervisor_review") {
    return buildSupervisorReviewInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }
  if (stage.type === "background_audit") {
    return buildBackgroundAuditInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }

  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({ room, task, stage, member, previousOutputs, roomContext, taskMessages, policy, templates });
  return [
    `You are ${member.name || member.agentId}, participating in TeamRoom through the configured execution backend.`,
    `Room: ${room.name}`,
    `Room members: ${formatRoomMembers(room.members || [])}`,
    "Shared room context:",
    values.roomContext,
    "",
    "Human collaboration messages for the current task:",
    values.taskMessages,
    values.resumeInstruction,
    "",
    `Goal: ${task.goal}`,
    `Current stage: ${stage.title} (${stage.type})`,
    `Stage needs: ${(stage.needs || []).join(", ")}`,
    "You own this stage. Build on previous outputs from other agents and hand off useful context to the next agent.",
    "",
    "Previous stage outputs:",
    values.previousOutputs,
    "",
    "Return a concise result with: status, summary, artifacts, and next_actions."
  ].join("\n");
}

function formatRoomMembers(members) {
  return members
    .map((item) => {
      const tags = [...(item.roles || []), ...(item.capabilities || [])].filter(Boolean);
      return `- ${item.name || item.agentId} (${item.agentId})${tags.length ? `: ${tags.join(", ")}` : ""}`;
    })
    .join("\n");
}

function normalizeAgentResult(result) {
  if (!result) {
    return {
      status: "completed",
      summary: "Agent returned no content.",
      artifacts: [],
      nextActions: []
    };
  }
  if (typeof result === "string") {
    return {
      status: "completed",
      summary: result,
      artifacts: [],
      nextActions: []
    };
  }
  return {
    status: result.status || "completed",
    summary: result.summary || result.content || JSON.stringify(result),
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    nextActions: result.nextActions || result.next_actions || []
  };
}

function normalizeRuntimeApprovalRequest(request = {}) {
  const type = request.type === "question" ? "question" : "permission";
  if (type === "question") {
    return {
      type,
      externalId: request.id || request.requestId || "",
      sessionId: request.sessionId || request.sessionID || "",
      title: request.title || "OpenCode 请求人工回答",
      details: request.details || "",
      questions: normalizeRuntimeQuestions(request.questions || []),
      raw: request.raw || null
    };
  }

  return {
    type,
    externalId: request.id || request.requestId || "",
    sessionId: request.sessionId || request.sessionID || "",
    title: request.title || "OpenCode 请求执行确认",
    details: request.details || "",
    permission: request.permission || "",
    patterns: Array.isArray(request.patterns) ? request.patterns.map(String) : [],
    canAlwaysAllow: Boolean(request.canAlwaysAllow),
    tool: request.tool || null,
    raw: request.raw || null
  };
}

function normalizeRuntimeQuestions(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((question, index) => ({
      header: String(question.header || `问题 ${index + 1}`).trim(),
      question: String(question.question || question.header || "").trim(),
      options: (Array.isArray(question.options) ? question.options : [])
        .map((option, optionIndex) => ({
          label: String(option.label || option.value || optionIndex + 1).trim(),
          description: String(option.description || option.value || option.label || "").trim()
        }))
        .filter((option) => option.label || option.description),
      multiple: Boolean(question.multiple),
      custom: question.custom !== false
    }))
    .filter((question) => question.question || question.header);
}

function normalizeRuntimeApprovalResponse(approval, response = {}) {
  const message = String(response.message || response.reason || "").trim();
  if (approval.type === "question") {
    return {
      type: "question",
      reply: "once",
      answers: normalizeQuestionAnswerPayload(response.answers || response.answer || response.content),
      message
    };
  }

  const rawReply = String(response.reply || response.response || response.action || "").trim().toLowerCase();
  const reply = ({
    approve: "once",
    approved: "once",
    allow: "once",
    once: "once",
    yes: "once",
    always: "always",
    reject: "reject",
    deny: "reject",
    denied: "reject",
    no: "reject"
  })[rawReply] || (response.approved === false ? "reject" : "once");

  return {
    type: "permission",
    reply: ["once", "always", "reject"].includes(reply) ? reply : "once",
    message
  };
}

function normalizeQuestionAnswerPayload(value) {
  if (Array.isArray(value)) {
    return value.map((answer) => Array.isArray(answer)
      ? answer.map(String).filter(Boolean)
      : [String(answer)].filter(Boolean));
  }
  const text = String(value || "").trim();
  return text ? [[text]] : [];
}

function publicRuntimeApproval(approval) {
  return {
    id: approval.id,
    externalId: approval.externalId || "",
    type: approval.type,
    sessionId: approval.sessionId || "",
    taskId: approval.taskId,
    stageId: approval.stageId,
    agentId: approval.agentId,
    title: approval.title,
    details: approval.details || "",
    permission: approval.permission || "",
    patterns: approval.patterns || [],
    questions: approval.questions || [],
    canAlwaysAllow: Boolean(approval.canAlwaysAllow),
    tool: approval.tool || null,
    status: approval.status,
    response: approval.response || null,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt || null
  };
}

function buildSupervisorDispatchInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({
    room,
    task,
    member,
    previousOutputs,
    roomContext,
    taskMessages,
    policy,
    templates
  });
  const rendered = renderTemplate(templates.supervisorDispatch, {
    ...values,
    dispatchJsonContract: "",
    previousOutputs: dispatchPreviousOutputsNotice()
  });
  const relayGuardrails = rendered.includes("TeamRoom 只负责")
    ? ""
    : supervisorRelayGuardrails();
  return [
    rendered,
    relayGuardrails,
    values.dispatchJsonContract,
    stageSupervisorInstruction(stage)
  ].filter(Boolean).join("\n\n");
}

function buildSupervisorConversationInput({ room, task, member, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({
    room,
    task,
    member,
    previousOutputs: [],
    roomContext,
    taskMessages,
    policy,
    templates
  });
  return [
    `你是 ${member.name || member.agentId}，在 TeamRoom 中担任 Supervisor / 总控 Agent。`,
    "当前不是实施执行任务，而是用户发起的复盘、解释、讨论或普通对话。",
    "",
    "边界:",
    "- 不要启动标准实施 SOP。",
    "- 不要输出 TEAMROOM_DISPATCH_JSON、TEAMROOM_REVIEW_JSON、TEAMROOM_DELIVERY_JSON 或 TEAMROOM_AUDIT_JSON。",
    "- 不要派发子 Agent，不要做 ssot_workspace_manager snapshot/bootstrap，不要进入最终审核。",
    "- 只基于已有上下文和你的判断，给出清晰、可操作的对话式回答。",
    "",
    "协作室共享上下文（仅供必要时参考）:",
    values.roomContext,
    "",
    "当前任务的人类补充/干预消息:",
    values.taskMessages,
    "",
    `用户想讨论的问题: ${task.goal}`,
    "",
    "请直接回答用户的问题。"
  ].join("\n");
}

function buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const relayContext = buildSpecialistRelayContext({
    task,
    stage,
    previousOutputs
  });
  const rendered = [
    `你是 ${member.name || member.agentId}，在 TeamRoom 中担任专业子 Agent。`,
    "TeamRoom 轻量中转说明:",
    "- 你不会收到总控完整 SOP、协作室长历史或用户原始长文本。",
    "- 总控已经完成需求解析、派发前判断和标准 Payload 组装；你只按本轮 A2A Payload 执行。",
    "- 如需背景，只参考下面的需求解析摘要和上一个子 Agent 结果摘要。",
    "",
    `当前阶段: ${stage.title || "专业执行"}`,
    `派工理由: ${stage.reason || "总控要求执行本轮专业任务。"}`,
    "",
    "需求解析结果:",
    relayContext.demandAnalysis,
    "",
    "上一个子 Agent 结果摘要:",
    relayContext.previousSpecialistSummary,
    "",
    "输出要求:",
    "- 直接完成 Payload 指定的检查、校验、写入或修改建议。",
    "- 不要等待总控二次确认，不要只回复“已准备好”。",
    "- 只有缺口必须由 BA、业务方或用户做业务决策/事实补充时，才返回 NEED_INFO。",
    "- 执行冲突返回 ERROR / CONFLICT，并说明冲突对象、文件位置和建议处理方式。",
    "- 如果与你的专业范围无关，明确说明“无影响”，不要扩展猜测。",
    policy.specialistExtraPrompt ? `\n协作室自定义子 Agent 指导:\n${policy.specialistExtraPrompt}` : ""
  ].filter(Boolean).join("\n");
  return [
    rendered,
    stage.a2aPayload ? standardA2aPayloadBlock(stage.a2aPayload) : "",
    specialistExecutionGuardrails({
      rendered,
      hasA2aPayload: Boolean(stage.a2aPayload)
    }),
    stage.continueInstruction ? `内部继续指令:\n${stage.continueInstruction}` : ""
  ].filter(Boolean).join("\n\n");
}

function buildSupervisorReviewInput({ room, task, member, previousOutputs, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({
    room,
    task,
    member,
    previousOutputs,
    roomContext,
    taskMessages,
    policy,
    templates
  });
  return [
    renderTemplate(templates.supervisorReview, {
      ...values,
      reviewJsonContract: ""
    }),
    supervisorRelayGuardrails(),
    values.reviewJsonContract
  ].filter(Boolean).join("\n\n");
}

function buildBackgroundAuditInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({
    room,
    task,
    stage,
    member,
    previousOutputs,
    roomContext,
    taskMessages,
    policy,
    templates
  });
  return [
    `你是 ${member.name || member.agentId}，正在执行 TeamRoom 后台闭环审计阶段。`,
    "注意: 用户可见结论已经先交付，TeamRoom 已停止用户等待计时。你现在不要重复长篇最终结论，只执行 Step 7 的后台事项。",
    "",
    `原始目标: ${task.goal}`,
    "已交付结论:",
    JSON.stringify(task.delivery || {}, null, 2),
    "",
    "前序阶段工作记忆:",
    values.previousOutputs,
    "",
    "后台审计要求:",
    "- 调用 closure_sync_reporter 或按你的 SOP 完成记忆同步: MEMORY.md、memory/流水账.md、memory/执行日志.md。",
    "- 遍历 opencode_foxagent/working/ 作为 SSOT，聚合最新交付件。",
    "- 校验已交付结论与物理交付件是否一致。",
    "- 如果发现需要用户决策、确认或补救的问题，返回 status: \"pending\" 或 \"audit_alert\"，并填写 confirmation_points。",
    "- 如果没有问题，返回 status: \"completed\"，confirmation_points 为空。",
    "",
    "请在回答末尾包含机器可读 JSON:",
    "TEAMROOM_AUDIT_JSON_START",
    JSON.stringify({
      status: "completed",
      summary: "后台审计完成，未发现需要用户处理的问题。",
      confirmation_points: [],
      risks: [],
      changed_artifacts: []
    }, null, 2),
    "TEAMROOM_AUDIT_JSON_END"
  ].join("\n");
}

function supervisorRelayGuardrails() {
  return [
    "TEAMROOM_EXECUTION_MODE=relay",
    "TeamRoom 边界:",
    "- TeamRoom 只做中转、分发、等待、可视化和超时续接；不替代你的 SOP 判断。",
    "- 你必须按自己的标准 SOP 完成解析、Probe、Assessment、Pre-Dispatch Validation、ssot_workspace_manager bootstrap/snapshot、反馈分诊、联动检查和闭环审计。",
    "- 需要用户确认时，只输出 confirmation_points，TeamRoom 会暂停并转给用户。",
    "- 需要子 Agent 执行时，输出目标 agent 和 a2a_payload；TeamRoom 只按目标 agent 中转，不替你校验 payload。",
    "- 禁止在 TeamRoom 任务中直接调用 OpenCode Task/subagent 或 OpenClaw A2A/sessions_spawn；TeamRoom 已经承担跨 Agent 中转职责。",
    "- snapshot / payload 校验 / 操作兼容性握手仍由你自己的 SOP 负责；失败时请返回 pending 或 waiting。"
  ].join("\n");
}

function stageSupervisorInstruction(stage = {}) {
  if (!stage?.goal && !stage?.reason) {
    return "";
  }
  return [
    "当前 TeamRoom 对总控的续接指令:",
    stage.goal || "",
    stage.reason ? `原因: ${stage.reason}` : ""
  ].filter(Boolean).join("\n");
}

function standardA2aPayloadBlock(payload) {
  return [
    "总控标准 A2A Payload:",
    "A2A_PAYLOAD_START",
    JSON.stringify(payload, null, 2),
    "A2A_PAYLOAD_END"
  ].join("\n");
}

function specialistExecutionGuardrails({ rendered = "", hasA2aPayload = false } = {}) {
  const lines = [];
  if (!/(不要再等待总控确认|不要只回复)/.test(rendered)) {
    lines.push("- 已获总控内部授权；不要只回复“已准备好”或等待二次确认。");
  }
  if (hasA2aPayload) {
    lines.push("- 只按 A2A_PAYLOAD 执行；target_uri 是唯一写入目标，params 是唯一业务参数来源。");
    lines.push("- 信息缺口返回 NEED_INFO；冲突返回 ERROR / CONFLICT，并交回总控分诊。");
  }
  return lines.length ? ["TeamRoom 执行规则:", ...lines].join("\n") : "";
}

function buildSpecialistRelayContext({ task, stage, previousOutputs = [] }) {
  return {
    demandAnalysis: summarizeDemandAnalysisForSpecialist({ task, stage, previousOutputs }),
    previousSpecialistSummary: summarizePreviousSpecialistForSpecialist({ previousOutputs })
  };
}

function summarizeDemandAnalysisForSpecialist({ task, stage, previousOutputs = [] }) {
  const reversedOutputs = [...previousOutputs].reverse();
  const supervisorOutput = reversedOutputs.find(isSupervisorDispatchOutput) || reversedOutputs.find(isSupervisorOutput);
  const summary = supervisorOutput?.result?.summary || "";
  const parsed = parseDispatchJson(summary) || parseReviewJson(summary);
  const lines = [];
  if (parsed?.summary) {
    lines.push(`- 总控结论: ${truncatePromptText(parsed.summary, 360)}`);
  }
  const requirementAnalysis = firstStructuredValue(
    parsed?.requirement_analysis,
    parsed?.requirementAnalysis,
    parsed?.demand_analysis,
    parsed?.demandAnalysis,
    parsed?.parsed_requirement,
    parsed?.parsedRequirement,
    parsed?.business_logic,
    parsed?.businessLogic,
    parsed?.extracted_logic,
    parsed?.extractedLogic
  );
  if (requirementAnalysis) {
    lines.push(`- Step 1 需求解析: ${truncatePromptText(requirementAnalysis, 900)}`);
  }
  const sopStatus = parsed?.sop_status || parsed?.sopStatus;
  if (sopStatus && typeof sopStatus === "object" && !Array.isArray(sopStatus)) {
    const statusLine = Object.entries(sopStatus)
      .filter(([, value]) => value != null && value !== "")
      .slice(0, 8)
      .map(([key, value]) => `${key}=${formatCompactValue(value)}`)
      .join("；");
    if (statusLine) {
      lines.push(`- SOP 状态: ${statusLine}`);
    }
  }
  const payload = stage.a2aPayload || {};
  if (payload.action) {
    lines.push(`- 本轮动作: ${payload.action}`);
  }
  if (payload.workspace_context?.target_uri) {
    lines.push(`- 目标文件: ${payload.workspace_context.target_uri}`);
  }
  if (Array.isArray(payload.workspace_context?.input_references) && payload.workspace_context.input_references.length) {
    lines.push(`- 输入引用: ${payload.workspace_context.input_references.join("；")}`);
  }
  if (payload.params && typeof payload.params === "object") {
    lines.push(`- 业务参数: ${truncatePromptText(JSON.stringify(payload.params), 700)}`);
  }
  if (!lines.length && summary) {
    lines.push(`- 总控摘要: ${truncatePromptText(stripTeamRoomJsonBlocks(summary), 700)}`);
  }
  if (!lines.length) {
    lines.push(`- 任务目标: ${truncatePromptText(task.goal, 360)}`);
  }
  return lines.join("\n");
}

function firstStructuredValue(...values) {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }
  return "";
}

function isSupervisorDispatchOutput(item = {}) {
  const title = String(item.title || "").toLowerCase();
  return isSupervisorOutput(item) && (title.includes("dispatch") || title.includes("派发") || title.includes("分发"));
}

function summarizePreviousSpecialistForSpecialist({ previousOutputs = [] }) {
  const specialistOutput = [...previousOutputs]
    .reverse()
    .find((item) => !isSupervisorOutput(item));
  if (!specialistOutput) {
    return "- 无；这是本轮第一位专业子 Agent，直接按 Payload 执行。";
  }
  const snapshot = createStageMemorySnapshot(specialistOutput);
  const lines = [
    `- ${snapshot.agentId} / ${snapshot.title} / ${snapshot.status}: ${snapshot.summary || "无摘要"}`
  ];
  if (snapshot.artifacts.length) {
    lines.push(`  artifacts: ${snapshot.artifacts.join("；")}`);
  }
  if (snapshot.nextActions.length) {
    lines.push(`  next_actions: ${snapshot.nextActions.join("；")}`);
  }
  return lines.join("\n");
}

function buildPromptValues({ room, task, stage = {}, member, previousOutputs, roomContext, taskMessages, policy, templates }) {
  return {
    agentId: member.agentId,
    agentName: member.name || member.agentId,
    roomName: room.name,
    roomMembers: formatRoomMembers(room.members || []),
    goal: task.goal,
    memberRoles: (member.roles || []).join(", ") || "none",
    memberCapabilities: (member.capabilities || []).join(", ") || "general",
    roomContext: formatRoomContext(roomContext, templates),
    taskMessages: formatTaskMessages(taskMessages, templates, {
      omitContent: task.resumeInstruction
    }),
    previousOutputs: formatPreviousOutputs(previousOutputs, templates),
    stageTitle: stage.title || "",
    stageType: stage.type || "",
    stageGoal: stage.goal || stage.title || "",
    stageNeeds: (stage.needs || []).join(", ") || "general",
    stageReason: stage.reason || "未指定。",
    resumeInstruction: task.resumeInstruction ? `续跑指令: ${task.resumeInstruction}` : "",
    dispatchJsonContract: dispatchJsonContract(),
    reviewJsonContract: reviewJsonContract(),
    supervisorExtraPrompt: policy.supervisorExtraPrompt ? `协作室自定义总控指导:\n${policy.supervisorExtraPrompt}` : "",
    specialistExtraPrompt: policy.specialistExtraPrompt ? `协作室自定义子 Agent 指导:\n${policy.specialistExtraPrompt}` : "",
    reviewExtraPrompt: policy.reviewExtraPrompt ? `协作室自定义复核指导:\n${policy.reviewExtraPrompt}` : "",
    fallbackWarning: policy.fallbackDispatch === "none"
      ? "注意: 如果你不输出可解析 JSON，TeamRoom 不会兜底安排任何子 agent。"
      : ""
  };
}

function reviewJsonContract() {
  return [
    "重要输出要求:",
    "- 你是总控 Agent。这里不是 TeamRoom 替你做最终总结，而是 TeamRoom 把用户补充或子 Agent 回传交还给你继续执行 SOP。",
    "- 请先按 SOP 做反馈分诊: SUCCESS 进入联动检查；NEED_INFO 翻译成业务问题；ERROR / CONFLICT 翻译成用户决策点。",
    "- 如果还要继续派发子 Agent，请把 status 设为 followup，并在 followup_subtasks 中提供标准 a2a_payload。",
    "- 只有当最终结论中存在必须由 BA、业务方、用户或人工做业务决策/事实补充的信息缺口时，任务才进入人工确认。",
    "- 这种情况下请把 status 设为 pending，并只把人类可回答的问题写入 confirmation_points。",
    "- confirmation_points 可以是字符串数组，也可以是对象数组；对象格式为 { question, hint, options }。",
    "- 不要把内部流程状态写入 confirmation_points，例如: 等待某个 agent 返回、某个 agent 正在执行、验证未结束、后续需要派发 form_agent / permission_agent。",
    "- followup_subtasks 的每一项格式为: { agent_id, title, reason, a2a_payload }；agent_id 必须来自协作室成员，a2a_payload 必须符合标准 Payload。",
    "- 如果只是内部 agent 尚未返回或需要继续观察，请把 status 设为 waiting，confirmation_points 为空数组，TeamRoom 会自动继续复核。",
    "- 如果已经形成可交付给用户的结论，但 Step 7 记忆同步/资产聚合/一致性校验还要继续，请先输出 TEAMROOM_DELIVERY_JSON；TeamRoom 会立即交付并停止用户等待计时，然后安排后台审计。",
    "- 如果全部 SOP 闭环完成，请把 status 设为 completed，confirmation_points 为空数组，并输出交付件清单。",
    "",
    "先交付结论 JSON（可选；一旦输出，TeamRoom 会先交付给用户）:",
    "TEAMROOM_DELIVERY_JSON_START",
    JSON.stringify({
      status: "delivered",
      summary: "面向用户的可交付结论摘要",
      changed_artifacts: [],
      risks: [],
      next_steps: [],
      background_audit_required: true
    }, null, 2),
    "TEAMROOM_DELIVERY_JSON_END",
    "",
    "请在回答末尾包含下面这个机器可读 JSON 块，TeamRoom 会据此判断任务是否完成:",
    "TEAMROOM_REVIEW_JSON_START",
    JSON.stringify({
      status: "completed",
      summary: "一句话最终审核结论",
      confirmation_points: [],
      followup_subtasks: [],
      closure: {
        changed_artifacts: [],
        risks: [],
        next_steps: []
      }
    }, null, 2),
    "TEAMROOM_REVIEW_JSON_END"
  ].join("\n");
}

function dispatchJsonContract() {
  return [
    "重要约束:",
    "- TeamRoom 只负责中转分发、等待续接和可视化，业务拆题权、SOP 执行权、Payload 组装权都在你这里。",
    "- 你必须先按标准 SOP 完成 Step 1-3.2: 解析、probe_context_sync、blueprint_risk_evaluator、三问原则、Pre-Dispatch Validation、ssot_workspace_manager bootstrap/snapshot。",
    "- snapshot 失败、Payload 校验失败、操作兼容性握手失败时，严禁派发子 Agent。",
    "- 只从上面的可调度成员中选择 agent_id；不要为了热闹而安排无关 agent。",
    "- 如果需要用户补充或决策，请返回 status: \"pending\" 且写入 confirmation_points；只要 confirmation_points 非空，TeamRoom 会暂停并转给用户。",
    "- 如果你仍在执行内部 SOP 或等待执行后端内部结果，请返回 status: \"waiting\" 且 confirmation_points: []，TeamRoom 会低频续接。",
    "- 如果要派发子 Agent，请返回 status: \"dispatch\"、dispatch_ready: true，并为每个 subtask 提供标准 a2a_payload。",
    "- TeamRoom 不校验 a2a_payload 内容；只根据 subtask.agent_id / agentId / target_agent 找到目标 agent 后中转。",
    "- 不要直接调用 OpenCode Task/subagent 或 OpenClaw A2A/sessions_spawn；你只输出 TEAMROOM_DISPATCH_JSON，TeamRoom 负责把 payload 转给子 Agent。",
    "- workspace_context.input_references 是可选的输入材料引用；如果没有独立的原始需求文件，可以填 []，不要因此停下来补流程。",
    "- 子 Agent 只会收到 a2a_payload；不要把大段用户原文放入 params，不要让子 Agent 自行猜测。",
    "- 为了降低子 Agent 上下文长度，请在 requirement_analysis 中保留 Step 1 需求解析结果；TeamRoom 转发给子 Agent 时只保留 requirement_analysis、最近一个子 Agent 结果摘要和本轮 a2a_payload。",
    "- 如果不需要任何子 Agent 且 SOP 已闭环，请返回 status: \"completed\"。",
    "",
    "标准 a2a_payload 结构必须包含:",
    JSON.stringify({
      task_id: "FA-YYYYMMDD-SEQ",
      session_id: "UUID",
      iteration: 1,
      action: "dispatch-orchestrator action_type",
      target_agent: "dim-model-agent | form-agent | auth-agent",
      workspace_context: {
        input_references: ["opencode_foxagent/input/原需求文件名"],
        target_uri: "opencode_foxagent/working/目标编辑文件名.xlsx"
      },
      params: {
        example: "剥离后的线性或隐性规则参数"
      },
      error_handle: "CALLBACK_TO_MASTER"
    }, null, 2),
    "",
    "请在回答中包含下面这个机器可读 JSON 块，TeamRoom 会据此中转:",
    "TEAMROOM_DISPATCH_JSON_START",
    JSON.stringify({
      status: "dispatch",
      summary: "一句话说明 SOP 当前结论和影响范围",
      requirement_analysis: {
        objects: ["从需求中提取的业务对象"],
        actions: ["需要执行的动作"],
        rules: ["线性规则或隐性关联"],
        confirmed_params: ["已确认参数"],
        missing_params: []
      },
      dispatch_ready: true,
      sop_status: {
        task_level: "L1|L2|L3",
        probe: "GREEN|YELLOW|RED",
        confidence: 95,
        pre_dispatch_validation: "PASS",
        snapshot: "PASS",
        strategy_report: "已输出"
      },
      subtasks: [
        {
          agent_id: "dim_model_agent",
          title: "维度与模型影响分析",
          reason: "为什么需要该 agent 参与",
          a2a_payload: {
            task_id: "FA-YYYYMMDD-001",
            session_id: "UUID",
            iteration: 1,
            action: "ADD_DIM_MEMBER",
            target_agent: "dim_model_agent",
            workspace_context: {
              input_references: ["opencode_foxagent/input/需求文件.md"],
              target_uri: "opencode_foxagent/working/维度交付件.xlsx"
            },
            params: {
              member_name: "示例成员",
              parent: "示例父项"
            },
            error_handle: "CALLBACK_TO_MASTER"
          }
        }
      ],
      confirmation_points: []
    }, null, 2),
    "TEAMROOM_DISPATCH_JSON_END"
  ].join("\n");
}

function formatRoomContext(roomContext = [], templates = {}) {
  if (!roomContext.length) {
    return "- 暂无历史任务上下文。";
  }
  return roomContext.map((item, index) => renderTemplate(templates.roomContextItem, {
    index: index + 1,
    goal: truncatePromptText(item.goal, 180),
    status: item.status || "completed",
    completedAt: item.completedAt || "",
    summary: truncatePromptText(item.summary || "", 500)
  })).join("\n\n");
}

function dispatchPreviousOutputsNotice() {
  return "- Dispatch 阶段不注入完整阶段输出；子 Agent 回传由 Supervisor Review 阶段交还总控分诊。";
}

function formatTaskMessages(taskMessages = [], templates = {}, options = {}) {
  const omitContent = normalizeComparableText(options.omitContent || "");
  const filteredMessages = omitContent
    ? taskMessages.filter((item) => normalizeComparableText(item.content || "") !== omitContent)
    : taskMessages;
  if (!filteredMessages.length) {
    return "- 暂无。";
  }
  const memory = compactTaskMessages(filteredMessages);
  const sections = [];
  if (memory.confirmedFacts.length) {
    sections.push([
      "当前有效人工确认:",
      ...memory.confirmedFacts.map((item) => `- ${item.key}: ${item.answer}`)
    ].join("\n"));
  }
  if (memory.recentMessages.length) {
    sections.push([
      "其他补充/干预（最近）:",
      ...memory.recentMessages.map((item) => renderTemplate(templates.taskMessageItem, {
        timestamp: item.timestamp || "",
        author: item.author || "human",
        content: truncatePromptText(item.content || "", 600)
      }))
    ].join("\n"));
  }
  return sections.length ? sections.join("\n\n") : "- 暂无。";
}

function normalizeComparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactTaskMessages(messages = []) {
  const confirmedByKey = new Map();
  const freeform = [];
  for (const item of messages) {
    const content = String(item.content || "").trim();
    if (!content) {
      continue;
    }
    const facts = extractConfirmedFacts(content);
    if (facts.length) {
      for (const fact of facts) {
        confirmedByKey.set(normalizeConfirmationKey(fact.key), {
          key: truncatePromptText(fact.key, 180),
          answer: truncatePromptText(fact.answer, 320)
        });
      }
    } else {
      freeform.push(item);
    }
  }
  return {
    confirmedFacts: [...confirmedByKey.values()].slice(-12),
    recentMessages: freeform.slice(-3)
  };
}

function extractConfirmedFacts(content) {
  const text = String(content || "");
  if (!/人工确认结果|确认结果|补充说明/.test(text)) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*]\s*)?(?:\d+|[A-Za-z0-9_-]+)[.、]\s*(.+?)[:：]\s*(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      key: match[1].trim(),
      answer: match[2].trim()
    }))
    .filter((item) => item.key && item.answer);
}

function normalizeConfirmationKey(value) {
  return normalizeComparableText(value)
    .replace(/[。？?：:，,；;]/g, "")
    .slice(0, 120);
}

function formatPreviousOutputs(previousOutputs = [], templates = {}) {
  if (!previousOutputs.length) {
    return "- 无。";
  }
  return formatWorkingMemory(previousOutputs);
}

function formatWorkingMemory(previousOutputs = []) {
  const byAgent = new Map();
  const latestSupervisor = [];
  for (const item of previousOutputs) {
    const agentId = item.agentId || "unknown";
    const snapshot = createStageMemorySnapshot(item);
    if (isSupervisorOutput(item)) {
      latestSupervisor.push(snapshot);
    } else {
      byAgent.set(agentId, snapshot);
    }
  }

  const sections = [];
  const agentStates = [...byAgent.values()];
  if (agentStates.length) {
    sections.push([
      "各子 Agent 最新状态（同一 Agent 仅保留最近一次）:",
      ...agentStates.map(formatStageMemorySnapshot)
    ].join("\n"));
  }
  const supervisorStates = latestSupervisor.slice(-2);
  if (supervisorStates.length) {
    sections.push([
      "总控最近续接状态:",
      ...supervisorStates.map(formatStageMemorySnapshot)
    ].join("\n"));
  }
  return sections.length ? sections.join("\n\n") : "- 无。";
}

function createStageMemorySnapshot(item = {}) {
  const result = item.result || {};
  return {
    stageId: item.stageId || "",
    title: item.title || "Stage Output",
    agentId: item.agentId || "unknown",
    status: result.status || "completed",
    summary: truncatePromptText(result.summary || "", 900),
    artifacts: Array.isArray(result.artifacts) ? result.artifacts.slice(0, 5).map(formatCompactValue) : [],
    nextActions: Array.isArray(result.nextActions) ? result.nextActions.slice(0, 5).map(formatCompactValue) : []
  };
}

function formatStageMemorySnapshot(item) {
  const lines = [
    `- ${item.agentId} / ${item.title} / ${item.status}: ${item.summary || "无摘要"}`
  ];
  if (item.artifacts.length) {
    lines.push(`  artifacts: ${item.artifacts.join("；")}`);
  }
  if (item.nextActions.length) {
    lines.push(`  next_actions: ${item.nextActions.join("；")}`);
  }
  return lines.join("\n");
}

function isSupervisorOutput(item = {}) {
  const title = String(item.title || "").toLowerCase();
  const agentId = String(item.agentId || "").toLowerCase();
  return title.includes("supervisor") || /supervisor|总控/.test(agentId);
}

function formatCompactValue(value) {
  if (typeof value === "string") {
    return truncatePromptText(value, 180);
  }
  if (value && typeof value === "object") {
    return truncatePromptText(JSON.stringify(value), 180);
  }
  return truncatePromptText(String(value ?? ""), 180);
}

function truncatePromptText(value, maxLength = 1000) {
  const text = String(value || "").replace(/\s+\n/g, "\n").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[已截断 ${text.length - maxLength} 字]`;
}

function createSupervisorFollowUpStages({ room, task, dispatchStage, policy }) {
  const supervisor = findSupervisorMember(room.members || []);
  const dispatch = parseDispatchPlan(dispatchStage.result?.summary || "");
  const members = room.members || [];
  const normalizedSubtasks = (dispatch.subtasks || [])
    .map((subtask, index) => normalizeSubtask(subtask, index))
    .map((subtask) => ({
      ...subtask,
      assignedAgentId: resolveSubtaskAgentId(subtask, members)
    }))
    .filter((subtask) => subtask.assignedAgentId);

  const workItems = dispatch.parsed ? normalizedSubtasks : [];
  if (!workItems.length) {
    return [];
  }

  const stages = workItems.map((item, index) => createRuntimeStage({
    type: "specialist_work",
    title: item.title || `A2A Payload Dispatch ${index + 1}`,
    needs: item.needs?.length ? item.needs : ["specialist", "domain"],
    assignedAgentId: item.assignedAgentId,
    goal: item.goal || `按总控标准 A2A Payload 执行 ${item.a2aPayload?.action || "专业任务"}。`,
    reason: item.reason,
    a2aPayload: item.a2aPayload
  }));

  if (supervisor) {
    stages.push(createRuntimeStage({
      type: "supervisor_review",
      title: "Supervisor Review",
      needs: ["supervisor", "review", "summary"],
      assignedAgentId: supervisor.agentId,
      goal: "审核各专业子 agent 的输出，形成面向 BA 的最终结论。",
      reason: "Supervisor owns final consistency review and human confirmation points."
    }));
  }

  return stages;
}

function createSupervisorReviewFollowUpStages({ room, task, reviewStage, reviewDecision }) {
  const supervisor = findSupervisorMember(room.members || []);
  const members = room.members || [];
  const structuredItems = (reviewDecision.followUpSubtasks || [])
    .map((subtask, index) => normalizeSubtask(subtask, index))
    .map((subtask) => ({
      ...subtask,
      assignedAgentId: resolveSubtaskAgentId(subtask, members)
    }))
    .filter((subtask) => subtask.assignedAgentId);
  const inferredItems = [];
  const seenAgentIds = new Set();
  const workItems = [...structuredItems, ...inferredItems]
    .filter((item) => item.assignedAgentId !== supervisor?.agentId)
    .filter((item) => !hasUnfinishedStageForAgent(task, item.assignedAgentId))
    .filter((item) => {
      if (seenAgentIds.has(item.assignedAgentId)) {
        return false;
      }
      seenAgentIds.add(item.assignedAgentId);
      return true;
    });

  if (!workItems.length) {
    return [];
  }

  const stages = workItems.map((item, index) => {
    const member = (room.members || []).find((candidate) => candidate.agentId === item.assignedAgentId);
    const needs = item.needs?.length ? item.needs : inferSpecialistNeeds(member || item);
    return createRuntimeStage({
      type: "specialist_work",
      title: item.title || `${domainTitle(needs)}补充校验 ${index + 1}`,
      needs,
      assignedAgentId: item.assignedAgentId,
      goal: item.goal || `按总控标准 A2A Payload 继续处理: ${item.reason || "补充内部 agent 校验"}`,
      reason: item.reason || "Supervisor review found an internal specialist task that still needs to run.",
      a2aPayload: item.a2aPayload
    });
  });

  if (supervisor) {
    stages.push(createRuntimeStage({
      type: "supervisor_review",
      title: "Supervisor Review",
      needs: ["supervisor", "review", "summary"],
      assignedAgentId: supervisor.agentId,
      goal: "审核补充子 agent 的输出，确认原始需求是否已完整覆盖。",
      reason: "Supervisor must review follow-up specialist output before completion."
    }));
  }

  return stages;
}

function inferReviewFollowUpSubtasks({ room, task, reviewStage }) {
  const text = stripReviewJsonBlock(reviewStage.result?.summary || "");
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[\s#>*\-0-9.、|]+/, "").trim())
    .filter(Boolean);
  const supervisor = findSupervisorMember(room.members || []);
  const subtasks = [];

  for (const member of room.members || []) {
    if (!member.agentId || member.agentId === supervisor?.agentId) {
      continue;
    }
    const matchingLine = lines.find((line) => lineMentionsMember(line, member) && isFollowUpDispatchLine(line));
    if (!matchingLine) {
      continue;
    }
    const needs = inferSpecialistNeeds(member);
    subtasks.push({
      agentId: member.agentId,
      title: `${domainTitle(needs)}补充校验`,
      goal: `总控复核发现该内部工作尚未完成，请根据原始需求继续校验并给出修改建议。\n原始需求: ${task.goal}\n复核要求: ${matchingLine}`,
      needs,
      reason: matchingLine
    });
  }

  return subtasks;
}

function lineMentionsMember(line, member) {
  const source = String(line || "").toLowerCase();
  const names = [member.agentId, member.name, ...(member.roles || []), ...(member.capabilities || [])]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());
  return names.some((name) => name && source.includes(name));
}

function isFollowUpDispatchLine(line) {
  const source = String(line || "");
  if (/(无需|无须|不需要|已完成|已执行|已校验|SUCCESS|DONE)/i.test(source)
    && !/(尚未|未执行|未校验|待|仍需|还需|需要|需\s*)/i.test(source)) {
    return false;
  }
  return /(尚未|未执行|未校验|待|仍需|还需|需要|需\s*|应当|应该|后续|下一步|派发|调度).{0,40}(agent|校验|检查|同步|执行|修改|表单|权限|规则)|(?:agent|校验|检查|同步|执行|修改|表单|权限|规则).{0,40}(尚未|未执行|未校验|待|仍需|还需|需要|需\s*|应当|应该|后续|下一步|派发|调度)/i.test(source);
}

function hasUnfinishedStageForAgent(task, agentId) {
  return (task.stages || []).some((stage) => (
    stage.assignedAgentId === agentId
    && ["queued", "running", "retrying"].includes(stage.status)
  ));
}

function progressDetailForStage(stage) {
  if (stage.type === "supervisor_dispatch") {
    return "TeamRoom 已把用户需求或续接信息交给 Supervisor；Supervisor 应按 SOP 执行到确认、等待、派发或闭环节点。";
  }
  if (stage.type === "specialist_work") {
    return stage.a2aPayload
      ? "TeamRoom 正在把 Supervisor 生成的标准 A2A Payload 转发给专业 Agent。"
      : "专业 Agent 将按阶段目标执行检查、分析、写入或修改建议。";
  }
  if (stage.type === "supervisor_review") {
    return "TeamRoom 正在把子 Agent 回传交还给 Supervisor，由 Supervisor 继续按 SOP 分诊下一步。";
  }
  if (stage.type === "background_audit") {
    return "用户可见结论已先交付；TeamRoom 正在让 Supervisor 后台执行闭环审计。";
  }
  return "TeamRoom 已准备好本阶段上下文。";
}

function displayStageType(type) {
  return ({
    supervisor_dispatch: "总控派工",
    supervisor_chat: "总控对话",
    specialist_work: "专业执行",
    supervisor_review: "总控复核",
    analysis: "分析",
    planning: "规划",
    implementation: "执行",
    review: "审核",
    summary: "总结",
    background_audit: "后台审计"
  })[type] || "当前阶段";
}

function createStageStreamHandler({ publish, intervalMs = 900, maxSegmentLength = 1400 }) {
  let buffer = "";
  let timer = null;
  let publishing = null;
  const lastPublishedSegments = new Map();

  const publishLatest = async () => {
    timer = null;
    const text = String(buffer || "").replace(/\s+\n/g, "\n").trim();
    if (!text) {
      return;
    }
    const segmentCount = Math.max(1, Math.ceil(text.length / maxSegmentLength));
    const chunks = [];
    for (let index = 0; index < segmentCount; index += 1) {
      const start = index * maxSegmentLength;
      const detail = text.slice(start, start + maxSegmentLength);
      if (!detail || lastPublishedSegments.get(index) === detail) {
        continue;
      }
      lastPublishedSegments.set(index, detail);
      chunks.push({
        detail,
        segmentIndex: index,
        segmentCount,
        segmentStart: start,
        segmentLength: detail.length,
        maxSegmentLength,
        totalLength: text.length,
        isSegmentComplete: index < segmentCount - 1 || detail.length >= maxSegmentLength
      });
    }
    if (!chunks.length) {
      return;
    }
    publishing = Promise.resolve((async () => {
      for (const chunk of chunks) {
        await publish(chunk);
      }
    })())
      .catch(() => {})
      .finally(() => {
        publishing = null;
      });
    await publishing;
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      publishLatest().catch(() => {});
    }, intervalMs);
  };

  return {
    push(progress = {}) {
      const text = String(progress.text || progress || "");
      if (!text.trim()) {
        return;
      }
      buffer = progress.append ? `${buffer}${text}` : text;
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (publishing) {
        await publishing;
      }
      await publishLatest();
    }
  };
}

function isSupervisorStage(stage = {}) {
  return ["supervisor_dispatch", "supervisor_review"].includes(stage.type);
}

function isRelevantRecoveredSupervisorResult(summary, stage = {}) {
  if (!summary) {
    return false;
  }
  if (stage.type === "supervisor_dispatch") {
    const decision = parseSupervisorDispatchDecision(summary);
    return Boolean(decision.pending || decision.internalWait);
  }
  if (stage.type === "supervisor_review") {
    const decision = parseSupervisorReviewDecision(summary);
    return Boolean(decision.pending || decision.internalWait);
  }
  return false;
}

function reviewDecisionLabel(decision = {}) {
  if (decision.pending) {
    return "需要人工确认";
  }
  if (decision.followUpSubtasks?.length) {
    return "追加内部派工";
  }
  if (decision.internalWait) {
    return "等待内部结果";
  }
  return "可以完成任务";
}

function parseDispatchPlan(text) {
  const parsed = parseDispatchJson(text);
  return {
    parsed: Boolean(parsed),
    subtasks: Array.isArray(parsed?.subtasks) ? parsed.subtasks : []
  };
}

function parseSupervisorDispatchDecision(text, room = null) {
  const parsed = parseDispatchJson(text);
  const confirmationCandidates = extractParsedConfirmationCandidates(parsed);
  const rawParsedPoints = normalizeConfirmationPointCandidates(confirmationCandidates);
  const parsedPoints = normalizeConfirmationPoints(confirmationCandidates);
  const actionableParsedPoints = parsedPoints.length
    ? parsedPoints
    : rawParsedPoints.filter((point) => !isInternalWorkflowConfirmation(point));

  if (parsed) {
    if (actionableParsedPoints.length > 0) {
      return {
        pending: true,
        reason: parsed?.summary || parsed?.reason || "总控派工前认为仍存在需要人工确认的点。",
        confirmationPoints: actionableParsedPoints
      };
    }
    const parsedStatus = String(parsed.status || "").trim().toLowerCase();
    if (["pending", "needs_confirmation", "need_confirmation"].includes(parsedStatus)) {
      return {
        pending: true,
        reason: parsed?.summary || parsed?.reason || "总控派工前认为仍存在需要人工确认的点。",
        confirmationPoints: ["总控认为派发前仍需要用户确认，但未提供具体问题。请补充具体确认点后继续。"]
      };
    }
    if (isInternalWaitStatus(parsedStatus)) {
      return {
        pending: false,
        internalWait: true,
        reason: parsed?.summary || parsed?.reason || "总控仍在执行内部 SOP，等待继续。",
        confirmationPoints: [],
        waitingPoints: []
      };
    }
    const wantsDispatch = ["dispatch", "followup", "follow_up", "continue"].includes(parsedStatus)
      || parsed.dispatch_ready === true
      || parsed.dispatchReady === true;
    if (wantsDispatch && (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0)) {
      return {
        pending: false,
        reason: "总控声明需要派发子 Agent，但没有提供可路由的 subtasks；TeamRoom 不做 payload 修正。",
        confirmationPoints: []
      };
    }
    return {
      pending: false,
      reason: parsed?.summary || "总控派工确认无需人工补充。",
      confirmationPoints: []
    };
  }

  const heuristicPoints = inferConfirmationPoints(stripDispatchJsonBlock(text));
  if (heuristicPoints.length > 0) {
    return {
      pending: true,
      reason: "总控派工前认为仍存在需要人工确认的点。",
      confirmationPoints: heuristicPoints
    };
  }

  return {
    pending: false,
    reason: "总控没有输出可解析派发 JSON；TeamRoom 不做 payload 校验或修正。",
    confirmationPoints: []
  };
}

function parseDispatchJson(text) {
  const raw = String(text || "");
  const marked = raw.match(/TEAMROOM_DISPATCH_JSON_START\s*([\s\S]*?)\s*TEAMROOM_DISPATCH_JSON_END/);
  if (marked) {
    return parseJsonCandidate(marked[1]);
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const parsed = parseJsonCandidate(fenced[1]);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return parseJsonCandidate(raw.slice(firstBrace, lastBrace + 1));
  }
  return null;
}

function parseSupervisorReviewDecision(text, room = null) {
  const parsed = parseReviewJson(text);
  const confirmationCandidates = extractParsedConfirmationCandidates(parsed);
  const rawParsedPoints = normalizeConfirmationPointCandidates(confirmationCandidates);
  const parsedPoints = normalizeConfirmationPoints(confirmationCandidates);
  const parsedStatus = String(parsed?.status || "").trim().toLowerCase();
  const readableText = stripReviewJsonBlock(text);
  const waitingPoints = rawParsedPoints.filter((point) => isInternalWorkflowConfirmation(point));
  const followUpSubtasks = extractParsedReviewFollowUpSubtasks(parsed);
  const actionableParsedPoints = parsedPoints.length
    ? parsedPoints
    : rawParsedPoints.filter((point) => !isInternalWorkflowConfirmation(point));

  if (parsed) {
    if (actionableParsedPoints.length > 0) {
      return {
        pending: true,
        reason: parsed?.summary || parsed?.reason || "总控审核认为仍存在需要人工确认的点。",
        confirmationPoints: actionableParsedPoints
      };
    }

    if (["followup", "follow_up", "dispatch", "continue"].includes(parsedStatus) && followUpSubtasks.length === 0) {
      return {
        pending: false,
        reason: parsed?.summary || parsed?.reason || "总控声明需要续接派发，但没有提供可路由的 followup_subtasks。",
        confirmationPoints: []
      };
    }

    if (followUpSubtasks.length > 0 || ["followup", "follow_up", "dispatch", "continue"].includes(parsedStatus)) {
      return {
        pending: false,
        followUpSubtasks,
        reason: parsed?.summary || parsed?.reason || "总控复核发现仍需追加内部 agent 处理。",
        confirmationPoints: []
      };
    }

    const internalWait = isInternalWaitStatus(parsedStatus)
      || (rawParsedPoints.length > 0 && waitingPoints.length === rawParsedPoints.length);
    if (internalWait) {
      return {
        pending: false,
        internalWait: true,
        reason: parsed?.summary || parsed?.reason || "等待内部 Agent 返回结果。",
        confirmationPoints: [],
        waitingPoints
      };
    }

    if (["pending", "needs_confirmation", "need_confirmation"].includes(parsedStatus)) {
      const heuristicPoints = inferConfirmationPoints(readableText);
      const fallbackPoints = rawParsedPoints.filter((point) => !isInternalWorkflowConfirmation(point));
      return {
        pending: true,
        reason: parsed?.summary || parsed?.reason || "总控审核认为仍存在需要人工确认的点。",
        confirmationPoints: heuristicPoints.length
          ? heuristicPoints
          : (fallbackPoints.length ? fallbackPoints : ["总控审核认为仍存在需要人工确认的点。"])
      };
    }

    return {
      pending: false,
      reason: parsed?.summary || "总控审核确认无需人工补充。",
      confirmationPoints: []
    };
  }

  const heuristicPoints = inferConfirmationPoints(readableText);
  const internalWait = hasInternalWaitSignal(readableText);

  if (heuristicPoints.length > 0) {
    return {
      pending: true,
      reason: "总控审核认为仍存在需要人工确认的点。",
      confirmationPoints: heuristicPoints
    };
  }
  if (internalWait) {
    return {
      pending: false,
      internalWait: true,
      reason: "等待内部 Agent 返回结果。",
      confirmationPoints: [],
      waitingPoints: extractInternalWaitingPoints(readableText)
    };
  }

  return {
    pending: false,
    reason: "总控审核确认无需人工补充。",
    confirmationPoints: []
  };
}

function parseSupervisorDeliveryDecision(text) {
  const parsed = parseDeliveryJson(text);
  if (!parsed || typeof parsed !== "object") {
    return { delivered: false };
  }
  const status = String(parsed.status || "").trim().toLowerCase();
  const closure = parsed.closure && typeof parsed.closure === "object" ? parsed.closure : {};
  const changedArtifacts = arrayFrom(
    parsed.changed_artifacts,
    parsed.changedArtifacts,
    parsed.artifacts,
    closure.changed_artifacts,
    closure.changedArtifacts
  );
  const risks = arrayFrom(parsed.risks, closure.risks);
  const nextSteps = arrayFrom(parsed.next_steps, parsed.nextSteps, closure.next_steps, closure.nextSteps);
  return {
    delivered: ["delivered", "delivery", "completed", "complete"].includes(status) || parsed.deliver_now === true || parsed.deliverNow === true,
    summary: parsed.summary || closure.summary || "已先行交付总控结论，后台审计继续执行。",
    changedArtifacts,
    risks,
    nextSteps,
    backgroundAuditRequired: parsed.background_audit_required !== false && parsed.backgroundAuditRequired !== false
  };
}

function parseBackgroundAuditDecision(text) {
  const parsed = parseAuditJson(text);
  const confirmationCandidates = extractParsedConfirmationCandidates(parsed);
  const confirmationPoints = normalizeConfirmationPoints(confirmationCandidates);
  const rawParsedPoints = normalizeConfirmationPointCandidates(confirmationCandidates);
  const fallbackPoints = rawParsedPoints.filter((point) => !isInternalWorkflowConfirmation(point));
  const status = String(parsed?.status || "").trim().toLowerCase();
  const points = confirmationPoints.length ? confirmationPoints : fallbackPoints;
  if (points.length || ["pending", "audit_alert", "alert", "needs_confirmation", "need_confirmation"].includes(status)) {
    return {
      pending: true,
      reason: parsed?.summary || parsed?.reason || "后台审计发现需要用户确认或处理的问题。",
      confirmationPoints: points.length ? points : ["后台审计发现问题，请确认下一步处理方式。"],
      risks: arrayFrom(parsed?.risks)
    };
  }
  return {
    pending: false,
    reason: parsed?.summary || "后台审计完成，未发现需要用户处理的问题。",
    confirmationPoints: [],
    risks: arrayFrom(parsed?.risks)
  };
}

function parseReviewJson(text) {
  const raw = String(text || "");
  const marked = raw.match(/TEAMROOM_REVIEW_JSON_START\s*([\s\S]*?)\s*TEAMROOM_REVIEW_JSON_END/);
  if (!marked) {
    return null;
  }
  const fenced = String(marked[1]).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return parseJsonCandidate(fenced ? fenced[1] : marked[1]);
}

function parseDeliveryJson(text) {
  const raw = String(text || "");
  const marked = raw.match(/TEAMROOM_DELIVERY_JSON_START\s*([\s\S]*?)\s*TEAMROOM_DELIVERY_JSON_END/);
  if (!marked) {
    return null;
  }
  const fenced = String(marked[1]).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return parseJsonCandidate(fenced ? fenced[1] : marked[1]);
}

function parseAuditJson(text) {
  const raw = String(text || "");
  const marked = raw.match(/TEAMROOM_AUDIT_JSON_START\s*([\s\S]*?)\s*TEAMROOM_AUDIT_JSON_END/);
  if (!marked) {
    return null;
  }
  const fenced = String(marked[1]).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return parseJsonCandidate(fenced ? fenced[1] : marked[1]);
}

function arrayFrom(...values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : (value == null ? [] : [value]))
    .filter((item) => item != null && String(item).trim());
}

function extractParsedConfirmationCandidates(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  return [
    parsed.confirmation_points,
    parsed.confirmationPoints,
    parsed.confirm_points,
    parsed.confirmPoints,
    parsed.confirmations,
    parsed.questions,
    parsed.confirmation_questions,
    parsed.confirmationQuestions,
    parsed.pending_questions,
    parsed.pendingQuestions,
    parsed.human_confirmation_points,
    parsed.humanConfirmationPoints
  ].flatMap((item) => Array.isArray(item) ? item : (item == null ? [] : [item]));
}

function extractParsedReviewFollowUpSubtasks(parsed) {
  const candidates = parsed?.followup_subtasks
    || parsed?.followUpSubtasks
    || parsed?.follow_up_subtasks
    || parsed?.next_subtasks
    || parsed?.subtasks;
  return Array.isArray(candidates) ? candidates : [];
}

function stripReviewJsonBlock(text) {
  return String(text || "").replace(/TEAMROOM_REVIEW_JSON_START[\s\S]*?TEAMROOM_REVIEW_JSON_END/gi, "");
}

function stripDispatchJsonBlock(text) {
  return String(text || "").replace(/TEAMROOM_DISPATCH_JSON_START[\s\S]*?TEAMROOM_DISPATCH_JSON_END/gi, "");
}

function stripTeamRoomJsonBlocks(text) {
  return String(text || "")
    .replace(/TEAMROOM_DISPATCH_JSON_START[\s\S]*?TEAMROOM_DISPATCH_JSON_END/gi, "")
    .replace(/TEAMROOM_REVIEW_JSON_START[\s\S]*?TEAMROOM_REVIEW_JSON_END/gi, "")
    .replace(/TEAMROOM_DELIVERY_JSON_START[\s\S]*?TEAMROOM_DELIVERY_JSON_END/gi, "")
    .replace(/TEAMROOM_AUDIT_JSON_START[\s\S]*?TEAMROOM_AUDIT_JSON_END/gi, "")
    .trim();
}

function normalizeConfirmationPoints(value) {
  return normalizeConfirmationPointDisplayCandidates(value)
    .filter((item) => !isNegativeConfirmationText(confirmationPointText(item)))
    .filter((item) => isHumanActionableConfirmationPoint(confirmationPointText(item)));
}

function normalizeConfirmationPointCandidates(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap(normalizeConfirmationPointCandidates)
      .filter(Boolean)
      .filter((item) => !isNegativeConfirmationText(item));
  }
  if (typeof value === "string" && value.trim()) {
    return isNegativeConfirmationText(value) ? [] : [value.trim()];
  }
  if (value && typeof value === "object") {
    const normalized = normalizeConfirmationPointObject(value);
    return normalized && !isNegativeConfirmationText(normalized) ? [normalized] : [];
  }
  return [];
}

function normalizeConfirmationPointDisplayCandidates(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap(normalizeConfirmationPointDisplayCandidates)
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return isNegativeConfirmationText(value) ? [] : [value.trim()];
  }
  if (value && typeof value === "object") {
    const normalized = normalizeConfirmationPointObjectForDisplay(value);
    return normalized && !isNegativeConfirmationText(confirmationPointText(normalized)) ? [normalized] : [];
  }
  return [];
}

function normalizeConfirmationPointObject(value) {
  const question = firstStringValue(value, [
    "question",
    "title",
    "label",
    "prompt",
    "content",
    "text",
    "description",
    "issue",
    "name"
  ]);
  const hint = firstStringValue(value, [
    "hint",
    "detail",
    "details",
    "reason",
    "suggestion",
    "recommendation",
    "default",
    "default_value",
    "defaultValue"
  ]);
  const options = normalizeConfirmationOptions(value.options || value.choices || value.candidates || value.values);
  const parts = [];
  if (question) {
    parts.push(question);
  }
  if (hint && hint !== question) {
    parts.push(hint);
  }
  if (options.length) {
    parts.push(`选项: ${options.join(" / ")}`);
  }
  if (parts.length) {
    return parts.join(": ");
  }

  const fallback = Object.entries(value)
    .filter(([key]) => !["options", "choices", "candidates", "values"].includes(key))
    .map(([key, item]) => `${key}: ${stringifyConfirmationValue(item)}`)
    .filter((item) => item.replace(/^[^:]+:\s*/, "").trim())
    .join("; ");
  return fallback.trim();
}

function normalizeConfirmationPointObjectForDisplay(value) {
  const question = firstStringValue(value, [
    "question",
    "title",
    "label",
    "prompt",
    "content",
    "text",
    "description",
    "issue",
    "name"
  ]);
  const hint = firstStringValue(value, [
    "hint",
    "detail",
    "details",
    "reason",
    "suggestion",
    "recommendation"
  ]);
  const defaultValue = firstStringValue(value, [
    "default_if_no_response",
    "defaultIfNoResponse",
    "default",
    "default_value",
    "defaultValue"
  ]);
  const options = normalizeConfirmationOptions(value.options || value.choices || value.candidates || value.values);
  if (!question && !hint && !defaultValue && options.length === 0) {
    const fallback = normalizeConfirmationPointObject(value);
    return fallback ? { question: fallback } : null;
  }
  return {
    id: firstStringValue(value, ["q_id", "qid", "id", "key"]),
    category: firstStringValue(value, ["category", "type", "kind"]),
    question: question || hint || defaultValue || "确认点",
    hint: hint && hint !== question ? hint : "",
    options,
    inferred: value.inferred === true,
    default_if_no_response: defaultValue,
    current_inference: firstStringValue(value, ["current_inference", "currentInference", "inference"])
  };
}

function confirmationPointText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return [
      value.id,
      value.category,
      value.question,
      value.hint,
      value.default_if_no_response,
      value.current_inference,
      ...(Array.isArray(value.options) ? value.options : [])
    ].filter(Boolean).join(" ");
  }
  return "";
}

function firstStringValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value != null && typeof value !== "object") {
      const text = String(value).trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function normalizeConfirmationOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      if (item && typeof item === "object") {
        return firstStringValue(item, ["value", "label", "text", "title", "name"]);
      }
      return String(item || "").trim();
    })
    .filter(Boolean);
}

function stringifyConfirmationValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(stringifyConfirmationValue).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value == null ? "" : String(value).trim();
}

function inferConfirmationPoints(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return [];
  }
  if (isNegativeConfirmationText(raw)) {
    return [];
  }
  const section = extractConfirmationSection(raw);
  const source = section || raw;
  if (section && sectionHasNoConfirmation(section)) {
    return [];
  }
  if (isNegativeConfirmationText(source)) {
    return [];
  }
  const tablePoints = extractConfirmationTablePoints(source);
  if (tablePoints.length > 0) {
    return tablePoints.filter(isHumanActionableConfirmationPoint);
  }
  const lines = source
    .split("\n")
    .map((line) => line.replace(/^[\s#>*\-0-9.、]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !isNegativeConfirmationText(line));

  const pointLines = lines.filter((line) => (
    /(确认|澄清|补充|待定|待确认|待回答|需要|需\s*|回答|决策|选择|决定)/.test(line)
    && /(BA|业务方|人工|人为|用户|你|确认|澄清|补充|回答|决策|选择|决定)/i.test(line)
  )).filter(isHumanActionableConfirmationPoint);
  if (pointLines.length > 0) {
    return pointLines.slice(0, 6);
  }

  return hasHumanConfirmationSignal(source) ? ["总控审核认为仍存在需要人工确认的点。"] : [];
}

function extractConfirmationTablePoints(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .filter((line) => !/^\|?[\s:-]+\|[\s|:-]*$/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 3)
    .filter((cells) => !["#", "序号", "问题", "选项", "选项/建议"].some((header) => cells.join("").includes(header) && cells[0] === header))
    .map((cells) => {
      const issue = cells[1] || cells[0];
      const suggestion = cells[2] || "";
      return suggestion ? `${issue}: ${suggestion}` : issue;
    })
    .filter(Boolean)
    .slice(0, 6);
}

function hasHumanConfirmationSignal(text) {
  const source = String(text || "");
  return /确认点汇总|等待业务定义澄清|需\s*(?:BA|业务方|人工|人为|用户|你)(?:\s*\/\s*(?:BA|业务方|人工|用户|你))*\s*(?:回答|确认|澄清|补充|决策|选择|决定)|(?:需要|需|待).{0,16}(?:BA|业务方|人工|人为|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)|(?:请|由).{0,8}(?:BA|业务方|人工|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)/i.test(source);
}

function extractConfirmationSection(text) {
  const match = String(text || "").match(/(?:需(?:要)?\s*(?:BA|业务方|人工|用户|你).{0,16}(?:回答|确认|澄清|补充).{0,12}|确认(?:的问题|点)|待(?:确认|回答)|confirmation_points)[\s\S]*?(?=\n#{1,6}\s|\n---|\n下一步|$)/i);
  return match ? match[0] : "";
}

function isHumanActionableConfirmationPoint(text) {
  const source = String(text || "").trim();
  if (!source || isNegativeConfirmationText(source)) {
    return false;
  }
  if (hasExplicitHumanActor(source) && hasDecisionVerb(source)) {
    return true;
  }
  if (isInternalWorkflowConfirmation(source)) {
    return false;
  }
  return /[？?]|哪个|哪一|哪种|是否|要不要|需不需要|是什么|多少|如何|怎样|编码|父项|归属|范围|口径|规则|选项|方案/i.test(source);
}

function hasExplicitHumanActor(text) {
  return /BA|业务方|业务用户|业务人员|人工|人为|用户|你|人来|人手动/i.test(String(text || ""));
}

function hasDecisionVerb(text) {
  return /回答|确认|澄清|补充|决策|选择|决定|提供|指定|明确/i.test(String(text || ""));
}

function isInternalWorkflowConfirmation(text) {
  const source = String(text || "");
  if (!source.trim()) {
    return false;
  }
  if (hasExplicitHumanActor(source)) {
    return false;
  }
  const hasBusinessQuestion = /[？?]|哪个|哪一|哪种|是否|要不要|需不需要|是什么|多少|如何|怎样|编码|父项|归属|范围|口径|规则|选项|方案/i.test(source);
  const hardInternal = /等待|待.*返回|尚未返回|正在|执行中|运行中|验证结果|最终验证|返回结果|返回执行结果|完成后|通过后|后续|下游|派发|调度|回调|继续执行|重试|连接|断开|OpenClaw/i.test(source);
  if (hasBusinessQuestion && !hardInternal) {
    return false;
  }
  return hardInternal || /子\s*Agent|agent[_-]|_agent|dim-model|supervisor_agent|dimension_agent|form_agent|permission_agent/i.test(source);
}

function isInternalWaitStatus(status) {
  return ["waiting", "wait", "running", "in_progress", "processing", "retrying"].includes(String(status || "").trim().toLowerCase());
}

function hasInternalWaitSignal(text) {
  const source = String(text || "");
  return /等待|待.*返回|尚未返回|正在.{0,12}(?:执行|运行|验证)|执行中|运行中|验证结果|返回结果|返回执行结果|最终验证|尚未完成|未完成全部轮次|不可提前关闭|子\s*Agent|agent[_-]|_agent|dim-model/i.test(source)
    && !/(?:BA|业务方|业务用户|人工|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)/i.test(source);
}

function isAwaitingInternalSupervisorConfirmation(text) {
  const source = String(text || "");
  if (!source.trim()) {
    return false;
  }
  if (/(?:BA|业务方|业务用户|人工|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)/i.test(source)) {
    return false;
  }
  const supervisorActor = /总控|supervisor|主管|调度方|上游/i;
  const confirmationVerb = /确认|授权|批准|许可|approve|approval|confirm/i;
  const waitingVerb = /等待|待|请|需要|需\s*|准备好|ready|就绪/i;
  const executionVerb = /启动|执行|写入|修改|变更|校验|检查|物理变更|落地/i;
  return (
    supervisorActor.test(source)
    && confirmationVerb.test(source)
    && (waitingVerb.test(source) || executionVerb.test(source))
  ) || /(?:准备好|ready|就绪).{0,24}(?:确认|授权|批准).{0,24}(?:启动|执行|写入|修改|变更|校验|检查)/i.test(source);
}

function extractInternalWaitingPoints(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/^[\s#>*\-0-9.、]+/, "").trim())
    .filter(Boolean)
    .filter(isInternalWorkflowConfirmation)
    .slice(0, 4);
}

function isInternalOnlyPendingTask(task) {
  const points = normalizeConfirmationPointCandidates(task?.confirmationPoints || []);
  if (points.length === 0) {
    return false;
  }
  const humanPoints = points.filter(isHumanActionableConfirmationPoint);
  if (humanPoints.length > 0) {
    return false;
  }
  return points.every(isInternalWorkflowConfirmation);
}

function sectionHasNoConfirmation(section) {
  const lines = String(section || "")
    .split("\n")
    .map((line) => line.replace(/^[\s#>*\-0-9.、]+/, "").trim())
    .filter(Boolean);
  const contentLines = lines.filter((line) => (
    !/^(?:需(?:要)?\s*)?(?:BA|业务方|人工|用户|你)?.{0,12}(?:确认|澄清|补充)(?:的问题|点)?$/i.test(line)
    && !(/确认/.test(line) && /(点|问题)/.test(line) && line.length <= 40)
    && !/^confirmation_points$/i.test(line)
  ));
  return contentLines.length > 0 && isNegativeConfirmationText(contentLines[0]);
}

function isNegativeConfirmationText(text) {
  const compact = String(text || "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .replace(/[*_`>|｜]/g, "")
    .toLowerCase();
  if (/(?:需(?:要)?|待)?.{0,16}(?:ba|业务方|业务用户|人工|用户)?.{0,16}(?:确认|澄清|补充|回答)/i.test(compact)
    && /(无|无需|无须|不需要|无影响|无业务决策|无业务交付|纯信息展示)/.test(compact)) {
    return true;
  }

  const normalized = String(text || "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "")
    .toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    "无",
    "暂无",
    "没有",
    "无需",
    "无须",
    "不需要",
    "无需ba",
    "无需业务方",
    "无需人工",
    "无需用户",
    "无需确认",
    "不需要确认",
    "无待确认"
  ].some((keyword) => normalized === keyword || normalized.startsWith(keyword));
}

function parseJsonCandidate(value) {
  try {
    return JSON.parse(String(value).trim());
  } catch {
    return null;
  }
}

function normalizeSubtask(subtask, index) {
  const a2aPayload = extractA2aPayload(subtask);
  const agentId = subtask.agent_id
    || subtask.agentId
    || subtask.agent
    || subtask.assignee
    || a2aPayload?.target_agent;
  return {
    agentId,
    title: subtask.title || `Specialist Work ${index + 1}`,
    goal: subtask.goal || subtask.task || subtask.description || "",
    needs: Array.isArray(subtask.needs) ? subtask.needs.map(String) : [],
    reason: subtask.reason || "",
    a2aPayload
  };
}

function resolveSubtaskAgentId(subtask = {}, members = []) {
  const requested = subtask.agentId
    || subtask.agent_id
    || subtask.agent
    || subtask.assignee
    || subtask.a2aPayload?.target_agent
    || subtask.a2aPayload?.targetAgent;
  if (!requested) {
    return "";
  }
  const exact = members.find((member) => member.agentId === requested);
  if (exact) {
    return exact.agentId;
  }
  const equivalent = members.find((member) => agentIdsEquivalent(member.agentId, requested));
  if (equivalent) {
    return equivalent.agentId;
  }
  const requestedTokens = agentRouteTokens(requested);
  const tokenMatched = members.find((member) => {
    const memberTokens = new Set([
      ...agentRouteTokens(member.agentId),
      ...agentRouteTokens(member.name),
      ...(member.roles || []).flatMap(agentRouteTokens),
      ...(member.capabilities || []).flatMap(agentRouteTokens)
    ]);
    return requestedTokens.some((token) => memberTokens.has(token));
  });
  return tokenMatched?.agentId || "";
}

function agentIdsEquivalent(left, right) {
  const normalize = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^fox[_-]/, "")
    .replace(/^openclaw[_-]/, "")
    .replace(/[_-]+/g, "_")
    .replace(/_agent$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b
    || (a === "auth" && b === "permission")
    || (a === "permission" && b === "auth")
    || (a === "dim_model" && ["dimension", "model", "dim"].includes(b))
    || (b === "dim_model" && ["dimension", "model", "dim"].includes(a));
}

function agentRouteTokens(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/^fox[_-]/, "")
    .replace(/^openclaw[_-]/, "")
    .replace(/[_-]+agent$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim();
  const tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const joined = tokens.join("_");
  const aliases = [];
  if (/dim|dimension|维度|模型|model/.test(joined)) {
    aliases.push("dimension", "model", "dim_model");
  }
  if (/form|表单|sheet/.test(joined)) {
    aliases.push("form");
  }
  if (/auth|permission|权限|access/.test(joined)) {
    aliases.push("permission", "auth", "access");
  }
  if (/workflow|作业流|flow/.test(joined)) {
    aliases.push("workflow");
  }
  return [...new Set([...tokens, joined, ...aliases].filter(Boolean))];
}

function extractA2aPayload(subtask = {}) {
  const candidate = subtask.a2a_payload
    || subtask.a2aPayload
    || subtask.payload
    || subtask.standard_payload
    || subtask.standardPayload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return normalizeA2aPayloadShape(candidate);
  }
  if (subtask.task_id && subtask.target_agent && subtask.workspace_context) {
    return normalizeA2aPayloadShape(subtask);
  }
  return null;
}

function normalizeA2aPayloadShape(payload = {}) {
  const normalized = {
    ...payload,
    workspace_context: payload.workspace_context && typeof payload.workspace_context === "object"
      ? { ...payload.workspace_context }
      : payload.workspace_context
  };
  const workspaceContext = normalized.workspace_context;
  if (workspaceContext && typeof workspaceContext === "object" && !Array.isArray(workspaceContext)) {
    const references = workspaceContext.input_references
      ?? workspaceContext.inputReferences
      ?? workspaceContext.input_reference
      ?? workspaceContext.inputReference
      ?? [];
    workspaceContext.input_references = Array.isArray(references)
      ? references.filter(Boolean)
      : [references].filter(Boolean);
    delete workspaceContext.inputReferences;
    delete workspaceContext.input_reference;
    delete workspaceContext.inputReference;
  }
  return normalized;
}

function createBackgroundAuditStage({ supervisor, sourceStage }) {
  return createRuntimeStage({
    type: "background_audit",
    title: "Background Closure Audit",
    needs: ["supervisor", "audit", "closure"],
    assignedAgentId: supervisor?.agentId,
    goal: [
      "用户可见结论已经通过 TeamRoom 先行交付。",
      "请继续执行 Step 7 后台闭环审计: 记忆同步、流水账/执行日志追加、working 目录交付件聚合和一致性校验。",
      "不要重复生成长篇用户结论；只在发现风险、矛盾或需要用户处理时返回 pending/audit_alert。"
    ].join("\n"),
    reason: `TeamRoom delivered user-facing conclusion from ${sourceStage?.title || "Supervisor"} and continues closure audit in background.`
  });
}

function fallbackSpecialistSubtasks({ room, task, supervisor, policy }) {
  const fallbackDispatch = normalizePolicy(policy).fallbackDispatch;
  if (fallbackDispatch === "none") {
    return [];
  }
  const inferred = new Set(inferCapabilities(task.goal)
    .filter((item) => !["general", "domain", "specialist"].includes(item)));

  return (room.members || [])
    .filter((member) => member.agentId !== supervisor?.agentId)
    .map((member) => ({
      member,
      needs: inferSpecialistNeeds(member)
    }))
    .filter(({ member, needs }) => (
      fallbackDispatch === "all"
      || (inferred.size > 0 && matchesInferredCapabilities(member, needs, inferred))
    ))
    .map(({ member, needs }) => {
      return {
        agentId: member.agentId,
        title: `${domainTitle(needs)}影响判断`,
        goal: `从${domainTitle(needs)}视角判断用户需求的影响范围，并说明是否需要更新对应交付件。用户需求: ${task.goal}`,
        needs,
        reason: "Supervisor did not return a machine-readable dispatch plan; TeamRoom selected this specialist because its tags match the task keywords."
      };
    });
}

function matchesInferredCapabilities(member, needs, inferred) {
  const memberTags = new Set([
    ...(member.roles || []),
    ...(member.capabilities || []),
    ...(needs || [])
  ].map((item) => String(item).toLowerCase()));

  for (const capability of inferred) {
    if (memberTags.has(capability)) {
      return true;
    }
  }
  return false;
}

function inferSpecialistNeeds(member) {
  const raw = [
    member.agentId,
    member.name,
    ...(member.roles || []),
    ...(member.capabilities || [])
  ].filter(Boolean).join(" ").toLowerCase();

  if (raw.includes("agent_2") || raw.includes("维度") || raw.includes("dimension") || raw.includes("模型") || raw.includes("model")) {
    return ["dimension", "model"];
  }
  if (raw.includes("agent_3") || raw.includes("表单") || raw.includes("form")) {
    return ["form"];
  }
  if (raw.includes("agent_4") || raw.includes("权限") || raw.includes("permission") || raw.includes("access")) {
    return ["permission", "access"];
  }
  if (raw.includes("rule") || raw.includes("规则")) {
    return ["rule"];
  }
  if (raw.includes("integration") || raw.includes("集成")) {
    return ["integration"];
  }
  if (raw.includes("workflow") || raw.includes("作业流")) {
    return ["workflow"];
  }
  return (member.capabilities || []).filter((item) => item !== "general").slice(0, 3);
}

function domainTitle(needs) {
  const tags = new Set(needs || []);
  if (tags.has("dimension") || tags.has("model")) {
    return "维度/模型";
  }
  if (tags.has("form")) {
    return "表单";
  }
  if (tags.has("permission") || tags.has("access")) {
    return "权限";
  }
  if (tags.has("rule")) {
    return "规则";
  }
  if (tags.has("integration")) {
    return "集成";
  }
  if (tags.has("workflow")) {
    return "作业流";
  }
  return "专业";
}

function createRuntimeStage({ type, title, needs, assignedAgentId, goal, reason, a2aPayload, continueInstruction }) {
  return {
    id: createId("stage"),
    order: 0,
    type,
    title,
    needs,
    assignedAgentId,
    goal,
    reason,
    status: "queued",
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    ...(a2aPayload ? { a2aPayload } : {}),
    ...(continueInstruction ? { continueInstruction } : {})
  };
}

function renumberStages(stages) {
  stages.forEach((stage, index) => {
    stage.order = index;
  });
}

function collectCompletedOutputs(task) {
  return (task.stages || [])
    .filter((stage) => stage.status === "completed" && stage.result)
    .map((stage) => ({
      stageId: stage.id,
      title: stage.title,
      agentId: stage.assignedAgentId,
      result: stage.result
    }));
}

function firstIncompleteStageIndex(stages = []) {
  const index = stages.findIndex((stage) => stage.status !== "completed");
  return index >= 0 ? index : stages.length;
}

function isRecoverableOpenClawError(error) {
  const message = String(error?.message || error || "");
  return /OpenClaw gateway (?:connection closed|is not connected|request timed out|websocket upgrade failed)|OpenClaw chat run timed out|OpenCode request (?:failed|timed out)|cannot connect|fetch failed|device nonce mismatch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeBackoff(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return normalized.length ? normalized : fallback;
}

function shouldResumeFromMessage(content) {
  const normalized = String(content || "").toLowerCase();
  return [
    "继续",
    "续跑",
    "接着",
    "恢复",
    "继续任务",
    "resume",
    "continue",
    "go on"
  ].some((keyword) => normalized.includes(keyword));
}
