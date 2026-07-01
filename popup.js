const envSelect = document.getElementById('env');
const dot       = document.getElementById('dot');
const status    = document.getElementById('status');
const authBtn   = document.getElementById('authBtn');
const err       = document.getElementById('err');

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'getAuthState' });
  envSelect.value = state.env;
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
  }
}

envSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ env: envSelect.value });
  err.hidden = true;
  refresh();
});

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

refresh();
