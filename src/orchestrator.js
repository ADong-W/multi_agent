import { createTaskGraph, findSupervisorMember, normalizePolicy, selectAgent } from "./policy.js";
import { createId, nowIso } from "./utils.js";

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

  async runTask(taskId) {
    if (this.runningTasks.has(taskId)) {
      return;
    }
    this.runningTasks.add(taskId);

    const task = await this.store.getTask(taskId);
    const room = await this.store.getRoom(task.roomId);
    if (!room) {
      throw new Error(`Room not found: ${task.roomId}`);
    }
    if (!room.members?.length) {
      throw new Error("Room has no agent members");
    }

    task.status = "running";
    await this.store.updateTask(task);
    await this.events.publish(room.id, "task.running", { taskId: task.id });

    const previousOutputs = [];
    const roomContext = await this.buildRoomContext(room.id, task.id);
    const assignmentCounts = new Map();
    try {
      let index = 0;
      while (index < task.stages.length) {
        const latestRoom = await this.store.getRoom(room.id);
        const policy = normalizePolicy(latestRoom.policy);
        const stage = task.stages[index];
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

        const input = buildAgentInput({
          room: latestRoom,
          task,
          stage,
          member,
          previousOutputs,
          roomContext
        });

        const result = await this.adapter.runAgent(member.agentId, input, {
          roomId: room.id,
          taskId: task.id,
          stageId: stage.id,
          stageType: stage.type,
          goal: task.goal,
          previousOutputs,
          roomContext
        });

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

  async failTask(taskId, error) {
    const task = await this.store.getTask(taskId);
    if (!task) {
      return;
    }
    task.status = "failed";
    task.error = error.message;
    await this.store.updateTask(task);
    await this.events.publish(task.roomId, "task.failed", {
      taskId,
      error: error.message
    });
  }

  async buildRoomContext(roomId, currentTaskId) {
    const tasks = await this.store.listTasks(roomId);
    return tasks
      .filter((item) => item.id !== currentTaskId && item.status === "completed")
      .slice(0, 6)
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
}

function buildAgentInput({ room, task, stage, member, previousOutputs, roomContext }) {
  if (stage.type === "supervisor_dispatch") {
    return buildSupervisorDispatchInput({ room, task, member, roomContext });
  }
  if (stage.type === "specialist_work") {
    return buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext });
  }
  if (stage.type === "supervisor_review") {
    return buildSupervisorReviewInput({ room, task, stage, member, previousOutputs, roomContext });
  }

  return [
    `You are ${member.name || member.agentId}, participating in OpenClaw TeamRoom.`,
    `Room: ${room.name}`,
    `Room members: ${formatRoomMembers(room.members || [])}`,
    "Shared room context:",
    formatRoomContext(roomContext),
    "",
    `Goal: ${task.goal}`,
    `Current stage: ${stage.title} (${stage.type})`,
    `Stage needs: ${(stage.needs || []).join(", ")}`,
    "You own this stage. Build on previous outputs from other agents and hand off useful context to the next agent.",
    "",
    "Previous stage outputs:",
    previousOutputs.length
      ? previousOutputs.map((item) => `- ${item.title} by ${item.agentId}: ${item.result.summary}`).join("\n")
      : "- None",
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

function buildSupervisorDispatchInput({ room, task, member, roomContext }) {
  return [
    `你是 ${member.name || member.agentId}，在 OpenClaw TeamRoom 中担任 Supervisor / 总控 Agent。`,
    `协作室: ${room.name}`,
    "可调度成员:",
    formatRoomMembers(room.members || []),
    "",
    "协作室共享上下文（来自本协作室已完成的历史任务，后续任务默认需要继承这些背景）:",
    formatRoomContext(roomContext),
    "",
    `用户需求: ${task.goal}`,
    "",
    "请先做需求理解和影响范围判断，然后给出子 agent 协作计划。",
    "重要约束:",
    "- TeamRoom 只负责协作管控和可视化，业务拆题权在你这里。",
    "- 只从上面的可调度成员中选择 agent_id。",
    "- 不要为了热闹而安排无关 agent；如果某类交付件不受影响，可以不安排。",
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
    "TEAMROOM_DISPATCH_JSON_END",
    "",
    "JSON 之外可以用简短中文解释你的判断。"
  ].join("\n");
}

function buildSpecialistInput({ room, task, stage, member, previousOutputs, roomContext }) {
  const dispatch = previousOutputs.find((item) => item.title === "Supervisor Dispatch");
  return [
    `你是 ${member.name || member.agentId}，在 OpenClaw TeamRoom 中担任专业子 Agent。`,
    `协作室: ${room.name}`,
    `用户需求: ${task.goal}`,
    `Supervisor 分配给你的任务: ${stage.goal || stage.title}`,
    stage.reason ? `分配原因: ${stage.reason}` : "",
    "",
    "协作室共享上下文（来自本协作室已完成的历史任务）:",
    formatRoomContext(roomContext),
    "",
    "Supervisor 的拆题结果:",
    dispatch?.result?.summary || "无",
    "",
    "请只处理你负责的专业范围，输出:",
    "- 你的判断结论",
    "- 对相关交付件的新增/修改/删除建议",
    "- 需要其他 agent 或 BA 确认的问题",
    "- 可交付的结构化结果或下一步动作",
    "",
    "如果你判断该需求与你的专业范围无关，请明确说明“无影响”，不要编造交付件变化。"
  ].filter(Boolean).join("\n");
}

function buildSupervisorReviewInput({ room, task, member, previousOutputs, roomContext }) {
  return [
    `你是 ${member.name || member.agentId}，在 OpenClaw TeamRoom 中担任 Supervisor / 总控 Agent。`,
    `协作室: ${room.name}`,
    `用户需求: ${task.goal}`,
    "",
    "协作室共享上下文（来自本协作室已完成的历史任务）:",
    formatRoomContext(roomContext),
    "",
    "下面是各阶段输出:",
    previousOutputs.map((item) => [
      `## ${item.title} by ${item.agentId}`,
      item.result.summary
    ].join("\n")).join("\n\n"),
    "",
    "请做最终审核和汇总，重点检查:",
    "- 子 agent 结论之间是否一致",
    "- 是否遗漏维度、模型、表单、权限、规则、集成或作业流影响",
    "- 哪些点需要 BA 或业务方确认",
    "- 下一步应该生成或更新哪些交付件",
    "",
    "请给出面向实施 BA 的简洁结论。"
  ].join("\n");
}

function formatRoomContext(roomContext = []) {
  if (!roomContext.length) {
    return "- 暂无历史任务上下文。";
  }
  return roomContext.map((item, index) => [
    `### 历史任务 ${index + 1}: ${item.goal}`,
    item.completedAt ? `完成时间: ${item.completedAt}` : "",
    item.summary
  ].filter(Boolean).join("\n")).join("\n\n");
}

function createSupervisorFollowUpStages({ room, task, dispatchStage, policy }) {
  const supervisor = findSupervisorMember(room.members || []);
  const subtasks = parseDispatchSubtasks(dispatchStage.result?.summary || "");
  const allowedAgentIds = new Set((room.members || []).map((member) => member.agentId));
  const normalizedSubtasks = subtasks
    .map((subtask, index) => normalizeSubtask(subtask, index))
    .filter((subtask) => subtask.agentId && allowedAgentIds.has(subtask.agentId));

  const workItems = normalizedSubtasks.length > 0
    ? normalizedSubtasks
    : fallbackSpecialistSubtasks({ room, task, supervisor });

  const stages = workItems.map((item, index) => createRuntimeStage({
    type: "specialist_work",
    title: item.title || `Specialist Work ${index + 1}`,
    needs: item.needs?.length ? item.needs : ["specialist", "domain"],
    assignedAgentId: item.agentId,
    goal: item.goal,
    reason: item.reason
  }));

  if (policy.requireReview && supervisor) {
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

function parseDispatchSubtasks(text) {
  const parsed = parseDispatchJson(text);
  const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  return subtasks;
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

function fallbackSpecialistSubtasks({ room, task, supervisor }) {
  return (room.members || [])
    .filter((member) => member.agentId !== supervisor?.agentId)
    .map((member) => {
      const needs = inferSpecialistNeeds(member);
      return {
        agentId: member.agentId,
        title: `${domainTitle(needs)}影响判断`,
        goal: `从${domainTitle(needs)}视角判断用户需求的影响范围，并说明是否需要更新对应交付件。用户需求: ${task.goal}`,
        needs,
        reason: "Supervisor did not return a machine-readable dispatch plan; TeamRoom asks room specialists to assess impact as a fallback."
      };
    });
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
