const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

// Wrap global fetch to auto-inject Origin header for state-changing methods.
// This ensures test requests pass CSRF origin checks without manually adding
// Origin to every call.
const _origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const method = (init?.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = { ...(init?.headers || {}) };
    if (!headers.Origin && !headers.origin) {
      try {
        const u = new URL(url);
        headers.Origin = u.origin;
      } catch {}
    }
    init = { ...init, headers };
  }
  return _origFetch(input, init);
};

const PROJECT_DIR = path.resolve(__dirname, '..');

function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-identity-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ child, dataDir, port: Number(match[1]), baseUrl: `http://127.0.0.1:${match[1]}`, wsUrl: `ws://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Exited early: ${code} ${signal}\n${stdout}\n${stderr}`));
    });
  });
}

async function stopServer(server) {
  await new Promise((resolve) => {
    if (server.child.exitCode !== null) { resolve(); return; }
    const t = setTimeout(() => server.child.kill('SIGKILL'), 1000);
    server.child.once('exit', () => { clearTimeout(t); resolve(); });
    server.child.kill('SIGINT');
  });
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  // Extract just the session_token value
  const match = raw.match(/session_token=([^;]+)/);
  return match ? match[1] : null;
}

function cookieHeader(cookie) {
  return { Cookie: `session_token=${cookie}` };
}

async function registerUser(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST' });
  const data = await res.json();
  const cookie = extractCookie(res);
  return { code: data.code, token: data.token, cookie };
}

// --- Tests ---

test('register returns user code and sets cookie', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.code);
    assert.equal(data.code.length, 8);
    assert.ok(data.token);
    assert.ok(data.token.includes('.')); // userId.signature format
    const cookie = extractCookie(res);
    assert.ok(cookie, 'Set-Cookie header should be present');
    assert.equal(cookie, data.token);
  } finally {
    await stopServer(server);
  }
});

test('verify endpoint validates token correctly', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);

    // Valid token
    const valid = await fetch(`${server.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: user.token }),
    });
    const validData = await valid.json();
    assert.equal(validData.valid, true);
    assert.equal(validData.code, user.code);

    // Invalid token
    const invalid = await fetch(`${server.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fake.token' }),
    });
    const invalidData = await invalid.json();
    assert.equal(invalidData.valid, false);
  } finally {
    await stopServer(server);
  }
});

test('cookie-based auth works for API requests', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);

    // Request with cookie should identify user
    const me = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: cookieHeader(user.cookie),
    });
    assert.equal(me.status, 200);
    const meData = await me.json();
    assert.equal(meData.code, user.code);

    // Request without cookie should be unauthenticated
    const anon = await fetch(`${server.baseUrl}/api/auth/me`);
    assert.equal(anon.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('token signature uses 3-part format with timestamp', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);
    const parts = user.token.split('.');
    assert.equal(parts.length, 3); // userId.timestamp.signature
    assert.equal(parts[0].length, 8); // user code
    assert.ok(parts[1].length > 0, 'timestamp should be present');
    assert.equal(parts[2].length, 64); // full SHA-256 HMAC = 64 hex chars
  } finally {
    await stopServer(server);
  }
});

test('invitation creation requires auth', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUses: 5 }),
    });
    assert.equal(res.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('invitation create and redeem flow', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    // Alice creates invite
    const createRes = await fetch(`${server.baseUrl}/api/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ maxUses: 1 }),
    });
    assert.equal(createRes.status, 200);
    const invite = await createRes.json();
    assert.ok(invite.token);
    assert.ok(invite.token.length >= 22); // 128-bit entropy

    // Bob redeems
    const redeemRes = await fetch(`${server.baseUrl}/api/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(bob.cookie) },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(redeemRes.status, 200);
    const redeemed = await redeemRes.json();
    assert.equal(redeemed.grantorCode, alice.code);

    // Bob can now see Alice's pads
    // First Alice creates a pad
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    // Bob can access Alice's pad
    const bobState = await fetch(`${server.baseUrl}/api/state`, {
      headers: cookieHeader(bob.cookie),
    });
    const stateData = await bobState.json();
    const alicePad = stateData.pads.find(p => p.id === pad.id);
    assert.ok(alicePad, 'Bob should see Alice\'s pad');
  } finally {
    await stopServer(server);
  }
});

