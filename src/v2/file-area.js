import fs from "node:fs/promises";
import path from "node:path";

export async function resolveFileArea(config, preferredMode = "automatic") {
  const projectRoot = detectProjectRoot(config);
  const projectInputPath = projectRoot ? path.join(projectRoot, "input") : "";
  const projectInputAvailable = projectInputPath ? await isDirectory(projectInputPath) : false;
  const teamroomPath = config.teamroomDefaultFileArea;
  await fs.mkdir(teamroomPath, { recursive: true });

  const useProject = preferredMode !== "teamroom_default" && projectInputAvailable;
  return {
    mode: useProject ? "project_input" : "teamroom_default",
    path: useProject ? projectInputPath : teamroomPath,
    projectInputAvailable,
    projectInputPath: projectInputAvailable ? projectInputPath : "",
    teamroomPath
  };
}

export function detectProjectRoot(config) {
  if (config.adapter === "opencode") {
    return String(config.opencode?.directory || "").trim();
  }
  return String(config.projectDirectory || "").trim();
}

async function isDirectory(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

