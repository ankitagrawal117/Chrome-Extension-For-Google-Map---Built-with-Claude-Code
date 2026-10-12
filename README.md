# Maps Listings Collector (Chrome extension)

Collects business listings from Google Maps for a city + category (optionally
split by locality) and exports one Excel (.xlsx) file ready for a bulk
messaging tool.

Manifest V3, plain JavaScript, no build step, nothing loaded from a CDN.
SheetJS is vendored as `lib/xlsx.full.min.js`.

## The Excel file

`<category>_<city>_<YYYY-MM-DD>.xlsx`, two sheets:

**Listings**: columns in this order:

| # | Column | Notes |
|---|---|---|
| 1 | Name | Trimmed, whitespace/line breaks collapsed |
| 2 | Phone | Exactly 10 digits as a **text** cell (column format `@`), or blank |
| 3 | Area | Address segment just before the city name; fallback: the area searched |
| 4 | Rating | Number, e.g. `4.5`; blank if none |
| 5 | Reviews | Integer; blank if none |
| 6 | Address | Full address from the detail panel |
| 7 | Maps URL | Place link (query string stripped) |

**Valid Numbers Only**: just `Name` + `Phone` for rows whose phone is a valid
10-digit mobile number (starts with 6–9). Upload this sheet directly.

Both sheets have a bold, frozen header row, an autofilter and set column widths.

### Phone rules

For each listing, every phone number shown in its Maps detail panel is stored
as-is. Normalisation happens when you export (and for the live counter), in
`phone.js`:

1. Split a field holding several numbers on `/ , ; |` or "or".
2. For each number, strip all non-digits. 12 digits starting with `91` → drop
   `91`. 11 digits starting with `0` → drop `0`. Keep it only if exactly 10
   digits remain.
3. Use the first valid number. With **Mobile numbers only** ON (default),
   numbers not starting with 6/7/8/9 (landlines, after their leading 0 is
   dropped) are skipped. A listing with only a landline is kept with a blank
   Phone.
4. Never write partial/invalid numbers: anything else gives a blank cell.
5. Rows are de-duplicated by phone (first occurrence wins), and rows without a
   phone by Maps URL, so the same number never appears twice.

| Input | Mobile only ON | OFF |
|---|---|---|
| `+91 98765 43210` | `9876543210` | `9876543210` |
| `098765 43210` | `9876543210` | `9876543210` |
| `098765-43210` | `9876543210` | `9876543210` |
| `(020) 2567 1234` | blank | `2025671234` |
| `98765 43210 / 98765 43211` | `9876543210` | `9876543210` |
| `1800 123 4567` | blank | blank |
| `9876543210` | `9876543210` | `9876543210` |

The checkbox only changes the export, not the collection, so you can toggle
it after a run and download again.

## Install (load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder (the one with `manifest.json`).
5. Pin the extension from the puzzle-piece menu.

After editing files, click the reload icon on the extension's card, then reload
any open Google Maps tab.

## Usage

1. Click the extension icon.
2. Enter **City** (`Pune`) and **Category** (`Dermatologist`).
3. Optional: **Areas**, one per line (`Kothrud`, `Baner`, …). One search per
   area: `Dermatologist in Kothrud, Pune`. With no areas: `Dermatologist in Pune`.
4. Leave **Mobile numbers only** ticked for WhatsApp/SMS campaigns.
5. Click **Start**. The extension reuses the current Google Maps tab (or any
   open one), or opens one. It never opens more than one.
6. Progress shows `Area 3/12 · 87 listings · 61 valid numbers` (counts after
   phone de-duplication). The popup can be closed; every listing is saved
   immediately.
7. **Pause** / **Resume** and **Stop** work at any time. Stop keeps the data.
8. **Download Excel** is enabled as soon as one listing exists.

If data from an earlier run exists, **Start** offers: **Resume** the unfinished
run (continues at its area and skips places already collected), **New search,
keep data**, or **Clear data & start new**. **Clear data** deletes everything.

### Messages

