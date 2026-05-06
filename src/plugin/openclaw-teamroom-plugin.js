import { createTeamRoomServer } from "../server.js";
import { loadConfig } from "../config.js";

/**
 * Native plugin mounting sketch.
 *
 * OpenClaw plugin APIs can differ across versions. Keep this file as the thin
 * integration layer and leave the TeamRoom core independent from those details.
 *
 * Expected shape:
 *
 * export async function register(api) {
 *   const app = await createTeamRoomServer(loadConfig());
 *   api.registerHttpRoute({
 *     method: "ANY",
 *     path: "/teamroom/*",
 *     handler: app.serverHandler
 *   });
 * }
 */
export async function register(api) {
  const config = loadConfig();
  const app = await createTeamRoomServer(config);

  if (typeof api.registerHttpRoute !== "function") {
    throw new Error("OpenClaw API does not expose registerHttpRoute; run TeamRoom standalone instead.");
  }

  api.registerHttpRoute({
    method: "ANY",
    path: "/teamroom/*",
    handler: (req, res) => app.server.emit("request", req, res)
  });
}
