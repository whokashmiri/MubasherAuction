// src/scrape/auction.js
const { humanWait } = require("../util/time");

const BASE = "https://re.mobasher.sa";

function absUrl(href) {
  if (!href) return href;
  if (href.startsWith("http")) return href;
  return BASE + href;
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/**
 * Wait until auction items list is present + hydrated.
 */
async function waitForAuctionListings(page, settings, log) {
  await page.waitForSelector("div.listings-wrap.timed-auctions.list-view", {
    timeout: settings.opTimeoutMs,
  });

  const start = Date.now();
  const maxMs = Math.min(settings.opTimeoutMs, 15000);

  while (Date.now() - start < maxMs) {
    const snap = await page.evaluate(() => {
      const root = document.querySelector("div.listings-wrap.timed-auctions.list-view");
      const count = root ? root.querySelectorAll("div.listing").length : 0;

      const ul =
        document.querySelector("ul.pagination") ||
        document.querySelector("ul.pagination.nav") ||
        document.querySelector("ul.pagination.justify-content-center") ||
        document.querySelector("ul.pagination.justify-content-center.nav");

      return { count, hasPagination: !!ul };
    });

    // usually 10-20+; but allow 1+ as "hydrated"
    if (snap.count > 0 || snap.hasPagination) return;
    await humanWait(250, 500);
  }

  log?.info?.("[auction] listings hydration timeout; continuing anyway");
}

/**
 * Read items from *current* auction page (no pagination here).
 */
async function readItemsFromCurrentAuctionPage(page) {
  return await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("div.listings-wrap.timed-auctions.list-view");
    if (!root) return [];

    const listings = Array.from(root.querySelectorAll("div.listing"));
    const out = [];

    for (const li of listings) {
      const a = li.querySelector("h2.listing-title a");
      const href = a?.getAttribute("href") || "";
      const title = clean(a?.textContent);

      let itemId = null;
      const m = href.match(/t-details\/(\d+)/);
      if (m) itemId = m[1];

      if (href && itemId) out.push({ href, title, itemId });
    }

    return out;
  });
}

/**
 * Auction pagination helpers:
 * - "second last li" is the NEXT button in your HTML (… <li next> <li last>)
 * - stop when that li is disabled
 */
async function getAuctionPageState(page) {
  return await page.evaluate(() => {
    const root = document.querySelector("div.listings-wrap.timed-auctions.list-view");
    const count = root ? root.querySelectorAll("div.listing").length : 0;

    const firstHref =
      root?.querySelector("div.listing h2.listing-title a")?.getAttribute("href") || "";

    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");

    const activeA = ul?.querySelector("li.page-item.active a.page-link");
    const activeText = activeA ? activeA.textContent.trim() : "";

    return { count, firstHref, activeText, hasPagination: !!ul };
  });
}

async function hasNextEnabledAuction(page) {
  return await page.evaluate(() => {
    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");

    if (!ul) return { exists: false, enabled: false };

    // ✅ "second last li" (NEXT)
    const lis = Array.from(ul.querySelectorAll("li.page-item"));
    if (lis.length < 2) return { exists: false, enabled: false };

    const nextLi = lis[lis.length - 2];
    const nextA = nextLi.querySelector("a.page-link") || null;

    if (!nextA) return { exists: false, enabled: false };

    const ariaDisabled = nextA.getAttribute("aria-disabled") === "true";
    const liDisabled = nextLi.classList.contains("disabled");
    const aDisabled = nextA.classList.contains("disabled");

    const style = window.getComputedStyle(nextA);
    const peNone = style.pointerEvents === "none";

    const enabled = !(ariaDisabled || liDisabled || aDisabled || peNone);
    return { exists: true, enabled };
  });
}

