import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactTracker } from "../src/v2/artifact-tracker.js";

test("artifact tracker reports files changed during a task", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-artifacts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const before = path.join(directory, "before.xlsx");
  const changed = path.join(directory, "changed.xlsx");
  await fs.writeFile(before, "before");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(before, old, old);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(changed, "changed");

  const tracker = new ArtifactTracker({ getRoots: () => [directory] });
  const artifacts = await tracker.collect({
    startedAt,
    completedAt: new Date().toISOString()
  });

  assert.deepEqual(artifacts.map((item) => item.name), ["changed.xlsx"]);
});
