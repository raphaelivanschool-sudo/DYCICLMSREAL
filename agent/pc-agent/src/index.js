#!/usr/bin/env node
import { io } from 'socket.io-client';
import si from 'systeminformation';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dgram from 'dgram';
// PowerShell functionality removed - using exec commands instead
// import screenshot from 'screenshot-desktop'; // Temporarily disabled
import { spawn, exec } from 'child_process';
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

      // Get active network interface
      const activeInterface = network.find(ni => 
        ni.ip4 && !ni.internal && ni.ip4.startsWith('192.168.')
      ) || network.find(ni => ni.ip4 && !ni.internal);

      const ip = activeInterface?.ip4 || '0.0.0.0';
      const mac = activeInterface?.mac || '00:00:00:00:00:00';

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

  setupEventHandlers() {
    // Connection established
    this.socket.on('connect', async () => {
      this.logger.info('Connected to server: ' + this.socket.id);
      this.reconnectAttempts = 0;

      // Register this computer
      const computerData = await this.getSystemInfo();
      this.socket.emit('agent_register', computerData);
      
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
            timestamp: new Date()
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
    const { action, params, from } = command;
    
    try {
      let result;
      
      switch (action) {
        case 'lock':
          result = await this.lockWorkstation();
          break;
        case 'shutdown':
          result = await this.shutdownPC(params?.delay || 0);
          break;
        case 'restart':
          result = await this.restartPC(params?.delay || 0);
          break;
        case 'vnc-start':
          result = await this.startVNC(params);
          break;
        case 'vnc-stop':
          result = await this.stopVNC();
          break;
        // case 'screenshot':
        //   result = await this.takeScreenshot();
        //   break;
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
        default:
          result = { success: false, error: `Unknown command: ${action}` };
      }

      // Send result back
      this.socket.emit('command_result', {
        action,
        success: result.success !== false,
        result,
        from,
        timestamp: new Date()
      });

    } catch (error) {
      this.logger.error(`Command ${action} failed:`, error);
      
      this.socket.emit('command_result', {
        action,
        success: false,
        error: error.message,
        from,
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

  async shutdownPC(delay = 0) {
    this.logger.info(`Shutting down PC (delay: ${delay}s)...`);
    try {
      const cmd = delay > 0 
        ? `shutdown /s /t ${delay} /c "Shutdown requested by Lab Management System"`
        : 'shutdown /s /t 0';
      await execAsync(cmd);
      return { success: true, message: `Shutdown initiated (delay: ${delay}s)` };
    } catch (error) {
      throw new Error('Failed to shutdown: ' + error.message);
    }
  }

  async restartPC(delay = 0) {
    this.logger.info(`Restarting PC (delay: ${delay}s)...`);
    try {
      const cmd = delay > 0 
        ? `shutdown /r /t ${delay} /c "Restart requested by Lab Management System"`
        : 'shutdown /r /t 0';
      await execAsync(cmd);
      return { success: true, message: `Restart initiated (delay: ${delay}s)` };
    } catch (error) {
      throw new Error('Failed to restart: ' + error.message);
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

  // async takeScreenshot() {
  //   this.logger.info('Taking screenshot...');
  //   try {
  //     const img = await screenshot();
  //     const base64 = img.toString('base64');
  //     
  //     return {
  //       success: true,
  //       image: base64,
  //       format: 'png',
  //       timestamp: new Date()
  //     };
  //   } catch (error) {
  //     throw new Error('Failed to take screenshot: ' + error.message);
  //   }
  // }

  generateRandomPassword(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  sanitizeWebsites(websites = []) {
    const cleaned = new Set();
    websites.forEach((website) => {
      const normalized = String(website || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0];
      if (normalized) cleaned.add(normalized);
    });
    return Array.from(cleaned);
  }

  buildBlockSection(websites) {
    const lines = [BLOCK_START_MARKER];
    websites.forEach((site) => {
      lines.push(`127.0.0.1 ${site}`);
      lines.push(`127.0.0.1 www.${site}`);
    });
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

  async setWebsiteBlocklist(websites = []) {
    if (process.platform !== 'win32') {
      throw new Error('Website blocking currently supports Windows only');
    }

    const sanitized = this.sanitizeWebsites(websites);
    if (sanitized.length === 0) {
      throw new Error('No valid websites provided');
    }

    try {
      let hostsContent = await fs.promises.readFile(HOSTS_PATH, 'utf8');
      hostsContent = this.removeManagedBlockSection(hostsContent).trimEnd();
      hostsContent += `\r\n\r\n${this.buildBlockSection(sanitized)}`;
      await fs.promises.writeFile(HOSTS_PATH, hostsContent, 'utf8');
      return { success: true, blockedSites: sanitized };
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
      return { success: true, cleared: true };
    } catch (error) {
      throw new Error(`Failed to clear hosts file blocklist: ${error.message}`);
    }
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
