/**
 * Structured control-action log for the usage reports (Stage 1).
 *
 * Every remote command (lock/shutdown/restart/project/wifi/website-block/
 * wake/screenshot…) writes a denormalized snapshot to ControlActionLog so the
 * Control Action Log report has actor/target/result columns without depending
 * on joins that may be missing for freshly discovered guests. This is in
 * addition to (not a replacement for) the existing SystemLog audit entries.
 */

const MAX_FIELD = 191;
const MAX_DETAIL = 8000;

function clip(v, max = MAX_FIELD) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{
 *   actorId?: number|null, actorRole?: string|null, action: string,
 *   targetComputerId?: string|null, targetHostname?: string|null,
 *   targetIp?: string|null, result?: string|null, detail?: string|null
 * }} entry
 */
export async function recordControlAction(prisma, entry) {
  if (!prisma || !entry?.action) return;
  try {
    const actorId =
      entry.actorId != null && Number.isFinite(Number(entry.actorId))
        ? Number(entry.actorId)
        : null;
    await prisma.controlActionLog.create({
      data: {
        actorId,
        actorRole: clip(entry.actorRole),
        action: clip(entry.action),
        targetComputerId: clip(entry.targetComputerId),
        targetHostname: clip(entry.targetHostname),
        targetIp: clip(entry.targetIp),
        result: clip(entry.result) || 'SENT',
        detail: clip(entry.detail, MAX_DETAIL),
      },
    });
  } catch (e) {
    console.error('[recordControlAction]', entry.action, e.message);
  }
}

/** Resolve a target's hostname/ip from the live connected-agents map. */
export function resolveTarget(connectedComputers, targetId) {
  try {
    const entry = connectedComputers?.get(targetId);
    const c = entry?.computer || {};
    return {
      targetComputerId: targetId || null,
      targetHostname: c.hostname || c.name || null,
      targetIp: c.ip || null,
    };
  } catch {
    return { targetComputerId: targetId || null, targetHostname: null, targetIp: null };
  }
}
