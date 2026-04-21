#!/usr/bin/env python3
import argparse
import concurrent.futures
import ipaddress
import json
import os
import platform
import socket
import time
from typing import Dict, List, Optional, Tuple

from ping3 import ping
from scapy.all import ARP, Ether, srp  # type: ignore


DEFAULT_TIMEOUT = 1.0
DEFAULT_WORKERS = 32


class NetworkScanner:
    def __init__(self, registry_path: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT):
        self.timeout = timeout
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.registry_path = registry_path or os.path.join(base_dir, "registry.json")
        self.warnings: List[str] = []

    def _guess_connection_type(self) -> str:
        names = [name.lower() for name in socket.if_nameindex() and [n[1] for n in socket.if_nameindex()] or []]
        joined = " ".join(names)
        if any(k in joined for k in ("wi-fi", "wifi", "wlan", "wireless")):
            return "wifi"
        if any(k in joined for k in ("ethernet", "en", "eth", "lan")):
            return "lan"
        return "unknown"

    def _resolve_hostname(self, ip: str) -> str:
        default_hostname = "Unknown"
        try:
            socket.setdefaulttimeout(self.timeout)
            host, _, _ = socket.gethostbyaddr(ip)
            return host or default_hostname
        except Exception:
            return default_hostname
        finally:
            socket.setdefaulttimeout(None)

    def _normalize_result(
        self,
        hostname: Optional[str],
        ip: str,
        mac: Optional[str],
        status: str = "unknown",
        connection_type: str = "unknown",
    ) -> Dict[str, str]:
        return {
            "hostname": hostname or "Unknown",
            "ip": ip,
            "mac": mac or "",
            "status": status,
            "connection_type": connection_type,
        }

    def get_local_network(self) -> str:
        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
            ip_obj = ipaddress.ip_address(local_ip)
            if ip_obj.is_loopback:
                raise ValueError("resolved loopback address")
            network = ipaddress.ip_network(f"{local_ip}/24", strict=False)
            return str(network)
        except Exception:
            probe_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                probe_sock.connect(("8.8.8.8", 80))
                local_ip = probe_sock.getsockname()[0]
                network = ipaddress.ip_network(f"{local_ip}/24", strict=False)
                return str(network)
            finally:
                probe_sock.close()

    def scan_subnet(self, subnet: str) -> List[Dict[str, str]]:
        connection_type = self._guess_connection_type()
        try:
            arp = ARP(pdst=subnet)
            ether = Ether(dst="ff:ff:ff:ff:ff:ff")
            packet = ether / arp
            answered = srp(packet, timeout=self.timeout, verbose=False)[0]
        except PermissionError as error:
            self.warnings.append(f"ARP scan permission error: {error}")
            return []
        except OSError as error:
            self.warnings.append(f"ARP scan failed (Npcap/admin might be required): {error}")
            return []
        except Exception as error:
            self.warnings.append(f"ARP scan error: {error}")
            return []

        devices: List[Dict[str, str]] = []
        for _, received in answered:
            ip = getattr(received, "psrc", "")
            mac = getattr(received, "hwsrc", "")
            if not ip:
                continue
            hostname = self._resolve_hostname(ip)
            devices.append(
                self._normalize_result(
                    hostname=hostname,
                    ip=ip,
                    mac=mac,
                    status="online",
                    connection_type=connection_type,
                )
            )
        return devices

    def ping_ip(self, ip: str) -> bool:
        try:
            response = ping(ip, timeout=self.timeout, unit="ms")
            return response is not None
        except PermissionError:
            return False
        except Exception:
            return False

    def load_manual_registry(self) -> List[Dict[str, str]]:
        if not os.path.exists(self.registry_path):
            self.warnings.append(f"Manual registry not found: {self.registry_path}")
            return []

        try:
            with open(self.registry_path, "r", encoding="utf-8") as registry_file:
                raw = json.load(registry_file)
        except Exception as error:
            self.warnings.append(f"Failed to read registry file: {error}")
            return []

        entries = raw.get("devices", raw) if isinstance(raw, dict) else raw
        if not isinstance(entries, list):
            self.warnings.append("Registry format is invalid; expected array or { devices: [] }.")
            return []

        normalized: List[Dict[str, str]] = []
        for entry in entries:
            if isinstance(entry, str):
                ip = entry.strip()
                if ip:
                    normalized.append(
                        self._normalize_result(
                            hostname="Unknown",
                            ip=ip,
                            mac="",
                            status="unknown",
                            connection_type="manual",
                        )
                    )
            elif isinstance(entry, dict):
                ip = str(entry.get("ip", "")).strip()
                if ip:
                    normalized.append(
                        self._normalize_result(
                            hostname=str(entry.get("hostname", "Unknown")),
                            ip=ip,
                            mac=str(entry.get("mac", "")),
                            status=str(entry.get("status", "unknown")),
                            connection_type=str(entry.get("connection_type", "manual")),
                        )
                    )
        return normalized

    def _verify_device(self, device: Dict[str, str]) -> Dict[str, str]:
        ip = device.get("ip", "")
        if not ip:
            return device

        is_online = self.ping_ip(ip)
        verified = dict(device)
        verified["status"] = "online" if is_online else (device.get("status") or "offline")
        if verified.get("hostname", "Unknown") == "Unknown":
            verified["hostname"] = self._resolve_hostname(ip)
        return verified

    def discover_all(self, subnet: Optional[str] = None, registry_only: bool = False) -> Dict[str, object]:
        start = time.time()
        self.warnings = []
        chosen_subnet = subnet or self.get_local_network()

        candidates: Dict[str, Dict[str, str]] = {}
        for entry in self.load_manual_registry():
            candidates[entry["ip"]] = entry

        if not registry_only:
            for entry in self.scan_subnet(chosen_subnet):
                if entry["ip"] in candidates:
                    merged = dict(candidates[entry["ip"]])
                    merged.update({k: v for k, v in entry.items() if v})
                    candidates[entry["ip"]] = merged
                else:
                    candidates[entry["ip"]] = entry

        discovered: List[Dict[str, str]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=DEFAULT_WORKERS) as executor:
            futures = [executor.submit(self._verify_device, d) for d in candidates.values()]
            for future in concurrent.futures.as_completed(futures):
                try:
                    discovered.append(future.result(timeout=self.timeout + 1.0))
                except Exception as error:
                    self.warnings.append(f"Verification timeout/error: {error}")

        discovered.sort(key=lambda item: item.get("ip", ""))
        return {
            "ok": True,
            "subnet": chosen_subnet,
            "platform": platform.system(),
            "warnings": self.warnings,
            "discovered": discovered,
            "elapsed_ms": int((time.time() - start) * 1000),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Discover PCs on local subnet")
    parser.add_argument("--subnet", help="Subnet CIDR to scan (e.g. 192.168.1.0/24)")
    parser.add_argument("--registry", help="Path to manual registry JSON")
    parser.add_argument("--registry-only", action="store_true", help="Skip ARP scan and only use registry entries")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Timeout in seconds")
    args = parser.parse_args()

    scanner = NetworkScanner(registry_path=args.registry, timeout=args.timeout)
    try:
        result = scanner.discover_all(subnet=args.subnet, registry_only=args.registry_only)
        print(json.dumps(result))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Discovery failed",
                    "details": str(error),
                    "warnings": scanner.warnings,
                    "discovered": [],
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
