/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { localStorage } from "./utils";

// Make clicking Notifications focus the window
const originalSetOnClick = Object.getOwnPropertyDescriptor(Notification.prototype, "onclick")!.set!;
Object.defineProperty(Notification.prototype, "onclick", {
    set(onClick) {
        originalSetOnClick.call(this, function (this: unknown) {
            onClick.apply(this, arguments);
            VesktopNative.win.focus();
        });
    },
    configurable: true
});

// Hide "Download Discord Desktop now!!!!" banner
localStorage.setItem("hideNag", "true");

// Ensure Discord's favicon uses the Discordmaxxer mascot logo
const MASCOT_FAVICON =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAAwFBMVEWcEiCpqaJmZmMZGRjJrKluT05nJCijTlOolpIyMSoWFxUfHx5fXwBKSkfX1NTPz71CQj6DgX4AAFV/gHpBQD+yPUuEhHpDPz9/AAAA/wAAAAD49u8BAgFPCA1wCRF+fn4UFBQWFhX///6OChdLSkgoKShVVVU4ODbu6+RVVVGYmJSuqqYmJiTZ1tEZGhjKyMRJSUctAAA2NjW2tbAlJSRXV1UqKyl2dXNwa2no49yKiYY8PDzKwb3k3dg1NTOWmJP+3qSgAAAAQHRSTlP/Dyfh//////81cJoCTw4PTP8D////G0wCAQD//v//AvbQBP8x/wNL/y7//4//s///////rP9x/////wT//2gUu/meCgAABZ5JREFUeNrtWlmbqjgQBdx7vXf2gagBRWUTXEHbbv//v5okiJCkoFX0Zb57nrpDqJNakxQq+oOh/CK4ikCb3EPkRNMtmEBtjOuLH+pO4whqMNGnaKrX1kEUU9RgjZ7vYaItWsM+UDEyrfryLRPhI0gwRQiN67tAI2KmIIFPnvj3sBAnpkBgkif1bWQJYnICFSGmXM04mjIxR4mAhC97YtbVYM7EjIlAnuDlRF30zy3oIcEQGcGH/pU+qucF5gGCLyJQ9MFT+ghtoeCTHTOZDKWxDxZCFE+AkzMCYr+PatkFvPzDVQkNSasECExVjKQ351VyzfRvRxWrkGqiSzRAjbeCDuoP38TMbR/ELKlxyJ+vZAibz9O/0hBMHTBH5QRnJzMGsrZ/6ehxO8fZoMbtHOe5820W82ouH3Dyb1mYplZiNcnxUXFMdRynRzDWxseCLIR9h84em4UxOUyHhUVR+EdnXZCBeGBhcN47cotBDuADy5RlUNiJ92lskITI2HmJDS8BQ7VIn8tCEE4OhmHs3AggcAPyqBk3gNfmYDX9kubZ7ozIWJ2WjxvLaEMQLe3TeiOPPJ65S+nFLUAw1Ifi6l3yuuHR1+3N3gt3lC3FLlztN9Q8dpf+69rCqxp8quBtlFB54ZLaIjRABC7RzV5RLeIyC3EEveLy6XtGgpbuzqgAtc+G/rHCYJAKB69cBRwYM7L86GB8i3CzDMnkIGdoWLAGL/r4PMel8uPQuAhhfCDTXZRXy9KzaZYtNjOxcTEC6q/M037F4TdLNte4AV1wxxJO11quwPWwhSoBEJy2P1tBC4CTlYKsKfi2W0EMwzs6QpwqkmMG5GkSdCrIGCZEN5KEIppLBEwHy+Nm7FMvTwsJajj4hI3K3IaBLcT7ORE4AjG6U5VA1Fqo0kJwdPNWVxuI+UCC826nU5THGx2Ol05XwLJRkrx/gnH0KcyGIxGf3L7wq4zGg0GyiccR+MSDVgMxdI77YEyUhSlUxzrKBSDtqRDLJ6fpS3Tk4pkv00UUJRRwUpN+v9o0O53xdmrii3TwqAL2v0BIyiq0KHyiY36bTBQ0TtAMEldIFXqT0qQMuxyrzAFCEE/AJ3QywNVPBdtpGjpUwLCMBqdN+jDiK2fEjTBgrcFTfQM1onmghEQhsFZWHOQyV94YCas9dKz6QrQoJ8qMThX2cMgFU8ImqCX4Xsy7GPigxNB++yDXTsjkH3AUg2X3pOBzay16KdoFcZOQ4s2vK0B9+RJupkB2333RFA0t5eNdUv2BPkCcsrjP4AClqqwaAFj7bKCCt0yfTBKqdKtBUFLZKVj0OmgxRdUpdDvAisRs0iSSNG1ShIPnMyq0TNAwCrRT6M29nw1Uvg0cOsTuHwilBJcuTMH/BG1ARA0+GK9iq+RH+cvemUaCATG3l5dKv5g/y7UCkADlRG0OG9tLrJTsOFKZJI1I0AfcBsaWcvmWy3CRHqpysn8wXRHbpHLfYUan/SGHhUnhFho/Sni9QlzR1+PXiqi/QFI2VnoRji7TQvygUye5N0WPkHTSzaOYncVnOr1LDh044j5zN5z1OfLLFTs1PM9VAhQL+94NGyKvE/i8Zp1zhPVstZy9mLBEsYnRiVgt+l8+XnPAm4tF3sVy5xi1kClwPnRbhV936vYcp2W+OTZJarA6aAZ7rlZX2XHd6FjZEexF0aoElHo/dzYpd0igUA10R1AmpYlBEP9/Q4MpO06rLgnP9eVv668JxPqaS0lzKmuD7/5Evj2dTOFuVUv+tRoTdNu8lXApv9qXfEtU9UcbS0u8IczdhjGIhxNveFjqUDgv3/7EfAaguGHxROQ9JwMy6HX1MDUHvA9uUDgW/ojCfCU9iQfRzC/1TwXEviW/kgCLCX/fQlqmecCgq1e9+NpJQEeP/Z3Fa+a/uuXIf8Hgv8AXGDjELNwnlUAAAAASUVORK5CYII=";

function updateFavicon() {
    const links = document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']");
    if (links.length === 0) {
        const link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/png";
        link.href = MASCOT_FAVICON;
        (document.head || document.documentElement).appendChild(link);
    } else {
        links.forEach(l => {
            if (l.href !== MASCOT_FAVICON) {
                l.href = MASCOT_FAVICON;
            }
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateFavicon, { once: true });
} else {
    updateFavicon();
}

const headObserver = new MutationObserver(updateFavicon);
if (document.head) {
    headObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
}
