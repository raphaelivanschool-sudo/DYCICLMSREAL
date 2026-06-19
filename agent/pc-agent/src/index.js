#!/usr/bin/env node
import { io } from 'socket.io-client';
import si from 'systeminformation';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import dgram from 'dgram';
import { spawn, exec, execFile } from 'child_process';
import { promisify } from 'util';
import { runPythonDiscovery } from './pythonDiscovery.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG_PATH = path.join(process.env.PROGRAMDATA || os.homedir(), 'DYCI-Agent', 'config.json');
const LOG_PATH = path.join(process.env.PROGRAMDATA || os.homedir(), 'DYCI-Agent', 'agent.log');
const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const BLOCK_START_MARKER = '# DYCICLMS_WEBSITE_BLOCK_START';
const BLOCK_END_MARKER = '# DYCICLMS_WEBSITE_BLOCK_END';

// Kept in sync with pc-agent/agent.js (the dev/server agent). A hosts entry
// matches one exact hostname, so each blocked domain is expanded to the apex
// plus these common www/mobile fronts. Browser Secure DNS (DoH) bypasses the
// hosts file, so we force it OFF via managed policy while blocking is active.
const BLOCK_SUBDOMAINS = ['www', 'm', 'web', 'mobile'];
const DOH_POLICY_KEYS = [
  { browser: 'Edge', key: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge' },
  { browser: 'Chrome', key: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome' },
];
const DOH_POLICY_VALUE = 'DnsOverHttpsMode';

// ---- Internet block via Windows Firewall (managed outbound block rule) ----
// Scoped to the PUBLIC IPv4 ranges only so the LAN + LMS server stay reachable and
// the agent never severs its own control channel. See blockInternet()/allowInternet().
const FIREWALL_RULE_NAME = 'DYCI-BlockInternet';
const FIREWALL_RULE_GROUP = 'DYCI-CLMS';
const FIREWALL_RULE_DESC =
  'DYCI CLMS: blocks public internet while keeping the LAN and LMS server reachable so the agent stays controllable. Managed rule — removed by Allow internet.';

function ipToInt(ip) {
  const parts = String(ip || '').trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3];
}

function intToIp(n) {
  return [
    Math.floor(n / 16777216) % 256,
    Math.floor(n / 65536) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join('.');
}

/**
 * Return the PUBLIC IPv4 ranges to block as ["a.b.c.d-e.f.g.h", …]: the complement
 * of the private/reserved ranges we must keep reachable (LAN, link-local, loopback,
 * multicast/reserved) plus the LMS server IP (carved out automatically).
 */
function computePublicBlockRanges(serverIp) {
  const MAX = 4294967295; // 255.255.255.255
  const keep = [
    [0, 16777215],            // 0.0.0.0/8     "this network"
    [167772160, 184549375],   // 10.0.0.0/8
    [2130706432, 2147483647], // 127.0.0.0/8   loopback
    [2851995648, 2852061183], // 169.254.0.0/16 link-local (APIPA)
    [2886729728, 2887778303], // 172.16.0.0/12
    [3232235520, 3232301055], // 192.168.0.0/16
    [3758096384, MAX],        // 224.0.0.0/3   multicast + reserved + broadcast
  ];
  const sip = ipToInt(serverIp);
  if (sip != null) keep.push([sip, sip]);

  keep.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of keep) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const block = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) block.push([cursor, s - 1]);
    cursor = Math.max(cursor, e + 1);
  }
  if (cursor <= MAX) block.push([cursor, MAX]);
  return block.map(([s, e]) => `${intToIp(s)}-${intToIp(e)}`);
}

/** True only if this agent process can manage firewall rules (Administrator). */
async function isElevated() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)"',
    );
    return /true/i.test(stdout);
  } catch {
    return false;
  }
}

// ---- Local capture-agent (Python, mss) helpers ----
// Screenshots are captured in-process by the local Python agent and reached over
// 127.0.0.1 only (never a dialed LAN IP, never a temp .ps1).

