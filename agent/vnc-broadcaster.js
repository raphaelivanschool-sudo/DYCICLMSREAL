#!/usr/bin/env node
/**
 * Standalone TightVNC Service Broadcaster
 * 
 * This lightweight script can be run on target PCs to broadcast
 * TightVNC availability via UDP, allowing instant discovery by
 * the DYCI PC Control Panel.
 * 
 * Usage:
 *   node vnc-broadcaster.js
 * 
 * Or as a Windows service using node-windows
 */

import dgram from 'dgram';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONFIG = {
  DISCOVERY_PORT: 41234,
  BROADCAST_INTERVAL: 30000, // 30 seconds
  VNC_PORT: 5900,
  COMPUTER_ID: os.hostname().replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
};

class VNCBroadcaster {
  constructor() {
    this.socket = null;
    this.intervalId = null;
    this.isRunning = false;
  }

  async getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
          return iface.address;
        }
      }
    }
    // Fallback to any non-internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '0.0.0.0';
  }

  getBroadcastAddresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const ip = iface.address;
          const netmask = iface.netmask;
          if (ip && netmask) {
            const ipParts = ip.split('.').map(Number);
            const maskParts = netmask.split('.').map(Number);
            const broadcastParts = ipParts.map((part, i) => part | (~maskParts[i] & 255));
            addresses.push(broadcastParts.join('.'));
          }
        }
      }
    }
    
    if (addresses.length === 0) {
      addresses.push('255.255.255.255');
    }
    
    return addresses;
  }

  async isVNCRunning() {
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq tvnserver.exe" /FO CSV /NH');
      return stdout.includes('tvnserver.exe');
    } catch (error) {
      return false;
    }
  }

  async sendAnnouncement() {
    if (!this.socket) return;

    const localIP = await this.getLocalIP();
    const vncRunning = await this.isVNCRunning();
    
    const announcement = {
      type: 'tightvnc-announce',
      computerId: CONFIG.COMPUTER_ID,
      hostname: os.hostname(),
      ip: localIP,
      port: CONFIG.VNC_PORT,
      hasAgent: false, // This is the standalone broadcaster
      vncRunning: vncRunning,
      timestamp: new Date().toISOString()
    };

    const message = Buffer.from(JSON.stringify(announcement));
    const broadcastAddresses = this.getBroadcastAddresses();

    for (const broadcastAddr of broadcastAddresses) {
      this.socket.send(message, CONFIG.DISCOVERY_PORT, broadcastAddr, (err) => {
        if (err) {
          console.log(`[Broadcaster] Failed to send to ${broadcastAddr}: ${err.message}`);
        } else {
          console.log(`[Broadcaster] Announcement sent to ${broadcastAddr}:${CONFIG.DISCOVERY_PORT} (VNC ${vncRunning ? 'running' : 'stopped'})`);
        }
      });
    }
  }

  start() {
    if (this.isRunning) {
      console.log('[Broadcaster] Already running');
      return;
    }

    this.socket = dgram.createSocket('udp4');
    
    this.socket.on('error', (err) => {
      console.error('[Broadcaster] Socket error:', err);
    });

    this.socket.on('listening', () => {
      this.socket.setBroadcast(true);
      console.log('[Broadcaster] TightVNC Service Broadcaster started');
      console.log(`[Broadcaster] Computer: ${os.hostname()} (${CONFIG.COMPUTER_ID})`);
      console.log(`[Broadcaster] Broadcasting every ${CONFIG.BROADCAST_INTERVAL / 1000}s on port ${CONFIG.DISCOVERY_PORT}`);
      console.log('');
      
      // Send initial announcement
      this.sendAnnouncement();
      
      // Set up periodic broadcasts
      this.intervalId = setInterval(() => {
        this.sendAnnouncement();
      }, CONFIG.BROADCAST_INTERVAL);
    });

    // Bind to any available port
    this.socket.bind(0, () => {
      this.socket.setBroadcast(true);
    });

    this.isRunning = true;
  }

  stop() {
    if (!this.isRunning) return;
    
    console.log('[Broadcaster] Stopping...');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    
    this.isRunning = false;
    console.log('[Broadcaster] Stopped');
  }
}

// Create and start broadcaster
const broadcaster = new VNCBroadcaster();

// Handle graceful shutdown
process.on('SIGINT', () => {
  broadcaster.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  broadcaster.stop();
  process.exit(0);
});

// Start broadcasting
broadcaster.start();