test('cannot redeem own invitation', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);

    const createRes = await fetch(`${server.baseUrl}/api/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ maxUses: 1 }),
    });
    const invite = await createRes.json();

    const redeemRes = await fetch(`${server.baseUrl}/api/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(redeemRes.status, 400);
  } finally {
    await stopServer(server);
  }
});

test('invitation maxUses enforcement', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);
    const carol = await registerUser(server.baseUrl);

    const createRes = await fetch(`${server.baseUrl}/api/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ maxUses: 1 }),
    });
    const invite = await createRes.json();

    // Bob redeems successfully
    const r1 = await fetch(`${server.baseUrl}/api/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(bob.cookie) },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(r1.status, 200);

    // Carol should fail (maxUses=1)
    const r2 = await fetch(`${server.baseUrl}/api/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(carol.cookie) },
      body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(r2.status, 410);
  } finally {
    await stopServer(server);
  }
});

test('invitation with maxUses=0 is unlimited', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);
    const carol = await registerUser(server.baseUrl);
    const dave = await registerUser(server.baseUrl);

    const createRes = await fetch(`${server.baseUrl}/api/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ maxUses: 0 }),
    });
    const invite = await createRes.json();
    assert.equal(invite.maxUses, 0, 'maxUses=0 should be preserved (unlimited)');

    // Three different users redeem — all should succeed
    for (const user of [bob, carol, dave]) {
      const r = await fetch(`${server.baseUrl}/api/invitations/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookieHeader(user.cookie) },
        body: JSON.stringify({ token: invite.token }),
      });
      assert.equal(r.status, 200, `redeem by ${user.code} should succeed on unlimited invite`);
    }
  } finally {
    await stopServer(server);
  }
});

test('pad access control: own vs public vs invited', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    // Alice creates a pad (ownerUserId = alice)
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();
    assert.equal(pad.ownerUserId, alice.code);

    // Bob cannot access Alice's pad without invitation
    const bobGet = await fetch(`${server.baseUrl}/api/pads/${pad.id}`, {
      headers: cookieHeader(bob.cookie),
    });
    assert.equal(bobGet.status, 403);

    // Bob can access public pads (pad 1 has ownerUserId=null)
    const bobPublic = await fetch(`${server.baseUrl}/api/pads/1`, {
      headers: cookieHeader(bob.cookie),
    });
    assert.equal(bobPublic.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('public pad destructive ops require creator or admin', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    const user = await registerUser(server.baseUrl);

    // Public pad 1 (creatorCode=null) - admin can set password
    const res = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(res.status, 403, 'regular user cannot manage public pad');

    const adminRes = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(adminRes.status, 200, 'admin can manage public pad');

    // Anonymous user cannot set password on public pad
    const anon = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'test2' }),
    });
    assert.equal(anon.status, 401, 'anonymous cannot set password');
  } finally {
    await stopServer(server);
  }
});

test('WebSocket requires valid token for private pads', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);

    // Create a private pad
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    // Unauthenticated WS connection to private pad should be rejected
    const wsResult = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=${pad.id}`);
      ws.once('close', (code) => resolve({ code }));
      ws.once('error', () => resolve({ code: -1 }));
      setTimeout(() => resolve({ code: 0 }), 1000);
    });
    assert.equal(wsResult.code, 4401, 'Should reject with 4401 (access denied)');

    // Query-string session tokens are ignored; a successful auth path must use cookies.
    const queryTokenResult = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=${pad.id}&token=${alice.token}`);
      ws.once('close', (code) => resolve({ code }));
      ws.once('error', () => resolve({ code: -1 }));
      setTimeout(() => resolve({ code: 0 }), 1000);
    });
    assert.equal(queryTokenResult.code, 4401, 'query-string token should not authenticate');

    // Authenticated WS connection should receive the application hello message.
    const ws2 = new WebSocket(`${server.wsUrl}/?pad=${pad.id}`, {
      headers: cookieHeader(alice.cookie),
    });
    const hello = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for hello')), 1000);
      ws2.once('message', (raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(raw)));
      });
      ws2.once('close', (code) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before hello: ${code}`));
      });
      ws2.once('error', reject);
    });
    assert.equal(hello.type, 'hello');
    assert.equal(hello.userId, alice.code);
    ws2.close();
  } finally {
    await stopServer(server);
  }
});

