import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import dgram from 'dgram';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { pickAgentTargetId, resolveLanIpForPcAgent } from '../utils/agentLookup.js';
import { projectionManager } from '../utils/projectionSession.js';
import {
  getPcAgentApiKey,
  getPcAgentConfigPathTried,
} from '../utils/pcAgentAuth.js';
import {
  recordActivity,
  clientIp,
  summarizePayload,
} from '../utils/activityLog.js';
import { recordControlAction, resolveTarget } from '../utils/controlLog.js';

const router = Router();
const prisma = new PrismaClient();
const PC_AGENT_PORT = parseInt(process.env.PC_AGENT_HTTP_PORT || '5555', 10);

// Helper to create WoL magic packet
function createMagicPacket(mac) {
  const macBytes = mac.replace(/:/g, '').match(/.{1,2}/g).map(b => parseInt(b, 16));
  const packet = Buffer.alloc(102);
  // 6 bytes of 0xFF
  for (let i = 0; i < 6; i++) packet[i] = 0xFF;
  // 16 repetitions of MAC address
  for (let i = 1; i <= 16; i++) {
    macBytes.forEach((byte, j) => {
      packet[i * 6 + j] = byte;
    });
  }
  return packet;
}

// GET /api/agents - Get all registered agents from database
router.get('/', authenticateToken, async (req, res) => {
  try {
    const agents = await prisma.agent.findMany({
      orderBy: { lastSeen: 'desc' }
    });
    res.json(agents);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// GET /api/agents/stats - Get stats with alerts
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const [total, online, offline, staleAgents] = await Promise.all([
      prisma.agent.count(),
      prisma.agent.count({ where: { status: 'ONLINE' } }),
      prisma.agent.count({ where: { status: 'OFFLINE' } }),
      prisma.agent.findMany({
        where: {
          status: 'ONLINE',
          lastSeen: { lt: fiveMinutesAgo }
        },
        select: { id: true, hostname: true, lastSeen: true }
      })
    ]);

    const alerts = staleAgents.map(agent => ({
      id: agent.id,
      hostname: agent.hostname,
      reason: `No heartbeat for ${Math.floor((Date.now() - new Date(agent.lastSeen)) / 60000)} minutes`
    }));

    res.json({ total, online, offline, alerts });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/agents/wake - Wake on LAN
router.post('/wake', authenticateToken, async (req, res) => {
  try {
    const { mac } = req.body;
    if (!mac) {
      return res.status(400).json({ error: 'MAC address is required' });
    }

    // Create and send magic packet
    const packet = createMagicPacket(mac);
    const socket = dgram.createSocket('udp4');
    
    socket.send(packet, 9, '255.255.255.255', async (err) => {
      socket.close();
      if (err) {
        console.error('WoL error:', err);
        return res.status(500).json({ error: 'Failed to send wake packet' });
      }
      await recordActivity(prisma, {
        userId: req.user.id,
        action: 'WAKE_ON_LAN',
        description: `Wake-on-LAN magic packet sent for MAC ${mac}`,
        ipAddress: clientIp(req),
      });
      const wakeTarget = await prisma.agent.findUnique({ where: { mac } }).catch(() => null);
      await recordControlAction(prisma, {
        actorId: req.user.id,
        actorRole: req.user.role,
        action: 'wake',
        targetHostname: wakeTarget?.hostname || null,
        targetIp: wakeTarget?.ipAddress || null,
        result: 'SENT',
        detail: `Wake-on-LAN magic packet for MAC ${mac}`,
      });
      res.json({ ok: true, message: `Wake packet sent to ${mac}` });
    });

    // Log the wake attempt
    const agent = await prisma.agent.findUnique({ where: { mac } });
    if (agent) {
      await prisma.agentActivityLog.create({
        data: {
          agentId: agent.id,
          command: 'wake',
          issuedBy: req.user.id,
          status: 'SENT'
        }
      });
    }
  } catch (error) {
    console.error('Error sending WoL:', error);
    res.status(500).json({ error: 'Failed to send wake packet' });
  }
});

// GET /api/agents/:id/logs - Get agent logs
router.get('/:id/logs', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.agentActivityLog.findMany({
        where: { agentId: parseInt(id) },
        include: { agent: true, user: { select: { username: true } } },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit
      }),
      prisma.agentActivityLog.count({ where: { agentId: parseInt(id) } })
    ]);

    res.json({
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    console.error('Error fetching agent logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// GET /api/agents/logs - Get all logs
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.agentActivityLog.findMany({
        include: { agent: true, user: { select: { username: true } } },
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit
      }),
      prisma.agentActivityLog.count()
    ]);

    res.json({
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Get all connected agent PCs
router.get('/connected', authenticateToken, (req, res) => {
  try {
    const io = req.app.get('io');
    const connectedComputers = req.app.get('connectedComputers');
    
    if (!connectedComputers) {
      return res.json({
        success: true,
        devices: [],
        count: 0
      });
    }

    // Convert Map to array of computer data (include ipAddresses for UI merge / commands)
    const devices = Array.from(connectedComputers.values()).map((computerData) => {
      const c = computerData.computer || {};
      return {
        id: c.id,
        name: c.name || c.hostname,
        hostname: c.hostname,
        ip: c.ip,
        mac: c.mac,
        ipAddresses: Array.isArray(c.ipAddresses) ? c.ipAddresses : [],
        interfaceBindings: Array.isArray(c.interfaceBindings) ? c.interfaceBindings : [],
        user: computerData.user || c.user,
        status: computerData.status || 'online',
        os: c.platform || c.distro || c.os || 'Windows',
        lastSeen: computerData.lastSeen,
        specs: c.specs || {},
        socketId: computerData.socketId,
      };
    });

    res.json({
      success: true,
      devices,
      count: devices.length,
      lastScan: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting connected agents:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get connected agents'
    });
  }
});

// Get specific agent PC details
router.get('/connected/:computerId', authenticateToken, (req, res) => {
  try {
    const connectedComputers = req.app.get('connectedComputers');
    const computerData = connectedComputers?.get(req.params.computerId);
    
    if (!computerData) {
      return res.status(404).json({
        success: false,
        error: 'Computer not found'
      });
    }

    const c = computerData.computer || {};
    res.json({
      success: true,
      device: {
        id: c.id,
        name: c.name || c.hostname,
        hostname: c.hostname,
        ip: c.ip,
        mac: c.mac,
        ipAddresses: Array.isArray(c.ipAddresses) ? c.ipAddresses : [],
        interfaceBindings: Array.isArray(c.interfaceBindings) ? c.interfaceBindings : [],
        user: computerData.user || c.user,
        status: computerData.status || 'online',
        os: c.platform || c.distro || c.os || 'Windows',
        lastSeen: computerData.lastSeen,
        specs: c.specs || {},
      },
    });
  } catch (error) {
    console.error('Error getting agent details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get agent details'
    });
  }
});

// Send command to agent PC (by computer UUID and/or client LAN IP / MAC)
router.post('/command', authenticateToken, async (req, res) => {
  try {
    // Agent control is privileged — enforce role server-side, not just in the UI.
    const role = String(req.user?.role || '').toUpperCase();
    if (role !== 'ADMIN' && role !== 'INSTRUCTOR') {
      return res.status(403).json({
        success: false,
        error: 'Admin or instructor role required to send agent commands.',
      });
    }

    const io = req.app.get('io');
    const connectedComputers = req.app.get('connectedComputers');
    const { computerId, ip, mac, action, params } = req.body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'action is required',
      });
    }

    const { targetId, strategy } = pickAgentTargetId(connectedComputers, {
      computerId,
      ip,
      mac,
    });

    if (!targetId) {
      return res.status(404).json({
        success: false,
        error:
          'No online agent matches this PC. Ensure the DYCI agent is running and connected to this server.',
      });
    }

    if (process.env.NODE_ENV !== 'production' && strategy === 'single-session-fallback') {
      console.warn(
        '[agents/command] Using single-session fallback (one agent online; discovery IP/MAC did not match registration).'
      );
    }

    io.to(`computer_${targetId}`).emit('execute_command', {
      action,
      params,
      from: req.user.id,
      timestamp: new Date(),
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'AGENT_REMOTE_COMMAND',
      description: `Remote agent command "${action}" → computer ${targetId} (ip=${ip || '—'} mac=${mac || '—'}) params=${summarizePayload(params)}`,
      ipAddress: clientIp(req),
    });

    // Structured control-action row for the usage reports.
    const tgt = resolveTarget(connectedComputers, targetId);
    await recordControlAction(prisma, {
      actorId: req.user.id,
      actorRole: req.user.role,
      action,
      ...tgt,
      targetIp: tgt.targetIp || ip || null,
      result: 'SENT',
      detail: `params=${summarizePayload(params)} (strategy=${strategy})`,
    });

    res.json({
      success: true,
      message: `Command ${action} sent to computer ${targetId}`,
      resolvedComputerId: targetId,
      resolutionStrategy: strategy,
    });
  } catch (error) {
    console.error('Error sending command to agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send command',
    });
  }
});


