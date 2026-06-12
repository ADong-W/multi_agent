const state = {
  token: localStorage.getItem("teamroom.token") || "",
  agents: [],
  rooms: [],
  activeRoomId: localStorage.getItem("teamroom.activeRoomId") || "",
  activeRoom: null,
  tasks: [],
  events: [],
  expandedRooms: new Set(),
  expandedAgents: new Set(),
  expandedMessages: new Set(),
  expandedTasks: new Set(),
  configOpen: false,
  configTab: "agent-files",
  configAgentId: localStorage.getItem("teamroom.configAgentId") || "",
  configFileName: localStorage.getItem("teamroom.configFileName") || "AGENTS.md",
  configRoomId: localStorage.getItem("teamroom.configRoomId") || "",
  agentFiles: new Map(),
  promptDefaults: null,
  promptPlaceholders: [],
  source: null,
  sourceRoomId: "",
  reconnectingOpenClaw: false,
  activePromptTemplateKey: localStorage.getItem("teamroom.activePromptTemplateKey") || "supervisorDispatch"
};

let retryCountdownTimer = null;

const OPENCLAW_AGENT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md"
];

const PROMPT_TEMPLATE_KEYS = [
  "supervisorDispatch",
  "specialistWork",
  "supervisorReview",
  "previousOutputItem",
  "roomContextItem",
  "taskMessageItem"
];

const PROMPT_TEMPLATE_META = [
  {
    key: "supervisorDispatch",
    title: "Supervisor 派工",
    group: "主模板",
    tone: "需求分析与任务拆解",
    description: "TeamRoom 首次接收用户需求后，发送给总控 Agent，用于判断影响范围并输出可解析派工 JSON。",
    textarea: "supervisorDispatchTemplateInput"
  },
  {
    key: "specialistWork",
    title: "Specialist 执行",
    group: "主模板",
    tone: "专业子 Agent 处理",
    description: "总控派出子任务后，发送给专业 Agent，包含原始需求、派工理由、前序输出与人工补充。",
    textarea: "specialistWorkTemplateInput"
  },
  {
    key: "supervisorReview",
    title: "Supervisor 终审",
    group: "主模板",
    tone: "汇总审核与人工确认判定",
    description: "所有子 Agent 返回后，发送给总控 Agent，用于最终审核、判断 completed / pending / waiting。",
    textarea: "supervisorReviewTemplateInput"
  },
  {
    key: "previousOutputItem",
    title: "前序输出拼接",
    group: "拼接子模板",
    tone: "agent 间上下文传递",
    description: "控制 TeamRoom 如何把前一个阶段的输出拼进后续 Agent 的 prompt。",
    textarea: "previousOutputItemTemplateInput"
  },
  {
    key: "roomContextItem",
    title: "历史任务拼接",
    group: "拼接子模板",
    tone: "协作室长期上下文",
    description: "控制已完成历史任务如何进入当前任务 prompt，影响跨任务记忆的表达方式。",
    textarea: "roomContextItemTemplateInput"
  },
  {
    key: "taskMessageItem",
    title: "人工消息拼接",
    group: "拼接子模板",
    tone: "人类补充与干预",
    description: "控制中间聊天窗里人工补充、确认点回复、继续任务指令如何进入后续 prompt。",
    textarea: "taskMessageItemTemplateInput"
  }
];

const PROMPT_VARIABLE_GUIDE = [
  ["agentName", "当前被调用的 OpenClaw Agent 展示名称。"],
  ["agentId", "当前被调用的 Agent ID，用于派发子任务和标记输出来源。"],
  ["roomName", "当前协作室名称。"],
  ["roomMembers", "当前协作室里的 Agent 成员清单，包含角色标签、能力标签和可调度状态。"],
  ["goal", "用户发布的当前任务原始需求。"],
  ["roomContext", "协作室共享历史上下文，会按配置注入最近任务摘要。"],
  ["taskMessages", "当前任务里，人类在中间聊天窗补充、干预、确认的信息。"],
  ["previousOutputs", "当前任务已完成阶段的 Agent 输出汇总。"],
  ["memberRoles", "当前被调用 Agent 的角色标签。"],
  ["memberCapabilities", "当前被调用 Agent 的专业能力标签。"],
  ["stageTitle", "当前派发阶段的标题。"],
  ["stageType", "当前阶段类型，供模板区分派工、执行、复核等阶段。"],
  ["stageGoal", "总控派给当前子 Agent 的具体阶段目标。"],
  ["stageNeeds", "当前阶段需要的能力标签。"],
  ["stageReason", "总控把任务派给该 Agent 的原因。"],
  ["resumeInstruction", "任务中断后继续执行时注入的续跑说明。"],
  ["dispatchJsonContract", "Supervisor 派工阶段必须遵守的机器可读 JSON 输出格式。"],
  ["reviewJsonContract", "Supervisor 终审阶段必须遵守的机器可读 JSON 输出格式。"],
  ["supervisorExtraPrompt", "协作策略里追加给总控阶段的自定义提示。"],
  ["specialistExtraPrompt", "协作策略里追加给专业子 Agent 阶段的自定义提示。"],
  ["reviewExtraPrompt", "协作策略里追加给总控终审阶段的自定义提示。"],
  ["fallbackWarning", "JSON 解析失败且未开启兜底派工时，注入给总控的提醒。"],
  ["index", "拼接列表中的序号，常用于历史任务或前序输出模板。"],
  ["title", "前序阶段或输出标题。"],
  ["summary", "历史任务摘要或前序阶段输出摘要。"],
  ["status", "历史任务状态。"],
  ["completedAt", "历史任务完成时间。"],
  ["timestamp", "人工消息发生时间。"],
  ["author", "人工消息作者。"],
  ["content", "人工消息正文。"]
];

const STAGE_TITLE_LABELS = {
  "Supervisor Dispatch": "需求分析·任务拆解",
  "Supervisor Conversation": "总控对话",
  "Supervisor Review": "任务汇总审核"
};

const PROFILE_PRESETS = [
  {
    key: "supervisor",
    label: "总控",
    roles: ["supervisor", "leader", "planner"],
    capabilities: ["supervisor", "analysis", "planning", "review", "summary"]
  },
  {
    key: "dimension_model",
    label: "维度/模型",
    roles: ["specialist"],
    capabilities: ["dimension", "model", "data", "domain"]
  },
  {
    key: "form",
    label: "表单",
    roles: ["specialist"],
    capabilities: ["form", "ui", "domain"]
  },
  {
    key: "permission",
    label: "权限",
    roles: ["specialist"],
    capabilities: ["permission", "access", "domain"]
  },
  {
    key: "rule",
    label: "规则",
    roles: ["specialist"],
    capabilities: ["rule", "calculation", "domain"]
  },
  {
    key: "integration",
    label: "集成",
    roles: ["specialist"],
    capabilities: ["integration", "api", "domain"]
  },
  {
    key: "workflow",
    label: "作业流",
    roles: ["specialist"],
    capabilities: ["workflow", "ops", "domain"]
  }
];

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  shell: document.querySelector(".shell"),
  reconnectOpenClawButton: document.querySelector("#reconnectOpenClawButton"),
  openConfigButton: document.querySelector("#openConfigButton"),
  closeConfigButton: document.querySelector("#closeConfigButton"),
  configView: document.querySelector("#configView"),
  configStatus: document.querySelector("#configStatus"),
  configTabs: [...document.querySelectorAll("[data-config-tab]")],
  agentFilesPanel: document.querySelector("#agentFilesPanel"),
  teamroomPolicyPanel: document.querySelector("#teamroomPolicyPanel"),
  configAgentSelect: document.querySelector("#configAgentSelect"),
  agentFileWorkspace: document.querySelector("#agentFileWorkspace"),
  agentFileTabs: document.querySelector("#agentFileTabs"),
  agentFileEditor: document.querySelector("#agentFileEditor"),
  saveAgentFileButton: document.querySelector("#saveAgentFileButton"),
  configRoomSelect: document.querySelector("#configRoomSelect"),
  configFallbackDispatchInput: document.querySelector("#configFallbackDispatchInput"),
  configRequireReviewInput: document.querySelector("#configRequireReviewInput"),
  configRoomContextLimitInput: document.querySelector("#configRoomContextLimitInput"),
  configTaskMessageLimitInput: document.querySelector("#configTaskMessageLimitInput"),
  promptPlaceholders: document.querySelector("#promptPlaceholders"),
  promptVariableGuide: document.querySelector("#promptVariableGuide"),
  promptTemplateSummary: document.querySelector("#promptTemplateSummary"),
  promptTemplateNav: document.querySelector("#promptTemplateNav"),
  supervisorDispatchTemplateInput: document.querySelector("#supervisorDispatchTemplateInput"),
  specialistWorkTemplateInput: document.querySelector("#specialistWorkTemplateInput"),
  supervisorReviewTemplateInput: document.querySelector("#supervisorReviewTemplateInput"),
  previousOutputItemTemplateInput: document.querySelector("#previousOutputItemTemplateInput"),
  roomContextItemTemplateInput: document.querySelector("#roomContextItemTemplateInput"),
  taskMessageItemTemplateInput: document.querySelector("#taskMessageItemTemplateInput"),
  resetCurrentPromptTemplateButton: document.querySelector("#resetCurrentPromptTemplateButton"),
  resetPolicyTemplatesButton: document.querySelector("#resetPolicyTemplatesButton"),
  savePolicyConfigButton: document.querySelector("#savePolicyConfigButton"),
  tokenInput: document.querySelector("#tokenInput"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  createRoomButton: document.querySelector("#createRoomButton"),
  roomForm: document.querySelector("#roomForm"),
  roomNameInput: document.querySelector("#roomNameInput"),
  roomsList: document.querySelector("#roomsList"),
  refreshAgentsButton: document.querySelector("#refreshAgentsButton"),
  agentsList: document.querySelector("#agentsList"),
  activeRoomName: document.querySelector("#activeRoomName"),
  activeRoomPolicy: document.querySelector("#activeRoomPolicy"),
  memberChips: document.querySelector("#memberChips"),
  eventsFeed: document.querySelector("#eventsFeed"),
  chatForm: document.querySelector("#chatForm"),
  chatMessageInput: document.querySelector("#chatMessageInput"),
  taskForm: document.querySelector("#taskForm"),
  taskGoalInput: document.querySelector("#taskGoalInput"),
  cancelTaskButton: document.querySelector("#cancelTaskButton"),
  activeTaskStatus: document.querySelector("#activeTaskStatus"),
  tasksList: document.querySelector("#tasksList")
};

els.tokenInput.value = state.token;

els.saveTokenButton.addEventListener("click", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("teamroom.token", state.token);
  refreshAll();
});

window.addEventListener("resize", () => {
  window.requestAnimationFrame(() => {
    fitMemberGraphRows();
    drawMemberGraphLines();
  });
});

els.refreshAgentsButton.addEventListener("click", () => {
  loadAgents();
});

els.reconnectOpenClawButton.addEventListener("click", async () => {
  await reconnectOpenClaw();
});

els.createRoomButton.addEventListener("click", () => {
  els.roomForm.classList.toggle("hidden");
  if (!els.roomForm.classList.contains("hidden")) {
    els.roomNameInput.focus();
  }
});

els.openConfigButton.addEventListener("click", async () => {
  await openConfigView();
});

els.closeConfigButton.addEventListener("click", () => {
  closeConfigView();
});

els.configTabs.forEach((button) => {
  button.addEventListener("click", async () => {
    state.configTab = button.dataset.configTab;
    renderConfigView();
    if (state.configTab === "agent-files") {
      await loadSelectedAgentFiles();
    }
  });
});

els.configAgentSelect.addEventListener("change", async () => {
  state.configAgentId = els.configAgentSelect.value;
  localStorage.setItem("teamroom.configAgentId", state.configAgentId);
  await loadSelectedAgentFiles({ force: true });
});

els.configRoomSelect.addEventListener("change", () => {
  state.configRoomId = els.configRoomSelect.value;
  localStorage.setItem("teamroom.configRoomId", state.configRoomId);
  renderTeamRoomConfigForm();
});

els.saveAgentFileButton.addEventListener("click", async () => {
  await saveSelectedAgentFile();
});

els.savePolicyConfigButton.addEventListener("click", async () => {
  await saveTeamRoomPolicyConfig();
});

els.resetPolicyTemplatesButton.addEventListener("click", () => {
  fillPromptTemplateInputs(state.promptDefaults || {});
  renderPromptTemplateNav();
  setConfigStatus("已填入默认模板，点击保存后生效");
});

els.resetCurrentPromptTemplateButton.addEventListener("click", () => {
  resetCurrentPromptTemplate();
});

PROMPT_TEMPLATE_META.forEach((meta) => {
  const textarea = els[meta.textarea];
  textarea?.addEventListener("focus", () => {
    setActivePromptTemplate(meta.key);
  });
  textarea?.addEventListener("input", () => {
    renderPromptTemplateNav();
  });
});

els.roomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = els.roomNameInput.value.trim() || "实施设计协作室";
  const payload = {
    name,
    policy: {
      mode: "supervisor",
      requireReview: true,
      maxParallel: 2
    }
  };
  const { room } = await api("/api/rooms", {
    method: "POST",
    body: payload
  });
  els.roomNameInput.value = "";
  els.roomForm.classList.add("hidden");
  state.activeRoomId = room.id;
  localStorage.setItem("teamroom.activeRoomId", room.id);
  await refreshAll();
});

