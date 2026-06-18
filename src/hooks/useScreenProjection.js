import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import socketService from '../services/socketService.js';

/**
 * useScreenProjection — Locked Demo Mode capture/broadcast engine (single source of truth).
 *
 * This is the EXACT working projection engine that originally lived inline in
 * Developer Mode, lifted verbatim into a hook so both Developer Mode and the
 * instructor's Student Screen Monitoring page drive the identical mechanism:
 * the host browser captures via getDisplayMedia, pushes JPEG frames to the
 * server over the existing outbound Socket.IO channel (NOT a dialed/stale IP),
 * and the server fans them out to each targeted guest's agent room
 * (`computer_<id>`) which renders a fullscreen, input-locked overlay. Ending is
 * owned server-side: host Stop, host disconnect, or the guest watchdog (~8s).
 *
 * Routing fix preserved: frame delivery rides the agent's live Socket.IO room,
 * so it keeps working across guest IP changes / multi-NIC hosts with no rescan.
 *
 * Targets are guest agent ids (computer UUIDs), or the string 'all'.
 */

// Locked Demo Mode capture defaults / ranges (host screen broadcast).
export const PROJECTION_DEFAULTS = { fps: 12, quality: 60, maxWidth: 1280 };
export const PROJECTION_FPS_RANGE = { min: 5, max: 20 };
export const PROJECTION_QUALITY_RANGE = { min: 30, max: 85 };
export const PROJECTION_MAXWIDTH_RANGE = { min: 640, max: 3840 };
const PROJECTION_PING_MS = 2000; // host heartbeat to keep guest watchdogs alive
const PROJECTION_PREVIEW_EVERY = 4; // refresh self-preview every N frames