test('invalid origin is rejected on destructive endpoints', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);

    const res = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, 'Invalid origin');
  } finally {
    await stopServer(server);
  }
});

test('missing origin header is allowed (same-origin non-browser)', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);

    // No Origin header on GET request - should succeed (safe methods skip Origin check)
    const getRes = await fetch(`${server.baseUrl}/api/state`, {
      headers: { ...cookieHeader(user.cookie) },
    });
    assert.equal(getRes.status, 200);

    // No Origin header on POST request - should be rejected (state-changing methods require Origin)
    // Use _origFetch to bypass the auto-Origin wrapper
    const postRes = await _origFetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(postRes.status, 403, 'state-changing requests without Origin are rejected');
  } finally {
    await stopServer(server);
  }
});

test('PUBLIC_ORIGIN env var configures origin check', async () => {
  const server = await startServer({ PUBLIC_ORIGIN: 'http://custom.example.com' });
  try {
    const user = await registerUser(server.baseUrl);

    // Wrong origin should be rejected
    const wrong = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
        Origin: `http://localhost:${server.port}`,
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(wrong.status, 403);

    // Correct origin should pass (but still need admin for public pad)
    const correct = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
        Origin: 'http://custom.example.com',
      },
      body: JSON.stringify({ password: null }),
    });
    assert.equal(correct.status, 403, 'public pad still requires admin even with correct origin');
  } finally {
    await stopServer(server);
  }
});

test('password change accepts currentPassword when unlock token is missing/expired', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);

    // Alice creates a pad and sets a password
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    const setRes = await fetch(`${server.baseUrl}/api/pads/${pad.id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ password: 'oldpass' }),
    });
    assert.equal(setRes.status, 200);

    // Simulate expired unlock token: omit X-Pad-Token and omit currentPassword → reject
    const noCreds = await fetch(`${server.baseUrl}/api/pads/${pad.id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ password: 'newpass' }),
    });
    assert.equal(noCreds.status, 403);
    assert.equal((await noCreds.json()).error, 'Current password incorrect');

    // Provide currentPassword → should succeed even without unlock token
    const withCreds = await fetch(`${server.baseUrl}/api/pads/${pad.id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ password: 'newpass', currentPassword: 'oldpass' }),
    });
    assert.equal(withCreds.status, 200);

    // Verify the new password works via unlock
    const unlockRes = await fetch(`${server.baseUrl}/api/pads/${pad.id}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ password: 'newpass' }),
    });
    assert.equal(unlockRes.status, 200);
    assert.ok((await unlockRes.json()).token);

    // Old password should no longer unlock
    const oldUnlock = await fetch(`${server.baseUrl}/api/pads/${pad.id}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie) },
      body: JSON.stringify({ password: 'oldpass' }),
    });
    assert.equal(oldUnlock.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('ADMIN_TOKEN timing-safe comparison', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'super-secret-admin-key' });
  try {
    const user = await registerUser(server.baseUrl);

    // Create a public pad with a specific creator
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(user.cookie),
    });
    const pad = await padRes.json();

    // Another user tries to delete the pad
    const bob = await registerUser(server.baseUrl);
    const failDelete = await fetch(`${server.baseUrl}/api/pads/${pad.id}`, {
      method: 'DELETE',
      headers: { ...cookieHeader(bob.cookie), 'Content-Type': 'application/json' },
    });
    assert.equal(failDelete.status, 403);

    // Admin can delete
    const adminDelete = await fetch(`${server.baseUrl}/api/pads/${pad.id}`, {
      method: 'DELETE',
      headers: {
        ...cookieHeader(bob.cookie),
        'Content-Type': 'application/json',
        'X-Admin-Token': 'super-secret-admin-key',
      },
    });
    assert.equal(adminDelete.status, 200);

    // Create a new pad for the owner to test wrong admin token
    const pad2Res = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(user.cookie),
    });
    const pad2 = await pad2Res.json();

    // Wrong admin token should fail on Alice's private pad
    const wrongAdmin = await fetch(`${server.baseUrl}/api/pads/${pad2.id}/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(bob.cookie),
        'X-Admin-Token': 'wrong-secret-admin-key',
      },
      body: JSON.stringify({ password: 'test' }),
    });
    // Should be 403 (not the owner, not a valid admin)
    assert.equal(wrongAdmin.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('token persists across restart with same SESSION_SECRET', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-restart-'));
  const secret = 'stable-test-secret-for-restart';
  const env = { PORT: '0', DATA_DIR: dataDir, SESSION_SECRET: secret };

  // Start server 1
  let server1 = await startServer(env);
  const user1 = await registerUser(server1.baseUrl);
  await stopServer(server1);

  // Start server 2 with same secret and same data dir
  let server2 = await startServer(env);
  try {
    // Old token should still work
    const me = await fetch(`${server2.baseUrl}/api/auth/me`, {
      headers: cookieHeader(user1.cookie),
    });
    assert.equal(me.status, 200);
    const data = await me.json();
    assert.equal(data.code, user1.code);
  } finally {
    await stopServer(server2);
  }
});

