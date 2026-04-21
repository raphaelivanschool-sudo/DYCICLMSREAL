from __future__ import annotations

import base64
import io
import json
import logging
import queue
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

from PIL import Image, ImageTk

from controller_config import ControllerConfig, KnownPC


APP_TITLE = "PC CONTROLLER v1.0"
DEFAULT_AGENT_PORT = 5555
STATUS_TIMEOUT_S = 2.0
SCREENSHOT_TIMEOUT_S = 5.0


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _safe_int(x: Any, default: int) -> int:
    try:
        return int(x)
    except Exception:
        return default


def _is_probably_ip(s: str) -> bool:
    s = (s or "").strip()
    parts = s.split(".")
    if len(parts) != 4:
        return False
    try:
        nums = [int(p) for p in parts]
    except Exception:
        return False
    return all(0 <= n <= 255 for n in nums)


def setup_logging(level: str) -> logging.Logger:
    logger = logging.getLogger("controller")
    logger.setLevel(getattr(logging, (level or "INFO").upper(), logging.INFO))
    logger.handlers.clear()
    logger.propagate = False

    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler("controller.log", encoding="utf-8")
    fh.setFormatter(formatter)
    fh.setLevel(logger.level)
    logger.addHandler(fh)

    sh = logging.StreamHandler()
    sh.setFormatter(formatter)
    sh.setLevel(logger.level)
    logger.addHandler(sh)
    return logger


@dataclass
class PCListItem:
    hostname: str
    ip: str
    api_key: str = ""
    connection_type: str = "Unknown"
    online: bool = False
    last_seen: str = ""
    last_status: Dict[str, Any] = field(default_factory=dict)
    selected: bool = False

    def display_name(self) -> str:
        return self.hostname or self.ip


class _Tooltip:
    def __init__(self, widget: tk.Widget) -> None:
        self.widget = widget
        self._win: Optional[tk.Toplevel] = None
        self._text = ""

    def set_text(self, text: str) -> None:
        self._text = text or ""

    def show(self, x: int, y: int) -> None:
        if not self._text:
            return
        if self._win is not None:
            return
        self._win = tk.Toplevel(self.widget)
        self._win.wm_overrideredirect(True)
        self._win.wm_geometry(f"+{x}+{y}")
        label = tk.Label(
            self._win,
            text=self._text,
            justify="left",
            background="#ffffe0",
            relief="solid",
            borderwidth=1,
            font=("Segoe UI", 9),
        )
        label.pack(ipadx=6, ipady=4)

    def hide(self) -> None:
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
            self._win = None


class AgentClient:
    def __init__(self, logger: logging.Logger) -> None:
        self.logger = logger
        self.session = requests.Session()

    def _base_url(self, ip: str, use_https: bool = False) -> str:
        scheme = "https" if use_https else "http"
        return f"{scheme}://{ip}:{DEFAULT_AGENT_PORT}"

    def _headers(self, api_key: str) -> Dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

    def _request(
        self,
        method: str,
        url: str,
        api_key: str,
        timeout: float,
        json_body: Optional[Dict[str, Any]] = None,
        retries: int = 2,
    ) -> requests.Response:
        backoff = 0.25
        last_exc: Optional[Exception] = None
        for attempt in range(retries + 1):
            start = time.time()
            try:
                resp = self.session.request(
                    method=method,
                    url=url,
                    headers=self._headers(api_key),
                    timeout=timeout,
                    json=json_body,
                )
                elapsed_ms = int((time.time() - start) * 1000)
                self.logger.info("api %s %s -> %s (%dms)", method, url, resp.status_code, elapsed_ms)
                return resp
            except (requests.Timeout, requests.ConnectionError) as e:
                last_exc = e
                elapsed_ms = int((time.time() - start) * 1000)
                self.logger.warning("api %s %s failed (%dms): %s", method, url, elapsed_ms, e)
                if attempt < retries:
                    time.sleep(backoff)
                    backoff = min(2.0, backoff * 2.0)
                    continue
                raise
            except Exception as e:
                last_exc = e
                self.logger.error("api %s %s error: %s", method, url, e, exc_info=True)
                raise
        if last_exc:
            raise last_exc
        raise RuntimeError("request failed")

    def get_status(self, ip: str, api_key: str) -> Dict[str, Any]:
        url = f"{self._base_url(ip)}/status"
        resp = self._request("GET", url, api_key=api_key, timeout=STATUS_TIMEOUT_S)
        if resp.status_code == 401:
            raise PermissionError("Invalid API key")
        resp.raise_for_status()
        return resp.json()

    def get_screenshot(self, ip: str, api_key: str) -> Dict[str, Any]:
        url = f"{self._base_url(ip)}/screenshot"
        resp = self._request("GET", url, api_key=api_key, timeout=SCREENSHOT_TIMEOUT_S)
        if resp.status_code == 401:
            raise PermissionError("Invalid API key")
        resp.raise_for_status()
        return resp.json()

    def lock(self, ip: str, api_key: str) -> Dict[str, Any]:
        url = f"{self._base_url(ip)}/lock"
        resp = self._request("POST", url, api_key=api_key, timeout=STATUS_TIMEOUT_S)
        if resp.status_code == 401:
            raise PermissionError("Invalid API key")
        resp.raise_for_status()
        return resp.json()

    def shutdown(self, ip: str, api_key: str, delay: int, reason: str) -> Dict[str, Any]:
        url = f"{self._base_url(ip)}/shutdown"
        body = {"delay": int(delay), "reason": str(reason or "")}
        resp = self._request("POST", url, api_key=api_key, timeout=STATUS_TIMEOUT_S, json_body=body)
        if resp.status_code == 401:
            raise PermissionError("Invalid API key")
        resp.raise_for_status()
        return resp.json()

    def cancel_shutdown(self, ip: str, api_key: str) -> Dict[str, Any]:
        url = f"{self._base_url(ip)}/cancel_shutdown"
        resp = self._request("POST", url, api_key=api_key, timeout=STATUS_TIMEOUT_S)
        if resp.status_code == 401:
            raise PermissionError("Invalid API key")
        resp.raise_for_status()
        return resp.json()


