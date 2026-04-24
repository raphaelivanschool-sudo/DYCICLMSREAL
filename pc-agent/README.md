# DYCICLMS PC Agent

A lightweight PC agent that runs on lab computers to enable monitoring and control from the DYCICLMS web interface.

## What This Agent Does

- **Reports PC status** to the central server (online, user logged in, hardware specs)
- **Sends periodic updates** about CPU, memory, and system status
- **Receives commands** from instructors (lock, logout, restart, shutdown, message)
- **Runs as a Windows service** for automatic startup and background operation

## Features

| Feature | Description |
|---------|-------------|
| **Real-time Status** | Reports computer name, IP, logged-in user, OS info |
| **System Monitoring** | CPU usage, memory usage, running processes |
| **Remote Lock** | Lock the computer screen remotely |
| **Remote Logout** | Log out the current user |
| **Remote Restart** | Restart the computer |
| **Remote Shutdown** | Shut down the computer |
| **Send Messages** | Display popup messages to the user |
| **Auto-reconnect** | Automatically reconnects if connection is lost |

## Installation

### Prerequisites

- Windows 10/11 or Windows Server
- Node.js 16+ installed
- Administrator privileges (for service installation)

### Step 1: Install Dependencies

```bash
cd pc-agent
npm install
```

### Step 2: Configure the Agent

Edit `agent.js` or set environment variables:

```javascript
// In agent.js, update the CONFIG section:
const CONFIG = {
  serverUrl: 'http://your-server-ip:3001',  // Your DYCICLMS server URL
  computerId: 'lab-pc-01',                   // Unique ID for this computer
  heartbeatInterval: 30000,
  statusUpdateInterval: 5000
};
```

Or use environment variables:
```bash
set SERVER_URL=http://your-server-ip:3001
set COMPUTER_ID=lab-pc-01
```

### Step 3: Install as Windows Service (Recommended)

Run as Administrator:

```bash
node install-service.js
```

This will:
- Install the agent as a Windows service
- Start the service automatically
- Configure it to start on boot

### Step 4: Verify Installation

Check the Windows Services:
1. Press `Win + R`, type `services.msc`
2. Look for "DYCICLMS PC Agent"
3. Status should be "Running"

## Manual Operation (Without Service)

If you don't want to install as a service:

```bash
npm start
```

Or directly:
```bash
node agent.js
```

## Uninstallation

Run as Administrator:

```bash
node uninstall-service.js
```

## Architecture

```
┌─────────────────┐         WebSocket         ┌─────────────────┐
│   Lab PC #1     │ ◄──────────────────────► │  DYCICLMS       │
│  (This Agent)   │    Status & Commands      │  Server         │
└─────────────────┘                            └─────────────────┘
         │                                              │
         │         ┌──────────────────┐                 │
         └────────►│ Instructor Dashboard│◄───────────────┘
                   │ (DeveloperMode)    │    Commands
                   └──────────────────┘
```

## Communication Protocol

### Agent to Server (Status Reports)
- `agent_register` - Initial registration with computer info
- `agent_status_update` - Periodic status updates (CPU, memory, user)
- `agent_heartbeat` - Keep-alive signal

### Server to Agent (Commands)
- `execute_command` - Execute action on the PC
  - `lock` - Lock the computer
  - `logout` - Log out current user
  - `restart` - Restart the computer
  - `shutdown` - Shut down the computer
  - `message` - Show a popup message
  - `get_status` - Request immediate status update

## Troubleshooting

### Agent won't connect
1. Check server URL is correct
2. Verify server is running
3. Check firewall allows outbound connections on port 3001
4. Check agent logs for errors

### Service won't start
1. Run Command Prompt as Administrator
2. Check Node.js is in system PATH
3. Review Windows Event Viewer for errors

### Commands not working
1. Verify agent is running with admin privileges
2. Check Windows User Account Control settings
3. Review agent console output for error messages

## Security Considerations

- The agent requires administrator privileges for some commands (lock, logout, restart, shutdown)
- Use a secure token for agent authentication (set AGENT_TOKEN environment variable)
- The agent only makes outbound connections - no incoming ports required
- All communication is through WebSocket with your DYCICLMS server

## Files

- `agent.js` - Main agent code
- `install-service.js` - Windows service installer
- `uninstall-service.js` - Windows service uninstaller
- `package.json` - Dependencies and scripts
- `README.md` - This file

## Support

For issues or questions, contact the DYCICLMS administrator.
