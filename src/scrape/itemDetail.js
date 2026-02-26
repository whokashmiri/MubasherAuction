// src/scrape/itemDetail.js
const { humanWait } = require("../util/time");

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function toNumberOrNull(raw) {
  const n = Number(String(raw || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Click tab by visible text for Mobasher "separator-tabs"
 * Works for <li> only tabs or <a> inside.
 */
async function clickSeparatorTabByText(page, tabText, settings, log) {
  const ok = await page
    .evaluate((tabText) => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

      const uls = Array.from(
        document.querySelectorAll("ul.separator-tabs, ul.nav.nav-tabs, ul.nav-tabs")
      );

      for (const ul of uls) {
        // IMPORTANT: Mobasher uses <li class="nav-link nav-item">TEXT</li>
        const lis = Array.from(ul.querySelectorAll("li.nav-link, li.nav-item, li"));
        const hit = lis.find((li) => clean(li.textContent).includes(tabText));
        if (!hit) continue;

        // sometimes there is <a> inside, but usually not
        const a = hit.querySelector("a");
        (a || hit).click();
        return true;
      }
      return false;
    }, tabText)
    .catch(() => false);

  if (!ok) {
    log?.warn?.(`Tab not found: ${tabText}`);
    return false;
  }

  // give SPA time to flip "active"
  await humanWait(120, 220);

  // wait for an active tab-pane to exist
  await page
    .waitForFunction(() => !!document.querySelector(".tab-content .tab-pane.active"), {
      timeout: Math.min(settings.opTimeoutMs || 12000, 5000),
    })
    .catch(() => null);

  await humanWait(80, 160);
  return true;
}

/**
 * Scrape title + flat breadcrumbs (you requested earlier)
 */
async function scrapeHeaderAndBreadcrumbs(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const titleEl =
      document.querySelector("h1") ||
      document.querySelector(".tw-mb-3 h1") ||
      document.querySelector("div.tw-mb-3 h1");

    const title = clean(titleEl?.textContent);

    const crumbs = Array.from(
      document.querySelectorAll("nav[aria-label='breadcrumb'] ol.breadcrumb li.breadcrumb-item")
    )
      .map((li) => {
        const a = li.querySelector("a");
        return clean(a ? a.textContent : li.textContent);
      })
      .filter(Boolean);

    const fallback = Array.from(document.querySelectorAll(".breadcrumb li"))
      .map((li) => clean(li.textContent))
      .filter(Boolean);

    return {
      title: title || null,
      breadcrumbsFlat: crumbs.length ? crumbs : fallback,
    };
  });
}

/**
 * Scrape base name + auction details table
 */
async function scrapeBaseNameAndDetails(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const body = document.querySelector("div.card-body") || document;

    // Auction Name
    let auctionName = null;
    const h6s = Array.from(body.querySelectorAll("h6.section-head"));
    for (const h of h6s) {
      const t = clean(h.textContent);
      if (t.includes("اسم المزاد")) {
        auctionName = t.replace("اسم المزاد:", "").trim();
        break;
      }
    }

    // Auction details table
    const detailsTable =
      body.querySelector("table.table.table-bordered.table-striped") ||
      body.querySelector("table.table-bordered") ||
      document.querySelector("table.table.table-bordered.table-striped") ||
      document.querySelector("table.table-bordered");

    const details = {};
    if (detailsTable) {
      for (const tr of Array.from(detailsTable.querySelectorAll("tbody tr"))) {
        const k = clean(tr.querySelector("th")?.textContent);
        const v = clean(tr.querySelector("td")?.textContent);
        if (k) details[k] = v || null;
      }
    }

    const highestOnlineBid = details["أعلى مزايدة اونلاين"] || null;

    return { auctionName: auctionName || null, auctionDetails: details, highestOnlineBid };
  });
}

/**
 * ✅ IMPORTANT: bid history on this site often renders rows but cells populate slightly later.
 * This waits until first row has >= 4 tds with non-empty text.
 */
