# TightVNC Broadcast Discovery

## Overview

The DYCI PC Control Panel now supports **UDP broadcast-based discovery** of TightVNC services on the local network. This allows PCs with TightVNC to be discovered instantly without waiting for network scans.

## How It Works

```
┌─────────────────┐                    ┌─────────────────┐
│   Target PC     │                    │  DYCI Server    │
│  (192.168.1.193)│                    │  (192.168.1.1)  │
│                 │  UDP Broadcast     │                 │
│  ┌───────────┐  │  (Port 41234)      │  ┌───────────┐  │
│  │ TightVNC  │  │ ───────────────►   │  │ UDP       │  │
│  │ Server    │  │                    │  │ Listener  │  │
│  │ (Port 5900)│ │                    │  │           │  │
│  └───────────┘  │  ┌───────────────   │  └─────┬─────┘  │
│       ▲         │  │                  │        │        │
│       │         │  │                  │        ▼        │
│  ┌────┴────┐    │  │ Announcement:    │  ┌───────────┐   │
│  │ Agent   │────┘  │  {               │  │ Socket.IO │   │
│  │Service  │──────►│    type:        │  │ Broadcast │   │
│  │         │       │    "tightvnc-   │  └─────┬─────┘   │
│  └─────────┘       │    announce",   │        │         │
│                    │    hostname:    │        ▼         │
│                    │    "PC-193",    │  ┌───────────┐    │
│                    │    ip:          │  │ PC Control│    │
│                    │    "192.168.    │  │ Panel UI  │    │
│                    │    1.193",      │  │           │    │
│                    │    port: 5900   │  └───────────┘    │
│                    │  }              │                   │
│                    │                 │                   │
└────────────────────┘                 └───────────────────┘
```

## Discovery Methods

### 1. UDP Broadcast (Instant) 🟣
- **Speed**: Instant (no scanning required)
- **Mechanism**: Agent sends UDP broadcast every 30 seconds
- **Badge**: Purple "Broadcast" badge
- **Best For**: Quick discovery of PCs with the agent installed

### 2. Socket.IO Agent (Persistent) 🔵
- **Speed**: Real-time connection
- **Mechanism**: WebSocket connection with full agent
- **Badge**: Blue "Agent" badge
- **Best For**: Full remote control capabilities

### 3. Network Scan (On-Demand) 🟢
- **Speed**: 30-60 seconds for full subnet
- **Mechanism**: Ping sweep + port scan
- **Badge**: Green "Online" badge
- **Best For**: Finding PCs without the agent

## Setup Options

### Option A: Full Agent (Recommended)
Installs the complete agent with UDP broadcast + Socket.IO connection.

```bash
# Generate installer from Settings panel
# Run on target PC
DYCI-Agent-Setup.exe
```

### Option B: Lightweight Broadcaster Only
For PCs that already have TightVNC installed but need discovery.

```bash
# Copy vnc-broadcaster.js to target PC
# Run with Node.js
node vnc-broadcaster.js
```

**To install as Windows service:**
```bash
npm install -g node-windows
node vnc-broadcaster-install.js
```

### Option C: Manual Discovery
Use network scanning if you cannot install software on target PCs.

```
PC Control Panel → Scan Network → Select Subnet → 192.168.1.x
```

## Broadcast Protocol

### Port
- **Discovery Port**: `41234/UDP`

### Announcement Format
```json
{
  "type": "tightvnc-announce",
  "computerId": "pc-192-168-1-193",
  "hostname": "Teacher-PC",
  "ip": "192.168.1.193",
  "port": 5900,
  "hasAgent": true,
  "vncRunning": true,
  "timestamp": "2026-04-16T15:30:00.000Z"
}
```

### Broadcast Addresses
The broadcaster sends to:
1. Calculated broadcast address for each interface (e.g., `192.168.1.255`)
2. Fallback to `255.255.255.255` if no interfaces detected

## Firewall Requirements

### On Target PCs (Running Agent/Broadcaster)
- **Outbound UDP**: Port 41234 (for broadcasts)
- **Outbound TCP**: Server port (default 3001) for Socket.IO
- **Inbound TCP**: Port 5900 for TightVNC connections

### On DYCI Server
- **Inbound UDP**: Port 41234 (for discovery broadcasts)
- **Inbound TCP**: Port 3001 for Socket.IO connections

## Troubleshooting

### PCs Not Appearing via Broadcast

1. **Check Windows Firewall**
   ```powershell
   # Allow UDP 41234
   netsh advfirewall firewall add rule name="DYCI Discovery" dir=out action=allow protocol=udp localport=41234
   ```

2. **Verify Agent is Running**
   ```powershell
   # Check for agent process
   Get-Process -Name "node" | Where-Object {$_.CommandLine -like "*pc-agent*"}
   ```

3. **Test Broadcast Reception**
   ```bash
   # On server, run test listener
   node server/utils/broadcast-test.js
   ```

4. **Check Network Segmentation**
   - UDP broadcasts only work within the same subnet
   - Routers typically block broadcast packets between subnets

### Testing Discovery

```bash
# 1. Start test listener on server
node server/utils/broadcast-test.js

# 2. Run broadcaster on target PC
node agent/vnc-broadcaster.js

# 3. Check PC Control Panel
# You should see the PC appear with purple "Broadcast" badge
```

## UI Indicators

### Status Badges
- 🔵 **Agent**: Full Socket.IO connection established
- 🟣 **Broadcast**: Discovered via UDP broadcast
- 🟢 **Online**: Discovered via network scan
- ⚫ **Offline**: PC not responding

### Filter Options
- **PCs Only**: Shows all PCs (agents + broadcast + network)
- **Agent-Connected Only**: Only Socket.IO connected PCs
- **Broadcast Only**: Only UDP-discovered PCs
- **All Devices**: Everything including phones, printers

## Security Considerations

1. **Broadcast Scope**: UDP broadcasts only reach the local subnet
2. **No Authentication**: Discovery announcements are unauthenticated
3. **Information Leaked**: IP, hostname, VNC port availability
4. **Mitigation**: Use on trusted networks only; consider VLAN isolation

## Performance

- **Broadcast Interval**: 30 seconds (configurable)
- **Service Timeout**: 2 minutes (services older than this are removed)
- **Network Impact**: Minimal (~200 bytes per broadcast)
- **CPU Impact**: Negligible

## Future Enhancements

- mDNS/Zeroconf support for cross-platform discovery
- Encrypted announcements with shared secret
- WebRTC for direct browser-to-PC connections
- SSDP (UPnP) compatibility for IoT device discovery
