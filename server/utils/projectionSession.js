/**
 * Locked Demo Mode — projection session manager (single source of truth).
 *
 * The browser admin/instructor is the HOST: it captures its screen and pushes
 * JPEG frames to the server over Socket.IO. The server fans frames out to the
 * targeted guest agents (rooms `computer_<id>`), which render a locked overlay.
 *
 * Only ONE projection session is active at a time (serialized). The server owns
 * lifecycle: it tears the whole session down on host disconnect, host stop, or
 * process exit, and tracks per-guest state for the dashboard.
 *
 * Transport note: this intentionally reuses the existing outbound Socket.IO
 * agent channel (NOT a server→agent TCP 5555 protocol). Frame/ping/stop are
 * Socket.IO events; the api_key still gates the Python agent's HTTP surface.
 */
import { randomUUID } from "crypto";

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const ROLE_ALLOWED = new Set(["ADMIN", "INSTRUCTOR"]);

// Tunables (env overrides; safe defaults for a lab LAN).
const DEFAULTS = Object.freeze({
  fps: clampInt(process.env.PROJECTION_FPS, 5, 20, 12),
  quality: clampInt(process.env.PROJECTION_JPEG_QUALITY, 30, 85, 60),
  maxWidth: clampInt(process.env.PROJECTION_MAX_WIDTH, 320, 3840, 1280),
  watchdogSeconds: clampInt(process.env.PROJECTION_WATCHDOG_SECONDS, 3, 60, 8),
  resendToLateJoiners:
    String(process.env.PROJECTION_RESEND_TO_LATE_JOINERS || "true").toLowerCase() !==
    "false",
});

// Guest states surfaced to the dashboard.
const GUEST = Object.freeze({
  CONNECTING: "connecting",
  PROJECTING: "projecting",
  STOPPING: "stopping",
  STOPPED: "stopped",
  OFFLINE: "offline",
  ERROR: "error",
});

class ProjectionSessionManager {
  constructor() {
    /** @type {import('socket.io').Server|null} */
    this.io = null;
    /** @type {Map<string, any>|null} */
    this.connectedComputers = null;
    this.session = null; // active session or null
  }

  attach({ io, connectedComputers }) {
    this.io = io;
    this.connectedComputers = connectedComputers;
  }

  get config() {
    return { ...DEFAULTS };
  }

  isActive() {
    return !!this.session;
  }

  /** Snapshot for REST GET /status and socket emits. */
  status() {
    if (!this.session) return { active: false, session: null };
    const s = this.session;
    return {
      active: true,
      session: {
        sessionId: s.sessionId,
        hostUserId: s.hostUserId,
        startedAt: s.startedAt,
        targetsType: s.isAll ? "all" : "selected",
        fps: s.fps,
        quality: s.quality,
        maxWidth: s.maxWidth,
        perGuest: this._perGuest(),
      },
    };
  }

  _perGuest() {
    if (!this.session) return [];
    return [...this.session.targets.values()].map((t) => ({
      id: t.id,
      ip: t.ip || null,
      mac: t.mac || null,
      hostname: t.hostname || null,
      name: t.name || null,
      state: t.state,
      detail: t.detail || null,
    }));
  }

  /** Resolve requested targets into [{ id, online }]. */
  _resolveTargets(targets) {
    const cc = this.connectedComputers;
    if (targets === "all") {
      return [...cc.keys()].map((id) => ({ id, online: true }));
    }
    const ids = Array.isArray(targets)
      ? [...new Set(targets.filter((x) => typeof x === "string" && x))]
      : [];
    return ids.map((id) => ({ id, online: cc.has(id) }));
  }

  _guestMeta(id) {
    const entry = this.connectedComputers.get(id);
    const c = entry?.computer || {};
    return {
      ip: c.ip || null,
      mac: c.mac || null,
      hostname: c.hostname || c.name || null,
      name: c.name || c.hostname || null,
    };
  }

