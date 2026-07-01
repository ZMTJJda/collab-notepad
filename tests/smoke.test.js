const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const PROJECT_DIR = path.resolve(__dirname, '..');

function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comark-notepad-'));

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
      reject(new Error(`Timed out starting server.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (!match || settled) return;

      settled = true;
      clearTimeout(timeout);
      resolve({
        child,
        dataDir,
        port: Number(match[1]),
        baseUrl: `http://127.0.0.1:${match[1]}`,
        wsUrl: `ws://127.0.0.1:${match[1]}`,
      });
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code} signal ${signal}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function stopServer(server) {
  const { child, dataDir } = server;

  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGINT');
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function fetchJson(baseUrl, pathname, init) {
  // Auto-inject Origin header for state-changing methods if not already set
  if (init && init.method && init.method !== 'GET' && init.method !== 'HEAD') {
    const headers = init.headers || {};
    if (!headers.Origin && !headers.origin) {
      init.headers = { ...headers, Origin: baseUrl };
    }
  }
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json();
  return { response, body };
}

function createClient(wsUrl, padId = 1) {
  const url = padId ? `${wsUrl}/?pad=${padId}` : wsUrl;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];

    socket.on('message', (raw) => {
      messages.push(JSON.parse(String(raw)));
    });

    socket.once('open', () => {
      resolve({
        socket,
        messages,
        wsId: null,
        padId,
        drain() {
          messages.length = 0;
        },
      });
    });

    socket.once('error', reject);
  });
}

async function waitForMessage(client, predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = client.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = client.messages.splice(index, 1);
      if (message.type === 'hello') client.wsId = message.wsId;
      return message;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for message');
}

async function expectNoMessage(client, predicate, timeout = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (client.messages.some(predicate)) {
      throw new Error('Received unexpected message');
    }
    await delay(10);
  }
}

async function closeClient(client) {
  await new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    client.socket.once('close', resolve);
    client.socket.close();
  });
}

async function createReadyClient(wsUrl, padId = 1) {
  const client = await createClient(wsUrl, padId);
  await waitForMessage(client, (msg) => msg.type === 'hello');
  return client;
}

test('state endpoint returns default shape with one pad', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/state');
    assert.equal(response.status, 200);
    assert.equal(body.pads.length, 1);
    assert.equal(body.pads[0].id, 1);
    assert.equal(body.pads[0].hasPassword, false);
    assert.deepEqual(body.files, []);
  } finally {
    await stopServer(server);
  }
});

test('health endpoint returns status', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.pads, 1);
  } finally {
    await stopServer(server);
  }
});

test('online count is per-pad', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    await waitForMessage(a, (msg) => msg.type === 'online-count' && msg.count === 1);

    const b = await createReadyClient(server.wsUrl, 1);
    await waitForMessage(a, (msg) => msg.type === 'online-count' && msg.count === 2);
    await waitForMessage(b, (msg) => msg.type === 'online-count' && msg.count === 2);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads)
    await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });

    // Client on pad 2 should NOT affect pad 1's count
    const c = await createReadyClient(server.wsUrl, 2);
    await waitForMessage(c, (msg) => msg.type === 'online-count' && msg.count === 1);
    await expectNoMessage(a, (msg) => msg.type === 'online-count' && msg.count === 3);

    await closeClient(b);
    await closeClient(c);
    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('text updates are scoped to the same pad', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    const b = await createReadyClient(server.wsUrl, 1);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads)
    await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });
    const c = await createReadyClient(server.wsUrl, 2);

    a.drain();
    b.drain();
    c.drain();

    const { response, body } = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'pad 1 test', _wsId: a.wsId }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.textVersion, 1);

    // Client b (same pad) should receive the update
    const update = await waitForMessage(b, (msg) => msg.type === 'text-update');
    assert.equal(update.text, 'pad 1 test');
    assert.equal(update.padId, 1);

    // Client a (sender) should NOT receive it
    await expectNoMessage(a, (msg) => msg.type === 'text-update');

    // Client c (different pad) should NOT receive it
    await expectNoMessage(c, (msg) => msg.type === 'text-update');

    await closeClient(a);
    await closeClient(b);
    await closeClient(c);
  } finally {
    await stopServer(server);
  }
});

