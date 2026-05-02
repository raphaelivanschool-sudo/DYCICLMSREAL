const io = require('socket.io-client');
const si = require('systeminformation');
const screenshotDesktop = require('screenshot-desktop');
const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const https = require('https');
const util = require('util');

function normalizeServerUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  return s || 'http://localhost:3001';
}

/**
 * Verifies the same HTTP server Socket.IO uses responds (GET /health).
 */
function checkServerHealth(baseUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(baseUrl);
    } catch {
      resolve({ ok: false, detail: 'Invalid SERVER_URL' });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
    const options = {
      hostname: u.hostname,
      port,
      path: '/health',
      method: 'GET',
      timeout: 5000,
    };
    const req = lib.request(options, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, detail: `HTTP ${res.statusCode}` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, detail: err.message || String(err) });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: 'Connection timed out' });
    });
    req.end();
  });
}

/** Readable Socket.IO / Engine.IO connect errors (avoids "websocket error ([object Object])"). */
function formatSocketConnectError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  const d = err.description;
  if (d != null) {
    if (typeof d === 'string') parts.push(d);
    else if (typeof d === 'object') {
      try {
        parts.push(JSON.stringify(d));
      } catch {
        parts.push(util.inspect(d, { depth: 3 }));
      }
    }
  }
  const inner = err.cause || err.error;
  if (inner) {
    const im = inner.message || inner.code || inner.errno;
    if (im) parts.push(`cause: ${im}`);
  }
  if (err.type) parts.push(`type: ${err.type}`);
  if (err.context && typeof err.context === 'object') {
    try {
      parts.push(`context: ${JSON.stringify(err.context)}`);
    } catch {
      /* ignore */
    }
  }
  const out = parts.filter(Boolean).join(' | ');
  return out || util.inspect(err, { depth: 2, breakLength: 100 });
}

