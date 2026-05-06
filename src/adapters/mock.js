const MOCK_AGENTS = [
  {
    id: "supervisor-agent",
    name: "Supervisor Agent",
    roles: ["supervisor", "leader", "planner"],
    capabilities: ["supervisor", "analysis", "planning", "architecture", "summary", "communication"]
  },
  {
    id: "frontend-agent",
    name: "Frontend Agent",
    roles: ["implementer"],
    capabilities: ["frontend", "react", "ui", "coding"]
  },
  {
    id: "backend-agent",
    name: "Backend Agent",
    roles: ["implementer"],
    capabilities: ["backend", "api", "storage", "coding"]
  },
  {
    id: "reviewer-agent",
    name: "Reviewer Agent",
    roles: ["reviewer"],
    capabilities: ["review", "testing", "quality", "analysis"]
  }
];

export function createMockAdapter() {
  return {
    async listAgents() {
      return MOCK_AGENTS;
    },

    async runAgent(agentId, input, context) {
      await sleep(500 + Math.floor(Math.random() * 600));
      const agent = MOCK_AGENTS.find((item) => item.id === agentId);
      if (context.stageType === "supervisor_dispatch") {
        return {
          status: "completed",
          summary: [
            "Supervisor analyzed the goal and created a collaboration plan.",
            "TEAMROOM_DISPATCH_JSON_START",
            JSON.stringify({
              summary: `Plan work for: ${context.goal}`,
              subtasks: [
                {
                  agent_id: "frontend-agent",
                  title: "Frontend impact check",
                  goal: "Assess UI and interaction changes.",
                  needs: ["frontend", "ui"],
                  reason: "The request may affect the visible workspace."
                },
                {
                  agent_id: "backend-agent",
                  title: "Backend impact check",
                  goal: "Assess API and storage changes.",
                  needs: ["backend", "api"],
                  reason: "The request may affect orchestration or persisted state."
                }
              ],
              confirmation_points: ["Confirm final scope before implementation."]
            }, null, 2),
            "TEAMROOM_DISPATCH_JSON_END"
          ].join("\n"),
          artifacts: [],
          nextActions: ["Run specialist subtasks"]
        };
      }

      return {
        status: "completed",
        summary: `${agent?.name || agentId} completed ${context.stageType} for "${context.goal}".`,
        artifacts: [],
        nextActions: context.stageType === "supervisor_review"
          ? []
          : [`Continue after ${context.stageType}`],
        debugInputPreview: input.slice(0, 220)
      };
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
