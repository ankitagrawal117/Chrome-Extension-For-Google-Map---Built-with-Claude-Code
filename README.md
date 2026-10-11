# Maps Listings Collector (Chrome extension)

Collects business listings from Google Maps for a city + category (optionally
split by locality) and exports them as one CSV file.

Manifest V3, plain JavaScript, no build step, no dependencies.

| Column | Source |
|---|---|
| Name | Result card / detail panel title |
| Phone | Detail panel (`button[data-item-id^="phone:tel:"]`), blank if absent |
| Area | Parsed from the address (see below) |
| Address | Detail panel (`button[data-item-id="address"]`) |
| Rating, Review Count | Result card's star label; detail panel header as fallback |
| Google Maps URL | The listing's place link (query string stripped) |
| Search Query | The search that first found the listing |
| Also Found By | Other searches (areas) that returned the same place |
| Searched Area, City, Category, Collected At | Run metadata |

## Install (load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or Edge/Brave).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu so the popup is one click away.

After editing any file, click the reload icon on the extension's card in
`chrome://extensions`, then reload any open Google Maps tab.

## Usage

1. Click the extension icon.
2. Enter **City** (e.g. `Pune`) and **Category** (e.g. `Dermatologist`).
3. Optional: list **Areas**, one per line (e.g. `Kothrud`, `Baner`). One
   search runs per area: `Dermatologist in Kothrud, Pune`. With no areas a
   single search `Dermatologist in Pune` runs.
4. Click **Start**. The extension reuses the current Google Maps tab (or any
   open Maps tab), or opens one. It never opens more than one.
5. Watch the progress line (`Area 3/12 · 87 listings collected`). You can close
   the popup; the run continues and every listing is saved immediately.
6. **Pause** / **Resume** and **Stop** work at any time. Stop keeps the data.
7. **Download CSV** is enabled as soon as one listing exists. The file is named
   `<category>_<city>_<YYYY-MM-DD>.csv`.

When previous data exists, **Start** asks whether to:
- **Resume** the unfinished run (continues at the area where it stopped and
  skips places already collected),
- **New search, keep data** (adds to the existing rows, de-duplicated), or
- **Clear data & start new**.

**Clear data** (below the download button) deletes everything collected.

### Messages you may see

| Message | What to do |
|---|---|
| *Google is showing a consent or CAPTCHA page…* | Switch to the Maps tab, accept/solve it manually, then click **Resume**. |
| *The run tab is not on Google Maps any more…* | You navigated the run tab elsewhere. Click **Resume** to go back. |
| *The Google Maps tab was closed…* | Click **Resume**; a new Maps tab opens and the current area is redone (collected places are skipped). |
| *No results found for "…"* | That area returned nothing; the run moves on to the next area. |
| *Could not talk to the Google Maps tab…* | Reload the Maps tab, then **Resume**. |

## How it works

- `background.js` (service worker) owns the run state machine, the single Maps
  tab and every write to `chrome.storage.local` (serialised through a queue,
  so concurrent messages cannot overwrite each other). State lives in storage,
  not memory, so it survives the worker being shut down. A `kick()` routine runs
  whenever the worker wakes up (any message, opening the popup) and restarts a
  step that stalled while it slept.
- `content.js` runs on `https://www.google.com/maps/*`. For each area it waits
  for the results feed, scrolls it until *"You've reached the end of the list"*
  (or 6 scrolls with no new cards), snapshots the cards as plain data (no
  element references kept), then for each card re-finds the link by its URL,
  clicks it, waits until the URL carries that place's ID **and** the panel
  with that name has rendered, and reads phone/address/rating.
- Before every click and during every delay the content script checks the
  run status in storage, so Pause/Stop take effect within about a second.
- Delays: 800–2000 ms (random) between listings, 4–8 s between area searches.
- De-duplication: by Google's place feature ID from the URL
  (`!1s0x…:0x…`), falling back to name + phone digits. Duplicates found by
  another area's search are recorded in **Also Found By**.
- Searches append `?hl=en` so on-page text (end-of-list marker, labels) is in
  English regardless of your Google language.

### Area parsing

The address is split on commas; a leading plus code, and trailing country,
state, PIN code and city segments are removed; the last remaining segment is
the area. If the area you searched for appears in the address, that name is
used instead.
`Shop 5, ABC Complex, Kothrud, Pune, Maharashtra 411038` → `Kothrud`.

### CSV format

- UTF-8 with BOM, CRLF line endings, every field quoted, `"` doubled, so
  commas, quotes, newlines and Indian scripts open correctly in Excel.
- Phone numbers are written as `="+91 98765 43210"` so Excel keeps them as
  text (no `9.19877E+11`, leading zeros kept). Google Sheets and LibreOffice
  handle this too.