| Message | What to do |
|---|---|
| *Google is showing a consent or CAPTCHA page…* | Go to the Maps tab, solve/accept it manually, click **Resume**. |
| *The run tab is not on Google Maps any more…* | Click **Resume** to go back. |
| *The Google Maps tab was closed…* | Click **Resume**; a new tab opens and the area is redone (collected places skipped). |
| *No results found for "…"* | That search returned nothing; the run moves on. |
| *The extension was reloaded / Chrome was restarted…* | Click **Resume**. |
| *Could not talk to the Google Maps tab…* | Reload the Maps tab, click **Resume**. |

## How it works

| File | Role |
|---|---|
| `background.js` | Service worker. Run state machine, the single Maps tab, all storage writes (serialised through a queue). State lives in `chrome.storage.local`, so the worker can be shut down at any time; `kick()` re-drives a stalled step whenever it wakes. |
| `content.js` | Runs on `google.com/maps/*`. Per area: wait for the feed, scroll until "You've reached the end of the list" (or 6 scrolls with nothing new), snapshot the cards as plain data, then for each card re-find its link by URL, click it, wait until the URL carries that place's ID *and* the named panel has rendered (or changed, for same-name chain branches), and read phone(s)/address/rating. |
| `phone.js` | Phone normaliser (shared by popup and tests). |
| `export.js` | Final rows (normalise + dedupe) and the .xlsx. |
| `popup.*` | UI and commands. |
| `lib/xlsx.full.min.js` | SheetJS Community Edition 0.18.5 (Apache-2.0, see `lib/xlsx.LICENSE`). Optional at runtime: if it is missing, `export.js` uses its built-in writer. |

- Pause/Stop: the content script checks run status before each click and during
  every delay, so both take effect within about a second.
- Delays: 800–2000 ms between listings, 4–8 s between area searches.
- During collection places are de-duplicated by Google's place ID from the URL,
  so a place found by several area searches is visited once.
- Searches append `?hl=en` so the page text the script looks for is English.
- SheetJS Community Edition cannot write bold fonts or column-level formats.
  `export.js` builds the workbook with SheetJS and then patches its
  `styles.xml`/sheet XML through SheetJS's bundled zip reader/writer
  (`XLSX.CFB`). If that patch ever fails, the plain SheetJS file is used
  instead. Phone cells are still text with format `@`; only the bold header,
  column-wide format and frozen row are lost.

### Built-in fallback writer

`export.js` also contains a small dependency-free .xlsx writer (an
uncompressed zip with the same sheets, bold frozen header, widths,
autofilter, and Phone as `@` text). It is used when SheetJS is not loaded,
for example if the `lib/` folder was not copied, or if SheetJS throws. The
popup's DevTools console then logs `SheetJS (lib/xlsx.full.min.js) not
loaded, using built-in writer`. Both paths are covered by
`tests/export.test.js`.

## Troubleshooting

| Problem | Fix |
|---|---|
| *Could not build the Excel file: Cannot read properties of null (reading 'utils')* | Fixed in 1.1.1: the export no longer depends on SheetJS being present. Update all files, keep the `lib/` folder, and click reload on the extension card. |
| Popup shows an old version / old error | `chrome://extensions` → reload icon on the card, then close and reopen the popup. |
| Want to see why something failed | Right-click inside the popup → **Inspect** → Console. |

## Tests

```
node tests/phone.test.js     # phone normaliser, all required cases
node tests/export.test.js    # rows, dedupe, sheets, Phone = text "@" cells
```

Or open `tests/test.html` in Chrome (drag the file into a tab) for the phone tests.

## Updating selectors when Google Maps changes

All DOM knowledge is in the `SELECTORS`, `TEXT` and `TIMING` objects at the top
of `content.js`.

1. Open a Maps search, press F12, use the element picker on what broke.
2. Prefer `role`, `aria-label`, `data-item-id` over generated class names.
3. Try it in the console, e.g.
   `document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]').length`.
4. Update the entry, reload the extension, reload the Maps tab.

