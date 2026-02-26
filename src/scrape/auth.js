const { humanWait } = require("../util/time");

async function isLoginPage(page) {
  const url = page.url() || "";
  if (url.includes("/login")) return true;

  // selector-based detection
  const hasIdentifier = await page.$('input[name="identifier"]');
  if (hasIdentifier) return true;

  // fallback: any input with aria-label like "رقم الهوية" or email
  const hasArLabel = await page.$('input[aria-label*="رقم الهوية"], input[aria-label*="البريد"]');
  if (hasArLabel) return true;

  return false;
}

async function loginIfNeeded(page, settings, log) {
  // ✅ ONLY decide based on what we see AFTER navigating target url
  const needs = await isLoginPage(page);
  if (!needs) {
    log.info("Login not required");
    return false;
  }

  if (!settings.email || !settings.password) {
    throw new Error("Login required but MOBASHER_EMAIL / MOBASHER_PASSWORD not set");
  }

  log.warn("Login required - performing login...");

  // If we aren't on /login, go there
  if (!page.url().includes("/login")) {
    await page.goto(settings.loginUrl, { waitUntil: "domcontentloaded", timeout: settings.navTimeoutMs });
    await humanWait(600, 1400);
  }

  // Wait for inputs
  await page.waitForSelector('input[name="identifier"], input[aria-label*="رقم الهوية"], input[aria-label*="البريد"]', {
    timeout: settings.opTimeoutMs,
  });

  const idSel =
    (await page.$('input[name="identifier"]')) ? 'input[name="identifier"]'
    : (await page.$('input[aria-label*="رقم الهوية"]')) ? 'input[aria-label*="رقم الهوية"]'
    : 'input[aria-label*="البريد"]';

  const passSel =
    (await page.$('input[name="password"]')) ? 'input[name="password"]'
    : 'input[type="password"]';

  await humanWait(400, 900);
  await page.click(idSel, { clickCount: 3 });
  await page.type(idSel, settings.email, { delay: 40 });

  await humanWait(500, 1100);
  await page.click(passSel, { clickCount: 3 });
  await page.type(passSel, settings.password, { delay: 40 });

  await humanWait(500, 1200);

  // click دخول
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
    const b = btns.find((x) => (x.textContent || "").includes("دخول")) || btns[0];
    b?.click?.();
    return !!b;
  });

  if (!clicked) throw new Error("Could not find login submit button");

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: settings.navTimeoutMs }).catch(() => null);
  await humanWait(800, 1600);

  const still = await isLoginPage(page);
  if (still) {
    log.error("Login appears to have failed (still seeing login)");
    return false;
  }

  log.info("Login successful");
  return true;
}

module.exports = { loginIfNeeded, isLoginPage };