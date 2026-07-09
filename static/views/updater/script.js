// Loaded as a CLASSIC script, not type="module".
//
// Electron 43's Chromium only allows CORS fetches for a fixed set of schemes
// (chrome, chrome-extension, chrome-untrusted, data, dm-media, http, https).
// `vesktop:` is not registered as a privileged/standard scheme, and a
// `type="module"` script is fetched with CORS — so the module was blocked with
// `net::ERR_FAILED` and NO javascript ran in this window at all. The dialog
// rendered its static HTML, the "Install update & restart" button had no click
// listener, and pressing it did nothing. Silently. (Regressed with the Electron
// 41 -> 43 bump; only surfaced once update detection was fixed. 2026-07-09.)
//
// Classic scripts are not CORS-fetched, so this loads. The whole body is wrapped
// in an async IIFE because the original relied on top-level await, which only
// modules allow.
(async () => {
    const { update, version: currentVersion } = await VesktopUpdaterNative.getData();

    // Tool-authorship attribution that should never surface to users in the
    // changelog. Release notes are sourced from GitHub release bodies, which can
    // inherit commit-message trailers ("Co-Authored-By: Claude …", "🤖 Generated
    // with Claude Code"). Strip those lines defensively so the update popup shows
    // only real changelog content regardless of what a release body contains.
    const AUTHORSHIP_LINE =
        /(?:co-authored-by:?\s*)?(?:🤖\s*)?(?:generated with\s+)?(?:authored by\s+)?claude\b[^\n<]*|🤖\s*generated with[^\n<]*|co-authored-by:[^\n<]*/gi;

    function stripAuthorship(html) {
        if (!html) return "";
        return (
            html
                // drop whole list items / paragraphs that are purely an attribution
                .replace(/<li[^>]*>\s*(?:🤖\s*)?(?:co-authored-by|generated with|authored by)[^<]*<\/li>/gi, "")
                .replace(/<p[^>]*>\s*(?:🤖\s*)?(?:co-authored-by|generated with|authored by)[^<]*<\/p>/gi, "")
                // then clean any remaining inline mentions
                .replace(AUTHORSHIP_LINE, "")
        );
    }

    document.getElementById("current-version").textContent = currentVersion;
    document.getElementById("new-version").textContent = update.version;
    document.getElementById("release-notes").innerHTML = (update.releaseNotes ?? [])
        .map(
            ({ version, note: html }) => `
            <section>
                <h3>Version ${version}</h3>
                <div>${stripAuthorship(html).replace(/<\/?h([1-3])/g, (m, level) => m.replace(level, Number(level) + 3))}</div>
            </section>
        `
        )
        .join("\n");

    document.querySelectorAll("a").forEach(a => {
        a.target = "_blank";
    });

    // remove useless headings
    document.querySelectorAll("h3, h4, h5, h6").forEach(h => {
        if (h.textContent.trim().toLowerCase() === "what's changed") {
            h.remove();
        }
    });

    // belt-and-suspenders: remove any element left whose text is just a tool
    // authorship credit (catches markdown shapes the regex pass above missed)
    document.querySelectorAll("#release-notes li, #release-notes p").forEach(el => {
        const t = el.textContent.trim().toLowerCase();
        if (
            /^(?:🤖\s*)?(?:co-authored-by|generated with|authored by)\b/.test(t) ||
            (/\bclaude\b/.test(t) && t.includes("anthropic"))
        ) {
            el.remove();
        }
    });

    /** @type {HTMLDialogElement} */
    const updateDialog = document.getElementById("update-dialog");
    /** @type {HTMLDialogElement} */
    const installingDialog = document.getElementById("installing-dialog");
    /** @type {HTMLProgressElement} */
    const downloadProgress = document.getElementById("download-progress");
    /** @type {HTMLElement} */
    const errorText = document.getElementById("error");

    document.getElementById("update-button").addEventListener("click", () => {
        downloadProgress.value = 0;
        errorText.textContent = "";

        if (navigator.platform.startsWith("Linux")) {
            document.getElementById("linux-note").classList.remove("hidden");
        }

        updateDialog.showModal();

        VesktopUpdaterNative.installUpdate()
            .then(() => {
                downloadProgress.value = 100;
                updateDialog.closedBy = "any";

                installingDialog.showModal();
                updateDialog.classList.add("hidden");
            })
            // Without this, a rejected download left the dialog frozen at 0% with
            // no message at all — the error only reached the main-process console,
            // which is invisible in a packaged app. Never fail silently here.
            .catch(err => {
                const message = err?.message ?? String(err);
                console.error("[Discordmaxxer updater] install failed:", err);
                updateDialog.closedBy = "any";
                errorText.textContent = `Update failed: ${message}`;
                installingDialog.close();
                updateDialog.classList.remove("hidden");
            });
    });

    document.getElementById("later-button").addEventListener("click", () => VesktopUpdaterNative.snoozeUpdate());
    document.getElementById("ignore-button").addEventListener("click", () => {
        const confirmed = confirm(
            "Are you sure you want to ignore this update? You will not be notified about this update again. Updates are important for security and stability."
        );
        if (confirmed) VesktopUpdaterNative.ignoreUpdate();
    });

    VesktopUpdaterNative.onProgress(percent => (downloadProgress.value = percent));
    VesktopUpdaterNative.onError(message => {
        updateDialog.closedBy = "any";
        errorText.textContent = `An error occurred while downloading the update: ${message}`;
        installingDialog.close();
        updateDialog.classList.remove("hidden");
    });
})();
