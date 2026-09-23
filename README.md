<p align="center">
  <img src="branding/discordmaxxer-mark-secondary.png" alt="Discordmaxxer" width="200"/>
</p>

# Discordmaxxer

> Discord, optimized.

A standalone Discord client with 50+ client-side enhancements pre-enabled, custom branding, and original plugins for tournament low-latency mode, mass-delete with safeguards, profile flair, and GIF picker upgrades.

Part of the [Maxxtopia](https://maxxtopia.com) suite — native gaming utilities for the players who count frame times. Product page: **[maxxtopia.com/discordmaxxer](https://maxxtopia.com/discordmaxxer)** · Community: [discord.gg/S78eecbWdx](https://discord.gg/S78eecbWdx).

**Status:** v0.7.x — active development. See [RESUME.md](RESUME.md) for the current live release and unpublished candidates.

---

## What it is

A standalone Discord-optimized client built on a forked plugin engine. Single download, no official Discord install needed. Ships with sensible defaults, original plugins, and a clean rebrand. Upstream credits in [NOTICE.md](NOTICE.md) per GPL-3.

## Headline features

- **50+ third-party plugins enabled by default** — FakeNitro, MessageLogger (see deleted), ClearURLs, ClientTheme, ImageZoom, TypingTweaks, RelationshipNotifier, SilentTyping, GifPaste, VolumeBooster, BetterFolders, BetterSettings, MentionAvatars, MoreQuickReactions, PinDMs, ReadAllNotificationsButton, TextReplace, WebKeybinds, WebScreenShareFixes, and more.
- **TournamentMode** (custom) — global hotkey lowers Discord's process priority, pauses costly background work, and disables rich-presence polling for low-input-delay competitive sessions. Its renderer frame-rate request is best-effort and may be ignored in normal windowed mode.
- **CompactView** (custom) — hotkey to hide server list, channels, and member sidebar. Optional auto-hide on screenshare. For vertical-monitor users.
- **MassDelete** (custom, opt-in) — bulk-delete your own messages with rate-limiting and ban-risk warnings.
- **GIF picker upgrades** (custom) — opens favorites by default, search bar over favorites.
- **DiscordmaxxerBadge** (custom) — viral identity layer with supporter-unlock removal.
- **Performance claims stay evidence-based** — Discordmaxxer does not promise a fixed RAM percentage. Tournament Mode is designed to reduce scheduling and background work; voice, screenshare, and real-device measurements remain the acceptance test.

## Building from source

Requires Git, Node.js ≥ 18, pnpm ≥ 8.

```powershell
pnpm install
pnpm build
pnpm start          # launches the app
pnpm package        # produces installers in dist/
```

## License + attribution

GPL-3.0-or-later. Forked from upstream GPL-3 projects. See [NOTICE.md](NOTICE.md) for full credits + commit lineage.

## Risk disclaimer

Client-modding Discord violates Discord's ToS. Enforcement is rare for personal use of plugin-based clients (similar tools have shipped to hundreds of thousands of users without mass-ban events). MassDelete carries higher risk — gated, rate-limited, opt-in for that reason. Use at your own discretion.
