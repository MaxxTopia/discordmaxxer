/*
 * Discordmaxxer — Vencord source-rebrand pipeline
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Applies text-level patches to vencord-src/ before the Vencord build runs.
 * Used to strip Vencord branding from user-visible UI surfaces (settings tab
 * title, donation prompt, etc.) and replace them with Discordmaxxer-branded
 * content.
 *
 * Idempotent: each patch checks if the target text is already present and
 * skips. If `find` is missing AND `replace` is present, we count it as
 * already-patched. If neither, we warn (upstream Vencord changed shape).
 *
 * GPL-3 attribution: per-file copyright headers + LICENSE + NOTICE.md remain
 * intact. We only patch user-visible UI strings, never copyright notices.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENCORD_SRC = resolve(__dirname, "..", "vencord-src");

const PATCHES = [
    // ── A. Settings tab title ──────────────────────────────────────────
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find: 'wrapTab(VencordSettings, "Vencord Settings")',
        replace: 'wrapTab(VencordSettings, "Discordmaxxer")'
    },

    // ── B. Donation card → DiscordmaxxerVipCard ────────────────────────
    // The donation card was a 2-branch SpecialCard ternary (donor vs non-
    // donor). The VIP-card patch (added later in this file) replaces the
    // entire ternary with <DiscordmaxxerVipCard />, so the previous
    // patches that retitled / re-described the donation card are no
    // longer applicable — removed in commit landing the VipCard.
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find: "description=\"Since you've contributed to Vencord you now have a cool new badge!\"",
        replace: 'description="Thanks for contributing! Your contributor badge is active across Discordmaxxer."'
    },

    // ── C. DonateButton: URL + label ───────────────────────────────────
    {
        file: "src/components/settings/DonateButton.tsx",
        find: 'https://github.com/sponsors/Vendicated',
        replace: 'https://discordmaxxer.dev/vip'
    },
    {
        file: "src/components/settings/DonateButton.tsx",
        find: '            Donate\n',
        replace: '            View VIP\n'
    },
    {
        file: "src/components/settings/DonateButton.tsx",
        find: 'className="vc-donate-button"',
        replace: 'className="dm-vip-button"'
    },

    // ── D. Settings sidebar: rename "Vencord" link + "Vencord Settings" header ──
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'title: "Vencord",\n                panelTitle: "Vencord Settings",',
        replace: 'title: "Discordmaxxer",\n                panelTitle: "Discordmaxxer",'
    },
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'panelTitle: "Vencord Updater",',
        replace: 'panelTitle: "Updates",'
    },
    // Cloud Sync feature removal — Discordmaxxer's landing copy promises
    // "Zero outbound calls outside your messages." Vencord's Cloud Sync
    // POSTs encrypted settings to api.vencord.dev when a user enables it,
    // which violates that claim. Self-hosting the AGPL backend at
    // github.com/Vencord/Backend is real ops weight for a feature whose
    // primary value (cross-machine settings backup) barely applies — paid
    // tiers are HWID-locked to one machine anyway. So we drop the sidebar
    // registration entirely; esbuild tree-shakes the now-unreferenced
    // CloudTab + CloudIcon imports out of the bundle.
    {
        file: "src/plugins/_core/settings.tsx",
        find:
            '            buildEntry({\n' +
            '                key: "vencord_cloud",\n' +
            '                title: "Cloud",\n' +
            '                panelTitle: "Vencord Cloud",\n' +
            '                Component: CloudTab,\n' +
            '                Icon: CloudIcon\n' +
            '            }),\n',
        replace: ""
    },
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'useTitle: () => "Vencord Settings",',
        replace: 'useTitle: () => "Discordmaxxer",'
    },
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'description: "Where to put the Vencord settings section",',
        replace: 'description: "Where to put the Discordmaxxer settings section",'
    },
    {
        file: "src/plugins/_core/settings.tsx",
        find: "Also copy Vencord info (Vencord, Electron, Chromium)",
        replace: "Also copy Discordmaxxer info (Vencord engine, Electron, Chromium)"
    },

    // ── E. Strip image + brand color from the contributor card ─────────
    // (Donation-card variants of these patches were removed when the
    // VipCard replaced the donation slot.)
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find: 'cardImage={COZY_CONTRIB_IMAGE}',
        replace: 'cardImage=""'
    },
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find: 'backgroundImage={CONTRIB_BACKGROUND_IMAGE}',
        replace: 'backgroundImage=""'
    },
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find: 'backgroundColor="#EDCC87"',
        replace: 'backgroundColor="#3a2e0e"'
    },

    // ── G. Updater tab — strip Vencord/Vesktop dual-attribution card + descriptions ──
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: '<HeadingSecondary>Vesktop & Vencord</HeadingSecondary>',
        replace: '<HeadingSecondary>Discordmaxxer Updates</HeadingSecondary>'
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: '<Paragraph>Vesktop and Vencord are two separate things. This updater is for Vencord.</Paragraph>',
        replace: '<Paragraph>This updater keeps your Discordmaxxer plugin engine current.</Paragraph>'
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: 'You receive separate popups for Vesktop updates. You can also manually update by installing the <Link href="https://vesktop.dev/install">latest version</Link>.',
        replace: 'App-level updates are handled separately. You can manually update by installing the <Link href="https://discordmaxxer.dev/download">latest version</Link>.'
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: 'description="Automatically update Vencord without confirmation prompt"',
        replace: 'description="Automatically update the plugin engine without confirmation prompt"'
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: 'description="Show a notification when Vencord automatically updates"',
        replace: 'description="Show a notification when the plugin engine automatically updates"'
    },

    // ── H. Drop the heart icon from the VIP button ──
    {
        file: "src/components/settings/DonateButton.tsx",
        find: 'import { Heart } from "@components/Heart";\n',
        replace: ""
    },
    {
        file: "src/components/settings/DonateButton.tsx",
        find: "<Heart />\n            View VIP",
        replace: "View VIP"
    },

    // ── I. ChatButtons API: right-click chat bar context menu ──
    {
        file: "src/api/ChatButtons.tsx",
        find: '<Menu.MenuItem id="vc-chat-buttons" key="vencord-chat-buttons" label="Vencord Buttons">',
        replace: '<Menu.MenuItem id="vc-chat-buttons" key="vencord-chat-buttons" label="Discordmaxxer Buttons">'
    },

    // ── J. Toolbox header tooltip ──
    {
        file: "src/plugins/vencordToolbox/index.tsx",
        find: 'tooltip={isShown ? null : "Vencord Toolbox"}',
        replace: 'tooltip={isShown ? null : "Discordmaxxer Toolbox"}'
    },

    // ── K. GameActivityToggle: header dropdown ──
    {
        file: "src/plugins/gameActivityToggle/index.tsx",
        find: '{ label: "Vencord Toolbox", value: "TOOLBOX" }',
        replace: '{ label: "Discordmaxxer Toolbox", value: "TOOLBOX" }'
    },

    // ── L. Monaco QuickCSS editor window title ──
    {
        file: "src/main/monacoWin.html",
        find: "<title>Vencord QuickCSS Editor</title>",
        replace: "<title>Discordmaxxer QuickCSS Editor</title>"
    },

    // ── M. NotificationSettings — in-app notification description ──
    {
        file: "src/components/settings/tabs/vencord/NotificationSettings.tsx",
        find: "<li><strong>Vencord Notifications</strong>: These are in-app notifications</li>",
        replace: "<li><strong>Discordmaxxer Notifications</strong>: These are in-app notifications</li>"
    },
    {
        file: "src/components/settings/tabs/vencord/NotificationSettings.tsx",
        find: '{ label: "Always use Vencord notifications", value: "never" },',
        replace: '{ label: "Always use Discordmaxxer notifications", value: "never" },'
    },

    // ── O. Updater — outdated-app card ──
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: "<HeadingSecondary>Vesktop Outdated</HeadingSecondary>",
        replace: "<HeadingSecondary>Discordmaxxer Outdated</HeadingSecondary>"
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: "<Paragraph>Your version of Vesktop is outdated!</Paragraph>",
        replace: "<Paragraph>Your version of Discordmaxxer is outdated!</Paragraph>"
    },
    {
        file: "src/components/settings/tabs/updater/index.tsx",
        find: "Open Vesktop Updater",
        replace: "Open Discordmaxxer Updater"
    },

    // ── P. SettingsSync offline — backup file label + parse error ──
    {
        file: "src/api/SettingsSync/offline.ts",
        find: 'throw new Error("Invalid Settings. Is this even a Vencord Settings file?");',
        replace: 'throw new Error("Invalid Settings. Is this even a Discordmaxxer Settings file?");'
    },
    {
        file: "src/api/SettingsSync/offline.ts",
        find: '{ name: "Vencord Settings Backup", extensions: ["json"] },',
        replace: '{ name: "Discordmaxxer Settings Backup", extensions: ["json"] },'
    },

    // ── Q. Plugins-tab excluded-reasons (user-facing) ──
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: 'desktop: "Discord Desktop app or Vesktop",',
        replace: 'desktop: "Discord Desktop app or Discordmaxxer",'
    },
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: 'vesktop: "Vesktop app",',
        replace: 'vesktop: "Discordmaxxer app",'
    },
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: 'web: "Vesktop app and the Web version of Discord",',
        replace: 'web: "Discordmaxxer app and the Web version of Discord",'
    },
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: 'dev: "Developer version of Vencord"',
        replace: 'dev: "Developer build of Discordmaxxer"'
    },

    // ── R. CSP manager + theme CSP error card ──
    {
        file: "src/main/csp/manager.ts",
        find: '`You will have to fully close and restart ${IS_DISCORD_DESKTOP ? "Discord" : "Vesktop"} for the changes to take effect.`;',
        replace: '`You will have to fully close and restart ${IS_DISCORD_DESKTOP ? "Discord" : "Discordmaxxer"} for the changes to take effect.`;'
    },
    {
        file: "src/components/settings/tabs/themes/CspErrorCard.tsx",
        find: 'After allowing a domain, you have to fully close (from tray / task manager) and restart {IS_DISCORD_DESKTOP ? "Discord" : "Vesktop"} to apply the change.',
        replace: 'After allowing a domain, you have to fully close (from tray / task manager) and restart {IS_DISCORD_DESKTOP ? "Discord" : "Discordmaxxer"} to apply the change.'
    },

    // ── S. webKeybinds plugin description ──
    {
        file: "src/plugins/webKeybinds.web/index.ts",
        find: 'description: "Re-adds keybinds missing in the web version of Discord. Only works fully on Vesktop/Legcord, not inside your browser",',
        replace: 'description: "Re-adds keybinds missing in the web version of Discord. Only works fully on Discordmaxxer, not inside your browser",'
    },

    // ── T. SupportHelper user-visible copy + slash-command names ──
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: '"Vencord DevBuild": !IS_STANDALONE,',
        replace: '"Discordmaxxer DevBuild": !IS_STANDALONE,'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'name: "vencord-debug",',
        replace: 'name: "discordmaxxer-debug",'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'description: "Send Vencord debug info",',
        replace: 'description: "Send Discordmaxxer debug info",'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'name: "vencord-plugins",',
        replace: 'name: "discordmaxxer-plugins",'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'description: "Send Vencord plugin list",',
        replace: 'description: "Send Discordmaxxer plugin list",'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: '<Forms.FormText>You are using an outdated version of Vencord! Chances are, your issue is already fixed.</Forms.FormText>',
        replace: '<Forms.FormText>You are using an outdated version of Discordmaxxer! Chances are, your issue is already fixed.</Forms.FormText>'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: '<Forms.FormText>You are using an externally updated Vencord version, which we do not provide support for!</Forms.FormText>',
        replace: '<Forms.FormText>You are using an externally updated Discordmaxxer build, which we do not provide support for!</Forms.FormText>'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: '<Forms.FormText>You are using a custom build of Vencord, which we do not provide support for!</Forms.FormText>',
        replace: '<Forms.FormText>You are using a custom build of Discordmaxxer, which we do not provide support for!</Forms.FormText>'
    },
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'props.message.content.includes("/vencord-debug") || props.message.content.includes("/vencord-plugins")',
        replace: 'props.message.content.includes("/discordmaxxer-debug") || props.message.content.includes("/discordmaxxer-plugins")'
    },

    // ── Settings sidebar version footer (most visible leak) ────────────
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'if (IS_VESKTOP) return ` (Vesktop v${VesktopNative.app.getVersion()})`;',
        replace: 'if (IS_VESKTOP) return ` (v${VesktopNative.app.getVersion()})`;'
    },
    {
        file: "src/plugins/_core/settings.tsx",
        find: 'const rows = [`Vencord ${gitHash}${additionalInfo}`];',
        replace: 'const rows = [`Discordmaxxer ${gitHash}${additionalInfo}`];'
    },

    // ── Support helper client-name string ──────────────────────────────
    {
        file: "src/plugins/_core/supportHelper.tsx",
        find: 'if (IS_VESKTOP) return `Vesktop v${VesktopNative.app.getVersion()}`;',
        replace: 'if (IS_VESKTOP) return `Discordmaxxer v${VesktopNative.app.getVersion()}`;'
    },

    // ── Hypixel-style VIP card replaces the donation slot ──────────────
    // Adds the import for our 4-tier ladder card from plugins/_dm-shared/.
    // Find spans 2 consecutive imports so re-runs see find absent (the
    // VipCard line sits between them after patch -> idempotent).
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find:
            'import { SpecialCard } from "@components/settings/SpecialCard";\n' +
            'import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";',
        replace:
            'import { SpecialCard } from "@components/settings/SpecialCard";\n' +
            'import { DiscordmaxxerVipCard } from "../../../../userplugins/_dm-shared/VipCard";\n' +
            'import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";'
    },
    // Replace the entire isDonor ternary (two SpecialCards) with our card.
    // CRITICAL: this find string MUST match the upstream Vencord v1.14.13
    // source verbatim — earlier versions of this patch matched a stale
    // post-patched form that only existed in cached local vencord-src
    // checkouts, so it silently no-op'd in CI builds and shipped the
    // upstream "Please consider supporting the development of Vencord"
    // card to v0.5.0–v0.5.6 users. Verified 2026-05-09 against
    // github.com/Vendicated/Vencord/blob/v1.14.13/src/components/settings/tabs/vencord/index.tsx
    {
        file: "src/components/settings/tabs/vencord/index.tsx",
        find:
            '            {isDonor(user?.id)\n' +
            '                ? (\n' +
            '                    <SpecialCard\n' +
            '                        title="Donations"\n' +
            '                        subtitle="Thank you for donating!"\n' +
            '                        description="You can manage your perks at any time by messaging @vending.machine."\n' +
            '                        cardImage={VENNIE_DONATOR_IMAGE}\n' +
            '                        backgroundImage={DONOR_BACKGROUND_IMAGE}\n' +
            '                        backgroundColor="#ED87A9"\n' +
            '                    >\n' +
            '                        <DonateButtonComponent />\n' +
            '                    </SpecialCard>\n' +
            '                )\n' +
            '                : (\n' +
            '                    <SpecialCard\n' +
            '                        title="Support the Project"\n' +
            '                        description="Please consider supporting the development of Vencord by donating!"\n' +
            '                        cardImage={donateImage}\n' +
            '                        backgroundImage={DONOR_BACKGROUND_IMAGE}\n' +
            '                        backgroundColor="#c3a3ce"\n' +
            '                    >\n' +
            '                        <DonateButtonComponent />\n' +
            '                    </SpecialCard>\n' +
            '                )\n' +
            '            }',
        replace: '            <DiscordmaxxerVipCard />'
    },

    // ── Round 2 user-visible Vencord strings caught during rc3 testing ──
    // BackupAndRestoreTab.tsx — both Vencord references on the same panel
    {
        file: "src/components/settings/tabs/sync/BackupAndRestoreTab.tsx",
        find: 'You can import and export your Vencord settings as a JSON file.',
        replace: 'You can import and export your Discordmaxxer settings as a JSON file.'
    },
    {
        file: "src/components/settings/tabs/sync/BackupAndRestoreTab.tsx",
        find: 'or recover your settings after reinstalling Vencord or Discord.',
        replace: 'or recover your settings after reinstalling Discordmaxxer or Discord.'
    },
    // ContributorModal "Vencord in other ways"
    {
        file: "src/components/settings/tabs/plugins/ContributorModal.tsx",
        find: 'This person has not made any plugins. They likely {ContributedHyperLink} to Vencord in other ways!',
        replace: 'This person has not made any plugins. They likely {ContributedHyperLink} to the Vencord engine that powers Discordmaxxer in other ways!'
    },
    // Plugins tab "required for Vencord to function"
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: '? "This plugin is required for Vencord to function."',
        replace: '? "This plugin is required for Discordmaxxer to function."'
    },

    // ── Round 3 (rc6 testing) ──
    // Notifications panel description
    {
        file: "src/components/settings/tabs/vencord/NotificationSettings.tsx",
        find: 'Settings for Notifications sent by Vencord.',
        replace: 'Settings for Notifications sent by Discordmaxxer.'
    },
    // ── Round 4: full Vencord-name strip (user said "0 mention") ──────
    // Slash-command error toast pseudo-username
    {
        file: "src/api/Commands/index.ts",
        find: 'username: "Vencord"',
        replace: 'username: "Discordmaxxer"'
    },
    // Contributor modal — strip the "vencord.dev/source" link target
    {
        file: "src/components/settings/tabs/plugins/ContributorModal.tsx",
        find: '<Link href="https://vencord.dev/source">contributed</Link>',
        replace: '<Link href="https://github.com/MaxxTopia/discordmaxxer/graphs/contributors">contributed</Link>'
    },
    // Plugin info modal — strip the "vencord.dev/plugins/<name>" "More info" button
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'href={`https://vencord.dev/plugins/${plugin.name}`}',
        replace: 'href={`https://github.com/MaxxTopia/discordmaxxer/blob/main/vencord-src/src/plugins/${plugin.name}`}'
    },
    // CSP host-permission dialog title
    {
        file: "src/main/csp/manager.ts",
        find: 'title: "Vencord Host Permissions",',
        replace: 'title: "Discordmaxxer Host Permissions",'
    },
    // Monaco QuickCSS editor window title (used to find existing window)
    {
        file: "src/main/ipcMain.ts",
        find: 'const title = "Vencord QuickCSS Editor";',
        replace: 'const title = "Discordmaxxer QuickCSS Editor";'
    },

    // ── Round 5: plugin description fields visible in the Plugins tab ─
    // textReplace: "in Vencord's Server" Discord channel reference
    {
        file: "src/plugins/textReplace/index.tsx",
        find: 'description: "Replace text in your messages. You can find pre-made rules in the #textreplace-rules channel in Vencord\'s Server",',
        replace: 'description: "Replace text in your messages with custom rules.",'
    },
    // vencordToolbox: "Vencord quick actions"
    {
        file: "src/plugins/vencordToolbox/index.tsx",
        find: 'description: "Adds a button to the titlebar that houses Vencord quick actions",',
        replace: 'description: "Adds a button to the titlebar that houses Discordmaxxer quick actions",'
    },
    // webScreenShareFixes.web: "vesktop clients"
    {
        file: "src/plugins/webScreenShareFixes.web/index.ts",
        find: 'description: "Removes 2500kbps bitrate cap on chromium and vesktop clients.",',
        replace: 'description: "Removes 2500kbps bitrate cap on chromium-based and Electron clients.",'
    },
    // Carry forward Vencord be77396b: stop the hidden stream-preview video
    // from continuing to decode after its source is detached. Without the
    // pause(), long-running screenshares can accumulate CPU load and starve
    // the sender encoder, which is visible to native Discord recipients as
    // dropped or uneven frames. Keep this in the overlay so fresh pinned
    // source checkouts receive the safeguard as well.
    {
        file: "src/plugins/webScreenShareFixes.web/index.ts",
        find:
            '                },\n' +
            '            ]\n' +
            '        }\n' +
            '    ]\n' +
            '});',
        replace:
            '                },\n' +
            '            ]\n' +
            '        },\n' +
            '        {\n' +
            '            find: "ApplicationStreamPreviewUploadManager",\n' +
            '            replacement: {\n' +
            '                match: /(\\i)\\.removeAttribute\\("srcObject"\\)/,\n' +
            '                replace: "$1.pause(),$1.srcObject=null"\n' +
            '            }\n' +
            '        }\n' +
            '    ]\n' +
            '});'
    },
    // Badges: "Vencord Contributor" badge title
    {
        file: "src/plugins/_api/badges/index.tsx",
        find: 'description: "Vencord Contributor",',
        replace: 'description: "Plugin Engine Contributor",'
    },

    // ── Round 6 (v0.5.6): CSP allowlist + donor-badge kill ────────────
    // ImageZoom: current Discord routes attachment-image context menus
    // through `message`, not `image-context`. Keep the upstream route for
    // older builds, add the current route, and isolate slider pointer/arrow
    // events so the parent menu does not select and close on interaction.
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: ImageZoom menu route helpers",
        find: 'const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {',
        replace:
            '// Discordmaxxer: ImageZoom menu route helpers\n' +
            'function isImageContext(props: any) {\n' +
            '    const mediaType = props?.mediaItem?.contentType ?? props?.mediaItem?.originalContentType;\n' +
            '    if (mediaType) return mediaType.startsWith("image/");\n' +
            '    return props?.target?.tagName === "IMG";\n' +
            '}\n\n' +
            'function stopImageSliderKey(e: any) {\n' +
            '    if (!e.ctrlKey && !e.altKey && !e.metaKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", " "].includes(e.key)) {\n' +
            '        e.stopPropagation();\n' +
            '    }\n' +
            '}\n\n' +
            'function ImageZoomSlider({ children }: { children: JSX.Element }) {\n' +
            '    return (\n' +
            '        <div\n' +
            '            onPointerDown={e => e.stopPropagation()}\n' +
            '            onMouseDown={e => e.stopPropagation()}\n' +
            '            onClick={e => e.stopPropagation()}\n' +
            '            onKeyDown={stopImageSliderKey}\n' +
            '        >\n' +
            '            {children}\n' +
            '        </div>\n' +
            '    );\n' +
            '}\n\n' +
            'const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        find: '    if ("href" in props) return;\n    // emojis in user statuses',
        replace: '    if ("href" in props) return;\n    if (props?.mediaItem && !isImageContext(props)) return;\n    if (children.some(child => child?.props?.id === "image-zoom")) return;\n    // emojis in user statuses'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: ImageZoom interactive MenuControlItems",
        find: '                control={(props, ref) => (',
        replace: '                // Discordmaxxer: ImageZoom interactive MenuControlItems\n                interactive\n                control={(props, ref) => ('
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: ImageZoom slider interaction boundary",
        find: 'control={(props, ref) => (\n                    <Menu.MenuSliderControl',
        replace: 'control={(props, ref) => (\n                    <ImageZoomSlider>\n                        {/* Discordmaxxer: ImageZoom slider interaction boundary */}\n                        <Menu.MenuSliderControl'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        find: '                    />\n                )}',
        replace: '                        />\n                    </ImageZoomSlider>\n                )}'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: ImageZoom message-menu route",
        find: '};\n\nexport default definePlugin({\n    name: "ImageZoom",',
        replace:
            '};\n\n' +
            '// Discordmaxxer: ImageZoom message-menu route\n' +
            'const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {\n' +
            '    if (!isImageContext(props)) return;\n' +
            '    imageContextMenuPatch(children, props);\n' +
            '};\n\n' +
            'export default definePlugin({\n    name: "ImageZoom",'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        find: '        "image-context": imageContextMenuPatch\n    },',
        replace: '        "image-context": imageContextMenuPatch,\n        "message": messageContextMenuPatch\n    },'
    },
    // WebKeybinds: do not steal a key already claimed by Discord, an IME, or
    // text editing controls. Ctrl+Tab is explicitly prevented because the
    // browser focus action otherwise wins over the Discord action.
    // Upstream 72cc4d11 replaced WebKeybinds' document-level onKey handler
    // with Discord-native blocked-keybind patching. The old guards no longer
    // have a handler to attach to, so stale patches are intentionally removed.

    // Allow renderer fetches to the optmaxxing-vip Cloudflare Worker so the
    // VipClaim panel can POST {code, hwid} without tripping Discord's CSP.
    // Without this patch, fetch() throws "Failed to fetch" because the
    // worker domain isn't in connect-src.
    {
        file: "src/main/csp/index.ts",
        marker: "Discordmaxxer VIP claim worker",
        find: '    "icons.duckduckgo.com": ImageSrc, // DuckDuckGo Favicon API (Reverse Image Search)\n',
        replace:
            '    "icons.duckduckgo.com": ImageSrc, // DuckDuckGo Favicon API (Reverse Image Search)\n\n' +
            '    // Discordmaxxer VIP claim worker (shared with optimizationmaxxing).\n' +
            '    "optmaxxing-vip.maxxtopia.workers.dev": ConnectSrc,\n'
    },
    // VideoBackground plugin (MAXXER+ feature) lets users pick an arbitrary
    // HTTPS video URL as their Discord background. Discord's base CSP locks
    // media-src down hard so external video URLs 404 with MEDIA_ERR_NETWORK.
    // We open media-src to all HTTPS sources — render-only directive, no
    // exfiltration risk, narrow scope.
    {
        file: "src/main/csp/index.ts",
        marker: "Discordmaxxer: VideoBackground plugin needs arbitrary HTTPS",
        find:
            '        for (const directive of ["style-src", "connect-src", "img-src", "font-src", "media-src", "worker-src"]) {\n' +
            '            pushDirective(directive, "blob:", "data:", "vencord:", "vesktop:");\n' +
            '        }',
        replace:
            '        for (const directive of ["style-src", "connect-src", "img-src", "font-src", "media-src", "worker-src"]) {\n' +
            '            pushDirective(directive, "blob:", "data:", "vencord:", "vesktop:");\n' +
            '        }\n' +
            '        // Discordmaxxer: VideoBackground plugin needs arbitrary HTTPS\n' +
            '        // video URLs in media-src so users can use any video CDN.\n' +
            '        pushDirective("media-src", "https:");'
    },
    // Disable Chromium's Opaque Response Blocking (ORB) for cross-origin
    // media + image responses by injecting `Cross-Origin-Resource-Policy:
    // cross-origin` on each response. CSP `media-src https:` permits the
    // load but ORB is a SEPARATE Chromium security layer that blocks
    // no-CORS media responses regardless of CSP — the user gets
    // net::ERR_BLOCKED_BY_ORB with no console error visible. Adding CORP
    // header tells ORB the resource is intentionally cross-origin safe.
    // Disabling at the response-header level beats trying disable-features
    // flags which Chromium ignores in current versions (ORB was promoted
    // from feature flag to mandatory behavior).
    {
        file: "src/main/csp/index.ts",
        marker: "Discordmaxxer: bypass Opaque Response Blocking for media+image",
        find:
            '            if (resourceType === "stylesheet") {\n' +
            '                const header = findHeader(responseHeaders, "content-type");\n' +
            '                if (header)\n' +
            '                    responseHeaders[header] = ["text/css"];\n' +
            '            }',
        replace:
            '            if (resourceType === "stylesheet") {\n' +
            '                const header = findHeader(responseHeaders, "content-type");\n' +
            '                if (header)\n' +
            '                    responseHeaders[header] = ["text/css"];\n' +
            '            }\n\n' +
            '            // Discordmaxxer: bypass Opaque Response Blocking for media+image\n' +
            '            // so user-set banner/avatar URLs from any CDN load without\n' +
            '            // net::ERR_BLOCKED_BY_ORB. See VideoBackground / DMProfileFlair.\n' +
            '            if (resourceType === "media" || resourceType === "image") {\n' +
            '                const corpKey = findHeader(responseHeaders, "cross-origin-resource-policy");\n' +
            '                if (corpKey) delete responseHeaders[corpKey];\n' +
            '                responseHeaders["cross-origin-resource-policy"] = ["cross-origin"];\n' +
            '            }'
    },
    // Update notification strings — belt-and-suspenders alongside the
    // --disable-updater build flag (which already skips the path that posts
    // these). If any future Vencord change reintroduces a notify() call we
    // haven't anticipated, the string is at least correctly branded.
    {
        file: "src/Vencord.ts",
        find: 'title: "Vencord has been updated!",',
        replace: 'title: "Discordmaxxer has been updated!",'
    },
    {
        file: "src/Vencord.ts",
        find: 'title: "A Vencord update is available!",',
        replace: 'title: "A Discordmaxxer update is available!",'
    },
    // No-op the donor-badge loader. With DonorBadges always empty,
    // getDonorBadges(userId) returns undefined for every user — neither the
    // donor badge nor its "Please consider supporting Vencord" modal ever
    // render. Also stops the 30-min poll to badges.vencord.dev.
    {
        file: "src/plugins/_api/badges/index.tsx",
        find:
            'async function loadBadges(noCache = false) {\n' +
            '    const init = {} as RequestInit;\n' +
            '    if (noCache)\n' +
            '        init.cache = "no-cache";\n\n' +
            '    DonorBadges = await fetch("https://badges.vencord.dev/badges.json", init)\n' +
            '        .then(r => r.json());\n' +
            '}',
        replace:
            'async function loadBadges(_noCache = false) {\n' +
            '    // Discordmaxxer: never surface Vencord donor badges (or their\n' +
            '    // "support the project" modal). Empty map keeps the upstream\n' +
            '    // getDonorBadges() flow intact but harmless.\n' +
            '    DonorBadges = {};\n' +
            '}'
    }
];

