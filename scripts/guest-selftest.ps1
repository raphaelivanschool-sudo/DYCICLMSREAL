<#
.SYNOPSIS
  DYCI lab-agent guest self-test (run ON the Windows guest, e.g. 192.168.1.193).

.DESCRIPTION
  Validates everything the macOS host needs from this guest for "Refresh
  screenshot" and "Project to this PC":
    * Python + the real deps (mss, Pillow, tkinter; pywin32 only for service mode)
    * Python agent listening on TCP 5555 and inbound firewall rule
    * api_key present (masked) and optionally matching the server's
    * a real mss/Pillow test capture
    * an overlay dry-run (no input lock — safe to run interactively)

  NOTE: the projection overlay uses tkinter + Pillow + ctypes. PyQt5/pygame are
  NOT required. pywin32 is only needed to run the agent as a Windows service.

  Run elevated (Administrator) to also confirm the input-lock path is ready.

.PARAMETER ExpectedApiKey
  The api_key configured on the SERVER (PC_AGENT_API_KEY). If provided, the
  script checks it matches the guest's agent_config.json.

.PARAMETER Port
  Python agent port (default 5555).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\guest-selftest.ps1 -ExpectedApiKey "sk_pc_agent_xxx"
#>
param(
  [string]$ExpectedApiKey = "",
  [int]$Port = 5555
)

$ErrorActionPreference = "Continue"
$script:Pass = 0
$script:Fail = 0
$script:Warn = 0

function Ok($msg)   { Write-Host ("[OK]   " + $msg) -ForegroundColor Green; $script:Pass++ }
function Bad($msg)  { Write-Host ("[FAIL] " + $msg) -ForegroundColor Red;   $script:Fail++ }
function Warn($msg) { Write-Host ("[WARN] " + $msg) -ForegroundColor Yellow; $script:Warn++ }
function Info($msg) { Write-Host ("       " + $msg) -ForegroundColor Gray }

# Resolve repo paths relative to this script (scripts/ -> repo root).
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PyDir = Join-Path $RepoRoot "agent\pc-agent\python"
$AgentConfig = Join-Path $PyDir "agent_config.json"
$OverlayScript = Join-Path $PyDir "projection_overlay.py"

Write-Host "==== DYCI guest self-test ====" -ForegroundColor Cyan
Info ("Repo root:   " + $RepoRoot)
$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if ($elevated) { Ok "Running elevated (Administrator) — full input lock can engage" }
else { Warn "Not elevated — overlay will show but input lock may not fully engage (re-run as Administrator)" }

# 1) Python launcher
$PyCmd = $null
foreach ($cand in @("python.exe", "python", "py")) {
  $v = & $cand --version 2>&1
  if ($LASTEXITCODE -eq 0) { $PyCmd = $cand; break }
}
if ($PyCmd) { Ok ("Python found: " + $PyCmd + " (" + ($v -join ' ') + ")") }
else { Bad "Python not found on PATH (install Python 3 + Pillow + mss)"; }

$PyWCmd = $null
foreach ($cand in @("pythonw.exe", "pythonw")) {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $PyWCmd = $cand; break }
}
if ($PyWCmd) { Ok ("pythonw found (no-console overlay launcher): " + $PyWCmd) }
else { Warn "pythonw.exe not found — the Node agent will fall back to python.exe (a console may flash)" }

# 2) Required Python deps
if ($PyCmd) {
  $deps = @{ "mss" = "mss"; "Pillow" = "PIL"; "tkinter" = "tkinter" }
  foreach ($label in $deps.Keys) {
    & $PyCmd -c ("import " + $deps[$label]) 2>$null
    if ($LASTEXITCODE -eq 0) { Ok ("Python dep importable: " + $label) }
    else {
      if ($label -eq "mss") { Warn "mss not installed (pip install mss) — capture falls back to Pillow" }
      else { Bad ("Required Python dep MISSING: " + $label) }
    }
  }
  & $PyCmd -c "import win32api" 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "pywin32 importable (needed only for Windows-service mode)" }
  else { Info "pywin32 not installed (only needed to run the agent as a Windows service)" }
}

