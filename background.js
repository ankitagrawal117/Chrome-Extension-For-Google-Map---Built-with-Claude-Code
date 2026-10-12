// Service worker: owns the run state machine, the single Maps tab, and all
// writes to chrome.storage.local. The content script does the scraping and
// reports back through messages; the popup only sends commands and reads
// storage.
//
// MV3 service workers can be killed at any time (≈30 s idle). Nothing here
// relies on in-memory state surviving: every handler reloads `run` from
// storage, and `kick()` re-drives a run that stalled while the worker slept.

const MAPS_PREFIX = 'https://www.google.com/maps';
const AREA_PAUSE_MS = [4000, 8000];   // pause between area searches
const NAV_STALL_MS = 30000;           // navigating for longer than this → re-check
const COLLECT_STALL_MS = 90000;       // no word from content script → re-check

// ---------------------------------------------------------------------------
// Storage helpers + a serial queue so read-modify-write never interleaves.

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error('[bg] queued task failed', e));
  return p;
}

async function load(...keys) {
  return chrome.storage.local.get(keys);
}
async function getRun() {
  return (await load('run')).run || null;
}
async function saveRun(run) {
  run.updatedAt = Date.now();
  await chrome.storage.local.set({ run });
  return run;
}

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Search helpers

function searchesFor(run) {
  const { city, category, areas } = run;
  if (!areas || areas.length === 0) {
    return [{ area: '', query: `${category} in ${city}` }];
  }
  return areas.map((area) => ({ area, query: `${category} in ${area}, ${city}` }));
}

function searchUrl(query) {
  // "Dermatologist in Kothrud, Pune" → /maps/search/Dermatologist+in+Kothrud,+Pune
  const path = query.trim().split(/\s+/).map(encodeURIComponent).join('+').replace(/%2C/gi, ',');
  // hl=en keeps on-page text (end-of-list marker etc.) in English.
  return `${MAPS_PREFIX}/search/${path}?hl=en`;
}

function isMapsUrl(url) {
  return typeof url === 'string' && url.startsWith(MAPS_PREFIX);
}

function isBlockedUrl(url) {
  if (typeof url !== 'string') return false;
  return (
    url.startsWith('https://consent.google.') ||
    /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\//.test(url) ||
    url.includes('/recaptcha/')
  );
}

// ---------------------------------------------------------------------------
// Tab handling — exactly one Maps tab per run.

async function tabExists(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function findRunTab(run) {
  const existing = await tabExists(run.tabId);
  if (existing) return existing;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isMapsUrl(active.url)) return active;
  const mapsTabs = await chrome.tabs.query({ url: `${MAPS_PREFIX}/*` });
  return mapsTabs[0] || null;
}

// Must be called inside serial(). Points the run tab at the current area.
async function navigateToArea(run) {
  const searches = searchesFor(run);
  const search = searches[run.areaIndex];
  const url = searchUrl(search.query);
  run.stage = 'navigating';
  run.navStartedAt = Date.now();
  run.message = '';
  run.detail = `Opening search: ${search.query}`;

  let tab = await findRunTab(run);
  if (tab) {
    run.tabId = tab.id;
    await saveRun(run);
    try {
      await chrome.tabs.update(tab.id, { url, active: true });
    } catch {
      tab = null; // closed in the meantime → open a fresh one below
    }
  }
  if (!tab) {
    // Save the stage first so the new tab's load events are recognised.
    await saveRun(run);
    const created = await chrome.tabs.create({ url, active: true });
    run.tabId = created.id;
    await saveRun(run);
  }
  setTimeout(kick, NAV_STALL_MS + 1000);
}

async function pingContent(tabId) {
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'ping' }),
      sleep(3000).then(() => null),
    ]);
    return res || null;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  if (await pingContent(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('[bg] inject failed', e);
    return false;
  }
  return !!(await pingContent(tabId));
}

