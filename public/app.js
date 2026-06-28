const $ = (s) => document.querySelector(s);

// --- Mobile detection (more reliable than @media on iOS Safari) ---
function updateMobileClass() {
  document.documentElement.classList.toggle('is-mobile', window.innerWidth <= 600);
}
updateMobileClass();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateMobileClass, 150);
});
window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateMobileClass, 300);
});

// --- State ---
// Default conversion capabilities (will be replaced by GET /api/convert/capabilities in Step 2)
const convertCapabilities = {
  maxBytes: 10 * 1024 * 1024, // 10MB — matches server CONVERT_MAX_BYTES default
  timeoutMs: 60 * 1000,       // 60s
  extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'log', 'html', 'htm', 'json', 'xml', 'yaml', 'yml', 'jpg', 'jpeg', 'png', 'gif'],
  features: {
    pptx: true,
    imageMetadata: true,
    imageCaption: false,
    ocr: false,
  },
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB — must match server MAX_FILE_BYTES
let ws;
let wsId = null;
let currentPadId = 1;
let pads = [];
let allFiles = []; // all accessible files (unfiltered by pad)

function upsertLocalFile(file) {
  allFiles = allFiles.filter(f => f.id !== file.id);
  allFiles.unshift(file);
}
function removeLocalFile(fileId) {
  allFiles = allFiles.filter(f => f.id !== fileId);
}
let textVersion = 0;
let pendingRemoteState = null;
let lastTextRequestId = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let userCode = null; // Current user's display code (from cookie-based auth)
let longPressed = false; // Flag to prevent click after long-press on pad tabs
let toastTimer = null;   // Cancels previous hide-timeout on new toast
let previewTargetId = null; // Cancels stale markdown preview responses

async function initIdentity() {
  // Check if we already have a user code in sessionStorage
  try { userCode = sessionStorage.getItem('userCode') || null; } catch {}

  // Try to verify existing session via cookie
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      userCode = data.code;
    } else {
      // No valid session → register new user
      const regRes = await fetch('/api/auth/register', { method: 'POST' });
      if (regRes.ok) {
        const regData = await regRes.json();
        userCode = regData.code;
      }
    }
  } catch (e) {
    console.warn('Identity init failed:', e);
  }

  // Persist user code for display purposes
  if (userCode) {
    try { sessionStorage.setItem('userCode', userCode); } catch {}
    updateUserCodeUI();
  }
}

function updateUserCodeUI() {
  const el = $('#user-code-display');
  if (!el) return;
  if (userCode) {
    el.textContent = userCode;
    el.parentElement.hidden = false;
  } else {
    el.parentElement.hidden = true;
  }
}

function copyUserCode() {
  if (!userCode) return;
  if (!navigator.clipboard) {
    showToast('Copy not available in this browser context');
    return;
  }
  navigator.clipboard.writeText(userCode).then(
    () => showToast('User code copied!'),
    () => showToast('Copy failed')
  );
}



// Pad unlock tokens (padId -> token), stored in sessionStorage
function getPadToken(padId) {
  try { return JSON.parse(sessionStorage.getItem('pad-tokens') || '{}')[padId] || null; } catch { return null; }
}
function setPadToken(padId, token) {
  try {
    const tokens = JSON.parse(sessionStorage.getItem('pad-tokens') || '{}');
    if (token) tokens[padId] = token;
    else delete tokens[padId];
    sessionStorage.setItem('pad-tokens', JSON.stringify(tokens));
  } catch {}
}

// --- Theme ---
let themeMode = localStorage.getItem('notepad-theme') || 'auto';

function applyTheme() {
  if (themeMode === 'auto') {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = themeMode;
  }
}

function toggleTheme() {
  const order = ['auto', 'dark', 'light'];
  themeMode = order[(order.indexOf(themeMode) + 1) % 3];
  if (themeMode === 'auto') localStorage.removeItem('notepad-theme');
  else localStorage.setItem('notepad-theme', themeMode);
  applyTheme();
}

applyTheme();
$('#theme-toggle').addEventListener('click', toggleTheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme();
});

// --- Pad Tabs ---