| Key | Must match |
|---|---|
| `feed` | Scrollable results list |
| `resultLink` | One link per result card (`aria-label` = name, `href` = place URL) |
| `detailPanel` | Place detail pane (`aria-label` = place name) |
| `detailTitle` | Name heading in the pane |
| `phoneButton` | Phone row(s): `data-item-id="phone:tel:…"` |
| `addressButton` | Address row: `data-item-id="address"` |
| `overviewRow` | Any info row; ratings above the first one are the header rating |
| `ratingImage` | Elements labelled like `4.5 stars` |
| `blocked` | Consent / CAPTCHA forms |
| `TEXT.endOfList`, `TEXT.noResults`, `TEXT.blocked` | English page texts |

Slow connection? Raise `TIMING.panelTimeout` / `TIMING.panelFieldsTimeout`.

## Known limits

- Maps shows at most about 120 results per search; split big cities into areas.
- Keep the Maps tab **visible** (its own window is best). Chrome throttles
  background tabs and the run slows to a crawl.
- Don't move the map during a run. With "Update results when map moves" on,
  the list can be replaced.
- About 2–4 s per listing plus scrolling: 500 listings ≈ 25–35 minutes.
- Phone rules are India-specific (10-digit numbers, `91`/`0` prefixes).
- Area parsing depends on the city name appearing in the address; common
  old/new names (Bangalore/Bengaluru, Bombay/Mumbai, Gurgaon/Gurugram, …) are
  handled.
- Rating/reviews come from the result card, falling back to the panel header.
- Heavy use can trigger Google's CAPTCHA; the run stops and waits for you.
- SheetJS 0.18.5 is the last release on npm. Its published advisories concern
  *reading* untrusted spreadsheets; this extension only writes files.
- Automated collection may conflict with Google's Terms of Service, and bulk
  messaging is regulated (e.g. TRAI DND rules in India). Use responsibly.
- `chrome.storage.local` holds 10 MB: about 20,000 listings.

## Manual test checklist

**1. Small city, narrow category**
- [ ] Load unpacked: no errors on the extension card.
- [ ] City `Satara`, Category `Dermatologist`, no areas, mobile only ✓ → Start.
- [ ] One Maps tab is opened or reused; the feed scrolls to "end of the list".
- [ ] Each listing is clicked in turn; progress increases; ends **Done**.
- [ ] Spot-check 5 rows against Maps: phone, address, area, rating, reviews.

**2. Area-split run**
- [ ] City `Pune`, Category `Dermatologist`, Areas `Kothrud`, `Baner`, `Aundh`.
- [ ] Searches run one after another with a pause in between.
- [ ] A clinic appearing in two areas is one row.
- [ ] Add a nonsense area (`Zzqx`): "No results found" message, run continues.

**3. Pause / resume / persistence**
- [ ] Pause mid-area: counter stops. Resume: continues from the next listing.
- [ ] Close and reopen the popup mid-run: progress still live.
- [ ] Stop, then Start: **Resume** is offered; collected places aren't clicked again.
- [ ] Close the Maps tab mid-run: Paused with a message; Resume opens a new tab.
- [ ] Reload the extension mid-run, reopen popup: data kept, Resume works.

**4. Excel file**
- [ ] Download: file named like `Dermatologist_Pune_2026-10-12.xlsx`; opens without a repair prompt.
- [ ] Sheets **Listings** and **Valid Numbers Only**; header bold and frozen.
- [ ] Columns exactly: Name, Phone, Area, Rating, Reviews, Address, Maps URL.
- [ ] **Phone shows full 10-digit text** (e.g. `9876543210`): no `9.88E+09`, no `+91`, no leading 0, no spaces.
- [ ] Select a Phone cell → Format Cells shows **Text**; select the empty cell below the last row in column B → also **Text**.
- [ ] Phone values left-aligned (text); a green "number stored as text" marker is fine.
- [ ] No phone number appears twice in the Phone column.
- [ ] Landline-only listings have a blank Phone with mobile-only ON; untick it, download again, landlines appear as 10 digits.
- [ ] **Valid Numbers Only** contains only numbers starting 6–9.
- [ ] Rating is numeric (can be averaged), Reviews is integer.
- [ ] Names in Devanagari/Tamil etc. display correctly.
- [ ] Upload **Valid Numbers Only** to your bulk messaging tool; numbers are accepted.