els.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeRoomId) {
    return;
  }
  const goal = els.taskGoalInput.value.trim();
  if (!goal) {
    return;
  }
  els.taskGoalInput.value = "";
  try {
    await api(`/api/rooms/${state.activeRoomId}/tasks`, {
      method: "POST",
      body: { goal }
    });
    setTimeout(loadActiveRoom, 300);
  } catch (error) {
    setConnection(error.message);
    els.taskGoalInput.value = goal;
  }
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeRoomId) {
    return;
  }
  const content = els.chatMessageInput.value.trim();
  if (!content) {
    return;
  }
  els.chatMessageInput.value = "";
  await submitHumanContent(content, {
    restoreOnError: () => {
      els.chatMessageInput.value = content;
    }
  });
});

async function submitHumanContent(content, { restoreOnError } = {}) {
  try {
    const result = await api(`/api/rooms/${state.activeRoomId}/messages`, {
      method: "POST",
      body: { content }
    });
    appendLocalEvent(result.event || createLocalMessageEvent(content));
    setTimeout(loadActiveRoom, 300);
  } catch (error) {
    setConnection(error.message);
    if (typeof restoreOnError === "function") {
      restoreOnError();
    }
  }
}

async function reconnectOpenClaw() {
  if (!state.activeRoomId || state.reconnectingOpenClaw) {
    return;
  }
  const runningStage = runningStageForActiveTask();
  if (runningStage && !window.confirm("当前有阶段正在执行。手动重连会刷新执行后端连接，并可能让该阶段进入自动续接。继续重连吗？")) {
    return;
  }
  state.reconnectingOpenClaw = true;
  setConnection("Reconnecting");
  renderTopbarActions();
  try {
    await api(`/api/rooms/${state.activeRoomId}/runtime/reconnect`, {
      method: "POST",
      body: {}
    });
    setConnection("Connected");
    await Promise.all([loadAgents(), loadActiveRoom()]);
  } catch (error) {
    setConnection(error.message || "执行后端重连失败");
  } finally {
    state.reconnectingOpenClaw = false;
    renderTopbarActions();
  }
}

els.cancelTaskButton.addEventListener("click", async () => {
  const task = activeTask();
  if (!state.activeRoomId || !task) {
    return;
  }
  if (!window.confirm(`终止当前任务“${task.goal}”？终止后才能发布新任务。`)) {
    return;
  }
  await api(`/api/rooms/${state.activeRoomId}/tasks/${encodeURIComponent(task.id)}/cancel`, {
    method: "POST",
    body: { reason: "Human terminated the task." }
  });
  await loadActiveRoom();
});

async function refreshAll() {
  await Promise.all([loadAgents(), loadRooms()]);
  if (!state.activeRoomId && state.rooms[0]) {
    state.activeRoomId = state.rooms[0].id;
  }
  if (!state.configRoomId && state.activeRoomId) {
    state.configRoomId = state.activeRoomId;
  }
  if (!state.configAgentId && state.agents[0]) {
    state.configAgentId = state.agents[0].id;
  }
  await loadActiveRoom();
  render();
}

async function openConfigView() {
  state.configOpen = true;
  state.configRoomId = state.activeRoomId || state.configRoomId || state.rooms[0]?.id || "";
  state.configAgentId = state.configAgentId || state.agents[0]?.id || "";
  els.shell.classList.add("config-open");
  els.configView.classList.remove("hidden");
  try {
    await loadPromptDefaults();
  } catch (error) {
    setConfigStatus(error.message);
  }
  renderConfigView();
  if (state.configTab === "agent-files") {
    await loadSelectedAgentFiles();
  }
}

function closeConfigView() {
  state.configOpen = false;
  els.shell.classList.remove("config-open");
  els.configView.classList.add("hidden");
}

async function loadPromptDefaults() {
  if (state.promptDefaults) {
    return;
  }
  const payload = await api("/api/config/prompt-templates");
  state.promptDefaults = payload.promptTemplates || {};
  state.promptPlaceholders = payload.placeholders || [];
}

async function loadSelectedAgentFiles({ force = false } = {}) {
  if (!state.configAgentId) {
    renderAgentFileConfig();
    return;
  }
  if (!force && state.agentFiles.has(state.configAgentId)) {
    renderAgentFileConfig();
    return;
  }
  setConfigStatus("正在加载 agent 文件...");
  try {
    const payload = await api(`/api/openclaw/agents/${encodeURIComponent(state.configAgentId)}/files`);
    state.agentFiles.set(state.configAgentId, payload);
    setConfigStatus("Agent 文件已加载");
  } catch (error) {
    setConfigStatus(error.message);
  }
  renderAgentFileConfig();
}

async function saveSelectedAgentFile() {
  if (!state.configAgentId || !state.configFileName) {
    return;
  }
  setConfigStatus("正在保存 agent 文件...");
  try {
    const result = await api(`/api/openclaw/agents/${encodeURIComponent(state.configAgentId)}/files/${encodeURIComponent(state.configFileName)}`, {
      method: "PUT",
      body: { content: els.agentFileEditor.value }
    });
    const cached = state.agentFiles.get(state.configAgentId) || { files: [] };
    const nextFiles = OPENCLAW_AGENT_FILES.map((name) => {
      if (name === result.file.name) {
        return result.file;
      }
      return cached.files?.find((file) => file.name === name) || { name, exists: false, content: "" };
    });
    state.agentFiles.set(state.configAgentId, { ...cached, ...result, files: nextFiles });
    setConfigStatus(`${state.configFileName} 已保存`);
    renderAgentFileConfig();
  } catch (error) {
    setConfigStatus(error.message);
  }
}

