const envSelect     = document.getElementById('env');
const dot           = document.getElementById('dot');
const status        = document.getElementById('status');
const authBtn       = document.getElementById('authBtn');
const err           = document.getElementById('err');
const setupSection  = document.getElementById('setupSection');
const setupBanner   = document.getElementById('setupBanner');
const overlayDot    = document.getElementById('overlayDot');
const overlayReset  = document.getElementById('overlayReset');
const ohlcDot       = document.getElementById('ohlcDot');
const ohlcReset     = document.getElementById('ohlcReset');
const readyBanner   = document.getElementById('readyBanner');
const settingsSection = document.getElementById('settingsSection');
const excludeOutliers = document.getElementById('excludeOutliers');
const updateBanner    = document.getElementById('updateBanner');
const updateVersion   = document.getElementById('updateVersion');

// Independent of auth state — surface a newer GitHub release if one exists.
async function checkForUpdate() {
  const r = await chrome.runtime.sendMessage({ type: 'checkUpdate' });
  if (!r?.ok) return;
  updateBanner.hidden = !r.updateAvailable;
  if (r.updateAvailable) updateVersion.textContent = 'v' + r.latest;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'getAuthState' });
  // envSelect is stripped from the popup in prod builds (see build.sh) —
  // guard so a null reference doesn't abort refresh() before the auth
  // button's dataset.action is set (which would leave the popup stuck
  // on "checking..." and the Sign-in click a no-op).
  if (envSelect) envSelect.value = state.env;

  if (state.signedIn) {
    dot.className = 'dot ok';
    status.textContent = 'Signed in';
    authBtn.textContent = 'Sign out';
    authBtn.dataset.action = 'signOut';
  } else {
    dot.className = 'dot bad';
    status.textContent = 'Not signed in';
    authBtn.textContent = 'Sign in';
    authBtn.dataset.action = 'signIn';
    setupSection.hidden = true;
    readyBanner.hidden = true;
    settingsSection.hidden = true;
    return;
  }

  const p = state.pineIds || {};
  const complete = !!p.overlay && !!p.ohlc;
  // Hide the whole Setup section (banner + both step rows) once both
  // Pine IDs are configured — user doesn't need onboarding anymore.
  // Settings only show once fully onboarded (Ready).
  setupSection.hidden = complete;
  readyBanner.hidden = !complete;
  settingsSection.hidden = !complete;
  if (complete) {
    const settings = (await configGet('settings')) || {};
    excludeOutliers.value = settings.excludeOutliers === false ? 'no' : 'yes';
  }
  if (!complete) {
    applyStepState(overlayDot, overlayReset, !!p.overlay);
    applyStepState(ohlcDot,    ohlcReset,    !!p.ohlc);
  }
}

// Green dot + Reset button when the step is done; orange "wait" dot and
// no Reset while pending. The step's "How to" link is a plain <a> and
// stays visible in both states.
function applyStepState(dotEl, resetBtn, done) {
  dotEl.className = 'dot ' + (done ? 'ok' : 'wait');
  resetBtn.hidden = !done;
}

if (envSelect) {
  envSelect.addEventListener('change', async () => {
    await chrome.storage.local.set({ env: envSelect.value });
    err.hidden = true;
    refresh();
  });
}

authBtn.addEventListener('click', async () => {
  err.hidden = true;
  authBtn.disabled = true;
  const action = authBtn.dataset.action;
  const resp = await chrome.runtime.sendMessage({ type: action });
  authBtn.disabled = false;
  if (!resp?.ok) {
    err.hidden = false;
    err.textContent = resp?.error || 'unknown error';
  }
  refresh();
});

overlayReset.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearPineId', kind: 'overlay' });
  refresh();
});
// Persist setting changes — content.js watches chrome.storage and
// redraws the overlays live, so no reload is needed.
excludeOutliers.addEventListener('change', async () => {
  const settings = (await configGet('settings')) || {};
  settings.excludeOutliers = excludeOutliers.value === 'yes';
  await configSet({ settings });
});

ohlcReset.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearPineId', kind: 'ohlc' });
  refresh();
});

// Live-update when background saves an auto-detected Pine ID — no need to
// close and reopen the popup for the ✓ to appear. pineIds live in sync
// storage now; oauth stays local.
chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.pineIds || (area === 'local' && changes.oauth)) refresh();
});

refresh();
checkForUpdate();
