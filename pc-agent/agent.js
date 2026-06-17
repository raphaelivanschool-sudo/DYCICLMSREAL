const io = require('socket.io-client');
const si = require('systeminformation');
const screenshotDesktop = require('screenshot-desktop');
const os = require('os');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const https = require('https');
const util = require('util');

// --- Locked Demo Mode projection (host screen broadcast) ---
// The Node agent receives projection_* events over Socket.IO and renders the
// host screen in a LOCKED Python overlay (projection_overlay.py) that the guest
// cannot dismiss. Node writes each JPEG frame to a temp file the overlay reads,
// and keeps a heartbeat file fresh; the overlay self-tears-down (restoring input)
// if the heartbeat goes stale — so a crashed agent never leaves a guest locked.
const PROJECTION_FRAME_PATH = path.join(os.tmpdir(), 'dyci_projection_frame.jpg');
const PROJECTION_FRAME_TMP  = PROJECTION_FRAME_PATH + '.tmp';
const PROJECTION_HEARTBEAT_PATH = path.join(os.tmpdir(), 'dyci_projection.alive');

const projection = {
  active: false,
  sessionId: null,
  overlayProc: null,
  lastSeq: -1,
  lastActivity: 0,        // epoch ms of last frame OR ping
  watchdogSeconds: 8,
  watchdogTimer: null,
  stopping: false,
};

function normalizeServerUrl(url) {
  let s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return 'http://localhost:3001';
  // Accept a bare IP or host (e.g. "172.24.112.1" or "172.24.112.1:3001"):
  // add the scheme, then default the port to 3001 if none was given.
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.port) u.port = '3001';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return 'http://localhost:3001';
  }
}

// --- Server selection ----------------------------------------------------
// Decide which server (IP/URL) to connect to. Precedence, highest first:
//   1. CLI flag    --server <ip|url>   or   --use <profileName>
//   2. Env var     SERVER_URL
//   3. Config file pc-agent/agent.config.json  (active profile, or serverUrl)
//   4. Default     http://localhost:3001
const CONFIG_PATH = path.join(__dirname, 'agent.config.json');