  /**
   * Start a session. Returns { ok, sessionId?, config?, perGuest?, error? }.
   */
  start({ host, targets, opts = {} }) {
    if (!host || !ROLE_ALLOWED.has(String(host.role || "").toUpperCase())) {
      return { ok: false, error: "Only admin/instructor users can start projection." };
    }
    if (this.session) {
      // Serialize: reject a second concurrent session with a clear message.
      const owner = this.session.hostUserId;
      return {
        ok: false,
        error:
          owner === host.userId
            ? "You already have an active projection. Stop it before starting another."
            : "Another instructor is already projecting. Try again once they stop.",
        active: this.status(),
      };
    }

    const resolved = this._resolveTargets(targets);
    if (resolved.length === 0) {
      return { ok: false, error: "No target PCs selected (or no agents online)." };
    }

    const fps = clampInt(opts.fps, 5, 20, DEFAULTS.fps);
    const quality = clampInt(opts.quality, 30, 85, DEFAULTS.quality);
    const maxWidth = clampInt(opts.maxWidth, 320, 3840, DEFAULTS.maxWidth);

    const sessionId = randomUUID();
    const targetMap = new Map();
    for (const { id, online } of resolved) {
      const meta = online ? this._guestMeta(id) : {};
      targetMap.set(id, {
        id,
        ...meta,
        state: online ? GUEST.CONNECTING : GUEST.OFFLINE,
        detail: online ? null : "Agent not connected",
      });
    }

    this.session = {
      sessionId,
      hostUserId: host.userId,
      hostSocketId: host.socketId,
      startedAt: new Date().toISOString(),
      isAll: targets === "all",
      fps,
      quality,
      maxWidth,
      lastSeq: 0,
      targets: targetMap,
    };

    // Fan out PROJECT_START to every online target.
    for (const t of targetMap.values()) {
      if (t.state === GUEST.CONNECTING) this._sendStart(t.id);
    }

    this._emitStatus();
    return {
      ok: true,
      sessionId,
      config: { fps, quality, maxWidth, watchdogSeconds: DEFAULTS.watchdogSeconds },
      perGuest: this._perGuest(),
    };
  }

  _sendStart(computerId) {
    if (!this.session) return;
    const s = this.session;
    this.io.to(`computer_${computerId}`).emit("projection_start", {
      session_id: s.sessionId,
      fps: s.fps,
      quality: s.quality,
      max_width: s.maxWidth,
      watchdog_seconds: DEFAULTS.watchdogSeconds,
      expect_frames: true,
    });
  }

  /** Relay a frame to all active guests (latest-wins; stale/out-of-order dropped). */
  frame({ sessionId, seq, w, h, screenshot }) {
    const s = this.session;
    if (!s || s.sessionId !== sessionId) return { ok: false };
    if (!screenshot || typeof screenshot !== "string") return { ok: false };
    let safeSeq;
    if (Number.isFinite(seq)) {
      if (seq <= s.lastSeq) return { ok: false, stale: true }; // drop stale/out-of-order
      safeSeq = seq;
      s.lastSeq = seq;
    } else {
      safeSeq = ++s.lastSeq;
    }
    for (const t of s.targets.values()) {
      if (t.state === GUEST.CONNECTING || t.state === GUEST.PROJECTING) {
        this.io.to(`computer_${t.id}`).emit("projection_frame", {
          session_id: sessionId,
          seq: safeSeq,
          w: w || null,
          h: h || null,
          format: "jpeg",
          screenshot,
        });
      }
    }
    return { ok: true };
  }

  /** Heartbeat: fan a ping out to keep guest watchdogs alive even if frames stall. */
  ping({ sessionId, ts }) {
    const s = this.session;
    if (!s || s.sessionId !== sessionId) return { ok: false };
    const stamp = ts || Date.now();
    for (const t of s.targets.values()) {
      if (t.state === GUEST.CONNECTING || t.state === GUEST.PROJECTING) {
        this.io
          .to(`computer_${t.id}`)
          .emit("projection_ping", { session_id: sessionId, ts: stamp });
      }
    }
    return { ok: true };
  }