function renderPadTabs() {
  const container = $('#pad-tabs');
  container.innerHTML = '';

  function addPadBtn(pad, label) {
    const btn = document.createElement('button');
    btn.className = 'pad-btn' + (pad.id === currentPadId ? ' active' : '');
    if (pad.hasPassword) btn.classList.add('locked');
    btn.textContent = label || pad.id;
    btn.title = pad.hasPassword ? `Pad ${pad.id} (locked)` : `Pad ${pad.id}`;
    btn.addEventListener('click', () => {
      if (longPressed) { longPressed = false; return; }
      switchPad(pad.id);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showDeletePadMenu(pad.id);
    });
    // Long-press for mobile (no right-click)
    let longPressTimer;
    btn.addEventListener('touchstart', (e) => {
      longPressed = false;
      longPressTimer = setTimeout(() => {
        longPressed = true;
        showDeletePadMenu(pad.id);
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);
      // If long-press already fired, delay clearing the flag so the browser's
      // delayed click event can still be swallowed. Without the delay the click
      // would see longPressed=false and trigger an unwanted tab switch.
      if (longPressed) {
        setTimeout(() => { longPressed = false; }, 100);
      }
    });
    btn.addEventListener('touchmove', () => {
      clearTimeout(longPressTimer);
      longPressed = false;
    });
    btn.addEventListener('touchcancel', () => {
      clearTimeout(longPressTimer);
      longPressed = false;
    });
    container.appendChild(btn);
  }

  // Show all pads (simple flat list with optional group labels for clarity)
  for (const pad of pads) {
    addPadBtn(pad);
  }

  // Add [+] button
  const addBtn = document.createElement('button');
  addBtn.className = 'pad-add-btn';
  addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = 'New pad';
  addBtn.addEventListener('click', createPad);
  container.appendChild(addBtn);
}

async function switchPad(padId) {
  if (padId === currentPadId) return;
  // Flush pending text sync for the old pad before switching, so edits made
  // within the 300 ms debounce window are not lost.
  if (sendTimeout) {
    clearTimeout(sendTimeout);
    await sendTextNow();
  }
  lastTextRequestId = 0;     // reset so stale responses don't update new pad
  currentPadId = padId;
  textVersion = 0;
  pendingRemoteState = null;
  $('#text-input').value = '';

  renderPadTabs();
  updateLockButton();

  // Refresh file list for the new pad
  renderFilesList(allFiles.filter(f => (f.padId || 1) === padId));

  // Try to load pad content
  await loadPadContent();
  // Reconnect WebSocket with new pad
  connectWS();
}

async function createPad() {
  try {
    const res = await fetch('/api/pads', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create pad');
    const data = await res.json();
    // Optimistically insert the new pad locally so it's immediately visible
    // (avoids a race with saveStore's 200 ms debounce).
    const newPad = {
      id: data.id,
      hasPassword: data.hasPassword || false,
      createdAt: Date.now(),
      ownerUserId: data.ownerUserId || null,
    };
    pads.push(newPad);
    renderPadTabs();
    await switchPad(data.id);
    showToast(`Created pad ${data.id}`);
  } catch (e) {
    showToast(e.message);
  }
}

async function refreshPads() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Failed to load state');
    const data = await res.json();
    if (!Array.isArray(data.pads)) throw new Error('Invalid pads data');
    pads = data.pads;
    allFiles = Array.isArray(data.files) ? data.files : [];
    renderFilesList(allFiles.filter(f => (f.padId || 1) === currentPadId));
    renderPadTabs();
    updateLockButton();
  } catch (e) {
    console.warn('Failed to refresh pads:', e);
  }
}

async function loadPadContent() {
  const padId = currentPadId;
  const token = getPadToken(padId);
  const headers = {};
  if (token) headers['X-Pad-Token'] = token;

  try {
    const res = await fetch(`/api/pads/${padId}`, { headers });
    // If the user switched pads while the request was in flight, discard.
    if (padId !== currentPadId) return;

    if (res.status === 403) {
      const data = await res.json();
      if (data.hasPassword) {
        showUnlockModal(padId);
        return;
      }
    }
    if (!res.ok) throw new Error('Failed to load pad');
    const data = await res.json();
    // Re-check after parsing in case the user switched pads while JSON was being read.
    if (padId !== currentPadId) return;
    const nextVersion = Number.isInteger(data.textVersion) ? data.textVersion : 0;
    applyTextState(data.text || '', nextVersion);
  } catch (e) {
    console.warn('Failed to load pad content:', e);
  }
}

// --- Lock Button ---

function updateLockButton() {
  const pad = pads.find(p => p.id === currentPadId);
  const btn = $('#pad-lock-btn');
  if (!pad) { btn.hidden = true; return; }
  btn.hidden = false;
  if (pad.hasPassword) {
    btn.title = 'Change/remove password';
    btn.style.color = 'var(--primary)';
  } else {
    btn.title = 'Set password';
    btn.style.color = '';
  }
}

$('#pad-lock-btn').addEventListener('click', () => {
  const pad = pads.find(p => p.id === currentPadId);
  if (!pad) return;
  if (pad.hasPassword) {
    showPasswordModal('change');
  } else {
    showPasswordModal('set');
  }
});

// --- Password Modal ---

let passwordMode = 'set'; // 'set' | 'change' | 'remove'

