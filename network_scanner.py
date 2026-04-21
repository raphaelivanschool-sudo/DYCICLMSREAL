"""
Network discovery module for detecting PCs on WiFi and LAN (Phase 1).

Dependencies:
  - scapy: ARP scanning (requires admin/root and, on Windows, Npcap)
  - psutil: interface enumeration
  - ping3: ICMP ping verification (may require elevated privileges on some OSes)

Usage example:

from network_scanner import NetworkScanner

scanner = NetworkScanner(debug=True)

local_net = scanner.get_local_network()
print(f"Local IP: {local_net['ip']}, Subnet: {local_net['subnet']}")

all_pcs = scanner.discover_all()
for pc in all_pcs:
    print(f\"{pc['hostname']} ({pc['ip']}) - {pc['connection_type']} - {pc['status']}\")

scanner.add_to_registry(\"GUEST-PC\", \"192.168.1.200\", \"AA:BB:CC:DD:EE:FF\", \"WiFi\")
"""

from __future__ import annotations

import dataclasses
import ipaddress
import json
import logging
import platform
import re
import socket
import subprocess
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


try:
    import psutil  # type: ignore
except Exception as e:  # pragma: no cover
    psutil = None  # type: ignore
    _PSUTIL_IMPORT_ERROR = e

try:
    from ping3 import ping  # type: ignore
except Exception as e:  # pragma: no cover
    ping = None  # type: ignore
    _PING3_IMPORT_ERROR = e

try:
    # scapy requires extra system deps on Windows (Npcap) and privileges on all OSes for ARP.
    from scapy.all import ARP, Ether, srp  # type: ignore
except Exception as e:  # pragma: no cover
    ARP = Ether = srp = None  # type: ignore
    _SCAPY_IMPORT_ERROR = e


DEFAULT_PING_TIMEOUT = 2.0
DEFAULT_ARP_TIMEOUT = 1.5
DEFAULT_MAX_WORKERS = 64
DEFAULT_CACHE_TTL_S = 10.0


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@dataclasses.dataclass(frozen=True)
class NetworkInterface:
    name: str
    ip: str
    netmask: str
    mac: str
    subnet: str  # CIDR


