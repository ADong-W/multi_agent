import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIMIT = 2000;

export class ArtifactTracker {
  constructor({ getRoots, limit = DEFAULT_LIMIT } = {}) {
    this.getRoots = typeof getRoots === "function" ? getRoots : () => [];
    this.limit = limit;
  }

  async collect(run = {}) {
    const startedAt = Date.parse(run.startedAt || run.createdAt || "");
    if (!Number.isFinite(startedAt)) {
      return [];
    }
    const endedAt = Date.parse(
      run.completedAt || run.failedAt || run.cancelledAt || new Date().toISOString()
    );
    const roots = uniquePaths(await this.getRoots(run));
    const artifacts = [];
    for (const root of roots) {
      await walkFiles(root, async (filePath, stats) => {
        if (artifacts.length >= this.limit) {
          return false;
        }
        const modifiedAt = stats.mtimeMs;
        if (modifiedAt < startedAt - 2000 || modifiedAt > endedAt + 5000) {
          return true;
        }
        artifacts.push({
          name: path.basename(filePath),
          path: filePath,
          relativePath: path.relative(root, filePath),
          modifiedAt: stats.mtime.toISOString(),
          size: stats.size
        });
        return true;
      });
    }
    return dedupeArtifacts(artifacts)
      .sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
  }
}

async function walkFiles(root, visit) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(filePath, visit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (await visit(filePath, stats) === false) {
      return;
    }
  }
}

function uniquePaths(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value)))];
}

function dedupeArtifacts(artifacts) {
  const seen = new Set();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.path)) {
      return false;
    }
    seen.add(artifact.path);
    return true;
  });
}
