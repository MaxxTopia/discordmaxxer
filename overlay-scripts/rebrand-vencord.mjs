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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENCORD_SRC = resolve(process.env.DISCORDMAXXER_VENCORD_SRC ?? join(__dirname, "..", "vencord-src"));
const VENCORD_SOURCE_PIN = JSON.parse(readFileSync(join(__dirname, "vencord-source.json"), "utf8"));
// BetterFolders owns Discord's folder expansion and route state.  Keep that
// contract on the pinned upstream implementation; the previous local bridge
// attempted to predict store transitions and could blank the folder popout or
// crash navigation when Discord replaced its stores during a DM switch.
const USE_STABLE_BETTER_FOLDERS = process.env.DM_STABLE_BETTER_FOLDERS !== "0";

function readVencordSourceCommit() {
    // Some local/dev checkouts contain the pinned source plus a provenance
    // marker, but not a nested .git directory. In that layout `git -C` walks
    // up into the Discordmaxxer repository and can report the wrong commit.
    // Prefer the source marker when the source itself is not a git checkout;
    // real pinned checkouts still use git as the authoritative source.
    const sourceGitPath = join(VENCORD_SRC, ".git");
    const markerPath = join(VENCORD_SRC, ".discordmaxxer-source.json");
    if (!existsSync(sourceGitPath) && existsSync(markerPath)) {
        try {
            return JSON.parse(readFileSync(markerPath, "utf8")).commit ?? null;
        } catch {
            return null;
        }
    }

    try {
        return execFileSync("git", ["-C", VENCORD_SRC, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
        if (!existsSync(markerPath)) return null;
        try {
            return JSON.parse(readFileSync(markerPath, "utf8")).commit ?? null;
        } catch {
            return null;
        }
    }
}

const actualVencordCommit = readVencordSourceCommit();
if (actualVencordCommit !== VENCORD_SOURCE_PIN.commit) {
    throw new Error(
        `[rebrand] Vencord source mismatch at ${VENCORD_SRC}. ` +
            `Expected ${VENCORD_SOURCE_PIN.commit}, found ${actualVencordCommit ?? "missing/unpinned source"}. ` +
            "Use the pinned Vencord checkout for both Dev and release builds."
    );
}

const PATCHES = [
    // ── SpotifyControls: fail closed while Discord's Spotify modules load ──
    // Discord can mount the account panel before the Spotify webpack exports
    // exist. The upstream store performed the lookup eagerly and then called
    // through an unavailable proxy, which made the ErrorBoundary show
    // "Failed to render Spotify Modal". Keep the player mounted and make
    // controls no-op until Discord exposes a usable socket/API pair.
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify module lookup is fail-closed.",
        find:
            '    const SpotifySocket = findByProps("getActiveSocketAndDevice");\n' +
            '    const SpotifyAPI = findByPropsLazy("vcSpotifyMarker");',
        replace:
            '    // Discord can expose Flux before the Spotify webpack modules are ready.\n' +
            '    // Do not resolve either module while the store is constructed: a lazy\n' +
            '    // webpack proxy can still throw later when a property is read.\n' +
            '    // Resolve them only inside a guarded request.\n' +
            '    const getSpotifySocket = () => {\n' +
            '        try { return findByProps("getActiveSocketAndDevice"); }\n' +
            '        catch (error) {\n' +
            '            console.warn("[Discordmaxxer] Spotify socket lookup unavailable", error);\n' +
            '            return null;\n' +
            '        }\n' +
            '    };\n' +
            '    const getSpotifyAPI = () => {\n' +
            '        try { return findByPropsLazy("vcSpotifyMarker"); }\n' +
            '        catch (error) {\n' +
            '            console.warn("[Discordmaxxer] Spotify API lookup unavailable", error);\n' +
            '            return null;\n' +
            '        }\n' +
            '    };'
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify requests are fail-closed.",
        find:
            '            const { socket } = SpotifySocket.getActiveSocketAndDevice();\n' +
            '            return SpotifyAPI[method](socket.accountId, socket.accessToken, {\n' +
            '                url: API_BASE + route,\n' +
            '                ...data\n' +
            '            });',
        replace:
            '            try {\n' +
            '                const spotifySocket = getSpotifySocket();\n' +
            '                const spotifyAPI = getSpotifyAPI();\n' +
            '                const active = spotifySocket?.getActiveSocketAndDevice?.();\n' +
            '                const socket = active?.socket;\n' +
            '                const request = spotifyAPI?.[method];\n' +
            '                if (!socket?.accountId || !socket?.accessToken || typeof request !== "function") {\n' +
            '                    console.warn("[Discordmaxxer] Spotify connection is not ready");\n' +
            '                    return Promise.resolve();\n' +
            '                }\n' +
            '                return request.call(spotifyAPI, socket.accountId, socket.accessToken, {\n' +
            '                    url: API_BASE + route,\n' +
            '                    ...data\n' +
            '                });\n' +
            '            } catch (error) {\n' +
            '                console.warn("[Discordmaxxer] Spotify request skipped", error);\n' +
            '                return Promise.resolve();\n' +
            '            }'
    },
    // ── SpotifyControls: normalize partial player state before render ──
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify track normalization v2.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: Spotify track normalization v2."),
        find: "    const store = new SpotifyStore(FluxDispatcher, {",
        replace:
            "    // Discordmaxxer: Spotify track normalization v2.\n" +
            "    // Discord can dispatch a partial player payload while Spotify is\n" +
            "    // reconnecting. Normalize optional fields into a render-safe Track\n" +
            "    // instead of making React fall into the plugin ErrorBoundary.\n" +
            "    const normalizeTrack = (candidate: unknown): Track | null => {\n" +
            "        if (!candidate || typeof candidate !== \"object\") return null;\n" +
            "        const track = candidate as any;\n" +
            "        const id = typeof track.id === \"string\" ? track.id : typeof track.uri === \"string\" ? track.uri : \"\";\n" +
            "        if (!id) return null;\n" +
            "        const albumSource = track.album && typeof track.album === \"object\" ? track.album : {};\n" +
            "        const imageSource = albumSource.image && typeof albumSource.image === \"object\" ? albumSource.image : {};\n" +
            "        const artistsSource = Array.isArray(track.artists) ? track.artists : [];\n" +
            "        const artists = artistsSource.filter((artist: any) => artist && typeof artist.name === \"string\").map((artist: any) => ({\n" +
            "            ...artist,\n" +
            "            id: typeof artist.id === \"string\" ? artist.id : \"\",\n" +
            "            href: typeof artist.href === \"string\" ? artist.href : \"\",\n" +
            "            type: typeof artist.type === \"string\" ? artist.type : \"artist\"\n" +
            "        }));\n" +
            "        if (artists.length === 0) artists.push({ id: \"\", href: \"\", name: \"Unknown artist\", type: \"artist\" });\n" +
            "        return {\n" +
            "            ...track,\n" +
            "            id,\n" +
            "            name: typeof track.name === \"string\" && track.name.trim() ? track.name : \"Unknown track\",\n" +
            "            duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,\n" +
            "            album: {\n" +
            "                ...albumSource,\n" +
            "                id: typeof albumSource.id === \"string\" ? albumSource.id : \"\",\n" +
            "                name: typeof albumSource.name === \"string\" ? albumSource.name : \"Unknown album\",\n" +
            "                image: {\n" +
            "                    ...imageSource,\n" +
            "                    height: Number.isFinite(imageSource.height) ? imageSource.height : 0,\n" +
            "                    width: Number.isFinite(imageSource.width) ? imageSource.width : 0,\n" +
            "                    url: typeof imageSource.url === \"string\" ? imageSource.url : \"\"\n" +
            "                }\n" +
            "            },\n" +
            "            artists\n" +
            "        } as Track;\n" +
            "    };\n" +
            "\n" +
            "    const normalizeRepeat = (value: unknown): Repeat =>\n" +
            "        value === \"track\" || value === \"context\" ? value : \"off\";\n" +
            "\n" +
            "    const store = new SpotifyStore(FluxDispatcher, {"
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify track dispatch normalization.",
        find: "            store.track = e.track;",
        replace: "            store.track = normalizeTrack(e.track);"
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify player state normalization.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: Spotify player state normalization.") ||
            content.includes("const rawDevice = e.device && typeof e.device === \"object\" ? e.device as any : null;"),
        find:
            "            store.device = e.device ?? null;\n" +
            "            store.isPlaying = e.isPlaying ?? false;\n" +
            "            store.volume = e.volumePercent ?? 0;\n" +
            "            store.repeat = e.actual_repeat || \"off\";\n" +
            "            store.shuffle = e.shuffle ?? false;\n" +
            "            store.position = e.position ?? 0;",
        replace:
            "            // Discordmaxxer: Spotify player state normalization.\n" +
            "            const rawDevice = e.device && typeof e.device === \"object\" ? e.device as any : null;\n" +
            "            store.device = typeof rawDevice?.id === \"string\"\n" +
            "                ? { ...rawDevice, is_active: rawDevice.is_active !== false }\n" +
            "                : null;\n" +
            "            store.isPlaying = e.isPlaying === true;\n" +
            "            store.volume = Number.isFinite(e.volumePercent) ? Math.max(0, Math.min(100, e.volumePercent)) : 0;\n" +
            "            store.repeat = normalizeRepeat(e.actual_repeat);\n" +
            "            store.shuffle = e.shuffle === true;\n" +
            "            store.position = Number.isFinite(e.position) ? Math.max(0, e.position) : 0;"
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify active-device normalization.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: Spotify active-device normalization.") ||
            content.includes("const availableDevices = Array.isArray(devices)"),
        find: "            store.device = devices.find(d => d.is_active) ?? devices[0] ?? null;",
        replace:
            "            // Discordmaxxer: Spotify active-device normalization.\n" +
            "            const availableDevices = Array.isArray(devices) ? devices : [];\n" +
            "            const activeDevice = availableDevices.find(d => d?.is_active) ?? availableDevices[0] ?? null;\n" +
            "            store.device = activeDevice && typeof activeDevice.id === \"string\"\n" +
            "                ? { ...activeDevice, is_active: activeDevice.is_active !== false }\n" +
            "                : null;"
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify repeat dispatch normalization.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: Spotify repeat dispatch normalization.") ||
            content.includes("store.repeat = normalizeRepeat(e.actual_repeat);"),
        find: '            store.repeat = e.actual_repeat || "off";',
        replace: "            store.repeat = normalizeRepeat(e.actual_repeat);"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify repeat render normalization.",
        find:
            "    const [nextRepeat, repeatClassName] = (() => {\n" +
            "        switch (repeat) {\n" +
            '            case "off": return ["context", "repeat-off"] as const;\n' +
            '            case "context": return ["track", "repeat-context"] as const;\n' +
            '            case "track": return ["off", "repeat-track"] as const;\n' +
            "            default: throw new Error(`Invalid repeat state ${repeat}`);\n" +
            "        }\n" +
            "    })();",
        replace:
            "    // Discord may briefly send a boolean or an unknown repeat value\n" +
            "    // during reconnect. Treat it as off instead of crashing the panel.\n" +
            "    const safeRepeat = repeat === \"context\" || repeat === \"track\" ? repeat : \"off\";\n" +
            "    const [nextRepeat, repeatClassName] = (() => {\n" +
            "        switch (safeRepeat) {\n" +
            '            case "off": return ["context", "repeat-off"] as const;\n' +
            '            case "context": return ["track", "repeat-context"] as const;\n' +
            '            case "track": return ["off", "repeat-track"] as const;\n' +
            '            default: return ["context", "repeat-off"] as const;\n' +
            "        }\n" +
            "    })();"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify seek duration guard.",
        find:
            "function SpotifySeekBar() {\n" +
            "    const { duration } = SpotifyStore.track!;",
        replace:
            "function SpotifySeekBar() {\n" +
            "    // A reconnect can publish a track before its duration arrives.\n" +
            "    // Keep hooks stable and give SeekBar a safe non-zero range.\n" +
            "    const rawDuration = SpotifyStore.track?.duration;\n" +
            "    const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration ?? 0) : 0;\n" +
            "    const seekMax = Math.max(duration, 1);"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify seek range guard.",
        find: "                maxValue={duration}",
        replace: "                maxValue={seekMax}"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify seek position normalization.",
        find:
            "    const [storePosition, isSettingPosition, isPlaying] = useStateFromStores(\n" +
            "        [SpotifyStore],\n" +
            "        () => [SpotifyStore.mPosition, SpotifyStore.isSettingPosition, SpotifyStore.isPlaying]\n" +
            "    );\n\n" +
            "    const [position, setPosition] = useState(storePosition);\n\n" +
            "    useEffect(() => {\n" +
            "        if (isPlaying && !isSettingPosition) {\n" +
            "            setPosition(SpotifyStore.position);\n" +
            "            const interval = setInterval(() => {\n" +
            "                setPosition(p => p + 1000);\n" +
            "            }, 1000);\n\n" +
            "            return () => clearInterval(interval);\n" +
            "        }\n" +
            "    }, [storePosition, isSettingPosition, isPlaying]);\n\n" +
            "    const onChange = (v: number) => {\n" +
            "        if (isSettingPosition) return;\n" +
            "        setPosition(v);\n" +
            "        seek(v);\n" +
            "    };",
        replace:
            "    const safePosition = (value: unknown) => Number.isFinite(value)\n" +
            "        ? Math.max(0, Math.min(Number(value), seekMax))\n" +
            "        : 0;\n\n" +
            "    const [storePosition, isSettingPosition, isPlaying] = useStateFromStores(\n" +
            "        [SpotifyStore],\n" +
            "        () => [safePosition(SpotifyStore.mPosition), SpotifyStore.isSettingPosition, SpotifyStore.isPlaying]\n" +
            "    );\n\n" +
            "    const [position, setPosition] = useState(safePosition(storePosition));\n\n" +
            "    useEffect(() => {\n" +
            "        if (isPlaying && !isSettingPosition) {\n" +
            "            setPosition(safePosition(SpotifyStore.position));\n" +
            "            const interval = setInterval(() => {\n" +
            "                setPosition(p => safePosition(p + 1000));\n" +
            "            }, 1000);\n\n" +
            "            return () => clearInterval(interval);\n" +
            "        }\n" +
            "    }, [storePosition, isSettingPosition, isPlaying, seekMax]);\n\n" +
            "    const onChange = (v: number) => {\n" +
            "        if (isSettingPosition) return;\n" +
            "        const nextPosition = safePosition(v);\n" +
            "        setPosition(nextPosition);\n" +
            "        seek(nextPosition);\n" +
            "    };"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify player surface marker.",
        find: '        <div id={cl("player")} style={exportTrackImageStyle}>',
        replace: '        <div id={cl("player")} data-dm-spotify-surface="true" style={exportTrackImageStyle}>'
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify artists and album guard.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: Spotify artists and album guard."),
        find:
            "                {track.artists.some(a => a.name) && (\n" +
            "                    <Paragraph className={cl([\"ellipoverflow\", \"secondary-song-info\"])}>\n" +
            "                        <span className={cl(\"song-info-prefix\")}>by&nbsp;</span>\n" +
            "                        {track.artists.map((a, i) => (\n" +
            "                            <React.Fragment key={a.name}>",
        replace:
            "                {/* Discordmaxxer: Spotify artists and album guard. */}\n" +
            "                {(Array.isArray(track?.artists) ? track.artists : []).some(a => a?.name) && (\n" +
            "                    <Paragraph className={cl([\"ellipoverflow\", \"secondary-song-info\"])}>\n" +
            "                        <span className={cl(\"song-info-prefix\")}>by&nbsp;</span>\n" +
            "                        {(Array.isArray(track?.artists) ? track.artists : []).filter(a => a && typeof a.name === \"string\").map((a, i, arr) => (\n" +
            "                            <React.Fragment key={a.id || a.name || i}>"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify artists length guard.",
        alreadyAppliedWhen: content => content.includes("arr.length - 1"),
        find:
            "                                {i !== track.artists.length - 1 && <span className={cl(\"comma\")}>{\", \"}</span>}",
        replace:
            "                                {i !== arr.length - 1 && <span className={cl(\"comma\")}>{\", \"}</span>}"
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "Discordmaxxer: Spotify album name guard.",
        alreadyAppliedWhen: content => content.includes("Boolean(track?.album?.name)"),
        find:
            "                {track.album.name && (",
        replace:
            "                {Boolean(track?.album?.name) && ("
    },
    {
        file: "src/plugins/spotifyControls/SeekBar.ts",
        marker: "Discordmaxxer: Spotify SeekBar SliderClass guard.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: Spotify SeekBar SliderClass guard."),
        find:
            "export const SeekBar = LazyComponent(() => {\n" +
            "    const SliderClass = Slider.$$vencordGetWrappedComponent();",
        replace:
            "export const SeekBar = LazyComponent(() => {\n" +
            "    // Discordmaxxer: Spotify SeekBar SliderClass guard.\n" +
            "    const SliderClass = typeof (Slider as any)?.$$vencordGetWrappedComponent === \"function\"\n" +
            "        ? (Slider as any).$$vencordGetWrappedComponent()\n" +
            "        : null;\n" +
            "    if (!SliderClass || typeof SliderClass !== \"function\" || !SliderClass.prototype) {\n" +
            "        return () => null;\n" +
            "    }"
    },
    {
        file: "src/plugins/spotifyControls/index.tsx",
        marker: "Discordmaxxer: Spotify slot isolation wrapper",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: Spotify slot isolation wrapper"),
        find:
            "                <ErrorBoundary\n" +
            "                    fallback={() => (\n" +
            "                        <div className=\"vc-spotify-fallback\">\n" +
            "                            <p>Failed to render Spotify Modal :(</p>\n" +
            "                            <p >Check the console for errors</p>\n" +
            "                        </div>\n" +
            "                    )}\n" +
            "                >\n" +
            "                    <Player />\n" +
            "                </ErrorBoundary>\n\n                <VencordOriginal {...props} />",
        replace:
            "                <div data-dm-spotify-slot=\"true\" className=\"vc-spotify-slot\" style={{ display: \"contents\" }}>\n" +
            "                    {/* Discordmaxxer: Spotify slot isolation wrapper and guarded fallback. */}\n" +
            "                    <ErrorBoundary fallback={err => { console.warn(\"[Discordmaxxer] SpotifyControls render error:\", err); return null; }}>\n" +
            "                        <Player />\n" +
            "                    </ErrorBoundary>\n" +
            "                </div>\n\n                <VencordOriginal {...props} />"
    },

    // ── Startup compatibility: Discord's current Webpack export helper ──
    // Newer Discord bundles call n.d(exports, definition, directExports),
    // while Vencord's configurable-export shim historically accepted only
    // the two-argument form. Dropping directExports leaves exports such as
    // module 626584's `A` undefined and prevents Discord from mounting.
    {
        file: "src/webpack/patchWebpack.ts",
        find:
            "            this.d = function (exports, definition) {\n" +
            "                for (const key in definition) {\n" +
            "                    if (Object.hasOwn(definition, key) && !Object.hasOwn(exports, key)) {\n" +
            "                        Object.defineProperty(exports, key, {\n" +
            "                            enumerable: true,\n" +
            "                            configurable: true,\n" +
            "                            get: definition[key],\n" +
            "                        });\n" +
            "                    }\n" +
            "                }\n" +
            "            };",
        replace:
            "            this.d = function (exports, definition, directDefinition) {\n" +
            "                for (const key in definition) {\n" +
            "                    if (Object.hasOwn(definition, key) && !Object.hasOwn(exports, key)) {\n" +
            "                        Object.defineProperty(exports, key, {\n" +
            "                            enumerable: true,\n" +
            "                            configurable: true,\n" +
            "                            get: definition[key],\n" +
            "                        });\n" +
            "                    }\n" +
            "                }\n" +
            "\n" +
            "                // Discord now sometimes passes direct export values as\n" +
            "                // the third argument (for example { A: SomeClass }).\n" +
            "                // Preserve those values as live export getters too.\n" +
            "                if (directDefinition && typeof directDefinition === \"object\") {\n" +
            "                    for (const key in directDefinition) {\n" +
            "                        if (Object.hasOwn(directDefinition, key) && !Object.hasOwn(exports, key)) {\n" +
            "                            Object.defineProperty(exports, key, {\n" +
            "                                enumerable: true,\n" +
            "                                configurable: true,\n" +
            "                                get: () => directDefinition[key],\n" +
            "                            });\n" +
            "                        }\n" +
            "                    }\n" +
            "                }\n" +
            "            };"
    },
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

    // ── Q2. Plugins tab rendering performance ──
    // useSettings() without paths registers a global settings change listener that
    // re-renders all 250 cards on any setting write anywhere in the app. Scope to plugins.*
    // with a static paths array so identity is preserved across renders.
    {
        file: "src/components/settings/tabs/plugins/index.tsx",
        find: "function PluginSettings() {\n    const settings = useSettings();",
        replace: "const PLUGIN_SETTINGS_PATHS = [\"plugins.*\"] as any;\n\nfunction PluginSettings() {\n    const settings = useSettings(PLUGIN_SETTINGS_PATHS);"
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

    // ── R2. Theme loader parity ──
    // Desktop builds previously kept the vencord:// import path while web
    // builds loaded the same file through a Blob URL. Discordmaxxer can serve
    // local themes from a packaged/updated profile where that custom scheme is
    // unavailable, so use the native theme bytes for both paths and guard
    // against an older async load winning a newer toggle.
    {
        file: "src/api/Themes.ts",
        find: 'import { isNonNullish } from "@utils/guards";\n',
        replace: ''
    },
    {
        file: "src/api/Themes.ts",
          marker: "let themeInitGeneration = 0;",
        find: '// for cleanup\nlet previousThemeBlobObjectURLs = [] as string[];',
        replace: '// for cleanup\nlet previousThemeBlobObjectURLs = [] as string[];\nlet themeInitGeneration = 0;'
    },
    {
        file: "src/api/Themes.ts",
        find: '    if (IS_WEB) {\n        previousThemeBlobObjectURLs.forEach(url => URL.revokeObjectURL(url));\n\n        const objectUrls = await Promise.all(enabledThemes.map(async theme => {\n            const themeData = await VencordNative.themes.getThemeData(theme);\n            if (!themeData) return null;\n\n            const blob = new Blob([themeData], { type: "text/css" });\n            return URL.createObjectURL(blob);\n        }));\n\n        previousThemeBlobObjectURLs = objectUrls.filter(isNonNullish);\n        links.push(...previousThemeBlobObjectURLs);\n    } else {\n        const localThemes = enabledThemes.map(theme => `vencord:///themes/${theme}?v=${Date.now()}`);\n        links.push(...localThemes);\n    }',
        replace: '    const generation = ++themeInitGeneration;\n    const nextObjectUrls: string[] = [];\n    for (const theme of enabledThemes) {\n        try {\n            const themeData = await VencordNative.themes.getThemeData(theme);\n            if (!themeData) continue;\n            const blob = new Blob([themeData], { type: "text/css" });\n            nextObjectUrls.push(URL.createObjectURL(blob));\n        } catch (error) {\n            console.warn("[Discordmaxxer] theme load failed:", theme, error);\n        }\n    }\n    if (generation !== themeInitGeneration) {\n        nextObjectUrls.forEach(url => URL.revokeObjectURL(url));\n        return;\n    }\n    previousThemeBlobObjectURLs.forEach(url => URL.revokeObjectURL(url));\n    previousThemeBlobObjectURLs = nextObjectUrls;\n    links.push(...nextObjectUrls);'
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
    // Plugin settings are user-extensible and can contain malformed or
    // version-sensitive definitions. The existing per-control boundaries are
    // too late for failures in the modal's own hooks, metadata lookup, or
    // settings enumeration. Keep one bad plugin from reaching Discord's
    // renderer-wide crash handler.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: isolate plugin settings modal failures.",
        find:
            '    openModal(modalProps => (\n' +
            '        <PluginModal\n' +
            '            {...modalProps}\n' +
            '            plugin={plugin}\n' +
            '            onRestartNeeded={(key: string) => onRestartNeeded?.(plugin.name, key)}\n' +
            '        />\n' +
            '    ));',
        replace:
            '    openModal(modalProps => (\n' +
            '        <ErrorBoundary message="Could not render this plugin\'s settings. Discordmaxxer kept the rest of Discord running.">\n' +
            '            {/* Discordmaxxer: isolate plugin settings modal failures. */}\n' +
            '            <PluginModal\n' +
            '                {...modalProps}\n' +
            '                plugin={plugin}\n' +
            '                onRestartNeeded={(key: string) => onRestartNeeded?.(plugin.name, key)}\n' +
            '            />\n' +
            '        </ErrorBoundary>\n' +
            '    ));'
    },
    // Older/custom plugin metadata must not make the modal fail before the
    // plugin's controls render. Treat an unknown plugin as a user plugin.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: "    const pluginMeta = PluginMeta[plugin.name];",
        replace:
            "    const pluginMeta = PluginMeta[plugin.name] ?? {\n" +
            "        folderName: plugin.name,\n" +
            "        userPlugin: true,\n" +
            "    };"
    },
    // Older/custom plugin manifests can omit authors entirely. The native
    // modal reads that field in several places before the plugin settings
    // component mounts, so normalize it at the boundary instead of letting
    // one malformed manifest crash the settings renderer.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: normalize plugin author metadata.",
        find: "interface PluginModalProps extends RenderModalProps {",
        replace:
            "const EMPTY_PLUGIN_AUTHORS: Plugin[\"authors\"] = [];\n\n" +
            "// Discordmaxxer: normalize plugin author metadata.\n" +
            "interface PluginModalProps extends RenderModalProps {"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: use normalized plugin authors.",
        find: "export default function PluginModal({ plugin, onRestartNeeded, onClose, transitionState }: PluginModalProps) {\n    const pluginSettings = useSettings([`plugins.${plugin.name}.*`]).plugins[plugin.name];",
        replace:
            "export default function PluginModal({ plugin, onRestartNeeded, onClose, transitionState }: PluginModalProps) {\n" +
            "    // Discordmaxxer: use normalized plugin authors.\n" +
            "    const pluginAuthors = Array.isArray(plugin.authors)\n" +
            "        ? plugin.authors.filter(author => author && typeof author === \"object\" && typeof author.name === \"string\")\n" +
            "        : EMPTY_PLUGIN_AUTHORS;\n" +
            "    const settingsState = useSettings([`plugins.${plugin.name}.*`]);\n" +
            "    const pluginSettings = settingsState?.plugins?.[plugin.name] ?? {};"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: memoize normalized plugin authors.",
        find:
            "    const pluginAuthors = Array.isArray(plugin.authors)\n" +
            "        ? plugin.authors.filter(author => author && typeof author === \"object\" && typeof author.name === \"string\")\n" +
            "        : EMPTY_PLUGIN_AUTHORS;",
        replace:
            "    // Discordmaxxer: memoize normalized plugin authors so the author-loading effect does not restart on every render.\n" +
            "    const pluginAuthors = useMemo(() => (\n" +
            "        Array.isArray(plugin.authors)\n" +
            "            ? plugin.authors.filter(author => author && typeof author === \"object\" && typeof author.name === \"string\")\n" +
            "            : EMPTY_PLUGIN_AUTHORS\n" +
            "    ), [plugin.authors]);"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        // This intermediate renderer is still needed on a pristine source
        // checkout so the later compact-author patch can match it. On a
        // second build, the final compact-author marker proves that this
        // transitional shape was already consumed; do not report it as a
        // stale upstream patch target.
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        marker: "Discordmaxxer: render only valid plugin author overflow.",
        find:
            "    function renderMoreUsers(_label: string, count: number) {\n" +
            "        const sliceCount = plugin.authors.length - count;\n" +
            "        const sliceStart = plugin.authors.length - sliceCount;\n" +
            "        const sliceEnd = sliceStart + plugin.authors.length - count;\n\n" +
            "        return (\n" +
            "            <Tooltip text={plugin.authors.slice(sliceStart, sliceEnd).map(u => u.name).join(\", \")}",
        replace:
            "    function renderMoreUsers(_label: string, count: number) {\n" +
            "        // Discordmaxxer: render only valid plugin author overflow.\n" +
            "        const sliceCount = Math.max(pluginAuthors.length - count, 0);\n" +
            "        if (!sliceCount) return null;\n" +
            "\n" +
            "        const sliceStart = pluginAuthors.length - sliceCount;\n" +
            "        const sliceEnd = sliceStart + sliceCount;\n\n" +
            "        return (\n" +
            "            <Tooltip text={pluginAuthors.slice(sliceStart, sliceEnd).map(u => u.name).join(\", \")}"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        marker: "Discordmaxxer: read normalized plugin authors.",
        find: "            for (const user of plugin.authors.slice(0, 6)) {",
        replace: "            for (const user of pluginAuthors.slice(0, 6)) {"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        marker: "Discordmaxxer: subscribe to normalized plugin authors.",
        find: "    }, [plugin.authors]);",
        replace: "    }, [pluginAuthors]);"
    },
    // Discord's UserSummaryItem changed its internal virtualized-list contract
    // across the pinned web builds. Its modal path can receive an undefined
    // sections array and throw before the plugin settings have mounted. Keep
    // the contributor avatars, but render them with stable primitives that do
    // not depend on that private list implementation.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        marker: "Discordmaxxer: render plugin authors without native summary list.",
        find:
            "                            <UserSummaryItem\n" +
            "                                users={authors.length ? authors : fallbackAuthors}\n" +
            "                                guildId={undefined}\n" +
            "                                renderIcon={false}\n" +
            "                                max={6}\n" +
            "                                showDefaultAvatarsForNullUsers\n" +
            "                                renderMoreUsers={renderMoreUsers}\n" +
            "                                renderUser={(user: User) => (\n" +
            "                                    <Clickable\n" +
            "                                        className={AvatarStyles.clickableAvatar}\n" +
            "                                        onClick={() => openContributorModal(user)}\n" +
            "                                    >\n" +
            "                                        <img\n" +
            "                                            className={AvatarStyles.avatar}\n" +
            "                                            src={user.getAvatarURL(void 0, 80, true)}\n" +
            "                                            alt={user.username}\n" +
            "                                            title={user.username}\n" +
            "                                        />\n" +
            "                                    </Clickable>\n" +
            "                                )}\n" +
            "                            />",
        replace:
            "                            <div style={{ display: \"flex\", alignItems: \"center\", gap: 4 }}>\n" +
            "                                {(authors.length ? authors : fallbackAuthors).slice(0, 6).map((user, index) => {\n" +
            "                                    const avatarUrl = typeof user.getAvatarURL === \"function\"\n" +
            "                                        ? user.getAvatarURL(void 0, 80, true)\n" +
            "                                        : undefined;\n" +
            "                                    const username = user.username ?? \"Contributor\";\n" +
            "                                    return (\n" +
            "                                        <Clickable\n" +
            "                                            key={String(user.id ?? username ?? index)}\n" +
            "                                            className={AvatarStyles.clickableAvatar}\n" +
            "                                            onClick={() => openContributorModal(user as User)}\n" +
            "                                        >\n" +
            "                                            {avatarUrl ? (\n" +
            "                                                <img\n" +
            "                                                    className={AvatarStyles.avatar}\n" +
            "                                                    src={avatarUrl}\n" +
            "                                                    alt={username}\n" +
            "                                                    title={username}\n" +
            "                                                />\n" +
            "                                            ) : (\n" +
            "                                                <div\n" +
            "                                                    className={AvatarStyles.avatar}\n" +
            "                                                    aria-label={username}\n" +
            "                                                    title={username}\n" +
            "                                                    style={{ display: \"grid\", placeItems: \"center\", background: \"var(--background-secondary)\" }}\n" +
            "                                                >\n" +
            "                                                    ?\n" +
            "                                                </div>\n" +
            "                                            )}\n" +
            "                                        </Clickable>\n" +
            "                                    );\n" +
            "                                })}\n" +
            "                                {pluginAuthors.length > 6 && renderMoreUsers(\"\", 6)}\n" +
            "                            </div>"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        marker: "Discordmaxxer: use legacy plugin settings imports.",
        find: "Forms, Modal, openModal, React, Text, Tooltip, useEffect, useMemo, UserStore, UserSummaryItem, UserUtils, useState",
        replace: "Forms, Modal, openModal, React, Text, Tooltip, useEffect, useMemo, UserStore, UserUtils, useState"
    },
    // The current Discord modal implementation internally mounts a native
    // MasonryList. Its private `sections` contract changed in the web build
    // used by Discordmaxxer v0.7.119, so the plugin settings modal can throw
    // before any plugin-specific setting renders. Keep the plugin modal on
    // Vencord's stable legacy shell; this is the same contract used by the
    // known-good upstream implementation before the migration.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: use legacy plugin settings modal contract.",
        find: 'import { BaseText } from "@components/BaseText";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: compact static plugin authors."),
        find: 'import { RenderModalProps, User } from "@vencord/discord-types";',
        replace: 'import { User } from "@vencord/discord-types";'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: use legacy plugin settings imports.",
        find: 'import { Clickable, FluxDispatcher, Forms, Modal, openModal, React, Text, Tooltip, useEffect, useMemo, UserStore, UserUtils, useState } from "@webpack/common";',
        replace:
            '// Discordmaxxer: use legacy plugin settings imports.\n' +
            'import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";\n' +
            'import { Clickable, FluxDispatcher, Forms, React, Text, Tooltip, useEffect, useMemo, UserStore, UserUtils, useState } from "@webpack/common";'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: "interface PluginModalProps extends RenderModalProps {",
        replace: "interface PluginModalProps extends ModalProps {"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        alreadyAppliedWhen: content => content.includes("<ModalRoot transitionState={transitionState}"),
        find:
            '        <Modal\n' +
            '            transitionState={transitionState}\n' +
            '            onClose={onClose}\n' +
            '            size="lg"\n' +
            '            title={\n' +
            '                <div className={cl("header")}>\n' +
            '                    <BaseText tag="h1" weight="semibold" size="lg">{plugin.name}</BaseText>\n' +
            '                    {!pluginMeta.userPlugin && (\n' +
            '                        <div className="vc-settings-modal-links">\n' +
            '                            <FavoriteButton\n' +
            '                                isFavorite={pluginSettings.isFavorite ?? false}\n' +
            '                                onClick={() => pluginSettings.isFavorite = !pluginSettings.isFavorite}\n' +
            '                            />\n' +
            '                            <WebsiteButton\n' +
            '                                text="View more info"\n' +
            '                                href={`https://github.com/MaxxTopia/discordmaxxer/blob/main/vencord-src/src/plugins/${plugin.name}`}\n' +
            '                            />\n' +
            '                            <GithubButton\n' +
            '                                text="View source code"\n' +
            '                                href={`https://github.com/${gitRemote}/tree/main/src/plugins/${pluginMeta.folderName}`}\n' +
            '                            />\n' +
            '                        </div>\n' +
            '                    )}\n' +
            '                </div>\n' +
            '            }\n' +
            '            subtitle={\n' +
            '                <div className={cl("info")}>\n' +
            '                    <div>\n' +
            '                        <Forms.FormText>{plugin.description}</Forms.FormText>\n' +
            '                        {!!plugin.tags?.length && <PluginTags tags={plugin.tags} />}\n' +
            '                    </div>\n' +
            '                </div>\n' +
            '            }\n' +
            '        >',
        replace:
            '        <ModalRoot transitionState={transitionState} size={ModalSize.MEDIUM}>\n' +
            '            <ModalHeader separator={false} className={Margins.bottom8}>\n' +
            '                <div className={cl("header")}>\n' +
            '                    <div className={cl("heading")}>\n' +
            '                        <Text variant="heading-xl/bold" style={{ flexGrow: 1 }}>{plugin.name}</Text>\n' +
            '                        {!pluginMeta.userPlugin && (\n' +
            '                            <div className="vc-settings-modal-links">\n' +
            '                                <FavoriteButton\n' +
            '                                    isFavorite={pluginSettings.isFavorite ?? false}\n' +
            '                                    onClick={() => pluginSettings.isFavorite = !pluginSettings.isFavorite}\n' +
            '                                />\n' +
            '                                <WebsiteButton\n' +
            '                                    text="View more info"\n' +
            '                                    href={`https://github.com/MaxxTopia/discordmaxxer/blob/main/vencord-src/src/plugins/${plugin.name}`}\n' +
            '                                />\n' +
            '                                <GithubButton\n' +
            '                                    text="View source code"\n' +
            '                                    href={`https://github.com/${gitRemote}/tree/main/src/plugins/${pluginMeta.folderName}`}\n' +
            '                                />\n' +
            '                            </div>\n' +
            '                        )}\n' +
            '                    </div>\n' +
            '                </div>\n' +
            '                <ModalCloseButton onClick={onClose} />\n' +
            '            </ModalHeader>\n' +
            '            <ModalContent>\n' +
            '                <div className={cl("info")}>\n' +
            '                    <div>\n' +
            '                        <Forms.FormText>{plugin.description}</Forms.FormText>\n' +
            '                        {!!plugin.tags?.length && <PluginTags tags={plugin.tags} />}\n' +
            '                    </div>\n' +
            '                </div>'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: "        </Modal>\n    );",
        replace: "            </ModalContent>\n        </ModalRoot>\n    );"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: validate plugin setting definitions.",
        find:
            "        const { settings } = plugin;\n" +
            "        if (!hasSettings || !settings)\n" +
            "            return <Forms.FormText>There are no settings for this plugin.</Forms.FormText>;\n\n" +
            "        const options = Object.entries(settings.def).map(([key, setting]) => {",
        replace:
            "        const { settings } = plugin;\n" +
            "        const definitions = settings?.def;\n" +
            "        if (!hasSettings || !settings || !definitions || typeof definitions !== \"object\")\n" +
            "            return <Forms.FormText>There are no settings for this plugin.</Forms.FormText>;\n\n" +
            "        const options = Object.entries(definitions).map(([key, setting]) => {"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: use validated plugin setting definitions.",
        find: "                const option = plugin.settings!.def[key];",
        replace:
            "                // Discordmaxxer: use validated plugin setting definitions.\n" +
            "                const option = definitions[key];"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: isolate malformed setting visibility checks.",
        find: "            if (isSettingHidden(settings, setting)) return null;",
        replace:
            "            try {\n" +
            "                // Discordmaxxer: isolate malformed setting visibility checks.\n" +
            "                if (isSettingHidden(settings, setting)) return null;\n" +
            "            } catch {\n" +
            "                return null;\n" +
            "            }"
    },
    {
        file: "src/api/PluginManager.ts",
        marker: "Discordmaxxer: guard malformed plugin setting definitions.",
        find:
            "export function hasAnyVisibleSettings({ settings }: Plugin) {\n" +
            "    return !!settings && Object.values(settings.def).some(s => !isSettingHidden(settings, s));\n" +
            "}",
        replace:
            "export function hasAnyVisibleSettings({ settings }: Plugin) {\n" +
            "    // Discordmaxxer: guard malformed plugin setting definitions.\n" +
            "    const definitions = settings?.def;\n" +
            "    if (!definitions || typeof definitions !== \"object\") return false;\n\n" +
            "    return Object.values(definitions).some(setting => {\n" +
            "        if (!setting || typeof setting !== \"object\") return false;\n" +
            "        try {\n" +
            "            return !isSettingHidden(settings, setting);\n" +
            "        } catch {\n" +
            "            return false;\n" +
            "        }\n" +
            "    });\n" +
            "}"
    },

    // A stale setting type should be skipped instead of React attempting to
    // render an undefined component and crashing the whole settings modal.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: "            const Component = OptionComponentMap[setting.type];\n            return (",
        replace:
            "            const Component = OptionComponentMap[setting.type];\n" +
            "            if (!Component) {\n" +
            "                console.warn(`[Discordmaxxer] Unsupported setting type in ${plugin.name}.${key}`);\n" +
            "                return null;\n" +
            "            }\n" +
            "            return ("
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: show diagnostic card when setting render fails.",
        find: "                <ErrorBoundary noop key={key}>",
        replace: '                <ErrorBoundary message={`An error occurred while rendering setting "${key}"`} key={key}>'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: add scroll clearance to modal content.",
        find: '            <div className={"vc-settings-modal-content"}>',
        replace: '            <div className={"vc-settings-modal-content"} style={{ paddingBottom: 48 }}>'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.css",
        marker: "Discordmaxxer: modal content bottom clearance.",
        alreadyAppliedWhen: content => content.includes(".vc-settings-modal-content"),
        find:
            ".vc-plugin-modal-tag {\n" +
            "    align-items: center;\n" +
            "    border: 1px solid var(--border-normal);\n" +
            "    border-radius: 9999px;\n" +
            "    display: flex;\n" +
            "    justify-content: center;\n" +
            "    padding: 6px 12px;\n" +
            "    color: var(--text-default);\n" +
            "}",
        replace:
            ".vc-plugin-modal-tag {\n" +
            "    align-items: center;\n" +
            "    border: 1px solid var(--border-normal);\n" +
            "    border-radius: 9999px;\n" +
            "    display: flex;\n" +
            "    justify-content: center;\n" +
            "    padding: 6px 12px;\n" +
            "    color: var(--text-default);\n" +
            "}\n\n" +
            ".vc-settings-modal-content {\n" +
            "    padding-bottom: 48px;\n" +
            "}"
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
    // ImageZoom: leave Discord's native image click and context-menu paths
    // authoritative. The previous overlay touched the image viewer and
    // menu renderer and could crash on ordinary message/image right-clicks.
    // ImageZoom's hover magnifier and settings remain upstream behavior.
    // The first replacement below is the durable form of the image-render
    // repair. It removes the wrapper that swallowed Discord's native image
    // node/menu target from a clean pinned Vencord checkout. The second form
    // recognizes the older local checkout that already contains the v2
    // replacement, so rebuilds remain idempotent while converging it to the
    // same native path.
    {
        file: "src/plugins/imageZoom/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: preserve native attachment image node.",
        obsoleteWhen: content => content.includes("Discordmaxxer: preserve native attachment image clicks v2"),
        find:
            "                {\n" +
            "                    match: /(?<=null!=(\\i)\\?.{0,20})\\i(?:\\.\\i)?,{children:\\1/, // TODO: (?:\\.\\i)? is stable compat\n" +
            "                    replace: \"'div',{onClick:e=>e.stopPropagation(),children:$1\"\n" +
            "                }\n",
        replace:
            "                // Discordmaxxer: preserve native attachment image node.\n"
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: preserve native attachment image node.",
        find:
            "                {\n" +
            "                    match: /(?<=null!=(\\i)\\?.{0,20})\\i(?:\\.\\i)?,{children:\\1/, // TODO: (?:\\.\\i)? is stable compat\n" +
            "                    replace: \"'div',{children:$1\"\n" +
            "                    // Discordmaxxer: preserve native attachment image clicks v2\n" +
            "                }\n",
        replace:
            "                // Discordmaxxer: preserve native attachment image node.\n"
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        alreadyAppliedWhen: content => content.includes("Keep Discord's native image context menu authoritative."),
        marker: "Discordmaxxer: keep native image context menus v3",
        find: '    contextMenus: {\n        "image-context": imageContextMenuPatch\n    },\n',
        replace:
            '    // Discordmaxxer: keep Discord native image/message context menus.\n' +
            '    // Zoom remains available through the hover magnifier/settings.\n'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: unmount magnifier only on modal image unmount",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: unmount magnifier only on modal image unmount") || content.includes("$self.unMountMagnifier(this)"),
        find:
            '                {\n' +
            '                    match: /componentWillUnmount\\(\\){/,\n' +
            '                    replace: "$&$self.unMountMagnifier();"\n' +
            '                },',
        replace:
            '                {\n' +
            '                    // Discordmaxxer: unmount magnifier only on modal image unmount\n' +
            '                    match: /componentWillUnmount\\(\\){/,\n' +
            '                    replace: "$&$self.unMountMagnifier(this);"\n' +
            '                },'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: only attach hover zoom handlers to the enlarged modal image",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: only attach hover zoom handlers to the enlarged modal image") || content.includes("if (instance?.props?.id !== ELEMENT_ID) return {};"),
        find:
            '    makeProps(instance) {\n' +
            '        return {\n' +
            '            onMouseOver: () => this.onMouseOver(instance),\n' +
            '            onMouseOut: () => this.onMouseOut(instance),\n' +
            '            onMouseDown: (e: React.MouseEvent) => this.onMouseDown(e, instance),\n' +
            '            onMouseUp: () => this.onMouseUp(instance),\n' +
            '            id: instance.props.id,\n' +
            '        };\n' +
            '    },',
        replace:
            '    makeProps(instance) {\n' +
            '        // Discordmaxxer: only attach hover zoom handlers to the enlarged modal image.\n' +
            '        // Leaving chat attachments untouched preserves native image click/open behavior.\n' +
            '        if (instance?.props?.id !== ELEMENT_ID) return {};\n' +
            '        return {\n' +
            '            onMouseOver: () => this.onMouseOver(instance),\n' +
            '            onMouseOut: () => this.onMouseOut(instance),\n' +
            '            onMouseDown: (e: React.MouseEvent) => this.onMouseDown(e, instance),\n' +
            '            onMouseUp: () => this.onMouseUp(instance),\n' +
            '            id: instance.props.id,\n' +
            '        };\n' +
            '    },'
    },
    {
        file: "src/plugins/imageZoom/index.tsx",
        marker: "Discordmaxxer: update existing magnifier root safely",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: update existing root safely without unmount/createRoot collisions"),
        find:
            '    renderMagnifier(instance) {\n' +
            '        try {\n' +
            '            if (instance.props.id === ELEMENT_ID) {\n' +
            '                if (!this.currentMagnifierElement) {\n' +
            '                    this.currentMagnifierElement = <Magnifier size={settings.store.size} zoom={settings.store.zoom} instance={instance} />;\n' +
            '                    this.root = createRoot(this.element!);\n' +
            '                    this.root.render(this.currentMagnifierElement);\n' +
            '                }\n' +
            '            }\n' +
            '        } catch (error) {\n' +
            '            new Logger("ImageZoom").error("Failed to render magnifier:", error);\n' +
            '        }\n' +
            '    },\n\n' +
            '    updateMagnifier(instance) {\n' +
            '        this.unMountMagnifier();\n' +
            '        this.renderMagnifier(instance);\n' +
            '    },\n\n' +
            '    unMountMagnifier() {\n' +
            '        this.root?.unmount();\n' +
            '        this.currentMagnifierElement = null;\n' +
            '        this.root = null;\n' +
            '    },',
        replace:
            '    renderMagnifier(instance) {\n' +
            '        try {\n' +
            '            // Discordmaxxer: safely guard container element and modal id.\n' +
            '            if (instance?.props?.id === ELEMENT_ID && this.element) {\n' +
            '                if (!this.currentMagnifierElement) {\n' +
            '                    this.currentMagnifierElement = <Magnifier size={settings.store.size} zoom={settings.store.zoom} instance={instance} />;\n' +
            '                    this.root = createRoot(this.element);\n' +
            '                    this.root.render(this.currentMagnifierElement);\n' +
            '                }\n' +
            '            }\n' +
            '        } catch (error) {\n' +
            '            new Logger("ImageZoom").error("Failed to render magnifier:", error);\n' +
            '        }\n' +
            '    },\n\n' +
            '    updateMagnifier(instance) {\n' +
            '        // Discordmaxxer: update existing root safely without unmount/createRoot collisions.\n' +
            '        if (instance?.props?.id !== ELEMENT_ID) return;\n' +
            '        if (this.root && this.currentMagnifierElement) {\n' +
            '            this.currentMagnifierElement = <Magnifier size={settings.store.size} zoom={settings.store.zoom} instance={instance} />;\n' +
            '            this.root.render(this.currentMagnifierElement);\n' +
            '        } else {\n' +
            '            this.renderMagnifier(instance);\n' +
            '        }\n' +
            '    },\n\n' +
            '    unMountMagnifier(instance?: any) {\n' +
            '        // Discordmaxxer: only unmount magnifier when the modal image itself unmounts.\n' +
            '        if (instance && instance.props?.id !== ELEMENT_ID) return;\n' +
            '        this.root?.unmount();\n' +
            '        this.currentMagnifierElement = null;\n' +
            '        this.root = null;\n' +
            '    },'
    },
    {
        file: "src/plugins/imageZoom/components/Magnifier.tsx",
        marker: "Discordmaxxer: safely guard element and video listeners in ready callback",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: safely guard element and video listeners in ready callback"),
        find:
            '        waitFor(() => instance.state.readyState === "READY", () => {\n' +
            '            const elem = document.getElementById(ELEMENT_ID) as HTMLDivElement;\n' +
            '            element.current = elem;\n' +
            '            elem.querySelector("img,video")?.setAttribute("draggable", "false");\n' +
            '            if (instance.props.animated) {\n' +
            '                originalVideoElementRef.current = elem!.querySelector("video")!;\n' +
            '                originalVideoElementRef.current.addEventListener("timeupdate", syncVideos);\n' +
            '            }\n\n' +
            '            setReady(true);\n' +
            '        });',
        replace:
            '        // Discordmaxxer: safely guard element and video listeners in ready callback.\n' +
            '        waitFor(() => instance.state.readyState === "READY", () => {\n' +
            '            const elem = document.getElementById(ELEMENT_ID) as HTMLDivElement | null;\n' +
            '            if (!elem) return;\n' +
            '            element.current = elem;\n' +
            '            elem.querySelector("img,video")?.setAttribute("draggable", "false");\n' +
            '            if (instance.props.animated) {\n' +
            '                const videoEl = elem.querySelector("video");\n' +
            '                if (videoEl) {\n' +
            '                    originalVideoElementRef.current = videoEl;\n' +
            '                    videoEl.addEventListener("timeupdate", syncVideos);\n' +
            '                }\n' +
            '            }\n\n' +
            '            setReady(true);\n' +
            '        });'
    },
    {
        file: "src/plugins/imageZoom/components/Magnifier.tsx",
        marker: "Discordmaxxer: cleanup video event listeners in Magnifier",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: cleanup video event listeners in Magnifier"),
        find:
            '        return () => {\n' +
            '            document.removeEventListener("keydown", onKeyDown);\n' +
            '            document.removeEventListener("keyup", onKeyUp);\n' +
            '            document.removeEventListener("mousemove", updateMousePosition);\n' +
            '            document.removeEventListener("mousedown", onMouseDown);\n' +
            '            document.removeEventListener("mouseup", onMouseUp);\n' +
            '            document.removeEventListener("wheel", onWheel);\n' +
            '        };',
        replace:
            '        return () => {\n' +
            '            document.removeEventListener("keydown", onKeyDown);\n' +
            '            document.removeEventListener("keyup", onKeyUp);\n' +
            '            document.removeEventListener("mousemove", updateMousePosition);\n' +
            '            document.removeEventListener("mousedown", onMouseDown);\n' +
            '            document.removeEventListener("mouseup", onMouseUp);\n' +
            '            document.removeEventListener("wheel", onWheel);\n' +
            '            // Discordmaxxer: cleanup video event listeners in Magnifier\n' +
            '            if (originalVideoElementRef.current) {\n' +
            '                originalVideoElementRef.current.removeEventListener("timeupdate", syncVideos);\n' +
            '                originalVideoElementRef.current = null;\n' +
            '            }\n' +
            '        };'
    },
    // ReverseImageSearch has a second, standalone image-context hook. It can
    // receive frozen/partial menu children while Discord is opening the image
    // viewer; keeping only its message hook preserves the useful search action
    // without replacing Discord's native image menu or crashing the renderer.
    {
        file: "src/plugins/reverseImageSearch/index.tsx",
        marker: "Discordmaxxer: keep native image context menus in ReverseImageSearch.",
        find:
            '    contextMenus: {\n' +
            '        "message": messageContextMenuPatch,\n' +
            '        "image-context": imageContextMenuPatch\n' +
            '    }',
        replace:
            '    contextMenus: {\n' +
            '        // Discordmaxxer: keep native image context menus in ReverseImageSearch.\n' +
            '        // The message hook remains available for inline-image search.\n' +
            '        "message": messageContextMenuPatch\n' +
            '    }'
    },
    // Keep Discord's stock message/image menus authoritative. Plugin patches
    // for these menu IDs are optional enhancements; one malformed child from
    // any plugin can otherwise take down the renderer after the menu opens.
    // Reply, forward, reactions, pin, bookmark, and image actions remain the
    // native Discord actions, while user/guild/channel menus stay extensible.
    {
        file: "src/api/PluginManager.ts",
        marker: "Discordmaxxer: preserve native message menus.",
        find: "export const startPlugin = traceFunction(\"startPlugin\", function startPlugin(p: Plugin) {",
        replace:
            "const DISCORDMAXXER_NATIVE_MENU_IDS = new Set([\"message\", \"message-actions\", \"image-context\"]);\n\n" +
            "// Discordmaxxer: preserve native message menus.\n" +
            "export const startPlugin = traceFunction(\"startPlugin\", function startPlugin(p: Plugin) {"
    },
    {
        file: "src/api/PluginManager.ts",
        marker: "Discordmaxxer: skip unsafe message menu patches.",
        find:
            "    if (contextMenus) {\n" +
            "        logger.debug(\"Adding context menus patches of plugin\", name);\n" +
            "        for (const navId in contextMenus) {\n" +
            "            addContextMenuPatch(navId, contextMenus[navId]);\n" +
            "        }\n" +
            "    }",
        replace:
            "    if (contextMenus) {\n" +
            "        logger.debug(\"Adding context menus patches of plugin\", name);\n" +
            "        for (const navId in contextMenus) {\n" +
            "            if (DISCORDMAXXER_NATIVE_MENU_IDS.has(navId) && name !== \"WebContextMenus\") {\n" +
            "                logger.debug(\"Keeping native Discord context menu\", navId, name);\n" +
            "                continue;\n" +
            "            }\n" +
            "            addContextMenuPatch(navId, contextMenus[navId]);\n" +
            "        }\n" +
            "    }"
    },
    {
        file: "src/api/PluginManager.ts",
        marker: "Discordmaxxer: skip unsafe message menu removals.",
        find:
            "    if (contextMenus) {\n" +
            "        logger.debug(\"Removing context menus patches of plugin\", name);\n" +
            "        for (const navId in contextMenus) {\n" +
            "            removeContextMenuPatch(navId, contextMenus[navId]);\n" +
            "        }\n" +
            "    }",
        replace:
            "    if (contextMenus) {\n" +
            "        logger.debug(\"Removing context menus patches of plugin\", name);\n" +
            "        for (const navId in contextMenus) {\n" +
            "            if (DISCORDMAXXER_NATIVE_MENU_IDS.has(navId) && name !== \"WebContextMenus\") continue;\n" +
            "            removeContextMenuPatch(navId, contextMenus[navId]);\n" +
            "        }\n" +
            "    }"
    },
    // Vencord's desktop-only WebContextMenus plugin restores the Discord
    // image/link/text menu path that the web client omits. Keep that desktop
    // path enabled so Copy Image/Open Image are present; the independent
    // PluginManager guard above still prevents third-party message/image
    // context-menu patches from replacing the native menu or crashing it.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        marker: "Discordmaxxer: preserve desktop context menus.",
        obsoleteWhen: content => content.includes("const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;") ||
            content.includes("Discordmaxxer: keep Discord desktop native context menus."),
        find: "const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;",
        replace:
            "// Discordmaxxer: preserve desktop context menus.\n" +
            "const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: require native desktop context menus.",
        alreadyAppliedWhen: content => content.includes("required: IS_DISCORD_DESKTOP || IS_VESKTOP,"),
        find:
            "    enabledByDefault: true,\n" +
            "    required: IS_VESKTOP,",
        replace:
            "    enabledByDefault: true,\n" +
            "    // Discordmaxxer: require native desktop context menus.\n" +
            "    required: IS_DISCORD_DESKTOP || IS_VESKTOP,"
    },
    // The generated source may already contain the older overlay marker from
    // a previous build. Converge that state as well so an incremental rebuild
    // cannot silently leave the native desktop image menu disabled.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: restore desktop context menus from disabled overlay.",
        obsoleteWhen: content => content.includes("const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;") ||
            content.includes("Discordmaxxer: keep Discord desktop native context menus."),
        find:
            "// Discordmaxxer: use Discord native web context menus.\n" +
            "const shouldAddBackMenus = () => false;",
        replace:
            "// Discordmaxxer: restore desktop context menus from disabled overlay.\n" +
            "const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;"
    },
    // Converge the intermediate release state where the native menu was
    // restored but still depended on IS_VESKTOP alone. Discordmaxxer is a
    // desktop Electron client, so the broader desktop constant must count.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: desktop-aware context menu flag.",
        alreadyAppliedWhen: content => content.includes("const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;"),
        find: "const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;",
        replace:
            "// Discordmaxxer: desktop-aware context menu flag.\n" +
            "const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;"
    },
    // Discord's desktop renderer already owns the native message/image menu.
    // The web-context-menu replacement is only needed by Vesktop/web-style
    // surfaces. Keep the desktop plugin optional so it cannot intercept the
    // native Copy Image, Reply, Forward, and attachment actions.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: keep Discord desktop native context menus.",
        alreadyAppliedWhen: content => content.includes("const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;"),
        find: "const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;",
        replace:
            "// Discordmaxxer: keep Discord desktop native context menus.\n" +
            "const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: keep Discord desktop plugin optional.",
        alreadyAppliedWhen: content => content.includes("required: IS_VESKTOP,"),
        find: "    required: IS_DISCORD_DESKTOP || IS_VESKTOP,",
        replace:
            "    // Discordmaxxer: keep Discord desktop plugin optional.\n" +
            "    required: IS_VESKTOP,"
    },
    // Discordmaxxer runs in a Vesktop-derived Electron shell, but its normal
    // desktop menu is Discord's native menu. Do not use IS_VESKTOP as a
    // reason to replace that menu: opt-in is the only safe path for the web
    // compatibility plugin. Existing users may still have the plugin enabled
    // in settings, so the explicit runtime predicate is required as well.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: web context menus are opt-in.",
        alreadyAppliedWhen: content => content.includes("const shouldAddBackMenus = () => false;"),
        find: "const shouldAddBackMenus = () => IS_VESKTOP || settings.store.addBack;",
        replace:
            "// Discordmaxxer: native Discord menus stay authoritative on the desktop client.\n" +
            "// The compatibility plugin remains present for source parity, but it is\n" +
            "// hard-disabled so persisted settings cannot replace image/message menus.\n" +
            "const shouldAddBackMenus = () => false;"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: web context menus are not required.",
        alreadyAppliedWhen: content => content.includes("required: false,"),
        find: "    required: IS_VESKTOP,",
        replace:
            "    // Discordmaxxer: the narrow composer bridge is required on desktop.\n" +
            "    required: IS_DISCORD_DESKTOP || IS_VESKTOP,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: web context menus are opt-in by default.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: native composer menu bridge is enabled by default.") || content.includes("enabledByDefault: false,"),
        find: "    enabledByDefault: true,",
        replace: "    // Discordmaxxer: native composer menu bridge is enabled by default.\n    enabledByDefault: true,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: restore only the built-in image menu route.",
        alreadyAppliedWhen: content => content.includes("const shouldAddImageMenus = () => false;") ||
            content.includes("const shouldAddImageMenus = () => true;"),
        find: "const shouldAddBackMenus = () => false;",
        replace:
            "const shouldAddBackMenus = () => false;\n" +
            "// Discordmaxxer: keep the built-in image route scoped to Discord's\n" +
            "// native renderer. DMImageContext owns the desktop Copy Image affordance\n" +
            "// so this compatibility plugin cannot replace normal message menus.\n" +
            "const shouldAddImageMenus = () => false;\n" +
            "// Discordmaxxer: route only the composer through Discord's native menu.\n" +
            "// Message, image, link, and media menus remain on Discord's normal path.\n" +
            "const shouldAddComposerMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;\n" +
            "function isComposerTarget(event: Event) {\n" +
            "    const target = event.target as any;\n" +
            "    return !!target && typeof target.closest === \"function\" && Boolean(target.closest('[contenteditable=\"true\"], textarea, input, [role=\"textbox\"]'));\n" +
            "}\n" +
            "let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;"
    },
    // Incremental candidate builds can already contain the image-route flag
    // without the composer definitions. Converge both states explicitly so a
    // stale idempotency check cannot leave undefined runtime references.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: converge image/composer route definitions.",
        alreadyAppliedWhen: content => content.includes("let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;"),
        find: "const shouldAddImageMenus = () => true;",
        replace:
            "// Discordmaxxer: converge image/composer route definitions.\n" +
            "const shouldAddImageMenus = () => false;\n" +
            "// Discordmaxxer: route only the composer through Discord's native menu.\n" +
            "// Message, image, link, and media menus remain on Discord's normal path.\n" +
            "const shouldAddComposerMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;\n" +
            "function isComposerTarget(event: Event) {\n" +
            "    const target = event.target as any;\n" +
            "    return !!target && typeof target.closest === \"function\" && Boolean(target.closest('[contenteditable=\"true\"], textarea, input, [role=\"textbox\"]'));\n" +
            "}\n" +
            "let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: converge image/composer route definitions.",
        alreadyAppliedWhen: content => content.includes("let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;"),
        find: "const shouldAddImageMenus = () => false;",
        replace:
            "// Discordmaxxer: converge image/composer route definitions.\n" +
            "const shouldAddImageMenus = () => false;\n" +
            "// Discordmaxxer: route only the composer through Discord's native menu.\n" +
            "// Message, image, link, and media menus remain on Discord's normal path.\n" +
            "const shouldAddComposerMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;\n" +
            "function isComposerTarget(event: Event) {\n" +
            "    const target = event.target as any;\n" +
            "    return !!target && typeof target.closest === \"function\" && Boolean(target.closest('[contenteditable=\"true\"], textarea, input, [role=\"textbox\"]'));\n" +
            "}\n" +
            "let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;"
    },
    // Older generated source can retain the compatibility plugin's disabled
    // flags even after the desktop bridge patches have run. Normalize those
    // flags on the incremental path; clean source is already handled by the
    // earlier desktop-aware patches and will skip these as idempotent.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
                marker: "Discordmaxxer: converge native composer plugin defaults.",
        alreadyAppliedWhen: content => content.includes("enabledByDefault: true,") && content.includes("required: IS_DISCORD_DESKTOP || IS_VESKTOP,"),
        find: "    enabledByDefault: false,",
        replace: "    // Discordmaxxer: native composer menu bridge is enabled by default.\n    enabledByDefault: true,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
                marker: "Discordmaxxer: converge native composer required flag.",
        alreadyAppliedWhen: content => content.includes("required: IS_DISCORD_DESKTOP || IS_VESKTOP,"),
        find: "    required: false,",
        replace: "    // Discordmaxxer: the narrow composer bridge is required on desktop.\n    required: IS_DISCORD_DESKTOP || IS_VESKTOP,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard link menu patches.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddBackMenus,\n            find: \"open-native-link\",") ,
        find: "            find: \"open-native-link\",",
        replace: "            predicate: shouldAddBackMenus,\n            find: \"open-native-link\","
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard image support patch.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddImageMenus,\n            find: \"Copy image not supported\",") ,
        find: "            find: \"Copy image not supported\",",
        replace: "            predicate: shouldAddImageMenus,\n            find: \"Copy image not supported\","
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard image action patches.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddImageMenus,\n            find: 'id:\"copy-image\"',"),
        find: "            find: 'id:\"copy-image\"',",
        replace: "            predicate: shouldAddImageMenus,\n            find: 'id:\"copy-image\"',"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard built-in image context menu patch.",
        alreadyAppliedWhen: content => content.includes("            predicate: shouldAddImageMenus,\n            find: 'navId:\"image-context\"',"),
        find: "            find: 'navId:\"image-context\"',",
        replace: "            predicate: shouldAddImageMenus,\n            find: 'navId:\"image-context\"',"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: deduplicate built-in image context menu predicate.",
        alreadyAppliedWhen: content =>
            !content.includes(
                "            all: true,\n" +
                "            predicate: shouldAddBackMenus,\n" +
                "            replacement:"
            ),
        find:
            "            predicate: shouldAddImageMenus,\n" +
            "            find: 'navId:\"image-context\"',\n" +
            "            all: true,\n" +
            "            predicate: shouldAddBackMenus,\n",
        replace:
            "            predicate: shouldAddImageMenus,\n" +
            "            find: 'navId:\"image-context\"',\n" +
            "            all: true,\n"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard media menu patch.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddBackMenus,\n            find: '\"MediaEngineWebRTC\");',") ,
        find: "            find: '\"MediaEngineWebRTC\");',",
        replace: "            predicate: shouldAddBackMenus,\n            find: '\"MediaEngineWebRTC\");',"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard search menu patch.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddBackMenus,\n            find: \"#{intl::SEARCH_WITH_GOOGLE}\",") ,
        find: "            find: \"#{intl::SEARCH_WITH_GOOGLE}\",",
        replace: "            predicate: shouldAddBackMenus,\n            find: \"#{intl::SEARCH_WITH_GOOGLE}\","
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard copy menu patch.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddBackMenus,\n            find: \"#{intl::COPY}),hint:\",") ,
        find: "            find: \"#{intl::COPY}),hint:\",",
        replace: "            predicate: shouldAddBackMenus,\n            find: \"#{intl::COPY}),hint:\","
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard automod menu patch.",
        alreadyAppliedWhen: content => content.includes("predicate: shouldAddBackMenus,\n            find: '(\"interactionUsernameProfile',") ,
        find: "            find: '(\"interactionUsernameProfile',",
        replace: "            predicate: shouldAddBackMenus,\n            find: '(\"interactionUsernameProfile',"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: harden native context menu listeners.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: harden native context menu listeners."),
        find:
            "    start() {\n" +
            "        if (shouldAddBackMenus()) {\n" +
            "            window.removeEventListener(\"contextmenu\", ctxMenuCallbacks.contextMenuCallbackWeb);\n" +
            "            window.addEventListener(\"contextmenu\", ctxMenuCallbacks.contextMenuCallbackNative);\n" +
            "            this.changedListeners = true;\n" +
            "        }\n" +
            "    },\n\n" +
            "    stop() {\n" +
            "        if (this.changedListeners) {\n" +
            "            window.removeEventListener(\"contextmenu\", ctxMenuCallbacks.contextMenuCallbackNative);\n" +
            "            window.addEventListener(\"contextmenu\", ctxMenuCallbacks.contextMenuCallbackWeb);\n" +
            "        }\n" +
            "    },",
        replace:
            "    // Discordmaxxer: harden native context menu listeners.\n" +
            "    start() {\n" +
            "        if (!shouldAddComposerMenus()) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        const native = callbacks?.contextMenuCallbackNative;\n" +
            "        if (typeof web !== \"function\" || typeof native !== \"function\") {\n" +
            "            console.warn(\"[Discordmaxxer] native context menu callbacks unavailable; keeping Discord web menu path\");\n" +
            "            this.changedListeners = false;\n" +
            "            return;\n" +
            "        }\n" +
            "        try {\n" +
            "            const router = (event: MouseEvent) => {\n" +
            "                try {\n" +
            "                    if (isComposerTarget(event)) native(event);\n" +
            "                    else web(event);\n" +
            "                } catch (error) {\n" +
            "                    console.error(\"[Discordmaxxer] context menu route failed; restoring Discord web menu\", error);\n" +
            "                    web(event);\n" +
            "                }\n" +
            "            };\n" +
            "            composerContextMenuRouter = router;\n" +
            "            window.removeEventListener(\"contextmenu\", web);\n" +
            "            window.addEventListener(\"contextmenu\", router);\n" +
            "            this.changedListeners = true;\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to install native context menu path\", error);\n" +
            "            this.changedListeners = false;\n" +
            "        }\n" +
            "    },\n\n" +
            "    stop() {\n" +
            "        if (!this.changedListeners) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        try {\n" +
            "            if (composerContextMenuRouter) {\n" +
            "                window.removeEventListener(\"contextmenu\", composerContextMenuRouter);\n" +
            "                composerContextMenuRouter = null;\n" +
            "            }\n" +
            "            if (typeof web === \"function\") window.addEventListener(\"contextmenu\", web);\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to restore web context menu path\", error);\n" +
            "        }\n" +
            "        this.changedListeners = false;\n" +
            "    },"
    },
    // The current incremental source already has the safe attachment-image
    // capture handler, but its old global-listener block does not match the
    // clean-source hardening patch above. Converge that exact block to the
    // narrow composer router without touching the image handler.
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: converge native context menu listeners v2.",
        alreadyAppliedWhen: content => content.includes("composerContextMenuRouter = router;"),
        find:
            "        if (!shouldAddBackMenus()) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        const native = callbacks?.contextMenuCallbackNative;\n" +
            "        if (typeof web !== \"function\" || typeof native !== \"function\") {\n" +
            "            console.warn(\"[Discordmaxxer] native context menu callbacks unavailable; keeping Discord web menu path\");\n" +
            "            this.changedListeners = false;\n" +
            "            return;\n" +
            "        }\n" +
            "        try {\n" +
            "            window.removeEventListener(\"contextmenu\", web);\n" +
            "            window.addEventListener(\"contextmenu\", native);\n" +
            "            this.changedListeners = true;\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to install native context menu path\", error);\n" +
            "            this.changedListeners = false;\n" +
            "        }\n" +
            "    },\n\n" +
            "    stop() {\n" +
            "        if (imageContextMenuHandler) {\n" +
            "            window.removeEventListener(\"contextmenu\", imageContextMenuHandler, true);\n" +
            "            imageContextMenuHandler = null;\n" +
            "        }\n" +
            "        if (!this.changedListeners) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        const native = callbacks?.contextMenuCallbackNative;\n" +
            "        try {\n" +
            "            if (typeof native === \"function\") window.removeEventListener(\"contextmenu\", native);\n" +
            "            if (typeof web === \"function\") window.addEventListener(\"contextmenu\", web);\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to restore web context menu path\", error);\n" +
            "        }\n" +
            "        this.changedListeners = false;\n" +
            "    },",
        replace:
            "        // Discordmaxxer: converge native context menu listeners v2.\n" +
            "        if (!shouldAddComposerMenus()) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        const native = callbacks?.contextMenuCallbackNative;\n" +
            "        if (typeof web !== \"function\" || typeof native !== \"function\") {\n" +
            "            console.warn(\"[Discordmaxxer] native context menu callbacks unavailable; keeping Discord web menu path\");\n" +
            "            this.changedListeners = false;\n" +
            "            return;\n" +
            "        }\n" +
            "        try {\n" +
            "            const router = (event: MouseEvent) => {\n" +
            "                try {\n" +
            "                    if (isComposerTarget(event)) native(event);\n" +
            "                    else web(event);\n" +
            "                } catch (error) {\n" +
            "                    console.error(\"[Discordmaxxer] context menu route failed; restoring Discord web menu\", error);\n" +
            "                    web(event);\n" +
            "                }\n" +
            "            };\n" +
            "            composerContextMenuRouter = router;\n" +
            "            window.removeEventListener(\"contextmenu\", web);\n" +
            "            window.addEventListener(\"contextmenu\", router);\n" +
            "            this.changedListeners = true;\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to install native context menu path\", error);\n" +
            "            this.changedListeners = false;\n" +
            "        }\n" +
            "    },\n\n" +
            "    stop() {\n" +
            "        if (imageContextMenuHandler) {\n" +
            "            window.removeEventListener(\"contextmenu\", imageContextMenuHandler, true);\n" +
            "            imageContextMenuHandler = null;\n" +
            "        }\n" +
            "        if (!this.changedListeners) return;\n" +
            "        const callbacks = ctxMenuCallbacks as any;\n" +
            "        const web = callbacks?.contextMenuCallbackWeb;\n" +
            "        try {\n" +
            "            if (composerContextMenuRouter) {\n" +
            "                window.removeEventListener(\"contextmenu\", composerContextMenuRouter);\n" +
            "                composerContextMenuRouter = null;\n" +
            "            }\n" +
            "            if (typeof web === \"function\") window.addEventListener(\"contextmenu\", web);\n" +
            "        } catch (error) {\n" +
            "            console.error(\"[Discordmaxxer] failed to restore web context menu path\", error);\n" +
            "        }\n" +
            "        this.changedListeners = false;\n" +
            "    },"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: scope slate context menu patch to composer.",
        alreadyAppliedWhen: content => content.includes("find: 'getElementById(\"slate-toolbar\"',\n            predicate: shouldAddComposerMenus,"),
        find:
            "            find: 'getElementById(\"slate-toolbar\"',\n" +
            "            predicate: shouldAddBackMenus,",
        replace:
            "            find: 'getElementById(\"slate-toolbar\"',\n" +
            "            predicate: shouldAddComposerMenus,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: scope slash context menu patch to composer.",
        alreadyAppliedWhen: content => content.includes("find: \".SLASH_COMMAND_SUGGESTIONS_TOGGLED,{\",\n            predicate: shouldAddComposerMenus,"),
        find:
            "            find: \".SLASH_COMMAND_SUGGESTIONS_TOGGLED,{\",\n" +
            "            predicate: shouldAddBackMenus,",
        replace:
            "            find: \".SLASH_COMMAND_SUGGESTIONS_TOGGLED,{\",\n" +
            "            predicate: shouldAddComposerMenus,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: scope dictionary context menu patch to composer.",
        alreadyAppliedWhen: content => content.includes("find: '\"add-to-dictionary\"',\n            predicate: shouldAddComposerMenus,"),
        find:
            "            find: '\"add-to-dictionary\"',\n" +
            "            predicate: shouldAddBackMenus,",
        replace:
            "            find: '\"add-to-dictionary\"',\n" +
            "            predicate: shouldAddComposerMenus,"
    },
    {
        file: "src/plugins/webContextMenus.web/index.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: harden image copy fallback.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: harden image copy fallback."),
        find:
            "    async copyImage(url: string) {\n" +
            "        url = fixImageUrl(url);\n\n" +
            "        let imageData = await fetch(url).then(r => r.blob());\n" +
            "        if (imageData.type !== \"image/png\") {\n" +
            "            const bitmap = await createImageBitmap(imageData);\n\n" +
            "            const canvas = document.createElement(\"canvas\");\n" +
            "            canvas.width = bitmap.width;\n" +
            "            canvas.height = bitmap.height;\n" +
            "            canvas.getContext(\"2d\")!.drawImage(bitmap, 0, 0);\n\n" +
            "            await new Promise<void>(done => {\n" +
            "                canvas.toBlob(data => {\n" +
            "                    imageData = data!;\n" +
            "                    done();\n" +
            "                }, \"image/png\");\n" +
            "            });\n" +
            "        }\n\n" +
            "        if (IS_VESKTOP && VesktopNative.clipboard) {\n" +
            "            VesktopNative.clipboard.copyImage(await imageData.arrayBuffer(), url);\n" +
            "            return;\n" +
            "        } else {\n" +
            "            navigator.clipboard.write([\n" +
            "                new ClipboardItem({\n" +
            "                    \"image/png\": imageData\n" +
            "                })\n" +
            "            ]);\n" +
            "        }\n" +
            "    },",
        replace:
            "    // Discordmaxxer: harden image copy fallback.\n" +
            "    async copyImage(url: string) {\n" +
            "        const sourceUrl = url;\n" +
            "        try {\n" +
            "            url = fixImageUrl(url);\n" +
            "            const response = await fetch(url);\n" +
            "            if (!response.ok) throw new Error(`Image request failed (${response.status})`);\n" +
            "            let imageData = await response.blob();\n" +
            "            if (!imageData || imageData.size === 0) throw new Error(\"Image response was empty\");\n" +
            "            if (imageData.type !== \"image/png\") {\n" +
            "                const bitmap = await createImageBitmap(imageData);\n" +
            "                try {\n" +
            "                    const canvas = document.createElement(\"canvas\");\n" +
            "                    canvas.width = bitmap.width;\n" +
            "                    canvas.height = bitmap.height;\n" +
            "                    const context = canvas.getContext(\"2d\");\n" +
            "                    if (!context) throw new Error(\"Canvas context unavailable\");\n" +
            "                    context.drawImage(bitmap, 0, 0);\n" +
            "                    imageData = await new Promise<Blob>((resolve, reject) => {\n" +
            "                        canvas.toBlob(data => data ? resolve(data) : reject(new Error(\"PNG conversion failed\")), \"image/png\");\n" +
            "                    });\n" +
            "                } finally {\n" +
            "                    bitmap.close();\n" +
            "                }\n" +
            "            }\n" +
            "            if (IS_VESKTOP && VesktopNative.clipboard) {\n" +
            "                await VesktopNative.clipboard.copyImage(await imageData.arrayBuffer(), url);\n" +
            "                return;\n" +
            "            }\n" +
            "            await navigator.clipboard.write([new ClipboardItem({ \"image/png\": imageData })]);\n" +
            "        } catch (error) {\n" +
            "            console.warn(\"[Discordmaxxer] copy image failed; copying the source link instead\", error);\n" +
            "            try {\n" +
            "                await copyToClipboard(sourceUrl);\n" +
            "            } catch (fallbackError) {\n" +
            "                console.error(\"[Discordmaxxer] copy image fallback failed\", fallbackError);\n" +
            "            }\n" +
            "        }\n" +
            "    },"
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
    },

    // ── DM navigation: keep optional PinDMs stores fail-open ──
    // Discord's current module graph can expose these lazy store proxies
    // before their backing exports exist. A group-DM navigation must never
    // take down the renderer just because the optional pinning plugin cannot
    // read its sort order for one render.
    {
        file: "src/plugins/pinDms/data.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: guard PinDMs lazy stores.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: guard PinDMs lazy stores.") ||
            (content.includes("function currentUserIdSafe(): string | null") &&
                content.includes("function privateChannelIdsSafe(): string[]")),
        find:
            "let forceUpdateDms: (() => void) | undefined = undefined;\n" +
            "export let currentUserCategories: Category[] = [];\n",
        replace:
            "let forceUpdateDms: (() => void) | undefined = undefined;\n" +
            "export let currentUserCategories: Category[] = [];\n\n" +
            "// Discordmaxxer: guard PinDMs lazy stores.\n" +
            "let warnedUserStoreUnavailable = false;\n" +
            "let warnedPrivateChannelSortStoreUnavailable = false;\n\n" +
            "function currentUserIdSafe(): string | null {\n" +
            "    try {\n" +
            "        const getCurrentUser = (UserStore as any)?.getCurrentUser;\n" +
            "        const user = typeof getCurrentUser === \"function\" ? getCurrentUser.call(UserStore) : null;\n" +
            "        return user?.id ?? null;\n" +
            "    } catch (error) {\n" +
            "        if (!warnedUserStoreUnavailable) {\n" +
            "            warnedUserStoreUnavailable = true;\n" +
            "            console.warn(\"[PinDMs] user store unavailable; deferring category initialization\", error);\n" +
            "        }\n" +
            "        return null;\n" +
            "    }\n" +
            "}\n\n" +
            "function privateChannelIdsSafe(): string[] {\n" +
            "    try {\n" +
            "        const getPrivateChannelIds = (PrivateChannelSortStore as any)?.getPrivateChannelIds;\n" +
            "        const ids = typeof getPrivateChannelIds === \"function\"\n" +
            "            ? getPrivateChannelIds.call(PrivateChannelSortStore)\n" +
            "            : [];\n" +
            "        return Array.isArray(ids) ? ids : [];\n" +
            "    } catch (error) {\n" +
            "        if (!warnedPrivateChannelSortStoreUnavailable) {\n" +
            "            warnedPrivateChannelSortStoreUnavailable = true;\n" +
            "            console.warn(\"[PinDMs] private channel sort store unavailable; using saved DM order\", error);\n" +
            "        }\n" +
            "        return [];\n" +
            "    }\n" +
            "}\n"
    },
    {
        file: "src/plugins/pinDms/data.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: use guarded PinDMs user initialization.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: use guarded PinDMs user initialization.") ||
            content.includes("const userId = currentUserIdSafe();"),
        find: "    const userId = UserStore.getCurrentUser()?.id;",
        replace:
            "    // Discordmaxxer: use guarded PinDMs user initialization.\n" +
            "    const userId = currentUserIdSafe();"
    },
    {
        file: "src/plugins/pinDms/data.ts",
        allowOnStable: true,
        marker: "Discordmaxxer: use guarded PinDMs order reads.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: use guarded PinDMs order reads.") ||
            content.includes("const sortedChannels = privateChannelIdsSafe();"),
        find:
            "export function getAllUncollapsedChannels() {\n" +
            "    if (settings.store.pinOrder === PinOrder.LastMessage) {\n" +
            "        const sortedChannels = PrivateChannelSortStore.getPrivateChannelIds();\n" +
            "        return currentUserCategories.filter(c => !c.collapsed).flatMap(c => sortedChannels.filter(channel => c.channels.includes(channel)));\n" +
            "    }\n",
        replace:
            "export function getAllUncollapsedChannels() {\n" +
            "    let pinOrder: PinOrder | undefined;\n" +
            "    try {\n" +
            "        pinOrder = settings.store.pinOrder;\n" +
            "    } catch (error) {\n" +
            "        if (!warnedPrivateChannelSortStoreUnavailable) {\n" +
            "            warnedPrivateChannelSortStoreUnavailable = true;\n" +
            "            console.warn(\"[PinDMs] pin order settings unavailable; using saved DM order\", error);\n" +
            "        }\n" +
            "    }\n\n" +
            "    if (pinOrder === PinOrder.LastMessage) {\n" +
            "        const sortedChannels = privateChannelIdsSafe();\n" +
            "        return currentUserCategories.filter(c => !c.collapsed).flatMap(c => sortedChannels.filter(channel => c.channels.includes(channel)));\n" +
            "    }\n"
    },

    // ── BetterFolders: keep the actual folder popout enabled ──
    // The custom sidebar is deliberately guarded by the stable-store
    // fallbacks below, but it must not be hard-disabled or folder contents
    // disappear instead of becoming selectable.
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: enable guarded custom folder sidebar.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: enable guarded custom folder sidebar.") ||
            content.includes("const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;"),
        find:
            "const GRID_STYLE_NAME = \"vc-betterFolders-sidebar-grid\";\n\n" +
            "export default definePlugin({",
        replace:
            "const GRID_STYLE_NAME = \"vc-betterFolders-sidebar-grid\";\n\n" +
            "// Discordmaxxer: enable guarded custom folder sidebar.\n" +
            "const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;\n\n" +
            "export default definePlugin({"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: keep native folder children visible.",
        find: "            predicate: () => settings.store.sidebar,\n",
        replace: "            predicate: () => settings.store.sidebar && DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED,\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: export guarded custom folder sidebar flag.",
        alreadyAppliedWhen: content => content.includes("export const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;"),
        find: "const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;",
        replace:
            "// Discordmaxxer: export guarded custom folder sidebar flag.\n" +
            "export const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: keep native folder expansion authoritative.",
        find: "            predicate: () => settings.store.sidebar && settings.store.showFolderIcon !== FolderIconDisplay.Always,\n",
        replace: "            predicate: () => settings.store.sidebar && DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED && settings.store.showFolderIcon !== FolderIconDisplay.Always,\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: leave native folder lifecycle untouched.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder lifecycle untouched.") ||
            content.includes("Discordmaxxer: close folder store transitions safely.") ||
            content.includes("const expanded = ExpandedGuildFolderStore?.getExpandedFolders?.();") ||
            content.includes("const expanded = ExpandedGuildFolderStore.getExpandedFolders?.();"),
        obsoleteWhen: content => content.includes("for (const id of ExpandedGuildFolderStore.getExpandedFolders())") &&
            content.includes("FolderUtils.toggleGuildFolderExpand(id);"),
        find:
            "function closeFolders() {\n" +
            "    try {\n",
        replace:
            "function closeFolders() {\n" +
            "    // Discord owns the native folder tree. The optional custom sidebar\n" +
            "    // is disabled until its renderer contract is stable.\n" +
            "    // Discordmaxxer: leave native folder lifecycle untouched.\n" +
            "    if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return;\n" +
            "    try {\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: leave native folder route selection untouched.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder route selection untouched."),
        find:
            "        CHANNEL_SELECT(data) {\n" +
            "            if (!settings.store.closeAllFolders && !settings.store.forceOpen)\n",
        replace:
            "        CHANNEL_SELECT(data) {\n" +
            "            // Discordmaxxer: leave native folder route selection untouched.\n" +
            "            if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return;\n" +
            "            if (!settings.store.closeAllFolders && !settings.store.forceOpen)\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: leave native folder toggle untouched.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder toggle untouched."),
        find:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n",
        replace:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            // Discordmaxxer: leave native folder toggle untouched.\n" +
            "            if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return;\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n"
    },

    // ── BetterFolders: carry ID and renderer-transition safeguards into CI ──
    // The local Vencord checkout is ignored and CI clones it from the pinned
    // commit. Keep the folder repair in this tracked overlay so a release
    // cannot silently fall back to the old disappearing-child behavior.
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: BetterFolders normalized ID helpers.",
        find: "let lastGuildId = null as string | null;\nlet dispatchingFoldersClose = false;\n",
        replace:
            "let lastGuildId = null as string | null;\n" +
            "let dispatchingFoldersClose = false;\n\n" +
            "// Discordmaxxer: BetterFolders normalized ID helpers. Discord has\n" +
            "// emitted folder/guild IDs as both numbers and strings across\n" +
            "// client revisions; compare them at the store/React boundary.\n" +
            "export function normalizeFolderId(value: unknown): string | null {\n" +
            "    if (value !== null && typeof value === \"object\") {\n" +
            "        const record = value as any;\n" +
            "        value = record.folderId ?? record.id ?? record.folder?.id ?? record.node?.id;\n" +
            "    }\n" +
            "    return value === null || value === undefined ? null : String(value);\n" +
            "}\n\n" +
            "export function hasFolderId(ids: unknown, value: unknown): boolean {\n" +
            "    const target = normalizeFolderId(value);\n" +
            "    if (target === null || ids === null || ids === undefined) return false;\n\n" +
            "    const candidate = ids as any;\n" +
            "    try {\n" +
            "        if (typeof candidate.has === \"function\") {\n" +
            "            for (const key of [value, target]) {\n" +
            "                if (!candidate.has(key)) continue;\n" +
            "                if (typeof candidate.get !== \"function\" || candidate.get(key) !== false) return true;\n" +
            "            }\n" +
            "        }\n" +
            "        if (typeof candidate.includes === \"function\" && (candidate.includes(value) || candidate.includes(target))) return true;\n" +
            "    } catch {\n" +
            "        // A renderer transition can expose a partially disposed store.\n" +
            "    }\n\n" +
            "    if (candidate && typeof candidate === \"object\" && !Array.isArray(candidate)) {\n" +
            "        try {\n" +
            "            for (const [key, entry] of Object.entries(candidate)) {\n" +
            "                if (normalizeFolderId(key) === target && entry !== false) return true;\n" +
            "            }\n" +
            "        } catch {\n" +
            "            // Continue to the iterable fallback.\n" +
            "        }\n" +
            "    }\n\n" +
            "    try {\n" +
            "        if (typeof candidate?.[Symbol.iterator] !== \"function\") return false;\n" +
            "        for (const id of candidate as Iterable<unknown>) {\n" +
            "            if (normalizeFolderId(id) === target) return true;\n" +
            "            if (Array.isArray(id) && normalizeFolderId(id[0]) === target && id[1] !== false) return true;\n" +
            "        }\n" +
            "    } catch {\n" +
            "        // Treat an unstable store as not expanded; the caller fails open.\n" +
            "    }\n\n" +
            "    return false;\n" +
            "}\n\n" +
            "export function isFolderExpandedId(value: unknown): boolean {\n" +
            "    const store = ExpandedGuildFolderStore as any;\n" +
            "    try {\n" +
            "        if (typeof store?.isFolderExpanded === \"function\" && (store.isFolderExpanded(value) || store.isFolderExpanded(normalizeFolderId(value)))) return true;\n" +
            "    } catch {\n" +
            "        // Fall through to the expanded-ID collection for older clients.\n" +
            "    }\n" +
            "    try {\n" +
            "        return hasFolderId(store?.getExpandedFolders?.(), value);\n" +
            "    } catch {\n" +
            "        return false;\n" +
            "    }\n" +
            "}\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: optimistic expanded-folder bridge.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: optimistic expanded-folder bridge."),
        obsoleteWhen: content => content.includes("discordmaxxerManualExpandedFolderIds"),
        find: "let dispatchingFoldersClose = false;\n",
        replace:
            "let dispatchingFoldersClose = false;\n\n" +
            "// Discordmaxxer: optimistic expanded-folder bridge. Discord's\n" +
            "// expanded-folder store can be one render behind the folder click,\n" +
            "// so keep a small local bridge for the dedicated sidebar.\n" +
            "const discordmaxxerManualExpandedFolderIds = new Set<string>();\n" +
            "const discordmaxxerManualExpandedFolderListeners = new Set<() => void>();\n" +
            "export const DiscordmaxxerExpandedFolderStore = {\n" +
            "    addChangeListener(listener: () => void) {\n" +
            "        discordmaxxerManualExpandedFolderListeners.add(listener);\n" +
            "    },\n" +
            "    removeChangeListener(listener: () => void) {\n" +
            "        discordmaxxerManualExpandedFolderListeners.delete(listener);\n" +
            "    },\n" +
            "    emitChange() {\n" +
            "        for (const listener of [...discordmaxxerManualExpandedFolderListeners]) {\n" +
            "            try {\n" +
            "                listener();\n" +
            "            } catch {\n" +
            "                // A stale React subscriber must not break the dispatcher.\n" +
            "            }\n" +
            "        }\n" +
            "    }\n" +
            "};\n\n" +
            "export function getDiscordmaxxerManualExpandedFolderIds() {\n" +
            "    return new Set(discordmaxxerManualExpandedFolderIds);\n" +
            "}\n\n" +
            "function setManualExpandedFolder(id: unknown, expanded: boolean) {\n" +
            "    const normalized = normalizeFolderId(id);\n" +
            "    if (normalized === null) return;\n" +
            "    if (expanded) discordmaxxerManualExpandedFolderIds.add(normalized);\n" +
            "    else discordmaxxerManualExpandedFolderIds.delete(normalized);\n" +
            "    DiscordmaxxerExpandedFolderStore.emitChange();\n" +
            "}\n\n" +
            "function noteFolderToggle(id: unknown) {\n" +
            "    const normalized = normalizeFolderId(id);\n" +
            "    if (normalized === null) return;\n" +
            "    // Mirror the direction of Discord's native toggle, then reconcile\n" +
            "    // after its store commits. Never force every toggle to \"open\".\n" +
            "    const expectedExpanded = !isFolderExpandedId(normalized);\n" +
            "    setManualExpandedFolder(normalized, expectedExpanded);\n" +
            "    const reconcile = (attempt: number) => {\n" +
            "        window.setTimeout(() => {\n" +
            "            try {\n" +
            "                const expanded = isFolderExpandedId(normalized);\n" +
            "                if (expanded === expectedExpanded || attempt >= 3) {\n" +
            "                    setManualExpandedFolder(normalized, expanded);\n" +
            "                    return;\n" +
            "                }\n" +
            "            } catch {\n" +
            "                if (attempt >= 3) return;\n" +
            "            }\n" +
            "            reconcile(attempt + 1);\n" +
            "        }, attempt === 0 ? 120 : 180);\n" +
            "    };\n" +
            "    reconcile(0);\n" +
            "}\n\n" +
            "function clearManualExpandedFolders() {\n" +
            "    if (!discordmaxxerManualExpandedFolderIds.size) return;\n" +
            "    discordmaxxerManualExpandedFolderIds.clear();\n" +
            "    DiscordmaxxerExpandedFolderStore.emitChange();\n" +
            "}\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: guard force-open navigation.",
        alreadyAppliedWhen: content => content.includes("noteFolderToggle(guildFolder.folderId)"),
        obsoleteWhen: content => content.includes("noteFolderToggle(guildFolder.folderId)") || content.includes("Discordmaxxer: keep route selection native."),
        find:
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore.isFolderExpanded(guildFolder.folderId)) {\n" +
            "                        FolderUtils.toggleGuildFolderExpand(guildFolder.folderId);\n" +
            "                    }",
        replace:
            "                    if (settings.store.forceOpen && !isFolderExpandedId(guildFolder.folderId)) {\n" +
            "                        try {\n" +
            "                            FolderUtils.toggleGuildFolderExpand(guildFolder.folderId);\n" +
            "                            noteFolderToggle(guildFolder.folderId);\n" +
            "                        } catch {\n" +
            "                            // Guild navigation can race folder disposal.\n" +
            "                        }\n" +
            "                    }"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: keep route selection native.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: keep route selection native."),
        obsoleteWhen: content => content.includes("Discordmaxxer: keep route selection native."),
        find:
            "        CHANNEL_SELECT(data) {\n" +
            "            try {\n" +
            "                if (!settings.store.closeAllFolders && !settings.store.forceOpen)\n" +
            "                    return;\n\n" +
            "                if (lastGuildId !== data?.guildId) {\n" +
            "                    lastGuildId = data?.guildId ?? null;\n" +
            "                    const guildFolder = getGuildFolder(data?.guildId);\n\n" +
            "                    if (guildFolder?.folderId !== null && guildFolder?.folderId !== undefined) {\n" +
            "                        if (settings.store.forceOpen && !isFolderExpandedId(guildFolder.folderId)) {\n" +
            "                            try {\n" +
            "                                FolderUtils.toggleGuildFolderExpand(guildFolder.folderId);\n" +
            "                                noteFolderToggle(guildFolder.folderId);\n" +
            "                            } catch {\n" +
            "                                // Guild navigation can race folder disposal.\n" +
            "                            }\n" +
            "                        }\n" +
            "                    } else if (settings.store.closeAllFolders) {\n" +
            "                        closeFolders();\n" +
            "                    }\n" +
            "                }\n" +
            "            } catch {\n" +
            "                // DM/group-chat navigation may expose partial stores for one tick.\n" +
            "            }\n" +
            "        },",
        replace:
            "        CHANNEL_SELECT() {\n" +
            "            // Discord owns route selection. Folder convenience behavior is\n" +
            "            // deliberately excluded from DM/group-chat navigation.\n" +
            "        },"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: keep folder toggle native.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: keep folder toggle native."),
        obsoleteWhen: content => content.includes("Discordmaxxer: keep folder toggle native."),
        find:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            noteFolderToggle(data?.folderId);\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders?.();\n\n" +
            "                        if (expandedFolders.size > 1) {\n" +
            "                            for (const id of expandedFolders) if (id !== data.folderId)\n" +
            "                                FolderUtils.toggleGuildFolderExpand(id);\n" +
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partially disposed folder store must not crash navigation.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });\n" +
            "            }\n" +
            "        },",
        replace:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            // Discord owns the folder toggle. Only mirror its state for\n" +
            "            // the custom sidebar; do not dispatch recursive close events.\n" +
            "            // Discordmaxxer: keep folder toggle native.\n" +
            "            try { noteFolderToggle(data?.folderId); } catch { /* fail open */ }\n" +
            "        },"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: guard folder close-other wait.",
        alreadyAppliedWhen: content => content.includes("A partially disposed folder store must not crash navigation."),
        obsoleteWhen: content => content.includes("A partially disposed folder store must not crash navigation.") || content.includes("Discordmaxxer: keep folder toggle native."),
        find: "                FluxDispatcher.wait(() => {\n                    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders?.();\n",
        replace:
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders?.();\n"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: finish folder close-other wait safely.",
        alreadyAppliedWhen: content => content.includes("finally {\n                            dispatchingFoldersClose = false;"),
        obsoleteWhen: content => content.includes("finally {\n                            dispatchingFoldersClose = false;") || content.includes("Discordmaxxer: keep folder toggle native."),
        find: "                    }\n\n                    dispatchingFoldersClose = false;\n                });",
        replace:
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partially disposed folder store must not crash navigation.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: clear manual folder state on lifecycle.",
        alreadyAppliedWhen: content => content.includes("start() {\n        clearManualExpandedFolders();"),
        obsoleteWhen: content => content.includes("clearManualExpandedFolders();"),
        find: "    FolderSideBar,\n    closeFolders,\n",
        replace:
            "    FolderSideBar,\n    closeFolders,\n\n" +
            "    start() {\n" +
            "        clearManualExpandedFolders();\n" +
            "    },\n\n" +
            "    stop() {\n" +
            "        clearManualExpandedFolders();\n" +
            "    },\n"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        marker: "Discordmaxxer: subscribe optimistic folder state.",
        alreadyAppliedWhen: content => content.includes("DiscordmaxxerExpandedFolderStore"),
        obsoleteWhen: content => content.includes("DiscordmaxxerExpandedFolderStore"),
        find: "import { ExpandedGuildFolderStore, hasFolderId, isFolderExpandedId, normalizeFolderId, settings, SortedGuildStore } from \".\";",
        replace: "import { DiscordmaxxerExpandedFolderStore, ExpandedGuildFolderStore, getDiscordmaxxerManualExpandedFolderIds, hasFolderId, isFolderExpandedId, normalizeFolderId, settings, SortedGuildStore } from \".\";"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        marker: "Discordmaxxer: merge optimistic folder state.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: merge optimistic folder state while Discord"),
        obsoleteWhen: content => content.includes("getDiscordmaxxerManualExpandedFolderIds()"),
        find: "        return expandedFolderIds;\n",
        replace:
            "        // Discordmaxxer: merge optimistic folder state while Discord\n" +
            "        // commits the expanded-folder store after a click.\n" +
            "        for (const id of getDiscordmaxxerManualExpandedFolderIds()) expandedFolderIds.add(id);\n\n" +
            "        return expandedFolderIds;\n"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        marker: "Discordmaxxer: subscribe FolderSideBar to optimistic state.",
        alreadyAppliedWhen: content => content.includes("DiscordmaxxerExpandedFolderStore"),
        obsoleteWhen: content => content.includes("DiscordmaxxerExpandedFolderStore"),
        find: "    const expandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore], () => getExpandedFolderIds());",
        replace: "    const expandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore, DiscordmaxxerExpandedFolderStore], () => getExpandedFolderIds());"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        marker: "Discordmaxxer: support map-shaped expanded state.",
        alreadyAppliedWhen: content => content.includes("for (const entry of expandedFolders as Iterable<unknown>)"),
        obsoleteWhen: content => content.includes("for (const entry of expandedFolders as Iterable<unknown>)"),
        find:
            "            for (const id of expandedFolders as Iterable<unknown>) {\n" +
            "                const normalized = normalizeFolderId(id);\n" +
            "                if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "            }",
        replace:
            "            for (const entry of expandedFolders as Iterable<unknown>) {\n" +
            "                const id = Array.isArray(entry) ? entry[0] : entry;\n" +
            "                if (Array.isArray(entry) && entry[1] === false) continue;\n" +
            "                const normalized = normalizeFolderId(id);\n" +
            "                if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "            }"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        obsoleteWhen: content => content.includes("Discord can replace the sorted-guild store during DM/group navigation."),
        find: "return SortedGuildStore.getGuildFolders().find(folder => folder.guildIds.includes(id));",
        replace:
            "try {\n" +
            "        const folders = SortedGuildStore.getGuildFolders?.();\n" +
            "        return folders?.find(folder =>\n" +
            "            folder.guildIds?.some(guildId => normalizeFolderId(guildId) === normalizeFolderId(id))\n" +
            "        );\n" +
            "    } catch {\n" +
            "        // Discord can replace the sorted-guild store during DM/group navigation.\n" +
            "        return undefined;\n" +
            "    }"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: keep route selection native."),
        find: "if (guildFolder?.folderId) {",
        replace: "if (guildFolder?.folderId !== null && guildFolder?.folderId !== undefined) {"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: guard close-other-folder transitions.") || content.includes("Discordmaxxer: keep folder toggle native."),
        find: "for (const id of expandedFolders) if (id !== data.folderId)",
        replace: "for (const id of expandedFolders) if (!hasFolderId([id], data.folderId))"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: remove stale BetterFolders wrapper declaration.",
        find:
            "        const folderNodeId = node?.type === \"folder\"\n" +
            "            ? node.id ?? node.folderId ?? node.folderNode?.folderId\n" +
            "            : node.parentId ?? node.folderId ?? node.guild?.folderId ?? node.folderNode?.folderId;\n",
        replace: ""
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        // The clean source can already contain the fail-open wrapper from a
        // prior local build. Treat that transformed contract as idempotent so
        // strict release builds do not fail on a stale pre-transform matcher.
        obsoleteWhen: content =>
            content.includes("Discordmaxxer: classify BetterFolders nodes fail open.") ||
            content.includes("Discordmaxxer: use the same direct expanded-ID contract as the"),
        marker: "Fail open during a renderer transition.",
        find:
            "if (\n" +
            "            !isBetterFolders ||\n" +
            "            // Discordmaxxer: fail open during a renderer transition.\n" +
            "            // Missing/empty props must not blank the dedicated sidebar.\n" +
            "            expandedFolderIds == null ||\n" +
            "            expandedFolderIds.size === 0 ||\n" +
            "            node.type === \"folder\" && (isFolderExpandedId(folderNodeId) || hasFolderId(expandedFolderIds, folderNodeId)) ||\n" +
            "            node.type === \"guild\" && (isFolderExpandedId(folderNodeId) || hasFolderId(expandedFolderIds, folderNodeId))\n" +
            "        ) {",
        replace:
            "const nodeType = String(node?.type ?? \"\");\n" +
            "        const folderNodeId = nodeType === \"folder\"\n" +
            "            ? node.id ?? node.folderId ?? node.folderNode?.folderId\n" +
            "            : node.parentId ?? node.folderId ?? node.guild?.folderId ?? node.folderNode?.folderId;\n" +
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            expandedFolderIds == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" ||\n" +
            "            nodeType === \"guild\" && folderNodeId == null ||\n" +
            "            hasFolderId(expandedFolderIds, folderNodeId) ||\n" +
            "            isFolderExpandedId(folderNodeId)\n" +
            "        ) {"
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
    alreadyAppliedWhen: content =>
        content.includes("Discordmaxxer: fail open during a renderer transition.") &&
        content.includes("expandedFolderIds == null"),
        obsoleteWhen: content => content.includes("Discordmaxxer: fail open when expanded folder state is unavailable."),
        marker: "Discordmaxxer: fail open when expanded folder state is unavailable.",
        find: "        if (!isBetterFolders || expandedFolderIds == null) return originalComponent();",
        replace:
            "        // Discordmaxxer: fail open when expanded folder state is unavailable.\n" +
            "        // A transient empty store must not hide the normal guild list.\n" +
            "        if (!isBetterFolders || expandedFolderIds == null || expandedFolderIds.size === 0) return originalComponent();",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: close folder store transitions safely.",
        find:
            "function closeFolders() {\n" +
            "    for (const id of ExpandedGuildFolderStore.getExpandedFolders())\n" +
            "        FolderUtils.toggleGuildFolderExpand(id);\n" +
            "}",
        replace:
            "function closeFolders() {\n" +
            "    // Discordmaxxer: close folder store transitions safely.\n" +
            "    try {\n" +
            "        const expanded = ExpandedGuildFolderStore.getExpandedFolders?.();\n" +
            "        if (!expanded || typeof expanded[Symbol.iterator] !== \"function\") return;\n" +
            "        for (const id of expanded) {\n" +
            "            try {\n" +
            "                FolderUtils.toggleGuildFolderExpand(id);\n" +
            "            } catch {\n" +
            "                // A folder may disappear while Discord is changing routes.\n" +
            "            }\n" +
            "        }\n" +
            "    } catch {\n" +
            "        // A partially disposed store must not take down the renderer.\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        marker: "Discordmaxxer: guard close-other-folder transitions.",
        obsoleteWhen: content => content.includes("Discordmaxxer: keep folder toggle native."),
        find:
            "                    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders();\n\n" +
            "                    if (expandedFolders.size > 1) {\n" +
            "                        for (const id of expandedFolders) if (!hasFolderId([id], data.folderId))\n" +
            "                            FolderUtils.toggleGuildFolderExpand(id);\n" +
            "                    }",
        replace:
            "                    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders?.();\n" +
            "                    const expandedIds = expandedFolders && typeof expandedFolders[Symbol.iterator] === \"function\"\n" +
            "                        ? [...expandedFolders]\n" +
            "                        : [];\n\n" +
            "                    // Discordmaxxer: guard close-other-folder transitions.\n" +
            "                    if (expandedIds.length > 1) {\n" +
            "                        for (const id of expandedIds) if (!hasFolderId([id], data.folderId)) {\n" +
            "                            try {\n" +
            "                                FolderUtils.toggleGuildFolderExpand(id);\n" +
            "                            } catch {\n" +
            "                                // The folder can disappear during navigation.\n" +
            "                            }\n" +
            "                        }\n" +
            "                    }"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        obsoleteWhen: content => content.includes("normalizeFolderId"),
        find: "import { ExpandedGuildFolderStore, settings, SortedGuildStore } from \".\";",
        replace: "import { ExpandedGuildFolderStore, hasFolderId, isFolderExpandedId, normalizeFolderId, settings, SortedGuildStore } from \".\";"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        obsoleteWhen: content =>
            content.includes("Discordmaxxer: guard folder sidebar store transitions.") ||
            content.includes("Discordmaxxer: read the expanded-folder store directly.") ||
            content.includes("Discordmaxxer: restore catalog folder IDs."),
        find:
            "        if (expandedFolders.has(folder.folderId) && folder.guildIds?.length) {\n" +
            "            expandedFolderIds.add(folder.folderId);",
        replace:
            "        const folderRecord = folder as any;\n" +
            "        const folderId = normalizeFolderId(folderRecord.folderId ?? folderRecord.id ?? folderRecord.folder?.id);\n" +
            "        const guildIds = folderRecord.guildIds ?? folderRecord.guilds?.map((guild: any) => guild.id ?? guild);\n" +
            "        if (folderId && (isFolderExpandedId(folderId) || hasFolderId(expandedFolders, folderId)) && guildIds?.length) {\n" +
            "            expandedFolderIds.add(folderId);"
    }
    ,
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        obsoleteWhen: content =>
            content.includes("Discordmaxxer: read the expanded-folder store directly.") ||
            content.includes("Discordmaxxer: restore catalog folder IDs."),
        marker: "Discordmaxxer: guard folder sidebar store transitions.",
        find:
            "function getExpandedFolderIds() {\n" +
            "    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders();\n" +
            "    const folders = SortedGuildStore.getGuildFolders();\n\n" +
            "    const expandedFolderIds = new Set<string>();\n\n" +
            "    for (const folder of folders) {\n" +
            "        const folderRecord = folder as any;\n" +
            "        const folderId = normalizeFolderId(folderRecord.folderId ?? folderRecord.id ?? folderRecord.folder?.id);\n" +
            "        const guildIds = folderRecord.guildIds ?? folderRecord.guilds?.map((guild: any) => guild.id ?? guild);\n" +
            "        if (folderId && (isFolderExpandedId(folderId) || hasFolderId(expandedFolders, folderId)) && guildIds?.length) {\n" +
            "            expandedFolderIds.add(folderId);\n" +
            "        }\n" +
            "    }\n\n" +
            "    return expandedFolderIds;\n" +
            "}",
        replace:
            "function getExpandedFolderIds() {\n" +
            "    // Discordmaxxer: read the expanded-folder store directly. Do not\n" +
            "    // intersect it with SortedGuildStore during a click transition: Discord\n" +
            "    // can publish those stores on adjacent React commits, which made the\n" +
            "    // folder sidebar disappear even though the folder was open.\n" +
            "    try {\n" +
            "        const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders?.();\n" +
            "        const expandedFolderIds = new Set<string>();\n" +
            "        if (expandedFolders && typeof (expandedFolders as any)[Symbol.iterator] === \"function\") {\n" +
            "            for (const id of expandedFolders as Iterable<unknown>) {\n" +
            "                const normalized = normalizeFolderId(id);\n" +
            "                if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "            }\n" +
            "        }\n\n" +
            "        if (expandedFolders && typeof expandedFolders === \"object\" && typeof (expandedFolders as any)[Symbol.iterator] !== \"function\") {\n" +
            "            for (const [id, entry] of Object.entries(expandedFolders as any)) {\n" +
            "                if (entry !== false) {\n" +
            "                    const normalized = normalizeFolderId(id);\n" +
            "                    if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "                }\n" +
            "            }\n" +
            "        }\n\n" +
            "        return expandedFolderIds;\n" +
            "    } catch (error) {\n" +
            "        console.warn(\"[Discordmaxxer] BetterFolders state unavailable; keeping the sidebar interactive.\", error);\n" +
            "        return new Set<string>();\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: restore catalog folder IDs."),
        marker: "Discordmaxxer: restore catalog folder IDs.",
        find:
            "        const expandedFolderIds = new Set<string>();\n" +
            "        if (expandedFolders && typeof (expandedFolders as any)[Symbol.iterator] === \"function\") {\n" +
            "            for (const id of expandedFolders as Iterable<unknown>) {\n" +
            "                const normalized = normalizeFolderId(id);\n" +
            "                if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "            }\n" +
            "        }\n\n" +
            "        if (expandedFolders && typeof expandedFolders === \"object\" && typeof (expandedFolders as any)[Symbol.iterator] !== \"function\") {\n" +
            "            for (const [id, entry] of Object.entries(expandedFolders as any)) {\n" +
            "                if (entry !== false) {\n" +
            "                    const normalized = normalizeFolderId(id);\n" +
            "                    if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "                }\n" +
            "            }\n" +
            "        }\n",
        replace:
            "        const expandedFolderIds = new Set<string>();\n\n" +
            "        const folders = SortedGuildStore.getGuildFolders?.();\n" +
            "        if (folders && typeof (folders as any)[Symbol.iterator] === \"function\") {\n" +
            "            for (const folder of folders as Iterable<unknown>) {\n" +
            "                const folderRecord = folder as any;\n" +
            "                const folderId = normalizeFolderId(\n" +
            "                    folderRecord?.folderId ??\n" +
            "                    folderRecord?.id ??\n" +
            "                    folderRecord?.folder?.id ??\n" +
            "                    folderRecord?.folderNode?.folderId,\n" +
            "                );\n" +
            "                const guildIds =\n" +
            "                    folderRecord?.guildIds ??\n" +
            "                    folderRecord?.guildIdsInFolder ??\n" +
            "                    folderRecord?.guilds?.map((guild: any) => guild?.id ?? guild);\n\n" +
            "                if (\n" +
            "                    folderId &&\n" +
            "                    (isFolderExpandedId(folderId) || hasFolderId(expandedFolders, folderId)) &&\n" +
            "                    (!guildIds || guildIds.length > 0)\n" +
            "                ) {\n" +
            "                    expandedFolderIds.add(folderId);\n" +
            "                }\n" +
            "            }\n" +
            "        }\n\n" +
            "        // Fallback for Discord revisions where the catalog is not ready yet,\n" +
            "        // or where the store returns raw IDs instead of folder records.\n" +
            "        if (expandedFolderIds.size === 0) {\n" +
            "            if (expandedFolders && typeof (expandedFolders as any)[Symbol.iterator] === \"function\") {\n" +
            "                for (const id of expandedFolders as Iterable<unknown>) {\n" +
            "                    const normalized = normalizeFolderId(id);\n" +
            "                    if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "                }\n" +
            "            }\n" +
            "            if (\n" +
            "                expandedFolders &&\n" +
            "                typeof expandedFolders === \"object\" &&\n" +
            "                typeof (expandedFolders as any)[Symbol.iterator] !== \"function\"\n" +
            "            ) {\n" +
            "                for (const [id, entry] of Object.entries(expandedFolders as any)) {\n" +
            "                    if (entry !== false) {\n" +
            "                        const normalized = normalizeFolderId(id);\n" +
            "                        if (normalized !== null) expandedFolderIds.add(normalized);\n" +
            "                    }\n" +
            "                }\n" +
            "            }\n" +
            "        }\n",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        obsoleteWhen: content => content.includes("Discordmaxxer: isolate catalog lookup during transitions."),
        marker: "Discordmaxxer: isolate catalog lookup during transitions.",
        find: "        const folders = SortedGuildStore.getGuildFolders?.();",
        replace:
            "        // Discordmaxxer: isolate catalog lookup during transitions.\n" +
            "        let folders: Iterable<unknown> | null = null;\n" +
            "        try {\n" +
            "            folders = SortedGuildStore.getGuildFolders?.() as Iterable<unknown> | null;\n" +
            "        } catch {\n" +
            "            // The sorted-guild catalog can be unavailable for one render commit.\n" +
            "        }",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        obsoleteWhen: content => content.includes("Discordmaxxer: guard FolderSideBar DOM lookup."),
        find: "    const guilds = document.querySelector(guildsBarProps.className.split(\" \").map(c => \`.\${c}\`).join(\"\"));",
        find: "    const guilds = document.querySelector(guildsBarProps.className.split(\" \").map(c => \`.\${c}\`).join(\"\"));",
        replace:
            "    // Discordmaxxer: guard FolderSideBar DOM lookup.\n" +
            "    // Discord can render this helper during a route transition with partial\n" +
            "    // props. A missing/invalid className must not take down the renderer.\n" +
            "    let guilds: Element | null = null;\n" +
            "    try {\n" +
            "        const className = typeof guildsBarProps?.className === \"string\" ? guildsBarProps.className : \"\";\n" +
            "        if (className) guilds = document.querySelector(className.split(\" \").filter(Boolean).map(c => \`.\${c}\`).join(\"\"));\n" +
            "    } catch {\n" +
            "        guilds = null;\n" +
            "    }",
    },
    // Plugin info modals must not construct Discord User records just to show
    // authors. The native summary/avatar path is both visually oversized in
    // this client and unsafe for plugin manifests with partial author data;
    // static metadata chips are compact, non-interactive, and cannot open the
    // contributor modal crash path.
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: compact static plugin authors.",
        find:
            "                            <div style={{ display: \"flex\", alignItems: \"center\", gap: 4 }}>\n" +
            "                                {(authors.length ? authors : fallbackAuthors).slice(0, 6).map((user, index) => {\n" +
            "                                    const avatarUrl = typeof user.getAvatarURL === \"function\"\n" +
            "                                        ? user.getAvatarURL(void 0, 80, true)\n" +
            "                                        : undefined;\n" +
            "                                    const username = user.username ?? \"Contributor\";\n" +
            "                                    return (\n" +
            "                                        <Clickable\n" +
            "                                            key={String(user.id ?? username ?? index)}\n" +
            "                                            className={AvatarStyles.clickableAvatar}\n" +
            "                                            onClick={() => openContributorModal(user as User)}\n" +
            "                                        >\n" +
            "                                            {avatarUrl ? (\n" +
            "                                                <img\n" +
            "                                                    className={AvatarStyles.avatar}\n" +
            "                                                    src={avatarUrl}\n" +
            "                                                    alt={username}\n" +
            "                                                    title={username}\n" +
            "                                                />\n" +
            "                                            ) : (\n" +
            "                                                <div\n" +
            "                                                    className={AvatarStyles.avatar}\n" +
            "                                                    aria-label={username}\n" +
            "                                                    title={username}\n" +
            "                                                    style={{ display: \"grid\", placeItems: \"center\", background: \"var(--background-secondary)\" }}\n" +
            "                                                >\n" +
            "                                                    ?\n" +
            "                                                </div>\n" +
            "                                            )}\n" +
            "                                        </Clickable>\n" +
            "                                    );\n" +
            "                                })}\n" +
            "                                {pluginAuthors.length > 6 && renderMoreUsers(\"\", 6)}\n" +
            "                            </div>",
        replace:
            "                            {/* Discordmaxxer: compact static plugin authors. */}\n" +
            "                            <div\n" +
            "                                aria-label={`Plugin authors: ${pluginAuthors.map(author => author.name).join(\", \") || \"Discordmaxxer team\"}`}\n" +
            "                                style={{ display: \"flex\", flexWrap: \"wrap\", alignItems: \"center\", gap: 6, maxWidth: \"100%\" }}\n" +
            "                            >\n" +
            "                                {pluginAuthors.length ? pluginAuthors.slice(0, 8).map((author, index) => {\n" +
            "                                    const name = author.name.trim();\n" +
            "                                    return (\n" +
            "                                        <span\n" +
            "                                            key={name + \"-\" + index}\n" +
            "                                            title={name}\n" +
            "                                            style={{ display: \"inline-flex\", alignItems: \"center\", maxWidth: \"100%\", padding: \"4px 8px\", borderRadius: 9999, background: \"var(--background-secondary-alt)\", color: \"var(--text-normal)\", fontSize: 12, lineHeight: \"16px\", whiteSpace: \"nowrap\", overflow: \"hidden\", textOverflow: \"ellipsis\" }}\n" +
            "                                        >\n" +
            "                                            {name}\n" +
            "                                        </span>\n" +
            "                                    );\n" +
            "                                }) : (\n" +
            "                                    <span style={{ padding: \"4px 8px\", borderRadius: 9999, background: \"var(--background-secondary-alt)\", color: \"var(--text-muted)\", fontSize: 12 }}>Discordmaxxer team</span>\n" +
            "                                )}\n" +
            "                                {pluginAuthors.length > 8 && (\n" +
            "                                    <span style={{ padding: \"4px 8px\", borderRadius: 9999, background: \"var(--background-secondary-alt)\", color: \"var(--text-muted)\", fontSize: 12 }}>+{pluginAuthors.length - 8}</span>\n" +
            "                                )}\n" +
            "                            </div>"
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: remove unsafe plugin author construction.",
        find:
            "const AvatarStyles = findCssClassesLazy(\"moreUsers\", \"avatar\", \"clickableAvatar\");\n" +
            "const UserRecord: Constructor<Partial<User>> = proxyLazy(() => UserStore.getCurrentUser().constructor) as any;\n\n",
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: remove dummy plugin author records.",
        find:
            "function makeDummyUser(user: { username: string; id?: string; avatar?: string; }) {\n" +
            "    const newUser = new UserRecord({\n" +
            "        username: user.username,\n" +
            "        id: user.id ?? generateId(),\n" +
            "        avatar: user.avatar,\n" +
            "        /** To stop discord making unwanted requests... */\n" +
            "        bot: true,\n" +
            "    });\n\n" +
            "    FluxDispatcher.dispatch({\n" +
            "        type: \"USER_UPDATE\",\n" +
            "        user: newUser,\n" +
            "    });\n\n" +
            "    return newUser;\n" +
            "}\n\n",
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: remove async plugin author loading.",
        find:
            "    // avoid layout shift by showing dummy users while loading users\n" +
            "    const fallbackAuthors = useMemo(() => [makeDummyUser({ username: \"Loading...\", id: \"-1465912127305809920\" })], []);\n" +
            "    const [authors, setAuthors] = useState<Partial<User>[]>([]);\n\n" +
            "    useEffect(() => {\n" +
            "        (async () => {\n" +
            "            for (const user of pluginAuthors.slice(0, 6)) {\n" +
            "                try {\n" +
            "                    const author = user.id\n" +
            "                        ? await UserUtils.getUser(String(user.id))\n" +
            "                            .catch(() => makeDummyUser({ username: user.name }))\n" +
            "                        : makeDummyUser({ username: user.name });\n\n" +
            "                    setAuthors(a => [...a, author]);\n" +
            "                } catch (e) {\n" +
            "                    continue;\n" +
            "                }\n" +
            "            }\n" +
            "        })();\n" +
            "    }, [pluginAuthors]);\n\n",
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: remove plugin author overflow renderer.",
        find:
            "    function renderMoreUsers(_label: string, count: number) {\n" +
            "        // Discordmaxxer: render only valid plugin author overflow.\n" +
            "        const sliceCount = Math.max(pluginAuthors.length - count, 0);\n" +
            "        if (!sliceCount) return null;\n\n" +
            "        const sliceStart = pluginAuthors.length - sliceCount;\n" +
            "        const sliceEnd = sliceStart + sliceCount;\n\n" +
            "        return (\n" +
            "            <Tooltip text={pluginAuthors.slice(sliceStart, sliceEnd).map(u => u.name).join(\", \")}>\n" +
            "                {({ onMouseEnter, onMouseLeave }) => (\n" +
            "                    <div\n" +
            "                        className={AvatarStyles.moreUsers}\n" +
            "                        onMouseEnter={onMouseEnter}\n" +
            "                        onMouseLeave={onMouseLeave}\n" +
            "                    >\n" +
            "                        +{sliceCount}\n" +
            "                    </div>\n" +
            "                )}\n" +
            "            </Tooltip>\n" +
            "        );\n" +
            "    }\n\n",
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { openContributorModal } from "./ContributorModal";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        marker: "Discordmaxxer: remove remaining unsafe author imports.",
        find: 'import { generateId } from "@api/Commands";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { proxyLazy } from "@utils/lazy";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { User } from "@vencord/discord-types";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { findCssClassesLazy } from "@webpack";\n',
        replace: ""
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { Clickable, FluxDispatcher, Forms, React, Text, Tooltip, useEffect, useMemo, UserStore, UserUtils, useState } from "@webpack/common";\n',
        replace: 'import { Forms, React, Text, useEffect, useMemo } from "@webpack/common";\n'
    },
    {
        file: "src/components/settings/tabs/plugins/PluginModal.tsx",
        find: 'import { Constructor } from "type-fest";\n',
        replace: ""
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: BetterFolders normalized ID helpers.") &&
            content.includes("normalizeFolderId(guildId)"),
        marker: "Discordmaxxer: stable-safe BetterFolders guild lookup.",
        find:
            "function getGuildFolder(id: string) {\n" +
            "    return SortedGuildStore.getGuildFolders().find(folder => folder.guildIds.includes(id));\n" +
            "}",
        replace:
            "function getGuildFolder(id: string | null | undefined) {\n" +
            "    if (!id) return undefined;\n" +
            "    try {\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        return Array.isArray(folders) ? folders.find(folder => folder?.guildIds?.includes(id)) : undefined;\n" +
            "    } catch {\n" +
            "        // DM/group routes can publish a partial guild store for one tick.\n" +
            "        return undefined;\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders close.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder lifecycle untouched.") ||
            content.includes("Discordmaxxer: close folder store transitions safely.") ||
            content.includes("Discordmaxxer: stable-safe BetterFolders close."),
        find:
            "function closeFolders() {\n" +
            "    for (const id of ExpandedGuildFolderStore.getExpandedFolders())\n" +
            "        FolderUtils.toggleGuildFolderExpand(id);\n" +
            "}",
        replace:
            "function closeFolders() {\n" +
            "    try {\n" +
            "        const expanded = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "        if (!expanded || typeof expanded[Symbol.iterator] !== \"function\") return;\n" +
            "        for (const id of expanded) {\n" +
            "            try {\n" +
            "                FolderUtils.toggleGuildFolderExpand(id);\n" +
            "            } catch {\n" +
            "                // A folder can disappear while Discord changes routes.\n" +
            "            }\n" +
            "        }\n" +
            "    } catch {\n" +
            "        // A partial folder store must not take down the renderer.\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders route selection.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder route selection untouched.") ||
            content.includes("Discordmaxxer: keep route selection native.") ||
            content.includes("Discordmaxxer: native DM route ownership.") ||
            content.includes("Discordmaxxer: stable-safe BetterFolders route selection."),
        find:
            "        CHANNEL_SELECT(data) {\n" +
            "            if (!settings.store.closeAllFolders && !settings.store.forceOpen)\n" +
            "                return;\n\n" +
            "            if (lastGuildId !== data.guildId) {\n" +
            "                lastGuildId = data.guildId;\n" +
            "                const guildFolder = getGuildFolder(data.guildId);\n\n" +
            "                if (guildFolder?.folderId) {\n" +
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore.isFolderExpanded(guildFolder.folderId)) {\n" +
            "                        FolderUtils.toggleGuildFolderExpand(guildFolder.folderId);\n" +
            "                    }\n" +
            "                } else if (settings.store.closeAllFolders) {\n" +
            "                    closeFolders();\n" +
            "                }\n" +
            "            }\n" +
            "        },",
        replace:
            "        CHANNEL_SELECT(data) {\n" +
            "            try {\n" +
            "                if (!settings.store.closeAllFolders && !settings.store.forceOpen) return;\n" +
            "                const guildId = data?.guildId;\n" +
            "                if (lastGuildId === guildId) return;\n" +
            "                lastGuildId = guildId ?? null;\n" +
            "                const guildFolder = getGuildFolder(guildId);\n" +
            "                if (guildFolder?.folderId) {\n" +
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore?.isFolderExpanded?.(guildFolder.folderId)) {\n" +
            "                        try { FolderUtils.toggleGuildFolderExpand(guildFolder.folderId); } catch { /* fail open */ }\n" +
            "                    }\n" +
            "                } else if (settings.store.closeAllFolders) {\n" +
            "                    closeFolders();\n" +
            "                }\n" +
            "            } catch {\n" +
            "                // DM/group-chat selection is not a guild-folder transition.\n" +
            "            }\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders folder toggle.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: leave native folder toggle untouched.") ||
            content.includes("Discordmaxxer: keep folder toggle native.") ||
            content.includes("Discordmaxxer: native folder expansion ownership.") ||
            content.includes("Discordmaxxer: stable-safe BetterFolders folder toggle."),
        find:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders();\n\n" +
            "                    if (expandedFolders.size > 1) {\n" +
            "                        for (const id of expandedFolders) if (id !== data.folderId)\n" +
            "                            FolderUtils.toggleGuildFolderExpand(id);\n" +
            "                    }\n\n" +
            "                    dispatchingFoldersClose = false;\n" +
            "                });\n" +
            "            }\n" +
            "        },",
        replace:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "                        const expandedIds = expandedFolders && typeof expandedFolders[Symbol.iterator] === \"function\"\n" +
            "                            ? [...expandedFolders]\n" +
            "                            : [];\n" +
            "                        if (expandedIds.length > 1) {\n" +
            "                            for (const id of expandedIds) if (id !== data?.folderId) {\n" +
            "                                try { FolderUtils.toggleGuildFolderExpand(id); } catch { /* fail open */ }\n" +
            "                            }\n" +
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partial store must not crash folder clicks.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });\n" +
            "            }\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: fail open during a renderer transition.") &&
            content.includes("hasFolderId(expandedFolderIds"),
        marker: "Discordmaxxer: stable-safe BetterFolders node guard.",
        find:
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            node.type === \"folder\" && expandedFolderIds?.has(node.id) ||\n" +
            "            node.type === \"guild\" && expandedFolderIds?.has(node.parentId)\n" +
            "        ) {",
        replace:
            "        const nodeType = node?.type;\n" +
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            nodeType == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" && expandedFolderIds?.has(node.id) ||\n" +
            "            nodeType === \"guild\" && expandedFolderIds?.has(node.parentId)\n" +
            "        ) {",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders sidebar stores.",
        find:
            "function getExpandedFolderIds() {\n" +
            "    const expandedFolders = ExpandedGuildFolderStore.getExpandedFolders();\n" +
            "    const folders = SortedGuildStore.getGuildFolders();\n\n" +
            "    const expandedFolderIds = new Set<string>();\n\n" +
            "    for (const folder of folders) {\n" +
            "        if (expandedFolders.has(folder.folderId) && folder.guildIds?.length) {\n" +
            "            expandedFolderIds.add(folder.folderId);\n" +
            "        }\n" +
            "    }\n\n" +
            "    return expandedFolderIds;\n" +
            "}",
        replace:
            "function getExpandedFolderIds() {\n" +
            "    try {\n" +
            "        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        if (!expandedFolders || typeof expandedFolders.has !== \"function\" || !Array.isArray(folders)) return new Set<string>();\n\n" +
            "        const expandedFolderIds = new Set<string>();\n" +
            "        for (const folder of folders) {\n" +
            "            if (folder?.folderId && expandedFolders.has(folder.folderId) && folder.guildIds?.length) {\n" +
            "                expandedFolderIds.add(folder.folderId);\n" +
            "            }\n" +
            "        }\n\n" +
            "        return expandedFolderIds;\n" +
            "    } catch {\n" +
            "        // Keep the native Discord shell alive while stores settle.\n" +
            "        return new Set<string>();\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: BetterFolders normalized ID helpers.") &&
            content.includes("normalizeFolderId(guildId)"),
        marker: "Discordmaxxer: stable-safe BetterFolders normalized IDs.",
        find:
            "function getGuildFolder(id: string | null | undefined) {\n" +
            "    if (!id) return undefined;\n" +
            "    try {\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        return Array.isArray(folders) ? folders.find(folder => folder?.guildIds?.includes(id)) : undefined;\n" +
            "    } catch {\n" +
            "        // DM/group routes can publish a partial guild store for one tick.\n" +
            "        return undefined;\n" +
            "    }\n" +
            "}\n",
        replace:
            "function getGuildFolder(id: string | null | undefined) {\n" +
            "    if (typeof id !== \"string\" || id.length === 0) return undefined;\n" +
            "    try {\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        return Array.isArray(folders)\n" +
            "            ? folders.find(folder => Array.isArray(folder?.guildIds) && folder.guildIds.some(guildId => String(guildId) === id))\n" +
            "            : undefined;\n" +
            "    } catch {\n" +
            "        // DM/group routes can publish a partial guild store for one tick.\n" +
            "        return undefined;\n" +
            "    }\n" +
            "}\n\n" +
            "function isExpandedFolderId(expandedFolderIds: Set<any> | undefined, value: unknown) {\n" +
            "    if (!expandedFolderIds || value == null) return false;\n" +
            "    try {\n" +
            "        return expandedFolderIds.has(value) || expandedFolderIds.has(String(value));\n" +
            "    } catch {\n" +
            "        return false;\n" +
            "    }\n" +
            "}\n",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders DM route guard.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: leave native folder route selection untouched.") ||
            content.includes("Discordmaxxer: keep route selection native.") ||
            content.includes("Discordmaxxer: native DM route ownership.") ||
            content.includes("CHANNEL_SELECT()"),
        find:
            "        CHANNEL_SELECT(data) {\n" +
            "            try {\n" +
            "                if (!settings.store.closeAllFolders && !settings.store.forceOpen) return;\n" +
            "                const guildId = data?.guildId;\n" +
            "                if (lastGuildId === guildId) return;\n" +
            "                lastGuildId = guildId ?? null;\n" +
            "                const guildFolder = getGuildFolder(guildId);\n" +
            "                if (guildFolder?.folderId) {\n" +
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore?.isFolderExpanded?.(guildFolder.folderId)) {\n" +
            "                        try { FolderUtils.toggleGuildFolderExpand(guildFolder.folderId); } catch { /* fail open */ }\n" +
            "                    }\n" +
            "                } else if (settings.store.closeAllFolders) {\n" +
            "                    closeFolders();\n" +
            "                }\n" +
            "            } catch {\n" +
            "                // DM/group-chat selection is not a guild-folder transition.\n" +
            "            }\n" +
            "        },",
        replace:
            "        CHANNEL_SELECT(data) {\n" +
            "            try {\n" +
            "                if (!settings.store.closeAllFolders && !settings.store.forceOpen) return;\n" +
            "                const guildId = data?.guildId;\n" +
            "                // DM and group-DM selections do not have a guild folder. Do not\n" +
            "                // query or mutate the folder stores during that route transition.\n" +
            "                if (typeof guildId !== \"string\" || guildId.length === 0) {\n" +
            "                    lastGuildId = null;\n" +
            "                    return;\n" +
            "                }\n" +
            "                if (lastGuildId === guildId) return;\n" +
            "                lastGuildId = guildId;\n" +
            "                const guildFolder = getGuildFolder(guildId);\n" +
            "                if (guildFolder?.folderId) {\n" +
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore?.isFolderExpanded?.(guildFolder.folderId)) {\n" +
            "                        try { FolderUtils.toggleGuildFolderExpand(guildFolder.folderId); } catch { /* fail open */ }\n" +
            "                    }\n" +
            "                } else if (settings.store.closeAllFolders) {\n" +
            "                    closeFolders();\n" +
            "                }\n" +
            "            } catch {\n" +
            "                // DM/group-chat selection is not a guild-folder transition.\n" +
            "            }\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders toggle payload.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: leave native folder toggle untouched.") ||
            content.includes("Discordmaxxer: keep folder toggle native.") ||
            content.includes("Discordmaxxer: native folder expansion ownership.") ||
            content.includes("TOGGLE_GUILD_FOLDER_EXPAND()"),
        find:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "                        const expandedIds = expandedFolders && typeof expandedFolders[Symbol.iterator] === \"function\"\n" +
            "                            ? [...expandedFolders]\n" +
            "                            : [];\n" +
            "                        if (expandedIds.length > 1) {\n" +
            "                            for (const id of expandedIds) if (id !== data?.folderId) {\n" +
            "                                try { FolderUtils.toggleGuildFolderExpand(id); } catch { /* fail open */ }\n" +
            "                            }\n" +
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partial store must not crash folder clicks.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });\n" +
            "            }\n" +
            "        },",
        replace:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (data?.folderId == null) return;\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "                        const expandedIds = expandedFolders && typeof expandedFolders[Symbol.iterator] === \"function\"\n" +
            "                            ? [...expandedFolders]\n" +
            "                            : [];\n" +
            "                        if (expandedIds.length > 1) {\n" +
            "                            for (const id of expandedIds) if (String(id) !== String(data.folderId)) {\n" +
            "                                try { FolderUtils.toggleGuildFolderExpand(id); } catch { /* fail open */ }\n" +
            "                            }\n" +
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partial store must not crash folder clicks.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });\n" +
            "            }\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: fail open during a renderer transition.") &&
            content.includes("expandedFolderIds == null") &&
            content.includes("hasFolderId(expandedFolderIds"),
        marker: "Discordmaxxer: stable-safe BetterFolders render fallback.",
        find:
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            nodeType == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" && expandedFolderIds?.has(node.id) ||\n" +
            "            nodeType === \"guild\" && expandedFolderIds?.has(node.parentId)\n" +
            "        ) {",
        replace:
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            expandedFolderIds == null ||\n" +
            "            nodeType == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" && isExpandedFolderId(expandedFolderIds, node.id) ||\n" +
            "            nodeType === \"guild\" && isExpandedFolderId(expandedFolderIds, node.parentId)\n" +
            "        ) {",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: stable-safe BetterFolders expanded ID normalization.",
        find:
            "function getExpandedFolderIds() {\n" +
            "    try {\n" +
            "        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        if (!expandedFolders || typeof expandedFolders.has !== \"function\" || !Array.isArray(folders)) return new Set<string>();\n\n" +
            "        const expandedFolderIds = new Set<string>();\n" +
            "        for (const folder of folders) {\n" +
            "            if (folder?.folderId && expandedFolders.has(folder.folderId) && folder.guildIds?.length) {\n" +
            "                expandedFolderIds.add(folder.folderId);\n" +
            "            }\n" +
            "        }\n\n" +
            "        return expandedFolderIds;\n" +
            "    } catch {\n" +
            "        // Keep the native Discord shell alive while stores settle.\n" +
            "        return new Set<string>();\n" +
            "    }\n" +
            "}",
        replace:
            "function normalizedId(value: unknown): string | null {\n" +
            "    if (value == null) return null;\n" +
            "    if (typeof value === \"object\") {\n" +
            "        const record = value as Record<string, unknown>;\n" +
            "        value = record.folderId ?? record.id ?? record.guildId;\n" +
            "    }\n" +
            "    return value == null ? null : String(value);\n" +
            "}\n\n" +
            "function collectExpandedIds(expandedFolders: unknown) {\n" +
            "    const ids = new Set<string>();\n" +
            "    const add = (value: unknown) => {\n" +
            "        const id = normalizedId(value);\n" +
            "        if (id) ids.add(id);\n" +
            "    };\n\n" +
            "    try {\n" +
            "        if (expandedFolders && typeof (expandedFolders as any)[Symbol.iterator] === \"function\") {\n" +
            "            for (const entry of expandedFolders as Iterable<unknown>) {\n" +
            "                if (Array.isArray(entry)) {\n" +
            "                    if (entry[1] === false) continue;\n" +
            "                    add(entry[0]);\n" +
            "                } else {\n" +
            "                    add(entry);\n" +
            "                }\n" +
            "            }\n" +
            "        } else if (expandedFolders && typeof expandedFolders === \"object\") {\n" +
            "            for (const [key, value] of Object.entries(expandedFolders)) {\n" +
            "                if (value !== false) add(key);\n" +
            "            }\n" +
            "        }\n" +
            "    } catch {\n" +
            "        // Store shape can be partial during startup or a route transition.\n" +
            "    }\n\n" +
            "    return ids;\n" +
            "}\n\n" +
            "function getExpandedFolderIds() {\n" +
            "    try {\n" +
            "        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        const rawExpandedIds = collectExpandedIds(expandedFolders);\n" +
            "        if (!Array.isArray(folders)) return rawExpandedIds;\n\n" +
            "        const expandedFolderIds = new Set<string>();\n" +
            "        for (const folder of folders) {\n" +
            "            const folderId = normalizedId(folder?.folderId ?? folder?.id);\n" +
            "            if (folderId && rawExpandedIds.has(folderId) && Array.isArray(folder?.guildIds) && folder.guildIds.length) {\n" +
            "                expandedFolderIds.add(folderId);\n" +
            "            }\n" +
            "        }\n\n" +
            "        // If Discord has published the expanded IDs before its sorted guild\n" +
            "        // catalog, retain them for this render. The store subscription will\n" +
            "        // reconcile the catalog on the next update instead of hiding the\n" +
            "        // folder sidebar permanently.\n" +
            "        return expandedFolderIds.size ? expandedFolderIds : rawExpandedIds;\n" +
            "    } catch {\n" +
            "        // Keep the native Discord shell alive while stores settle.\n" +
            "        return new Set<string>();\n" +
            "    }\n" +
            "}",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: native DM route ownership.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: native DM route ownership.") ||
            content.includes("Discordmaxxer: leave native folder route selection untouched.") ||
            content.includes("Discordmaxxer: keep route selection native.") ||
            (!content.includes("lastGuildId") && content.includes("CHANNEL_SELECT()")),
        find:
            "        CHANNEL_SELECT(data) {\n" +
            "            try {\n" +
            "                if (!settings.store.closeAllFolders && !settings.store.forceOpen) return;\n" +
            "                const guildId = data?.guildId;\n" +
            "                // DM and group-DM selections do not have a guild folder. Do not\n" +
            "                // query or mutate the folder stores during that route transition.\n" +
            "                if (typeof guildId !== \"string\" || guildId.length === 0) {\n" +
            "                    lastGuildId = null;\n" +
            "                    return;\n" +
            "                }\n" +
            "                if (lastGuildId === guildId) return;\n" +
            "                lastGuildId = guildId;\n" +
            "                const guildFolder = getGuildFolder(guildId);\n" +
            "                if (guildFolder?.folderId) {\n" +
            "                    if (settings.store.forceOpen && !ExpandedGuildFolderStore?.isFolderExpanded?.(guildFolder.folderId)) {\n" +
            "                        try { FolderUtils.toggleGuildFolderExpand(guildFolder.folderId); } catch { /* fail open */ }\n" +
            "                    }\n" +
            "                } else if (settings.store.closeAllFolders) {\n" +
            "                    closeFolders();\n" +
            "                }\n" +
            "            } catch {\n" +
            "                // DM/group-chat selection is not a guild-folder transition.\n" +
            "            }\n" +
            "        },",
        replace:
            "        CHANNEL_SELECT() {\n" +
            "            // Discordmaxxer: native DM route ownership.\n" +
            "            // DM and group-DM navigation belongs entirely to Discord.\n" +
            "            // BetterFolders must not inspect guild stores on this event.\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: native folder expansion ownership.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: native folder expansion ownership.") ||
            content.includes("Discordmaxxer: leave native folder toggle untouched.") ||
            content.includes("Discordmaxxer: keep folder toggle native.") ||
            (!content.includes("dispatchingFoldersClose") && content.includes("TOGGLE_GUILD_FOLDER_EXPAND()")),
        find:
            "        TOGGLE_GUILD_FOLDER_EXPAND(data) {\n" +
            "            if (data?.folderId == null) return;\n" +
            "            if (settings.store.closeOthers && !dispatchingFoldersClose) {\n" +
            "                dispatchingFoldersClose = true;\n" +
            "                FluxDispatcher.wait(() => {\n" +
            "                    try {\n" +
            "                        const expandedFolders = ExpandedGuildFolderStore?.getExpandedFolders?.();\n" +
            "                        const expandedIds = expandedFolders && typeof expandedFolders[Symbol.iterator] === \"function\"\n" +
            "                            ? [...expandedFolders]\n" +
            "                            : [];\n" +
            "                        if (expandedIds.length > 1) {\n" +
            "                            for (const id of expandedIds) if (String(id) !== String(data.folderId)) {\n" +
            "                                try { FolderUtils.toggleGuildFolderExpand(id); } catch { /* fail open */ }\n" +
            "                            }\n" +
            "                        }\n" +
            "                    } catch {\n" +
            "                        // A partial store must not crash folder clicks.\n" +
            "                    } finally {\n" +
            "                        dispatchingFoldersClose = false;\n" +
            "                    }\n" +
            "                });\n" +
            "            }\n" +
            "        },",
        replace:
            "        TOGGLE_GUILD_FOLDER_EXPAND() {\n" +
            "            // Discordmaxxer: native folder expansion ownership.\n" +
            "            // BetterFolders never dispatches a second toggle. The sidebar\n" +
            "            // observes Discord's native action as a render fallback.\n" +
            "        },",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        find: 'import { FluxDispatcher } from "@webpack/common";\n',
        replace: "",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        find: "let lastGuildId = null as string | null;\nlet dispatchingFoldersClose = false;\n\n",
        replace: "",
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        find:
            "function getGuildFolder(id: string | null | undefined) {\n" +
            "    if (typeof id !== \"string\" || id.length === 0) return undefined;\n" +
            "    try {\n" +
            "        const folders = SortedGuildStore?.getGuildFolders?.();\n" +
            "        return Array.isArray(folders)\n" +
            "            ? folders.find(folder => Array.isArray(folder?.guildIds) && folder.guildIds.some(guildId => String(guildId) === id))\n" +
            "            : undefined;\n" +
            "    } catch {\n" +
            "        // DM/group routes can publish a partial guild store for one tick.\n" +
            "        return undefined;\n" +
            "    }\n" +
            "}\n",
        replace: "",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: native folder toggle render fallback import.",
        alreadyAppliedWhen: content => content.includes("FluxDispatcher.subscribe(\"TOGGLE_GUILD_FOLDER_EXPAND\"") ,
        find: 'import { Animations, ChannelRTCStore, useStateFromStores } from "@webpack/common";',
        replace:
            'import { Animations, ChannelRTCStore, FluxDispatcher, useEffect, useState, useStateFromStores } from "@webpack/common";\n' +
            "// Discordmaxxer: native folder toggle render fallback import.\n",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: guard unsupported custom folder sidebar.",
        alreadyAppliedWhen: content => content.includes("DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED"),
        obsoleteWhen: content =>
            !content.includes('import { ExpandedGuildFolderStore, hasFolderId, normalizeFolderId, settings, SortedGuildStore } from ".";'),
        find: "import { ExpandedGuildFolderStore, hasFolderId, normalizeFolderId, settings, SortedGuildStore } from \".\";",
        replace: "import { DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED, ExpandedGuildFolderStore, hasFolderId, normalizeFolderId, settings, SortedGuildStore } from \".\";"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: use shared folder ID helper in toggle fallback.",
        alreadyAppliedWhen: content =>
            content.includes("const folderId = normalizeFolderId(data?.folderId ?? data?.id);") ||
            content.includes("const folderId = normalizedId(data?.folderId ?? data?.id);"),
        obsoleteWhen: content =>
            (content.includes("Discordmaxxer: native folder toggle render fallback.") &&
                content.includes("const folderId = normalizedId(data?.folderId ?? data?.id);")) ||
            content.includes("const expandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore], () => getExpandedFolderIds());"),
        find: "const folderId = normalizedId(data?.folderId ?? data?.id);",
        replace: "const folderId = normalizeFolderId(data?.folderId ?? data?.id);"
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: disable unsupported custom folder sidebar.",
        alreadyAppliedWhen: content =>
            content.includes("if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return null;") ||
            content.includes("Discordmaxxer: final custom folder sidebar capability guard."),
        obsoleteWhen: content =>
            (content.includes("const expandedFolderIds = new Set([...storeExpandedFolderIds, ...manualExpandedFolderIds]);") &&
                content.includes("const Sidebar = (") &&
                !content.includes("const isFullscreen = useStateFromStores([ChannelRTCStore], () => ChannelRTCStore.isFullscreenInContext());")) ||
            (content.includes("const expandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore], () => getExpandedFolderIds());") &&
                content.includes("const Sidebar = (")),
        find:
            "        } catch {\n" +
            "            // Discord can expose the dispatcher during plugin startup without\n" +
            "            // its subscription methods being ready for one render.\n" +
            "            return undefined;\n" +
            "        }\n" +
            "    }, []);\n\n" +
            "    const expandedFolderIds = new Set([...storeExpandedFolderIds, ...manualExpandedFolderIds]);\n" +
            "    const isFullscreen = useStateFromStores([ChannelRTCStore], () => ChannelRTCStore.isFullscreenInContext());\n\n" +
            "    const Sidebar = (",
        replace:
            "        } catch {\n" +
            "            // Discord can expose the dispatcher during plugin startup without\n" +
            "            // its subscription methods being ready for one render.\n" +
            "            return undefined;\n" +
            "        }\n" +
            "    }, []);\n\n" +
            "    const expandedFolderIds = new Set([...storeExpandedFolderIds, ...manualExpandedFolderIds]);\n" +
            "    const isFullscreen = useStateFromStores([ChannelRTCStore], () => ChannelRTCStore.isFullscreenInContext());\n\n" +
            "    // Discordmaxxer: the custom sidebar is intentionally unsupported until\n" +
            "    // the native folder contract is stable across client revisions.\n" +
            "    if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return null;\n\n" +
            "    const Sidebar = ("
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: native folder toggle render fallback.",
        alreadyAppliedWhen: content => content.includes("Discordmaxxer: native folder toggle render fallback."),
        obsoleteWhen: content =>
            content.includes("storeExpandedFolderIds") &&
            content.includes("FluxDispatcher.subscribe(\"TOGGLE_GUILD_FOLDER_EXPAND\""),
        find:
            "export default ErrorBoundary.wrap(guildsBarProps => {\n" +
            "    const expandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore], () => getExpandedFolderIds());",
        replace:
            "export default ErrorBoundary.wrap(guildsBarProps => {\n" +
            "    const storeExpandedFolderIds = useStateFromStores([ExpandedGuildFolderStore, SortedGuildStore], () => getExpandedFolderIds());\n" +
            "    const [manualExpandedFolderIds, setManualExpandedFolderIds] = useState<Set<string>>(() => new Set());\n\n" +
            "    // Discord's folder store can publish the toggle action before its public\n" +
            "    // selector has updated. Keep a render-only fallback for that transition;\n" +
            "    // the native store remains authoritative whenever it has the ID.\n" +
            "    // Discordmaxxer: native folder toggle render fallback.\n" +
            "    useEffect(() => {\n" +
            "        const onFolderToggle = (data: any) => {\n" +
            "            const folderId = normalizedId(data?.folderId ?? data?.id);\n" +
            "            if (!folderId) return;\n\n" +
            "            setManualExpandedFolderIds(previous => {\n" +
            "                const next = new Set(previous);\n" +
            "                if (data?.expanded === false) next.delete(folderId);\n" +
            "                else if (data?.expanded === true) next.add(folderId);\n" +
            "                else if (next.has(folderId)) next.delete(folderId);\n" +
            "                else next.add(folderId);\n" +
            "                return next;\n" +
            "            });\n" +
            "        };\n\n" +
            "        try {\n" +
            "            FluxDispatcher.subscribe(\"TOGGLE_GUILD_FOLDER_EXPAND\", onFolderToggle);\n" +
            "            return () => FluxDispatcher.unsubscribe(\"TOGGLE_GUILD_FOLDER_EXPAND\", onFolderToggle);\n" +
            "        } catch {\n" +
            "            // Discord can expose the dispatcher during plugin startup without\n" +
            "            // its subscription methods being ready for one render.\n" +
            "            return undefined;\n" +
            "        }\n" +
            "    }, []);\n\n" +
            "    const expandedFolderIds = new Set([...storeExpandedFolderIds, ...manualExpandedFolderIds]);",
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: final custom folder sidebar capability import.",
        alreadyAppliedWhen: content => content.includes("DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED"),
        find: 'import { ExpandedGuildFolderStore, settings, SortedGuildStore } from ".";',
        replace: 'import { DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED, ExpandedGuildFolderStore, settings, SortedGuildStore } from ".";'
    },
    {
        file: "src/plugins/betterFolders/FolderSideBar.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: final custom folder sidebar capability guard.",
        alreadyAppliedWhen: content => content.includes("if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return null;"),
        find: "    const Sidebar = (",
        replace:
            "    // Discordmaxxer: native Discord owns the folder child-row lifecycle.\n" +
            "    // Keep the optional custom sidebar fail-closed until its contract is stable.\n" +
            "    if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return null;\n\n" +
            "    const Sidebar = ("
    },
    {
        file: "src/plugins/betterFolders/index.tsx",
        allowOnStable: true,
        marker: "Discordmaxxer: fail open on empty folder state.",
        alreadyAppliedWhen: content =>
            content.includes("Discordmaxxer: fail open on empty folder state.") ||
            content.includes("Discordmaxxer: fail open during a renderer transition.") &&
            content.includes("expandedFolderIds == null"),
        obsoleteWhen: content =>
            content.includes("expandedFolderIds.size === 0") &&
            content.includes("expandedFolderIds == null"),
        find:
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            expandedFolderIds == null ||\n" +
            "            nodeType == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" && isExpandedFolderId(expandedFolderIds, node.id) ||\n" +
            "            nodeType === \"guild\" && isExpandedFolderId(expandedFolderIds, node.parentId)\n" +
            "        ) {",
        replace:
            "        if (\n" +
            "            !isBetterFolders ||\n" +
            "            expandedFolderIds == null ||\n" +
            "            // Discordmaxxer: fail open on empty folder state.\n" +
            "            // A transient empty store must not hide the native guild list.\n" +
            "            expandedFolderIds.size === 0 ||\n" +
            "            nodeType == null ||\n" +
            "            nodeType !== \"folder\" && nodeType !== \"guild\" ||\n" +
            "            nodeType === \"folder\" && isExpandedFolderId(expandedFolderIds, node.id) ||\n" +
            "            nodeType === \"guild\" && isExpandedFolderId(expandedFolderIds, node.parentId)\n" +
            "        ) {",
    },

    // ── SpotifyControls resilience ────────────────────────────────────
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: "device?.is_active === false",
        find: '    if (!track || !device?.is_active || shouldHide)\n        return null;',
        replace: '    if (!track || device?.is_active === false || shouldHide)\n        return null;'
    },
    {
        file: "src/plugins/spotifyControls/PlayerComponent.tsx",
        marker: 'data-dm-spotify-surface="true"',
        find:
            '    const exportTrackImageStyle = {\n' +
            '        "--vc-spotify-track-image": `url(${track?.album?.image?.url || ""})`,\n' +
            '    } as React.CSSProperties;\n' +
            '\n' +
            '    return (\n' +
            '        <div id={cl("player")} style={exportTrackImageStyle}>',
        replace:
            '    const exportTrackImageStyle = {\n' +
            '        "--vc-spotify-track-image": `url(${track?.album?.image?.url || ""})`,\n' +
            '    } as React.CSSProperties;\n' +
            '\n' +
            '    return (\n' +
            '        <div id={cl("player")} data-dm-spotify-surface="true" style={exportTrackImageStyle}>'
    },
    {
        file: "src/plugins/spotifyControls/SpotifyStore.ts",
        marker: "Discordmaxxer: Spotify track normalization",
        find:
            '    const store = new SpotifyStore(FluxDispatcher, {\n' +
            '        SPOTIFY_PLAYER_STATE(e: PlayerState) {\n' +
            '            store.track = e.track;\n' +
            '            store.device = e.device ?? null;\n' +
            '            store.isPlaying = e.isPlaying ?? false;\n' +
            '            store.volume = e.volumePercent ?? 0;\n' +
            '            store.repeat = e.actual_repeat || "off";\n' +
            '            store.shuffle = e.shuffle ?? false;\n' +
            '            store.position = e.position ?? 0;\n' +
            '            store.isSettingPosition = false;\n' +
            '            store.emitChange();\n' +
            '        },\n' +
            '        SPOTIFY_SET_DEVICES({ devices }: { devices: Device[]; }) {\n' +
            '            store.device = devices.find(d => d.is_active) ?? devices[0] ?? null;\n' +
            '            store.emitChange();\n' +
            '        }\n' +
            '    });',
        replace:
            '    // Discordmaxxer: Spotify track normalization v2.\n' +
            '    const normalizeTrack = (candidate: unknown): Track | null => {\n' +
            '        if (!candidate || typeof candidate !== "object") return null;\n' +
            '        const track = candidate as any;\n' +
            '        const id = typeof track.id === "string" ? track.id : typeof track.uri === "string" ? track.uri : "";\n' +
            '        if (!id) return null;\n' +
            '        const albumSource = track.album && typeof track.album === "object" ? track.album : {};\n' +
            '        const imageSource = albumSource.image && typeof albumSource.image === "object" ? albumSource.image : {};\n' +
            '        const artistsSource = Array.isArray(track.artists) ? track.artists : [];\n' +
            '        const artists = artistsSource.filter((artist: any) => artist && typeof artist.name === "string").map((artist: any) => ({\n' +
            '            ...artist,\n' +
            '            id: typeof artist.id === "string" ? artist.id : "",\n' +
            '            href: typeof artist.href === "string" ? artist.href : "",\n' +
            '            type: typeof artist.type === "string" ? artist.type : "artist"\n' +
            '        }));\n' +
            '        if (artists.length === 0) artists.push({ id: "", href: "", name: "Unknown artist", type: "artist" });\n' +
            '        return {\n' +
            '            ...track,\n' +
            '            id,\n' +
            '            name: typeof track.name === "string" && track.name.trim() ? track.name : "Unknown track",\n' +
            '            duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,\n' +
            '            album: {\n' +
            '                ...albumSource,\n' +
            '                id: typeof albumSource.id === "string" ? albumSource.id : "",\n' +
            '                name: typeof albumSource.name === "string" ? albumSource.name : "Unknown album",\n' +
            '                image: {\n' +
            '                    ...imageSource,\n' +
            '                    height: Number.isFinite(imageSource.height) ? imageSource.height : 0,\n' +
            '                    width: Number.isFinite(imageSource.width) ? imageSource.width : 0,\n' +
            '                    url: typeof imageSource.url === "string" ? imageSource.url : ""\n' +
            '                }\n' +
            '            },\n' +
            '            artists\n' +
            '        } as Track;\n' +
            '    };\n' +
            '\n' +
            '    const normalizeRepeat = (value: unknown): Repeat =>\n' +
            '        value === "track" || value === "context" ? value : "off";\n' +
            '\n' +
            '    const store = new SpotifyStore(FluxDispatcher, {\n' +
            '        SPOTIFY_PLAYER_STATE(e: PlayerState) {\n' +
            '            store.track = normalizeTrack(e.track);\n' +
            '            const rawDevice = e.device && typeof e.device === "object" ? e.device as any : null;\n' +
            '            store.device = typeof rawDevice?.id === "string"\n' +
            '                ? { ...rawDevice, is_active: rawDevice.is_active !== false }\n' +
            '                : (store.track ? (store.device ?? { id: "default", is_active: true }) : null);\n' +
            '            store.isPlaying = e.isPlaying === true;\n' +
            '            store.volume = Number.isFinite(e.volumePercent) ? Math.max(0, Math.min(100, e.volumePercent)) : 0;\n' +
            '            store.repeat = normalizeRepeat(e.actual_repeat);\n' +
            '            store.shuffle = e.shuffle === true;\n' +
            '            store.position = Number.isFinite(e.position) ? Math.max(0, e.position) : 0;\n' +
            '            store.isSettingPosition = false;\n' +
            '            store.emitChange();\n' +
            '        },\n' +
            '        SPOTIFY_SET_DEVICES({ devices }: { devices: Device[]; }) {\n' +
            '            const availableDevices = Array.isArray(devices) ? devices : [];\n' +
            '            const activeDevice = availableDevices.find(d => d?.is_active) ?? availableDevices[0] ?? null;\n' +
            '            store.device = activeDevice && typeof activeDevice.id === "string"\n' +
            '                ? { ...activeDevice, is_active: activeDevice.is_active !== false }\n' +
            '                : null;\n' +
            '            store.emitChange();\n' +
            '        }\n' +
            '    });'
    },
];

