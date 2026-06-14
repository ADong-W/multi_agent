const REQUIRED_V2_METHODS = [
  "probeConnection",
  "listAgents",
  "sendMessage"
];

export function assertBackendAdapterV2(adapter) {
  for (const method of REQUIRED_V2_METHODS) {
    if (typeof adapter?.[method] !== "function") {
      throw new TypeError(`V2 backend adapter is missing ${method}()`);
    }
  }
  return adapter;
}
