import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pickDirectory(options = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const run = dependencies.execFile || execFileAsync;
  const prompt = options.prompt || "选择 OpenCode 项目文件夹";
  const initialPath = String(options.initialPath || "").trim();
  const command = directoryPickerCommand(platform, prompt, initialPath);

  try {
    const result = await run(command.file, command.args, {
      encoding: "utf8",
      windowsHide: false
    });
    const selectedPath = String(result.stdout || "").trim();
    return selectedPath ? { selected: true, path: selectedPath } : { selected: false, path: "" };
  } catch (error) {
    if (isCancellation(error, platform)) {
      return { selected: false, path: "" };
    }
    const wrapped = new Error("无法打开系统文件夹选择器，请确认 TeamRoom 在本机桌面环境中运行。");
    wrapped.cause = error;
    throw wrapped;
  }
}

export function directoryPickerCommand(platform, prompt, initialPath = "") {
  if (platform === "darwin") {
    const script = initialPath
      ? `POSIX path of (choose folder with prompt ${appleScriptString(prompt)} default location POSIX file ${appleScriptString(initialPath)})`
      : `POSIX path of (choose folder with prompt ${appleScriptString(prompt)})`;
    return { file: "osascript", args: ["-e", script] };
  }

  if (platform === "win32") {
    const escapedPrompt = powershellString(prompt);
    const escapedPath = powershellString(initialPath);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${escapedPrompt}'`,
      initialPath ? `$dialog.SelectedPath = '${escapedPath}'` : "",
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
    ].filter(Boolean).join("; ");
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", script]
    };
  }

  return {
    file: "zenity",
    args: [
      "--file-selection",
      "--directory",
      `--title=${prompt}`,
      ...(initialPath ? [`--filename=${initialPath.replace(/\/?$/, "/")}`] : [])
    ]
  };
}

function isCancellation(error, platform) {
  const message = String(error?.stderr || error?.message || "");
  if (platform === "darwin") {
    return error?.code === 1 && /User canceled|-128/i.test(message);
  }
  return error?.code === 1;
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function powershellString(value) {
  return String(value).replaceAll("'", "''");
}
