import { createMockBackendV2 } from "./mock.js";
import { createOpenCodeBackendV2 } from "./opencode.js";

export function createBackendV2(config) {
  if (config.adapter === "mock") {
    return createMockBackendV2();
  }
  if (config.adapter === "opencode") {
    return createOpenCodeBackendV2(config);
  }
  throw new Error(`V2 backend adapter is not implemented: ${config.adapter}`);
}
