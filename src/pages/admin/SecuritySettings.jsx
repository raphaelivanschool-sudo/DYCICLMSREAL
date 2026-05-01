import { useEffect, useMemo, useState } from 'react';
import {
  Shield,
  Globe,
  Monitor,
  CheckCircle,
  Loader2,
  XCircle,
  Building2,
  Search
} from 'lucide-react';
import { agentsApi, labsApi } from '../../services/api';
import networkApi from '../../services/network-api';
import socketService from '../../services/socketService';

const DEFAULT_BLOCKED_WEBSITES = [
  'facebook.com',
  'youtube.com',
  'twitter.com',
  'instagram.com',
  'tiktok.com',
  'chatgpt',
];

// Helper component for badges
const Badge = ({ variant, children }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    destructive: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
};

function normalizeDomain(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function SecuritySettings() {
  const [labs, setLabs] = useState([]);
  const [isLoadingLabs, setIsLoadingLabs] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isLoadingDevices, setIsLoadingDevices] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [devices, setDevices] = useState([]);
  const [selectedPcIds, setSelectedPcIds] = useState([]);
  const [selectedLab, setSelectedLab] = useState('all');
  const [blockedWebsites, setBlockedWebsites] = useState(DEFAULT_BLOCKED_WEBSITES);
  const [newWebsite, setNewWebsite] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [securitySettings, setSecuritySettings] = useState({
    blockWebsites: true,
  });

  const agentCapableDevices = useMemo(
    () => devices.filter((device) => device.source === 'agent'),
    [devices]
  );

  const selectedAgentCapableDevices = useMemo(
    () => agentCapableDevices.filter((device) => selectedPcIds.includes(device.id)),
    [agentCapableDevices, selectedPcIds]
  );

  useEffect(() => {
    socketService.connect();

    const loadInitialData = async () => {
      await Promise.all([fetchLabs(), fetchScannedDevices()]);
    };

    loadInitialData();
  }, []);

  const fetchLabs = async () => {
    try {
      setIsLoadingLabs(true);
      const response = await labsApi.getAll();
      setLabs(response.data?.data || []);
    } catch {
      setErrorMessage('Failed to load laboratories.');
    } finally {
      setIsLoadingLabs(false);
    }
  };

  const fetchScannedDevices = async () => {
    try {
      setIsLoadingDevices(true);
      setErrorMessage('');

      const [agentsResult, networkResult] = await Promise.allSettled([
        agentsApi.getConnected(),
        networkApi.getDiscoveredDevices(),
      ]);

      const merged = [];
      const ipsWithAgent = new Set();

      if (agentsResult.status === 'fulfilled') {
        const agentDevices = agentsResult.value.data?.devices || [];
        agentDevices.forEach((device) => {
          ipsWithAgent.add(device.ip);
          merged.push({
            id: String(device.id),
            name: device.user || device.name || device.hostname || `PC-${String(device.ip).split('.').pop()}`,
            ip: device.ip,
            status: device.status || 'online',
            source: 'agent',
          });
        });
      }

      if (networkResult.status === 'fulfilled') {
        const discovered = networkResult.value.devices || [];
        discovered.forEach((device) => {
          if (!ipsWithAgent.has(device.ip)) {
            merged.push({
              id: `net-${device.ip}`,
              name: device.user || device.name || device.hostname || `PC-${String(device.ip).split('.').pop()}`,
              ip: device.ip,
              status: device.status || 'online',
              source: 'network',
            });
          }
        });
      }

      setDevices(merged);
      setSelectedPcIds((prev) => prev.filter((id) => merged.some((device) => device.id === id)));
    } catch {
      setErrorMessage('Failed to load scanned PCs.');
    } finally {
      setIsLoadingDevices(false);
    }
  };

  const runScan = async () => {
    try {
      setIsScanning(true);
      setScanProgress(0);
      setErrorMessage('');
      setStatusMessage('Network scan started...');

      await networkApi.startServerScan();

      let attempts = 0;
      while (attempts < 60) {
        const status = await networkApi.getScanStatus();
        setScanProgress(status.progress || 0);
        if (!status.isScanning && !status.hasActiveScan) break;
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      await fetchScannedDevices();
      setStatusMessage('Scan complete. Devices list refreshed.');
    } catch (error) {
      setErrorMessage(error.message || 'Failed to start network scan.');
    } finally {
      setIsScanning(false);
    }
  };

  const toggleSetting = (setting) => {
    setSecuritySettings(prev => ({
      ...prev,
      [setting]: !prev[setting]
    }));
  };

  const addWebsite = () => {
    const domain = normalizeDomain(newWebsite);
    if (!domain) return;
    if (blockedWebsites.includes(domain)) {
      setNewWebsite('');
      return;
    }
    setBlockedWebsites((prev) => [...prev, domain]);
    setNewWebsite('');
  };

  const removeWebsite = (site) => {
    setBlockedWebsites((prev) => prev.filter((existing) => existing !== site));
  };

  const toggleSelectPc = (pcId) => {
    setSelectedPcIds((prev) =>
      prev.includes(pcId) ? prev.filter((id) => id !== pcId) : [...prev, pcId]
    );
  };

  const toggleSelectAllAgents = () => {
    if (selectedAgentCapableDevices.length === agentCapableDevices.length) {
      setSelectedPcIds([]);
      return;
    }
    setSelectedPcIds(agentCapableDevices.map((device) => device.id));
  };

  const selectSinglePc = (pcId) => {
    if (!pcId) {
      setSelectedPcIds([]);
      return;
    }
    setSelectedPcIds([pcId]);
  };

  const applyWebsiteBlocking = async () => {
    if (selectedAgentCapableDevices.length === 0) {
      setErrorMessage('Select at least one agent-connected PC.');
      return;
    }

    if (securitySettings.blockWebsites && blockedWebsites.length === 0) {
      setErrorMessage('Add at least one website to block.');
      return;
    }

    try {
      setIsApplying(true);
      setErrorMessage('');
      setStatusMessage('Applying website blocking policy...');

      const action = securitySettings.blockWebsites
        ? 'set_website_blocklist'
        : 'clear_website_blocklist';
      const params = securitySettings.blockWebsites ? { websites: blockedWebsites } : {};

      const sendResults = await Promise.allSettled(
        selectedAgentCapableDevices.map((device) =>
          agentsApi.sendCommand(device.id, action, params)
        )
      );

      const sendSucceeded = sendResults.filter((result) => result.status === 'fulfilled').length;
      const sendFailed = sendResults.length - sendSucceeded;

      if (sendFailed > 0) {
        setErrorMessage(`Failed to send command to ${sendFailed} PC(s).`);
        return;
      }

      const expectedIds = new Set(selectedAgentCapableDevices.map((device) => String(device.id)));
      const errors = [];
      let resolvedCount = 0;

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (resolvedCount < expectedIds.size) {
            errors.push(
              `${expectedIds.size - resolvedCount} PC(s) did not confirm policy application (agent may be offline or unresponsive).`
            );
          }
          unsubscribe?.();
          resolve();
        }, 12000);

        const unsubscribe = socketService.on('agent_command_result', (event) => {
          if (!event || event.action !== action) return;
          const computerId = String(event.computerId || '');
          if (!expectedIds.has(computerId)) return;

          expectedIds.delete(computerId);
          resolvedCount += 1;

          if (!event.success) {
            const reason = String(event.error || 'Unknown error');
            const permissionHint =
              reason.toLowerCase().includes('eacces') ||
              reason.toLowerCase().includes('eperm') ||
              reason.toLowerCase().includes('access is denied')
                ? ' Run agent as Administrator on that PC.'
                : '';
            errors.push(`${computerId}: ${reason}.${permissionHint}`);
          }

          if (expectedIds.size === 0) {
            clearTimeout(timeout);
            unsubscribe?.();
            resolve();
          }
        });
      });

      if (errors.length > 0) {
        setErrorMessage(`Policy apply issues: ${errors.join(' | ')}`);
      } else {
        setStatusMessage(`Website policy applied to ${selectedAgentCapableDevices.length} PC(s).`);
      }
    } catch {
      setErrorMessage('Failed to apply website blocking policy.');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Security Settings</h1>
        <p className="text-gray-500">Configure security policies and restrictions across laboratories</p>
      </div>

      {/* Lab Selector */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-center space-x-4">
          <Building2 className="w-5 h-5 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">Apply settings to:</span>
          <select
            value={selectedLab}
            onChange={(e) => setSelectedLab(e.target.value)}
            className="flex-1 max-w-xs h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Laboratories</option>
            {labs.map((lab) => (
              <option key={lab.id} value={lab.id}>{lab.name}</option>
            ))}
          </select>
          {isLoadingLabs && <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />}
        </div>
      </div>

      {(statusMessage || errorMessage) && (
        <div className={`rounded-lg border p-3 text-sm ${errorMessage ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
          {errorMessage || statusMessage}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Website Blocking */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm xl:col-span-2">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center mr-3">
                  <Globe className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Website Blocking</h3>
                  <p className="text-sm text-gray-500">Apply website blocklist to scanned PCs</p>
                </div>
              </div>
              <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center mr-3">
                <button
                  onClick={runScan}
                  disabled={isScanning}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {isScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  Scan PCs
                </button>
              </div>
            </div>
            {isScanning && (
              <p className="mt-3 text-xs text-blue-700">Scanning network... {scanProgress}%</p>
            )}
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center">
                <Shield className="w-5 h-5 text-gray-600 mr-3" />
                <span className="text-sm font-medium text-gray-700">Enable Website Blocking</span>
              </div>
              <button
                onClick={() => toggleSetting('blockWebsites')}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  securitySettings.blockWebsites ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    securitySettings.blockWebsites ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="space-y-2">
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg space-y-2">
                <p className="text-xs font-medium text-blue-900">Target scanned PC</p>
                <select
                  value={selectedAgentCapableDevices.length === 1 ? selectedAgentCapableDevices[0].id : ''}
                  onChange={(e) => selectSinglePc(e.target.value)}
                  className="w-full h-9 px-3 py-2 bg-white border border-blue-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select one agent-ready PC</option>
                  {agentCapableDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name} ({device.ip})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-blue-700">
                  Pick one PC here, or use the list on the right to select multiple PCs.
                </p>
              </div>
              <p className="text-sm font-medium text-gray-700">Blocked Websites:</p>
              <div className="space-y-2">
                {blockedWebsites.map((site) => (
                  <div key={site} className="flex items-center justify-between p-2 bg-red-50 rounded-md">
                    <div className="flex items-center">
                      <XCircle className="w-4 h-4 text-red-500 mr-2" />
                      <span className="text-sm text-red-700">{site}</span>
                    </div>
                    <button onClick={() => removeWebsite(site)} className="text-red-400 hover:text-red-600">
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newWebsite}
                  onChange={(e) => setNewWebsite(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addWebsite()}
                  placeholder="Add website (e.g., reddit.com)"
                  className="flex-1 h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm"
                />
                <button
                  onClick={addWebsite}
                  className="px-4 h-10 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Scanned PCs */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="p-6 border-b border-gray-100">
            <div className="flex items-center">
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center mr-3">
                <Monitor className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Scanned PCs</h3>
                <p className="text-sm text-gray-500">Select PCs to apply website policy</p>
              </div>
            </div>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">
                {devices.length} device(s), {agentCapableDevices.length} agent-ready
              </span>
              <button onClick={toggleSelectAllAgents} className="text-xs text-blue-600 hover:underline">
                {selectedAgentCapableDevices.length === agentCapableDevices.length ? 'Clear Selection' : 'Select All Agent PCs'}
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto space-y-2">
              {isLoadingDevices ? (
                <div className="text-sm text-gray-500 py-6 text-center">Loading devices...</div>
              ) : devices.length === 0 ? (
                <div className="text-sm text-gray-500 py-6 text-center">No scanned PCs yet. Click `Scan PCs`.</div>
              ) : (
                devices.map((device) => {
                  const isChecked = selectedPcIds.includes(device.id);
                  const isAgent = device.source === 'agent';
                  return (
                    <label key={device.id} className="flex items-start gap-3 p-3 border rounded-md cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelectPc(device.id)}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{device.name}</p>
                        <p className="text-xs text-gray-500">{device.ip}</p>
                      </div>
                      <Badge variant={isAgent ? 'success' : 'warning'}>
                        {isAgent ? 'Agent Ready' : 'Scan Only'}
                      </Badge>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={applyWebsiteBlocking}
          disabled={isApplying}
          className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-60"
        >
          {isApplying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-2" />}
          Apply Website Policy
        </button>
      </div>
    </div>
  );
}

export default SecuritySettings;
