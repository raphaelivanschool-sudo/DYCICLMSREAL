from __future__ import annotations

import base64
import functools
import io
import json
import logging
import os
import platform
import queue
import subprocess
import threading
import time
import traceback
import ctypes
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Optional, Tuple, TypeVar

import psutil
from flask import Flask, Response, jsonify, request
from PIL import Image, ImageGrab


AGENT_VERSION = "1.0"

T = TypeVar("T")

# Host→guest projection fullscreen (Tk on a background thread)
_projection_queue: "queue.Queue[Optional[bytes]]" = queue.Queue()
_projection_ui_thread: Optional[threading.Thread] = None
_projection_lock = threading.Lock()
_projection_photo_ref: list = []  # keep PhotoImage refs for Tk
_stream_player_proc: Optional[subprocess.Popen] = None
_stream_player_lock = threading.Lock()


@dataclass(frozen=True)
class AgentConfig:
    api_key: str
    port: int = 5555
    host: str = "0.0.0.0"
    log_level: str = "INFO"
    screenshot_quality: int = 70
    screenshot_max_width: int = 1920
    screenshot_max_height: int = 1080
    default_shutdown_delay: int = 30
    enable_https: bool = False
    https_cert: Optional[str] = None
    https_key: Optional[str] = None


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def load_config(config_path: Optional[str] = None) -> AgentConfig:
    """
    Load agent configuration from `agent_config.json` located alongside this file
    (or from `config_path` if provided).
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))
    path = config_path or os.path.join(base_dir, "agent_config.json")

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    return AgentConfig(
        api_key=str(raw.get("api_key", "")),
        port=int(raw.get("port", 5555)),
        host=str(raw.get("host", "0.0.0.0")),
        log_level=str(raw.get("log_level", "INFO")),
        screenshot_quality=int(raw.get("screenshot_quality", 70)),
        screenshot_max_width=int(raw.get("screenshot_max_width", 1920)),
        screenshot_max_height=int(raw.get("screenshot_max_height", 1080)),
        default_shutdown_delay=int(raw.get("default_shutdown_delay", 30)),
        enable_https=bool(raw.get("enable_https", False)),
        https_cert=raw.get("https_cert", None),
        https_key=raw.get("https_key", None),
    )


def setup_logging(log_level: str) -> logging.Logger:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    log_path = os.path.join(base_dir, "agent.log")

    logger = logging.getLogger("pc_agent")
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
    logger.handlers.clear()
    logger.propagate = False

    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logger.level)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    stream_handler.setLevel(logger.level)
    logger.addHandler(stream_handler)

    return logger


def _unauthorized() -> Tuple[Response, int]:
    return jsonify({"error": "Unauthorized"}), 401


def require_auth(config: AgentConfig) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Flask decorator enforcing `Authorization: Bearer {TOKEN}`.
    """

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            auth = request.headers.get("Authorization", "")
            expected = f"Bearer {config.api_key}"
            if not auth or auth.strip() != expected:
                return _unauthorized()
            return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def _get_os_string() -> str:
    if platform.system().lower().startswith("win"):
        ver = platform.win32_ver()
        if ver and ver[0]:
            return f"{ver[0]} {ver[1]}".strip()
        return "Windows"
    return platform.platform()


def _disk_percent() -> float:
    try:
        usage = psutil.disk_usage(os.path.abspath(os.sep))
        return float(usage.percent)
    except Exception:
        return 0.0


def _uptime_seconds() -> int:
    try:
        return int(time.time() - psutil.boot_time())
    except Exception:
        return 0


def _resize_to_fit(img: Image.Image, max_w: int, max_h: int) -> Image.Image:
    if max_w <= 0 or max_h <= 0:
        return img
    w, h = img.size
    if w <= max_w and h <= max_h:
        return img
    scale = min(max_w / float(w), max_h / float(h))
    new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
    return img.resize(new_size, Image.Resampling.LANCZOS)


