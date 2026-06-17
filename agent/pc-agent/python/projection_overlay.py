#!/usr/bin/env python3
"""
Locked Demo Mode overlay (guest side).

Spawned by the Node PC agent when an instructor projects their screen. While a
session is active this window:

  * covers every monitor (borderless, fullscreen, always-on-top, re-asserted),
  * blocks all keyboard + mouse input to the OS underneath (Windows low-level
    hooks via ctypes), so the guest cannot alt-tab/minimize/close out,
  * renders the instructor's JPEG frames (letterboxed), with an
    "Instructor is presenting…" placeholder until the first frame arrives.

Fail-open by design: the overlay watches a heartbeat file kept fresh by the
agent. If the heartbeat goes stale (agent crash / network drop) or is removed
(clean stop), the overlay exits and input is restored. There is no key/click a
guest can use to dismiss it — only stop / watchdog / shutdown end it.

Platform note: Ctrl+Alt+Del (Secure Attention Sequence) cannot be blocked from
user space. Full input lock requires the agent to run elevated; without it the
overlay still covers the screen but underlying input may not be fully swallowed.
"""

import argparse
import ctypes
import io
import logging
import os
import sys
import tempfile
import threading
import time

IS_WINDOWS = sys.platform.startswith("win")

# Log to a file the agent/operator can inspect — the Node agent spawns this with
# no console, so a crash would otherwise be invisible. The agent also surfaces a
# clear "overlay keeps crashing" error to the dashboard pointing here.
LOG_PATH = os.path.join(tempfile.gettempdir(), "dyci_projection_overlay.log")
logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("projection_overlay")


# --------------------------------------------------------------------------- #
# Global input blocking (Windows low-level keyboard + mouse hooks via ctypes). #
# Low-level hooks do NOT require DLL injection but DO require the installing    #
# thread to pump messages, so we run them on a dedicated thread.               #
# --------------------------------------------------------------------------- #
class InputBlocker:
    WH_KEYBOARD_LL = 13
    WH_MOUSE_LL = 14
    WM_QUIT = 0x0012

    def __init__(self):
        self._thread = None
        self._thread_id = None
        self._kb_hook = None
        self._mouse_hook = None
        self._kb_proc = None
        self._mouse_proc = None
        self.active = False
        self.error = None

    def start(self):
        if not IS_WINDOWS:
            self.error = "input lock unavailable on non-Windows (overlay covers screen only)"
            return
        self._thread = threading.Thread(target=self._run, name="input-blocker", daemon=True)
        self._thread.start()

    def _run(self):
        try:
            import ctypes.wintypes as wt

            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            LRESULT = ctypes.c_ssize_t
            HOOKPROC = ctypes.CFUNCTYPE(LRESULT, ctypes.c_int, wt.WPARAM, wt.LPARAM)

            # Pointer-sized argtypes/restypes are essential on 64-bit: without them
            # ctypes assumes c_int and truncates HHOOK/HMODULE handles, which makes
            # SetWindowsHookEx silently fail (no input lock).
            user32.SetWindowsHookExW.restype = ctypes.c_void_p
            user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wt.DWORD]
            user32.CallNextHookEx.restype = LRESULT
            user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
            user32.UnhookWindowsHookEx.restype = wt.BOOL
            user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
            kernel32.GetModuleHandleW.restype = ctypes.c_void_p
            kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
            kernel32.GetCurrentThreadId.restype = wt.DWORD

            def _make_proc(hook_ref):
                def _proc(nCode, wParam, lParam):
                    # nCode == HC_ACTION (0) and >=0 means a real event: swallow it
                    # by returning non-zero WITHOUT chaining to CallNextHookEx.
                    if nCode >= 0:
                        return 1
                    return user32.CallNextHookEx(hook_ref[0], nCode, wParam, lParam)
                return _proc

            kb_ref = [None]
            mouse_ref = [None]
            self._kb_proc = HOOKPROC(_make_proc(kb_ref))
            self._mouse_proc = HOOKPROC(_make_proc(mouse_ref))

            hmod = kernel32.GetModuleHandleW(None)
            self._thread_id = kernel32.GetCurrentThreadId()

            self._kb_hook = user32.SetWindowsHookExW(self.WH_KEYBOARD_LL, self._kb_proc, hmod, 0)
            kb_ref[0] = self._kb_hook
            self._mouse_hook = user32.SetWindowsHookExW(self.WH_MOUSE_LL, self._mouse_proc, hmod, 0)
            mouse_ref[0] = self._mouse_hook

            if not self._kb_hook or not self._mouse_hook:
                self.error = "SetWindowsHookEx failed (run the agent as Administrator for full input lock)"
                log.error(self.error)
                return

            self.active = True
            log.info("global input lock engaged")

            # Pump messages so the low-level hooks fire. Exits on WM_QUIT.
            msg = wt.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as e:  # pragma: no cover - platform specific
            self.error = f"input blocker error: {e}"
            log.exception("input blocker crashed")
        finally:
            self._unhook()

    def _unhook(self):
        try:
            if IS_WINDOWS:
                user32 = ctypes.windll.user32
                if self._kb_hook:
                    user32.UnhookWindowsHookEx(self._kb_hook)
                    self._kb_hook = None
                if self._mouse_hook:
                    user32.UnhookWindowsHookEx(self._mouse_hook)
                    self._mouse_hook = None
        except Exception:
            pass
        self.active = False

    def stop(self):
        # Ask the pump thread to exit; the OS also auto-removes hooks on process
        # termination, so a force-kill of this process still restores input.
        if IS_WINDOWS and self._thread_id:
            try:
                ctypes.windll.user32.PostThreadMessageW(
                    self._thread_id, self.WM_QUIT, 0, 0
                )
            except Exception:
                pass
        self._unhook()