/**
 * Live screenshot of a guest — primary capture path.
 *
 * Fetches the JPEG from the guest's Python agent (Flask on TCP 5555, mss/Pillow)
 * using the shared api_key. This replaces the fragile screenshot-desktop
 * (.bat/.exe) backend in the Node agent, which remains only as a socket fallback.
 */
router.post('/screenshot', authenticateToken, async (req, res) => {
  try {
    const apiKey = getPcAgentApiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error:
          `Screenshot unavailable: Python agent api_key not configured. Set PC_AGENT_API_KEY in server/.env ` +
          `or sync agent_config.json (see ${getPcAgentConfigPathTried()}).`,
      });
    }

    const connectedComputers = req.app.get('connectedComputers');
    const { computerId, ip, mac } = req.body || {};
    const { targetId, strategy } = pickAgentTargetId(connectedComputers, { computerId, ip, mac });
    if (!targetId) {
      return res.status(404).json({
        success: false,
        error: 'No online agent matches this PC. Ensure the DYCI agent is running and connected.',
      });
    }

    const lanIp = resolveLanIpForPcAgent(connectedComputers, targetId, ip);
    if (!lanIp) {
      return res.status(400).json({ success: false, error: 'Could not resolve the guest agent LAN IP.' });
    }

    const url = `http://${lanIp}:${PC_AGENT_PORT}/screenshot`;
    let guestResp;
    try {
      guestResp = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 12000,
        validateStatus: () => true,
      });
    } catch (e) {
      const msg =
        e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH'
          ? `Could not reach the Python agent at ${lanIp}:${PC_AGENT_PORT}. Confirm it is running and that the guest firewall allows TCP ${PC_AGENT_PORT} on the LAN.`
          : e.message || 'Screenshot request failed';
      return res.status(502).json({ success: false, error: msg });
    }

    if (guestResp.status === 401 || guestResp.status === 403) {
      return res.status(guestResp.status).json({
        success: false,
        error: 'Guest agent rejected the api_key — it must match the server (PC_AGENT_API_KEY / agent_config.json).',
      });
    }
    if (guestResp.status !== 200 || !guestResp.data?.screenshot) {
      const detail =
        (typeof guestResp.data === 'object' && guestResp.data?.error) ||
        guestResp.statusText ||
        String(guestResp.status);
      return res.status(502).json({ success: false, error: `Guest agent screenshot failed: ${detail}` });
    }

    return res.json({
      success: true,
      screenshot: guestResp.data.screenshot,
      format: guestResp.data.format || 'jpeg',
      timestamp: guestResp.data.timestamp || new Date().toISOString(),
      resolvedComputerId: targetId,
      resolutionStrategy: strategy,
    });
  } catch (error) {
    console.error('[agents/screenshot]', error);
    res.status(500).json({ success: false, error: 'Screenshot failed (server error)' });
  }
});

