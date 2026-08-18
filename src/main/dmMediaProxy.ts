/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Discordmaxxer — dm-media:// protocol proxy
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Proxies arbitrary HTTPS media URLs through a same-origin `dm-media://`
 * scheme so they bypass Chromium's Opaque Response Blocking (ORB).
 *
 * ORB blocks no-CORS cross-origin media requests in <video>/<audio> when
 * Chromium's content-type sniffer can't confidently confirm the response
 * is a media format. It runs at the network-service layer, BEFORE the
 * renderer sees the response — so neither CSP overrides nor injected
 * Cross-Origin-Resource-Policy response headers (via webRequest) help.
 *
 * The escape hatch: fetch the URL from MAIN process (Node-side, no ORB),
 * and serve the bytes through a privileged scheme registered as same-
 * origin. The renderer sees `dm-media://...` as a local resource, no
 * cross-origin check applies.
 *
 * Plugin-side usage (DMProfileFlair):
 *     const proxied = `dm-media:///${encodeURIComponent(realUrl)}`;
 *     videoEl.src = proxied;
 *
 * Security:
 *   - Only allows https:// targets (prevents file://, http://).
 *   - Blocks any target whose hostname is — or DNS-resolves to — a
 *     loopback / private / link-local / unique-local / CGNAT address.
 *     This closes the SSRF hole where a renderer (a malicious Vencord
 *     plugin or theme) could make the MAIN process read internal hosts
 *     (router admin pages, 169.254.169.254 cloud metadata, intranet apps).
 *     The check runs on the initial target AND on every redirect hop, so a
 *     public host that 302-redirects to an internal IP can't bypass it.
 *   - Caps the proxied body size (main-process memory-DoS guard).
 *   - Rejects text/html responses (a media proxy should never return a
 *     navigable HTML document).
 *   - No auth headers / cookies are forwarded — pure public-resource fetch.
 */

import { lookup } from "dns/promises";
import { app, protocol } from "electron";
import { request as httpsRequest } from "https";
import { isIP, type LookupFunction } from "net";

// Main-process memory guard: refuse to buffer more than this from any single
// proxied response. Banner videos are ~3MB, avatars far less; 50MB is generous
// headroom while still bounding a hostile oversized target.
const MAX_PROXY_BYTES = 50 * 1024 * 1024;
// Cap redirect chains — each hop is re-validated against the private-IP block.
const MAX_REDIRECTS = 4;

/** True if an IP literal falls in a loopback / private / link-local / ULA /
 *  CGNAT / multicast / reserved range we must never let the main process
 *  reach on the renderer's behalf. Malformed input is treated as blocked. */
function ipIsPrivate(ipRaw: string): boolean {
    const ip = ipRaw.split("%")[0]; // drop IPv6 zone id
    const fam = isIP(ip);
    if (fam === 4) {
        const p = ip.split(".").map(Number);
        if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
        const [a, b] = p;
        if (a === 0 || a === 10 || a === 127) return true; // this-net / private / loopback
        if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true; // private
        if (a === 192 && b === 168) return true; // private
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a >= 224) return true; // multicast + reserved
        return false;
    }
    if (fam === 6) {
        const v = ip.toLowerCase();
        if (v === "::1" || v === "::") return true;
        if (v.startsWith("fe80")) return true; // link-local
        if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
        if (v.startsWith("2001:db8")) return true; // documentation
        if (v.startsWith("::ffff:")) return ipIsPrivate(v.slice(7)); // IPv4-mapped
        return false;
    }
    return true; // not a valid IP literal where one was expected → block
}

/** Resolve a hostname to a SINGLE concrete address that we then PIN the
 *  connection to. Blocks if the host is, or any of its addresses map to, a
 *  private range. Returning the resolved address (and connecting to exactly
 *  it via a custom `lookup`) is what actually defeats DNS-rebinding: the prior
 *  approach resolved during validation but let the network stack re-resolve
 *  at connect time, leaving a TOCTOU window where DNS could flip to an
 *  internal IP between the two resolves. Throws on any block/failure. */
