importScripts('config.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  handler(msg).then(sendResponse);
  return true;
});

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
  return { ok: true };
}

async function handleSignOut() {
  const env = await getEnv();
  await clearAuth(env);
  return { ok: true };
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
  const { overlays = [] } = await chrome.storage.local.get('overlays');
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
  // Use every snapshot the user's tier allows. available_snapshots already
  // caps by subscription tier, so no additional client-side cap is needed.
  const dates = allDates;
  const dateBatches = chunk(dates, DATES_PER_BATCH);
  const statBatches = chunk(allStats, MAX_STATS_PER_BATCH);

  const seriesByMetric = Object.fromEntries(metrics.map(m => [m, []]));

  const jobs = [];
  for (const dBatch of dateBatches) {
    for (const sBatch of statBatches) {
      jobs.push(toolCall('ticker_metrics', {
        tickers: [ticker], stats: sBatch, snapshot_dates: dBatch,
      }));
    }
  }
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
  const { overlays = [] } = await chrome.storage.local.get('overlays');
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
    if (changed) await chrome.storage.local.set({ overlays });
  }
  return { ok: true, overlays };
}

async function handleAddOverlay({ metric, label, isStrike, unit, pairedExpiration }) {
  const { overlays = [] } = await chrome.storage.local.get('overlays');
  if (overlays.some(o => o.metric === metric)) return { ok: true, overlays };
  const color = COLOR_PALETTE[overlays.length % COLOR_PALETTE.length];
  overlays.push({
    metric, label, color,
    isStrike: !!isStrike,
    unit: unit || null,
    pairedExpiration: pairedExpiration || null,
  });
  await chrome.storage.local.set({ overlays });
  return { ok: true, overlays };
}

async function handleRemoveOverlay({ metric }) {
  const { overlays = [] } = await chrome.storage.local.get('overlays');
  const next = overlays.filter(o => o.metric !== metric);
  await chrome.storage.local.set({ overlays: next });
  return { ok: true, overlays: next };
}

async function handleGetAuthState() {
  const env = await getEnv();
  const auth = await loadAuth(env);
  return {
    env,
    signedIn: !!auth?.access_token,
    hasClient: !!auth?.client_id,
    expiresAt: auth?.expires_at || null,
  };
}

const HANDLERS = {
  fetchCatalog:   handleFetchCatalog,
  fetchHistory:   handleFetchHistory,
  getOverlays:    handleGetOverlays,
  addOverlay:     handleAddOverlay,
  removeOverlay:  handleRemoveOverlay,
  getAuthState:   handleGetAuthState,
  signIn:         wrap(handleSignIn),
  signOut:        handleSignOut,
};

function wrap(fn) {
  return async (msg) => {
    try { return await fn(msg); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  };
}
