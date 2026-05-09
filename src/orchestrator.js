import { createTaskGraph, findSupervisorMember, inferCapabilities, normalizePolicy, selectAgent } from "./policy.js";
import { normalizePromptTemplates, renderTemplate } from "./prompt-templates.js";
import { createId, nowIso } from "./utils.js";

const AUTO_RETRY_DELAY_MS = 5000;
const AUTO_RETRY_MAX_ATTEMPTS = 3;

export class Orchestrator {
  constructor({ store, events, adapter }) {
    this.store = store;
    this.events = events;
    this.adapter = adapter;
    this.runningTasks = new Set();
    this.busyAgents = new Set();
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
      }
      if (stage.assignedAgentId) {
        this.busyAgents.delete(stage.assignedAgentId);
        await this.store.setMemberStatus(roomId, stage.assignedAgentId, "idle");
      }
    }
    await this.store.updateTask(task);
    await this.events.publish(roomId, "task.cancelled", {
      taskId: task.id,
      reason
    });
    return task;
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
          stage.startedAt = null;
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
        stage.startedAt = nowIso();
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

        let result;
        try {
          result = await this.adapter.runAgent(member.agentId, input, {
            roomId: room.id,
            taskId: task.id,
            stageId: stage.id,
            stageType: stage.type,
            goal: task.goal,
            previousOutputs,
            roomContext,
            taskMessages,
            resumeInstruction: task.resumeInstruction || ""
          });
        } catch (error) {
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

        const afterRun = await this.store.getTask(task.id);
        if (!afterRun || afterRun.status === "cancelled" || afterRun.cancelRequested) {
          this.busyAgents.delete(member.agentId);
          await this.store.setMemberStatus(room.id, member.agentId, "idle");
          return;
        }

        stage.status = "completed";
        stage.completedAt = nowIso();
        stage.result = normalizeAgentResult(result);
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
          const reviewDecision = parseSupervisorReviewDecision(stage.result?.summary || "");
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
        }

        if (policy.mode === "supervisor" && stage.type === "supervisor_dispatch") {
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
      task.error = error.message;
      const runningStage = task.stages.find((stage) => stage.status === "running");
      if (runningStage) {
        runningStage.status = "failed";
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
      this.runningTasks.delete(taskId);
    }
  }

  async scheduleAutoRetry({ roomId, task, stage, member, error }) {
    if (!isRecoverableOpenClawError(error)) {
      return false;
    }
    const retryCount = Number(stage.autoRetryCount || 0);
    if (retryCount >= AUTO_RETRY_MAX_ATTEMPTS) {
      return false;
    }

    const attempt = retryCount + 1;
    const retryAt = new Date(Date.now() + AUTO_RETRY_DELAY_MS).toISOString();
    this.busyAgents.delete(member.agentId);
    await this.store.setMemberStatus(roomId, member.agentId, "idle");

    if (typeof this.adapter.resetConnection === "function") {
      await this.adapter.resetConnection().catch(() => {});
    }

    stage.status = "queued";
    stage.error = error.message;
    stage.startedAt = null;
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
      maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
      delayMs: AUTO_RETRY_DELAY_MS,
      retryAt
    });

    await sleep(AUTO_RETRY_DELAY_MS);
    const latest = await this.store.getTask(task.id);
    if (!latest || latest.status === "cancelled" || latest.cancelRequested) {
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
    task.error = error.message;
    const runningStage = task.stages?.find((stage) => stage.status === "running");
    if (runningStage) {
      runningStage.status = "failed";
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
    return buildSupervisorDispatchInput({ room, task, member, previousOutputs, roomContext, taskMessages });
  }
  if (stage.type === "specialist_work") {
    return buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }
  if (stage.type === "supervisor_review") {
    return buildSupervisorReviewInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages });
  }

  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  const values = buildPromptValues({ room, task, stage, member, previousOutputs, roomContext, taskMessages, policy, templates });
  return [
    `You are ${member.name || member.agentId}, participating in OpenClaw TeamRoom.`,
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

function buildSupervisorDispatchInput({ room, task, member, previousOutputs, roomContext, taskMessages }) {
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
    renderTemplate(templates.supervisorDispatch, values),
    "",
    "当前任务已有阶段输出:",
    values.previousOutputs
  ].join("\n");
}

function buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext, taskMessages }) {
  const policy = normalizePolicy(room.policy);
  const templates = normalizePromptTemplates(policy.promptTemplates);
  return renderTemplate(templates.specialistWork, buildPromptValues({
    room,
    task,
    stage,
    member,
    previousOutputs,
    roomContext,
    taskMessages,
    policy,
    templates
  }));
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
    renderTemplate(templates.supervisorReview, values),
    "",
    values.reviewJsonContract
  ].join("\n");
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
    taskMessages: formatTaskMessages(taskMessages, templates),
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
    "- 你是本次任务最后的审核人。",
    "- 如果最终结论中仍存在需要 BA、业务方、用户或人工确认/澄清/补充的信息，任务不能自动完成。",
    "- 这种情况下请把 status 设为 pending，并把确认问题写入 confirmation_points。",
    "- 如果没有任何人工确认点，请把 status 设为 completed，confirmation_points 为空数组。",
    "",
    "请在回答末尾包含下面这个机器可读 JSON 块，TeamRoom 会据此判断任务是否完成:",
    "TEAMROOM_REVIEW_JSON_START",
    JSON.stringify({
      status: "completed",
      summary: "一句话最终审核结论",
      confirmation_points: []
    }, null, 2),
    "TEAMROOM_REVIEW_JSON_END"
  ].join("\n");
}

function dispatchJsonContract() {
  return [
    "重要约束:",
    "- TeamRoom 只负责协作管控和可视化，业务拆题权在你这里。",
    "- 只从上面的可调度成员中选择 agent_id。",
    "- 不要为了热闹而安排无关 agent；如果某类交付件不受影响，可以不安排。",
    "- 如果无法判断需要哪个专业 agent，请返回空的 subtasks，并把问题写入 confirmation_points，不要把任务派给所有 agent 当作兜底。",
    "- 如果存在需要 BA 或业务方确认的点，请写入 confirmation_points。",
    "",
    "请在回答中包含下面这个机器可读 JSON 块，TeamRoom 会据此派发子任务:",
    "TEAMROOM_DISPATCH_JSON_START",
    JSON.stringify({
      summary: "一句话说明需求和影响范围",
      subtasks: [
        {
          agent_id: "agent_2",
          title: "维度与模型影响分析",
          goal: "说明要交给该 agent 的具体任务",
          needs: ["dimension", "model"],
          reason: "为什么需要该 agent 参与"
        }
      ],
      confirmation_points: ["需要人工确认的问题"]
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
    goal: item.goal,
    status: item.status || "completed",
    completedAt: item.completedAt || "",
    summary: item.summary || ""
  })).join("\n\n");
}

function formatTaskMessages(taskMessages = [], templates = {}) {
  if (!taskMessages.length) {
    return "- 暂无。";
  }
  return taskMessages
    .map((item) => renderTemplate(templates.taskMessageItem, {
      timestamp: item.timestamp || "",
      author: item.author || "human",
      content: item.content || ""
    }))
    .join("\n");
}

function formatPreviousOutputs(previousOutputs = [], templates = {}) {
  if (!previousOutputs.length) {
    return "- 无。";
  }
  return previousOutputs.map((item, index) => renderTemplate(templates.previousOutputItem, {
    index: index + 1,
    title: item.title || "Stage Output",
    agentId: item.agentId || "",
    summary: item.result?.summary || ""
  })).join("\n\n");
}

