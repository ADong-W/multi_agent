import path from "node:path";

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig() {
  const rootDir = process.cwd();
  return {
    rootDir,
    host: process.env.TEAMROOM_HOST || "127.0.0.1",
    port: readInt("TEAMROOM_PORT", 8787),
    token: process.env.TEAMROOM_TOKEN || "",
    adapter: process.env.TEAMROOM_ADAPTER || "mock",
    dataFile: path.resolve(rootDir, process.env.TEAMROOM_DATA_FILE || "data/teamroom.json"),
    publicDir: path.resolve(rootDir, "public"),
    openclaw: {
      baseUrl: process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:3000",
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "",
      deviceFile: path.resolve(rootDir, process.env.OPENCLAW_DEVICE_FILE || "data/openclaw-device.json"),
      workspaceRoot: process.env.OPENCLAW_WORKSPACE_ROOT || "~/.openclaw",
      agentFileBackupDir: path.resolve(rootDir, process.env.OPENCLAW_AGENT_FILE_BACKUP_DIR || "data/openclaw-file-backups"),
      agentsPath: process.env.OPENCLAW_AGENTS_PATH || "/api/agents",
      runPath: process.env.OPENCLAW_RUN_PATH || "/api/agents/:agentId/runs",
      modelsPath: process.env.OPENCLAW_MODELS_PATH || "/v1/models",
      responsesPath: process.env.OPENCLAW_RESPONSES_PATH || "/v1/responses",
      token: process.env.OPENCLAW_TOKEN || "",
      password: process.env.OPENCLAW_PASSWORD || ""
    }
  };
}
