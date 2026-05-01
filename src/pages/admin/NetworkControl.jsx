import { useEffect, useMemo, useState } from 'react';
import {
  Wifi,
  WifiOff,
  CheckCircle,
  Monitor,
  RefreshCw,
  Search,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { agentsApi } from '../../services/api';

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

function NetworkControl() {
  const [machines, setMachines] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [error, setError] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [commandLoading, setCommandLoading] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchConnectedMachines = async () => {
    try {
      setIsLoading(true);
      setError('');
      const response = await agentsApi.getConnected();
      const devices = response?.data?.devices || [];
      setMachines(devices);
      setLastScan(new Date());
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to scan connected agent PCs.');
    } finally {
      setIsLoading(false);
      setIsInitialLoad(false);
    }
  };

  useEffect(() => {
    fetchConnectedMachines();
  }, []);

  const handleDisableWifi = async (machine) => {
    const key = `${machine.id}-disable`;
    const machineLabel = machine.user || machine.name || machine.hostname || machine.id;
    try {
      setCommandLoading((prev) => ({ ...prev, [key]: true }));
      await agentsApi.sendCommand(machine.id, 'disable_wifi', {});
      showToast(`Disable Wi-Fi command sent to ${machineLabel}`);
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to send disable Wi-Fi command.', 'error');
    } finally {
      setCommandLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleEnableWifi = async (machine) => {
    const key = `${machine.id}-enable`;
    const machineLabel = machine.user || machine.name || machine.hostname || machine.id;
    try {
      setCommandLoading((prev) => ({ ...prev, [key]: true }));
      await agentsApi.sendCommand(machine.id, 'enable_wifi', {});
      showToast(`Enable Wi-Fi command sent to ${machineLabel}`);
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to send enable Wi-Fi command.', 'error');
    } finally {
      setCommandLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const onlineCount = useMemo(
    () => machines.filter((machine) => String(machine.status).toLowerCase() === 'online').length,
    [machines]
  );
  const offlineCount = machines.length - onlineCount;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Network Control</h1>
          <p className="text-gray-500">
            Scan and manage agent-connected PCs from this host.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchConnectedMachines}
            disabled={isLoading}
            className="h-10 px-4 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Scan PCs
              </>
            )}
          </button>
          <button
            onClick={fetchConnectedMachines}
            disabled={isLoading}
            className="h-10 px-3 rounded-md text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60 inline-flex items-center"
            title="Refresh connected PCs"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center mr-3">
              <Wifi className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">PCs Online</p>
              <p className="text-xl font-bold text-gray-900">{onlineCount}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center mr-3">
              <Monitor className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Scanned PCs</p>
              <p className="text-xl font-bold text-gray-900">{machines.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center mr-3">
              <WifiOff className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">PCs Offline</p>
              <p className="text-xl font-bold text-gray-900">{offlineCount}</p>
            </div>
          </div>
        </div>
      </div>

      {lastScan && (
        <p className="text-sm text-gray-500">
          Last scan: {lastScan.toLocaleString()}
        </p>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}

      {/* Connected PC Cards */}
      {!isInitialLoad && machines.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-10 text-center">
          <Monitor className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">No agent-connected PCs found.</p>
          <p className="text-sm text-gray-500 mt-1">
            Click Scan PCs after agent clients connect to this host.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {machines.map((machine) => {
            const isOnline = String(machine.status).toLowerCase() === 'online';
            const machineLabel = machine.user || machine.name || machine.hostname || machine.id;
            return (
              <div key={machine.id} className="bg-white rounded-lg border border-gray-200 shadow-sm">
                <div className="p-6 border-b border-gray-100">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center">
                      <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center mr-3">
                        <Monitor className="w-5 h-5 text-slate-600" />
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">{machineLabel}</h3>
                        <p className="text-sm text-gray-500">{machine.ip || 'Unknown IP'}</p>
                      </div>
                    </div>
                    {isOnline ? (
                      <CheckCircle className="w-5 h-5 text-green-500" />
                    ) : (
                      <WifiOff className="w-5 h-5 text-red-500" />
                    )}
                  </div>
                </div>
                <div className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">Agent Status</span>
                    <Badge variant={isOnline ? 'success' : 'destructive'}>
                      {isOnline ? 'online' : 'offline'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">MAC</span>
                    <span className="text-sm font-medium text-gray-700">{machine.mac || 'Unknown'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">OS</span>
                    <span className="text-sm font-medium text-gray-700">{machine.os || 'Unknown'}</span>
                  </div>

                  <div className="pt-4 border-t border-gray-100">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => handleDisableWifi(machine)}
                        disabled={!isOnline || commandLoading[`${machine.id}-disable`] || commandLoading[`${machine.id}-enable`]}
                        className={`h-10 rounded-md text-sm font-medium flex items-center justify-center transition-colors ${
                          !isOnline
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-70'
                        }`}
                        title={isOnline ? 'Disable Wi-Fi on this connected PC' : 'PC is offline'}
                      >
                        {commandLoading[`${machine.id}-disable`] ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <WifiOff className="w-4 h-4 mr-2" />
                            Disable Wi-Fi
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => handleEnableWifi(machine)}
                        disabled={!isOnline || commandLoading[`${machine.id}-enable`] || commandLoading[`${machine.id}-disable`]}
                        className={`h-10 rounded-md text-sm font-medium flex items-center justify-center transition-colors ${
                          !isOnline
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-70'
                        }`}
                        title={isOnline ? 'Enable Wi-Fi on this connected PC' : 'PC is offline'}
                      >
                        {commandLoading[`${machine.id}-enable`] ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Wifi className="w-4 h-4 mr-2" />
                            Enable Wi-Fi
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg z-50 text-sm font-medium ${
            toast.type === 'success' ? 'bg-gray-900 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default NetworkControl;
