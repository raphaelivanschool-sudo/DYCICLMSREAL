import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

function normalizeMac(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase().replace(/-/g, ':');
}

function findConnectedAgentForPc(connectedComputers, { ipAddress, macAddress }) {
  if (!connectedComputers) return null;
  const ip = ipAddress ? String(ipAddress).trim() : null;
  const mac = normalizeMac(macAddress);

  for (const [agentId, entry] of connectedComputers.entries()) {
    const c = entry?.computer || {};
    const agentIp = c.ip ? String(c.ip).trim() : null;
    const agentMac = normalizeMac(c.mac);
    const agentIps = Array.isArray(c.ipAddresses) ? c.ipAddresses.map((x) => String(x).trim()) : [];

    const ipMatch = ip && (agentIp === ip || agentIps.includes(ip));
    const macMatch = mac && agentMac === mac;

    if (ipMatch || macMatch) {
      return {
        agentId,
        status: entry?.status || 'online',
        lastSeen: entry?.lastSeen || null,
        ip: agentIp || null,
        mac: agentMac || null,
        hostname: c.hostname || null,
        user: entry?.user || c.user || null,
      };
    }
  }

  return null;
}

router.use(authenticateToken);

// GET /api/session-context/student
router.get('/student', async (req, res) => {
  try {
    const studentId = req.user?.id;
    if (!studentId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const active = await prisma.sessionStudent.findFirst({
      where: {
        studentId: studentId,
        status: 'ACTIVE',
      },
      include: {
        session: {
          include: {
            laboratory: { select: { id: true, name: true, roomNumber: true, building: true, location: true } },
            instructor: { select: { id: true, fullName: true, username: true } },
          },
        },
        computer: { select: { id: true, name: true, seatNumber: true, ipAddress: true, macAddress: true, laboratoryId: true } },
      },
      orderBy: { checkInTime: 'desc' },
    });

    if (!active) {
      return res.json({ success: true, hasActiveSession: false });
    }

    const session = active.session;
    const lab = session?.laboratory || null;
    const computer = active.computer || null;

    return res.json({
      success: true,
      hasActiveSession: true,
      session: {
        id: session?.id,
        name: session?.name,
        status: session?.status,
        startTime: session?.startTime,
        endTime: session?.endTime,
      },
      laboratory: lab
        ? {
            id: lab.id,
            name: lab.name,
            roomNumber: lab.roomNumber,
            building: lab.building,
            location: lab.location,
          }
        : null,
      instructor: session?.instructor
        ? {
            id: session.instructor.id,
            fullName: session.instructor.fullName,
            username: session.instructor.username,
          }
        : null,
      assignment: {
        sessionStudentId: active.id,
        checkInTime: active.checkInTime,
        checkOutTime: active.checkOutTime,
        studentId: active.studentId,
        computer: computer
          ? {
              id: computer.id,
              name: computer.name,
              seatNumber: computer.seatNumber,
              ipAddress: computer.ipAddress,
              macAddress: computer.macAddress,
              laboratoryId: computer.laboratoryId,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('[session-context/student]', error);
    return res.status(500).json({ success: false, error: 'Failed to load session context' });
  }
});

// GET /api/session-context/instructor
router.get('/instructor', async (req, res) => {
  try {
    const instructorId = req.user?.id;
    if (!instructorId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const session = await prisma.session.findFirst({
      where: {
        instructorId,
        status: 'ACTIVE',
      },
      include: {
        laboratory: { select: { id: true, name: true, roomNumber: true, building: true, location: true } },
        sessionStudents: {
          where: { status: 'ACTIVE' },
          include: {
            computer: { select: { id: true, name: true, seatNumber: true, ipAddress: true, macAddress: true, laboratoryId: true } },
          },
          orderBy: { checkInTime: 'desc' },
        },
      },
      orderBy: { startTime: 'desc' },
    });

    if (!session) {
      return res.json({ success: true, hasActiveSession: false });
    }

    const studentIds = session.sessionStudents.map((ss) => ss.studentId);
    const students = studentIds.length
      ? await prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, fullName: true, username: true, role: true },
        })
      : [];
    const byId = new Map(students.map((u) => [u.id, u]));

    const connectedComputers = req.app.get('connectedComputers');
    const roster = session.sessionStudents.map((ss) => {
      const user = byId.get(ss.studentId) || null;
      const pc = ss.computer || null;
      const agent = pc ? findConnectedAgentForPc(connectedComputers, { ipAddress: pc.ipAddress, macAddress: pc.macAddress }) : null;
      const inferredStatus = agent ? 'online' : 'offline';

      return {
        sessionStudentId: ss.id,
        studentId: ss.studentId,
        student: user
          ? { id: user.id, fullName: user.fullName, username: user.username }
          : { id: ss.studentId, fullName: `Student ${ss.studentId}`, username: null },
        checkInTime: ss.checkInTime,
        computer: pc
          ? {
              id: pc.id,
              name: pc.name,
              seatNumber: pc.seatNumber,
              ipAddress: pc.ipAddress,
              macAddress: pc.macAddress,
              laboratoryId: pc.laboratoryId,
            }
          : null,
        agent: agent
          ? {
              id: agent.agentId,
              status: agent.status,
              lastSeen: agent.lastSeen,
              ip: agent.ip,
              mac: agent.mac,
              hostname: agent.hostname,
              user: agent.user,
            }
          : null,
        status: inferredStatus,
      };
    });

    return res.json({
      success: true,
      hasActiveSession: true,
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startTime: session.startTime,
        endTime: session.endTime,
      },
      laboratory: session.laboratory || null,
      rosterCount: roster.length,
      roster,
    });
  } catch (error) {
    console.error('[session-context/instructor]', error);
    return res.status(500).json({ success: false, error: 'Failed to load instructor session context' });
  }
});

export default router;