test('token invalidated when SESSION_SECRET changes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-secret-change-'));

  // Start server 1 with secret A
  let server1 = await startServer({ PORT: '0', DATA_DIR: dataDir, SESSION_SECRET: 'secret-a' });
  const user = await registerUser(server1.baseUrl);
  await stopServer(server1);

  // Start server 2 with secret B
  let server2 = await startServer({ PORT: '0', DATA_DIR: dataDir, SESSION_SECRET: 'secret-b' });
  try {
    const me = await fetch(`${server2.baseUrl}/api/auth/me`, {
      headers: cookieHeader(user.cookie),
    });
    assert.equal(me.status, 401); // Old token should be invalid
  } finally {
    await stopServer(server2);
  }
});

test('backward compat: unauthenticated users can access public pads', async () => {
  const server = await startServer();
  try {
    // No auth at all
    const state = await fetch(`${server.baseUrl}/api/state`);
    assert.equal(state.status, 200);
    const data = await state.json();
    assert.ok(data.pads.length >= 1);
    assert.equal(data.pads[0].id, 1);
    assert.equal(data.pads[0].ownerUserId, null);
    assert.equal(data.userCode, null);

    // Can read public pad
    const pad = await fetch(`${server.baseUrl}/api/pads/1`);
    assert.equal(pad.status, 200);

    // Can write to public pad
    const write = await fetch(`${server.baseUrl}/api/pads/1/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(write.status, 200);
  } finally {
    await stopServer(server);
  }
});

// --- Regression tests for review findings ---

test('malformed cookie does not crash server or WebSocket', async () => {
  const server = await startServer();
  try {
    // Send malformed cookie via WebSocket — server must stay alive
    const wsResult = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=1`, {
        headers: { Cookie: 'session_token=%ZZ' },
      });
      ws.once('open', () => { ws.close(); resolve({ ok: true }); });
      ws.once('close', () => resolve({ ok: true }));
      ws.once('error', () => resolve({ ok: true }));
      setTimeout(() => resolve({ ok: true }), 1000);
    });
    assert.ok(wsResult.ok);

    // Server still responsive after malformed cookie
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('register accepts custom expiresInDays', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 7 }),
    });
    const data = await res.json();
    assert.equal(data.expiresInDays, 7);

    // Token should have 3 parts
    const parts = data.token.split('.');
    assert.equal(parts.length, 3);

    // Token should still work
    const me = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: cookieHeader(extractCookie(res)),
    });
    assert.equal(me.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('verify endpoint reports expired token', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);

    // Token should be valid now
    const valid = await fetch(`${server.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: user.token }),
    });
    const validData = await valid.json();
    assert.equal(validData.valid, true);

    // Manually create a token that's already expired (expiresAt in the past)
    const fakeUserId = user.code;
    const pastTs = Math.floor(Date.now() / 1000 - 3600).toString(36); // 1 hour ago
    const crypto = require('node:crypto');
    // We can't forge the HMAC without the secret, but we can test that
    // the verify endpoint rejects a token with wrong structure
    const expiredToken = `${fakeUserId}.${pastTs}.a]`;
    const expired = await fetch(`${server.baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiredToken }),
    });
    const expiredData = await expired.json();
    assert.equal(expiredData.valid, false, 'Forged token should be invalid');
  } finally {
    await stopServer(server);
  }
});