function showPasswordModal(mode) {
  passwordMode = mode;
  const modal = $('#password-modal');
  const title = $('#password-modal-title');
  const desc = $('#password-modal-desc');
  const input = $('#password-input');
  const confirmInput = $('#password-confirm');
  const currentInput = $('#password-current');
  const confirmBtn = $('#password-confirm-btn');
  const error = $('#password-error');

  error.hidden = true;
  input.value = '';
  confirmInput.value = '';
  currentInput.value = '';

  if (mode === 'set') {
    title.textContent = 'Set Password';
    desc.textContent = 'Enter a password to protect this pad';
    currentInput.hidden = true;
    confirmInput.hidden = false;
    confirmBtn.textContent = 'Set Password';
    confirmBtn.className = 'modal-btn confirm';
  } else if (mode === 'change') {
    title.textContent = 'Change Password';
    desc.textContent = 'Enter a new password, or leave empty to remove';
    // Current password is optional: server accepts a valid X-Pad-Token instead.
    // Only needed when the unlock token has expired (8h) or session was lost.
    currentInput.hidden = false;
    currentInput.placeholder = 'Current password (if unlock expired)';
    confirmInput.hidden = false;
    confirmBtn.textContent = 'Update';
    confirmBtn.className = 'modal-btn confirm';
  }

  modal.hidden = false;
  input.focus();
}

function hidePasswordModal() {
  $('#password-modal').hidden = true;
}

$('#password-cancel').addEventListener('click', hidePasswordModal);

$('#password-confirm-btn').addEventListener('click', async () => {
  const password = $('#password-input').value;
  const confirm = $('#password-confirm').value;
  const currentPassword = $('#password-current').value;
  const error = $('#password-error');

  if (password && password !== confirm) {
    error.textContent = 'Passwords do not match';
    error.hidden = false;
    return;
  }

  const token = getPadToken(currentPadId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;

  const body = { password: password || null };
  // Send currentPassword when provided (covers the case where the unlock
  // token has expired and X-Pad-Token alone won't authorize the change).
  if (currentPassword) body.currentPassword = currentPassword;

  try {
    const res = await fetch(`/api/pads/${currentPadId}/password`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to set password');
    }
    const data = await res.json();
    if (data.token) setPadToken(currentPadId, data.token);
    else setPadToken(currentPadId, null);

    hidePasswordModal();
    await refreshPads();
    showToast(password ? 'Password set' : 'Password removed');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
});

// --- Unlock Modal ---

let unlockTargetPadId = null;

function showUnlockModal(padId) {
  if (!$('#unlock-modal').hidden) return; // already showing, don't reset user input
  unlockTargetPadId = padId;
  $('#unlock-error').hidden = true;
  $('#unlock-input').value = '';
  $('#unlock-modal').hidden = false;
  $('#unlock-input').focus();
}

function hideUnlockModal() {
  $('#unlock-modal').hidden = true;
  unlockTargetPadId = null;
}

$('#unlock-cancel').addEventListener('click', hideUnlockModal);

$('#unlock-confirm-btn').addEventListener('click', async () => {
  if (!unlockTargetPadId) return;
  const password = $('#unlock-input').value;
  const error = $('#unlock-error');
  error.hidden = true;

  try {
    const res = await fetch(`/api/pads/${unlockTargetPadId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Wrong password');
    }
    const data = await res.json();
    if (data.token) setPadToken(unlockTargetPadId, data.token);
    hideUnlockModal();
    currentPadId = unlockTargetPadId;
    await loadPadContent();
    connectWS();
    renderPadTabs();
    updateLockButton();
    showToast('Unlocked');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
});

$('#unlock-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#unlock-confirm-btn').click();
});

// --- Confirm Modal (for delete pad / clear all) ---

function showConfirmModal(title, desc, okText, onConfirm) {
  $('#confirm-title').textContent = title;
  $('#confirm-desc').textContent = desc;
  $('#confirm-ok').textContent = okText;
  $('#confirm-modal').hidden = false;

  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');

  function cleanup() {
    $('#confirm-modal').hidden = true;
  }

  cancelBtn.onclick = cleanup;
  okBtn.onclick = () => {
    cleanup();
    onConfirm();
  };
}

async function showDeletePadMenu(padId) {
  if (pads.length <= 1) {
    showToast('Cannot delete the last pad');
    return;
  }
  showConfirmModal(
    `Delete Pad ${padId}?`,
    'This will permanently delete the pad and its content.',
    'Delete',
    async () => {
      const token = getPadToken(padId);
      const headers = {};
      if (token) headers['X-Pad-Token'] = token;
      try {
        const res = await fetch(`/api/pads/${padId}`, { method: 'DELETE', headers });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Delete failed');
        }
        setPadToken(padId, null);
        if (padId === currentPadId) {
          const nextPad = pads
            .filter(p => p.id !== padId)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (nextPad) {
            currentPadId = nextPad.id;
            textVersion = 0;
            await loadPadContent();
            connectWS();
          }
        }
        await refreshPads();
        showToast(`Deleted pad ${padId}`);
      } catch (e) {
        showToast(e.message);
      }
    }
  );
}

// --- WebSocket ---

function connectWS() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // NOTE: padToken is transmitted via URL query for WebSocket connections
  // because browsers do not support custom headers on WebSocket upgrade requests.
  // This token may appear in server access logs. For LAN-only deployments this
  // is acceptable; for internet-facing deployments, consider adding a secondary
  // authentication message after the WebSocket handshake.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const padToken = getPadToken(currentPadId);
  const params = new URLSearchParams({ pad: String(currentPadId) });
  if (padToken) params.set('padToken', padToken);
  const newWs = new WebSocket(`${proto}//${location.host}/?${params}`);
  ws = newWs;
  // Note: session token is sent via httpOnly cookie (browser auto-includes)
  // padToken is the per-pad unlock token (only present for password-protected pads)

  newWs.onopen = () => {
    if (ws !== newWs) return; // stale socket from a previous pad; ignore
    reconnectAttempts = 0;
    $('#status').className = 'status online';
    $('#status').title = 'Connected';
    loadPadContent();
  };

  newWs.onmessage = (e) => {
    if (ws !== newWs) return; // stale socket from a previous pad; ignore
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      console.warn('Malformed WebSocket message:', e.data);
      return;
    }
    switch (msg.type) {
      case 'hello':
        wsId = msg.wsId;
        break;
      case 'text-update':
        if (msg.padId === currentPadId) {
          applyRemoteText(msg.text, msg.textVersion);
        }
        break;
      case 'file-added':
        upsertLocalFile(msg.file);
        if (msg.padId === currentPadId) {
          addFileToList(msg.file, true);
          updateFilesEmpty();
        }
        break;
      case 'file-deleted':
        removeLocalFile(msg.fileId);
        if (msg.padId === currentPadId) {
          removeFileFromList(msg.fileId);
        }
        break;
      case 'online-count':
        if (msg.padId === currentPadId) {
          $('#online-count').textContent = msg.count;
        }
        break;
      case 'pad-created':
      case 'pad-updated':
      case 'pad-deleted':
        refreshPads();
        break;
    }
  };

  newWs.onclose = (e) => {
    if (ws !== newWs) return; // stale close from a previous socket; ignore
    $('#status').className = 'status offline';
    $('#status').title = 'Disconnected - reconnecting...';
    $('#online-count').textContent = '0';
    wsId = null;
    // 4400 = invalid origin (CSRF rejection) — don't auto-reconnect
    if (e.code === 4400) {
      showToast('Connection rejected by server');
      return;
    }
    // 4403 = pad locked (password required) — don't auto-reconnect, prompt unlock
    if (e.code === 4403) {
      if (!$('#unlock-modal').hidden) return; // already showing
      showUnlockModal(currentPadId);
      return;
    }
    // 4401 = access denied (no access grant) — unlocking won't help; don't loop
    if (e.code === 4401) {
      showToast('No access to this pad');
      refreshPads();
      return;
    }
    // 4404 = pad not found (deleted or never existed) — don't loop
    if (e.code === 4404) {
      showToast('Pad not found');
      refreshPads();
      return;
    }
    // 1013 = server overloaded or IP limit — back off longer before retrying
    if (e.code === 1013) {
      showToast('Server busy, retrying in 30s...');
      reconnectAttempts = Math.max(reconnectAttempts, 5); // start at ~30s delay
    }
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectWS, delay);
  };

  newWs.onerror = () => newWs.close();
}

// --- Invitation System ---

async function generateInvitation() {
  try {
    const res = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUses: 5 }),
    });
    if (!res.ok) throw new Error('Failed to create invitation');
    const data = await res.json();
    showInviteTokenModal(data.token);
  } catch (e) {
    showToast(e.message);
  }
}

