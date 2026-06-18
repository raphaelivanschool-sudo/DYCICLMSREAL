import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Server, Wifi, WifiOff, Clock, Search, Monitor, Grid, Maximize2,
  X, RefreshCw, AlertTriangle, Pencil,
} from 'lucide-react';
import { agentsApi } from '../../services/api';
import socketService from '../../services/socketService';

// Agent-centric monitoring. Tiles and counts are derived entirely from the live
// agent-discovery pipeline (the same source Developer Mode uses) — never from a
// student-login/session roster. There is NO manual scan step: the grid polls the
// connected agents and reacts to socket connect/disconnect events in near-real-time.
const DISCOVERY_POLL_MS = 5000;   // re-pull connected agents (new appear / gone flip offline)
const SCREENSHOT_TTL_MS = 3000;   // refresh each visible online tile ~every 3s
const SCHEDULER_TICK_MS = 1000;   // scheduler granularity (also drives "updated Xs ago")
const MAX_CONCURRENT_SHOTS = 4;   // cap simultaneous screenshot fetches so N PCs don't hammer in lockstep
const STALE_AFTER_MS = 9000;      // a frame older than this (or a failed fetch) is flagged stale

const LABELS_KEY = 'monitorFriendlyLabels'; // lab seat labels, keyed by mac||agentId

