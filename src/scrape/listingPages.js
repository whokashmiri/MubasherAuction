// src/scrape/listingPages.js
const { humanWait } = require("../util/time");

async function waitForMainListings(page, settings, log) {
  // container must exist
  await page.waitForSelector("div.listings-wrap.live-auction.card-view", {
    timeout: settings.opTimeoutMs,
  });

  // ✅ allow SPA hydration: wait until either
  // - cards >= 10 (usually 12)
  // - OR pagination appears
  // - OR timeout
  const start = Date.now();
  const maxMs = Math.min(settings.opTimeoutMs, 15000);

  while (Date.now() - start < maxMs) {
    const snap = await page.evaluate(() => {
       const root = document.querySelector("div.listings-wrap.live-auction.card-view");
  const count = root ? root.querySelectorAll("div.listing").length : 0;
  const hasEndedBadge = !!root?.querySelector("span.ended-auction");
  const ul =
        document.querySelector("ul.pagination") ||
    document.querySelector("ul.pagination.nav") ||
    document.querySelector("ul.pagination.justify-content-center.nav");
  return { count, hasPagination: !!ul, hasEndedBadge };
    });

    if (snap.count >= 10 || snap.hasPagination || snap.hasEndedBadge) return;
    await humanWait(350, 650);
  }

  log?.info?.("Listings hydrated timeout reached; continuing anyway");
}

async function readEndedAuctionCards(page, log) {
  const res = await page.evaluate(() => {
    const root = document.querySelector("div.listings-wrap.live-auction.card-view");
    if (!root) return { ended: [], dbg: { total: 0, endedByBadge: 0, skippedByTimer: 0 } };

    const cards = Array.from(root.querySelectorAll("div.listing"));
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function hasTimer(card) {
      // timer block is huge, but simplest signals:
      // - contains "ينتهي في"
      // - or contains tw-relative countdown container
      if (norm(card.textContent).includes("ينتهي في")) return true;
      if (card.querySelector("div.tw-relative.tw-w-full.tw-max-w-3xl")) return true;
      if (card.querySelector("[class*='animate-flip']")) return true;
      return false;
    }

    function hasEndedBadge(card) {
      // exact ended badge from your HTML
      const b1 = card.querySelector("span.ended-auction");
      if (b1) return true;

      const b2 = card.querySelector("div.mt-5.mb-3 span.btn.btn-info.ended-auction");
      if (b2) return true;

      // fallback: any span with ended-auction class (some pages double space)
      const b3 = card.querySelector("span.btn.ended-auction");
      return !!b3;
    }

    const out = [];
    let endedByBadge = 0;
    let skippedByTimer = 0;

    for (const card of cards) {
      // ✅ must be ended badge
      const ended = hasEndedBadge(card);

      // ✅ skip if timer exists (running auction)
      const timer = hasTimer(card);

      if (!ended) continue;
      if (timer) {
        skippedByTimer += 1;
        continue;
      }

      endedByBadge += 1;

      const a =
        card.querySelector("h2.listing-title a") ||
        card.querySelector("a[href*='/auctions/t-container-details/']");

      const href = a?.getAttribute("href") || "";
      const title = norm(a?.textContent || "");

      let auctionId = null;
      const m = href.match(/t-container-details\/(\d+)/);
      if (m) auctionId = m[1];

      if (!href) continue;
      out.push({ href, title, auctionId });
    }

    return {
      ended: out,
      dbg: { total: cards.length, endedByBadge, skippedByTimer }
    };
  });

  if (log) log.info("ENDED CARD debug", res.dbg);
  return res.ended;
}


async function getPageState(page) {
  return await page.evaluate(() => {
    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");

    const activeA = ul?.querySelector("li.page-item.active a.page-link");
    const activeText = activeA ? activeA.textContent.trim() : "";

    const root = document.querySelector("div.listings-wrap.live-auction.card-view");
    const firstHref =
      root?.querySelector("div.listing h2.listing-title a")?.getAttribute("href") || "";
    const count = root ? root.querySelectorAll("div.listing").length : 0;

    return { activeText, firstHref, count, hasPagination: !!ul };
  });
}

