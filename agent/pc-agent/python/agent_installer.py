from __future__ import annotations

import ctypes
import json
import os
import secrets
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class InstallerPaths:
    base_dir: str
    config_path: str
    requirements_path: str


def _paths() -> InstallerPaths:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return InstallerPaths(
        base_dir=base_dir,
        config_path=os.path.join(base_dir, "agent_config.json"),
        requirements_path=os.path.join(base_dir, "requirements_agent.txt"),
    )


def check_admin() -> bool:
    """
    Verify the installer is running as Administrator.
    """
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def install_dependencies(requirements_path: str) -> None:
    """
    Install Python dependencies from requirements file using the current interpreter.
    """
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", requirements_path],
        check=True,
        text=True,
    )


def generate_api_key() -> str:
    """
    Generate a random API key for Bearer auth.
    """
    token = secrets.token_urlsafe(24)
    return f"sk_pc_agent_{token}"


def create_config(config_path: str, api_key: Optional[str] = None) -> dict:
    """
    Create `agent_config.json` if missing. Returns config dict.
    """
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)

    cfg = {
        "api_key": api_key or generate_api_key(),
        "port": 5555,
        "host": "0.0.0.0",
        "log_level": "INFO",
        "screenshot_quality": 70,
        "screenshot_max_width": 1920,
        "screenshot_max_height": 1080,
        "default_shutdown_delay": 30,
        "enable_https": False,
        "https_cert": None,
        "https_key": None,
    }
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg


def _run_service_cmd(args: list[str]) -> None:
    subprocess.run([sys.executable, "run_as_service.py", *args], check=True, cwd=os.path.dirname(os.path.abspath(__file__)))


def install_service() -> None:
    """
    Register the Windows service using pywin32.
    """
    _run_service_cmd(["install"])


def start_service() -> None:
    """
    Start the Windows service.
    """
    _run_service_cmd(["start"])


def verify_service(service_name: str = "PCAgentService") -> bool:
    """
    Verify service is installed and running.
    """
    proc = subprocess.run(["sc", "query", service_name], capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    return "RUNNING" in out.upper()


def _add_firewall_rule() -> None:
    """
    Add a firewall rule allowing inbound access for the current Python interpreter.
    (This follows your spec; in practice you may prefer port-based rules.)
    """
    python_exe = sys.executable
    rule_name = "PC Agent Service"
    subprocess.run(
        [
            "netsh",
            "advfirewall",
            "firewall",
            "add",
            "rule",
            f'name={rule_name}',
            "dir=in",
            "action=allow",
            f'program={python_exe}',
            "enable=yes",
        ],
        capture_output=True,
        text=True,
    )


def _print_manage_commands() -> None:
    print("\nService management:")
    print("  sc query PCAgentService")
    print("  net start PCAgentService")
    print("  net stop PCAgentService")
    print("  sc delete PCAgentService")


def main() -> int:
    p = _paths()

    if not check_admin():
        print("ERROR: Please run this installer as Administrator.")
        return 1

    print("Installing dependencies...")
    install_dependencies(p.requirements_path)
    print("✓ Dependencies installed")

    cfg = create_config(p.config_path)
    print("✓ Config created/loaded")
    print(f"✓ API Key: {cfg.get('api_key')}")

    print("Adding firewall rule...")
    _add_firewall_rule()
    print('✓ Firewall rule attempted (name: "PC Agent Service")')

    print('Installing Windows service "PCAgentService"...')
    install_service()
    print("✓ Service installed")

    print("Starting service...")
    start_service()
    print("✓ Service start command issued")

    ok = verify_service()
    if ok:
        print("✓ Service is running")
    else:
        print("⚠ Service may not be running yet. Check with: sc query PCAgentService")

    _print_manage_commands()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

