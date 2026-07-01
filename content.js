const PAGE_TAG = 'amoa-tv';
const TIMEZONE_SELECTOR = '[aria-label="Timezone"], [data-name="time-zone-menu"]';
const RIGHT_GAP = 12; // px between panel edge and Timezone button
const RIGHT_SAFE_ZONE_FALLBACK = 240; // used only if the Timezone button isn't in the DOM
const log = (...a) => console.log('[amoa-tv:content]', ...a);
log('content.js loaded, url=', location.href);

let currentSymbol = null;
let catalog = null;              // { total, entries: [{stat, description, group, isStrike}] }
let overlays = [];               // [{ metric, label, isStrike, color }]
let panelEl = null;
let inputEl = null;
let dropdownEl = null;
let activeBtnEl = null;
let activeMenuEl = null;
let brandEl = null;
let highlightIdx = 0;
let filteredEntries = [];
let loadingCount = 0; // active fetches — spinner shown while > 0

// ── page ↔ content bridge ─────────────────────────────────────────────────
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || msg.tag !== PAGE_TAG || msg.dir !== 'page->bg') return;

  if (msg.type === 'symbolChanged') {
    currentSymbol = msg.symbol;
    log('symbol changed →', currentSymbol);
    refreshOverlaysForSymbol();
  }
});

function postToPage(payload) {
  window.postMessage({ tag: PAGE_TAG, dir: 'bg->page', ...payload }, '*');
}

// ── init ─────────────────────────────────────────────────────────────────
buildPanel();
installKeyboardShield();
mountPanel();
loadInitialState();

// TradingView occasionally clears added nodes on layout switches and the
// tab strip moves when it collapses/expands. Cheap heartbeat that re-mounts
// and re-positions on each tick.
setInterval(() => { mountPanel(); }, 500);

async function loadInitialState() {
  const ov = await chrome.runtime.sendMessage({ type: 'getOverlays' });
  overlays = ov?.overlays || [];
  renderChips();
  // catalog is fetched lazily on first search input to save an initial RTT
  postToPage({ type: 'contentReady' });
  // Race: page.js may have already delivered symbolChanged while overlays
  // were still loading from storage. In that case, refreshOverlaysForSymbol
  // ran with an empty list and returned early. Now that we have both symbol
  // and overlays, redraw.
  if (currentSymbol && overlays.length) refreshOverlaysForSymbol();
}

