# Releasing Discordmaxxer

> v0.1 ships **Windows-only** per `CLAUDE.md`. Mac/Linux defer to v0.2.

## One-time setup (do this before the first release)

1. **Create the GitHub repo** at `https://github.com/MaxxTopia/discordmaxxer` (matches `homepage` + `publish.owner`/`repo` + `repository.url` in `package.json`).
2. **Push the existing branch:** `git push -u origin main`. This populates the repo so CI has something to check out.
3. **Regenerate icons** (currently still Vesktop's penguin in `.ico`/`.icns`):
   ```powershell
   pnpm add -D sharp png-to-ico
   pnpm regen-icons
   ```
   Inspect `build/icon.ico` afterward — should be the magenta+blue gradient mark from `build/icon.svg`. Commit the new `.ico` alongside the new devDeps.

## Local build (smoke test)

```powershell
pnpm package:win        # builds dist/ + emits installer to dist/Discordmaxxer-Setup-X.X.X.exe
pnpm package:dir        # unpacked build at dist/win-unpacked/ — fastest iteration loop
```

The installer:
- Lives in `dist/`
- Is unsigned (no code-signing cert configured for v0.1; expect SmartScreen warnings on user machines — document in install instructions)
- Writes to `%LocalAppData%\Discordmaxxer` (per `build/installer.nsh`)
- Registers the `discord://` URL scheme handler (per `build.protocols`)

## Cutting a release

```powershell
# 1. Bump version
# Edit package.json "version" field (don't use `npm version` — it tries to git-tag which fights the manual flow below)
# Then: pnpm install (lock-file refresh)

# 2. Commit + tag
git add package.json pnpm-lock.yaml
git commit -m "release: v0.1.X"
git tag v0.1.X

# 3. Push + tag triggers CI
git push origin main
git push origin v0.1.X
```

## What CI does

`.github/workflows/release.yml` triggers on `v*` tags:
1. Spins up `windows-latest`
2. Installs Node 20 + pnpm + project deps
3. Validates `docs/releases/vX.Y.Z.md` before the publish command. The
   workflow fails if the file is missing, empty, or lacks a `## Highlights`
   section.
4. Runs `pnpm build` plus the strict overlay and artifact gates
5. Runs `pnpm electron-builder --windows --publish always`, which uploads the
   installer + `latest.yml` (auto-updater feed) to the GitHub release
6. Attaches the already-validated notes to that release

The release workflow publishes the release after the build and notes checks
pass. The notes file is the human-readable source for the in-app updater.
If a later post-publish step fails, the Maxx-bot alert checks the GitHub
Release first and reports whether the release is live, partial, or absent
instead of claiming that nothing was published when artifacts already exist.

## Auto-updater

`electron-updater` (v6.6.2, already in deps) reads `publish.provider: github` from `package.json` and queries `https://api.github.com/repos/MaxxTopia/discordmaxxer/releases/latest`. When a newer `version` is found, the existing updater UI in `src/renderer/components/Updater.tsx` (handled by `src/main/updater.ts`) prompts the user.

State persists in `%APPDATA%\Discordmaxxer\State.json`:
- `updater.snoozeUntil` — Date.now()+1 day if user clicks "Snooze"
- `updater.ignoredVersion` — version string if user clicks "Skip this version"

## Known v0.1 ship caveats

- **No code signing.** Windows SmartScreen will warn on first install. Users must click "More info" → "Run anyway". Document this in the install instructions / first-launch wizard.
- **Icons may still be Vesktop's** until `pnpm regen-icons` is run with sharp + png-to-ico installed. The SVG itself was rebranded 2026-05-05; the binary `.ico`/`.icns` lag.
- **Mac DMG background + Assets.car** are still Vesktop's. Acceptable since Mac builds aren't in the v0.1 CI matrix anyway.
- **arRPC** uses fixed pipes/ports (`\\?\pipe\discord-ipc-0`, ws 6463). If the user has the official Discord client running, both will be claimed and arRPC will fail over to higher pipe IDs (`-ipc-1`) and port (6464). This is fine, just noisy in the logs.

## v0.2 release-checklist additions

- Restore `macos-latest` + `ubuntu-latest` to the CI matrix
- Generate `build/icon.icns` via the `regen-icons` script
- Replace `build/Assets.car` and `build/background.tiff` with Discordmaxxer-branded versions
- Decide on Mac code-signing (Apple Developer cert + secrets) or document unsigned install
