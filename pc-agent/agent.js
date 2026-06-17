const io = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
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
// Phase 1 diagnostics: the overlay process writes decode/paint counters here as
// JSON ~1/s; the agent samples it to report real overlay FPS to the dashboard.
const PROJECTION_STATS_PATH = path.join(os.tmpdir(), 'dyci_projection_overlay.stats');

const projection = {
  active: false,
  sessionId: null,
  overlayProc: null,
  overlayScript: null,
  pythonCmd: null,
  lastSeq: -1,
  lastActivity: 0,        // epoch ms of last frame OR ping
  watchdogSeconds: 8,
  watchdogTimer: null,
  stopping: false,
  relaunchCount: 0,
  lastSpawnAt: 0,
  // Phase 1 diagnostics: monotonic counters + a 1s sampler that emits
  // `projection_stats` so the dashboard can see exactly which hop drops to 0 fps.
  framesRecv: 0,          // projection_frame events received over Socket.IO
  framesWritten: 0,       // frames successfully written to the overlay frame file
  lastFrameBytes: 0,      // decoded byte size of the most recent frame
  statsTimer: null,
  _sample: null,          // { ts, framesRecv, framesWritten, overlayDecoded, overlayPainted }
};

// Resolved once: the Python launcher on the guest that can actually run the
// overlay (Pillow + tkinter importable), with diagnostics about why if not.
let cachedPythonCmd = null;
let cachedPythonDepsOk = false;   // PIL.Image + PIL.ImageTk + tkinter all import
let cachedPythonDetail = '';      // last import error when depsOk is false
let pythonProbed = false;

// The overlay needs exactly these. Probing the SAME interpreter the agent will
// launch (e.g. pythonw.exe) catches the #1 failure: deps installed under one
// python but the launcher resolving to a different one without them.
const OVERLAY_IMPORT_PROBE = 'import tkinter; from PIL import Image, ImageTk';