async function clickNextAndWaitAuction(page, settings, log) {
  const before = await getAuctionPageState(page);

  const clicked = await page.evaluate(() => {
    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");
    if (!ul) return false;

    const lis = Array.from(ul.querySelectorAll("li.page-item"));
    if (lis.length < 2) return false;

    const nextLi = lis[lis.length - 2];
    const nextA = nextLi.querySelector("a.page-link") || null;

    if (!nextA) return false;
    if (nextLi.classList.contains("disabled")) return false;
    if (nextA.getAttribute("aria-disabled") === "true") return false;

    nextA.click();
    return true;
  });

  if (!clicked) return false;

  // allow SPA update
  await humanWait(600, 1200);

  // Wait for active page OR first card to change
  await page
    .waitForFunction(
      (b) => {
        const ul =
          document.querySelector("ul.pagination") ||
          document.querySelector("ul.pagination.nav") ||
          document.querySelector("ul.pagination.justify-content-center") ||
          document.querySelector("ul.pagination.justify-content-center.nav");

        const activeA = ul?.querySelector("li.page-item.active a.page-link");
        const activeText = activeA ? activeA.textContent.trim() : "";

        const root = document.querySelector("div.listings-wrap.timed-auctions.list-view");
        const firstHref =
          root?.querySelector("div.listing h2.listing-title a")?.getAttribute("href") || "";

        return activeText !== b.activeText || firstHref !== b.firstHref;
      },
      { timeout: settings.opTimeoutMs },
      before
    )
    .catch(() => null);

  const after = await getAuctionPageState(page);
  const moved = after.activeText !== before.activeText || after.firstHref !== before.firstHref;

  if (moved) {
    log?.info?.(
      `[auction] moved next (active: ${before.activeText || "?"} -> ${after.activeText || "?"})`
    );
  } else {
    log?.warn?.("[auction] tried to move next but state did not change");
  }

  await humanWait(450, 900);
  return moved;
}

/**
 * ✅ NEW: Read ALL items across auction pagination (if pagination exists).
 * Stops when "second last li" becomes disabled.
 */
async function readEndedItemsFromAuctionPages(page, settings, log, auctionMeta) {
  await waitForAuctionListings(page, settings, log);

  const auctionUrl = page.url();
  const auctionId =
    auctionMeta?.auctionId ||
    (() => {
      const m = auctionUrl.match(/t-container-details\/(\d+)/);
      return m ? m[1] : null;
    })();

  const all = [];
  let pageNo = 1;

  for (;;) {
    const state = await getAuctionPageState(page);
    log?.info?.(
      `[auction] PAGE ${pageNo} (active=${state.activeText || "?"}, cards=${state.count}, pagination=${state.hasPagination})`
    );

    const items = await readItemsFromCurrentAuctionPage(page);

    for (const it of items) {
      all.push({
        ...it,
        url: absUrl(it.href),
        auctionId,
        auctionTitle: auctionMeta?.title || null,
        auctionUrl,
      });
    }

    const next = await hasNextEnabledAuction(page);

    // ✅ no pagination => single page
    if (!next.exists) {
      log?.info?.("[auction] no pagination detected => single page mode");
      break;
    }

    // ✅ next disabled => end
    if (!next.enabled) {
      log?.info?.("[auction] next (second last li) disabled => reached last page");
      break;
    }

    const moved = await clickNextAndWaitAuction(page, settings, log);
    if (!moved) {
      log?.warn?.("[auction] could not advance => stopping pagination");
      break;
    }

    // tiny settle so cards finish rendering
    await humanWait(300, 650);

    pageNo += 1;
  }

  // de-dup by itemId (safe)
  const seen = new Set();
  const dedup = [];
  for (const x of all) {
    const key = x.itemId || x.url || x.href;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(x);
  }

  log?.info?.(`Auction ${auctionId || ""} items (all pages): ${dedup.length}`);
  return dedup;
}

/**
 * Backward-compatible function:
 * - keeps your old name but now returns ALL pages automatically
 */
async function readEndedItemsFromAuctionPage(page, settings, log, auctionMeta) {
  return readEndedItemsFromAuctionPages(page, settings, log, auctionMeta);
}

module.exports = {
  absUrl,
  readEndedItemsFromAuctionPage,   // now paginates
  readEndedItemsFromAuctionPages,  // explicit
};