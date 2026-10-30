# Uses a separate Zotero profile and data directory; never reads the user's library.
param([switch]$DebugServer, [switch]$Fixture)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $root '.test-profile'
$results = Join-Path $root '.test-results'
$existing = Get-CimInstance Win32_Process -Filter "Name='zotero.exe'" | Where-Object { $_.CommandLine -like '*-profile*' -and $_.CommandLine.Contains($profile) }
if ($existing) { throw 'The isolated test profile is already running. Close that instance before rerunning.' }
New-Item -ItemType Directory -Path "$profile/extensions", $results -Force | Out-Null
$data = Join-Path $profile 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$dataJSON = ConvertTo-Json $data -Compress
@"
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.dataDir", $dataJSON);
user_pref("extensions.zotero.firstRun", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.logging.enabled", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("extensions.zotero.livereload.automatic", false);
"@ | Set-Content -LiteralPath "$profile/user.js" -Encoding UTF8
Get-Content -LiteralPath "$profile/user.js" -Raw | Add-Content -LiteralPath "$profile/prefs.js" -Encoding UTF8
$target = Join-Path $profile 'extensions/livereload@local.zotero.xpi'
$stream = [IO.File]::Open($target, [IO.FileMode]::Create)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
$resultJSON = ConvertTo-Json (Join-Path $results 'smoke.json') -Compress
$fixtureJS = $Fixture.IsPresent.ToString().ToLowerInvariant()
$bootstrap = Get-Content -LiteralPath "$root/bootstrap.js" -Raw
$bootstrap = $bootstrap.Replace('async function startup(', 'async function originalStartup(')
$bootstrap += @"

async function startup(options) {
  await originalStartup(options);
  // Exercise UI commands after startup/session restoration has completed.
  Zotero.uiReadyPromise.then(() => Zotero.Promise.delay(250)).then(() => runSmoke(options));
}

async function runSmoke(options) {
  const result = { version: Zotero.version, steps: [] };
  const fixture = $fixtureJS;
  try {
    Zotero.Prefs.set('extensions.zotero.livereload.url', fixture
      ? 'http://127.0.0.1:18765/main.pdf' : 'http://10.253.0.9:8765/main.pdf', true);
    result.steps.push('startup');
    await LiveReload.openPreview();
    result.steps.push('download-and-open');
    const reader = Zotero.Reader._readers.find(r => r.itemID === LiveReload.itemID);
    await reader._initPromise;
    await Zotero.Promise.delay(3000);
    result.steps.push('reader-initialized');
    let clickedReader = reader;
    if (fixture) {
      const oldApp = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
      const oldBytes = Components.utils.cloneInto(await oldApp.pdfDocument.getData(), {});
      result.textBefore = String.fromCharCode(...oldBytes).match(/Figure 1: (OLD|NEW)/)?.[0];
      if (!result.textBefore.includes('Figure 1: OLD')) throw new Error('Expected OLD fixture');
      const imported = await Zotero.Attachments.importFromFile({
        file: LiveReload.cachePath(), libraryID: Zotero.Libraries.userLibraryID,
        title: 'Old imported PDF regression'
      });
      clickedReader = await Zotero.Reader.open(imported.id);
      await clickedReader._initPromise;
      await Zotero.Promise.delay(1000);
      result.ordinaryPDFHasNoToolbar = !clickedReader._iframeWindow.document.querySelector('.zotero-livereload-controls');
      if (!result.ordinaryPDFHasNoToolbar) throw new Error('Toolbar leaked into ordinary PDF');
      await Zotero.Reader.open(reader.itemID);
      clickedReader = reader;
      await Zotero.HTTP.request('GET', 'http://127.0.0.1:18765/advance');
    }
    const controls = Array.from(LiveReload.controls);
    const control = controls.find(control => control.root.isConnected && control.reader === clickedReader);
    if (!control) throw new Error('LiveReload toolbar missing');
    let clicks = 0;
    let downloads = 0;
    let reloads = 0;
    const request = LiveReload.request.bind(LiveReload);
    LiveReload.request = async (method, force) => {
      if (method === 'GET') downloads++;
      return request(method, force);
    };
    const reload = LiveReload.reloadReader.bind(LiveReload);
    LiveReload.reloadReader = async (target, bytes) => { reloads++; return reload(target, bytes); };
    control.refresh.addEventListener('click', () => clicks++);
    result.buttonDisabled = control.refresh.disabled;
    result.buttonNamespace = control.refresh.namespaceURI;
    result.toolbarButtonCount = control.root.querySelectorAll('button').length;
    result.updatedBefore = LiveReload.pref('updatedAt.' + reader.itemID, '');
    control.refresh.click();
    if (LiveReload.busy) await LiveReload.busy;
    result.clicks = clicks;
    result.downloads = downloads;
    result.reloads = reloads;
    result.updatedAfter = LiveReload.pref('updatedAt.' + reader.itemID, '');
    result.timestampText = control.status.textContent;
    if (downloads !== 1 || reloads !== 1) throw new Error('Toolbar click did not download and reload');
    if (result.toolbarButtonCount !== 1 || !result.updatedAfter || result.updatedAfter === result.updatedBefore) {
      throw new Error('Expected one refresh button and an advancing success timestamp');
    }
    await Zotero.Promise.delay(2000);
    result.steps.push('native-reload');
    const app = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
    const renderedBytes = Components.utils.cloneInto(await app.pdfDocument.getData(), {});
    const diskBytes = await IOUtils.read(LiveReload.cachePath());
    const remoteBytes = new Uint8Array((await request('GET', true)).response);
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    result.readerMatchesDisk = same(renderedBytes, diskBytes);
    result.readerMatchesServer = same(renderedBytes, remoteBytes);
    if (!result.readerMatchesDisk || !result.readerMatchesServer) throw new Error('Reader is displaying stale PDF bytes');
    if (fixture) {
      result.textAfter = String.fromCharCode(...renderedBytes).match(/Figure 1: (OLD|NEW)/)?.[0];
      result.focusedManagedPreview = Zotero.Reader.getByTabID(Zotero.getMainWindow().Zotero_Tabs.selectedID)?.itemID === LiveReload.itemID;
      if (!result.textAfter.includes('Figure 1: NEW') || !result.focusedManagedPreview) {
        throw new Error('Managed preview did not display the NEW remote fixture');
      }
    }
    result.pages = app.pdfDocument.numPages;
    result.renderedCanvases = app.pdfViewer._pages.filter(page => page.canvas?.width > 0).length;
    result.menu = !!Zotero.getMainWindow().document.getElementById('zotero-livereload-menu');
    result.toolbar = LiveReload.controls.size;
    result.itemID = LiveReload.itemID;
    result.bytes = (await IOUtils.stat(LiveReload.cachePath())).size;
    result.status = LiveReload.status;
    result.ok = result.menu && result.toolbar > 0 && result.bytes > 0 && result.renderedCanvases > 0;
    const win = Zotero.getMainWindow();
    const tabs = win.Zotero_Tabs;
    tabs.select(tabs._tabs[0].id);
    tabs.unload(reader.tabID);
    await Zotero.Promise.delay(300);
    let opening;
    const openPreview = LiveReload.openPreview.bind(LiveReload);
    LiveReload.openPreview = () => { opening = openPreview(); return opening; };
    win.document.getElementById('zotero-livereload-menu').querySelector('menuitem')
      .doCommand();
    await Zotero.Promise.delay(100);
    if (!opening) throw new Error('Open menu command did not trigger');
    const restored = await opening;
    const restoredData = Components.utils.cloneInto(await restored._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument.getData(), {});
    result.unloadedTabRestored = restored.itemID === LiveReload.itemID && tabs.selectedID === restored.tabID;
    result.restoredReaderMatchesServer = same(restoredData, remoteBytes);
    if (!result.unloadedTabRestored || !result.restoredReaderMatchesServer) throw new Error('Unloaded preview was not restored and focused');
    result.steps.push('menu-restores-unloaded-tab');
  } catch (error) {
    result.ok = false;
    result.error = String(error) + '\n' + error.stack;
  }
  await IOUtils.writeUTF8($resultJSON, JSON.stringify(result, null, 2));
}
"@
try {
    foreach ($name in @('manifest.json', 'livereload.js')) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $name), $name) | Out-Null
    }
    $entry = $zip.CreateEntry('bootstrap.js')
    $writer = [IO.StreamWriter]::new($entry.Open())
    $writer.Write($bootstrap)
    $writer.Dispose()
} finally { $zip.Dispose(); $stream.Dispose() }
$arguments = @('-no-remote', '-profile', "`"$profile`"", '-ZoteroDebugText')
if ($DebugServer) { $arguments += @('-start-debugger-server', '6100') }
$startedAt = Get-Date
if ($Fixture) {
    if (Get-NetTCPConnection -LocalPort 18765 -State Listen -ErrorAction SilentlyContinue) { throw 'Fixture port 18765 is already in use.' }
    $fixturePath = Join-Path $PSScriptRoot 'fixture-server.cjs'
    $fixtureProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("`"$fixturePath`"") -WindowStyle Hidden -PassThru -RedirectStandardError "$results/fixture.log"
    Start-Sleep -Milliseconds 600
    if ($fixtureProcess.HasExited) { throw 'Fixture server failed to start.' }
}
$process = Start-Process -FilePath 'C:\Program Files\Zotero\zotero.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$results/stdout.log" -RedirectStandardError "$results/stderr.log"
$process.Id | Set-Content -LiteralPath "$results/process-id.txt"
Write-Output "Isolated Zotero PID: $($process.Id)"
Write-Output "Result: $results\smoke.json"
if ($DebugServer) { return }
try {
    $deadline = (Get-Date).AddSeconds(45)
    $resultFile = Join-Path $results 'smoke.json'
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $resultFile) -and (Get-Item -LiteralPath $resultFile).LastWriteTime -ge $startedAt) {
            $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
            if (!$result.ok) { throw (ConvertTo-Json $result -Depth 5) }
            Get-Content -LiteralPath $resultFile -Raw
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Isolated Zotero smoke test timed out; inspect .test-results logs.'
} finally {
    Get-CimInstance Win32_Process -Filter "Name='zotero.exe'" |
        Where-Object { $_.CommandLine -like '*-profile*' -and $_.CommandLine.Contains($profile) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    if ($fixtureProcess) { Stop-Process -Id $fixtureProcess.Id -ErrorAction SilentlyContinue }
}