async function saveTeamRoomPolicyConfig() {
  const room = selectedConfigRoom();
  if (!room) {
    return;
  }
  const policy = readTeamRoomConfigForm(room.policy || {});
  setConfigStatus("正在保存协作配置...");
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(room.id)}/policy`, {
      method: "PUT",
      body: { policy }
    });
    state.rooms = state.rooms.map((item) => item.id === result.room.id ? result.room : item);
    if (state.activeRoomId === result.room.id) {
      state.activeRoom = result.room;
    }
    setConfigStatus("协作配置已保存");
    renderRooms();
    renderActiveRoom();
    renderTeamRoomConfigForm();
  } catch (error) {
    setConfigStatus(error.message);
  }
}

async function loadAgents() {
  const payload = await api("/api/agents");
  state.agents = payload.agents || [];
  renderAgents();
}

async function loadRooms() {
  const payload = await api("/api/rooms");
  state.rooms = payload.rooms || [];
  renderRooms();
}

async function loadActiveRoom() {
  if (!state.activeRoomId) {
    state.activeRoom = null;
    state.tasks = [];
    connectEvents();
    render();
    return;
  }
  try {
    const payload = await api(`/api/rooms/${state.activeRoomId}`);
    state.activeRoom = payload.room;
    upsertRoomInList(payload.room);
    state.tasks = payload.tasks || [];
    localStorage.setItem("teamroom.activeRoomId", state.activeRoomId);
    connectEvents();
    render();
  } catch (error) {
    state.activeRoomId = "";
    state.activeRoom = null;
    state.tasks = [];
    render();
  }
}

function upsertRoomInList(room) {
  if (!room?.id) {
    return;
  }
  const index = state.rooms.findIndex((item) => item.id === room.id);
  if (index >= 0) {
    state.rooms[index] = room;
  } else {
    state.rooms.unshift(room);
  }
}

function connectEvents() {
  if (state.source && state.sourceRoomId === state.activeRoomId) {
    return;
  }
  if (state.source) {
    state.source.close();
    state.source = null;
    state.sourceRoomId = "";
  }
  state.events = [];
  if (!state.activeRoomId) {
    setConnection("Disconnected");
    return;
  }

  const url = new URL(`/api/rooms/${state.activeRoomId}/events`, window.location.href);
  if (state.token) {
    url.searchParams.set("token", state.token);
  }

  const source = new EventSource(url);
  state.source = source;
  state.sourceRoomId = state.activeRoomId;
  source.onopen = () => setConnection("Connected");
  source.onerror = () => setConnection("Reconnecting");
  const eventNames = [
    "room.created",
    "room.policy_updated",
    "runtime.reconnect_started",
    "runtime.reconnect_completed",
    "runtime.reconnect_failed",
    "runtime.approval_requested",
    "runtime.approval_resolved",
    "member.added",
    "member.removed",
    "message.created",
    "task.created",
    "task.planned",
    "task.running",
    "task.pending",
    "task.retry_scheduled",
    "task.wait_scheduled",
    "task.delivered",
    "task.audit_completed",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "task.resumed",
    "task.resume_skipped",
    "stage.assigned",
    "stage.running",
    "stage.progress",
    "stage.stream",
    "stage.awaiting_agent",
    "stage.result_received",
    "stage.review_decision",
    "stage.auto_continue",
    "stage.completed",
    "stage.failed"
  ];
  for (const name of eventNames) {
    source.addEventListener(name, (message) => {
      const event = JSON.parse(message.data);
      appendLocalEvent(event);
      if (name.startsWith("task.") || name.startsWith("stage.") || name.startsWith("member.") || name.startsWith("room.") || name.startsWith("runtime.")) {
        loadActiveRoom();
      }
    });
  }
}

function appendLocalEvent(event) {
  if (!event?.id || state.events.some((item) => item.id === event.id)) {
    return;
  }
  if (event.type === "stage.stream") {
    const segmentKey = streamSegmentKey(event);
    const segmentCount = Number(event.payload?.streamSegment?.segmentCount || 0);
    state.events = state.events.filter((item) => !(
      item.type === "stage.stream"
      && item.taskId === event.taskId
      && item.stageId === event.stageId
      && streamSegmentKey(item) === segmentKey
    ) && !(
      item.type === "stage.stream"
      && segmentCount > 0
      && item.taskId === event.taskId
      && item.stageId === event.stageId
      && Number(streamSegmentKey(item)) >= segmentCount
    ));
  }
  if (isLocalEvent(event) && state.events.some((item) => isMatchingServerMessage(item, event))) {
    return;
  }
  if (!isLocalEvent(event)) {
    state.events = state.events.filter((item) => !isMatchingLocalMessage(item, event));
  }
  state.events.push(event);
  state.events = state.events.slice(-150);
  renderEvents();
}

function streamSegmentKey(event = {}) {
  const segment = event.payload?.streamSegment || {};
  return String(segment.segmentIndex ?? event.payload?.segmentIndex ?? 0);
}

function createLocalMessageEvent(content) {
  const task = activeTask();
  return {
    id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    roomId: state.activeRoomId,
    taskId: task?.id,
    type: "message.created",
    timestamp: new Date().toISOString(),
    payload: {
      taskId: task?.id,
      author: "human",
      content
    }
  };
}

function isLocalEvent(event) {
  return String(event?.id || "").startsWith("local-");
}

function isMatchingServerMessage(event, localEvent) {
  return !isLocalEvent(event) && isMatchingMessage(event, localEvent);
}

function isMatchingLocalMessage(event, serverEvent) {
  return isLocalEvent(event) && isMatchingMessage(event, serverEvent);
}

function isMatchingMessage(left, right) {
  if (left?.type !== "message.created" || right?.type !== "message.created") {
    return false;
  }
  const sameTask = (left.payload?.taskId || "") === (right.payload?.taskId || "");
  const sameContent = (left.payload?.content || "") === (right.payload?.content || "");
  const leftTime = new Date(left.timestamp || 0).getTime();
  const rightTime = new Date(right.timestamp || 0).getTime();
  return sameTask && sameContent && Math.abs(leftTime - rightTime) < 15000;
}

function setConnection(text) {
  els.connectionStatus.textContent = text;
  const normalized = String(text || "").toLowerCase();
  els.connectionStatus.classList.toggle("connected", normalized === "connected");
  els.connectionStatus.classList.toggle("reconnecting", normalized === "reconnecting");
  els.connectionStatus.classList.toggle("disconnected", normalized === "disconnected");
  els.connectionStatus.classList.toggle(
    "error",
    Boolean(text) && !["connected", "reconnecting", "disconnected"].includes(normalized)
  );
}

function render() {
  renderTopbarActions();
  renderRooms();
  renderAgents();
  renderActiveRoom();
  renderEvents();
  renderTasks();
  if (state.configOpen) {
    renderConfigView();
  }
}

function renderTopbarActions() {
  if (!els.reconnectOpenClawButton) {
    return;
  }
  els.reconnectOpenClawButton.disabled = !state.activeRoomId || state.reconnectingOpenClaw;
  els.reconnectOpenClawButton.classList.toggle("loading", state.reconnectingOpenClaw);
  const label = els.reconnectOpenClawButton.querySelector(".reconnect-label");
  if (label) {
    label.textContent = state.reconnectingOpenClaw ? "重连中" : "重连";
  }
}

function renderRooms() {
  const previousScrollTop = els.roomsList.scrollTop;
  if (!state.rooms.length) {
    els.roomsList.innerHTML = `<div class="empty">暂无协作室</div>`;
    return;
  }
  els.roomsList.innerHTML = state.rooms.map((room) => {
    const displayRoom = state.activeRoom?.id === room.id ? state.activeRoom : room;
    const members = displayRoom.members || [];
    const expanded = state.expandedRooms.has(room.id);
    return `
    <article class="room-card ${room.id === state.activeRoomId ? "active" : ""} ${expanded ? "expanded" : ""}" data-room-card="${escapeHtml(room.id)}">
      <div class="room-summary" data-room-toggle="${escapeHtml(room.id)}" role="button" tabindex="0" aria-expanded="${expanded ? "true" : "false"}">
        <span class="summary-caret" aria-hidden="true">›</span>
        <span class="room-summary-main">
          <span class="room-name">${escapeHtml(room.name)}</span>
        </span>
        <button type="button" class="danger-button" data-delete-room="${escapeHtml(room.id)}" title="删除协作室">删除</button>
      </div>
      <div class="room-body">
        <div class="room-id-row">
          <span>协作室 ID</span>
          <code>${escapeHtml(displayRoom.id)}</code>
        </div>
        <div class="meta">共 ${members.length} 个 agents</div>
        <div class="room-member-list">
          ${members.length
            ? members.map((member) => `<span class="room-member-chip" title="${escapeHtml(member.agentId || member.name || "")}">${escapeHtml(member.name || member.agentId)}</span>`).join("")
            : `<span class="room-member-chip muted">暂无成员</span>`}
        </div>
      </div>
    </article>
  `;
  }).join("");
  els.roomsList.scrollTop = previousScrollTop;

  els.roomsList.querySelectorAll("[data-room-toggle]").forEach((toggle) => {
    const activate = async () => {
      const roomId = toggle.dataset.roomToggle;
      const wasActive = state.activeRoomId === roomId;
      state.activeRoomId = roomId;
      if (state.expandedRooms.has(roomId) && wasActive) {
        state.expandedRooms.delete(roomId);
      } else {
        state.expandedRooms.add(roomId);
      }
      await loadActiveRoom();
    };
    toggle.addEventListener("click", activate);
    toggle.addEventListener("keydown", (event) => {
      if (event.target.closest("button, input, textarea, select")) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });

  els.roomsList.querySelectorAll("[data-delete-room]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const roomId = button.dataset.deleteRoom;
      const room = state.rooms.find((item) => item.id === roomId);
      if (!window.confirm(`删除协作室“${room?.name || roomId}”？历史任务和事件也会一起删除。`)) {
        return;
      }
      button.disabled = true;
      try {
        await deleteRoom(roomId);
      } catch (error) {
        setConnection(error.message);
        await refreshAll();
      }
    });
  });
}

function renderAgents() {
  if (!state.agents.length) {
    els.agentsList.innerHTML = `<div class="empty">暂无 agents</div>`;
    return;
  }
  const memberIds = new Set((state.activeRoom?.members || []).map((member) => member.agentId));
  els.agentsList.innerHTML = state.agents.map((agent) => {
    const isMember = memberIds.has(agent.id);
    return `
    <article class="agent-card ${state.expandedAgents.has(agent.id) ? "expanded" : ""}" data-agent-card="${escapeHtml(agent.id)}">
      <div class="agent-summary" data-agent-toggle="${escapeHtml(agent.id)}" role="button" tabindex="0" aria-expanded="${state.expandedAgents.has(agent.id) ? "true" : "false"}">
        <span class="summary-caret" aria-hidden="true">›</span>
        <span class="agent-summary-main">
          <span class="agent-name">${escapeHtml(agent.name || agent.id)}</span>
        </span>
        <button
          type="button"
          class="agent-add-button ${isMember ? "is-member" : ""}"
          data-agent-membership="${escapeHtml(agent.id)}"
          data-is-member="${isMember ? "true" : "false"}"
          ${!state.activeRoomId ? "disabled" : ""}
          title="${isMember ? "从当前协作室移出" : "拉入当前协作室"}"
        >${isMember ? "移出" : "拉入"}</button>
      </div>
      <div class="agent-body">
        <div class="meta">${escapeHtml(agent.id)} · ${agent.profileSource === "local" ? "本地标签" : "OpenClaw 推断"}</div>
        <div class="tags">${renderAgentTags(agent)}</div>
      </div>
      <div class="profile-editor" data-profile-agent="${escapeHtml(agent.id)}">
        <div class="profile-inputs">
          <label class="profile-field">
            <span>协作角色</span>
            <input
              data-profile-roles="${escapeHtml(agent.id)}"
              value="${escapeHtml((agent.roles || []).join(", "))}"
              placeholder="例如 supervisor, specialist, reviewer"
              title="协作角色：用于判断总控、规划、执行、审核等协作身份"
            />
          </label>
          <label class="profile-field">
            <span>专业能力</span>
            <input
              data-profile-capabilities="${escapeHtml(agent.id)}"
              value="${escapeHtml((agent.capabilities || []).join(", "))}"
              placeholder="例如 dimension, form, permission"
              title="专业能力：用于描述 agent 擅长的业务或技术领域"
            />
          </label>
        </div>
        <div class="preset-row">
          ${PROFILE_PRESETS.map((preset) => `<button type="button" class="preset-button" data-preset-agent="${escapeHtml(agent.id)}" data-preset-key="${escapeHtml(preset.key)}">${escapeHtml(preset.label)}</button>`).join("")}
        </div>
        <div class="profile-actions">
          <button type="button" class="profile-action-button primary" data-save-profile="${escapeHtml(agent.id)}">保存标签</button>
          <button type="button" class="profile-action-button secondary" data-clear-profile="${escapeHtml(agent.id)}">清空</button>
        </div>
      </div>
    </article>
  `;
  }).join("");

  bindAgentToggles();

  els.agentsList.querySelectorAll("[data-agent-membership]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const agentId = button.dataset.agentMembership;
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent || !state.activeRoomId || button.disabled) {
        return;
      }
      button.disabled = true;
      try {
        if (button.dataset.isMember === "true") {
          await api(`/api/rooms/${state.activeRoomId}/members/${encodeURIComponent(agent.id)}`, {
            method: "DELETE"
          });
        } else {
          await api(`/api/rooms/${state.activeRoomId}/members`, {
            method: "POST",
            body: {
              agentId: agent.id,
              name: agent.name,
              roles: agent.roles || [],
              capabilities: agent.capabilities || []
            }
          });
        }
        await loadActiveRoom();
      } catch (error) {
        setConnection(error.message);
        button.disabled = false;
      }
    });
  });

  els.agentsList.querySelectorAll("[data-save-profile]").forEach((button) => {
    button.addEventListener("click", async () => {
      await saveAgentProfile(button.dataset.saveProfile);
    });
  });

  els.agentsList.querySelectorAll("[data-clear-profile]").forEach((button) => {
    button.addEventListener("click", async () => {
      await clearAgentProfile(button.dataset.clearProfile);
    });
  });

  els.agentsList.querySelectorAll("[data-preset-agent]").forEach((button) => {
    button.addEventListener("click", async () => {
      const preset = PROFILE_PRESETS.find((item) => item.key === button.dataset.presetKey);
      if (!preset) {
        return;
      }
      setAgentProfileInputs(button.dataset.presetAgent, preset);
      await saveAgentProfile(button.dataset.presetAgent);
    });
  });
}

function bindAgentToggles() {
  els.agentsList.querySelectorAll("[data-agent-toggle]").forEach((toggle) => {
    const activate = () => {
      const agentId = toggle.dataset.agentToggle;
      if (!agentId) {
        return;
      }
      if (state.expandedAgents.has(agentId)) {
        state.expandedAgents.delete(agentId);
      } else {
        state.expandedAgents.add(agentId);
      }
      renderAgents();
    };
    toggle.addEventListener("click", activate);
    toggle.addEventListener("keydown", (event) => {
      if (event.target.closest("button, input, textarea, select")) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function renderActiveRoom() {
  const room = state.activeRoom;
  if (!room) {
    els.activeRoomName.textContent = "未选择协作室";
    els.activeRoomPolicy.textContent = "协作策略";
    els.memberChips.innerHTML = "";
    els.taskForm.querySelector("button").disabled = true;
    els.chatForm.querySelector("button").disabled = true;
    els.cancelTaskButton.disabled = true;
    els.activeTaskStatus.textContent = "暂无当前任务";
    return;
  }

  els.activeRoomName.textContent = room.name;
  const mode = room.policy?.mode || "supervisor";
  els.activeRoomPolicy.textContent = mode === "supervisor"
    ? `${policyLabel(mode)} · Supervisor 拆题 · 总控终审`
    : `${policyLabel(mode)} · ${room.policy?.requireReview ? "审核开启" : "审核关闭"} · max ${room.policy?.maxParallel || 1}`;
  els.memberChips.innerHTML = renderMemberGraph(room);
  window.requestAnimationFrame(() => {
    fitMemberGraphRows();
    drawMemberGraphLines();
  });
  const current = activeTask();
  els.taskForm.querySelector("button").disabled = !room.members?.length || Boolean(current);
  els.chatForm.querySelector("button").disabled = false;
  els.cancelTaskButton.disabled = !current;
  els.activeTaskStatus.innerHTML = current
    ? renderActiveTaskStatus(current)
    : "暂无当前任务";
}

function renderActiveTaskStatus(task) {
  const points = Array.isArray(task.confirmationPoints) ? task.confirmationPoints.filter(Boolean) : [];
  const runningStage = task.stages?.find((stage) => stage.status === "running") || null;
  const startedAt = taskStartedAt(task);
  const endedAt = terminalAt(task);
  const taskDuration = renderDurationBadge({
    label: task.deliveredAt ? "交付耗时" : "总耗时",
    startedAt,
    endedAt,
    live: Boolean(startedAt && !endedAt && isActiveTimedStatus(task.status)),
    className: "active-task-duration"
  });
  const pendingHint = task.status === "pending"
    ? `<span class="pending-hint">${escapeHtml(displayConfirmationPointBrief(points[0]) || "请在中间聊天窗补充确认点，系统会继续交给总控分析。")}</span>`
    : "";
  const retryHint = task.status === "retrying"
    ? `<span class="retry-hint">${escapeHtml(task.retryReason || "等待自动继续。")}</span>`
    : "";
  const approvalHint = task.status === "approval_pending"
    ? `<span class="retry-hint">OpenCode 正在等待你确认工具执行或回答问题。</span>`
    : "";
  const runningHint = runningStage
    ? `<span class="retry-hint">${escapeHtml(runningStage.progress?.label || `${runningStage.assignedAgentId || "Agent"} 正在执行 ${displayStageTitle(runningStage.title)}`)} · <span data-live-duration="${escapeHtml(runningStage.startedAt || "")}">${escapeHtml(formatElapsedFrom(runningStage.startedAt))}</span></span>`
    : "";
  return `<strong>${escapeHtml(statusLabel(task.status))}</strong>${taskDuration}<span class="active-task-goal">${escapeHtml(task.goal)}</span>${runningHint}${pendingHint}${retryHint}${approvalHint}`;
}

function renderEvents() {
  if (!state.events.length) {
    els.eventsFeed.innerHTML = `<div class="empty">暂无对话</div>`;
    startRetryCountdowns();
    return;
  }
  els.eventsFeed.innerHTML = state.events
    .map(eventToMessage)
    .filter(Boolean)
    .map(renderMessage)
    .join("");
  bindMessageToggles();
  bindPendingDecisionPanels();
  bindRuntimeApprovalPanels();
  startRetryCountdowns();
  els.eventsFeed.scrollTop = els.eventsFeed.scrollHeight;
}

function startRetryCountdowns() {
  updateRetryCountdowns();
  const hasCountdown = Boolean(els.eventsFeed.querySelector("[data-retry-at]"));
  const hasLiveDuration = Boolean(document.querySelector("[data-live-duration]"));
  if ((hasCountdown || hasLiveDuration) && !retryCountdownTimer) {
    retryCountdownTimer = window.setInterval(updateRetryCountdowns, 1000);
  }
  if (!hasCountdown && !hasLiveDuration && retryCountdownTimer) {
    window.clearInterval(retryCountdownTimer);
    retryCountdownTimer = null;
  }
}

function updateRetryCountdowns() {
  if (els.eventsFeed) {
    els.eventsFeed.querySelectorAll("[data-retry-at]").forEach((item) => {
      const retryAt = new Date(item.dataset.retryAt).getTime();
      const label = item.dataset.retryLabel || "自动重连";
      if (!Number.isFinite(retryAt)) {
        item.textContent = `准备${label}`;
        return;
      }
      item.textContent = retryCountdownText(item.dataset.retryAt, label);
    });
  }
  document.querySelectorAll("[data-live-duration]").forEach((item) => {
    item.textContent = formatElapsedFrom(item.dataset.liveDuration);
  });
}

function retryCountdownText(retryAtValue, label) {
  const retryAt = new Date(retryAtValue).getTime();
  if (!Number.isFinite(retryAt)) {
    return `准备${label}`;
  }
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  if (seconds <= 0) {
    return `正在${label}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  const duration = minutes > 0
    ? `${minutes}m${remainingSeconds ? `${remainingSeconds}s` : ""}`
    : `${seconds}s`;
  return `${duration} 后${label}`;
}

function formatElapsedFrom(value) {
  return formatDurationBetween(value) || "刚刚";
}

