import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';
import { recordActivity, clientIp } from '../utils/activityLog.js';

const router = express.Router();
const prisma = new PrismaClient();

// All routes are protected with JWT middleware
router.use(authenticateToken);

// Helper function to generate computer name prefix from lab name
// "Computer Lab A" → "CLA", "EdTech Laboratory" → "EL", "Sandbox" → "S"
const generateComputerPrefix = (labName) => {
  const words = labName.trim().split(/\s+/);
  const prefix = words.map(word => word[0].toUpperCase()).join('');
  return prefix;
};

// Helper function to generate computer names
const generateComputerName = (labName, seatNumber) => {
  const prefix = generateComputerPrefix(labName);
  return `${prefix}-PC${seatNumber.toString().padStart(2, '0')}`;
};

// GET /api/labs - Return all laboratories
router.get('/', async (req, res) => {
  try {
    console.log('Labs API called');
    const labs = await prisma.laboratory.findMany({
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        assignedInstructor: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        computers: {
          orderBy: {
            seatNumber: 'asc'
          }
        },
        _count: {
          select: {
            computers: true
          }
        }
      }
    });

    // Transform the response to include computer count
    const formattedLabs = labs.map(lab => ({
      id: lab.id,
      name: lab.name,
      location: lab.location,
      building: lab.building,
      roomNumber: lab.roomNumber,
      capacity: lab.capacity,
      status: lab.status,
      createdAt: lab.createdAt,
      assignedInstructor: lab.assignedInstructor,
      computerCount: lab._count.computers,
      computers: lab.computers,
      // Schedule fields
      scheduleDay: lab.scheduleDay,
      scheduleTimeSlot: lab.scheduleTimeSlot,
      scheduleClass: lab.scheduleClass,
      scheduleSubjectCode: lab.scheduleSubjectCode
    }));

    res.json({
      success: true,
      data: formattedLabs
    });
    console.log('Labs sent:', formattedLabs.length);
  } catch (error) {
    console.error('Error fetching labs:', error);
    res.status(500).json({ message: 'Failed to fetch laboratories' });
  }
});

// GET /api/labs/:id - Return single lab with computers
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const labId = parseInt(id);

    if (isNaN(labId)) {
      return res.status(400).json({ message: 'Invalid lab ID' });
    }

    const lab = await prisma.laboratory.findUnique({
      where: { id: labId },
      include: {
        assignedInstructor: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        },
        computers: {
          orderBy: {
            seatNumber: 'asc'
          }
        }
      }
    });

    if (!lab) {
      return res.status(404).json({ message: 'Laboratory not found' });
    }

    res.json(lab);
  } catch (error) {
    console.error('Error fetching lab:', error);
    res.status(500).json({ message: 'Failed to fetch laboratory' });
  }
});

// POST /api/labs - Create new lab with computers
router.post('/', async (req, res) => {
  try {
    const { name, location, building, roomNumber, capacity, status, assignedInstructorId, computerCount, 
      scheduleDay, scheduleTimeSlot, scheduleClass, scheduleSubjectCode } = req.body;

    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({ message: 'Lab name is required' });
    }

    if (!capacity || isNaN(parseInt(capacity)) || parseInt(capacity) <= 0) {
      return res.status(400).json({ message: 'Valid capacity is required' });
    }

    if (!computerCount || isNaN(parseInt(computerCount)) || parseInt(computerCount) <= 0) {
      return res.status(400).json({ message: 'Valid computer count is required (minimum 1)' });
    }

    if (parseInt(computerCount) > 200) {
      return res.status(400).json({ message: 'Computer count cannot exceed 200' });
    }

    // Check if assignedInstructorId is valid if provided
    if (assignedInstructorId) {
      const instructor = await prisma.user.findUnique({
        where: { 
          id: parseInt(assignedInstructorId),
          role: 'INSTRUCTOR'
        }
      });

      if (!instructor) {
        return res.status(400).json({ message: 'Invalid instructor ID' });
      }
    }

    // Create lab and computers in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create the lab
      const lab = await tx.laboratory.create({
        data: {
          name: name.trim(),
          location: location?.trim() || null,
          building: building || null,
          roomNumber: roomNumber?.trim() || name.trim(),
          capacity: parseInt(capacity),
          status: status || 'ACTIVE',
          assignedInstructorId: assignedInstructorId ? parseInt(assignedInstructorId) : null,
          // Schedule fields
          scheduleDay: scheduleDay || null,
          scheduleTimeSlot: scheduleTimeSlot || null,
          scheduleClass: scheduleClass || null,
          scheduleSubjectCode: scheduleSubjectCode || null
        },
        include: {
          assignedInstructor: {
            select: {
              id: true,
              fullName: true,
              username: true
            }
          }
        }
      });

      // Create computers for this lab
      const count = parseInt(computerCount);
      const computerData = [];
      
      for (let i = 1; i <= count; i++) {
        computerData.push({
          name: generateComputerName(lab.name, i),
          seatNumber: i,
          status: 'OFFLINE',
          isLocked: false,
          laboratoryId: lab.id
        });
      }

      await tx.computer.createMany({
        data: computerData
      });

      // Fetch the created computers
      const computers = await tx.computer.findMany({
        where: { laboratoryId: lab.id },
        orderBy: { seatNumber: 'asc' }
      });

      return { ...lab, computers };
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'LAB_CREATED',
      description: `Laboratory "${result.name}" id=${result.id} with ${result.computers?.length || 0} computer slots`,
      ipAddress: clientIp(req),
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating lab:', error);
    res.status(500).json({ message: 'Failed to create laboratory' });
  }
});

