# DMWidget editor crash continuity — 2026-09-29

## Root cause

On the published v0.7.80 client, the DMHub Create/Edit Profile Widget action
called Vencord's `openPluginModal`. Discord's current webpack module surface can
leave that helper with a null `Modal` component. The failure occurs during the
asynchronous React render, after the call returns, so the old try/catch could
not contain it. CrashHandler then left the user behind a grey recovery state
when the action was tried again.

## v0.7.81 fix

DMHub and DMWelcome now use Vencord's `SettingsRouter.openUserSettings
("vencord_plugins")` seam for the DMWidget, DMProfileFlair, and
DMDisplayNameStyle shortcuts. The router is checked before use and failures
are logged without throwing into the renderer. This keeps the editor entry
point out of the fragile modal resolver.

## Verification

- `pnpm testTypes` passed on the rebuilt candidate.
- `pnpm overlay:vencord` passed with the custom overlay staged.
- `pnpm build:dev` passed.
- `pnpm verifyPlugins` passed.
- A running candidate was tested over CDP: first open, close, and reopen all
  stayed in the app; no crash/recovery overlay appeared; no relevant
  `Modal`/`DMWidget` runtime exception was observed.

The v0.7.81 release still requires the documented strict release build,
artifact verification, tag publication, and updater/asset checks.
