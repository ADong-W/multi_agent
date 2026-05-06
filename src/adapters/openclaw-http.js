export function createOpenClawHttpAdapter(config) {
  const baseUrl = config.openclaw.baseUrl.replace(/\/$/, "");

  return {
    async listAgents() {
      const response = await fetch(`${baseUrl}${config.openclaw.agentsPath}`, {
        headers: authHeaders(config)
      });
      if (!response.ok) {
        throw new Error(`OpenClaw listAgents failed: ${response.status} ${response.statusText}`);
      }
      const payload = await response.json();
      const agents = Array.isArray(payload) ? payload : payload.agents || payload.data || [];
      return agents.map(normalizeAgent);
    },

    async runAgent(agentId, input, context) {
      const path = config.openclaw.runPath.replace(":agentId", encodeURIComponent(agentId));
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...authHeaders(config),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          agentId,
          input,
          context
        })
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OpenClaw runAgent failed: ${response.status} ${response.statusText} ${text}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        return payload.result || payload.message || payload.output || payload;
      }
      return response.text();
    }
  };
}

function authHeaders(config) {
  return config.openclaw.token
    ? { authorization: `Bearer ${config.openclaw.token}` }
    : {};
}

function normalizeAgent(agent) {
  return {
    id: agent.id || agent.agentId || agent.name,
    name: agent.name || agent.displayName || agent.id || agent.agentId,
    roles: agent.roles || [],
    capabilities: agent.capabilities || agent.tags || []
  };
}