function showInviteTokenModal(token) {
  const modal = $('#invite-modal');
  if (!modal) return;
  const tokenBox = modal.querySelector('.invite-token-box');
  const tokenDisplay = modal.querySelector('.invite-token-display');
  if (tokenDisplay) tokenDisplay.textContent = token;
  if (tokenBox) tokenBox.hidden = false;
  modal.hidden = false;
}

function hideInviteModal() {
  const modal = $('#invite-modal');
  if (modal) modal.hidden = true;
}

function copyInviteToken() {
  const modal = $('#invite-modal');
  const token = modal?.querySelector('.invite-token-display')?.textContent;
  if (!token) return;
  if (!navigator.clipboard) {
    showToast('Copy not available in this browser context');
    return;
  }
  navigator.clipboard.writeText(token).then(
    () => showToast('Invite token copied!'),
    () => showToast('Copy failed')
  );
}

async function redeemInvite() {
  const input = $('#redeem-input');
  const error = $('#redeem-error');
  if (!input || !error) return;
  const token = input.value.trim();
  if (!token) { error.textContent = 'Please enter an invite token'; error.hidden = false; return; }

  try {
    const res = await fetch('/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Redeem failed');
    }
    const data = await res.json();
    hideInviteModal();
    showToast(`Access granted from ${data.grantorCode}`);
    await refreshPads();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
}

// --- Identity event bindings (CSP-safe, no inline onclick) ---

