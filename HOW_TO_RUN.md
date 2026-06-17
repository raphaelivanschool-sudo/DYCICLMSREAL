# How to Run the Lab Management System

## Prerequisites

1. **Node.js** (v18 or higher)
2. **MySQL** (v8.0 or higher)
3. **Git** (for cloning the repository)

## Initial Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Database Setup

#### MySQL Configuration
- Make sure MySQL is running on your system
- Create a database named `labmanagement`
- Update the `.env` file if your MySQL credentials are different:

```env
DATABASE_URL="mysql://username:password@localhost:3306/labmanagement"
```

#### Run Database Migrations
```bash
npx prisma migrate dev
```

#### Seed the Database (Optional - for initial data)
```bash
npx prisma db seed
```

## Running the Project

### Option 1: Run Both Frontend and Backend Together
```bash
npm run dev:all
```

### Option 2: Run Separately (Recommended for Development)

#### Terminal 1 - Frontend (React + Vite)
```bash
npm run dev
```
- Frontend will run on: http://localhost:5173

#### Terminal 2 - Backend (Node.js + Express)
```bash
npm run server:dev
```
- Backend API will run on: http://localhost:3001

## Default Login Credentials

| Role | Username | Password |
|------|----------|----------|
| Admin | admin | admin123 |
| Instructor | instructor | instructor123 |
| Student | student | student123 |

## Project Structure

```
DYCICLMS4/
├── src/                 # React frontend source code
├── server/              # Node.js backend source code
├── prisma/              # Database schema and migrations
├── public/              # Static assets
├── electron/            # Electron app configuration
└── .env                 # Environment variables
```

## Available Scripts

- `npm run dev` - Start frontend development server
- `npm run server:dev` - Start backend development server with nodemon
- `npm run dev:all` - Start both frontend and backend simultaneously
- `npm run build` - Build for production
- `npm run db:migrate` - Run Prisma database migrations
- `npm run db:seed` - Seed database with initial data
- `npm run electron` - Run Electron desktop app
- `npm run lint` - Run ESLint

## Database Management

### Reset Database (Warning: This will delete all data)
```bash
npx prisma migrate reset --force
```

### View Database
```bash
npx prisma studio
```
- Opens Prisma Studio at http://localhost:5555

## Troubleshooting

### Common Issues

1. **Database Connection Error**
   - Ensure MySQL is running
   - Check DATABASE_URL in .env file
   - Verify database exists: `CREATE DATABASE labmanagement;`

2. **Migration Conflicts**
   - Reset database: `npx prisma migrate reset --force`
   - Then run migrations again: `npx prisma migrate dev`

3. **Port Already in Use**
   - Frontend (5173) or Backend (3001) might be in use
   - Kill processes or change ports in configuration

4. **Node Modules Issues**
   - Delete node_modules folder and package-lock.json
   - Run `npm install` again

### Environment Variables

Make sure your `.env` file contains:
```env
VITE_API_URL="http://localhost:3001"
VITE_SOCKET_URL="http://localhost:3001"
DATABASE_URL="mysql://root:@localhost:3306/labmanagement"
```

## Screen Projection (Locked Demo Mode)

Broadcast an instructor/admin's screen to one, several, or **all** online lab PCs.
On each targeted guest the screen appears in a **fullscreen, always-on-top,
input-locked overlay** the student cannot close, minimize, or alt-tab out of. It
ends only when the host clicks **Stop**, the host disconnects, or a safety
watchdog fires — and input is always restored.

### How it works (data flow)

```
Browser host (getDisplayMedia)  ->  Server (Socket.IO session manager)  ->  Guest Node agent  ->  Python locked overlay
   projection:start/frame/ping        fans out projection_start/frame/        projection_overlay.py (global
   projection:status (per-guest)      ping/stop to each computer_<id>          keyboard+mouse hooks, watchdog)
```

The server is the single authority: the browser talks only to the server, the
server relays to guest agents over the existing Socket.IO channel (no extra
ports). Frames are JPEG; the agent renders newest-frame-wins and drops stale ones.

### Using it

1. Open **Admin -> Developer Mode** (PC Discovery panel).
2. **Project to all online agents**, or tick rows and **Project to selected**, or
   use the per-row **Project** button. Pick a window/screen when the browser asks.
