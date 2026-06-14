# CHANGELOG

## Unreleased

### V2 Cleanup

- Removed the V1 forced orchestration engine, policy engine, prompt template workbench, legacy OpenClaw file editor, and old adapter files.
- Kept the V2 direct-run runtime, OpenCode adapter, Mock adapter, SQLite store, artifact tracker, setup flow, launch scripts, formal UI, and V2 tests.
- Replaced old README content with V2-focused startup, OpenCode connection, file-area, API, and code-location notes.
- Switched room creation and deletion to `/api/v2/rooms`.
- Removed obsolete design preview pages and old V1 architecture/policy/OpenClaw connection docs.

### V2 Baseline

- OpenCode can be connected through an external `opencode serve` process or started by TeamRoom in managed mode.
- TeamRoom supports explicit main-agent selection, direct user messages, interventions, human confirmation cards, permissions, streaming progress, child invocation display, file-change tracking, timing display, and native OpenCode attach command copy.
- Mock backend remains available for local demos and automated tests.
