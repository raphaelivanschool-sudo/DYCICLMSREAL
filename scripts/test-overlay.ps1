<#
.SYNOPSIS
  Standalone locked-overlay test (run ON the Windows guest). No server, no network.

.DESCRIPTION
  Validates the overlay itself — "can it render a frame, ENGAGE the input lock,
  and tear down cleanly on THIS machine" — in isolation from the network frame
  path. It:
    1. generates a static test JPEG locally (the pinned wire format: a real JPEG),
    2. launches projection_overlay.py in --locked-test mode, which:
         * covers every monitor, always-on-top, borderless,
         * engages the REAL global keyboard+mouse lock,
         * renders the test image (letterboxed),
    3. tears down and restores input three ways (any of them is enough):
         * press ESC          (the documented kill key / escape hatch),
         * wait for auto-close (-Seconds, default 15),
         * Ctrl+Alt+Del       (OS-level, always available — last resort).

  Run elevated (Administrator) to exercise the full input lock. Without elevation
  the window still covers the screen but the lock may be partial — that is expected.

  This uses python.exe (a console) so any error is visible; the production launcher
  is pythonw.exe. It auto-selects the first interpreter where Pillow + tkinter
  import, mirroring how the Node agent picks one.

.PARAMETER Seconds
  Hard auto-close timeout while locked (default 15).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\test-overlay.ps1
  powershell -ExecutionPolicy Bypass -File scripts\test-overlay.ps1 -Seconds 20
#>
param(
  [double]$Seconds = 15
)

$ErrorActionPreference = "Stop"

function Ok($m)   { Write-Host ("[OK]   " + $m) -ForegroundColor Green }
function Bad($m)  { Write-Host ("[FAIL] " + $m) -ForegroundColor Red }
function Warn($m) { Write-Host ("[WARN] " + $m) -ForegroundColor Yellow }
function Info($m) { Write-Host ("       " + $m) -ForegroundColor Gray }

# scripts/ -> repo root
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PyDir = Join-Path $RepoRoot "agent\pc-agent\python"
$OverlayScript = Join-Path $PyDir "projection_overlay.py"
$FramePath = Join-Path $env:TEMP "dyci_overlay_test.jpg"
$HeartbeatPath = Join-Path $env:TEMP "dyci_overlay_test.alive"
$LogPath = Join-Path $env:TEMP "dyci_projection_overlay.log"

Write-Host "==== DYCI standalone locked-overlay test ====" -ForegroundColor Cyan

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if ($elevated) { Ok "Elevated — full input lock will engage" }
else { Warn "Not elevated — overlay covers screen but the lock may be partial (re-run as Administrator for the full test)" }

if (-not (Test-Path $OverlayScript)) { Bad ("overlay script missing: " + $OverlayScript); exit 1 }
Ok ("overlay script: " + $OverlayScript)

# Pick the first interpreter where Pillow + tkinter import (mirrors the Node agent).
$PyCmd = $null
foreach ($cand in @("python.exe", "python", "py")) {
  if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
  & $cand -c "import tkinter; from PIL import Image, ImageTk" 2>$null
  if ($LASTEXITCODE -eq 0) { $PyCmd = $cand; break }
}
if (-not $PyCmd) {
  Bad "No Python with Pillow + tkinter found. Install:  python.exe -m pip install pillow  (tkinter ships with the python.org installer)."
  exit 1
}
Ok ("Python (Pillow+tkinter OK): " + $PyCmd)

# 1) Generate a static test JPEG locally (a real JPEG — the pinned wire format).
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 1280, 720
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(18, 28, 58))
  $fBig = New-Object System.Drawing.Font("Segoe UI", 40, [System.Drawing.FontStyle]::Bold)
  $fMid = New-Object System.Drawing.Font("Segoe UI", 22)
  $white = [System.Drawing.Brushes]::White
  $amber = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Gold)
  $g.DrawString("DYCI OVERLAY TEST", $fBig, $white, 80, 250)
  $g.DrawString((Get-Date).ToString("u"), $fMid, $white, 82, 330)
  $g.DrawString("Press ESC to exit  (auto-closes in $Seconds s)", $fMid, $amber, 82, 380)
  $g.DrawString("If the screen is filled and input is blocked, the overlay works.", $fMid, $white, 82, 430)
  $g.Dispose()
  $bmp.Save($FramePath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()
  Ok ("test frame written: " + $FramePath + "  (" + (Get-Item $FramePath).Length + " bytes)")
} catch {
  Bad ("could not generate test JPEG: " + $_.Exception.Message); exit 1
}

# Heartbeat is required by the overlay CLI but the watchdog is skipped in locked-test.
Set-Content -Path $HeartbeatPath -Value ([string][int][double](Get-Date -UFormat %s)) -ErrorAction SilentlyContinue

Write-Host ""
Warn "The screen is about to be COVERED and input LOCKED."
Info ("Exit any of: ESC  |  wait $Seconds s (auto-close)  |  Ctrl+Alt+Del (last resort).")
Write-Host ""
Start-Sleep -Seconds 1

# 2) Launch the overlay in locked-test mode (real lock, ESC kill key, hard auto-close).
& $PyCmd $OverlayScript `
  --frame $FramePath `
  --heartbeat $HeartbeatPath `
  --locked-test-seconds $Seconds `
  --exit-key 27
$code = $LASTEXITCODE

# 3) Cleanup + verdict (input is already restored when the overlay process exits).
Remove-Item $HeartbeatPath -ErrorAction SilentlyContinue
Remove-Item $FramePath -ErrorAction SilentlyContinue

Write-Host ""
if ($code -eq 0) {
  Ok "Overlay rendered, locked, and tore down cleanly. Input restored."
  Info "If you saw the test image full-screen and could not click/type underneath, the overlay is GOOD."
  exit 0
} else {
  Bad ("Overlay exited with code " + $code + ".")
  if (Test-Path $LogPath) { Info ("See the log: " + $LogPath); Write-Host "---- last 30 log lines ----" -ForegroundColor DarkGray; Get-Content $LogPath -Tail 30 | ForEach-Object { Write-Host $_ } }
  else { Info ("No log at " + $LogPath) }
  exit 1
}
