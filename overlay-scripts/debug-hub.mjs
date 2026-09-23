import puppeteer from "puppeteer-core";

const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await b.pages();
const page = pages.find(p => p.url().includes("discord.com")) ?? pages[0];

const result = await page.evaluate(() => {
    const v = globalThis.Vencord;

    // 1) Test the setSetting path: write enable=true on DMTheme, see if it sticks.
    const before = v.PlainSettings?.plugins?.DMTheme?.enable;
    try {
        v.Settings.plugins.DMTheme.enable = true;
    } catch (e) {
        return { writeTest: "THREW", error: String(e) };
    }
    const afterPlain = v.PlainSettings?.plugins?.DMTheme?.enable;
    const afterProxy = v.Settings?.plugins?.DMTheme?.enable;

    // 2) Find Discord's user panel and inspect its structure.
    const userArea = document.querySelector('section[class*="panels-"]') ??
                      document.querySelector('[class*="panels"]:has([class*="avatarWrapper"])') ??
                      document.querySelector('[class*="container"][class*="userPanel"]');
    const userAreaInfo = userArea && {
        tag: userArea.tagName,
        className: String(userArea.className).slice(0, 120),
        outerHTMLStart: userArea.outerHTML.slice(0, 200),
        childCount: userArea.children.length
    };

    // 3) Try to find the avatar + the icon row.
    const avatar = document.querySelector('[class*="avatarWrapper"]');
    const iconRow = avatar?.parentElement?.parentElement;
    const iconRowInfo = iconRow && {
        tag: iconRow.tagName,
        className: String(iconRow.className).slice(0, 120),
        children: Array.from(iconRow.children).map(c => ({
            tag: c.tagName,
            className: String(c.className).slice(0, 80)
        }))
    };

    // 4) Find the mic button specifically.
    const micButton = document.querySelector('button[aria-label*="ute" i]');
    const micInfo = micButton && {
        tag: micButton.tagName,
        className: String(micButton.className).slice(0, 120),
        ariaLabel: micButton.getAttribute("aria-label"),
        parentClassName: String(micButton.parentElement?.className).slice(0, 120)
    };

    return {
        writeTest: { before, afterPlain, afterProxy, sticks: afterPlain === true },
        userAreaInfo,
        iconRowInfo,
        micInfo
    };
});

console.log(JSON.stringify(result, null, 2));
b.disconnect();
