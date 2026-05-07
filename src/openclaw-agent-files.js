import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const OPENCLAW_AGENT_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md"
];

const ALLOWED_FILE_NAMES = new Set(OPENCLAW_AGENT_FILE_NAMES);

export function createOpenClawAgentFiles(config) {
  const rootDir = expandHome(config.openclaw.workspaceRoot || path.join(os.homedir(), ".openclaw"));
  const backupDir = config.openclaw.agentFileBackupDir;

  return {
    async listFiles(agentId) {
      const workspace = await findWorkspace(rootDir, agentId);
      const files = await Promise.all(OPENCLAW_AGENT_FILE_NAMES.map(async (name) => {
        const filePath = path.join(workspace, name);
        const content = await readOptionalFile(filePath);
        return {
          name,
          exists: content !== null,
          content: content ?? "",
          path: filePath
        };
      }));
      return {
        agentId,
        rootDir,
        workspace,
        files
      };
    },

    async writeFile(agentId, fileName, content) {
      assertAllowedFileName(fileName);
      const workspace = await findWorkspace(rootDir, agentId);
      await fs.mkdir(workspace, { recursive: true });
      const filePath = path.join(workspace, fileName);
      await backupExistingFile({ agentId, fileName, filePath, backupDir });
      await fs.writeFile(filePath, String(content ?? ""), "utf8");
      return {
        agentId,
        workspace,
        file: {
          name: fileName,
          exists: true,
          content: String(content ?? ""),
          path: filePath
        }
      };
    }
  };
}

function assertAllowedFileName(fileName) {
  if (!ALLOWED_FILE_NAMES.has(fileName)) {
    const error = new Error(`Unsupported OpenClaw agent file: ${fileName}`);
    error.statusCode = 400;
    throw error;
  }
}

async function findWorkspace(rootDir, agentId) {
  const candidates = workspaceCandidates(rootDir, agentId);
  for (const candidate of candidates) {
    if (await hasAnyAgentFile(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function workspaceCandidates(rootDir, agentId) {
  const id = String(agentId || "main");
  const slug = sanitizeWorkspaceName(id);
  const candidates = [];

  if (id === "main") {
    candidates.push(path.join(rootDir, "workspace"));
  }
  candidates.push(path.join(rootDir, `workspace-${id}`));
  if (slug && slug !== id) {
    candidates.push(path.join(rootDir, `workspace-${slug}`));
  }
  candidates.push(path.join(rootDir, "agents", id));
  if (slug && slug !== id) {
    candidates.push(path.join(rootDir, "agents", slug));
  }

  return unique(candidates);
}

async function hasAnyAgentFile(dir) {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  for (const fileName of OPENCLAW_AGENT_FILE_NAMES) {
    try {
      const stats = await fs.stat(path.join(dir, fileName));
      if (stats.isFile()) {
        return true;
      }
    } catch {
      // keep looking
    }
  }
  return false;
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function backupExistingFile({ agentId, fileName, filePath, backupDir }) {
  if (!backupDir) {
    return;
  }
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const safeAgentId = sanitizeWorkspaceName(agentId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(backupDir, safeAgentId);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(filePath, path.join(targetDir, `${timestamp}-${fileName}`));
}

function sanitizeWorkspaceName(value) {
  return String(value || "main")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "main";
}

function expandHome(value) {
  const raw = String(value || "");
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function unique(values) {
  return [...new Set(values)];
}