def capture_screenshot_jpeg(
    quality: int,
    max_w: int,
    max_h: int,
    timeout_seconds: float = 5.0,
) -> Dict[str, Any]:
    """
    Capture a screenshot of all monitors and return metadata + base64 JPEG.
    Uses a background thread to enforce a hard timeout.
    """
    result: Dict[str, Any] = {}
    error: Dict[str, str] = {}

    def _work() -> None:
        try:
            img = ImageGrab.grab(all_screens=True)
            img = img.convert("RGB")
            img = _resize_to_fit(img, max_w=max_w, max_h=max_h)
            buf = io.BytesIO()
            q = max(1, min(int(quality), 95))
            img.save(buf, format="JPEG", quality=q, optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            result.update(
                {
                    "screenshot": b64,
                    "format": "jpeg",
                    "quality": q,
                    "width": int(img.size[0]),
                    "height": int(img.size[1]),
                    "timestamp": _now_str(),
                }
            )
        except Exception as e:
            error["message"] = str(e)
            error["traceback"] = traceback.format_exc()

    t = threading.Thread(target=_work, daemon=True)
    t.start()
    t.join(timeout=timeout_seconds)

    if t.is_alive():
        raise TimeoutError("Screenshot capture timed out after 5 seconds")
    if error:
        raise RuntimeError(error["message"])
    return result


def _run_windows_command(args: list[str], timeout_seconds: float = 10.0) -> None:
    subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout_seconds)


def lock_windows() -> None:
    _run_windows_command(["rundll32.exe", "user32.dll,LockWorkStation"], timeout_seconds=5.0)


def shutdown_windows(delay: int, reason: str) -> None:
    delay_s = max(0, int(delay))
    safe_reason = (reason or "").replace('"', "'")
    _run_windows_command(["shutdown", "/s", "/t", str(delay_s), "/c", safe_reason], timeout_seconds=5.0)


def cancel_shutdown_windows() -> None:
    _run_windows_command(["shutdown", "/a"], timeout_seconds=5.0)


def _run_projection_ui(logger: logging.Logger) -> None:
    """Tk fullscreen loop (must run in its own thread)."""
    global _projection_ui_thread
    try:
        import tkinter as tk
        from PIL import ImageTk
    except Exception as e:
        logger.error("projection UI imports failed: %s", e)
        return

    root = tk.Tk()
    root.title("Screen projection")
    root.configure(bg="black")
    root.attributes("-fullscreen", True)
    root.attributes("-topmost", True)
    lbl = tk.Label(root, bg="black")
    lbl.pack(fill=tk.BOTH, expand=True)

    def pump() -> None:
        try:
            last_frame: Optional[bytes] = None
            stop_requested = False
            while True:
                try:
                    item = _projection_queue.get_nowait()
                except queue.Empty:
                    break
                if item is None:
                    stop_requested = True
                else:
                    last_frame = item
            if stop_requested:
                root.destroy()
                return
            if last_frame is None:
                root.after(120, pump)
                return
            img = Image.open(io.BytesIO(last_frame)).convert("RGB")
            sw = max(1, root.winfo_screenwidth())
            sh = max(1, root.winfo_screenheight())
            img = img.resize((sw, sh), Image.Resampling.LANCZOS)
            hold = ImageTk.PhotoImage(img)
            _projection_photo_ref.clear()
            _projection_photo_ref.append(hold)
            lbl.config(image=hold)
        except tk.TclError:
            return
        except Exception as e:
            logger.warning("projection frame: %s", e)
        root.after(120, pump)

    root.after(50, pump)
    try:
        root.mainloop()
    finally:
        with _projection_lock:
            _projection_ui_thread = None


def _ensure_projection_ui(logger: logging.Logger) -> None:
    global _projection_ui_thread
    with _projection_lock:
        if _projection_ui_thread is not None and _projection_ui_thread.is_alive():
            return
        _projection_ui_thread = threading.Thread(
            target=lambda: _run_projection_ui(logger),
            name="projection-ui",
            daemon=True,
        )
        _projection_ui_thread.start()


def _start_stream_player(stream_url: str, logger: logging.Logger) -> None:
    global _stream_player_proc
    with _stream_player_lock:
        if _stream_player_proc is not None and _stream_player_proc.poll() is None:
            try:
                _stream_player_proc.terminate()
                _stream_player_proc.wait(timeout=1.5)
            except Exception:
                try:
                    _stream_player_proc.kill()
                except Exception:
                    pass
            _stream_player_proc = None

        cmd = [
            "ffplay",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-framedrop",
            "-sync",
            "video",
            "-rtsp_transport",
            "tcp",
            "-window_title",
            "Live Stream",
            "-fs",
            stream_url,
        ]
        _stream_player_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        logger.info("stream player started url=%s", stream_url)


def _stop_stream_player(logger: logging.Logger) -> None:
    global _stream_player_proc
    with _stream_player_lock:
        if _stream_player_proc is None:
            return
        try:
            _stream_player_proc.terminate()
            _stream_player_proc.wait(timeout=1.5)
        except Exception:
            try:
                _stream_player_proc.kill()
            except Exception:
                pass
        _stream_player_proc = None
        logger.info("stream player stopped")