/**
 * Per-guest health/diagnostics for the dashboard. Aggregates:
 *   - Node agent online (Socket.IO presence),
 *   - Python agent reachable + api_key OK (HTTP 5555 /selftest),
 *   - capture/overlay dependency status + a real test capture,
 *   - current projection state for this guest.
 * Lets the macOS host pinpoint why a Windows guest screenshot/overlay fails.
 */
router.post('/diagnose', authenticateToken, async (req, res) => {
  const connectedComputers = req.app.get('connectedComputers');
  const { computerId, ip, mac } = req.body || {};
  const { targetId, strategy } = pickAgentTargetId(connectedComputers, { computerId, ip, mac });

  const out = {
    success: true,
    resolvedComputerId: targetId || null,
    resolutionStrategy: strategy || null,
    nodeAgentOnline: Boolean(targetId),
    pythonAgentReachable: false,
    apiKeyOk: false,
    deps: {},
    capture: {},
    overlay: {},
    elevated: null,
    projection: null,
    guest: null,
    errors: [],
  };

  // Current projection state for this guest (server-side truth).
  try {
    const status = projectionManager.status();
    if (status.active && targetId) {
      out.projection = (status.session.perGuest || []).find((g) => g.id === targetId) || null;
    }
  } catch { /* ignore */ }

  if (!targetId) {
    out.errors.push('Node agent for this PC is not connected to the server (Socket.IO). Start/restart pc-agent/agent.js on the guest.');
    return res.json(out);
  }

  const apiKey = getPcAgentApiKey();
  if (!apiKey) {
    out.errors.push(`Server api_key not configured. Set PC_AGENT_API_KEY in server/.env or sync agent_config.json (${getPcAgentConfigPathTried()}).`);
    return res.json(out);
  }

  const lanIp = resolveLanIpForPcAgent(connectedComputers, targetId, ip);
  if (!lanIp) {
    out.errors.push('Could not resolve the guest LAN IP for the Python agent.');
    return res.json(out);
  }
  out.lanIp = lanIp;

  try {
    const r = await axios.get(`http://${lanIp}:${PC_AGENT_PORT}/selftest`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 12000,
      validateStatus: () => true,
    });
    if (r.status === 401 || r.status === 403) {
      out.pythonAgentReachable = true;
      out.apiKeyOk = false;
      out.errors.push('api_key mismatch — the guest Python agent rejected the key (sync PC_AGENT_API_KEY with the guest agent_config.json).');
    } else if (r.status === 200 && r.data) {
      out.pythonAgentReachable = true;
      out.apiKeyOk = true;
      out.guest = r.data;
      out.deps = r.data.deps || {};
      out.capture = r.data.capture || {};
      out.overlay = r.data.overlay || {};
      out.elevated = r.data.elevated ?? null;
      if (out.capture && out.capture.ok === false && out.capture.error) {
        out.errors.push(`Guest capture failed: ${out.capture.error}`);
      }
      if (out.deps && out.deps.mss === false) out.errors.push('Guest: mss not installed (pip install mss) — falling back to Pillow.');
      if (out.overlay && out.overlay.script_present === false) out.errors.push('Guest: projection_overlay.py missing next to the Python agent.');
      if (out.elevated === false) out.errors.push('Guest agent is NOT elevated — full input lock needs Administrator.');
    } else {
      out.pythonAgentReachable = true;
      out.errors.push(`Guest /selftest returned HTTP ${r.status}.`);
    }
  } catch (e) {
    out.errors.push(
      `Python agent unreachable at ${lanIp}:${PC_AGENT_PORT} (${e.code || e.message}). Check it is running and the guest firewall allows inbound TCP ${PC_AGENT_PORT} on the LAN.`,
    );
  }

  return res.json(out);
});