3. Watch per-guest badges (`connecting` -> `projecting`, or `error`/`offline`) and
   the red session banner. Click the big red **Stop projection** to end it everywhere.
4. **Advanced** lets you tune FPS (5-20), JPEG quality (30-85), and max width.

### Guest requirements

- Both the **Node agent** (`pc-agent/agent.js`) and the **Python agent**
  (`agent/pc-agent/python/`) run on each lab PC. The Node agent spawns
  `projection_overlay.py` (needs `Pillow` + Python 3 / Tkinter, already in
  `requirements_agent.txt`).
- **Run the agent elevated (Administrator).** Full keyboard/mouse lockdown uses
  Windows low-level hooks that only fully work when elevated. Without elevation
  the overlay still covers the screen but underlying input may not be swallowed.
- **Ctrl+Alt+Del** (Secure Attention Sequence) **cannot** be blocked from user
  space — this is a Windows platform limitation, not a bug.

### Ports

- Projection rides the existing agent **Socket.IO** connection to the server
  (default port **3001**). No inbound ports are opened on guests.
- The Python agent's HTTP API (screenshots, etc.) still listens on **5555**.

### Tunables (server environment, in `server/.env`)

| Variable | Default | Range | Purpose |
|----------|---------|-------|---------|
| `PROJECTION_FPS` | 12 | 5-20 | Target capture/broadcast frame rate |
| `PROJECTION_JPEG_QUALITY` | 60 | 30-85 | JPEG quality (bandwidth vs. clarity) |
| `PROJECTION_MAX_WIDTH` | 1280 | — | Max frame width (preserves aspect) |
| `PROJECTION_WATCHDOG_SECONDS` | 8 | 3-60 | Guest auto-teardown if no frame/ping |
| `PROJECTION_RESEND_TO_LATE_JOINERS` | true | — | Resync agents that connect mid-broadcast (for "all") |

Guest-agent overrides (env or `pc-agent/agent.config.json`): `PROJECTION_OVERLAY_PATH`
(path to `projection_overlay.py`), `PROJECTION_PYTHON` (python launcher, default
`pythonw.exe` on Windows).

### Safety / fail-open

A guest is **never left permanently locked**: if the agent loses the server, or
no frame/ping arrives within `PROJECTION_WATCHDOG_SECONDS`, or the host tab/process
dies, the overlay tears down and input is restored. Stop is idempotent and always wins.

### Manual QA checklist (run on a Windows guest, e.g. `acer / 26.191.85.125`)

Setup: start the server (`npm run server:dev`) and the web app (`npm run dev`).
On the guest PC, run **both** agents **as Administrator** (elevation is required
for full input lock):

```powershell
# Node agent (Socket.IO) — point it at the server
node pc-agent\agent.js --server http://<SERVER_IP>:3001
# Python agent (screenshots) in another elevated terminal
python agent\pc-agent\python\agent.py
```

Then verify, from **Admin → Developer Mode**:

1. **Project to all** — overlay appears on the guest within ~2s, fullscreen across
   all monitors, on top of the taskbar; dashboard badge shows `projecting`.
2. **Locked** — on the guest, try Esc, Alt+Tab, Alt+F4, Win key, mouse clicks:
   none escape the overlay. (Ctrl+Alt+Del is expected to still work — documented.)
3. **Frames** — moving a window on the host appears on the guest smoothly.
4. **Stop** — click the red **Stop projection**: overlay vanishes instantly and the
   guest keyboard/mouse work again.
5. **Project to selected** — tick ≥1 row, **Project to selected**: only those guests lock.
6. **Per-row Project** — the row's 🖥️ Project button locks just that PC.
7. **Host tab close** — start projecting, then close the browser tab: the guest
   auto-unlocks within a couple seconds (server detected host disconnect).
8. **Watchdog** — while projecting, pull the guest's network (or stop the server):
   the overlay tears down and input is restored within `PROJECTION_WATCHDOG_SECONDS` (~8s).
9. **Late joiner** — start **Project to all**, then start a new agent: it receives
   the stream and locks too.
10. **Regression** — confirm **Lock**, **Shutdown**, **Refresh screenshot**, and
    **Scan Network** still work as before.

