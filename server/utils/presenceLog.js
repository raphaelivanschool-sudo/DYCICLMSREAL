/**
 * Agent presence history for the usage reports (Stage 1).
 *
 * Records ONLINE/OFFLINE transitions in AgentPresenceLog and keeps the
 * Agent row's status/lastSeen current. Transition-only: heartbeats just
 * refresh lastSeen (no extra rows). Online intervals are later derived by
 * pairing each ONLINE with the next OFFLINE. Everything is best-effort and
 * guarded — presence logging must never block or break the socket path.
 */

const MAX = 191; // safe length for indexed varchar columns

function clip(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, MAX) : null;
}

/** A usable MAC we can key the Agent table on (it has a unique mac column). */
function usableMac(mac) {
  const m = clip(mac);
  if (!m) return null;
  return m.toLowerCase() === 'unknown' ? null : m;
}

/** Pull the reporting fields out of an agent's registration/status payload. */
function fieldsFrom(computerData = {}) {
  const mac = usableMac(computerData.mac);
  const hostname = clip(computerData.hostname || computerData.name);
  const ipAddress = clip(computerData.ip);
  // Stable identity even when MAC is missing: fall back to the reported id/hostname.
  const agentKey = mac || clip(computerData.id) || hostname || 'unknown';
  const platform =
    clip(computerData.platform || computerData.distro || computerData.os) || 'unknown';
  return { mac, hostname, ipAddress, agentKey, platform };
}

/**
 * Upsert the Agent row (by MAC) to the given status and write a presence
 * transition row. `event` is 'ONLINE' or 'OFFLINE'.
 */
export async function recordPresence(prisma, computerData, event) {
  if (!prisma || (event !== 'ONLINE' && event !== 'OFFLINE')) return;
  try {
    const { mac, hostname, ipAddress, agentKey, platform } = fieldsFrom(computerData);
    const status = event === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    const now = new Date();

    let agentId = null;
    if (mac) {
      const agent = await prisma.agent.upsert({
        where: { mac },
        create: {
          hostname: hostname || 'unknown',
          ipAddress: ipAddress || 'unknown',
          mac,
          platform,
          status,
          lastSeen: now,
        },
        update: {
          ...(hostname ? { hostname } : {}),
          ...(ipAddress ? { ipAddress } : {}),
          platform,
          status,
          lastSeen: now,
        },
        select: { id: true },
      });
      agentId = agent.id;
    }

    await prisma.agentPresenceLog.create({
      data: { agentId, agentKey, hostname, ipAddress, mac, event: status, at: now },
    });
  } catch (e) {
    console.error('[recordPresence]', event, e.message);
  }
}

/** Heartbeat / status update: refresh lastSeen only (no presence row). */
export async function touchAgentSeen(prisma, computerData) {
  if (!prisma) return;
  try {
    const mac = usableMac(computerData?.mac);
    if (!mac) return;
    await prisma.agent.updateMany({
      where: { mac },
      data: { lastSeen: new Date(), status: 'ONLINE' },
    });
  } catch (e) {
    console.error('[touchAgentSeen]', e.message);
  }
}
