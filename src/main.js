// src/main.js
const { getSettings } = require("./core/config");
const { makeLogger } = require("./core/logger");
const { launchBrowser, getMainPage, newTab } = require("./core/browser");
const { getCollection, upsertIfNew, closeMongo } = require("./core/db");

const { humanWait, hours, sleep } = require("./util/time");
const { loginIfNeeded } = require("./scrape/auth");

const {
  waitForMainListings,
  readEndedAuctionCards,
  hasNextEnabled,
  clickNextAndWait,
  getPageState,
} = require("./scrape/listingPages");

const { absUrl, readEndedItemsFromAuctionPage } = require("./scrape/auction");
const { scrapeItemDetail } = require("./scrape/itemDetail");

const log = makeLogger("MAIN");

// --- quiet logs: only warn on 403/429 responses ---
function attachPageLogs(page, scope = "PAGE") {
  if (page.__eventsAttached) return;
  page.__eventsAttached = true;

  page.on("console", () => {});
  page.on("pageerror", () => {});
  page.on("response", (resp) => {
    const st = resp.status();
    if (st === 403 || st === 429) log.warn(`[${scope}] HTTP ${st} ${resp.url()}`);
  });
}

async function gotoSafe(page, url, settings, scopeLog) {
  scopeLog.info(`goto: ${url}`);
  const resp = await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: settings.navTimeoutMs })
    .catch(() => null);

  const st = resp?.status?.() ?? null;
  scopeLog.info(`nav status: ${st} current url: ${page.url()}`);
  await humanWait(350, 750);
  return st;
}

// ✅ Create item tabs pool (size = itemConcurrency)
// NOTE: we label them as tab=3.. in logs (listing=1, auction=2)
async function createItemTabs(browser, settings, count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    const p = await newTab(browser, settings);
    attachPageLogs(p, `DET-${i + 1}`);
    p.__tabNo = i + 3; // <-- important for your logging expectation
    tabs.push(p);
  }
  return tabs;
}

/**
 * ✅ Worker Pool (stable)
 * - push(job) returns Promise<{ inserted: boolean, id: string|null }>
 * - workers never die (they keep looping even if a job fails)
 * - supports "await batch" per auction
 */
