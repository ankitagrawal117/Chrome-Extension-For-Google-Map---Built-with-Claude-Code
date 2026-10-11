// Popup: collects inputs, sends commands to the service worker, mirrors run
// state from chrome.storage.local and builds the CSV client-side.

const $ = (id) => document.getElementById(id);
const els = {
  city: $('city'),
  category: $('category'),
  areas: $('areas'),
  start: $('start'),
  pause: $('pause'),
  stop: $('stop'),
  download: $('download'),
  clear: $('clear'),
  badge: $('badge'),
  progress: $('progress'),
  detail: $('detail'),
  message: $('message'),
  prompt: $('prompt'),
  promptText: $('promptText'),
  promptButtons: $('promptButtons'),
};

let state = { run: null, listingCount: 0 };

const ACTIVE = ['running', 'paused', 'blocked', 'error'];
const STATUS_LABEL = {
  running: 'Running',
  paused: 'Paused',
  blocked: 'Action needed',
  error: 'Error',
  stopped: 'Stopped',
  done: 'Done',
  idle: 'Idle',
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));
}

function totalAreas(run) {
  return run && run.areas && run.areas.length ? run.areas.length : 1;
}

function isResumable(run) {
  return !!run && run.status !== 'done' && run.areaIndex < totalAreas(run);
}

function readConfig() {
  return {
    city: els.city.value.trim(),
    category: els.category.value.trim(),
    areas: els.areas.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
  };
}

function fillInputs(cfg) {
  if (!cfg) return;
  els.city.value = cfg.city || '';
  els.category.value = cfg.category || '';
  els.areas.value = (cfg.areas || []).join('\n');
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  const run = state.run;
  const status = run ? run.status : 'idle';
  const active = ACTIVE.includes(status);

  els.badge.textContent = STATUS_LABEL[status] || status;
  els.badge.className = `badge ${status}`;

  if (run) {
    const total = totalAreas(run);
    const current = Math.min(run.areaIndex + 1, total);
    const shownArea = status === 'done' ? total : current;
    els.progress.textContent = `Area ${shownArea}/${total} · ${state.listingCount} listings collected`;
  } else {
    els.progress.textContent = state.listingCount
      ? `${state.listingCount} listings collected`
      : 'No run yet';
  }
  els.detail.textContent = (run && run.detail) || '';

  const msg = run && run.message;
  els.message.hidden = !msg;
  els.message.textContent = msg || '';
  els.message.className = `message${status === 'blocked' || status === 'error' ? ' error' : ''}`;

  for (const el of [els.city, els.category, els.areas]) el.disabled = active;
  els.start.disabled = active;
  els.pause.disabled = !active;
  els.pause.textContent = status === 'running' ? 'Pause' : 'Resume';
  els.stop.disabled = !active;
  els.download.disabled = state.listingCount === 0;
  els.clear.disabled = status === 'running' || (state.listingCount === 0 && !run);
}

function showMessage(text, isError = true) {
  els.message.hidden = false;
  els.message.textContent = text;
  els.message.className = `message${isError ? ' error' : ''}`;
}

function hidePrompt() {
  els.prompt.hidden = true;
  els.promptButtons.textContent = '';
}

function showPrompt(text, options) {
  els.promptText.textContent = text;
  els.promptButtons.textContent = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.textContent = opt.label;
    if (opt.className) b.className = opt.className;
    b.addEventListener('click', () => {
      hidePrompt();
      opt.onClick();
    });
    els.promptButtons.appendChild(b);
  }
  els.prompt.hidden = false;
}

// ---------------------------------------------------------------------------
// Commands

async function start(mode) {
  const res = await send({ type: 'start', mode, config: readConfig() });
  if (!res || !res.ok) showMessage((res && res.error) || 'Could not start.');
}

