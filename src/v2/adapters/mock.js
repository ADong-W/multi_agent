import { createId } from "../../utils.js";
import { assertBackendAdapterV2 } from "../backend-contract.js";

const AGENTS = [
  { id: "supervisor-agent", name: "Supervisor Agent", roles: ["main"], capabilities: ["general"] },
  { id: "form-agent", name: "Form Agent", roles: ["specialist"], capabilities: ["form"] },
  { id: "dimension-agent", name: "Dimension Agent", roles: ["specialist"], capabilities: ["dimension"] }
];

export function createMockBackendV2() {
  const sessions = new Map();
  const statuses = new Map();

  return assertBackendAdapterV2({
    async probeConnection() {
      return {
        backend: "mock",
        connected: true,
        version: "v2-demo",
        capabilities: {
          streaming: true,
          questions: true,
          permissions: true,
          interrupt: true,
          childInvocations: true,
          eventReplay: true,
          explicitCompletion: true
        }
      };
    },

    async listAgents() {
      return AGENTS;
    },

    async sendMessage({ agentId, content, context = {}, hooks = {} }) {
      const sessionId = context.backendSessionId || sessions.get(context.conversationId) || createId("mock_session");
      sessions.set(context.conversationId, sessionId);
      statuses.set(sessionId, "busy");
      await hooks.onSessionReady?.({
        sessionId,
        backendRunId: createId("mock_run")
      });
      await context.onProgress?.({
        text: "正在理解你的要求",
        append: false,
        state: "running"
      });

      if (/调用协作助手|表单|维度/.test(content)) {
        await hooks.onInvocationEvent?.({
          type: "v2.invocation.started",
          sessionId: createId("mock_child"),
          parentRunId: sessionId,
          agentId: /维度/.test(content) ? "dimension-agent" : "form-agent"
        });
      }

      if (/确认|选择/.test(content)) {
        const response = await hooks.onApprovalRequest?.({
          id: createId("mock_question"),
          type: "question",
          sessionId,
          agentId,
          title: "需要你的确认",
          questions: [{
            header: "处理方式",
            question: "是否继续执行当前任务？",
            options: ["继续", "停止"]
          }]
        });
        if (response?.reply === "reject" || response?.cancelled) {
          statuses.set(sessionId, "idle");
          return {
            backendSessionId: sessionId,
            status: "completed",
            summary: "任务已按你的选择停止。",
            completionSource: "mock_session_idle"
          };
        }
      }

      await context.onProgress?.({
        text: "正在整理最终结果",
        append: false,
        state: "running"
      });
      statuses.set(sessionId, "idle");
      return {
        backendSessionId: sessionId,
        status: "completed",
        summary: `${AGENTS.find((agent) => agent.id === agentId)?.name || agentId} 已直接完成：${content}`,
        artifacts: [],
        completionSource: "mock_session_idle"
      };
    },

    async getSnapshot({ sessionId }) {
      return {
        session: { id: sessionId },
        status: { type: statuses.get(sessionId) || "unknown" },
        children: [],
        messages: []
      };
    },

    async sendIntervention({ sessionId }) {
      statuses.set(sessionId, "busy");
      return { delivered: true, sessionId };
    },

    async watchSession({ sessionId }) {
      statuses.set(sessionId, "idle");
      return {
        backendSessionId: sessionId,
        backendRunId: sessionId,
        status: "completed",
        summary: "已恢复原会话并完成处理。",
        artifacts: [],
        completionSource: "mock_recovered_session"
      };
    },

    async interrupt({ sessionId }) {
      statuses.set(sessionId, "idle");
      return true;
    },

    async answerQuestion({ request }) {
      if (request?.sessionId) {
        statuses.set(request.sessionId, "busy");
      }
      return true;
    },

    async answerPermission() {
      return true;
    }
  });
}