def _virtual_screen_rect():
    """Bounding box covering all monitors (Windows); fallback to primary."""
    if IS_WINDOWS:
        try:
            user32 = ctypes.windll.user32
            SM_XVIRTUALSCREEN = 76
            SM_YVIRTUALSCREEN = 77
            SM_CXVIRTUALSCREEN = 78
            SM_CYVIRTUALSCREEN = 79
            x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
            y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
            w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
            h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
            if w > 0 and h > 0:
                return x, y, w, h
        except Exception:
            pass
    return None


def main():
    parser = argparse.ArgumentParser(description="DYCI Locked Demo Mode overlay")
    parser.add_argument("--frame", required=True, help="path to the latest JPEG frame file")
    parser.add_argument("--heartbeat", required=True, help="path to the heartbeat file")
    parser.add_argument("--watchdog", type=float, default=8.0, help="stale-heartbeat timeout (s)")
    parser.add_argument("--session", default="", help="session id (informational)")
    parser.add_argument(
        "--placeholder",
        default="Instructor is presenting…",
        help="text shown until the first frame arrives",
    )
    args = parser.parse_args()

    log.info("overlay starting (session=%s, frame=%s)", args.session, args.frame)
    try:
        import tkinter as tk
        from PIL import Image, ImageTk
    except Exception as e:  # pragma: no cover
        msg = f"required UI libs missing (need Pillow + tkinter): {e}"
        sys.stderr.write(f"projection_overlay: {msg}\n")
        log.error(msg)
        return 2

    # Mark DPI awareness so geometry matches physical pixels on Windows.
    if IS_WINDOWS:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

    blocker = InputBlocker()
    blocker.start()

    root = tk.Tk()
    root.title("DYCI Locked Demo Mode")
    root.configure(bg="black")
    root.overrideredirect(True)
    root.attributes("-topmost", True)

    rect = _virtual_screen_rect()
    if rect:
        x, y, w, h = rect
        root.geometry(f"{w}x{h}+{x}+{y}")
    else:
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = sw, sh
        root.geometry(f"{sw}x{sh}+0+0")
        try:
            root.attributes("-fullscreen", True)
        except Exception:
            pass

    label = tk.Label(
        root,
        bg="black",
        fg="#dddddd",
        text=args.placeholder,
        font=("Segoe UI", 28),
    )
    label.pack(fill=tk.BOTH, expand=True)

    state = {"running": True, "last_mtime": 0.0, "photo": None, "got_frame": False}

    def shutdown(reason=""):
        if not state["running"]:
            return
        state["running"] = False
        try:
            blocker.stop()
        finally:
            try:
                root.destroy()
            except Exception:
                pass

    # Re-assert always-on-top to defeat focus-stealing / other topmost windows.
    def reassert_topmost():
        if not state["running"]:
            return
        try:
            root.attributes("-topmost", True)
            root.lift()
            root.focus_force()
            if IS_WINDOWS:
                hwnd = root.winfo_id()
                HWND_TOPMOST = -1
                SWP_NOMOVE = 0x0002
                SWP_NOSIZE = 0x0001
                SWP_NOACTIVATE = 0x0010
                ctypes.windll.user32.SetWindowPos(
                    hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
        except Exception:
            pass
        root.after(500, reassert_topmost)

    # Watchdog: stale or missing heartbeat → fail open (restore input + exit).
    def check_watchdog():
        if not state["running"]:
            return
        try:
            mtime = os.path.getmtime(args.heartbeat)
            if time.time() - mtime > args.watchdog:
                shutdown("heartbeat_stale")
                return
        except OSError:
            # Heartbeat removed → agent asked for a clean stop.
            shutdown("heartbeat_removed")
            return
        root.after(500, check_watchdog)

    # Render newest frame (letterboxed). Drops repeats via mtime.
    def render_frame():
        if not state["running"]:
            return
        try:
            mtime = os.path.getmtime(args.frame)
            if mtime != state["last_mtime"]:
                state["last_mtime"] = mtime
                with open(args.frame, "rb") as f:
                    data = f.read()
                if data:
                    img = Image.open(io.BytesIO(data)).convert("RGB")
                    cw = max(1, root.winfo_width())
                    ch = max(1, root.winfo_height())
                    iw, ih = img.size
                    scale = min(cw / iw, ch / ih)
                    nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
                    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
                    canvas = Image.new("RGB", (cw, ch), (0, 0, 0))
                    canvas.paste(img, ((cw - nw) // 2, (ch - nh) // 2))
                    photo = ImageTk.PhotoImage(canvas)
                    state["photo"] = photo  # keep a ref
                    label.config(image=photo, text="")
                    state["got_frame"] = True
        except (OSError, ValueError):
            pass  # frame not ready / mid-write; try again next tick
        except Exception:
            pass
        root.after(60, render_frame)

    root.after(100, reassert_topmost)
    root.after(500, check_watchdog)
    root.after(100, render_frame)

    # No escape hatch for the guest: swallow window-level key/close attempts too.
    root.protocol("WM_DELETE_WINDOW", lambda: None)
    root.bind("<Escape>", lambda e: "break")
    root.bind("<Alt-F4>", lambda e: "break")

    try:
        root.mainloop()
    finally:
        shutdown("mainloop_exit")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        # Any uncaught error must be logged (we run headless under pythonw) so the
        # crash is diagnosable; the agent's watchdog still restores guest input.
        log.exception("overlay crashed (uncaught)")
        sys.exit(1)