class NetworkScanner:
    """
    Main network scanner class.

    All returned devices use this structure:

    {
        "hostname": str,
        "ip": str,
        "mac": str,
        "status": "online" | "offline" | "unreachable",
        "connection_type": "WiFi" | "Ethernet" | "Unknown",
        "interface": str,
        "subnet": str,
        "last_seen": "YYYY-MM-DD HH:MM:SS",
        "source": "arp_scan" | "ping" | "manual_registry"
    }
    """

    def __init__(
        self,
        registry_path: str | Path = "registry.json",
        debug: bool = False,
        ping_timeout: float = DEFAULT_PING_TIMEOUT,
        arp_timeout: float = DEFAULT_ARP_TIMEOUT,
        max_workers: int = DEFAULT_MAX_WORKERS,
        interface_cache_ttl_s: float = DEFAULT_CACHE_TTL_S,
    ) -> None:
        self.registry_path = Path(registry_path)
        self.ping_timeout = float(ping_timeout)
        self.arp_timeout = float(arp_timeout)
        self.max_workers = int(max_workers)
        self.interface_cache_ttl_s = float(interface_cache_ttl_s)

        self.logger = logging.getLogger(self.__class__.__name__)
        self.set_debug(debug)

        self._iface_cache: Tuple[float, List[NetworkInterface]] = (0.0, [])

    def set_debug(self, enabled: bool) -> None:
        """Enable/disable debug logging for this scanner."""
        level = logging.DEBUG if enabled else logging.INFO
        self.logger.setLevel(level)
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)

    # -------------------------
    # Interface / network info
    # -------------------------

    def get_network_interfaces(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """
        Return list of active network interfaces with details.

        Uses psutil. Results are cached briefly to avoid repeated calls.
        """
        if psutil is None:
            raise RuntimeError(f"psutil is required but failed to import: {_PSUTIL_IMPORT_ERROR}")

        now = time.time()
        cached_at, cached = self._iface_cache
        if not force_refresh and cached and (now - cached_at) < self.interface_cache_ttl_s:
            return [dataclasses.asdict(i) for i in cached]

        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()

        interfaces: List[NetworkInterface] = []
        for name, addr_list in addrs.items():
            stat = stats.get(name)
            if stat is None or not stat.isup:
                continue

            ip = netmask = mac = ""
            for a in addr_list:
                # AF_LINK is platform-dependent; psutil uses psutil.AF_LINK when available
                if getattr(a, "family", None) == socket.AF_INET:
                    ip = a.address
                    netmask = a.netmask or ""
                elif str(getattr(a, "family", "")).endswith("AF_LINK") or getattr(a, "family", None) == getattr(psutil, "AF_LINK", object()):
                    mac = a.address or ""

            if not ip or ip.startswith("127."):
                continue

            try:
                if netmask:
                    subnet = str(ipaddress.IPv4Network((ip, netmask), strict=False))
                else:
                    subnet = str(ipaddress.IPv4Network(f"{ip}/24", strict=False))
            except Exception:
                subnet = str(ipaddress.IPv4Network(f"{ip}/24", strict=False))

            interfaces.append(NetworkInterface(name=name, ip=ip, netmask=netmask or "", mac=mac or "", subnet=subnet))

        self._iface_cache = (now, interfaces)
        self.logger.debug("Interfaces found: %d", len(interfaces))
        return [dataclasses.asdict(i) for i in interfaces]

    def get_connection_type(self, interface_name: str) -> str:
        """
        Identify if an interface is WiFi or Ethernet.
        Uses OS-specific heuristics (best-effort).
        """
        name = (interface_name or "").lower()
        # Fast path heuristics
        wifi_keywords = ("wi-fi", "wifi", "wlan", "wireless", "airport")
        eth_keywords = ("ethernet", "eth", "en", "lan")
        if any(k in name for k in wifi_keywords):
            return "WiFi"
        if any(k in name for k in eth_keywords):
            return "Ethernet"

        system = platform.system().lower()
        try:
            if system == "windows":
                # Use ipconfig to look for adapter name + "Wireless LAN adapter"
                out = subprocess.check_output(["ipconfig", "/all"], text=True, errors="ignore")
                # If the adapter section label contains Wireless, treat as WiFi
                # Adapter sections look like: "Wireless LAN adapter Wi-Fi:"
                pattern = re.compile(r"^(?P<label>.+adapter\s+(?P<adapter>.+)):\s*$", re.IGNORECASE | re.MULTILINE)
                for m in pattern.finditer(out):
                    label = m.group("label").lower()
                    adapter = m.group("adapter").strip()
                    if adapter.lower() == interface_name.lower() or adapter.lower() in name:
                        if "wireless" in label:
                            return "WiFi"
                        if "ethernet" in label:
                            return "Ethernet"
            elif system == "linux":
                # `ip link` shows "wl" (wifi) vs "en"/"eth"
                out = subprocess.check_output(["ip", "link"], text=True, errors="ignore")
                if re.search(rf"^\d+:\s*{re.escape(interface_name)}:.*$", out, re.MULTILINE):
                    if interface_name.startswith(("wl", "wlan")):
                        return "WiFi"
                    if interface_name.startswith(("en", "eth")):
                        return "Ethernet"
            elif system == "darwin":
                # macOS typically: en0 wifi, en1/others ethernet (not always)
                out = subprocess.check_output(["networksetup", "-listallhardwareports"], text=True, errors="ignore")
                # Hardware Port: Wi-Fi\nDevice: en0
                blocks = out.split("\n\n")
                for b in blocks:
                    if f"Device: {interface_name}" in b:
                        if "Wi-Fi" in b or "AirPort" in b:
                            return "WiFi"
                        if "Ethernet" in b:
                            return "Ethernet"
        except Exception:
            self.logger.debug("Connection type detection failed for %s", interface_name, exc_info=True)

        return "Unknown"

    def get_local_network(self) -> Dict[str, Any]:
        """
        Return Dict with local IP, subnet, gateway, active interfaces.
        """
        interfaces = self.get_network_interfaces()
        gateway = self._get_default_gateway()

        # Pick a primary interface (default route best-effort; otherwise first)
        primary = interfaces[0] if interfaces else {}
        result = {
            "ip": primary.get("ip", ""),
            "subnet": primary.get("subnet", ""),
            "gateway": gateway or "",
            "interfaces": interfaces,
        }
        return result

    def _get_default_gateway(self) -> Optional[str]:
        system = platform.system().lower()
        try:
            if system == "windows":
                out = subprocess.check_output(["route", "print", "0.0.0.0"], text=True, errors="ignore")
                # Look for line: 0.0.0.0  0.0.0.0  <gateway> ...
                for line in out.splitlines():
                    if line.strip().startswith("0.0.0.0"):
                        parts = line.split()
                        if len(parts) >= 3:
                            return parts[2]
            elif system == "linux":
                out = subprocess.check_output(["ip", "route"], text=True, errors="ignore")
                m = re.search(r"default\s+via\s+(\d+\.\d+\.\d+\.\d+)", out)
                if m:
                    return m.group(1)
            elif system == "darwin":
                out = subprocess.check_output(["route", "-n", "get", "default"], text=True, errors="ignore")
                m = re.search(r"gateway:\s+(\d+\.\d+\.\d+\.\d+)", out)
                if m:
                    return m.group(1)
        except Exception:
            self.logger.debug("Gateway detection failed", exc_info=True)
        return None

    # -------------------------
    # Discovery methods
    # -------------------------

    def scan_subnet(self, subnet: str) -> List[Dict[str, Any]]:
        """
        ARP scan results for a subnet across all active interfaces that match the subnet.

        Notes:
        - On Windows, Scapy requires Npcap (WinPcap is deprecated).
        - ARP scanning typically requires elevated privileges (admin/root).
        """
        if ARP is None or Ether is None or srp is None:
            raise RuntimeError(f"scapy is required but failed to import: {_SCAPY_IMPORT_ERROR}")

        subnet_net = ipaddress.ip_network(subnet, strict=False)
        if subnet_net.num_addresses > 65536:
            # Guardrail for very large networks; keep Phase 1 predictable.
            raise ValueError(f"Refusing to ARP scan very large subnet: {subnet}")

        interfaces = [NetworkInterface(**i) for i in self.get_network_interfaces()]
        matching = [i for i in interfaces if ipaddress.ip_address(i.ip) in subnet_net]
        if not matching:
            matching = interfaces  # best-effort

        start = time.time()
        found: List[Dict[str, Any]] = []

        for iface in matching:
            conn_type = self.get_connection_type(iface.name)
            self.logger.debug("ARP scanning %s on iface=%s", subnet, iface.name)
            try:
                packet = Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=str(subnet_net))
                answered, _ = srp(packet, iface=iface.name, timeout=self.arp_timeout, verbose=False)
            except PermissionError as e:
                self.logger.warning("ARP permission error on %s: %s", iface.name, e)
                continue
            except OSError as e:
                self.logger.warning("ARP OS error on %s: %s", iface.name, e)
                continue
            except Exception as e:
                self.logger.debug("ARP scan error on %s: %s", iface.name, e, exc_info=True)
                continue

            for _, received in answered:
                ip = getattr(received, "psrc", "") or ""
                mac = getattr(received, "hwsrc", "") or ""
                if not ip or ip.startswith("127."):
                    continue
                if ip == str(subnet_net.network_address) or ip == str(subnet_net.broadcast_address):
                    continue
                found.append(
                    {
                        "hostname": self._safe_reverse_dns(ip),
                        "ip": ip,
                        "mac": mac,
                        "status": "online",  # will be verified by ping
                        "connection_type": conn_type,
                        "interface": iface.name,
                        "subnet": iface.subnet,
                        "last_seen": _now_str(),
                        "source": "arp_scan",
                    }
                )

        elapsed = (time.time() - start) * 1000
        self.logger.debug("ARP scan completed in %dms, found=%d", int(elapsed), len(found))
        return found

    def ping_ip(self, ip: str, timeout: float = DEFAULT_PING_TIMEOUT) -> bool:
        """
        Boolean: is IP online?

        Primary: ping3 (ICMP via raw socket; may require privileges).
        Fallback: system `ping` command if ping3 isn't available.
        """
        timeout_s = float(timeout)

        if ping is not None:
            try:
                resp = ping(ip, timeout=timeout_s, unit="ms")
                return resp is not None
            except Exception:
                return False

        # Fallback: system ping (works without ping3 installed)
        system = platform.system().lower()
        try:
            if system == "windows":
                # -n 1: one echo request, -w timeout(ms)
                timeout_ms = max(1, int(timeout_s * 1000))
                proc = subprocess.run(
                    ["ping", "-n", "1", "-w", str(timeout_ms), ip],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                return proc.returncode == 0
            else:
                # Linux/macOS:
                # -c 1: one packet
                # Linux uses -W <seconds>, macOS uses -W <ms> (and -t for TTL).
                if system == "darwin":
                    timeout_ms = max(1, int(timeout_s * 1000))
                    proc = subprocess.run(
                        ["ping", "-c", "1", "-W", str(timeout_ms), ip],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                    return proc.returncode == 0
                proc = subprocess.run(
                    ["ping", "-c", "1", "-W", str(max(1, int(timeout_s))), ip],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                return proc.returncode == 0
        except Exception:
            return False

    def load_manual_registry(self, filepath: str | Path = "registry.json") -> List[Dict[str, Any]]:
        """Load manually-added PCs. Missing file is handled gracefully."""
        path = Path(filepath)
        if not path.exists():
            self.logger.debug("Manual registry missing: %s", path)
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            self.logger.warning("Failed to read registry: %s", path, exc_info=True)
            return []

        pcs = raw.get("manually_added_pcs", []) if isinstance(raw, dict) else []
        if not isinstance(pcs, list):
            return []

        out: List[Dict[str, Any]] = []
        for entry in pcs:
            if not isinstance(entry, dict):
                continue
            ip = str(entry.get("ip", "")).strip()
            if not ip or ip.startswith("127."):
                continue
            out.append(
                {
                    "hostname": str(entry.get("hostname", "Unknown")),
                    "ip": ip,
                    "mac": str(entry.get("mac", "")),
                    "status": "offline",  # will be verified by ping
                    "connection_type": str(entry.get("connection_type", "Unknown")) or "Unknown",
                    "interface": str(entry.get("interface", "")) or "",
                    "subnet": str(entry.get("subnet", "")) or "",
                    "last_seen": "",
                    "source": "manual_registry",
                }
            )
        return out

    def add_to_registry(
        self,
        hostname: str,
        ip: str,
        mac: str,
        connection_type: str,
        filepath: str | Path = "registry.json",
    ) -> None:
        """Add a PC to the manual registry JSON."""
        path = Path(filepath)
        data: Dict[str, Any] = {"manually_added_pcs": []}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                data = {"manually_added_pcs": []}
        pcs = data.get("manually_added_pcs")
        if not isinstance(pcs, list):
            pcs = []
            data["manually_added_pcs"] = pcs

        pcs.append(
            {
                "hostname": hostname,
                "ip": ip,
                "mac": mac,
                "connection_type": connection_type,
            }
        )
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def discover_all(self) -> List[Dict[str, Any]]:
        """
        Run all detection methods and consolidate results.

        - Multi-interface: scans each active interface subnet.
        - Deduplicates by IP, preferring arp_scan > ping > manual_registry.
        - Verifies hosts via ping (short timeout) to avoid hangs.
        """
        start = time.time()
        errors: List[str] = []

        interfaces_raw = []
        try:
            interfaces_raw = self.get_network_interfaces()
        except Exception as e:
            errors.append(f"interfaces_error: {e}")

        interfaces = [NetworkInterface(**i) for i in interfaces_raw] if interfaces_raw else []
        subnets = sorted({i.subnet for i in interfaces if i.subnet})

        manual = self.load_manual_registry(self.registry_path)

        arp_results: List[Dict[str, Any]] = []
        for subnet in subnets:
            try:
                arp_results.extend(self.scan_subnet(subnet))
            except Exception as e:
                # Do not fail entire discovery if ARP isn't available
                self.logger.debug("ARP scan failed for %s: %s", subnet, e, exc_info=True)
                errors.append(f"arp_scan_error[{subnet}]: {e}")

        # Consolidate candidates
        by_ip: Dict[str, Dict[str, Any]] = {}
        source_rank = {"arp_scan": 3, "ping": 2, "manual_registry": 1}

        def merge(dev: Dict[str, Any]) -> None:
            ip = str(dev.get("ip", "")).strip()
            if not ip:
                return
            existing = by_ip.get(ip)
            if not existing:
                by_ip[ip] = dev
                return
            if source_rank.get(dev.get("source", ""), 0) > source_rank.get(existing.get("source", ""), 0):
                merged = dict(existing)
                merged.update({k: v for k, v in dev.items() if v not in ("", None)})
                by_ip[ip] = merged
            else:
                merged = dict(dev)
                merged.update({k: v for k, v in existing.items() if v not in ("", None)})
                by_ip[ip] = merged

        for d in manual:
            merge(d)
        for d in arp_results:
            merge(d)

        # Ping verification (for status and last_seen)
        def verify(ip: str) -> Tuple[str, bool]:
            return ip, self.ping_ip(ip, timeout=self.ping_timeout)

        ips = list(by_ip.keys())
        with ThreadPoolExecutor(max_workers=min(self.max_workers, max(4, len(ips) or 4))) as ex:
            futures = [ex.submit(verify, ip) for ip in ips]
            for fut in as_completed(futures):
                ip, ok = fut.result()
                dev = by_ip.get(ip)
                if not dev:
                    continue
                if ok:
                    dev["status"] = "online"
                    dev["last_seen"] = _now_str()
                else:
                    dev["status"] = "unreachable" if dev.get("source") == "arp_scan" else "offline"

                if not dev.get("hostname") or dev.get("hostname") == "Unknown":
                    dev["hostname"] = self._safe_reverse_dns(ip)

                if dev.get("connection_type") in ("", None, "Unknown"):
                    iface_name = dev.get("interface") or ""
                    if iface_name:
                        dev["connection_type"] = self.get_connection_type(str(iface_name))

        elapsed_ms = int((time.time() - start) * 1000)
        self.logger.debug("discover_all completed in %dms, hosts=%d", elapsed_ms, len(by_ip))
        if errors:
            self.logger.debug("Discovery non-fatal errors: %s", errors)

        # Ensure required keys exist
        out: List[Dict[str, Any]] = []
        for ip, dev in by_ip.items():
            dev.setdefault("hostname", "Unknown")
            dev.setdefault("mac", "")
            dev.setdefault("status", "offline")
            dev.setdefault("connection_type", "Unknown")
            dev.setdefault("interface", dev.get("interface", ""))
            dev.setdefault("subnet", dev.get("subnet", ""))
            dev.setdefault("last_seen", dev.get("last_seen", ""))
            dev.setdefault("source", dev.get("source", "ping"))
            dev["ip"] = ip
            out.append(dev)

        out.sort(key=lambda d: ipaddress.ip_address(d["ip"]))
        return out

    # -------------------------
    # Helpers
    # -------------------------

    def _safe_reverse_dns(self, ip: str) -> str:
        try:
            socket.setdefaulttimeout(self.ping_timeout)
            host, _, _ = socket.gethostbyaddr(ip)
            return host or "Unknown"
        except Exception:
            return "Unknown"
        finally:
            socket.setdefaulttimeout(None)

