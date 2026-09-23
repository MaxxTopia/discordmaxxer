import puppeteer from "puppeteer-core";

const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await b.pages();
const page = pages.find(p => p.url().includes("discord.com")) ?? pages[0];

// 1. Theme toggle test
const themeTest = await page.evaluate(() => {
    const v = globalThis.Vencord;
    const before = {
        enable: v.PlainSettings?.plugins?.DMTheme?.enable,
        brand500: getComputedStyle(document.documentElement).getPropertyValue("--brand-500").trim()
    };

    // Find existing theme style elements
    const existingStyles = Array.from(document.querySelectorAll('style[id*="dm-theme"]'))
        .map(s => ({ id: s.id, hasContent: !!s.textContent, contentLen: s.textContent?.length }));

    return { before, existingStyles };
});
console.log("THEME state:", JSON.stringify(themeTest, null, 2));

// 2. Toggle theme off via the Hub click flow
const toggle1 = await page.evaluate(() => {
    document.getElementById("dm-hub-fab")?.click();
});
await new Promise(r => setTimeout(r, 300));

const toggle2 = await page.evaluate(() => {
    const t = document.querySelector('.dm-hub-toggle[data-plugin="DMTheme"]');
    if (!t) return { err: "no toggle in panel" };
    t.click();
    return { clicked: true, wasOn: t.classList.contains("on") };
});
await new Promise(r => setTimeout(r, 700));

const after = await page.evaluate(() => {
    const v = globalThis.Vencord;
    return {
        enable: v.PlainSettings?.plugins?.DMTheme?.enable,
        brand500: getComputedStyle(document.documentElement).getPropertyValue("--brand-500").trim(),
        existingStyles: Array.from(document.querySelectorAll('style[id*="dm-theme"]'))
            .map(s => ({ id: s.id, hasContent: !!s.textContent, contentLen: s.textContent?.length }))
    };
});
console.log("AFTER click:", JSON.stringify({ toggle2, after }, null, 2));

// 3. Test if window.prompt works (MassDelete relies on it)
const promptTest = await page.evaluate(() => {
    // Don't actually call prompt — that'd block. Just check the function.
    return {
        promptType: typeof window.prompt,
        promptIsBound: window.prompt === Window.prototype.prompt || window.prompt.toString().includes("[native code]")
    };
});
console.log("PROMPT:", JSON.stringify(promptTest, null, 2));

// 4. Test Alerts.show availability
const alertsTest = await page.evaluate(() => {
    const v = globalThis.Vencord;
    const Alerts = v.Webpack?.Common?.Alerts;
    return {
        alertsAvailable: !!Alerts?.show,
        alertsShape: Alerts ? Object.keys(Alerts) : null
    };
});
console.log("ALERTS:", JSON.stringify(alertsTest, null, 2));

b.disconnect();
