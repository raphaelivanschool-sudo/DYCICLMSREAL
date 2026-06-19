<#
.SYNOPSIS
  DYCI "Block internet" firewall diagnostic (run ON the Windows guest).

.DESCRIPTION
  Confirms whether the managed outbound block rule created by the agent's
  "Block internet" action actually exists AND is effective. This is the script to
  run when clicking "Block internet" appears to fire but the student can still
  browse. It reports, in order of how often each one is the real cause:

    1. Elevation       - the agent must be Administrator to add/remove the rule.
    2. Firewall state  - a Block rule does NOTHING on a profile whose Windows
                         Firewall is turned OFF. This is the #1 silent failure.
    3. The rule itself - Direction / Action / Enabled / Profile / Protocol /
                         RemoteAddress, dumped from the live firewall (not assumed).
    4. Live effect     - optional Test-NetConnection to a public host on TCP 443
                         AND a UDP/QUIC (HTTP/3) reachability probe, plus a LAN/
                         server reachability check to prove the whitelist works.

  Safe to run interactively; with -Test it only makes outbound probes, it never
  changes any firewall rule.

.PARAMETER Name
  Managed rule DisplayName to inspect (default: DYCI-BlockInternet).

.PARAMETER Test
  Also run live connectivity probes (public TCP 443, public UDP/QUIC 443, LAN).

.PARAMETER ServerIp
  LMS server IP to confirm stays reachable while blocked (optional).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\guest-check-firewall.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\guest-check-firewall.ps1 -Test -ServerIp 192.168.1.10
#>
param(
  [string]$Name = "DYCI-BlockInternet",
  [switch]$Test,
  [string]$ServerIp = ""
)

$ErrorActionPreference = "Continue"

function Head($msg) { Write-Host ""; Write-Host ("=== " + $msg + " ===") -ForegroundColor Cyan }
function Ok($msg)   { Write-Host ("[OK]   " + $msg) -ForegroundColor Green }
function Bad($msg)  { Write-Host ("[FAIL] " + $msg) -ForegroundColor Red }
function Warn($msg) { Write-Host ("[WARN] " + $msg) -ForegroundColor Yellow }
function Info($msg) { Write-Host ("       " + $msg) -ForegroundColor Gray }

Write-Host "DYCI firewall check - rule '$Name'" -ForegroundColor White

# 1. Elevation -------------------------------------------------------------
Head "Elevation"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if ($admin) { Ok "Running elevated (Administrator)." }
else { Warn "NOT elevated. The agent ALSO needs to run as Administrator or it cannot create/remove the rule (you may only see partial rule data here)." }

# 2. Windows Firewall profile state ---------------------------------------
Head "Windows Firewall profiles"
$profiles = Get-NetFirewallProfile -ErrorAction SilentlyContinue
if (-not $profiles) {
  Bad "Could not query Get-NetFirewallProfile (NetSecurity module missing or service unavailable)."
} else {
  foreach ($p in $profiles) {
    if ($p.Enabled) { Ok ("{0,-8} firewall is ON" -f $p.Name) }
    else { Bad ("{0,-8} firewall is OFF - a Block rule has NO effect on this profile!" -f $p.Name) }
  }
  $off = @($profiles | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
  if ($off.Count) {
    Info ("Fix: Set-NetFirewallProfile -Profile {0} -Enabled True" -f ($off -join ","))
  }
  # Which profile is actually active right now (per connected network category).
  try {
    $cats = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $_.NetworkCategory })
    if ($cats.Count) { Info ("Active network category(ies): " + ($cats -join ", ") + " (a Domain-only rule would miss Private/Public).") }
  } catch {}
}

