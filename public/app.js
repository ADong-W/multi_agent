const state = {
  token: localStorage.getItem("teamroom.token") || "",
  agents: [],
  rooms: [],
  activeRoomId: localStorage.getItem("teamroom.activeRoomId") || "",
  activeRoom: null,
  tasks: [],
  events: [],
  source: null,
  sourceRoomId: ""
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
  tokenInput: document.querySelector("#tokenInput"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  roomForm: document.querySelector("#roomForm"),
  roomNameInput: document.querySelector("#roomNameInput"),
  policyModeInput: document.querySelector("#policyModeInput"),
  roomsList: document.querySelector("#roomsList"),
  refreshAgentsButton: document.querySelector("#refreshAgentsButton"),
  agentsList: document.querySelector("#agentsList"),
  activeRoomName: document.querySelector("#activeRoomName"),
  activeRoomPolicy: document.querySelector("#activeRoomPolicy"),
  memberChips: document.querySelector("#memberChips"),
  eventsFeed: document.querySelector("#eventsFeed"),
  taskForm: document.querySelector("#taskForm"),
  taskGoalInput: document.querySelector("#taskGoalInput"),
  tasksList: document.querySelector("#tasksList")
};

els.tokenInput.value = state.token;

els.saveTokenButton.addEventListener("click", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("teamroom.token", state.token);
  refreshAll();
});

els.refreshAgentsButton.addEventListener("click", () => {
  loadAgents();
});

els.roomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = els.roomNameInput.value.trim() || "实施设计协作室";
  const mode = els.policyModeInput.value;
  const payload = {
    name,
    policy: {
      mode,
      requireReview: true,
      maxParallel: 2
    }
  };
  const { room } = await api("/api/rooms", {
    method: "POST",
    body: payload
  });
  els.roomNameInput.value = "";
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
  await api(`/api/rooms/${state.activeRoomId}/tasks`, {
    method: "POST",
    body: { goal }
  });
  setTimeout(loadActiveRoom, 300);
});

async function refreshAll() {
  await Promise.all([loadAgents(), loadRooms()]);
  if (!state.activeRoomId && state.rooms[0]) {
    state.activeRoomId = state.rooms[0].id;
  }
  await loadActiveRoom();
  render();
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
    "member.added",
    "member.removed",
    "task.created",
    "task.planned",
    "task.running",
    "task.completed",
    "task.failed",
    "stage.assigned",
    "stage.running",
    "stage.completed",
    "stage.failed"
  ];
  for (const name of eventNames) {
    source.addEventListener(name, (message) => {
      const event = JSON.parse(message.data);
      state.events.push(event);
      state.events = state.events.slice(-150);
      renderEvents();
      if (name.startsWith("task.") || name.startsWith("stage.") || name.startsWith("member.")) {
        loadActiveRoom();
      }
    });
  }
}

function setConnection(text) {
  els.connectionStatus.textContent = text;
}

function render() {
  renderRooms();
  renderAgents();
  renderActiveRoom();
  renderEvents();
  renderTasks();
}

