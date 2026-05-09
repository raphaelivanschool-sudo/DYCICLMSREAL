import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, RefreshCw, Search, AlertCircle, Radio, Power } from 'lucide-react';
import networkApi from '../../services/network-api.js';
import { agentsApi } from '../../services/api.js';
import socketService from '../../services/socketService.js';

const RESULT_TIMEOUT_MS = 90000;
const SCREENSHOT_AUTO_MS = 3000;
// Interval for sending JPEG frames to the guest agent (~10 FPS).
// (This is the proven "projection" path; RTSP/H.264 is separate and currently more fragile.)
const PROJECTION_INTERVAL_MS = 100;
const SCAN_POLL_MS = 1500;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result;
      if (typeof s === 'string') {
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      } else {
        reject(new Error('Invalid read result'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Attach agent UUID to scan/broadcast rows when an online agent reports the same LAN IP (or ipAddresses). */
function mergeAgentIdsOntoScanRows(prevByIp, connectedDevices) {
  if (!connectedDevices?.length) return prevByIp;
  const next = { ...prevByIp };
  for (const ip of Object.keys(next)) {
    const row = next[ip];
    if (row.agentId) continue;
    const match = connectedDevices.find((d) => {
      const ips = [
        d.ip,
        ...(Array.isArray(d.ipAddresses) ? d.ipAddresses : []),
        ...(Array.isArray(d.interfaceBindings) ? d.interfaceBindings.map((b) => b?.ip).filter(Boolean) : []),
      ].filter(Boolean);
      return ips.some((a) => String(a) === String(ip));
    });
    if (match?.id) {
      next[ip] = {
        ...row,
        agentId: match.id,
        connection_type: 'agent',
        source: row.source && !String(row.source).includes('agent') ? `${row.source}+agent` : 'agent',
      };
    }
  }
  return next;
}

function DeveloperModePage() {
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [resultsByIp, setResultsByIp] = useState({});
  const [lastRunAt, setLastRunAt] = useState(null);
  const [scannerWarnings, setScannerWarnings] = useState([]);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanSubnet, setScanSubnet] = useState('');
  const [selectedIp, setSelectedIp] = useState('');
  const [lockingIp, setLockingIp] = useState('');
  const [lockStatus, setLockStatus] = useState('');
  const [lockError, setLockError] = useState('');
  const [shuttingDownIp, setShuttingDownIp] = useState('');
  const [shutdownStatus, setShutdownStatus] = useState('');
  const [shutdownError, setShutdownError] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [screenshotStatus, setScreenshotStatus] = useState('');
  const [screenshotFetching, setScreenshotFetching] = useState(false);
  const [autoRefreshScreenshot, setAutoRefreshScreenshot] = useState(false);
  const [projectionActive, setProjectionActive] = useState(false);
  const [projectionStatus, setProjectionStatus] = useState('');
  const projectionRunningRef = useRef(false);
  const projectionIntervalRef = useRef(null);
  const projectionStreamRef = useRef(null);
  const selectedAgentIdRef = useRef(null);
  const commandTargetComputerIdRef = useRef(null);
  const pendingScreenshotCommandRef = useRef(false);
  const selectedDisplayRef = useRef({ host: 'PC', ip: '' });
  const lastScreenshotRequestRef = useRef({ silent: false });

  const results = useMemo(() => {
    const items = Object.values(resultsByIp);
    items.sort((a, b) => (a.ip || '').localeCompare(b.ip || ''));
    return items;
  }, [resultsByIp]);

  useEffect(() => {
    if (!socketService.connected()) {
      socketService.connect();
    }
  }, []);

  const selectedDevice = results.find((d) => d.ip === selectedIp) || null;

  useEffect(() => {
    selectedAgentIdRef.current = selectedDevice?.agentId || null;
    commandTargetComputerIdRef.current = selectedDevice?.agentId || null;
  }, [selectedDevice?.agentId]);

  useEffect(() => {
    const d = Object.values(resultsByIp).find((x) => x.ip === selectedIp);
    const host = d?.user || d?.hostname || selectedIp || 'PC';
    selectedDisplayRef.current = { ip: selectedIp || '', host };
  }, [resultsByIp, selectedIp]);

  useEffect(() => {
    setScreenshotUrl('');
    setScreenshotStatus('');
    setScreenshotFetching(false);
    pendingScreenshotCommandRef.current = false;
  }, [selectedIp]);

  const lockDevice = async (device) => {
    if (!device?.ip) return;

    const hostname = device.user || device.hostname || 'Unknown';
    const ip = device.ip;

    const confirmed = window.confirm(
      `Lock ${hostname} (${ip})?\n\nPC will be locked immediately.`
    );
    if (!confirmed) return;

    setLockingIp(ip);
    setLockStatus('Locking...');
    setLockError('');

    try {
      if (!device.ip) {
        throw new Error('Missing IP for this row.');
      }
      const res = await agentsApi.sendCommand(device.agentId, 'lock', {}, { ip: device.ip, mac: device.mac });
      const rid = res?.data?.resolvedComputerId;
      if (rid) {
        commandTargetComputerIdRef.current = rid;
      }
      setLockStatus(`✓ ${hostname} Locked`);
      setLockError('');
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Unknown error';
      setLockError(`✗ Lock failed: ${msg}`);
      setLockStatus('');
    } finally {
      setLockingIp('');
    }
  };

  const shutdownDevice = async (device) => {
    if (!device?.ip) return;

    const hostname = device.user || device.hostname || 'Unknown';
    const ip = device.ip;

    const confirmed = window.confirm(
      `Shut down ${hostname} (${ip})?\n\nThis will power off the PC immediately. Unsaved work may be lost.`
    );
    if (!confirmed) return;

    setShuttingDownIp(ip);
    setShutdownStatus('Sending shutdown...');
    setShutdownError('');

    try {
      const res = await agentsApi.sendCommand(device.agentId, 'shutdown', { delay: 0 }, { ip: device.ip, mac: device.mac });
      const rid = res?.data?.resolvedComputerId;
      if (rid) {
        commandTargetComputerIdRef.current = rid;
      }
      setShutdownStatus(`✓ Shutdown command sent to ${hostname} (${ip})`);
      setShutdownError('');
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Unknown error';
      setShutdownError(`✗ Shutdown failed: ${msg}`);
      setShutdownStatus('');
    } finally {
      setShuttingDownIp('');
    }
  };

  const applyScreenshotResult = useCallback((event) => {
    if (event.action !== 'screenshot') return;
    const candidates = [selectedAgentIdRef.current, commandTargetComputerIdRef.current].filter(Boolean);
    let matches = Boolean(event.computerId && candidates.includes(event.computerId));
    if (!matches && pendingScreenshotCommandRef.current && event.computerId) {
      pendingScreenshotCommandRef.current = false;
      commandTargetComputerIdRef.current = event.computerId;
      matches = true;
    }
    if (!matches) return;
    pendingScreenshotCommandRef.current = false;

    const { silent } = lastScreenshotRequestRef.current;
    setScreenshotFetching(false);

    if (event.success && event.result?.screenshot) {
      const fmt = (event.result.format || 'png').toLowerCase();
      const mime =
        fmt === 'jpeg' || fmt === 'jpg'
          ? 'image/jpeg'
          : fmt === 'png'
            ? 'image/png'
            : 'image/png';
      setScreenshotUrl(`data:${mime};base64,${event.result.screenshot}`);
      const t = new Date().toLocaleTimeString();
      const host = selectedDisplayRef.current.host;
      if (!silent) {
        setScreenshotStatus(`✓ Screenshot updated — ${host} — Last updated: ${t}`);
      } else {
        setScreenshotStatus(`Live — ${host} — Last updated: ${t}`);
      }
      return;
    }

    const msg = event.error || event.result?.error || 'Screenshot failed';
    if (!silent) {
      setScreenshotStatus(`✗ Error: ${msg}`);
    }
  }, []);

  useEffect(() => {
    const unsub = socketService.on('agent_command_result', applyScreenshotResult);
    return unsub;
  }, [applyScreenshotResult]);

  const requestScreenshot = useCallback(
    async ({ silent = false } = {}) => {
      const agentId = selectedDevice?.agentId;
      const ip = selectedDevice?.ip;
      const mac = selectedDevice?.mac;
      if (!ip) {
        if (!silent) {
          setScreenshotStatus('✗ Select a PC row with an IP address.');
        }
        return;
      }
      lastScreenshotRequestRef.current = { silent };
      pendingScreenshotCommandRef.current = true;
      if (!silent) {
        setScreenshotFetching(true);
        setScreenshotStatus('Fetching screenshot...');
      }
      try {
        const res = await agentsApi.sendCommand(agentId, 'screenshot', {}, { ip, mac });
        const rid = res?.data?.resolvedComputerId;
        if (rid) {
          commandTargetComputerIdRef.current = rid;
        }
      } catch (error) {
        pendingScreenshotCommandRef.current = false;
        setScreenshotFetching(false);
        if (!silent) {
          const msg = error.response?.data?.error || error.message || 'Could not send screenshot command';
          setScreenshotStatus(`✗ Error: ${msg}`);
        }
      }
    },
    [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac]
  );

  useEffect(() => {
    if (!autoRefreshScreenshot || !selectedDevice?.ip) {
      return undefined;
    }
    const tick = () => {
      requestScreenshot({ silent: true });
    };
    const id = window.setInterval(tick, SCREENSHOT_AUTO_MS);
    return () => window.clearInterval(id);
  }, [autoRefreshScreenshot, selectedDevice?.ip, requestScreenshot]);

  const stopHostProjection = useCallback(
    async ({ silent = false } = {}) => {
      projectionRunningRef.current = false;
      if (projectionIntervalRef.current != null) {
        window.clearInterval(projectionIntervalRef.current);
        projectionIntervalRef.current = null;
      }
      const pack = projectionStreamRef.current;
      projectionStreamRef.current = null;
      if (pack?.stream) {
        pack.stream.getTracks().forEach((t) => t.stop());
      }
      setProjectionActive(false);

      const agentId = selectedDevice?.agentId;
      const ip = selectedDevice?.ip;
      const mac = selectedDevice?.mac;
      if (!ip) {
        if (!silent) setProjectionStatus('');
        return;
      }
      try {
        await agentsApi.stopProjectionHttp(agentId, { ip, mac });
        if (!silent) setProjectionStatus('✓ Projection stopped on guest');
      } catch (e) {
        const msg = e.response?.data?.error || e.message || 'Stop failed';
        if (!silent) setProjectionStatus(`✗ Stop: ${msg}`);
      }
    },
    [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac]
  );

  const startHostProjection = useCallback(async () => {
    if (!selectedDevice?.ip) {
      setProjectionStatus('✗ Select a PC with an IP first.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setProjectionStatus('✗ Screen capture is not supported in this browser.');
      return;
    }
    if (projectionRunningRef.current) {
      setProjectionStatus('✗ Projection already running.');
      return;
    }
    setProjectionStatus('Select a window/screen to share...');

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
    } catch (e) {
      setProjectionStatus(`✗ Screen share cancelled or denied: ${e?.message || e}`);
      return;
    }

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      setProjectionStatus(`✗ Could not start capture: ${e?.message || e}`);
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    projectionStreamRef.current = { stream, video, canvas, ctx };
    projectionRunningRef.current = true;
    setProjectionActive(true);

    const agentId = selectedDevice?.agentId;
    const ip = selectedDevice?.ip;
    const mac = selectedDevice?.mac;

    try {
      setProjectionStatus('Waiting for target PC confirmation popup...');
      await agentsApi.requestProjectionPermission(
        agentId,
        { sender_hostname: window.location.hostname || 'dyci-host' },
        { ip, mac }
      );
      // For older guest agents that don't open UI on accept, open it best-effort.
      try {
        await agentsApi.openProjectionWindow(agentId, { ip, mac });
      } catch {
        // ignore
      }
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      projectionRunningRef.current = false;
      setProjectionActive(false);
      const msg = e.response?.data?.error || e.message || 'Target did not accept projection request';
      setProjectionStatus(`✗ ${msg}`);
      return;
    }

    const sendFrame = async () => {
      if (!projectionRunningRef.current || !projectionStreamRef.current) return;
      const { video: v, canvas: c, ctx: cctx } = projectionStreamRef.current;
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (!vw || !vh) return;

      const maxW = 1280;
      const maxH = 720;
      let tw = vw;
      let th = vh;
      if (tw > maxW || th > maxH) {
        const scale = Math.min(maxW / tw, maxH / th);
        tw = Math.round(tw * scale);
        th = Math.round(th * scale);
      }

      c.width = tw;
      c.height = th;
      cctx.drawImage(v, 0, 0, tw, th);

      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.52));
      if (!blob || !projectionRunningRef.current) return;
      const b64 = await blobToBase64(blob);

      await agentsApi.sendProjectionFrame(
        agentId,
        {
          screenshot: b64,
          sender_hostname: typeof window !== 'undefined' ? window.location.hostname || 'browser' : 'browser',
          timestamp: new Date().toISOString(),
        },
        { ip, mac }
      );
    };

    setProjectionStatus('🖥️ Streaming…');
    try {
      await sendFrame();
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Send failed';
      setProjectionStatus(`✗ ${msg}`);
      await stopHostProjection({ silent: true });
      return;
    }

    projectionIntervalRef.current = window.setInterval(() => {
      sendFrame().catch((e) => {
        const msg = e.response?.data?.error || e.message || 'Send failed';
        setProjectionStatus(`✗ ${msg}`);
      });
    }, PROJECTION_INTERVAL_MS);

    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      stopHostProjection({ silent: false });
    });
  }, [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac, stopHostProjection]);

  useEffect(() => {
    return () => {
      projectionRunningRef.current = false;
      if (projectionIntervalRef.current != null) {
        window.clearInterval(projectionIntervalRef.current);
        projectionIntervalRef.current = null;
      }
      const pack = projectionStreamRef.current;
      if (pack?.stream) {
        pack.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const runDiscovery = async () => {
    setDiscovering(true);
    setDiscoveryError('');
    setScannerWarnings([]);
    setResultsByIp({});
    setScanProgress(null);

    let timeoutId;
    let unsubscribe;
    let unsubscribeProgress;
    let unsubscribeComplete;
    let unsubscribeBroadcast;
    let resolveComplete;
    let pollTimer;
    let pollRejected = false;

    try {
      // Always include agent-connected PCs in discovery results.
      const connectedAgentsResponse = await agentsApi.getConnected();
      const connectedAgents = connectedAgentsResponse?.data?.devices || [];
      if (connectedAgents.length > 0) {
        setResultsByIp((prev) => {
          const next = { ...prev };
          connectedAgents.forEach((device) => {
            if (!device?.id) return;
            const ips = [
              ...new Set(
                [
                  device.ip,
                  ...(Array.isArray(device.ipAddresses) ? device.ipAddresses : []),
                  ...(Array.isArray(device.interfaceBindings)
                    ? device.interfaceBindings.map((b) => b?.ip).filter(Boolean)
                    : []),
                ].filter(Boolean)
              ),
            ];
            ips.forEach((dip) => {
              const existing = next[dip] || {};
              next[dip] = {
                ...existing,
                hostname:
                  device.user || device.name || device.hostname || existing.hostname || 'Unknown',
                ip: dip,
                mac: device.mac || existing.mac || '',
                status: device.status || existing.status || 'online',
                connection_type: 'agent',
                source: existing.source ? `${existing.source}+agent` : 'agent',
                agentId: device.id,
                user: device.user || existing.user || '',
              };
            });
          });
          return mergeAgentIdsOntoScanRows(next, connectedAgents);
        });
      }

      const completionPromise = new Promise((resolve, reject) => {
        resolveComplete = resolve;

        timeoutId = setTimeout(() => {
          pollRejected = true;
          reject(new Error('Timed out waiting for scan completion.'));
        }, RESULT_TIMEOUT_MS);

        unsubscribe = socketService.on('device_found', (event) => {
          if (!event?.device?.ip) return;
          const ip = event.device.ip;
          setResultsByIp((prev) => {
            const existing = prev[ip] || {};
            const row = {
              ...existing,
              hostname:
                event.device.user ||
                event.device.hostname ||
                existing.hostname ||
                event.device.name ||
                'Unknown',
              ip,
              mac: event.device.mac || existing.mac || '',
              status: event.device.status || existing.status || 'online',
              connection_type: existing.connection_type || 'unknown',
              user: event.device.user || existing.user || '',
              source: existing.source
                ? `${existing.source.includes('scan') ? existing.source : `${existing.source}+scan`}`
                : 'scan',
            };
            return mergeAgentIdsOntoScanRows({ ...prev, [ip]: row }, connectedAgents);
          });
        });
      });

      unsubscribeProgress = socketService.on('scan_progress', (evt) => {
        if (typeof evt?.progress === 'number') setScanProgress(evt.progress);
      });

      unsubscribeComplete = socketService.on('scan_complete', () => {
        setLastRunAt(new Date());
        setDiscovering(false);
        if (resolveComplete) resolveComplete();
      });

      unsubscribeBroadcast = socketService.on('service_discovered', (data) => {
        if (!data?.ip) return;
        setResultsByIp((prev) => {
          const existing = prev[data.ip] || {};
          const row = {
            ...existing,
            hostname: data.user || data.hostname || existing.hostname || 'Unknown',
            ip: data.ip,
            mac: existing.mac || '',
            status: 'online',
            connection_type: existing.connection_type || 'unknown',
            user: data.user || existing.user || '',
            source: existing.source ? `${existing.source}+broadcast` : 'broadcast',
            agentId: existing.agentId,
          };
          return mergeAgentIdsOntoScanRows({ ...prev, [data.ip]: row }, connectedAgents);
        });
      });

      const subnet = scanSubnet.trim();
      if (subnet) {
        await networkApi.startScan(subnet);
      } else {
        await networkApi.startServerScan();
      }

      // Fallback polling path so scan still works even if socket events are delayed/missed.
      pollTimer = window.setInterval(async () => {
        if (pollRejected) return;
        try {
          const [statusResp, devicesResp] = await Promise.all([
            networkApi.getScanStatus(),
            networkApi.getDiscoveredDevices(),
          ]);
          if (typeof statusResp?.progress === 'number') {
            setScanProgress(statusResp.progress);
          }
          const devices = Array.isArray(devicesResp?.devices) ? devicesResp.devices : [];
          if (devices.length > 0) {
            setResultsByIp((prev) => {
              let merged = { ...prev };
              for (const d of devices) {
                if (!d?.ip) continue;
                const existing = merged[d.ip] || {};
                merged[d.ip] = {
                  ...existing,
                  hostname: d.user || d.hostname || d.name || existing.hostname || 'Unknown',
                  ip: d.ip,
                  mac: d.mac || existing.mac || '',
                  status: d.status || existing.status || 'online',
                  connection_type: existing.connection_type || 'unknown',
                  user: d.user || existing.user || '',
                  source: existing.source ? `${existing.source}+scan` : 'scan',
                };
              }
              return mergeAgentIdsOntoScanRows(merged, connectedAgents);
            });
          }
          const done = statusResp && !statusResp.isScanning && !statusResp.hasActiveScan;
          if (done && resolveComplete) {
            resolveComplete();
          }
        } catch {
          // Ignore intermittent polling errors; socket path may still succeed.
        }
      }, SCAN_POLL_MS);

      await completionPromise;
    } catch (error) {
      setDiscoveryError(error.message || 'Failed to run discovery.');
    } finally {
      if (pollTimer) window.clearInterval(pollTimer);
      if (timeoutId) clearTimeout(timeoutId);
      if (unsubscribe) unsubscribe();
      if (unsubscribeProgress) unsubscribeProgress();
      if (unsubscribeComplete) unsubscribeComplete();
      if (unsubscribeBroadcast) unsubscribeBroadcast();
      setDiscovering(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="bg-gray-900 text-white p-6 rounded-t-xl">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Monitor className="w-6 h-6" />
            Developer Mode
          </h1>
          <p className="text-gray-300 mt-1">PC discovery and debugging tools</p>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex flex-wrap gap-3 items-end">
            <input
              type="text"
              value={scanSubnet}
              onChange={(e) => setScanSubnet(e.target.value)}
              placeholder="Optional subnet (e.g. 172.16.246)"
              className="px-3 py-2 rounded-lg text-sm border border-gray-300"
            />
            <button
              onClick={runDiscovery}
              disabled={discovering}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Search className="w-4 h-4" />
              {discovering ? 'Scanning network...' : 'Scan Network'}
            </button>
            <button
              onClick={() => selectedDevice && lockDevice(selectedDevice)}
              disabled={!selectedDevice || Boolean(lockingIp) || Boolean(shuttingDownIp)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
            >
              {selectedDevice ? (lockingIp === selectedDevice.ip ? 'Locking...' : `🔒 Lock ${selectedDevice.ip}`) : '🔒 Lock Selected PC'}
            </button>
            <button
              type="button"
              onClick={() => selectedDevice && shutdownDevice(selectedDevice)}
              disabled={!selectedDevice || Boolean(lockingIp) || Boolean(shuttingDownIp)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              <Power className="w-4 h-4" />
              {selectedDevice
                ? shuttingDownIp === selectedDevice.ip
                  ? 'Shutting down...'
                  : `Shutdown ${selectedDevice.ip}`
                : 'Shutdown selected PC'}
            </button>
          </div>

          {typeof scanProgress === 'number' && (
            <p className="text-sm text-gray-500">Scan progress: {scanProgress}%</p>
          )}

          {lastRunAt && (
            <p className="text-sm text-gray-500">Last run: {lastRunAt.toLocaleString()}</p>
          )}

          {lockStatus && (
            <p className="text-sm text-emerald-700 font-medium">{lockStatus}</p>
          )}
          {lockError && (
            <p className="text-sm text-red-700 font-medium">{lockError}</p>
          )}
          {shutdownStatus && (
            <p className="text-sm text-emerald-700 font-medium">{shutdownStatus}</p>
          )}
          {shutdownError && (
            <p className="text-sm text-red-700 font-medium">{shutdownError}</p>
          )}

          {(discoveryError || scannerWarnings.length > 0) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 text-amber-800 text-sm font-medium">
                <AlertCircle className="w-4 h-4" />
                Discovery notices
              </div>
              {discoveryError && <p className="text-sm text-amber-800 mt-2">{discoveryError}</p>}
              {scannerWarnings.map((warning, index) => (
                <p key={`${warning}-${index}`} className="text-sm text-amber-800 mt-1">{warning}</p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">PC Discovery (Python)</h2>
          <p className="text-sm text-gray-500">Hybrid sources: server scan + UDP broadcast</p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">IP</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">MAC</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Connection</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Source</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Action</th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                    {discovering ? 'Running server scan...' : 'No results yet. Click “Scan Server Network”.'}
                  </td>
                </tr>
              ) : (
                results.map((device, index) => (
                  <tr
                    key={`${device.ip}-${index}`}
                    className={`border-t border-gray-100 cursor-pointer ${selectedIp === device.ip ? 'bg-amber-50' : ''}`}
                    onClick={() => setSelectedIp(device.ip || '')}
                  >
                    <td className="px-4 py-3 text-gray-700">{device.user || device.hostname || 'Unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.ip || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.mac || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.status || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.connection_type || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700 flex items-center gap-2">
                      {device.source?.includes('broadcast') && <Radio className="w-4 h-4 text-purple-600" />}
                      {device.source || 'unknown'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={(evt) => {
                            evt.stopPropagation();
                            setSelectedIp(device.ip || '');
                            lockDevice(device);
                          }}
                          disabled={Boolean(lockingIp) || Boolean(shuttingDownIp)}
                          className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
                        >
                          {lockingIp === device.ip ? 'Locking...' : '🔒 Lock'}
                        </button>
                        <button
                          type="button"
                          onClick={(evt) => {
                            evt.stopPropagation();
                            setSelectedIp(device.ip || '');
                            shutdownDevice(device);
                          }}
                          disabled={Boolean(lockingIp) || Boolean(shuttingDownIp)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                        >
                          <Power className="w-3.5 h-3.5" />
                          {shuttingDownIp === device.ip ? 'Shutting down...' : 'Shutdown'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedIp ? (
          <div className="border-t border-gray-200 bg-gray-50 p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <Monitor className="w-5 h-5 text-indigo-600" />
                  Screen preview
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  {selectedDevice
                    ? `${selectedDevice.user || selectedDevice.hostname || 'Unknown'} (${selectedIp})`
                    : selectedIp}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  title="Get latest screenshot of selected PC"
                  onClick={() => requestScreenshot({ silent: false })}
                  disabled={!selectedDevice?.ip || screenshotFetching}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`w-4 h-4 ${screenshotFetching ? 'animate-spin' : ''}`} />
                  {screenshotFetching ? 'Fetching…' : '📺 Refresh screenshot'}
                </button>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    checked={autoRefreshScreenshot}
                    onChange={(e) => setAutoRefreshScreenshot(e.target.checked)}
                    disabled={!selectedDevice?.ip}
                  />
                  Auto-refresh ({SCREENSHOT_AUTO_MS / 1000}s)
                </label>
                <button
                  type="button"
                  onClick={startHostProjection}
                  disabled={!selectedDevice?.ip || projectionActive}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  🖥️ Project my screen
                </button>
                <button
                  type="button"
                  onClick={() => stopHostProjection({ silent: false })}
                  disabled={!projectionActive}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-gray-700 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ⏹️ Stop projection
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-gray-300 bg-[#2d2d2d] min-h-[280px] flex items-center justify-center overflow-hidden">
              {screenshotUrl ? (
                <img
                  src={screenshotUrl}
                  alt={`Desktop ${selectedIp}`}
                  className="max-w-full max-h-[min(70vh,720px)] w-auto h-auto object-contain"
                />
              ) : (
                <p className="text-center text-gray-400 text-sm px-6 py-12 max-w-md">
                  Click “Refresh screenshot”. Commands route by this row&apos;s IP (and MAC when present) to an online
                  agent when one matches — including scan-only rows when the agent reports the same LAN address.
                </p>
              )}
            </div>

            {screenshotStatus && (
              <p className={`text-sm ${screenshotStatus.startsWith('✗') ? 'text-red-700' : 'text-emerald-800'}`}>
                {screenshotStatus}
              </p>
            )}
            {projectionStatus && (
              <p
                className={`text-sm ${
                  projectionStatus.startsWith('✗') ? 'text-red-700' : 'text-violet-900'
                }`}
              >
                {projectionStatus}
              </p>
            )}
            <p className="text-xs text-gray-500 max-w-3xl">
              Host→guest projection forwards JPEG frames to each guest&apos;s <strong>Python</strong> agent on TCP{' '}
              <strong>5555</strong>. The API server loads <code className="bg-gray-100 px-1 rounded">api_key</code> from{' '}
              <code className="bg-gray-100 px-1 rounded">agent/pc-agent/python/agent_config.json</code> when{' '}
              <code className="bg-gray-100 px-1 rounded">PC_AGENT_API_KEY</code> is not set — use the{' '}
              <strong>same</strong> key on the guest PC. Override with <code className="bg-gray-100 px-1 rounded">PC_AGENT_API_KEY</code> in{' '}
              <code className="bg-gray-100 px-1 rounded">server/.env</code> if the guest uses a different file.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default DeveloperModePage;
