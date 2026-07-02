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
    return;
  }

  const p = state.pineIds || {};
  const complete = !!p.overlay && !!p.ohlc;
  // Hide the whole Setup section (banner + both step rows) once both
  // Pine IDs are configured — user doesn't need onboarding anymore.
  setupSection.hidden = complete;
  readyBanner.hidden = !complete;
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
ohlcReset.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearPineId', kind: 'ohlc' });
  refresh();
});

// Live-update when background saves an auto-detected Pine ID — no need to
// close and reopen the popup for the ✓ to appear.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pineIds || changes.oauth) refresh();
});

refresh();