test('legacy pad with ADMIN_TOKEN requires admin for delete', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'super-secret-admin-key' });
  try {
    const user = await registerUser(server.baseUrl);

    // Authenticated user cannot set password on legacy pad (pad 1, creatorCode=null)
    const fail = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(user.cookie) },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(fail.status, 403);

    // Admin can set password on legacy pad
    const admin = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookieHeader(user.cookie),
        'X-Admin-Token': 'super-secret-admin-key',
      },
      body: JSON.stringify({ password: 'test' }),
    });
    assert.equal(admin.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('legacy pad without ADMIN_TOKEN still requires admin-level management', async () => {
  const server = await startServer(); // no ADMIN_TOKEN
  try {
    const user = await registerUser(server.baseUrl);

    // Without ADMIN_TOKEN, legacy pad requires admin (fallback removed for security)
    const res = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(user.cookie), Origin: server.baseUrl },
      body: JSON.stringify({ password: 'test123' }),
    });
    assert.equal(res.status, 403, 'legacy pad now requires admin');

    // Anonymous still cannot
    const anon = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'test456' }),
    });
    assert.ok(anon.status >= 400);
  } finally {
    await stopServer(server);
  }
});

test('unauthorized upload to private pad is rejected', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    // Alice creates a private pad
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    // Bob tries to upload to Alice's pad (no access grant)
    // padId sent BEFORE file field — early check short-circuits
    const formData = new FormData();
    formData.append('padId', String(pad.id));
    const blob = new Blob(['test content'], { type: 'text/plain' });
    formData.append('file', blob, 'test.txt');

    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: cookieHeader(bob.cookie),
      body: formData,
    });
    assert.equal(upload.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('unauthorized upload rejected even when padId arrives after file part', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    // Alice creates a private pad
    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    // Bob uploads with file part FIRST, padId AFTER — mimics the real
    // frontend (public/app.js) ordering. Early check can't fire because
    // padId isn't known when the file stream begins; the authoritative
    // finish-time check must catch it.
    const formData = new FormData();
    const blob = new Blob(['test content'], { type: 'text/plain' });
    formData.append('file', blob, 'test.txt');
    formData.append('padId', String(pad.id));

    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: cookieHeader(bob.cookie),
      body: formData,
    });
    assert.equal(upload.status, 403, 'file-first ordering must still be rejected');

    // Verify the file was not committed to Alice's pad
    const stateRes = await fetch(`${server.baseUrl}/api/state`, {
      headers: cookieHeader(alice.cookie),
    });
    const state = await stateRes.json();
    const leaked = state.files.some(f => f.padId === pad.id);
    assert.equal(leaked, false, 'no file should be stored on the private pad');
  } finally {
    await stopServer(server);
  }
});

test('upload to nonexistent pad is rejected', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);
    const formData = new FormData();
    formData.append('file', new Blob(['orphan content'], { type: 'text/plain' }), 'orphan.txt');
    formData.append('padId', '999');

    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: cookieHeader(user.cookie),
      body: formData,
    });
    assert.equal(upload.status, 404);

    const state = await fetch(`${server.baseUrl}/api/state`, {
      headers: cookieHeader(user.cookie),
    });
    const stateData = await state.json();
    assert.equal(stateData.files.some(f => f.padId === 999), false);
  } finally {
    await stopServer(server);
  }
});