function formatDurationBetween(startValue, endValue) {
  const startedAt = new Date(startValue || "").getTime();
  if (!Number.isFinite(startedAt)) {
    return "";
  }
  const endedAt = endValue ? new Date(endValue).getTime() : Date.now();
  const safeEndedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
  const seconds = Math.max(0, Math.floor((safeEndedAt - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes ? `${minutes}m` : ""}${remainingSeconds && !minutes ? `${remainingSeconds}s` : ""}`;
  }
  if (minutes > 0) {
    return `${minutes}m${remainingSeconds ? `${remainingSeconds}s` : ""}`;
  }
  return `${remainingSeconds}s`;
}

function terminalAt(record) {
  return record?.deliveredAt || record?.completedAt || record?.failedAt || record?.cancelledAt || "";
}

function streamSegmentTitle(stage, segmentIndex, segment = {}) {
  const elapsed = formatDurationBetween(stage?.startedAt, terminalAt(stage));
  if (terminalAt(stage) && elapsed) {
    return `已处理 ${elapsed}`;
  }
  const total = Number(segment.segmentCount || 0);
  return total > segmentIndex + 1
    ? `已处理片段 ${segmentIndex + 1}/${total}`
    : `已处理片段 ${segmentIndex + 1}`;
}

function taskStartedAt(task) {
  if (task?.startedAt) {
    return task.startedAt;
  }
  if (task?.createdAt && task?.status && task.status !== "queued") {
    return task.createdAt;
  }
  return "";
}

function isActiveTimedStatus(status) {
  return ["queued", "running", "pending", "approval_pending", "retrying"].includes(String(status || ""));
}

function renderDurationBadge({ label, startedAt, endedAt, live, className = "duration-badge" }) {
  if (!startedAt) {
    return "";
  }
  const value = formatDurationBetween(startedAt, endedAt);
  if (!value) {
    return "";
  }
  const liveAttr = live ? ` data-live-duration="${escapeHtml(startedAt)}"` : "";
  return `<span class="${escapeHtml(className)}">${escapeHtml(label)} <strong${liveAttr}>${escapeHtml(value)}</strong></span>`;
}

function renderTasks() {
  if (!state.tasks.length) {
    updateInspectorTaskLayout(false, false);
    els.tasksList.innerHTML = `<div class="empty">暂无任务</div>`;
    return;
  }
  const current = activeTask();
  const hasOpenTask = state.tasks.some((task) => state.expandedTasks.has(task.id) || task.id === current?.id);
  updateInspectorTaskLayout(hasOpenTask, state.tasks.length > 4);
  els.tasksList.innerHTML = state.tasks.map((task) => {
    const open = state.expandedTasks.has(task.id) || task.id === current?.id;
    const startedAt = taskStartedAt(task);
    const endedAt = terminalAt(task);
    const taskDuration = renderDurationBadge({
      label: task.deliveredAt ? "交付耗时" : "总耗时",
      startedAt,
      endedAt,
      live: Boolean(startedAt && !endedAt && isActiveTimedStatus(task.status)),
      className: "task-duration"
    });
    return `
    <details class="task-card" data-task-card="${escapeHtml(task.id)}" ${open ? "open" : ""}>
      <summary class="task-summary">
        <span class="summary-caret">›</span>
        <span class="task-summary-main">
          <span class="task-title">${escapeHtml(task.goal)}</span>
          <span class="meta task-meta">${escapeHtml(task.createdAt ? formatDateTime(task.createdAt) : "")}${taskDuration}</span>
        </span>
        <span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span>
      </summary>
      <div class="task-stage-scroll">
        <div class="stage-list">
          ${(task.stages || []).map((stage) => `
            ${renderTaskStage(stage)}
          `).join("")}
        </div>
      </div>
    </details>
  `;
  }).join("");
  bindTaskToggles();
  startRetryCountdowns();
}

function updateInspectorTaskLayout(hasOpenTask, hasManyTasks) {
  const inspector = els.tasksList?.closest(".inspector");
  if (!inspector) {
    return;
  }
  inspector.classList.toggle("task-flow-expanded", Boolean(hasOpenTask));
  inspector.classList.toggle("task-flow-dense", Boolean(hasManyTasks));
}

function renderTaskStage(stage) {
  const detailOpen = ["running", "failed"].includes(stage.status);
  const title = displayStageTitle(stage.title);
  const progress = stage.progress || {};
  const agent = findAgentDisplay(stage.assignedAgentId);
  const stageDuration = renderDurationBadge({
    label: "阶段耗时",
    startedAt: stage.startedAt,
    endedAt: terminalAt(stage),
    live: Boolean(stage.startedAt && !terminalAt(stage)),
    className: "stage-duration"
  });
  return `
    <details class="stage" ${detailOpen ? "open" : ""}>
      <summary class="stage-summary">
        <div class="stage-row">
          <span class="stage-name">${escapeHtml(title)}</span>
          <span class="status-pill ${escapeHtml(stage.status)}">${escapeHtml(statusLabel(stage.status))}</span>
        </div>
        <div class="meta stage-meta"><span class="stage-agent-name">${escapeHtml(agent.name || "未分配 Agent")}</span>${stageDuration}</div>
      </summary>
      <div class="stage-detail-body">
        ${progress.label ? `<div class="stage-progress">${escapeHtml(progress.label)}</div>` : ""}
        ${progress.detail ? `<div class="stage-progress-detail">${escapeHtml(progress.detail)}</div>` : ""}
        ${stage.reason ? `<div class="stage-note">${escapeHtml(stage.reason)}</div>` : ""}
        ${stage.result?.summary ? `<div class="stage-result">${escapeHtml(truncate(stage.result.summary, 180))}</div>` : ""}
      </div>
    </details>
  `;
}

function renderConfigView() {
  els.configTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.configTab === state.configTab);
  });
  els.agentFilesPanel.classList.toggle("hidden", state.configTab !== "agent-files");
  els.teamroomPolicyPanel.classList.toggle("hidden", state.configTab !== "teamroom-policy");
  renderAgentFileConfig();
  renderTeamRoomConfigForm();
}

function renderAgentFileConfig() {
  els.configAgentSelect.innerHTML = state.agents.length
    ? state.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name || agent.id)} (${escapeHtml(agent.id)})</option>`).join("")
    : `<option value="">暂无 agent</option>`;
  if (state.configAgentId && state.agents.some((agent) => agent.id === state.configAgentId)) {
    els.configAgentSelect.value = state.configAgentId;
  } else {
    state.configAgentId = state.agents[0]?.id || "";
    els.configAgentSelect.value = state.configAgentId;
  }

  if (!OPENCLAW_AGENT_FILES.includes(state.configFileName)) {
    state.configFileName = OPENCLAW_AGENT_FILES[0];
  }

  els.agentFileTabs.innerHTML = OPENCLAW_AGENT_FILES.map((name) => {
    const file = selectedAgentFile(name);
    return `<button type="button" class="file-tab ${name === state.configFileName ? "active" : ""}" data-agent-file="${escapeHtml(name)}">${escapeHtml(name.replace(".md", ""))}${file?.exists ? "" : " *"}</button>`;
  }).join("");

  els.agentFileTabs.querySelectorAll("[data-agent-file]").forEach((button) => {
    button.addEventListener("click", () => {
      state.configFileName = button.dataset.agentFile;
      localStorage.setItem("teamroom.configFileName", state.configFileName);
      renderAgentFileConfig();
    });
  });

  const payload = state.agentFiles.get(state.configAgentId);
  const currentFile = selectedAgentFile(state.configFileName);
  els.agentFileWorkspace.textContent = payload?.workspace ? `工作区: ${payload.workspace}` : "未加载工作区";
  els.agentFileEditor.value = currentFile?.content || "";
  els.agentFileEditor.disabled = !state.configAgentId;
  els.saveAgentFileButton.disabled = !state.configAgentId;
}

function renderTeamRoomConfigForm() {
  els.configRoomSelect.innerHTML = state.rooms.length
    ? state.rooms.map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.name)}</option>`).join("")
    : `<option value="">暂无协作室</option>`;
  if (state.configRoomId && state.rooms.some((room) => room.id === state.configRoomId)) {
    els.configRoomSelect.value = state.configRoomId;
  } else {
    state.configRoomId = state.activeRoomId || state.rooms[0]?.id || "";
    els.configRoomSelect.value = state.configRoomId;
  }

  const room = selectedConfigRoom();
  const policy = room?.policy || {};
  const templates = { ...(state.promptDefaults || {}), ...(policy.promptTemplates || {}) };
  els.configFallbackDispatchInput.value = policy.fallbackDispatch || "none";
  els.configRequireReviewInput.checked = policy.requireReview ?? true;
  els.configRoomContextLimitInput.value = Number(policy.roomContextLimit ?? 6);
  els.configTaskMessageLimitInput.value = Number(policy.taskMessageLimit ?? 12);
  fillPromptTemplateInputs(templates);
  renderPromptPlaceholders();
  renderPromptTemplateNav();

  const disabled = !room;
  [
    els.configFallbackDispatchInput,
    els.configRequireReviewInput,
    els.configRoomContextLimitInput,
    els.configTaskMessageLimitInput,
    els.supervisorDispatchTemplateInput,
    els.specialistWorkTemplateInput,
    els.supervisorReviewTemplateInput,
    els.previousOutputItemTemplateInput,
    els.roomContextItemTemplateInput,
    els.taskMessageItemTemplateInput,
    els.resetCurrentPromptTemplateButton,
    els.resetPolicyTemplatesButton,
    els.savePolicyConfigButton
  ].forEach((element) => {
    element.disabled = disabled;
  });
}

function fillPromptTemplateInputs(templates) {
  els.supervisorDispatchTemplateInput.value = templates.supervisorDispatch || "";
  els.specialistWorkTemplateInput.value = templates.specialistWork || "";
  els.supervisorReviewTemplateInput.value = templates.supervisorReview || "";
  els.previousOutputItemTemplateInput.value = templates.previousOutputItem || "";
  els.roomContextItemTemplateInput.value = templates.roomContextItem || "";
  els.taskMessageItemTemplateInput.value = templates.taskMessageItem || "";
}

function renderPromptPlaceholders() {
  els.promptPlaceholders.innerHTML = state.promptPlaceholders.map((name) => (
    `<code>{{${escapeHtml(name)}}}</code>`
  )).join("");
  renderPromptVariableGuide();
}

function renderPromptVariableGuide() {
  if (!els.promptVariableGuide) {
    return;
  }
  const serverPlaceholders = new Set(state.promptPlaceholders || []);
  const variables = PROMPT_VARIABLE_GUIDE.filter(([name]) => (
    serverPlaceholders.size === 0 || serverPlaceholders.has(name) || [
      "memberRoles",
      "memberCapabilities",
      "stageType",
      "reviewJsonContract",
      "index",
      "title",
      "summary",
      "status",
      "completedAt",
      "timestamp",
      "author",
      "content"
    ].includes(name)
  ));
  els.promptVariableGuide.innerHTML = `
    <div class="variable-guide-head">
      <h4>变量说明</h4>
      <p>保存后，TeamRoom 会在发送给 Agent 前自动替换这些占位符。</p>
    </div>
    <dl>
      ${variables.map(([name, description]) => `
        <div>
          <dt><code>{{${escapeHtml(name)}}}</code></dt>
          <dd>${escapeHtml(description)}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function renderPromptTemplateNav() {
  const active = promptTemplateMeta(state.activePromptTemplateKey) || PROMPT_TEMPLATE_META[0];
  state.activePromptTemplateKey = active.key;
  const changedCount = PROMPT_TEMPLATE_META.filter((meta) => isPromptTemplateChanged(meta.key)).length;
  if (els.promptTemplateSummary) {
    els.promptTemplateSummary.innerHTML = `
      <span>${changedCount} / ${PROMPT_TEMPLATE_META.length} 已微调</span>
      <strong>${escapeHtml(active.title)}</strong>
      <em>${escapeHtml(active.description)}</em>
    `;
  }
  if (els.promptTemplateNav) {
    els.promptTemplateNav.innerHTML = PROMPT_TEMPLATE_META.map((meta) => {
      const changed = isPromptTemplateChanged(meta.key);
      return `
        <button type="button" class="${meta.key === active.key ? "active" : ""}" data-prompt-template-key="${escapeHtml(meta.key)}">
          <span>${escapeHtml(meta.group)}</span>
          <strong>${escapeHtml(meta.title)}</strong>
          <em>${escapeHtml(meta.tone)}</em>
          <small>${changed ? "已微调" : "默认"}</small>
        </button>
      `;
    }).join("");
    els.promptTemplateNav.querySelectorAll("[data-prompt-template-key]").forEach((button) => {
      button.addEventListener("click", () => {
        setActivePromptTemplate(button.dataset.promptTemplateKey, { focus: true });
      });
    });
  }
  document.querySelectorAll("[data-template-key]").forEach((card) => {
    const key = card.dataset.templateKey;
    const isActive = key === active.key;
    card.hidden = !isActive;
    card.setAttribute("aria-hidden", String(!isActive));
    card.classList.toggle("active", isActive);
    card.classList.toggle("changed", isPromptTemplateChanged(key));
  });
}

function setActivePromptTemplate(key, { focus = false } = {}) {
  const meta = promptTemplateMeta(key);
  if (!meta) {
    return;
  }
  state.activePromptTemplateKey = meta.key;
  localStorage.setItem("teamroom.activePromptTemplateKey", meta.key);
  renderPromptTemplateNav();
  const card = document.querySelector(`[data-template-key="${cssEscape(meta.key)}"]`);
  if (focus && card) {
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    els[meta.textarea]?.focus();
  }
}

function resetCurrentPromptTemplate() {
  const meta = promptTemplateMeta(state.activePromptTemplateKey);
  if (!meta || !state.promptDefaults) {
    return;
  }
  const textarea = els[meta.textarea];
  if (!textarea) {
    return;
  }
  textarea.value = state.promptDefaults[meta.key] || "";
  renderPromptTemplateNav();
  setConfigStatus(`${meta.title} 已恢复默认，点击保存后生效`);
  textarea.focus();
}

function promptTemplateMeta(key) {
  return PROMPT_TEMPLATE_META.find((meta) => meta.key === key);
}

function isPromptTemplateChanged(key) {
  const meta = promptTemplateMeta(key);
  if (!meta) {
    return false;
  }
  const current = String(els[meta.textarea]?.value || "").trim();
  const original = String(state.promptDefaults?.[key] || "").trim();
  return current !== original;
}

function readTeamRoomConfigForm(existingPolicy = {}) {
  return {
    ...existingPolicy,
    fallbackDispatch: els.configFallbackDispatchInput.value,
    requireReview: els.configRequireReviewInput.checked,
    roomContextLimit: Number(els.configRoomContextLimitInput.value || 0),
    taskMessageLimit: Number(els.configTaskMessageLimitInput.value || 0),
    promptTemplates: {
      supervisorDispatch: els.supervisorDispatchTemplateInput.value,
      specialistWork: els.specialistWorkTemplateInput.value,
      supervisorReview: els.supervisorReviewTemplateInput.value,
      previousOutputItem: els.previousOutputItemTemplateInput.value,
      roomContextItem: els.roomContextItemTemplateInput.value,
      taskMessageItem: els.taskMessageItemTemplateInput.value
    }
  };
}

function selectedAgentFile(fileName) {
  const payload = state.agentFiles.get(state.configAgentId);
  return payload?.files?.find((file) => file.name === fileName) || null;
}

function selectedConfigRoom() {
  return state.rooms.find((room) => room.id === state.configRoomId) || null;
}

function setConfigStatus(text) {
  els.configStatus.textContent = text;
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {})
  };
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function saveAgentProfile(agentId) {
  const rolesInput = els.agentsList.querySelector(`[data-profile-roles="${cssEscape(agentId)}"]`);
  const capabilitiesInput = els.agentsList.querySelector(`[data-profile-capabilities="${cssEscape(agentId)}"]`);
  await api(`/api/agents/${encodeURIComponent(agentId)}/profile`, {
    method: "PUT",
    body: {
      roles: parseTags(rolesInput?.value || ""),
      capabilities: parseTags(capabilitiesInput?.value || "")
    }
  });
  await Promise.all([loadAgents(), loadActiveRoom()]);
}

async function clearAgentProfile(agentId) {
  await api(`/api/agents/${encodeURIComponent(agentId)}/profile`, {
    method: "DELETE"
  });
  await Promise.all([loadAgents(), loadActiveRoom()]);
}

async function deleteRoom(roomId) {
  const wasActive = state.activeRoomId === roomId;
  state.rooms = state.rooms.filter((room) => room.id !== roomId);
  if (wasActive) {
    if (state.source) {
      state.source.close();
      state.source = null;
      state.sourceRoomId = "";
    }
    state.activeRoomId = state.rooms[0]?.id || "";
    if (state.activeRoomId) {
      localStorage.setItem("teamroom.activeRoomId", state.activeRoomId);
    } else {
      localStorage.removeItem("teamroom.activeRoomId");
    }
    state.activeRoom = null;
    state.tasks = [];
    state.events = [];
  }
  render();

  await api(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE"
  });

  await loadRooms();
  if (state.activeRoomId === roomId || !state.rooms.some((room) => room.id === state.activeRoomId)) {
    state.activeRoomId = "";
    localStorage.removeItem("teamroom.activeRoomId");
  }
  if (!state.activeRoomId && state.rooms[0]) {
    state.activeRoomId = state.rooms[0].id;
    localStorage.setItem("teamroom.activeRoomId", state.activeRoomId);
  }
  await loadActiveRoom();
}

function setAgentProfileInputs(agentId, preset) {
  const rolesInput = els.agentsList.querySelector(`[data-profile-roles="${cssEscape(agentId)}"]`);
  const capabilitiesInput = els.agentsList.querySelector(`[data-profile-capabilities="${cssEscape(agentId)}"]`);
  if (rolesInput) {
    rolesInput.value = preset.roles.join(", ");
  }
  if (capabilitiesInput) {
    capabilitiesInput.value = preset.capabilities.join(", ");
  }
}

function parseTags(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function renderAgentTags(agent) {
  const roles = (agent.roles || []).map((tag) => `<span class="tag role">${escapeHtml(tag)}</span>`);
  const capabilities = (agent.capabilities || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`);
  return [...roles, ...capabilities].join("") || `<span class="tag">untagged</span>`;
}

