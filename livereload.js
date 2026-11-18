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
    this.sources = new Map();
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

  get automatic() { return this.pref("automatic", false); }

  get previews() {
    return this.urls.map(url => {
      if (!this.sources.has(url)) this.sources.set(url, new LiveReloadSource(this, url));
      return this.sources.get(url);
    });
  }

  async start() {
    this.directory = this.fs.path.join(Zotero.DataDirectory.dir, "livereload");
    await this.fs.io.makeDirectory(this.directory, { ignoreExisting: true });
    const legacyURL = this.pref("url", "http://10.253.0.9:8765/main.pdf");
    const saved = this.pref("urls", "");
    this.urls = saved ? JSON.parse(saved) : [legacyURL];
    if (!saved) {
      const legacyID = this.pref("itemID", 0);
      if (legacyID) this.previews[0].itemID = legacyID;
      this.setPref("urls", JSON.stringify(this.urls));
    }
    Zotero.Reader.registerEventListener("renderToolbar", this.onToolbar, this.pluginID);
    for (const win of Zotero.getMainWindows()) this.addWindow(win);
    this.schedule();
  }

  report(message) {
    this.status = message;
    for (const control of this.controls) {
      const source = control.source;
      if (!this.isConnected(control.root) || control.reader.itemID !== source.itemID) {
        if (this.isConnected(control.root)) control.root.remove();
        this.controls.delete(control);
        this.toolbarRoots.delete(control.root);
        continue;
      }
      control.root.style.display = this.urls.includes(source.url) ? "inline-flex" : "none";
      const updated = this.pref("updatedAt." + source.itemID, "");
      control.status.textContent = "更新时间：" + (updated
        ? new Date(updated).toLocaleTimeString([], { hour12: false }) : "—");
      control.status.title = updated ? new Date(updated).toLocaleString() : "尚未成功刷新";
      const loading = !!source.busy;
      control.refresh.disabled = loading;
      control.refresh.textContent = loading ? "刷新中…" : "刷新 PDF";
      control.refresh.title = `${source.status}\n从 ${source.url} 下载最新版并显示实时预览`;
    }
    for (const nodes of this.windows.values()) {
      nodes.auto.setAttribute("checked", String(this.automatic));
      nodes.status.setAttribute("label", message);
    }
  }

  isConnected(node) {
    // Unloading a Zotero reader destroys its document. Even reading isConnected
    // on a retained node can throw "can't access dead object".
    try { return node.isConnected; }
    catch { return false; }
  }

  async action(fn, win = Zotero.getMainWindow(), source) {
    try { return await fn(); }
    catch (error) {
      Zotero.logError(error);
      const message = "操作失败：" + error.message;
      if (source) source.report(message);
      else this.report(message);
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
    add("打开 / 刷新远程 PDF", () => this.openPreview(win));
    add("打开 / 刷新所有远程 PDF", () => this.openAll(win));
    const auto = add("自动刷新（每 2 秒检查）", () => this.toggleAutomatic(win));
    auto.setAttribute("type", "checkbox");
    auto.setAttribute("autocheck", "false");
    auto.setAttribute("checked", String(this.automatic));
    add("添加 PDF 地址…", () => this.addAddress(win));
    add("移除 PDF 地址…", () => this.removeAddress(win));
    const status = add(this.status, () => {});
    status.setAttribute("disabled", "true");
    add("查看状态", () => {
      const details = this.previews.map(source => `${source.url}\n${source.status}`).join("\n\n");
      Zotero.alert(win, "Zotero LiveReload", `自动刷新：${this.automatic ? "开" : "关"}\n\n${details || "尚未配置 PDF 地址"}`);
    });
    parent.append(menu);
    this.windows.set(win, { menu, auto, status });
  }

  removeWindow(win) {
    this.windows.get(win)?.menu.remove();
    this.windows.delete(win);
  }

  addToolbar({ reader, doc, append }) {
    if (reader.type !== "pdf" || this.stopped) return;
    const source = this.previews.find(candidate => candidate.itemID && candidate.itemID === reader.itemID);
    if (!source) return;
    const root = doc.createElement("span");
    root.className = "zotero-livereload-controls";
    for (const node of this.toolbarRoots) {
      if (!this.isConnected(node)) this.toolbarRoots.delete(node);
    }
    this.toolbarRoots.add(root);
    root.style.cssText = "align-items:center;gap:6px;margin-inline:6px;font-size:12px;";
    const button = (text, fn) => {
      const node = doc.createElement("button");
      node.type = "button";
      node.textContent = text;
      node.style.cssText = "font:inherit;padding:3px 7px;cursor:pointer;white-space:nowrap;";
      node.addEventListener("click", () => this.action(fn, undefined, source));
      root.append(node);
      return node;
    };
    const refresh = button("刷新 PDF", () => {
      if (this.urls.includes(source.url)) return source.refresh(true);
    });
    const status = doc.createElement("span");
    status.style.cssText = "max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    root.append(status);
    root.title = source.url;
    append(root);
    this.controls.add({ root, refresh, status, reader, source });
    this.report(this.status);
  }

  choosePreview(win, title, alwaysChoose = false) {
    const previews = this.previews;
    if (!previews.length) throw new Error("请先添加 PDF 地址");
    if (previews.length === 1 && !alwaysChoose) return previews[0];
    const selected = { value: 0 };
    const labels = previews.map(source => source.url);
    if (Services.prompt.select(win, "Zotero LiveReload", title, labels, selected)) {
      return previews[selected.value];
    }
  }

  async openPreview(win) {
    const source = this.choosePreview(win, "选择要打开或刷新的 PDF");
    if (source) return this.action(() => source.openPreview(), win, source);
  }

  async openAll(win) {
    if (!this.urls.length) throw new Error("请先添加 PDF 地址");
    // Open tabs sequentially to avoid competing for tab selection during restoration.
    for (const source of this.previews) {
      if (this.stopped) break;
      if (!this.urls.includes(source.url)) continue;
      await this.action(() => source.openPreview(), win, source);
    }
  }

  async addAddress(win) {
    const input = { value: "" };
    if (!Services.prompt.prompt(win, "添加远程 PDF", "输入 HTTP / HTTPS PDF 地址", input, null, {})) return;
    const url = input.value.trim();
    let uri;
    try { uri = Services.io.newURI(url); }
    catch { throw new Error("请输入有效的 HTTP 或 HTTPS 地址"); }
    if (!["http", "https"].includes(uri.scheme) || !uri.host) {
      throw new Error("请输入有效的 HTTP 或 HTTPS 地址");
    }
    if (!this.urls.includes(url)) this.saveURLs([...this.urls, url]);
    const source = this.previews.find(candidate => candidate.url === url);
    return this.action(() => source.openPreview(), win, source);
  }

  removeAddress(win) {
    const source = this.choosePreview(win, "选择要从列表移除的 PDF 地址", true);
    if (!source) return;
    this.saveURLs(this.urls.filter(url => url !== source.url));
    this.report("已移除 PDF 地址");
  }

  saveURLs(urls) {
    this.setPref("urls", JSON.stringify(urls));
    this.urls = urls;
  }

  async toggleAutomatic(win) {
    this.setPref("automatic", !this.automatic);
    this.report(this.automatic ? "自动刷新已开启" : "自动刷新已暂停");
    if (this.automatic && this.urls.length === 1 && !this.previews[0].hasOpenReader()) {
      await this.openPreview(win);
    }
  }

  schedule() {
    if (this.stopped) return;
    this.timer = this.timerAPI.setTimeout(() => {
      if (this.automatic) {
        for (const source of this.previews) {
          if (source.busy || !source.hasOpenReader()) continue;
          source.refresh(false).catch(error => {
            Zotero.logError(error);
            source.report("连接失败，稍后重试：" + error.message);
          });
        }
      }
      this.schedule();
    }, 2000);
  }

  async stop() {
    this.stopped = true;
    this.timerAPI.clearTimeout(this.timer);
    Zotero.Reader.unregisterEventListener("renderToolbar", this.onToolbar);
    // In-flight HTTP requests have a finite timeout and check stopped before writing.
    await Promise.allSettled(Array.from(this.sources.values(), source => source.busy));
    for (const win of Array.from(this.windows.keys())) this.removeWindow(win);
    for (const root of this.toolbarRoots) {
      if (this.isConnected(root)) root.remove();
    }
    this.toolbarRoots.clear();
    this.controls.clear();
  }
};