async function resolvePinnedAddress(hostname: string): Promise<{ address: string; family: number }> {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(h)) {
        if (ipIsPrivate(h)) throw new Error("target host is not allowed");
        return { address: h, family: isIP(h) };
    }
    if (
        h === "localhost" ||
        h.endsWith(".localhost") ||
        h.endsWith(".local") ||
        h.endsWith(".internal") ||
        h.endsWith(".home.arpa")
    )
        throw new Error("target host is not allowed");
    let addrs;
    try {
        addrs = await lookup(h, { all: true });
    } catch {
        throw new Error("target host is not allowed"); // unresolvable → block
    }
    if (!addrs.length) throw new Error("target host is not allowed");
    // Strict: if ANY resolved address is private, block the host entirely
    // (defends against a host that returns mixed public+private records).
    if (addrs.some(a => ipIsPrivate(a.address))) throw new Error("target host is not allowed");
    return { address: addrs[0].address, family: addrs[0].family };
}

/** Validate scheme + host of a URL string. Returns null if OK, else an error.
 *  Used as a fast pre-check for nice 400/403 errors; the authoritative SSRF
 *  guard is the pinned connect in fetchValidated. */
async function validateTarget(urlStr: string): Promise<string | null> {
    let parsed: URL;
    try {
        parsed = new URL(urlStr);
    } catch {
        return "malformed URL";
    }
    if (parsed.protocol !== "https:") return "only https:// targets allowed";
    try {
        await resolvePinnedAddress(parsed.hostname);
    } catch {
        return "target host is not allowed";
    }
    return null;
}

interface ProxyResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    location?: string;
}

/** One HTTPS GET pinned to a pre-validated address. The custom `lookup`
 *  forces the socket to connect to `pinned.address` while `servername`/the
 *  Host header stay the real hostname so TLS SNI + cert validation succeed. */
function fetchOnce(
    parsed: URL,
    rangeHeader: string | null,
    pinned: { address: string; family: number }
): Promise<ProxyResponse> {
    return new Promise((resolve, reject) => {
        // Node's net stack calls this with `{ all: true }`, which REQUIRES the
        // callback to return an ARRAY of {address,family}. Returning the 3-arg
        // (address, family) form there yields "Invalid IP address: undefined"
        // and the connection never opens. Honour both call shapes.
        const pinnedLookup: LookupFunction = (_hn, opts, cb) => {
            const anyCb = cb as any;
            if ((opts as any)?.all) {
                anyCb(null, [{ address: pinned.address, family: pinned.family }]);
            } else {
                anyCb(null, pinned.address, pinned.family);
            }
        };
        const req = httpsRequest(
            {
                protocol: "https:",
                hostname: parsed.hostname,
                servername: parsed.hostname,
                port: parsed.port || 443,
                path: (parsed.pathname || "/") + parsed.search,
                method: "GET",
                lookup: pinnedLookup,
                headers: rangeHeader ? { range: rangeHeader } : {}
            },
            res => {
                const status = res.statusCode ?? 0;
                // Redirect — drain and hand the Location back up for re-validation.
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve({ status, headers: res.headers, body: Buffer.alloc(0), location: res.headers.location });
                    return;
                }
                const chunks: Buffer[] = [];
                let total = 0;
                res.on("data", (c: Buffer) => {
                    total += c.length;
                    if (total > MAX_PROXY_BYTES) {
                        req.destroy();
                        reject(new Error("response exceeds size cap"));
                        return;
                    }
                    chunks.push(c);
                });
                res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
                res.on("error", (e: Error) => reject(e));
            }
        );
        req.on("error", e => reject(e));
        req.end();
    });
}

/** Fetch a URL with MANUAL redirect handling so every hop is independently
 *  re-resolved and pinned against the private-IP block, plus a hard byte cap. */
