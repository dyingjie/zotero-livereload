/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
"use strict";

var LiveReload;

async function startup({ id, rootURI }) {
  const scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils };
  Services.scriptloader.loadSubScript(rootURI + "livereload.js", scope);
  LiveReload = new scope.LiveReloadController(id);
  await LiveReload.start();
}

async function shutdown() {
  if (LiveReload) await LiveReload.stop();
  LiveReload = null;
}

function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) { LiveReload?.addWindow(window); }
function onMainWindowUnload({ window }) { LiveReload?.removeWindow(window); }
