from __future__ import annotations

import logging
import os
import servicemanager
import socket
import sys
import threading
import time
import traceback
from typing import Optional

import win32event
import win32service
import win32serviceutil


def _setup_service_logging() -> logging.Logger:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    log_path = os.path.join(base_dir, "agent.log")

    logger = logging.getLogger("pc_agent_service")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.propagate = False

    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    sh = logging.StreamHandler()
    sh.setFormatter(formatter)
    logger.addHandler(sh)

    return logger


class PCAgentService(win32serviceutil.ServiceFramework):
    """
    Windows Service wrapper to run the Flask agent.
    """

    _svc_name_ = "PCAgentService"
    _svc_display_name_ = "PC Agent Service"
    _svc_description_ = "PC Agent Service (Flask API) for remote lab management"

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        socket.setdefaulttimeout(60)
        self._logger = _setup_service_logging()
        self._thread: Optional[threading.Thread] = None

    def SvcStop(self):
        self._logger.info("Service stop requested")
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)
        self.ReportServiceStatus(win32service.SERVICE_STOPPED)
        self._logger.info("Service stopped")

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, ""),
        )

        self._logger.info("Service starting")

        self._thread = threading.Thread(target=self._run_agent, daemon=True)
        self._thread.start()

        # Wait until stop is signaled.
        while True:
            rc = win32event.WaitForSingleObject(self.stop_event, 1000)
            if rc == win32event.WAIT_OBJECT_0:
                break

        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STOPPED,
            (self._svc_name_, ""),
        )

    def _run_agent(self) -> None:
        try:
            # Import here so service install can work even if deps are missing.
            from agent import main as agent_main  # type: ignore

            self._logger.info("Launching agent.py")
            agent_main()
        except SystemExit as e:
            self._logger.info("Agent exited: %s", e)
        except Exception as e:
            self._logger.error("Agent crashed: %s\n%s", e, traceback.format_exc())
            # Keep service alive briefly so crash is logged/flushed.
            time.sleep(1.0)


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(PCAgentService)