class StatusChecker(threading.Thread):
    def __init__(
        self,
        stop_event: threading.Event,
        client: AgentClient,
        items_ref: Dict[str, PCListItem],
        interval_s: float,
        out_queue: "queue.Queue[Tuple[str, Any]]",
        logger: logging.Logger,
    ) -> None:
        super().__init__(daemon=True)
        self.stop_event = stop_event
        self.client = client
        self.items_ref = items_ref
        self.interval_s = float(interval_s)
        self.out_queue = out_queue
        self.logger = logger

    def run(self) -> None:
        while not self.stop_event.is_set():
            start = time.time()
            for ip, item in list(self.items_ref.items()):
                if self.stop_event.is_set():
                    break
                if not item.api_key:
                    self.out_queue.put(("status", (ip, False, {"error": "Missing API key"})))
                    continue
                try:
                    data = self.client.get_status(ip, item.api_key)
                    self.out_queue.put(("status", (ip, True, data)))
                except PermissionError:
                    self.out_queue.put(("status", (ip, False, {"error": "Invalid API key"})))
                except Exception as e:
                    msg = "Connection failed"
                    if isinstance(e, requests.Timeout):
                        msg = "Timed out"
                    self.out_queue.put(("status", (ip, False, {"error": msg})))
            elapsed = time.time() - start
            sleep_for = max(0.5, self.interval_s - elapsed)
            self.stop_event.wait(timeout=sleep_for)


class ScreenshotFetcher(threading.Thread):
    def __init__(
        self,
        stop_event: threading.Event,
        client: AgentClient,
        selected_ip_getter,
        items_ref: Dict[str, PCListItem],
        interval_s: float,
        out_queue: "queue.Queue[Tuple[str, Any]]",
        logger: logging.Logger,
    ) -> None:
        super().__init__(daemon=True)
        self.stop_event = stop_event
        self.client = client
        self.selected_ip_getter = selected_ip_getter
        self.items_ref = items_ref
        self.interval_s = float(interval_s)
        self.out_queue = out_queue
        self.logger = logger

    def run(self) -> None:
        while not self.stop_event.is_set():
            ip = self.selected_ip_getter()
            if not ip:
                self.stop_event.wait(timeout=0.5)
                continue
            item = self.items_ref.get(ip)
            if not item or not item.api_key:
                self.out_queue.put(("screenshot_error", (ip, "Missing API key")))
                self.stop_event.wait(timeout=self.interval_s)
                continue
            try:
                payload = self.client.get_screenshot(ip, item.api_key)
                self.out_queue.put(("screenshot", (ip, payload)))
            except PermissionError:
                self.out_queue.put(("screenshot_error", (ip, "Invalid API key")))
            except Exception as e:
                msg = "Could not fetch screenshot"
                if isinstance(e, requests.Timeout):
                    msg = "Screenshot timed out"
                self.out_queue.put(("screenshot_error", (ip, msg)))
            self.stop_event.wait(timeout=self.interval_s)


