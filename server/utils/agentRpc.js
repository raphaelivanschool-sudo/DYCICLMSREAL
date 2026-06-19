/**
 * Correlated request/reply over Socket.IO for agent commands that return data
 * (currently: screenshot/preview capture).
 *
 * Why this exists: the screenshot used to be fetched by the server dialing the
 * guest's LAN IP (HTTP 5555) — a stale-IP path that breaks the same way the old
 * projection flow did. Now the route reaches the guest over its *reliable*
 * Socket.IO connection (keyed by computer id): it emits `execute_command` with a
 * `requestId`, the agent runs the capture and echoes the `requestId` back in its
 * `command_result`, and `resolveAgentRequest()` (called from the socket handler)
 * settles the awaiting HTTP request. No LAN IP is dialed.
 */
import { randomUUID } from 'crypto';

/** requestId -> { resolve, timer } */
const pending = new Map();

/**
 * Register a pending agent request. Resolves with the agent's reply, or with
 * `{ timedOut: true }` if no `command_result` carrying this requestId arrives in
 * time (e.g. the capture agent on the guest is down).
 *
 * @param {number} timeoutMs
 * @returns {{ requestId: string, promise: Promise<{success?:boolean, result?:any, error?:string, action?:string, timedOut?:boolean}> }}
 */
export function createAgentRequest(timeoutMs = 15000) {
  const requestId = randomUUID();
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ timedOut: true });
    }, timeoutMs);
    // Don't keep the event loop alive solely for a pending capture.
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(requestId, { resolve, timer });
  });
  return { requestId, promise };
}

/**
 * Settle a pending agent request from a `command_result`. No-op (returns false)
 * if the requestId is unknown — so unrelated command results pass through
 * harmlessly.
 *
 * @param {string} requestId
 * @param {object} payload  forwarded to the awaiting promise
 * @returns {boolean} true if a pending request was resolved
 */
export function resolveAgentRequest(requestId, payload) {
  if (!requestId) return false;
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(payload);
  return true;
}
