const ENV_URLS = {
  dev:  'http://localhost:8000',
  prod: 'https://www.amountainofalpha.com',
};

const DEFAULT_ENV = 'prod';

const SCOPE = 'amoa.read';
const CLIENT_NAME = 'AMOA TradingView Overlay';

// AMOA Overlay Pine study identifiers are per-user, stored in
// chrome.storage.sync under `pineIds` — each user provides their own hash
// via the popup onboarding wizard (auto-detected once they add the Pine
// script to their chart).

// Depth = every snapshot date the user's tier grants: one snapshot_start/
// snapshot_end range call per stat batch (MCP caps stats at 30 per call).
const MAX_STATS_PER_BATCH = 30;

// Color palette assigned to overlays in add-order.
const COLOR_PALETTE = [
  '#a855f7', '#22c55e', '#3b82f6', '#f59e0b',
  '#ec4899', '#06b6d4', '#84cc16', '#f43f5e',
];

async function getEnv() {
  const { env } = await chrome.storage.local.get('env');
  return env || DEFAULT_ENV;
}

// ── persistent config (survives reinstalls) ─────────────────────────────────
// User config lives in chrome.storage.sync so a reinstall (or a new machine
// on the same Chrome profile) restores onboarding (pineIds), overlays and
// settings without redoing setup. OAuth tokens deliberately stay in
// storage.local: refresh tokens shouldn't sit on sync servers, and token
// rotation would fight between two synced devices — after a reinstall the
// user just clicks Sign in once.
const SYNC_CONFIG_KEYS = ['overlays', 'settings', 'pineIds'];

// Read one config key: sync first, falling back to storage.local for
// pre-sync installs that background.js hasn't migrated yet.
async function configGet(key) {
  const s = await chrome.storage.sync.get(key);
  if (s[key] !== undefined) return s[key];
  const l = await chrome.storage.local.get(key);
  return l[key];
}

async function configSet(patch) {
  await chrome.storage.sync.set(patch);
}

async function getBaseUrl() {
  return ENV_URLS[await getEnv()];
}
