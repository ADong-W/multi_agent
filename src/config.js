import path from "node:path";

function readInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

export function loadConfig() {
  const rootDir = process.cwd();
  return {
    rootDir,
    host: process.env.TEAMROOM_HOST || "127.0.0.1",
    port: readInt("TEAMROOM_PORT", 8787),
    token: process.env.TEAMROOM_TOKEN || "",
    adapter: process.env.TEAMROOM_ADAPTER || "opencode",
    dataFile: path.resolve(rootDir, process.env.TEAMROOM_DATA_FILE || "data/teamroom.json"),
    v2DatabaseFile: path.resolve(rootDir, process.env.TEAMROOM_V2_DATABASE_FILE || "data/teamroom-v2.sqlite"),
    teamroomDefaultFileArea: path.resolve(
      rootDir,
      process.env.TEAMROOM_DEFAULT_FILE_AREA || "data/files/default"
    ),
    publicDir: path.resolve(rootDir, "public"),
    openclaw: {
      baseUrl: process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:3000",
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "",
      token: process.env.OPENCLAW_TOKEN || "",
      password: process.env.OPENCLAW_PASSWORD || ""
    },
    opencode: {
      command: process.env.OPENCODE_COMMAND || "opencode",
      baseUrl: process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096",
      launchMode: process.env.OPENCODE_LAUNCH_MODE || process.env.TEAMROOM_OPENCODE_LAUNCH_MODE || "external",
      token: process.env.OPENCODE_TOKEN || "",
      username: process.env.OPENCODE_USERNAME || "opencode",
      password: process.env.OPENCODE_PASSWORD || "",
      directory: process.env.OPENCODE_DIRECTORY || "",
      provider: process.env.OPENCODE_PROVIDER || "",
      model: process.env.OPENCODE_MODEL || "",
      variant: process.env.OPENCODE_VARIANT || "",
      timeoutMs: readInt("OPENCODE_TIMEOUT_MS", 180000),
      sessionStrategy: process.env.OPENCODE_SESSION_STRATEGY || "per-agent-room",
      includeHiddenAgents: readBool("OPENCODE_INCLUDE_HIDDEN_AGENTS", false)
    }
  };
}
