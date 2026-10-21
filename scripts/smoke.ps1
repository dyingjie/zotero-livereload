# Uses a separate Zotero profile and data directory; never reads the user's library.
param([switch]$DebugServer)
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
$bootstrap = Get-Content -LiteralPath "$root/bootstrap.js" -Raw
$bootstrap = $bootstrap.Replace('async function startup(', 'async function originalStartup(')
$bootstrap += @"

async function startup(options) {
  const result = { version: Zotero.version, steps: [] };
  try {
    await originalStartup(options);
    result.steps.push('startup');
    await LiveReload.openPreview();
    result.steps.push('download-and-open');
    const reader = Zotero.Reader._readers.find(r => r.itemID === LiveReload.itemID);
    await reader._initPromise;
    await Zotero.Promise.delay(3000);
    result.steps.push('reader-initialized');
    await LiveReload.refresh(true);
    await Zotero.Promise.delay(2000);
    result.steps.push('native-reload');
    const app = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
    result.pages = app.pdfDocument.numPages;
    result.renderedCanvases = app.pdfViewer._pages.filter(page => page.canvas?.width > 0).length;
    result.menu = !!Zotero.getMainWindow().document.getElementById('zotero-livereload-menu');
    result.toolbar = LiveReload.controls.size;
    result.itemID = LiveReload.itemID;
    result.bytes = (await IOUtils.stat(LiveReload.cachePath())).size;
    result.status = LiveReload.status;
    result.ok = result.menu && result.toolbar > 0 && result.bytes > 0 && result.renderedCanvases > 0;
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
}
