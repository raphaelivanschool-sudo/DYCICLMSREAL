/**
 * System-Usage Reports (CSV).
 *
 * Admin reports are institution-wide; instructor reports are scoped
 * server-side to the logged-in instructor (req.user.id), never to a
 * client-supplied id. Every handler parses a date range, queries the
 * relevant table(s), and streams a CSV via the shared sendCsv helper.
 */
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requireRole } from '../middleware/auth.js';
import {
  sendCsv,
  parseRange,
  minutesBetween,
  EXPORT_MAX_ROWS,
} from '../utils/csv.js';

const router = express.Router();
const prisma = new PrismaClient();

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Local YYYY-MM-DD (so day-grouping matches the server's clock). */
function localYmd(d) {
  const dt = new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

/** ISO timestamp for CSV cells (empty for null). */
function iso(d) {
  return d ? new Date(d).toISOString() : '';
}

function norm(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

/**
 * Group presence events into online intervals per agentKey.
 * `events` must be ordered by [agentKey asc, at asc]. A dangling ONLINE
 * (no OFFLINE in range) is closed at min(rangeEnd, now).
 * @returns {Map<string, {agentKey, hostname, ipAddress, mac, intervals: {start:Date,end:Date}[]}>}
 */
function sessionize(events, rangeEnd) {
  const closeAt = Math.min(new Date(rangeEnd).getTime(), Date.now());
  const groups = new Map();

  for (const ev of events) {
    let g = groups.get(ev.agentKey);
    if (!g) {
      g = {
        agentKey: ev.agentKey,
        hostname: ev.hostname || null,
        ipAddress: ev.ipAddress || null,
        mac: ev.mac || null,
        intervals: [],
        _openAt: null,
      };
      groups.set(ev.agentKey, g);
    }
    // Keep the freshest identity fields we've seen.
    if (ev.hostname) g.hostname = ev.hostname;
    if (ev.ipAddress) g.ipAddress = ev.ipAddress;
    if (ev.mac) g.mac = ev.mac;

    if (ev.event === 'ONLINE') {
      if (g._openAt == null) g._openAt = new Date(ev.at);
    } else if (ev.event === 'OFFLINE') {
      if (g._openAt != null) {
        g.intervals.push({ start: g._openAt, end: new Date(ev.at) });
        g._openAt = null;
      }
    }
  }

  // Close any still-open intervals at the range end / now.
  for (const g of groups.values()) {
    if (g._openAt != null) {
      const end = new Date(Math.max(closeAt, g._openAt.getTime()));
      g.intervals.push({ start: g._openAt, end });
    }
    delete g._openAt;
  }
  return groups;
}

/** Split [start,end] at local midnight into per-day segments. */
function splitByDay(start, end) {
  const out = [];
  let cur = new Date(start);
  const stop = new Date(end);
  while (cur < stop) {
    const dayEnd = new Date(cur);
    dayEnd.setHours(23, 59, 59, 999);
    const segEnd = dayEnd < stop ? dayEnd : stop;
    out.push({ day: localYmd(cur), start: new Date(cur), end: new Date(segEnd) });
    cur = new Date(dayEnd.getTime() + 1); // next local midnight
  }
  return out;
}

/** Minutes of `intervals` that fall inside [winStart,winEnd], plus first/last. */
function overlap(intervals, winStart, winEnd) {
  const ws = new Date(winStart).getTime();
  const we = new Date(winEnd).getTime();
  let minutes = 0;
  let first = null;
  let last = null;
  for (const { start, end } of intervals || []) {
    const s = Math.max(new Date(start).getTime(), ws);
    const e = Math.min(new Date(end).getTime(), we);
    if (e > s) {
      minutes += (e - s) / 60000;
      if (first == null || s < first) first = s;
      if (last == null || e > last) last = e;
    }
  }
  return {
    minutes: Math.round(minutes),
    first: first ? new Date(first) : null,
    last: last ? new Date(last) : null,
  };
}

/** Build mac/ip/name lookup over Computers (with their Laboratory). */
function buildComputerIndex(computers) {
  const byMac = new Map();
  const byIp = new Map();
  const byName = new Map();
  for (const c of computers) {
    if (c.macAddress) byMac.set(norm(c.macAddress), c);
    if (c.ipAddress) byIp.set(norm(c.ipAddress), c);
    if (c.name) byName.set(norm(c.name), c);
  }
  return { byMac, byIp, byName };
}

/** Best-effort match of a presence identity to a Computer row. */
function matchComputer(index, { mac, ipAddress, hostname }) {
  return (
    (mac && index.byMac.get(norm(mac))) ||
    (hostname && index.byName.get(norm(hostname))) ||
    (ipAddress && index.byIp.get(norm(ipAddress))) ||
    null
  );
}

function labRoomLabel(lab) {
  if (!lab) return '';
  if (lab.name && lab.roomNumber) return `${lab.name} (${lab.roomNumber})`;
  return lab.roomNumber || lab.name || '';
}

// ===========================================================================
// ADMIN REPORTS (institution-wide)
// ===========================================================================

/** 1. Lab/PC Utilization — one row per (PC, day) within the range. */
router.get('/lab-utilization', requireRole(['ADMIN']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const labId = req.query.labId ? Number(req.query.labId) : null;

    const [events, computers] = await Promise.all([
      prisma.agentPresenceLog.findMany({
        where: { at: { gte, lte } },
        orderBy: [{ agentKey: 'asc' }, { at: 'asc' }],
        take: EXPORT_MAX_ROWS,
      }),
      prisma.computer.findMany({ include: { laboratory: true } }),
    ]);

    const index = buildComputerIndex(computers);
    const groups = sessionize(events, lte);

    const rows = [];
    for (const g of groups.values()) {
      const computer = matchComputer(index, g);
      const lab = computer?.laboratory || null;
      if (labId && (!lab || lab.id !== labId)) continue;

      // Aggregate this PC's intervals per calendar day.
      const perDay = new Map(); // day -> { minutes, sessions, first, last }
      for (const itv of g.intervals) {
        for (const seg of splitByDay(itv.start, itv.end)) {
          let d = perDay.get(seg.day);
          if (!d) {
            d = { minutes: 0, sessions: 0, first: seg.start, last: seg.end };
            perDay.set(seg.day, d);
          }
          d.minutes += minutesBetween(seg.start, seg.end);
          d.sessions += 1;
          if (seg.start < d.first) d.first = seg.start;
          if (seg.end > d.last) d.last = seg.end;
        }
      }

      for (const [day, d] of perDay) {
        rows.push([
          day,
          labRoomLabel(lab),
          g.hostname || computer?.name || g.agentKey,
          g.ipAddress || computer?.ipAddress || '',
          d.minutes,
          d.sessions,
          iso(d.first),
          iso(d.last),
        ]);
      }
    }

    rows.sort((a, b) => String(a[0]).localeCompare(b[0]) || String(a[1]).localeCompare(b[1]));

    sendCsv(res, {
      filename: `lab-utilization_${startStr}_${endStr}.csv`,
      header: ['date', 'lab_room', 'hostname', 'ip', 'online_minutes', 'sessions_count', 'first_seen', 'last_seen'],
      rows,
    });
  } catch (error) {
    console.error('[reports/lab-utilization]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

/** 2. Control Action Log. */
router.get('/control-actions', requireRole(['ADMIN']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const logs = await prisma.controlActionLog.findMany({
      where: { createdAt: { gte, lte } },
      include: { actor: { select: { fullName: true, username: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX_ROWS,
    });

    const rows = logs.map((l) => [
      iso(l.createdAt),
      l.actor?.fullName || l.actor?.username || 'System',
      l.actorRole || l.actor?.role || '',
      l.action,
      l.targetHostname || '',
      l.targetIp || '',
      l.result || '',
      l.detail || '',
    ]);

    sendCsv(res, {
      filename: `control-action-log_${startStr}_${endStr}.csv`,
      header: ['timestamp', 'actor_name', 'actor_role', 'action', 'target_hostname', 'target_ip', 'result', 'detail'],
      rows,
    });
  } catch (error) {
    console.error('[reports/control-actions]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

/** 3. Login/Session Activity. */
router.get('/login-activity', requireRole(['ADMIN']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const username = req.query.username ? String(req.query.username).trim() : '';

    const where = {
      createdAt: { gte, lte },
      action: { in: ['LOGIN', 'LOGOUT', 'LOGIN_FAILED'] },
    };
    if (username) {
      where.OR = [
        { user: { username: { contains: username } } },
        { description: { contains: username } },
      ];
    }

    const logs = await prisma.systemLog.findMany({
      where,
      include: { user: { select: { username: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX_ROWS,
    });

    const rows = logs.map((l) => {
      const event = l.action === 'LOGOUT' ? 'logout' : 'login';
      const result = l.action === 'LOGIN_FAILED' ? 'fail' : 'success';
      // Failed logins for unknown users carry the attempted name in the description.
      let uname = l.user?.username || '';
      if (!uname) {
        const m = /Failed login for "([^"]+)"/.exec(l.description || '');
        if (m) uname = m[1];
      }
      return [iso(l.createdAt), uname, l.user?.role || '', event, l.ipAddress || '', result];
    });

    sendCsv(res, {
      filename: `login-activity_${startStr}_${endStr}.csv`,
      header: ['timestamp', 'username', 'role', 'event', 'ip', 'result'],
      rows,
    });
  } catch (error) {
    console.error('[reports/login-activity]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

/** 4. Tickets / Support. */
router.get('/tickets', requireRole(['ADMIN']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const tickets = await prisma.ticket.findMany({
      where: { createdAt: { gte, lte } },
      include: {
        creator: { select: { fullName: true, username: true } },
        assignee: { select: { fullName: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX_ROWS,
    });

    const RESOLVED = new Set(['RESOLVED', 'CLOSED']);
    const rows = tickets.map((t) => {
      const resolvedAt = RESOLVED.has(t.status) ? t.updatedAt : null;
      return [
        t.ticketId,
        iso(t.createdAt),
        t.creator?.fullName || t.creator?.username || '',
        t.category || '',
        t.status,
        t.assignee?.fullName || t.assignee?.username || '',
        iso(resolvedAt),
        resolvedAt ? minutesBetween(t.createdAt, resolvedAt) : '',
      ];
    });

    sendCsv(res, {
      filename: `tickets-support_${startStr}_${endStr}.csv`,
      header: ['ticket_id', 'created_at', 'requester', 'category', 'status', 'assigned_to', 'resolved_at', 'resolution_minutes'],
      rows,
    });
  } catch (error) {
    console.error('[reports/tickets]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

/** 5. PC Inventory / Status (current snapshot, not range-filtered). */
router.get('/inventory', requireRole(['ADMIN']), async (req, res) => {
  try {
    const [computers, agents] = await Promise.all([
      prisma.computer.findMany({ include: { laboratory: true }, orderBy: { name: 'asc' } }),
      prisma.agent.findMany({ select: { mac: true, lastSeen: true } }),
    ]);

    const lastSeenByMac = new Map();
    for (const a of agents) {
      if (a.mac) lastSeenByMac.set(norm(a.mac), a.lastSeen);
    }

    const rows = computers.map((c) => [
      c.name || '',
      c.ipAddress || '',
      c.macAddress || '',
      c.status,
      iso(c.macAddress ? lastSeenByMac.get(norm(c.macAddress)) : null),
      c.processor || '',
      c.ram || '',
      c.osVersion || '',
      labRoomLabel(c.laboratory),
    ]);

    const stamp = new Date().toISOString().slice(0, 10);
    sendCsv(res, {
      filename: `pc-inventory_${stamp}.csv`,
      header: ['hostname', 'ip', 'mac', 'status', 'last_seen', 'cpu', 'ram', 'os', 'lab_room'],
      rows,
    });
  } catch (error) {
    console.error('[reports/inventory]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

// ===========================================================================
// INSTRUCTOR REPORTS (scoped to req.user.id, enforced server-side)
// ===========================================================================

/**
 * 6. Attendance via Agent Presence.
 * Scoped to the instructor's own lab schedules. Because agents report a PC
 * (no student-account link), attendance is emitted per PC/room — the
 * student_or_pc column shows the PC, and that fallback is noted here.
 */
router.get('/attendance', requireRole(['INSTRUCTOR']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const instructorId = req.user.id; // never trust the client
    const sectionId = req.query.sectionId ? Number(req.query.sectionId) : null;

    // The instructor's scheduled lab sessions (+ lab + linked sections/subjects).
    const schedules = await prisma.labSchedule.findMany({
      where: { instructorId },
      include: {
        laboratory: { include: { computers: true } },
        sections: { include: { subject: true } },
      },
    });

    // Optional section filter — must belong to this instructor.
    let allowScheduleIds = null;
    if (sectionId) {
      const section = await prisma.section.findFirst({
        where: { id: sectionId, instructorId },
        select: { labScheduleId: true },
      });
      if (!section) {
        return res.status(403).json({ message: 'Section not found for this instructor.' });
      }
      allowScheduleIds = new Set(section.labScheduleId ? [section.labScheduleId] : []);
    }

    // Presence over the range, sessionized + indexed onto this instructor's lab PCs.
    const events = await prisma.agentPresenceLog.findMany({
      where: { at: { gte, lte } },
      orderBy: [{ agentKey: 'asc' }, { at: 'asc' }],
      take: EXPORT_MAX_ROWS,
    });
    const groups = [...sessionize(events, lte).values()];

    const rows = [];
    for (const sched of schedules) {
      if (allowScheduleIds && !allowScheduleIds.has(sched.id)) continue;
      const lab = sched.laboratory;
      if (!lab) continue;

      const sectionLabel = sched.sections[0]?.name || sched.className || '';
      const subjectLabel =
        sched.sections[0]?.subject?.title || sched.subjectCode || '';

      const compIndex = buildComputerIndex(lab.computers || []);
      // agentKey-group → computer in this lab
      const labGroups = groups
        .map((g) => ({ g, c: matchComputer(compIndex, g) }))
        .filter((x) => x.c);

      // Each date in range whose weekday matches this schedule's day.
      const [sh, sm] = String(sched.startTime || '0:0').split(':').map(Number);
      const [eh, em] = String(sched.endTime || '0:0').split(':').map(Number);
      for (let d = new Date(gte); d <= lte; d.setDate(d.getDate() + 1)) {
        if (WEEKDAYS[d.getDay()] !== sched.day) continue;
        const winStart = new Date(d); winStart.setHours(sh || 0, sm || 0, 0, 0);
        const winEnd = new Date(d); winEnd.setHours(eh || 0, em || 0, 0, 0);
        const sessionDate = localYmd(d);

        for (const { g, c } of labGroups) {
          const o = overlap(g.intervals, winStart, winEnd);
          rows.push([
            sessionDate,
            sectionLabel,
            subjectLabel,
            g.hostname || c.name || g.agentKey, // PC fallback (no student mapping)
            o.minutes > 0 ? 'yes' : 'no',
            o.minutes,
            iso(o.first),
            iso(o.last),
          ]);
        }
      }
    }

    rows.sort((a, b) => String(a[0]).localeCompare(b[0]) || String(a[3]).localeCompare(b[3]));

    sendCsv(res, {
      filename: `attendance_${startStr}_${endStr}.csv`,
      header: ['session_date', 'section', 'subject', 'student_or_pc', 'online', 'online_minutes', 'first_seen', 'last_seen'],
      rows,
    });
  } catch (error) {
    console.error('[reports/attendance]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

/** 7. My Control/Projection Log — only this instructor's actions. */
router.get('/my-control-log', requireRole(['INSTRUCTOR']), async (req, res) => {
  try {
    const { gte, lte, startStr, endStr } = parseRange(req.query);
    const actorId = req.user.id; // scoped server-side

    const logs = await prisma.controlActionLog.findMany({
      where: { actorId, createdAt: { gte, lte } },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_MAX_ROWS,
    });

    // Pair each projection start with the next stop to derive duration.
    const durationFor = new Map(); // log.id -> minutes (on the START row)
    const openStarts = [];
    for (const l of logs) {
      if (l.action === 'project') {
        openStarts.push(l);
      } else if (l.action === 'projection-stop' && openStarts.length) {
        const start = openStarts.shift();
        durationFor.set(start.id, minutesBetween(start.createdAt, l.createdAt));
      }
    }

    const rows = logs
      .slice()
      .reverse() // newest first for display
      .map((l) => [
        iso(l.createdAt),
        l.action,
        l.targetHostname || '',
        l.targetIp || '',
        l.result || '',
        durationFor.has(l.id) ? durationFor.get(l.id) : '',
      ]);

    sendCsv(res, {
      filename: `my-control-log_${startStr}_${endStr}.csv`,
      header: ['timestamp', 'action', 'target_hostname', 'target_ip', 'result', 'duration_minutes'],
      rows,
    });
  } catch (error) {
    console.error('[reports/my-control-log]', error);
    res.status(500).json({ message: 'Failed to build report', error: error.message });
  }
});

export default router;