/** TCP port of the local Python capture agent (env > 5555). */
function resolvePcAgentHttpPort() {
  const fromEnv = parseInt(process.env.PC_AGENT_HTTP_PORT || '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 5555;
}

let cachedPcAgentApiKey;
/** Bearer token for the local Python capture agent (env > agent config > python agent_config.json). */
function resolvePcAgentApiKey(agentConfig) {
  const fromEnv = (process.env.PC_AGENT_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = (agentConfig?.pcAgentApiKey || agentConfig?.api_key || '').trim?.() || '';
  if (fromCfg) return fromCfg;
  if (cachedPcAgentApiKey !== undefined) return cachedPcAgentApiKey;

  const candidates = [
    process.env.PC_AGENT_CONFIG_PATH,
    path.join(__dirname, '..', 'python', 'agent_config.json'),
    path.join(__dirname, 'agent_config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (typeof j.api_key === 'string' && j.api_key.trim()) {
        cachedPcAgentApiKey = j.api_key.trim();
        return cachedPcAgentApiKey;
      }
    } catch { /* try next candidate */ }
  }
  cachedPcAgentApiKey = '';
  return '';
}

/** GET a JSON body from the local capture agent over plain HTTP (localhost only). */
function httpGetLocalJson(urlStr, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        timeout: timeoutMs,
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (d) => chunks.push(d));
        resp.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = body ? JSON.parse(body) : null; } catch { /* non-JSON body */ }
          resolve({ status: resp.statusCode || 0, json, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

class PCAgent {
  constructor() {
    this.socket = null;
    this.computerId = null;
    this.config = this.loadConfig();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.heartbeatInterval = null;
    this.vncProcess = null;
    this.logger = this.createLogger();
    
    // UDP Service Discovery
    this.discoverySocket = null;
    this.discoveryInterval = null;
    this.DISCOVERY_PORT = 41234;
    this.DISCOVERY_INTERVAL = 30000; // 30 seconds
    this.vncPort = 5900;
    this.pythonProjectionProcess = null;
    this.pythonProjectionRestartTimer = null;
  }

  createLogger() {
    return {
      info: (msg) => {
        const line = `[${new Date().toISOString()}] INFO: ${msg}`;
        console.log(line);
        this.appendToLog(line);
      },
      error: (msg, err) => {
        const line = `[${new Date().toISOString()}] ERROR: ${msg} ${err ? err.message : ''}`;
        console.error(line);
        this.appendToLog(line);
      },
      debug: (msg) => {
        if (process.env.DEBUG) {
          const line = `[${new Date().toISOString()}] DEBUG: ${msg}`;
          console.log(line);
          this.appendToLog(line);
        }
      }
    };
  }

  appendToLog(line) {
    try {
      const dir = path.dirname(LOG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(LOG_PATH, line + '\n');
    } catch (e) {
      // Silent fail for logging
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        this.logger?.info('Configuration loaded from ' + CONFIG_PATH);
        return config;
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }
    
    // Default config
    return {
      serverUrl: process.env.AGENT_SERVER || 'http://localhost:3001',
      agentToken: process.env.AGENT_TOKEN || 'agent-token-placeholder',
      room: process.env.AGENT_ROOM || 'Default',
      computerId: uuidv4(),
      autoStartVNC: false,
      heartbeatInterval: 30000,
      reconnectEnabled: true
    };
  }

  saveConfig() {
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    } catch (error) {
      this.logger.error('Failed to save config:', error);
    }
  }

  async getSystemInfo() {
    try {
      const [system, osInfo, cpu, mem, network, users] = await Promise.all([
        si.system(),
        si.osInfo(),
        si.cpu(),
        si.mem(),
        si.networkInterfaces(),
        si.users()
      ]);

      // Collect non-loopback IPv4 addresses for primary IP + ipAddresses (scan/dashboard matching)
      const ipv4Candidates = [];
      for (const ni of network) {
        if (!ni?.ip4) continue;
        const a = String(ni.ip4).trim();
        if (!a || a.startsWith('127.')) continue;
        ipv4Candidates.push({ ip: a, mac: ni.mac || '00:00:00:00:00:00' });
      }

      const scoreIp = (addr) => {
        if (addr.startsWith('192.168.')) return 300;
        if (addr.startsWith('10.')) return 250;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 200;
        if (addr.startsWith('169.254.')) return 50;
        return 100;
      };

      const osCandidates = [];
      try {
        const nics = os.networkInterfaces();
        for (const name of Object.keys(nics)) {
          for (const addr of nics[name] || []) {
            const fam = addr.family;
            const isV4 = fam === 'IPv4' || fam === 4;
            if (!isV4 || !addr.address) continue;
            const a = String(addr.address).trim();
            if (!a || a.startsWith('127.') || addr.internal) continue;
            osCandidates.push({
              ip: a,
              mac: (addr.mac || '00:00:00:00:00:00').replace(/-/g, ':'),
            });
          }
        }
      } catch {
        /* ignore */
      }

      const byIp = new Map();
      for (const c of ipv4Candidates) byIp.set(c.ip, c);
      for (const c of osCandidates) {
        if (!byIp.has(c.ip)) byIp.set(c.ip, c);
      }
      const candidates = [...byIp.values()];

      const uniqueIps = [...new Set(candidates.map((c) => c.ip))]
        .filter((x) => x && !String(x).startsWith('127.'))
        .sort((x, y) => scoreIp(y) - scoreIp(x));

      const ip = uniqueIps[0] || '0.0.0.0';
      const primaryNi = candidates.find((c) => c.ip === ip) || candidates[0];
      const mac = primaryNi?.mac || '00:00:00:00:00:00';

      const interfaceBindings = candidates.map((c) => ({
        ip: c.ip,
        mac: c.mac || '00:00:00:00:00:00',
      }));

      // Get current logged-in user
      const currentUser = users.find(u => u.loggedIn) || users[0] || { user: os.userInfo().username };

      return {
        id: this.config.computerId,
        name: os.hostname(),
        hostname: os.hostname(),
        ip: ip,
        mac: mac,
        user: currentUser.user || 'Unknown',
        room: this.config.room,
        status: 'online',
        ipAddresses: uniqueIps.length ? uniqueIps : ip !== '0.0.0.0' ? [ip] : [],
        interfaceBindings,
        os: `${osInfo.platform} ${osInfo.release}`,
        specs: {
          cpu: `${cpu.manufacturer} ${cpu.brand}`,
          cores: cpu.cores,
          ram: this.formatBytes(mem.total),
          ramBytes: mem.total,
          storage: 'Unknown',
          arch: os.arch()
        },
        lastSeen: new Date()
      };
    } catch (error) {
      this.logger.error('Error getting system info:', error);
      return {
        id: this.config.computerId,
        name: os.hostname(),
        hostname: os.hostname(),
        ip: '0.0.0.0',
        mac: '00:00:00:00:00:00',
        ipAddresses: [],
        interfaceBindings: [],
        user: os.userInfo().username,
        room: this.config.room,
        status: 'online',
        os: 'Windows Unknown',
        specs: {},
        lastSeen: new Date()
      };
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // UDP Service Discovery - Broadcast TightVNC availability
  async startServiceDiscovery() {
    try {
      if (this.discoverySocket) {
        return; // Already started
      }

      this.discoverySocket = dgram.createSocket('udp4');
      
      this.discoverySocket.on('error', (err) => {
        this.logger.error('Discovery socket error:', err);
      });

      this.discoverySocket.on('listening', () => {
        this.discoverySocket.setBroadcast(true);
        this.logger.info('UDP service discovery started');
        
        // Send initial announcement
        this.sendDiscoveryAnnouncement();
        
        // Set up periodic announcements
        this.discoveryInterval = setInterval(() => {
          this.sendDiscoveryAnnouncement();
        }, this.DISCOVERY_INTERVAL);
      });

      // Bind to any available port
      this.discoverySocket.bind(0, () => {
        this.discoverySocket.setBroadcast(true);
      });
      
    } catch (error) {
      this.logger.error('Failed to start service discovery:', error);
    }
  }

  stopServiceDiscovery() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    if (this.discoverySocket) {
      this.discoverySocket.close();
      this.discoverySocket = null;
      this.logger.info('UDP service discovery stopped');
    }
  }

  async sendDiscoveryAnnouncement() {
    try {
      const systemInfo = await this.getSystemInfo();
      
      // Check if VNC is actually running
      const vncRunning = await this.isVNCRunning();
      
      const announcement = {
        type: 'tightvnc-announce',
        computerId: this.config.computerId,
        hostname: systemInfo.hostname,
        ip: systemInfo.ip,
        port: this.vncPort,
        hasAgent: true,
        vncRunning: vncRunning,
        timestamp: new Date().toISOString()
      };
      
      const message = Buffer.from(JSON.stringify(announcement));
      
      // Broadcast to all interfaces
      const broadcastAddresses = this.getBroadcastAddresses();
      
      for (const broadcastAddr of broadcastAddresses) {
        this.discoverySocket.send(message, this.DISCOVERY_PORT, broadcastAddr, (err) => {
          if (err) {
            this.logger.debug(`Discovery broadcast failed to ${broadcastAddr}: ${err.message}`);
          } else {
            this.logger.debug(`Discovery announcement sent to ${broadcastAddr}:${this.DISCOVERY_PORT}`);
          }
        });
      }
    } catch (error) {
      this.logger.error('Failed to send discovery announcement:', error);
    }
  }

  // Get broadcast addresses for all network interfaces
  getBroadcastAddresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          // Calculate broadcast address
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
    
    // Fallback to common broadcast addresses if no interfaces found
    if (addresses.length === 0) {
      addresses.push('255.255.255.255');
    }
    
    return addresses;
  }

  // Check if TightVNC is currently running
  async isVNCRunning() {
    try {
      // Check if tvnserver process exists
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq tvnserver.exe" /FO CSV /NH');
      return stdout.includes('tvnserver.exe');
    } catch (error) {
      return false;
    }
  }

  async connect() {
    try {
      this.logger.info(`Connecting to server: ${this.config.serverUrl}`);

      this.socket = io(this.config.serverUrl, {
        auth: {
          token: this.config.agentToken
        },
        transports: ['websocket', 'polling'], // Fallback to polling
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: this.reconnectDelay,
        timeout: 10000
      });

      this.setupEventHandlers();
    } catch (error) {
      this.logger.error('Connection error:', error);
      this.scheduleReconnect();
    }
  }

  resolvePythonLauncher() {
    if (process.platform !== 'win32') return null;
    const candidates = [
      { cmd: 'python', args: [] },
      { cmd: 'py', args: ['-3'] },
    ];
    return candidates;
  }

  startPythonProjectionAgent() {
    if (process.platform !== 'win32') {
      this.logger.info('Skipping Python projection agent startup (non-Windows)');
      return;
    }
    if (this.pythonProjectionProcess && !this.pythonProjectionProcess.killed) {
      return;
    }

    const pythonAgentDir = path.join(__dirname, '..', 'python');
    const pythonAgentPath = path.join(pythonAgentDir, 'agent.py');
    if (!fs.existsSync(pythonAgentPath)) {
      this.logger.info(`Python projection agent not found: ${pythonAgentPath}`);
      return;
    }

    const launchers = this.resolvePythonLauncher() || [];
    for (const launcher of launchers) {
      try {
        const args = [...launcher.args, pythonAgentPath];
        const child = spawn(launcher.cmd, args, {
          cwd: pythonAgentDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.pythonProjectionProcess = child;
        this.logger.info(`Started Python projection agent via ${launcher.cmd} ${launcher.args.join(' ')}`.trim());

        child.stdout?.on('data', (d) => {
          const msg = String(d || '').trim();
          if (msg) this.logger.debug(`[python-agent] ${msg}`);
        });
        child.stderr?.on('data', (d) => {
          const msg = String(d || '').trim();
          if (msg) this.logger.debug(`[python-agent-err] ${msg}`);
        });
        child.on('exit', (code) => {
          this.logger.error(`Python projection agent exited (code=${code})`);
          this.pythonProjectionProcess = null;
          if (this.pythonProjectionRestartTimer) {
            clearTimeout(this.pythonProjectionRestartTimer);
          }
          this.pythonProjectionRestartTimer = setTimeout(() => {
            this.startPythonProjectionAgent();
          }, 5000);
        });
        return;
      } catch (error) {
        this.logger.error(`Failed launching Python projection agent via ${launcher.cmd}:`, error);
      }
    }

    this.logger.error('Could not launch Python projection agent. Install Python 3 or add python/py to PATH.');
  }

  stopPythonProjectionAgent() {
    if (this.pythonProjectionRestartTimer) {
      clearTimeout(this.pythonProjectionRestartTimer);
      this.pythonProjectionRestartTimer = null;
    }
    if (this.pythonProjectionProcess) {
      try {
        this.pythonProjectionProcess.kill();
      } catch {
        // ignore
      }
      this.pythonProjectionProcess = null;
    }
  }

  setupEventHandlers() {
    // Connection established
    this.socket.on('connect', async () => {
      this.logger.info('Connected to server: ' + this.socket.id);
      this.reconnectAttempts = 0;

      // Register this computer
      const computerData = await this.getSystemInfo();
      this.socket.emit('agent_register', computerData);
      this.socket.emit('agent_status_update', {
        computerId: this.config.computerId,
        status: 'online',
        user: computerData.user,
        ip: computerData.ip,
        mac: computerData.mac,
        ipAddresses: computerData.ipAddresses,
        interfaceBindings: computerData.interfaceBindings,
        hostname: computerData.hostname,
        timestamp: new Date(),
      });

      // Start heartbeat
      this.startHeartbeat();
      
      // Start UDP service discovery broadcasting
      this.startServiceDiscovery();
    });

    // Registration acknowledged
    this.socket.on('agent_registered', (response) => {
      if (response.success) {
        this.logger.info('Agent registered successfully');
      }
    });

    // Execute command
    this.socket.on('execute_command', async (command) => {
      this.logger.info(`Received command: ${command.action}`);
      await this.executeCommand(command);
    });

    // Disconnection
    this.socket.on('disconnect', (reason) => {
      this.logger.info('Disconnected: ' + reason);
      this.stopHeartbeat();
      this.stopServiceDiscovery();
    });

    // Reconnecting
    this.socket.on('reconnecting', (attempt) => {
      this.logger.info(`Reconnecting... attempt ${attempt}`);
    });

    // Reconnect failed
    this.socket.on('reconnect_failed', () => {
      this.logger.error('Reconnection failed after max attempts');
      this.scheduleReconnect();
    });

    // Error
    this.socket.on('connect_error', (error) => {
      this.logger.error('Connection error:', error);
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(async () => {
      if (this.socket?.connected) {
        try {
          const status = await this.getSystemInfo();
          this.socket.emit('agent_status_update', {
            computerId: this.config.computerId,
            status: 'online',
            user: status.user,
            ip: status.ip,
            mac: status.mac,
            ipAddresses: status.ipAddresses,
            interfaceBindings: status.interfaceBindings,
            hostname: status.hostname,
            timestamp: new Date(),
          });
          this.logger.debug('Heartbeat sent');
        } catch (error) {
          this.logger.error('Heartbeat error:', error);
        }
      }
    }, this.config.heartbeatInterval || 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    if (!this.config.reconnectEnabled) return;
    
    setTimeout(() => {
      this.logger.info('Attempting to reconnect...');
      this.connect();
    }, this.reconnectDelay);
  }

  async executeCommand(command) {
    const { action, params, from, requestId } = command;

    try {
      let result;
      
      switch (action) {
        case 'lock':
          result = await this.lockWorkstation();
          break;
        case 'shutdown':
          result = await this.shutdownPC(params || {});
          break;
        case 'restart':
          result = await this.restartPC(params || {});
          break;
        case 'abort_shutdown':
          result = await this.abortShutdown();
          break;
        case 'vnc-start':
          result = await this.startVNC(params);
          break;
        case 'vnc-stop':
          result = await this.stopVNC();
          break;
        case 'screenshot':
          result = await this.takeScreenshot();
          break;
        case 'get-info':
          result = await this.getSystemInfo();
          break;
        case 'discover-peers':
          result = await runPythonDiscovery({
            subnet: params?.subnet,
            registryOnly: Boolean(params?.registryOnly),
            timeoutMs: params?.timeoutMs
          });
          break;
        case 'set_website_blocklist':
          result = await this.setWebsiteBlocklist(params?.websites || []);
          break;
        case 'clear_website_blocklist':
          result = await this.clearWebsiteBlocklist();
          break;
        case 'get_website_blocklist':
          result = await this.getWebsiteBlocklist();
          break;
        case 'block_internet':
          result = await this.blockInternet();
          break;
        case 'allow_internet':
          result = await this.allowInternet();
          break;
        default:
          result = { success: false, error: `Unknown command: ${action}` };
      }

      // Send result back
      this.socket.emit('command_result', {
        action,
        success: result.success !== false,
        result,
        from,
        requestId, // lets a server-side RPC (e.g. screenshot) correlate this reply
        timestamp: new Date()
      });

    } catch (error) {
      this.logger.error(`Command ${action} failed:`, error);

      this.socket.emit('command_result', {
        action,
        success: false,
        error: error.message,
        from,
        requestId,
        timestamp: new Date()
      });
    }
  }

  async lockWorkstation() {
    this.logger.info('Locking workstation...');
    try {
      // Use rundll32 (most reliable on Windows)
      await execAsync('rundll32.exe user32.dll,LockWorkStation');
      return { success: true, message: 'Workstation locked' };
    } catch (error) {
      throw new Error('Failed to lock workstation: ' + error.message);
    }
  }

  // Graceful power action by default: scheduled countdown the guest can see, with
  // an on-screen warning (/c) and optional forced app-close (/f). Accepts either
  // { graceSeconds } (new monitoring UI) or { delay } (legacy) for the countdown.
  _powerParams(params) {
    const raw = typeof params === 'number' ? { delay: params } : (params || {});
    const grace = Math.max(0, Math.floor(Number(raw.graceSeconds ?? raw.delay ?? 0)) || 0);
    return { grace, force: !!raw.force, message: raw.message || '' };
  }

  async shutdownPC(params = {}) {
    const { grace, force, message } = this._powerParams(params);
    this.logger.info(`Shutting down PC (grace: ${grace}s, force: ${force})...`);
    try {
      const warn = (message || `Your instructor is shutting down this PC in ${grace} second(s). Please save your work now.`).replace(/"/g, "'");
      const cmd = `shutdown /s /t ${grace}${force ? ' /f' : ''} /c "${warn}"`;
      await execAsync(cmd);
      return { success: true, action: 'shutdown', graceSeconds: grace, force, message: warn };
    } catch (error) {
      const denied = /access is denied|\(5\)/i.test(error.message || '');
      throw new Error(denied ? 'Shutdown failed: access denied (run the agent as Administrator).' : 'Failed to shutdown: ' + error.message);
    }
  }

  async restartPC(params = {}) {
    const { grace, force, message } = this._powerParams(params);
    this.logger.info(`Restarting PC (grace: ${grace}s, force: ${force})...`);
    try {
      const warn = (message || `Your instructor is restarting this PC in ${grace} second(s). Please save your work now.`).replace(/"/g, "'");
      const cmd = `shutdown /r /t ${grace}${force ? ' /f' : ''} /c "${warn}"`;
      await execAsync(cmd);
      return { success: true, action: 'restart', graceSeconds: grace, force, message: warn };
    } catch (error) {
      const denied = /access is denied|\(5\)/i.test(error.message || '');
      throw new Error(denied ? 'Restart failed: access denied (run the agent as Administrator).' : 'Failed to restart: ' + error.message);
    }
  }

  // Cancel a pending shutdown/restart within its countdown window (shutdown /a).
  async abortShutdown() {
    this.logger.info('Aborting pending shutdown/restart...');
    try {
      await execAsync('shutdown /a');
      return { success: true, action: 'abort_shutdown', aborted: true, message: 'Pending power action aborted.' };
    } catch (error) {
      const detail = error.message || '';
      if (/1116|no shutdown was in progress/i.test(detail)) {
        return { success: true, action: 'abort_shutdown', aborted: false, message: 'No pending shutdown to abort.' };
      }
      const denied = /access is denied|\(5\)/i.test(detail);
      throw new Error(denied ? 'Abort failed: access denied (run the agent as Administrator).' : 'Failed to abort: ' + detail);
    }
  }

  async startVNC(params = {}) {
    this.logger.info('Starting VNC server...');
    try {
      // Stop any existing VNC
      await this.stopVNC();

      // Generate random password if not provided
      const password = params.password || this.generateRandomPassword(8);
      const port = params.port || 5900;

      // Check if TightVNC exists
      const vncPath = path.join(__dirname, '..', 'vnc', 'tvnserver.exe');
      
      if (!fs.existsSync(vncPath)) {
        throw new Error('TightVNC server not found at: ' + vncPath);
      }

      // Configure and start TightVNC
      // Set password
      await execAsync(`"${vncPath}" -controlservice -setprimarypassword ${password}`);
      
      // Start server
      this.vncProcess = spawn(vncPath, ['-controlservice', '-start'], {
        detached: true,
        stdio: 'ignore'
      });

      this.vncProcess.unref();

      this.logger.info(`VNC server started on port ${port}`);

      return { 
        success: true, 
        message: 'VNC server started',
        port,
        password,
        url: `vnc://${os.hostname()}:${port}`
      };

    } catch (error) {
      throw new Error('Failed to start VNC: ' + error.message);
    }
  }

  async stopVNC() {
    this.logger.info('Stopping VNC server...');
    try {
      const vncPath = path.join(__dirname, '..', 'vnc', 'tvnserver.exe');
      
      if (fs.existsSync(vncPath)) {
        await execAsync(`"${vncPath}" -controlservice -stop`);
      }

      if (this.vncProcess) {
        this.vncProcess.kill();
        this.vncProcess = null;
      }

      return { success: true, message: 'VNC server stopped' };
    } catch (error) {
      // VNC might not be running, that's okay
      return { success: true, message: 'VNC server stopped (or was not running)' };
    }
  }

  async takeScreenshot() {
    this.logger.info('Taking screenshot (local Python capture agent, mss)...');
    // Capture is done IN-PROCESS by the local Python agent (mss + Pillow), reached
    // over LOCALHOST only. We never write/run a temp .ps1 to capture — Defender/AMSI
    // blocks that pattern ("ScriptContainedMaliciousContent"). No temp files, no
    // spawned scripts: just a localhost GET to the already-running capture agent.
    const port = resolvePcAgentHttpPort();
    const apiKey = resolvePcAgentApiKey(this.config);
    let resp;
    try {
      resp = await httpGetLocalJson(`http://127.0.0.1:${port}/screenshot`, apiKey, 15000);
    } catch (error) {
      const why = error && error.code === 'ECONNREFUSED'
        ? `the local capture agent isn't listening on 127.0.0.1:${port}`
        : (error?.message || 'request failed');
      throw new Error(`Could not reach the local capture agent (${why}). Start the DYCI Python agent on this PC.`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Local capture agent rejected the api_key — it must match PC_AGENT_API_KEY / agent_config.json.');
    }
    if (resp.status !== 200 || !resp.json?.screenshot) {
      throw new Error('Local capture agent screenshot failed: ' + (resp.json?.error || `HTTP ${resp.status}`));
    }
    return {
      success: true,
      screenshot: resp.json.screenshot,
      format: resp.json.format || 'jpeg',
      timestamp: resp.json.timestamp || new Date().toISOString(),
    };
  }

  generateRandomPassword(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  // Collapse each entry to a registrable BASE domain (peel www/mobile fronts
  // only while ≥2 labels remain), matching pc-agent/agent.js.
  sanitizeWebsites(websites = []) {
    const cleaned = new Set();
    (Array.isArray(websites) ? websites : []).forEach((website) => {
      let host = String(website || '').trim().toLowerCase();
      host = host.replace(/^[a-z]+:\/\//, '');
      host = host.split('/')[0].split('?')[0].split('#')[0];
      host = host.split(':')[0].replace(/\.+$/, '').trim();
      let prev;
      do {
        prev = host;
        for (const sub of BLOCK_SUBDOMAINS) {
          if (host.startsWith(`${sub}.`)) {
            const candidate = host.slice(sub.length + 1);
            if (candidate.includes('.')) host = candidate;
          }
        }
      } while (host !== prev);
      if (host && host.includes('.') && !/\s/.test(host)) cleaned.add(host);
    });
    return Array.from(cleaned);
  }

  expandHosts(bases) {
    const hosts = [];
    const seen = new Set();
    bases.forEach((base) => {
      [base, ...BLOCK_SUBDOMAINS.map((s) => `${s}.${base}`)].forEach((h) => {
        if (!seen.has(h)) {
          seen.add(h);
          hosts.push(h);
        }
      });
    });
    return hosts;
  }

  buildBlockSection(hosts) {
    // 0.0.0.0 (no-route sink) fails fast on every modern browser and avoids the
    // guest's own loopback services answering, unlike the old 127.0.0.1.
    const lines = [BLOCK_START_MARKER];
    hosts.forEach((h) => lines.push(`0.0.0.0 ${h}`));
    lines.push(BLOCK_END_MARKER);
    return `${lines.join('\r\n')}\r\n`;
  }

  removeManagedBlockSection(content) {
    const sectionRegex = new RegExp(
      `${BLOCK_START_MARKER}[\\s\\S]*?${BLOCK_END_MARKER}\\r?\\n?`,
      'g'
    );
    return content.replace(sectionRegex, '');
  }

  async flushDns() {
    if (process.platform !== 'win32') return;
    try {
      await execAsync('ipconfig /flushdns');
    } catch (err) {
      this.logger?.debug?.(`[Hosts] ipconfig /flushdns failed (non-fatal): ${err.message}`);
    }
  }

  async setBrowserSecureDns(mode) {
    const changed = [];
    const failed = [];
    if (process.platform !== 'win32') return { changed, failed };
    for (const { browser, key } of DOH_POLICY_KEYS) {
      const cmd =
        mode === 'off'
          ? `reg add "${key}" /v ${DOH_POLICY_VALUE} /t REG_SZ /d off /f`
          : `reg delete "${key}" /v ${DOH_POLICY_VALUE} /f`;
      try {
        await execAsync(cmd);
        changed.push(browser);
      } catch (err) {
        const msg = String(err.message || '').split('\n')[0].trim();
        if (mode === 'restore' && /cannot find|unable to find|was not found|not exist/i.test(msg)) {
          continue;
        }
        failed.push({ browser, error: msg.slice(0, 200) });
      }
    }
    return { changed, failed };
  }

  async setWebsiteBlocklist(websites = []) {
    if (process.platform !== 'win32') {
      throw new Error('Website blocking currently supports Windows only');
    }

    const bases = this.sanitizeWebsites(websites);
    if (bases.length === 0) {
      throw new Error('No valid websites provided');
    }
    const hosts = this.expandHosts(bases);

    try {
      let hostsContent = await fs.promises.readFile(HOSTS_PATH, 'utf8');
      hostsContent = this.removeManagedBlockSection(hostsContent).trimEnd();
      hostsContent += `\r\n\r\n${this.buildBlockSection(hosts)}`;
      await fs.promises.writeFile(HOSTS_PATH, hostsContent, 'utf8');

      const doh = await this.setBrowserSecureDns('off');
      await this.flushDns();

      const warnings = [];
      if (doh.failed.length) {
        warnings.push(
          `Could not disable Secure DNS (DoH) for ${doh.failed.map((f) => f.browser).join(', ')} — ` +
            `run the agent as Administrator or DoH can bypass hosts blocking (${doh.failed[0].error})`
        );
      }
      return {
        success: true,
        blockedDomains: bases,
        blockedHosts: hosts,
        secureDnsDisabledFor: doh.changed,
        warnings,
        message:
          `Blocking ${bases.length} site(s) (${hosts.length} host variants); ` +
          `Secure DNS off for ${doh.changed.join(', ') || 'no browsers'}` +
          (warnings.length ? ` — ${warnings.join('; ')}` : ''),
      };
    } catch (error) {
      throw new Error(`Failed to update hosts file: ${error.message}`);
    }
  }

  async clearWebsiteBlocklist() {
    if (process.platform !== 'win32') {
      throw new Error('Website blocking currently supports Windows only');
    }

    try {
      const hostsContent = await fs.promises.readFile(HOSTS_PATH, 'utf8');
      const updatedContent = this.removeManagedBlockSection(hostsContent).trimEnd() + '\r\n';
      await fs.promises.writeFile(HOSTS_PATH, updatedContent, 'utf8');

      const doh = await this.setBrowserSecureDns('restore');
      await this.flushDns();

      const warnings = [];
      if (doh.failed.length) {
        warnings.push(
          `Could not restore Secure DNS for ${doh.failed.map((f) => f.browser).join(', ')} (${doh.failed[0].error})`
        );
      }
      return {
        success: true,
        cleared: true,
        blockedDomains: [],
        blockedHosts: [],
        secureDnsRestoredFor: doh.changed,
        warnings,
        message: 'Cleared all blocked sites; Secure DNS restored',
      };
    } catch (error) {
      throw new Error(`Failed to clear hosts file blocklist: ${error.message}`);
    }
  }

  async getWebsiteBlocklist() {
    if (process.platform !== 'win32') {
      return { blockedDomains: [], blockedHosts: [] };
    }
    let content = '';
    try {
      content = await fs.promises.readFile(HOSTS_PATH, 'utf8');
    } catch {
      return { blockedDomains: [], blockedHosts: [] };
    }
    const start = content.indexOf(BLOCK_START_MARKER);
    const end = content.indexOf(BLOCK_END_MARKER);
    const hosts = [];
    if (start !== -1 && end !== -1 && end > start) {
      const body = content.slice(start + BLOCK_START_MARKER.length, end);
      body.split(/\r?\n/).forEach((line) => {
        const m = line.trim().match(/^0\.0\.0\.0\s+(\S+)/i);
        if (m) hosts.push(m[1].toLowerCase());
      });
    }
    return { blockedDomains: this.sanitizeWebsites(hosts), blockedHosts: hosts };
  }

  // --- Internet block via Windows Firewall (replaces the old Wi-Fi adapter toggle) ---
  // Adds a managed OUTBOUND BLOCK rule scoped to the PUBLIC IPv4 ranges only, so the
  // LAN + LMS server stay reachable and the agent never severs its own control channel.
  // (A Block rule overrides Allow in Windows Firewall, so we block the *complement* of
  // the private/reserved ranges + the server IP rather than "block all + allow server".)
  async blockInternet() {
    if (process.platform !== 'win32') {
      throw new Error('Internet blocking currently supports Windows only');
    }
    if (!(await isElevated())) {
      throw new Error('Agent is not elevated — run the agent as Administrator to block internet (the firewall rule needs admin).');
    }

    let serverIp = '';
    try { serverIp = new URL(this.config.serverUrl).hostname; } catch { serverIp = ''; }
    const ranges = computePublicBlockRanges(serverIp);
    const psArray = ranges.map((r) => `'${r}'`).join(',');

    // -Protocol Any is explicit so UDP/QUIC (HTTP/3 on 443) is covered, not just TCP.
    const script =
      `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue; ` +
      `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Group '${FIREWALL_RULE_GROUP}' ` +
      `-Direction Outbound -Action Block -Enabled True -Profile Any -Protocol Any -RemoteAddress @(${psArray}) ` +
      `-Description '${FIREWALL_RULE_DESC}' | Out-Null`;
    await execAsync(`powershell -NoProfile -Command "${script}"`);

    return {
      success: true,
      blocked: true,
      rule: FIREWALL_RULE_NAME,
      message: `Blocked public internet via firewall rule "${FIREWALL_RULE_NAME}"; LAN + LMS server stay reachable`,
    };
  }

  async allowInternet() {
    if (process.platform !== 'win32') {
      throw new Error('Internet blocking currently supports Windows only');
    }
    if (!(await isElevated())) {
      throw new Error('Agent is not elevated — run the agent as Administrator to manage the firewall rule.');
    }

    // Surgical: touch ONLY the managed rule.
    const script =
      `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue) ` +
      `{ Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}'; 'removed' } else { 'absent' }`;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script}"`);
    const removed = /removed/i.test(stdout);

    return {
      success: true,
      blocked: false,
      rule: FIREWALL_RULE_NAME,
      removed,
      message: removed
        ? `Allowed internet — removed firewall rule "${FIREWALL_RULE_NAME}"`
        : 'Internet already allowed — no managed firewall rule present',
    };
  }

  async run() {
    this.logger.info('========================================');
    this.logger.info('DYCI PC Agent Starting...');
    this.logger.info(`Version: 1.0.0`);
    this.logger.info(`Computer ID: ${this.config.computerId}`);
    this.logger.info(`Room: ${this.config.room}`);
    this.logger.info(`Server: ${this.config.serverUrl}`);
    this.logger.info('========================================');

    // Create Windows Firewall rule (requires admin)
    await this.createFirewallRule();

    // Start Python projection API agent (host->guest projection popup/fullscreen).
    this.startPythonProjectionAgent();

    // Connect to server
    await this.connect();

    // Handle process signals
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.on('uncaughtException', (err) => {
      this.logger.error('Uncaught exception:', err);
    });
  }

  async createFirewallRule() {
    try {
      this.logger.info('Creating Windows Firewall rule...');
      
      // Use netsh command instead of PowerShell
      const removeRuleCmd = 'netsh advfirewall firewall delete rule name="DYCI PC Agent"';
      const addRuleCmd = `netsh advfirewall firewall add rule name="DYCI PC Agent" dir=in action=allow protocol=tcp localport=3001,5900-5905`;
      
      try {
        await execAsync(removeRuleCmd);
      } catch (e) {
        // Rule might not exist, that's ok
      }
      
      await execAsync(addRuleCmd);
      this.logger.info('Firewall rule created successfully');
    } catch (error) {
      this.logger.error('Failed to create firewall rule (may need admin):', error.message);
    }
  }

  shutdown() {
    this.logger.info('Shutting down agent...');
    this.stopHeartbeat();
    
    if (this.socket) {
      this.socket.disconnect();
    }

    this.stopVNC().catch(() => {});
    this.stopPythonProjectionAgent();

    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
}

// Run the agent
const agent = new PCAgent();
agent.run().catch(error => {
  console.error('Failed to start agent:', error);
  process.exit(1);
});

export default PCAgent;
