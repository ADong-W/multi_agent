import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class OpenCodeProcessManager {
  constructor(config = {}, dependencies = {}) {
    this.spawn = dependencies.spawn || spawn;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.command = config.opencode?.command || "opencode";
    this.profile = null;
    this.child = null;
    this.startedAt = null;
    this.lastExit = null;
    this.logs = [];
    this.startPromise = null;
    this.profileSignature = "";
    this.restartRequired = false;
  }

  configure(profile, config = {}) {
    const nextProfile = {
      ...profile,
      workspacePath: profile?.workspacePath || config.opencode?.directory || ""
    };
    const nextSignature = [
      nextProfile.backend,
      nextProfile.launchMode,
      nextProfile.baseUrl,
      nextProfile.workspacePath
    ].join("|");
    this.restartRequired = Boolean(
      this.profileSignature
      && this.profileSignature !== nextSignature
      && this.child
    );
    this.profile = nextProfile;
    this.profileSignature = nextSignature;
    this.command = config.opencode?.command || this.command || "opencode";
  }

  status() {
    return {
      mode: this.profile?.launchMode || "external",
      ownership: this.child ? "teamroom" : "external",
      processState: this.child ? "running" : "stopped",
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      logs: this.logs.slice(-12)
    };
  }

  async ensureStarted() {
    if (this.profile?.backend !== "opencode" || this.profile?.launchMode !== "managed") {
      return this.status();
    }
    if (this.restartRequired && this.child) {
      await this.stop();
      this.restartRequired = false;
    }
    if (this.child) {
      return this.status();
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async start() {
    const target = parseManagedTarget(this.profile?.baseUrl);
    const workspacePath = String(this.profile?.workspacePath || "").trim();
    if (!workspacePath) {
      throw managedError(
        "OPENCODE_WORKSPACE_MISSING",
        "未设置 OpenCode 项目目录，TeamRoom 无法启动运行服务。"
      );
    }
    try {
      if (!(await fs.stat(workspacePath)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw managedError(
        "OPENCODE_WORKSPACE_UNAVAILABLE",
        `OpenCode 项目目录不可访问：${workspacePath}`
      );
    }

    if (await this.isHealthy(target.baseUrl)) {
      this.lastExit = null;
      return {
        ...this.status(),
        ownership: "external",
        processState: "connected"
      };
    }

    const child = this.spawn(this.command, [
      "serve",
      "--hostname",
      target.hostname,
      "--port",
      String(target.port),
      "--print-logs",
      "--log-level",
      "INFO"
    ], {
      cwd: workspacePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.restartRequired = false;
    this.startedAt = new Date().toISOString();
    this.lastExit = null;
    this.capture(child.stdout);
    this.capture(child.stderr);

    const earlyFailure = new Promise((_, reject) => {
      child.once("error", (error) => {
        this.clearChild(child);
        reject(classifyLaunchError(error, this.command, workspacePath));
      });
      child.once("exit", (code, signal) => {
        this.lastExit = {
          code,
          signal,
          at: new Date().toISOString()
        };
        this.clearChild(child);
        reject(managedError(
          "OPENCODE_EXITED",
          `OpenCode 启动后立即退出${code === null ? "" : `（退出码 ${code}）`}。`,
          this.logs.slice(-12)
        ));
      });
    });

    try {
      await Promise.race([
        this.waitUntilHealthy(target.baseUrl),
        earlyFailure
      ]);
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async reconnect() {
    if (this.profile?.launchMode !== "managed") {
      return this.status();
    }
    if (this.child) {
      await this.stop();
    }
    return this.ensureStarted();
  }

  async stop() {
    const child = this.child;
    if (!child) {
      return this.status();
    }
    this.child = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
    return this.status();
  }

  async waitUntilHealthy(baseUrl) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await this.isHealthy(baseUrl)) {
        return true;
      }
      await sleep(300);
    }
    throw managedError(
      "OPENCODE_START_TIMEOUT",
      "OpenCode 已启动，但在 12 秒内没有就绪。",
      this.logs.slice(-12)
    );
  }

  async isHealthy(baseUrl) {
    try {
      const response = await this.fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(1500)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  capture(stream) {
    stream?.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      this.logs.push(...lines);
      if (this.logs.length > 80) {
        this.logs.splice(0, this.logs.length - 80);
      }
    });
  }

  clearChild(child) {
    if (this.child === child) {
      this.child = null;
    }
  }
}

export function diagnoseRuntimeError(error, profile = {}, processStatus = {}) {
  const message = String(error?.message || error || "");
  if (error?.code?.startsWith("OPENCODE_")) {
    return {
      code: error.code,
      title: "OpenCode 启动失败",
      message,
      guidance: launchGuidance(error.code),
      details: error.details || processStatus.logs || []
    };
  }
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return {
      code: "RUNTIME_AUTH_FAILED",
      title: "身份验证失败",
      message,
      guidance: "请检查 OpenCode 用户名、密码或 Token。"
    };
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return {
      code: "RUNTIME_TIMEOUT",
      title: "运行服务响应超时",
      message,
      guidance: "服务可能仍在启动或正忙，可稍后检查当前任务或重新连接。"
    };
  }
  if (/fetch failed|ECONNREFUSED|cannot connect|connection refused/i.test(message)) {
    return {
      code: "RUNTIME_UNREACHABLE",
      title: "无法连接运行服务",
      message,
      guidance: profile.launchMode === "managed"
        ? "TeamRoom 未能启动 OpenCode，请展开详情查看启动日志。"
        : "请先启动 OpenCode，或改为“由 TeamRoom 启动本机服务”。"
    };
  }
  return {
    code: "RUNTIME_UNKNOWN",
    title: "运行服务不可用",
    message,
    guidance: "请检查服务地址和项目目录后重试。"
  };
}

export function parseManagedTarget(baseUrl = "http://127.0.0.1:4096") {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw managedError("OPENCODE_URL_INVALID", `OpenCode 服务地址无效：${baseUrl}`);
  }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
    throw managedError(
      "OPENCODE_MANAGED_REMOTE_URL",
      "由 TeamRoom 启动时，服务地址必须是本机 HTTP 地址。"
    );
  }
  return {
    baseUrl: url.origin,
    hostname: url.hostname,
    port: Number(url.port || 80)
  };
}

function classifyLaunchError(error, command, workspacePath) {
  if (error?.code === "ENOENT") {
    return managedError(
      "OPENCODE_COMMAND_NOT_FOUND",
      `找不到 OpenCode 命令：${command}`,
      ["请确认已安装 OpenCode，且该命令可以在终端直接运行。"]
    );
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return managedError(
      "OPENCODE_PERMISSION_DENIED",
      `没有权限在项目目录启动 OpenCode：${workspacePath}`,
      [error.message]
    );
  }
  return managedError("OPENCODE_LAUNCH_FAILED", error?.message || "OpenCode 启动失败");
}

function managedError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function launchGuidance(code) {
  return ({
    OPENCODE_WORKSPACE_MISSING: "请设置 FoxAgent 或其他 OpenCode 项目的目录。",
    OPENCODE_WORKSPACE_UNAVAILABLE: "请确认项目目录存在，并允许当前用户访问。",
    OPENCODE_COMMAND_NOT_FOUND: "请先安装 OpenCode，或配置 OPENCODE_COMMAND。",
    OPENCODE_PERMISSION_DENIED: "请检查项目目录和 OpenCode 数据目录的访问权限。",
    OPENCODE_MANAGED_REMOTE_URL: "自动启动仅支持 127.0.0.1、localhost 或 ::1。",
    OPENCODE_START_TIMEOUT: "可查看启动日志，确认端口是否占用或 OpenCode 配置是否有效。",
    OPENCODE_EXITED: "请查看退出前的日志，通常可定位配置、端口或目录问题。"
  })[code] || "请查看启动日志后重试。";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