// Hands the current area to the content script. Safe to call repeatedly:
// only the first call for a given (runId, areaIndex) while navigating wins.
async function dispatchCollect(expectRunId, expectAreaIndex) {
  const job = await serial(async () => {
    const run = await getRun();
    if (!run || run.status !== 'running' || run.stage !== 'navigating') return null;
    if (run.runId !== expectRunId || run.areaIndex !== expectAreaIndex) return null;
    const tab = await tabExists(run.tabId);
    if (!tab || !isMapsUrl(tab.url)) return null;
    run.stage = 'collecting';
    run.lastActivity = Date.now();
    await saveRun(run);
    const search = searchesFor(run)[run.areaIndex];
    return {
      tabId: run.tabId,
      job: {
        runId: run.runId,
        areaIndex: run.areaIndex,
        areaCount: searchesFor(run).length,
        query: search.query,
        area: search.area,
        city: run.city,
        category: run.category,
      },
    };
  });
  if (!job) return;

  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    if (await ensureContentScript(job.tabId)) {
      try {
        const res = await chrome.tabs.sendMessage(job.tabId, { type: 'collect', job: job.job });
        ok = !!(res && res.ok);
      } catch {
        ok = false;
      }
    }
    if (!ok) await sleep(1500);
  }
  if (!ok) {
    await serial(async () => {
      const run = await getRun();
      if (!run || run.runId !== job.job.runId) return;
      run.status = 'paused';
      run.stage = null;
      run.message = 'Could not talk to the Google Maps tab. Reload it, then click Resume.';
      await saveRun(run);
    });
  }
}

// Re-drives a running run whose next step was lost (e.g. the worker slept).
async function kick() {
  const action = await serial(async () => {
    const run = await getRun();
    if (!run || run.status !== 'running') return null;
    const now = Date.now();
    if (run.stage === 'between' && now >= (run.nextAreaAt || 0)) {
      await navigateToArea(run);
      return null;
    }
    if (run.stage === 'navigating' && now - (run.navStartedAt || 0) > NAV_STALL_MS) {
      const tab = await tabExists(run.tabId);
      if (!tab) {
        await navigateToArea(run);
        return null;
      }
      if (tab.status === 'complete' && isMapsUrl(tab.url)) {
        return { dispatch: [run.runId, run.areaIndex] };
      }
      return null;
    }
    if (run.stage === 'collecting' && now - (run.lastActivity || 0) > COLLECT_STALL_MS) {
      const pong = await pingContent(run.tabId);
      if (!pong || !pong.active || pong.active.runId !== run.runId) {
        await navigateToArea(run); // content script lost its job → redo the area
      } else {
        run.lastActivity = now;
        await saveRun(run);
      }
    }
    return null;
  });
  if (action && action.dispatch) dispatchCollect(...action.dispatch);
}

// ---------------------------------------------------------------------------
// Commands from the popup

async function startRun({ mode, config }) {
  return serial(async () => {
    const prev = await getRun();
    if (prev && ['running'].includes(prev.status)) {
      return { ok: false, error: 'A run is already in progress.' };
    }

    if (mode === 'resume') {
      if (!prev || prev.areaIndex >= searchesFor(prev).length) {
        return { ok: false, error: 'Nothing to resume.' };
      }
      prev.status = 'running';
      await navigateToArea(prev);
      return { ok: true };
    }

    const city = (config.city || '').trim();
    const category = (config.category || '').trim();
    if (!city || !category) return { ok: false, error: 'City and Category are required.' };
    const areas = [...new Set((config.areas || []).map((a) => a.trim()).filter(Boolean))];

    let { listings = [] } = await load('listings');
    if (mode === 'fresh') {
      listings = [];
      await chrome.storage.local.set({ listings });
    }

    const run = {
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      city,
      category,
      areas,
      areaIndex: 0,
      status: 'running',
      stage: null,
      tabId: prev ? prev.tabId : null,
      count: listings.length,
      startedAt: Date.now(),
      message: '',
      detail: '',
    };
    await chrome.storage.local.set({ config: { city, category, areas } });
    await navigateToArea(run);
    return { ok: true };
  });
}

async function pauseRun() {
  return serial(async () => {
    const run = await getRun();
    if (!run || run.status !== 'running') return { ok: false };
    run.status = 'paused';
    run.message = 'Paused.';
    await saveRun(run);
    return { ok: true };
  });
}

async function resumeRun() {
  return serial(async () => {
    const run = await getRun();
    if (!run || !['paused', 'blocked', 'error'].includes(run.status)) return { ok: false };
    if (run.areaIndex >= searchesFor(run).length) return { ok: false, error: 'Run already finished.' };
    const wasBlocked = run.status === 'blocked';
    run.status = 'running';
    run.message = '';

    if (run.stage === 'between') {
      run.nextAreaAt = Date.now();
      await saveRun(run);
      setTimeout(kick, 50);
      return { ok: true };
    }
    // If the content script is still alive and holding this area's job, it is
    // just waiting in its pause loop — flipping the status lets it continue.
    if (run.stage === 'collecting' && !wasBlocked) {
      const pong = await pingContent(run.tabId);
      if (pong && pong.active && pong.active.runId === run.runId && pong.active.areaIndex === run.areaIndex) {
        run.lastActivity = Date.now();
        await saveRun(run);
        return { ok: true };
      }
    }
    // Otherwise (blocked, tab closed/reloaded, …) redo the current area.
    // Already-collected places are skipped by the content script.
    await navigateToArea(run);
    return { ok: true };
  });
}

