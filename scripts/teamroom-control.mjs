import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(rootDir, "data");
const packageRoot = path.resolve(rootDir, "..");
const host = process.env.TEAMROOM_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.TEAMROOM_PORT || "8787", 10);
const fileSuffix = port === 8787 ? "" : `-${port}`;
const pidFile = path.join(dataDir, `teamroom${fileSuffix}.pid`);
const logFile = path.join(dataDir, `teamroom${fileSuffix}.log`);
const baseUrl = `http://${host}:${port}`;
const command = process.argv[2] || "start";
const requiredNodeMajor = 22;

await fs.mkdir(dataDir, { recursive: true });

try {
  if (command === "start") {
    await startTeamRoom();
  } else if (command === "restart") {
    await stopTeamRoom();
    await startTeamRoom();
  } else if (command === "stop") {
    await stopTeamRoom();
  } else if (command === "status") {
    const status = await inspectTeamRoom();
    console.log(status.running ? `TeamRoom 正在运行：${baseUrl}` : "TeamRoom 当前未运行");
  } else {
    throw new Error("可用操作：start、restart、stop、status");
  }
} catch (error) {
  console.error(`\n操作失败：${error.message}`);
  console.error(`运行日志：${logFile}`);
  process.exitCode = 1;
}

async function startTeamRoom() {
  await assertLocalRequirements();
  const current = await inspectTeamRoom();
  if (current.running) {
    console.log(`TeamRoom 已经在运行，正在打开：${baseUrl}`);
    openBrowser(baseUrl);
    return;
  }
  if (current.portOccupied) {
    throw new Error(`端口 ${port} 已被其他程序占用，无法启动 TeamRoom。`);
  }

  const launchEnv = await buildLaunchEnv();
  await writeLaunchHeader(launchEnv);
  const logHandle = await fs.open(logFile, "a");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      ...launchEnv,
      TEAMROOM_HOST: host,
      TEAMROOM_PORT: String(port),
      TEAMROOM_ADAPTER: launchEnv.TEAMROOM_ADAPTER || process.env.TEAMROOM_ADAPTER || "opencode"
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd]
  });
  child.unref();
  await fs.writeFile(pidFile, `${child.pid}\n`);
  await logHandle.close();

  const ready = await waitForHealth();
  if (!ready) {
    await removePidFile();
    throw new Error(`TeamRoom 启动失败。请查看日志：${logFile}`);
  }
  console.log(`TeamRoom 已启动：${baseUrl}`);
  console.log(`运行日志：${logFile}`);
  if (launchEnv.OPENCODE_DIRECTORY) {
    console.log(`OpenCode 项目：${launchEnv.OPENCODE_DIRECTORY}`);
    console.log(`OpenCode 模式：${launchEnv.OPENCODE_LAUNCH_MODE === "managed" ? "由 TeamRoom 自动启动" : "连接已有服务"}`);
  } else {
    console.log("未自动识别 OpenCode 项目。首次进入页面后可以在“连接与设置”里选择项目文件夹。");
  }
  if (process.env.TEAMROOM_NO_OPEN !== "1") {
    openBrowser(baseUrl);
  }
}

async function stopTeamRoom() {
  const current = await inspectTeamRoom();
  if (!current.running) {
    if (current.portOccupied) {
      throw new Error(`端口 ${port} 被其他程序占用，未停止该程序。`);
    }
    await removePidFile();
    console.log("TeamRoom 当前未运行");
    return;
  }

  const pid = current.pid || await findListeningPid();
  if (!pid) {
    throw new Error("已检测到 TeamRoom，但无法确认它的进程编号。");
  }
  console.log("正在停止旧的 TeamRoom...");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  const stopped = await waitForStop(pid);
  if (!stopped) {
    process.kill(pid, "SIGKILL");
  }
  await removePidFile();
  console.log("TeamRoom 已停止");
}

async function inspectTeamRoom() {
  const response = await fetchHealth();
  if (response?.service === "openclaw-teamroom") {
    return {
      running: true,
      portOccupied: true,
      pid: await resolvePid()
    };
  }
  return {
    running: false,
    portOccupied: Boolean(await findListeningPid()),
    pid: null
  };
}