function renderAgentTagPreview(agent) {
  const roles = (agent.roles || []).map((tag) => ({ tag, kind: "role" }));
  const capabilities = (agent.capabilities || []).map((tag) => ({ tag, kind: "" }));
  const tags = [...roles, ...capabilities];
  if (!tags.length) {
    return `<span class="tag">untagged</span>`;
  }
  const visible = tags.slice(0, 4).map((item) => `<span class="tag ${item.kind}">${escapeHtml(item.tag)}</span>`);
  if (tags.length > visible.length) {
    visible.push(`<span class="tag">+${tags.length - visible.length}</span>`);
  }
  return visible.join("");
}

function renderMemberGraph(room) {
  const members = room.members || [];
  if (!members.length) {
    return `<div class="member-graph empty-graph">暂无 agent</div>`;
  }

  const supervisor = findSupervisorMember(members) || members[0];
  const specialists = members.filter((member) => member.agentId !== supervisor.agentId);
  const runningStage = runningStageForActiveTask();
  const activeAgentId = runningStage?.assignedAgentId || "";
  const dimOthers = Boolean(activeAgentId);

  return `
    <div class="member-graph" data-active-agent="${escapeHtml(activeAgentId)}" data-supervisor-agent="${escapeHtml(supervisor.agentId)}" data-specialist-count="${escapeHtml(String(specialists.length))}">
      <svg class="member-graph-lines" aria-hidden="true"></svg>
      <div class="member-row supervisor-row">
        <span class="member-node-label">Supervisor</span>
        ${renderMemberGraphNode(supervisor, {
          kind: "supervisor",
          active: activeAgentId === supervisor.agentId,
          dim: false
        })}
      </div>
      <div class="member-row specialist-row">
        <span class="member-node-label">Agents</span>
        ${specialists.length
          ? specialists.map((member) => renderMemberGraphNode(member, {
            kind: "specialist",
            active: activeAgentId === member.agentId,
            dim: dimOthers && activeAgentId !== member.agentId
          })).join("")
          : `<span class="member-node placeholder-node">暂无子 agent</span>`}
      </div>
    </div>
  `;
}

function renderMemberGraphNode(member, { kind, active, dim }) {
  const label = member.name || member.agentId;
  const badge = kind === "supervisor" ? "总控 Agent" : "子 Agent";
  const subtitle = compactMemberCapabilities(member);
  return `
    <span
      class="member-node ${escapeHtml(kind)} ${active ? "active" : ""} ${dim ? "dim" : ""}"
      data-member-node="${escapeHtml(member.agentId)}"
      title="${escapeHtml(label)}"
    >
      <span class="member-node-badge">${escapeHtml(badge)}</span>
      <span class="member-node-name">${escapeHtml(label)}</span>
      <span class="member-node-subtitle">${escapeHtml(subtitle)}</span>
    </span>
  `;
}

function compactMemberCapabilities(member) {
  const tags = (member.capabilities || [])
    .filter((tag) => !["specialist", "domain"].includes(String(tag).toLowerCase()));
  return tags.slice(0, 3).join(" · ") || "未设置专业能力";
}

function fitMemberGraphRows() {
  const graph = els.memberChips.querySelector(".member-graph");
  if (!graph) {
    return;
  }

  const availableWidth = Math.max(80, graph.clientWidth - 20);
  const specialistCount = Math.max(1, Number(graph.dataset.specialistCount || 1));
  const estimatedWidth = specialistCount * 108 + Math.max(0, specialistCount - 1) * 7;
  const estimatedRatio = availableWidth / estimatedWidth;
  const scale = Math.max(0.24, Math.min(1, estimatedRatio));

  graph.style.setProperty("--graph-scale", scale.toFixed(3));
  graph.style.setProperty("--graph-node-width", `${Math.round(108 * scale)}px`);
  graph.style.setProperty("--graph-node-height", `${Math.round(54 * scale)}px`);
  graph.style.setProperty("--graph-supervisor-width", `${Math.round(152 * scale)}px`);
  graph.style.setProperty("--graph-supervisor-height", `${Math.round(60 * scale)}px`);
  graph.style.setProperty("--graph-node-gap", `${Math.max(2, Math.round(7 * scale))}px`);
  graph.style.setProperty("--graph-node-pad-y", `${Math.max(3, Math.round(7 * scale))}px`);
  graph.style.setProperty("--graph-node-pad-x", `${Math.max(4, Math.round(8 * scale))}px`);
  graph.style.setProperty("--graph-badge-font", `${Math.max(6.5, 10 * scale).toFixed(1)}px`);
  graph.style.setProperty("--graph-name-font", `${Math.max(7.5, 12 * scale).toFixed(1)}px`);
  graph.style.setProperty("--graph-subtitle-font", `${Math.max(7, 11 * scale).toFixed(1)}px`);
}

function drawMemberGraphLines() {
  const graph = els.memberChips.querySelector(".member-graph");
  const svg = graph?.querySelector(".member-graph-lines");
  const supervisorNode = graph?.querySelector(".member-node.supervisor");
  if (!graph || !svg || !supervisorNode) {
    return;
  }

  const specialistNodes = [...graph.querySelectorAll(".member-node.specialist")];
  const graphRect = graph.getBoundingClientRect();
  if (!graphRect.width || !graphRect.height) {
    return;
  }

  svg.setAttribute("viewBox", `0 0 ${graphRect.width} ${graphRect.height}`);
  svg.innerHTML = "";

  const supervisorRect = supervisorNode.getBoundingClientRect();
  const x1 = supervisorRect.left - graphRect.left + supervisorRect.width / 2;
  const y1 = supervisorRect.bottom - graphRect.top - 1;
  const activeAgentId = graph.dataset.activeAgent || "";
  const supervisorAgentId = graph.dataset.supervisorAgent || "";

  for (const node of specialistNodes) {
    const rect = node.getBoundingClientRect();
    const x2 = rect.left - graphRect.left + rect.width / 2;
    const y2 = rect.top - graphRect.top + 1;
    const agentId = node.dataset.memberNode;
    const active = activeAgentId && activeAgentId !== supervisorAgentId && activeAgentId === agentId;
    const dim = activeAgentId && !active;
    const midY = y1 + Math.max(10, (y2 - y1) * 0.45);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    path.setAttribute("class", `member-graph-line ${active ? "active" : ""} ${dim ? "dim" : ""}`);
    svg.appendChild(path);
  }
}

function findSupervisorMember(members) {
  return members.find(isSupervisorMember) || null;
}

function isSupervisorMember(member) {
  return (member.roles || []).some((role) => isSupervisorRole(role));
}

function isSupervisorRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return [
    "supervisor",
    "leader",
    "coordinator",
    "总控",
    "主控",
    "中枢"
  ].some((keyword) => normalized === keyword || normalized.includes(keyword));
}

function runningStageForActiveTask() {
  const task = activeTask();
  return task?.stages?.find((stage) => stage.status === "running") || null;
}

function labelForEvent(event) {
  return ({
    "room.created": "协作室已创建",
    "runtime.reconnect_started": "手动重连",
    "runtime.reconnect_completed": "重连完成",
    "runtime.reconnect_failed": "重连失败",
    "runtime.approval_requested": "等待运行时确认",
    "runtime.approval_resolved": "运行时确认已处理",
    "member.added": "Agent 已加入",
    "member.removed": "Agent 已移除",
    "task.created": "任务已创建",
    "task.planned": "总控已生成协作计划",
    "task.running": "任务运行中",
    "task.pending": "等待人工确认",
    "task.retry_scheduled": "自动重连",
    "task.wait_scheduled": "内部等待",
    "task.delivered": "已先行交付",
    "task.audit_completed": "后台审计完成",
    "task.completed": "任务已完成",
    "task.failed": "任务失败",
    "stage.assigned": "阶段已分配",
    "stage.running": "阶段运行中",
    "stage.progress": "阶段进度",
    "stage.stream": "实时输出",
    "stage.awaiting_agent": "等待 Agent",
    "stage.result_received": "已收到结果",
    "stage.review_decision": "总控判定",
    "stage.auto_continue": "自动继续",
    "stage.completed": "阶段已完成",
    "stage.failed": "阶段失败"
  })[event.type] || event.type.replaceAll(".", " ");
}

function displayStageTitle(title) {
  const normalized = String(title || "").trim();
  return STAGE_TITLE_LABELS[normalized] || normalized;
}

function bodyForEvent(event, payload) {
  if (event.type === "stage.completed") {
    return `${payload.agentId}: ${payload.result?.summary || "已完成"}`;
  }
  if (event.type === "runtime.reconnect_started") {
    return "用户手动触发执行后端重连，TeamRoom 正在刷新连接。";
  }
  if (event.type === "runtime.reconnect_completed") {
    const elapsedMs = payload.result?.elapsedMs;
    const elapsed = Number.isFinite(elapsedMs) ? `，耗时 ${Math.max(1, Math.round(elapsedMs / 1000))} 秒` : "";
    return `执行后端连接已恢复${elapsed}。`;
  }
  if (event.type === "runtime.reconnect_failed") {
    return `执行后端手动重连失败：${payload.error || "未知错误"}`;
  }
  if (event.type === "runtime.approval_requested") {
    return payload.approval?.title || "OpenCode 正在等待人工确认。";
  }
  if (event.type === "runtime.approval_resolved") {
    return `OpenCode 确认已处理：${approvalStatusLabel(payload.approval?.status)}`;
  }
  if (event.type === "stage.running") {
    return `${payload.agentId} 正在执行 ${displayStageTitle(payload.title)}`;
  }
  if (event.type === "stage.stream") {
    return `${displayStageTitle(payload.title || "阶段")}：${payload.label || "执行后端正在流式输出"}\n${payload.detail || ""}`;
  }
  if (event.type === "stage.progress" || event.type === "stage.awaiting_agent" || event.type === "stage.result_received") {
    return `${displayStageTitle(payload.title || "阶段")}：${payload.label || payload.detail || "进度更新"}`;
  }
  if (event.type === "stage.review_decision") {
    return `总控判定：${payload.decision || "已完成判定"}${payload.reason ? `。${payload.reason}` : ""}`;
  }
  if (event.type === "stage.auto_continue") {
    return `${payload.agentId} 等待内部确认，TeamRoom 已自动补发继续执行指令。`;
  }
  if (event.type === "stage.assigned") {
    return `${displayStageTitle(payload.stage?.title || "阶段")} 分配给 ${payload.agentId}`;
  }
  if (event.type === "task.planned") {
    const stages = payload.stages || [];
    return stages.length
      ? stages.map((stage) => `${displayStageTitle(stage.title)} -> ${stage.assignedAgentId}`).join("\n")
      : "总控未要求追加子任务阶段";
  }
  if (event.type === "task.created") {
    return payload.goal || "任务已创建";
  }
  if (event.type === "task.completed") {
    return payload.summary || "任务已完成";
  }
  if (event.type === "task.delivered") {
    return payload.summary || "已先行交付结论，后台审计继续执行。";
  }
  if (event.type === "task.audit_completed") {
    return payload.summary || "后台审计完成。";
  }
  if (event.type === "task.pending") {
    const points = payload.confirmationPoints || [];
    return points.length
      ? `任务等待人工确认：${points.map(displayConfirmationPointBrief).filter(Boolean).join("；")}`
      : (payload.reason || "任务等待人工确认");
  }
  if (event.type === "task.retry_scheduled") {
    return `执行后端连接异常：${payload.error || "连接中断"}。${Math.round((payload.delayMs || 5000) / 1000)} 秒后自动继续。`;
  }
  if (event.type === "task.wait_scheduled") {
    return `内部 Agent 尚未返回：${payload.reason || "等待执行结果"}。${Math.round((payload.delayMs || 5000) / 1000)} 秒后自动复核。`;
  }
  if (event.type === "task.failed") {
    return payload.error || "任务失败";
  }
  if (event.type === "member.added") {
    return `${payload.member?.name || payload.member?.agentId} 已加入`;
  }
  return JSON.stringify(payload, null, 2);
}

