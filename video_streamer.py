from __future__ import annotations

import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

try:
    import cv2
except Exception:  # pragma: no cover - dependency gate
    cv2 = None  # type: ignore[assignment]

try:
    import mss
except Exception:  # pragma: no cover - dependency gate
    mss = None  # type: ignore[assignment]


def check_ffmpeg_installed() -> bool:
    return shutil.which("ffmpeg") is not None


def check_ffplay_installed() -> bool:
    return shutil.which("ffplay") is not None


def get_local_ip_for_target(target_ip: str) -> str:
    """
    Get local source IP used to reach target_ip.
    Falls back to hostname resolution if route probing fails.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect((target_ip, 1))
            return str(sock.getsockname()[0])
    except Exception:
        try:
            return str(socket.gethostbyname(socket.gethostname()))
        except Exception:
            return "127.0.0.1"


class ScreenCapturer:
    def __init__(self, fps: int = 30, max_width: int = 1920, max_height: int = 1080) -> None:
        self.fps = max(1, int(fps))
        self.frame_time = 1.0 / float(self.fps)
        self.max_width = int(max_width)
        self.max_height = int(max_height)
        self.latest_frame: Optional[np.ndarray] = None
        self.is_capturing = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._sct: Optional[mss.mss] = None
        self._monitor: Optional[dict] = None

    def _resize_if_needed(self, frame: np.ndarray) -> np.ndarray:
        h, w = frame.shape[:2]
        if w <= self.max_width and h <= self.max_height:
            return frame
        if cv2 is None:
            raise RuntimeError("opencv-python is required for frame resize")
        scale = min(self.max_width / float(w), self.max_height / float(h))
        nw = max(1, int(w * scale))
        nh = max(1, int(h * scale))
        return cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)

    def _capture_once(self) -> np.ndarray:
        if mss is None or cv2 is None:
            raise RuntimeError("mss and opencv-python are required for screen capture")
        if self._sct is None:
            self._sct = mss.mss()
            self._monitor = self._sct.monitors[1]
        assert self._sct is not None
        assert self._monitor is not None
        shot = self._sct.grab(self._monitor)
        bgra = np.asarray(shot, dtype=np.uint8)
        bgr = cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR)
        return self._resize_if_needed(bgr)

    def capture_loop(self) -> None:
        while self.is_capturing:
            start = time.time()
            frame = self._capture_once()
            with self._lock:
                self.latest_frame = frame
            elapsed = time.time() - start
            time.sleep(max(0.0, self.frame_time - elapsed))

    def get_latest_frame_copy(self) -> Optional[np.ndarray]:
        with self._lock:
            if self.latest_frame is None:
                return None
            return self.latest_frame.copy()

    def start(self) -> None:
        if self.is_capturing:
            return
        self.is_capturing = True
        self._thread = threading.Thread(target=self.capture_loop, daemon=True, name="screen-capture-loop")
        self._thread.start()

    def stop(self) -> None:
        self.is_capturing = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        if self._sct is not None:
            self._sct.close()
            self._sct = None
            self._monitor = None


class VideoEncoder:
    """
    Container for H.264 encoder parameters used by RTSPServer.
    """

    def __init__(
        self,
        fps: int = 30,
        bitrate: str = "8M",
        crf: int = 23,
        preset: str = "ultrafast",
        use_hwaccel_if_available: bool = True,
    ) -> None:
        self.fps = int(fps)
        self.bitrate = str(bitrate)
        self.crf = int(crf)
        self.preset = str(preset)
        self.use_hwaccel_if_available = bool(use_hwaccel_if_available)

    def pick_codec(self) -> str:
        if self.use_hwaccel_if_available and shutil.which("nvidia-smi"):
            return "h264_nvenc"
        return "libx264"


class RTSPServer:
    """
    FFmpeg-driven RTSP listening endpoint.
    FFmpeg receives raw BGR frames on stdin and serves RTSP.
    """

    def __init__(self, port: int = 8554, path: str = "stream") -> None:
        self.port = int(port)
        self.path = path.strip("/") or "stream"
        self.process: Optional[subprocess.Popen] = None
        self.url = f"rtsp://0.0.0.0:{self.port}/{self.path}"

    def start(self, width: int, height: int, encoder: VideoEncoder) -> None:
        if not check_ffmpeg_installed():
            raise RuntimeError("FFmpeg is not installed or not in PATH.")
        if self.process is not None and self.process.poll() is None:
            return

        codec = encoder.pick_codec()
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-f",
            "rawvideo",
            "-pixel_format",
            "bgr24",
            "-video_size",
            f"{width}x{height}",
            "-framerate",
            str(encoder.fps),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            codec,
            "-preset",
            encoder.preset,
            "-tune",
            "zerolatency",
            "-crf",
            str(encoder.crf),
            "-b:v",
            encoder.bitrate,
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rtsp",
            "-rtsp_transport",
            "tcp",
            "-rtsp_flags",
            "listen",
            self.url,
        ]
        self.process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )

    def send_packet(self, frame: np.ndarray) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("RTSP server is not started")
        if self.process.poll() is not None:
            raise RuntimeError("FFmpeg RTSP process exited unexpectedly")
        self.process.stdin.write(frame.tobytes())

    def stop(self) -> None:
        if self.process is None:
            return
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except Exception:
            pass
        try:
            self.process.terminate()
            self.process.wait(timeout=2.0)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass
        self.process = None


@dataclass
class StreamSession:
    capturer: ScreenCapturer
    encoder: VideoEncoder
    rtsp_server: RTSPServer
    stop_event: threading.Event
    stream_thread: threading.Thread
    width: int
    height: int
    stream_url: str


def streaming_thread(capturer: ScreenCapturer, rtsp_server: RTSPServer, stop_event: threading.Event, fps: int = 30) -> None:
    frame_time = 1.0 / float(max(1, fps))
    while not stop_event.is_set():
        start = time.time()
        frame = capturer.get_latest_frame_copy()
        if frame is not None:
            rtsp_server.send_packet(frame)
        elapsed = time.time() - start
        time.sleep(max(0.0, frame_time - elapsed))