test('create new pad and switch to it', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    assert.equal(body.id, 2);
    assert.equal(body.text, '');

    const state = await fetchJson(server.baseUrl, '/api/state');
    assert.equal(state.body.pads.length, 2);
    assert.equal(state.body.pads[1].id, 2);
  } finally {
    await stopServer(server);
  }
});

test('pad password protection', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    // Admin sets password on pad 1
    const setPassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(setPassword.response.status, 200);
    assert.equal(setPassword.body.hasPassword, true);
    assert.ok(setPassword.body.token);

    const token = setPassword.body.token;

    // GET pad without token should fail
    const locked = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(locked.response.status, 403);
    assert.equal(locked.body.hasPassword, true);

    // GET pad with token should succeed
    const unlocked = await fetchJson(server.baseUrl, '/api/pads/1', {
      headers: { 'X-Pad-Token': token },
    });
    assert.equal(unlocked.response.status, 200);

    // Wrong password unlock should fail
    const wrongUnlock = await fetchJson(server.baseUrl, '/api/pads/1/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(wrongUnlock.response.status, 403);

    // Correct password unlock should succeed
    const correctUnlock = await fetchJson(server.baseUrl, '/api/pads/1/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(correctUnlock.response.status, 200);
    assert.ok(correctUnlock.body.token);

    // Remove password (admin with unlock token)
    const removePassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        'X-Pad-Token': correctUnlock.body.token,
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: null }),
    });
    assert.equal(removePassword.response.status, 200);
    assert.equal(removePassword.body.hasPassword, false);

    // Now GET without token should work
    const openPad = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(openPad.response.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('file updates broadcast to same pad only', async () => {
  const server = await startServer();
  try {
    // Register a user so uploaded files have an owner (deletion requires auth)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const a = await createReadyClient(server.wsUrl, 1);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads).
    // Keep pad 2 public (no cookie) so the anonymous client b can join it.
    const pad2 = await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });
    assert.equal(pad2.response.status, 200);
    assert.equal(pad2.body.id, 2);
    const b = await createReadyClient(server.wsUrl, 2);

    a.drain();
    b.drain();

    const formData = new FormData();
    formData.append('_wsId', a.wsId);
    formData.append('padId', '1');
    formData.append('file', new Blob(['sample upload\n'], { type: 'text/plain' }), 'sample.txt');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });

    assert.equal(upload.response.status, 200);
    assert.equal(upload.body.originalName, 'sample.txt');

    // Client b (different pad) should NOT receive file-added (files are now pad-scoped)
    await expectNoMessage(b, (msg) => msg.type === 'file-added');
    // Client a (sender) should NOT receive it either (sender excluded)
    await expectNoMessage(a, (msg) => msg.type === 'file-added');

    // Client on same pad should receive it
    const a2 = await createReadyClient(server.wsUrl, 1);
    a2.drain();

    const formData2 = new FormData();
    formData2.append('_wsId', a.wsId);
    formData2.append('padId', '1');
    formData2.append('file', new Blob(['second file\n'], { type: 'text/plain' }), 'second.txt');
    const upload2 = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData2,
    });
    assert.equal(upload2.response.status, 200);

    // Client a2 (same pad, not sender) should receive file-added
    const fileAddedA2 = await waitForMessage(a2, (msg) => msg.type === 'file-added');
    assert.equal(fileAddedA2.file.id, upload2.body.id);

    // Delete the file
    const deleteResult = await fetchJson(server.baseUrl, `/api/files/${upload.body.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ _wsId: a.wsId }),
    });
    assert.equal(deleteResult.response.status, 200);

    // Client a2 (same pad) should receive file-deleted
    const fileDeletedA2 = await waitForMessage(a2, (msg) => msg.type === 'file-deleted');
    assert.equal(fileDeletedA2.fileId, upload.body.id);
    // Client b (different pad) should NOT receive delete broadcast
    await expectNoMessage(b, (msg) => msg.type === 'file-deleted');

    await closeClient(a);
    await closeClient(b);
    await closeClient(a2);
  } finally {
    await stopServer(server);
  }
});

test('clear all files', async () => {
  const server = await startServer();
  try {
    // Register a user and create a pad they are allowed to manage.
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');
    const padRes = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(padRes.response.status, 200);
    const padId = padRes.body.id;

    for (const name of ['a.txt', 'b.txt']) {
      const formData = new FormData();
      formData.append('padId', String(padId));
      formData.append('file', new Blob(['content\n'], { type: 'text/plain' }), name);
      await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData, headers: { Cookie: cookie } });
    }

    const beforeState = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: cookie } });
    assert.equal(beforeState.body.files.length, 2);

    const clearResult = await fetchJson(server.baseUrl, '/api/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ padId }),
    });
    assert.equal(clearResult.response.status, 200);
    assert.equal(clearResult.body.cleared, 2);

    const afterState = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: cookie } });
    assert.equal(afterState.body.files.length, 0);

    const filesDir = path.join(server.dataDir, 'files');
    assert.deepEqual(fs.readdirSync(filesDir), []);
  } finally {
    await stopServer(server);
  }
});

test('upload preserves chinese filenames', async () => {
  const server = await startServer();
  try {
    const formData = new FormData();
    formData.append('file', new Blob(['hello\n'], { type: 'text/plain' }), '测试文档.txt');

    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      body: formData,
    });

    assert.equal(upload.response.status, 200);
    assert.equal(upload.body.originalName, '测试文档.txt');

    const download = await fetch(`${server.baseUrl}/api/files/${upload.body.id}`);
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get('content-disposition') || '',
      /filename\*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3\.txt/
    );
  } finally {
    await stopServer(server);
  }
});

test('convert file to markdown', async () => {
  const server = await startServer();
  try {
    // Register user
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    // Upload a CSV file
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['name,age\nAlice,30\n'], { type: 'text/csv' }), 'data.csv');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    // Convert to markdown
    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 200);
    assert.equal(convert.body.mimeType, 'text/markdown');
    assert.match(convert.body.originalName, /\.md$/);

    // Verify .md file exists on disk
    const filesDir = path.join(server.dataDir, 'files');
    const mdFiles = fs.readdirSync(filesDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 1, 'Expected at least one .md file on disk');

    // Duplicate convert (original file was deleted after first conversion) → 404
    const dup = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(dup.response.status, 404);

    // Nonexistent fileId → 404
    const missing = await fetchJson(server.baseUrl, '/api/convert/nonexistent123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(missing.response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test('convert requires file access', async () => {
  const server = await startServer();
  try {
    // Register and upload a file with an owner (so it's not public)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['secret,data\n'], { type: 'text/csv' }), 'secret.csv');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    // Unauthenticated request (no cookie) → 403
    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('convert rejects .md source files', async () => {
  const server = await startServer();
  try {
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['# Hello\n'], { type: 'text/markdown' }), 'already.md');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 400);
    assert.match(convert.body.error, /Markdown/i);
  } finally {
    await stopServer(server);
  }
});

test('old single-pad store migrates to multi-pad', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comark-notepad-migrate-'));
  const storeFile = path.join(dataDir, 'store.json');
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  fs.writeFileSync(storeFile, JSON.stringify({
    text: 'old content',
    textVersion: 5,
    files: [],
  }));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const { baseUrl } = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Server start timeout'));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve({ baseUrl: `http://127.0.0.1:${match[1]}` });
        }
      });
    });

    const state = await fetchJson(baseUrl, '/api/state');
    assert.equal(state.body.pads.length, 1);
    assert.equal(state.body.pads[0].id, 1);

    const pad = await fetchJson(baseUrl, '/api/pads/1');
    assert.equal(pad.body.text, 'old content');
    assert.equal(pad.body.textVersion, 5);
  } finally {
    child.kill('SIGINT');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 3000); // fallback if process doesn't exit
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invitation lifecycle', async () => {
  const server = await startServer();
  try {
    // Register two users
    const regA = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieA = regA.headers.get('set-cookie');
    const userA = await regA.json();

    const regB = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieB = regB.headers.get('set-cookie');
    const userB = await regB.json();

    // User A creates an invitation
    const create = await fetchJson(server.baseUrl, '/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ maxUses: 2, expiresInHours: 1 }),
    });
    assert.equal(create.response.status, 200);
    assert.ok(create.body.token);
    assert.equal(create.body.maxUses, 2);

    // User B redeems it
    const redeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(redeem.response.status, 200);
    assert.equal(redeem.body.grantorCode, userA.code);

    // Duplicate redeem → 409
    const dupRedeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(dupRedeem.response.status, 409);

    // Self-redeem → 400
    const selfRedeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(selfRedeem.response.status, 400);

    // List invitations
    const list = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieA },
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.created.length, 1);
    assert.equal(list.body.created[0].token, create.body.token);

    // User B lists received grants
    const listB = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listB.response.status, 200);
    assert.equal(listB.body.received.length, 1);
    assert.equal(listB.body.received[0].grantorCode, userA.code);

    // Delete invitation
    const del = await fetchJson(server.baseUrl, `/api/invitations/${create.body.token}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(del.response.status, 200);

    // Redeem after delete → 404
    const postDel = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(postDel.response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test('requireOrigin rejects cross-origin write requests', async () => {
  const server = await startServer();
  try {
    // Authenticated user
    const reg = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = reg.headers.get('set-cookie');

    // PUT text with disallowed Origin
    const put = await fetch(`${server.baseUrl}/api/pads/1/text`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'bad' }),
    });
    assert.equal(put.status, 403);
    const putBody = await put.json();
    assert.equal(putBody.error, 'Invalid origin');

    // POST upload with disallowed Origin
    const formData = new FormData();
    formData.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.status, 403);
    const upBody = await upload.json();
    assert.equal(upBody.error, 'Invalid origin');

    // Same-origin (with matching Origin header) still works
    const ok = await fetch(`${server.baseUrl}/api/pads/1/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: server.baseUrl },
      body: JSON.stringify({ text: 'good' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('pad routes reject invalid pad IDs', async () => {
  const server = await startServer();
  try {
    const cases = [
      { path: '/api/pads/abc', method: 'GET', expected: 400 },
      { path: '/api/pads/0', method: 'GET', expected: 400 },
      { path: '/api/pads/-1', method: 'GET', expected: 400 },
      { path: '/api/pads/1.5', method: 'GET', expected: 400 },
      { path: '/api/pads/abc/text', method: 'PUT', expected: 400 },
      { path: '/api/pads/0/text', method: 'PUT', expected: 400 },
      { path: '/api/pads/abc/password', method: 'POST', expected: 400 },
      { path: '/api/pads/abc/unlock', method: 'POST', expected: 400 },
      { path: '/api/pads/abc', method: 'DELETE', expected: 400 },
    ];

    for (const { path, method, expected } of cases) {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (method === 'PUT' || method === 'POST') {
        init.body = JSON.stringify({ text: '', password: null });
      }
      const { response } = await fetchJson(server.baseUrl, path, init);
      assert.equal(response.status, expected, `${method} ${path} should return ${expected}, got ${response.status}`);
    }
  } finally {
    await stopServer(server);
  }
});

test('deleting invitation revokes associated access grants', async () => {
  const server = await startServer();
  try {
    // Register two users
    const regA = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieA = regA.headers.get('set-cookie');

    const regB = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieB = regB.headers.get('set-cookie');

    // User A creates invitation
    const create = await fetchJson(server.baseUrl, '/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ maxUses: 5 }),
    });
    assert.equal(create.response.status, 200);

    // User B redeems it
    const redeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(redeem.response.status, 200);

    // Verify B has the grant
    const listBefore = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listBefore.body.received.length, 1);

    // User A deletes the invitation
    const del = await fetchJson(server.baseUrl, `/api/invitations/${create.body.token}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(del.response.status, 200);
    assert.equal(del.body.revokedGrants, 1);

    // Verify B's grant is revoked
    const listAfter = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listAfter.body.received.length, 0);
  } finally {
    await stopServer(server);
  }
});
