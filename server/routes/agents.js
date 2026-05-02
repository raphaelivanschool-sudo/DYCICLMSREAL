import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import dgram from 'dgram';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth.js';
import { pickAgentTargetId, resolveLanIpForPcAgent } from '../utils/agentLookup.js';
import {
  getPcAgentApiKey,
  getPcAgentConfigPathTried,
} from '../utils/pcAgentAuth.js';

const router = Router();
const prisma = new PrismaClient();

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
    
    socket.send(packet, 9, '255.255.255.255', (err) => {
      socket.close();
      if (err) {
        console.error('WoL error:', err);
        return res.status(500).json({ error: 'Failed to send wake packet' });
      }
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
router.post('/command', authenticateToken, (req, res) => {
  try {
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

const PC_AGENT_PORT = parseInt(process.env.PC_AGENT_HTTP_PORT || '5555', 10);

/** Forward host screen frame to guest PC Flask agent (Python /project). */
router.post('/projection/frame', authenticateToken, async (req, res) => {
  try {
    const apiKey = getPcAgentApiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error:
          `Python agent API key not configured. Set PC_AGENT_API_KEY in server/.env, ` +
            `or PC_AGENT_CONFIG_PATH to agent_config.json, or place agent_config.json at ${getPcAgentConfigPathTried()} ` +
            `(api_key must match the guest PC Python agent).`,
      });
    }

    const connectedComputers = req.app.get('connectedComputers');
    const { computerId, ip, mac, screenshot, sender_hostname, timestamp } = req.body || {};

    if (!screenshot || typeof screenshot !== 'string') {
      return res.status(400).json({ success: false, error: 'screenshot (base64 JPEG) is required' });
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
          'No online agent matches this PC. Select a row that maps to a connected agent.',
      });
    }

    const lanIp = resolveLanIpForPcAgent(connectedComputers, targetId, ip);
    if (!lanIp) {
      return res.status(400).json({
        success: false,
        error: 'Could not resolve LAN IP for the guest agent (enable discovery IP or fix agent registration).',
      });
    }

    const url = `http://${lanIp}:${PC_AGENT_PORT}/project`;
    let guestResp;
    try {
      guestResp = await axios.post(
        url,
        {
          screenshot,
          sender_hostname: sender_hostname || 'browser-host',
          timestamp: timestamp || new Date().toISOString(),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
    } catch (e) {
      const msg =
        e.code === 'ECONNREFUSED'
          ? `Nothing listening on ${lanIp}:${PC_AGENT_PORT} — run the Python PC agent on the guest.`
          : e.message || 'Forward failed';
      return res.status(502).json({ success: false, error: msg });
    }

    if (guestResp.status !== 200) {
      const detail =
        typeof guestResp.data === 'object' && guestResp.data?.error
          ? guestResp.data.error
          : guestResp.statusText || String(guestResp.status);
      return res.status(502).json({
        success: false,
        error: `Guest agent HTTP ${guestResp.status}: ${detail}`,
      });
    }

    return res.json({
      success: true,
      resolvedComputerId: targetId,
      resolutionStrategy: strategy,
      forwardedTo: url,
    });
  } catch (error) {
    console.error('[agents/projection/frame]', error);
    res.status(500).json({ success: false, error: 'Projection forward failed' });
  }
});

/** Ask guest Flask agent to close fullscreen projection. */
router.post('/projection/stop', authenticateToken, async (req, res) => {
  try {
    const apiKey = getPcAgentApiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error:
          `Python agent API key not configured. Set PC_AGENT_API_KEY or sync agent_config.json (see ${getPcAgentConfigPathTried()}).`,
      });
    }

    const connectedComputers = req.app.get('connectedComputers');
    const { computerId, ip, mac } = req.body || {};

    const { targetId, strategy } = pickAgentTargetId(connectedComputers, {
      computerId,
      ip,
      mac,
    });

    if (!targetId) {
      return res.status(404).json({
        success: false,
        error: 'No online agent matches this PC.',
      });
    }

    const lanIp = resolveLanIpForPcAgent(connectedComputers, targetId, ip);
    if (!lanIp) {
      return res.status(400).json({
        success: false,
        error: 'Could not resolve LAN IP for the guest agent.',
      });
    }

    const url = `http://${lanIp}:${PC_AGENT_PORT}/stop_projection`;
    try {
      const guestResp = await axios.post(
        url,
        {},
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
          validateStatus: () => true,
        },
      );
      if (guestResp.status !== 200) {
        const detail =
          typeof guestResp.data === 'object' && guestResp.data?.error
            ? guestResp.data.error
            : guestResp.statusText || String(guestResp.status);
        return res.status(502).json({
          success: false,
          error: `Guest agent HTTP ${guestResp.status}: ${detail}`,
        });
      }
      return res.json({
        success: true,
        resolvedComputerId: targetId,
        resolutionStrategy: strategy,
        forwardedTo: url,
      });
    } catch (e) {
      const msg =
        e.code === 'ECONNREFUSED'
          ? `Nothing listening on ${lanIp}:${PC_AGENT_PORT}`
          : e.message || 'Forward failed';
      return res.status(502).json({ success: false, error: msg });
    }
  } catch (error) {
    console.error('[agents/projection/stop]', error);
    res.status(500).json({ success: false, error: 'Stop projection failed' });
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