  /** Guest → server acknowledgement (resolve guest id from its socket). */
  ack({ socketId, sessionId, state, detail }) {
    const s = this.session;
    if (!s || (sessionId && s.sessionId !== sessionId)) return;
    const id = this._computerIdForSocket(socketId);
    if (!id) return;
    const t = s.targets.get(id);
    if (!t) return;
    if (state === "projecting") t.state = GUEST.PROJECTING;
    else if (state === "stopped") t.state = GUEST.STOPPED;
    else if (state === "error") {
      t.state = GUEST.ERROR;
      t.detail = detail || "Agent reported an error";
    }
    if (detail && state !== "error") t.detail = detail;
    this._emitStatus();
  }

  /** Guest → server heartbeat reply (kept for liveness; no state change needed). */
  pong({ socketId, sessionId }) {
    const s = this.session;
    if (!s || (sessionId && s.sessionId !== sessionId)) return;
    const id = this._computerIdForSocket(socketId);
    if (!id) return;
    const t = s.targets.get(id);
    if (t) t.lastPong = Date.now();
  }

  _computerIdForSocket(socketId) {
    if (!socketId || !this.connectedComputers) return null;
    for (const [id, c] of this.connectedComputers.entries()) {
      if (c.socketId === socketId) return id;
    }
    return null;
  }

  /**
   * Stop the active session (idempotent). Broadcasts PROJECT_STOP to all guests.
   * Returns { ok, sessionId } — ok is true even if there was nothing to stop.
   */
  stop({ sessionId, reason } = {}) {
    const s = this.session;
    if (!s) return { ok: true, sessionId: null, alreadyStopped: true };
    if (sessionId && s.sessionId !== sessionId) {
      return { ok: true, sessionId: s.sessionId, mismatch: true };
    }
    for (const t of s.targets.values()) {
      if (t.state !== GUEST.OFFLINE) t.state = GUEST.STOPPING;
      this.io
        .to(`computer_${t.id}`)
        .emit("projection_stop", { session_id: s.sessionId, reason: reason || "host_stop" });
    }
    const stopped = { ok: true, sessionId: s.sessionId, reason: reason || "host_stop" };
    // Final status push, then clear.
    this._emitStatus();
    this.session = null;
    return stopped;
  }

  /** Host browser socket dropped → tear the whole session down. */
  onHostDisconnect(socketId) {
    if (this.session && this.session.hostSocketId === socketId) {
      return this.stop({ reason: "host_disconnected" });
    }
    return null;
  }

  /** A guest agent dropped mid-session → mark it offline; others continue. */
  onAgentDisconnect(computerId) {
    const s = this.session;
    if (!s) return;
    const t = s.targets.get(computerId);
    if (t && t.state !== GUEST.OFFLINE) {
      t.state = GUEST.OFFLINE;
      t.detail = "Disconnected during session";
      this._emitStatus();
    }
  }

  /** A guest agent (re)connected mid-session → resend START for late joiners. */
  onAgentRegister(computerId) {
    const s = this.session;
    if (!s || !DEFAULTS.resendToLateJoiners) return;
    if (!s.isAll && !s.targets.has(computerId)) return; // selected sessions don't auto-add
    const meta = this._guestMeta(computerId);
    const existing = s.targets.get(computerId);
    s.targets.set(computerId, {
      id: computerId,
      ...meta,
      state: GUEST.CONNECTING,
      detail: existing ? "Reconnected — resyncing" : "Late joiner",
    });
    this._sendStart(computerId);
    this._emitStatus();
  }

  _emitStatus() {
    if (!this.io || !this.session) return;
    const payload = {
      session_id: this.session.sessionId,
      perGuest: this._perGuest(),
      config: {
        fps: this.session.fps,
        quality: this.session.quality,
        maxWidth: this.session.maxWidth,
        watchdogSeconds: DEFAULTS.watchdogSeconds,
      },
    };
    // The host is a user socket; emit directly to it.
    this.io.to(this.session.hostSocketId).emit("projection:status", payload);
  }
}

// Singleton shared by server/index.js (socket handlers) and routes/agents.js (REST).
export const projectionManager = new ProjectionSessionManager();
export { GUEST as PROJECTION_GUEST_STATE, DEFAULTS as PROJECTION_DEFAULTS };
