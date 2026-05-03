import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';
import { recordActivity, clientIp, summarizePayload } from '../utils/activityLog.js';

const router = express.Router();
const prisma = new PrismaClient();

// All routes are protected with JWT middleware
router.use(authenticateToken);

// GET /api/computers - Get all computers with optional filters
router.get('/', async (req, res) => {
  try {
    const { labId, status } = req.query;
    
    // Build filter conditions
    const whereClause = {};
    
    if (labId && !isNaN(parseInt(labId))) {
      whereClause.laboratoryId = parseInt(labId);
    }
    
    if (status && ['ONLINE', 'OFFLINE', 'IN_USE', 'IDLE', 'MAINTENANCE'].includes(status.toUpperCase())) {
      whereClause.status = status.toUpperCase();
    }

    const computers = await prisma.computer.findMany({
      where: whereClause,
      include: {
        laboratory: {
          select: {
            id: true,
            name: true,
            location: true
          }
        }
      },
      orderBy: [
        { laboratoryId: 'asc' },
        { seatNumber: 'asc' }
      ]
    });

    // Transform to match frontend expectations
    const formattedComputers = computers.map(comp => ({
      id: comp.id,
      name: comp.name,
      seatNumber: comp.seatNumber,
      status: comp.status.toLowerCase(), // Convert to lowercase for frontend
      isLocked: comp.isLocked,
      ipAddress: comp.ipAddress,
      macAddress: comp.macAddress,
      labId: comp.laboratoryId,
      lab: comp.laboratory.name,
      labLocation: comp.laboratory.location,
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
      // Hardware specifications
      processor: comp.processor,
      ram: comp.ram,
      storageType: comp.storageType,
      storageSize: comp.storageSize,
      gpu: comp.gpu,
      osVersion: comp.osVersion,
      // Add placeholder fields for monitoring data (will be populated by agent service later)
      user: null, // Will be populated when agent reports active user
      cpu: 0,     // Will be populated by agent
      memory: 0,  // Will be populated by agent
      uptime: '-' // Will be populated by agent
    }));

    res.json({
      success: true,
      data: formattedComputers
    });
  } catch (error) {
    console.error('Error fetching computers:', error);
    res.status(500).json({ message: 'Failed to fetch computers' });
  }
});

// GET /api/computers/:id - Get single computer by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const computerId = parseInt(id);

    if (isNaN(computerId)) {
      return res.status(400).json({ message: 'Invalid computer ID' });
    }

    const computer = await prisma.computer.findUnique({
      where: { id: computerId },
      include: {
        laboratory: {
          select: {
            id: true,
            name: true,
            location: true
          }
        }
      }
    });

    if (!computer) {
      return res.status(404).json({ message: 'Computer not found' });
    }

    res.json(computer);
  } catch (error) {
    console.error('Error fetching computer:', error);
    res.status(500).json({ message: 'Failed to fetch computer' });
  }
});

// PUT /api/computers/:id - Update computer
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const computerId = parseInt(id);

    if (isNaN(computerId)) {
      return res.status(400).json({ message: 'Invalid computer ID' });
    }

    const { name, status, isLocked, ipAddress, macAddress, seatNumber, 
      processor, ram, storageType, storageSize, gpu, osVersion } = req.body;

    // Check if computer exists
    const existingComputer = await prisma.computer.findUnique({
      where: { id: computerId }
    });

    if (!existingComputer) {
      return res.status(404).json({ message: 'Computer not found' });
    }

    // Build update data
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (status !== undefined) {
      const validStatuses = ['ONLINE', 'OFFLINE', 'IN_USE', 'IDLE', 'MAINTENANCE'];
      const upperStatus = status.toUpperCase();
      if (!validStatuses.includes(upperStatus)) {
        return res.status(400).json({ message: 'Invalid status value' });
      }
      updateData.status = upperStatus;
    }
    if (isLocked !== undefined) updateData.isLocked = isLocked;
    if (ipAddress !== undefined) updateData.ipAddress = ipAddress || null;
    if (macAddress !== undefined) updateData.macAddress = macAddress || null;
    if (seatNumber !== undefined) updateData.seatNumber = parseInt(seatNumber);
    
    // Hardware specifications
    if (processor !== undefined) updateData.processor = processor || null;
    if (ram !== undefined) updateData.ram = ram || null;
    if (storageType !== undefined) updateData.storageType = storageType || null;
    if (storageSize !== undefined) updateData.storageSize = storageSize || null;
    if (gpu !== undefined) updateData.gpu = gpu || null;
    if (osVersion !== undefined) updateData.osVersion = osVersion || null;

    const computer = await prisma.computer.update({
      where: { id: computerId },
      data: updateData,
      include: {
        laboratory: {
          select: {
            id: true,
            name: true,
            location: true
          }
        }
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'COMPUTER_UPDATED',
      description: `Computer "${computer.name}" id=${computerId} lab="${computer.laboratory?.name}" fields=${summarizePayload(updateData)}`,
      ipAddress: clientIp(req),
    });

    res.json(computer);
  } catch (error) {
    console.error('Error updating computer:', error);
    res.status(500).json({ message: 'Failed to update computer' });
  }
});