let patched = 0;
let skipped = 0;
const warnings = [];

for (const p of PATCHES) {
    if (USE_STABLE_BETTER_FOLDERS && p.file.startsWith("src/plugins/betterFolders/") && !p.allowOnStable) {
        skipped++;
        continue;
    }

    const path = join(VENCORD_SRC, p.file);
    if (!existsSync(path)) {
        warnings.push(`File not found: ${p.file}`);
        continue;
    }
    let content = readFileSync(path, "utf-8");

    // The stable candidate is intentionally maintained as a clean, already-
    // hardened BetterFolders source. Historical stable-safe patches are kept
    // in this script so a fresh pinned extraction can still be repaired, but
    // they must not warn when the final native-ownership implementation is
    // already present. Do not skip the final cleanup patches below: those
    // remove obsolete imports/state from a fresh extraction.
    const stableBetterFoldersFinalized =
        content.includes("Discordmaxxer: native DM route ownership.") ||
        content.includes("Discordmaxxer: native folder expansion ownership.") ||
        content.includes("Discordmaxxer: native folder toggle render fallback.") ||
        content.includes("Discordmaxxer: fail open on empty folder state.") ||
        // The isolated stable source may contain the same final code after a
        // prior clean-up pass without retaining the overlay marker comments.
        // Recognize those source shapes so historical patches remain quiet and
        // cannot be mistaken for a failed fresh-build patch.
        (p.file.endsWith("src/plugins/betterFolders/index.tsx") &&
            content.includes("CHANNEL_SELECT()") &&
            content.includes("TOGGLE_GUILD_FOLDER_EXPAND()") &&
            !content.includes("lastGuildId")) ||
        (p.file.endsWith("src/plugins/betterFolders/FolderSideBar.tsx") &&
            content.includes("storeExpandedFolderIds") &&
            content.includes("FluxDispatcher.subscribe(\"TOGGLE_GUILD_FOLDER_EXPAND\""));
    if (
        USE_STABLE_BETTER_FOLDERS &&
        p.file.startsWith("src/plugins/betterFolders/") &&
        p.allowOnStable &&
        p.marker?.startsWith("Discordmaxxer: stable-safe") &&
        stableBetterFoldersFinalized
    ) {
        skipped++;
        continue;
    }

    if (p.marker && content.includes(p.marker)) {
        skipped++;
        continue;
    }

    if (p.alreadyAppliedWhen?.(content)) {
        skipped++;
        continue;
    }

    if (p.obsoleteWhen?.(content) && !content.includes(p.find)) {
        skipped++;
        continue;
    }

    if (content.includes(p.replace) && !content.includes(p.find)) {
        skipped++;
        continue;
    }

    if (!content.includes(p.find)) {
        warnings.push(`Patch target not found in ${p.file}${p.marker ? ` [${p.marker}]` : ""}: "${p.find.slice(0, 60)}..."`);
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
