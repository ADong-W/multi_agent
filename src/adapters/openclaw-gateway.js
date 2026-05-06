import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function createOpenClawGatewayAdapter(config) {
  const client = new GatewayRpcClient({
    url: resolveGatewayUrl(config),
    token: config.openclaw.token,
    password: config.openclaw.password,
    deviceFile: config.openclaw.deviceFile
  });

  return {
    async listAgents() {
      await client.connect();
      const payload = await client.request("agents.list", {});
      const agents = Array.isArray(payload?.agents) ? payload.agents : [];
      return agents.map(normalizeAgent);
    },

    async runAgent(agentId, input, context) {
      await client.connect();
      const sessionKey = sessionKeyFor(agentId, context);
      const idempotencyKey = crypto.randomUUID();

      await client.request("chat.send", {
        sessionKey,
        message: input,
        deliver: false,
        idempotencyKey
      });

      await client.waitForChatFinal({ sessionKey, runId: idempotencyKey, timeoutMs: 180000 });
      const history = await client.request("chat.history", { sessionKey, limit: 40 });
      return {
        status: "completed",
        summary: extractLastAssistantText(history),
        artifacts: [],
        nextActions: []
      };
    }
  };
}

class GatewayRpcClient {
  constructor({ url, token, password, deviceFile }) {
    this.url = url;
    this.token = token || "";
    this.password = password || "";
    this.deviceFile = deviceFile;
    this.deviceIdentity = null;
    this.connectNonce = "";
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.pending = new Map();
    this.chatWaiters = new Set();
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.openSocket()
      .then(async () => {
        this.deviceIdentity = await loadDeviceIdentity(this.deviceFile);
        await this.waitForChallenge(1500);
        const hello = await this.request("connect", this.connectParams());
        this.connected = true;
        return hello;
      })
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  request(method, params) {
    if (!this.socket) {
      return Promise.reject(new Error("OpenClaw gateway is not connected"));
    }

    const id = crypto.randomUUID();
    const message = JSON.stringify({ type: "req", id, method, params });
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw gateway request timed out: ${method}`));
      }, 180000);
      this.pending.set(id, { resolve, reject, timeout });
    });

    this.socket.write(encodeFrame(message));
    return promise;
  }

  waitForChatFinal({ sessionKey, runId, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const waiter = { sessionKey, runId, resolve, reject };
      waiter.timeout = setTimeout(() => {
        this.chatWaiters.delete(waiter);
        reject(new Error(`OpenClaw chat run timed out: ${sessionKey}`));
      }, timeoutMs);
      this.chatWaiters.add(waiter);
    });
  }

  waitForChallenge(timeoutMs) {
    if (this.connectNonce) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (this.connectNonce || Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url);
      const isSecure = url.protocol === "wss:";
      const port = Number(url.port || (isSecure ? 443 : 80));
      const socket = isSecure
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port });

      this.socket = socket;
      socket.once("error", reject);
      socket.once("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        const path = `${url.pathname || "/"}${url.search || ""}`;
        socket.write([
          `GET ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${originFor(url)}`,
          "User-Agent: OpenClaw-TeamRoom",
          "",
          ""
        ].join("\r\n"));
      });

      let handshake = Buffer.alloc(0);
      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary < 0) {
          return;
        }

        socket.off("data", onHandshakeData);
        const header = handshake.slice(0, boundary).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101") && !header.startsWith("HTTP/1.0 101")) {
          reject(new Error(`OpenClaw gateway websocket upgrade failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }

        socket.on("data", (data) => this.handleData(data));
        socket.on("close", () => this.handleClose());
        const rest = handshake.slice(boundary + 4);
        if (rest.length > 0) {
          this.handleData(rest);
        }
        resolve();
      };

      socket.on("data", onHandshakeData);
    });
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (!decoded) {
        return;
      }
      this.buffer = this.buffer.slice(decoded.bytes);

      if (decoded.opcode === OP_PING) {
        this.socket?.write(encodeFrame(decoded.payload, OP_PONG));
        continue;
      }
      if (decoded.opcode === OP_CLOSE) {
        this.socket?.end();
        this.handleClose();
        return;
      }
      if (decoded.opcode !== OP_TEXT) {
        continue;
      }

      this.handleMessage(decoded.payload.toString("utf8"));
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "res") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error?.message || "OpenClaw gateway request failed"));
      }
      return;
    }

    if (message.type === "event" && message.event === "chat") {
      this.resolveChatWaiters(message.payload || {});
      return;
    }

    if (message.type === "event" && message.event === "connect.challenge") {
      const nonce = message.payload?.nonce;
      if (typeof nonce === "string") {
        this.connectNonce = nonce;
      }
    }
  }

  resolveChatWaiters(payload) {
    const state = payload.state;
    if (!["final", "error", "aborted"].includes(state)) {
      return;
    }

    for (const waiter of [...this.chatWaiters]) {
      if (payload.sessionKey !== waiter.sessionKey) {
        continue;
      }
      if (waiter.runId && payload.runId && waiter.runId !== payload.runId) {
        continue;
      }

      clearTimeout(waiter.timeout);
      this.chatWaiters.delete(waiter);
      if (state === "final") {
        waiter.resolve(payload);
      } else {
        waiter.reject(new Error(`OpenClaw chat ended with state: ${state}`));
      }
    }
  }

  handleClose() {
    this.connected = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("OpenClaw gateway connection closed"));
    }
    this.pending.clear();
    for (const waiter of this.chatWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("OpenClaw gateway connection closed"));
    }
    this.chatWaiters.clear();
  }

  connectParams() {
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "0.1.0",
        platform: process.platform,
        mode: "webchat",
        instanceId: "teamroom"
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
      caps: ["tool-events"],
      auth: authPayload(this),
      device: signDeviceConnect({
        identity: this.deviceIdentity,
        clientId: "openclaw-control-ui",
        clientMode: "webchat",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
        token: this.token || null,
        nonce: this.connectNonce
      }),
      userAgent: "OpenClaw-TeamRoom",
      locale: "zh-CN"
    };
  }
}

