import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REQUIRED_RENDERER_FILES = [
  "vencordDesktopRenderer.js",
  "vencordDesktopRenderer.js.map",
  "vencordDesktopRenderer.css",
  "vencordDesktopShell.css",
];

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function collectFiles(directory, predicate, output = []) {
  if (!existsSync(directory)) return output;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolute, predicate, output);
    else if (predicate(absolute)) output.push(absolute);
  }
  return output;
}

function isSourceFile(filePath) {
  const normalized = relative(ROOT, filePath).replaceAll("\\", "/");
  if (normalized.startsWith("vencord-dist/") || normalized.startsWith("node_modules/")) return false;
  if (normalized.startsWith("overlay-scripts/reports/") || normalized.startsWith("overlay-scripts/screenshots/")) return false;
  // Benchmark CSV/JSON output is generated state, not renderer input. Keeping
  // it out of the source fingerprint prevents every measurement from making a
  // verified staged build look stale on the next launch.
  if (normalized.startsWith("overlay-scripts/") && /\.(?:csv|json)$/.test(normalized)) return false;
  return /\.(?:json|js|mjs|ts|tsx|css)$/.test(normalized);
}

export function sourceFiles() {
  return [
    ...collectFiles(join(ROOT, "plugins"), isSourceFile),
    ...collectFiles(join(ROOT, "src"), isSourceFile),
    ...collectFiles(join(ROOT, "overlay-scripts"), isSourceFile),
    join(ROOT, "package.json"),
  ]
    .filter((filePath) => existsSync(filePath))
    .sort();
}

export function sourceFingerprint() {
  const hash = createHash("sha256");
  for (const filePath of sourceFiles()) {
    hash.update(relative(ROOT, filePath).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function pluginNames() {
  return readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (existsSync(join(ROOT, "plugins", entry.name, "index.tsx")) || existsSync(join(ROOT, "plugins", entry.name, "index.ts"))),
    )
    .map((entry) => entry.name)
    .sort();
}

export function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function fileSnapshot(directory) {
  return Object.fromEntries(
    REQUIRED_RENDERER_FILES.flatMap((name) => {
      const filePath = join(directory, name);
      if (!existsSync(filePath)) return [];
      return [[name, { sha256: sha256File(filePath), bytes: statSync(filePath).size }]];
    }),
  );
}
