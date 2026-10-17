import puppeteer from "puppeteer-core";

const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await b.pages();
const page = pages.find(p => p.url().includes("discord.com")) ?? pages[0];

const result = await page.evaluate(() => {
    // Read --brand-experiment BEFORE
    const beforeBrand = getComputedStyle(document.documentElement).getPropertyValue("--brand-experiment").trim();

    // Find DMTheme's toggle in the panel and click it.
    // First open the panel.
    document.getElementById("dm-hub-fab")?.click();

    return {
        beforeBrand,
        panelOpened: !document.getElementById("dm-hub-panel-root")?.classList.contains("hidden"),
        panelHasThemeToggle: !!document.querySelector('.dm-hub-toggle[data-plugin="DMTheme"]')
    };
});
console.log("Phase 1:", JSON.stringify(result, null, 2));

// Now click the DMTheme toggle.
const phase2 = await page.evaluate(() => {
    const toggle = document.querySelector('.dm-hub-toggle[data-plugin="DMTheme"]');
    if (!toggle) return { error: "no theme toggle in panel" };
    const wasOn = toggle.classList.contains("on");
    toggle.click();
    // Allow re-render
    return { wasOn, clicked: true };
});
console.log("Phase 2:", JSON.stringify(phase2, null, 2));

// Wait for the plugin restart + CSS to inject
await new Promise(r => setTimeout(r, 500));

const phase3 = await page.evaluate(() => {
    const v = globalThis.Vencord;
    return {
        themeEnableSetting: v.PlainSettings?.plugins?.DMTheme?.enable,
        brandColorAfter: getComputedStyle(document.documentElement).getPropertyValue("--brand-experiment").trim(),
        // Check the panel re-rendered with new state
        toggleStateAfter: document.querySelector('.dm-hub-toggle[data-plugin="DMTheme"]')?.classList.contains("on")
    };
});
console.log("Phase 3:", JSON.stringify(phase3, null, 2));

b.disconnect();