def _ask_projection_consent(sender_hostname: str, timeout_seconds: int = 25) -> bool:
    """
    Ask local guest user for consent before host projection starts.
    Uses Windows MessageBox for reliable topmost prompt.
    """
    if not platform.system().lower().startswith("win"):
        return True

    prompt = (
        f"{sender_hostname or 'Host PC'} wants to share their screen on this computer.\n\n"
        f"Allow screen sharing now?\n"
        f"(This prompt closes in {timeout_seconds}s and defaults to No.)"
    )
    title = "DYCI Screen Share Request"

    result: Dict[str, bool] = {"accepted": False}

    def _show() -> None:
        try:
            MB_YESNO = 0x00000004
            MB_ICONQUESTION = 0x00000020
            MB_TOPMOST = 0x00040000
            MB_SYSTEMMODAL = 0x00001000
            value = ctypes.windll.user32.MessageBoxW(0, prompt, title, MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SYSTEMMODAL)
            result["accepted"] = value == 6  # IDYES
        except Exception:
            result["accepted"] = False

    t = threading.Thread(target=_show, daemon=True)
    t.start()
    t.join(timeout=max(5, int(timeout_seconds)))
    return bool(result["accepted"])


def create_app(config: AgentConfig, logger: logging.Logger) -> Flask:
    app = Flask(__name__)
    auth_required = require_auth(config)

    @app.before_request
    def _log_request() -> None:
        try:
            ip = request.headers.get("X-Forwarded-For", request.remote_addr) or "unknown"
            logger.info("request ip=%s method=%s path=%s", ip, request.method, request.path)
        except Exception:
            # Avoid failing requests due to logging
            pass

    @app.errorhandler(Exception)
    def _handle_unexpected_error(err: Exception) -> Tuple[Response, int]:
        logger.error("Unhandled error: %s\n%s", err, traceback.format_exc())
        return jsonify({"error": "Internal server error"}), 500

    @app.get("/status")
    @auth_required
    def status() -> Tuple[Response, int]:
        try:
            hostname = platform.node()
            cpu = float(psutil.cpu_percent(interval=0.1))
            mem = float(psutil.virtual_memory().percent)
            disk = _disk_percent()
            uptime = _uptime_seconds()
            payload = {
                "status": "online",
                "hostname": hostname,
                "os": _get_os_string(),
                "cpu_percent": cpu,
                "memory_percent": mem,
                "disk_percent": disk,
                "uptime_seconds": uptime,
                "agent_version": AGENT_VERSION,
            }
            return jsonify(payload), 200
        except Exception as e:
            logger.error("status failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "Failed to get status"}), 500

    @app.get("/screenshot")
    @auth_required
    def screenshot() -> Tuple[Response, int]:
        try:
            payload = capture_screenshot_jpeg(
                quality=config.screenshot_quality,
                max_w=config.screenshot_max_width,
                max_h=config.screenshot_max_height,
                timeout_seconds=5.0,
            )
            logger.info("screenshot captured ts=%s", payload.get("timestamp"))
            return jsonify(payload), 200
        except Exception as e:
            logger.error("screenshot failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "Screenshot capture failed"}), 500

    @app.post("/lock")
    @auth_required
    def lock() -> Tuple[Response, int]:
        try:
            lock_windows()
            ts = _now_str()
            logger.info("lock action completed ts=%s", ts)
            return jsonify({"status": "success", "action": "locked", "timestamp": ts}), 200
        except Exception as e:
            logger.error("lock failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "Failed to lock PC"}), 500

    @app.post("/shutdown")
    @auth_required
    def shutdown() -> Tuple[Response, int]:
        try:
            body: Dict[str, Any] = {}
            if request.data:
                try:
                    body = request.get_json(force=True, silent=False) or {}
                except Exception:
                    return jsonify({"error": "Invalid JSON"}), 400

            delay = int(body.get("delay", config.default_shutdown_delay))
            reason = str(body.get("reason", "Controlled shutdown"))
            shutdown_windows(delay=delay, reason=reason)
            ts = _now_str()
            logger.info("shutdown initiated delay=%s ts=%s", delay, ts)
            return (
                jsonify({"status": "success", "action": "shutdown_initiated", "delay_seconds": delay, "timestamp": ts}),
                200,
            )
        except Exception as e:
            logger.error("shutdown failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "Failed to initiate shutdown"}), 500

    @app.post("/cancel_shutdown")
    @auth_required
    def cancel_shutdown() -> Tuple[Response, int]:
        try:
            cancel_shutdown_windows()
            ts = _now_str()
            logger.info("shutdown cancelled ts=%s", ts)
            return jsonify({"status": "success", "action": "shutdown_cancelled", "timestamp": ts}), 200
        except subprocess.CalledProcessError as e:
            # `shutdown /a` may return non-zero if no shutdown was scheduled.
            logger.error("cancel shutdown failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "No shutdown to cancel"}), 500
        except Exception as e:
            logger.error("cancel shutdown failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "No shutdown to cancel"}), 500

    @app.post("/project")
    @auth_required
    def project_screen() -> Tuple[Response, int]:
        """Receive a JPEG screenshot from the instructor host and show it fullscreen."""
        try:
            body: Dict[str, Any] = {}
            if request.data:
                body = request.get_json(force=True, silent=True) or {}
            b64 = body.get("screenshot") or ""
            if not b64:
                return jsonify({"error": "screenshot required"}), 400
            try:
                raw = base64.b64decode(b64)
            except Exception:
                return jsonify({"error": "invalid base64"}), 400
            if len(raw) < 100:
                return jsonify({"error": "screenshot payload too small"}), 400
            _ensure_projection_ui(logger)
            try:
                while True:
                    _projection_queue.get_nowait()
            except queue.Empty:
                pass
            _projection_queue.put(raw)
            logger.info("projection frame queued bytes=%s", len(raw))
            return jsonify({"status": "ok"}), 200
        except Exception as e:
            logger.error("project failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "projection failed"}), 500

    @app.post("/project_open")
    @auth_required
    def project_open_ep() -> Tuple[Response, int]:
        """Open projection window immediately on guest PC."""
        try:
            _ensure_projection_ui(logger)
            return jsonify({"status": "opened"}), 200
        except Exception as e:
            logger.error("project_open failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "projection open failed"}), 500

    @app.post("/project_request")
    @auth_required
    def project_request_ep() -> Tuple[Response, int]:
        """
        Ask guest user permission before host starts continuous projection.
        """
        try:
            body: Dict[str, Any] = request.get_json(force=True, silent=True) or {}
            sender = str(body.get("sender_hostname") or "Host PC")
            accepted = _ask_projection_consent(sender_hostname=sender, timeout_seconds=25)
            if not accepted:
                return jsonify({"accepted": False, "error": "Guest denied screen-share request"}), 403
            return jsonify({"accepted": True}), 200
        except Exception as e:
            logger.error("project_request failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "projection request failed"}), 500

    @app.post("/stop_projection")
    @auth_required
    def stop_projection_ep() -> Tuple[Response, int]:
        try:
            _projection_queue.put(None)
            logger.info("projection stop requested")
            return jsonify({"status": "stopped"}), 200
        except Exception as e:
            logger.error("stop_projection failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "stop failed"}), 500

    @app.post("/stream")
    @auth_required
    def start_stream_ep() -> Tuple[Response, int]:
        try:
            body: Dict[str, Any] = request.get_json(force=True, silent=True) or {}
            stream_url = str(body.get("stream_url") or "").strip()
            if not stream_url:
                return jsonify({"error": "stream_url required"}), 400
            if not (stream_url.startswith("rtsp://") or stream_url.startswith("rtsps://")):
                return jsonify({"error": "stream_url must be RTSP"}), 400
            _start_stream_player(stream_url=stream_url, logger=logger)
            return jsonify({"status": "streaming", "stream_url": stream_url}), 200
        except FileNotFoundError:
            return jsonify({"error": "ffplay not installed"}), 500
        except Exception as e:
            logger.error("stream start failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "stream start failed"}), 500

    @app.post("/stop_stream")
    @auth_required
    def stop_stream_ep() -> Tuple[Response, int]:
        try:
            _stop_stream_player(logger=logger)
            return jsonify({"status": "stopped"}), 200
        except Exception as e:
            logger.error("stream stop failed: %s\n%s", e, traceback.format_exc())
            return jsonify({"error": "stream stop failed"}), 500

    return app


def main() -> int:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(base_dir, "agent_config.json")

    config = load_config(config_path)
    logger = setup_logging(config.log_level)

    logger.info("Agent starting version=%s host=%s port=%s", AGENT_VERSION, config.host, config.port)

    ssl_context = None
    if config.enable_https:
        if not config.https_cert or not config.https_key:
            logger.error("HTTPS enabled but https_cert/https_key not configured")
            return 2
        ssl_context = (config.https_cert, config.https_key)

    app = create_app(config=config, logger=logger)
    app.run(host=config.host, port=config.port, threaded=True, ssl_context=ssl_context)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