// ── UI ────────────────────────────────────────────────────────────────────
function buildPanel() {
  panelEl = document.createElement('div');
  panelEl.id = 'amoa-tv-panel';
  panelEl.style.cssText = `
    position: fixed; left: -9999px; top: -9999px;
    z-index: 999998;
    display: flex; align-items: center; gap: 6px;
    box-sizing: border-box;
    padding: 0 8px;
    background: transparent;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: rgb(228, 228, 231);
    pointer-events: auto;
  `;

  brandEl = document.createElement('span');
  brandEl.textContent = 'AMOA';
  brandEl.title = 'AMOA overlays';
  brandEl.style.cssText = `
    font-size: 11px; color: rgb(161, 161, 170); flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 42px;
  `;
  panelEl.appendChild(brandEl);

  // Spinner CSS injected once. Uses tw-zinc-300 outline with a transparent
  // top so the spinning gap reads as a subtle progress indicator.
  if (!document.getElementById('amoa-tv-style')) {
    const style = document.createElement('style');
    style.id = 'amoa-tv-style';
    style.textContent = `
      @keyframes amoa-tv-spin { to { transform: rotate(360deg); } }
      .amoa-tv-spinner {
        display: inline-block; width: 12px; height: 12px;
        border: 1.5px solid rgba(161, 161, 170, 0.35);
        border-top-color: rgb(212, 212, 216);
        border-radius: 50%;
        animation: amoa-tv-spin 0.8s linear infinite;
      }
    `;
    document.head.appendChild(style);
  }

  // Compact "active metrics" select button. Shows a count; clicking opens a
  // dropdown with each active metric + its remove control.
  activeBtnEl = document.createElement('button');
  activeBtnEl.type = 'button';
  activeBtnEl.style.cssText = `
    display: inline-flex; align-items: center; gap: 4px;
    background: rgb(39, 39, 42); color: rgb(228, 228, 231);
    border: 1px solid rgba(82, 82, 91, 0.6); border-radius: 4px;
    padding: 3px 8px; font-size: 12px; cursor: pointer;
    flex-shrink: 0; white-space: nowrap;
  `;
  activeBtnEl.addEventListener('click', toggleActiveMenu);
  panelEl.appendChild(activeBtnEl);

  const inputWrap = document.createElement('div');
  inputWrap.style.cssText = 'flex: 1; min-width: 200px; position: relative;';
  inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.placeholder = 'Add metric…';
  inputEl.autocomplete = 'off';
  inputEl.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgb(39, 39, 42); color: rgb(228, 228, 231);
    border: 1px solid rgba(82, 82, 91, 0.6); border-radius: 4px;
    padding: 4px 8px; font-size: 12px; outline: none;
  `;
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeyDown);
  inputEl.addEventListener('focus', onFocus);
  inputWrap.appendChild(inputEl);
  panelEl.appendChild(inputWrap);

  document.addEventListener('mousedown', onOutsideClick, true);
}

function mountPanel() {
  if (!panelEl.isConnected) {
    document.body.appendChild(panelEl);
    log('mounted panel (fixed overlay)');
  }
  updatePanelPosition();
}

// Position the panel to the right of TradingView's date-range tab strip,
// aligned to the same row, and clamped so it doesn't reach the clock/ADJ
// controls on the far right.
function updatePanelPosition() {
  if (!panelEl?.isConnected) return;
  const anchor = document.querySelector('[class*="dateRangeExpanded-"]')
              || document.querySelector('[data-name="date-ranges-tabs"]')
              || document.querySelector('[class*="dateRangeWrapper-"]:not([class*="collapsed-"])');
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  // Right edge follows TradingView's Timezone button — panel stops with a
  // small gap before it. Falls back to a fixed reserve if the button isn't
  // in the DOM (e.g. TV re-rendering, or a layout mode that hides it).
  const tz = document.querySelector(TIMEZONE_SELECTOR);
  let right = RIGHT_SAFE_ZONE_FALLBACK;
  if (tz) {
    const tzRect = tz.getBoundingClientRect();
    if (tzRect.width > 0) {
      right = Math.max(0, window.innerWidth - tzRect.left + RIGHT_GAP);
    }
  }

  const left = Math.round(rect.right + 8);
  if (window.innerWidth - right - left < 180) return; // no room — leave off-screen
  panelEl.style.left   = `${left}px`;
  panelEl.style.right  = `${Math.round(right)}px`;
  panelEl.style.top    = `${Math.round(rect.top)}px`;
  panelEl.style.height = `${Math.round(rect.height)}px`;
  panelEl.style.bottom = '';
}
window.addEventListener('resize', () => {
  updatePanelPosition();
  if (activeMenuEl) positionActiveMenu();
  if (dropdownEl) positionDropdown();
});

// TradingView listens to keyboard events on document with capture: true, so
// our target-phase handlers never get a chance to stop them. Intercept in
// the capture phase for any event that originates inside our panel.
function installKeyboardShield() {
  const shield = (e) => {
    if (!panelEl?.contains(e.target)) return;
    e.stopPropagation();
  };
  document.addEventListener('keydown',  shield, true);
  document.addEventListener('keyup',    shield, true);
  document.addEventListener('keypress', shield, true);
}

function onOutsideClick(e) {
  if (!panelEl?.contains(e.target) && !dropdownEl?.contains(e.target)) closeDropdown();
  if (!panelEl?.contains(e.target) && !activeMenuEl?.contains(e.target)) closeActiveMenu();
}

async function onFocus() {
  if (!catalog) {
    const r = await chrome.runtime.sendMessage({ type: 'fetchCatalog' });
    if (r?.ok) catalog = r.catalog;
    else log('catalog fetch failed', r?.error);
  }
  openDropdown();
  updateFiltered();
}

function onInput() {
  if (!dropdownEl) openDropdown();
  highlightIdx = 0;
  updateFiltered();
}

function onKeyDown(e) {
  // Native single-line input default for ArrowUp/Down is to jump the caret
  // to line-start/line-end — always preventDefault so those keys are ours.
  // Enter/Tab also always eaten to avoid form-submit / focus-jump fallbacks.
  const navKeys = ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Home', 'End'];
  if (navKeys.includes(e.key)) e.preventDefault();
  if (e.key === 'Escape') { closeDropdown(); inputEl.blur(); return; }
  if (!filteredEntries.length) return;
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    highlightIdx = (highlightIdx + 1) % filteredEntries.length;
    renderRows();
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    highlightIdx = (highlightIdx - 1 + filteredEntries.length) % filteredEntries.length;
    renderRows();
  } else if (e.key === 'Enter') {
    pickMetric(filteredEntries[highlightIdx]);
  }
}

function openDropdown() {
  if (dropdownEl) return;
  dropdownEl = document.createElement('div');
  dropdownEl.style.cssText = `
    position: fixed; z-index: 999999;
    background: rgba(24, 24, 27, 0.98);
    border: 1px solid rgba(82, 82, 91, 0.6); border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    max-height: 320px; overflow-y: auto;
    font-family: inherit; color: rgb(228, 228, 231);
  `;
  document.body.appendChild(dropdownEl);
  positionDropdown();
}

function positionDropdown() {
  if (!dropdownEl || !inputEl) return;
  const rect = inputEl.getBoundingClientRect();
  const height = Math.min(320, window.innerHeight - 80);
  dropdownEl.style.left = `${rect.left}px`;
  dropdownEl.style.width = `${Math.max(rect.width, 420)}px`;
  dropdownEl.style.maxHeight = `${height}px`;
  dropdownEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
}

function closeDropdown() {
  if (dropdownEl) { dropdownEl.remove(); dropdownEl = null; }
  if (inputEl) inputEl.value = '';
  filteredEntries = [];
  highlightIdx = 0;
}

function updateFiltered() {
  if (!catalog) { filteredEntries = []; renderRows(); return; }
  const q = (inputEl?.value || '').trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const active = new Set(overlays.map(o => o.metric));

  const scored = [];
  for (const e of catalog.entries) {
    if (active.has(e.stat)) continue;
    const hay = (e.stat + ' ' + e.description + ' ' + e.group).toLowerCase();
    let all = true, score = 0;
    for (const t of tokens) {
      const inStat = e.stat.toLowerCase().includes(t);
      const inGroup = e.group.toLowerCase().includes(t);
      const inDesc = e.description.toLowerCase().includes(t);
      if (!inStat && !inGroup && !inDesc) { all = false; break; }
      score += inStat ? 100 : inGroup ? 10 : 1;
    }
    if (!all) continue;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  filteredEntries = scored.slice(0, 200).map(s => s.e);
  if (highlightIdx >= filteredEntries.length) highlightIdx = 0;
  renderRows();
}

function renderRows() {
  if (!dropdownEl) return;
  dropdownEl.innerHTML = '';
  positionDropdown();

  if (!catalog) {
    const empty = document.createElement('div');
    empty.textContent = 'Loading catalog…';
    empty.style.cssText = 'padding: 10px; color: rgb(113, 113, 122); font-size: 12px;';
    dropdownEl.appendChild(empty);
    return;
  }
  if (!filteredEntries.length) {
    const empty = document.createElement('div');
    empty.textContent = inputEl?.value ? 'No matches' : 'Type to search metrics';
    empty.style.cssText = 'padding: 10px; color: rgb(113, 113, 122); font-size: 12px;';
    dropdownEl.appendChild(empty);
    return;
  }

  filteredEntries.forEach((e, i) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: baseline; gap: 8px; padding: 6px 10px;
      font-size: 12px; cursor: pointer; border-bottom: 1px solid rgba(63, 63, 70, 0.5);
      background: ${i === highlightIdx ? 'rgba(82, 82, 91, 0.5)' : 'transparent'};
    `;
    row.addEventListener('mouseenter', () => { highlightIdx = i; updateRowHighlight(); });
    row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickMetric(e); });

    const name = document.createElement('span');
    name.textContent = e.stat;
    name.style.cssText = 'font-family: ui-monospace, monospace; color: rgb(228, 228, 231); flex-shrink: 0;';
    row.appendChild(name);

    const group = document.createElement('span');
    group.textContent = e.group;
    group.style.cssText = 'color: rgb(161, 161, 170); font-size: 10px; flex-shrink: 0;';
    row.appendChild(group);

    const desc = document.createElement('span');
    desc.textContent = e.description || '';
    desc.style.cssText = 'color: rgb(113, 113, 122); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    row.appendChild(desc);

    dropdownEl.appendChild(row);
  });
}