/**
 * Tail of the guest's locked-overlay log (dyci_projection_overlay.log) + the
 * env that decides whether the overlay can launch. This is how the macOS host
 * reads the real Windows traceback when the overlay crash-loops — it proxies to
 * the guest Python agent's GET /overlay-log over HTTP 5555 using the api_key.
 *
 * Body: { computerId?, ip?, mac?, lines? }  (lines default 200, capped 1000)
 */
router.post('/overlay-log', authenticateToken, async (req, res) => {
  try {
    const apiKey = getPcAgentApiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error:
          `Overlay log unavailable: Python agent api_key not configured. Set PC_AGENT_API_KEY in server/.env ` +
          `or sync agent_config.json (see ${getPcAgentConfigPathTried()}).`,
      });
    }

    const connectedComputers = req.app.get('connectedComputers');
    const { computerId, ip, mac } = req.body || {};
    const lines = Math.max(1, Math.min(1000, parseInt(req.body?.lines, 10) || 200));
    const { targetId, strategy } = pickAgentTargetId(connectedComputers, { computerId, ip, mac });
    if (!targetId) {
      return res.status(404).json({
        success: false,
        error: 'No online agent matches this PC. Ensure the DYCI agent is running and connected.',
      });
    }

    const lanIp = resolveLanIpForPcAgent(connectedComputers, targetId, ip);
    if (!lanIp) {
      return res.status(400).json({ success: false, error: 'Could not resolve the guest agent LAN IP.' });
    }

    const url = `http://${lanIp}:${PC_AGENT_PORT}/overlay-log?lines=${lines}`;
    let guestResp;
    try {
      guestResp = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 12000,
        validateStatus: () => true,
      });
    } catch (e) {
      const msg =
        e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH'
          ? `Could not reach the Python agent at ${lanIp}:${PC_AGENT_PORT}. Confirm it is running and that the guest firewall allows TCP ${PC_AGENT_PORT} on the LAN.`
          : e.message || 'Overlay-log request failed';
      return res.status(502).json({ success: false, error: msg });
    }

    if (guestResp.status === 401 || guestResp.status === 403) {
      return res.status(guestResp.status).json({
        success: false,
        error: 'Guest agent rejected the api_key — it must match the server (PC_AGENT_API_KEY / agent_config.json).',
      });
    }
    if (guestResp.status !== 200 || !guestResp.data?.log) {
      const detail =
        (typeof guestResp.data === 'object' && guestResp.data?.error) ||
        guestResp.statusText ||
        String(guestResp.status);
      return res.status(502).json({ success: false, error: `Guest overlay-log failed: ${detail}` });
    }

    return res.json({
      success: true,
      resolvedComputerId: targetId,
      resolutionStrategy: strategy,
      lanIp,
      ...guestResp.data,
    });
  } catch (error) {
    console.error('[agents/overlay-log]', error);
    res.status(500).json({ success: false, error: 'Overlay log failed (server error)' });
  }
});