$('#copy-user-code-btn').addEventListener('click', copyUserCode);
$('#preview-close').addEventListener('click', closeMarkdownPreview);
$('#preview-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeMarkdownPreview();
});
$('#invite-btn').addEventListener('click', () => {
  const modal = $('#invite-modal');
  modal.hidden = !modal.hidden;
  $('#redeem-error').hidden = true;
});
$('#generate-invite-btn').addEventListener('click', generateInvitation);
$('#copy-invite-btn').addEventListener('click', copyInviteToken);
$('#close-invite-btn').addEventListener('click', hideInviteModal);
$('#redeem-invite-btn').addEventListener('click', redeemInvite);

// --- Text Sync ---

const textarea = $('#text-input');

function shouldDeferRemoteText() {
  return document.activeElement === textarea;
}

function applyTextState(text, version) {
  text = text || '';
  const ta = textarea;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = text;
  ta.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
  textVersion = Math.max(textVersion, version || 0);
  updateTextStats();
}

function queueRemoteText(text, version) {
  if (version <= textVersion) return;
  pendingRemoteState = { text, textVersion: version };
}

function applyPendingRemoteText() {
  if (!pendingRemoteState) return;
  // Discard stale remote text if our local version has already moved ahead
  if (pendingRemoteState.textVersion <= textVersion) {
    pendingRemoteState = null;
    return;
  }
  applyTextState(pendingRemoteState.text, pendingRemoteState.textVersion);
  pendingRemoteState = null;
}

function applyRemoteText(text, version) {
  if (version <= textVersion) return;
  if (shouldDeferRemoteText()) {
    queueRemoteText(text, version);
    return;
  }
  applyTextState(text, version);
}

let sendTimeout;
function sendText() {
  clearTimeout(sendTimeout);
  sendTimeout = setTimeout(sendTextNow, 300);
}

async function sendTextNow() {
  sendTimeout = null;
  const requestId = ++lastTextRequestId;
  const token = getPadToken(currentPadId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;
  try {
    const res = await fetch(`/api/pads/${currentPadId}/text`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ text: textarea.value, _wsId: wsId }),
    });
    if (!res.ok) throw new Error('Failed to sync text');
    const data = await res.json();
    if (requestId === lastTextRequestId) {
      textVersion = Math.max(textVersion, data.textVersion || 0);
    }
  } catch (e) {
    console.warn('Failed to sync text:', e);
  }
}

textarea.addEventListener('input', () => {
  sendText();
  updateTextStats();
});

textarea.addEventListener('blur', () => {
  applyPendingRemoteText();
});

// --- Text Stats & Export ---

function updateTextStats() {
  const stats = $('#text-stats');
  if (!stats) return;
  const text = textarea.value;
  const chars = text.length;
  const lines = text ? text.split('\n').length : 1;
  stats.textContent = `${chars} char${chars !== 1 ? 's' : ''} · ${lines} line${lines !== 1 ? 's' : ''}`;
}

