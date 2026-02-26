# Mobasher Ended Auctions Scraper (Motors)

Scrapes **ended** motor auctions from:
- `https://re.mobasher.sa/?cat=motors`

Flow:
1. Open the motors auctions list.
2. If redirected / login form appears, it logs in using `MOBASHER_EMAIL` + `MOBASHER_PASSWORD`.
3. Paginate through all pages.
4. Collect auctions that have the **ended badge**: `span.ended-auction` with text `مزاد منتهي`.
5. Open each ended auction, collect ended items.
6. Open each item detail page and scrape:
   - `title` (from the `h1`)
   - `breadcrumbs` (flattened array)
7. Save to MongoDB with `_id = itemId` to avoid duplicates.
8. After finishing, sleeps `CHECK_INTERVAL_HOURS` and repeats.

## Install

```bash
npm i
```

## Configure

Copy env example:

```bash
cp .env.example .env
```

Fill `MONGO_URI` and optionally login creds.

## Run

```bash
npm start
```

## Notes
- Uses `puppeteer-extra` + `stealth` plugin.
- Lots of console logs are enabled to see what is happening.
- Random human waits are added between actions.