async function stopRun() {
  return serial(async () => {
    const run = await getRun();
    if (!run) return { ok: false };
    if (['running', 'paused', 'blocked', 'error'].includes(run.status)) {
      run.status = 'stopped';
      run.stage = null;
      run.message = 'Stopped. Collected data is kept — download it any time.';
      await saveRun(run);
    }
    return { ok: true };
  });
}

async function clearData() {
  return serial(async () => {
    const run = await getRun();
    if (run && run.status === 'running') return { ok: false, error: 'Stop the run first.' };
    await chrome.storage.local.set({ listings: [] });
    await chrome.storage.local.remove('run');
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Reports from the content script

function sameJob(run, msg) {
  return run && msg.runId === run.runId && msg.areaIndex === run.areaIndex;
}

async function onListing(msg) {
  return serial(async () => {
    const { run, listings = [] } = await load('run', 'listings');
    if (!run || msg.runId !== run.runId) return { ok: false, stale: true };
    const item = msg.listing;
    const existing = listings.find((l) => l.key === item.key);
    let duplicate = false;
    if (existing) {
      duplicate = true;
      addAlsoFound(existing, item.query);
    } else {
      listings.push({ ...item, alsoFoundBy: [] });
    }
    run.count = listings.length;
    run.lastActivity = Date.now();
    if (msg.detail) run.detail = msg.detail;
    run.updatedAt = Date.now();
    await chrome.storage.local.set({ listings, run });
    return { ok: true, duplicate };
  });
}

function addAlsoFound(listing, query) {
  if (!query || listing.query === query) return;
  listing.alsoFoundBy = listing.alsoFoundBy || [];
  if (!listing.alsoFoundBy.includes(query)) listing.alsoFoundBy.push(query);
}

async function onSeenAgain(msg) {
  return serial(async () => {
    const { run, listings = [] } = await load('run', 'listings');
    if (!run || msg.runId !== run.runId) return { ok: false };
    const keys = new Set(msg.keys || []);
    let changed = false;
    for (const l of listings) {
      if (keys.has(l.key)) {
        const before = (l.alsoFoundBy || []).length;
        addAlsoFound(l, msg.query);
        if ((l.alsoFoundBy || []).length !== before) changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ listings });
    return { ok: true };
  });
}

async function onProgress(msg) {
  return serial(async () => {
    const run = await getRun();
    if (!sameJob(run, msg)) return { ok: false };
    run.detail = msg.detail || run.detail;
    run.lastActivity = Date.now();
    await saveRun(run);
    return { ok: true };
  });
}

async function onAreaDone(msg) {
  const res = await serial(async () => {
    const run = await getRun();
    if (!sameJob(run, msg) || run.stage !== 'collecting') return { ok: false };
    const searches = searchesFor(run);
    run.lastAreaNote = msg.noResults
      ? `No results found for "${searches[run.areaIndex].query}".`
      : '';
    run.areaIndex += 1;
    if (run.areaIndex >= searches.length) {
      run.stage = null;
      if (run.status === 'running') run.status = 'done';
      run.message = run.lastAreaNote || '';
      run.detail = "Finished. Download the Excel file below.";
      if (run.count === 0) run.message = 'No results found.';
      await saveRun(run);
      return { ok: true };
    }
    const delay = rand(...AREA_PAUSE_MS);
    run.stage = 'between';
    run.nextAreaAt = Date.now() + delay;
    run.message = run.lastAreaNote || '';
    run.detail = `Waiting ${Math.round(delay / 1000)} s before next area…`;
    await saveRun(run);
    setTimeout(kick, delay + 50);
    return { ok: true };
  });
  return res;
}

async function onBlocked(msg, reason) {
  return serial(async () => {
    const run = await getRun();
    if (!run || (msg && msg.runId && msg.runId !== run.runId)) return { ok: false };
    if (!['running', 'paused'].includes(run.status)) return { ok: false };
    run.status = 'blocked';
    run.message =
      reason ||
      'Google is showing a consent or CAPTCHA page. Solve it manually in the Maps tab, then click Resume.';
    await saveRun(run);
    return { ok: true };
  });
}

async function onContentError(msg) {
  return serial(async () => {
    const run = await getRun();
    if (!sameJob(run, msg)) return { ok: false };
    run.status = 'paused';
    run.stage = null;
    run.message = msg.error || 'Unexpected error in the Maps tab. Click Resume to retry this area.';
    await saveRun(run);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Tab events

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  serial(async () => {
    const run = await getRun();
    if (!run || run.tabId !== tabId || run.status !== 'running') return null;
    const url = changeInfo.url || tab.url;

    if (isBlockedUrl(url)) {
      run.status = 'blocked';
      run.message =
        'Google is showing a consent or CAPTCHA page. Solve it manually in the Maps tab, then click Resume.';
      await saveRun(run);
      return null;
    }
    if (changeInfo.status !== 'complete') return null;

    if (!isMapsUrl(url)) {
      run.status = 'paused';
      run.stage = null;
      run.message = 'The run tab is not on Google Maps any more. Click Resume to go back and continue.';
      await saveRun(run);
      return null;
    }
    if (run.stage === 'navigating') return { dispatch: [run.runId, run.areaIndex] };
    if (run.stage === 'collecting') return { verify: [run.runId, run.areaIndex] };
    return null;
  }).then(async (action) => {
    if (!action) return;
    if (action.dispatch) {
      dispatchCollect(...action.dispatch);
    } else if (action.verify) {
      // Maps' in-page navigation also fires "complete"; only a real reload
      // kills the content script. Give a fresh one time to load, then check.
      await sleep(2500);
      const run = await getRun();
      if (!run || run.status !== 'running' || run.stage !== 'collecting') return;
      if (run.runId !== action.verify[0] || run.areaIndex !== action.verify[1]) return;
      const pong = await pingContent(run.tabId);
      if (!pong || !pong.active || pong.active.runId !== run.runId) {
        await serial(async () => {
          const r = await getRun();
          if (r && r.status === 'running' && r.stage === 'collecting' && r.runId === run.runId) {
            await navigateToArea(r);
          }
        });
      }
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const run = await getRun();
    if (!run || run.tabId !== tabId) return;
    run.tabId = null;
    if (run.status === 'running') {
      run.status = 'paused';
      run.stage = null;
      run.message = 'The Google Maps tab was closed. Click Resume to continue in a new tab.';
    }
    await saveRun(run);
  });
});

// ---------------------------------------------------------------------------
// Message router

const handlers = {
  start: (msg) => startRun(msg),
  pause: () => pauseRun(),
  resume: () => resumeRun(),
  stop: () => stopRun(),
  clear: () => clearData(),
  getState: async () => {
    kick();
    const { run, config } = await load('run', 'config');
    return { run: run || null, config: config || null };
  },
  contentReady: async (msg, sender) => {
    // A Maps page finished loading in some tab. If it is ours and we are
    // waiting for it, start collecting (onUpdated may have been missed).
    const run = await getRun();
    if (run && sender.tab && sender.tab.id === run.tabId && run.status === 'running' && run.stage === 'navigating') {
      dispatchCollect(run.runId, run.areaIndex);
    }
    return { ok: true };
  },
  listing: (msg) => onListing(msg),
  seenAgain: (msg) => onSeenAgain(msg),
  progress: (msg) => onProgress(msg),
  areaDone: (msg) => onAreaDone(msg),
  blocked: (msg) => onBlocked(msg, msg.reason),
  contentError: (msg) => onContentError(msg),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});

// Extension reloaded/updated or browser restarted: the content script that
// held the job is gone, so a "running" run can't continue by itself.
function pauseOrphanedRun(reason) {
  serial(async () => {
    const run = await getRun();
    if (!run || run.status !== 'running') return;
    run.status = 'paused';
    run.stage = null;
    run.message = `${reason} Click Resume to continue where it stopped.`;
    await saveRun(run);
  });
}
chrome.runtime.onInstalled.addListener(() => pauseOrphanedRun('The extension was reloaded.'));
chrome.runtime.onStartup.addListener(() => pauseOrphanedRun('Chrome was restarted.'));

// Worker (re)started — pick up anything that stalled while it was asleep.
kick();