els.start.addEventListener('click', () => {
  hidePrompt();
  const cfg = readConfig();
  const run = state.run;
  const resumable = isResumable(run);

  if (!resumable && (!cfg.city || !cfg.category)) {
    showMessage('Please enter both a City and a Category.');
    return;
  }
  if (!resumable && state.listingCount === 0) {
    start('fresh');
    return;
  }

  const options = [];
  if (resumable) {
    const total = totalAreas(run);
    options.push({
      label: `Resume (area ${Math.min(run.areaIndex + 1, total)}/${total})`,
      className: 'primary',
      onClick: () => start('resume'),
    });
  }
  if (cfg.city && cfg.category) {
    if (state.listingCount > 0) {
      options.push({ label: 'New search, keep data', onClick: () => start('append') });
    }
    options.push({ label: 'Clear data & start new', className: 'danger', onClick: () => start('fresh') });
  }
  options.push({ label: 'Cancel', onClick: () => {} });

  const parts = [];
  if (state.listingCount) parts.push(`${state.listingCount} listings from a previous run are saved.`);
  if (resumable) parts.push(`The run "${run.category} in ${run.city}" did not finish.`);
  showPrompt(parts.join(' ') + ' What would you like to do?', options);
});

els.pause.addEventListener('click', async () => {
  const status = state.run && state.run.status;
  const res = await send({ type: status === 'running' ? 'pause' : 'resume' });
  if (res && res.error) showMessage(res.error);
});

els.stop.addEventListener('click', async () => {
  hidePrompt();
  await send({ type: 'stop' });
});

els.clear.addEventListener('click', () => {
  showPrompt(`Delete all ${state.listingCount} collected listings? This cannot be undone.`, [
    {
      label: 'Delete',
      className: 'danger',
      onClick: async () => {
        const res = await send({ type: 'clear' });
        if (res && !res.ok) showMessage(res.error || 'Could not clear.');
      },
    },
    { label: 'Cancel', onClick: () => {} },
  ]);
});

els.download.addEventListener('click', async () => {
  const { listings = [], run, config } = await chrome.storage.local.get(['listings', 'run', 'config']);
  if (!listings.length) return;
  const meta = run || config || readConfig();
  const csv = buildCsv(listings);
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFilename(meta.category, meta.city);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// ---------------------------------------------------------------------------
// CSV

const COLUMNS = [
  ['Name', (l) => l.name],
  ['Phone', (l) => l.phone],
  ['Area', (l) => l.area],
  ['Address', (l) => l.address],
  ['Rating', (l) => l.rating],
  ['Review Count', (l) => l.reviews],
  ['Google Maps URL', (l) => l.url],
  ['Search Query', (l) => l.query],
  ['Also Found By', (l) => (l.alsoFoundBy || []).join(' | ')],
  ['Searched Area', (l) => l.searchedArea],
  ['City', (l) => l.city],
  ['Category', (l) => l.category],
  ['Collected At', (l) => l.collectedAt],
];

function csvField(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Keep Excel from evaluating text that happens to look like a formula.
  if (/^[=+@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// ="…" makes Excel keep the phone number as text (no 9.19E+11, no lost
// leading zero). The formula itself is CSV-quoted like any other field.
function csvPhone(value) {
  const s = (value || '').replace(/"/g, '');
  if (!s) return '""';
  return `"=""${s}"""`;
}

function buildCsv(listings) {
  const lines = [COLUMNS.map(([h]) => csvField(h)).join(',')];
  for (const l of listings) {
    lines.push(
      COLUMNS.map(([h, get]) => (h === 'Phone' ? csvPhone(get(l)) : csvField(get(l)))).join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

function csvFilename(category, city) {
  const safe = (s) =>
    (s || 'listings')
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'listings';
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${safe(category)}_${safe(city)}_${ymd}.csv`;
}

// ---------------------------------------------------------------------------
// Init + live updates

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('run' in changes) state.run = changes.run.newValue || null;
  if ('listings' in changes) state.listingCount = (changes.listings.newValue || []).length;
  render();
});

(async () => {
  const [{ listings = [] }, res] = await Promise.all([
    chrome.storage.local.get('listings'),
    send({ type: 'getState' }),
  ]);
  state.listingCount = listings.length;
  state.run = (res && res.run) || null;
  const run = state.run;
  fillInputs(run && ACTIVE.includes(run.status) ? run : (res && res.config) || run);
  render();
})();
