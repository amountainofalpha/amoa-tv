const ENV_URLS = {
  dev:  'http://localhost:8000',
  prod: 'https://www.amountainofalpha.com',
};

const DEFAULT_ENV = 'prod';

const SCOPE = 'amoa.read';
const CLIENT_NAME = 'AMOA TradingView Overlay';

// AMOA Overlay Pine study identifiers are per-user, stored in
// chrome.storage.local under `pineIds` — each user provides their own hash
// via the popup onboarding wizard (auto-detected once they add the Pine
// script to their chart).

// Depth = every snapshot date the user's tier grants (via available_snapshots).
// MCP ticker_metrics is capped at 10 dates and 30 stats per call, so we batch.
const DATES_PER_BATCH = 10;
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

async function getBaseUrl() {
  return ENV_URLS[await getEnv()];
}