$('#export-btn').addEventListener('click', () => {
  const text = textarea.value;
  if (!text.trim()) {
    showToast('Nothing to export');
    return;
  }
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `pad-${currentPadId}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Exported!');
});

// Initial stats
updateTextStats();

// --- File Upload ---

const fileInput = $('#file-input');
const dropOverlay = $('#drop-overlay');
let dragCounter = 0;

// Cross-browser check: DOMStringList may use includes() or contains()
function hasDraggedFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  if (typeof types.includes === 'function') return types.includes('Files');
  if (typeof types.contains === 'function') return types.contains('Files');
  return Array.from(types).includes('Files');
}

// Collect files from input or drop, then show confirm modal
fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length > 0) showUploadConfirm(files);
  e.target.value = '';
});

document.addEventListener('dragenter', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('visible');
});

document.addEventListener('dragleave', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  const files = Array.from(e.dataTransfer.files);
  if (files.length > 0) showUploadConfirm(files);
});

// Upload confirm modal
function showUploadConfirm(files) {
  const modal = $('#upload-confirm-modal');
  const list = $('#upload-confirm-list');
  list.innerHTML = '';

  for (const file of files) {
    const isLarge = file.size > MAX_FILE_SIZE;
    const canConvert = isConvertible(file.name) && file.size <= convertCapabilities.maxBytes;
    const item = document.createElement('div');
    item.className = 'upload-confirm-item';
    if (isLarge) item.style.opacity = '0.5';
    item.innerHTML = `
      <div class="file-icon">${fileIcon(file.name)}</div>
      <span class="upload-confirm-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      ${canConvert && !isLarge ? `<span class="upload-confirm-badge">→ Markdown</span>` : ''}
      ${isLarge ? '<span class="upload-confirm-badge warn">Too large</span>' : ''}
    `;
    list.appendChild(item);
  }

  modal.hidden = false;

  // 原格式上传：所有文件都不转换
  $('#upload-confirm-cancel').onclick = () => {
    modal.hidden = true;
    const queue = files.map((file) => ({ file, shouldConvert: false }));
    processUploadQueue(queue);
  };

  // 转 Markdown 上传：可转换的文件才转换
  $('#upload-confirm-ok').onclick = () => {
    modal.hidden = true;
    const queue = files.map((file) => ({
      file,
      shouldConvert: isConvertible(file.name) && file.size <= convertCapabilities.maxBytes,
    }));
    processUploadQueue(queue);
  };
}

async function processUploadQueue(queue) {
  const CONCURRENCY = 3;
  const progress = $('#upload-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  progress.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = `Uploading 0/${queue.length}...`;

  let completed = 0;
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const { file, shouldConvert } = queue[i];
      await uploadFile(file, shouldConvert, (filePercent) => {
        // Aggregate progress: completed files + current file's share
        const overall = Math.round(((completed + filePercent / 100) / queue.length) * 100);
        progressFill.style.width = `${overall}%`;
        progressText.textContent = `Uploading ${completed}/${queue.length}...`;
      });
      completed++;
      progressFill.style.width = `${Math.round((completed / queue.length) * 100)}%`;
      progressText.textContent = completed < queue.length
        ? `Uploading ${completed}/${queue.length}...`
        : `Uploaded ${queue.length} file${queue.length !== 1 ? 's' : ''}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  setTimeout(() => { progress.hidden = true; }, 500);
}

async function uploadFile(file, shouldConvert = false, onProgress) {
  if (file.size > MAX_FILE_SIZE) {
    showToast(`Skipped: ${file.name} (too large)`);
    return;
  }

  // Snapshot pad context at the moment of upload so switching pads mid-upload doesn't
  // route the file to the wrong pad.
  const padId = currentPadId;
  const padToken = getPadToken(padId);

  const formData = new FormData();
  formData.append('file', file, file.name);
  if (wsId) formData.append('_wsId', wsId);
  formData.append('padId', String(padId));

  try {
    const uploadedFile = await uploadWithProgress(formData, padToken, onProgress || (() => {}));
    upsertLocalFile(uploadedFile);
    addFileToList(uploadedFile, true);
    updateFilesEmpty();
    showToast(`Uploaded: ${file.name}`);

    // Auto-convert to Markdown if requested and file is convertible
    if (shouldConvert && isConvertible(uploadedFile.originalName) && uploadedFile.size <= convertCapabilities.maxBytes) {
      const convertBtn = document.querySelector(`#files-list [data-id="${uploadedFile.id}"] .convert`);
      if (convertBtn) {
        convertBtn.disabled = true;
        convertBtn.title = 'Converting...';
        convertBtn.classList.add('loading');
      }
      try {
        const convertHeaders = { 'Content-Type': 'application/json' };
        if (padToken) convertHeaders['X-Pad-Token'] = padToken;
        const res = await fetch(`/api/convert/${uploadedFile.id}`, {
          method: 'POST',
          headers: convertHeaders,
          body: JSON.stringify({ _wsId: wsId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Conversion failed');
        removeLocalFile(uploadedFile.id);
        upsertLocalFile(data);
        removeFileFromList(uploadedFile.id);
        addFileToList(data, true);
        updateFilesEmpty();
        showToast(`Converted: ${data.originalName}`);
        if (convertBtn) {
          convertBtn.classList.remove('loading');
          convertBtn.classList.add('success');
          convertBtn.title = 'Already converted';
        }
      } catch (e) {
        showToast(`Convert failed: ${e.message}`);
        if (convertBtn) {
          convertBtn.classList.remove('loading');
          convertBtn.disabled = false;
          convertBtn.title = 'Convert to Markdown';
        }
      }
    }
  } catch (e) {
    showToast(e.message);
  }
}

// --- File List ---

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fileIcon(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const icons = {
    pdf: '📄', doc: '📄', docx: '📄', txt: '📄', md: '📄',
    xls: '📊', xlsx: '📊', csv: '📊',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵', aac: '🎵',
    mp4: '🎬', webm: '🎬', mov: '🎬', avi: '🎬',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    js: '💻', ts: '💻', py: '💻', go: '💻', rs: '💻', java: '💻',
    json: '💻', xml: '💻', yaml: '💻', yml: '💻',
  };
  return icons[ext] || '📁';
}

const CONVERTIBLE_EXTS = new Set(convertCapabilities.extensions);

function isConvertible(name) {
  return CONVERTIBLE_EXTS.has((name || '').toLowerCase().split('.').pop());
}

function canConvert(file) {
  return isConvertible(file.name) && file.size <= convertCapabilities.maxBytes;
}

function createFileElement(file) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.dataset.id = file.id;
  el.dataset.createdAt = String(file.createdAt || Date.now());

  const sizeLabel = formatSize(file.size);
  const showConvert = isConvertible(file.originalName) && file.size <= convertCapabilities.maxBytes;
  const isMd = (file.originalName || '').toLowerCase().endsWith('.md');
  el.innerHTML = `
    <div class="file-icon">${fileIcon(file.originalName)}</div>
    <div class="file-info">
      <div class="file-name${isMd ? ' is-previewable' : ''}" title="${isMd ? 'Click to preview' : ''}">${escapeHtml(file.originalName)}</div>
      <div class="file-meta" data-size="${escapeHtml(sizeLabel)}">${sizeLabel} · ${timeAgo(file.createdAt)}</div>
    </div>
    <div class="file-actions">
      ${showConvert ? `<button class="file-action convert" title="Convert to Markdown">
        <svg class="icon-doc" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <svg class="icon-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        <svg class="icon-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </button>` : ''}
      <button class="file-action download" title="Download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="file-action delete" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;

  el.querySelector('.download').addEventListener('click', () => {
    const a = document.createElement('a');
    const padToken = getPadToken(file.padId || currentPadId);
    const url = padToken ? `/api/files/${file.id}?padToken=${encodeURIComponent(padToken)}` : `/api/files/${file.id}`;
    a.href = url;
    a.download = file.originalName;
    a.click();
  });

  const previewName = el.querySelector('.file-name.is-previewable');
  if (previewName) {
    previewName.addEventListener('click', () => openMarkdownPreview(file));
  }

  const convertBtn = el.querySelector('.convert');
  if (convertBtn) {
    convertBtn.addEventListener('click', async () => {
      convertBtn.disabled = true;
      convertBtn.title = 'Converting...';
      convertBtn.classList.add('loading');
      try {
        const token = getPadToken(file.padId || currentPadId);
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Pad-Token'] = token;
        const res = await fetch(`/api/convert/${file.id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ _wsId: wsId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Conversion failed');
        removeLocalFile(file.id);
        upsertLocalFile(data);
        removeFileFromList(file.id);
        addFileToList(data, true);
        updateFilesEmpty();
        showToast(`Converted: ${data.originalName}`);
        convertBtn.classList.remove('loading');
        convertBtn.classList.add('success');
        convertBtn.title = 'Already converted';
      } catch (e) {
        showToast(e.message);
        convertBtn.classList.remove('loading');
        convertBtn.disabled = false;
        convertBtn.title = 'Convert to Markdown';
      }
    });
  }

  el.querySelector('.delete').addEventListener('click', async () => {
    try {
      const token = getPadToken(file.padId || currentPadId);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Pad-Token'] = token;
      const res = await fetch(`/api/files/${file.id}`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ _wsId: wsId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      removeLocalFile(file.id);
      removeFileFromList(file.id);
    } catch (e) {
      showToast(e.message);
    }
  });

  return el;
}

function addFileToList(file, prepend = false) {
  const list = $('#files-list');
  const existing = list.querySelector(`[data-id="${CSS.escape(file.id)}"]`);
  if (existing) {
    // The old element may be mid-fade-out after a conversion; remove it so the
    // replacement can be inserted immediately.
    if (existing.style.opacity === '0') existing.remove();
    else return;
  }
  const el = createFileElement(file);
  if (prepend) list.prepend(el);
  else list.appendChild(el);
}

function removeFileFromList(fileId) {
  const el = $(`#files-list [data-id="${CSS.escape(fileId)}"]`);
  if (el) {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-20px)';
    setTimeout(() => {
      el.remove();
      updateFilesEmpty();
    }, 200);
    return;
  }
  updateFilesEmpty();
}

function renderFilesList(files) {
  const list = $('#files-list');
  list.innerHTML = '';
  files.forEach((file) => addFileToList(file));
  updateFilesEmpty();
}

function updateFilesEmpty() {
  const empty = $('#files-empty');
  const list = $('#files-list');
  empty.hidden = list.children.length > 0;
  // Show/hide search bar based on file count
  const searchBar = $('#file-search-bar');
  const totalFiles = list.children.length;
  searchBar.hidden = totalFiles < 4;
}

// --- File Search ---

$('#file-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  document.querySelectorAll('#files-list .file-item').forEach((el) => {
    const name = (el.querySelector('.file-name')?.textContent || '').toLowerCase();
    el.style.display = (!query || name.includes(query)) ? '' : 'none';
  });
});