function createSupervisorFollowUpStages({ room, task, dispatchStage, policy }) {
  const supervisor = findSupervisorMember(room.members || []);
  const dispatch = parseDispatchPlan(dispatchStage.result?.summary || "");
  const allowedAgentIds = new Set((room.members || []).map((member) => member.agentId));
  const normalizedSubtasks = (dispatch.subtasks || [])
    .map((subtask, index) => normalizeSubtask(subtask, index))
    .filter((subtask) => subtask.agentId && allowedAgentIds.has(subtask.agentId));

  const workItems = dispatch.parsed
    ? normalizedSubtasks
    : fallbackSpecialistSubtasks({ room, task, supervisor, policy });

  const stages = workItems.map((item, index) => createRuntimeStage({
    type: "specialist_work",
    title: item.title || `Specialist Work ${index + 1}`,
    needs: item.needs?.length ? item.needs : ["specialist", "domain"],
    assignedAgentId: item.agentId,
    goal: item.goal,
    reason: item.reason
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

function parseDispatchPlan(text) {
  const parsed = parseDispatchJson(text);
  return {
    parsed: Boolean(parsed),
    subtasks: Array.isArray(parsed?.subtasks) ? parsed.subtasks : []
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

function parseSupervisorReviewDecision(text) {
  const parsed = parseReviewJson(text);
  const parsedPoints = normalizeConfirmationPoints(
    parsed?.confirmation_points
    || parsed?.confirmationPoints
    || parsed?.confirmations
    || parsed?.questions
  );
  const parsedStatus = String(parsed?.status || "").trim().toLowerCase();
  const heuristicPoints = inferConfirmationPoints(stripReviewJsonBlock(text));
  if (parsedStatus === "pending" || parsedPoints.length > 0 || heuristicPoints.length > 0) {
    const confirmationPoints = parsedPoints.length ? parsedPoints : heuristicPoints;
    return {
      pending: true,
      reason: parsed?.summary || parsed?.reason || "总控审核认为仍存在需要人工确认的点。",
      confirmationPoints: confirmationPoints.length ? confirmationPoints : ["总控审核认为仍存在需要人工确认的点。"]
    };
  }
  if (["completed", "complete", "done"].includes(parsedStatus)) {
    return {
      pending: false,
      reason: parsed?.summary || "总控审核确认无需人工补充。",
      confirmationPoints: []
    };
  }

  return {
    pending: heuristicPoints.length > 0,
    reason: heuristicPoints.length > 0 ? "总控审核认为仍存在需要人工确认的点。" : "总控审核确认无需人工补充。",
    confirmationPoints: heuristicPoints
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

function stripReviewJsonBlock(text) {
  return String(text || "").replace(/TEAMROOM_REVIEW_JSON_START[\s\S]*?TEAMROOM_REVIEW_JSON_END/gi, "");
}

function normalizeConfirmationPoints(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item) => !isNegativeConfirmationText(item));
  }
  if (typeof value === "string" && value.trim()) {
    return isNegativeConfirmationText(value) ? [] : [value.trim()];
  }
  return [];
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
    return tablePoints;
  }
  const lines = source
    .split("\n")
    .map((line) => line.replace(/^[\s#>*\-0-9.、]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !isNegativeConfirmationText(line));

  const pointLines = lines.filter((line) => (
    /(确认|澄清|补充|待定|待确认|待回答|需要|需\s*|回答|决策|选择|决定)/.test(line)
    && /(BA|业务方|人工|人为|用户|你|确认|澄清|补充|回答|决策|选择|决定)/i.test(line)
  ));
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
  return /确认点汇总|等待业务定义澄清|需\s*(?:BA|业务方|人工|人为|用户|你)(?:\s*\/\s*(?:BA|业务方|人工|用户|你))*\s*(?:回答|确认|澄清|补充|决策|选择|决定)|(?:需要|需|待).{0,16}(?:BA|业务方|人工|人为|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)|(?:请|由).{0,8}(?:BA|业务方|人工|用户|你).{0,16}(?:回答|确认|澄清|补充|决策|选择|决定)|待确认|待回答|confirmation_points/i.test(source);
}

function extractConfirmationSection(text) {
  const match = String(text || "").match(/(?:需(?:要)?\s*(?:BA|业务方|人工|用户|你).{0,16}(?:回答|确认|澄清|补充).{0,12}|确认(?:的问题|点)|待(?:确认|回答)|confirmation_points)[\s\S]*?(?=\n#{1,6}\s|\n---|\n下一步|$)/i);
  return match ? match[0] : "";
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
  return {
    agentId: subtask.agent_id || subtask.agentId || subtask.agent || subtask.assignee,
    title: subtask.title || `Specialist Work ${index + 1}`,
    goal: subtask.goal || subtask.task || subtask.description || "",
    needs: Array.isArray(subtask.needs) ? subtask.needs.map(String) : [],
    reason: subtask.reason || ""
  };
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

function createRuntimeStage({ type, title, needs, assignedAgentId, goal, reason }) {
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
    completedAt: null
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
  return /OpenClaw gateway (?:connection closed|is not connected|request timed out|websocket upgrade failed)|OpenClaw chat run timed out|device nonce mismatch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