If full input lock does not engage, confirm the agent is running **elevated**; the
dashboard badge will read `error: SetWindowsHookEx failed …` when it is not.

### Diagnosing a guest (host = macOS, guest = Windows)

Because the macOS host can't see the Windows guest's screen, two tools report guest health:

- **Dashboard → Developer Mode → 🩺 Diagnose guest** (per selected row): shows ✅/❌ for
  Node agent online, Python agent reachable on 5555, api_key match, capture (mss/Pillow),
  overlay script present, and elevation — plus plain-language errors.
- **`scripts/guest-selftest.ps1`** — run **on the Windows guest**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\guest-selftest.ps1 -ExpectedApiKey "<server PC_AGENT_API_KEY>"
  ```
  Checks Python + deps (mss, Pillow, tkinter; pywin32 only for service mode), that the
  agent listens on 5555, the inbound firewall rule, the api_key (masked) and whether it
  matches, a real test capture, and an overlay dry-run (no input lock). Run as
  Administrator to also confirm the input-lock path. Overlay crashes are logged to
  `%TEMP%\dyci_projection_overlay.log`.

> If "Refresh screenshot" still shows a `screenCapture_*.exe` error, the guest is running
> an **old agent build** (with the removed `screenshot-desktop`). Pull the latest code and
> restart both agents on the guest. Set `PROJECTION_DEBUG=true` (server env or
> `agent.config.json`) for verbose per-hop projection logging while diagnosing.

### Per-hop frame-flow diagnostics ("overlay is up but nothing renders")

While a projection is live, **Developer Mode** shows a live **Frame flow** readout so you
can see exactly which hop drops to 0 fps. The four hops, in order:

```
① Browser emit   →  ② Server recv/relay  →  ③ Agent recv/write  →  ④ Overlay decode/paint
(this browser)      (Socket.IO session)     (guest Node agent)     (guest Python overlay)
```

- **① and ② shown at the top of the panel; ③ and ④ on each PC row** (`③ recv/write · ④ decode/paint`).
- Read it left-to-right and find the **first hop that sits near 0 while the one before it is healthy** — that hop is the bug:

| First hop at ~0 | Likely cause |
|---|---|
| ① Browser emit | Capture loop not running / screen-share ended / tab throttled. Re-pick the share. |
| ② Server recv | Frames not reaching the server — host socket dropped, or a frame exceeded the Socket.IO buffer (now 16 MB). |
| ② relay (recv OK) | No online guest in `projecting`/`connecting` state to relay to. |
| ③ Agent recv | Server relaying but the guest agent isn't receiving — wrong room / agent reconnecting / client buffer. |
| ③ write (recv OK) | Agent receiving but failing to write the frame file (disk/temp permission) — check the agent console. |
| ④ `no overlay stats` | Overlay process not writing its stats file — overlay crashed/relaunching; fetch the **Overlay log**. |
| ④ decode = 0 (write OK) | Overlay reads the file but **can't decode** it (bad/garbled JPEG) — overlay log shows `frame decode/render failed`. |
| ④ paint < decode | Decoding but not painting (window not sized/mapped) — rare; usually self-corrects. |

The agent reports ③/④ over a `projection_stats` Socket.IO event each second (overlay
counters come from `%TEMP%\dyci_projection_overlay.stats`). Enable `PROJECTION_DEBUG=true`
to also log these counts in the server and agent consoles.

## Features

- **User Management**: Admin, Instructor, and Student roles
- **Laboratory Management**: Schedule and manage computer labs
- **Computer Inventory**: Track computer specifications and status
- **Real-time Messaging**: Chat system with Socket.io
- **Class Groups**: Organize students by class sections
- **Electron App**: Desktop application support

## Development Tips

- Frontend uses React with Vite, TailwindCSS, and Radix UI components
- Backend uses Express.js with JWT authentication
- Database uses Prisma ORM with MySQL
- Real-time features powered by Socket.io
- Hot reload enabled for both frontend and backend during development

## Support

If you encounter any issues:
1. Check the troubleshooting section above
2. Ensure all prerequisites are installed
3. Verify database connection and migrations
4. Check terminal output for specific error messages
