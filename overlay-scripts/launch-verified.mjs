import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ROOT, pluginNames, sourceFingerprint } from "./build-fingerprint.mjs";

const manifestPath = join(ROOT, "vencord-dist", "discordmaxxer-build.json");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const requiredPlugins = [
  "DMBadge",
  "DMCursor",
  "DMDisplayNameStyle",
  "DMEmoji",
  "DMHub",
  "DMPresence",
  "DMProfileCosmetics",
  "DMProfileFlair",
  "DMTierFlair",
  "DMTranslate",
  "DMWidget",
  "PlaylistmaxxingPresence",
  "TournamentMode",
  "VideoBackground",
];

function fail(message) {
  console.error(`[Discordmaxxer] REFUSING TO LAUNCH: ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) fail("vencord-dist has no build manifest; run pnpm overlay:vencord");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.product !== "discordmaxxer") fail("staged renderer is not a Discordmaxxer build");
if (manifest.appVersion !== packageJson.version) fail(`staged version ${manifest.appVersion} does not match package ${packageJson.version}`);
if (!manifest.buildId || manifest.sourceFingerprint !== sourceFingerprint()) fail("staged renderer is stale or from another checkout");
const installedPlugins = new Set(pluginNames());
const missing = requiredPlugins.filter((plugin) => !installedPlugins.has(plugin));
if (missing.length) fail(`required plugins are missing from source: ${missing.join(", ")}`);

const args = process.argv.slice(2);
const electronCli = join(ROOT, "node_modules", "electron", "cli.js");
if (!existsSync(electronCli)) fail("local Electron CLI is missing; run pnpm install first");
console.log(`[Discordmaxxer] launching verified build ${manifest.buildId}`);
const child = spawn(process.execPath, [electronCli, ROOT, ...args], { cwd: ROOT, stdio: "inherit", windowsHide: true });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