function eventToMessage(event) {
  const payload = event.payload || {};
  if (event.type === "message.created") {
    return {
      id: event.id,
      kind: "user",
      author: "你",
      title: "补充 / 干预",
      time: event.timestamp,
      body: payload.content || ""
    };
  }

  if (event.type === "task.created") {
    return {
      id: event.id,
      kind: "user",
      author: "你",
      title: "提交需求",
      time: event.timestamp,
      body: payload.goal || ""
    };
  }

  if (event.type === "runtime.reconnect_started") {
    return {
      kind: "system process",
      time: event.timestamp,
      body: "用户手动触发执行后端重连，TeamRoom 正在刷新连接。"
    };
  }

  if (event.type === "runtime.reconnect_completed") {
    const elapsedMs = payload.result?.elapsedMs;
    const elapsed = Number.isFinite(elapsedMs) ? `，耗时 ${Math.max(1, Math.round(elapsedMs / 1000))} 秒` : "";
    return {
      kind: "system process",
      time: event.timestamp,
      body: `执行后端连接已恢复${elapsed}。`
    };
  }

  if (event.type === "runtime.reconnect_failed") {
    return {
      kind: "system error",
      time: event.timestamp,
      body: `执行后端手动重连失败：${payload.error || "未知错误"}`
    };
  }

  if (event.type === "runtime.approval_requested") {
    return {
      id: event.id,
      kind: "system runtime-approval",
      taskId: event.taskId || payload.taskId,
      time: event.timestamp,
      approval: payload.approval,
      actionable: activeTask()?.id === (event.taskId || payload.taskId)
    };
  }

  if (event.type === "runtime.approval_resolved") {
    return {
      id: event.id,
      kind: "system runtime-approval",
      taskId: event.taskId || payload.taskId,
      time: event.timestamp,
      approval: payload.approval,
      actionable: false
    };
  }

  if (event.type === "stage.completed") {
    const agent = findAgentDisplay(payload.agentId);
    return {
      id: event.id,
      kind: "agent",
      author: agent.name,
      agentId: payload.agentId,
      title: displayStageTitle(payload.stage?.title || stageTitleFromEvent(event) || "阶段输出"),
      time: event.timestamp,
      body: payload.result?.summary || "已完成"
    };
  }

  if (event.type === "task.planned") {
    const stages = payload.stages || [];
    return {
      kind: "system",
      time: event.timestamp,
      body: stages.length
        ? `总控已生成协作计划：${stages.map((stage) => `${displayStageTitle(stage.title)} -> ${stage.assignedAgentId}`).join("；")}`
        : "总控未要求追加子任务阶段"
    };
  }

  if (event.type === "stage.running") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${payload.agentId} 正在执行 ${displayStageTitle(payload.title)}`
    };
  }

  if (event.type === "stage.stream") {
    const stage = findTaskStage(event.taskId, event.stageId);
    const agent = findAgentDisplay(payload.agentId || stage?.assignedAgentId);
    const segment = payload.streamSegment || {};
    const segmentIndex = Number(segment.segmentIndex || 0);
    const streamId = `stream-${event.taskId || payload.taskId || "task"}-${event.stageId || payload.stageId || "stage"}-${segmentIndex}`;
    const completed = Boolean(terminalAt(stage)) || Boolean(segment.isSegmentComplete);
    const title = completed
      ? streamSegmentTitle(stage, segmentIndex, segment)
      : "处理过程 · 进行中";
    return {
      id: streamId,
      kind: `agent stream ${completed ? "completed" : "live"}`,
      author: agent.name,
      agentId: payload.agentId || stage?.assignedAgentId,
      title,
      time: event.timestamp,
      body: payload.detail || "正在等待执行后端输出..."
    };
  }

  if (["stage.progress", "stage.awaiting_agent", "stage.result_received"].includes(event.type)) {
    return {
      kind: event.type === "stage.awaiting_agent" ? "system process live" : "system process",
      time: event.timestamp,
      retryAt: null,
      body: `${displayStageTitle(payload.title || "阶段")}：${payload.label || payload.detail || "进度更新"}`
    };
  }

  if (event.type === "stage.review_decision") {
    const extra = payload.followUpSubtasks?.length
      ? `；追加 ${payload.followUpSubtasks.map((item) => item.agent_id || item.agentId || item.agent).filter(Boolean).join("、")}`
      : "";
    return {
      kind: "system process",
      time: event.timestamp,
      body: `总控判定：${payload.decision || "已完成判定"}${extra}${payload.reason ? `。${payload.reason}` : ""}`
    };
  }

  if (event.type === "stage.auto_continue") {
    return {
      kind: "system process",
      time: event.timestamp,
      body: `${payload.agentId} 等待内部确认，TeamRoom 已自动补发继续执行指令。`
    };
  }

  if (event.type === "stage.assigned") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${displayStageTitle(payload.stage?.title || "阶段")} 分配给 ${payload.agentId}`
    };
  }

  if (event.type === "member.added") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${payload.member?.name || payload.member?.agentId} 已加入协作室`
    };
  }

  if (event.type === "member.removed") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${payload.agentId} 已离开协作室`
    };
  }

  if (event.type === "task.completed") {
    return {
      kind: "agent",
      id: event.id,
      author: "总控",
      title: "任务完成",
      time: event.timestamp,
      body: payload.summary || "任务已完成"
    };
  }

  if (event.type === "task.delivered") {
    return {
      kind: "agent",
      id: event.id,
      author: "总控",
      title: "已先行交付",
      time: event.timestamp,
      body: renderDeliveryBody(payload)
    };
  }

  if (event.type === "task.audit_completed") {
    return {
      kind: "agent",
      id: event.id,
      author: "总控",
      title: "后台审计完成",
      time: event.timestamp,
      body: renderAuditCompletedBody(payload)
    };
  }

  if (event.type === "task.pending") {
    const points = payload.confirmationPoints || [];
    const taskId = event.taskId || payload.taskId || "";
    const matchingTask = state.tasks.find((task) => task.id === taskId);
    const current = activeTask();
    return {
      kind: "system pending",
      id: event.id,
      taskId,
      actionable: matchingTask
        ? !["completed", "cancelled", "failed"].includes(matchingTask.status)
        : current?.id === taskId,
      time: event.timestamp,
      points,
      reason: payload.reason || "",
      body: points.length
        ? `任务等待人工确认：${points.map(displayConfirmationPointBrief).filter(Boolean).join("；")}`
        : (payload.reason || "任务等待人工确认")
    };
  }

  if (event.type === "task.retry_scheduled") {
    return {
      kind: "system retry",
      time: event.timestamp,
      retryAt: payload.retryAt,
      retryLabel: "自动重连",
      body: `执行后端连接异常，已安排自动重连继续。${payload.error ? `原因：${payload.error}` : ""}`.trim()
    };
  }

  if (event.type === "task.wait_scheduled") {
    return {
      kind: "system retry",
      time: event.timestamp,
      retryAt: payload.retryAt,
      retryLabel: "自动复核",
      body: `内部 Agent 尚未返回，已安排自动复核。${payload.reason ? `原因：${payload.reason}` : ""}`.trim()
    };
  }

  if (event.type === "task.cancelled") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `任务已终止。${payload.reason || ""}`.trim()
    };
  }

  if (event.type === "task.resumed") {
    return {
      kind: "system",
      time: event.timestamp,
      body: payload.instruction
        ? `继续任务：${payload.instruction}`
        : "继续任务"
    };
  }

  if (event.type === "task.resume_skipped") {
    return {
      kind: "system",
      time: event.timestamp,
      body: payload.reason || "任务正在运行，无需续跑"
    };
  }

  if (event.type === "task.failed" || event.type === "stage.failed") {
    return {
      kind: "system error",
      time: event.timestamp,
      body: payload.error || "任务失败"
    };
  }

  if (event.type === "task.running") {
    return {
      kind: "system",
      time: event.timestamp,
      body: "任务开始运行"
    };
  }

  return null;
}

function renderDeliveryBody(payload = {}) {
  const lines = [];
  if (payload.summary) {
    lines.push(payload.summary);
  }
  const artifacts = Array.isArray(payload.changedArtifacts) ? payload.changedArtifacts : [];
  if (artifacts.length) {
    lines.push("", "交付件:", ...artifacts.map((item) => `- ${formatDeliveryItem(item)}`));
  }
  const risks = Array.isArray(payload.risks) ? payload.risks : [];
  if (risks.length) {
    lines.push("", "风险:", ...risks.map((item) => `- ${formatDeliveryItem(item)}`));
  }
  const nextSteps = Array.isArray(payload.nextSteps) ? payload.nextSteps : [];
  if (nextSteps.length) {
    lines.push("", "下一步:", ...nextSteps.map((item) => `- ${formatDeliveryItem(item)}`));
  }
  if (payload.backgroundAuditRequired) {
    lines.push("", "后台闭环审计继续执行；若发现问题，TeamRoom 会再次弹出。");
  }
  return lines.filter((line, index) => line || lines[index - 1]).join("\n") || "已先行交付结论。";
}

function renderAuditCompletedBody(payload = {}) {
  const lines = [payload.summary || "后台审计完成，未发现需要用户处理的问题。"];
  const risks = Array.isArray(payload.risks) ? payload.risks.filter(Boolean) : [];
  if (risks.length) {
    lines.push("", "审计关注点:", ...risks.map((item) => `- ${formatDeliveryItem(item)}`));
  }
  return lines.join("\n");
}

function formatDeliveryItem(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return value.name || value.title || value.path || JSON.stringify(value);
  }
  return String(value ?? "");
}

