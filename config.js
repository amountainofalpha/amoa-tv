const ENV_URLS = {
  dev:  'http://localhost:8000',
  prod: 'https://www.amountainofalpha.com',
};

const DEFAULT_ENV = 'prod';

const SCOPE = 'amoa.read';
const CLIENT_NAME = 'AMOA TradingView Overlay';

// AMOA Overlay Pine study identifiers. The extension inserts this via
// `insertStudy({type: 'pine', pineId, pineVersion}, [])`. Replace pineId
// with a PUB;<hash> value once the script is published; version stays 5.0
// unless the script itself is rewritten in Pine v6+.
// Left-axis study: percent / ratio / count / days / signed non-price metrics.
const AMOA_PINE_ID = 'USER;91ba7cf3139447a3b3fb0930e49271e8';
const AMOA_PINE_VERSION = 'last';
// Right-axis study: strike prices on the OHLC axis. Paired strike +
// expiration metrics render as bar-by-bar strike values here so TV
// renders them as horizontal price lines that align with the candles.
const AMOA_OHLC_PINE_ID = 'USER;4188b047d90c4ee3b626a7b16a5a4d48';
const AMOA_OHLC_PINE_VERSION = 'last';

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
