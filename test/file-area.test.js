import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveFileArea } from "../src/v2/file-area.js";

test("file area defaults to detected project input and can switch to TeamRoom", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-files-"));
  const project = path.join(directory, "project");
  const input = path.join(project, "input");
  const teamroom = path.join(directory, "teamroom-files");
  await fs.mkdir(input, { recursive: true });
  const config = {
    adapter: "opencode",
    opencode: { directory: project },
    teamroomDefaultFileArea: teamroom
  };

  const automatic = await resolveFileArea(config);
  assert.equal(automatic.mode, "project_input");
  assert.equal(automatic.path, input);
  assert.equal(automatic.projectInputAvailable, true);

  const switched = await resolveFileArea(config, "teamroom_default");
  assert.equal(switched.mode, "teamroom_default");
  assert.equal(switched.path, teamroom);

  await fs.rm(directory, { recursive: true, force: true });
});

test("file area creates TeamRoom default when project input is unavailable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-files-empty-"));
  const teamroom = path.join(directory, "teamroom-files");
  const result = await resolveFileArea({
    adapter: "opencode",
    opencode: { directory: path.join(directory, "project") },
    teamroomDefaultFileArea: teamroom
  });

  assert.equal(result.mode, "teamroom_default");
  assert.equal(result.projectInputAvailable, false);
  assert.equal((await fs.stat(teamroom)).isDirectory(), true);

  await fs.rm(directory, { recursive: true, force: true });
});