class NetworkScanWorker(threading.Thread):
    def __init__(
        self,
        stop_event: threading.Event,
        out_queue: "queue.Queue[Tuple[str, Any]]",
        logger: logging.Logger,
    ) -> None:
        super().__init__(daemon=True)
        self.stop_event = stop_event
        self.out_queue = out_queue
        self.logger = logger

    def run(self) -> None:
        try:
            scanner = None
            try:
                # Preferred per your prompt (if present)
                from detection.network_scanner import NetworkScanner as _NS  # type: ignore

                scanner = _NS(debug=False)
            except Exception:
                from network_scanner import NetworkScanner as _NS  # type: ignore

                scanner = _NS(debug=False)

            self.logger.info("network scan started")
            devices = scanner.discover_all()
            self.out_queue.put(("scan_result", devices))
            self.logger.info("network scan finished devices=%d", len(devices))
        except Exception as e:
            self.logger.error("network scan failed: %s", e, exc_info=True)
            self.out_queue.put(("scan_error", str(e)))


class ControllerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_TITLE)

        self.config = ControllerConfig.load("controller_config.json")
        self.logger = setup_logging(self.config.general.get("log_level", "INFO"))
        self.client = AgentClient(self.logger)

        self.stop_event = threading.Event()
        self.events: "queue.Queue[Tuple[str, Any]]" = queue.Queue()

        self.items: Dict[str, PCListItem] = {}
        self._selected_ip: str = ""

        self._screenshot_photo: Optional[ImageTk.PhotoImage] = None
        self._screenshot_history: List[Image.Image] = []
        self._screenshot_history_idx: int = -1

        self._build_ui()
        self._bind_shortcuts()

        self._load_known_pcs()
        self._apply_window_geometry()

        self._status_thread = StatusChecker(
            stop_event=self.stop_event,
            client=self.client,
            items_ref=self.items,
            interval_s=float(self.config.auto_detect_interval),
            out_queue=self.events,
            logger=self.logger,
        )
        self._status_thread.start()

        self._screenshot_thread = ScreenshotFetcher(
            stop_event=self.stop_event,
            client=self.client,
            selected_ip_getter=lambda: self._selected_ip,
            items_ref=self.items,
            interval_s=float(self.config.screenshot_interval),
            out_queue=self.events,
            logger=self.logger,
        )
        self._screenshot_thread.start()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(100, self._process_events)

        self._set_status("Ready")
        self.logger.info("controller started")

    # ---------------- UI ----------------

    def _build_ui(self) -> None:
        self.root.geometry("1200x800")

        self.paned = ttk.Panedwindow(self.root, orient=tk.HORIZONTAL)
        self.paned.pack(fill=tk.BOTH, expand=True)

        self.left = ttk.Frame(self.paned, padding=10)
        self.right = ttk.Frame(self.paned, padding=10)
        self.paned.add(self.left, weight=1)
        self.paned.add(self.right, weight=3)

        self._setup_left_panel()
        self._setup_right_panel()

        self.status_bar = ttk.Label(self.root, text="", anchor="w")
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

    def _setup_left_panel(self) -> None:
        ttk.Label(self.left, text="Discovered PCs", font=("Segoe UI", 12, "bold")).pack(anchor="w")

        btn_row = ttk.Frame(self.left)
        btn_row.pack(fill=tk.X, pady=(8, 10))
        ttk.Button(btn_row, text="Scan Network", command=self.scan_network).pack(fill=tk.X, pady=3)
        ttk.Button(btn_row, text="Add Manual PC", command=self.add_manual_pc).pack(fill=tk.X, pady=3)
        ttk.Button(btn_row, text="Refresh Status", command=self.refresh_status).pack(fill=tk.X, pady=3)

        columns = ("sel", "hostname", "ip", "status", "conn")
        self.tree = ttk.Treeview(self.left, columns=columns, show="headings", selectmode="browse", height=18)
        self.tree.heading("sel", text="")
        self.tree.heading("hostname", text="Hostname")
        self.tree.heading("ip", text="IP")
        self.tree.heading("status", text="Status")
        self.tree.heading("conn", text="Link")

        self.tree.column("sel", width=40, anchor="center", stretch=False)
        self.tree.column("hostname", width=180, anchor="w")
        self.tree.column("ip", width=120, anchor="w")
        self.tree.column("status", width=90, anchor="w")
        self.tree.column("conn", width=70, anchor="center", stretch=False)

        yscroll = ttk.Scrollbar(self.left, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=yscroll.set)

        tree_frame = ttk.Frame(self.left)
        tree_frame.pack(fill=tk.BOTH, expand=True)
        self.tree.pack(in_=tree_frame, side=tk.LEFT, fill=tk.BOTH, expand=True)
        yscroll.pack(in_=tree_frame, side=tk.RIGHT, fill=tk.Y)

        self._tooltip = _Tooltip(self.tree)
        self.tree.bind("<Motion>", self._on_tree_motion)
        self.tree.bind("<Leave>", lambda e: self._tooltip.hide())
        self.tree.bind("<Button-1>", self._on_tree_click)
        self.tree.bind("<<TreeviewSelect>>", self.select_pc)

    def _setup_right_panel(self) -> None:
        ttk.Label(self.right, text="Screenshot Viewer", font=("Segoe UI", 12, "bold")).pack(anchor="w")

        self.screenshot_meta = ttk.Label(self.right, text="No PC selected", anchor="w")
        self.screenshot_meta.pack(fill=tk.X, pady=(6, 6))

        self.image_border = ttk.Frame(self.right, relief=tk.GROOVE, borderwidth=2)
        self.image_border.pack(fill=tk.BOTH, expand=True)
        self.image_label = ttk.Label(self.image_border, text="(screenshot here)", anchor="center")
        self.image_label.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)
        self.image_label.bind("<Configure>", lambda e: self._render_current_screenshot())

        btns = ttk.Frame(self.right)
        btns.pack(fill=tk.X, pady=(10, 6))
        ttk.Button(btns, text="Refresh", command=self.refresh_screenshot).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btns, text="Lock", command=self.lock_pc).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btns, text="Shutdown", command=self.shutdown_pc).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Button(btns, text="Settings", command=self.open_settings).pack(side=tk.RIGHT)

        history = ttk.Frame(self.right)
        history.pack(fill=tk.X)
        ttk.Button(history, text="◀", width=4, command=lambda: self._step_history(-1)).pack(side=tk.LEFT)
        ttk.Button(history, text="▶", width=4, command=lambda: self._step_history(1)).pack(side=tk.LEFT, padx=(6, 0))
        ttk.Button(history, text="Save Screenshot", command=self.save_screenshot).pack(side=tk.RIGHT)

    def _bind_shortcuts(self) -> None:
        self.root.bind_all("<Control-r>", lambda e: self.refresh_screenshot())
        self.root.bind_all("<Control-l>", lambda e: self.lock_pc())

    # ---------------- Persistence ----------------

    def _apply_window_geometry(self) -> None:
        w = _safe_int(self.config.window.get("width"), 1200)
        h = _safe_int(self.config.window.get("height"), 800)
        x = _safe_int(self.config.window.get("x"), 100)
        y = _safe_int(self.config.window.get("y"), 100)
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _capture_window_geometry(self) -> None:
        try:
            self.root.update_idletasks()
            geo = self.root.winfo_geometry()  # e.g. "1200x800+100+100"
            size, pos = geo.split("+", 1)
            w_s, h_s = size.split("x", 1)
            x_s, y_s = pos.split("+", 1)
            self.config.window = {"width": int(w_s), "height": int(h_s), "x": int(x_s), "y": int(y_s)}
        except Exception:
            pass

    def save_config(self) -> None:
        self._capture_window_geometry()
        self.config.selected_pc_ip = self._selected_ip
        self.config.save()

    def load_config(self) -> None:
        self.config = ControllerConfig.load("controller_config.json")

    # ---------------- Left panel behaviors ----------------

    def _load_known_pcs(self) -> None:
        for pc in self.config.known_pcs:
            item = PCListItem(
                hostname=pc.hostname,
                ip=pc.ip,
                api_key=pc.api_key,
                connection_type=pc.connection_type,
                online=False,
                last_seen=pc.last_seen,
            )
            self.items[item.ip] = item
        self._refresh_tree()

        if self.config.selected_pc_ip and self.config.selected_pc_ip in self.items:
            self._selected_ip = self.config.selected_pc_ip
            self._select_tree_ip(self._selected_ip)

    def _refresh_tree(self) -> None:
        self.tree.delete(*self.tree.get_children())
        for ip in sorted(self.items.keys()):
            item = self.items[ip]
            sel = "☑" if item.selected else "☐"
            status = "✓ Online" if item.online else "✗ Offline"
            conn_icon = "📶" if item.connection_type.lower() == "wifi" else ("🔌" if item.connection_type.lower() == "ethernet" else "•")
            self.tree.insert("", tk.END, iid=ip, values=(sel, item.hostname, item.ip, status, conn_icon))

    def _select_tree_ip(self, ip: str) -> None:
        try:
            self.tree.selection_set(ip)
            self.tree.focus(ip)
            self.tree.see(ip)
        except Exception:
            pass

    def _selected_items(self) -> List[PCListItem]:
        return [it for it in self.items.values() if it.selected]

    def scan_network(self) -> None:
        if getattr(self, "_scan_in_flight", False):
            return
        self._scan_in_flight = True
        self._set_status("Scanning network...")
        self._show_progress("Scanning network... please wait")
        NetworkScanWorker(stop_event=self.stop_event, out_queue=self.events, logger=self.logger).start()

    def add_manual_pc(self) -> None:
        ip = simpledialog.askstring("Add Manual PC", "Enter IP address:", parent=self.root)
        if not ip:
            return
        ip = ip.strip()
        if not _is_probably_ip(ip):
            messagebox.showerror("Invalid IP", "Please enter a valid IPv4 address (e.g. 192.168.1.10).")
            return

        hostname = simpledialog.askstring("Add Manual PC", "Optional hostname (leave blank to auto):", parent=self.root) or ""
        api_key = simpledialog.askstring("Add Manual PC", "API key (Bearer token):", parent=self.root) or ""

        tmp_item = PCListItem(hostname=hostname or "Unknown", ip=ip, api_key=api_key, connection_type="Manual")
        self.items[ip] = tmp_item
        self._refresh_tree()
        self._select_tree_ip(ip)

        def _verify() -> None:
            ok = False
            err = ""
            try:
                if not api_key:
                    raise PermissionError("Missing API key")
                data = self.client.get_status(ip, api_key)
                ok = True
                tmp_item.hostname = str(data.get("hostname") or tmp_item.hostname)
                tmp_item.online = True
                tmp_item.last_status = data
                tmp_item.last_seen = _now_str()
            except PermissionError:
                err = "API key is missing or invalid."
            except Exception:
                err = "Could not connect to that PC."

            self.events.put(("manual_add_verified", (ip, ok, err)))

        threading.Thread(target=_verify, daemon=True).start()
        self._set_status("Verifying PC...")

    def refresh_status(self) -> None:
        self._set_status("Refreshing status...")

        def _run_once() -> None:
            for ip, item in list(self.items.items()):
                if not item.api_key:
                    self.events.put(("status", (ip, False, {"error": "Missing API key"})))
                    continue
                try:
                    data = self.client.get_status(ip, item.api_key)
                    self.events.put(("status", (ip, True, data)))
                except PermissionError:
                    self.events.put(("status", (ip, False, {"error": "Invalid API key"})))
                except Exception as e:
                    msg = "Connection failed"
                    if isinstance(e, requests.Timeout):
                        msg = "Timed out"
                    self.events.put(("status", (ip, False, {"error": msg})))

        threading.Thread(target=_run_once, daemon=True).start()

    def _on_tree_click(self, event: tk.Event) -> None:
        row = self.tree.identify_row(event.y)
        col = self.tree.identify_column(event.x)
        if not row:
            return
        if col == "#1":  # sel column
            item = self.items.get(row)
            if item:
                item.selected = not item.selected
                self._refresh_tree()
                self._select_tree_ip(row)

    def _on_tree_motion(self, event: tk.Event) -> None:
        row = self.tree.identify_row(event.y)
        if not row:
            self._tooltip.hide()
            return
        item = self.items.get(row)
        if not item:
            self._tooltip.hide()
            return
        s = item.last_status or {}
        cpu = s.get("cpu_percent", None)
        mem = s.get("memory_percent", None)
        uptime = s.get("uptime_seconds", None)
        os_name = s.get("os", "")
        tip = f"{item.hostname} ({item.ip})\n"
        if os_name:
            tip += f"OS: {os_name}\n"
        if cpu is not None:
            tip += f"CPU: {cpu}%\n"
        if mem is not None:
            tip += f"Memory: {mem}%\n"
        if uptime is not None:
            tip += f"Uptime: {uptime}s\n"
        if item.last_seen:
            tip += f"Last seen: {item.last_seen}"
        self._tooltip.set_text(tip.strip())
        self._tooltip.hide()
        self._tooltip.show(self.root.winfo_pointerx() + 10, self.root.winfo_pointery() + 10)

    def select_pc(self, event: Optional[tk.Event] = None) -> None:
        sel = self.tree.selection()
        if not sel:
            self._selected_ip = ""
            self.screenshot_meta.configure(text="No PC selected")
            return
        ip = sel[0]
        self._selected_ip = ip
        item = self.items.get(ip)
        if item:
            self.screenshot_meta.configure(text=f"Selected: {item.display_name()} ({item.ip})")
        self._set_status(f"Selected {ip}")

    # ---------------- Right panel behaviors ----------------

    def refresh_screenshot(self) -> None:
        ip = self._selected_ip
        if not ip:
            messagebox.showinfo("No selection", "Select a PC first.")
            return
        item = self.items.get(ip)
        if not item:
            return
        if not item.api_key:
            messagebox.showerror("Missing API key", "This PC has no API key configured.")
            return

        self._set_status("Fetching screenshot...")

        def _fetch() -> None:
            try:
                payload = self.client.get_screenshot(ip, item.api_key)
                self.events.put(("screenshot", (ip, payload)))
            except PermissionError:
                self.events.put(("screenshot_error", (ip, "Invalid API key")))
            except Exception as e:
                msg = "Could not fetch screenshot"
                if isinstance(e, requests.Timeout):
                    msg = "Screenshot timed out"
                self.events.put(("screenshot_error", (ip, msg)))

        threading.Thread(target=_fetch, daemon=True).start()

    def lock_pc(self) -> None:
        targets = self._selected_items()
        if not targets:
            if self._selected_ip and self._selected_ip in self.items:
                targets = [self.items[self._selected_ip]]
        if not targets:
            messagebox.showinfo("No selection", "Select one or more PCs (checkbox) or pick a PC.")
            return

        names = ", ".join(t.display_name() for t in targets)
        if not messagebox.askyesno("Confirm Lock", f"Lock {names}?"):
            return

        self._set_status("Sending lock command...")

        def _run() -> None:
            results = []
            for t in targets:
                try:
                    if not t.api_key:
                        raise PermissionError("Missing API key")
                    self.client.lock(t.ip, t.api_key)
                    results.append((t.ip, True, "Locked"))
                except PermissionError:
                    results.append((t.ip, False, "Invalid or missing API key"))
                except Exception:
                    results.append((t.ip, False, "Failed"))
            self.events.put(("action_result", ("lock", results)))

        threading.Thread(target=_run, daemon=True).start()

    def shutdown_pc(self) -> None:
        targets = self._selected_items()
        if not targets:
            if self._selected_ip and self._selected_ip in self.items:
                targets = [self.items[self._selected_ip]]
        if not targets:
            messagebox.showinfo("No selection", "Select one or more PCs (checkbox) or pick a PC.")
            return

        delay = simpledialog.askinteger("Shutdown", "Delay (seconds):", initialvalue=30, minvalue=0, maxvalue=3600, parent=self.root)
        if delay is None:
            return
        reason = simpledialog.askstring("Shutdown", "Reason/message (optional):", parent=self.root) or ""

        names = ", ".join(t.display_name() for t in targets)
        if not messagebox.askyesno("Confirm Shutdown", f"Shutdown {names} in {delay}s?"):
            return

        self._set_status("Sending shutdown command...")

        def _run() -> None:
            results = []
            for t in targets:
                try:
                    if not t.api_key:
                        raise PermissionError("Missing API key")
                    self.client.shutdown(t.ip, t.api_key, delay=delay, reason=reason)
                    results.append((t.ip, True, f"Shutdown in {delay}s"))
                except PermissionError:
                    results.append((t.ip, False, "Invalid or missing API key"))
                except Exception:
                    results.append((t.ip, False, "Failed"))
            self.events.put(("action_result", ("shutdown", results)))

        threading.Thread(target=_run, daemon=True).start()

    def save_screenshot(self) -> None:
        if self._screenshot_history_idx < 0 or self._screenshot_history_idx >= len(self._screenshot_history):
            messagebox.showinfo("No screenshot", "No screenshot to save yet.")
            return
        try:
            img = self._screenshot_history[self._screenshot_history_idx]
            ip = self._selected_ip or "unknown"
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            path = f"screenshot_{ip}_{ts}.jpg".replace(":", "_")
            img.save(path, format="JPEG", quality=90)
            self._set_status(f"Saved {path}")
        except Exception:
            messagebox.showerror("Save failed", "Could not save screenshot.")

    def _step_history(self, delta: int) -> None:
        if not self._screenshot_history:
            return
        self._screenshot_history_idx = max(0, min(len(self._screenshot_history) - 1, self._screenshot_history_idx + delta))
        self._render_current_screenshot()

    def open_settings(self) -> None:
        win = tk.Toplevel(self.root)
        win.title("Settings")
        win.transient(self.root)
        win.grab_set()

        frame = ttk.Frame(win, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(frame, text="Screenshot refresh interval (3-30s):").grid(row=0, column=0, sticky="w")
        scr_var = tk.IntVar(value=int(self.config.screenshot_interval))
        ttk.Spinbox(frame, from_=3, to=30, textvariable=scr_var, width=8).grid(row=0, column=1, sticky="w", padx=(8, 0))

        ttk.Label(frame, text="Auto status interval (10-300s):").grid(row=1, column=0, sticky="w", pady=(8, 0))
        st_var = tk.IntVar(value=int(self.config.auto_detect_interval))
        ttk.Spinbox(frame, from_=10, to=300, textvariable=st_var, width=8).grid(row=1, column=1, sticky="w", padx=(8, 0), pady=(8, 0))

        dark_var = tk.BooleanVar(value=bool(self.config.general.get("dark_mode", False)))
        ttk.Checkbutton(frame, text="Dark mode (basic)", variable=dark_var).grid(row=2, column=0, sticky="w", pady=(10, 0), columnspan=2)

        ttk.Label(frame, text="Log level:").grid(row=3, column=0, sticky="w", pady=(8, 0))
        lvl_var = tk.StringVar(value=str(self.config.general.get("log_level", "INFO")))
        ttk.Combobox(frame, textvariable=lvl_var, values=["DEBUG", "INFO", "WARNING", "ERROR"], width=10, state="readonly").grid(
            row=3, column=1, sticky="w", padx=(8, 0), pady=(8, 0)
        )

        btns = ttk.Frame(frame)
        btns.grid(row=4, column=0, columnspan=2, sticky="e", pady=(14, 0))

        def _apply() -> None:
            self.config.screenshot_interval = int(scr_var.get())
            self.config.auto_detect_interval = int(st_var.get())
            self.config.general["dark_mode"] = bool(dark_var.get())
            self.config.general["log_level"] = str(lvl_var.get())
            self.save_config()
            self._set_status("Settings saved (restart to apply log level)")
            win.destroy()

        ttk.Button(btns, text="Save", command=_apply).pack(side=tk.RIGHT, padx=(6, 0))
        ttk.Button(btns, text="Cancel", command=win.destroy).pack(side=tk.RIGHT)

    # ---------------- Event processing ----------------

    def _process_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "status":
                    ip, ok, data = payload
                    item = self.items.get(ip)
                    if not item:
                        continue
                    item.online = bool(ok)
                    item.last_status = data if isinstance(data, dict) else {}
                    if ok:
                        item.last_seen = _now_str()
                        if data.get("hostname"):
                            item.hostname = str(data.get("hostname"))
                    self._refresh_tree()
                    if ip == self._selected_ip:
                        self._update_status_bar_selected()
                elif kind == "screenshot":
                    ip, data = payload
                    if ip == self._selected_ip:
                        self._handle_screenshot_payload(data)
                elif kind == "screenshot_error":
                    ip, msg = payload
                    if ip == self._selected_ip:
                        self._set_status(msg)
                elif kind == "scan_result":
                    self._hide_progress()
                    self._scan_in_flight = False
                    self._merge_discovered(payload)
                    self._set_status("Scan complete")
                elif kind == "scan_error":
                    self._hide_progress()
                    self._scan_in_flight = False
                    messagebox.showerror("Scan failed", "Network scan failed. Check your firewall/permissions and try again.")
                    self._set_status("Scan failed")
                elif kind == "manual_add_verified":
                    ip, ok, err = payload
                    if ok:
                        messagebox.showinfo("Added", "PC added and verified.")
                        self._persist_known_pcs()
                        self._set_status("PC added")
                    else:
                        messagebox.showwarning("Added (unverified)", err or "PC added but could not be verified right now.")
                        self._persist_known_pcs()
                        self._set_status("PC added (unverified)")
                    self._refresh_tree()
                elif kind == "action_result":
                    action, results = payload
                    ok_count = sum(1 for _, ok, _ in results if ok)
                    total = len(results)
                    details = "\n".join(f"{ip}: {msg}" for ip, _, msg in results)
                    title = "Success" if ok_count == total else "Completed with issues"
                    messagebox.showinfo(title, f"{action.upper()} results ({ok_count}/{total}):\n\n{details}")
                    self._set_status(f"{action} done ({ok_count}/{total})")
                else:
                    self.logger.debug("unknown event kind=%s payload=%s", kind, payload)
        except queue.Empty:
            pass
        except Exception:
            self.logger.error("event loop error: %s", traceback.format_exc())
        finally:
            self.root.after(120, self._process_events)

    def _merge_discovered(self, devices: Any) -> None:
        if not isinstance(devices, list):
            return
        added = 0
        for d in devices:
            if not isinstance(d, dict):
                continue
            ip = str(d.get("ip") or "").strip()
            if not ip:
                continue
            hostname = str(d.get("hostname") or "Unknown")
            conn = str(d.get("connection_type") or "Unknown")
            if ip not in self.items:
                self.items[ip] = PCListItem(hostname=hostname, ip=ip, api_key="", connection_type=conn)
                added += 1
            else:
                it = self.items[ip]
                if it.hostname in ("", "Unknown") and hostname:
                    it.hostname = hostname
                if it.connection_type in ("", "Unknown") and conn:
                    it.connection_type = conn
        self._refresh_tree()
        self._persist_known_pcs()
        if added:
            self._set_status(f"Added {added} PCs")

    def _persist_known_pcs(self) -> None:
        self.config.known_pcs = [
            KnownPC(
                hostname=i.hostname,
                ip=i.ip,
                api_key=i.api_key,
                connection_type=i.connection_type,
                last_seen=i.last_seen,
            )
            for i in self.items.values()
        ]
        self.save_config()

    # ---------------- Screenshot handling ----------------

    def _handle_screenshot_payload(self, payload: Dict[str, Any]) -> None:
        try:
            b64 = str(payload.get("screenshot") or "")
            ts = str(payload.get("timestamp") or "")
            w = payload.get("width", None)
            h = payload.get("height", None)
            if not b64:
                raise ValueError("missing screenshot")
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            self._push_history(img)
            self.screenshot_meta.configure(text=f"Resolution: {w}x{h}    Timestamp: {ts}")
            self._render_current_screenshot()
            self._set_status("Screenshot updated")
        except Exception:
            self.logger.warning("bad screenshot payload", exc_info=True)
            self._set_status("Invalid screenshot data")

    def _push_history(self, img: Image.Image) -> None:
        self._screenshot_history.append(img)
        if len(self._screenshot_history) > 5:
            self._screenshot_history = self._screenshot_history[-5:]
        self._screenshot_history_idx = len(self._screenshot_history) - 1

    def _render_current_screenshot(self) -> None:
        if self._screenshot_history_idx < 0 or self._screenshot_history_idx >= len(self._screenshot_history):
            return
        img = self._screenshot_history[self._screenshot_history_idx]
        w = max(50, self.image_label.winfo_width())
        h = max(50, self.image_label.winfo_height())
        fit = img.copy()
        fit.thumbnail((w - 10, h - 10), Image.Resampling.LANCZOS)
        self._screenshot_photo = ImageTk.PhotoImage(fit)
        self.image_label.configure(image=self._screenshot_photo, text="")

    # ---------------- Status / dialogs ----------------

    def _set_status(self, text: str) -> None:
        self.status_bar.configure(text=f"Status: {text}")

    def _update_status_bar_selected(self) -> None:
        ip = self._selected_ip
        if not ip:
            return
        item = self.items.get(ip)
        if not item:
            return
        state = "Online" if item.online else "Offline"
        self._set_status(f"{item.display_name()} - {state}")

    def _show_progress(self, message: str) -> None:
        if getattr(self, "_progress_win", None) is not None:
            return
        win = tk.Toplevel(self.root)
        win.title("Working...")
        win.transient(self.root)
        win.grab_set()
        win.resizable(False, False)
        frame = ttk.Frame(win, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        ttk.Label(frame, text=message).pack(anchor="w")
        pb = ttk.Progressbar(frame, mode="indeterminate")
        pb.pack(fill=tk.X, pady=(10, 0))
        pb.start(10)
        self._progress_win = win
        self._progress_pb = pb

    def _hide_progress(self) -> None:
        win = getattr(self, "_progress_win", None)
        if win is None:
            return
        try:
            pb = getattr(self, "_progress_pb", None)
            if pb is not None:
                pb.stop()
            win.destroy()
        except Exception:
            pass
        self._progress_win = None
        self._progress_pb = None

    # ---------------- Shutdown ----------------

    def _on_close(self) -> None:
        try:
            self.logger.info("controller shutting down")
        except Exception:
            pass
        self.save_config()
        self.stop_event.set()
        self.root.after(150, self.root.destroy)


if __name__ == "__main__":
    root = tk.Tk()
    app = ControllerApp(root)
    root.mainloop()

