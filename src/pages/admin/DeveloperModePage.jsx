import { useEffect, useMemo, useState } from 'react';
import { Monitor, RefreshCw, Search, AlertCircle } from 'lucide-react';
import { agentsApi } from '../../services/api.js';
import socketService from '../../services/socketService.js';

const RESULT_TIMEOUT_MS = 90000;

function DeveloperModePage() {
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [results, setResults] = useState([]);
  const [lastRunAt, setLastRunAt] = useState(null);
  const [scannerWarnings, setScannerWarnings] = useState([]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId]
  );

  const loadAgents = async () => {
    try {
      setLoadingAgents(true);
      const response = await agentsApi.getConnected();
      const devices = response.data?.devices || [];
      setAgents(devices);

      if (devices.length > 0 && !selectedAgentId) {
        setSelectedAgentId(devices[0].id);
      } else if (devices.length > 0 && selectedAgentId && !devices.find((d) => d.id === selectedAgentId)) {
        setSelectedAgentId(devices[0].id);
      }
    } catch (error) {
      setDiscoveryError('Failed to load connected agents.');
    } finally {
      setLoadingAgents(false);
    }
  };

  useEffect(() => {
    loadAgents();
  }, []);

  useEffect(() => {
    if (!socketService.connected()) {
      socketService.connect();
    }
  }, []);

  const runDiscovery = async () => {
    if (!selectedAgentId) {
      setDiscoveryError('Select an agent first.');
      return;
    }

    setDiscovering(true);
    setDiscoveryError('');
    setScannerWarnings([]);
    setResults([]);

    let timeoutId;
    let unsubscribe;

    try {
      const resultPromise = new Promise((resolve, reject) => {
        unsubscribe = socketService.on('agent_command_result', (event) => {
          if (event?.computerId !== selectedAgentId || event?.action !== 'discover-peers') {
            return;
          }
          resolve(event);
        });

        timeoutId = setTimeout(() => {
          reject(new Error('Timed out waiting for agent discovery result.'));
        }, RESULT_TIMEOUT_MS);
      });

      await agentsApi.sendCommand(selectedAgentId, 'discover-peers', {});
      const event = await resultPromise;

      const payload = event?.result || {};
      const discovered = Array.isArray(payload.discovered) ? payload.discovered : [];
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];

      setResults(discovered);
      setScannerWarnings(warnings);
      setLastRunAt(new Date());
      if (event?.success === false) {
        setDiscoveryError(event.error || payload.error || 'Discovery failed on the agent.');
      }
    } catch (error) {
      setDiscoveryError(error.message || 'Failed to run discovery.');
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (unsubscribe) unsubscribe();
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
            <div className="min-w-[260px]">
              <label className="block text-sm font-medium text-gray-700 mb-1">Target agent</label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                disabled={loadingAgents || discovering}
              >
                {agents.length === 0 ? (
                  <option value="">No connected agents</option>
                ) : (
                  agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name || agent.hostname || agent.id} ({agent.ip})
                    </option>
                  ))
                )}
              </select>
            </div>

            <button
              onClick={loadAgents}
              disabled={loadingAgents || discovering}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loadingAgents ? 'animate-spin' : ''}`} />
              Refresh Agents
            </button>

            <button
              onClick={runDiscovery}
              disabled={discovering || !selectedAgentId}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              <Search className="w-4 h-4" />
              {discovering ? 'Discovering...' : 'Discover now'}
            </button>
          </div>

          {selectedAgent && (
            <p className="text-sm text-gray-500">
              Selected: <span className="font-medium text-gray-700">{selectedAgent.name || selectedAgent.hostname}</span> ({selectedAgent.ip})
            </p>
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
          <p className="text-sm text-gray-500">Result shape: hostname, ip, mac, status, connection_type</p>
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
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    {discovering ? 'Running discovery...' : 'No results yet. Select an agent and click Discover now.'}
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
