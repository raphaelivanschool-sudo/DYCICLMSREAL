import express from "express";
import { PrismaClient } from "@prisma/client";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { recordActivity, clientIp } from "../utils/activityLog.js";

const router = express.Router();
const prisma = new PrismaClient();

// Get all hardware inventory items for a specific lab
router.get(
  "/laboratory/:laboratoryId",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { laboratoryId } = req.params;
      const { search, deviceType, condition } = req.query;

      const whereClause = {
        laboratoryId: parseInt(laboratoryId),
      };

      // Add filters
      if (search) {
        whereClause.OR = [
          { name: { contains: search } },
          { serialNumber: { contains: search } },
          { model: { contains: search } },
        ];
      }

      if (deviceType && deviceType !== "all") {
        whereClause.deviceType = deviceType;
      }

      if (condition && condition !== "all") {
        whereClause.condition = condition;
      }

      const items = await prisma.hardwareInventory.findMany({
        where: whereClause,
        include: {
          laboratory: {
            select: {
              id: true,
              name: true,
              roomNumber: true,
            },
          },
          assignedComputer: {
            select: {
              id: true,
              name: true,
              seatNumber: true,
            },
          },
        },
        orderBy: [{ deviceType: "asc" }, { name: "asc" }],
      });

      res.json({
        success: true,
        data: items,
      });
    } catch (error) {
      console.error("Error fetching hardware inventory:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch hardware inventory",
      });
    }
  },
);

// Get statistics for a specific lab
router.get(
  "/laboratory/:laboratoryId/stats",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { laboratoryId } = req.params;

      const stats = await prisma.hardwareInventory.groupBy({
        by: ["condition", "status"],
        where: {
          laboratoryId: parseInt(laboratoryId),
        },
        _count: {
          id: true,
        },
      });

      const totalItems = await prisma.hardwareInventory.count({
        where: {
          laboratoryId: parseInt(laboratoryId),
        },
      });

      // Process stats into required format
      const result = {
        total: totalItems,
        good: 0,
        needAttention: 0,
        underRepairOrMissing: 0,
      };

      stats.forEach((stat) => {
        const count = stat._count.id;

        if (stat.condition === "GOOD") {
          result.good += count;
        } else if (stat.condition === "POOR" || stat.condition === "DAMAGED") {
          result.needAttention += count;
        }

        if (stat.status === "UNDER_REPAIR" || stat.status === "MISSING") {
          result.underRepairOrMissing += count;
        }
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Error fetching inventory stats:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch inventory statistics",
      });
    }
  },
);

// Get a single hardware inventory item
router.get(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      const item = await prisma.hardwareInventory.findUnique({
        where: {
          id: parseInt(id),
        },
        include: {
          laboratory: true,
          assignedComputer: true,
        },
      });

      if (!item) {
        return res.status(404).json({
          success: false,
          message: "Hardware inventory item not found",
        });
      }

      res.json({
        success: true,
        data: item,
      });
    } catch (error) {
      console.error("Error fetching hardware inventory item:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch hardware inventory item",
      });
    }
  },
);

// Create a new hardware inventory item
router.post(
  "/",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const {
        name,
        deviceType,
        model,
        serialNumber,
        condition,
        status,
        notes,
        laboratoryId,
        assignedComputerId,
      } = req.body;

      // Check if serial number already exists
      const existingItem = await prisma.hardwareInventory.findUnique({
        where: {
          serialNumber,
        },
      });

      if (existingItem) {
        return res.status(400).json({
          success: false,
          message: "Serial number already exists",
        });
      }

      // Verify laboratory exists
      const laboratory = await prisma.laboratory.findUnique({
        where: {
          id: laboratoryId,
        },
      });

      if (!laboratory) {
        return res.status(400).json({
          success: false,
          message: "Laboratory not found",
        });
      }

      // If assignedComputerId is provided, verify it exists and belongs to the same lab
      if (assignedComputerId) {
        const computer = await prisma.computer.findUnique({
          where: {
            id: assignedComputerId,
          },
        });

        if (!computer || computer.laboratoryId !== laboratoryId) {
          return res.status(400).json({
            success: false,
            message:
              "Assigned computer not found or does not belong to the selected laboratory",
          });
        }
      }

      const newItem = await prisma.hardwareInventory.create({
        data: {
          name,
          deviceType,
          model: model || null,
          serialNumber,
          condition: condition || "GOOD",
          status: status || "ACTIVE",
          notes: notes || null,
          laboratoryId,
          assignedComputerId: assignedComputerId || null,
        },
        include: {
          laboratory: {
            select: {
              id: true,
              name: true,
              roomNumber: true,
            },
          },
          assignedComputer: {
            select: {
              id: true,
              name: true,
              seatNumber: true,
            },
          },
        },
      });

      await recordActivity(prisma, {
        userId: req.user.id,
        action: "HARDWARE_INVENTORY_CREATED",
        description: `Added "${name}" (${serialNumber}) lab id=${laboratoryId}`,
        ipAddress: clientIp(req),
      });

      res.status(201).json({
        success: true,
        data: newItem,
        message: "Hardware inventory item created successfully",
      });
    } catch (error) {
      console.error("Error creating hardware inventory item:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create hardware inventory item",
      });
    }
  },
);

