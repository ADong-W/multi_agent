export function createOpenClawResponsesAdapter(config) {
  const baseUrl = config.openclaw.baseUrl.replace(/\/$/, "");

  return {
    async listAgents() {
      const response = await fetch(`${baseUrl}${config.openclaw.modelsPath}`, {
        headers: authHeaders(config)
      });
      if (!response.ok) {
        throw new Error(`OpenClaw models request failed: ${response.status} ${response.statusText}`);
      }

      const payload = await response.json();
      const models = Array.isArray(payload) ? payload : payload.data || payload.models || [];
      const agents = models
        .map((model) => normalizeModelAgent(model))
        .filter(Boolean);

      return dedupeAgents(agents);
    },

    async runAgent(agentId, input, context) {
      const model = toOpenClawModel(agentId);
      const response = await fetch(`${baseUrl}${config.openclaw.responsesPath}`, {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input,
          metadata: {
            roomId: context.roomId,
            taskId: context.taskId,
            stageId: context.stageId,
            stageType: context.stageType
          }
        })
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OpenClaw responses request failed: ${response.status} ${response.statusText} ${text}`);
      }

      const payload = await response.json();
      return {
        status: payload.status || "completed",
        summary: extractResponseText(payload),
        artifacts: [],
        nextActions: []
      };
    }
  };
}

function authHeaders(config) {
  return config.openclaw.token
    ? { authorization: `Bearer ${config.openclaw.token}` }
    : {};
}

function normalizeModelAgent(model) {
  const modelId = typeof model === "string" ? model : model.id || model.name;
  if (!modelId) {
    return null;
  }

  const agentId = fromOpenClawModel(modelId);
  if (!agentId) {
    return null;
  }

  return {
    id: agentId,
    name: agentId,
    roles: [],
    capabilities: inferCapabilitiesFromAgentId(agentId)
  };
}

function fromOpenClawModel(modelId) {
  if (modelId === "openclaw") {
    return "default";
  }
  if (modelId.startsWith("openclaw/")) {
    return modelId.slice("openclaw/".length) || "default";
  }
  return null;
}

function toOpenClawModel(agentId) {
  if (agentId === "openclaw" || agentId.startsWith("openclaw/")) {
    return agentId;
  }
  if (agentId === "default") {
    return "openclaw/default";
  }
  return `openclaw/${agentId}`;
}

function dedupeAgents(agents) {
  const byId = new Map();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function inferCapabilitiesFromAgentId(agentId) {
  const lower = agentId.toLowerCase();
  const caps = new Set(["general"]);

  if (lower.includes("plan") || lower.includes("architect")) {
    caps.add("planning");
    caps.add("architecture");
    caps.add("analysis");
  }
  if (lower.includes("front") || lower.includes("ui")) {
    caps.add("frontend");
    caps.add("ui");
    caps.add("coding");
  }
  if (lower.includes("back") || lower.includes("api") || lower.includes("server")) {
    caps.add("backend");
    caps.add("api");
    caps.add("coding");
  }
  if (lower.includes("review") || lower.includes("test") || lower.includes("qa")) {
    caps.add("review");
    caps.add("testing");
    caps.add("quality");
  }
  if (lower.includes("doc") || lower.includes("write") || lower.includes("summary")) {
    caps.add("writing");
    caps.add("summary");
  }

  return [...caps];
}

function extractResponseText(payload) {
  if (payload.output_text) {
    return payload.output_text;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (Array.isArray(payload.output)) {
    const text = payload.output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || content.output_text || "")
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  if (Array.isArray(payload.choices)) {
    const text = payload.choices
      .map((choice) => choice.message?.content || choice.text || "")
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return JSON.stringify(payload);
}
