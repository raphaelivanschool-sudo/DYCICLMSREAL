const io = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');

// Configuration
const CONFIG = {
  serverUrl: process.env.SERVER_URL || 'http://localhost:3001',
  computerId: process.env.COMPUTER_ID || `${os.hostname()}-${Math.random().toString(36).substr(2, 9)}`,
  heartbeatInterval: 30000, // 30 seconds
  statusUpdateInterval: 5000, // 5 seconds
  reconnectInterval: 5000, // 5 seconds
  maxReconnectAttempts: 10
};

// Agent state
let socket = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let statusUpdateTimer = null;
let isRegistered = false;

// Get computer information
async function getComputerInfo() {
  try {
    const [system, cpu, mem, osInfo, network, graphics] = await Promise.all([
      si.system(),
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.networkInterfaces(),
      si.graphics()
    ]);

    // Get IP address - prioritize 192.168.0.x LAN subnet
    let ipAddress = '127.0.0.1';
    const allInterfaces = Object.values(network).flat();
    
    // First priority: 192.168.0.x (where test PC should be)
    const lanInterface = allInterfaces.find(
      iface => iface && iface.ip4 && 
        !iface.internal && 
        iface.ip4.startsWith('192.168.0.')
    );
    
    if (lanInterface) {
      ipAddress = lanInterface.ip4;
    } else {
      // Second priority: any 192.168.x.x except VirtualBox (192.168.56.x)
      const homeInterface = allInterfaces.find(
        iface => iface && iface.ip4 && 
          !iface.internal && 
          iface.ip4.startsWith('192.168.') &&
          !iface.ip4.startsWith('192.168.56.')  // Skip VirtualBox
      );
      
      if (homeInterface) {
        ipAddress = homeInterface.ip4;
      } else {
        // Fallback: any valid non-localhost IP
        const fallbackInterface = allInterfaces.find(
          iface => iface && iface.ip4 && 
            !iface.internal && 
            !iface.ip4.startsWith('127.') &&
            !iface.ip4.startsWith('0.') &&
            !iface.ip4.startsWith('169.254.')
        );
        if (fallbackInterface) {
          ipAddress = fallbackInterface.ip4;
        }
      }
    }

    // Get logged in user
    const user = await getLoggedInUser();

    return {
      id: CONFIG.computerId,
      name: os.hostname(),
      ip: ipAddress,
      mac: validInterface ? validInterface.mac : 'unknown',
      platform: osInfo.platform,
      distro: osInfo.distro,
      release: osInfo.release,
      arch: osInfo.arch,
      hostname: os.hostname(),
      specs: {
        cpu: cpu.brand,
        cores: cpu.cores,
        memory: Math.round(mem.total / (1024 * 1024 * 1024)) + ' GB',
        storage: 'Unknown', // Would need additional query
        graphics: graphics.controllers[0]?.model || 'Unknown'
      },
      user: user,
      status: 'online'
    };
  } catch (error) {
    console.error('Error getting computer info:', error);
    return {
      id: CONFIG.computerId,
      name: os.hostname(),
      ip: '127.0.0.1',
      user: 'Unknown',
      status: 'online'
    };
  }
}

// Get currently logged in user
async function getLoggedInUser() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('echo %USERNAME%', (error, stdout) => {
        if (error) {
          resolve('Unknown');
        } else {
          resolve(stdout.trim() || 'Unknown');
        }
      });
    } else {
      exec('whoami', (error, stdout) => {
        if (error) {
          resolve('Unknown');
        } else {
          resolve(stdout.trim() || 'Unknown');
        }
      });
    }
  });
}

// Get current system status
async function getSystemStatus() {
  try {
    const [cpu, mem, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.processes()
    ]);

    const user = await getLoggedInUser();

    return {
      computerId: CONFIG.computerId,
      status: 'online',
      user: user,
      cpu: cpu.currentLoad.toFixed(1),
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        percentage: ((mem.used / mem.total) * 100).toFixed(1)
      },
      processes: processes.all,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error getting system status:', error);
    return {
      computerId: CONFIG.computerId,
      status: 'online',
      user: 'Unknown',
      timestamp: new Date().toISOString()
    };
  }
}