// DELETE /api/computers/:id - Delete single computer
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const computerId = parseInt(id);

    if (isNaN(computerId)) {
      return res.status(400).json({ message: 'Invalid computer ID' });
    }

    // Check if computer exists and get its status
    const computer = await prisma.computer.findUnique({
      where: { id: computerId }
    });

    if (!computer) {
      return res.status(404).json({ message: 'Computer not found' });
    }

    // Check if computer is currently in use
    if (computer.status === 'IN_USE') {
      return res.status(400).json({ 
        message: 'Cannot delete computer that is currently in use. Please ensure no user is logged in.' 
      });
    }

    await prisma.computer.delete({
      where: { id: computerId }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'COMPUTER_DELETED',
      description: `Deleted computer "${computer.name}" id=${computerId}`,
      ipAddress: clientIp(req),
    });

    res.json({ message: 'Computer deleted successfully' });
  } catch (error) {
    console.error('Error deleting computer:', error);
    res.status(500).json({ message: 'Failed to delete computer' });
  }
});

// GET /api/computers/:id/software - Get software installed on a computer
router.get('/:id/software', async (req, res) => {
  try {
    const { id } = req.params;
    const computerId = parseInt(id);

    if (isNaN(computerId)) {
      return res.status(400).json({ message: 'Invalid computer ID' });
    }

    // Check if computer exists
    const computer = await prisma.computer.findUnique({
      where: { id: computerId }
    });

    if (!computer) {
      return res.status(404).json({ message: 'Computer not found' });
    }

    const software = await prisma.computerSoftware.findMany({
      where: { computerId },
      orderBy: { installedAt: 'desc' }
    });

    res.json(software);
  } catch (error) {
    console.error('Error fetching computer software:', error);
    res.status(500).json({ message: 'Failed to fetch software list' });
  }
});

// POST /api/computers/:id/software - Add software to a computer
router.post('/:id/software', async (req, res) => {
  try {
    const { id } = req.params;
    const computerId = parseInt(id);
    const { softwareName, version } = req.body;

    if (isNaN(computerId)) {
      return res.status(400).json({ message: 'Invalid computer ID' });
    }

    if (!softwareName || softwareName.trim() === '') {
      return res.status(400).json({ message: 'Software name is required' });
    }

    // Check if computer exists
    const computer = await prisma.computer.findUnique({
      where: { id: computerId }
    });

    if (!computer) {
      return res.status(404).json({ message: 'Computer not found' });
    }

    const software = await prisma.computerSoftware.create({
      data: {
        computerId,
        softwareName: softwareName.trim(),
        version: version?.trim() || null
      }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'COMPUTER_SOFTWARE_ADDED',
      description: `Added software "${software.softwareName}" to computer id=${computerId}`,
      ipAddress: clientIp(req),
    });

    res.status(201).json(software);
  } catch (error) {
    console.error('Error adding software:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ message: 'Software already exists on this computer' });
    }
    res.status(500).json({ message: 'Failed to add software' });
  }
});

// DELETE /api/computers/:id/software/:softwareId - Remove software from a computer
router.delete('/:id/software/:softwareId', async (req, res) => {
  try {
    const { id, softwareId } = req.params;
    const computerId = parseInt(id);
    const sId = parseInt(softwareId);

    if (isNaN(computerId) || isNaN(sId)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    await prisma.computerSoftware.delete({
      where: { id: sId }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'COMPUTER_SOFTWARE_REMOVED',
      description: `Removed software record id=${sId} from computer id=${computerId}`,
      ipAddress: clientIp(req),
    });

    res.json({ message: 'Software removed successfully' });
  } catch (error) {
    console.error('Error removing software:', error);
    res.status(500).json({ message: 'Failed to remove software' });
  }
});

// POST /api/computers/bulk-update - Bulk update computers
router.post('/bulk-update', async (req, res) => {
  try {
    const { computerIds, specs } = req.body;

    if (!Array.isArray(computerIds) || computerIds.length === 0) {
      return res.status(400).json({ message: 'Computer IDs array is required' });
    }

    const validIds = computerIds.map(id => parseInt(id)).filter(id => !isNaN(id));

    if (validIds.length === 0) {
      return res.status(400).json({ message: 'No valid computer IDs provided' });
    }

    // Build update data from specs
    const updateData = {};
    if (specs.processor !== undefined) updateData.processor = specs.processor || null;
    if (specs.ram !== undefined) updateData.ram = specs.ram || null;
    if (specs.storageType !== undefined) updateData.storageType = specs.storageType || null;
    if (specs.storageSize !== undefined) updateData.storageSize = specs.storageSize || null;
    if (specs.gpu !== undefined) updateData.gpu = specs.gpu || null;
    if (specs.osVersion !== undefined) updateData.osVersion = specs.osVersion || null;

    // Update all specified computers
    const result = await prisma.computer.updateMany({
      where: { id: { in: validIds } },
      data: updateData
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'COMPUTER_BULK_UPDATED',
      description: `Bulk-updated ${result.count} computer(s) ids=[${validIds.join(',')}] ${summarizePayload(updateData)}`,
      ipAddress: clientIp(req),
    });

    res.json({ 
      message: `Updated ${result.count} computers successfully`,
      updatedCount: result.count
    });
  } catch (error) {
    console.error('Error bulk updating computers:', error);
    res.status(500).json({ message: 'Failed to update computers' });
  }
});

export default router;