# 3) Python agent listening on 5555
$listening = $false
try {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($conns) { $listening = $true }
} catch { }
if (-not $listening) {
  try { $listening = (Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { }
}
if ($listening) { Ok ("Python agent is listening on TCP " + $Port) }
else { Bad ("Nothing listening on TCP " + $Port + " — start the Python agent: " + $PyCmd + " agent\pc-agent\python\agent.py") }

# 4) Firewall inbound rule for the port
$fwOk = $false
try {
  $rules = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq "$Port" } |
    ForEach-Object { $_ | Get-NetFirewallRule -ErrorAction SilentlyContinue } |
    Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
  if ($rules) { $fwOk = $true }
} catch { }
if ($fwOk) { Ok ("Inbound firewall rule allows TCP " + $Port) }
else { Warn ("No explicit inbound Allow rule for TCP " + $Port + ". If the host cannot reach it, add one:`n       New-NetFirewallRule -DisplayName 'DYCI Agent 5555' -Direction Inbound -Action Allow -Protocol TCP -LocalPort " + $Port) }

# 5) api_key present + (optional) match
if (Test-Path $AgentConfig) {
  try {
    $cfg = Get-Content $AgentConfig -Raw | ConvertFrom-Json
    $key = [string]$cfg.api_key
    if ([string]::IsNullOrWhiteSpace($key) -or $key -eq "sk_pc_agent_CHANGE_ME") {
      Bad "agent_config.json api_key is empty or still the placeholder — set a real key"
    } else {
      $masked = if ($key.Length -gt 6) { $key.Substring(0,3) + "..." + $key.Substring($key.Length-3) } else { "***" }
      Ok ("agent_config.json api_key present (" + $masked + ")")
      if ($ExpectedApiKey -ne "") {
        if ($ExpectedApiKey -eq $key) { Ok "api_key MATCHES the server value you passed" }
        else { Bad "api_key does NOT match the server value (-ExpectedApiKey) — projection/screenshot will be rejected" }
      } else {
        Info "Pass -ExpectedApiKey '<server PC_AGENT_API_KEY>' to verify it matches the server"
      }
    }
  } catch { Bad ("Could not parse " + $AgentConfig + ": " + $_.Exception.Message) }
} else {
  Bad ("agent_config.json not found at " + $AgentConfig)
}

# 6) Real mss/Pillow test capture
if ($PyCmd) {
  $cap = & $PyCmd -c @"
import sys
try:
    try:
        import mss
        from PIL import Image
        with mss.mss() as s:
            m=s.monitors[0]; img=s.grab(m)
        print('OK mss %dx%d' % (img.size[0], img.size[1]))
    except Exception:
        from PIL import ImageGrab
        im=ImageGrab.grab(all_screens=True)
        print('OK PIL %dx%d' % im.size)
except Exception as e:
    print('ERR '+str(e)); sys.exit(1)
"@ 2>&1
  if ($LASTEXITCODE -eq 0) { Ok ("Test screen capture succeeded: " + ($cap -join ' ')) }
  else { Bad ("Test screen capture FAILED: " + ($cap -join ' ')) }
}

# 7) Overlay dry-run (no input lock; auto-closes)
if ($PyCmd -and (Test-Path $OverlayScript)) {
  Ok ("Overlay script present: " + $OverlayScript)
  $frame = Join-Path $env:TEMP "dyci_selftest_frame.jpg"
  $hb = Join-Path $env:TEMP "dyci_selftest.alive"
  Set-Content -Path $hb -Value "1" -ErrorAction SilentlyContinue
  & $PyCmd $OverlayScript --frame $frame --heartbeat $hb --selftest-seconds 1 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "Overlay dry-run launched + closed cleanly (tkinter/Pillow OK)" }
  else { Bad "Overlay dry-run failed — see %TEMP%\dyci_projection_overlay.log" }
  Remove-Item $hb -ErrorAction SilentlyContinue
} elseif ($PyCmd) {
  Bad ("Overlay script missing at " + $OverlayScript)
}

Write-Host ""
Write-Host ("==== Summary: " + $script:Pass + " passed, " + $script:Fail + " failed, " + $script:Warn + " warnings ====") -ForegroundColor Cyan
if ($script:Fail -gt 0) { Write-Host "Result: NOT READY — fix the [FAIL] items above." -ForegroundColor Red; exit 1 }
else { Write-Host "Result: READY for screenshot + projection." -ForegroundColor Green; exit 0 }
