import express from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { recordActivity, clientIp } from '../utils/activityLog.js';

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Generate ticket ID
const generateTicketId = async () => {
  const year = new Date().getFullYear();
  const currentYearTickets = await prisma.ticket.count({
    where: {
      ticketId: {
        startsWith: `T-${year}-`
      }
    }
  });
  
  const nextNumber = currentYearTickets + 1;
  return `T-${year}-${String(nextNumber).padStart(3, '0')}`;
};

// GET all tickets for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
      where: {
        createdBy: req.user.id
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        assignee: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(tickets);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// GET tickets pending approval (for instructors)
router.get('/pending-approval', authenticateToken, async (req, res) => {
  try {
    // Only instructors can view pending approvals
    if (req.user.role !== 'INSTRUCTOR' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const tickets = await prisma.ticket.findMany({
      where: {
        status: 'PENDING_APPROVAL'
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true,
            role: true
          }
        },
        assignee: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(tickets);
  } catch (error) {
    console.error('Error fetching pending tickets:', error);
    res.status(500).json({ error: 'Failed to fetch pending tickets' });
  }
});

// GET all tickets (for instructors/admins)
router.get('/all', authenticateToken, async (req, res) => {
  try {
    // Only instructors and admins can view all tickets
    if (req.user.role !== 'INSTRUCTOR' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { status, priority, category } = req.query;
    const where = {};

    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (category) where.category = category;

    const tickets = await prisma.ticket.findMany({
      where,
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true,
            role: true
          }
        },
        assignee: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(tickets);
  } catch (error) {
    console.error('Error fetching all tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// POST create new ticket
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, category, priority, description } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    const ticketId = await generateTicketId();

    const ticket = await prisma.ticket.create({
      data: {
        ticketId,
        title,
        description,
        category,
        priority: priority || 'MEDIUM',
        status: 'PENDING_APPROVAL',
        createdBy: req.user.id
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'TICKET_CREATED',
      description: `Ticket ${ticket.ticketId} "${title}" created (pending approval)`,
      ipAddress: clientIp(req),
    });

    res.status(201).json(ticket);
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// PUT approve ticket
router.put('/:id/approve', authenticateToken, async (req, res) => {
  try {
    // Only instructors and admins can approve tickets
    if (req.user.role !== 'INSTRUCTOR' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const ticketId = parseInt(req.params.id);
    const { assignedTo } = req.body;

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ error: 'Ticket is not pending approval' });
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'APPROVED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        assignedTo: assignedTo || req.user.id,
        updatedAt: new Date()
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        assignee: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'TICKET_APPROVED',
      description: `Ticket ${updatedTicket.ticketId} approved; assignedTo=${updatedTicket.assignedTo ?? ''}`,
      ipAddress: clientIp(req),
    });

    res.json(updatedTicket);
  } catch (error) {
    console.error('Error approving ticket:', error);
    res.status(500).json({ error: 'Failed to approve ticket' });
  }
});

// PUT reject ticket
router.put('/:id/reject', authenticateToken, async (req, res) => {
  try {
    // Only instructors and admins can reject tickets
    if (req.user.role !== 'INSTRUCTOR' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const ticketId = parseInt(req.params.id);
    const { rejectionReason } = req.body;

    if (!rejectionReason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ error: 'Ticket is not pending approval' });
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'REJECTED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        rejectionReason,
        updatedAt: new Date()
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'TICKET_REJECTED',
      description: `Ticket ${updatedTicket.ticketId} rejected: ${rejectionReason}`,
      ipAddress: clientIp(req),
    });

    res.json(updatedTicket);
  } catch (error) {
    console.error('Error rejecting ticket:', error);
    res.status(500).json({ error: 'Failed to reject ticket' });
  }
});

// PUT update ticket status
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Only allow status updates for approved tickets
    if (ticket.status === 'PENDING_APPROVAL') {
      return res.status(400).json({ error: 'Ticket must be approved first' });
    }

    // Only instructors, admins, or assigned users can update status
    if (req.user.role !== 'INSTRUCTOR' && 
        req.user.role !== 'ADMIN' && 
        ticket.assignedTo !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status,
        updatedAt: new Date()
      },
      include: {
        creator: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        assignee: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        approver: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'TICKET_STATUS_UPDATED',
      description: `Ticket ${updatedTicket.ticketId} status → ${status}`,
      ipAddress: clientIp(req),
    });

    res.json(updatedTicket);
  } catch (error) {
    console.error('Error updating ticket status:', error);
    res.status(500).json({ error: 'Failed to update ticket status' });
  }
});

// GET ticket statistics
router.get('/stats/my', authenticateToken, async (req, res) => {
  try {
    const stats = await prisma.ticket.groupBy({
      by: ['status'],
      where: {
        createdBy: req.user.id
      },
      _count: {
        status: true
      }
    });

    const result = {
      total: 0,
      pendingApproval: 0,
      approved: 0,
      rejected: 0,
      open: 0,
      inProgress: 0,
      resolved: 0,
      closed: 0
    };

    stats.forEach(stat => {
      result.total += stat._count.status;
      switch (stat.status) {
        case 'PENDING_APPROVAL':
          result.pendingApproval = stat._count.status;
          break;
        case 'APPROVED':
          result.approved = stat._count.status;
          break;
        case 'REJECTED':
          result.rejected = stat._count.status;
          break;
        case 'OPEN':
          result.open = stat._count.status;
          break;
        case 'IN_PROGRESS':
          result.inProgress = stat._count.status;
          break;
        case 'RESOLVED':
          result.resolved = stat._count.status;
          break;
        case 'CLOSED':
          result.closed = stat._count.status;
          break;
      }
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching ticket stats:', error);
    res.status(500).json({ error: 'Failed to fetch ticket statistics' });
  }
});

// GET ticket statistics for instructors
router.get('/stats/instructor', authenticateToken, async (req, res) => {
  try {
    // Only instructors and admins can view these stats
    if (req.user.role !== 'INSTRUCTOR' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stats = await prisma.ticket.groupBy({
      by: ['status'],
      _count: {
        status: true
      }
    });

    const result = {
      total: 0,
      pendingApproval: 0,
      approved: 0,
      rejected: 0,
      open: 0,
      inProgress: 0,
      resolved: 0,
      closed: 0
    };

    stats.forEach(stat => {
      result.total += stat._count.status;
      switch (stat.status) {
        case 'PENDING_APPROVAL':
          result.pendingApproval = stat._count.status;
          break;
        case 'APPROVED':
          result.approved = stat._count.status;
          break;
        case 'REJECTED':
          result.rejected = stat._count.status;
          break;
        case 'OPEN':
          result.open = stat._count.status;
          break;
        case 'IN_PROGRESS':
          result.inProgress = stat._count.status;
          break;
        case 'RESOLVED':
          result.resolved = stat._count.status;
          break;
        case 'CLOSED':
          result.closed = stat._count.status;
          break;
      }
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching instructor ticket stats:', error);
    res.status(500).json({ error: 'Failed to fetch ticket statistics' });
  }
});

export default router;
