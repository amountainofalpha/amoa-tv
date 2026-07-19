importScripts('config.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  // Wrap both success + failure so we always attempt to close the channel,
  // and swallow "message channel closed" errors that fire when the sender
  // (tab / content script) has gone away by the time we resolve.
  Promise.resolve()
    .then(() => handler(msg))
    .then((result) => {
      try { sendResponse(result); } catch (_) {}
    })
    .catch((e) => {
      try { sendResponse({ ok: false, error: String(e?.message || e) }); } catch (_) {}
    });
  return true;
});

// ============================================================================
// Update check: poll the repo's GitHub releases for a newer version tag.
// Releases must be tagged v<version> matching manifest.json (build.sh names
// the zip from the same field). api.github.com serves CORS `*`, so no host
// permission is needed. Cached 6h; the popup forces a read on open and a
// startup check keeps the icon badge fresh even if the popup stays closed.
// ============================================================================

const RELEASES_API  = 'https://api.github.com/repos/amountainofalpha/amoa-tv/releases/latest';
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

async function handleCheckUpdate({ force } = {}) {
  const now = Date.now();
  const { updateCheck = {} } = await chrome.storage.local.get('updateCheck');
  let latest = updateCheck.latest || null;
  if (force || !updateCheck.checkedAt || now - updateCheck.checkedAt >= UPDATE_CHECK_TTL_MS) {
    try {
      const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('GitHub API ' + res.status);
      const body = await res.json();
      latest = String(body?.tag_name || '').replace(/^v/i, '') || null;
      await chrome.storage.local.set({ updateCheck: { checkedAt: now, latest } });
    } catch (e) {
      // Keep whatever we knew before; retry after TTL.
      await chrome.storage.local.set({ updateCheck: { checkedAt: now, latest } });
    }
  }
  const current = chrome.runtime.getManifest().version;
  const updateAvailable = !!latest && compareVersions(latest, current) > 0;
  try {
    chrome.action.setBadgeText({ text: updateAvailable ? 'NEW' : '' });
    if (updateAvailable) chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } catch (_) {}
  return { ok: true, current, latest, updateAvailable };
}

// Dotted-numeric compare: 0.2.0 > 0.1.9, tolerates different lengths.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Refresh the badge whenever the service worker spins up (throttled by TTL).
handleCheckUpdate().catch(() => {});