// --- Utilities ---

function escapeHtml(text) {
  // textContent handles < > &, but we also need quotes for attribute safety
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Markdown Preview ---

async function openMarkdownPreview(file) {
  const modal = $('#preview-modal');
  const titleEl = $('#preview-title');
  const bodyEl = $('#preview-body');
  previewTargetId = file.id;
  titleEl.textContent = file.originalName;
  bodyEl.className = 'preview-body is-loading';
  bodyEl.textContent = 'Loading...';
  modal.hidden = false;

  try {
    const padToken = getPadToken(file.padId || currentPadId);
    const url = padToken
      ? `/api/files/${file.id}?padToken=${encodeURIComponent(padToken)}`
      : `/api/files/${file.id}`;
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const markdown = await res.text();
    // User opened a different file while this request was in flight; ignore.
    if (previewTargetId !== file.id) return;
    // Safe fallback: if either lib failed to load, render as escaped plain text
    // rather than risk injecting unsanitized marked output.
    let html;
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      html = `<pre>${escapeHtml(markdown)}</pre>`;
    } else {
      html = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
    }
    bodyEl.className = 'preview-body';
    bodyEl.innerHTML = html;
  } catch (e) {
    if (previewTargetId !== file.id) return;
    bodyEl.className = 'preview-body is-error';
    bodyEl.textContent = e.message || 'Failed to load preview';
  }
}

