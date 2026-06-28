const test = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const AdmZip = require('adm-zip');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'convert-worker.js');

// Spawn convert-worker.js and return the markdown result
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    worker.on('message', (msg) => {
      if (msg.ok) resolve(msg.markdown);
      else reject(new Error(msg.error));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

// ── MIME / content sniffing ─────────────────────────────────────────────────

test('MIME sniff: JPEG with wrong extension (.bin) is detected as image', async () => {
  // Minimal JPEG header (SOI + SOF0 + EOI) — valid enough for magic byte detection
  // but too small for full image processing, so we expect a conversion error.
  const jpegHeader = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
  ]);
  await assert.rejects(
    () => runWorker({
      buffer: jpegHeader,
      ext: '.bin',
      mimeType: 'application/octet-stream',
      originalName: 'fake.bin',
    }),
    // The worker SHOULD try to parse as JPEG (not .bin/unknown),
    // and fail on image processing rather than UNSUPPORTED_FILE_TYPE
    (err) => err.message !== 'UNSUPPORTED_FILE_TYPE'
  );
});

test('MIME sniff: plain text with wrong extension (.pdf) falls back to extension', async () => {
  // Content is plain text, not a real PDF.
  // Magic byte check fails → falls back to extension '.pdf' → pdf-parse fails.
  // This verifies the worker doesn't silently succeed on mismatched content.
  await assert.rejects(
    () => runWorker({
      buffer: Buffer.from('this is not a pdf at all'),
      ext: '.pdf',
      mimeType: 'application/pdf',
      originalName: 'not-a-pdf.pdf',
    }),
    (err) => err.message.length > 0
  );
});

test('MIME sniff: CSV with correct extension converts to markdown table', async () => {
  const md = await runWorker({
    buffer: Buffer.from('name,age\nAlice,30\nBob,25'),
    ext: '.csv',
    mimeType: 'text/csv',
    originalName: 'data.csv',
  });
  assert.match(md, /\| name \| age \|/);
  assert.match(md, /\| Alice \| 30 \|/);
});

test('unsupported type returns error', async () => {
  await assert.rejects(
    () => runWorker({
      buffer: Buffer.from('binary data'),
      ext: '.exe',
      mimeType: 'application/x-msdownload',
      originalName: 'app.exe',
    }),
    /UNSUPPORTED_FILE_TYPE/
  );
});

// ── HTML security ───────────────────────────────────────────────────────────

test('HTML: strips <script> and preserves safe content', async () => {
  const html = '<p>safe paragraph</p><script>var evil = "xss"</script><p>also safe</p>';
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'page.html',
  });
  assert.ok(md.includes('safe paragraph'), 'Should preserve safe text');
  assert.ok(md.includes('also safe'), 'Should preserve sibling content');
  assert.ok(!md.includes('evil'), 'Should strip script content');
  assert.ok(!md.includes('var '), 'Should strip script code');
});

test('HTML: strips <style>, <iframe>, <noscript>', async () => {
  const html = [
    '<p>content</p>',
    '<style>body { background: red }</style>',
    '<iframe src="evil.com"></iframe>',
    '<noscript>enable js</noscript>',
    '<p>more content</p>',
  ].join('');
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'page.html',
  });
  assert.ok(md.includes('content'), 'Should keep safe text');
  assert.ok(!md.includes('background'), 'Should strip style content');
  assert.ok(!md.includes('evil.com'), 'Should strip iframe');
  assert.ok(!md.includes('enable js'), 'Should strip noscript');
});

test('HTML: blocks javascript: and data: links', async () => {
  const html = [
    '<a href="javascript:alert(1)">click me</a>',
    '<a href="data:text/html,<h1>xss</h1>">data link</a>',
    '<a href="vbscript:msgbox(1)">vb link</a>',
    '<a href="https://example.com">safe link</a>',
  ].join('');
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'links.html',
  });
  assert.ok(!md.includes('javascript:'), 'Should block javascript: protocol');
  assert.ok(!md.includes('data:text'), 'Should block data: URI');
  assert.ok(!md.includes('vbscript:'), 'Should block vbscript: protocol');
  assert.ok(md.includes('https://example.com'), 'Should preserve safe links');
  assert.ok(md.includes('safe link'), 'Should preserve link text');
});

test('HTML: blocks javascript: and data: in images', async () => {
  const html = [
    '<img src="javascript:alert(1)" alt="bad img">',
    '<img src="data:image/png;base64,iVBOR" alt="data img">',
    '<img src="https://example.com/photo.jpg" alt="good img">',
  ].join('');
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'images.html',
  });
  assert.ok(!md.includes('javascript:'), 'Should block js in img src');
  assert.ok(!md.includes('base64'), 'Should block data URI in img');
  assert.ok(md.includes('https://example.com/photo.jpg'), 'Should preserve safe images');
});

test('HTML: converts checkboxes to markdown syntax', async () => {
  const html = '<ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox"> Todo</li></ul>';
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'todo.html',
  });
  assert.ok(md.includes('[x]'), 'Should convert checked checkbox');
  assert.ok(md.includes('[ ]'), 'Should convert unchecked checkbox');
});

test('HTML: normalizes trailing whitespace and blank lines', async () => {
  const html = '<p>line1</p>\n\n\n\n\n<p>line2</p>';
  const md = await runWorker({
    buffer: Buffer.from(html),
    ext: '.html',
    mimeType: 'text/html',
    originalName: 'normalize.html',
  });
  // Should not have more than 2 consecutive newlines
  assert.ok(!md.includes('\n\n\n'), 'Should collapse excessive blank lines');
});

