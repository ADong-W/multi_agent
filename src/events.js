import { createId, nowIso, sseFormat } from "./utils.js";

export class EventHub {
  constructor({ store }) {
    this.store = store;
    this.clients = new Map();
  }

  async publish(roomId, type, payload = {}) {
    const event = {
      id: createId("evt"),
      roomId,
      taskId: payload.taskId,
      stageId: payload.stageId,
      type,
      timestamp: nowIso(),
      payload
    };

    await this.store.appendEvent(event);
    const clients = this.clients.get(roomId);
    if (clients) {
      for (const res of clients) {
        res.write(sseFormat(event));
      }
    }
    return event;
  }

  async subscribe(roomId, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const events = await this.store.listEvents(roomId, 100);
    for (const event of events) {
      res.write(sseFormat(event));
    }

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30000);

    let clients = this.clients.get(roomId);
    if (!clients) {
      clients = new Set();
      this.clients.set(roomId, clients);
    }
    clients.add(res);

    res.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
      if (clients.size === 0) {
        this.clients.delete(roomId);
      }
    });
  }
}