function loadConfigFile() {
  try {
    return JSON.parse(fsSync.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server' || a === '-s') { out.server = argv[++i]; }
    else if (a.startsWith('--server=')) { out.server = a.slice('--server='.length); }
    else if (a === '--use' || a === '-u') { out.use = argv[++i]; }
    else if (a.startsWith('--use=')) { out.use = a.slice('--use='.length); }
    else if (a === '--id') { out.id = argv[++i]; }
    else if (a.startsWith('--id=')) { out.id = a.slice('--id='.length); }
  }
  return out;
}

const fileConfig = loadConfigFile();
const cliArgs = parseCliArgs(process.argv.slice(2));

function resolveServerUrl() {
  const servers = fileConfig.knownServers || {};
  // 1. CLI --server <ip|url>
  if (cliArgs.server) {
    return { url: normalizeServerUrl(cliArgs.server), source: 'CLI --server' };
  }
  // 1b. CLI --use <profile>
  if (cliArgs.use) {
    if (servers[cliArgs.use]) {
      return { url: normalizeServerUrl(servers[cliArgs.use]), source: `CLI --use "${cliArgs.use}"` };
    }
    console.warn(`[Config] Unknown profile "--use ${cliArgs.use}". Known: ${Object.keys(servers).join(', ') || '(none)'}`);
  }
  // 2. SERVER_URL env var (keeps PowerShell / Windows-service behavior working)
  if (process.env.SERVER_URL) {
    return { url: normalizeServerUrl(process.env.SERVER_URL), source: 'env SERVER_URL' };
  }
  // 3. config file: active named profile, then explicit serverUrl
  if (fileConfig.active && servers[fileConfig.active]) {
    return { url: normalizeServerUrl(servers[fileConfig.active]), source: `config active "${fileConfig.active}"` };
  }
  if (fileConfig.serverUrl) {
    return { url: normalizeServerUrl(fileConfig.serverUrl), source: 'config serverUrl' };
  }
  // 4. default
  return { url: 'http://localhost:3001', source: 'default' };
}

const resolvedServer = resolveServerUrl();

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
  serverUrl: resolvedServer.url,
  computerId: cliArgs.id || process.env.COMPUTER_ID || fileConfig.computerId || `${os.hostname()}-${Math.random().toString(36).substr(2, 9)}`,
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

    // Locked Demo Mode: host wants to start projecting onto this guest.
    socket.on('projection_start', async (data) => {
      try {
        await startProjection(data || {});
      } catch (err) {
        console.error('[Projection] start error:', err.message);
        sendProjectionAck('error', err.message || 'Failed to start overlay');
      }
    });

    // High-frequency frame delivery — newest seq wins, stale frames dropped.
    socket.on('projection_frame', async (data) => {
      try {
        const { session_id, seq, screenshot } = data || {};
        if (!projection.active || session_id !== projection.sessionId) return;
        if (!screenshot || typeof screenshot !== 'string') return;
        if (typeof seq === 'number' && seq <= projection.lastSeq) return; // drop stale/out-of-order
        if (typeof seq === 'number') projection.lastSeq = seq;
        const buf = Buffer.from(screenshot, 'base64');
        await fs.writeFile(PROJECTION_FRAME_TMP, buf);
        await fs.rename(PROJECTION_FRAME_TMP, PROJECTION_FRAME_PATH);
        await touchProjectionHeartbeat();
      } catch (err) {
        console.error('[Projection] Frame write error:', err.message);
      }
    });

    // Heartbeat keeps the overlay alive even when frames stall; reply with pong.
    socket.on('projection_ping', async (data) => {
      const { session_id, ts } = data || {};
      if (!projection.active || session_id !== projection.sessionId) return;
      await touchProjectionHeartbeat();
      if (socket) socket.emit('projection_pong', { session_id, ts: ts || Date.now() });
    });

    // Stop is honored unconditionally and immediately.
    socket.on('projection_stop', async (data) => {
      const { session_id } = data || {};
      // Accept stop for the active session, or a bare stop with no id (safety).
      if (session_id && projection.sessionId && session_id !== projection.sessionId) return;
      await stopProjection('host_stop');
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`Disconnected from server: ${reason}`);
      isRegistered = false;
      stopHeartbeat();
      stopStatusUpdates();
      // Fail-open: lost the server → tear down any locked overlay so the guest
      // is never left locked. (The overlay's own watchdog is the final backstop.)
      if (projection.active) {
        stopProjection('server_disconnected').catch(() => {});
      }
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

// ---- Locked overlay subprocess management ----

/** Send a projection acknowledgement back to the server. */
function sendProjectionAck(state, detail) {
  if (socket && socket.connected) {
    socket.emit('projection_ack', {
      session_id: projection.sessionId,
      state,
      detail: detail || null,
    });
  }
}

/** Locate projection_overlay.py — config/env override, then known repo layouts. */
function resolveOverlayScript() {
  const candidates = [
    process.env.PROJECTION_OVERLAY_PATH,
    fileConfig.overlayScript,
    path.join(__dirname, 'projection_overlay.py'),
    path.join(__dirname, 'python', 'projection_overlay.py'),
    path.join(__dirname, '..', 'agent', 'pc-agent', 'python', 'projection_overlay.py'),
    path.join(__dirname, '..', 'pc-agent', 'python', 'projection_overlay.py'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/** Pick a Python launcher that hides the console window when possible. */
function resolvePythonCommand() {
  if (process.env.PROJECTION_PYTHON) return process.env.PROJECTION_PYTHON;
  if (process.platform === 'win32') return 'pythonw.exe';
  return 'python3';
}

/** Touch/refresh the heartbeat file the overlay watchdog reads. */
async function touchProjectionHeartbeat() {
  projection.lastActivity = Date.now();
  try {
    await fs.writeFile(PROJECTION_HEARTBEAT_PATH, String(projection.lastActivity));
  } catch (err) {
    console.error('[Projection] heartbeat write failed:', err.message);
  }
}

/** Spawn the locked Python overlay for the given session. */
function spawnOverlay() {
  const script = resolveOverlayScript();
  if (!script) {
    throw new Error(
      'projection_overlay.py not found. Set PROJECTION_OVERLAY_PATH or place it beside the agent.',
    );
  }
  const py = resolvePythonCommand();
  const args = [
    script,
    '--frame', PROJECTION_FRAME_PATH,
    '--heartbeat', PROJECTION_HEARTBEAT_PATH,
    '--watchdog', String(projection.watchdogSeconds),
    '--session', projection.sessionId || '',
  ];
  const proc = spawn(py, args, { detached: false, stdio: 'ignore', windowsHide: true });
  proc.on('exit', (code) => {
    console.log(`[Projection] Overlay exited (code ${code})`);
    if (projection.overlayProc === proc) projection.overlayProc = null;
    // Supervisor: if the overlay died mid-session (not during teardown), relaunch.
    if (projection.active && !projection.stopping) {
      try {
        projection.overlayProc = spawnOverlay();
        console.log('[Projection] Overlay relaunched by supervisor');
      } catch (err) {
        console.error('[Projection] relaunch failed:', err.message);
        sendProjectionAck('error', `Overlay crashed and relaunch failed: ${err.message}`);
      }
    }
  });
  return proc;
}

/** Start a locked projection session on this guest. */
async function startProjection(data) {
  const sessionId = data.session_id || `local-${Date.now()}`;
  const watchdog = parseInt(data.watchdog_seconds, 10);
  // Already projecting this session → re-ack and continue (idempotent late-joiner resend).
  if (projection.active && projection.sessionId === sessionId) {
    sendProjectionAck('projecting', 'Already active');
    return;
  }
  // Different session active → swap to the new one cleanly.
  if (projection.active) await stopProjection('superseded');

  projection.active = true;
  projection.stopping = false;
  projection.sessionId = sessionId;
  projection.lastSeq = -1;
  projection.watchdogSeconds = Number.isFinite(watchdog) ? watchdog : 8;

  // Clear any stale frame so the overlay shows the "presenting…" placeholder first.
  try { await fs.unlink(PROJECTION_FRAME_PATH); } catch { /* ignore */ }
  await touchProjectionHeartbeat();

  projection.overlayProc = spawnOverlay();
  console.log('[Projection] Overlay started PID:', projection.overlayProc.pid);

  // Node-side watchdog: if no frame/ping arrives within the window, fail open.
  if (projection.watchdogTimer) clearInterval(projection.watchdogTimer);
  projection.watchdogTimer = setInterval(() => {
    if (!projection.active) return;
    const idle = Date.now() - projection.lastActivity;
    if (idle > projection.watchdogSeconds * 1000) {
      console.warn(`[Projection] watchdog timeout (${idle}ms) — tearing down`);
      stopProjection('watchdog_timeout').catch(() => {});
    }
  }, 1000);

  sendProjectionAck('projecting', null);
}

/** Stop the projection session and restore the guest to normal (idempotent). */
async function stopProjection(reason) {
  if (!projection.active && !projection.overlayProc) {
    sendProjectionAck('stopped', reason || null);
    return;
  }
  projection.stopping = true;
  projection.active = false;

  if (projection.watchdogTimer) {
    clearInterval(projection.watchdogTimer);
    projection.watchdogTimer = null;
  }

  // Graceful stop first: removing the heartbeat tells the overlay to exit and
  // restore input/taskbar cleanly. Force-kill as a fallback shortly after.
  try { await fs.unlink(PROJECTION_HEARTBEAT_PATH); } catch { /* ignore */ }

  const proc = projection.overlayProc;
  projection.overlayProc = null;
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    const pid = proc.pid;
    setTimeout(() => {
      if (process.platform === 'win32') {
        try { exec(`taskkill /PID ${pid} /T /F`, () => {}); } catch { /* ignore */ }
      } else {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 1500);
  }

  try { await fs.unlink(PROJECTION_FRAME_PATH); } catch { /* ignore */ }
  try { await fs.unlink(PROJECTION_FRAME_TMP);  } catch { /* ignore */ }

  console.log(`[Projection] Stopped (${reason || 'stop'})`);
  sendProjectionAck('stopped', reason || null);
  projection.sessionId = null;
  projection.stopping = false;
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
process.on('SIGINT', async () => {
  console.log('Shutting down agent...');
  stopHeartbeat();
  stopStatusUpdates();
  await stopProjection('agent_shutdown');
  if (socket) {
    socket.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down agent...');
  stopHeartbeat();
  stopStatusUpdates();
  await stopProjection('agent_shutdown');
  if (socket) {
    socket.disconnect();
  }
  process.exit(0);
});

// Start the agent
console.log('DYCICLMS PC Agent starting...');
console.log(`Computer ID: ${CONFIG.computerId}`);
console.log(`Server: ${CONFIG.serverUrl}  (from ${resolvedServer.source})`);
connect();
