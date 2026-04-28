import { useEffect, useMemo, useState } from 'react';
import { Monitor, RefreshCw, Search, AlertCircle, Radio } from 'lucide-react';
import networkApi from '../../services/network-api.js';
import socketService from '../../services/socketService.js';

const RESULT_TIMEOUT_MS = 90000;

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

  const lockDevice = async (device) => {
    if (!device?.ip) return;

    const hostname = device.hostname || 'Unknown';
    const ip = device.ip;

    const confirmed = window.confirm(
      `Lock ${hostname} (${ip})?\n\nPC will be locked immediately.`
    );
    if (!confirmed) return;

    setLockingIp(ip);
    setLockStatus('Locking...');
    setLockError('');

    try {
      await networkApi.lockDiscoveredPc(ip);
      setLockStatus(`✓ ${hostname} Locked`);
      setLockError('');
    } catch (error) {
      setLockError(`✗ Lock failed: ${error.message || 'Unknown error'}`);
      setLockStatus('');
    } finally {
      setLockingIp('');
    }
  };

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
            return {
              ...prev,
              [ip]: {
                ...existing,
                hostname: event.device.hostname || existing.hostname || event.device.name || 'Unknown',
                ip,
                mac: event.device.mac || existing.mac || '',
                status: event.device.status || existing.status || 'online',
                connection_type: existing.connection_type || 'unknown',
                source: existing.source === 'broadcast' ? 'broadcast+scan' : 'scan'
              }
            };
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
                    <td className="px-4 py-3 text-gray-700">{device.hostname || 'Unknown'}</td>
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
      </div>
    </div>
  );
}

export default DeveloperModePage;