// PUT /api/labs/:id - Update lab and handle computer count changes
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const labId = parseInt(id);

    if (isNaN(labId)) {
      return res.status(400).json({ message: 'Invalid lab ID' });
    }

    const { name, location, building, roomNumber, capacity, status, assignedInstructorId, computerCount,
      scheduleDay, scheduleTimeSlot, scheduleClass, scheduleSubjectCode } = req.body;

    // Check if lab exists
    const existingLab = await prisma.laboratory.findUnique({
      where: { id: labId },
      include: {
        computers: {
          orderBy: { seatNumber: 'asc' }
        }
      }
    });

    if (!existingLab) {
      return res.status(404).json({ message: 'Laboratory not found' });
    }

    // Validation
    if (name !== undefined && name.trim() === '') {
      return res.status(400).json({ message: 'Lab name cannot be empty' });
    }

    if (capacity !== undefined && (isNaN(parseInt(capacity)) || parseInt(capacity) <= 0)) {
      return res.status(400).json({ message: 'Valid capacity is required' });
    }

    // Check if assignedInstructorId is valid if provided
    if (assignedInstructorId) {
      const instructor = await prisma.user.findUnique({
        where: { 
          id: parseInt(assignedInstructorId),
          role: 'INSTRUCTOR'
        }
      });

      if (!instructor) {
        return res.status(400).json({ message: 'Invalid instructor ID' });
      }
    }

    // Handle computer count changes
    let warning = null;
    let finalComputers = existingLab.computers;
    const currentCount = existingLab.computers.length;
    const newCount = computerCount !== undefined ? parseInt(computerCount) : currentCount;

    if (computerCount !== undefined && !isNaN(newCount)) {
      if (newCount > 200) {
        return res.status(400).json({ message: 'Computer count cannot exceed 200' });
      }

      if (newCount < currentCount) {
        // Don't delete computers, just warn
        warning = {
          type: 'COMPUTER_COUNT_REDUCTION',
          message: `You are reducing the computer count from ${currentCount} to ${newCount}. Existing computers will not be automatically deleted. Please manually remove computers from the Computers Panel if needed.`,
          currentCount,
          newCount
        };
      } else if (newCount > currentCount) {
        // Add more computers
        const computersToAdd = [];
        const labName = name !== undefined ? name.trim() : existingLab.name;
        
        for (let i = currentCount + 1; i <= newCount; i++) {
          computersToAdd.push({
            name: generateComputerName(labName, i),
            seatNumber: i,
            status: 'OFFLINE',
            isLocked: false,
            laboratoryId: labId
          });
        }

        await prisma.computer.createMany({
          data: computersToAdd
        });
      }
      // If same count, do nothing
    }

    // Build update data
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (location !== undefined) updateData.location = location?.trim() || null;
    if (building !== undefined) updateData.building = building || null;
    if (roomNumber !== undefined) updateData.roomNumber = roomNumber?.trim() || null;
    if (capacity !== undefined) updateData.capacity = parseInt(capacity);
    if (status !== undefined) updateData.status = status;
    if (assignedInstructorId !== undefined) {
      updateData.assignedInstructorId = assignedInstructorId ? parseInt(assignedInstructorId) : null;
    }
    // Schedule fields
    if (scheduleDay !== undefined) updateData.scheduleDay = scheduleDay || null;
    if (scheduleTimeSlot !== undefined) updateData.scheduleTimeSlot = scheduleTimeSlot || null;
    if (scheduleClass !== undefined) updateData.scheduleClass = scheduleClass || null;
    if (scheduleSubjectCode !== undefined) updateData.scheduleSubjectCode = scheduleSubjectCode || null;

    // Update the lab
    const updatedLab = await prisma.laboratory.update({
      where: { id: labId },
      data: updateData,
      include: {
        assignedInstructor: {
          select: {
            id: true,
            fullName: true,
            username: true
          }
        }
      }
    });

    // Fetch updated computers list
    finalComputers = await prisma.computer.findMany({
      where: { laboratoryId: labId },
      orderBy: { seatNumber: 'asc' }
    });

    const response = {
      ...updatedLab,
      computers: finalComputers,
      computerCount: finalComputers.length
    };

    if (warning) {
      response.warning = warning;
    }

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'LAB_UPDATED',
      description: `Laboratory id=${labId} "${response.name}" updated (computers: ${response.computerCount})`,
      ipAddress: clientIp(req),
    });

    res.json(response);
  } catch (error) {
    console.error('Error updating lab:', error);
    res.status(500).json({ message: 'Failed to update laboratory' });
  }
});

// DELETE /api/labs/:id - Delete lab and all its computers
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const labId = parseInt(id);

    if (isNaN(labId)) {
      return res.status(400).json({ message: 'Invalid lab ID' });
    }

    // Check if lab exists
    const lab = await prisma.laboratory.findUnique({
      where: { id: labId },
      include: {
        computers: true
      }
    });

    if (!lab) {
      return res.status(404).json({ message: 'Laboratory not found' });
    }

    const computerCount = lab.computers.length;

    // Delete lab and all computers (cascade delete is set in schema)
    await prisma.laboratory.delete({
      where: { id: labId }
    });

    await recordActivity(prisma, {
      userId: req.user.id,
      action: 'LAB_DELETED',
      description: `Deleted laboratory "${lab.name}" id=${labId} and ${computerCount} computer record(s)`,
      ipAddress: clientIp(req),
    });

    res.json({ 
      message: 'Laboratory and all associated computers deleted successfully',
      deletedComputers: computerCount
    });
  } catch (error) {
    console.error('Error deleting lab:', error);
    res.status(500).json({ message: 'Failed to delete laboratory' });
  }
});

export default router;