function encodeFrame(payload, opcode = OP_TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const mask = crypto.randomBytes(4);
  const headerLength = data.length < 126 ? 2 : data.length < 65536 ? 4 : 10;
  const header = Buffer.alloc(headerLength);
  header[0] = 0x80 | opcode;
  if (data.length < 126) {
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    masked[i] = data[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }

  return {
    opcode,
    payload,
    bytes: offset + length
  };
}

function resolveGatewayUrl(config) {
  if (config.openclaw.gatewayUrl) {
    return config.openclaw.gatewayUrl;
  }

  const baseUrl = new URL(config.openclaw.baseUrl);
  baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return baseUrl.toString();
}

function originFor(url) {
  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

function authPayload(client) {
  if (!client.token && !client.password) {
    return undefined;
  }
  return {
    token: client.token || undefined,
    password: client.password || undefined
  };
}

async function loadDeviceIdentity(filePath) {
  if (filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.privateKeyDer && parsed.publicKeyRaw && parsed.deviceId) {
        return {
          deviceId: parsed.deviceId,
          publicKeyRaw: parsed.publicKeyRaw,
          privateKeyDer: parsed.privateKeyDer
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const identity = createDeviceIdentity();
  if (filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, ...identity }, null, 2), { mode: 0o600 });
  }
  return identity;
}

function createDeviceIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });
  const publicKeyRaw = publicKeyDer.slice(-32);
  return {
    deviceId: crypto.createHash("sha256").update(publicKeyRaw).digest("hex"),
    publicKeyRaw: base64Url(publicKeyRaw),
    privateKeyDer: privateKeyDer.toString("base64")
  };
}

function signDeviceConnect({ identity, clientId, clientMode, role, scopes, token, nonce }) {
  if (!identity) {
    return undefined;
  }
  const signedAt = Date.now();
  const payload = [
    "v2",
    identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAt),
    token || "",
    nonce || ""
  ].join("|");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(identity.privateKeyDer, "base64"),
    type: "pkcs8",
    format: "der"
  });
  const signature = crypto.sign(null, Buffer.from(payload), privateKey);
  return {
    id: identity.deviceId,
    publicKey: identity.publicKeyRaw,
    signature: base64Url(signature),
    signedAt,
    nonce: nonce || ""
  };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizeAgent(agent) {
  const id = agent.id || agent.agentId || agent.name;
  return {
    id,
    name: agent.identity?.name || agent.name || id,
    roles: agent.roles || [],
    capabilities: inferCapabilitiesFromAgent(agent)
  };
}

function inferCapabilitiesFromAgent(agent) {
  const raw = [
    agent.id,
    agent.name,
    agent.identity?.name,
    agent.model,
    ...(agent.capabilities || []),
    ...(agent.tags || [])
  ].filter(Boolean).join(" ").toLowerCase();

  const caps = new Set(["general"]);
  if (raw.includes("plan") || raw.includes("architect")) {
    caps.add("planning");
    caps.add("architecture");
    caps.add("analysis");
  }
  if (raw.includes("front") || raw.includes("ui")) {
    caps.add("frontend");
    caps.add("ui");
    caps.add("coding");
  }
  if (raw.includes("back") || raw.includes("api") || raw.includes("server")) {
    caps.add("backend");
    caps.add("api");
    caps.add("coding");
  }
  if (raw.includes("review") || raw.includes("test") || raw.includes("qa")) {
    caps.add("review");
    caps.add("testing");
    caps.add("quality");
  }
  if (raw.includes("doc") || raw.includes("write") || raw.includes("summary")) {
    caps.add("writing");
    caps.add("summary");
  }
  return [...caps];
}

function sessionKeyFor(agentId, context) {
  const room = sanitizeKey(context.roomId || "room");
  return `agent:${sanitizeKey(agentId)}:teamroom-${room}`;
}

function sanitizeKey(value) {
  return String(value || "main")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64) || "main";
}

function extractLastAssistantText(history) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (const message of [...messages].reverse()) {
    const text = messageText(message);
    if (text && String(message.role || "").toLowerCase() === "assistant") {
      return text;
    }
  }
  return "OpenClaw agent completed the run, but no assistant message was found in chat history.";
}

function messageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => part.text || part.content || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