- Text cells starting with `=`, `+` or `@` are prefixed with `'` so they are
  not evaluated as formulas.

## Updating selectors when Google Maps changes

All DOM knowledge is in the `SELECTORS`, `TEXT` and `TIMING` objects at the top
of `content.js`. To fix a broken selector:

1. Open a Google Maps search, press F12, and use the element picker on the
   part that stopped working (result link, phone row, address row…).
2. Prefer stable hooks: `role`, `aria-label`, `data-item-id`. Avoid generated
   class names where possible (`a.hfpxzc` is kept only as one alternative).
3. Test in the DevTools console, e.g.
   `document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]').length`.
4. Update the entry, reload the extension in `chrome://extensions`, reload the
   Maps tab.

| Key | What it must match |
|---|---|
| `feed` | The scrollable results list |
| `resultLink` | One link per result card (its `aria-label` is the name, `href` the place URL) |
| `detailPanel` | The place detail pane (its `aria-label` is the place name) |
| `detailTitle` | Place name heading inside the pane |
| `phoneButton`, `addressButton` | The phone / address rows in the pane |
| `overviewRow` | Any info row; ratings above the first one are the header rating |
| `ratingImage` | Elements whose `aria-label` reads like `4.5 stars` |
| `blocked` | Consent / CAPTCHA forms |
| `TEXT.endOfList`, `TEXT.noResults`, `TEXT.blocked` | English page texts |

If panels are slow on your connection, increase `TIMING.panelTimeout` /
`TIMING.panelFieldsTimeout`.

## Known limits

- Google Maps shows at most about 120 results per search. Split big cities
  into areas to get more coverage.
- Keep the Maps tab **visible** (its own window is best). Chrome throttles
  timers in background tabs heavily after a few minutes, which slows the run
  to a crawl.
- Leave the map alone during a run. If "Update results when map moves" is on,
  panning can replace the result list.
- Expect roughly 2–4 seconds per listing plus scrolling; 500 listings ≈ 25–35
  minutes.
- Area parsing is heuristic and tuned for Indian address formats.
- The rating comes from the result card; review counts written as "1.2K" are
  converted to 1200 (approximate).
- Heavy use can trigger Google's CAPTCHA. The run stops and waits for you.
- Scraping may conflict with Google's Terms of Service. Use responsibly, at
  low volume, for your own research.
- Storage uses `chrome.storage.local` (10 MB): about 20,000 listings.

## Manual test checklist

**1. Small single search**
- [ ] Load unpacked; no errors on the extension card.
- [ ] City `Satara`, Category `Dermatologist`, no areas → Start.
- [ ] A Maps tab opens (or the current one is reused); only one Maps tab.
- [ ] Progress line shows `Area 1/1 · N listings collected` and increases.
- [ ] The feed scrolls to "You've reached the end of the list".
- [ ] Each listing is clicked in turn; status ends as **Done**.
- [ ] Spot-check 5 rows against Maps: phone, address, rating, reviews.

**2. Area-split run**
- [ ] City `Pune`, Category `Dermatologist`, Areas `Kothrud`, `Baner`, `Aundh`.
- [ ] Searches run one after another with a pause between.
- [ ] A clinic appearing in two areas is one row, with the second search in **Also Found By**.
- [ ] Add a nonsense area (`Zzqx`) → "No results found" message, run continues.

**3. Pause / resume / persistence**
- [ ] Pause mid-area → count stops; Resume → continues from the next listing.
- [ ] Close the popup during a run and reopen it → progress is still live.
- [ ] Stop → Start → prompt offers **Resume** → run continues; already
      collected places are not clicked again.
- [ ] Close the Maps tab mid-run → status Paused with a message → Resume opens a new tab.
- [ ] Reload the extension mid-run, reopen popup → data still there, Resume works.

**4. CSV in Excel**
- [ ] Download → file named like `Dermatologist_Pune_2026-10-11.csv`.
- [ ] Open by double-clicking in Excel: columns split correctly.
- [ ] Phones show as text (`+91 98765 43210`, `020…` keeps the leading 0), not `9.19E+11`.
- [ ] Names with commas, quotes, or Devanagari/Tamil text display correctly.
- [ ] Download CSV is enabled once the first listing is collected.

**5. Blocked page**
- [ ] In a fresh profile (EU consent) or after a CAPTCHA, the run shows
      *Action needed* with instructions; after solving, Resume continues.

## Files

```
manifest.json   MV3 manifest (storage, tabs, scripting; host www.google.com/maps/*)
background.js   Service worker: run state, tab control, storage writes
content.js      Scraper (SELECTORS config at the top)
popup.html/css/js  UI, commands, CSV export
icons/          Placeholder icons (16/32/48/128)
```
