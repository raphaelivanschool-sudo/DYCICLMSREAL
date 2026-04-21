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

    try {
      const resultPromise = new Promise((resolve, reject) => {
        unsubscribe = socketService.on('device_found', (event) => resolve(event));

        timeoutId = setTimeout(() => {
          reject(new Error('Timed out waiting for agent discovery result.'));
        }, RESULT_TIMEOUT_MS);
      });

      unsubscribeProgress = socketService.on('scan_progress', (evt) => {
        if (typeof evt?.progress === 'number') setScanProgress(evt.progress);
      });

      unsubscribeComplete = socketService.on('scan_complete', () => {
        setLastRunAt(new Date());
        setDiscovering(false);
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
      const event = await resultPromise;

      if (event?.device?.ip) {
        setResultsByIp((prev) => {
          const ip = event.device.ip;
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
      }
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
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
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
