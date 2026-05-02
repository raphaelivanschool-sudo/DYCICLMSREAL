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
export function resolveComputerIdFromConnectedAgents(connectedComputers, query) {
  if (!connectedComputers?.size) return null;
  const wantIp = normalizeIp(query?.ip || "");
  const wantMac = normalizeMac(query?.mac || "");

  let macMatch = null;
  let ipMatch = null;

  for (const [id, entry] of connectedComputers.entries()) {
    const c = entry?.computer;
    if (!c) continue;

    if (wantMac) {
      const cm = normalizeMac(c.mac || "");
      if (cm && cm === wantMac) {
        macMatch = id;
        break;
      }
    }
  }

  if (macMatch) return macMatch;

  if (!wantIp) return null;

  for (const [id, entry] of connectedComputers.entries()) {
    const c = entry?.computer;
    if (!c) continue;

    if (normalizeIp(c.ip) === wantIp) {
      ipMatch = id;
      break;
    }
    const addrs = Array.isArray(c.ipAddresses) ? c.ipAddresses : [];
    if (addrs.some((a) => normalizeIp(a) === wantIp)) {
      ipMatch = id;
      break;
    }
  }

  return ipMatch;
}