let patched = 0;
let skipped = 0;
const warnings = [];

for (const p of PATCHES) {
    const path = join(VENCORD_SRC, p.file);
    if (!existsSync(path)) {
        warnings.push(`File not found: ${p.file}`);
        continue;
    }
    let content = readFileSync(path, "utf-8");

    if (p.marker && content.includes(p.marker)) {
        skipped++;
        continue;
    }

    if (content.includes(p.replace) && !content.includes(p.find)) {
        skipped++;
        continue;
    }

    if (!content.includes(p.find)) {
        warnings.push(`Patch target not found in ${p.file}: "${p.find.slice(0, 60)}..."`);
        continue;
    }

    content = content.split(p.find).join(p.replace);
    writeFileSync(path, content);
    patched++;
    console.log(`[rebrand] ✓ ${p.file}: "${p.find.slice(0, 50)}..." → "${p.replace.slice(0, 50)}..."`);
}

console.log(`\n[rebrand] applied=${patched} skipped(idempotent)=${skipped} warnings=${warnings.length}`);
for (const w of warnings) console.warn(`[rebrand] ⚠ ${w}`);

// HARD GATE (audit 2026-06-26): a rebrand warning means a patch find-string no
// longer matches the current Vencord — i.e. a brand surface ("Vencord" labels,
// the donate card, etc.) silently un-rebranded, OR a plugin patch went stale.
// Locally we only WARN (so iteration isn't blocked), but in the release pipeline
// we FAIL the build so a silently-broken bundle can never publish. release.yml
// sets DM_STRICT_REBRAND=1 for exactly this. The auto-rebump path already gates
// on warnings; this closes the same hole on the primary tag-push release.
if (warnings.length > 0 && process.env.DM_STRICT_REBRAND === "1") {
    console.error(
        `\n[rebrand] ✗ STRICT MODE: ${warnings.length} warning(s) — refusing to build a release with stale ` +
            `rebrand patches. Fix the find-strings against the current Vencord (see TROUBLESHOOTING.md), then retry.`
    );
    process.exit(1);
}
