import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();
const prisma = new PrismaClient();

/** Actions counted as “security / operational significance” on the dashboard stats card */
function criticalActionsWhereClause() {
  return {
    OR: [
      {
        action: {
          in: [
            'LOGIN',
            'LOGOUT',
            'WAKE_ON_LAN',
            'AGENT_INSTALLER_GENERATED',
            'SCREEN_PROJECTION_STOP',
            'TICKET_APPROVED',
            'TICKET_REJECTED',
            'LAB_DELETED',
          ],
        },
      },
      { action: { startsWith: 'AGENT_' } },
      { action: { startsWith: 'TICKET_' } },
      { action: { startsWith: 'HARDWARE_' } },
      { action: { startsWith: 'LAB_' } },
      { action: { startsWith: 'COMPUTER_' } },
      { action: { startsWith: 'NETWORK_' } },
      { action: { startsWith: 'GRADING_' } },
    ],
  };
}

// Helper function to calculate date ranges
const getDateRange = (range) => {
  const now = new Date();
  const start = new Date();
  
  switch (range) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setDate(now.getDate() - 7);
      break;
    case 'month':
      start.setMonth(now.getMonth() - 1);
      break;
    default:
      return null; // No date filter
  }
  
  return { start, end: now };
};

const EXPORT_MAX_ROWS = 25_000;

function normalizeActionFilter(rawActionFilter) {
  return rawActionFilter === undefined ||
    rawActionFilter === null ||
    String(rawActionFilter).trim() === '' ||
    String(rawActionFilter).toLowerCase() === 'all'
    ? 'all'
    : String(rawActionFilter);
}

/** Date, action, and search filters — same rules as the list endpoint (no status filter). */
function buildBaseLogsWhere(query) {
  const {
    dateRange = 'week',
    actionFilter: rawActionFilter,
    searchTerm = '',
    customStartDate,
    customEndDate,
  } = query;

  const actionFilter = normalizeActionFilter(rawActionFilter);
  const where = {};

  if (dateRange === 'custom' && customStartDate && customEndDate) {
    where.createdAt = {
      gte: new Date(customStartDate),
      lte: new Date(customEndDate),
    };
  } else {
    const dateFilter = getDateRange(dateRange);
    if (dateFilter) {
      where.createdAt = {
        gte: dateFilter.start,
        lte: dateFilter.end,
      };
    }
  }

  if (actionFilter !== 'all') {
    where.action = actionFilter;
  }

  if (searchTerm) {
    where.OR = [
      {
        user: {
          OR: [
            { fullName: { contains: searchTerm } },
            { username: { contains: searchTerm } },
          ],
        },
      },
      { description: { contains: searchTerm } },
      { ipAddress: { contains: searchTerm } },
    ];
  }

  return where;
}

/** Matches client-side status filtering on SystemLogs.jsx */
function withLogsStatusFilter(baseWhere, statusFilter) {
  const sf = String(statusFilter || 'all').toLowerCase();
  if (sf === 'all') return baseWhere;

  let statusClause = null;
  if (sf === 'success') {
    statusClause = { NOT: { action: { contains: 'ERROR' } } };
  } else if (sf === 'error') {
    statusClause = { action: { contains: 'ERROR' } };
  } else if (sf === 'warning') {
    statusClause = { action: { contains: 'WARNING' } };
  } else {
    return baseWhere;
  }

  const keys = Object.keys(baseWhere);
  if (keys.length === 0) return statusClause;
  return { AND: [baseWhere, statusClause] };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function deriveStatusLabel(action) {
  if (!action) return '';
  if (String(action).includes('ERROR')) return 'Error';
  if (String(action).includes('WARNING')) return 'Warning';
  return 'Success';
}

// GET /api/logs/export — CSV download (same filters as UI + status)
router.get('/export', authenticateToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
  try {
    const baseWhere = buildBaseLogsWhere(req.query);
    const where = withLogsStatusFilter(baseWhere, req.query.statusFilter);

    const rows = await prisma.systemLog.findMany({
      where,
      include: {
        user: {
          select: {
            username: true,
            fullName: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX_ROWS,
    });

    const header = [
      'Timestamp',
      'User',
      'Username',
      'Role',
      'Action',
      'Description',
      'IP Address',
      'Status',
    ];
    const lines = [
      header.map(csvEscape).join(','),
      ...rows.map((log) =>
        [
          new Date(log.createdAt).toISOString(),
          log.user?.fullName || 'System',
          log.user?.username || 'system',
          log.user?.role || 'SYSTEM',
          log.action,
          log.description || '',
          log.ipAddress || '',
          deriveStatusLabel(log.action),
        ]
          .map(csvEscape)
          .join(',')
      ),
    ];

    const csv = '\uFEFF' + lines.join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    const fileSafe = `system-logs-${stamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSafe}"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting system logs:', error);
    res.status(500).json({
      message: 'Failed to export logs',
      error: error.message,
    });
  }
});

// GET /api/logs - Fetch system logs with filtering (Admin and Instructor access)
router.get('/', authenticateToken, requireRole(['ADMIN', 'INSTRUCTOR']), async (req, res) => {
  console.log('=== LOGS API CALLED ===');
  console.log('User:', req.user);
  console.log('Query params:', req.query);
  try {
    const {
      page = 1,
      limit = 50,
    } = req.query;

    const where = buildBaseLogsWhere(req.query);

    // Get total count for pagination
    const total = await prisma.systemLog.count({ where });

    // Fetch logs with user relationship
    const logs = await prisma.systemLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit)
    });

    // Get unique actions for filter dropdown
    const uniqueActions = await prisma.systemLog.findMany({
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' }
    });

    // Calculate stats
    const stats = {
      totalActions: total,
      activeUsers: await prisma.systemLog.groupBy({
        by: ['userId'],
        where: {
          ...where,
          userId: { not: null }
        }
      }).then(groups => groups.length),
      criticalCommands: await prisma.systemLog.count({
        where: {
          ...where,
          ...criticalActionsWhereClause(),
        },
      }),
      errors: await prisma.systemLog.count({
        where: {
          ...where,
          OR: [
            { action: { contains: 'ERROR' } },
            { description: { contains: 'error' } }
          ]
        }
      })
    };

    res.json({
      logs,
      stats,
      uniqueActions: uniqueActions.map(item => item.action),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
    
    console.log('=== LOGS RESPONSE ===');
    console.log('Logs count:', logs.length);
    console.log('Stats:', stats);
    console.log('Unique actions:', uniqueActions);

  } catch (error) {
    console.error('Error fetching system logs:', error);
    res.status(500).json({ 
      message: 'Internal server error', 
      error: error.message 
    });
  }
});

export default router;
