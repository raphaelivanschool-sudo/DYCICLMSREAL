/**
 * Tests for the Locked Demo Mode session manager.
 * Run: npm test   (uses Node's built-in test runner; no extra deps)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { projectionManager } from "./projectionSession.js";

// --- Test doubles -------------------------------------------------------- //
function makeIo() {
  const emits = [];
  return {
    emits,
    to(room) {
      return {
        emit(event, payload) {
          emits.push({ room, event, payload });
        },
      };
    },
    clear() {
      emits.length = 0;
    },
    eventsFor(event) {
      return emits.filter((e) => e.event === event);
    },
  };
}

function makeComputers(ids) {
  const m = new Map();
  ids.forEach((id, i) => {
    m.set(id, {
      socketId: `sock-${id}`,
      computer: { id, ip: `10.0.0.${i + 1}`, mac: `AA:BB:0${i}`, hostname: `pc-${id}` },
    });
  });
  return m;
}

const ADMIN = { userId: 1, role: "ADMIN", socketId: "host-sock" };

let io;
let computers;

beforeEach(() => {
  // Reset the singleton between tests.
  if (projectionManager.isActive()) projectionManager.stop({});
  io = makeIo();
  computers = makeComputers(["a", "b", "c"]);
  projectionManager.attach({ io, connectedComputers: computers });
});

test("start('all') fans projection_start to every online guest", () => {
  const res = projectionManager.start({ host: ADMIN, targets: "all" });
  assert.equal(res.ok, true);
  assert.ok(res.sessionId);
  const starts = io.eventsFor("projection_start");
  assert.equal(starts.length, 3);
  const rooms = starts.map((s) => s.room).sort();
  assert.deepEqual(rooms, ["computer_a", "computer_b", "computer_c"]);
  assert.equal(res.perGuest.every((g) => g.state === "connecting"), true);
});

test("non-admin role is rejected", () => {
  const res = projectionManager.start({
    host: { userId: 9, role: "STUDENT", socketId: "s" },
    targets: "all",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /admin\/instructor/i);
});

test("second concurrent session is rejected (serialized)", () => {
  assert.equal(projectionManager.start({ host: ADMIN, targets: "all" }).ok, true);
  const other = projectionManager.start({
    host: { userId: 2, role: "INSTRUCTOR", socketId: "h2" },
    targets: "all",
  });
  assert.equal(other.ok, false);
  assert.match(other.error, /already projecting/i);
});

test("selected targets include offline ids as 'offline'", () => {
  const res = projectionManager.start({ host: ADMIN, targets: ["a", "ghost"] });
  assert.equal(res.ok, true);
  const ghost = res.perGuest.find((g) => g.id === "ghost");
  assert.equal(ghost.state, "offline");
  // Only the online target 'a' gets a START.
  assert.equal(io.eventsFor("projection_start").length, 1);
});

test("frames fan out and stale seq is dropped", () => {
  const { sessionId } = projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  projectionManager.frame({ sessionId, seq: 5, screenshot: "AAAA" });
  assert.equal(io.eventsFor("projection_frame").length, 3); // one per guest
  io.clear();
  projectionManager.frame({ sessionId, seq: 3, screenshot: "BBBB" }); // stale
  assert.equal(io.eventsFor("projection_frame").length, 0);
});

test("frame for wrong/no session is ignored", () => {
  projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  projectionManager.frame({ sessionId: "nope", seq: 1, screenshot: "X" });
  assert.equal(io.eventsFor("projection_frame").length, 0);
});

test("ack updates per-guest state and pushes status to host", () => {
  const { sessionId } = projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  projectionManager.ack({ socketId: "sock-a", sessionId, state: "projecting" });
  const status = io.eventsFor("projection:status");
  assert.ok(status.length >= 1);
  const last = status[status.length - 1];
  assert.equal(last.room, "host-sock");
  const a = last.payload.perGuest.find((g) => g.id === "a");
  assert.equal(a.state, "projecting");
});

test("stop broadcasts projection_stop and is idempotent", () => {
  const { sessionId } = projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  const r1 = projectionManager.stop({ sessionId });
  assert.equal(r1.ok, true);
  assert.equal(io.eventsFor("projection_stop").length, 3);
  assert.equal(projectionManager.isActive(), false);
  const r2 = projectionManager.stop({ sessionId }); // idempotent
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyStopped, true);
});

test("host disconnect tears the session down", () => {
  projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  const res = projectionManager.onHostDisconnect("host-sock");
  assert.ok(res);
  assert.equal(io.eventsFor("projection_stop").length, 3);
  assert.equal(projectionManager.isActive(), false);
});

test("agent disconnect marks that guest offline, others continue", () => {
  projectionManager.start({ host: ADMIN, targets: "all" });
  computers.delete("b");
  projectionManager.onAgentDisconnect("b");
  const snap = projectionManager.status();
  const b = snap.session.perGuest.find((g) => g.id === "b");
  assert.equal(b.state, "offline");
  assert.equal(projectionManager.isActive(), true);
});

test("late joiner gets a resent START during an 'all' broadcast", () => {
  projectionManager.start({ host: ADMIN, targets: "all" });
  io.clear();
  computers.set("d", {
    socketId: "sock-d",
    computer: { id: "d", ip: "10.0.0.9", mac: "AA:BB:09", hostname: "pc-d" },
  });
  projectionManager.onAgentRegister("d");
  const starts = io.eventsFor("projection_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].room, "computer_d");
});