function createItemWorkers(itemTabs, settings, col) {
  const jobs = [];
  const waiters = [];
  let stopped = false;

  function push(job) {
    if (stopped) return Promise.resolve({ inserted: false, id: null });

    return new Promise((resolve) => {
      jobs.push({ job, resolve });

      // wake ONE worker
      const w = waiters.shift();
      if (w) w();
    });
  }

  async function pop() {
    while (jobs.length === 0) {
      if (stopped) return null;
      await new Promise((res) => waiters.push(res));
    }
    return jobs.shift();
  }

  async function workerLoop(tab, tabNoDisplay) {
    const wlog = makeLogger(`W${tabNoDisplay}`);
    wlog.info(`Worker started on tab=${tabNoDisplay}`);

    while (!stopped) {
      let entry = null;

      try {
        entry = await pop();
        if (!entry) break;

        const { job, resolve } = entry;
        const { it, auctionCtx } = job;

        const itemLog = makeLogger(`ITEM-${it.itemId || "X"}`);
        itemLog.info(`OPEN ITEM ${it.itemId} (tab=${tabNoDisplay}) => ${it.url}`);

        let inserted = false;
        let savedId = null;

        try {
          await gotoSafe(tab, it.url, settings, itemLog);

          const detail = await scrapeItemDetail(tab, settings, itemLog);

          detail.auctionId = auctionCtx.auctionId || null;
          detail.auctionTitle = auctionCtx.auctionTitle || null;
          detail.auctionUrl = auctionCtx.auctionUrl || null;

          const res = await upsertIfNew(col, detail);
          inserted = !!res?.inserted;
          savedId = detail?._id ?? null;

          if (inserted) itemLog.info(`SAVED NEW ${savedId}`);
          else itemLog.info(`SKIP EXISTS ${savedId}`);
        } catch (e) {
          itemLog.error("ITEM FAILED", { url: it.url, err: String(e) });
        } finally {
          // always resolve the job promise
          resolve({ inserted, id: savedId });
          await humanWait(150, 350);
        }
      } catch (loopErr) {
        // ✅ critical: never let worker die
        wlog.warn("Worker loop error (continuing)", String(loopErr));
        await humanWait(300, 600);
      }
    }

    wlog.info("Worker stopped");
  }

  // ✅ deterministic tab numbers: listing=1, auction=2, workers=3..
  const workers = itemTabs.map((tab, idx) => workerLoop(tab, idx + 3));

  async function stop() {
    stopped = true;
    // wake all waiting workers so pop() can exit
    while (waiters.length) waiters.shift()();
    await Promise.allSettled(workers);
  }

  return { push, stop };
}
async function runOnce(browser, listingPage, auctionPage, itemTabs, settings, col) {
  const runLog = makeLogger("RUN");

  // ----- listing tab (tab 1) -----
  attachPageLogs(listingPage, "LIST");
  runLog.info("Opening start URL");
  await gotoSafe(listingPage, settings.startUrl, settings, runLog);

  await loginIfNeeded(listingPage, settings, runLog);
  if (!listingPage.url().startsWith(settings.startUrl)) {
    await gotoSafe(listingPage, settings.startUrl, settings, runLog);
  }

  await waitForMainListings(listingPage, settings, runLog);

  // ----- auction tab (tab 2) -----
  attachPageLogs(auctionPage, "AUC");

  // ----- item workers (tabs 3..N) -----
  const workers = createItemWorkers(itemTabs, settings, col);

  const processedAuctions = new Set();
  const counters = { auctions: 0, items: 0, newSaved: 0 };

  let pageNo = 1;

  try {
    for (;;) {
      const state = await getPageState(listingPage);
      runLog.info(`LIST PAGE ${pageNo} (active=${state.activeText || "?"}, cards=${state.count})`);

      const endedAuctions = await readEndedAuctionCards(listingPage, runLog);
      runLog.info(`ENDED auctions on this page: ${endedAuctions.length}`);

      // Process auctions sequentially on the ONE auction tab
      for (const auction of endedAuctions) {
        const key = auction.auctionId || auction.href;
        if (!key || processedAuctions.has(key)) continue;
        processedAuctions.add(key);
        counters.auctions++;

        const auctionUrl = absUrl(auction.href);
        runLog.info(`OPEN AUCTION ${auction.auctionId} => ${auctionUrl}`);

        // ✅ tab 2 stays here until THIS auction's items are done
        await gotoSafe(auctionPage, auctionUrl, settings, runLog);

        let items = [];
        try {
          items = await readEndedItemsFromAuctionPage(auctionPage, settings, runLog, auction);
        } catch (e) {
          runLog.error("readEndedItemsFromAuctionPage failed", String(e));
          continue;
        }

        runLog.info(`AUCTION ${auction.auctionId} items: ${items.length}`);

        // enqueue items and collect completion promises
        const batch = [];
        for (const it of items) {
          if (!it?.url || !it?.itemId) continue;
          counters.items++;

          batch.push(
            workers.push({
              it,
              auctionCtx: {
                auctionId: it.auctionId,
                auctionTitle: it.auctionTitle,
                auctionUrl: it.auctionUrl,
              },
            })
          );
        }

        // ✅ THIS is the missing piece:
        // Wait until ALL items of this auction are finished before moving tab 2
        if (batch.length) {
          runLog.info(`WAIT AUCTION ${auction.auctionId} batch (${batch.length} items) ...`);
          const results = await Promise.allSettled(batch);

// ✅ count inserted from worker results
        for (const r of results) {
          if (r.status === "fulfilled" && r.value?.inserted) {
           counters.newSaved += 1;
            }
        }
          runLog.info(`DONE AUCTION ${auction.auctionId} batch`);
        }

        await humanWait(250, 600);
      }

      // paginate listing (tab 1)
      const next = await hasNextEnabled(listingPage);
      if (!next.exists) {
        runLog.info("No pagination => stopping");
        break;
      }
      if (!next.enabled) {
        runLog.info("Next disabled => last page");
        break;
      }

      const moved = await clickNextAndWait(listingPage, settings, runLog);
      if (!moved) break;

      pageNo++;
      await humanWait(250, 600);
    }

    runLog.info(`DONE auctions=${counters.auctions} items=${counters.items} newSaved=${counters.newSaved}`);
    return counters;
  } finally {
    await workers.stop();
  }
}


async function main() {
  const settings = getSettings();

  log.info("Boot settings", {
    startUrl: settings.startUrl,
    headless: settings.headless,
    db: `${settings.dbName}.${settings.collectionName}`,
    checkIntervalHours: settings.checkIntervalHours,
    itemConcurrency: settings.itemConcurrency,
  });

  const col = await getCollection(settings, log);
  const browser = await launchBrowser(settings, log);

  // ✅ tabs: listing (1), auction (2), item workers (3..)
  const listingPage = await getMainPage(browser, settings, log);
  log.info("Main listing page ready");
  attachPageLogs(listingPage, "LIST");

  const auctionPage = await newTab(browser, settings);
  attachPageLogs(auctionPage, "AUC");

  const workerCount = Math.max(1, Number(settings.itemConcurrency) || 1);
  const itemTabs = await createItemTabs(browser, settings, workerCount);
  log.info(`Item tabs pool ready: ${itemTabs.length}`);

  try {
    let runNo = 1;
    for (;;) {
      log.info(`=== RUN #${runNo} START ===`);
      const res = await runOnce(browser, listingPage, auctionPage, itemTabs, settings, col);
      log.info(`=== RUN #${runNo} END ===`, res);

      try {
        await gotoSafe(listingPage, settings.startUrl, settings, log);
      } catch {}

      const ms = hours(settings.checkIntervalHours);
      log.info(`Sleeping for ${settings.checkIntervalHours} hours...`);
      await sleep(ms);

      runNo++;
    }
  } finally {
    await browser.close().catch(() => null);
    await closeMongo(log);
  }
}

main().catch((e) => {
  log.error("Fatal", String(e));
  process.exitCode = 1;
});