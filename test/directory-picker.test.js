import assert from "node:assert/strict";
import test from "node:test";
import { directoryPickerCommand, pickDirectory } from "../src/v2/directory-picker.js";

test("macOS directory picker uses the native choose-folder dialog", () => {
  const command = directoryPickerCommand("darwin", "选择项目", "/tmp/project");
  assert.equal(command.file, "osascript");
  assert.match(command.args.join(" "), /choose folder/);
  assert.match(command.args.join(" "), /default location/);
});

test("directory picker returns the selected folder and treats cancellation as empty", async () => {
  const selected = await pickDirectory({}, {
    platform: "darwin",
    execFile: async () => ({ stdout: "/tmp/project/\n" })
  });
  assert.deepEqual(selected, { selected: true, path: "/tmp/project/" });

  const cancelled = await pickDirectory({}, {
    platform: "darwin",
    execFile: async () => {
      const error = new Error("User canceled. (-128)");
      error.code = 1;
      throw error;
    }
  });
  assert.deepEqual(cancelled, { selected: false, path: "" });
});