async function waitForBidHistoryToSettle(page, settings, log) {
  const timeout = Math.min(Number(settings.bidWaitMs || 12000), 25000);

  log?.info?.(`[bid] Waiting up to ${timeout}ms for bid history to settle...`);

  await page
    .waitForFunction(() => {
      const table =
        document.querySelector(".scrollbar-container table.table.style1") ||
        document.querySelector("table.table.style1") ||
        Array.from(document.querySelectorAll("table")).find((t) =>
          (t.querySelector("thead")?.textContent || "").includes("المزايد")
        );

      const tr = table?.querySelector("tbody tr");
      if (!tr) return false;

      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 4) return false;

      // ensure at least bidder+amount have text
      const bidder = (tds[0]?.textContent || "").trim();
      const amount = (tds[1]?.textContent || "").trim();
      return bidder.length > 0 && amount.length > 0;
    }, { timeout })
    .catch(() => {
      log?.warn?.(`[bid] settle wait timeout (maybe no bids on this item)`);
    });

  // small extra pause (helps React hydration finish)
  await humanWait(200, 350);
}

/**
 * Scrape bid history table (top N rows)
 */
async function scrapeBidHistory(page, settings, log) {
  await waitForBidHistoryToSettle(page, settings, log);

  return page.evaluate((maxBids) => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    let bidTable =
      document.querySelector(".scrollbar-container table.table.style1") ||
      document.querySelector("table.table.style1");

    if (!bidTable) {
      // fallback by header contains "المزايد"
      bidTable =
        Array.from(document.querySelectorAll("table")).find((t) =>
          (t.querySelector("thead")?.textContent || "").includes("المزايد")
        ) || null;
    }

    if (!bidTable) return [];

    const trs = Array.from(bidTable.querySelectorAll("tbody tr"));
    const limit = Math.max(1, Number(maxBids) || 80);
    const slice = trs.slice(0, Math.min(limit, trs.length));

    const bids = [];
    for (const tr of slice) {
      const tds = Array.from(tr.querySelectorAll("td")).map((x) => clean(x.textContent));
      if (tds.length >= 4) {
        // IMPORTANT: only push real rows (avoid empty placeholders)
        if (!tds[0] || !tds[1]) continue;

        bids.push({
          bidder: tds[0] || null,
          amount: tds[1] || null,
          method: tds[2] || null,
          time: tds[3] || null,
        });
      }
    }
    return bids;
  }, Number(settings.maxBidRows || 80));
}

/**
 * ✅ Scrape the "separator-tabs" section:
 * - Tab 1: البيانات  => dataItem fields + notes text
 * - Tab 2: الصور    => image URLs
 * - Tab 3: العنوان  => location text
 */
