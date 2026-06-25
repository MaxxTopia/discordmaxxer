/*
 * Discordmaxxer
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ambient declarations for esbuild asset imports used by the renderer:
 *  - "*.wasm"  → bundled as a Uint8Array (loader: "binary")
 *  - "*?raw"   → bundled as the file's raw text (rawPlugin)
 */

declare module "*.wasm" {
    const contents: Uint8Array;
    export default contents;
}

declare module "*?raw" {
    const contents: string;
    export default contents;
}
