// src/core/browser.js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

async function launchBrowser(settings, log) {
  log.info(`Launching browser headless=${settings.headless}`);
  const browser = await puppeteer.launch({
    headless: settings.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
    defaultViewport: null,
  });
  return browser;
}

function applyTimeouts(page, settings) {
  page.setDefaultNavigationTimeout(settings.navTimeoutMs);
  page.setDefaultTimeout(settings.opTimeoutMs);
}

/**
 * Speed/Noise mode:
 * - blocks websocket
 * - blocks analytics/youtube/etc
 * - blocks heavy assets (image/font/media) to speed item scraping
 * - safe to call multiple times (only attaches once per page)
 */
async function enableSpeedMode(page, log) {
  if (page.__speedModeEnabled) return;
  page.__speedModeEnabled = true;

  await page.setRequestInterception(true);

  page.on("request", (req) => {
    try {
      const url = req.url();
      const rt = req.resourceType();

      // 1) Always block websockets
      if (rt === "websocket") return req.abort();

      // 2) Block heavy resources (big win)
      if (rt === "image" || rt === "media" || rt === "font") return req.abort();

      // 3) Block noisy/slow domains/scripts (adjust freely)
      const BLOCK_SUBSTR = [
        "youtube.com",
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "hotjar.com",
        "clarity.ms",
        "/socket.io",
        "ws-bid-new.mobasher.sa",
      ];

      if (BLOCK_SUBSTR.some((s) => url.includes(s))) return req.abort();

      return req.continue();
    } catch {
      // in case anything goes wrong, don't break the run
      try {
        return req.continue();
      } catch {}
    }
  });

  // Avoid console noise coming from failed resources
  page.on("requestfailed", () => {});

  log?.info?.("Speed mode enabled for this tab");
}

/**
 * Reuse the first about:blank tab so you always have ONE visible window and stable tab.
 */
async function getMainPage(browser, settings, log) {
  const pages = await browser.pages().catch(() => []);
  const page = pages?.[0] ? pages[0] : await browser.newPage();
  applyTimeouts(page, settings);

  // ✅ enable speed/noise mode automatically
  await enableSpeedMode(page, log);

  log.info("Main listing page ready");
  return page;
}

/**
 * Create a new tab in the same window (default context).
 */
async function newTab(browser, settings, log) {
  const page = await browser.newPage();
  applyTimeouts(page, settings);

  // ✅ enable speed/noise mode automatically
  await enableSpeedMode(page, log);

  return page;
}

/**
 * Create a fixed-size pool of tabs (for item concurrency).
 */
async function createTabPool(browser, settings, size, log) {
  const n = Math.max(1, Number(size) || 1);
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const p = await newTab(browser, settings, log);
    p.__tabNo = i + 1; // helpful for logs
    tabs.push(p);
  }
  return tabs;
}

module.exports = {
  launchBrowser,
  getMainPage,
  newTab,
  createTabPool,
  enableSpeedMode, // exported in case you want manual control
};