async function scrapeProductTabsSection(page, settings, log) {
  // No clicking. No .active dependency.
  // We scan all panes inside the المنتج section and classify by content.
  const out = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    // Find the specific separator-tabs block that contains "البيانات" and "الصور" and "العنوان"
    const targetUl = Array.from(document.querySelectorAll("ul.separator-tabs")).find((ul) => {
      const t = clean(ul.textContent);
      return t.includes("البيانات") && t.includes("الصور") && t.includes("العنوان");
    });

    if (!targetUl) {
      return {
        productData: null,
        productNotes: { warning: null, notes: null },
        images: [],
        address: null,
        debug: { reason: "targetUl not found" },
      };
    }

    // tab-content is usually next sibling container or within same parent
    const root =
      targetUl.closest(".col-lg-12") ||
      targetUl.parentElement ||
      document;

    const tabContent =
      root.querySelector(":scope > .tab-content") ||
      root.querySelector(".tab-content");

    if (!tabContent) {
      return {
        productData: null,
        productNotes: { warning: null, notes: null },
        images: [],
        address: null,
        debug: { reason: "tabContent not found" },
      };
    }

    const panes = Array.from(tabContent.querySelectorAll(":scope > .tab-pane, .tab-pane"));

    let productData = null;
    let productNotes = { warning: null, notes: null };
    let images = [];
    let address = null;

    // helper: dedupe array
    const uniq = (arr) => {
      const seen = new Set();
      const out = [];
      for (const x of arr) {
        if (!x || seen.has(x)) continue;
        seen.add(x);
        out.push(x);
      }
      return out;
    };

    for (const pane of panes) {
      // 1) DATA pane: has .data-item
      const dataItems = Array.from(pane.querySelectorAll(".data-item"));
      if (dataItems.length) {
        const items = {};
        for (const b of dataItems) {
          const k = clean(b.querySelector(".item-label")?.textContent);
          const v = clean(b.querySelector(".item-value")?.textContent);
          if (k) items[k] = v || null;
        }

        const warning = clean(pane.querySelector("p.text-danger")?.textContent) || null;

        const notesCandidates = Array.from(pane.querySelectorAll("div.mb-3, p"))
          .map((x) => clean(x.textContent))
          .filter((t) => t && t.length > 10);

        const notes =
          notesCandidates.find((t) => t.includes("للمعاينة") || /\d{9,}/.test(t)) ||
          notesCandidates[0] ||
          null;

        productData = items;
        productNotes = { warning, notes };
        continue;
      }

      // 2) IMAGES pane: has images
      const imgs = Array.from(pane.querySelectorAll("img[src]"))
        .map((img) => (img.getAttribute("src") || "").trim())
        .filter(Boolean);

      if (imgs.length) {
        images = uniq(images.concat(imgs));
        continue;
      }

      // 3) ADDRESS pane: often just <p>الرياض</p>
      // Avoid panes with long text (like تقرير موجز)
      const p = pane.querySelector("p");
      const txt = clean(p ? p.textContent : pane.textContent);

      // "العنوان" is usually short (city name) and not a big paragraph
      if (txt && txt.length <= 40 && !txt.includes("شراء") && !txt.includes("تقرير") && !txt.includes("فيديو")) {
        // also ensure it's Arabic-ish
        const hasArabic = /[\u0600-\u06FF]/.test(txt);
        if (hasArabic) address = address || txt;
      }
    }

    return {
      productData: productData || {},
      productNotes: productNotes || { warning: null, notes: null },
      images: images || [],
      address: address || null,
      debug: {
        panesCount: panes.length,
        ulText: clean(targetUl.textContent).slice(0, 120),
      },
    };
  });

  // optional debug log
  log?.info?.(
    `[productTabs] panes=${out?.debug?.panesCount ?? "?"} images=${(out.images || []).length} dataKeys=${Object.keys(out.productData || {}).length} address=${out.address}`
  );

  return {
    productData: out.productData || {},
    productNotes: out.productNotes || { warning: null, notes: null },
    images: Array.isArray(out.images) ? out.images : [],
    address: out.address || null,
  };
}
/**
 * Existing helpers for fees/description/terms tabs in the first section
 * (kept minimal; reuse your current implementation if you want)
 */
async function clickTabByText(page, tabText, settings, log) {
  const ok = await page
    .evaluate((tabText) => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const uls = Array.from(document.querySelectorAll("ul.separator-tabs.nav.nav-tabs"));
      for (const ul of uls) {
        const lis = Array.from(ul.querySelectorAll("li.nav-link.nav-item, li"));
        const hit = lis.find((x) => clean(x.textContent).includes(tabText));
        if (!hit) continue;
        const a = hit.querySelector("a");
        (a || hit).click();
        return true;
      }
      return false;
    }, tabText)
    .catch(() => false);

  if (!ok) {
    log?.warn?.(`Tab not found: ${tabText}`);
    return false;
  }

  await humanWait(120, 240);
  await page
    .waitForFunction(() => !!document.querySelector(".tab-content .tab-pane.active"), {
      timeout: Math.min(settings.opTimeoutMs || 12000, 4000),
    })
    .catch(() => null);
  await humanWait(80, 160);
  return true;
}

