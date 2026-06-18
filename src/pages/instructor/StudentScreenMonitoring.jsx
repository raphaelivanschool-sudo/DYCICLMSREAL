import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Server, Wifi, WifiOff, Clock, Search, Monitor, Grid, Maximize2,
  X, RefreshCw, AlertTriangle, Pencil,
  Lock, Power, RotateCcw, CheckSquare, Square, Ban, Check, Loader2, ShieldAlert,
  MonitorPlay, StopCircle, Cast, Settings, Stethoscope, FileText,
} from 'lucide-react';
import { agentsApi } from '../../services/api';
import socketService from '../../services/socketService';
import useScreenProjection, {
  clampNum,
  PROJECTION_DEFAULTS,
  PROJECTION_FPS_RANGE,
  PROJECTION_QUALITY_RANGE,
  PROJECTION_MAXWIDTH_RANGE,
} from '../../hooks/useScreenProjection';

// Agent-centric monitoring. Tiles and counts are derived entirely from the live
// agent-discovery pipeline (the same source Developer Mode uses) — never from a
// student-login/session roster. There is NO manual scan step: the grid polls the
// connected agents and reacts to socket connect/disconnect events in near-real-time.
const DISCOVERY_POLL_MS = 5000;   // re-pull connected agents (new appear / gone flip offline)
const SCREENSHOT_TTL_MS = 3000;   // refresh each visible online tile ~every 3s
const SCHEDULER_TICK_MS = 1000;   // scheduler granularity (also drives "updated Xs ago")
const MAX_CONCURRENT_SHOTS = 4;   // cap simultaneous screenshot fetches so N PCs don't hammer in lockstep
const STALE_AFTER_MS = 9000;      // a frame older than this (or a failed fetch) is flagged stale