function updateRowHighlight() {
  if (!dropdownEl) return;
  const rows = dropdownEl.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].style.background = i === highlightIdx ? 'rgba(82, 82, 91, 0.5)' : 'transparent';
  }
}

async function pickMetric(entry) {
  if (!entry) return;
  // pairedExpiration comes pre-resolved from the catalog builder — no need
  // to re-detect it here.
  const r = await chrome.runtime.sendMessage({
    type: 'addOverlay',
    metric: entry.stat,
    label: entry.label || entry.stat,
    isStrike: entry.isStrike,
    unit: entry.unit || null,
    pairedExpiration: entry.pairedExpiration || null,
  });
  overlays = r?.overlays || overlays;
  renderChips();
  closeDropdown();
  await drawOverlay(entry.stat);
}

function renderChips() {
  if (!activeBtnEl) return;
  const n = overlays.length;
  activeBtnEl.innerHTML = '';
  // Color dot preview showing the first overlay's swatch when there's exactly
  // one — otherwise just count.
  if (n === 1) {
    const dot = document.createElement('span');
    dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; background: ${overlays[0].color}; display: inline-block;`;
    activeBtnEl.appendChild(dot);
  }
  const text = document.createElement('span');
  text.textContent = n === 0 ? 'No overlays' : `${n} overlay${n === 1 ? '' : 's'}`;
  activeBtnEl.appendChild(text);
  const caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'color: rgb(161, 161, 170); font-size: 10px;';
  activeBtnEl.appendChild(caret);
  activeBtnEl.disabled = n === 0;
  activeBtnEl.style.opacity = n === 0 ? '0.5' : '1';
  activeBtnEl.style.cursor = n === 0 ? 'default' : 'pointer';
  // Keep the menu content in sync if it's already open
  if (activeMenuEl) renderActiveMenu();
}

function toggleActiveMenu() {
  if (activeMenuEl) closeActiveMenu(); else openActiveMenu();
}

function openActiveMenu() {
  if (!overlays.length) return;
  if (activeMenuEl) return;
  activeMenuEl = document.createElement('div');
  activeMenuEl.style.cssText = `
    position: fixed; z-index: 999999;
    background: rgba(24, 24, 27, 0.98);
    border: 1px solid rgba(82, 82, 91, 0.6); border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
    max-height: 320px; overflow-y: auto;
    font-family: inherit; color: rgb(228, 228, 231);
    min-width: 260px;
  `;
  document.body.appendChild(activeMenuEl);
  positionActiveMenu();
  renderActiveMenu();
}

function positionActiveMenu() {
  if (!activeMenuEl || !activeBtnEl) return;
  const rect = activeBtnEl.getBoundingClientRect();
  activeMenuEl.style.left = `${rect.left}px`;
  activeMenuEl.style.bottom = `${window.innerHeight - rect.top + 4}px`;
}

function closeActiveMenu() {
  if (activeMenuEl) { activeMenuEl.remove(); activeMenuEl = null; }
}

function renderActiveMenu() {
  if (!activeMenuEl) return;
  activeMenuEl.innerHTML = '';
  positionActiveMenu();
  for (const o of overlays) {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      font-size: 12px; border-bottom: 1px solid rgba(63, 63, 70, 0.4);
    `;
    const dot = document.createElement('span');
    dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; background: ${o.color}; flex-shrink: 0;`;
    row.appendChild(dot);

    const name = document.createElement('span');
    name.textContent = o.label || o.metric;
    name.title = o.metric;
    name.style.cssText = 'font-family: ui-monospace, monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    row.appendChild(name);

    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove overlay';
    x.style.cssText = `
      background: transparent; color: rgb(161, 161, 170);
      border: 0; cursor: pointer; padding: 0 4px;
      font-size: 16px; line-height: 1;
    `;
    x.addEventListener('mouseenter', () => { x.style.color = 'rgb(248, 113, 113)'; });
    x.addEventListener('mouseleave', () => { x.style.color = 'rgb(161, 161, 170)'; });
    x.addEventListener('click', async () => {
      await removeOverlay(o.metric);
      if (!overlays.length) closeActiveMenu();
    });
    row.appendChild(x);

    activeMenuEl.appendChild(row);
  }
}

async function removeOverlay(metric) {
  const r = await chrome.runtime.sendMessage({ type: 'removeOverlay', metric });
  overlays = r?.overlays || overlays;
  renderChips();
  postToPage({ type: 'clearMetric', metric });
}

async function drawOverlay(metric) {
  if (!currentSymbol) return;
  const overlay = overlays.find(o => o.metric === metric);
  if (!overlay) return;
  const targetSymbol = currentSymbol;
  startLoading();
  const r = await chrome.runtime.sendMessage({
    type: 'fetchHistory',
    ticker: targetSymbol,
    metrics: [metric],
  });
  stopLoading();
  if (targetSymbol !== currentSymbol) return;
  if (!r?.ok) { log('history fetch failed', r?.error); return; }
  const points = r.series?.[metric] || [];
  postToPage({
    type: 'drawSeries',
    symbol: targetSymbol,
    metric,
    color: overlay.color,
    isStrike: overlay.isStrike,
    unit: overlay.unit || null,
    label: overlay.label || overlay.metric,
    points,
  });
}

let fetchGeneration = 0;

async function refreshOverlaysForSymbol() {
  const gen = ++fetchGeneration;
  const targetSymbol = currentSymbol;
  postToPage({ type: 'clearAll' });
  if (!overlays.length || !targetSymbol) return;
  const metrics = overlays.map(o => o.metric);
  startLoading();
  const r = await chrome.runtime.sendMessage({
    type: 'fetchHistory',
    ticker: targetSymbol,
    metrics,
  });
  stopLoading();
  if (gen !== fetchGeneration) { log('stale fetch abandoned for', targetSymbol); return; }
  if (targetSymbol !== currentSymbol) { log('symbol shifted, abandoning', targetSymbol); return; }
  if (!r?.ok) { log('bulk history fetch failed', r?.error); return; }
  for (const o of overlays) {
    const points = r.series?.[o.metric] || [];
    postToPage({
      type: 'drawSeries',
      symbol: targetSymbol,
      metric: o.metric,
      color: o.color,
      isStrike: o.isStrike,
      unit: o.unit || null,
      label: o.label || o.metric,
      points,
    });
  }
}

function startLoading() {
  loadingCount++;
  updateBrand();
}
function stopLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  updateBrand();
}
function updateBrand() {
  if (!brandEl) return;
  if (loadingCount > 0) {
    brandEl.innerHTML = '<span class="amoa-tv-spinner" title="Loading AMOA data…"></span>';
  } else {
    brandEl.textContent = 'AMOA';
  }
}