async function scrapeFees(page, settings, log) {
  await clickTabByText(page, "الرسوم", settings, log);

  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const active = document.querySelector(".tab-content .tab-pane.active") || document;

    const t = active.querySelector("table.table");
    if (!t) return null;

    const rows = Array.from(t.querySelectorAll("tbody tr"));
    const items = [];
    let totalNumber = null;
    let totalWords = null;

    for (const tr of rows) {
      const thText = clean(tr.querySelector("th")?.textContent);
      const tdText = clean(tr.querySelector("td")?.textContent);

      if (!thText) continue;

      if (thText.includes("الاجمالي")) {
        const h6s = Array.from(tr.querySelectorAll("h6")).map((x) => clean(x.textContent));
        const maybeNum = h6s.find((x) => /\d/.test(x) && !x.includes("الاجمالي"));
        if (maybeNum) totalNumber = clean(maybeNum.replace(/[^\d]/g, "")) || null;

        const maybeWords = h6s.find((x) => x.includes("فقط") || x.includes("ريال"));
        totalWords = maybeWords || null;
        continue;
      }

      items.push({ fee: thText || null, value: tdText || null });
    }

    return { items, totalNumber, totalWords };
  });
}

async function scrapeDescription(page, settings, log) {
  await clickTabByText(page, "الوصف", settings, log);

  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const active = document.querySelector(".tab-content .tab-pane.active") || document;

    const t =
      active.querySelector("table.table.style2.table-borderless") ||
      active.querySelector("table.table-borderless") ||
      active.querySelector("table");

    if (!t) return null;

    const obj = {};
    for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      if (cells.length < 2) continue;

      const k = clean(cells[0]?.textContent).replace(/:$/, "").trim();
      const v = clean(cells[1]?.textContent);
      if (k) obj[k] = v || null;
    }
    return obj;
  });
}

async function scrapeTerms(page, settings, log) {
  await clickTabByText(page, "الشروط", settings, log);

  return page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const active = document.querySelector(".tab-content .tab-pane.active");
    if (!active) return null;
    const txt = clean(active.textContent);
    return txt && txt.length > 3 ? txt : null;
  });
}

/**
 * ✅ FINAL scrapeItemDetail
 */
async function scrapeItemDetail(page, settings, log) {
  // shell
  await page.waitForSelector("div.card-body", { timeout: settings.opTimeoutMs || 12000 });
  await humanWait(120, 220);

  // title + breadcrumbs
  const header = await scrapeHeaderAndBreadcrumbs(page);

  // base name/details
  const base = await scrapeBaseNameAndDetails(page);

  // bid history (settle wait)
  const bidHistory = await scrapeBidHistory(page, settings, log).catch(() => []);

  // first section tabs
  const fees = await scrapeFees(page, settings, log);
  const description = await scrapeDescription(page, settings, log);
  const terms = await scrapeTerms(page, settings, log);

  // ✅ NEW: product details section (البيانات/الصور/العنوان)
const productTabs = await scrapeProductTabsSection(page, settings, log).catch(() => ({
  productData: {},
  productNotes: { warning: null, notes: null },
  images: [],
  address: null,
}));

  // ids
  const url = page.url();
  const m = url.match(/t-details\/(\d+)/);
  const itemId = m ? m[1] : null;

  const auctionCode =
    description?.["كود المزاد"] ||
    description?.["كود المزاد :"] ||
    description?.["كود المزاد:"] ||
    null;

  const highestOnlineBidRaw = base.highestOnlineBid || null;

  return {
    _id: itemId || auctionCode || url,

    itemId: itemId || null,
    auctionCode: auctionCode || null,
    url,

    // ✅ requested
    title: header.title || null,
    breadcrumbs: Array.isArray(header.breadcrumbsFlat) ? header.breadcrumbsFlat : [],

    auctionName: base.auctionName || null,
    auctionDetails: base.auctionDetails || {},

    highestOnlineBid: {
      raw: highestOnlineBidRaw,
      number: toNumberOrNull(highestOnlineBidRaw),
    },

    bidHistory: Array.isArray(bidHistory) ? bidHistory : [],

    fees: fees || null,
    description: description || null,
    terms: terms || null,

    // ✅ new section
    productData: productTabs.productData || null,
    productNotes: productTabs.productNotes || null,
    images: Array.isArray(productTabs.images) ? productTabs.images : [],
    address: productTabs.address || null,

    scrapedAt: new Date(),
  };
}

module.exports = { scrapeItemDetail };