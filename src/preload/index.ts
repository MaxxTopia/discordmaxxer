/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";
import { VesktopNative } from "./VesktopNative";

contextBridge.exposeInMainWorld("VesktopNative", VesktopNative);

// Electron's packaged renderer can occasionally start without Chromium's
// built-in HTML display defaults. In that state normal <script>/<style> text
// is painted into the page and #app-mount is pushed below the viewport. Keep
// this small fallback at document-start so the Discord/Vencord styles can
// still override the defaults they intentionally set.
const DISPLAY_DEFAULTS_STYLE_ID = "dm-renderer-display-defaults";
const DISPLAY_DEFAULTS_CSS = `
html { display: block; }
body { display: block; }
head, base, link, meta, noscript, script, style, template, title { display: none; }
article, aside, blockquote, body, div, dl, dt, dd, fieldset, figcaption, figure,
footer, form, h1, h2, h3, h4, h5, h6, header, hr, main, nav, ol, p, pre, section,
table, ul { display: block; }
li { display: list-item; }
caption { display: table-caption; }
colgroup { display: table-column-group; }
col { display: table-column; }
tbody { display: table-row-group; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr { display: table-row; }
td, th { display: table-cell; }
button, input, select, textarea { display: inline-block; }
img, svg, canvas, video, audio, iframe, object, embed { display: inline-block; }
a, abbr, acronym, b, bdi, bdo, br, cite, code, del, dfn, em, i, kbd,
mark, q, s, samp, small, span, strong, sub, sup, time, u, var { display: inline; }
#app-mount { position: absolute; inset: 0; display: flex; }
`;

function installDisplayDefaults(): void {
    const root = document.documentElement;
    if (!root || document.getElementById(DISPLAY_DEFAULTS_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = DISPLAY_DEFAULTS_STYLE_ID;
    style.textContent = DISPLAY_DEFAULTS_CSS;
    root.appendChild(style);
}

installDisplayDefaults();
if (!document.documentElement) {
    window.addEventListener("DOMContentLoaded", installDisplayDefaults, { once: true });
}

// TODO: remove this legacy workaround once some time has passed
const isSandboxed = typeof __dirname === "undefined";
if (isSandboxed) {
    // While sandboxed, Electron "polyfills" these APIs as local variables.
    // We have to pass them as arguments as they are not global
    Function(
        "require",
        "Buffer",
        "process",
        "clearImmediate",
        "setImmediate",
        ipcRenderer.sendSync(IpcEvents.GET_VENCORD_PRELOAD_SCRIPT)
    )(require, Buffer, process, clearImmediate, setImmediate);
} else {
    require(ipcRenderer.sendSync(IpcEvents.DEPRECATED_GET_VENCORD_PRELOAD_SCRIPT_PATH));
}

webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VENCORD_RENDERER_SCRIPT));
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_VESKTOP_RENDERER_SCRIPT));
