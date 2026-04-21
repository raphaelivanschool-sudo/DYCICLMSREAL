from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class KnownPC:
    hostname: str
    ip: str
    api_key: str = ""
    connection_type: str = "Unknown"
    last_seen: str = ""

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "KnownPC":
        return KnownPC(
            hostname=str(d.get("hostname") or "Unknown"),
            ip=str(d.get("ip") or "").strip(),
            api_key=str(d.get("api_key") or ""),
            connection_type=str(d.get("connection_type") or "Unknown"),
            last_seen=str(d.get("last_seen") or ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "hostname": self.hostname,
            "ip": self.ip,
            "api_key": self.api_key,
            "connection_type": self.connection_type,
            "last_seen": self.last_seen,
        }


@dataclass
class ControllerConfig:
    """
    Persistent config for the desktop controller.

    Notes:
    - API keys are stored in plaintext for now (future: encrypt at rest).
    - Do not log API keys.
    """

    path: str = "controller_config.json"
    window: Dict[str, int] = field(default_factory=lambda: {"width": 1200, "height": 800, "x": 100, "y": 100})
    screenshot_interval: int = 5
    auto_detect_interval: int = 30
    known_pcs: List[KnownPC] = field(default_factory=list)
    general: Dict[str, Any] = field(default_factory=lambda: {"dark_mode": False, "log_level": "INFO"})
    selected_pc_ip: str = ""

    @classmethod
    def default(cls, path: str = "controller_config.json") -> "ControllerConfig":
        return cls(path=path)

    @classmethod
    def load(cls, path: str = "controller_config.json") -> "ControllerConfig":
        if not os.path.exists(path):
            return cls.default(path=path)

        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception:
            return cls.default(path=path)

        cfg = cls.default(path=path)
        if isinstance(raw, dict):
            cfg.window = dict(raw.get("window") or cfg.window)
            cfg.screenshot_interval = int(raw.get("screenshot_interval") or cfg.screenshot_interval)
            cfg.auto_detect_interval = int(raw.get("auto_detect_interval") or cfg.auto_detect_interval)
            cfg.general = dict(raw.get("general") or cfg.general)
            cfg.selected_pc_ip = str(raw.get("selected_pc_ip") or "")

            pcs = raw.get("known_pcs") or []
            if isinstance(pcs, list):
                cfg.known_pcs = [KnownPC.from_dict(p) for p in pcs if isinstance(p, dict) and p.get("ip")]

        cfg.screenshot_interval = max(3, min(30, int(cfg.screenshot_interval)))
        cfg.auto_detect_interval = max(10, min(300, int(cfg.auto_detect_interval)))
        return cfg

    def save(self) -> None:
        data = {
            "window": self.window,
            "screenshot_interval": int(self.screenshot_interval),
            "auto_detect_interval": int(self.auto_detect_interval),
            "known_pcs": [pc.to_dict() for pc in self.known_pcs],
            "general": self.general,
            "selected_pc_ip": self.selected_pc_ip,
        }
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def upsert_pc(self, pc: KnownPC) -> None:
        pc.ip = pc.ip.strip()
        if not pc.last_seen:
            pc.last_seen = _now_str()
        for i, existing in enumerate(self.known_pcs):
            if existing.ip == pc.ip:
                merged = KnownPC(
                    hostname=pc.hostname or existing.hostname,
                    ip=pc.ip,
                    api_key=pc.api_key or existing.api_key,
                    connection_type=pc.connection_type or existing.connection_type,
                    last_seen=pc.last_seen or existing.last_seen,
                )
                self.known_pcs[i] = merged
                return
        self.known_pcs.append(pc)

    def remove_pc(self, ip: str) -> None:
        ip = (ip or "").strip()
        self.known_pcs = [pc for pc in self.known_pcs if pc.ip != ip]

    def find_pc(self, ip: str) -> Optional[KnownPC]:
        ip = (ip or "").strip()
        for pc in self.known_pcs:
            if pc.ip == ip:
                return pc
        return None