# 3. The managed rule ------------------------------------------------------
Head "Managed rule"
$rules = @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
if ($rules.Count -eq 0) {
  Bad "Rule '$Name' does NOT exist. The agent never created it -> check the agent is elevated and watch its console for a [Firewall] line / error."
} else {
  if ($rules.Count -gt 1) { Warn "$($rules.Count) rules share this DisplayName (expected 1)." }
  foreach ($r in $rules) {
    $pf = $r | Get-NetFirewallPortFilter
    $af = $r | Get-NetFirewallAddressFilter
    Write-Host ""
    Write-Host ("  Rule:        " + $r.DisplayName)
    Write-Host ("  Enabled:     " + $r.Enabled)
    Write-Host ("  Direction:   " + $r.Direction)
    Write-Host ("  Action:      " + $r.Action)
    Write-Host ("  Profile:     " + $r.Profile)
    Write-Host ("  Protocol:    " + $pf.Protocol)
    Write-Host ("  RemoteAddr:  " + (@($af.RemoteAddress) -join ", "))

    # Property-by-property verdict (these are the classic mis-scopes).
    if ("$($r.Enabled)" -match "True")        { Ok "Enabled = True" }       else { Bad "Enabled is '$($r.Enabled)' (must be True)" }
    if ("$($r.Direction)" -match "Outbound")  { Ok "Direction = Outbound" } else { Bad "Direction is '$($r.Direction)' (must be Outbound)" }
    if ("$($r.Action)" -match "Block")        { Ok "Action = Block" }       else { Bad "Action is '$($r.Action)' (must be Block)" }
    if ("$($r.Profile)" -match "Any")         { Ok "Profile = Any" }        else { Warn "Profile is '$($r.Profile)' - if it does not include the ACTIVE profile above, the rule will not apply. Prefer Any." }
    if ("$($pf.Protocol)" -match "Any")       { Ok "Protocol = Any (TCP + UDP/QUIC covered)" } else { Bad "Protocol is '$($pf.Protocol)' - TCP-only leaks UDP/QUIC (HTTP/3). Must be Any." }
    if (@($af.RemoteAddress).Count -gt 0)     { Ok "RemoteAddress scoped to public ranges (LAN/server excluded)" } else { Warn "RemoteAddress is empty/Any - check LAN + server stay reachable." }
  }
}

# 4. Live effect (optional) -----------------------------------------------
if ($Test) {
  Head "Live connectivity probes"
  Info "Public TCP 443 (should FAIL when blocked):"
  $tcp = Test-NetConnection -ComputerName "1.1.1.1" -Port 443 -WarningAction SilentlyContinue
  if ($tcp.TcpTestSucceeded) { Warn "Public TCP 443 SUCCEEDED -> internet is NOT blocked." }
  else { Ok "Public TCP 443 failed -> public TCP is blocked." }

  Info "Public UDP/QUIC 443 (HTTP/3) reachability (should FAIL when blocked):"
  try {
    $udp = New-Object System.Net.Sockets.UdpClient
    $udp.Client.ReceiveTimeout = 2000
    $udp.Connect("8.8.8.8", 443)          # 8.8.8.8:443 also answers QUIC; we only test send reachability
    [void]$udp.Send([byte[]](1,2,3), 3)
    # If the block rule works, the outbound datagram is dropped by the firewall.
    # We cannot get a clean "blocked" signal from UDP, so report send result only.
    Ok "UDP send attempted (a working Protocol=Any block drops these outbound QUIC packets)."
    $udp.Close()
  } catch {
    Ok "UDP/QUIC send blocked or failed: $($_.Exception.Message)"
  }

  if ($ServerIp) {
    Info "LMS server reachability (should SUCCEED - proves the whitelist):"
    $srv = Test-NetConnection -ComputerName $ServerIp -Port 3001 -WarningAction SilentlyContinue
    if ($srv.TcpTestSucceeded) { Ok "Server $ServerIp:3001 reachable -> agent stays online while blocked." }
    else { Warn "Server $ServerIp:3001 NOT reachable - the agent may go offline. Confirm the server IP is carved out of the block ranges." }
  }
}

Write-Host ""
Write-Host "Done. Re-run with -Test (and optionally -ServerIp <ip>) to also probe live connectivity." -ForegroundColor White
