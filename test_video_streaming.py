"""
Tests for real-time streaming helpers.
Run: python -m unittest test_video_streaming.py
"""
from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

from video_streamer import RTSPServer, ScreenCapturer, VideoEncoder, streaming_thread


class TestScreenCapturerTiming(unittest.TestCase):
    def test_capture_loop_target_fps(self) -> None:
        capturer = ScreenCapturer(fps=30)
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        calls = []

        def fake_capture_once() -> np.ndarray:
            calls.append(time.time())
            return frame

        with patch.object(capturer, "_capture_once", side_effect=fake_capture_once):
            capturer.start()
            time.sleep(1.1)
            capturer.stop()

        self.assertGreaterEqual(len(calls), 25)
        fps = len(calls) / (calls[-1] - calls[0])
        self.assertGreaterEqual(fps, 24.0)
        self.assertLessEqual(fps, 36.0)


class TestVideoEncoder(unittest.TestCase):
    def test_encoder_defaults(self) -> None:
        enc = VideoEncoder()
        self.assertEqual(enc.fps, 30)
        self.assertEqual(enc.bitrate, "8M")
        self.assertEqual(enc.crf, 23)
        self.assertIn(enc.pick_codec(), ("libx264", "h264_nvenc"))


class TestRTSPServer(unittest.TestCase):
    @patch("video_streamer.check_ffmpeg_installed", return_value=True)
    @patch("video_streamer.subprocess.Popen")
    def test_server_start_invokes_ffmpeg(self, mock_popen: MagicMock, _mock_ffmpeg: MagicMock) -> None:
        proc = MagicMock()
        proc.poll.return_value = None
        proc.stdin = MagicMock()
        mock_popen.return_value = proc

        server = RTSPServer(port=8554, path="stream")
        server.start(width=1280, height=720, encoder=VideoEncoder())
        self.assertIsNotNone(server.process)
        self.assertTrue(mock_popen.called)

    def test_send_packet_requires_started_process(self) -> None:
        server = RTSPServer()
        with self.assertRaises(RuntimeError):
            server.send_packet(np.zeros((10, 10, 3), dtype=np.uint8))


class TestStreamingLoop(unittest.TestCase):
    def test_streaming_thread_sends_frames(self) -> None:
        capturer = MagicMock()
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        calls = {"n": 0}

        def _next_frame() -> np.ndarray | None:
            calls["n"] += 1
            return frame if calls["n"] <= 3 else None

        capturer.get_latest_frame_copy.side_effect = _next_frame
        rtsp = MagicMock()
        stop_event = threading.Event()

        t = threading.Thread(target=streaming_thread, args=(capturer, rtsp, stop_event, 30), daemon=True)
        t.start()
        time.sleep(0.2)
        stop_event.set()
        t.join(timeout=1.0)

        self.assertGreaterEqual(rtsp.send_packet.call_count, 1)


if __name__ == "__main__":
    unittest.main()
