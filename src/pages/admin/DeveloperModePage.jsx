import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, RefreshCw, Search, AlertCircle, Radio } from 'lucide-react';
import networkApi from '../../services/network-api.js';
import { agentsApi } from '../../services/api.js';
import socketService from '../../services/socketService.js';

const RESULT_TIMEOUT_MS = 90000;
const SCREENSHOT_AUTO_MS = 3000;

/** Attach agent UUID to scan/broadcast rows when an online agent reports the same LAN IP (or ipAddresses). */
function mergeAgentIdsOntoScanRows(prevByIp, connectedDevices) {
  if (!connectedDevices?.length) return prevByIp;
  const next = { ...prevByIp };
  for (const ip of Object.keys(next)) {
    const row = next[ip];
    if (row.agentId) continue;
    const match = connectedDevices.find((d) => {
      const ips = [d.ip, ...(Array.isArray(d.ipAddresses) ? d.ipAddresses : [])].filter(Boolean);
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
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [screenshotStatus, setScreenshotStatus] = useState('');
  const [screenshotFetching, setScreenshotFetching] = useState(false);
  const [autoRefreshScreenshot, setAutoRefreshScreenshot] = useState(false);
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
                [device.ip, ...(Array.isArray(device.ipAddresses) ? device.ipAddresses : [])].filter(Boolean)
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
      await completionPromise;
    } catch (error) {
      setDiscoveryError(error.message || 'Failed to run discovery.');
    } finally {
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
              disabled={!selectedDevice || Boolean(lockingIp)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
            >
              {selectedDevice ? (lockingIp === selectedDevice.ip ? 'Locking...' : `🔒 Lock ${selectedDevice.ip}`) : '🔒 Lock Selected PC'}
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
                      <button
                        onClick={(evt) => {
                          evt.stopPropagation();
                          setSelectedIp(device.ip || '');
                          lockDevice(device);
                        }}
                        disabled={Boolean(lockingIp)}
                        className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50"
                      >
                        {lockingIp === device.ip ? 'Locking...' : '🔒 Lock'}
                      </button>
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default DeveloperModePage;
