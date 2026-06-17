/**
 * Tests for PC-agent IP resolution — guards the projection/screenshot/overlay
 * diagnostics against stale or wrong-NIC addresses.
 * Run: npm test   (Node's built-in test runner; no extra deps)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReachableLanIp, resolveLanIpForPcAgent } from "./agentLookup.js";

function makeMap(id, computer) {
  return new Map([[id, { socketId: "s1", computer, lastSeen: new Date(), status: "online" }]]);
}

test("isReachableLanIp rejects loopback, APIPA, and virtual/VPN ranges", () => {
  assert.equal(isReachableLanIp("192.168.1.193"), true);
  assert.equal(isReachableLanIp("10.0.0.5"), true);
  assert.equal(isReachableLanIp("127.0.0.1"), false);
  assert.equal(isReachableLanIp("169.254.10.2"), false); // APIPA
  assert.equal(isReachableLanIp("192.168.56.101"), false); // VirtualBox host-only
  assert.equal(isReachableLanIp("26.42.1.7"), false); // Radmin VPN
  assert.equal(isReachableLanIp(""), false);
  assert.equal(isReachableLanIp(null), false);
});

test("prefers the agent's live primary IP over a stale dashboard hint", () => {
  // Agent now reports .193 (correct LAN); the dashboard row still has stale .114.
  const cc = makeMap("lab-pc-01", { ip: "192.168.1.193", ipAddresses: ["192.168.1.193"] });
  assert.equal(resolveLanIpForPcAgent(cc, "lab-pc-01", "192.168.1.114"), "192.168.1.193");
});

test("rejects a stale hint that is no longer a live interface", () => {
  const cc = makeMap("lab-pc-01", {
    ip: "192.168.1.193",
    interfaceBindings: [{ ip: "192.168.1.193", mac: "aa", iface: "Ethernet" }],
  });
  // .114 is not in the live set → must not be dialed; falls back to live primary.
  assert.equal(resolveLanIpForPcAgent(cc, "lab-pc-01", "192.168.1.114"), "192.168.1.193");
});

test("honors the hint when primary is loopback and the hint is a live interface", () => {
  const cc = makeMap("lab-pc-01", {
    ip: "127.0.0.1",
    ipAddresses: ["127.0.0.1", "192.168.1.50"],
  });
  assert.equal(resolveLanIpForPcAgent(cc, "lab-pc-01", "192.168.1.50"), "192.168.1.50");
});

test("falls back to a live reachable IP when primary is unusable and no hint", () => {
  const cc = makeMap("lab-pc-01", {
    ip: "169.254.1.1", // APIPA
    ipAddresses: ["169.254.1.1", "10.10.0.7"],
  });
  assert.equal(resolveLanIpForPcAgent(cc, "lab-pc-01", ""), "10.10.0.7");
});

test("never returns a virtual-range address from the candidate set", () => {
  const cc = makeMap("lab-pc-01", {
    ip: "192.168.56.10", // VirtualBox primary (wrong)
    ipAddresses: ["192.168.56.10", "26.1.2.3", "192.168.1.193"],
  });
  assert.equal(resolveLanIpForPcAgent(cc, "lab-pc-01", "192.168.56.10"), "192.168.1.193");
});

test("returns null when the target is not connected", () => {
  const cc = makeMap("lab-pc-01", { ip: "192.168.1.193" });
  assert.equal(resolveLanIpForPcAgent(cc, "unknown-id", "192.168.1.193"), null);
  assert.equal(resolveLanIpForPcAgent(null, "lab-pc-01", "x"), null);
});