async function fetchValidated(initialUrl: string, rangeHeader: string | null): Promise<ProxyResponse> {
    let current = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let parsed: URL;
        try {
            parsed = new URL(current);
        } catch {
            throw new Error("malformed URL");
        }
        if (parsed.protocol !== "https:") throw new Error("only https:// targets allowed");
        // Resolve + validate + pin in one step — no second resolve at connect.
        const pinned = await resolvePinnedAddress(parsed.hostname);
        const res = await fetchOnce(parsed, rangeHeader, pinned);
        if (res.location && res.status >= 300 && res.status < 400) {
            current = new URL(res.location, current).toString();
            continue;
        }
        return res;
    }
    throw new Error("too many redirects");
}

// MUST be called BEFORE app.whenReady() — that's why this file is
// imported at the top of main/index.ts, where its module-level side
// effects run during the initial require pass.
protocol.registerSchemesAsPrivileged([
    {
        scheme: "dm-media",
        privileges: {
            stream: true, // enables seekable media playback (range requests)
            supportFetchAPI: true,
            corsEnabled: true,
            bypassCSP: true, // renderer's CSP doesn't apply to same-origin custom scheme
            standard: true, // required for `stream: true` to take effect
            secure: true // ALSO required for <video> URL safety check — without
            //   this Chromium rejects with "Media load rejected by
            //   URL safety check" before even fetching.
        }
    }
]);

app.whenReady().then(() => {
    protocol.handle("dm-media", async request => {
        // URL shape: dm-media://proxy/<url-encoded https URL>
        // Example: dm-media://proxy/https%3A%2F%2Fi.imgur.com%2Fabc.mp4
        // The `proxy` hostname is required — Chromium's <video> URL safety
        // check rejects custom-scheme URLs that lack a host component.
        const u = new URL(request.url);
        const encoded = u.pathname.replace(/^\//, "") + u.search + u.hash;
        let target: string;
        try {
            target = decodeURIComponent(encoded);
        } catch {
            return new Response("malformed target URL", { status: 400 });
        }
        const targetErr = await validateTarget(target);
        if (targetErr) {
            return new Response(targetErr, { status: targetErr === "target host is not allowed" ? 403 : 400 });
        }
        try {
            // Fetch via net.request with manual redirect validation + byte cap
            // (see fetchValidated). Each redirect hop is re-checked against the
            // private-IP block so a public host can't 302 us into the intranet.
            const upstream = await fetchValidated(target, request.headers.get("range"));

            // Normalize header values (net.request gives string | string[]).
            const pick = (k: string): string => {
                const v = upstream.headers[k] ?? upstream.headers[k.toLowerCase()];
                return Array.isArray(v) ? v[0] : (v ?? "");
            };
            const contentType = pick("content-type");
            // A media proxy must never hand back a navigable HTML document.
            if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
                return new Response("refusing to proxy an HTML document", { status: 415 });
            }

            const respHeaders = new Headers();
            if (contentType) respHeaders.set("content-type", contentType);
            const contentRange = pick("content-range");
            if (contentRange) respHeaders.set("content-range", contentRange);
            respHeaders.set("content-length", String(upstream.body.length));
            // Allow ranged playback + mark cross-origin OK for any downstream check.
            respHeaders.set("accept-ranges", "bytes");
            respHeaders.set("cross-origin-resource-policy", "cross-origin");
            // Buffer is a valid Response body at runtime; the cast bridges the
            // Node typed-array generic (Uint8Array<ArrayBufferLike>) vs the DOM
            // BodyInit lib type — a TS 5.7 generic-mismatch, not a real concern.
            return new Response(upstream.body as unknown as BodyInit, {
                status: upstream.status,
                headers: respHeaders
            });
        } catch (e: any) {
            console.warn("[dm-media] proxy failed:", target.slice(0, 100), e?.message ?? e);
            return new Response(`upstream error: ${e?.message ?? "unknown"}`, { status: 502 });
        }
    });
});
