#!/usr/bin/env node
/**
 * UDP Broadcast Service Discovery Test
 * 
 * This script tests the UDP broadcast discovery functionality
 * for TightVNC services on the local network.
 */

import dgram from 'dgram';
import os from 'os';

const DISCOVERY_PORT = 41234;

// Create UDP socket to listen for broadcasts
const socket = dgram.createSocket('udp4');

socket.on('error', (err) => {
  console.error('[Test] Socket error:', err.message);
});

socket.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    console.log('[Test] Received broadcast from:', rinfo.address);
    console.log('[Test] Data:', JSON.stringify(data, null, 2));
    console.log('---');
  } catch (err) {
    console.log('[Test] Invalid message from', rinfo.address, ':', msg.toString());
  }
});

socket.on('listening', () => {
  const address = socket.address();
  console.log('[Test] Listening for TightVNC broadcasts on', address.address + ':' + address.port);
  console.log('[Test] Waiting for announcements from agents...\n');
});

// Bind to discovery port
socket.bind(DISCOVERY_PORT, () => {
  socket.setBroadcast(true);
});

// Show local network info
console.log('[Test] Local network interfaces:');
const interfaces = os.networkInterfaces();
for (const name of Object.keys(interfaces)) {
  for (const iface of interfaces[name]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      console.log(`  ${name}: ${iface.address} (netmask: ${iface.netmask})`);
    }
  }
}
console.log('');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Test] Shutting down...');
  socket.close();
  process.exit(0);
});
