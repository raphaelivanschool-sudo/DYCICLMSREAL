import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Users, CheckCircle, Lock, MonitorUp, Ban,
  MessageSquare, Globe, Plus, X, Send, Power, RefreshCw,
  Square, CheckSquare, Circle, ShieldOff, Monitor,
} from 'lucide-react';
import socketService from '../../services/socketService';
import useScreenProjection from '../../hooks/useScreenProjection';
import { agentsApi } from '../../services/api';

const DISCOVERY_POLL_MS = 5000;

// Sensible classroom defaults the instructor can edit before applying.
const DEFAULT_BLOCKLIST = [
  'facebook.com', 'youtube.com', 'tiktok.com', 'instagram.com',
  'twitter.com', 'x.com', 'reddit.com', 'netflix.com',
];

const ACTION_LABELS = {
  lock: 'Lock',
  shutdown: 'Shutdown',
  message: 'Message',
  set_website_blocklist: 'Block websites',
  clear_website_blocklist: 'Unblock websites',
  block_internet: 'Block internet',
  allow_internet: 'Allow internet',
};
const labelForAction = (a) => ACTION_LABELS[a] || a;

// Common www/mobile fronts a typed domain is reduced past so the list stores one
// registrable base per site (the agent re-expands apex + these variants on apply).
const PEEL_SUBDOMAINS = ['www', 'm', 'web', 'mobile'];

// Normalize a typed domain to its registrable base, matching the agent's
// normalization so the list mirrors exactly what gets applied. Mobile/www fronts
// are only peeled while ≥2 labels remain, so "web.com" is never reduced to "com".
function normalizeDomain(raw) {
  let host = String(raw || '').trim().toLowerCase();
  if (!host) return '';
  host = host
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .split(':')[0]
    .replace(/\.+$/, '');
  let prev;
  do {
    prev = host;
    for (const sub of PEEL_SUBDOMAINS) {
      if (host.startsWith(`${sub}.`)) {
        const candidate = host.slice(sub.length + 1);
        if (candidate.includes('.')) host = candidate;
      }
    }
  } while (host !== prev);
  return host;
}

