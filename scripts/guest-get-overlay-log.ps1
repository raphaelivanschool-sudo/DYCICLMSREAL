<#
.SYNOPSIS
  Dump the locked-overlay log + launch environment FROM the Windows guest.

.DESCRIPTION
  Run this ON the Windows guest when "Project to this PC" reports the overlay
  crashing. It prints everything needed to pin the crash from the macOS host:

    * elevation (full input lock needs Administrator)
    * every Python launcher found, and whether Pillow + tkinter import in EACH
      (the Node agent launches pythonw.exe first — deps must exist THERE, not
      just under python.exe)
    * the projection_overlay.py log:  %TEMP%\dyci_projection_overlay.log
      (this is the real traceback when the overlay crash-loops)
    * the live frame / heartbeat files the agent writes
    * whether the Python agent is listening on TCP 5555
    * optionally, the agent's own GET /overlay-log response (cross-check)

  Copy/paste the whole output back to the host to diagnose.

.PARAMETER Lines
  How many trailing log lines to print (default 200).

.PARAMETER Port
  Python agent port (default 5555).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\guest-get-overlay-log.ps1
  powershell -ExecutionPolicy Bypass -File scripts\guest-get-overlay-log.ps1 -Lines 400
#>
param(
  [int]$Lines = 200,
  [int]$Port = 5555
)

$ErrorActionPreference = "Continue"

function Section($t) { Write-Host ""; Write-Host ("==== " + $t + " ====") -ForegroundColor Cyan }
function Info($m)    { Write-Host ("    " + $m) -ForegroundColor Gray }
function Ok($m)      { Write-Host ("[OK]   " + $m) -ForegroundColor Green }
function Bad($m)     { Write-Host ("[FAIL] " + $m) -ForegroundColor Red }
function Warn($m)    { Write-Host ("[WARN] " + $m) -ForegroundColor Yellow }

# scripts/ -> repo root
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PyDir = Join-Path $RepoRoot "agent\pc-agent\python"
$AgentConfig = Join-Path $PyDir "agent_config.json"
$OverlayScript = Join-Path $PyDir "projection_overlay.py"
$LogPath = Join-Path $env:TEMP "dyci_projection_overlay.log"
$FramePath = Join-Path $env:TEMP "dyci_projection_frame.jpg"
$HeartbeatPath = Join-Path $env:TEMP "dyci_projection.alive"

Section "Host / session"
Info ("Computer:  " + $env:COMPUTERNAME)
Info ("User:      " + $env:USERNAME)
Info ("TEMP:      " + $env:TEMP)
Info ("Repo root: " + $RepoRoot)
Info ("Time:      " + (Get-Date).ToString("u"))
$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if ($elevated) { Ok "Running elevated (Administrator)" }
else { Warn "NOT elevated — overlay shows but full input lock may not engage (re-run as Administrator)" }

Section "Python launchers + overlay deps (Pillow + tkinter)"
# Order mirrors the Node agent: it prefers pythonw.exe, then python.exe, then py.
foreach ($cand in @("pythonw.exe", "python.exe", "py")) {
  $cmd = Get-Command $cand -ErrorAction SilentlyContinue
  if (-not $cmd) { Info ($cand + ": not found"); continue }
  $ver = (& $cand --version 2>&1) -join ' '
  # pythonw has no console; capture the import probe's result via exit code + a temp file.
  $probe = "import sys`ntry:`n import tkinter`n from PIL import Image, ImageTk`n open(sys.argv[1],'w').write('OK ' + Image.__name__)`nexcept Exception as e:`n open(sys.argv[1],'w').write('ERR ' + repr(e))`n raise"
  $probeFile = [System.IO.Path]::GetTempFileName()
  $tmpPy = [System.IO.Path]::GetTempFileName() + ".py"
  Set-Content -Path $tmpPy -Value $probe -Encoding UTF8
  & $cand $tmpPy $probeFile 2>$null | Out-Null
  $code = $LASTEXITCODE
  $res = ""
  if (Test-Path $probeFile) { $res = (Get-Content $probeFile -Raw).Trim() }
  Remove-Item $tmpPy, $probeFile -ErrorAction SilentlyContinue
  $exe = $cmd.Source
  if ($code -eq 0 -and $res -like "OK*") { Ok ($cand + "  (" + $ver + ")  [" + $exe + "]  Pillow+tkinter: OK") }
  else { Bad ($cand + "  (" + $ver + ")  [" + $exe + "]  Pillow+tkinter: MISSING -> " + $res) }
}
Info "If pythonw.exe is MISSING the deps but python.exe has them, install into pythonw's"
Info "environment:   pythonw.exe -m pip install pillow   (tkinter ships with python.org; the Microsoft Store build omits it)"

