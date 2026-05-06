import { createMockAdapter } from "./mock.js";
import { createOpenClawGatewayAdapter } from "./openclaw-gateway.js";
import { createOpenClawHttpAdapter } from "./openclaw-http.js";
import { createOpenClawResponsesAdapter } from "./openclaw-responses.js";

export function createAdapter(config) {
  if (config.adapter === "openclaw-gateway") {
    return createOpenClawGatewayAdapter(config);
  }
  if (config.adapter === "openclaw-responses") {
    return createOpenClawResponsesAdapter(config);
  }
  if (config.adapter === "openclaw-http") {
    return createOpenClawHttpAdapter(config);
  }
  return createMockAdapter(config);
}
