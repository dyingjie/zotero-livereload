const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

test('install manifest includes Zotero 10 required metadata', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const app = manifest.applications.zotero;
  assert.ok(app.id && app.update_url && app.strict_max_version);
  assert.equal(manifest.manifest_version, 2);
});

function fixture() {
  const files = new Map();
  const prefs = new Map();
  const requests = [];
  let reloads = 0;
  let writes = 0;
  let version = 'one';
  let body = Buffer.from('%PDF-1.7\nfirst document\n%%EOF\n');
  let fail = false;
  let headStatus = 0;
  const reader = { itemID: 1, _initPromise: Promise.resolve(), reload: async () => { reloads++; } };
  let controller;
  const item = { id: 1, deleted: false, isAttachment: () => true, attachmentLinkMode: 2,
    getFilePathAsync: async () => controller.cachePath() };
  const context = vm.createContext({
    Uint8Array, Date, console,
    IOUtils: {
      makeDirectory: async () => {}, exists: async path => files.has(path),
      read: async path => files.get(path),
      write: async (path, bytes, options) => { assert.equal(options.tmpPath, path + '.tmp'); writes++; files.set(path, bytes.slice()); }
    },
    PathUtils: { join: (...parts) => parts.join('/') },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }) },
    Services: {},
    Zotero: {
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      DataDirectory: { dir: '/test' }, getMainWindows: () => [],
      Utilities: { Internal: { md5: value => crypto.createHash('md5').update(value).digest('hex') } },
      Reader: { _readers: [reader], registerEventListener() {}, unregisterEventListener() {}, open: async () => reader },
      Items: { getAsync: async () => item },
      Libraries: { userLibraryID: 1 },
      Attachments: { LINK_MODE_LINKED_FILE: 2, linkFromFile: async () => item },
      HTTP: { request: async (method, url, options) => {
        requests.push({ method, url, options });
        if (fail) throw new Error('offline');
        if (method === 'HEAD' && headStatus) throw Object.assign(new Error('unsupported'), { status: headStatus });
        const headers = { ETag: version, 'Content-Length': String(body.length) };
        return { getResponseHeader: key => headers[key] || null,
          response: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
      } }
    }
  });
  vm.runInContext(fs.readFileSync('livereload.js', 'utf8'), context);
  controller = new context.LiveReloadController('test');
  return { controller, files, requests, reader, item,
    get reloads() { return reloads; }, get writes() { return writes; },
    set version(value) { version = value; }, set body(value) { body = Buffer.from(value); },
    set fail(value) { fail = value; }, set headStatus(value) { headStatus = value; } };
}

test('first download creates preview; unchanged HEAD skips GET; manual refresh reloads', async () => {
  const f = fixture(); await f.controller.start();
  await f.controller.refresh(true);
  assert.equal(f.writes, 1); assert.equal(f.reloads, 1);
  await f.controller.refresh(false);
  assert.deepEqual(f.requests.map(r => r.method), ['HEAD', 'GET', 'HEAD']);
  await f.controller.refresh(true);
  assert.equal(f.writes, 1); assert.equal(f.reloads, 2);
});

test('automatic update waits for stable metadata then replaces and reloads', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  f.version = 'two'; f.body = '%PDF-1.7\nsecond document\n%%EOF\n';
  await f.controller.refresh(false); assert.equal(f.writes, 1);
  f.controller.pendingAt -= 2000;
  await f.controller.refresh(false);
  assert.equal(f.writes, 2); assert.equal(f.reloads, 2);
});

test('invalid and truncated responses and network failures preserve old PDF', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  const old = f.files.get(f.controller.cachePath());
  for (const body of ['<html>not a pdf</html>', '%PDF-1.7\npartially written document']) {
    f.body = body;
    await assert.rejects(f.controller.refresh(true), /PDF/);
    assert.deepEqual(f.files.get(f.controller.cachePath()), old);
  }
  f.fail = true; await assert.rejects(f.controller.refresh(true), /offline/);
  assert.equal(f.writes, 1); assert.equal(f.reloads, 1);
});

test('HEAD unsupported falls back to GET and overlapping refreshes share one request', async () => {
  const f = fixture(); await f.controller.start(); f.headStatus = 405;
  const first = f.controller.refresh(true); const second = f.controller.refresh(true);
  assert.equal(first, second); await first;
  assert.deepEqual(f.requests.map(r => r.method), ['HEAD', 'GET']);
});

test('source URLs have separate caches; unrelated attachments are not reused', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  const oldPath = f.controller.cachePath();
  f.controller.setPref('url', 'http://example.test/other.pdf');
  assert.notEqual(f.controller.cachePath(), oldPath);
  f.item.getFilePathAsync = async () => oldPath;
  assert.equal(await f.controller.getItem(), null);
});

test('shutdown prevents further downloads and detaches controls', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.stop();
  await f.controller.refresh(true); assert.equal(f.requests.length, 0);
});