Section "Overlay script + agent_config"
if (Test-Path $OverlayScript) { Ok ("overlay script present: " + $OverlayScript) }
else { Bad ("overlay script MISSING: " + $OverlayScript) }
if (Test-Path $AgentConfig) {
  try {
    $cfg = Get-Content $AgentConfig -Raw | ConvertFrom-Json
    $key = [string]$cfg.api_key
    if ([string]::IsNullOrWhiteSpace($key) -or $key -eq "sk_pc_agent_CHANGE_ME") { Warn "agent_config.json api_key empty/placeholder" }
    else { $masked = if ($key.Length -gt 6) { $key.Substring(0,3) + "..." + $key.Substring($key.Length-3) } else { "***" }; Ok ("api_key present (" + $masked + ")") }
  } catch { Bad ("could not parse agent_config.json: " + $_.Exception.Message) }
} else { Bad ("agent_config.json not found: " + $AgentConfig) }

Section "Live projection files (%TEMP%)"
foreach ($p in @($FramePath, $HeartbeatPath)) {
  if (Test-Path $p) {
    $fi = Get-Item $p
    Info ("present: " + $p + "  (" + $fi.Length + " bytes, modified " + $fi.LastWriteTime.ToString("u") + ")")
  } else { Info ("absent:  " + $p) }
}

Section "Python agent on TCP $Port"
$listening = $false
try { if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $listening = $true } } catch { }
if (-not $listening) { try { $listening = (Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { } }
if ($listening) { Ok ("Python agent listening on TCP " + $Port) }
else { Warn ("nothing listening on TCP " + $Port + " — start it: python.exe " + (Join-Path $PyDir 'agent.py')) }

# Cross-check: ask the agent's own /overlay-log (proves the host path works too).
if ($listening -and (Test-Path $AgentConfig)) {
  try {
    $cfg = Get-Content $AgentConfig -Raw | ConvertFrom-Json
    $key = [string]$cfg.api_key
    if ($key) {
      $resp = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/overlay-log?lines={1}" -f $Port, $Lines) -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 8
      Ok ("GET /overlay-log OK — log.exists=" + $resp.log.exists + ", deps=" + (($resp.deps.PSObject.Properties | ForEach-Object { $_.Name + ($(if ($_.Value) {'+'} else {'-'})) }) -join ' '))
    }
  } catch { Warn ("GET /overlay-log failed locally: " + $_.Exception.Message) }
}

Section "Overlay log  ($LogPath)  — last $Lines lines"
if (Test-Path $LogPath) {
  $fi = Get-Item $LogPath
  Info ("size " + $fi.Length + " bytes, modified " + $fi.LastWriteTime.ToString("u"))
  Write-Host "----------------------------------------------------------------" -ForegroundColor DarkGray
  Get-Content $LogPath -Tail $Lines | ForEach-Object { Write-Host $_ }
  Write-Host "----------------------------------------------------------------" -ForegroundColor DarkGray
} else {
  Bad ("no overlay log at " + $LogPath)
  Info "The overlay never wrote here under THIS user's %TEMP%. Either it never launched,"
  Info "or the agent/overlay run as a different user (e.g. a session-0 service). Run the"
  Info "Node agent in the interactive desktop session, then start a projection and retry."
}

Write-Host ""
Write-Host "Done. Copy everything above back to the host to diagnose." -ForegroundColor Cyan
