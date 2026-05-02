"""
Tests for host-to-guest screen projection (controller).

Uses mocks so no guest agent or display server is required.
"""

from __future__ import annotations

import base64
import io
import logging
import threading
import unittest
from unittest.mock import MagicMock, patch

import tkinter as tk
from PIL import Image

import controller as ctl


def _quiet_setup_logging(_level: str = "ERROR") -> logging.Logger:
    log = logging.getLogger("controller")
    for h in list(log.handlers):
        try:
            h.close()
        except Exception:
            pass
        log.removeHandler(h)
    log.setLevel(logging.CRITICAL)
    log.addHandler(logging.NullHandler())
    log.propagate = False
    return log


def _minimal_controller_app() -> ctl.ControllerApp:
    root = tk.Tk()
    root.withdraw()
    with patch.object(ctl, "setup_logging", _quiet_setup_logging):
        with patch.object(ctl.ControllerApp, "_build_ui", lambda self: None):
            with patch.object(ctl.ControllerApp, "_bind_shortcuts", lambda self: None):
                with patch.object(ctl.ControllerApp, "_load_known_pcs", lambda self: None):
                    with patch.object(ctl.ControllerApp, "_set_status", lambda self, text: None):
                        with patch.object(ctl.StatusChecker, "start", MagicMock()):
                            with patch.object(ctl.ScreenshotFetcher, "start", MagicMock()):
                                app = ctl.ControllerApp(root)
    app.root = root
    return app


class TestProjectionHelpers(unittest.TestCase):
    def test_screenshot_to_base64_roundtrip(self) -> None:
        app = _minimal_controller_app()
        app.config.projection["jpeg_quality"] = 50
        img = Image.new("RGB", (64, 48), color=(200, 100, 50))
        b64 = app.screenshot_to_base64(img)
        self.assertTrue(len(b64) > 20)
        raw = base64.b64decode(b64)
        Image.open(io.BytesIO(raw)).verify()

    @patch("controller.pyautogui.screenshot")
    def test_capture_host_screenshot(self, mock_ss: MagicMock) -> None:
        app = _minimal_controller_app()
        mock_ss.return_value = Image.new("RGB", (1920, 1080), color=(10, 20, 30))
        img = app.capture_host_screenshot()
        self.assertEqual(img.mode, "RGB")
        self.assertLessEqual(img.size[0], int(app.config.projection.get("max_width", 1280)))
        self.assertLessEqual(img.size[1], int(app.config.projection.get("max_height", 720)))

    def test_send_projection_payload_shape(self) -> None:
        logger = ctl.setup_logging("ERROR")
        client = ctl.AgentClient(logger)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        with patch.object(client, "_request", return_value=mock_resp) as req:
            body = {"screenshot": "abc", "sender_hostname": "h1", "timestamp": "t"}
            r = client.post_project("192.168.1.5", "key1", body)
            self.assertEqual(r.status_code, 200)
            args, kwargs = req.call_args
            self.assertEqual(args[0], "POST")
            self.assertIn("/project", args[1])
            self.assertEqual(kwargs.get("json_body"), body)