function renderMessage(message) {
  if (message.kind === "system pending") {
    return renderPendingDecisionPanel(message);
  }
  if (message.kind === "system runtime-approval") {
    return renderRuntimeApprovalPanel(message);
  }

  if (message.kind.startsWith("system")) {
    const retryCountdown = message.retryAt
      ? `<strong class="retry-countdown" data-retry-at="${escapeHtml(message.retryAt)}" data-retry-label="${escapeHtml(message.retryLabel || "自动重连")}">${retryCountdownText(message.retryAt, message.retryLabel || "自动重连")}</strong>`
      : "";
    return `
      <div class="message-system ${message.kind.includes("error") ? "error" : ""} ${message.kind.includes("pending") ? "pending" : ""} ${message.kind.includes("retry") ? "retry" : ""} ${message.kind.includes("process") ? "process" : ""} ${message.kind.includes("live") ? "live" : ""}">
        <span>${renderMarkdownInline(message.body)}</span>
        ${retryCountdown}
        <time>${formatTime(message.time)}</time>
      </div>
    `;
  }

  const avatar = initials(message.author);
  const displayTitle = displayStageTitle(message.title);
  const title = displayTitle ? `<div class="message-stage">${escapeHtml(displayTitle)}</div>` : "";
  const isStream = message.kind.includes("stream");
  const collapsible = isStream || isLongMessage(message.body);
  const defaultCollapsed = isStream && message.kind.includes("completed");
  const expanded = message.id && state.expandedMessages.has(message.id);
  const collapsed = collapsible && (defaultCollapsed ? !expanded : !expanded && !isStream);
  const toggleLabel = collapsed
    ? (isStream ? "查看过程" : "展开")
    : (isStream ? "收起过程" : "收起");
  return `
    <article class="message-row ${escapeHtml(message.kind)}">
      <div class="avatar" title="${escapeHtml(message.author)}">${escapeHtml(avatar)}</div>
      <div class="message-stack">
        <div class="message-meta">
          <span>${escapeHtml(message.author)}</span>
          <time>${formatTime(message.time)}</time>
        </div>
        <div class="message-bubble ${collapsible ? "collapsible" : ""} ${isStream ? "stream-bubble" : ""} ${collapsed ? "collapsed" : ""}" ${collapsible ? `data-collapsible-message="${escapeHtml(message.id || "")}"` : ""}>
          ${title}
          <div class="message-markdown">${renderMarkdown(message.body)}</div>
          ${collapsible ? `<button type="button" class="message-toggle" data-message-toggle="${escapeHtml(message.id || "")}">${escapeHtml(toggleLabel)}</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderPendingDecisionPanel(message) {
  const points = normalizeDecisionPoints(message.points?.length ? message.points : [message.body]);
  const actionable = message.actionable !== false;
  if (!actionable) {
    return renderResolvedDecisionPanel(message, points);
  }
  return `
    <section class="decision-panel" data-decision-panel="${escapeHtml(message.id || "")}">
      <div class="decision-panel-header">
        <div>
          <span class="decision-kicker">需要人工确认</span>
          <strong>${points.length} 个确认点，请选择或填写</strong>
        </div>
        <time>${formatTime(message.time)}</time>
      </div>
      <div class="decision-list">
        ${points.map((point, index) => renderDecisionItem(point, index, true)).join("")}
      </div>
      <details class="decision-extra">
        <summary>补充说明</summary>
        <textarea rows="2" data-decision-extra placeholder="可选：补充无法通过选项表达的说明"></textarea>
      </details>
      <div class="decision-actions">
        <button type="button" class="secondary decision-fill-button" data-decision-fill>填入聊天框</button>
        <button type="button" class="decision-submit-button" data-decision-submit>提交确认并继续</button>
      </div>
    </section>
  `;
}

function renderResolvedDecisionPanel(message, points) {
  return `
    <section class="decision-panel resolved compact">
      <details>
        <summary class="decision-history-summary">
          <span class="decision-kicker">历史确认点</span>
          <strong>${points.length} 个确认点已处理</strong>
          <time>${formatTime(message.time)}</time>
        </summary>
        <div class="decision-history-list">
          ${points.map((point, index) => `
            <div class="decision-history-item">
              <span>${index + 1}</span>
              <p>${escapeHtml(point.question)}</p>
            </div>
          `).join("")}
        </div>
      </details>
    </section>
  `;
}

function renderDecisionItem(point, index, actionable = true) {
  const optionButtons = point.options.length
    ? `<div class="decision-options">
        ${point.options.map((option, optionIndex) => `
          <button type="button" class="decision-option" data-decision-option="${index}" data-option-value="${escapeHtml(option.value)}" title="${escapeHtml(option.value)}" ${actionable ? "" : "disabled"}>
            <span>${escapeHtml(option.label || optionLabel(optionIndex))}</span>
            <strong>${escapeHtml(option.value)}</strong>
          </button>
        `).join("")}
      </div>`
    : "";
  const customInput = `<input class="decision-custom-input" data-decision-custom="${index}" placeholder="${point.options.length ? "输入其他答案" : "请输入你的确认意见"}" ${actionable ? "" : "disabled"} />`;
  const customControl = point.options.length
    ? `<details class="decision-custom-details">
        <summary>自定义填写</summary>
        ${customInput}
      </details>`
    : customInput;
  return `
    <article class="decision-item" data-decision-index="${index}" data-decision-id="${escapeHtml(point.id || "")}" data-decision-question="${escapeHtml(point.question)}">
      <div class="decision-number">${index + 1}</div>
      <div class="decision-content">
        <div class="decision-question">${escapeHtml(point.question)}</div>
        ${point.hint ? `<div class="decision-hint">${escapeHtml(point.hint)}</div>` : ""}
        ${optionButtons}
        ${customControl}
      </div>
    </article>
  `;
}

function renderRuntimeApprovalPanel(message) {
  const approval = message.approval || {};
  const actionable = message.actionable !== false && approval.status === "pending";
  const title = approval.title || (approval.type === "question" ? "OpenCode 请求人工回答" : "OpenCode 请求执行确认");
  const statusText = actionable ? "等待处理" : approvalStatusLabel(approval.status);
  if (approval.type === "question") {
    const questions = approval.questions?.length
      ? approval.questions
      : [{ header: "问题", question: approval.details || title, options: [], custom: true }];
    return `
      <section class="runtime-approval-panel ${actionable ? "" : "resolved"}" data-runtime-approval="${escapeHtml(approval.id || "")}" data-runtime-task="${escapeHtml(message.taskId || approval.taskId || "")}" data-runtime-type="question">
        <div class="decision-panel-header"><div><span class="decision-kicker runtime-kicker">OpenCode 问题</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(statusText)}</small></div><time>${formatTime(message.time)}</time></div>
        <div class="decision-list runtime-question-list">
          ${questions.map((question, index) => renderRuntimeQuestionItem(question, index, actionable)).join("")}
        </div>
        ${actionable ? `<textarea class="runtime-approval-message" rows="2" placeholder="可选：补充说明"></textarea><div class="decision-actions"><button type="button" class="secondary runtime-approval-reply" data-runtime-reply="reject">拒绝</button><button type="button" class="decision-submit-button runtime-approval-reply" data-runtime-reply="once">提交回答并继续</button></div>` : ""}
      </section>`;
  }
  const patterns = Array.isArray(approval.patterns) ? approval.patterns.filter(Boolean) : [];
  return `
    <section class="runtime-approval-panel ${actionable ? "" : "resolved"}" data-runtime-approval="${escapeHtml(approval.id || "")}" data-runtime-task="${escapeHtml(message.taskId || approval.taskId || "")}" data-runtime-type="permission">
      <div class="decision-panel-header"><div><span class="decision-kicker runtime-kicker">OpenCode 确认</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(statusText)}</small></div><time>${formatTime(message.time)}</time></div>
      <div class="runtime-permission-body">
        <div class="runtime-permission-meta"><span>Agent</span><strong>${escapeHtml(approval.agentId || "OpenCode")}</strong><span>权限</span><strong>${escapeHtml(approval.permission || "tool")}</strong></div>
        ${patterns.length ? `<pre class="runtime-patterns"><code>${escapeHtml(patterns.join("\n"))}</code></pre>` : `<p>${escapeHtml(approval.details || "OpenCode 请求执行一个受权限控制的动作。")}</p>`}
        ${actionable ? `<textarea class="runtime-approval-message" rows="2" placeholder="可选：给 OpenCode 的说明"></textarea><div class="decision-actions"><button type="button" class="secondary runtime-approval-reply" data-runtime-reply="reject">拒绝</button>${approval.canAlwaysAllow ? `<button type="button" class="secondary runtime-approval-reply" data-runtime-reply="always">始终允许</button>` : ""}<button type="button" class="decision-submit-button runtime-approval-reply" data-runtime-reply="once">本次允许</button></div>` : ""}
      </div>
    </section>`;
}

function renderRuntimeQuestionItem(question, index, actionable) {
  const options = Array.isArray(question.options) ? question.options : [];
  return `
    <article class="decision-item runtime-question-item" data-runtime-question-index="${index}" data-runtime-multiple="${question.multiple ? "true" : "false"}">
      <div class="decision-number">${index + 1}</div>
      <div class="decision-content">
        <div class="decision-question">${escapeHtml(question.header || `问题 ${index + 1}`)}</div>
        ${question.question ? `<div class="decision-hint">${escapeHtml(question.question)}</div>` : ""}
        ${options.length ? `<div class="decision-options">${options.map((option) => `<button type="button" class="decision-option" data-runtime-question-option="${index}" data-option-value="${escapeHtml(option.label)}" ${actionable ? "" : "disabled"}><span>${escapeHtml(option.label)}</span><strong>${escapeHtml(option.description || option.label)}</strong></button>`).join("")}</div>` : ""}
        ${question.custom !== false ? `<input class="decision-custom-input" data-runtime-question-custom="${index}" placeholder="${options.length ? "输入其他答案" : "请输入回答"}" ${actionable ? "" : "disabled"} />` : ""}
      </div>
    </article>`;
}

function approvalStatusLabel(status) {
  return ({ pending: "等待处理", approved: "已允许", rejected: "已拒绝", cancelled: "已取消" })[status] || status || "已处理";
}

function bindPendingDecisionPanels() {
  els.eventsFeed.querySelectorAll("[data-decision-panel]").forEach((panel) => {
    panel.querySelectorAll("[data-decision-option]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = button.dataset.decisionOption;
        panel.querySelectorAll(`[data-decision-option="${index}"]`).forEach((item) => {
          item.classList.toggle("selected", item === button);
        });
        const input = panel.querySelector(`[data-decision-custom="${index}"]`);
        if (input) {
          input.value = button.dataset.optionValue || "";
        }
      });
    });

    panel.querySelector("[data-decision-fill]")?.addEventListener("click", () => {
      const content = collectDecisionPanelContent(panel);
      if (!content) {
        setConnection("请至少选择或填写一个确认项");
        return;
      }
      els.chatMessageInput.value = content;
      els.chatMessageInput.focus();
    });

    panel.querySelector("[data-decision-submit]")?.addEventListener("click", async () => {
      const content = collectDecisionPanelContent(panel);
      if (!content) {
        setConnection("请至少选择或填写一个确认项");
        return;
      }
      panel.classList.add("submitting");
      panel.querySelectorAll("button, input, textarea").forEach((item) => {
        item.disabled = true;
      });
      await submitHumanContent(content, {
        restoreOnError: () => {
          panel.classList.remove("submitting");
          panel.querySelectorAll("button, input, textarea").forEach((item) => {
            item.disabled = false;
          });
        }
      });
    });
  });
}

function bindRuntimeApprovalPanels() {
  els.eventsFeed.querySelectorAll("[data-runtime-approval]").forEach((panel) => {
    panel.querySelectorAll("[data-runtime-question-option]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = button.dataset.runtimeQuestionOption;
        const multiple = button.closest("[data-runtime-question-index]")?.dataset.runtimeMultiple === "true";
        if (!multiple) {
          panel.querySelectorAll(`[data-runtime-question-option="${index}"]`).forEach((item) => item.classList.toggle("selected", item === button));
        } else {
          button.classList.toggle("selected");
        }
        const input = panel.querySelector(`[data-runtime-question-custom="${index}"]`);
        if (input) {
          input.value = [...panel.querySelectorAll(`[data-runtime-question-option="${index}"].selected`)]
            .map((item) => item.dataset.optionValue).filter(Boolean).join("；");
        }
      });
    });
    panel.querySelectorAll("[data-runtime-reply]").forEach((button) => {
      button.addEventListener("click", () => submitRuntimeApproval(panel, button.dataset.runtimeReply || "once"));
    });
  });
}

