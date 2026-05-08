const state = {
  token: localStorage.getItem("teamroom.token") || "",
  agents: [],
  rooms: [],
  activeRoomId: localStorage.getItem("teamroom.activeRoomId") || "",
  activeRoom: null,
  tasks: [],
  events: [],
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
  sourceRoomId: ""
};

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
  supervisorDispatchTemplateInput: document.querySelector("#supervisorDispatchTemplateInput"),
  specialistWorkTemplateInput: document.querySelector("#specialistWorkTemplateInput"),
  supervisorReviewTemplateInput: document.querySelector("#supervisorReviewTemplateInput"),
  previousOutputItemTemplateInput: document.querySelector("#previousOutputItemTemplateInput"),
  roomContextItemTemplateInput: document.querySelector("#roomContextItemTemplateInput"),
  taskMessageItemTemplateInput: document.querySelector("#taskMessageItemTemplateInput"),
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
  setConfigStatus("已填入默认模板，点击保存后生效");
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
  try {
    const result = await api(`/api/rooms/${state.activeRoomId}/messages`, {
      method: "POST",
      body: { content }
    });
    appendLocalEvent(result.event || createLocalMessageEvent(content));
    setTimeout(loadActiveRoom, 300);
  } catch (error) {
    setConnection(error.message);
    els.chatMessageInput.value = content;
  }
});

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
  state.configRoomId = state.configRoomId || state.activeRoomId || state.rooms[0]?.id || "";
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
    "member.added",
    "member.removed",
    "message.created",
    "task.created",
    "task.planned",
    "task.running",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "task.resumed",
    "task.resume_skipped",
    "stage.assigned",
    "stage.running",
    "stage.completed",
    "stage.failed"
  ];
  for (const name of eventNames) {
    source.addEventListener(name, (message) => {
      const event = JSON.parse(message.data);
      appendLocalEvent(event);
      if (name.startsWith("task.") || name.startsWith("stage.") || name.startsWith("member.") || name.startsWith("room.")) {
        loadActiveRoom();
      }
    });
  }
}