function ControlActions() {
  const [devices, setDevices] = useState(() => new Map()); // agentId -> device
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [results, setResults] = useState(() => new Map()); // agentId -> { action, state, detail, ts }
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  // Modals
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [showShutdown, setShowShutdown] = useState(false);
  const [shutdownGrace, setShutdownGrace] = useState(60);

  // Website blocklist (managed)
  const [blocklist, setBlocklist] = useState(DEFAULT_BLOCKLIST);
  const [domainInput, setDomainInput] = useState('');

  // Live "Show PC preview" — reuses the shared capture path (agentsApi.getScreenshot
  // → Socket.IO → guest Python/mss). No second implementation, no stale-IP dialing.
  const [previewDevice, setPreviewDevice] = useState(null); // device being previewed
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewStatus, setPreviewStatus] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewAuto, setPreviewAuto] = useState(true);

  const {
    projectionActive, projectionStatus, startProjection, stopProjection,
    projectingCount, failedCount, totalGuests,
  } = useScreenProjection();

  const toastTimerRef = useRef(null);
  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

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
          });
        }
        for (const [key, dev] of next) {
          if (!onlineIds.has(key) && dev.status !== 'offline') {
            next.set(key, { ...dev, status: 'offline', offlineSince: Date.now() });
          }
        }
        return next;
      });
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Failed to load connected agents');
    }
  }, []);

  // Mount: connect socket, immediate discovery, poll + react to agent events.
  useEffect(() => {
    if (!socketService.connected()) socketService.connect();
    // Kick off the first discovery off the effect's synchronous path (the setState
    // lands in an async callback, not directly in the effect body), then poll.
    const kickoff = setTimeout(pollDiscovery, 0);
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

    // Per-PC command feedback: upgrade a "sent" chip to "acknowledged"/"failed"
    // using the agent's own reply (relayed by the server to this user's room).
    const unsubCmd = socketService.on('agent_command_result', (data) => {
      if (!data) return;
      const id = data.computerId != null ? String(data.computerId) : null;
      if (!id) return;
      setResults((prev) => {
        const cur = prev.get(id);
        if (!cur || cur.action !== data.action) return prev; // only reflect the action we issued
        const n = new Map(prev);
        n.set(id, {
          ...cur,
          state: data.success ? 'acknowledged' : 'failed',
          detail: data.error || data.result?.message || cur.detail,
          ts: Date.now(),
        });
        return n;
      });
    });

    return () => {
      clearTimeout(kickoff);
      clearInterval(poll);
      unsubOnline?.();
      unsubOffline?.();
      unsubCmd?.();
    };
  }, [pollDiscovery]);

  // ---- Derived data ----
  const deviceList = useMemo(() => {
    const items = [...devices.values()];
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
      return (a.hostname || a.ip || '').localeCompare(b.hostname || b.ip || '');
    });
    return items;
  }, [devices]);

  const onlineDevices = useMemo(() => deviceList.filter((d) => d.status === 'online'), [deviceList]);
  const selectedOnline = useMemo(
    () => onlineDevices.filter((d) => selectedIds.has(String(d.agentId))),
    [onlineDevices, selectedIds],
  );
  // Actions apply to the checked PCs, or — when none are checked — all online PCs.
  const targets = selectedOnline.length ? selectedOnline : onlineDevices;
  const targetLabel = selectedOnline.length
    ? `${selectedOnline.length} selected`
    : `all ${onlineDevices.length} online`;
  const allOnlineSelected = onlineDevices.length > 0 && selectedOnline.length === onlineDevices.length;

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (onlineDevices.length > 0 && onlineDevices.every((d) => prev.has(String(d.agentId)))) {
        return new Set();
      }
      return new Set(onlineDevices.map((d) => String(d.agentId)));
    });
  };

  // ---- Command dispatch (per-PC results, offline skipped) ----
  const sendToTargets = useCallback(async (action, params, list) => {
    const online = (list || []).filter((d) => d.status === 'online' && d.agentId);
    if (online.length === 0) {
      showToast('No online PCs for this action');
      return;
    }
    setResults((prev) => {
      const n = new Map(prev);
      online.forEach((d) => n.set(String(d.agentId), { action, state: 'sent', ts: Date.now() }));
      return n;
    });
    await Promise.allSettled(
      online.map(async (d) => {
        try {
          await agentsApi.sendCommand(d.agentId, action, params, { ip: d.ip, mac: d.mac });
        } catch (e) {
          const detail = e?.response?.data?.error || e?.message || 'Request failed';
          setResults((prev) => {
            const n = new Map(prev);
            n.set(String(d.agentId), { action, state: 'failed', detail, ts: Date.now() });
            return n;
          });
        }
      }),
    );
    showToast(`${labelForAction(action)} sent to ${online.length} PC${online.length === 1 ? '' : 's'}`);
  }, [showToast]);

  // ---- Bulk handlers (operate on `targets`) ----
  const handleLock = () => sendToTargets('lock', {}, targets);
  const handleBlockInternet = () => sendToTargets('block_internet', {}, targets);
  const handleAllowInternet = () => sendToTargets('allow_internet', {}, targets);

  const handleConfirmShutdown = async () => {
    const graceSeconds = Math.max(0, Math.min(86400, parseInt(shutdownGrace, 10) || 0));
    setShowShutdown(false);
    await sendToTargets('shutdown', { graceSeconds }, targets);
  };

  const handleSendBroadcast = async () => {
    const msg = broadcastMessage.trim();
    if (!msg) return;
    setShowBroadcast(false);
    setBroadcastMessage('');
    await sendToTargets('message', { message: msg }, targets);
  };

  // ---- Website blocklist ----
  const addDomain = () => {
    const host = normalizeDomain(domainInput);
    if (!host) return;
    setBlocklist((prev) => (prev.includes(host) ? prev : [...prev, host]));
    setDomainInput('');
  };
  const removeDomain = (host) => setBlocklist((prev) => prev.filter((d) => d !== host));
  const handleApplyBlocklist = () => {
    if (blocklist.length === 0) {
      showToast('Add at least one domain to block');
      return;
    }
    sendToTargets('set_website_blocklist', { websites: blocklist }, targets);
  };
  const handleUnblockAll = () => sendToTargets('clear_website_blocklist', {}, targets);

  // ---- Live PC preview (shared capture path: getScreenshot → Socket.IO → mss) ----
  const requestPreview = useCallback(async (device, { silent = false } = {}) => {
    if (!device?.agentId) return;
    if (!silent) {
      setPreviewLoading(true);
      setPreviewStatus('Loading preview…');
    }
    try {
      const res = await agentsApi.getScreenshot(device.agentId, { ip: device.ip, mac: device.mac });
      const data = res?.data;
      if (data?.success && data.screenshot) {
        const fmt = (data.format || 'jpeg').toLowerCase();
        const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        setPreviewUrl(`data:${mime};base64,${data.screenshot}`);
        setPreviewStatus(`Live — updated ${new Date().toLocaleTimeString()}`);
      } else if (!silent) {
        setPreviewStatus(`Could not capture preview: ${data?.error || 'unknown error'}`);
      }
    } catch (e) {
      if (!silent) {
        setPreviewStatus(e?.response?.data?.error || e?.message || 'Could not capture preview');
      }
    } finally {
      if (!silent) setPreviewLoading(false);
    }
  }, []);

  const openPreview = (device) => {
    setPreviewUrl('');
    setPreviewStatus('');
    setPreviewDevice(device);
  };
  const closePreview = () => {
    setPreviewDevice(null);
    setPreviewUrl('');
    setPreviewStatus('');
    setPreviewLoading(false);
  };

  // Auto-start the preview on open, then refresh every 3s while open + auto is on.
  // The interval is torn down whenever the modal closes or auto-refresh is toggled.
  useEffect(() => {
    if (!previewDevice?.agentId) return undefined;
    requestPreview(previewDevice, { silent: false }); // immediate first frame
    if (!previewAuto) return undefined;
    const id = window.setInterval(() => requestPreview(previewDevice, { silent: true }), 3000);
    return () => window.clearInterval(id);
  }, [previewDevice, previewAuto, requestPreview]);

  // ---- Projection (reuses the shared Locked Demo Mode engine) ----
  const handleProjectAll = () => {
    if (projectionActive) return;
    startProjection('all', onlineDevices.length);
  };
  const handleProjectSelected = () => {
    if (projectionActive) return;
    startProjection(selectedOnline.map((d) => String(d.agentId)), selectedOnline.length);
  };
  const handleProjectOne = (device) => {
    if (projectionActive || device.status !== 'online') return;
    startProjection([String(device.agentId)], 1);
  };

  const lockedCount = useMemo(
    () => [...results.values()].filter((r) => r.action === 'lock' && r.state !== 'failed').length,
    [results],
  );

  const resultChip = (device) => {
    const r = results.get(String(device.agentId));
    if (!r) return null;
    const map = {
      sent: 'bg-blue-50 text-blue-700 border-blue-200',
      acknowledged: 'bg-green-50 text-green-700 border-green-200',
      failed: 'bg-red-50 text-red-700 border-red-200',
    };
    const text = {
      sent: `${labelForAction(r.action)}…`,
      acknowledged: `${labelForAction(r.action)} ✓`,
      failed: `${labelForAction(r.action)} ✕`,
    };
    return (
      <span
        title={r.detail || ''}
        className={`text-xs px-2 py-0.5 rounded border ${map[r.state] || map.sent}`}
      >
        {text[r.state] || r.state}
      </span>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {!!error && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Control Actions</h1>
          <p className="text-gray-500">Manage connected student PCs in real-time over the agent channel</p>
        </div>
        <button
          onClick={pollDiscovery}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Connected PCs</span>
            <Users className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{deviceList.length}</div>
          <div className="text-xs text-gray-400 mt-1">Discovered via agent</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Online</span>
            <CheckCircle className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{onlineDevices.length}</div>
          <div className="text-xs text-gray-400 mt-1">Available for control</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Locked Screens</span>
            <Lock className="w-5 h-5 text-red-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{lockedCount}</div>
          <div className="text-xs text-gray-400 mt-1">From this session</div>
        </div>
      </div>

      {/* Active projection banner */}
      {projectionActive && (
        <div className="mb-6 bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3 text-indigo-800">
            <MonitorUp className="w-5 h-5" />
            <span className="font-medium">
              Projecting — {projectingCount}/{totalGuests} live{failedCount ? `, ${failedCount} failed` : ''}
            </span>
          </div>
          <button
            onClick={() => stopProjection()}
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
          >
            Stop projection
          </button>
        </div>
      )}

      {/* Quick commands */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Quick Commands</h2>
          <span className="text-sm text-gray-500">Applies to <span className="font-medium text-gray-700">{targetLabel}</span></span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <ActionTile icon={Lock} label="Lock" color="red" onClick={handleLock} />
          <ActionTile icon={MessageSquare} label="Broadcast" color="blue" onClick={() => setShowBroadcast(true)} />
          <ActionTile icon={Power} label="Shutdown" color="red" onClick={() => setShowShutdown(true)} />
          <ActionTile
            icon={MonitorUp}
            label="Project to All"
            color="indigo"
            disabled={projectionActive || onlineDevices.length === 0}
            onClick={handleProjectAll}
          />
          <ActionTile
            icon={MonitorUp}
            label={`Project to Selected (${selectedOnline.length})`}
            color="indigo"
            disabled={projectionActive || selectedOnline.length === 0}
            onClick={handleProjectSelected}
          />
        </div>
        {projectionStatus && !projectionActive && (
          <p className="mt-3 text-sm text-indigo-700">{projectionStatus}</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Website blocking */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <ShieldOff className="w-5 h-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Website Blocking (specific sites)</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Blocks only the domains you list (hosts file → 0.0.0.0), with each domain expanded to its
            <span className="font-medium"> www / m / web</span> variants. While active it also turns off browser
            Secure DNS (DoH) so the hosts file is actually honored, then flushes DNS. Reversible — only a clearly
            delimited managed section is touched and Secure DNS is restored on <span className="font-medium">Unblock all</span>.
            Targeted by design; use <span className="font-medium">Internet → Block internet</span> for a hard cutoff
            (hosts blocking can't stop a VPN or a direct-IP visit). Needs the agent running as Administrator.
          </p>

          <div className="flex gap-2 mb-3">
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addDomain(); }}
              placeholder="e.g. facebook.com"
              className="flex-1 p-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              onClick={addDomain}
              className="flex items-center gap-1 px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4 min-h-[2rem]">
            {blocklist.length === 0 && <span className="text-sm text-gray-400">No domains in the list.</span>}
            {blocklist.map((host) => (
              <span key={host} className="inline-flex items-center gap-1 bg-gray-50 border border-gray-200 text-gray-700 text-sm px-2 py-1 rounded-lg">
                {host}
                <button onClick={() => removeDomain(host)} className="text-gray-400 hover:text-red-500" title="Remove">
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleApplyBlocklist}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"
            >
              <ShieldOff className="w-4 h-4" /> Block on {targetLabel}
            </button>
            <button
              onClick={handleUnblockAll}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
            >
              <Globe className="w-4 h-4" /> Unblock all
            </button>
          </div>
        </div>

        {/* Internet controls (firewall) */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <Globe className="w-5 h-5 text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Internet</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Blocks public internet while keeping the LMS reachable, so PCs stay controllable.
            Reversible instantly via Allow internet.
          </p>

          <div className="space-y-3">
            <button
              onClick={handleBlockInternet}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-red-300 hover:bg-red-50 text-gray-700 transition-all"
            >
              <Ban className="w-5 h-5 text-red-500" />
              <span className="font-medium">Block internet on {targetLabel}</span>
            </button>
            <button
              onClick={handleAllowInternet}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-green-300 hover:bg-green-50 text-gray-700 transition-all"
            >
              <Globe className="w-5 h-5 text-green-500" />
              <span className="font-medium">Allow internet on {targetLabel}</span>
            </button>
          </div>

          <div className="mt-4 flex items-start gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
            <Globe className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" />
            <span>
              Adds a managed Windows Firewall rule that cuts the public internet but leaves the local
              network and the LMS server reachable — so the agent stays online and you keep full control.
              Needs the agent running as Administrator on the guest.
            </span>
          </div>
        </div>
      </div>

      {/* Connected PCs */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Connected PCs</h2>
          <button
            onClick={toggleSelectAll}
            disabled={onlineDevices.length === 0}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-40"
          >
            {allOnlineSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
            {allOnlineSelected ? 'Deselect all' : 'Select all online'}
          </button>
        </div>

        {deviceList.length === 0 ? (
          <div className="text-center py-10 text-gray-400 text-sm">
            No agent PCs connected. Start the DYCI agent on a guest to control it here.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {deviceList.map((device) => {
              const id = String(device.agentId);
              const isOnline = device.status === 'online';
              const isSelected = selectedIds.has(id);
              return (
                <div key={id} className={`flex items-center gap-3 py-3 ${isOnline ? '' : 'opacity-60'}`}>
                  <button
                    onClick={() => isOnline && toggleSelect(id)}
                    disabled={!isOnline}
                    title={isOnline ? (isSelected ? 'Deselect' : 'Select') : 'Offline — not selectable'}
                    className="shrink-0 disabled:cursor-not-allowed"
                  >
                    {isSelected
                      ? <CheckSquare className="w-5 h-5 text-green-600" />
                      : <Square className={`w-5 h-5 ${isOnline ? 'text-gray-400' : 'text-gray-300'}`} />}
                  </button>

                  <Circle className={`w-2.5 h-2.5 shrink-0 ${isOnline ? 'text-green-500 fill-green-500' : 'text-gray-400 fill-gray-400'}`} />

                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">
                      {device.hostname || device.ip || 'Unknown PC'}
                    </div>
                    <div className="text-xs text-gray-400 truncate">
                      {device.user ? `${device.user} · ` : ''}{device.ip || '—'}{device.os ? ` · ${device.os}` : ''}
                    </div>
                  </div>

                  <div className="shrink-0">{resultChip(device)}</div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => openPreview(device)}
                      disabled={!isOnline}
                      title="Show a live preview of this PC"
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 text-xs font-medium disabled:opacity-40"
                    >
                      <Monitor className="w-3.5 h-3.5" /> Preview
                    </button>
                    <button
                      onClick={() => sendToTargets('lock', {}, [device])}
                      disabled={!isOnline}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 text-xs font-medium disabled:opacity-40"
                    >
                      <Lock className="w-3.5 h-3.5" /> Lock
                    </button>
                    <button
                      onClick={() => handleProjectOne(device)}
                      disabled={!isOnline || projectionActive}
                      title={projectionActive ? 'Already projecting — stop it first' : 'Project to this PC'}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-xs font-medium disabled:opacity-40"
                    >
                      <MonitorUp className="w-3.5 h-3.5" /> Project
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Broadcast modal */}
      {showBroadcast && (
        <Modal title="Broadcast Message" onClose={() => setShowBroadcast(false)}>
          <textarea
            value={broadcastMessage}
            onChange={(e) => setBroadcastMessage(e.target.value)}
            placeholder={`Message to ${targetLabel}…`}
            className="w-full h-32 p-3 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <ModalActions
            onCancel={() => setShowBroadcast(false)}
            confirmLabel="Send Broadcast"
            confirmIcon={Send}
            onConfirm={handleSendBroadcast}
          />
        </Modal>
      )}

      {/* Shutdown modal */}
      {showShutdown && (
        <Modal title="Shutdown PCs" onClose={() => setShowShutdown(false)}>
          <p className="text-sm text-gray-600 mb-3">
            A graceful shutdown with an on-screen warning will be scheduled on <span className="font-medium">{targetLabel}</span>.
            Students can save work during the countdown; use “Abort Shutdown” to cancel within the window.
          </p>
          <label className="block text-sm font-medium text-gray-700 mb-1">Countdown (seconds)</label>
          <input
            type="number"
            min={0}
            max={86400}
            value={shutdownGrace}
            onChange={(e) => setShutdownGrace(e.target.value)}
            className="w-full p-2.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
          />
          <ModalActions
            onCancel={() => setShowShutdown(false)}
            confirmLabel="Schedule Shutdown"
            confirmIcon={Power}
            danger
            onConfirm={handleConfirmShutdown}
          />
        </Modal>
      )}

      {/* Live PC preview modal */}
      {previewDevice && (
        <div className="modal-overlay" onClick={closePreview}>
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-emerald-100 shrink-0">
                  <Monitor className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-gray-900 truncate">
                    {previewDevice.hostname || previewDevice.ip || 'PC preview'}
                  </h3>
                  <p className="text-sm text-gray-500 truncate">
                    {previewDevice.user ? `${previewDevice.user} · ` : ''}{previewDevice.ip || '—'}
                  </p>
                </div>
              </div>
              <button onClick={closePreview} className="p-2 hover:bg-gray-100 rounded-lg" title="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4">
              <div className="rounded-xl border-2 border-gray-200 bg-gray-900 overflow-hidden aspect-video flex items-center justify-center">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={`${previewDevice.hostname || previewDevice.ip} screen`}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center">
                    <Monitor className="w-12 h-12 text-gray-500 mx-auto mb-2 animate-pulse" />
                    <span className="text-sm text-gray-400">
                      {previewLoading ? 'Loading preview…' : 'Waiting for preview…'}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
                <p className={`text-sm ${previewStatus && !/^(Live|Loading)/.test(previewStatus) ? 'text-red-600' : 'text-gray-500'}`}>
                  {previewStatus || 'Capture runs on the guest (Python/mss) over the agent connection.'}
                </p>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300"
                      checked={previewAuto}
                      onChange={(e) => setPreviewAuto(e.target.checked)}
                    />
                    Auto-refresh (3s)
                  </label>
                  <button
                    onClick={() => requestPreview(previewDevice, { silent: false })}
                    disabled={previewLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${previewLoading ? 'animate-spin' : ''}`} />
                    {previewLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// ---- Small presentational helpers ----
const COLOR_CLASSES = {
  red: 'hover:border-red-300 hover:bg-red-50',
  green: 'hover:border-green-300 hover:bg-green-50',
  blue: 'hover:border-blue-300 hover:bg-blue-50',
  indigo: 'hover:border-indigo-300 hover:bg-indigo-50',
  gray: 'hover:border-gray-400 hover:bg-gray-100',
};
const ICON_COLORS = {
  red: 'text-red-500', green: 'text-green-500', blue: 'text-blue-500',
  indigo: 'text-indigo-500', gray: 'text-gray-500',
};

function ActionTile({ icon, label, color = 'gray', onClick, disabled }) {
  const Icon = icon;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 border-gray-200 text-gray-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${COLOR_CLASSES[color] || COLOR_CLASSES.gray}`}
    >
      <Icon className={`w-6 h-6 mb-2 ${ICON_COLORS[color] || ICON_COLORS.gray}`} />
      <span className="text-sm font-medium text-center">{label}</span>
    </button>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-overlay">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ onCancel, onConfirm, confirmLabel, confirmIcon, danger }) {
  const Icon = confirmIcon;
  return (
    <div className="flex justify-end gap-2 mt-4">
      <button onClick={onCancel} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium">
        Cancel
      </button>
      <button
        onClick={onConfirm}
        className={`flex items-center gap-2 px-4 py-2 text-white rounded-lg font-medium ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
      >
        {Icon && <Icon className="w-4 h-4" />}
        {confirmLabel}
      </button>
    </div>
  );
}

export default ControlActions;
