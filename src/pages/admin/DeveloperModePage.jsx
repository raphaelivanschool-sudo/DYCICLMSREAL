import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, RefreshCw, Search, AlertCircle, Radio, Power } from 'lucide-react';
import networkApi from '../../services/network-api.js';
import { agentsApi } from '../../services/api.js';
import socketService from '../../services/socketService.js';
import useScreenProjection, {
  clampNum,
  PROJECTION_DEFAULTS,
  PROJECTION_FPS_RANGE,
  PROJECTION_QUALITY_RANGE,
} from '../../hooks/useScreenProjection.js';

const RESULT_TIMEOUT_MS = 90000;
const SCREENSHOT_AUTO_MS = 3000;
const SCAN_POLL_MS = 1500;

const GUEST_STATE_STYLES = {
  connecting: 'bg-amber-100 text-amber-800',
  projecting: 'bg-emerald-100 text-emerald-800',
  stopping: 'bg-gray-200 text-gray-700',
  stopped: 'bg-gray-100 text-gray-600',
  offline: 'bg-gray-100 text-gray-500',
  error: 'bg-red-100 text-red-800',
};

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
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [overlayLog, setOverlayLog] = useState(null); // { lines, exists, ... } | { error }
  const [overlayLogFetching, setOverlayLogFetching] = useState(false);
  // Locked Demo Mode (host screen broadcast) — shared capture/broadcast engine.
  const {
    projectionSession,
    projectionActive,
    projectionStatus,
    startProjection,
    stopProjection,
    selfPreviewUrl,
    hostEmitStats,
    projFps,
    setProjFps,
    projQuality,
    setProjQuality,
    projMaxWidth,
    setProjMaxWidth,
    guestStateById,
    projectingCount,
    failedCount,
    totalGuests,
  } = useScreenProjection();
  const [selectedRows, setSelectedRows] = useState(() => new Set()); // agentIds checked
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      if (!silent) {
        setScreenshotFetching(true);
        setScreenshotStatus('Fetching screenshot...');
      }

      // Primary: pull a live JPEG from the guest's Python agent over HTTP (5555).
      try {
        const res = await agentsApi.getScreenshot(agentId, { ip, mac });
        const data = res?.data;
        if (data?.success && data.screenshot) {
          const fmt = (data.format || 'jpeg').toLowerCase();
          const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
          setScreenshotUrl(`data:${mime};base64,${data.screenshot}`);
          setScreenshotFetching(false);
          if (data.resolvedComputerId) commandTargetComputerIdRef.current = data.resolvedComputerId;
          const t = new Date().toLocaleTimeString();
          const host = selectedDisplayRef.current.host;
          setScreenshotStatus(`${silent ? 'Live' : '✓ Screenshot updated'} — ${host} — Last updated: ${t}`);
          return;
        }
      } catch (error) {
        console.warn(
          '[Screenshot] HTTP path failed, falling back to agent command:',
          error?.response?.data?.error || error?.message,
        );
      }

      // Fallback: ask the Node agent to capture (PowerShell .NET) via Socket.IO;
      // the result arrives asynchronously on the agent_command_result event.
      pendingScreenshotCommandRef.current = true;
      try {
        const res = await agentsApi.sendCommand(agentId, 'screenshot', {}, { ip, mac });
        const rid = res?.data?.resolvedComputerId;
        if (rid) commandTargetComputerIdRef.current = rid;
      } catch (error) {
        pendingScreenshotCommandRef.current = false;
        setScreenshotFetching(false);
        if (!silent) {
          const msg = error.response?.data?.error || error.message || 'Could not capture screenshot';
          setScreenshotStatus(`✗ Error: ${msg}`);
        }
      }
    },
    [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac]
  );

  const runDiagnose = useCallback(async () => {
    if (!selectedDevice?.ip) return;
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const res = await agentsApi.diagnoseAgent(selectedDevice.agentId, {
        ip: selectedDevice.ip,
        mac: selectedDevice.mac,
      });
      setDiagnosis(res?.data || null);
    } catch (error) {
      setDiagnosis({
        success: false,
        errors: [error.response?.data?.error || error.message || 'Diagnostics request failed'],
      });
    } finally {
      setDiagnosing(false);
    }
  }, [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac]);

  const fetchOverlayLog = useCallback(async () => {
    if (!selectedDevice?.ip) return;
    setOverlayLogFetching(true);
    setOverlayLog(null);
    try {
      const res = await agentsApi.getOverlayLog(
        selectedDevice.agentId,
        { ip: selectedDevice.ip, mac: selectedDevice.mac },
        200,
      );
      setOverlayLog(res?.data || null);
    } catch (error) {
      setOverlayLog({
        success: false,
        error: error.response?.data?.error || error.message || 'Overlay-log request failed',
      });
    } finally {
      setOverlayLogFetching(false);
    }
  }, [selectedDevice?.agentId, selectedDevice?.ip, selectedDevice?.mac]);

  // Clear stale diagnosis / overlay log when switching rows.
  useEffect(() => {
    setDiagnosis(null);
    setOverlayLog(null);
  }, [selectedIp]);

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

  // ---- Locked Demo Mode: targets, host capture, broadcast ----

  // Valid projection targets = rows backed by an online agent (have an agentId).
  const onlineAgents = useMemo(
    () => results.filter((d) => d.agentId),
    [results],
  );
  const onlineAgentCount = onlineAgents.length;
  const onlineAgentIds = useMemo(
    () => new Set(onlineAgents.map((d) => d.agentId)),
    [onlineAgents],
  );
  const guestIsOnline = useCallback((id) => onlineAgentIds.has(id), [onlineAgentIds]);
  const selectedOnlineCount = useMemo(
    () => [...selectedRows].filter((id) => onlineAgentIds.has(id)).length,
    [selectedRows, onlineAgentIds],
  );

  const toggleRowSelect = useCallback((agentId) => {
    if (!agentId) return;
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
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
      {projectionActive && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-5 py-3 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-600" />
            </span>
            <span className="text-sm font-semibold text-red-900">
              Locked Demo Mode active — projecting to {projectingCount} of {totalGuests} PC(s)
              {failedCount > 0 ? ` — ${failedCount} failed` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={() => stopProjection({ silent: false })}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-bold text-white shadow hover:bg-red-700"
          >
            ■ Stop projection
          </button>
        </div>
      )}
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

        {/* Locked Demo Mode control bar */}
        <div className="px-6 py-4 border-b border-gray-200 bg-violet-50/40 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => startProjection('all', onlineAgentCount)}
              disabled={projectionActive || onlineAgentCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🖥️ Project to all online agents ({onlineAgentCount})
            </button>
            <button
              type="button"
              onClick={() => startProjection([...selectedRows].filter((id) => guestIsOnline(id)))}
              disabled={projectionActive || selectedOnlineCount === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-white px-4 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Project to selected ({selectedOnlineCount})
            </button>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-sm text-gray-600 underline decoration-dotted hover:text-gray-900"
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced…'}
            </button>
            {onlineAgentCount === 0 && (
              <span className="text-xs text-gray-500">No online agents — start the DYCI agent on a lab PC.</span>
            )}
          </div>
          {showAdvanced && (
            <div className="flex flex-wrap items-center gap-5 text-sm text-gray-700">
              <label className="flex items-center gap-2">
                FPS
                <input
                  type="number"
                  min={PROJECTION_FPS_RANGE.min}
                  max={PROJECTION_FPS_RANGE.max}
                  value={projFps}
                  disabled={projectionActive}
                  onChange={(e) => setProjFps(clampNum(e.target.value, PROJECTION_FPS_RANGE, PROJECTION_DEFAULTS.fps))}
                  className="w-20 rounded border border-gray-300 px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-2">
                JPEG quality
                <input
                  type="number"
                  min={PROJECTION_QUALITY_RANGE.min}
                  max={PROJECTION_QUALITY_RANGE.max}
                  value={projQuality}
                  disabled={projectionActive}
                  onChange={(e) => setProjQuality(clampNum(e.target.value, PROJECTION_QUALITY_RANGE, PROJECTION_DEFAULTS.quality))}
                  className="w-20 rounded border border-gray-300 px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-2">
                Max width
                <input
                  type="number"
                  min={640}
                  max={3840}
                  step={160}
                  value={projMaxWidth}
                  disabled={projectionActive}
                  onChange={(e) => setProjMaxWidth(clampNum(e.target.value, { min: 640, max: 3840 }, PROJECTION_DEFAULTS.maxWidth))}
                  className="w-24 rounded border border-gray-300 px-2 py-1"
                />
              </label>
            </div>
          )}
          {projectionStatus && (
            <p className="text-sm text-violet-900">{projectionStatus}</p>
          )}
          {projectionActive && (
            <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900">
              <div className="font-medium mb-1">Frame flow (find the hop that drops to 0):</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono">
                  ① Browser emit:{' '}
                  <b>{hostEmitStats ? `${hostEmitStats.fps} fps` : '…'}</b>
                  {hostEmitStats ? ` (${hostEmitStats.kbps} KB/s)` : ''}
                </span>
                <span className="text-violet-400">→</span>
                <span className="font-mono">
                  ② Server: recv <b>{projectionSession?.host?.hostFps ?? '…'}</b> / relay{' '}
                  <b>{projectionSession?.host?.relayFps ?? '…'}</b> fps
                </span>
                <span className="text-violet-400">→</span>
                <span className="font-mono">③④ per-PC below ↓</span>
              </div>
              <div className="mt-1 text-[11px] text-violet-700">
                Each PC row shows ③ agent recv/write and ④ overlay decode/paint fps. The first
                hop reading ~0 while the one before it is healthy is the bug.
              </div>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    title="Select all online agents"
                    checked={onlineAgentCount > 0 && selectedOnlineCount === onlineAgentCount}
                    onChange={(e) =>
                      setSelectedRows(
                        e.target.checked ? new Set(onlineAgents.map((d) => d.agentId)) : new Set(),
                      )
                    }
                    disabled={onlineAgentCount === 0}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">IP</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">MAC</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Connection</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Source</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Projection</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Action</th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-gray-500">
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
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 disabled:opacity-40"
                        checked={device.agentId ? selectedRows.has(device.agentId) : false}
                        onChange={() => toggleRowSelect(device.agentId)}
                        disabled={!device.agentId}
                        title={device.agentId ? 'Select for projection' : 'No reachable agent on this row'}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-700">{device.user || device.hostname || 'Unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.ip || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.mac || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.status || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.connection_type || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700 flex items-center gap-2">
                      {device.source?.includes('broadcast') && <Radio className="w-4 h-4 text-purple-600" />}
                      {device.source || 'unknown'}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const g = device.agentId ? guestStateById[device.agentId] : null;
                        if (!g) return <span className="text-xs text-gray-400">—</span>;
                        const st = g.stats;
                        const ov = st?.overlay;
                        return (
                          <div className="flex flex-col gap-1">
                            <span
                              className={`inline-block w-fit rounded-full px-2 py-0.5 text-xs font-medium ${GUEST_STATE_STYLES[g.state] || 'bg-gray-100 text-gray-600'}`}
                              title={g.detail || ''}
                            >
                              {g.state}
                              {g.state === 'error' && g.detail ? `: ${g.detail}` : ''}
                            </span>
                            {st && (g.state === 'projecting' || g.state === 'connecting') && (
                              <span
                                className="font-mono text-[11px] text-gray-500"
                                title="③ agent recv/write fps · ④ overlay decode/paint fps"
                              >
                                ③ {st.recvFps ?? '–'}/{st.writeFps ?? '–'} · ④{' '}
                                {ov ? `${ov.decodedFps ?? '–'}/${ov.paintedFps ?? '–'}` : 'no overlay stats'}
                              </span>
                            )}
                          </div>
                        );
                      })()}
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
                        <button
                          type="button"
                          onClick={(evt) => {
                            evt.stopPropagation();
                            startProjection([device.agentId]);
                          }}
                          disabled={!device.agentId || projectionActive}
                          title={device.agentId ? 'Project to this PC' : 'No reachable agent on this row'}
                          className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          🖥️ Project
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
                  onClick={() => selectedDevice?.agentId && startProjection([selectedDevice.agentId])}
                  disabled={!selectedDevice?.agentId || projectionActive}
                  title={selectedDevice?.agentId ? 'Project to this PC' : 'No reachable agent on this row'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  🖥️ Project to this PC
                </button>
                <button
                  type="button"
                  onClick={runDiagnose}
                  disabled={!selectedDevice?.ip || diagnosing}
                  title="Check the guest agent: reachability, api_key, capture + overlay deps"
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-gray-800 bg-gray-200 hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {diagnosing ? 'Diagnosing…' : '🩺 Diagnose guest'}
                </button>
                <button
                  type="button"
                  onClick={fetchOverlayLog}
                  disabled={!selectedDevice?.ip || overlayLogFetching}
                  title="Fetch the guest's locked-overlay log (the real traceback when projection crash-loops)"
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-gray-800 bg-gray-200 hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {overlayLogFetching ? 'Fetching…' : '📄 Overlay log'}
                </button>
              </div>
            </div>

            {overlayLog && (
              <div className="rounded-lg border border-gray-300 bg-white p-4 text-sm">
                <p className="font-semibold text-gray-900 mb-2">Overlay log (guest %TEMP%\dyci_projection_overlay.log)</p>
                {overlayLog.success === false ? (
                  <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{overlayLog.error}</div>
                ) : (
                  <>
                    <p className="text-xs text-gray-500 mb-2">
                      {overlayLog.log?.exists
                        ? `${overlayLog.log?.size_bytes ?? 0} bytes · modified ${overlayLog.log?.modified || '—'}`
                        : 'No log yet — the overlay has not written under this user’s %TEMP% (it never launched, or agent/overlay run as different users).'}
                      {overlayLog.elevated === false ? '  · agent NOT elevated' : ''}
                      {overlayLog.deps
                        ? `  · deps: ${Object.entries(overlayLog.deps).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ')}`
                        : ''}
                    </p>
                    {overlayLog.log?.lines?.length > 0 ? (
                      <pre className="max-h-72 overflow-auto rounded bg-[#1e1e1e] p-3 text-[11px] leading-relaxed text-gray-100 whitespace-pre-wrap break-words">
                        {overlayLog.log.lines.join('\n')}
                      </pre>
                    ) : (
                      overlayLog.log?.exists && (
                        <p className="text-xs text-gray-500">Log file is empty.</p>
                      )
                    )}
                  </>
                )}
              </div>
            )}

            {diagnosis && (
              <div className="rounded-lg border border-gray-300 bg-white p-4 text-sm">
                <p className="font-semibold text-gray-900 mb-2">Guest diagnostics</p>
                <ul className="space-y-1">
                  {[
                    ['Node agent online (Socket.IO)', diagnosis.nodeAgentOnline],
                    ['Python agent reachable (5555)', diagnosis.pythonAgentReachable],
                    ['api_key matches', diagnosis.apiKeyOk],
                    ['Screenshot capture (mss/Pillow)', diagnosis.capture?.ok],
                    ['Overlay script present', diagnosis.overlay?.script_present],
                    ['Agent elevated (input lock)', diagnosis.elevated],
                  ].map(([label, ok]) => (
                    <li key={label} className="flex items-center gap-2">
                      <span>{ok === true ? '✅' : ok === false ? '❌' : '➖'}</span>
                      <span className="text-gray-700">{label}</span>
                    </li>
                  ))}
                </ul>
                {diagnosis.deps && Object.keys(diagnosis.deps).length > 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    deps:{' '}
                    {Object.entries(diagnosis.deps)
                      .map(([k, v]) => `${k}${v ? '✓' : '✗'}`)
                      .join('  ')}
                    {diagnosis.capture?.backend ? `   capture via ${diagnosis.capture.backend}` : ''}
                  </p>
                )}
                {Array.isArray(diagnosis.errors) && diagnosis.errors.length > 0 && (
                  <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    {diagnosis.errors.map((e, i) => (
                      <p key={i}>• {e}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

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

            {selfPreviewUrl && (
              <div className="flex items-start gap-3">
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1">What guests see (self-preview)</p>
                  <img
                    src={selfPreviewUrl}
                    alt="Projection self preview"
                    className="w-64 rounded border border-violet-300 object-contain bg-black"
                  />
                </div>
              </div>
            )}

            <p className="text-xs text-gray-500 max-w-3xl">
              <strong>Locked Demo Mode</strong> broadcasts your screen as JPEG frames over Socket.IO to each guest&apos;s
              DYCI agent, which renders a fullscreen, input-locked overlay the student cannot dismiss. Use{' '}
              <strong>Project to all</strong> or check rows and <strong>Project to selected</strong>. The overlay ends
              only on <strong>Stop</strong>, host disconnect, or the guest watchdog (≈8s without frames). Full input
              lock requires the guest agent to run elevated; Ctrl+Alt+Del cannot be blocked.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default DeveloperModePage;
