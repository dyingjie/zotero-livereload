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
  const opened = [];
  const timers = new Map();
  let timerID = 0;
  const reader = { itemID: 1, _initPromise: Promise.resolve(), _iframeWindow: {},
    _internalReader: { reload: data => {
      reloads++;
      reader._internalReader._primaryView = { initializedPromise: Promise.resolve(),
        _iframeWindow: { PDFViewerApplication: { pdfDocument: { getData: async () => data.buf } } } };
    } } };
  let controller;
  const item = { id: 1, deleted: false, isAttachment: () => true, attachmentLinkMode: 2,
    getFilePathAsync: async () => controller.cachePath() };
  const context = vm.createContext({
    Uint8Array, Date, console,
    Cu: { cloneInto: value => value },
    IOUtils: {
      makeDirectory: async () => {}, exists: async path => files.has(path),
      read: async path => files.get(path),
      write: async (path, bytes, options) => { assert.equal(options.tmpPath, path + '.tmp'); writes++; files.set(path, bytes.slice()); }
    },
    PathUtils: { join: (...parts) => parts.join('/') },
    ChromeUtils: { importESModule: () => ({ setTimeout: (fn, ms) => { timers.set(++timerID, { fn, ms }); return timerID; }, clearTimeout: id => timers.delete(id) }) },
    Services: {},
    Zotero: {
      Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
      DataDirectory: { dir: '/test' }, getMainWindows: () => [],
      getMainWindow: () => null, Promise: { delay: ms => new Promise(resolve => setTimeout(resolve, ms)) },
      Utilities: { Internal: { md5: value => crypto.createHash('md5').update(value).digest('hex') } },
      Reader: { _readers: [reader], registerEventListener() {}, unregisterEventListener() {}, open: async id => { opened.push(id); return reader; } },
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
  return { controller, files, requests, reader, item, opened, zotero: context.Zotero, timers,
    get reloads() { return reloads; }, get writes() { return writes; },
    set version(value) { version = value; }, set body(value) { body = Buffer.from(value); },
    set fail(value) { fail = value; }, set headStatus(value) { headStatus = value; } };
}

test('first download creates preview; unchanged HEAD skips GET; manual refresh reloads', async () => {
  const f = fixture(); await f.controller.start();
  await f.controller.refresh(true);
  assert.equal(f.writes, 1); assert.equal(f.reloads, 1);
  await f.controller.refresh(false);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'HEAD']);
  await f.controller.refresh(true);
  assert.equal(f.writes, 1); assert.equal(f.reloads, 2);
});

test('open waits for a lazy restored reader even when Zotero.Reader.open returns undefined', async () => {
  const f = fixture(); await f.controller.start();
  f.zotero.Reader._readers = [];
  let focused = 0;
  f.reader.focus = async () => { focused++; };
  f.zotero.Reader.open = async () => {
    Promise.resolve().then(() => f.zotero.Reader._readers.push(f.reader));
    return undefined;
  };
  assert.equal(await f.controller.openPreview(), f.reader);
  assert.equal(focused, 1);
  assert.equal(f.reloads, 1);
});

test('closed and uninitialized readers do not block opening a new preview', async () => {
  const f = fixture(); await f.controller.start();
  const closed = { itemID: 1, _isTabClosed: true, _initPromise: new Promise(() => {}) };
  const pending = { itemID: 1, _initPromise: new Promise(() => {}) };
  f.zotero.Reader._readers = [closed, pending];
  f.zotero.Reader.open = async () => { f.zotero.Reader._readers.push(f.reader); return f.reader; };
  assert.equal(await f.controller.openPreview(), f.reader);
  assert.equal(f.reloads, 1);
});

test('reader initialization timeout releases busy state and late initialization cannot reload', async () => {
  const f = fixture(); await f.controller.start();
  let resolveInit;
  f.reader._initPromise = new Promise(resolve => { resolveInit = resolve; });
  const pending = f.controller.refresh(true);
  for (let i = 0; i < 30 && !Array.from(f.timers.values()).some(t => t.ms === 20000); i++) await Promise.resolve();
  const timeout = Array.from(f.timers.values()).find(t => t.ms === 20000);
  assert.ok(timeout);
  const rejection = assert.rejects(pending, /超时/);
  timeout.fn(); await rejection;
  assert.equal(f.controller.busy, null);
  resolveInit(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.reloads, 0);
});

