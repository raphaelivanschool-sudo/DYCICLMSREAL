"""
Tests for screenshot decode/resize helpers and controller screenshot wiring.
Run: python -m unittest test_screenshot_feature.py
"""
from __future__ import annotations

import base64
import io
import json
import unittest
from unittest.mock import MagicMock, patch

import requests
from PIL import Image

from controller import (
    ControllerApp,
    PCListItem,
    decode_screenshot_payload,
    screenshot_exception_message,
)


def _jpeg_b64(w: int, h: int) -> str:
    img = Image.new("RGB", (w, h), color=(120, 80, 40))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class TestDecodeScreenshot(unittest.TestCase):
    def test_image_decode(self) -> None:
        raw_b64 = _jpeg_b64(64, 48)
        payload = {"screenshot": raw_b64, "width": 64, "height": 48}
        img = decode_screenshot_payload(payload, (1280, 720))
        self.assertEqual(img.size[0], 64)
        self.assertEqual(img.size[1], 48)

    def test_image_resize(self) -> None:
        raw_b64 = _jpeg_b64(3000, 2000)
        payload = {"screenshot": raw_b64}
        img = decode_screenshot_payload(payload, (1280, 720))
        self.assertLessEqual(img.size[0], 1280)
        self.assertLessEqual(img.size[1], 720)
        self.assertGreater(img.size[0], 0)

    def test_invalid_payload(self) -> None:
        with self.assertRaises(ValueError):
            decode_screenshot_payload({}, (1280, 720))


class TestScreenshotErrors(unittest.TestCase):
    def test_timeout_handling(self) -> None:
        msg = screenshot_exception_message(requests.Timeout())
        self.assertIn("not responding", msg.lower())

    def test_connection_refused_mapping(self) -> None:
        msg = screenshot_exception_message(requests.ConnectionError("refused"))
        self.assertIn("unreachable", msg.lower())


class TestControllerScreenshotUI(unittest.TestCase):
    def test_screenshot_button_exists(self) -> None:
        root = __import__("tkinter").Tk()
        root.withdraw()
        try:
            app = ControllerApp(root)
            self.assertTrue(hasattr(app, "refresh_button"))
            self.assertIn("Refresh", app.refresh_button.cget("text"))
        finally:
            try:
                app.stop_event.set()
            except Exception:
                pass
            root.destroy()

    def test_refresh_requires_selection(self) -> None:
        root = __import__("tkinter").Tk()
        root.withdraw()
        try:
            app = ControllerApp(root)
            app._selected_ip = ""
            with patch("controller.messagebox.showinfo") as m:
                app.refresh_screenshot()
                m.assert_called_once()
        finally:
            app.stop_event.set()
            root.destroy()

    @patch("controller.AgentClient.get_screenshot")
    def test_screenshot_api_call(self, mock_get: MagicMock) -> None:
        mock_get.return_value = {"screenshot": _jpeg_b64(100, 80), "width": 100, "height": 80}
        root = __import__("tkinter").Tk()
        root.withdraw()
        try:
            app = ControllerApp(root)
            ip = "192.168.1.50"
            app.items[ip] = PCListItem(hostname="GUEST", ip=ip, api_key="secret", connection_type="LAN")
            app._selected_ip = ip
            app.tree.insert("", "end", iid=ip, values=("☑", "GUEST", ip, "✓ Online", "•"))
            app._manual_screenshot_busy = False
            app._sync_refresh_button_state()

            app.refresh_screenshot()
            import queue
            import time

            deadline = time.time() + 5.0
            done = False
            while time.time() < deadline and not done:
                root.update_idletasks()
                try:
                    while True:
                        kind, _ = app.events.get_nowait()
                        if kind == "screenshot_manual_done":
                            done = True
                            break
                except queue.Empty:
                    pass
                time.sleep(0.05)
            mock_get.assert_called()
            self.assertEqual(mock_get.call_args[0][0], ip)
            self.assertEqual(mock_get.call_args[0][1], "secret")
        finally:
            app.stop_event.set()
            root.destroy()

    def test_error_handling_does_not_crash_decode(self) -> None:
        with self.assertRaises(ValueError):
            decode_screenshot_payload({"screenshot": "!!!not-valid-base64!!!"}, (100, 100))


if __name__ == "__main__":
    unittest.main()
