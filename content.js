// Content script for https://www.google.com/maps/*
// Receives one "collect" job per area search from the service worker, scrolls
// the results feed, opens each result's detail panel and reports listings back.

(() => {
  if (window.__mapsListingsCollector) return; // injected twice (manifest + executeScript)
  window.__mapsListingsCollector = true;

  // -------------------------------------------------------------------------
  // SELECTORS — everything that depends on Google Maps' DOM lives here.
  // Prefer role / aria-label / data-item-id hooks over generated class names.
  // See README → "Updating selectors" when Maps changes its layout.
  const SELECTORS = {
    // Scrollable results list on a search page.
    feed: 'div[role="feed"]',
    // One link per result card inside the feed (aria-label = place name).
    resultLink: 'a.hfpxzc, a[href*="/maps/place/"]',
    // Detail pane; Maps labels it with the place name.
    detailPanel: 'div[role="main"][aria-label]',
    detailTitle: 'h1',
    phoneButton: 'button[data-item-id^="phone:tel:"], a[data-item-id^="phone:tel:"]',
    addressButton: 'button[data-item-id="address"], a[data-item-id="address"]',
    // Any overview row with a data-item-id; ratings above the first one belong
    // to the place header (below it are individual reviews).
    overviewRow: '[data-item-id]',
    // "4.5 stars" in the panel header, "4.5 stars 120 Reviews" on list cards.
    ratingImage: '[role="img"][aria-label]',
    // "1,234 reviews"
    reviewCountLabel: '[aria-label]',
    // Consent / CAPTCHA interstitials.
    blocked: 'form[action*="consent.google"], iframe[src*="recaptcha"], #captcha-form, form[action*="/sorry/"]',
  };

  const TEXT = {
    endOfList: /you['’]ve reached the end of the list/i,
    noResults: /Google Maps can['’]t find|No results found|Make sure your search is spelled correctly/i,
    blocked: /unusual traffic from your computer|Before you continue to Google|not a robot/i,
    rating: /(\d+(?:[.,]\d+)?)\s*stars?/i,
    reviews: /([\d.,]+\s*[KkMm]?)\s+reviews?/i,
    cardRatingText: /(\d(?:[.,]\d)?)\s*\(([\d.,]+\s*[KkMm]?)\)/,
    phonePrefix: /^\s*Phone:\s*/i,
    addressPrefix: /^\s*Address:\s*/i,
  };

  const TIMING = {
    resultsTimeout: 25000,       // wait for feed / place / no-results after load
    scrollWait: [1200, 2200],    // pause after each feed scroll
    maxStaleScrolls: 6,          // scrolls with no new cards before giving up
    panelTimeout: 10000,         // wait for the clicked place's panel
    panelFieldsTimeout: 3500,    // extra wait for phone/address rows to render
    clickDelay: [800, 2000],     // between listing clicks
  };

  // -------------------------------------------------------------------------
  // Utilities

  class Abort extends Error {}        // job should end quietly (stop/pause/superseded)
  class BlockedError extends Error {} // consent / CAPTCHA page detected

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const norm = (s) =>
    (s || '')
      .normalize('NFC')
      .replace(/[‎‏‪-‮]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  async function waitFor(fn, timeout, interval = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  function isVisible(el) {
    return !!(el && (el.offsetParent || el.getClientRects().length));
  }

  function parseCount(s) {
    if (!s) return '';
    const m = String(s).trim().match(/^([\d.,]+)\s*([KkMm]?)$/);
    if (!m) return '';
    let n;
    if (m[2]) {
      n = parseFloat(m[1].replace(',', '.')) * (/k/i.test(m[2]) ? 1e3 : 1e6);
    } else {
      n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    }
    return Number.isFinite(n) ? Math.round(n) : '';
  }

  function parseRating(s) {
    if (!s) return '';
    const n = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 5 ? n : '';
  }

  function cleanUrl(href) {
    try {
      const u = new URL(href, location.href);
      return `${u.origin}${u.pathname}`;
    } catch {
      return href || '';
    }
  }

  // Stable identity for a place. Maps feature id (0x…:0x…) is in nearly every
  // place URL; fall back to name + phone digits.
  function urlKey(url) {
    if (!url) return '';
    const fid = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (fid) return `fid:${fid[1].toLowerCase()}`;
    const cid = url.match(/[?&]cid=(\d+)/);
    if (cid) return `cid:${cid[1]}`;
    return '';
  }
  function placeKey(url, name, phone) {
    return urlKey(url) || `np:${norm(name)}|${(phone || '').replace(/\D/g, '')}`;
  }

  // -------------------------------------------------------------------------
  // Area parsing from a free-form address.

  const STATES = new Set(
    [
      'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
      'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
      'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'punjab', 'rajasthan',
      'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal',
      'andaman and nicobar islands', 'chandigarh', 'dadra and nagar haveli and daman and diu',
      'delhi', 'new delhi', 'jammu and kashmir', 'ladakh', 'lakshadweep', 'puducherry',
    ].map(norm)
  );
  const COUNTRIES = /^(india|bharat|united states|usa|united kingdom|uk|uae|united arab emirates)$/i;
  const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{0,3}\b/i;

  const PIN = /\b\d{3}\s?\d{3}\b|\b\d{5}(-\d{4})?\b/g;
  // Old/new city names, so "Bangalore" matches an address that says "Bengaluru".
  const CITY_ALIASES = [
    ['bangalore', 'bengaluru'], ['bombay', 'mumbai'], ['gurgaon', 'gurugram'], ['calcutta', 'kolkata'],
    ['madras', 'chennai'], ['poona', 'pune'], ['mysore', 'mysuru'], ['trivandrum', 'thiruvananthapuram'],
    ['vizag', 'visakhapatnam'], ['baroda', 'vadodara'], ['cochin', 'kochi'], ['new delhi', 'delhi'],
  ];
  function cityNames(city) {
    const c = norm(city);
    const names = new Set([c]);
    for (const pair of CITY_ALIASES) if (pair.includes(c)) pair.forEach((n) => names.add(n));
    return names;
  }

  // Area = the address segment just before the city name
  // ("Shop 5, ABC Complex, Kothrud, Pune, Maharashtra 411038" → "Kothrud").
  // Fallbacks: the searched area, then the last segment that is not
  // city/state/PIN/country.
  function parseArea(address, city, searchedArea) {
    const parts = String(address || '')
      .split(',')
      .map((p) => p.replace(PLUS_CODE, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const cities = cityNames(city);
    for (let i = parts.length - 1; i > 0; i--) {
      if (cities.has(norm(parts[i].replace(PIN, '')))) {
        const before = parts[i - 1].replace(PIN, '').trim();
        if (before && /\p{L}/u.test(before)) return before;
        break;
      }
    }
    if (searchedArea) return searchedArea;

    const rest = parts.slice();
    while (rest.length > 1) {
      const stripped = rest[rest.length - 1].replace(PIN, '').trim();
      const s = norm(stripped);
      if (!s || COUNTRIES.test(stripped) || STATES.has(s) || cities.has(s)) {
        rest.pop();
        continue;
      }
      return stripped;
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // DOM readers

  const getFeed = () => document.querySelector(SELECTORS.feed);

  function getCardAnchors() {
    const feed = getFeed();
    return feed ? [...feed.querySelectorAll(SELECTORS.resultLink)] : [];
  }

  function cardRoot(anchor) {
    // The result link is an overlay inside the card element, so its parent
    // holds the card's text (rating, category, …).
    const parent = anchor.parentElement;
    return parent && !parent.matches(SELECTORS.feed) ? parent : anchor;
  }

  function readCard(anchor) {
    const root = cardRoot(anchor);
    const name = cleanText(anchor.getAttribute('aria-label') || anchor.textContent);
    let rating = '';
    let reviews = '';
    for (const img of root.querySelectorAll(SELECTORS.ratingImage)) {
      const label = img.getAttribute('aria-label') || '';
      const r = label.match(TEXT.rating);
      if (r) {
        rating = parseRating(r[1]);
        const rv = label.match(TEXT.reviews);
        if (rv) reviews = parseCount(rv[1]);
        break;
      }
    }
    if (rating === '') {
      const m = (root.textContent || '').match(TEXT.cardRatingText);
      if (m) {
        rating = parseRating(m[1]);
        reviews = parseCount(m[2]);
      }
    }
    return { href: anchor.href, url: cleanUrl(anchor.href), key: urlKey(anchor.href), name, rating, reviews };
  }

  function findAnchorByHref(href) {
    return getCardAnchors().find((a) => a.href === href) || null;
  }

  // The detail panel for a given place name (visible one wins; Maps can keep
  // old panels around hidden). Returns null while the old panel is shown.
  function findPanel(name) {
    const want = norm(name);
    const panels = [...document.querySelectorAll(SELECTORS.detailPanel)].filter(isVisible);
    for (const p of panels.reverse()) {
      if (norm(p.getAttribute('aria-label')) === want) return p;
      const h1 = p.querySelector(SELECTORS.detailTitle);
      if (h1 && norm(h1.textContent) === want) return p;
    }
    return null;
  }

  function anyPlacePanel() {
    const panels = [...document.querySelectorAll(SELECTORS.detailPanel)].filter(isVisible);
    return panels.reverse().find((p) => p.querySelector(SELECTORS.detailTitle)) || null;
  }

  function precedes(a, b) {
    return !b || !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function panelSignature(panel) {
    const attr = (sel) => {
      const el = panel.querySelector(sel);
      return el ? el.getAttribute('aria-label') || el.textContent : '';
    };
    return `${attr(SELECTORS.phoneButton)}|${attr(SELECTORS.addressButton)}`;
  }

  function readPanel(panel) {
    const h1 = panel.querySelector(SELECTORS.detailTitle);
    const name = cleanText((h1 && h1.textContent) || panel.getAttribute('aria-label'));

    // Every phone row, raw text; normalisation happens at export time.
    const phones = [];
    for (const el of panel.querySelectorAll(SELECTORS.phoneButton)) {
      const label = (el.getAttribute('aria-label') || '').replace(TEXT.phonePrefix, '').trim();
      const tel = (el.getAttribute('data-item-id') || '').replace(/^phone:tel:/, '').trim();
      const v = label || el.textContent.trim() || tel;
      if (v && !phones.includes(v)) phones.push(v);
    }
    const phone = phones.join(' / ');

    let address = '';
    const addrEl = panel.querySelector(SELECTORS.addressButton);
    if (addrEl) {
      address = cleanText((addrEl.getAttribute('aria-label') || '').replace(TEXT.addressPrefix, '') || addrEl.textContent);
    }

    // Header rating / review count: only elements before the first overview
    // row, so user reviews further down ("5 stars") are never picked up.
    const boundary = panel.querySelector(SELECTORS.overviewRow);
    let rating = '';
    let reviews = '';
    // No overview rows → can't tell header from reviews; leave rating to the card.
    for (const el of boundary ? panel.querySelectorAll(SELECTORS.ratingImage) : []) {
      if (!precedes(el, boundary)) break;
      const m = (el.getAttribute('aria-label') || '').match(TEXT.rating);
      if (m) {
        rating = parseRating(m[1]);
        break;
      }
    }
    for (const el of boundary ? panel.querySelectorAll(SELECTORS.reviewCountLabel) : []) {
      if (!precedes(el, boundary)) break;
      const m = (el.getAttribute('aria-label') || '').match(TEXT.reviews);
      if (m) {
        reviews = parseCount(m[1]);
        break;
      }
    }
    return { name, phone, address, rating, reviews };
  }

  function pageBlocked() {
    if (document.querySelector(SELECTORS.blocked)) return true;
    const text = document.body ? document.body.innerText.slice(0, 4000) : '';
    return TEXT.blocked.test(text);
  }

  // -------------------------------------------------------------------------
  // Messaging + run control

  async function send(msg) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await chrome.runtime.sendMessage(msg);
      } catch (e) {
        const text = String((e && e.message) || e);
        if (/context invalidated/i.test(text)) throw new Abort(); // extension reloaded
        await sleep(500 * (attempt + 1)); // service worker waking up
      }
    }
    return null;
  }

  // Throws Abort when the job should end; blocks while paused.
  async function checkpoint(job) {
    for (;;) {
      if (job.cancelled) throw new Abort();
      let run;
      try {
        ({ run } = await chrome.storage.local.get('run'));
      } catch {
        throw new Abort();
      }
      if (!run || run.runId !== job.runId || run.areaIndex !== job.areaIndex) throw new Abort();
      if (run.status === 'running' && run.stage === 'collecting') return;
      if (run.status === 'paused' && run.stage === 'collecting') {
        await sleep(700);
        continue;
      }
      throw new Abort(); // stopped / blocked / done / re-navigated
    }
  }

  async function pause(job, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await checkpoint(job);
      await sleep(Math.min(400, end - Date.now()));
    }
  }

  function progress(job, detail) {
    send({ type: 'progress', runId: job.runId, areaIndex: job.areaIndex, detail });
  }

  function label(job) {
    return job.area || job.city;
  }

  // -------------------------------------------------------------------------
  // The job

  async function waitForResults(job) {
    const end = Date.now() + TIMING.resultsTimeout;
    let placeSeen = 0;
    while (Date.now() < end) {
      if (job.cancelled) throw new Abort();
      if (pageBlocked()) return 'blocked';
      const feed = getFeed();
      if (feed && getCardAnchors().length > 0) return 'feed';
      if (!feed && location.pathname.includes('/maps/place/') && anyPlacePanel()) {
        // Single match: Maps jumps straight to the place. Confirm twice so a
        // feed that is still rendering is not mistaken for it.
        if (++placeSeen >= 3) return 'place';
      }
      const main = document.querySelector('div[role="main"]');
      if (main && TEXT.noResults.test(main.innerText || '')) return 'none';
      await sleep(500);
    }
    return getFeed() && getCardAnchors().length ? 'feed' : 'none';
  }

  async function scrollFeed(job) {
    let last = getCardAnchors().length;
    let stale = 0;
    for (;;) {
      await checkpoint(job);
      const feed = getFeed();
      if (!feed) break;
      if (TEXT.endOfList.test(feed.textContent || '')) break;
      if (stale > 0 && stale % 2 === 0) {
        // Nudge: scroll up a little first so Maps re-triggers its loader.
        feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 600);
        await sleep(300);
      }
      feed.scrollTop = feed.scrollHeight;
      await sleep(rand(...TIMING.scrollWait));
      const n = getCardAnchors().length;
      progress(job, `${label(job)}: scrolling results… ${n} found`);
      if (TEXT.endOfList.test(feed.textContent || '')) break;
      if (n > last) {
        last = n;
        stale = 0;
      } else if (++stale >= TIMING.maxStaleScrolls) {
        break;
      }
      if (pageBlocked()) throw new BlockedError();
    }
  }

  function buildListing(job, data) {
    const url = data.url || '';
    return {
      key: placeKey(url, data.name, data.phone),
      name: cleanText(data.name),
      phoneRaw: data.phone || '', // all numbers as shown; normalised at export
      area: parseArea(data.address, job.city, job.area),
      address: data.address || '',
      rating: data.rating === undefined ? '' : data.rating,
      reviews: data.reviews === undefined ? '' : data.reviews,
      url,
      query: job.query,
      searchedArea: job.area || '',
      city: job.city,
      category: job.category,
      collectedAt: new Date().toISOString(),
    };
  }

  async function readDetails(job, card) {
    let anchor = findAnchorByHref(card.href);
    if (!anchor) {
      // Card list was re-rendered; give it a moment and look again.
      await sleep(800);
      anchor = findAnchorByHref(card.href);
    }
    if (!anchor) return { ...card, phone: '', address: '', partial: true };

    anchor.scrollIntoView({ block: 'center' });
    await sleep(150);
    // Re-query: scrolling can swap the node.
    anchor = findAnchorByHref(card.href) || anchor;
    // A same-name panel may already be open (chains: previous branch). Maps
    // updates the URL before the panel, so also wait for that panel to be
    // replaced or its contents to change.
    const previousPanel = findPanel(card.name);
    const previousSig = previousPanel ? panelSignature(previousPanel) : null;
    anchor.click();

    const ready = () => {
      if (card.key && urlKey(location.href) !== card.key) return null;
      const p = findPanel(card.name);
      if (!p) return null;
      if (p === previousPanel && p.isConnected && panelSignature(p) === previousSig) return null;
      return p;
    };
    let panel = await waitFor(ready, TIMING.panelTimeout);
    if (!panel) {
      // URL format changed, or a same-name branch with identical details:
      // fall back to whatever panel carries the name.
      panel = findPanel(card.name);
    }
    if (!panel) {
      if (pageBlocked()) throw new BlockedError();
      return { ...card, phone: '', address: '', partial: true };
    }
    // Rows render a little after the title. Re-find the panel each poll in
    // case Maps replaces the node while it loads.
    await waitFor(() => {
      const p = ready() || panel;
      return p.isConnected && (p.querySelector(SELECTORS.phoneButton) || p.querySelector(SELECTORS.addressButton));
    }, TIMING.panelFieldsTimeout);
    const fresh = ready() || findPanel(card.name) || panel;
    const d = readPanel(fresh);
    return {
      name: d.name || card.name,
      phone: d.phone,
      address: d.address,
      // Card rating comes from the list and is unambiguous; panel is fallback.
      rating: card.rating !== '' ? card.rating : d.rating,
      reviews: card.reviews !== '' ? card.reviews : d.reviews,
      url: card.url,
    };
  }

  async function runJob(job) {
    const n = job.areaCount;
    const where = label(job);
    progress(job, `${where}: waiting for results…`);
    await checkpoint(job);

    const state = await waitForResults(job);
    if (state === 'blocked') throw new BlockedError();
    if (state === 'none') {
      await send({ type: 'areaDone', runId: job.runId, areaIndex: job.areaIndex, found: 0, noResults: true });
      return;
    }

    const { listings = [] } = await chrome.storage.local.get('listings');
    const seen = new Set(listings.map((l) => l.key));

    if (state === 'place') {
      await checkpoint(job);
      const panel = anyPlacePanel();
      await waitFor(
        () => panel.querySelector(SELECTORS.phoneButton) || panel.querySelector(SELECTORS.addressButton),
        TIMING.panelFieldsTimeout
      );
      const d = readPanel(anyPlacePanel() || panel);
      const listing = buildListing(job, { ...d, url: cleanUrl(location.href) });
      if (urlKey(location.href)) listing.key = urlKey(location.href);
      const res = await send({ type: 'listing', runId: job.runId, areaIndex: job.areaIndex, listing, detail: `${where}: 1 result` });
      if (!res || res.stale) throw new Abort();
      await send({ type: 'areaDone', runId: job.runId, areaIndex: job.areaIndex, found: 1 });
      return;
    }

    await scrollFeed(job);

    // Snapshot the cards (plain data, no element references kept).
    const cards = [];
    const inThisSearch = new Set();
    for (const a of getCardAnchors()) {
      const c = readCard(a);
      if (!c.name) continue;
      const id = c.key || c.href;
      if (inThisSearch.has(id)) continue;
      inThisSearch.add(id);
      cards.push(c);
    }
    if (cards.length === 0) {
      await send({ type: 'areaDone', runId: job.runId, areaIndex: job.areaIndex, found: 0, noResults: true });
      return;
    }

    const already = cards.filter((c) => c.key && seen.has(c.key));
    if (already.length) {
      await send({ type: 'seenAgain', runId: job.runId, areaIndex: job.areaIndex, keys: already.map((c) => c.key), query: job.query });
    }
    const todo = cards.filter((c) => !(c.key && seen.has(c.key)));

    for (let i = 0; i < todo.length; i++) {
      await checkpoint(job);
      const card = todo[i];
      const detail = `${where}: reading ${i + 1}/${todo.length} — ${card.name}`;
      progress(job, detail);
      const data = await readDetails(job, card);
      const listing = buildListing(job, data);
      const res = await send({ type: 'listing', runId: job.runId, areaIndex: job.areaIndex, listing, detail });
      if (!res || res.stale) throw new Abort();
      seen.add(listing.key);
      if (i < todo.length - 1) await pause(job, rand(...TIMING.clickDelay));
    }

    await checkpoint(job);
    await send({
      type: 'areaDone',
      runId: job.runId,
      areaIndex: job.areaIndex,
      found: cards.length,
      detail: `${where}: done (area ${job.areaIndex + 1}/${n})`,
    });
  }

  // -------------------------------------------------------------------------
  // Wiring

  let activeJob = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'ping') {
      sendResponse({
        alive: true,
        active: activeJob ? { runId: activeJob.runId, areaIndex: activeJob.areaIndex } : null,
      });
      return false;
    }
    if (msg.type === 'collect') {
      const j = msg.job;
      if (activeJob && activeJob.runId === j.runId && activeJob.areaIndex === j.areaIndex) {
        sendResponse({ ok: true, already: true });
        return false;
      }
      if (activeJob) activeJob.cancelled = true; // superseded
      const job = { ...j, cancelled: false };
      activeJob = job;
      runJob(job)
        .catch(async (e) => {
          if (e instanceof Abort) return;
          if (e instanceof BlockedError) {
            await send({ type: 'blocked', runId: job.runId, areaIndex: job.areaIndex }).catch(() => {});
            return;
          }
          console.error('[maps-collector]', e);
          await send({
            type: 'contentError',
            runId: job.runId,
            areaIndex: job.areaIndex,
            error: `Error while collecting: ${(e && e.message) || e}. Click Resume to retry this area.`,
          }).catch(() => {});
        })
        .finally(() => {
          if (activeJob === job) activeJob = null;
        });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Tell the worker a Maps page is ready (wakes it if it was asleep).
  send({ type: 'contentReady' }).catch(() => {});
})();