export function clampNum(raw, { min, max }, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result;
      if (typeof s === 'string') {
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      } else {
        reject(new Error('Invalid read result'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export default function useScreenProjection() {
  // Locked Demo Mode (host screen broadcast) state.
  const [projectionSession, setProjectionSession] = useState(null); // { sessionId, perGuest, config }
  const [projectionStatus, setProjectionStatus] = useState('');
  const [projFps, setProjFps] = useState(PROJECTION_DEFAULTS.fps);
  const [projQuality, setProjQuality] = useState(PROJECTION_DEFAULTS.quality);
  const [projMaxWidth, setProjMaxWidth] = useState(PROJECTION_DEFAULTS.maxWidth);
  const [selfPreviewUrl, setSelfPreviewUrl] = useState('');
  const [hostEmitStats, setHostEmitStats] = useState(null); // { fps, kbps } emitted by this browser
  const projectionRunningRef = useRef(false);
  const projectionSessionIdRef = useRef(null);
  const projectionFrameTimerRef = useRef(null);
  const projectionPingTimerRef = useRef(null);
  const projectionStatsTimerRef = useRef(null);
  const projectionStreamRef = useRef(null);
  const projectionSeqRef = useRef(0);
  const projectionEmitCountRef = useRef(0); // frames emitted since last 1s sample
  const projectionEmitBytesRef = useRef(0); // base64 bytes emitted since last 1s sample
  const projectionActive = projectionSession != null;

  useEffect(() => {
    if (!socketService.connected()) socketService.connect();
  }, []);

  const guestStateById = useMemo(() => {
    const map = {};
    (projectionSession?.perGuest || []).forEach((g) => { map[g.id] = g; });
    return map;
  }, [projectionSession]);

  // Lookup tolerant of number/string ids (guest ids are computer UUID strings).
  const guestStateFor = useCallback(
    (id) => (id == null ? null : guestStateById[id] ?? guestStateById[String(id)] ?? null),
    [guestStateById],
  );

  const teardownCapture = useCallback(() => {
    projectionRunningRef.current = false;
    if (projectionFrameTimerRef.current != null) {
      window.clearInterval(projectionFrameTimerRef.current);
      projectionFrameTimerRef.current = null;
    }
    if (projectionPingTimerRef.current != null) {
      window.clearInterval(projectionPingTimerRef.current);
      projectionPingTimerRef.current = null;
    }
    if (projectionStatsTimerRef.current != null) {
      window.clearInterval(projectionStatsTimerRef.current);
      projectionStatsTimerRef.current = null;
    }
    projectionEmitCountRef.current = 0;
    projectionEmitBytesRef.current = 0;
    setHostEmitStats(null);
    const pack = projectionStreamRef.current;
    projectionStreamRef.current = null;
    if (pack?.stream) pack.stream.getTracks().forEach((t) => t.stop());
    setSelfPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
  }, []);

  const stopProjection = useCallback(
    ({ silent = false } = {}) => {
      const sessionId = projectionSessionIdRef.current;
      teardownCapture();
      projectionSessionIdRef.current = null;
      setProjectionSession(null);
      if (sessionId) socketService.stopProjection({ session_id: sessionId }, () => {});
      if (!silent) setProjectionStatus('Projection stopped.');
    },
    [teardownCapture],
  );

  // targets: 'all' | string[]. count is only used for the pre-capture guard /
  // initial status text ('all' resolves to every online guest server-side).
  const startProjection = useCallback(
    async (targets, count) => {
      const targetCount =
        typeof count === 'number' ? count : Array.isArray(targets) ? targets.length : 0;
      if (projectionRunningRef.current) {
        setProjectionStatus('Projection already running. Stop it first.');
        return;
      }
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setProjectionStatus('Screen capture is not supported in this browser.');
        return;
      }
      if (targetCount === 0) {
        setProjectionStatus('No online agents to project to.');
        return;
      }
      if (!socketService.connected()) socketService.connect();

      setProjectionStatus('Select a window/screen to share…');
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: projFps },
          audio: false,
        });
      } catch (e) {
        setProjectionStatus(`Screen share cancelled or denied: ${e?.message || e}`);
        return;
      }

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      try {
        await video.play();
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        setProjectionStatus(`Could not start capture: ${e?.message || e}`);
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      projectionStreamRef.current = { stream, video, canvas, ctx };
      projectionRunningRef.current = true;
      projectionSeqRef.current = 0;

      // host stops sharing via the browser's own "Stop sharing" control
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => stopProjection({ silent: false }));

      const sendFrame = () => {
        const sid = projectionSessionIdRef.current;
        const pack = projectionStreamRef.current;
        if (!projectionRunningRef.current || !pack || !sid) return;
        const { video: v, canvas: c, ctx: cctx } = pack;
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        if (!vw || !vh) return;
        let tw = vw;
        let th = vh;
        if (tw > projMaxWidth) {
          const scale = projMaxWidth / tw;
          tw = Math.round(tw * scale);
          th = Math.round(th * scale);
        }
        c.width = tw;
        c.height = th;
        cctx.drawImage(v, 0, 0, tw, th);
        c.toBlob(
          async (blob) => {
            if (!blob || !projectionRunningRef.current) return;
            const b64 = await blobToBase64(blob);
            const seq = (projectionSeqRef.current += 1);
            socketService.sendProjectionFrame({ session_id: sid, seq, w: tw, h: th, screenshot: b64 });
            projectionEmitCountRef.current += 1;
            projectionEmitBytesRef.current += b64.length;
            if (seq % PROJECTION_PREVIEW_EVERY === 0) {
              const url = URL.createObjectURL(blob);
              setSelfPreviewUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return url;
              });
            }
          },
          'image/jpeg',
          projQuality / 100,
        );
      };

      const beginLoops = () => {
        const frameMs = Math.round(1000 / projFps);
        projectionFrameTimerRef.current = window.setInterval(sendFrame, frameMs);
        projectionPingTimerRef.current = window.setInterval(() => {
          const sid = projectionSessionIdRef.current;
          if (sid) socketService.sendProjectionPing({ session_id: sid, ts: Date.now() });
        }, PROJECTION_PING_MS);
        // Sample this browser's actual emit rate once a second (hop #1 diagnostics).
        let lastSampleTs = Date.now();
        projectionStatsTimerRef.current = window.setInterval(() => {
          const now = Date.now();
          const dt = Math.max(0.001, (now - lastSampleTs) / 1000);
          lastSampleTs = now;
          const fps = Math.round((projectionEmitCountRef.current / dt) * 10) / 10;
          const kbps = Math.round(projectionEmitBytesRef.current / dt / 1024);
          projectionEmitCountRef.current = 0;
          projectionEmitBytesRef.current = 0;
          setHostEmitStats({ fps, kbps });
        }, 1000);
        sendFrame();
      };

      setProjectionStatus('Starting projection…');
      socketService.startProjection(
        { targets, fps: projFps, quality: projQuality, maxWidth: projMaxWidth },
        (res) => {
          if (!res?.ok) {
            teardownCapture();
            setProjectionStatus(res?.error || 'Server rejected projection.');
            return;
          }
          projectionSessionIdRef.current = res.sessionId;
          setProjectionSession({
            sessionId: res.sessionId,
            perGuest: res.perGuest || [],
            config: res.config,
          });
          const n = res.perGuest?.length || targetCount;
          setProjectionStatus(`Projecting to ${n} PC${n === 1 ? '' : 's'}…`);
          beginLoops();
        },
      );
    },
    [projFps, projQuality, projMaxWidth, teardownCapture, stopProjection],
  );

  // Live per-guest status pushed by the server.
  useEffect(() => {
    const unsub = socketService.on('projection:status', (data) => {
      setProjectionSession((prev) => {
        if (!prev || !data) return prev;
        if (data.session_id && prev.sessionId && data.session_id !== prev.sessionId) return prev;
        return {
          ...prev,
          perGuest: data.perGuest || prev.perGuest,
          config: data.config || prev.config,
          host: data.host || prev.host, // server-side recv/relay FPS (diagnostics)
        };
      });
    });
    return unsub;
  }, []);

  // Tear down capture (and tell the server to stop) if the consumer unmounts.
  useEffect(
    () => () => {
      teardownCapture();
      const sid = projectionSessionIdRef.current;
      if (sid) socketService.stopProjection({ session_id: sid }, () => {});
    },
    [teardownCapture],
  );

  const perGuest = projectionSession?.perGuest || [];
  const projectingCount = perGuest.filter(
    (g) => g.state === 'projecting' || g.state === 'connecting',
  ).length;
  const failedCount = perGuest.filter((g) => g.state === 'error' || g.state === 'offline').length;
  const totalGuests = perGuest.length;

  return {
    // session + status
    projectionSession,
    projectionActive,
    projectionStatus,
    setProjectionStatus,
    // controls
    startProjection,
    stopProjection,
    // host self-preview + diagnostics telemetry
    selfPreviewUrl,
    hostEmitStats,
    // capture config (clamped externally via the exported ranges)
    projFps,
    setProjFps,
    projQuality,
    setProjQuality,
    projMaxWidth,
    setProjMaxWidth,
    // per-guest state
    guestStateById,
    guestStateFor,
    projectingCount,
    failedCount,
    totalGuests,
  };
}
