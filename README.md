# DYCI Computer Laboratory Management System (DYCICLMS)

A classroom / computer-lab management system for DYCI. An admin or instructor runs a
web **dashboard** to monitor lab PCs, and can **lock**, **shut down**, **scan the
network**, restrict websites, and **project their own screen** onto any lab PC in a
fullscreen, input‑locked overlay (**Locked Demo Mode**).

The system has two sides:

- **Host (server + dashboard)** — React + Vite frontend (`:5173`), Express + Socket.IO
  backend (`:3001`), MySQL via Prisma. The admin runs this and projects their screen.
  The host can be **macOS or Windows**.
- **Guests (lab PCs)** — each **Windows** lab PC runs two small agents that connect
  back to the host: a **Node agent** (`pc-agent/agent.js`, outbound Socket.IO — drives
  online status, Lock, Shutdown, and renders the projection overlay) and a **Python
  agent** (`agent/pc-agent/python/agent.py`, listens on TCP **5555** for screenshots /
  diagnostics).

```
Host browser (dashboard)  ──Socket.IO──►  Host server (:3001)  ──Socket.IO──►  Guest Node agent  ──►  Python locked overlay
   getDisplayMedia frames                  relays projection_*                  writes JPEG frames     (fullscreen, input-locked)
                                           HTTP GET :5555 ──────────────────►  Guest Python agent (screenshots, diagnose)
```

> Host and all guests must be on the **same LAN / subnet**.

---

## Prerequisites

| | Host (server + dashboard) | Guest (Windows lab PC) |
|---|---|---|
| Node.js | 18+ | 18+ |
| MySQL | 8.0 | — |
| Python | optional (only for the standalone `network_scanner.py`) | 3.x (python.org build — needed for the agents/overlay) |
| Git | yes | yes |

### Find the host machine's LAN IP

The guest's `--server` flag needs the host's LAN IP.

- **macOS:** `ipconfig getifaddr en0`  (Wi‑Fi may be `en1` — try that if `en0` is empty)
- **Windows:** `ipconfig` → look for **IPv4 Address** (e.g. `192.168.1.114`)

---

## Host setup (server + dashboard)

```bash
# 1. Clone and install dependencies
git clone <repo-url>
cd DYCICLMSREAL
npm install

# 2. Create the two env files from the examples, then edit the values
cp .env.example .env                 # frontend (Vite) + Prisma DATABASE_URL
cp server/.env.example server/.env   # backend: JWT_SECRET, DATABASE_URL, PC_AGENT_API_KEY, ...
```

Set a real `JWT_SECRET` and a shared `PC_AGENT_API_KEY` in `server/.env`, and point both
`DATABASE_URL`s at your MySQL. See [`.env.example`](.env.example) and
[`server/.env.example`](server/.env.example) for every key.

```bash
# 3. Create the database, then run migrations + seed
#    (in MySQL:  CREATE DATABASE labmanagement;)
npx prisma migrate dev
npx prisma db seed

# 4. Start the backend + frontend together
npm run dev:all
```

- Dashboard: **http://localhost:5173**
- API / Socket.IO: **http://localhost:3001**

> Want the host to talk to real guests? The server already listens on `0.0.0.0:3001`;
> just make sure the host firewall allows inbound TCP **3001**.

**Default logins** (from the seed):

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Instructor | `instructor` | `instructor123` |
| Student | `student` | `student123` |

Other useful scripts: `npm run dev` (frontend only), `npm run server:dev` (backend only),
`npm run build`, `npm run db:migrate`, `npm run db:seed`.

---

## Guest agent setup (Windows lab PC)

This is where setups usually fail. Follow it exactly.

### 1. Open PowerShell **as Administrator**

The projection overlay locks the keyboard/mouse using low‑level Windows hooks that only
work fully when **elevated**. Without elevation the overlay still covers the screen, but
underlying input may not be blocked. Right‑click **Windows PowerShell → Run as administrator**.

### 2. Get the code

```powershell
git clone <repo-url>
cd DYCICLMSREAL
# (or, if already cloned)  git pull
```

### 3. Install the Node agent's dependencies

