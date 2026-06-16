/**
 * @type {typeof import(".")}
 */
const path = require("node:path");
const fs = require("node:fs");

// Resolve the .node binary in this order:
//   1. Packaged build — electron-builder copies the .node to
//      process.resourcesPath via the build.extraResources entry. Prefer
//      this path in production because __dirname points into app.asar
//      and Node can't dlopen() a .node file inside an asar archive.
//   2. Dev build — node-gyp output at ./build/Release/winaudio.node.
function resolveNative() {
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, "winaudio.node"));
    }
    candidates.push(path.join(__dirname, "build", "Release", "winaudio.node"));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch { /* fall through */ }
    }
    throw new Error(
        "winaudio.node not found. Tried:\n  " + candidates.join("\n  ") +
        "\nIf this is a dev build, run `pnpm buildWinAudio` from the repo root.",
    );
}

const native = require(resolveNative());

module.exports = native;