// ── PPTX ────────────────────────────────────────────────────────────────────

function createMinimalPptx() {
  const zip = new AdmZip();

  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
    '</Types>'
  ));

  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>'
  ));

  zip.addFile('ppt/presentation.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '</p:presentation>'
  ));

  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
    '</Relationships>'
  ));

  // Slide 1: title + table + body text
  const slideXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<p:cSld><p:spTree>',
    // Title shape
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>',
    '<p:spPr/><p:txBody><a:p><a:r><a:t>Welcome Slide</a:t></a:r></a:p></p:txBody></p:sp>',
    // Graphic frame with table
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table 1"/><p:nvPr/></p:nvGraphicFramePr>',
    '<p:graphic><p:graphicData><a:tbl>',
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Name</a:t></a:r></a:p></a:txBody></a:tc>',
    '<a:tc><a:txBody><a:p><a:r><a:t>Age</a:t></a:r></a:p></a:txBody></a:tc></a:tr>',
    '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Alice</a:t></a:r></a:p></a:txBody></a:tc>',
    '<a:tc><a:txBody><a:p><a:r><a:t>30</a:t></a:r></a:p></a:txBody></a:tc></a:tr>',
    '</a:tbl></p:graphicData></p:graphic></p:graphicFrame>',
    // Body text shape
    '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Body 1"/><p:nvPr/></p:nvSpPr>',
    '<p:spPr/><p:txBody><a:p><a:r><a:t>Some body text here</a:t></a:r></a:p></p:txBody></p:sp>',
    '</p:spTree></p:cSld></p:sld>',
  ].join('');
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml));

  return zip.toBuffer();
}

test('PPTX: extracts title, table, and body text', async () => {
  const pptxBuffer = createMinimalPptx();
  const md = await runWorker({
    buffer: pptxBuffer,
    ext: '.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    originalName: 'test.pptx',
  });

  // Title should be rendered as heading
  assert.ok(md.includes('Welcome Slide'), 'Should extract slide title');
  assert.ok(md.includes('## Welcome Slide'), 'Title should use heading syntax');

  // Table should be converted to markdown table
  assert.match(md, /\| Name \| Age \|/, 'Should convert table header');
  assert.match(md, /\| Alice \| 30 \|/, 'Should convert table body');

  // Body text should appear
  assert.ok(md.includes('Some body text here'), 'Should extract body text');
});

test('PPTX: extracts notes from notesSlide', async () => {
  const zip = new AdmZip(createMinimalPptx());

  // Add a notes slide
  zip.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<p:cSld><p:spTree>',
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:nvPr/></p:nvSpPr>',
    '<p:spPr/><p:txBody><a:p><a:r><a:t>Speaker notes content</a:t></a:r></a:p></p:txBody></p:sp>',
    '</p:spTree></p:cSld></p:notes>',
  ].join('')));

  const md = await runWorker({
    buffer: zip.toBuffer(),
    ext: '.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    originalName: 'notes.pptx',
  });

  assert.ok(md.includes('Speaker notes content'), 'Should extract notes text');
  assert.ok(md.includes('**Notes:**'), 'Should label notes section');
});

test('PPTX: no slides throws error', async () => {
  const zip = new AdmZip();
  zip.addFile('not-a-pptx.txt', Buffer.from('hello'));
  await assert.rejects(
    () => runWorker({
      buffer: zip.toBuffer(),
      ext: '.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      originalName: 'empty.pptx',
    }),
    /No slide content found/
  );
});

// ── Image ───────────────────────────────────────────────────────────────────

test('Image: PNG basic conversion outputs dimensions', async () => {
  // Minimal 1x1 red PNG (hand-crafted, valid checksums)
  const pngBuffer = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
    '2e00000000c4944415408d763f8cf00000002000160e227cf000000004945' +
    '4e44ae426082',
    'hex'
  );
  const md = await runWorker({
    buffer: pngBuffer,
    ext: '.png',
    mimeType: 'image/png',
    originalName: 'test.png',
  });
  assert.ok(md.includes('1 x 1'), 'Should output image dimensions');
  assert.ok(md.includes('png'), 'Should output MIME type');
});

// ── Capabilities API (integration test) ─────────────────────────────────────

test('capabilities API returns conversion info', async () => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-cap-'));
  const server = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const m = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, dataDir, baseUrl: `http://127.0.0.1:${m[1]}` }); }
    });
  });
  try {
    const res = await fetch(`${server.baseUrl}/api/convert/capabilities`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.extensions), 'Should have extensions array');
    assert.ok(data.extensions.includes('pdf'), 'Should include pdf');
    assert.ok(data.extensions.includes('pptx'), 'Should include pptx');
    assert.ok(data.extensions.includes('jpg'), 'Should include jpg');
    assert.ok(typeof data.maxBytes === 'number', 'Should have maxBytes');
    assert.ok(typeof data.features === 'object', 'Should have features');
  } finally {
    await new Promise(r => {
      if (server.child.exitCode !== null) return r();
      const t = setTimeout(() => server.child.kill('SIGKILL'), 1000);
      server.child.once('exit', () => { clearTimeout(t); r(); });
      server.child.kill('SIGINT');
    });
    fs.rmSync(server.dataDir, { recursive: true, force: true });
  }
});