// Configuration
const CONFIG = {
  serverUrl: normalizeServerUrl(process.env.SERVER_URL || 'http://localhost:3001'),
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
const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const BLOCK_START_MARKER = '# DYCICLMS_WEBSITE_BLOCK_START';
const BLOCK_END_MARKER = '# DYCICLMS_WEBSITE_BLOCK_END';

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

    let homeInterface;
    let fallbackInterface;

    if (lanInterface) {
      ipAddress = lanInterface.ip4;
    } else {
      // Second priority: any 192.168.x.x except VirtualBox (192.168.56.x)
      homeInterface = allInterfaces.find(
        iface => iface && iface.ip4 &&
          !iface.internal &&
          iface.ip4.startsWith('192.168.') &&
          !iface.ip4.startsWith('192.168.56.')  // Skip VirtualBox
      );

      if (homeInterface) {
        ipAddress = homeInterface.ip4;
      } else {
        // Fallback: any valid non-localhost IP
        fallbackInterface = allInterfaces.find(
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

    const chosenIface = lanInterface || homeInterface || fallbackInterface;

    // Get logged in user
    const user = await getLoggedInUser();

    return {
      id: CONFIG.computerId,
      name: os.hostname(),
      ip: ipAddress,
      mac: chosenIface && chosenIface.mac ? chosenIface.mac : 'unknown',
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

    const health = await checkServerHealth(CONFIG.serverUrl);
    if (!health.ok) {
      let netHint = '  Check SERVER_URL (use full URL e.g. http://192.168.1.10:3001)';
      try {
        const uu = new URL(CONFIG.serverUrl);
        const p = uu.port || (uu.protocol === 'https:' ? '443' : '80');
        netHint = `  From this PC: Test-NetConnection ${uu.hostname} -Port ${p}`;
      } catch {
        // keep default
      }
      const refused =
        typeof health.detail === 'string' &&
        (health.detail.includes('ECONNREFUSED') || health.detail.includes('refused'));
      const startBackend =
        refused ?
          '\n  On the SERVER PC (the machine at that IP): open this repo, run `npm install` once, then:\n' +
          '    npm run server:dev\n' +
          '  Ensure MySQL is running and server/.env has DATABASE_URL (see HOW_TO_RUN.md).\n' +
          '  Windows Firewall on that PC: allow inbound TCP on port 3001 (or the port in SERVER_URL).\n'
        : '';
      console.error(
        `[Agent] HTTP check failed: ${health.detail}\n` +
          `  Target: ${CONFIG.serverUrl}/health\n` +
          '  Nothing answered — the Lab Management API is not listening there yet.' +
          startBackend +
          '  Or point SERVER_URL at the PC that actually runs the backend.\n' +
          netHint
      );
    }

    socket = io(CONFIG.serverUrl, {
      auth: {
        // In production, use a proper authentication token
        token: process.env.AGENT_TOKEN || 'agent-token-placeholder'
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: CONFIG.maxReconnectAttempts,
      reconnectionDelay: CONFIG.reconnectInterval,
      timeout: 20000,
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
      console.error('Connection error:', formatSocketConnectError(error));
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
  let result = null;

  try {
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
        result = status;
        break;
      case 'set_website_blocklist':
        result = await setWebsiteBlocklist(params?.websites || []);
        break;
      case 'clear_website_blocklist':
        result = await clearWebsiteBlocklist();
        break;
      case 'disable_wifi':
        result = await disableWifiAdapter(params?.adapterName);
        break;
      case 'enable_wifi':
        result = await enableWifiAdapter(params?.adapterName);
        break;
      case 'screenshot':
        result = await takeScreenshot();
        break;
      default:
        console.log(`Unknown command: ${action}`);
        throw new Error(`Unknown command: ${action}`);
    }

    socket.emit('command_result', {
      action,
      success: true,
      result,
      from: command?.from
    });
  } catch (error) {
    console.error(`Error executing command "${action}":`, error.message);
    socket.emit('command_result', {
      action,
      success: false,
      error: error.message || 'Unknown command execution error',
      from: command?.from
    });
  }
}

function sanitizeWebsites(websites) {
  const unique = new Set();
  (Array.isArray(websites) ? websites : []).forEach((entry) => {
    if (!entry || typeof entry !== 'string') return;
    let host = entry.trim().toLowerCase();
    host = host.replace(/^https?:\/\//, '');
    host = host.replace(/^www\./, '');
    host = host.split('/')[0];
    host = host.trim();
    if (host) unique.add(host);
  });
  return Array.from(unique);
}

function buildBlockSection(websites) {
  const lines = [BLOCK_START_MARKER];
  websites.forEach((site) => {
    lines.push(`127.0.0.1 ${site}`);
    lines.push(`127.0.0.1 www.${site}`);
  });
  lines.push(BLOCK_END_MARKER);
  return `\n${lines.join('\n')}\n`;
}

function removeManagedSection(content) {
  const escapedStart = BLOCK_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = BLOCK_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`\\r?\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`, 'g');
  return content.replace(sectionRegex, '\n');
}

async function setWebsiteBlocklist(websites) {
  if (process.platform !== 'win32') {
    throw new Error('Website blocking is only supported on Windows targets');
  }

  const sanitized = sanitizeWebsites(websites);
  if (sanitized.length === 0) {
    throw new Error('No valid websites provided for blocklist');
  }

  try {
    const currentHosts = await fs.readFile(HOSTS_PATH, 'utf8');
    const cleanedHosts = removeManagedSection(currentHosts).trimEnd();
    const blockSection = buildBlockSection(sanitized).replace(/\n/g, '\r\n');
    const nextHosts = `${cleanedHosts}${blockSection}`;
    await fs.writeFile(HOSTS_PATH, nextHosts, 'utf8');
    console.log(`Applied website blocklist for ${sanitized.length} site(s)`);
    return { blockedSites: sanitized };
  } catch (error) {
    throw new Error(`Failed to apply website blocklist: ${error.message}`);
  }
}

async function clearWebsiteBlocklist() {
  if (process.platform !== 'win32') {
    throw new Error('Website blocking is only supported on Windows targets');
  }

  try {
    const currentHosts = await fs.readFile(HOSTS_PATH, 'utf8');
    const cleanedHosts = removeManagedSection(currentHosts);
    await fs.writeFile(HOSTS_PATH, cleanedHosts, 'utf8');
    console.log('Cleared managed website blocklist');
    return { cleared: true };
  } catch (error) {
    throw new Error(`Failed to clear website blocklist: ${error.message}`);
  }
}

async function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function disableWifiAdapter(preferredAdapterName) {
  if (process.platform !== 'win32') {
    throw new Error('Wi-Fi control is only supported on Windows targets');
  }

  const preferred = String(preferredAdapterName || '').trim();
  const escapedPreferred = preferred.replace(/'/g, "''");

  const discoverScript = preferred
    ? `$a = Get-NetAdapter -Name '${escapedPreferred}' -ErrorAction SilentlyContinue; if ($a) { $a.Name }`
    : "(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'Wireless|Wi-Fi|802\\.11' -or $_.Name -match 'Wi-?Fi|Wireless|WLAN') } | Select-Object -First 1 -ExpandProperty Name)";

  const { stdout } = await execCommand(`powershell -NoProfile -Command "${discoverScript}"`);
  const adapterName = stdout.trim();
  if (!adapterName) {
    throw new Error('No active Wi-Fi adapter found');
  }

  const escapedName = adapterName.replace(/'/g, "''");
  const disableScript = `Disable-NetAdapter -Name '${escapedName}' -Confirm:$false -PassThru | Out-Null`;
  await execCommand(`powershell -NoProfile -Command "${disableScript}"`);

  return {
    success: true,
    disabled: true,
    adapter: adapterName,
    message: `Disabled Wi-Fi adapter: ${adapterName}`
  };
}

async function enableWifiAdapter(preferredAdapterName) {
  if (process.platform !== 'win32') {
    throw new Error('Wi-Fi control is only supported on Windows targets');
  }

  const preferred = String(preferredAdapterName || '').trim();
  const escapedPreferred = preferred.replace(/'/g, "''");

  const discoverScript = preferred
    ? `$a = Get-NetAdapter -Name '${escapedPreferred}' -ErrorAction SilentlyContinue; if ($a) { $a.Name }`
    : "(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Disabled' -and ($_.InterfaceDescription -match 'Wireless|Wi-Fi|802\\.11' -or $_.Name -match 'Wi-?Fi|Wireless|WLAN') } | Select-Object -First 1 -ExpandProperty Name)";

  const { stdout: disabledStdout } = await execCommand(`powershell -NoProfile -Command "${discoverScript}"`);
  let adapterName = disabledStdout.trim();

  if (!adapterName) {
    const fallbackScript = "(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Wireless|Wi-Fi|802\\.11' -or $_.Name -match 'Wi-?Fi|Wireless|WLAN' } | Select-Object -First 1 -ExpandProperty Name)";
    const { stdout: anyStdout } = await execCommand(`powershell -NoProfile -Command "${fallbackScript}"`);
    adapterName = anyStdout.trim();
  }

  if (!adapterName) {
    throw new Error('No Wi-Fi adapter found to enable');
  }

  const escapedName = adapterName.replace(/'/g, "''");
  const enableScript = `Enable-NetAdapter -Name '${escapedName}' -Confirm:$false -PassThru | Out-Null`;
  await execCommand(`powershell -NoProfile -Command "${enableScript}"`);

  return {
    success: true,
    enabled: true,
    adapter: adapterName,
    message: `Enabled Wi-Fi adapter: ${adapterName}`
  };
}

/** Capture desktop as PNG for dashboard screen preview (matches agent/pc-agent contract). */
async function takeScreenshot() {
  const imgBuffer = await screenshotDesktop();
  if (!imgBuffer || !imgBuffer.length) {
    throw new Error('Empty screenshot capture');
  }
  const base64 = Buffer.from(imgBuffer).toString('base64');
  return {
    success: true,
    screenshot: base64,
    format: 'png',
    timestamp: new Date().toISOString(),
  };
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