// Connect to server
async function connect() {
  try {
    console.log(`Connecting to server: ${CONFIG.serverUrl}`);

    socket = io(CONFIG.serverUrl, {
      auth: {
        // In production, use a proper authentication token
        token: process.env.AGENT_TOKEN || 'agent-token-placeholder'
      },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: CONFIG.maxReconnectAttempts,
      reconnectionDelay: CONFIG.reconnectInterval
    });

    // Handle connection
    socket.on('connect', async () => {
      console.log('Connected to server');
      reconnectAttempts = 0;

      // Register this computer
      const computerInfo = await getComputerInfo();
      socket.emit('agent_register', computerInfo);
    });

    // Handle registration confirmation
    socket.on('agent_registered', (response) => {
      if (response.success) {
        console.log('Agent registered successfully');
        isRegistered = true;
        
        // Start heartbeat
        startHeartbeat();
        
        // Start status updates
        startStatusUpdates();
      }
    });

    // Handle commands from server
    socket.on('execute_command', async (command) => {
      console.log('Received command:', command);
      await executeCommand(command);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`Disconnected from server: ${reason}`);
      isRegistered = false;
      stopHeartbeat();
      stopStatusUpdates();
    });

    // Handle errors
    socket.on('connect_error', (error) => {
      console.error('Connection error:', error.message);
      reconnectAttempts++;
      
      if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
        console.error('Max reconnection attempts reached. Giving up.');
        process.exit(1);
      }
    });

  } catch (error) {
    console.error('Error connecting to server:', error);
  }
}

// Execute commands from server
async function executeCommand(command) {
  const { action, params } = command;

  switch (action) {
    case 'lock':
      await lockComputer();
      break;
    case 'logout':
      await logoutUser();
      break;
    case 'restart':
      await restartComputer();
      break;
    case 'shutdown':
      await shutdownComputer();
      break;
    case 'message':
      await showMessage(params.message);
      break;
    case 'get_status':
      const status = await getSystemStatus();
      socket.emit('agent_status_update', status);
      break;
    default:
      console.log(`Unknown command: ${action}`);
  }
}

// Lock computer (Windows)
async function lockComputer() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('rundll32.exe user32.dll,LockWorkStation', (error) => {
        if (error) {
          console.error('Error locking computer:', error);
        } else {
          console.log('Computer locked successfully');
        }
        resolve();
      });
    } else {
      console.log('Lock command not implemented for this platform');
      resolve();
    }
  });
}

// Logout user (Windows)
async function logoutUser() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('shutdown /l', (error) => {
        if (error) {
          console.error('Error logging out user:', error);
        } else {
          console.log('User logged out successfully');
        }
        resolve();
      });
    } else {
      console.log('Logout command not implemented for this platform');
      resolve();
    }
  });
}

// Restart computer (Windows)
async function restartComputer() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('shutdown /r /t 0', (error) => {
        if (error) {
          console.error('Error restarting computer:', error);
        }
        resolve();
      });
    } else {
      console.log('Restart command not implemented for this platform');
      resolve();
    }
  });
}

// Shutdown computer (Windows)
async function shutdownComputer() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('shutdown /s /t 0', (error) => {
        if (error) {
          console.error('Error shutting down computer:', error);
        }
        resolve();
      });
    } else {
      console.log('Shutdown command not implemented for this platform');
      resolve();
    }
  });
}

// Show message to user
async function showMessage(message) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`msg * "${message}"`, (error) => {
        if (error) {
          console.error('Error showing message:', error);
        } else {
          console.log('Message shown successfully');
        }
        resolve();
      });
    } else {
      console.log(`Message: ${message}`);
      resolve();
    }
  });
}

// Start heartbeat
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    if (socket && isRegistered) {
      socket.emit('agent_heartbeat', {
        computerId: CONFIG.computerId,
        timestamp: new Date().toISOString()
      });
    }
  }, CONFIG.heartbeatInterval);
}

// Stop heartbeat
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Start status updates
function startStatusUpdates() {
  statusUpdateTimer = setInterval(async () => {
    if (socket && isRegistered) {
      const status = await getSystemStatus();
      socket.emit('agent_status_update', status);
    }
  }, CONFIG.statusUpdateInterval);
}

// Stop status updates
function stopStatusUpdates() {
  if (statusUpdateTimer) {
    clearInterval(statusUpdateTimer);
    statusUpdateTimer = null;
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('Shutting down agent...');
  stopHeartbeat();
  stopStatusUpdates();
  if (socket) {
    socket.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down agent...');
  stopHeartbeat();
  stopStatusUpdates();
  if (socket) {
    socket.disconnect();
  }
  process.exit(0);
});

// Start the agent
console.log('DYCICLMS PC Agent starting...');
console.log(`Computer ID: ${CONFIG.computerId}`);
connect();