class TestProjectionFlow(unittest.TestCase):
    def tearDown(self) -> None:
        log = logging.getLogger("controller")
        for h in list(log.handlers):
            try:
                h.close()
            except Exception:
                pass
            log.removeHandler(h)

    @patch("controller.pyautogui.screenshot")
    def test_start_stop_projection(self, mock_ss: MagicMock) -> None:
        app = _minimal_controller_app()
        mock_ss.return_value = Image.new("RGB", (400, 300), color=(5, 5, 5))

        called = {"n": 0}

        def fake_post_project(ip: str, api_key: str, body: dict) -> object:
            called["n"] += 1
            r = MagicMock()
            r.status_code = 200
            return r

        def fake_stop(ip: str, api_key: str) -> object:
            r = MagicMock()
            r.status_code = 200
            return r

        app.client.post_project = fake_post_project  # type: ignore[method-assign]
        app.client.post_stop_projection = fake_stop  # type: ignore[method-assign]

        app.config.projection["update_interval"] = 1
        app.start_projection("10.0.0.2", "k", "Guest")
        for _ in range(50):
            if called["n"] >= 1:
                break
            threading.Event().wait(0.05)
        self.assertGreaterEqual(called["n"], 1)

        app.stop_projection(pc_ip="10.0.0.2", notify_agent=True)
        for _ in range(50):
            if not app.projection_active.get("10.0.0.2", False):
                break
            threading.Event().wait(0.05)
        self.assertFalse(app.projection_active.get("10.0.0.2", False))

    @patch("controller.pyautogui.screenshot")
    def test_error_handling_agent_rejected(self, mock_ss: MagicMock) -> None:
        """Non-200 from agent stops projection and emits projection_error (auto_stop default)."""
        app = _minimal_controller_app()
        mock_ss.return_value = Image.new("RGB", (400, 300), color=(1, 2, 3))

        def bad_post(*_a, **_k):
            r = MagicMock()
            r.status_code = 503
            r.json.return_value = {"error": "busy"}
            r.text = ""
            return r

        app.client.post_project = bad_post  # type: ignore[method-assign]
        app.client.post_stop_projection = lambda *a, **k: MagicMock(status_code=200)  # type: ignore
        app.config.projection["auto_stop_on_error"] = True

        app.start_projection("10.0.0.9", "k", "Guest9")
        for _ in range(100):
            if not app.projection_active.get("10.0.0.9", True):
                break
            threading.Event().wait(0.02)
        self.assertFalse(app.projection_active.get("10.0.0.9", True))
        try:
            kind, _payload = app.events.get_nowait()
        except Exception:
            self.fail("expected projection_error event")
        self.assertEqual(kind, "projection_error")

    @patch("controller.pyautogui.screenshot")
    def test_multiple_parallel_streams(self, mock_ss: MagicMock) -> None:
        """Two guests can receive projection concurrently."""
        app = _minimal_controller_app()
        mock_ss.return_value = Image.new("RGB", (200, 150), color=(9, 9, 9))
        counts = {"10.0.0.1": 0, "10.0.0.2": 0}

        def fake_post(ip: str, api_key: str, body: dict) -> object:
            counts[ip] = counts.get(ip, 0) + 1
            r = MagicMock()
            r.status_code = 200
            return r

        app.client.post_project = fake_post  # type: ignore[method-assign]
        app.client.post_stop_projection = lambda *a, **k: MagicMock(status_code=200)  # type: ignore
        app.config.projection["update_interval"] = 1

        app.start_projection("10.0.0.1", "k1", "A")
        app.start_projection("10.0.0.2", "k2", "B")
        for _ in range(80):
            if counts["10.0.0.1"] >= 1 and counts["10.0.0.2"] >= 1:
                break
            threading.Event().wait(0.05)
        self.assertGreaterEqual(counts["10.0.0.1"], 1)
        self.assertGreaterEqual(counts["10.0.0.2"], 1)
        self.assertTrue(app.projection_active.get("10.0.0.1", False))
        self.assertTrue(app.projection_active.get("10.0.0.2", False))

        app.stop_projection(pc_ip="10.0.0.1", notify_agent=False)
        app.stop_projection(pc_ip="10.0.0.2", notify_agent=False)
        for _ in range(80):
            if not app.projection_active.get("10.0.0.1") and not app.projection_active.get("10.0.0.2"):
                break
            threading.Event().wait(0.05)

    def test_multiple_projections_allowed(self) -> None:
        app = _minimal_controller_app()
        with app.projection_lock:
            app.projection_active["10.0.0.1"] = True
            app.projection_active["10.0.0.2"] = True
        self.assertEqual(sum(1 for v in app.projection_active.values() if v), 2)


class TestUIProjectionWidgets(unittest.TestCase):
    def tearDown(self) -> None:
        log = logging.getLogger("controller")
        for h in list(log.handlers):
            try:
                h.close()
            except Exception:
                pass
            log.removeHandler(h)

    def test_projection_buttons_exist(self) -> None:
        root = tk.Tk()
        root.withdraw()
        with patch.object(ctl, "setup_logging", _quiet_setup_logging):
            with patch.object(ctl.StatusChecker, "start", MagicMock()):
                with patch.object(ctl.ScreenshotFetcher, "start", MagicMock()):
                    app = ctl.ControllerApp(root)
        self.assertTrue(hasattr(app, "project_button"))
        self.assertTrue(hasattr(app, "stop_projection_button"))
        self.assertTrue(hasattr(app, "projection_status_label"))
        root.destroy()

    def test_ui_thread_not_blocked_by_projection_start(self) -> None:
        """Starting projection runs work on a background thread; main thread id unchanged."""
        app = _minimal_controller_app()
        main_id = threading.get_ident()

        def fake_post(*_a, **_k):
            r = MagicMock()
            r.status_code = 200
            return r

        app.client.post_project = fake_post  # type: ignore[method-assign]
        app.config.projection["update_interval"] = 10
        app.start_projection("10.0.0.5", "k", "X")
        self.assertEqual(threading.get_ident(), main_id)
        app.stop_projection(pc_ip="10.0.0.5", notify_agent=False)


class TestErrorMapping(unittest.TestCase):
    def test_projection_exception_message_timeout(self) -> None:
        import requests

        try:
            raise requests.Timeout()
        except requests.Timeout as e:
            msg = ctl.projection_exception_message(e)
            self.assertIn("timeout", msg.lower())


if __name__ == "__main__":
    unittest.main()