// Extension load (install / update / reload) and browser startup bypass the
// TTL — a fresh install may be the very version the badge advertised, so
// re-resolve immediately instead of showing a stale NEW for up to 6 hours.
chrome.runtime.onInstalled.addListener(() => { handleCheckUpdate({ force: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { handleCheckUpdate({ force: true }).catch(() => {}); });

// One-time migration: config saved by pre-sync versions moves from
// storage.local to storage.sync so it survives reinstalls from now on.
// configGet's local fallback covers any read that races this.
async function migrateConfigToSync() {
  const [syncVals, localVals] = await Promise.all([
    chrome.storage.sync.get(SYNC_CONFIG_KEYS),
    chrome.storage.local.get(SYNC_CONFIG_KEYS),
  ]);
  const patch = {};
  for (const k of SYNC_CONFIG_KEYS) {
    if (syncVals[k] === undefined && localVals[k] !== undefined) patch[k] = localVals[k];
  }
  if (!Object.keys(patch).length) return;
  await chrome.storage.sync.set(patch);
  await chrome.storage.local.remove(Object.keys(patch));
  console.log('[amoa-tv:bg] migrated config to storage.sync:', Object.keys(patch));
}
migrateConfigToSync().catch(() => {});

// ============================================================================
// Auth: OAuth 2.1 + PKCE against amoa's MCP server.
// ============================================================================

async function loadAuth(env) {
  const { oauth = {} } = await chrome.storage.local.get('oauth');
  return oauth[env] || null;
}

async function saveAuth(env, patch) {
  const { oauth = {} } = await chrome.storage.local.get('oauth');
  oauth[env] = { ...(oauth[env] || {}), ...patch };
  await chrome.storage.local.set({ oauth });
  return oauth[env];
}

async function clearAuth(env) {
  const { oauth = {} } = await chrome.storage.local.get('oauth');
  delete oauth[env];
  await chrome.storage.local.set({ oauth });
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function makePkce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

async function ensureClient(env) {
  const auth = (await loadAuth(env)) || {};
  const redirect_uri = chrome.identity.getRedirectURL();
  if (auth.client_id && auth.redirect_uri === redirect_uri) return auth;
  const base = ENV_URLS[env];
  const res = await fetch(`${base}/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect_uri], client_name: CLIENT_NAME }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = await res.json();
  return saveAuth(env, { client_id: data.client_id, redirect_uri });
}

async function handleSignIn() {
  const env = await getEnv();
  const base = ENV_URLS[env];
  const { client_id, redirect_uri } = await ensureClient(env);
  const { verifier, challenge } = await makePkce();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  const params = new URLSearchParams({
    client_id, redirect_uri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: SCOPE,
    state,
  });
  const authUrl = `${base}/mcp/oauth/authorize?${params.toString()}`;

  const redirectResponse = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }).catch((e) => { throw new Error('auth flow cancelled: ' + e.message); });
  if (!redirectResponse) throw new Error('auth flow returned no url');

  const url = new URL(redirectResponse);
  if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('authorize error: ' + (url.searchParams.get('error') || 'no code'));

  const tokenRes = await fetch(`${base}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code, client_id, redirect_uri, code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const t = await tokenRes.json();
  await saveAuth(env, {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in || 3600) * 1000) - 30_000,
  });
  broadcastAuthState(true);
  chrome.tabs.create({ url: `${base}/mcp/connected?client=TradingView` });
  return { ok: true };
}

async function handleSignOut() {
  const env = await getEnv();
  await clearAuth(env);
  broadcastAuthState(false);
  return { ok: true };
}

// Notify every TradingView chart tab that auth changed so content.js can
// mount/unmount the panel and clear drawings without waiting for a reload.
async function broadcastAuthState(signedIn) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.tradingview.com/chart/*' });
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'authChanged', signedIn })
        .catch(() => {}); // tab may not have our content script loaded yet
    }
  } catch (_) {}
}

async function refreshTokens(env) {
  const auth = await loadAuth(env);
  if (!auth?.refresh_token || !auth.client_id) return null;
  const base = ENV_URLS[env];
  const res = await fetch(`${base}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id,
    }).toString(),
  });
  if (!res.ok) return null;
  const t = await res.json();
  return saveAuth(env, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || auth.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in || 3600) * 1000) - 30_000,
  });
}

async function accessTokenValid(env) {
  const auth = await loadAuth(env);
  if (!auth?.access_token) return null;
  if (auth.expires_at && auth.expires_at < Date.now()) return await refreshTokens(env);
  return auth;
}

// ============================================================================
// MCP JSON-RPC transport
// ============================================================================

let rpcId = 1;

async function mcpCall(method, params) {
  const env = await getEnv();
  let auth = await accessTokenValid(env);
  if (!auth) return { ok: false, authRequired: true, error: 'not signed in' };
  const base = ENV_URLS[env];

  const doCall = (tok) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });

  let res = await doCall(auth.access_token);
  if (res.status === 401) {
    auth = await refreshTokens(env);
    if (!auth) return { ok: false, authRequired: true, error: 'session expired' };
    res = await doCall(auth.access_token);
  }
  if (!res.ok) return { ok: false, error: `mcp HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };

  const payload = await res.json();
  if (payload.error) return { ok: false, error: payload.error.message || 'rpc error' };
  return { ok: true, result: payload.result };
}

async function toolCall(name, args) {
  const rpc = await mcpCall('tools/call', { name, arguments: args });
  if (!rpc.ok) return rpc;
  const content = rpc.result?.content?.[0]?.text;
  if (rpc.result?.isError) return { ok: false, error: content || 'tool error' };
  if (!content) return { ok: false, error: 'empty tool response' };
  try { return { ok: true, payload: JSON.parse(content) }; }
  catch { return { ok: false, error: 'unparseable tool output' }; }
}

// ============================================================================
// Feature: metric catalog + history batching.
// ============================================================================

// Map TradingView's various aliases for the same index to AMOA's canonical
// symbol. AMOA stores broad-market indices with a `^` prefix (SPX → ^SPX)
// same convention as their ClickHouse ohlc dict (see main.py's replaceAll
// with `I:`). Regular equities keep their bare ticker.
const INDEX_ALIASES = {
  US500: 'SPX', SPX500: 'SPX', SPX: 'SPX', SP500: 'SPX', ES1: 'SPX',
  US100: 'NDX', NAS100: 'NDX', NDX: 'NDX', NDQ100: 'NDX', NQ1: 'NDX',
  US30:  'DJI', DJI: 'DJI', US30USD: 'DJI', YM1: 'DJI',
  US2000: 'RUT', RUT: 'RUT', RTY1: 'RUT',
  VIX: 'VIX', VIX1: 'VIX',
};

function normalizeTicker(rawTicker) {
  if (!rawTicker) return null;
  const bare = rawTicker.includes(':') ? rawTicker.split(':').pop() : rawTicker;
  const upper = bare.toUpperCase().replace(/^[A-Z]+[:/]/, '');
  const asIndex = INDEX_ALIASES[upper];
  if (asIndex) return '^' + asIndex;
  return upper;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let _catalogCache = null;
let _snapshotsCache = null; // { fetchedAt, dates: [YYYY-MM-DD, ...] } — session-scoped

async function loadSnapshotDates() {
  if (_snapshotsCache && (Date.now() - _snapshotsCache.fetchedAt) < 3600_000) {
    return _snapshotsCache.dates;
  }
  const r = await toolCall('available_snapshots', {});
  if (!r.ok) return null;
  const raw = r.payload?.snapshot_dates || [];
  const dates = raw.map(d => String(d).slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => (a < b ? 1 : -1));
  console.log('[amoa-tv:bg] available_snapshots: tier=', r.payload?.tier,
              'max_lookback_days=', r.payload?.max_lookback_days,
              'count=', dates.length,
              'newest=', dates[0], 'oldest=', dates[dates.length - 1]);
  _snapshotsCache = { fetchedAt: Date.now(), dates };
  return dates;
}

// Strike metrics come in two naming shapes:
//   1. Suffix form:  foo_strike               → foo_expiration
//   2. Infix form:   foo_strike_bar_baz       → foo_expiration_bar_baz
// HistoricalChart on the site only handles form 1; the tolerance-band variants
// (e.g. peak_call_dominant_delta_strike_longest_dte_tolerance_10) are form 2
// and need the middle-string swap. Return the sibling name if it exists in
// the catalog, otherwise null.
function findExpirationSibling(name, byName) {
  if (name.endsWith('_strike')) {
    const sib = name.slice(0, -'_strike'.length) + '_expiration';
    if (byName[sib]) return sib;
  }
  const idx = name.indexOf('_strike_');
  if (idx > -1) {
    const sib = name.slice(0, idx) + '_expiration_' + name.slice(idx + '_strike_'.length);
    if (byName[sib]) return sib;
  }
  return null;
}

async function handleFetchCatalog() {
  if (_catalogCache) return { ok: true, catalog: _catalogCache };
  const r = await toolCall('available_screener_filters', {});
  if (!r.ok) return r;
  const raw = r.payload?.catalog || [];
  const byName = Object.fromEntries(raw.map(e => [e.name, e]));
  const entries = [];
  for (const e of raw) {
    const isStrike = e.compare_kind === 'strike';
    entries.push({
      stat: e.name,
      label: e.label || e.name,
      description: e.description,
      group: e.group,
      unit: e.unit,
      isStrike,
      pairedExpiration: isStrike ? findExpirationSibling(e.name, byName) : null,
    });
  }
  _catalogCache = { total: entries.length, entries };
  return { ok: true, catalog: _catalogCache };
}

// Fetch history for many metrics × the user's allowed snapshot dates
// (available_snapshots respects subscription tier). Returns
// { [metric]: [{time, value, expiration?}, ...] } sorted oldest→newest.
// Any overlay with a pairedExpiration also pulls that sibling in the same
// batch so each point can carry its own expiration date.
async function handleFetchHistory({ ticker: rawTicker, metrics }) {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return { ok: false, error: 'unsupported symbol: ' + rawTicker };
  if (!Array.isArray(metrics) || !metrics.length) return { ok: true, series: {} };

  // Look up paired-expiration siblings. Prefer the *current* catalog entry
  // so overlays saved before pairing detection got fixed still work — the
  // stored `pairedExpiration` on old overlays is null and would otherwise
  // permanently miss the forward-drawing branch.
  const cat = await handleFetchCatalog();
  const catByStat = cat.ok ? Object.fromEntries(cat.catalog.entries.map(e => [e.stat, e])) : {};
  const overlays = (await configGet('overlays')) || [];
  const overlayByMetric = Object.fromEntries(overlays.map(o => [o.metric, o]));
  const pairedFor = {}; // metric → sibling
  const statSet = new Set(metrics);
  for (const m of metrics) {
    const sib = catByStat[m]?.pairedExpiration || overlayByMetric[m]?.pairedExpiration;
    if (sib) { pairedFor[m] = sib; statSet.add(sib); }
  }
  const allStats = [...statSet];

  const allDates = await loadSnapshotDates();
  if (!allDates?.length) return { ok: false, error: 'no snapshot dates available' };
  // One range call per stat batch covers the user's full allowed history —
  // the server clamps the range to the subscription tier's lookback window,
  // so oldest/newest here are just hints, not access control.
  const statBatches = chunk(allStats, MAX_STATS_PER_BATCH);

  const seriesByMetric = Object.fromEntries(metrics.map(m => [m, []]));

  // loadSnapshotDates sorts newest-first.
  const jobs = statBatches.map(sBatch => toolCall('ticker_metrics', {
    tickers: [ticker], stats: sBatch,
    snapshot_start: allDates[allDates.length - 1], snapshot_end: allDates[0],
  }));
  const results = await Promise.all(jobs);

  for (const r of results) {
    if (!r.ok) continue;
    const perTicker = r.payload?.data?.[ticker];
    if (!perTicker) continue;
    for (const [dateStr, stats] of Object.entries(perTicker)) {
      const timeSec = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
      for (const m of metrics) {
        const v = stats?.[m];
        if (v == null || !Number.isFinite(Number(v))) continue;
        const point = { time: timeSec, value: Number(v) };
        const sib = pairedFor[m];
        if (sib) {
          const expRaw = stats?.[sib];
          const expTime = yyyymmddToUnixSec(expRaw);
          if (expTime != null) point.expiration = expTime;
        }
        seriesByMetric[m].push(point);
      }
    }
  }
  for (const m of metrics) seriesByMetric[m].sort((a, b) => a.time - b.time);

  for (const m of metrics) {
    console.log('[amoa-tv:bg] history', ticker, m, 'points=', seriesByMetric[m].length,
                'paired=', !!pairedFor[m]);
  }

  return { ok: true, series: seriesByMetric, ticker };
}

// Convert a YYYYMMDD integer (as stored in expiration columns) to Unix
// seconds at midnight UTC. Same shape HistoricalChart._yyyymmddToIso decodes.
function yyyymmddToUnixSec(n) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num) || num <= 0) return null;
  const y = Math.floor(num / 10000);
  const m = Math.floor((num % 10000) / 100);
  const d = num % 100;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

// ============================================================================
// Overlays persistence (chrome.storage).
// ============================================================================

async function handleGetOverlays() {
  const overlays = (await configGet('overlays')) || [];
  // Auto-heal overlays saved before we tracked unit / pairedExpiration /
  // isStrike from the catalog. Without this, stored non-USD overlays keep
  // routing to the main-axis line branch instead of the study-hijack path.
  const cat = await handleFetchCatalog();
  if (cat.ok) {
    const byStat = Object.fromEntries(cat.catalog.entries.map(e => [e.stat, e]));
    let changed = false;
    for (const o of overlays) {
      const e = byStat[o.metric];
      if (!e) continue;
      if (o.unit == null && e.unit)                         { o.unit = e.unit; changed = true; }
      if (o.pairedExpiration == null && e.pairedExpiration) { o.pairedExpiration = e.pairedExpiration; changed = true; }
      if (o.isStrike !== e.isStrike)                        { o.isStrike = e.isStrike; changed = true; }
      if (!o.label && e.label)                              { o.label = e.label; changed = true; }
    }
    if (changed) await configSet({ overlays });
  }
  // Repair duplicate colors carried over from the old index-mod picker.
  // Walk in order — first occurrence keeps its color; any later overlay
  // sharing it gets remapped to the first unused palette slot.
  const seen = new Set();
  let recolored = false;
  for (const o of overlays) {
    // User-picked colors always win — never remap them, even if two
    // overlays end up the same shade on purpose.
    if (o.customColor && o.color) { seen.add(o.color); continue; }
    if (o.color && !seen.has(o.color)) { seen.add(o.color); continue; }
    const next = COLOR_PALETTE.find(c => !seen.has(c))
              || COLOR_PALETTE[seen.size % COLOR_PALETTE.length];
    o.color = next;
    seen.add(next);
    recolored = true;
  }
  if (recolored) await configSet({ overlays });
  return { ok: true, overlays };
}

// Serialize every overlays read+modify+write behind a shared chain — two
// concurrent removes / adds otherwise both read the same base list and the
// second write clobbers the first, leaving one overlay stuck in storage
// (visually "the chart didn't update after I removed it").
let overlaysMutex = Promise.resolve();
function withOverlaysLock(fn) {
  const next = overlaysMutex.then(fn, fn);
  overlaysMutex = next.catch(() => {}); // don't poison the chain on error
  return next;
}

async function handleAddOverlay({ metric, label, isStrike, unit, pairedExpiration }) {
  return withOverlaysLock(async () => {
    const overlays = (await configGet('overlays')) || [];
    if (overlays.some(o => o.metric === metric)) return { ok: true, overlays };
    const color = pickAvailableColor(overlays);
    overlays.push({
      metric, label, color,
      isStrike: !!isStrike,
      unit: unit || null,
      pairedExpiration: pairedExpiration || null,
    });
    await configSet({ overlays });
    return { ok: true, overlays };
  });
}

// First color in the palette that no existing overlay currently uses. Once
// every color is taken, fall back to cycling. Avoids the "removed one,
// added another → duplicate color" case where two overlays end up the
// same shade because the naive index=length picker doesn't skip already-
// taken palette slots.
function pickAvailableColor(overlays) {
  const taken = new Set(overlays.map(o => o.color));
  for (const c of COLOR_PALETTE) if (!taken.has(c)) return c;
  return COLOR_PALETTE[overlays.length % COLOR_PALETTE.length];
}

async function handleRemoveOverlay({ metric }) {
  return withOverlaysLock(async () => {
    const overlays = (await configGet('overlays')) || [];
    const next = overlays.filter(o => o.metric !== metric);
    await configSet({ overlays: next });
    return { ok: true, overlays: next };
  });
}

// User recolored a plot via TV's study settings dialog — persist the
// choice so future draws keep it. customColor marks it user-picked so
// the duplicate-color repair in handleGetOverlays never remaps it.
async function handleSetOverlayColor({ metric, color }) {
  return withOverlaysLock(async () => {
    const overlays = (await configGet('overlays')) || [];
    const o = overlays.find(x => x.metric === metric);
    if (!o) return { ok: true, overlays };
    o.color = color;
    o.customColor = true;
    await configSet({ overlays });
    return { ok: true, overlays };
  });
}

async function handleToggleOverlay({ metric, hidden }) {
  return withOverlaysLock(async () => {
    const overlays = (await configGet('overlays')) || [];
    const o = overlays.find(x => x.metric === metric);
    if (!o) return { ok: true, overlays };
    o.hidden = !!hidden;
    await configSet({ overlays });
    return { ok: true, overlays };
  });
}

// Reinstall recovery: content.js mirrors the config into the
// tradingview.com origin's localStorage, which survives extension
// uninstalls, and offers it back when our storage comes up empty. Only
// known config keys are accepted — auth is never part of the backup.
// No-ops (restored: false) if any config already exists, so a stale
// backup can't clobber a live setup.
async function handleRestoreConfig({ config }) {
  return withOverlaysLock(async () => {
    const cur = await loadPineIds();
    const curOverlays = (await configGet('overlays')) || [];
    if (cur.overlay || cur.ohlc || curOverlays.length) {
      return { ok: true, restored: false, pineIds: cur };
    }
    const patch = {};
    if (Array.isArray(config?.overlays)) {
      patch.overlays = config.overlays.filter(o => o && typeof o.metric === 'string');
    }
    if (config?.settings && typeof config.settings === 'object') {
      patch.settings = config.settings;
    }
    const cleanHash = (h) => String(h || '').match(/[a-f0-9]{32}/i)?.[0] || null;
    patch.pineIds = {
      overlay: cleanHash(config?.pineIds?.overlay),
      ohlc: cleanHash(config?.pineIds?.ohlc),
    };
    await configSet(patch);
    console.log('[amoa-tv:bg] restored config from site backup:',
                (patch.overlays || []).length, 'overlays, pineIds:',
                !!patch.pineIds.overlay, !!patch.pineIds.ohlc);
    broadcastPineIds(patch.pineIds);
    return { ok: true, restored: true, pineIds: patch.pineIds };
  });
}

async function handleGetAuthState() {
  const env = await getEnv();
  const auth = await loadAuth(env);
  const pineIds = await loadPineIds();
  return {
    env,
    signedIn: !!auth?.access_token,
    hasClient: !!auth?.client_id,
    expiresAt: auth?.expires_at || null,
    pineIds,
    setupComplete: !!(auth?.access_token && pineIds.overlay && pineIds.ohlc),
  };
}

// ============================================================================
// Pine script IDs — user-configurable so each user's private Pine copies work.
// Storage shape (chrome.storage.sync, so onboarding survives reinstalls):
// { pineIds: { overlay: '<hash>', ohlc: '<hash>' } }
// Values are the raw 32-char hex hash portion of `USER;<hash>` — page.js
// reconstructs the full pineId as needed.
// ============================================================================

async function loadPineIds() {
  const pineIds = (await configGet('pineIds')) || {};
  return { overlay: pineIds.overlay || null, ohlc: pineIds.ohlc || null };
}

async function savePineIds(patch) {
  const cur = await loadPineIds();
  const next = { ...cur, ...patch };
  await configSet({ pineIds: next });
  return next;
}

async function handleGetPineIds() {
  return { ok: true, pineIds: await loadPineIds() };
}

async function handleSetPineId({ kind, hash }) {
  if (!['overlay', 'ohlc'].includes(kind)) return { ok: false, error: 'invalid kind' };
  const cleaned = String(hash || '').match(/[a-f0-9]{32}/i)?.[0] || null;
  const pineIds = await savePineIds({ [kind]: cleaned });
  broadcastPineIds(pineIds);
  return { ok: true, pineIds };
}

async function handleClearPineId({ kind }) {
  const pineIds = await savePineIds({ [kind]: null });
  broadcastPineIds(pineIds);
  return { ok: true, pineIds };
}

async function broadcastPineIds(pineIds) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.tradingview.com/chart/*' });
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'pineIdsChanged', pineIds })
        .catch(() => {});
    }
  } catch (_) {}
}

const HANDLERS = {
  fetchCatalog:   handleFetchCatalog,
  fetchHistory:   handleFetchHistory,
  getOverlays:    handleGetOverlays,
  addOverlay:     handleAddOverlay,
  removeOverlay:  handleRemoveOverlay,
  toggleOverlay:  handleToggleOverlay,
  setOverlayColor: handleSetOverlayColor,
  restoreConfig:  handleRestoreConfig,
  checkUpdate:    handleCheckUpdate,
  getAuthState:   handleGetAuthState,
  getPineIds:     handleGetPineIds,
  setPineId:      handleSetPineId,
  clearPineId:    handleClearPineId,
  signIn:         wrap(handleSignIn),
  signOut:        handleSignOut,
};

function wrap(fn) {
  return async (msg) => {
    try { return await fn(msg); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };
}