async function hasNextEnabled(page) {
  return await page.evaluate(() => {
    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");

    if (!ul) return { exists: false, enabled: false };

    let nextA = ul.querySelector("a.page-link.next");

    // fallback: arrow-right icon
    if (!nextA) {
      nextA =
        Array.from(ul.querySelectorAll("a.page-link")).find((a) => a.querySelector("i.simple-icon-arrow-right")) ||
        null;
    }

    if (!nextA) return { exists: false, enabled: false };

    const nextLi = nextA.closest("li");
    const ariaDisabled = nextA.getAttribute("aria-disabled") === "true";
    const liDisabled = nextLi?.classList.contains("disabled");
    const aDisabled = nextA.classList.contains("disabled");

    const style = window.getComputedStyle(nextA);
    const peNone = style.pointerEvents === "none";

    const enabled = !(ariaDisabled || liDisabled || aDisabled || peNone);
    return { exists: true, enabled };
  });
}

async function clickNextAndWait(page, settings, log) {
  const before = await getPageState(page);

  const clicked = await page.evaluate(() => {
    const ul =
      document.querySelector("ul.pagination") ||
      document.querySelector("ul.pagination.nav") ||
      document.querySelector("ul.pagination.justify-content-center") ||
      document.querySelector("ul.pagination.justify-content-center.nav");

    if (!ul) return false;

    let nextA = ul.querySelector("a.page-link.next");
    if (!nextA) {
      nextA =
        Array.from(ul.querySelectorAll("a.page-link")).find((a) => a.querySelector("i.simple-icon-arrow-right")) ||
        null;
    }
    if (!nextA) return false;

    const nextLi = nextA.closest("li");
    if (nextLi?.classList.contains("disabled")) return false;
    if (nextA.getAttribute("aria-disabled") === "true") return false;

    nextA.click();
    return true;
  });

  if (!clicked) return false;

  await humanWait(700, 1400);

  // wait until active page changes OR first card changes
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

        const root = document.querySelector("div.listings-wrap.live-auction.card-view");
        const firstHref =
          root?.querySelector("div.listing h2.listing-title a")?.getAttribute("href") || "";

        return activeText !== b.activeText || firstHref !== b.firstHref;
      },
      { timeout: settings.opTimeoutMs },
      before
    )
    .catch(() => null);

  const after = await getPageState(page);
  const moved = after.activeText !== before.activeText || after.firstHref !== before.firstHref;

  if (moved) {
    log.info(`Moved to next page (active: ${before.activeText || "?"} -> ${after.activeText || "?"})`);
  } else {
    log.warn("Tried to move next page but state did not change");
  }

  await humanWait(600, 1200);
  return moved;
}

async function collectEndedAuctionsAcrossPages(page, settings, log) {
  await waitForMainListings(page, settings, log);

  const all = [];
  let pageNo = 1;

  for (;;) {
    const state = await getPageState(page);
    const dbg = await page.evaluate(() => ({
  uls: Array.from(document.querySelectorAll("ul")).map(u => u.className).slice(0, 30),
}));
log.info("DEBUG ul classes (first 30)" );
    log.info(
      `Scanning auctions page ${pageNo} (active=${state.activeText || "?"}, cards=${state.count}, pagination=${state.hasPagination})`
    );

    const ended = await readEndedAuctionCards(page, log);
    log.info(`Found ended auctions on this page: ${ended.length}`);
    for (const x of ended) all.push(x);

    const next = await hasNextEnabled(page);


    //no pagination 
    // ✅ If no pagination exists, we are in “single page mode”
    if (!next.exists) {
      log.info("No pagination detected => single page mode. Stopping.");
      break;
    }

    if (!next.enabled) {
      log.info("Next page disabled: reached last page");
      break;
    }

    const moved = await clickNextAndWait(page, settings, log);
    if (!moved) {
      log.warn("Could not advance to next page; stopping pagination");
      break;
    }

    pageNo += 1;
  }

  // de-dup
  const seen = new Set();
  const dedup = [];
  for (const a of all) {
    const key = a.auctionId || a.href;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(a);
  }

  return dedup;
}

module.exports = {
  collectEndedAuctionsAcrossPages,   // keep if you still want it
  waitForMainListings,
  readEndedAuctionCards,
  hasNextEnabled,
  clickNextAndWait,
  getPageState,
};