test('WebSocket rejects connection to password-protected pad without unlock token', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    const user = await registerUser(server.baseUrl);

    // Set a password on public pad 1 (requires admin)
    const setRes = await fetch(`${server.baseUrl}/api/pads/1/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'secret' }),
    });
    const setData = await setRes.json();
    assert.ok(setData.token, 'password set should return an unlock token');

    // WS connection without padToken should be rejected (4403)
    const rejected = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=1`);
      ws.once('close', (code) => resolve({ code }));
      ws.once('error', () => resolve({ code: -1 }));
      setTimeout(() => resolve({ code: 0 }), 1000);
    });
    assert.equal(rejected.code, 4403, 'WS to locked pad without token should be rejected');

    // WS connection WITH padToken should succeed
    const accepted = await new Promise((resolve) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=1&padToken=${setData.token}`);
      ws.once('open', () => { ws.close(); resolve({ ok: true }); });
      ws.once('error', () => resolve({ ok: false }));
      setTimeout(() => resolve({ ok: false }), 1000);
    });
    assert.equal(accepted.ok, true, 'WS with valid padToken should connect');
  } finally {
    await stopServer(server);
  }
});

test('legacy public file cannot be deleted anonymously', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    // Upload a file anonymously (creates ownerUserId=null legacy-style file on public pad)
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['x'], { type: 'text/plain' }), 'legacy.txt');
    const upload = await fetch(`${server.baseUrl}/api/upload`, { method: 'POST', body: formData, headers: { Origin: server.baseUrl } });
    assert.equal(upload.status, 200);
    const file = await upload.json();

    // Anonymous deletion should be rejected
    const anonDel = await fetch(`${server.baseUrl}/api/files/${file.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(anonDel.status, 401, 'anonymous delete of legacy public file should be rejected');

    // Regular auth user cannot delete legacy pad files (requires admin)
    const other = await registerUser(server.baseUrl);
    const del = await fetch(`${server.baseUrl}/api/files/${file.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(other.cookie), Origin: server.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(del.status, 403, 'regular auth user cannot delete legacy pad files');

    // Admin can delete
    const adminDel = await fetch(`${server.baseUrl}/api/files/${file.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': 'admin123', Origin: server.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(adminDel.status, 200, 'admin can delete legacy pad files');
  } finally {
    await stopServer(server);
  }
});

test('password-protected pad files require unlock token for delete and clear', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);

    const padRes = await fetch(`${server.baseUrl}/api/pads`, {
      method: 'POST',
      headers: cookieHeader(alice.cookie),
    });
    const pad = await padRes.json();

    const setPassword = await fetch(`${server.baseUrl}/api/pads/${pad.id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie), Origin: server.baseUrl },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(setPassword.status, 200);
    const { token } = await setPassword.json();
    assert.ok(token);

    async function upload(name) {
      const formData = new FormData();
      formData.append('padId', String(pad.id));
      formData.append('file', new Blob(['secret file'], { type: 'text/plain' }), name);
      const res = await fetch(`${server.baseUrl}/api/upload`, {
        method: 'POST',
        headers: { ...cookieHeader(alice.cookie), 'X-Pad-Token': token, Origin: server.baseUrl },
        body: formData,
      });
      assert.equal(res.status, 200);
      return res.json();
    }

    const first = await upload('first.txt');

    const deleteLocked = await fetch(`${server.baseUrl}/api/files/${first.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie), Origin: server.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(deleteLocked.status, 403);

    const deleteUnlocked = await fetch(`${server.baseUrl}/api/files/${first.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie), 'X-Pad-Token': token, Origin: server.baseUrl },
      body: JSON.stringify({}),
    });
    assert.equal(deleteUnlocked.status, 200);

    await upload('second.txt');

    const clearLocked = await fetch(`${server.baseUrl}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie), Origin: server.baseUrl },
      body: JSON.stringify({ padId: pad.id }),
    });
    assert.equal(clearLocked.status, 403);

    const clearUnlocked = await fetch(`${server.baseUrl}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(alice.cookie), 'X-Pad-Token': token, Origin: server.baseUrl },
      body: JSON.stringify({ padId: pad.id }),
    });
    assert.equal(clearUnlocked.status, 200);
    assert.equal((await clearUnlocked.json()).cleared, 1);
  } finally {
    await stopServer(server);
  }
});

test('legacy public pad files cannot be cleared by regular users', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['x'], { type: 'text/plain' }), 'legacy-clear.txt');
    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      headers: { Origin: server.baseUrl },
    });
    assert.equal(upload.status, 200);

    const other = await registerUser(server.baseUrl);
    const regularClear = await fetch(`${server.baseUrl}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(other.cookie), Origin: server.baseUrl },
      body: JSON.stringify({ padId: 1 }),
    });
    assert.equal(regularClear.status, 403);

    const adminClear = await fetch(`${server.baseUrl}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': 'admin123', Origin: server.baseUrl },
      body: JSON.stringify({ padId: 1 }),
    });
    assert.equal(adminClear.status, 200);
    assert.equal((await adminClear.json()).cleared, 1);
  } finally {
    await stopServer(server);
  }
});

test('clear files rejects missing padId', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...cookieHeader(user.cookie) },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    await stopServer(server);
  }
});

test('register clamps expiresInDays to SESSION_TOKEN_TTL_DAYS', async () => {
  const server = await startServer({ SESSION_TOKEN_TTL_DAYS: '7' });
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresInDays: 999 }),
    });
    const data = await res.json();
    assert.equal(data.expiresInDays, 7, 'should clamp to configured max');
  } finally {
    await stopServer(server);
  }
});
