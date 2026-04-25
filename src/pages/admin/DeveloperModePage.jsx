import { useEffect, useMemo, useState } from 'react';
import { Monitor, Search, AlertCircle, Radio, Lock, Loader2 } from 'lucide-react';
import networkApi from '../../services/network-api.js';
import { agentsApi } from '../../services/api.js';
import socketService from '../../services/socketService.js';

const RESULT_TIMEOUT_MS = 90000;

function DeveloperModePage() {
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [resultsByIp, setResultsByIp] = useState({});
  const [lastRunAt, setLastRunAt] = useState(null);
  const [scannerWarnings, setScannerWarnings] = useState([]);
  const [scanProgress, setScanProgress] = useState(null);
  const [agentByIp, setAgentByIp] = useState({});
  const [lockingByIp, setLockingByIp] = useState({});
  const [toast, setToast] = useState(null);

  const results = useMemo(() => {
    const items = Object.values(resultsByIp);
    items.sort((a, b) => (a.ip || '').localeCompare(b.ip || ''));
    return items;
  }, [resultsByIp]);

  useEffect(() => {
    if (!socketService.connected()) {
      socketService.connect();
    }
    loadConnectedAgents();
  }, []);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const mergeAgentRows = (devices = []) => {
    setResultsByIp((prev) => {
      const next = { ...prev };
      devices.forEach((device) => {
        if (!device?.ip) return;
        const existing = next[device.ip] || {};
        next[device.ip] = {
          ...existing,
          hostname: existing.hostname || device.name || device.hostname || 'Unknown',
          ip: device.ip,
          mac: existing.mac || device.mac || '',
          status: existing.status || device.status || 'online',
          connection_type: existing.connection_type || 'agent',
          source: existing.source
            ? (existing.source.includes('agent') ? existing.source : `${existing.source}+agent`)
            : 'agent'
        };
      });
      return next;
    });
  };

  const loadConnectedAgents = async (mergeIntoTable = true) => {
    try {
      const response = await agentsApi.getConnected();
      const devices = response.data?.devices || [];
      const byIp = {};
      devices.forEach((device) => {
        if (device?.ip && device?.id) {
          byIp[device.ip] = device;
        }
      });
      setAgentByIp(byIp);
      if (mergeIntoTable) {
        mergeAgentRows(devices);
      }
    } catch (error) {
      // Do not block discovery screen if agent list fails.
      console.error('Failed to load connected agents:', error);
    }
  };

  const handleLockDevice = async (device) => {
    if (!device?.ip) return;

    const linkedAgent = agentByIp[device.ip];
    if (!linkedAgent?.id) {
      showToast(`No connected agent found for ${device.ip}. Start DYCI PC agent on that machine.`, 'error');
      return;
    }

    const ipKey = device.ip;
    setLockingByIp((prev) => ({ ...prev, [ipKey]: true }));
    try {
      await agentsApi.sendCommand(linkedAgent.id, 'lock');
      showToast(`Lock command sent to ${device.hostname || linkedAgent.name || device.ip}`);
    } catch (error) {
      console.error('Failed to lock device:', error);
      showToast(error.response?.data?.error || 'Failed to send lock command', 'error');
    } finally {
      setLockingByIp((prev) => ({ ...prev, [ipKey]: false }));
    }
  };

  const runDiscovery = async () => {
    setDiscovering(true);
    setDiscoveryError('');
    setScannerWarnings([]);
    setResultsByIp({});
    setScanProgress(null);

    let timeoutId;
    let unsubscribeProgress;
    let unsubscribeComplete;
    let unsubscribeFound;
    let unsubscribeBroadcast;

    try {
      const completePromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Timed out waiting for scan to complete.'));
        }, RESULT_TIMEOUT_MS);

        unsubscribeComplete = socketService.on('scan_complete', () => {
          setLastRunAt(new Date());
          setDiscovering(false);
          resolve();
        });
      });

      unsubscribeProgress = socketService.on('scan_progress', (evt) => {
        if (typeof evt?.progress === 'number') setScanProgress(evt.progress);
      });

      unsubscribeFound = socketService.on('device_found', (event) => {
        const device = event?.device;
        if (!device?.ip) return;
        setResultsByIp((prev) => {
          const ip = device.ip;
          const existing = prev[ip] || {};
          return {
            ...prev,
            [ip]: {
              ...existing,
              hostname: device.hostname || existing.hostname || device.name || 'Unknown',
              ip,
              mac: device.mac || existing.mac || '',
              status: device.status || existing.status || 'online',
              connection_type: existing.connection_type || 'unknown',
              source: existing.source === 'broadcast' ? 'broadcast+scan' : (existing.source || 'scan')
            }
          };
        });
      });

      unsubscribeBroadcast = socketService.on('service_discovered', (data) => {
        if (!data?.ip) return;
        setResultsByIp((prev) => ({
          ...prev,
          [data.ip]: {
            hostname: data.hostname || 'Unknown',
            ip: data.ip,
            mac: '',
            status: 'online',
            connection_type: 'unknown',
            source: 'broadcast'
          }
        }));
      });

      await networkApi.startServerScan();
      await completePromise;

      // Backfill from REST endpoint so rows still appear even if socket events were missed.
      const discovered = await networkApi.getDiscoveredDevices();
      const scannedDevices = discovered?.devices || [];
      setResultsByIp((prev) => {
        const next = { ...prev };
        scannedDevices.forEach((device) => {
          if (!device?.ip) return;
          const existing = next[device.ip] || {};
          next[device.ip] = {
            ...existing,
            hostname: device.hostname || existing.hostname || device.name || 'Unknown',
            ip: device.ip,
            mac: device.mac || existing.mac || '',
            status: device.status || existing.status || 'online',
            connection_type: existing.connection_type || 'unknown',
            source: existing.source === 'broadcast' ? 'broadcast+scan' : (existing.source || 'scan')
          };
        });
        return next;
      });
    } catch (error) {
      setDiscoveryError(error.message || 'Failed to run discovery.');
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (unsubscribeProgress) unsubscribeProgress();
      if (unsubscribeComplete) unsubscribeComplete();
      if (unsubscribeFound) unsubscribeFound();
      if (unsubscribeBroadcast) unsubscribeBroadcast();
      await loadConnectedAgents(true);
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
            <button
              onClick={runDiscovery}
              disabled={discovering}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Search className="w-4 h-4" />
              {discovering ? 'Scanning server network...' : 'Scan Server Network'}
            </button>
          </div>

          {typeof scanProgress === 'number' && (
            <p className="text-sm text-gray-500">Scan progress: {scanProgress}%</p>
          )}

          {lastRunAt && (
            <p className="text-sm text-gray-500">Last run: {lastRunAt.toLocaleString()}</p>
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">Lock</th>
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
                  <tr key={`${device.ip}-${index}`} className="border-t border-gray-100">
                    <td className="px-4 py-3 text-gray-700">{device.hostname || 'Unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.ip || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.mac || '-'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.status || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700">{device.connection_type || 'unknown'}</td>
                    <td className="px-4 py-3 text-gray-700 flex items-center gap-2">
                      {device.source?.includes('broadcast') && <Radio className="w-4 h-4 text-purple-600" />}
                      {device.source || 'unknown'}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleLockDevice(device)}
                        disabled={!agentByIp[device.ip] || lockingByIp[device.ip]}
                        title={
                          agentByIp[device.ip]
                            ? `Lock ${device.hostname || device.ip}`
                            : 'Agent not connected for this IP'
                        }
                        className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          agentByIp[device.ip]
                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                            : 'bg-gray-200 text-gray-500 cursor-not-allowed'
                        }`}
                      >
                        {lockingByIp[device.ip] ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        Lock
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-sm font-medium shadow-lg ${
            toast.type === 'success' ? 'bg-gray-900 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default DeveloperModePage;