function appendLocalEvent(event) {
  if (!event?.id || state.events.some((item) => item.id === event.id)) {
    return;
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
  renderRooms();
  renderAgents();
  renderActiveRoom();
  renderEvents();
  renderTasks();
  if (state.configOpen) {
    renderConfigView();
  }
}

function renderRooms() {
  const previousScrollTop = els.roomsList.scrollTop;
  if (!state.rooms.length) {
    els.roomsList.innerHTML = `<div class="empty">暂无协作室</div>`;
    return;
  }
  els.roomsList.innerHTML = state.rooms.map((room) => `
    <div class="item ${room.id === state.activeRoomId ? "active" : ""}" data-room-id="${escapeHtml(room.id)}" role="button" tabindex="0">
      <div class="item-title">
        <span>${escapeHtml(room.name)}</span>
        <button type="button" class="danger-button" data-delete-room="${escapeHtml(room.id)}" title="删除协作室">删除</button>
      </div>
      <div class="meta">${room.members?.length || 0} agents</div>
    </div>
  `).join("");
  els.roomsList.scrollTop = previousScrollTop;

  els.roomsList.querySelectorAll("[data-room-id]").forEach((item) => {
    const activate = async () => {
      state.activeRoomId = item.dataset.roomId;
      await loadActiveRoom();
    };
    item.addEventListener("click", activate);
    item.addEventListener("keydown", (event) => {
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
  els.agentsList.innerHTML = state.agents.map((agent) => `
    <article class="agent-card ${state.expandedAgents.has(agent.id) ? "expanded" : ""}" data-agent-card="${escapeHtml(agent.id)}">
      <div class="agent-summary" data-agent-toggle="${escapeHtml(agent.id)}" role="button" tabindex="0" aria-expanded="${state.expandedAgents.has(agent.id) ? "true" : "false"}">
        <span class="summary-caret" aria-hidden="true">›</span>
        <span class="agent-summary-main">
          <span class="agent-name">${escapeHtml(agent.name || agent.id)}</span>
        </span>
        <span class="status-pill ${memberIds.has(agent.id) ? "completed" : ""}">${memberIds.has(agent.id) ? "已在室" : "可加入"}</span>
        <button
          type="button"
          class="agent-add-button"
          data-add-agent="${escapeHtml(agent.id)}"
          ${!state.activeRoomId || memberIds.has(agent.id) ? "disabled" : ""}
        >${memberIds.has(agent.id) ? "已加入" : "拉入"}</button>
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
          <button type="button" class="secondary-button" data-save-profile="${escapeHtml(agent.id)}">保存标签</button>
          <button type="button" class="secondary-button" data-clear-profile="${escapeHtml(agent.id)}">清空</button>
        </div>
      </div>
    </article>
  `).join("");

  bindAgentToggles();

  els.agentsList.querySelectorAll("[data-add-agent]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const agent = state.agents.find((item) => item.id === button.dataset.addAgent);
      if (!agent || !state.activeRoomId || button.disabled) {
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/rooms/${state.activeRoomId}/members`, {
          method: "POST",
          body: {
            agentId: agent.id,
            name: agent.name,
            roles: agent.roles || [],
            capabilities: agent.capabilities || []
          }
        });
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
    ? `${policyLabel(mode)} · Supervisor 拆题 · ${room.policy?.requireReview ? "最终审核开启" : "最终审核关闭"}`
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
    ? `<strong>${escapeHtml(statusLabel(current.status))}</strong><span>${escapeHtml(current.goal)}</span>`
    : "暂无当前任务";
}

function renderEvents() {
  if (!state.events.length) {
    els.eventsFeed.innerHTML = `<div class="empty">暂无对话</div>`;
    return;
  }
  els.eventsFeed.innerHTML = state.events
    .map(eventToMessage)
    .filter(Boolean)
    .map(renderMessage)
    .join("");
  bindMessageToggles();
  els.eventsFeed.scrollTop = els.eventsFeed.scrollHeight;
}

function renderTasks() {
  if (!state.tasks.length) {
    els.tasksList.innerHTML = `<div class="empty">暂无任务</div>`;
    return;
  }
  const current = activeTask();
  els.tasksList.innerHTML = state.tasks.map((task) => {
    const open = state.expandedTasks.has(task.id) || task.id === current?.id;
    return `
    <details class="task-card" data-task-card="${escapeHtml(task.id)}" ${open ? "open" : ""}>
      <summary class="task-summary">
        <span class="summary-caret">›</span>
        <span class="task-summary-main">
          <span class="task-title">${escapeHtml(task.goal)}</span>
          <span class="meta">${escapeHtml(task.createdAt ? formatDateTime(task.createdAt) : "")}</span>
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
}

function renderTaskStage(stage) {
  const detailOpen = ["running", "failed"].includes(stage.status);
  return `
    <details class="stage" ${detailOpen ? "open" : ""}>
      <summary class="stage-summary">
        <div class="stage-row">
          <span class="stage-name">${escapeHtml(stage.title)}</span>
          <span class="status-pill ${escapeHtml(stage.status)}">${escapeHtml(statusLabel(stage.status))}</span>
        </div>
        <div class="meta">${escapeHtml(stage.assignedAgentId || "unassigned")} · ${(stage.needs || []).map(escapeHtml).join(", ")}</div>
      </summary>
      <div class="stage-detail-body">
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
  const specialistRow = graph?.querySelector(".specialist-row");
  if (!graph || !specialistRow) {
    return;
  }

  graph.style.setProperty("--graph-scale", "1");

  const availableWidth = Math.max(80, graph.clientWidth - 20);
  const rawWidth = specialistRow.scrollWidth;
  const specialistCount = Math.max(1, Number(graph.dataset.specialistCount || 1));
  const estimatedWidth = specialistCount * 108 + Math.max(0, specialistCount - 1) * 7;
  const actualRatio = rawWidth > 0 ? availableWidth / rawWidth : 1;
  const estimatedRatio = availableWidth / estimatedWidth;
  const scale = Math.max(0.46, Math.min(1, actualRatio, estimatedRatio));

  graph.style.setProperty("--graph-scale", scale.toFixed(3));
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
    "member.added": "Agent 已加入",
    "member.removed": "Agent 已移除",
    "task.created": "任务已创建",
    "task.planned": "Supervisor 已生成协作计划",
    "task.running": "任务运行中",
    "task.completed": "任务已完成",
    "task.failed": "任务失败",
    "stage.assigned": "阶段已分配",
    "stage.running": "阶段运行中",
    "stage.completed": "阶段已完成",
    "stage.failed": "阶段失败"
  })[event.type] || event.type.replaceAll(".", " ");
}

function bodyForEvent(event, payload) {
  if (event.type === "stage.completed") {
    return `${payload.agentId}: ${payload.result?.summary || "已完成"}`;
  }
  if (event.type === "stage.running") {
    return `${payload.agentId} 正在执行 ${payload.title}`;
  }
  if (event.type === "stage.assigned") {
    return `${payload.stage?.title || "阶段"} 分配给 ${payload.agentId}`;
  }
  if (event.type === "task.planned") {
    const stages = payload.stages || [];
    return stages.length
      ? stages.map((stage) => `${stage.title} -> ${stage.assignedAgentId}`).join("\n")
      : "Supervisor 未要求追加子任务阶段";
  }
  if (event.type === "task.created") {
    return payload.goal || "任务已创建";
  }
  if (event.type === "task.completed") {
    return payload.summary || "任务已完成";
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

  if (event.type === "stage.completed") {
    const agent = findAgentDisplay(payload.agentId);
    return {
      id: event.id,
      kind: "agent",
      author: agent.name,
      agentId: payload.agentId,
      title: payload.stage?.title || stageTitleFromEvent(event) || "阶段输出",
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
        ? `Supervisor 已生成协作计划：${stages.map((stage) => `${stage.title} -> ${stage.assignedAgentId}`).join("；")}`
        : "Supervisor 未要求追加子任务阶段"
    };
  }

  if (event.type === "stage.running") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${payload.agentId} 正在执行 ${payload.title}`
    };
  }

  if (event.type === "stage.assigned") {
    return {
      kind: "system",
      time: event.timestamp,
      body: `${payload.stage?.title || "阶段"} 分配给 ${payload.agentId}`
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
      kind: "system",
      time: event.timestamp,
      body: "任务已完成"
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

function renderMessage(message) {
  if (message.kind.startsWith("system")) {
    return `
      <div class="message-system ${message.kind.includes("error") ? "error" : ""}">
        <span>${renderMarkdownInline(message.body)}</span>
        <time>${formatTime(message.time)}</time>
      </div>
    `;
  }

  const avatar = initials(message.author);
  const title = message.title ? `<div class="message-stage">${escapeHtml(message.title)}</div>` : "";
  const collapsible = isLongMessage(message.body);
  const expanded = message.id && state.expandedMessages.has(message.id);
  return `
    <article class="message-row ${escapeHtml(message.kind)}">
      <div class="avatar" title="${escapeHtml(message.author)}">${escapeHtml(avatar)}</div>
      <div class="message-stack">
        <div class="message-meta">
          <span>${escapeHtml(message.author)}</span>
          <time>${formatTime(message.time)}</time>
        </div>
        <div class="message-bubble ${collapsible ? "collapsible" : ""} ${collapsible && !expanded ? "collapsed" : ""}" ${collapsible ? `data-collapsible-message="${escapeHtml(message.id || "")}"` : ""}>
          ${title}
          <div class="message-markdown">${renderMarkdown(message.body)}</div>
          ${collapsible ? `<button type="button" class="message-toggle" data-message-toggle="${escapeHtml(message.id || "")}">${expanded ? "收起" : "展开"}</button>` : ""}
        </div>
      </div>
    </article>
  `;
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
  if (collapsed) {
    state.expandedMessages.delete(messageId);
    if (button) {
      button.textContent = "展开";
    }
  } else {
    state.expandedMessages.add(messageId);
    if (button) {
      button.textContent = "收起";
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
  const task = state.tasks.find((item) => item.id === event.taskId);
  const stage = task?.stages?.find((item) => item.id === event.stageId);
  return stage?.title || "";
}

function activeTask() {
  return state.tasks.find((task) => !["completed", "cancelled"].includes(task.status)) || null;
}

function statusLabel(status) {
  return ({
    queued: "等待中",
    running: "运行中",
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
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
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