async function submitRuntimeApproval(panel, reply) {
  const approvalId = panel.dataset.runtimeApproval;
  const taskId = panel.dataset.runtimeTask;
  if (!state.activeRoomId || !approvalId || !taskId) return;
  const message = String(panel.querySelector(".runtime-approval-message")?.value || "").trim();
  const body = panel.dataset.runtimeType === "question"
    ? { reply, answers: collectRuntimeQuestionAnswers(panel), message }
    : { reply, message };
  panel.classList.add("submitting");
  panel.querySelectorAll("button, input, textarea").forEach((item) => { item.disabled = true; });
  try {
    await api(`/api/rooms/${encodeURIComponent(state.activeRoomId)}/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body });
    setTimeout(loadActiveRoom, 300);
  } catch (error) {
    setConnection(error.message);
    panel.classList.remove("submitting");
    panel.querySelectorAll("button, input, textarea").forEach((item) => { item.disabled = false; });
  }
}

function collectRuntimeQuestionAnswers(panel) {
  return [...panel.querySelectorAll("[data-runtime-question-index]")].map((item) => {
    const index = item.dataset.runtimeQuestionIndex;
    const selected = [...item.querySelectorAll(`[data-runtime-question-option="${index}"].selected`)]
      .map((button) => button.dataset.optionValue).filter(Boolean);
    const custom = String(item.querySelector(`[data-runtime-question-custom="${index}"]`)?.value || "").trim();
    if (custom && !selected.includes(custom)) selected.push(custom);
    return selected;
  });
}

function collectDecisionPanelContent(panel) {
  const answers = [...panel.querySelectorAll("[data-decision-index]")]
    .map((item) => {
      const index = Number(item.dataset.decisionIndex || 0) + 1;
      const id = item.dataset.decisionId || "";
      const question = item.dataset.decisionQuestion || `确认点 ${index}`;
      const input = item.querySelector("[data-decision-custom]");
      const answer = String(input?.value || "").trim();
      const prefix = id ? `${id}.` : `${index}.`;
      return answer ? `${prefix} ${question}: ${answer}` : "";
    })
    .filter(Boolean);
  const extra = String(panel.querySelector("[data-decision-extra]")?.value || "").trim();
  if (extra) {
    answers.push(`补充说明: ${extra}`);
  }
  return answers.length ? `人工确认结果:\n${answers.join("\n")}` : "";
}

function normalizeDecisionPoints(points) {
  const normalized = points
    .flatMap((point) => {
      if (point && typeof point === "object") {
        return [normalizeDecisionPointObject(point)];
      }
      return splitConfirmationText(point).map(parseDecisionPoint);
    })
    .filter((point) => point.question || point.hint);

  return normalized.length
    ? normalized
    : [{ question: "确认意见", hint: "", options: [] }];
}

function displayConfirmationPointBrief(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    const id = value.q_id || value.qid || value.id || value.key || "";
    const question = value.question || value.title || value.label || value.prompt || value.content || value.text || value.description || "";
    return [id, question].filter(Boolean).join(" ");
  }
  return String(value);
}

function splitConfirmationText(value) {
  return String(value || "")
    .replace(/^任务等待人工确认[:：]?/, "")
    .split(/\n+|[；;]/)
    .map((item) => item.replace(/^[\s#>*\-0-9.、]+/, "").trim())
    .filter(Boolean);
}

function normalizeDecisionPointObject(value) {
  const question = firstDecisionObjectText(value, [
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
  const hintParts = [
    firstDecisionObjectText(value, ["category", "type", "kind"]),
    firstDecisionObjectText(value, ["hint", "detail", "details", "reason", "suggestion", "recommendation"]),
    firstDecisionObjectText(value, ["current_inference", "currentInference", "inference"])
      ? `当前推断: ${firstDecisionObjectText(value, ["current_inference", "currentInference", "inference"])}`
      : "",
    value.inferred === true ? "该确认点包含系统推断，请确认是否采纳。" : "",
    firstDecisionObjectText(value, ["default_if_no_response", "defaultIfNoResponse", "default", "default_value", "defaultValue"])
      ? `默认处理: ${firstDecisionObjectText(value, ["default_if_no_response", "defaultIfNoResponse", "default", "default_value", "defaultValue"])}`
      : ""
  ].filter(Boolean);
  const explicitOptions = normalizeDecisionObjectOptions(value.options || value.choices || value.candidates || value.values);
  const hint = hintParts
    .filter((item, index, source) => source.indexOf(item) === index)
    .filter((item) => normalizeDecisionText(item) !== normalizeDecisionText(question))
    .join(" ");
  return {
    id: firstDecisionObjectText(value, ["q_id", "qid", "id", "key"]),
    question: question || "确认点",
    hint,
    options: explicitOptions.length ? explicitOptions : extractDecisionOptions(question, hint)
  };
}

function firstDecisionObjectText(source, keys) {
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

function normalizeDecisionObjectOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return { label: optionLabel(index), value: item.trim() };
      }
      if (item && typeof item === "object") {
        const label = firstDecisionObjectText(item, ["label", "key", "name"]) || optionLabel(index);
        const optionValue = firstDecisionObjectText(item, ["value", "text", "title", "content", "description"]);
        return optionValue ? { label, value: optionValue } : null;
      }
      const text = String(item || "").trim();
      return text ? { label: optionLabel(index), value: text } : null;
    })
    .filter(Boolean);
}

function parseDecisionPoint(value) {
  const text = String(value || "").trim();
  const colonIndex = firstColonIndex(text);
  const hasShortLabel = colonIndex > 0 && colonIndex <= 14;
  const question = hasShortLabel
    ? text.slice(0, colonIndex).trim()
    : shortQuestionFromText(text);
  const rawHint = hasShortLabel
    ? text.slice(colonIndex + 1).trim()
    : text;
  const hint = cleanDecisionHint(question, rawHint);
  return {
    question: question || "确认点",
    hint,
    options: extractDecisionOptions(question, hint)
  };
}

function firstColonIndex(value) {
  const zh = value.indexOf("：");
  const en = value.indexOf(":");
  if (zh < 0) {
    return en;
  }
  if (en < 0) {
    return zh;
  }
  return Math.min(zh, en);
}

function shortQuestionFromText(value) {
  const cleaned = String(value || "").trim();
  const questionMark = cleaned.search(/[？?]/);
  if (questionMark > 0 && questionMark <= 28) {
    return cleaned.slice(0, questionMark + 1);
  }
  const comma = cleaned.search(/[，,]/);
  if (comma > 0 && comma <= 16) {
    return cleaned.slice(0, comma);
  }
  return cleaned.length > 26 ? `${cleaned.slice(0, 26)}...` : cleaned;
}

function cleanDecisionHint(question, hint) {
  let value = String(hint || "").trim();
  const title = String(question || "").trim();
  if (!value) {
    return "";
  }
  if (title && normalizeDecisionText(value) === normalizeDecisionText(title)) {
    return "";
  }
  if (title && value.startsWith(title)) {
    value = value.slice(title.length).replace(/^[\s，,。:：？?]+/, "").trim();
  }
  if (title && normalizeDecisionText(value) === normalizeDecisionText(title)) {
    return "";
  }
  return value;
}

function normalizeDecisionText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[。？?：:，,]/g, "")
    .toLowerCase();
}

function extractDecisionOptions(question, hint) {
  const text = `${question || ""} ${hint || ""}`.trim();
  const planOptions = extractPlanOptions(text);
  if (planOptions.length > 0) {
    return planOptions;
  }

  const eitherOptions = extractEitherOptions(hint);
  if (eitherOptions.length > 0) {
    return eitherOptions;
  }

  const code = text.match(/(?:建议编码|编码)\s*([A-Z]{2,}_[A-Z0-9_]+)/i)?.[1];
  if (code) {
    return [
      { label: "A", value: `采用建议编码 ${code}` },
      { label: "B", value: "使用既定编码（见自定义填写）" }
    ];
  }

  if (/是否|需不需要|要不要|是否需要/.test(text)) {
    const positive = /录入节点|_I/.test(text) ? "需要录入节点" : "需要";
    const negative = /录入节点|_I/.test(text) ? "不需要录入节点" : "不需要";
    return [
      { label: "A", value: positive },
      { label: "B", value: negative }
    ];
  }

  return [];
}

function extractPlanOptions(text) {
  const parts = String(text || "")
    .split(/(?=方案\s*[A-DＡ-Ｄ]\s*[:：]?)/i)
    .map((part) => part.trim())
    .filter((part) => /^方案\s*[A-DＡ-Ｄ]/i.test(part));
  if (parts.length < 2) {
    return [];
  }
  return parts.slice(0, 4).map((part, index) => {
    const label = part.match(/^方案\s*([A-DＡ-Ｄ])/i)?.[1] || optionLabel(index);
    const value = part
      .replace(/^方案\s*[A-DＡ-Ｄ]\s*[:：]?/i, "")
      .replace(/[\/|]+$/, "")
      .trim();
    return { label: normalizeOptionLabel(label), value: value || part };
  });
}

function extractEitherOptions(hint) {
  const text = String(hint || "").trim();
  if (!/还是/.test(text)) {
    return [];
  }
  const [leftRaw, rightRaw] = text.split(/，?还是/);
  if (!leftRaw || !rightRaw) {
    return [];
  }
  const left = cleanInlineOptionText(leftRaw, "left");
  const right = cleanInlineOptionText(rightRaw, "right");
  return [left, right]
    .filter(Boolean)
    .slice(0, 2)
    .map((value, index) => ({ label: optionLabel(index), value }));
}

function cleanInlineOptionText(value, side = "left") {
  let text = String(value || "").trim();
  if (side === "left") {
    text = text.replace(/^.*[？?]\s*/, "");
  }
  return text
    .replace(/^.*(?:：|:)\s*/, "")
    .replace(/[？?。；;，,].*$/, "")
    .replace(/^[\s/｜|]+|[\s/｜|]+$/g, "")
    .trim();
}

function optionLabel(index) {
  return ["A", "B", "C", "D"][index] || String(index + 1);
}

function normalizeOptionLabel(label) {
  const value = String(label || "").toUpperCase();
  return ({
    "Ａ": "A",
    "Ｂ": "B",
    "Ｃ": "C",
    "Ｄ": "D"
  })[value] || value;
}

function bindMessageToggles() {
  els.eventsFeed.querySelectorAll("[data-message-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const messageId = button.dataset.messageToggle;
      const bubble = button.closest(".message-bubble");
      toggleMessageBubble(bubble, messageId);
    });
  });

  els.eventsFeed.querySelectorAll("[data-collapsible-message]").forEach((bubble) => {
    bubble.addEventListener("click", (event) => {
      if (event.target.closest("a, button, code, pre")) {
        return;
      }
      toggleMessageBubble(bubble, bubble.dataset.collapsibleMessage);
    });
  });
}

function toggleMessageBubble(bubble, messageId) {
  if (!messageId || !bubble) {
    return;
  }
  const collapsed = bubble.classList.toggle("collapsed");
  const button = bubble.querySelector("[data-message-toggle]");
  const isStream = bubble.classList.contains("stream-bubble");
  if (collapsed) {
    state.expandedMessages.delete(messageId);
    if (button) {
      button.textContent = isStream ? "查看过程" : "展开";
    }
  } else {
    state.expandedMessages.add(messageId);
    if (button) {
      button.textContent = isStream ? "收起过程" : "收起";
    }
  }
}

function bindTaskToggles() {
  els.tasksList.querySelectorAll("[data-task-card]").forEach((card) => {
    card.addEventListener("toggle", () => {
      if (card.open) {
        state.expandedTasks.add(card.dataset.taskCard);
      } else {
        state.expandedTasks.delete(card.dataset.taskCard);
      }
    });
  });
}

function findAgentDisplay(agentId) {
  const member = state.activeRoom?.members?.find((item) => item.agentId === agentId);
  const agent = state.agents.find((item) => item.id === agentId);
  return {
    name: member?.name || agent?.name || agentId || "Agent"
  };
}

function stageTitleFromEvent(event) {
  const stage = findTaskStage(event.taskId, event.stageId);
  return stage?.title || "";
}

function findTaskStage(taskId, stageId) {
  const task = state.tasks.find((item) => item.id === taskId);
  return task?.stages?.find((item) => item.id === stageId) || null;
}

function activeTask() {
  return state.tasks.find((task) => !["completed", "cancelled"].includes(task.status)) || null;
}

function statusLabel(status) {
  return ({
    queued: "等待中",
    running: "运行中",
    auditing: "后台审计",
    retrying: "等待中",
    pending: "待确认",
    approval_pending: "待授权",
    delivered: "已交付",
    completed: "已完成",
    failed: "已中断",
    cancelled: "已终止"
  })[status] || status;
}

function isLongMessage(value) {
  const text = String(value || "");
  return text.length > 520 || text.split("\n").length > 10;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMarkdown(markdown) {
  const lines = normalizeTeamRoomJsonBlocks(markdown).split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let inCode = false;
  let codeLines = [];
  let codeLang = "";

  const closeParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${paragraph.map(renderMarkdownInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) {
      return;
    }
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const closeQuote = () => {
    if (!quote.length) {
      return;
    }
    html.push(`<blockquote>${quote.map(renderMarkdownInline).join("<br>")}</blockquote>`);
    quote = [];
  };
  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCode) {
        html.push(`<pre><code${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLines = [];
        codeLang = "";
      } else {
        closeBlocks();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    if (isMarkdownTableStart(line, lines[i + 1])) {
      closeBlocks();
      const headers = parseMarkdownTableRow(line);
      const separators = parseMarkdownTableRow(lines[i + 1]);
      const alignments = separators.map(tableAlignment);
      const rows = [];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        rows.push(parseMarkdownTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      html.push(renderMarkdownTable(headers, rows, alignments));
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      closeParagraph();
      closeQuote();
      if (!list || list.type !== "ul") {
        closeList();
        list = { type: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      closeParagraph();
      closeQuote();
      if (!list || list.type !== "ol") {
        closeList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    const quoted = line.match(/^>\s?(.+)$/);
    if (quoted) {
      closeParagraph();
      closeList();
      quote.push(quoted[1]);
      continue;
    }

    closeList();
    closeQuote();
    paragraph.push(line);
  }

  if (inCode) {
    html.push(`<pre><code${codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  closeBlocks();
  return html.join("");
}

function normalizeTeamRoomJsonBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const normalized = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^```(?:\w+)?\s*$/);
    if (fence) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    const start = line.trim().match(/^TEAMROOM_([A-Z_]+)_JSON_START$/);
    if (!inFence && start) {
      const blockType = start[1];
      const block = [line.trim()];
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        block.push(current);
        if (current.trim() === `TEAMROOM_${blockType}_JSON_END`) {
          break;
        }
        i += 1;
      }

      if (normalized.length && normalized[normalized.length - 1].trim()) {
        normalized.push("");
      }
      normalized.push("```json", ...block, "```");
      if (i < lines.length - 1 && lines[i + 1]?.trim()) {
        normalized.push("");
      }
      continue;
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function isMarkdownTableStart(line, separatorLine) {
  const headers = parseMarkdownTableRow(line);
  const separators = parseMarkdownTableRow(separatorLine);
  return Boolean(
    headers?.length >= 2
    && separators?.length >= headers.length
    && separators.slice(0, headers.length).every(isMarkdownTableSeparator)
  );
}

function isMarkdownTableRow(line) {
  const cells = parseMarkdownTableRow(line);
  return Boolean(cells?.length >= 2);
}

function parseMarkdownTableRow(line = "") {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEdges = withoutLeading.endsWith("|") ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutEdges.split(/(?<!\\)\|/).map((cell) => cell.replaceAll("\\|", "|").trim());
}

function isMarkdownTableSeparator(value) {
  return /^:?-{3,}:?$/.test(String(value || "").trim());
}

function tableAlignment(separator) {
  const value = String(separator || "").trim();
  if (value.startsWith(":") && value.endsWith(":")) {
    return "center";
  }
  if (value.endsWith(":")) {
    return "end";
  }
  return "start";
}

function renderMarkdownTable(headers, rows, alignments) {
  const headerHtml = headers.map((cell, index) => (
    `<th style="text-align:${alignments[index] || "start"}">${renderMarkdownInline(cell)}</th>`
  )).join("");
  const bodyHtml = rows.map((row) => {
    const cells = headers.map((_header, index) => row[index] || "");
    return `<tr>${cells.map((cell, index) => (
      `<td style="text-align:${alignments[index] || "start"}">${renderMarkdownInline(cell)}</td>`
    )).join("")}</tr>`;
  }).join("");
  return `<div class="markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderMarkdownInline(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_match, label, url) => (
    `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
  ));
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function initials(value) {
  const text = String(value || "A").trim();
  if (!text) {
    return "A";
  }
  const asciiWords = text.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) {
    return asciiWords.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  }
  return [...text].slice(0, 2).join("");
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return String(value).replaceAll('"', '\\"').replaceAll("\\", "\\\\");
}

function policyLabel(mode) {
  return ({
    supervisor: "Supervisor 驱动",
    capability: "能力匹配",
    leader: "Leader 接力",
    round_robin: "轮转",
    manual: "手动"
  })[mode] || mode;
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

refreshAll().catch((error) => {
  setConnection(error.message);
});