test('destroyed toolbar documents cannot break the open command or error reporting', async () => {
  const f = fixture(); await f.controller.start();
  const deadRoot = Object.defineProperty({}, 'isConnected', {
    get() { throw new TypeError("can't access dead object"); }
  });
  f.controller.controls.add({ root: deadRoot });
  f.controller.toolbarRoots.add(deadRoot);
  assert.equal(await f.controller.openPreview(), f.reader);
  assert.equal(f.controller.controls.size, 0);
  assert.equal(f.controller.toolbarRoots.size, 0);
  await f.controller.stop();
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
  const first = f.controller.refresh(false); const second = f.controller.refresh(false);
  assert.equal(first, second); await first;
  assert.deepEqual(f.requests.map(r => r.method), ['HEAD', 'GET']);
});

test('manual refresh bypasses HEAD and HTTP caches and records a successful update time', async () => {
  const f = fixture(); await f.controller.start(); f.headStatus = 403;
  await f.controller.refresh(true);
  assert.deepEqual(f.requests.map(r => r.method), ['GET']);
  assert.match(f.requests[0].url, /main\.pdf\?_zlr=\d+$/);
  const updated = f.controller.pref('updatedAt.1', '');
  assert.ok(updated && !Number.isNaN(Date.parse(updated)));
  f.fail = true;
  await assert.rejects(f.controller.refresh(true), /offline/);
  assert.equal(f.controller.pref('updatedAt.1', ''), updated);
});

test('manual click during automatic check still performs a forced GET', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  f.requests.length = 0;
  const automatic = f.controller.refresh(false);
  const manual = f.controller.refresh(true);
  await Promise.all([automatic, manual]);
  assert.deepEqual(f.requests.map(r => r.method), ['HEAD', 'GET']);
  assert.match(f.requests[1].url, /_zlr=/);
});

test('stale reader bytes reject refresh and do not advance successful update time', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  const updated = f.controller.pref('updatedAt.1', '');
  // Reproduce a reader that continues returning the old document after reload.
  f.reader._internalReader.reload = () => {};
  f.body = '%PDF-1.7\nnew figure document\n%%EOF\n';
  await assert.rejects(f.controller.refresh(true), /PDF.*不一致/);
  assert.equal(f.controller.pref('updatedAt.1', ''), updated);
});

test('success timestamp waits until PDF reader data has been verified', async () => {
  const f = fixture(); await f.controller.start();
  let release;
  f.reader._internalReader.reload = data => {
    f.reader._internalReader._primaryView = { initializedPromise: Promise.resolve(),
      _iframeWindow: { PDFViewerApplication: { pdfDocument: {
        getData: () => new Promise(resolve => { release = () => resolve(data.buf); })
      } } } };
  };
  const pending = f.controller.refresh(true);
  for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
  assert.ok(release);
  assert.equal(f.controller.pref('updatedAt.1', ''), '');
  release(); await pending;
  assert.ok(f.controller.pref('updatedAt.1', ''));
});

test('unrelated PDFs do not download or open the configured preview', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  f.requests.length = 0;
  let reloads = 0;
  const reader = { itemID: 99, _initPromise: Promise.resolve(), reload: async () => { reloads++; } };
  await f.controller.refreshReader(reader);
  assert.equal(reloads, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.opened, []);
  assert.equal(f.controller.pref('updatedAt.99', ''), '');
});

test('toolbar injection ignores ordinary PDFs and previews from another source', async () => {
  const f = fixture(); await f.controller.start();
  const doc = { createElement() { throw new Error('Must not touch ordinary PDF UI'); } };
  const append = () => { throw new Error('Must not inject toolbar'); };
  f.controller.addToolbar({ reader: { type: 'pdf', itemID: 99 }, doc, append });
  await f.controller.refresh(true);
  f.controller.addToolbar({ reader: { type: 'pdf', itemID: 99 }, doc, append });
  f.controller.setPref('itemID', 2);
  f.controller.addToolbar({ reader: { type: 'pdf', itemID: 1 }, doc, append });
  assert.equal(f.controller.controls.size, 0);
});

test('changing PDF source removes controls belonging to the previous preview', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.refresh(true);
  let removed = 0;
  const root = { isConnected: true, remove() { removed++; this.isConnected = false; } };
  f.controller.controls.add({ root, reader: f.reader });
  f.controller.toolbarRoots.add(root);
  f.controller.setPref('itemID', 2);
  f.controller.report('source changed');
  assert.equal(removed, 1);
  assert.equal(f.controller.controls.size, 0);
  assert.equal(f.controller.toolbarRoots.size, 0);
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
