/* global Zotero, Services, ChromeUtils */
"use strict";

var LiveReloadController = class {
  constructor(pluginID) {
    this.pluginID = pluginID;
    this.prefix = "extensions.zotero.livereload.";
    this.windows = new Map();
    this.controls = new Set();
    this.toolbarRoots = new Set();
    this.stopped = false;
    this.busy = null;
    this.signature = null;
    this.pendingSignature = null;
    this.pendingAt = 0;
    this.status = "就绪";
    this.timerAPI = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    this.fs = {};
    this.fs.io = IOUtils;
    this.fs.path = PathUtils;
    this.onToolbar = event => this.addToolbar(event);
  }

  pref(name, fallback) {
    return Zotero.Prefs.get(this.prefix + name, true) ?? fallback;
  }

  setPref(name, value) {
    Zotero.Prefs.set(this.prefix + name, value, true);
  }

  get url() { return this.pref("url", "http://10.253.0.9:8765/main.pdf"); }
  get automatic() { return this.pref("automatic", false); }
  get itemID() { return this.pref("itemID", 0); }

  async start() {
    this.directory = this.fs.path.join(Zotero.DataDirectory.dir, "livereload");
    await this.fs.io.makeDirectory(this.directory, { ignoreExisting: true });
    Zotero.Reader.registerEventListener("renderToolbar", this.onToolbar, this.pluginID);
    for (const win of Zotero.getMainWindows()) this.addWindow(win);
    this.schedule();
  }

  report(message) {
    this.status = message;
    for (const control of this.controls) {
      if (!control.root.isConnected) {
        this.controls.delete(control);
        continue;
      }
      const updated = this.pref("updatedAt." + this.itemID, "");
      control.status.textContent = "更新时间：" + (updated
        ? new Date(updated).toLocaleTimeString([], { hour12: false }) : "—");
      control.status.title = updated ? new Date(updated).toLocaleString() : "尚未成功刷新";
      const loading = !!this.busy;
      control.refresh.disabled = loading;
      control.refresh.textContent = loading ? "刷新中…" : "刷新 PDF";
      control.refresh.title = `${message}\n从 ${this.url} 下载最新版并显示实时预览`;
    }
    for (const nodes of this.windows.values()) {
      nodes.auto.setAttribute("checked", String(this.automatic));
    }
  }

  async action(fn, win = Zotero.getMainWindow()) {
    try { return await fn(); }
    catch (error) {
      Zotero.logError(error);
      this.report("刷新失败：" + error.message);
      Zotero.alert(win, "Zotero LiveReload", error.message);
    }
  }

  addWindow(win) {
    if (this.windows.has(win) || this.stopped) return;
    const doc = win.document;
    const parent = doc.getElementById("menu_ToolsPopup");
    if (!parent) return;
    const menu = doc.createXULElement("menu");
    menu.id = "zotero-livereload-menu";
    menu.setAttribute("label", "PDF 实时预览 (LiveReload)");
    const popup = doc.createXULElement("menupopup");
    menu.append(popup);
    const add = (label, fn) => {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => this.action(fn, win));
      popup.append(item);
      return item;
    };
    add("打开 / 刷新远程 PDF", () => this.openPreview());
    const auto = add("自动刷新（每 2 秒检查）", () => this.toggleAutomatic());
    auto.setAttribute("type", "checkbox");
    auto.setAttribute("autocheck", "false");
    auto.setAttribute("checked", String(this.automatic));
    add("设置 PDF 地址…", () => this.configure(win));
    add("查看状态", () => Zotero.alert(win, "Zotero LiveReload", `${this.url}\n${this.status}\n自动刷新：${this.automatic ? "开" : "关"}`));
    parent.append(menu);
    this.windows.set(win, { menu, auto });
  }

  removeWindow(win) {
    this.windows.get(win)?.menu.remove();
    this.windows.delete(win);
  }

  addToolbar({ reader, doc, append }) {
    if (reader.type !== "pdf" || this.stopped) return;
    const root = doc.createElement("span");
    root.className = "zotero-livereload-controls";
    for (const node of this.toolbarRoots) {
      if (!node.isConnected) this.toolbarRoots.delete(node);
    }
    this.toolbarRoots.add(root);
    root.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-inline:6px;font-size:12px;";
    const button = (text, fn) => {
      const node = doc.createElement("button");
      node.type = "button";
      node.textContent = text;
      node.style.cssText = "font:inherit;padding:3px 7px;cursor:pointer;white-space:nowrap;";
      node.addEventListener("click", () => this.action(fn));
      root.append(node);
      return node;
    };
    const refresh = button("刷新 PDF", () => this.refreshReader(reader));
    const status = doc.createElement("span");
    status.style.cssText = "max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    root.append(status);
    root.title = this.url;
    append(root);
    this.controls.add({ root, refresh, status, reader });
    this.report(this.status);
  }

  markUpdated(itemID) {
    this.setPref("updatedAt." + itemID, new Date().toISOString());
  }

  async refreshReader(reader) {
    if (reader.itemID === this.itemID) return this.refresh(true);
    // An imported copy may be stale. Always fetch the configured remote PDF and
    // focus its managed preview rather than claiming that a local-only reload updated it.
    await this.openPreview();
  }

  async configure(win) {
    // Finish a running replacement before changing which source owns the cache.
    if (this.busy) await this.busy;
    const input = { value: this.url };
    if (!Services.prompt.prompt(win, "远程 PDF 地址", "输入 HTTP / HTTPS PDF 地址", input, null, {})) return;
    const value = input.value.trim();
    const uri = Services.io.newURI(value);
    if (!["http", "https"].includes(uri.scheme) || !uri.host) {
      throw new Error("请输入有效的 HTTP 或 HTTPS 地址");
    }
    if (value !== this.url) {
      this.setPref("url", value);
      this.setPref("itemID", 0);
      this.signature = null;
      this.pendingSignature = null;
    }
    await this.openPreview();
  }

  cachePath() {
    // Stable source-specific path; changing URLs never overwrites another preview.
    const hash = Zotero.Utilities.Internal.md5(this.url);
    return this.fs.path.join(this.directory, hash + ".pdf");
  }

  async getItem() {
    if (!this.itemID) return null;
    const item = await Zotero.Items.getAsync(this.itemID);
    if (!item || item.deleted || !item.isAttachment()
      || item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE
      || await item.getFilePathAsync() !== this.cachePath()) return null;
    return item;
  }

  async ensureItem() {
    let item = await this.getItem();
    if (!item) {
      item = await Zotero.Attachments.linkFromFile({
        file: this.cachePath(),
        title: "LiveReload — " + this.url.split("/").pop().split("?")[0],
        contentType: "application/pdf",
        libraryID: Zotero.Libraries.userLibraryID
      });
      this.setPref("itemID", item.id);
    }
    return item;
  }

  async openPreview() {
    await this.refresh(true);
    if (this.stopped) return;
    const item = await this.ensureItem();
    const wasOpen = (Zotero.Reader._readers || []).some(reader => reader.itemID === item.id);
    const reader = await Zotero.Reader.open(item.id);
    if (!wasOpen && reader && !this.stopped) {
      await this.reloadReader(reader, await this.fs.io.read(this.cachePath()));
      this.markUpdated(item.id);
      this.report(this.status);
    }
  }

  async reloadReader(reader, bytes) {
    await reader._initPromise;
    if (this.stopped) return;
    const internal = reader._internalReader;
    if (!internal?.reload) throw new Error("当前 Zotero 不支持直接刷新 PDF 数据");
    // Passing freshly downloaded bytes avoids cached zotero://attachment responses.
    // Clone a separate copy: PDF.js may transfer and detach its input buffer.
    internal.reload(Cu.cloneInto({ buf: bytes.slice() }, reader._iframeWindow));
    const verify = async () => {
      const view = internal._primaryView;
      await view.initializedPromise;
      const app = view._iframeWindow.PDFViewerApplication;
      if (!app.pdfDocument) await app.pdfLoadingTask.promise;
      const loaded = Cu.cloneInto(await app.pdfDocument.getData(), {});
      if (loaded.length !== bytes.length || !bytes.every((value, index) => value === loaded[index])) {
        throw new Error("阅读器中的 PDF 与最新下载不一致，请重试刷新");
      }
    };
    let timer;
    try {
      await Promise.race([verify(), new Promise((resolve, reject) => {
        timer = this.timerAPI.setTimeout(() => reject(new Error("PDF 加载验证超时，请重试刷新")), 20000);
      })]);
    }
    finally { this.timerAPI.clearTimeout(timer); }
  }

  async toggleAutomatic() {
    this.setPref("automatic", !this.automatic);
    this.report(this.automatic ? "自动刷新已开启" : "自动刷新已暂停");
    if (this.automatic) await this.openPreview();
  }

  schedule() {
    if (this.stopped) return;
    this.timer = this.timerAPI.setTimeout(async () => {
      try {
        // Only poll while this preview is actually open, including detached windows.
        if (this.automatic && this.hasOpenReader()) await this.refresh(false);
      }
      catch (error) {
        Zotero.logError(error);
        this.report("连接失败，稍后重试：" + error.message);
      }
      finally { this.schedule(); }
    }, 2000);
  }

  hasOpenReader() {
    return (Zotero.Reader._readers || []).some(r => r.itemID === this.itemID);
  }

  async request(method, force = false) {
    // A unique GET URL bypasses intermediaries that ignore request cache headers.
    let url = this.url;
    if (force && method === "GET") {
      const hashIndex = url.indexOf("#");
      if (hashIndex !== -1) url = url.slice(0, hashIndex);
      url += (url.includes("?") ? "&" : "?") + "_zlr=" + Date.now();
    }
    return Zotero.HTTP.request(method, url, {
      responseType: method === "GET" ? "arraybuffer" : "text",
      timeout: 15000,
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
    });
  }

  fingerprint(response) {
    const etag = response.getResponseHeader("ETag");
    const modified = response.getResponseHeader("Last-Modified");
    const length = response.getResponseHeader("Content-Length");
    return etag || modified ? JSON.stringify([etag, modified, length]) : null;
  }

  refresh(force) {
    if (this.stopped) return Promise.resolve();
    if (this.busy) {
      // A manual click must not get swallowed by an automatic metadata check.
      if (force && !this.busyForced) return this.busy.then(() => this.refresh(true));
      return this.busy;
    }
    this.busyForced = force;
    this.busy = this.performRefresh(force).finally(() => {
      this.busy = null;
      this.report(this.status);
    });
    this.report(force ? "正在下载 PDF…" : this.status);
    return this.busy;
  }

  async performRefresh(force) {
    let head = null;
    try { if (!force) head = await this.request("HEAD"); }
    catch (error) {
      // Servers without HEAD support can still be refreshed with GET.
      if (![405, 501].includes(error.status)) throw error;
    }
    if (this.stopped) return;
    const signature = head && this.fingerprint(head);
    if (!force && signature && signature === this.signature) return;
    if (!force && signature) {
      if (this.pendingSignature !== signature) {
        this.pendingSignature = signature;
        this.pendingAt = Date.now();
        this.report("检测到更新，等待文件稳定…");
        return;
      }
      if (Date.now() - this.pendingAt < 1000) return;
    }
    const response = await this.request("GET", force);
    if (this.stopped) return;
    const bytes = new Uint8Array(response.response);
    this.validatePDF(bytes);
    const downloadedSignature = this.fingerprint(response);
    if (signature && downloadedSignature && signature !== downloadedSignature) {
      this.pendingSignature = downloadedSignature;
      this.pendingAt = Date.now();
      if (!force) { this.report("编译文件仍在变化，等待下一次检查…"); return; }
    }
    const path = this.cachePath();
    // Comparing bytes also handles servers that have no usable HTTP validators.
    let changed = true;
    if (await this.fs.io.exists(path)) {
      const old = await this.fs.io.read(path);
      changed = old.length !== bytes.length || old.some((value, i) => value !== bytes[i]);
    }
    if (this.stopped) return;
    if (changed) {
      await this.fs.io.write(path, bytes, { tmpPath: path + ".tmp" });
    }
    if (this.stopped) return;
    const item = await this.ensureItem();
    if (changed || force) {
      let reloaded = false;
      for (const reader of (Zotero.Reader._readers || []).slice()) {
        if (reader.itemID !== item.id) continue;
        await reader._initPromise;
        if (this.stopped) return;
        await this.reloadReader(reader, bytes);
        reloaded = true;
      }
      if (reloaded) this.markUpdated(item.id);
    }
    this.signature = downloadedSignature || signature;
    this.pendingSignature = null;
    this.report((changed || force ? "已更新 " : "已检查 ") + new Date().toLocaleTimeString());
  }

  validatePDF(bytes) {
    if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error("服务器返回的内容不是 PDF，已保留原文件");
    }
    const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 2048)));
    if (!tail.includes("%%EOF")) {
      throw new Error("PDF 尚未写完或下载不完整，已保留原文件");
    }
  }

  async stop() {
    this.stopped = true;
    this.timerAPI.clearTimeout(this.timer);
    Zotero.Reader.unregisterEventListener("renderToolbar", this.onToolbar);
    // In-flight HTTP requests have a finite timeout and check stopped before writing.
    if (this.busy) await this.busy.catch(() => {});
    for (const win of Array.from(this.windows.keys())) this.removeWindow(win);
    for (const root of this.toolbarRoots) root.remove();
    this.toolbarRoots.clear();
    this.controls.clear();
  }
};