// ---- Locked Demo Mode: projection REST fallbacks (socket path is primary) ----
// These mirror the Socket.IO projection:* events for clients that cannot use
// the live socket. The browser host normally drives projection over Socket.IO;
// the server is the single authority and fans frames out to guest agents.

function requireProjectionRole(req, res) {
  const role = String(req.user?.role || '').toUpperCase();
  if (role !== 'ADMIN' && role !== 'INSTRUCTOR') {
    res.status(403).json({ success: false, error: 'Admin or instructor role required.' });
    return false;
  }
  return true;
}

/** Start a projection session (targets: 'all' | array of computerIds). */
router.post('/projection/start', authenticateToken, async (req, res) => {
  try {
    if (!requireProjectionRole(req, res)) return;
    const { targets, fps, quality, maxWidth } = req.body || {};
    const result = projectionManager.start({
      host: { userId: req.user.id, role: req.user.role, socketId: null },
      targets: targets === 'all' ? 'all' : targets,
      opts: { fps, quality, maxWidth },
    });
    if (!result.ok) {
      return res.status(409).json({ success: false, error: result.error, active: result.active });
    }
    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'SCREEN_PROJECTION_START',
      description: `Started Locked Demo Mode via REST (${
        targets === 'all' ? 'all online' : `${(result.perGuest || []).length} selected`
      }) — session ${result.sessionId}`,
      ipAddress: clientIp(req),
    });
    await recordControlAction(prisma, {
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'project',
      result: 'SENT',
      detail: `Projection start — ${
        targets === 'all' ? 'all online' : `${(result.perGuest || []).length} selected`
      }, session ${result.sessionId}`,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[agents/projection/start]', error);
    res.status(500).json({ success: false, error: 'Failed to start projection' });
  }
});