async function assertLocalRequirements() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "", 10);
  if (!Number.isFinite(major) || major < requiredNodeMajor) {
    throw new Error(`当前 Node.js 版本是 ${process.version}，TeamRoom 需要 Node.js ${requiredNodeMajor} 或更高版本。`);
  }
  const packageJson = path.join(rootDir, "package.json");
  try {
    await fs.access(packageJson);
  } catch {
    throw new Error(`启动目录不正确，没有找到 package.json：${packageJson}`);
  }
}

async function buildLaunchEnv() {
  const adapter = process.env.TEAMROOM_ADAPTER || "opencode";
  const opencodeDirectory = process.env.OPENCODE_DIRECTORY || await detectOpenCodeDirectory();
  const env = {
    TEAMROOM_ADAPTER: adapter
  };
  if (adapter === "opencode") {
    env.OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096";
    if (opencodeDirectory) {
      env.OPENCODE_DIRECTORY = opencodeDirectory;
      env.OPENCODE_LAUNCH_MODE = process.env.OPENCODE_LAUNCH_MODE
        || process.env.TEAMROOM_OPENCODE_LAUNCH_MODE
        || "managed";
    } else {
      env.OPENCODE_LAUNCH_MODE = process.env.OPENCODE_LAUNCH_MODE
        || process.env.TEAMROOM_OPENCODE_LAUNCH_MODE
        || "external";
    }
  }
  return env;
}

async function detectOpenCodeDirectory() {
  const candidates = [
    path.join(rootDir, "opencode_foxagent"),
    path.join(packageRoot, "opencode_foxagent"),
    path.join(rootDir, "foxagent"),
    path.join(packageRoot, "foxagent"),
    path.join(rootDir, "opencode-project"),
    path.join(packageRoot, "opencode-project")
  ];
  for (const candidate of candidates) {
    if (await isOpenCodeProject(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function isOpenCodeProject(directory) {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) return false;
    const configExists = await exists(path.join(directory, "opencode.json"));
    const agentsExists = await exists(path.join(directory, ".opencode", "agents"));
    return configExists || agentsExists;
  } catch {
    return false;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeLaunchHeader(launchEnv) {
  const lines = [
    "",
    `==== TeamRoom 启动 ${new Date().toLocaleString()} ====`,
    `地址: ${baseUrl}`,
    `后端: ${launchEnv.TEAMROOM_ADAPTER || "opencode"}`,
    launchEnv.OPENCODE_DIRECTORY ? `OpenCode 项目: ${launchEnv.OPENCODE_DIRECTORY}` : "OpenCode 项目: 未自动识别",
    launchEnv.OPENCODE_LAUNCH_MODE ? `OpenCode 模式: ${launchEnv.OPENCODE_LAUNCH_MODE}` : "",
    ""
  ].filter(Boolean);
  await fs.appendFile(logFile, `${lines.join("\n")}\n`);
}

async function fetchHealth() {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const health = await fetchHealth();
    if (health?.service === "openclaw-teamroom") {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function waitForStop(pid) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !(await fetchHealth())) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function resolvePid() {
  const saved = await readPidFile();
  if (saved && isProcessAlive(saved)) {
    return saved;
  }
  return findListeningPid();
}

async function readPidFile() {
  try {
    const value = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function removePidFile() {
  await fs.rm(pidFile, { force: true });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findListeningPid() {
  if (process.platform === "win32") {
    const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    const line = String(result.stdout || "").split(/\r?\n/).find((item) => (
      item.includes(`:${port}`) && item.toUpperCase().includes("LISTENING")
    ));
    const pid = Number.parseInt(line?.trim().split(/\s+/).at(-1) || "", 10);
    return Number.isInteger(pid) ? pid : null;
  }

  const result = spawnSync("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t"
  ], { encoding: "utf8" });
  const pid = Number.parseInt(String(result.stdout || "").trim().split(/\s+/)[0] || "", 10);
  return Number.isInteger(pid) ? pid : null;
}

function openBrowser(url) {
  let opener;
  let args;
  if (process.platform === "darwin") {
    opener = "open";
    args = [url];
  } else if (process.platform === "win32") {
    opener = "cmd";
    args = ["/c", "start", "", url];
  } else {
    opener = "xdg-open";
    args = [url];
  }
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