// Update a hardware inventory item
router.put(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        name,
        deviceType,
        model,
        serialNumber,
        condition,
        status,
        notes,
        laboratoryId,
        assignedComputerId,
      } = req.body;

      // Check if item exists
      const existingItem = await prisma.hardwareInventory.findUnique({
        where: {
          id: parseInt(id),
        },
      });

      if (!existingItem) {
        return res.status(404).json({
          success: false,
          message: "Hardware inventory item not found",
        });
      }

      // Check if serial number conflicts with another item
      if (serialNumber !== existingItem.serialNumber) {
        const serialConflict = await prisma.hardwareInventory.findUnique({
          where: {
            serialNumber,
          },
        });

        if (serialConflict) {
          return res.status(400).json({
            success: false,
            message: "Serial number already exists",
          });
        }
      }

      // Verify laboratory exists
      const laboratory = await prisma.laboratory.findUnique({
        where: {
          id: laboratoryId,
        },
      });

      if (!laboratory) {
        return res.status(400).json({
          success: false,
          message: "Laboratory not found",
        });
      }

      // If assignedComputerId is provided, verify it exists and belongs to the same lab
      if (assignedComputerId) {
        const computer = await prisma.computer.findUnique({
          where: {
            id: assignedComputerId,
          },
        });

        if (!computer || computer.laboratoryId !== laboratoryId) {
          return res.status(400).json({
            success: false,
            message:
              "Assigned computer not found or does not belong to the selected laboratory",
          });
        }
      }

      const updatedItem = await prisma.hardwareInventory.update({
        where: {
          id: parseInt(id),
        },
        data: {
          name,
          deviceType,
          model: model || null,
          serialNumber,
          condition: condition || "GOOD",
          status: status || "ACTIVE",
          notes: notes || null,
          laboratoryId,
          assignedComputerId: assignedComputerId || null,
        },
        include: {
          laboratory: {
            select: {
              id: true,
              name: true,
              roomNumber: true,
            },
          },
          assignedComputer: {
            select: {
              id: true,
              name: true,
              seatNumber: true,
            },
          },
        },
      });

      await recordActivity(prisma, {
        userId: req.user.id,
        action: "HARDWARE_INVENTORY_UPDATED",
        description: `Updated item id=${id} "${updatedItem.name}" (${updatedItem.serialNumber})`,
        ipAddress: clientIp(req),
      });

      res.json({
        success: true,
        data: updatedItem,
        message: "Hardware inventory item updated successfully",
      });
    } catch (error) {
      console.error("Error updating hardware inventory item:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update hardware inventory item",
      });
    }
  },
);

// Delete a hardware inventory item
router.delete(
  "/:id",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check if item exists
      const existingItem = await prisma.hardwareInventory.findUnique({
        where: {
          id: parseInt(id),
        },
      });

      if (!existingItem) {
        return res.status(404).json({
          success: false,
          message: "Hardware inventory item not found",
        });
      }

      await prisma.hardwareInventory.delete({
        where: {
          id: parseInt(id),
        },
      });

      await recordActivity(prisma, {
        userId: req.user.id,
        action: "HARDWARE_INVENTORY_DELETED",
        description: `Deleted inventory "${existingItem.name}" SN=${existingItem.serialNumber} id=${id}`,
        ipAddress: clientIp(req),
      });

      res.json({
        success: true,
        message: "Hardware inventory item deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting hardware inventory item:", error);
      res.status(500).json({
        success: false,
        message: "Failed to delete hardware inventory item",
      });
    }
  },
);

// Get computers for a specific laboratory (for assignment dropdown)
router.get(
  "/computers/laboratory/:laboratoryId",
  authenticateToken,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const { laboratoryId } = req.params;

      const computers = await prisma.computer.findMany({
        where: {
          laboratoryId: parseInt(laboratoryId),
        },
        select: {
          id: true,
          name: true,
          seatNumber: true,
        },
        orderBy: [{ seatNumber: "asc" }, { name: "asc" }],
      });

      res.json({
        success: true,
        data: computers,
      });
    } catch (error) {
      console.error("Error fetching computers:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch computers",
      });
    }
  },
);

export default router;