/** Stop the active projection session (idempotent). */
router.post('/projection/stop', authenticateToken, async (req, res) => {
  try {
    if (!requireProjectionRole(req, res)) return;
    const { session_id } = req.body || {};
    const result = projectionManager.stop({ sessionId: session_id, reason: 'host_stop' });
    if (result.sessionId) {
      await recordActivity(prisma, {
        userId: req.user.id,
        action: 'SCREEN_PROJECTION_STOP',
        description: `Stopped Locked Demo Mode via REST — session ${result.sessionId}`,
        ipAddress: clientIp(req),
      });
      await recordControlAction(prisma, {
        actorId: req.user.id,
        actorRole: req.user.role,
        action: 'projection-stop',
        result: 'SENT',
        detail: `Projection stop — session ${result.sessionId}`,
      });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[agents/projection/stop]', error);
    res.status(500).json({ success: false, error: 'Failed to stop projection' });
  }
});

/** Current projection session snapshot (per-guest states). */
router.get('/projection/status', authenticateToken, (req, res) => {
  try {
    if (!requireProjectionRole(req, res)) return;
    return res.json({ success: true, ...projectionManager.status(), config: projectionManager.config });
  } catch (error) {
    console.error('[agents/projection/status]', error);
    res.status(500).json({ success: false, error: 'Failed to get projection status' });
  }
});

router.post('/installer', authenticateToken, async (req, res) => {
  try {
    const { room, serverUrl, computerName } = req.body;
    
    if (!room || !serverUrl) {
      return res.status(400).json({
        success: false,
        error: 'room and serverUrl are required'
      });
    }

    // Generate unique agent token
    const agentToken = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Create agent configuration
    const config = {
      serverUrl,
      agentToken,
      room,
      computerId: `pc-${Date.now()}`,
      createdAt: new Date(),
      createdBy: req.user.id
    };

    // Store in database for tracking
    await prisma.agent.create({
      data: {
        id: config.computerId,
        hostname: computerName || `PC-${config.computerId.slice(-6)}`,
        mac: 'PENDING_REGISTRATION',
        ip: 'PENDING_REGISTRATION',
        room,
        token: agentToken,
        status: 'OFFLINE',
        createdBy: req.user.id,
        lastSeen: new Date()
      }
    });

    // Generate installation script content
    const installScript = `@echo off
echo ========================================
echo DYCI PC Agent Installer
echo Room: ${room}
echo Server: ${serverUrl}
echo ========================================
echo.

set AGENT_DIR=%ProgramFiles%\\DYCI-Agent
set CONFIG_DIR=%ProgramData%\\DYCI-Agent

:: Create directories
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

:: Create config file
echo {> "%CONFIG_DIR%\\config.json"
echo   "serverUrl": "${serverUrl}",>> "%CONFIG_DIR%\\config.json"
echo   "agentToken": "${agentToken}",>> "%CONFIG_DIR%\\config.json"
echo   "room": "${room}",>> "%CONFIG_DIR%\\config.json"
echo   "computerId": "${config.computerId}",>> "%CONFIG_DIR%\\config.json"
echo   "autoStartVNC": false,>> "%CONFIG_DIR%\\config.json"
echo   "heartbeatInterval": 30000>> "%CONFIG_DIR%\\config.json"
echo }>> "%CONFIG_DIR%\\config.json"

:: Create firewall rule
echo Creating Windows Firewall rule...
netsh advfirewall firewall add rule name="DYCI PC Agent" dir=in action=allow protocol=tcp localport=3001,5900-5905 program="%AGENT_DIR%\\agent.exe" description="Allows DYCI Lab Management Agent to communicate"

:: Install service
echo Installing service...
"%AGENT_DIR%\\agent.exe" --install-service

:: Start service
echo Starting agent...
net start "DYCI PC Agent"

echo.
echo ========================================
echo Installation complete!
echo Agent will connect to: ${serverUrl}
echo Room: ${room}
echo ========================================
pause
`;

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'AGENT_INSTALLER_GENERATED',
      description: `Agent installer config for room "${room}" computerId=${config.computerId} serverUrl=${serverUrl}`,
      ipAddress: clientIp(req),
    });

    res.json({
      success: true,
      message: 'Agent installer configuration generated',
      config: {
        agentToken,
        computerId: config.computerId,
        room,
        serverUrl
      },
      installScript,
      downloadUrl: `/api/agents/download/${config.computerId}`,
      instructions: {
        windows: `Run the following as Administrator on the guest PC:
1. Download agent: ${serverUrl}/api/agents/download/${config.computerId}
2. Run: agent-installer.exe /S /SERVER=${serverUrl} /ROOM=${room}
3. Agent will auto-connect and appear in dashboard`
      }
    });

  } catch (error) {
    console.error('Error generating installer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate installer'
    });
  }
});

export default router;
