import { createId } from "./utils.js";
import { normalizePromptTemplates } from "./prompt-templates.js";

const ROLE_NEEDS = {
  supervisor_dispatch: ["supervisor", "leader", "planning", "analysis"],
  specialist_work: ["specialist", "domain", "general"],
  supervisor_review: ["supervisor", "leader", "review", "summary"],
  analysis: ["analysis", "research", "domain"],
  planning: ["planning", "architecture"],
  implementation: ["coding", "frontend", "backend", "writing", "data", "ops", "general"],
  review: ["review", "testing", "quality"],
  summary: ["summary", "communication", "writing"]
};

const KEYWORD_CAPABILITIES = [
  [["front", "frontend", "ui", "react", "vue", "页面", "前端", "界面", "组件"], ["frontend", "ui", "coding"]],
  [["back", "backend", "api", "server", "database", "后端", "接口", "数据库", "存储"], ["backend", "api", "storage", "coding"]],
  [["test", "review", "qa", "测试", "审查", "验证", "质量"], ["testing", "review", "quality"]],
  [["doc", "readme", "write", "文档", "总结", "分享", "文章"], ["writing", "summary", "communication"]],
  [["research", "compare", "survey", "调研", "比较", "分析"], ["research", "analysis"]],
  [["deploy", "ops", "infra", "部署", "运维", "内网"], ["ops", "infra"]],
  [["data", "csv", "excel", "chart", "数据", "表格", "图表"], ["data", "analysis"]],
  [["维度", "维值", "dimension", "member"], ["dimension", "model", "domain"]],
  [["模型", "指标", "model", "measure"], ["model", "data", "domain"]],
  [["表单", "form", "sheet"], ["form", "ui", "domain"]],
  [["权限", "access", "permission"], ["permission", "access", "domain"]],
  [["规则", "rule", "formula"], ["rule", "calculation", "domain"]],
  [["集成", "integration", "interface"], ["integration", "api", "domain"]],
  [["作业流", "workflow", "flow"], ["workflow", "ops", "domain"]]
];

export function normalizePolicy(policy = {}) {
  return {
    mode: policy.mode || "supervisor",
    requireReview: policy.requireReview ?? policy.require_review ?? true,
    maxParallel: Math.max(1, Number(policy.maxParallel ?? policy.max_parallel ?? 2)),
    fallbackDispatch: normalizeFallbackDispatch(policy.fallbackDispatch ?? policy.fallback_dispatch),
    roomContextLimit: clampInt(policy.roomContextLimit ?? policy.room_context_limit, 6, 0, 20),
    taskMessageLimit: clampInt(policy.taskMessageLimit ?? policy.task_message_limit, 12, 0, 50),
    supervisorExtraPrompt: String(policy.supervisorExtraPrompt ?? policy.supervisor_extra_prompt ?? "").trim(),
    specialistExtraPrompt: String(policy.specialistExtraPrompt ?? policy.specialist_extra_prompt ?? "").trim(),
    reviewExtraPrompt: String(policy.reviewExtraPrompt ?? policy.review_extra_prompt ?? "").trim(),
    promptTemplates: normalizePromptTemplates(policy.promptTemplates ?? policy.prompt_templates)
  };
}

function normalizeFallbackDispatch(value) {
  return ["none", "keyword", "all"].includes(value) ? value : "none";
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

export function inferCapabilities(goal) {
  const lower = String(goal || "").toLowerCase();
  const caps = new Set();
  for (const [keywords, capabilities] of KEYWORD_CAPABILITIES) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      for (const capability of capabilities) {
        caps.add(capability);
      }
    }
  }
  if (caps.size === 0) {
    caps.add("general");
  }
  return [...caps];
}

export function createTaskGraph({ goal, policy, requestedStages = [] }) {
  if (Array.isArray(requestedStages) && requestedStages.length > 0) {
    return requestedStages.map((stage, index) => normalizeStage(stage, index));
  }

  if (normalizePolicy(policy).mode === "supervisor") {
    return [
      {
        type: "supervisor_dispatch",
        title: "Supervisor Dispatch",
        needs: ["supervisor", "planning", "analysis"]
      }
    ].map((stage, index) => normalizeStage(stage, index));
  }

  const inferred = inferCapabilities(goal);
  const stages = [
    {
      type: "analysis",
      title: "Understand",
      needs: ["analysis", "research", "domain"]
    },
    {
      type: "planning",
      title: "Plan",
      needs: ["planning", "architecture"]
    },
    {
      type: "implementation",
      title: "Execute",
      needs: unique(["coding", ...inferred])
    }
  ];

  if (normalizePolicy(policy).requireReview) {
    stages.push({
      type: "review",
      title: "Review",
      needs: ["review", "testing", "quality"]
    });
  }

  stages.push({
    type: "summary",
    title: "Summarize",
    needs: ["summary", "communication", "writing"]
  });

  return stages.map((stage, index) => normalizeStage(stage, index));
}

