import { useState, useEffect, useCallback } from 'react';
import { Monitor, Lock, Power, Eye, Wifi, WifiOff, Settings, RefreshCw, Search, Loader2, ChevronDown, Check, X, Filter, Laptop, Smartphone, Printer, Radio } from 'lucide-react';
import networkApi from '../services/network-api';
import { agentsApi } from '../services/api';
import socketService from '../services/socketService';

const PCControlPanel = () => {
  const [pcs, setPcs] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [agentCount, setAgentCount] = useState(0);
  const [subnet, setSubnet] = useState('');
  const [showSubnetDropdown, setShowSubnetDropdown] = useState(false);
  const [availableSubnets, setAvailableSubnets] = useState(['192.168.1', '192.168.0', '10.0.0']);
  const [showSettings, setShowSettings] = useState(false);
  const [filterMode, setFilterMode] = useState('pcs-only'); // 'all', 'pcs-only', 'agents-only'
  const [vncPassword, setVncPassword] = useState('labpass123');
  const [agentInstallerUrl, setAgentInstallerUrl] = useState('');

  const [selectedPC, setSelectedPC] = useState(null);
  const [showVNC, setShowVNC] = useState(false);
  const [allDevices, setAllDevices] = useState([]); // Store all discovered devices
  const [broadcastServices, setBroadcastServices] = useState([]); // UDP broadcast discovered services

  // Fetch both agent-connected PCs and network-scanned devices
  const fetchDiscoveredDevices = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Fetch both sources in parallel
      const [networkResponse, agentResponse] = await Promise.allSettled([
        networkApi.getDiscoveredDevices(),
        agentsApi.getConnected()
      ]);
      
      const allDevices = [];
      const agentIPs = new Set();
      
      // Process agent-connected PCs first (more reliable)
      if (agentResponse.status === 'fulfilled' && agentResponse.value.data?.devices) {
        const agentDevices = agentResponse.value.data.devices;
        setAgentCount(agentDevices.length);
        
        for (const device of agentDevices) {
          agentIPs.add(device.ip);
          allDevices.push({
            id: device.id || `agent-${device.ip}`,
            name: device.name || device.hostname || `PC-${device.ip.split('.').pop()}`,
            ip: device.ip,
            status: device.status || 'online',
            vncPort: 5900,
            password: 'labpass123',
            mac: device.mac,
            os: device.os || 'Windows',
            source: 'agent', // Mark as agent-connected
            specs: device.specs,
            lastSeen: device.lastSeen,
            user: device.user
          });
        }
      }
      
      // Add network-scanned devices (skip duplicates by IP)
      if (networkResponse.status === 'fulfilled' && networkResponse.value.devices) {
        for (const device of networkResponse.value.devices) {
          if (!agentIPs.has(device.ip)) {
            allDevices.push({
              id: device.id || `net-${device.ip}`,
              name: device.name || device.hostname || `PC-${device.ip.split('.').pop()}`,
              ip: device.ip,
              status: device.status || 'online',
              vncPort: device.openPorts?.includes(5900) ? 5900 : 5900,
              password: 'labpass123',
              mac: device.mac,
              os: device.os,
              openPorts: device.openPorts || [],
              deviceType: device.deviceType,
              source: 'network', // Mark as network-scanned
              lastSeen: device.lastSeen,
              responseTime: device.responseTime
            });
          }
        }
        
        if (networkResponse.value.lastScan) {
          setLastScan(new Date(networkResponse.value.lastScan));
        }
      }
      
      setAllDevices(allDevices);
      
      // Apply filters
      applyFilters(allDevices, filterMode);
      
      // Detect subnets from found devices
      const subnets = new Set(availableSubnets);
      allDevices.forEach(device => {
        const parts = device.ip.split('.');
        if (parts.length === 4) {
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      });
      setAvailableSubnets(Array.from(subnets));
      
      setError(null);
    } catch (err) {
      console.error('Error fetching discovered devices:', err);
      setError('Failed to load devices. Click "Scan Network" to discover PCs, or ensure agents are running.');
    } finally {
      setIsLoading(false);
    }
  }, [availableSubnets, filterMode]);

  // Apply filters to device list
  const applyFilters = (devices, mode) => {
    let filtered = devices;
    
    switch (mode) {
      case 'agents-only':
        // Only show agent-connected PCs
        filtered = devices.filter(d => d.source === 'agent');
        break;
      case 'broadcast-only':
        // Only show broadcast-discovered PCs
        filtered = devices.filter(d => d.source === 'broadcast');
        break;
      case 'pcs-only':
        // Show PCs only (agents + broadcast + network devices with PC indicators)
        filtered = devices.filter(d => {
          // Always include agents and broadcast-discovered services
          if (d.source === 'agent' || d.source === 'broadcast') return true;
          
          // For network devices, check if it looks like a PC
          // Must have at least one of: VNC (5900), RDP (3389), SSH (22), SMB (445), WinRM (5985)
          const pcPorts = [5900, 3389, 22, 445, 5985, 135, 139];
          const hasPCPort = d.openPorts?.some(port => pcPorts.includes(port));
          
          // Or check device type if available
          const isPCType = d.deviceType === 'computer' || d.deviceType === 'server';
          
          return hasPCPort || isPCType;
        });
        break;
      case 'all':
      default:
        // Show all devices
        filtered = devices;
        break;
    }
    
    setPcs(filtered);
  };

  // Update filters when mode changes
  useEffect(() => {
    applyFilters(allDevices, filterMode);
  }, [filterMode, allDevices]);

  // Start network scan
  const startNetworkScan = async (customSubnet = null) => {
    try {
      setIsScanning(true);
      setScanProgress(0);
      setError(null);
      setShowSubnetDropdown(false);
      
      // Use custom subnet if provided, otherwise use selected subnet
      const scanRange = customSubnet || subnet || null;
      
      await networkApi.startScan(scanRange);
      
      // Poll for scan status
      const statusInterval = setInterval(async () => {
        try {
          const status = await networkApi.getScanStatus();
          setScanProgress(status.progress || 0);
          
          if (!status.isScanning && !status.hasActiveScan) {
            clearInterval(statusInterval);
            setIsScanning(false);
            // Refresh devices list after scan completes
            await fetchDiscoveredDevices();
          }
        } catch (err) {
          console.error('Error checking scan status:', err);
          clearInterval(statusInterval);
          setIsScanning(false);
        }
      }, 2000);
      
      // Auto-clear interval after 5 minutes (safety timeout)
      setTimeout(() => {
        clearInterval(statusInterval);
        setIsScanning(false);
      }, 5 * 60 * 1000);
      
    } catch (err) {
      console.error('Error starting network scan:', err);
      setError(err.message || 'Failed to start network scan');
      setIsScanning(false);
    }
  };

  // Load devices on component mount
  useEffect(() => {
    fetchDiscoveredDevices();
  }, [fetchDiscoveredDevices]);

  // Auto-refresh devices every 30 seconds when not scanning
  useEffect(() => {
    if (isScanning) return;
    
    const interval = setInterval(() => {
      fetchDiscoveredDevices();
    }, 30000);
    
    return () => clearInterval(interval);
  }, [isScanning, fetchDiscoveredDevices]);

  // Listen for real-time service discovery via Socket.IO
  useEffect(() => {
    // Connect socket if not connected
    if (!socketService.connected()) {
      socketService.connect();
    }

    // Listen for service discovered via UDP broadcast
    const unsubscribeDiscovered = socketService.on('service_discovered', (data) => {
      console.log('[Discovery] Service discovered via broadcast:', data);
      
      setBroadcastServices(prev => {
        // Check if already exists
        const exists = prev.find(s => s.ip === data.ip && s.port === data.port);
        if (exists) {
          // Update existing
          return prev.map(s => 
            s.ip === data.ip && s.port === data.port 
              ? { ...s, lastSeen: new Date(), hostname: data.hostname }
              : s
          );
        }
        // Add new
        return [...prev, { ...data, lastSeen: new Date(), source: 'broadcast' }];
      });
    });

    // Listen for service going offline
    const unsubscribeOffline = socketService.on('service_offline', (data) => {
      setBroadcastServices(prev => 
        prev.filter(s => !(s.computerId === data.computerId && s.ip === data.ip))
      );
    });

    // Listen for agent connections
    const unsubscribeOnline = socketService.on('computer_online', (data) => {
      console.log('[Discovery] Computer online via agent:', data);
      fetchDiscoveredDevices(); // Refresh the list
    });

    const unsubscribeAgentOffline = socketService.on('computer_offline', (data) => {
      fetchDiscoveredDevices(); // Refresh the list
    });

    return () => {
      unsubscribeDiscovered();
      unsubscribeOffline();
      unsubscribeOnline();
      unsubscribeAgentOffline();
    };
  }, [fetchDiscoveredDevices]);

  // Merge broadcast services into all devices
  useEffect(() => {
    if (broadcastServices.length === 0) return;
    
    setAllDevices(prev => {
      const existingIPs = new Set(prev.map(d => d.ip));
      const newBroadcastDevices = broadcastServices
        .filter(s => !existingIPs.has(s.ip))
        .map(s => ({
          id: s.computerId || `broadcast-${s.ip}`,
          name: s.hostname || `PC-${s.ip.split('.').pop()}`,
          ip: s.ip,
          status: 'online',
          vncPort: s.port,
          password: vncPassword,
          source: 'broadcast',
          hasAgent: s.hasAgent,
          lastSeen: s.lastSeen,
          deviceType: 'computer'
        }));
      
      if (newBroadcastDevices.length > 0) {
        return [...prev, ...newBroadcastDevices];
      }
      return prev;
    });
  }, [broadcastServices, vncPassword]);

  const viewScreen = (pc) => {
    setSelectedPC(pc);
    setShowVNC(true);
  };

  const closeVNC = () => {
    setShowVNC(false);
    setSelectedPC(null);
  };

  const lockPC = (pc) => {
    // In a real implementation, this would send a command to the PC
    alert(`Lock command sent to ${pc.name} (${pc.ip})`);
    // You could use your custom agent or PsExec for this
  };

  const shutdownPC = (pc) => {
    if (confirm(`Are you sure you want to shutdown ${pc.name}?`)) {
      alert(`Shutdown command sent to ${pc.name} (${pc.ip})`);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Monitor className="w-8 h-8 text-blue-600" />
          <div>
            <h2 className="text-2xl font-bold text-gray-900">PC Control Panel</h2>
            <p className="text-gray-500 text-sm">
              {lastScan 
                ? `${pcs.length} PC${pcs.length !== 1 ? 's' : ''} shown (${agentCount} via agent${broadcastServices.length > 0 ? `, ${broadcastServices.length} via broadcast` : ''}${subnet ? `, scanned ${subnet}.x` : ''}) - Filter: ${filterMode === 'pcs-only' ? 'PCs Only' : filterMode === 'agents-only' ? 'Agents Only' : filterMode === 'broadcast-only' ? 'Broadcast Only' : 'All Devices'}`
                : `Manage lab computers remotely${agentCount > 0 ? ` (${agentCount} agents connected)` : ''}${broadcastServices.length > 0 ? ` (${broadcastServices.length} via broadcast)` : ''}`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <button 
              onClick={() => startNetworkScan()}
              disabled={isScanning}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isScanning ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Scanning... {scanProgress}%</>
              ) : (
                <><Search className="w-4 h-4" /> Scan Network</>
              )}
            </button>
            {!isScanning && (
              <button
                onClick={() => setShowSubnetDropdown(!showSubnetDropdown)}
                className="absolute right-0 top-0 bottom-0 px-2 bg-blue-700 rounded-r-lg hover:bg-blue-800"
              >
                <ChevronDown className="w-4 h-4 text-white" />
              </button>
            )}
            {showSubnetDropdown && (
              <div className="absolute top-full right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-10">
                <div className="p-2 text-xs text-gray-500 border-b">Select Subnet to Scan</div>
                {availableSubnets.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setSubnet(s);
                      startNetworkScan(s);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center justify-between ${subnet === s ? 'bg-blue-50 text-blue-700' : ''}`}
                  >
                    {s}.x
                    {subnet === s && <Check className="w-4 h-4" />}
                  </button>
                ))}
                <div className="border-t p-2">
                  <input
                    type="text"
                    placeholder="Custom subnet (e.g., 192.168.1)"
                    className="w-full px-2 py-1 text-sm border rounded"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = e.target.value.trim();
                        if (val && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(val)) {
                          if (!availableSubnets.includes(val)) {
                            setAvailableSubnets([...availableSubnets, val]);
                          }
                          setSubnet(val);
                          startNetworkScan(val);
                        }
                      }
                    }}
                  />
                </div>
              </div>
            )}
          </div>
          <button 
            onClick={fetchDiscoveredDevices}
            disabled={isLoading || isScanning}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button 
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </div>
      </div>

      {/* Scan Progress Bar */}
      {isScanning && (
        <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-blue-900">Scanning network for available PCs...</span>
            <span className="text-sm text-blue-700">{scanProgress}%</span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${scanProgress}%` }}
            ></div>
          </div>
          <p className="text-xs text-blue-600 mt-2">Discovering devices on your local network. This may take a minute...</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 rounded-lg border border-red-200 flex items-center justify-between">
          <span className="text-sm text-red-700">{error}</span>
          <button 
            onClick={fetchDiscoveredDevices}
            className="text-sm text-red-600 hover:text-red-800 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* PC Filter Info */}
      {pcs.length > 0 && filterMode === 'pcs-only' && allDevices.length > pcs.length && (
        <div className="mb-4 p-3 bg-yellow-50 rounded-lg border border-yellow-200 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-yellow-800">
              <strong>Filtered:</strong> Showing {pcs.length} of {allDevices.length} devices (PCs with VNC/RDP/SSH ports only)
            </span>
            <button 
              onClick={() => setFilterMode('all')}
              className="text-yellow-700 hover:text-yellow-900 underline"
            >
              Show All
            </button>
          </div>
        </div>
      )}

      {/* Empty State */}
      {pcs.length === 0 && !isLoading && !isScanning && (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
          <Monitor className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No PCs Found</h3>
          <p className="text-gray-500 mb-2">
            {filterMode === 'pcs-only' 
              ? "Filtered to show only PCs. No computers with VNC/RDP/SSH detected." 
              : "No devices discovered on the network."}
          </p>
          <div className="max-w-md mx-auto mb-4 p-3 bg-blue-50 rounded-lg text-sm text-blue-700">
            <strong>💡 Tip:</strong> Install the TightVNC Agent on target PCs for reliable detection and remote control.
            The agent reports directly to this dashboard with accurate PC info.
          </div>
          <div className="flex justify-center gap-2 flex-wrap">
            <button 
              onClick={() => startNetworkScan('192.168.1')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Search className="w-4 h-4" />
              Scan 192.168.1.x
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              <Wifi className="w-4 h-4" />
              Install Agent
            </button>
            <button 
              onClick={() => setFilterMode('all')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Filter className="w-4 h-4" />
              Show All Devices
            </button>
          </div>
        </div>
      )}

      {/* PC Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pcs.map(pc => (
          <div key={pc.id} className="border rounded-xl p-4 bg-gray-50 hover:bg-white hover:shadow-md transition-all">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Monitor className="w-5 h-5 text-gray-600" />
                <h3 className="font-semibold text-gray-900">{pc.name}</h3>
              </div>
              <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                pc.status === 'online' 
                  ? pc.source === 'agent' 
                    ? 'bg-blue-100 text-blue-700'
                    : pc.source === 'broadcast'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-600'
              }`}>
                {pc.status === 'online' ? (
                  <>
                    {pc.source === 'broadcast' ? <Radio className="w-3 h-3" /> : <Wifi className="w-3 h-3" />}
                    {pc.source === 'agent' ? 'Agent' : pc.source === 'broadcast' ? 'Broadcast' : 'Online'}
                  </>
                ) : (
                  <><WifiOff className="w-3 h-3" /> Offline</>
                )}
              </div>
            </div>
            
            <p className="text-gray-500 text-sm mb-1">{pc.ip}</p>
            {pc.mac && <p className="text-gray-400 text-xs mb-1">MAC: {pc.mac}</p>}
            <p className="text-gray-400 text-xs mb-4">VNC Port: {pc.vncPort}</p>
            
            <div className="flex gap-2">
              <button 
                onClick={() => viewScreen(pc)}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Eye className="w-4 h-4" />
                View
              </button>
              <button 
                onClick={() => lockPC(pc)}
                className="flex items-center justify-center gap-2 bg-yellow-500 text-white px-3 py-2 rounded-lg hover:bg-yellow-600 transition-colors"
              >
                <Lock className="w-4 h-4" />
              </button>
              <button 
                onClick={() => shutdownPC(pc)}
                className="flex items-center justify-center gap-2 bg-red-500 text-white px-3 py-2 rounded-lg hover:bg-red-600 transition-colors"
              >
                <Power className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-gray-600" />
                <h3 className="font-semibold text-gray-900">PC Control Settings</h3>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Filter Mode */}
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                  <Filter className="w-4 h-4" />
                  Device Filter
                </label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="filter"
                      value="pcs-only"
                      checked={filterMode === 'pcs-only'}
                      onChange={(e) => setFilterMode(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <div className="flex items-center gap-2">
                      <Laptop className="w-4 h-4 text-gray-500" />
                      <div>
                        <span className="text-sm font-medium">PCs Only</span>
                        <p className="text-xs text-gray-500">Show only computers (VNC, RDP, or Agent)</p>
                      </div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="filter"
                      value="agents-only"
                      checked={filterMode === 'agents-only'}
                      onChange={(e) => setFilterMode(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <div className="flex items-center gap-2">
                      <Wifi className="w-4 h-4 text-blue-500" />
                      <div>
                        <span className="text-sm font-medium">Agent-Connected Only</span>
                        <p className="text-xs text-gray-500">Only PCs with TightVNC agent installed</p>
                      </div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="filter"
                      value="broadcast-only"
                      checked={filterMode === 'broadcast-only'}
                      onChange={(e) => setFilterMode(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <div className="flex items-center gap-2">
                      <Radio className="w-4 h-4 text-purple-500" />
                      <div>
                        <span className="text-sm font-medium">Broadcast Only</span>
                        <p className="text-xs text-gray-500">Only PCs discovered via UDP broadcast</p>
                      </div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="filter"
                      value="all"
                      checked={filterMode === 'all'}
                      onChange={(e) => setFilterMode(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-gray-500" />
                      <div>
                        <span className="text-sm font-medium">All Devices</span>
                        <p className="text-xs text-gray-500">Show all discovered devices (phones, printers, etc.)</p>
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {/* VNC Password */}
              <div className="border-t pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Default VNC Password
                </label>
                <input
                  type="text"
                  value={vncPassword}
                  onChange={(e) => setVncPassword(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter default VNC password"
                />
                <p className="text-xs text-gray-500 mt-1">
                  This password will be used when connecting to PCs without the agent
                </p>
              </div>

              {/* Agent Installer */}
              <div className="border-t pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Agent Installer URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={agentInstallerUrl}
                    onChange={(e) => setAgentInstallerUrl(e.target.value)}
                    className="flex-1 px-3 py-2 border rounded-lg text-sm"
                    placeholder="http://your-server:3001/agent-installer.exe"
                    readOnly
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Download and run this installer on target PCs to enable remote control
                </p>
                <button
                  onClick={async () => {
                    try {
                      const response = await agentsApi.createInstaller('Default', window.location.origin, '');
                      if (response.data?.config) {
                        setAgentInstallerUrl(`${window.location.origin}/api/agents/download/${response.data.config.computerId}`);
                      }
                    } catch (err) {
                      console.error('Failed to generate installer:', err);
                    }
                  }}
                  className="mt-2 w-full px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                >
                  Generate Agent Installer
                </button>
              </div>

              {/* Stats */}
              <div className="border-t pt-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
                  <div className="p-2 bg-gray-50 rounded-lg">
                    <div className="text-lg font-semibold text-gray-900">{allDevices.length}</div>
                    <div className="text-xs text-gray-500">Total Discovered</div>
                  </div>
                  <div className="p-2 bg-blue-50 rounded-lg">
                    <div className="text-lg font-semibold text-blue-900">{agentCount}</div>
                    <div className="text-xs text-blue-600">With Agent</div>
                  </div>
                  <div className="p-2 bg-purple-50 rounded-lg">
                    <div className="text-lg font-semibold text-purple-900">{broadcastServices.length}</div>
                    <div className="text-xs text-purple-600">Via Broadcast</div>
                  </div>
                  <div className="p-2 bg-green-50 rounded-lg">
                    <div className="text-lg font-semibold text-green-900">{pcs.length}</div>
                    <div className="text-xs text-green-600">PCs Shown</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VNC Viewer Modal */}
      {showVNC && selectedPC && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl overflow-hidden">
            {/* Header */}
            <div className="bg-gray-900 text-white p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Monitor className="w-6 h-6" />
                <div>
                  <h3 className="font-semibold">{selectedPC.name}</h3>
                  <p className="text-gray-400 text-sm">{selectedPC.ip}:{selectedPC.vncPort}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.open(`vnc://viewer?host=${selectedPC.ip}&port=${selectedPC.vncPort}`, '_blank')}
                  className="px-4 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors text-sm"
                >
                  Open in VNC Viewer
                </button>
                <button
                  onClick={closeVNC}
                  className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* VNC Container */}
            <div className="p-4 bg-gray-100">
              <div className="bg-black rounded-lg overflow-hidden" style={{ height: '600px' }}>
                {/* Placeholder for VNC - You can integrate noVNC here */}
                <div className="h-full flex flex-col items-center justify-center text-white">
                  <Monitor className="w-16 h-16 mb-4 text-gray-600" />
                  <p className="text-gray-400 mb-4">VNC Connection to {selectedPC.name}</p>
                  
                  {/* Option 1: Direct VNC Link */}
                  <a 
                    href={`vnc://viewer?host=${selectedPC.ip}&port=${selectedPC.vncPort}`}
                    className="px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors mb-3"
                  >
                    Connect with TightVNC Viewer
                  </a>
                  
                  {/* Instructions */}
                  <div className="mt-4 p-4 bg-gray-800 rounded-lg max-w-md text-sm text-gray-400">
                    <p className="mb-2"><strong>VNC Password:</strong> {selectedPC.password || vncPassword}</p>
                    <p>1. Install TightVNC Viewer on this PC</p>
                    <p>2. Click the button above or use:</p>
                    <p className="font-mono text-xs mt-1">Host: {selectedPC.ip}</p>
                    <p className="font-mono text-xs">Port: {selectedPC.vncPort}</p>
                  </div>

                  {/* Option 2: Browser-based (if noVNC is set up) */}
                  {/* 
                  <iframe 
                    src={`http://${selectedPC.ip}:6080/vnc.html?host=${selectedPC.ip}&port=${selectedPC.vncPort}`}
                    width="100%" 
                    height="100%"
                    className="border-0"
                  />
                  */}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PCControlPanel;
