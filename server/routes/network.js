import express from 'express';
import rateLimit from 'express-rate-limit';
import NetworkScanner from '../utils/network-scanner.js';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import { recordActivity, clientIp } from '../utils/activityLog.js';

const prisma = new PrismaClient();
const router = express.Router();

// Rate limiting for network scans
const scanLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // limit each IP to 3 scans per windowMs
  message: {
    error: 'Too many network scan requests. Please try again later.',
    retryAfter: '5 minutes'
  }
});

// Create a singleton instance of the scanner
const networkScanner = new NetworkScanner();

// Store active scan connections (for WebSocket updates)
const activeScans = new Map();

function getActiveSubnets() {
  const interfaces = os.networkInterfaces();
  const subnets = new Set();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        const parts = iface.address.split('.');
        if (parts.length === 4) {
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
  }
  return Array.from(subnets);
}

// Start network scan
router.post('/scan', scanLimiter, async (req, res) => {
  try {
    const { range } = req.body;
    const userId = req.user.id;

    // Check if user already has an active scan
    if (activeScans.has(userId)) {
      return res.status(400).json({
        error: 'You already have an active scan in progress'
      });
    }

    // Start scan in background with real-time device discovery
    const scanPromise = networkScanner.scanNetwork(
      range,
      (progress, devicesFound) => {
        // Emit progress via WebSocket if available
        const io = req.app.get('io');
        if (io) {
          io.to(`user_${userId}`).emit('scan_progress', {
            progress,
            devicesFound,
            userId
          });
        }
      },
      (device) => {
        // Real-time device found callback
        const io = req.app.get('io');
        const connectedComputers = req.app.get('connectedComputers');
        
        // Skip if this device matches an agent-connected IP
        if (connectedComputers) {
          for (const computerData of connectedComputers.values()) {
            if (computerData.computer.ip === device.ip) {
              return; // Skip this device - agent already provides better data
            }
          }
        }
        
        if (io) {
          io.to(`user_${userId}`).emit('device_found', {
            device,
            userId
          });
        }
      }
    );

    // Store scan promise for this user
    activeScans.set(userId, scanPromise);

    // Clean up when scan completes
    scanPromise.finally(() => {
      activeScans.delete(userId);
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'NETWORK_SCAN_STARTED',
      description: `Network scan started range=${range || 'default'}`,
      ipAddress: clientIp(req),
    });

    res.json({
      message: 'Network scan started',
      scanId: userId
    });

  } catch (error) {
    console.error('Error starting network scan:', error);
    res.status(500).json({
      error: 'Failed to start network scan',
      details: error.message
    });
  }
});

// Start server-local multi-subnet scan (no agent required)
router.post('/server-scan', scanLimiter, async (req, res) => {
  try {
    const userId = req.user.id;

    if (activeScans.has(userId)) {
      return res.status(400).json({
        error: 'You already have an active scan in progress'
      });
    }

    const subnets = getActiveSubnets();
    if (subnets.length === 0) {
      return res.status(400).json({
        error: 'No active IPv4 network interfaces found on the server'
      });
    }

    const io = req.app.get('io');

    const scanPromise = (async () => {
      let totalDevicesFound = 0;

      for (let i = 0; i < subnets.length; i++) {
        const subnet = subnets[i];

        await networkScanner.scanNetwork(
          subnet,
          (progress, devicesFound) => {
            totalDevicesFound = Math.max(totalDevicesFound, devicesFound);
            const overallProgress = Math.round(((i + (progress / 100)) / subnets.length) * 100);
            if (io) {
              io.to(`user_${userId}`).emit('scan_progress', {
                progress: overallProgress,
                devicesFound: totalDevicesFound,
                subnet: `${subnet}.0/24`,
                userId
              });
            }
          },
          (device) => {
            const connectedComputers = req.app.get('connectedComputers');

            if (connectedComputers) {
              for (const computerData of connectedComputers.values()) {
                if (computerData.computer.ip === device.ip) {
                  return;
                }
              }
            }

            if (io) {
              io.to(`user_${userId}`).emit('device_found', {
                device,
                subnet: `${subnet}.0/24`,
                userId
              });
            }
          }
        );
      }

      if (io) {
        io.to(`user_${userId}`).emit('scan_complete', {
          count: networkScanner.getDiscoveredDevices().length,
          subnets: subnets.map((s) => `${s}.0/24`),
          userId
        });
      }
    })();

    activeScans.set(userId, scanPromise);
    scanPromise.finally(() => {
      activeScans.delete(userId);
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'NETWORK_SERVER_SCAN_STARTED',
      description: `Server multi-subnet scan: ${subnets.map((s) => `${s}.0/24`).join(', ')}`,
      ipAddress: clientIp(req),
    });

    res.json({
      message: 'Server subnet scan started',
      subnets: subnets.map((s) => `${s}.0/24`),
      scanId: userId
    });
  } catch (error) {
    console.error('Error starting server scan:', error);
    res.status(500).json({
      error: 'Failed to start server scan',
      details: error.message
    });
  }
});

// Get scan status
router.get('/status', (req, res) => {
  try {
    const status = networkScanner.getScanStatus();
    const hasActiveScan = activeScans.has(req.user.id);

    res.json({
      ...status,
      hasActiveScan,
      canScan: !hasActiveScan && !status.isScanning
    });

  } catch (error) {
    console.error('Error getting scan status:', error);
    res.status(500).json({
      error: 'Failed to get scan status'
    });
  }
});

// Get discovered devices
router.get('/devices', (req, res) => {
  try {
    const devices = networkScanner.getDiscoveredDevices();
    const connectedComputers = req.app.get('connectedComputers');
    
    // Filter out network devices that match agent-connected IPs
    // to prevent duplicates like "PC-125" overwriting real agent data
    const agentIPs = new Set();
    if (connectedComputers) {
      for (const computerData of connectedComputers.values()) {
        agentIPs.add(computerData.computer.ip);
      }
    }
    
    const filteredDevices = devices.filter(device => !agentIPs.has(device.ip));
    
    res.json({
      devices: filteredDevices,
      count: filteredDevices.length,
      lastScan: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error getting devices:', error);
    res.status(500).json({
      error: 'Failed to get discovered devices'
    });
  }
});

// Cancel active scan
router.post('/cancel', (req, res) => {
  try {
    const userId = req.user.id;
    
    if (activeScans.has(userId)) {
      // Note: The current implementation doesn't support cancellation
      // You would need to modify the NetworkScanner class to support this
      activeScans.delete(userId);
      
      res.json({
        message: 'Scan cancelled'
      });
    } else {
      res.status(400).json({
        error: 'No active scan found'
      });
    }

  } catch (error) {
    console.error('Error cancelling scan:', error);
    res.status(500).json({
      error: 'Failed to cancel scan'
    });
  }
});

// Register discovered device
router.post('/register', async (req, res) => {
  try {
    const { deviceId, name, ip, mac, deviceType, os } = req.body;
    
    // This would integrate with your existing computer/database system
    // For now, just return success
    
    res.json({
      message: 'Device registered successfully',
      device: {
        id: deviceId,
        name,
        ip,
        mac,
        deviceType,
        os,
        registeredAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({
      error: 'Failed to register device'
    });
  }
});

export default router;
