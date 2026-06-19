import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server, Wifi, Clock, WifiOff, Search, Monitor, Lock, MessageSquare, Eye, X, Send,
  RefreshCw, Power, RotateCcw, MonitorUp, Cast, AlertTriangle,
} from 'lucide-react';
import { agentsApi } from '../../services/api';
import socketService from '../../services/socketService';
import useScreenProjection from '../../hooks/useScreenProjection';

// Agent-centric dashboard. Counts and the PC grid come entirely from the live
// agent-discovery pipeline (the SAME source as Student Screen Monitoring / Control
// Actions) — never from a student-login/session roster. Live previews and commands
// reuse the existing monitoring/control backends (agentsApi → Socket.IO), so there
// is no second implementation and no stale-IP dialing.
const DISCOVERY_POLL_MS = 5000;   // re-pull connected agents
const THUMB_TTL_MS = 4000;        // refresh each online tile's thumbnail ~every 4s
const TICK_MS = 1000;             // scheduler granularity (also drives "updated Xs ago")
const MAX_CONCURRENT_SHOTS = 4;   // cap simultaneous screenshot fetches
const POWER_GRACE_DEFAULT = 30;   // countdown (s) before shutdown/restart fires

function agoText(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function ClassroomDashboard() {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [devices, setDevices] = useState(() => new Map()); // agentId -> device
  const [screenshots, setScreenshots] = useState(() => new Map()); // agentId -> { dataUrl, timestamp, stale }
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [lastUpdated, setLastUpdated] = useState(null);

  const [messageText, setMessageText] = useState('');
  const [showMessageInput, setShowMessageInput] = useState(false);
  const [confirmPower, setConfirmPower] = useState(null); // { action, device }

  const {
    projectionActive, startProjection, stopProjection,
    projectingCount, totalGuests, guestStateFor,
  } = useScreenProjection();

  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Refs the screenshot scheduler reads without re-subscribing every render.
  const devicesRef = useRef(devices);
  const pendingRef = useRef(new Set());
  const lastShotAtRef = useRef(new Map());
  const inFlightRef = useRef(0);
  useEffect(() => { devicesRef.current = devices; }, [devices]);

  // ---- Discovery: pull connected agents; flip missing ones to offline. ----
  const pollDiscovery = useCallback(async () => {
    try {
      const res = await agentsApi.getConnected();
      const list = res?.data?.devices || [];
      setError('');
      setDevices((prev) => {
        const next = new Map(prev);
        const onlineIds = new Set();
        for (const d of list) {
          if (!d?.id) continue;
          const key = String(d.id);
          onlineIds.add(key);
          const existing = next.get(key) || {};
          next.set(key, {
            ...existing,
            agentId: d.id,
            hostname: d.hostname || d.name || existing.hostname || 'Unknown',
            user: d.user || existing.user || '',
            ip: d.ip || existing.ip || '',
            mac: d.mac || existing.mac || '',
            os: d.os || existing.os || '',
            status: 'online',
            lastSeen: d.lastSeen || new Date().toISOString(),
            firstSeen: existing.firstSeen || Date.now(),
          });
        }
        for (const [key, dev] of next) {
          if (!onlineIds.has(key) && dev.status !== 'offline') {
            next.set(key, { ...dev, status: 'offline', offlineSince: Date.now() });
          }
        }
        return next;
      });
      setLastUpdated(Date.now());
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Failed to load connected agents');
    }
  }, []);

  // Mount: connect socket, immediate discovery, then poll + react to agent events.
  useEffect(() => {
    if (!socketService.connected()) socketService.connect();
    pollDiscovery();
    const poll = setInterval(pollDiscovery, DISCOVERY_POLL_MS);

    const unsubOnline = socketService.on('computer_online', () => pollDiscovery());
    const unsubOffline = socketService.on('computer_offline', (data) => {
      const id = data?.computerId != null ? String(data.computerId) : null;
      if (id) {
        setDevices((prev) => {
          const dev = prev.get(id);
          if (!dev || dev.status === 'offline') return prev;
          const next = new Map(prev);
          next.set(id, { ...dev, status: 'offline', offlineSince: Date.now() });
          return next;
        });
      }
      pollDiscovery();
    });

    return () => {
      clearInterval(poll);
      unsubOnline?.();
      unsubOffline?.();
    };
  }, [pollDiscovery]);

  // ---- Live thumbnails: capture runs on the guest (Python/mss) over Socket.IO. ----
  const markStale = useCallback((key) => {
    setScreenshots((prev) => {
      const shot = prev.get(key);
      if (!shot) return prev;
      const n = new Map(prev);
      n.set(key, { ...shot, stale: true });
      return n;
    });
  }, []);

  const fetchShot = useCallback(async (device) => {
    const key = String(device.agentId);
    pendingRef.current.add(key);
    inFlightRef.current += 1;
    lastShotAtRef.current.set(key, Date.now());
    try {
      const res = await agentsApi.getScreenshot(device.agentId, { ip: device.ip, mac: device.mac });
      const data = res?.data;
      if (data?.success && data.screenshot) {
        const fmt = (data.format || 'jpeg').toLowerCase();
        const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        setScreenshots((prev) => {
          const n = new Map(prev);
          n.set(key, { dataUrl: `data:${mime};base64,${data.screenshot}`, timestamp: Date.now(), stale: false });
          return n;
        });
      } else {
        markStale(key);
      }
    } catch {
      markStale(key);
    } finally {
      pendingRef.current.delete(key);
      inFlightRef.current -= 1;
    }
  }, [markStale]);

  // Scheduler: refresh online tiles whose frame is older than the TTL, capped so a
  // lab of PCs never hammers the server in lockstep.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const candidates = [...devicesRef.current.values()]
        .filter((d) => {
          if (d.status !== 'online' || !d.agentId) return false;
          const key = String(d.agentId);
          if (pendingRef.current.has(key)) return false;
          return t - (lastShotAtRef.current.get(key) || 0) >= THUMB_TTL_MS;
        })
        .sort((a, b) =>
          (lastShotAtRef.current.get(String(a.agentId)) || 0) -
          (lastShotAtRef.current.get(String(b.agentId)) || 0));
      for (const d of candidates) {
        if (inFlightRef.current >= MAX_CONCURRENT_SHOTS) break;
        fetchShot(d);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [fetchShot]);

  // When the detail modal opens, fetch its preview immediately (don't wait for TTL).
  useEffect(() => {
    if (!selectedId) return;
    const dev = devicesRef.current.get(selectedId);
    if (dev?.status === 'online' && dev.agentId && !pendingRef.current.has(selectedId)) {
      lastShotAtRef.current.delete(selectedId);
      fetchShot(dev);
    }
  }, [selectedId, fetchShot]);

  // ---- Derived data ----
  const deviceList = useMemo(() => {
    const items = [...devices.values()];
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
      return (a.hostname || a.ip || '').localeCompare(b.hostname || b.ip || '');
    });
    return items;
  }, [devices]);

  const filteredDevices = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return deviceList;
    return deviceList.filter((d) =>
      [d.hostname, d.ip, d.user, d.mac].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  }, [deviceList, searchTerm]);

  const total = devices.size;
  const onlineCount = deviceList.filter((d) => d.status === 'online').length;
  const offlineCount = total - onlineCount;
  const selectedDevice = selectedId ? devices.get(selectedId) : null;

  const shotFor = (d) => (d?.agentId ? screenshots.get(String(d.agentId)) : null);

  // ---- Commands (reuse the shared control backend) ----
  const sendCommand = useCallback(async (device, action, params = {}) => {
    if (!device?.agentId || device.status !== 'online') {
      showToast('PC is offline — command skipped');
      return;
    }
    try {
      await agentsApi.sendCommand(device.agentId, action, params, { ip: device.ip, mac: device.mac });
      showToast(`${action} sent to ${device.hostname || device.ip || 'PC'}`);
    } catch (e) {
      showToast(`Failed: ${e?.response?.data?.error || e?.message || action}`);
    }
  }, [showToast]);

  const handlePower = (action, device) => setConfirmPower({ action, device });
  const confirmPowerAction = async () => {
    if (!confirmPower) return;
    const { action, device } = confirmPower;
    const grace = POWER_GRACE_DEFAULT;
    const verb = action === 'restart' ? 'restart' : 'shut down';
    const message = `Your instructor is about to ${verb} this PC in ${grace} second(s). Please save your work now.`;
    setConfirmPower(null);
    await sendCommand(device, action, { graceSeconds: grace, delay: grace, message });
  };

  const projectOne = (device) => {
    if (projectionActive || !device?.agentId || device.status !== 'online') return;
    startProjection([String(device.agentId)], 1);
    showToast(`Projecting to ${device.hostname || device.ip || 'PC'}`);
  };

  const manualRefresh = () => {
    lastShotAtRef.current.clear();
    pollDiscovery();
  };

  const getStatusColor = (status) =>
    status === 'online' ? 'border-green-500 bg-white' : 'border-gray-300 bg-gray-50';

  // Active-session indicator: real state, not a hardcoded placeholder.
  const sessionLabel = projectionActive
    ? `Projecting — ${projectingCount}/${totalGuests} live`
    : onlineCount > 0
      ? `Active — ${onlineCount} PC${onlineCount === 1 ? '' : 's'} online`
      : 'No PCs connected';

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Classroom Dashboard</h1>
          <p className="text-gray-500">
            Live overview of lab PCs — auto-discovered from the agents, with quick access to monitoring and controls
          </p>
        </div>
        <div className="text-right">
          <button
            onClick={manualRefresh}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 font-medium text-sm border border-gray-200"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          {lastUpdated && <p className="text-xs text-gray-400 mt-1">Updated {agoText(lastUpdated, now)}</p>}
        </div>
      </div>

      {/* Session / projection status bar (reflects real state) */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className={`relative flex h-2.5 w-2.5 ${onlineCount > 0 ? '' : 'opacity-40'}`}>
              {onlineCount > 0 && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              )}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${onlineCount > 0 ? 'bg-green-500' : 'bg-gray-400'}`} />
            </span>
            <span className="text-sm font-medium text-gray-900">{sessionLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            {projectionActive ? (
              <button
                onClick={() => stopProjection({ silent: false })}
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
              >
                <Cast className="w-4 h-4" /> Stop projection
              </button>
            ) : (
              <button
                onClick={() => navigate('/instructor/monitoring')}
                className="inline-flex items-center gap-2 px-3 py-1.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                <Monitor className="w-4 h-4" /> Open monitoring
              </button>
            )}
          </div>
        </div>
      </div>

      {!!error && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}

      {/* Stats Cards (all counts derived from agent discovery) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Total PCs</span>
            <Server className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{total}</div>
          <div className="text-xs text-gray-400 mt-1">Detected agents</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Online</span>
            <Wifi className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{onlineCount}</div>
          <div className="text-xs text-green-600 mt-1">Connected now</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Offline</span>
            <WifiOff className="w-5 h-5 text-gray-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{offlineCount}</div>
          <div className="text-xs text-gray-400 mt-1">Agent disconnected</div>
        </div>

        {/* Idle is honestly deferred: agents don't report input/activity yet. */}
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-5 shadow-sm opacity-70">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-400">Idle</span>
            <Clock className="w-5 h-5 text-gray-300" />
          </div>
          <div className="text-3xl font-bold text-gray-300">—</div>
          <div className="text-xs text-gray-400 mt-1">Activity tracking — coming soon</div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search by hostname or IP..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Student PC Grid */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Student PC Grid</h2>

        {filteredDevices.length === 0 ? (
          <div className="py-16 text-center">
            <Monitor className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">
              {searchTerm ? 'No PCs match your search.' : 'Waiting for lab PCs to connect…'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {searchTerm ? 'Try a different hostname or IP.' : 'Agents appear automatically as they come online.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredDevices.map((student) => {
              const isOnline = student.status === 'online';
              const shot = shotFor(student);
              const proj = guestStateFor(student.agentId);
              const isProjecting = !!proj && (proj.state === 'projecting' || proj.state === 'connecting');
              return (
                <div
                  key={student.agentId}
                  onClick={() => setSelectedId(String(student.agentId))}
                  className={`relative rounded-xl border-2 p-3 cursor-pointer transition-all hover:shadow-md ${getStatusColor(student.status)}`}
                >
                  {/* Preview thumbnail */}
                  <div className="aspect-video rounded-lg overflow-hidden bg-gray-800 flex items-center justify-center mb-2">
                    {isOnline && shot?.dataUrl ? (
                      <img
                        src={shot.dataUrl}
                        alt={`${student.hostname} screen`}
                        className={`w-full h-full object-cover ${shot.stale ? 'opacity-50' : 'opacity-100'}`}
                      />
                    ) : (
                      <Monitor className={`w-8 h-8 ${isOnline ? 'text-gray-500 animate-pulse' : 'text-gray-400'}`} />
                    )}
                  </div>

                  {/* Status + projecting badges */}
                  <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                    <span className={`px-2 py-0.5 text-[10px] font-medium rounded-full border flex items-center gap-1 ${
                      isOnline ? 'bg-green-100 text-green-700 border-green-300' : 'bg-gray-100 text-gray-500 border-gray-300'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                      {isOnline ? 'Online' : 'Offline'}
                    </span>
                    {isProjecting && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                        <Cast className="w-3 h-3" /> Projecting
                      </span>
                    )}
                  </div>

                  {/* PC Info */}
                  <div className="min-w-0">
                    <p className={`text-sm font-medium truncate ${isOnline ? 'text-gray-900' : 'text-gray-400'}`}>
                      {student.hostname || student.ip || 'Unknown PC'}
                    </p>
                    <p className="text-xs text-gray-400 truncate">{student.ip || 'No IP'}</p>
                  </div>

                  {/* Action Buttons */}
                  {isOnline && (
                    <div className="flex justify-center gap-1 mt-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="View screen"
                        onClick={() => setSelectedId(String(student.agentId))}
                        className="p-1.5 rounded-lg hover:bg-green-100 text-gray-400 hover:text-green-600"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        title="Lock screen"
                        onClick={() => sendCommand(student, 'lock')}
                        className="p-1.5 rounded-lg hover:bg-amber-100 text-gray-400 hover:text-amber-600"
                      >
                        <Lock className="w-4 h-4" />
                      </button>
                      <button
                        title="Send message"
                        onClick={() => sendCommand(student, 'message', { message: 'Please focus on the activity.' })}
                        className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                      >
                        <MessageSquare className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-50 text-sm">
          {toast}
        </div>
      )}

      {/* PC detail / preview modal (live preview + controls, reusing the shared backend) */}
      {selectedDevice && (
        <div className="modal-overlay" onClick={() => { setSelectedId(null); setShowMessageInput(false); setMessageText(''); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${selectedDevice.status === 'offline' ? 'bg-gray-200' : 'bg-blue-100'}`}>
                  <Monitor className={`w-5 h-5 ${selectedDevice.status === 'offline' ? 'text-gray-400' : 'text-blue-600'}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-gray-900 truncate">
                    {selectedDevice.hostname || selectedDevice.ip || 'PC'}
                  </h3>
                  <p className="text-sm text-gray-500 truncate">
                    {selectedDevice.user ? `${selectedDevice.user} · ` : ''}{selectedDevice.ip || 'No IP'}
                    {selectedDevice.os ? ` · ${selectedDevice.os}` : ''}
                  </p>
                </div>
              </div>
              <button
                onClick={() => { setSelectedId(null); setShowMessageInput(false); setMessageText(''); }}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4">
              {/* Live preview */}
              <div className={`rounded-xl border-2 overflow-hidden aspect-video flex items-center justify-center ${selectedDevice.status === 'offline' ? 'border-gray-300 bg-gray-100' : 'border-gray-200 bg-gray-900'}`}>
                {selectedDevice.status === 'offline' ? (
                  <div className="text-center">
                    <Monitor className="w-16 h-16 text-gray-400 mx-auto mb-1" />
                    <span className="text-lg text-gray-400">Offline</span>
                  </div>
                ) : shotFor(selectedDevice)?.dataUrl ? (
                  <img
                    src={shotFor(selectedDevice).dataUrl}
                    alt={`${selectedDevice.hostname} screen`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center">
                    <Monitor className="w-12 h-12 text-gray-500 mx-auto mb-2 animate-pulse" />
                    <span className="text-sm text-gray-400">Waiting for preview…</span>
                  </div>
                )}
              </div>

              {selectedDevice.status !== 'offline' && (
                <>
                  <div className="flex flex-wrap items-center gap-2 mt-4">
                    <button
                      onClick={() => projectOne(selectedDevice)}
                      disabled={projectionActive}
                      title={projectionActive ? 'Already projecting — stop it first' : 'Project to this PC'}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MonitorUp className="w-4 h-4" /> Project
                    </button>
                    <button
                      onClick={() => sendCommand(selectedDevice, 'lock')}
                      className="flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 font-medium text-sm"
                    >
                      <Lock className="w-4 h-4" /> Lock
                    </button>
                    <button
                      onClick={() => handlePower('restart', selectedDevice)}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 font-medium text-sm"
                    >
                      <RotateCcw className="w-4 h-4" /> Restart
                    </button>
                    <button
                      onClick={() => handlePower('shutdown', selectedDevice)}
                      className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium text-sm"
                    >
                      <Power className="w-4 h-4" /> Shut down
                    </button>
                    <button
                      onClick={() => setShowMessageInput((v) => !v)}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 font-medium text-sm"
                    >
                      <MessageSquare className="w-4 h-4" /> Message
                    </button>
                  </div>

                  {showMessageInput && (
                    <div className="mt-3 flex gap-2">
                      <input
                        type="text"
                        value={messageText}
                        onChange={(e) => setMessageText(e.target.value)}
                        placeholder="Type a message…"
                        className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && messageText.trim()) {
                            sendCommand(selectedDevice, 'message', { message: messageText.trim() });
                            setMessageText('');
                            setShowMessageInput(false);
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          if (messageText.trim()) {
                            sendCommand(selectedDevice, 'message', { message: messageText.trim() });
                            setMessageText('');
                            setShowMessageInput(false);
                          }
                        }}
                        className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-4">
                    <p className="text-sm text-gray-500">
                      {(() => {
                        const shot = shotFor(selectedDevice);
                        if (!shot) return 'Fetching preview…';
                        return `${shot.stale ? 'Stale — last good frame' : 'Live'} • updated ${agoText(shot.timestamp, now)}`;
                      })()}
                    </p>
                    <button
                      onClick={() => navigate('/instructor/monitoring')}
                      className="flex items-center gap-2 px-4 py-2 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium text-sm"
                    >
                      <Eye className="w-4 h-4" /> Full monitoring
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Power confirmation */}
      {confirmPower && (
        <div className="modal-overlay" onClick={() => setConfirmPower(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {confirmPower.action === 'restart' ? 'Restart' : 'Shut down'} this PC?
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    A {POWER_GRACE_DEFAULT}s on-screen warning will show on{' '}
                    <span className="font-medium">{confirmPower.device.hostname || confirmPower.device.ip || 'this PC'}</span>{' '}
                    so the student can save their work.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button onClick={() => setConfirmPower(null)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium">
                  Cancel
                </button>
                <button
                  onClick={confirmPowerAction}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium"
                >
                  {confirmPower.action === 'restart' ? <RotateCcw className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                  {confirmPower.action === 'restart' ? 'Restart' : 'Shut down'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ClassroomDashboard;
