# Discordmaxxer — next release notes (draft)

> Local draft only. Do not publish until the client, worker, and website are reviewed together and the two-account cross-PC check is complete.

## Highlights

- **Founder Pass clarified:** $67 is a single payment for one of the first 33 numbered Founder slots. The claimed account receives lifetime MAXXER+, a numbered Founder badge, and no recurring charge, auto-renewal, gift-month condition, or future price-lock wording.
- **Founder claims now keep the worker's answer:** the claim panel stores and displays the tier and duration returned by the licensing worker. Founder claims are shown as lifetime MAXXER+ instead of being incorrectly hard-coded as MAXXER++ locally.
- **Founder presentation redesigned:** the in-client Founder strip and VIP page now use the Discordmaxxer purple/cyan visual language and explain the offer in plain language while keeping the **Claim a Founder slot** button.
- **Checkout copy aligned:** the private ticket panel and activation messages now describe the same `$67 once` Founder Pass, lifetime MAXXER+ entitlement, numbered badge, and no recurring charge. The button remains **Founder Pass — $67 once**.
- **Profile flair tooling:** DMProfileFlair keeps banner/avatar previews beside their inputs, shows live color swatches and typed hex text, supports recent picks, and keeps native-media safety/fallback behavior visible to the user.
- **Shared profile rendering:** profile-media and roster work remains wired for cross-install banner/avatar/theme sharing, with owner-specific profile data and widget choices taking precedence over the viewer's local choices.
- **Widget and Fortnite polish:** widget previews, the curated Fortnite hero gallery, the Diggyai-specific remembered Catwoman preset, and owner-profile hydration are retained in this build.
- **Hub and plugin UX:** DMHub shortcuts and setup guidance, plugin status toasts, DMTheme controls, DMTierFlair finish previews, DMTranslate's message context action, DMVotes prompts, DMPrivacy retry behavior, and the related plugin cleanup are included in the current local worktree.
- **Free playback remains free:** video backgrounds are available to free users; paid tiers only expand saved URL slots and media limits.
- **Free profile showcase:** every claimed Discordmaxxer user can publish one active animated banner, one active animated avatar, and custom profile colors for other Discordmaxxer clients to see. Paid tiers keep their value through larger client limits and premium status cosmetics; vanilla Discord remains unable to render roster-only flair.

## Product decision implemented locally

The recommendation is now implemented in the local client, profile worker, VIP page, and checkout copy: give every claimed free user one active animated avatar and one active animated banner, plus theme colors. The profile schema has one active URL per field, and existing worker safety limits remain in place (5 MB images, 15 MB banner video uploads, five retained media objects per user, and URL validation). Paid tiers continue to monetize broader client limits and premium cosmetics. Separate duration enforcement and paid profile-media slot expansion are still future hardening work rather than promises in this release.

## Known verification gates

- The worker Founder changes are present in the correct profile-media worker checkout but are **not deployed** in this pass.
- The client and website have local source changes but are **not pushed or published** in this pass.
- The full client test command still reports eight pre-existing lint errors in unrelated dirty files (`chromeWindowOcclusion`, `ipc`, `VesktopNative`, `rtcStats`, and `screenShareFixes`); the focused type-check and overlay verification above pass.
- Source/build checks can prove wiring; they cannot prove that Diggyai's banner, avatar, widget skins, and roster data render correctly on the second signed-in PC. That recipient/cross-PC test remains required before release.
- Discordmaxxer-only profile flair and widget skins still cannot be made visible to an unmodified vanilla Discord client; that is a client capability boundary, not a missing release-note item.

## Verification record

- Client type-check: passed (`pnpm testTypes`).
- Client overlay/build: passed (`pnpm overlay:full`); structural artifact verification passed (`node overlay-scripts/verify-build.mjs`).
- Worker syntax and tests: passed (`node --check vip-worker/worker.js; node --test vip-worker/profile-media.test.mjs`, 14/14). Non-fatal local warnings: Discord role grant skipped because `DISCORD_BOT_TOKEN` is unset, and legacy roster migration was unavailable because the KV daily list limit was already exceeded.
- Website release checks and build: passed (`npm run build`), including the VIP route.
- Browser/recipient proof: pending the two-account cross-PC check.