class LiveReloadSource {
  constructor(controller, url) {
    this.controller = controller;
    this.url = url;
    this.hash = Zotero.Utilities.Internal.md5(url);
    this.fs = controller.fs;
    this.timerAPI = controller.timerAPI;
    this.busy = null;
    this.signature = null;
    this.pendingSignature = null;
    this.pendingAt = 0;
    this.status = "就绪";
  }

  get stopped() { return this.controller.stopped; }
  get itemID() { return this.controller.pref("itemID." + this.hash, 0); }
  set itemID(id) { this.controller.setPref("itemID." + this.hash, id); }

  report(message) {
    this.status = message;
    this.controller.report(message);
  }

  markUpdated(itemID) {
    this.controller.setPref("updatedAt." + itemID, new Date().toISOString());
  }

  cachePath() {
    // Stable source-specific path; changing URLs never overwrites another preview.
    return this.fs.path.join(this.controller.directory, this.hash + ".pdf");
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
      this.itemID = item.id;
    }
    return item;
  }

  async openPreview() {
    const readyBefore = new Set(this.liveReaders().filter(reader => reader._internalReader));
    await this.refresh(true);
    if (this.stopped) return;
    const item = await this.getItem();
    if (!item) throw new Error("找不到刚刷新的 PDF 附件，请重试");
    this.report("正在打开 PDF 标签页…");
    const reader = await this.withTimeout(async active => {
      // Restoring an unloaded tab returns undefined. Selection triggers a second,
      // asynchronous Reader.open(), so wait for that live reader instead.
      let opened = await Zotero.Reader.open(item.id);
      while (!opened && active() && !this.stopped) {
        opened = this.liveReaders().find(candidate => candidate.itemID === item.id);
        if (!opened) await Zotero.Promise.delay(50);
      }
      if (!active() || this.stopped) throw new Error("打开 PDF 已取消");
      await opened._initPromise;
      if (!active() || this.stopped) throw new Error("打开 PDF 已取消");
      // Explicitly select the restored tab after initialization as well.
      if (opened.tabID) {
        const win = Zotero.getMainWindow();
        win?.Zotero_Tabs?.select(opened.tabID);
      }
      await opened.focus?.();
      return opened;
    }, "PDF 标签页打开超时，请关闭该预览标签页后重试");
    if (!readyBefore.has(reader) && !this.stopped) {
      await this.reloadReader(reader, await this.fs.io.read(this.cachePath()));
      this.markUpdated(item.id);
    }
    this.report("已打开 PDF " + new Date().toLocaleTimeString());
    return reader;
  }

  async withTimeout(operation, message) {
    let timer;
    let active = true;
    try {
      return await Promise.race([operation(() => active), new Promise((resolve, reject) => {
        timer = this.timerAPI.setTimeout(() => {
          active = false;
          reject(new Error(message));
        }, 20000);
      })]);
    }
    finally { active = false; this.timerAPI.clearTimeout(timer); }
  }

  async reloadReader(reader, bytes) {
    return this.withTimeout(async active => {
      await reader._initPromise;
      if (!active() || this.stopped) throw new Error("PDF 刷新已取消");
      const internal = reader._internalReader;
      if (!internal?.reload) throw new Error("当前 Zotero 不支持直接刷新 PDF 数据");
      // Clone a separate copy: PDF.js may transfer and detach its input buffer.
      internal.reload(Cu.cloneInto({ buf: bytes.slice() }, reader._iframeWindow));
      const view = internal._primaryView;
      await view.initializedPromise;
      const app = view._iframeWindow.PDFViewerApplication;
      if (!app.pdfDocument) await app.pdfLoadingTask.promise;
      const loaded = Cu.cloneInto(await app.pdfDocument.getData(), {});
      if (loaded.length !== bytes.length || !bytes.every((value, index) => value === loaded[index])) {
        throw new Error("阅读器中的 PDF 与最新下载不一致，请重试刷新");
      }
    }, "PDF 加载验证超时，请关闭预览标签页后重试");
  }

  hasOpenReader() {
    return this.liveReaders().some(reader => reader._internalReader);
  }

  liveReaders() {
    return (Zotero.Reader._readers || []).filter(reader => reader.itemID === this.itemID
      && !reader._isTabClosed && !reader._isUninitialized);
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
      if (force && !this.busyForced) return this.busy.then(
        () => this.refresh(true), () => this.refresh(true)
      );
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
      for (const reader of this.liveReaders()) {
        // Background/lazy readers must be selected before waiting for initialization.
        if (!reader._internalReader) continue;
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

};