function loadLabels() {
  try {
    return JSON.parse(localStorage.getItem(LABELS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function agoText(ts, now) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

function StudentScreenMonitoring() {
  const [searchTerm, setSearchTerm] = useState('');
  const [devices, setDevices] = useState(() => new Map()); // agentId -> device record
  const [screenshots, setScreenshots] = useState(() => new Map()); // agentId -> { dataUrl, timestamp, stale }
  const [labels, setLabels] = useState(loadLabels);
  const [selectedId, setSelectedId] = useState(null); // zoomed tile (agentId)
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Refs the screenshot scheduler reads without re-subscribing every render.
  const devicesRef = useRef(devices);
  const selectedIdRef = useRef(selectedId);
  const visibleIdsRef = useRef(new Set());      // tiles currently on screen (IntersectionObserver)
  const renderedIdsRef = useRef(new Set());     // tiles currently mounted (after search filter)
  const pendingRef = useRef(new Set());         // screenshot fetches in flight, by key
  const lastShotAtRef = useRef(new Map());      // last dispatch time, by key (per-tile throttle)
  const inFlightRef = useRef(0);
  const observerRef = useRef(null);

  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // ---- Discovery: pull the connected agents; flip missing ones to offline. ----
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
            ipAddresses: Array.isArray(d.ipAddresses) ? d.ipAddresses : existing.ipAddresses || [],
            status: 'online',
            lastSeen: d.lastSeen || new Date().toISOString(),
            firstSeen: existing.firstSeen || Date.now(),
            offlineSince: undefined,
          });
        }
        // Known agents absent from this poll → offline (keep last good frame + stale flag).
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

  // Mount: connect socket, do an immediate discovery, then poll + react to agent events.
  useEffect(() => {
    if (!socketService.connected()) socketService.connect();
    pollDiscovery();
    const poll = setInterval(pollDiscovery, DISCOVERY_POLL_MS);

    // Near-real-time: an agent connecting/disconnecting refreshes discovery at once.
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

    // Secondary capture: pick up any screenshots delivered over the socket fallback.
    const unsubShot = socketService.on('agent_command_result', (data) => {
      if (!data || data.action !== 'screenshot' || !data.success || !data.result?.screenshot) return;
      const id = data.computerId != null ? String(data.computerId) : null;
      if (!id) return;
      const fmt = (data.result.format || 'png').toLowerCase();
      const mime = fmt === 'jpeg' || fmt === 'jpg' ? 'image/jpeg' : 'image/png';
      setScreenshots((prev) => {
        const n = new Map(prev);
        n.set(id, { dataUrl: `data:${mime};base64,${data.result.screenshot}`, timestamp: Date.now(), stale: false });
        return n;
      });
      pendingRef.current.delete(id);
    });

    return () => {
      clearInterval(poll);
      unsubOnline?.();
      unsubOffline?.();
      unsubShot?.();
    };
  }, [pollDiscovery]);

  // ---- Live screenshots: fetch the JPEG from the guest Python agent (HTTP 5555). ----
  const markStale = useCallback((key) => {
    setScreenshots((prev) => {
      const shot = prev.get(key);
      if (!shot) return prev; // no frame yet → leave the "waiting" placeholder
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
      // Route by agentId (resolves to the agent's live LAN IP server-side); ip/mac are hints only.
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
      markStale(key); // keep last good frame; tile degrades to a stale indicator, grid stays alive
    } finally {
      pendingRef.current.delete(key);
      inFlightRef.current -= 1;
    }
  }, [markStale]);

  // Scheduler: every tick, refresh only visible online tiles whose frame is older than the TTL,
  // capped at MAX_CONCURRENT_SHOTS. Staggers naturally so a lab of PCs never fires in lockstep.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const visible = visibleIdsRef.current;
      const focused = selectedIdRef.current;
      const candidates = [...devicesRef.current.values()]
        .filter((d) => {
          if (d.status !== 'online' || !d.agentId) return false;
          const key = String(d.agentId);
          // Only fetch tiles that are both mounted (not filtered out) and on screen — or the zoomed one.
          const shown = (renderedIdsRef.current.has(key) && visible.has(key)) || key === focused;
          if (!shown) return false;
          if (pendingRef.current.has(key)) return false;
          return t - (lastShotAtRef.current.get(key) || 0) >= SCREENSHOT_TTL_MS;
        })
        .sort((a, b) =>
          (lastShotAtRef.current.get(String(a.agentId)) || 0) -
          (lastShotAtRef.current.get(String(b.agentId)) || 0)); // oldest first

      for (const d of candidates) {
        if (inFlightRef.current >= MAX_CONCURRENT_SHOTS) break;
        fetchShot(d);
      }
    }, SCHEDULER_TICK_MS);
    return () => clearInterval(id);
  }, [fetchShot]);

  // ---- Visibility tracking so off-screen tiles aren't fetched (scales to a full lab). ----
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = e.target.getAttribute('data-agent-id');
          if (!key) continue;
          if (e.isIntersecting) visibleIdsRef.current.add(key);
          else visibleIdsRef.current.delete(key);
        }
      },
      { root: null, rootMargin: '150px', threshold: 0.01 },
    );
    return () => observerRef.current?.disconnect();
  }, []);

  const tileRef = useCallback((node) => {
    if (node && observerRef.current) observerRef.current.observe(node);
  }, []);

  // ---- Derived data ----
  const labelKey = useCallback((d) => (d?.mac ? `mac:${String(d.mac).toLowerCase()}` : `id:${d?.agentId}`), []);
  const displayName = useCallback(
    (d) => labels[labelKey(d)] || d.hostname || d.user || d.ip || 'Unknown PC',
    [labels, labelKey],
  );

  const deviceList = useMemo(() => {
    const items = [...devices.values()];
    // Online first, then by display name for a stable, readable grid.
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
      [displayName(d), d.hostname, d.ip, d.user, d.mac]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)));
  }, [deviceList, searchTerm, displayName]);

  // Keep the rendered-tile set in sync so the scheduler never fetches filtered-out tiles.
  useEffect(() => {
    renderedIdsRef.current = new Set(filteredDevices.map((d) => String(d.agentId)));
  }, [filteredDevices]);

  const total = devices.size;
  const onlineCount = deviceList.filter((d) => d.status === 'online').length;
  const offlineCount = total - onlineCount;

  const selectedDevice = selectedId ? devices.get(selectedId) : null;

  const renameDevice = (d) => {
    const current = labels[labelKey(d)] || '';
    const value = window.prompt(`Friendly label for ${d.hostname || d.ip || 'this PC'} (e.g. PC-01):`, current);
    if (value == null) return; // cancelled
    setLabels((prev) => {
      const next = { ...prev };
      const trimmed = value.trim();
      if (trimmed) next[labelKey(d)] = trimmed;
      else delete next[labelKey(d)];
      localStorage.setItem(LABELS_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Manual refresh (secondary control): re-poll agents and force-refresh visible frames now.
  const manualRefresh = () => {
    lastShotAtRef.current.clear();
    pollDiscovery();
  };

  // Force-refresh a single tile's frame (zoom modal "Refresh").
  const refreshOne = (d) => {
    if (!d?.agentId) return;
    lastShotAtRef.current.delete(String(d.agentId));
    fetchShot(d);
  };

  const openZoom = () => {
    if (selectedId) return;
    const firstOnline = filteredDevices.find((d) => d.status === 'online') || filteredDevices[0];
    if (firstOnline) setSelectedId(String(firstOnline.agentId));
  };

  const shotFor = (d) => (d?.agentId ? screenshots.get(String(d.agentId)) : null);
  const isStale = (shot) => !!shot && (shot.stale || now - shot.timestamp > STALE_AFTER_MS);

  // ---- Render helpers ----
  const StatusBadge = ({ status, stale }) => {
    if (status === 'offline') {
      return (
        <span className="px-2 py-1 text-xs font-medium text-white rounded-full flex items-center gap-1 bg-gray-400">
          <span className="w-1.5 h-1.5 bg-white rounded-full" /> Offline
        </span>
      );
    }
    if (stale) {
      return (
        <span className="px-2 py-1 text-xs font-medium text-white rounded-full flex items-center gap-1 bg-amber-500">
          <AlertTriangle className="w-3 h-3" /> Stale
        </span>
      );
    }
    return (
      <span className="px-2 py-1 text-xs font-medium text-white rounded-full flex items-center gap-1 bg-green-500">
        <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> Online
      </span>
    );
  };

  const ScreenPreview = ({ device, large = false }) => {
    const shot = shotFor(device);
    if (device.status === 'offline') {
      return (
        <div className="text-center">
          <Monitor className={`${large ? 'w-16 h-16' : 'w-8 h-8'} text-gray-400 mx-auto mb-1`} />
          <span className={`${large ? 'text-lg' : 'text-xs'} text-gray-400`}>Offline</span>
        </div>
      );
    }
    if (shot?.dataUrl) {
      return (
        <img
          src={shot.dataUrl}
          alt={`${displayName(device)} screen`}
          className={`w-full h-full object-cover transition-opacity ${isStale(shot) ? 'opacity-50' : 'opacity-100'}`}
        />
      );
    }
    return (
      <div className="text-center">
        <div className={`${large ? 'w-32 h-20' : 'w-16 h-10'} bg-gray-700 rounded mx-auto mb-2 flex items-center justify-center`}>
          <Monitor className={`${large ? 'w-12 h-12' : 'w-6 h-6'} text-gray-500 animate-pulse`} />
        </div>
        <span className={`${large ? 'text-lg' : 'text-xs'} text-gray-400`}>Waiting for preview…</span>
      </div>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Student Screen Monitoring</h1>
          <p className="text-gray-500">
            Live previews of every connected lab PC — auto-discovered from the agents, refreshed in real time
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
          {lastUpdated && (
            <p className="text-xs text-gray-400 mt-1">Updated {agoText(lastUpdated, now)}</p>
          )}
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

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by hostname or IP..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm bg-green-50 text-green-700">
              <Grid className="w-4 h-4" />
              View All
            </button>
            <button
              onClick={openZoom}
              disabled={filteredDevices.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 font-medium text-sm disabled:opacity-50"
            >
              <Maximize2 className="w-4 h-4" />
              Zoom In
            </button>
          </div>
        </div>
      </div>

      {/* Screen Monitoring Grid */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Screen Monitoring</h2>
          <div className="flex items-center gap-2">
            <Monitor className="w-4 h-4 text-gray-400" />
            <span className="text-sm text-gray-500">Thumbnail Mode</span>
          </div>
        </div>

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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredDevices.map((device) => {
              const shot = shotFor(device);
              const stale = isStale(shot);
              return (
                <div
                  key={device.agentId}
                  ref={tileRef}
                  data-agent-id={String(device.agentId)}
                  onClick={() => setSelectedId(String(device.agentId))}
                  className="group cursor-pointer"
                >
                  <div className={`relative rounded-xl border-2 overflow-hidden transition-all hover:shadow-lg ${device.status === 'offline' ? 'border-gray-300 bg-gray-100' : 'border-gray-200 bg-gray-900'}`}>
                    <div className={`aspect-video flex items-center justify-center ${device.status === 'offline' ? 'bg-gray-100' : 'bg-gray-800'}`}>
                      <ScreenPreview device={device} />
                    </div>

                    <div className="absolute top-2 right-2">
                      <StatusBadge status={device.status} stale={stale} />
                    </div>

                    {device.status !== 'offline' && (
                      <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                        <Maximize2 className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    )}

                    {device.status !== 'offline' && shot && !stale && (
                      <div className="absolute bottom-2 left-2 text-[10px] font-medium text-white/90 bg-black/40 rounded px-1.5 py-0.5">
                        {agoText(shot.timestamp, now)}
                      </div>
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${device.status === 'offline' ? 'bg-gray-200' : 'bg-blue-100'}`}>
                      <Monitor className={`w-4 h-4 ${device.status === 'offline' ? 'text-gray-400' : 'text-blue-600'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${device.status === 'offline' ? 'text-gray-400' : 'text-gray-900'}`}>
                        {displayName(device)}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{device.ip || 'No IP'}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Zoomed single-screen view */}
      {selectedDevice && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${selectedDevice.status === 'offline' ? 'bg-gray-200' : 'bg-blue-100'}`}>
                  <Monitor className={`w-5 h-5 ${selectedDevice.status === 'offline' ? 'text-gray-400' : 'text-blue-600'}`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-gray-900 truncate">{displayName(selectedDevice)}</h3>
                    <button
                      title="Rename (lab seat label)"
                      onClick={() => renameDevice(selectedDevice)}
                      className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-sm text-gray-500 truncate">
                    {selectedDevice.hostname} • {selectedDevice.ip || 'No IP'}
                    {selectedDevice.mac ? ` • ${selectedDevice.mac}` : ''}
                  </p>
                </div>
              </div>
              <button onClick={() => setSelectedId(null)} className="p-2 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4">
              <div className={`rounded-xl border-2 overflow-hidden aspect-video flex items-center justify-center ${selectedDevice.status === 'offline' ? 'border-gray-300 bg-gray-100' : 'border-gray-200 bg-gray-900'}`}>
                <ScreenPreview device={selectedDevice} large />
              </div>

              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-gray-500">
                  {(() => {
                    const shot = shotFor(selectedDevice);
                    if (selectedDevice.status === 'offline') return 'PC is offline';
                    if (!shot) return 'Fetching preview…';
                    return `${isStale(shot) ? 'Stale — last good frame' : 'Live'} • updated ${agoText(shot.timestamp, now)}`;
                  })()}
                </p>
                <button
                  onClick={() => refreshOne(selectedDevice)}
                  disabled={selectedDevice.status === 'offline'}
                  className="flex items-center gap-2 px-6 py-2 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium disabled:opacity-50"
                >
                  <RefreshCw className="w-4 h-4" />
                  Refresh
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default StudentScreenMonitoring;