The Node agent has its **own** `node_modules` (not the repo root's). Install them once:

```powershell
cd pc-agent
npm install
cd ..
```

### 4. Install the Python dependencies

So the Python agent and overlay don't crash on import:

```powershell
pip install -r agent\pc-agent\python\requirements_agent.txt
```

This installs **Flask, Pillow, psutil, mss, pywin32**. The overlay also needs **tkinter**,
which ships with the **python.org** installer (the Microsoft Store build omits it).

If `pip` isn't recognized, use the module form:

```powershell
python -m pip install -r agent\pc-agent\python\requirements_agent.txt
```

If `pywin32` errors on `win32` / `pywintypes` import, run its post‑install step once:

```powershell
python -m pywin32_postinstall -install
```

### 5. Run BOTH agents — in TWO separate Administrator PowerShell windows

Each command **stays running** (blocks). You need **both windows alive** at the same time.

**Window 1 — Node agent** (replace `<HOST_IP>` with the host's LAN IP):

```powershell
node pc-agent\agent.js --server http://<HOST_IP>:3001
```

**Window 2 — Python agent:**

```powershell
python agent\pc-agent\python\agent.py
```

#### ⚠️ The `--server` URL is the #1 failure point

It **must** be `http://` (two slashes) + the host's **correct** LAN IP + `:3001`:

```
✅  node pc-agent\agent.js --server http://192.168.1.114:3001
❌  --server http:192.168.1.114:3001     (missing  //  )
❌  --server http://192.168.1.41:3001    (wrong / typo'd IP octets)
```

Each window should print a startup line and **stay open**:

```
DYCICLMS PC Agent starting...
Server: http://192.168.1.114:3001  (from CLI --server)
Connected to server
Agent registered successfully
```

If a window drops back to the `PS>` prompt, **that agent crashed** — read the error. It's
almost always a missing module (`ModuleNotFoundError: ...`) → install it and re‑run.

### 6. Open the guest firewall for the Python agent (port 5555)

In an Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "DYCI Agent 5555" -Direction Inbound -LocalPort 5555 -Protocol TCP -Action Allow
```

### 7. Set the shared API key

The Python agent authenticates the host with a shared key. Set `api_key` in
`agent\pc-agent\python\agent_config.json` to the **same value** as `PC_AGENT_API_KEY` in
the host's `server/.env` (change the default `sk_pc_agent_CHANGE_ME` on both sides).

### 8. Verify connectivity from the host (before projecting)

From the **host**:

- **macOS:** `nc -vz <GUEST_IP> 5555`
- **Windows:** `Test-NetConnection <GUEST_IP> -Port 5555`

| Result | Meaning |
|--------|---------|
| `succeeded` / `open` | Python agent is reachable — good. |
| `connection refused` | Python agent isn't running (or wrong IP). |
| `timed out` | Firewall is blocking — re‑check step 6. |

---

## Using Locked Demo Mode (screen projection)

1. In the dashboard, go to **Admin → Developer Mode** (PC Discovery panel).
2. Confirm the guest's row shows **online** and the **correct guest IP** (the lab PC's
   real LAN IP — not the host's).
3. Project:
   - **Project to all online agents**, or
   - tick rows → **Project to selected**, or
   - use a row's per‑PC **Project** button.

   Pick the window/screen to share when the browser asks.
4. The host screen appears **fullscreen and input‑locked** on the guest. It ends only on
   **Stop projection**, host disconnect, or the guest watchdog (~8 s with no frames) —
   input is always restored.

Notes:
- Use **🩺 Diagnose guest** and **Overlay log** (per row) to troubleshoot a guest.
- Full input lock requires the guest agents to be **elevated** (Administrator).
- **Ctrl+Alt+Del** cannot be blocked from user space — a Windows limitation, not a bug.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Row shows **online** but projection does nothing | The Python agent isn't running on `5555`, or the IP shown is the host's, not the guest's. Confirm the guest's real IP and that `agent.py` is running. |
| `ModuleNotFoundError` on the Python agent | A package is missing — install it: `python -m pip install <name>` (or re‑run the `requirements_agent.txt` install). |
| `Python agent unreachable …:5555 (ECONNREFUSED)` | Python agent not running, or wrong guest IP. Start `agent.py`; verify the IP. |
| `nc` / `Test-NetConnection` → **connection refused** | Agent is down — start the Python agent. |
| `nc` / `Test-NetConnection` → **timed out** | Firewall — add the inbound rule for TCP `5555` (Guest setup step 6). |
| Node agent window closes / `HTTP check failed` | Wrong `--server` URL or host not running. Use `http://<HOST_IP>:3001` (two slashes, correct IP); start the host with `npm run dev:all`; allow inbound TCP `3001` on the host. |
| `node pc-agent\agent.js` → `Cannot find module 'systeminformation'` | You skipped the agent's install — run `cd pc-agent && npm install`. |
| Overlay error: `Pillow/tkinter not importable` | Install Pillow (`python -m pip install pillow`) and use the python.org build (it includes tkinter). |
| Overlay covers screen but input still works | Agents not elevated — relaunch both PowerShell windows **as Administrator**. |
| `401 Unauthorized` from the guest agent | `api_key` in `agent_config.json` doesn't match the host's `PC_AGENT_API_KEY`. Make them identical. |
| Guest's IP changed after reboot (DHCP) | Re‑scan / restart the Node agent (it self‑heals each heartbeat). For stable lab PCs, set **DHCP reservations** so IPs don't move. |

---

## Security note (rotate previously committed secrets)

Real `.env` files were committed to this repo earlier and are now untracked (`.env` and
`server/.env`), with `.env.example` templates added in their place. Because the old values
remain in **git history**, rotate them:

- **`PC_AGENT_API_KEY`** — set a new value in `server/.env` and in every guest's
  `agent_config.json`.
- **`JWT_SECRET`** — set a new random value in `server/.env` (this invalidates existing tokens).
- **Database password** — change the MySQL password and update both `DATABASE_URL`s.

Never commit real `.env` files — keep secrets only in your local (git‑ignored) `.env`.