function closeMarkdownPreview() {
  const modal = $('#preview-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  $('#preview-body').innerHTML = '';
}

function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function uploadWithProgress(formData, padToken, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.timeout = 300000; // 5 minutes
    if (padToken) {
      xhr.setRequestHeader('X-Pad-Token', padToken);
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      const data = xhr.response && typeof xhr.response === 'object'
        ? xhr.response
        : safeJsonParse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error(data?.error || 'Upload failed'));
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload canceled'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new Error('Upload timed out'));
    });

    xhr.send(formData);
  });
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// --- Refresh time labels ---
let timeLabelInterval = null;

function startTimeLabelUpdater() {
  if (timeLabelInterval) return;
  const tick = () => {
    document.querySelectorAll('.file-item').forEach((el) => {
      const meta = el.querySelector('.file-meta');
      if (!meta) return;
      const createdAt = Number(el.dataset.createdAt);
      const size = meta.dataset.size || '';
      meta.textContent = `${size} · ${timeAgo(createdAt)}`;
    });
  };
  tick(); // immediate first run
  timeLabelInterval = setInterval(tick, 60000);
}

function stopTimeLabelUpdater() {
  clearInterval(timeLabelInterval);
  timeLabelInterval = null;
}

startTimeLabelUpdater();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopTimeLabelUpdater();
  } else {
    startTimeLabelUpdater();
    // Refresh data and check WS connection after returning from background
    refreshPads();
    if (ws && ws.readyState !== WebSocket.OPEN) {
      connectWS();
    }
  }
});

// --- QR Code ---

const titleEl = document.querySelector('.header-left');
const qrPopup = $('#qr-popup');
const qrImg = $('#qr-image');
let qrLoaded = false;

titleEl.addEventListener('mouseenter', () => {
  if (!qrLoaded) {
    qrImg.src = '/api/qrcode';
    qrLoaded = true;
  }
  qrPopup.hidden = false;
});

titleEl.addEventListener('mouseleave', () => {
  qrPopup.hidden = true;
});

// Mobile: tap to toggle QR popup (no hover on touch devices)
titleEl.addEventListener('click', (e) => {
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    e.stopPropagation();
    if (!qrLoaded) {
      qrImg.src = '/api/qrcode';
      qrLoaded = true;
    }
    qrPopup.hidden = !qrPopup.hidden;
  }
});

// Close QR popup when tapping outside
document.addEventListener('click', (e) => {
  if (!titleEl.contains(e.target) && !qrPopup.contains(e.target)) {
    qrPopup.hidden = true;
  }
});

// --- Keyboard shortcuts ---

document.addEventListener('keydown', (e) => {
  // Escape closes modals
  if (e.key === 'Escape') {
    $('#password-modal').hidden = true;
    $('#unlock-modal').hidden = true;
    $('#confirm-modal').hidden = true;
    const inviteModal = $('#invite-modal');
    if (inviteModal) inviteModal.hidden = true;
    const uploadModal = $('#upload-confirm-modal');
    if (uploadModal) uploadModal.hidden = true;
    closeMarkdownPreview();
  }
});

// Flush debounced text sync before the user leaves the page.
// navigator.sendBeacon reliably fires during unload; we expose a POST alias of
// the text route so the method mismatch no longer loses the final edit.
window.addEventListener('beforeunload', () => {
  if (sendTimeout) {
    clearTimeout(sendTimeout);
    sendTimeout = null;
    const token = getPadToken(currentPadId);
    const payload = JSON.stringify({ text: textarea.value, _wsId: wsId });
    const blob = new Blob([payload], { type: 'application/json' });
    const url = token
      ? `/api/pads/${currentPadId}/text?padToken=${encodeURIComponent(token)}`
      : `/api/pads/${currentPadId}/text`;
    navigator.sendBeacon(url, blob);
  }
});

// Load conversion capabilities from backend (single source of truth)
// Falls back to conservative defaults if the API is unavailable.
async function loadConvertCapabilities() {
  try {
    const res = await fetch('/api/convert/capabilities');
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.extensions)) {
      convertCapabilities.extensions = data.extensions;
      CONVERTIBLE_EXTS.clear();
      data.extensions.forEach(ext => CONVERTIBLE_EXTS.add(ext));
    }
    if (typeof data.maxBytes === 'number') convertCapabilities.maxBytes = data.maxBytes;
    if (typeof data.timeoutMs === 'number') convertCapabilities.timeoutMs = data.timeoutMs;
    if (data.features && typeof data.features === 'object') {
      convertCapabilities.features = data.features;
    }
  } catch {
    // API unavailable — keep conservative defaults
  }
}

// --- Init ---

async function init() {
  // These two are independent and can run in parallel
  await Promise.all([loadConvertCapabilities(), initIdentity()]);
  await refreshPads();
  await loadPadContent();
  connectWS();
}

init();
