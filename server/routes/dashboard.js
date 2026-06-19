import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

// All routes are protected with JWT middleware
router.use(authenticateToken);

// GET /api/dashboard/stats - Return all dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    // Get labs stats
    const labsStats = await prisma.laboratory.groupBy({
      by: ['status'],
      _count: {
        id: true
      }
    });

    const totalLabs = labsStats.reduce((sum, stat) => sum + stat._count.id, 0);
    const activeLabs = labsStats.find(s => s.status === 'ACTIVE')?._count.id || 0;
    const inactiveLabs = labsStats.find(s => s.status === 'INACTIVE')?._count.id || 0;

    // Get computers stats
    const computersStats = await prisma.computer.groupBy({
      by: ['status'],
      _count: {
        id: true
      }
    });

    const lockedComputers = await prisma.computer.count({
      where: { isLocked: true }
    });

    const totalComputers = computersStats.reduce((sum, stat) => sum + stat._count.id, 0);
    const onlineComputers = computersStats.find(s => s.status === 'ONLINE')?._count.id || 0;
    const offlineComputers = computersStats.find(s => s.status === 'OFFLINE')?._count.id || 0;
    const inUseComputers = computersStats.find(s => s.status === 'IN_USE')?._count.id || 0;

    // Get tickets stats
    const ticketsStats = await prisma.ticket.groupBy({
      by: ['status'],
      _count: {
        id: true
      }
    });

    const ticketCountByStatus = (status) =>
      ticketsStats.find(s => s.status === status)?._count.id || 0;

    const totalTickets = ticketsStats.reduce((sum, stat) => sum + stat._count.id, 0);
    const inProgressTickets = ticketCountByStatus('IN_PROGRESS');
    const resolvedTickets = ticketCountByStatus('RESOLVED') + ticketCountByStatus('CLOSED');
    // "Open" = tickets still needing attention (not resolved/closed/rejected)
    const openTickets =
      ticketCountByStatus('PENDING_APPROVAL') +
      ticketCountByStatus('APPROVED') +
      ticketCountByStatus('OPEN') +
      ticketCountByStatus('IN_PROGRESS');

    // Get users stats
    const usersStats = await prisma.user.groupBy({
      by: ['role'],
      _count: {
        id: true
      }
    });

    const totalUsers = usersStats.reduce((sum, stat) => sum + stat._count.id, 0);
    const adminUsers = usersStats.find(s => s.role === 'ADMIN')?._count.id || 0;
    const instructorUsers = usersStats.find(s => s.role === 'INSTRUCTOR')?._count.id || 0;
    const studentUsers = usersStats.find(s => s.role === 'STUDENT')?._count.id || 0;

    // Get labs overview with computer breakdown
    const labsOverview = await prisma.laboratory.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        assignedInstructor: {
          select: {
            fullName: true
          }
        },
        computers: {
          select: {
            status: true
          }
        }
      }
    });

    const formattedLabsOverview = labsOverview.map(lab => {
      const onlineCount = lab.computers.filter(c => c.status === 'ONLINE').length;
      const offlineCount = lab.computers.filter(c => c.status === 'OFFLINE').length;
      const inUseCount = lab.computers.filter(c => c.status === 'IN_USE').length;
      
      return {
        id: lab.id,
        name: lab.name,
        location: lab.location,
        roomNumber: lab.roomNumber,
        status: lab.status,
        capacity: lab.capacity,
        computerCount: lab.computers.length,
        onlineCount,
        offlineCount,
        inUseCount,
        assignedInstructor: lab.assignedInstructor
      };
    });

    const response = {
      labs: {
        total: totalLabs,
        active: activeLabs,
        inactive: inactiveLabs
      },
      computers: {
        total: totalComputers,
        online: onlineComputers,
        offline: offlineComputers,
        inUse: inUseComputers,
        locked: lockedComputers
      },
      tickets: {
        open: openTickets,
        inProgress: inProgressTickets,
        resolved: resolvedTickets,
        total: totalTickets
      },
      users: {
        total: totalUsers,
        admins: adminUsers,
        instructors: instructorUsers,
        students: studentUsers
      },
      labsOverview: formattedLabsOverview
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard statistics' });
  }
});

// GET /api/dashboard/recent-activity - Return recent system logs
router.get('/recent-activity', async (req, res) => {
  try {
    const recentActivity = await prisma.systemLog.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            fullName: true,
            role: true
          }
        }
      }
    });

    const formattedActivity = recentActivity.map(log => ({
      id: log.id,
      action: log.action,
      details: log.description,
      timestamp: log.createdAt,
      user: log.user ? {
        fullName: log.user.fullName,
        role: log.user.role
      } : null
    }));

    res.json(formattedActivity);
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({ message: 'Failed to fetch recent activity' });
  }
});

export default router;
