# TeamRoom V2

TeamRoom V2 is a lightweight human-in-the-loop room for agent collaboration. This branch keeps the V2 runtime, UI, OpenCode adapter, Mock adapter, launch scripts, tests, and V2 docs. The old V1 policy engine, forced dispatch flow, prompt-template workbench, and legacy adapter files have been removed.

For daily use, see [README-CN.md](README-CN.md).

## Start

```bash
npm start
```

Default URL:

```text
http://127.0.0.1:8787
```

OpenCode external-server mode:

```bash
cd /path/to/opencode-project
opencode serve --hostname 127.0.0.1 --port 4096

TEAMROOM_ADAPTER=opencode \
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_DIRECTORY=/path/to/opencode-project \
npm start
```

Use native OpenCode details in another terminal:

```bash
opencode attach http://127.0.0.1:4096
```

## Useful Files

```text
src/server.js
src/v2/
public/index.html
public/app.js
public/airtable-theme.css
scripts/teamroom-control.mjs
docs/teamroom-product-requirements-v2.md
docs/teamroom-technical-architecture-v2.md
docs/teamroom-rebuild-plan-v2.md
```

## Check

```bash
npm run check
npm test
```
