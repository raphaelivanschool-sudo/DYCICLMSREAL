import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import dgram from 'dgram';
import { authenticateToken } from '../middleware/auth.js';
import { resolveComputerIdFromConnectedAgents } from '../utils/agentLookup.js';

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

    let targetId =
      computerId ||
      resolveComputerIdFromConnectedAgents(connectedComputers, { ip, mac });

    if (!targetId) {
      return res.status(404).json({
        success: false,
        error:
          'No online agent matches this PC. Ensure the DYCI agent is running and try the LAN IP shown in Agent discovery (not only a scan-only row).',
      });
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
    });
  } catch (error) {
    console.error('Error sending command to agent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send command',
    });
  }
});

// POST /api/agents/installer - Generate agent installer configuration
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
