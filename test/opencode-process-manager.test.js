import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diagnoseRuntimeError,
  OpenCodeProcessManager,
  parseManagedTarget
} from "../src/v2/opencode-process-manager.js";

test("managed OpenCode accepts only local HTTP targets", () => {
  assert.deepEqual(parseManagedTarget("http://127.0.0.1:4096"), {
    baseUrl: "http://127.0.0.1:4096",
    hostname: "127.0.0.1",
    port: 4096
  });
  assert.throws(
    () => parseManagedTarget("https://example.com:4096"),
    (error) => error.code === "OPENCODE_MANAGED_REMOTE_URL"
  );
});

test("manager reuses an already healthy external OpenCode without spawning", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-opencode-external-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let spawned = false;
  const manager = new OpenCodeProcessManager({}, {
    spawn() {
      spawned = true;
    },
    async fetch() {
      return new Response("{}", { status: 200 });
    }
  });
  manager.configure({
    backend: "opencode",
    launchMode: "managed",
    baseUrl: "http://127.0.0.1:4096",
    workspacePath: workspace
  });

  const status = await manager.ensureStarted();

  assert.equal(spawned, false);
  assert.equal(status.ownership, "external");
  assert.equal(status.processState, "connected");
});

test("manager starts and stops only the OpenCode process it created", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-opencode-managed-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let healthChecks = 0;
  let child;
  const manager = new OpenCodeProcessManager({}, {
    async fetch() {
      healthChecks += 1;
      return new Response("{}", { status: healthChecks > 1 ? 200 : 503 });
    },
    spawn(command, args, options) {
      child = new EventEmitter();
      child.pid = 4321;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
        return true;
      };
      child.command = command;
      child.args = args;
      child.options = options;
      return child;
    }
  });
  manager.configure({
    backend: "opencode",
    launchMode: "managed",
    baseUrl: "http://localhost:4097",
    workspacePath: workspace
  });

  const started = await manager.ensureStarted();
  assert.equal(started.ownership, "teamroom");
  assert.equal(started.pid, 4321);
  assert.equal(child.command, "opencode");
  assert.equal(child.options.cwd, workspace);
  assert.deepEqual(child.args.slice(0, 5), [
    "serve",
    "--hostname",
    "localhost",
    "--port",
    "4097"
  ]);

  await manager.stop();
  assert.equal(manager.status().processState, "stopped");
});

test("manager restarts its process when the managed target changes", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-opencode-restart-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const children = [];
  let healthChecks = 0;
  const manager = new OpenCodeProcessManager({}, {
    async fetch() {
      healthChecks += 1;
      return new Response("{}", { status: healthChecks % 2 === 0 ? 200 : 503 });
    },
    spawn() {
      const child = new EventEmitter();
      child.pid = 5000 + children.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
        return true;
      };
      children.push(child);
      return child;
    }
  });
  manager.configure({
    backend: "opencode",
    launchMode: "managed",
    baseUrl: "http://127.0.0.1:4096",
    workspacePath: workspace
  });
  await manager.ensureStarted();

  manager.configure({
    backend: "opencode",
    launchMode: "managed",
    baseUrl: "http://127.0.0.1:4097",
    workspacePath: workspace
  });
  await manager.ensureStarted();

  assert.equal(children.length, 2);
  assert.equal(manager.status().pid, 5001);
  await manager.stop();
});

test("runtime diagnostics turn connection failures into actionable guidance", () => {
  const diagnostic = diagnoseRuntimeError(
    new Error("fetch failed: ECONNREFUSED"),
    { launchMode: "external" }
  );
  assert.equal(diagnostic.code, "RUNTIME_UNREACHABLE");
  assert.match(diagnostic.guidance, /先启动 OpenCode/);
});