export function assignStages({ room, task, busy = new Set() }) {
  const policy = normalizePolicy(room.policy);
  const assignmentCounts = new Map();
  return task.stages.map((stage, index) => {
    const agentId = stage.assignedAgentId || selectAgent({
      room,
      stage,
      policy,
      index,
      busy,
      assignmentCounts
    })?.agentId || null;
    if (agentId) {
      assignmentCounts.set(agentId, (assignmentCounts.get(agentId) || 0) + 1);
    }
    return {
      ...stage,
      assignedAgentId: agentId
    };
  });
}

export function selectAgent({ room, stage, policy, index, busy = new Set(), assignmentCounts = new Map() }) {
  const members = room.members || [];
  if (members.length === 0) {
    return null;
  }

  if (stage.assignedAgentId) {
    return members.find((member) => member.agentId === stage.assignedAgentId) || null;
  }

  if (policy.mode === "supervisor") {
    if (["supervisor_dispatch", "supervisor_review"].includes(stage.type)) {
      return findSupervisorMember(members);
    }
    return findNonSupervisorMember(members, index) || findSupervisorMember(members);
  }

  if (policy.mode === "round_robin") {
    return members[index % members.length];
  }

  if (policy.mode === "leader") {
    const leader = findByRoleOrCapability(members, ["leader", "planner", "planning", "architecture"]);
    if (["analysis", "planning", "summary"].includes(stage.type) && leader) {
      return leader;
    }
  }

  const scored = members
    .map((member) => ({
      member,
      score: scoreMember(member, stage, busy),
      assignedCount: assignmentCounts.get(member.agentId) || 0,
      roundRobinDistance: roundRobinDistance(members, member, index)
    }))
    .sort((a, b) => (
      b.score - a.score
      || a.assignedCount - b.assignedCount
      || a.roundRobinDistance - b.roundRobinDistance
      || a.member.agentId.localeCompare(b.member.agentId)
    ));

  return scored[0]?.member || members[0];
}

export function scoreMember(member, stage, busy = new Set()) {
  const roles = new Set((member.roles || []).map((item) => item.toLowerCase()));
  const capabilities = new Set((member.capabilities || []).map((item) => item.toLowerCase()));
  const needs = new Set([...(stage.needs || []), ...(ROLE_NEEDS[stage.type] || [])].map((item) => item.toLowerCase()));

  let score = 0;
  for (const need of needs) {
    if (capabilities.has(need)) {
      score += 3;
    }
    if (roles.has(need)) {
      score += 2;
    }
  }

  if (stage.type === "planning" && roles.has("planner")) {
    score += 2;
  }
  if (stage.type === "implementation" && roles.has("implementer")) {
    score += 2;
  }
  if (stage.type === "review" && roles.has("reviewer")) {
    score += 2;
  }
  if (stage.type === "summary" && roles.has("summarizer")) {
    score += 2;
  }

  score += busy.has(member.agentId) ? -2 : 1;
  return score;
}

function normalizeStage(stage, index) {
  return {
    id: stage.id || createId("stage"),
    order: Number(stage.order ?? index),
    type: stage.type || "implementation",
    title: stage.title || titleForType(stage.type || "implementation"),
    needs: Array.isArray(stage.needs) && stage.needs.length > 0
      ? unique(stage.needs.map(String))
      : ROLE_NEEDS[stage.type] || ["general"],
    assignedAgentId: stage.assignedAgentId || stage.assigned_agent_id || null,
    status: "queued",
    result: null,
    error: null,
    startedAt: null,
    completedAt: null
  };
}

function findByRoleOrCapability(members, tags) {
  const wanted = new Set(tags.map((item) => item.toLowerCase()));
  return members.find((member) => {
    const values = [...(member.roles || []), ...(member.capabilities || [])].map((item) => item.toLowerCase());
    return values.some((value) => wanted.has(value));
  });
}

export function findSupervisorMember(members = []) {
  return members.find((member) => {
    return (member.roles || []).some((role) => isSupervisorRole(role));
  }) || members[0] || null;
}

function isSupervisorRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return [
    "supervisor",
    "leader",
    "coordinator",
    "中枢",
    "总控",
    "主控"
  ].some((keyword) => normalized === keyword || normalized.includes(keyword));
}

function findNonSupervisorMember(members, index) {
  const supervisor = findSupervisorMember(members);
  const candidates = members.filter((member) => member.agentId !== supervisor?.agentId);
  if (!candidates.length) {
    return null;
  }
  return candidates[index % candidates.length];
}

function titleForType(type) {
  return {
    supervisor_dispatch: "Supervisor Dispatch",
    specialist_work: "Specialist Work",
    supervisor_review: "Supervisor Review",
    analysis: "Understand",
    planning: "Plan",
    implementation: "Execute",
    review: "Review",
    summary: "Summarize"
  }[type] || "Execute";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function roundRobinDistance(members, member, index) {
  const current = members.findIndex((item) => item.agentId === member.agentId);
  if (current < 0 || members.length === 0) {
    return 0;
  }
  return (current - (index % members.length) + members.length) % members.length;
}
