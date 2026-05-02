/**
 * Match a socket-connected PC agent when the UI only knows scan/broadcast IP or MAC.
 */

export function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return "";
  return ip.trim().toLowerCase();
}

export function normalizeMac(mac) {
  if (!mac || typeof mac !== "string") return "";
  return mac.replace(/[:-]/g, "").toLowerCase();
}

/**
 * @param {Map} connectedComputers - server Map from agent_register
 * @param {{ ip?: string, mac?: string }} query
 * @returns {string|null} computer id (UUID) for Socket.IO room computer_${id}
 */
function collectMacsFromComputer(c) {
  const macs = new Set();
  if (!c || typeof c !== "object") return macs;
  const push = (m) => {
    const n = normalizeMac(m || "");
    if (n) macs.add(n);
  };
  push(c.mac);
  const bindings = Array.isArray(c.interfaceBindings) ? c.interfaceBindings : [];
  for (const b of bindings) {
    push(b?.mac);
  }
  return macs;
}

function collectIpsFromComputer(c) {
  const ips = new Set();
  if (!c || typeof c !== "object") return ips;
  const push = (ip) => {
    const n = normalizeIp(ip || "");
    if (n) ips.add(n);
  };
  push(c.ip);
  const addrs = Array.isArray(c.ipAddresses) ? c.ipAddresses : [];
  addrs.forEach((a) => push(a));
  const bindings = Array.isArray(c.interfaceBindings) ? c.interfaceBindings : [];
  for (const b of bindings) {
    push(b?.ip);
  }
  return ips;
}

export function resolveComputerIdFromConnectedAgents(connectedComputers, query) {
  if (!connectedComputers?.size) return null;
  const wantIp = normalizeIp(query?.ip || "");
  const wantMac = normalizeMac(query?.mac || "");

  if (wantMac) {
    for (const [id, entry] of connectedComputers.entries()) {
      const macs = collectMacsFromComputer(entry?.computer);
      if (macs.has(wantMac)) return id;
    }
  }

  if (!wantIp) return null;

  for (const [id, entry] of connectedComputers.entries()) {
    const ips = collectIpsFromComputer(entry?.computer);
    if (ips.has(wantIp)) return id;
  }

  return null;
}

/**
 * Resolve which Socket.IO agent session should receive a command.
 *
 * When IP/MAC discovery fails (e.g. scan shows LAN IP but agent registered as 127.0.0.1),
 * and exactly one agent is connected, route commands that include an IP or MAC hint to that
 * session. Typical single-PC developer setup.
 *
 * @returns {{ targetId: string|null, strategy: 'explicit-valid-id'|'ip-mac-match'|'single-session-fallback'|null }}
 */
export function pickAgentTargetId(connectedComputers, { computerId, ip, mac }) {
  if (!connectedComputers?.size) {
    return { targetId: null, strategy: null };
  }

  if (computerId && connectedComputers.has(computerId)) {
    return { targetId: computerId, strategy: "explicit-valid-id" };
  }

  const resolved = resolveComputerIdFromConnectedAgents(connectedComputers, { ip, mac });
  if (resolved) {
    return { targetId: resolved, strategy: "ip-mac-match" };
  }

  const discoveryHint = normalizeIp(ip || "") || normalizeMac(mac || "");
  if (connectedComputers.size === 1 && discoveryHint) {
    const onlyId = connectedComputers.keys().next().value;
    return { targetId: onlyId, strategy: "single-session-fallback" };
  }

  return { targetId: null, strategy: null };
}

/**
 * Choose the LAN IP used to reach the PC agent HTTP API (Flask on port 5555).
 * Prefer the discovery-row IP from the dashboard when it is not loopback.
 */
export function resolveLanIpForPcAgent(connectedComputers, targetId, hintIp) {
  if (!targetId || !connectedComputers?.has(targetId)) {
    return null;
  }
  const hint = normalizeIp(hintIp || "");
  if (hint && hint !== "127.0.0.1" && hint !== "::1") {
    return hint;
  }
  const entry = connectedComputers.get(targetId);
  const c = entry?.computer || {};
  const ips = [...collectIpsFromComputer(c)];
  const lan = ips.find(
    (i) =>
      i &&
      !i.startsWith("127.") &&
      !i.startsWith("::1") &&
      !i.startsWith("169.254."),
  );
  return lan || ips[0] || null;
}