// Verbose projection logging — gated so normal runs stay quiet. Errors always log.
// Enable with PROJECTION_DEBUG=true (env) or "projectionDebug": true in agent.config.json.
// (Read lazily so it can also consult fileConfig, which is defined further down.)
const pdlog = (...args) => {
  const on =
    String(process.env.PROJECTION_DEBUG || '').toLowerCase() === 'true' ||
    (typeof fileConfig === 'object' && fileConfig?.projectionDebug === true);
  if (on) console.log(...args);
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

// --- Network interface selection (robust against virtual / stale NICs) ------
// The server reaches this guest's HTTP surface (screenshot / overlay-log /
// diagnose on TCP 5555) by IP, so the agent must report the address the server
// can ACTUALLY reach — the default-route LAN interface — not a VMware / Hyper-V
// / Radmin / WSL / Docker / VPN adapter that may sort first. We also report the
// full candidate list (ipAddresses / interfaceBindings) and refresh it on every
// heartbeat so a DHCP / NIC change self-heals within one beat.
const VIRTUAL_IFACE_RE =
  /(vmware|virtualbox|vbox|hyper-?v|vethernet|radmin|hamachi|\bwsl\b|docker|loopback|\btap\b|tunnel|npcap|bluetooth|zerotier|tailscale|nordlynx|wireguard|teredo|isatap|pseudo|virtual)/i;

// IPv4 ranges we never want to advertise as the reachable LAN address.
function isVirtualIpv4(ip) {
  if (!ip || typeof ip !== 'string') return true;
  return (
    ip.startsWith('127.') ||
    ip.startsWith('0.') ||
    ip.startsWith('169.254.') || // APIPA (no DHCP lease)
    ip.startsWith('192.168.56.') || // VirtualBox host-only
    ip.startsWith('25.') || // Radmin VPN
    ip.startsWith('26.') // Radmin VPN
  );
}

function isVirtualIface(iface) {
  if (!iface) return true;
  if (iface.virtual === true) return true;
  return VIRTUAL_IFACE_RE.test(`${iface.iface || ''} ${iface.ifaceName || ''}`);
}

// Same /24 as the server → strong signal this is the on-LAN interface.
function sameSubnet24(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  if (pa.length !== 4 || pb.length !== 4) return false;
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}

function serverHostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Rank real IPv4 interfaces and return the best reachable LAN one plus the full
 * candidate list. Highest signal first: the OS default-route interface, then an
 * interface on the server's subnet, then non-virtual + link-up.
 * @returns {{ primary: {ip,mac,iface}|null, candidates: Array<{ip,mac,iface}> }}
 */
function selectNetwork(allInterfaces, { serverHost, defaultIfaceName } = {}) {
  const real = (allInterfaces || []).filter(
    (i) => i && i.ip4 && !i.internal && !isVirtualIpv4(i.ip4),
  );
  const score = (i) => {
    let s = 0;
    if (defaultIfaceName && i.iface === defaultIfaceName) s += 1000;
    if (serverHost && sameSubnet24(i.ip4, serverHost)) s += 500;
    if (i.operstate === 'up') s += 100;
    return s;
  };
  // Only advertise PHYSICAL interfaces so the server never dials (and the
  // dashboard never rows) a VMware/Hyper-V/WSL/VPN address. Fall back to the
  // raw set only if filtering would leave us with nothing to report.
  const clean = real.filter((i) => !isVirtualIface(i));
  const pool = clean.length ? clean : real;
  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const candidates = ranked.map((i) => ({
    ip: i.ip4,
    mac: i.mac || '',
    iface: i.iface || '',
  }));
  const primary = ranked[0]
    ? { ip: ranked[0].ip4, mac: ranked[0].mac || '', iface: ranked[0].iface || '' }
    : null;
  return { primary, candidates };
}

/** Live network snapshot used by both registration and heartbeat. */
async function getNetworkSnapshot() {
  try {
    const [network, defIface] = await Promise.all([
      si.networkInterfaces(),
      si.networkInterfaceDefault().catch(() => ''),
    ]);
    const { primary, candidates } = selectNetwork(Object.values(network).flat(), {
      serverHost: serverHostFromUrl(CONFIG.serverUrl),
      defaultIfaceName: defIface,
    });
    return {
      ip: primary?.ip || '127.0.0.1',
      mac: primary?.mac || 'unknown',
      ipAddresses: candidates.map((c) => c.ip),
      interfaceBindings: candidates,
    };
  } catch (error) {
    console.error('Error resolving network snapshot:', error);
    return { ip: '127.0.0.1', mac: 'unknown', ipAddresses: [], interfaceBindings: [] };
  }
}

// Get computer information
async function getComputerInfo() {
  try {
    const [system, cpu, mem, osInfo, graphics] = await Promise.all([
      si.system(),
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.graphics()
    ]);

    // Reachable LAN IP + full candidate list (see getNetworkSnapshot).
    const net = await getNetworkSnapshot();

    // Get logged in user
    const user = await getLoggedInUser();

    return {
      id: CONFIG.computerId,
      name: os.hostname(),
      ip: net.ip,
      mac: net.mac,
      ipAddresses: net.ipAddresses,
      interfaceBindings: net.interfaceBindings,
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
    // Refresh the reachable LAN IP every beat so a DHCP / NIC change self-heals
    // without restarting the agent (server applies these in agent_status_update).
    const net = await getNetworkSnapshot();

    return {
      computerId: CONFIG.computerId,
      status: 'online',
      user: user,
      ip: net.ip,
      mac: net.mac,
      ipAddresses: net.ipAddresses,
      interfaceBindings: net.interfaceBindings,
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
    //
    // WIRE FORMAT (pinned, host-OS-agnostic). The browser host encodes each frame
    // with canvas.toBlob('image/jpeg', q) — a real JPEG — then base64-encodes the
    // raw bytes WITHOUT any "data:image/jpeg;base64," prefix (see blobToBase64 in
    // DeveloperModePage.jsx). The server relays `screenshot` unchanged. So here
    // `screenshot` is base64-of-JPEG: decode straight to bytes and write the .jpg.
    // The overlay then decodes it with Pillow (Image.open). Do NOT re-encode.
    socket.on('projection_frame', async (data) => {
      try {
        const { session_id, seq, screenshot } = data || {};
        if (!projection.active || session_id !== projection.sessionId) return;
        if (!screenshot || typeof screenshot !== 'string') return;
        projection.framesRecv += 1; // count BEFORE the stale/seq filter so the dashboard distinguishes "arriving but dropped" from "not arriving"
        if (typeof seq === 'number' && seq <= projection.lastSeq) return; // drop stale/out-of-order
        if (typeof seq === 'number') projection.lastSeq = seq;
        const buf = Buffer.from(screenshot, 'base64');
        await fs.writeFile(PROJECTION_FRAME_TMP, buf);
        await fs.rename(PROJECTION_FRAME_TMP, PROJECTION_FRAME_PATH);
        projection.framesWritten += 1;
        projection.lastFrameBytes = buf.length;
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

/**
 * Capture the guest desktop via PowerShell + .NET (System.Drawing.CopyFromScreen).
 * This is the Socket.IO *fallback* path — the primary screenshot path is the
 * Python agent over HTTP 5555. Uses no external .exe, so it avoids the fragile
 * screenshot-desktop bat/exe that breaks when its companion exe is missing.
 */
async function takeScreenshot() {
  if (process.platform !== 'win32') {
    throw new Error('Screenshot capture is only implemented for Windows guests');
  }
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outPath = path.join(os.tmpdir(), `dyci_shot_${stamp}.jpg`);
  const ps1Path = path.join(os.tmpdir(), `dyci_shot_${stamp}.ps1`);
  const outEsc = outPath.replace(/\\/g, '\\\\');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70)
$bmp.Save('${outEsc}', $enc, $ep)
$g.Dispose(); $bmp.Dispose()
`;
  await fs.writeFile(ps1Path, script, 'utf8');
  try {
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
        { windowsHide: true, timeout: 15000 },
        (err, _stdout, stderr) => (err ? reject(new Error((stderr || err.message || '').trim())) : resolve()),
      );
    });
    const buf = await fs.readFile(outPath);
    if (!buf || !buf.length) throw new Error('Empty screenshot capture');
    return {
      success: true,
      screenshot: buf.toString('base64'),
      format: 'jpeg',
      timestamp: new Date().toISOString(),
    };
  } finally {
    fs.unlink(outPath).catch(() => {});
    fs.unlink(ps1Path).catch(() => {});
  }
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

/** Candidate Python launchers to try (prefer no-console `pythonw` on Windows). */
function pythonCandidates() {
  if (process.env.PROJECTION_PYTHON) return [process.env.PROJECTION_PYTHON];
  return process.platform === 'win32'
    ? ['pythonw.exe', 'python.exe', 'py']
    : ['python3', 'python'];
}

/** Probe a single launcher: does it run, and can it import the overlay's deps? */
function probePython(py) {
  return new Promise((resolve) => {
    execFile(py, ['--version'], { timeout: 5000, windowsHide: true }, (verr) => {
      if (verr) {
        resolve({ cmd: py, runs: false });
        return;
      }
      execFile(py, ['-c', OVERLAY_IMPORT_PROBE], { timeout: 8000, windowsHide: true }, (derr, _o, stderr) => {
        if (!derr) {
          resolve({ cmd: py, runs: true, depsOk: true });
          return;
        }
        const detail =
          String(stderr || derr.message || '')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .pop() || 'Pillow/tkinter import failed';
        resolve({ cmd: py, runs: true, depsOk: false, detail });
      });
    });
  });
}

/**
 * Resolve the Python launcher for the overlay. Prefers one where Pillow + tkinter
 * import; otherwise falls back to the first that merely runs (so the overlay can
 * still emit a precise ImportError to its log). Sets cachedPythonDepsOk/Detail.
 */
async function resolvePython() {
  // Only trust a confirmed-good cache. If deps were missing last time, re-probe so
  // a guest that runs `pip install pillow` and retries works without restarting.
  if (pythonProbed && cachedPythonCmd && cachedPythonDepsOk) return cachedPythonCmd;
  const candidates = pythonCandidates();
  const results = [];
  for (const py of candidates) {
    const r = await probePython(py);
    results.push(r);
    if (r.runs && r.depsOk) {
      cachedPythonCmd = py;
      cachedPythonDepsOk = true;
      cachedPythonDetail = '';
      pythonProbed = true;
      return py;
    }
  }
  const runnable = results.find((r) => r.runs);
  cachedPythonCmd = runnable ? runnable.cmd : null;
  cachedPythonDepsOk = false;
  cachedPythonDetail = runnable
    ? runnable.detail || 'Pillow/tkinter not importable'
    : 'no Python launcher ran';
  pythonProbed = true;
  return cachedPythonCmd;
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

/** Read the overlay's stats file (decode/paint counters). Returns null if absent/unparseable. */
function readOverlayStats() {
  try {
    const raw = fsSync.readFileSync(PROJECTION_STATS_PATH, 'utf8');
    const o = JSON.parse(raw);
    return {
      decoded: Number(o.decoded) || 0,
      painted: Number(o.painted) || 0,
      gotFrame: !!o.got_frame,
      w: o.w ?? null,
      h: o.h ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 1 diagnostics: once a second, derive per-hop FPS from the monotonic
 * counters (agent recv/write + overlay decode/paint) and emit `projection_stats`
 * so the dashboard can pinpoint the hop where frames stop flowing.
 */
function startProjectionStats() {
  stopProjectionStats();
  projection._sample = {
    ts: Date.now(),
    framesRecv: projection.framesRecv,
    framesWritten: projection.framesWritten,
    overlayDecoded: 0,
    overlayPainted: 0,
  };
  projection.statsTimer = setInterval(() => {
    if (!projection.active || !socket || !socket.connected) return;
    const now = Date.now();
    const prev = projection._sample;
    const dt = Math.max(0.001, (now - prev.ts) / 1000);
    const ov = readOverlayStats();
    const recvFps = (projection.framesRecv - prev.framesRecv) / dt;
    const writeFps = (projection.framesWritten - prev.framesWritten) / dt;
    const decodedFps = ov ? (ov.decoded - prev.overlayDecoded) / dt : 0;
    const paintedFps = ov ? (ov.painted - prev.overlayPainted) / dt : 0;
    projection._sample = {
      ts: now,
      framesRecv: projection.framesRecv,
      framesWritten: projection.framesWritten,
      overlayDecoded: ov ? ov.decoded : prev.overlayDecoded,
      overlayPainted: ov ? ov.painted : prev.overlayPainted,
    };
    const stats = {
      recvFps: Math.round(recvFps * 10) / 10,
      writeFps: Math.round(writeFps * 10) / 10,
      lastBytes: projection.lastFrameBytes,
      overlayUp: !!projection.overlayProc,
      overlay: ov
        ? {
            decodedFps: Math.round(decodedFps * 10) / 10,
            paintedFps: Math.round(paintedFps * 10) / 10,
            gotFrame: ov.gotFrame,
            w: ov.w,
            h: ov.h,
          }
        : null,
    };
    pdlog(
      `[Projection] stats recv=${stats.recvFps}fps write=${stats.writeFps}fps ` +
        `overlay=${ov ? `${stats.overlay.decodedFps}/${stats.overlay.paintedFps}fps got=${ov.gotFrame}` : 'no-stats-file'} ` +
        `bytes=${stats.lastBytes}`,
    );
    socket.emit('projection_stats', { session_id: projection.sessionId, ...stats });
  }, 1000);
}

function stopProjectionStats() {
  if (projection.statsTimer) {
    clearInterval(projection.statsTimer);
    projection.statsTimer = null;
  }
  projection._sample = null;
}

/** Fatal overlay failure: report a clear error to the dashboard and restore the guest. */
function onOverlayFatal(detail) {
  console.error('[Projection] FATAL:', detail);
  projection.stopping = true;
  projection.active = false;
  stopProjectionStats();
  if (projection.watchdogTimer) {
    clearInterval(projection.watchdogTimer);
    projection.watchdogTimer = null;
  }
  const proc = projection.overlayProc;
  projection.overlayProc = null;
  if (proc) { try { proc.kill(); } catch { /* ignore */ } }
  fs.unlink(PROJECTION_HEARTBEAT_PATH).catch(() => {});
  fs.unlink(PROJECTION_FRAME_PATH).catch(() => {});
  fs.unlink(PROJECTION_STATS_PATH).catch(() => {});
  // Leave the dashboard showing the error reason (no follow-up 'stopped' ack).
  sendProjectionAck('error', detail);
  projection.sessionId = null;
  projection.stopping = false;
}

/** Spawn the locked Python overlay process (uses the resolved launcher + script). */
function spawnOverlayProc() {
  const args = [
    projection.overlayScript,
    '--frame', PROJECTION_FRAME_PATH,
    '--heartbeat', PROJECTION_HEARTBEAT_PATH,
    '--watchdog', String(projection.watchdogSeconds),
    '--session', projection.sessionId || '',
    '--stats', PROJECTION_STATS_PATH,
  ];
  let proc;
  try {
    proc = spawn(projection.pythonCmd, args, {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    onOverlayFatal(`Failed to spawn overlay (${projection.pythonCmd}): ${err.message}`);
    return;
  }
  projection.overlayProc = proc;
  projection.lastSpawnAt = Date.now();

  // Capture stderr so a crash reports the real reason to the dashboard instead of
  // a generic "keeps crashing". The overlay prints "OVERLAY_FATAL: <reason>" for
  // unrecoverable startup failures (e.g. missing deps) — surface those verbatim.
  let stderrTail = '';
  let fatalLine = null;

  proc.on('spawn', () => pdlog(`[Projection] Overlay launched via ${projection.pythonCmd} (PID ${proc.pid})`));
  if (proc.stderr) {
    proc.stderr.on('data', (d) => {
      const text = String(d);
      stderrTail = (stderrTail + text).slice(-2000);
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        console.error('[Overlay]', line);
        if (line.startsWith('OVERLAY_FATAL:')) {
          fatalLine = line.slice('OVERLAY_FATAL:'.length).trim();
        }
      }
    });
  }
  const lastStderrLine = () =>
    stderrTail.trim().split(/\r?\n/).filter(Boolean).pop() || '';

  proc.on('error', (err) => {
    if (projection.overlayProc === proc) projection.overlayProc = null;
    onOverlayFatal(`Overlay process error (${projection.pythonCmd}): ${err.message}`);
  });
  proc.on('exit', (code, signal) => {
    if (projection.overlayProc === proc) projection.overlayProc = null;
    pdlog(`[Projection] Overlay exited (code=${code} signal=${signal || '-'})`);
    if (!projection.active || projection.stopping) return;

    // A structured startup failure won't fix itself on relaunch — report it now.
    if (fatalLine) {
      onOverlayFatal(`overlay: ${fatalLine}`);
      return;
    }
    // Exit code 2 == overlay's "required UI libs missing" path.
    if (code === 2) {
      const tail = lastStderrLine();
      onOverlayFatal(
        `Overlay exited reporting missing UI libraries (need Pillow + tkinter)${tail ? `: ${tail}` : '.'} ` +
          `Fetch the full log via "Overlay log" or scripts\\guest-get-overlay-log.ps1.`,
      );
      return;
    }
    // Crash-loop guard: relaunch, but give up after repeated rapid failures.
    const now = Date.now();
    if (now - projection.lastSpawnAt < 3000) projection.relaunchCount += 1;
    else projection.relaunchCount = 0;
    if (projection.relaunchCount >= 3) {
      const tail = lastStderrLine();
      onOverlayFatal(
        `Overlay keeps crashing on the guest${tail ? ` (last error: ${tail})` : ''}. ` +
          `Fetch the full traceback via "Overlay log" or scripts\\guest-get-overlay-log.ps1 ` +
          `(check Pillow + tkinter are installed and the agent is elevated).`,
      );
      return;
    }
    pdlog('[Projection] supervisor relaunching overlay…');
    spawnOverlayProc();
  });
}

/** Start a locked projection session on this guest. */
async function startProjection(data) {
  const sessionId = data.session_id || `local-${Date.now()}`;
  const watchdog = parseInt(data.watchdog_seconds, 10);
  pdlog(`[Projection] START received (session=${sessionId})`);
  // Already projecting this session → re-ack and continue (idempotent late-joiner resend).
  if (projection.active && projection.sessionId === sessionId) {
    sendProjectionAck('projecting', 'Already active');
    return;
  }
  // Different session active → swap to the new one cleanly.
  if (projection.active) await stopProjection('superseded');

  // Resolve the overlay script + a working Python launcher up front so failures
  // surface as a clear dashboard error instead of a stuck "connecting" badge.
  const script = resolveOverlayScript();
  if (!script) {
    onOverlayFatal(
      'projection_overlay.py not found on guest. Set PROJECTION_OVERLAY_PATH or deploy it beside the agent.',
    );
    return;
  }
  const py = await resolvePython();
  if (!py) {
    onOverlayFatal(
      `No working Python found on guest (tried: ${pythonCandidates().join(', ')}). Install Python 3 + Pillow.`,
    );
    return;
  }
  // The interpreter runs but can't import the overlay's deps — reporting this
  // up front beats spawning a guaranteed crash-loop. (#1 real-world cause.)
  if (!cachedPythonDepsOk) {
    onOverlayFatal(
      `Overlay can't start: Pillow/tkinter not importable in the guest's "${py}" (${cachedPythonDetail}). ` +
        `On the guest run:  ${py} -m pip install pillow  ` +
        `(tkinter ships with the python.org installer; the Microsoft Store build omits it).`,
    );
    return;
  }

  projection.active = true;
  projection.stopping = false;
  projection.sessionId = sessionId;
  projection.overlayScript = script;
  projection.pythonCmd = py;
  projection.lastSeq = -1;
  projection.relaunchCount = 0;
  projection.watchdogSeconds = Number.isFinite(watchdog) ? watchdog : 8;
  projection.framesRecv = 0;
  projection.framesWritten = 0;
  projection.lastFrameBytes = 0;

  // Clear any stale frame/stats so the overlay shows the "presenting…" placeholder
  // first and the dashboard doesn't read counters from a previous session.
  try { await fs.unlink(PROJECTION_FRAME_PATH); } catch { /* ignore */ }
  try { await fs.unlink(PROJECTION_STATS_PATH); } catch { /* ignore */ }
  await touchProjectionHeartbeat();

  spawnOverlayProc();
  if (!projection.active) return; // spawn failed → onOverlayFatal already reported

  startProjectionStats();

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

  stopProjectionStats();
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
  try { await fs.unlink(PROJECTION_STATS_PATH); } catch { /* ignore */ }

  pdlog(`[Projection] Stopped (${reason || 'stop'})`);
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
