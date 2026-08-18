# Discordmaxxer - Codex project instructions

This file is the Codex-compatible operational companion to `CLAUDE.md`.
`CLAUDE.md`, `RESUME.md`, and `TROUBLESHOOTING.md` remain authoritative for
project design, continuity, and recovery. Read them before consequential work.

## Preserve existing work

- Inspect `git status`, recent history, and the current release state first.
- Preserve unrelated modified and untracked files. Never reset, clean, discard,
  or mass-format user work.
- Keep `CLAUDE.md` and this file vendor-neutral and usable by another agent or
  human without chat history.
- Do not expose credentials or add AI/agent authorship to commits or release
  notes.

## Build and verification

Use the existing pnpm scripts; do not invent a parallel build path.

1. `pnpm test` runs ESLint and TypeScript checking.
2. `pnpm build` produces the application bundles.
3. Before release, run the strict Vencord overlay on the pinned commit:
   `$env:DM_STRICT_REBRAND="1"; pnpm overlay:vencord`
4. Run `node overlay-scripts/verify-build.mjs` and confirm the bundled Vencord
   files, custom plugins, and shell renderer are present.
5. For native audio changes, run `node --test packages/winaudio/test.js` and,
   when capture behavior changes, `node packages/winaudio/test-loopback.js`.
6. Smoke-package with `pnpm package:dir`; build the Windows artifacts with
   `pnpm package:win`.
7. After packaging or overlay changes, relaunch the project Electron binary
   and run `DM_DEBUG_URL=http://localhost:9223 node overlay-scripts/validate-all.mjs --skip badge`.
   The badge phase writes account settings and requires separate approval.
8. Never claim live voice or screenshare-with-audio from automation alone.
   A real call and screenshare with audio on the target Windows setup remain
   the human release gate.

## Ship and publish

- Normal code changes go to `main` only after the intended files are reviewed,
  `git diff --check` is clean, the documented checks pass, and the owner has
  authorized the push.
- A version tag is a public release. The documented sequence is:
  `git tag vX.Y.Z` followed by `git push origin vX.Y.Z`.
- The tag workflow clones the Vencord commit recorded in
  `.github/workflows/release.yml`, installs with a frozen lockfile, runs the
  strict overlay and artifact-integrity gate, then runs Electron Builder with
  publish enabled. Do not tag until the real voice/screenshare gate and the
  release decision are complete.
- Verify the resulting GitHub Release assets and updater manifest after a
  published tag. An unsigned Windows installer is a SmartScreen/public-trust
  gate even when local packaging succeeds.
- Before any publish, confirm the version is aligned in the expected project
  files, shipped PowerShell/batch/cmd scripts are ASCII-only, and no unrelated
  WIP is staged.

## Known high-risk boundaries

- The Vencord pin is a main commit, not a tag. Any bump requires a clean strict
  overlay, artifact verification, and a real voice test.
- The Electron zstd compatibility flags in `src/main/index.ts` protect DAVE
  voice initialization. Re-test voice after every Electron change.
- `packages/winaudio/` is Windows-version and capture-path sensitive. A passing
  chunk-count test is not enough if a real known-audio loopback is silent.
- Screenshare echo is sender-side. Diagnose the sender's version and audio
  capture path, not only the listener's client.
- Remote configuration must fail open to the last known-good state; never make
  a control channel a startup dependency.

## Continuity handoff

At the end of meaningful work, update `RESUME.md` with what changed, the exact
verification performed, current local/pushed/published state, remaining human
tests, known risks, and the next action. Keep the live baseline separate from
an unpublished candidate.