const POWER_GRACE_DEFAULT = 30;   // default countdown (s) before a shutdown/restart fires — never instant
const RESULT_TTL_MS = 12000;      // how long a per-PC action result chip stays visible on its tile

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

  // ---- Bulk control + power-action state ----
  const [selectedIds, setSelectedIds] = useState(() => new Set());     // checked tiles (agentId)
  const [results, setResults] = useState(() => new Map());             // agentId -> { action, state, detail, ts }
  const [confirm, setConfirm] = useState(null);                        // pending Shutdown/Restart confirmation
  const [pendingPower, setPendingPower] = useState(null);              // live abort window { action, targets, graceSeconds, deadline }
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // ---- Locked Demo Mode projection (shared capture/broadcast engine) ----
  const {
    projectionActive,
    projectionStatus,
    startProjection,
    stopProjection,
    selfPreviewUrl,
    hostEmitStats,
    projFps, setProjFps,
    projQuality, setProjQuality,
    projMaxWidth, setProjMaxWidth,
    guestStateFor,
    projectingCount,
    failedCount,
    totalGuests,
  } = useScreenProjection();
  const [showProjSettings, setShowProjSettings] = useState(false);

  // Projection troubleshooting (Diagnose guest / Overlay log) — scoped to the zoomed PC.
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [overlayLog, setOverlayLog] = useState(null);
  const [overlayLogFetching, setOverlayLogFetching] = useState(false);

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

    // Power/lock command results: upgrade a tile's "sent" chip to "acknowledged"
    // (agent ran it) or "failed" (e.g. privilege error) using the agent's reply.
    const unsubCmd = socketService.on('agent_command_result', (data) => {
      if (!data || data.action === 'screenshot') return; // screenshots handled above
      const id = data.computerId != null ? String(data.computerId) : null;
      if (!id) return;
      setResults((prev) => {
        const cur = prev.get(id);
        if (!cur || cur.action !== data.action) return prev; // only reflect the action we issued
        const n = new Map(prev);
        n.set(id, {
          ...cur,
          state: data.success ? 'acknowledged' : 'failed',
          detail: data.error || cur.detail,
          ts: Date.now(),
        });
        return n;
      });
    });

    return () => {
      clearInterval(poll);
      unsubOnline?.();
      unsubOffline?.();
      unsubShot?.();
      unsubCmd?.();
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

  // ---- Selection (multi-select for bulk actions) ----
  const onlineFiltered = useMemo(
    () => filteredDevices.filter((d) => d.status === 'online'),
    [filteredDevices],
  );
  const selectedDevices = useMemo(
    () => [...devices.values()].filter((d) => selectedIds.has(String(d.agentId))),
    [devices, selectedIds],
  );
  const selectedOnline = selectedDevices.filter((d) => d.status === 'online');
  const allOnlineSelected =
    onlineFiltered.length > 0 && onlineFiltered.every((d) => selectedIds.has(String(d.agentId)));

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const online = onlineFiltered.map((d) => String(d.agentId));
    setSelectedIds((prev) => {
      const everyOn = online.length > 0 && online.every((k) => prev.has(k));
      const next = new Set(prev);
      if (everyOn) online.forEach((k) => next.delete(k));
      else online.forEach((k) => next.add(k));
      return next;
    });
  }, [onlineFiltered]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ---- Toast + per-PC result tracking ----
  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const setResult = useCallback((id, patch) => {
    setResults((prev) => {
      const next = new Map(prev);
      const key = String(id);
      next.set(key, { ...(next.get(key) || {}), ...patch, ts: Date.now() });
      return next;
    });
  }, []);

  // ---- Projection targeting (reuses the grid's selection model) ----
  // All three feed the SAME shared engine; targets are guest agent ids / 'all'.
  const projectAll = useCallback(() => {
    if (projectionActive) return;
    if (onlineCount === 0) { showToast('No online PCs to project to.'); return; }
    startProjection('all', onlineCount);
  }, [projectionActive, onlineCount, startProjection, showToast]);

  const projectSelected = useCallback(() => {
    if (projectionActive) return;
    const ids = selectedOnline.map((d) => String(d.agentId));
    if (ids.length === 0) { showToast('Select at least one online PC to project to.'); return; }
    startProjection(ids, ids.length);
  }, [projectionActive, selectedOnline, startProjection, showToast]);

  const projectOne = useCallback((device) => {
    if (projectionActive || !device?.agentId || device.status !== 'online') return;
    startProjection([String(device.agentId)], 1);
  }, [projectionActive, startProjection]);

  // ---- Projection troubleshooting: Diagnose guest / Overlay log (per zoomed PC) ----
  const runDiagnose = useCallback(async (device) => {
    if (!device?.agentId) return;
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const res = await agentsApi.diagnoseAgent(device.agentId, { ip: device.ip, mac: device.mac });
      setDiagnosis(res?.data || null);
    } catch (e) {
      setDiagnosis({ success: false, errors: [e?.response?.data?.error || e?.message || 'Diagnostics request failed'] });
    } finally {
      setDiagnosing(false);
    }
  }, []);

  const fetchOverlayLog = useCallback(async (device) => {
    if (!device?.agentId) return;
    setOverlayLogFetching(true);
    setOverlayLog(null);
    try {
      const res = await agentsApi.getOverlayLog(device.agentId, { ip: device.ip, mac: device.mac }, 200);
      setOverlayLog(res?.data || null);
    } catch (e) {
      setOverlayLog({ success: false, error: e?.response?.data?.error || e?.message || 'Overlay-log request failed' });
    } finally {
      setOverlayLogFetching(false);
    }
  }, []);

  // Clear stale diagnostics when the zoomed PC changes / closes.
  useEffect(() => { setDiagnosis(null); setOverlayLog(null); }, [selectedId]);

  // Dispatch one command to one agent over the SAME Socket.IO path Lock uses
  // (POST /api/agents/command → execute_command in the agent's room). Offline
  // agents are flagged "skipped", never silently failed.
  const dispatchCommand = useCallback(async (device, action, params = {}) => {
    const id = String(device.agentId);
    if (device.status !== 'online') {
      setResult(id, { action, state: 'skipped-offline', detail: 'Agent offline — skipped' });
      return { id, ok: false, skipped: true };
    }
    setResult(id, { action, state: 'sending' });
    try {
      await agentsApi.sendCommand(device.agentId, action, params, { ip: device.ip, mac: device.mac });
      setResult(id, { action, state: 'sent' }); // → 'acknowledged'/'failed' arrives via socket
      return { id, ok: true };
    } catch (e) {
      const detail = e?.response?.data?.error || e?.message || 'Failed to send command';
      setResult(id, { action, state: 'failed', detail });
      return { id, ok: false, detail };
    }
  }, [setResult]);

  // Lock is immediate (no confirmation) — reuses the existing working lock command.
  const runLock = useCallback(async (targets) => {
    const online = targets.filter((d) => d.status === 'online');
    const offline = targets.filter((d) => d.status !== 'online');
    offline.forEach((d) =>
      setResult(d.agentId, { action: 'lock', state: 'skipped-offline', detail: 'Agent offline — skipped' }));
    if (online.length === 0) {
      showToast('No online PCs to lock.');
      return;
    }
    await Promise.all(online.map((d) => dispatchCommand(d, 'lock')));
    showToast(
      `Lock sent to ${online.length} PC${online.length > 1 ? 's' : ''}` +
        (offline.length ? ` · ${offline.length} offline skipped` : ''),
    );
  }, [dispatchCommand, setResult, showToast]);

  // Shutdown/Restart are destructive → open the confirmation dialog first.
  const requestPower = useCallback((action, targets) => {
    const online = targets.filter((d) => d.status === 'online');
    const offline = targets.filter((d) => d.status !== 'online');
    if (online.length === 0) {
      showToast(`No online PCs to ${action === 'restart' ? 'restart' : 'shut down'}.`);
      return;
    }
    setConfirm({ action, online, offline, graceSeconds: POWER_GRACE_DEFAULT, force: false });
  }, [showToast]);

  const confirmPower = useCallback(async () => {
    if (!confirm) return;
    const { action, online, force } = confirm;
    const grace = Math.max(0, Math.min(3600, parseInt(confirm.graceSeconds, 10) || 0));
    const verb = action === 'restart' ? 'restart' : 'shut down';
    const message = `Your instructor is about to ${verb} this PC in ${grace} second(s). Please save your work now.`;
    setConfirm(null);
    // Send both graceSeconds (new agent) and delay (legacy agent) so either build honors the countdown.
    await Promise.all(
      online.map((d) => dispatchCommand(d, action, { graceSeconds: grace, delay: grace, force, message })),
    );
    // Open the live abort window so the instructor can cancel within the countdown.
    if (grace > 0) {
      setPendingPower({ action, targets: online, graceSeconds: grace, deadline: Date.now() + grace * 1000 });
    }
    showToast(
      `${action === 'restart' ? 'Restart' : 'Shutdown'} scheduled on ${online.length} PC${online.length > 1 ? 's' : ''} (${grace}s warning)`,
    );
  }, [confirm, dispatchCommand, showToast]);

  const abortPending = useCallback(async () => {
    if (!pendingPower) return;
    const targets = pendingPower.targets;
    setPendingPower(null);
    await Promise.all(targets.map((d) => dispatchCommand(d, 'abort_shutdown')));
    showToast(`Abort sent to ${targets.length} PC${targets.length > 1 ? 's' : ''}`);
  }, [pendingPower, dispatchCommand, showToast]);

  // Close the abort window once the countdown elapses (the action has fired).
  useEffect(() => {
    if (pendingPower && now >= pendingPower.deadline) setPendingPower(null);
  }, [pendingPower, now]);

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

  // Most recent action result for a tile, while still fresh enough to show.
  const resultFor = (d) => {
    const r = d?.agentId ? results.get(String(d.agentId)) : null;
    if (!r || now - r.ts > RESULT_TTL_MS) return null;
    return r;
  };

  const ACTION_LABEL = { lock: 'Lock', shutdown: 'Shutdown', restart: 'Restart', abort_shutdown: 'Abort' };
  const resultView = (res) => {
    const verb = ACTION_LABEL[res.action] || res.action;
    switch (res.state) {
      case 'sending':         return { Icon: Loader2, spin: true,  cls: 'bg-blue-600',  text: `${verb}…` };
      case 'sent':            return { Icon: Loader2, spin: true,  cls: 'bg-blue-600',  text: `${verb} sent…` };
      case 'acknowledged':    return { Icon: Check,   spin: false, cls: 'bg-green-600', text: `${verb} done` };
      case 'failed':          return { Icon: AlertTriangle, spin: false, cls: 'bg-red-600', text: `${verb} failed` };
      case 'skipped-offline': return { Icon: Ban,     spin: false, cls: 'bg-gray-500',  text: 'Offline — skipped' };
      default:                return { Icon: Check,   spin: false, cls: 'bg-gray-500',  text: verb };
    }
  };

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
      {/* Active projection banner — prominent state + Stop-for-everyone while broadcasting */}
      {projectionActive && (
        <div className="sticky top-0 z-40 mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-300 bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 shadow-lg">
          <div className="flex items-center gap-3 min-w-0">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-white" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-white flex items-center gap-2">
                <Cast className="w-4 h-4 shrink-0" />
                Projecting your screen to {projectingCount} of {totalGuests} PC{totalGuests === 1 ? '' : 's'}
                {failedCount > 0 && (
                  <span className="font-medium text-indigo-100"> · {failedCount} unreachable</span>
                )}
              </p>
              <p className="text-xs text-indigo-100 truncate">
                Locked Demo Mode — students see a fullscreen, input-locked overlay until you stop.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => stopProjection({ silent: false })}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-indigo-700 shadow hover:bg-indigo-50 shrink-0"
          >
            <StopCircle className="w-4 h-4" />
            Stop projection
          </button>
        </div>
      )}

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
            <button
              onClick={toggleSelectAll}
              disabled={onlineFiltered.length === 0}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm border disabled:opacity-50 ${
                allOnlineSelected
                  ? 'bg-green-600 text-white border-green-600 hover:bg-green-700'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {allOnlineSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              {allOnlineSelected ? 'Clear all' : 'Select all'}
            </button>
            {selectedIds.size > 0 && (
              <span className="px-3 py-2 rounded-lg text-sm font-semibold bg-green-50 text-green-700 border border-green-200">
                {selectedIds.size} selected
              </span>
            )}
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

        {/* Screen projection (Locked Demo Mode) — reuses the grid's selection model */}
        <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
              <MonitorPlay className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-gray-900">Project my screen</div>
              <div className="text-xs text-gray-400">Locked demo broadcast to the lab PCs</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <button
              onClick={projectAll}
              disabled={projectionActive || onlineCount === 0}
              title={projectionActive ? 'Already projecting — stop it first' : 'Project to every online PC'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MonitorPlay className="w-4 h-4" />
              Project to all ({onlineCount})
            </button>
            <button
              onClick={projectSelected}
              disabled={projectionActive || selectedOnline.length === 0}
              title={selectedOnline.length === 0 ? 'Select online PCs first' : 'Project to the checked PCs'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Cast className="w-4 h-4" />
              Project to selected ({selectedOnline.length})
            </button>
            <button
              onClick={() => setShowProjSettings((v) => !v)}
              title="Capture quality settings"
              className={`inline-flex items-center justify-center w-10 h-10 rounded-lg border ${
                showProjSettings
                  ? 'bg-gray-100 text-gray-700 border-gray-300'
                  : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showProjSettings && (
          <div className="mt-3 flex flex-wrap items-center gap-5 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            <label className="flex items-center gap-2">
              FPS
              <input
                type="number"
                min={PROJECTION_FPS_RANGE.min}
                max={PROJECTION_FPS_RANGE.max}
                value={projFps}
                disabled={projectionActive}
                onChange={(e) => setProjFps(clampNum(e.target.value, PROJECTION_FPS_RANGE, PROJECTION_DEFAULTS.fps))}
                className="w-20 rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2">
              JPEG quality
              <input
                type="number"
                min={PROJECTION_QUALITY_RANGE.min}
                max={PROJECTION_QUALITY_RANGE.max}
                value={projQuality}
                disabled={projectionActive}
                onChange={(e) => setProjQuality(clampNum(e.target.value, PROJECTION_QUALITY_RANGE, PROJECTION_DEFAULTS.quality))}
                className="w-20 rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2">
              Max width
              <input
                type="number"
                min={PROJECTION_MAXWIDTH_RANGE.min}
                max={PROJECTION_MAXWIDTH_RANGE.max}
                step={160}
                value={projMaxWidth}
                disabled={projectionActive}
                onChange={(e) => setProjMaxWidth(clampNum(e.target.value, PROJECTION_MAXWIDTH_RANGE, PROJECTION_DEFAULTS.maxWidth))}
                className="w-24 rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
              />
            </label>
            <span className="text-xs text-gray-400">Lower values stay smoother on a busy lab LAN.</span>
          </div>
        )}

        {projectionStatus && !projectionActive && (
          <p className="mt-2 text-sm text-indigo-700">{projectionStatus}</p>
        )}
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
              const isOnline = device.status !== 'offline';
              const isSelected = selectedIds.has(String(device.agentId));
              const res = resultFor(device);
              const rv = res ? resultView(res) : null;
              const proj = guestStateFor(device.agentId);
              const isProjecting = !!proj && (proj.state === 'projecting' || proj.state === 'connecting');
              return (
                <div
                  key={device.agentId}
                  ref={tileRef}
                  data-agent-id={String(device.agentId)}
                  onClick={() => setSelectedId(String(device.agentId))}
                  className="group cursor-pointer"
                >
                  <div className={`relative rounded-xl border-2 overflow-hidden transition-all hover:shadow-lg ${
                    isProjecting
                      ? 'border-indigo-500 ring-2 ring-indigo-500 ring-offset-1'
                      : isSelected
                        ? 'border-green-500 ring-2 ring-green-500 ring-offset-1'
                        : (isOnline ? 'border-gray-200' : 'border-gray-300')
                  } ${isOnline ? 'bg-gray-900' : 'bg-gray-100'}`}>
                    <div className={`aspect-video flex items-center justify-center ${isOnline ? 'bg-gray-800' : 'bg-gray-100'}`}>
                      <ScreenPreview device={device} />
                    </div>

                    {/* Selection checkbox (online tiles only — offline are skipped by actions) */}
                    {isOnline && (
                      <button
                        title={isSelected ? 'Deselect' : 'Select'}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(device.agentId); }}
                        className={`absolute top-2 left-2 z-20 w-6 h-6 rounded-md flex items-center justify-center shadow transition-colors ${
                          isSelected ? 'bg-green-600 text-white' : 'bg-white/90 text-gray-500 hover:bg-white'
                        }`}
                      >
                        {isSelected ? <Check className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                    )}

                    <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
                      <StatusBadge status={device.status} stale={stale} />
                      {isProjecting && (
                        <span
                          title={proj?.detail || 'Receiving your projected screen'}
                          className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow"
                        >
                          <Cast className="w-3 h-3" />
                          {proj.state === 'connecting' ? 'Connecting…' : 'Projecting'}
                        </span>
                      )}
                    </div>

                    {isOnline && (
                      <div className="pointer-events-none absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                        <Maximize2 className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    )}

                    {/* Action result strip (takes priority over the "updated Xs ago" badge) */}
                    {rv ? (
                      <div className={`absolute bottom-0 left-0 right-0 z-10 ${rv.cls} text-white text-[10px] font-semibold px-2 py-1 flex items-center gap-1`}>
                        <rv.Icon className={`w-3 h-3 ${rv.spin ? 'animate-spin' : ''}`} />
                        <span className="truncate">{rv.text}</span>
                      </div>
                    ) : (
                      isOnline && shot && !stale && (
                        <div className="absolute bottom-2 left-2 text-[10px] font-medium text-white/90 bg-black/40 rounded px-1.5 py-0.5">
                          {agoText(shot.timestamp, now)}
                        </div>
                      )
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isOnline ? 'bg-blue-100' : 'bg-gray-200'}`}>
                      <Monitor className={`w-4 h-4 ${isOnline ? 'text-blue-600' : 'text-gray-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isOnline ? 'text-gray-900' : 'text-gray-400'}`}>
                        {displayName(device)}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{device.ip || 'No IP'}</p>
                    </div>

                    {/* Per-tile single-PC actions */}
                    {isOnline && (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          title={projectionActive ? 'Already projecting — stop it first' : 'Project to this PC'}
                          onClick={() => projectOne(device)}
                          disabled={projectionActive}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400 disabled:cursor-not-allowed"
                        >
                          <MonitorPlay className="w-4 h-4" />
                        </button>
                        <button
                          title="Lock screen"
                          onClick={() => runLock([device])}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50"
                        >
                          <Lock className="w-4 h-4" />
                        </button>
                        <button
                          title="Restart PC"
                          onClick={() => requestPower('restart', [device])}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                        <button
                          title="Shut down PC"
                          onClick={() => requestPower('shutdown', [device])}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                        >
                          <Power className="w-4 h-4" />
                        </button>
                      </div>
                    )}
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

              {/* Single-PC power controls */}
              {selectedDevice.status !== 'offline' && (
                <div className="flex flex-wrap items-center gap-2 mt-4">
                  <button
                    onClick={() => projectOne(selectedDevice)}
                    disabled={projectionActive}
                    title={projectionActive ? 'Already projecting — stop it first' : 'Project to this PC'}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <MonitorPlay className="w-4 h-4" /> Project to this PC
                  </button>
                  <button
                    onClick={() => runLock([selectedDevice])}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 font-medium text-sm"
                  >
                    <Lock className="w-4 h-4" /> Lock
                  </button>
                  <button
                    onClick={() => requestPower('restart', [selectedDevice])}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 font-medium text-sm"
                  >
                    <RotateCcw className="w-4 h-4" /> Restart
                  </button>
                  <button
                    onClick={() => requestPower('shutdown', [selectedDevice])}
                    className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium text-sm"
                  >
                    <Power className="w-4 h-4" /> Shut down
                  </button>
                </div>
              )}

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

              {/* Projection troubleshooting — Diagnose guest / Overlay log */}
              {selectedDevice.status !== 'offline' && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 mr-1">
                      Projection tools
                    </span>
                    <button
                      onClick={() => runDiagnose(selectedDevice)}
                      disabled={diagnosing}
                      title="Check this guest: Node online, Python reachable, api_key, capture + overlay deps, elevation"
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                    >
                      <Stethoscope className="w-4 h-4" />
                      {diagnosing ? 'Diagnosing…' : 'Diagnose guest'}
                    </button>
                    <button
                      onClick={() => fetchOverlayLog(selectedDevice)}
                      disabled={overlayLogFetching}
                      title="Fetch the guest's locked-overlay log — the real traceback when projection crash-loops"
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                    >
                      <FileText className="w-4 h-4" />
                      {overlayLogFetching ? 'Fetching…' : 'Overlay log'}
                    </button>
                  </div>

                  {diagnosis && (
                    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                      <p className="font-semibold text-gray-900 mb-2">Guest diagnostics</p>
                      <ul className="space-y-1">
                        {[
                          ['Node agent online (Socket.IO)', diagnosis.nodeAgentOnline],
                          ['Python agent reachable (5555)', diagnosis.pythonAgentReachable],
                          ['api_key matches', diagnosis.apiKeyOk],
                          ['Screenshot capture (mss/Pillow)', diagnosis.capture?.ok],
                          ['Overlay script present', diagnosis.overlay?.script_present],
                          ['Agent elevated (input lock)', diagnosis.elevated],
                        ].map(([label, ok]) => (
                          <li key={label} className="flex items-center gap-2">
                            <span>{ok === true ? '✅' : ok === false ? '❌' : '➖'}</span>
                            <span className="text-gray-700">{label}</span>
                          </li>
                        ))}
                      </ul>
                      {Array.isArray(diagnosis.errors) && diagnosis.errors.length > 0 && (
                        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                          {diagnosis.errors.map((e, i) => (
                            <p key={i}>• {e}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {overlayLog && (
                    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                      <p className="font-semibold text-gray-900 mb-2">Overlay log</p>
                      {overlayLog.success === false ? (
                        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{overlayLog.error}</div>
                      ) : (
                        <>
                          <p className="text-xs text-gray-500 mb-2">
                            {overlayLog.log?.exists
                              ? `${overlayLog.log?.size_bytes ?? 0} bytes · modified ${overlayLog.log?.modified || '—'}`
                              : 'No log yet — the overlay has not written under this user’s %TEMP% (it never launched, or agent/overlay run as different users).'}
                            {overlayLog.elevated === false ? '  · agent NOT elevated' : ''}
                          </p>
                          {overlayLog.log?.lines?.length > 0 ? (
                            <pre className="max-h-72 overflow-auto rounded bg-[#1e1e1e] p-3 text-[11px] leading-relaxed text-gray-100 whitespace-pre-wrap break-words">
                              {overlayLog.log.lines.join('\n')}
                            </pre>
                          ) : (
                            overlayLog.log?.exists && <p className="text-xs text-gray-500">Log file is empty.</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating bulk action bar (visible whenever ≥1 PC is selected) */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 max-w-full">
          <div className="flex items-center gap-1 bg-gray-900 text-white rounded-2xl shadow-2xl px-3 py-2">
            <span className="px-3 py-1.5 text-sm font-semibold whitespace-nowrap">
              {selectedIds.size} selected
              {selectedOnline.length !== selectedIds.size && (
                <span className="text-gray-400 font-normal"> · {selectedOnline.length} online</span>
              )}
            </span>
            <div className="w-px h-6 bg-white/20 mx-1" />
            <button
              onClick={projectSelected}
              disabled={projectionActive || selectedOnline.length === 0}
              title={projectionActive ? 'Already projecting — stop it first' : 'Project to the selected PCs'}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            >
              <MonitorPlay className="w-4 h-4 text-indigo-300" /> Project
            </button>
            <button
              onClick={() => runLock(selectedDevices)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-white/10"
            >
              <Lock className="w-4 h-4 text-amber-300" /> Lock
            </button>
            <button
              onClick={() => requestPower('shutdown', selectedDevices)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-white/10"
            >
              <Power className="w-4 h-4 text-red-400" /> Shut down
            </button>
            <button
              onClick={() => requestPower('restart', selectedDevices)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-white/10"
            >
              <RotateCcw className="w-4 h-4 text-blue-300" /> Restart
            </button>
            <div className="w-px h-6 bg-white/20 mx-1" />
            <button
              onClick={clearSelection}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-gray-300 hover:bg-white/10"
            >
              <X className="w-4 h-4" /> Clear
            </button>
          </div>
        </div>
      )}

      {/* Confirmation dialog for destructive power actions (Shutdown / Restart) */}
      {confirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center gap-3 p-4 border-b border-gray-200">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${confirm.action === 'restart' ? 'bg-blue-100' : 'bg-red-100'}`}>
                {confirm.action === 'restart'
                  ? <RotateCcw className="w-5 h-5 text-blue-600" />
                  : <Power className="w-5 h-5 text-red-600" />}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {confirm.action === 'restart' ? 'Restart' : 'Shut down'} {confirm.online.length} PC{confirm.online.length > 1 ? 's' : ''}?
                </h3>
                <p className="text-sm text-gray-500">A countdown warning is shown on each student PC first.</p>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Affected PCs (online apply; offline flagged + skipped) */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Affected PCs</p>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                  {confirm.online.map((d) => (
                    <div key={d.agentId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <span className="font-medium text-gray-800 truncate">{displayName(d)}</span>
                      <span className="text-gray-400 truncate ml-auto">{d.ip || ''}</span>
                    </div>
                  ))}
                  {confirm.offline.map((d) => (
                    <div key={d.agentId} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-50">
                      <Ban className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      <span className="font-medium text-gray-400 truncate line-through">{displayName(d)}</span>
                      <span className="text-gray-400 ml-auto text-xs whitespace-nowrap">offline — skipped</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Configurable grace period */}
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium text-gray-700">
                  Warning countdown
                  <span className="block text-xs font-normal text-gray-400">Students can save work before it fires</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" max="3600"
                    value={confirm.graceSeconds}
                    onChange={(e) => setConfirm((c) => ({ ...c, graceSeconds: e.target.value }))}
                    className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <span className="text-sm text-gray-500">sec</span>
                </div>
              </div>

              {/* Graceful-by-default; force is an explicit opt-in */}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox" checked={confirm.force}
                  onChange={(e) => setConfirm((c) => ({ ...c, force: e.target.checked }))}
                  className="mt-0.5"
                />
                <span className="text-sm text-gray-700">
                  Force-close apps{' '}
                  <span className="text-gray-400">(may discard unsaved work — leave off for a graceful save prompt)</span>
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
              <button
                onClick={() => setConfirm(null)}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmPower}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white ${confirm.action === 'restart' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {confirm.action === 'restart' ? <RotateCcw className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                {confirm.action === 'restart' ? 'Restart' : 'Shut down'} now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live abort window — cancel a scheduled shutdown/restart within the countdown */}
      {pendingPower && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4">
          <div className="flex items-center gap-3 bg-amber-500 text-white rounded-xl shadow-2xl px-4 py-3">
            <ShieldAlert className="w-6 h-6 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">
                {pendingPower.action === 'restart' ? 'Restart' : 'Shutdown'} in{' '}
                {Math.max(0, Math.ceil((pendingPower.deadline - now) / 1000))}s
                <span className="font-normal"> on {pendingPower.targets.length} PC{pendingPower.targets.length > 1 ? 's' : ''}</span>
              </p>
              <p className="text-xs text-amber-100">Cancel now to stop it on every targeted PC.</p>
            </div>
            <button
              onClick={abortPending}
              className="flex items-center gap-2 px-4 py-2 bg-white text-amber-700 rounded-lg hover:bg-amber-50 font-semibold text-sm shrink-0"
            >
              <Ban className="w-4 h-4" /> Abort
            </button>
          </div>
        </div>
      )}

      {/* Host self-preview — a small "what students see right now" while projecting */}
      {projectionActive && (
        <div className="fixed bottom-6 left-6 z-40 w-56 overflow-hidden rounded-xl border border-indigo-200 bg-white shadow-xl">
          <div className="flex items-center justify-between bg-indigo-600 px-3 py-1.5 text-white">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <Cast className="w-3.5 h-3.5" /> What students see
            </span>
            <button
              onClick={() => stopProjection({ silent: false })}
              title="Stop projection"
              className="text-white/80 hover:text-white"
            >
              <StopCircle className="w-4 h-4" />
            </button>
          </div>
          <div className="aspect-video flex items-center justify-center bg-black">
            {selfPreviewUrl ? (
              <img src={selfPreviewUrl} alt="Projection self preview" className="w-full h-full object-contain" />
            ) : (
              <span className="text-[11px] text-gray-400">Starting capture…</span>
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-gray-500">
            <span>{projectingCount}/{totalGuests} receiving</span>
            {hostEmitStats && <span className="font-mono">{hostEmitStats.fps} fps</span>}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg z-50 text-sm max-w-sm">
          {toast}
        </div>
      )}
    </div>
  );
}

export default StudentScreenMonitoring;