function renderRooms() {
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
      <div class="meta">${escapeHtml(policyLabel(room.policy?.mode || "supervisor"))} · ${room.members?.length || 0} agents</div>
    </div>
  `).join("");

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
    <div class="item">
      <div class="item-title">
        <span>${escapeHtml(agent.name || agent.id)}</span>
        <button data-add-agent="${escapeHtml(agent.id)}" ${!state.activeRoomId || memberIds.has(agent.id) ? "disabled" : ""}>拉入</button>
      </div>
      <div class="meta">${escapeHtml(agent.id)} · ${agent.profileSource === "local" ? "本地标签" : "OpenClaw 推断"}</div>
      <div class="tags">${renderAgentTags(agent)}</div>
      <div class="profile-editor" data-profile-agent="${escapeHtml(agent.id)}">
        <div class="profile-inputs">
          <input data-profile-roles="${escapeHtml(agent.id)}" value="${escapeHtml((agent.roles || []).join(", "))}" placeholder="roles" />
          <input data-profile-capabilities="${escapeHtml(agent.id)}" value="${escapeHtml((agent.capabilities || []).join(", "))}" placeholder="capabilities" />
        </div>
        <div class="preset-row">
          ${PROFILE_PRESETS.map((preset) => `<button type="button" class="preset-button" data-preset-agent="${escapeHtml(agent.id)}" data-preset-key="${escapeHtml(preset.key)}">${escapeHtml(preset.label)}</button>`).join("")}
        </div>
        <div class="profile-actions">
          <button type="button" class="secondary-button" data-save-profile="${escapeHtml(agent.id)}">保存标签</button>
          <button type="button" class="secondary-button" data-clear-profile="${escapeHtml(agent.id)}">清空</button>
        </div>
      </div>
    </div>
  `).join("");

  els.agentsList.querySelectorAll("[data-add-agent]").forEach((button) => {
    button.addEventListener("click", async () => {
      const agent = state.agents.find((item) => item.id === button.dataset.addAgent);
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

function renderActiveRoom() {
  const room = state.activeRoom;
  if (!room) {
    els.activeRoomName.textContent = "未选择协作室";
    els.activeRoomPolicy.textContent = "协作策略";
    els.memberChips.innerHTML = "";
    els.taskForm.querySelector("button").disabled = true;
    return;
  }

  els.activeRoomName.textContent = room.name;
  const mode = room.policy?.mode || "supervisor";
  els.activeRoomPolicy.textContent = mode === "supervisor"
    ? `${policyLabel(mode)} · Supervisor 拆题 · ${room.policy?.requireReview ? "最终审核开启" : "最终审核关闭"}`
    : `${policyLabel(mode)} · ${room.policy?.requireReview ? "审核开启" : "审核关闭"} · max ${room.policy?.maxParallel || 1}`;
  els.memberChips.innerHTML = (room.members || []).map((member) => `
    <span class="chip ${escapeHtml(member.status || "idle")}">${escapeHtml(member.name || member.agentId)}</span>
  `).join("");
  els.taskForm.querySelector("button").disabled = !room.members?.length;
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
  els.eventsFeed.scrollTop = els.eventsFeed.scrollHeight;
}

function renderTasks() {
  if (!state.tasks.length) {
    els.tasksList.innerHTML = `<div class="empty">暂无任务</div>`;
    return;
  }
  els.tasksList.innerHTML = state.tasks.map((task) => `
    <article class="task-card">
      <div class="stage-row">
        <h3>${escapeHtml(task.goal)}</h3>
        <span class="status-pill ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
      </div>
      <div class="stage-list">
        ${(task.stages || []).map((stage) => `
          <div class="stage">
            <div class="stage-row">
              <span class="stage-name">${escapeHtml(stage.title)}</span>
              <span class="status-pill ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span>
            </div>
            <div class="meta">${escapeHtml(stage.assignedAgentId || "unassigned")} · ${(stage.needs || []).map(escapeHtml).join(", ")}</div>
            ${stage.reason ? `<div class="stage-note">${escapeHtml(stage.reason)}</div>` : ""}
            ${stage.result?.summary ? `<div class="stage-result">${escapeHtml(truncate(stage.result.summary, 220))}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </article>
  `).join("");
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
  if (event.type === "task.created") {
    return {
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
  return `
    <article class="message-row ${escapeHtml(message.kind)}">
      <div class="avatar" title="${escapeHtml(message.author)}">${escapeHtml(avatar)}</div>
      <div class="message-stack">
        <div class="message-meta">
          <span>${escapeHtml(message.author)}</span>
          <time>${formatTime(message.time)}</time>
        </div>
        <div class="message-bubble">
          ${title}
          <div class="message-markdown">${renderMarkdown(message.body)}</div>
        </div>
      </div>
    </article>
  `;
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

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
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

  for (const line of lines) {
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
