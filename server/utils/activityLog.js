/**
 * Central audit trail: all entries go to SystemLog for the admin System Logs page.
 */
const MAX_ACTION = 128;
const MAX_DESC = 8000;
const MAX_IP = 128;

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId?: number|null, action: string, description?: string|null, ipAddress?: string|null }} entry
 */
export async function recordActivity(prisma, entry) {
  if (!prisma || !entry?.action) return;
  try {
    const action = String(entry.action).trim().slice(0, MAX_ACTION);
    const description =
      entry.description != null
        ? String(entry.description).trim().slice(0, MAX_DESC)
        : null;
    const ipAddress =
      entry.ipAddress != null
        ? String(entry.ipAddress).trim().slice(0, MAX_IP)
        : null;
    const userId =
      entry.userId != null && Number.isFinite(Number(entry.userId))
        ? Number(entry.userId)
        : null;

    await prisma.systemLog.create({
      data: {
        action,
        description: description || null,
        userId,
        ipAddress: ipAddress || null,
      },
    });
  } catch (e) {
    console.error("[recordActivity]", entry.action, e.message);
  }
}

/** Express client IP (supports X-Forwarded-For behind a proxy). */
export function clientIp(req) {
  if (!req) return null;
  const xf = req.headers?.["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) {
    return xf.split(",")[0].trim().slice(0, MAX_IP);
  }
  const raw = req.ip || req.socket?.remoteAddress || "";
  return raw ? String(raw).slice(0, MAX_IP) : null;
}

/** JSON for descriptions; truncated to avoid huge logs. */
export function summarizePayload(obj, maxLen = 800) {
  if (obj == null || obj === undefined) return "";
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return "[unserializable]";
  }
}
