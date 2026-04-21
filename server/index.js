import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import dgram from "dgram";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from server/.env
dotenv.config({ path: join(__dirname, ".env") });

// Environment check (only log in development)
if (process.env.NODE_ENV !== 'production') {
  console.log("JWT_SECRET loaded:", process.env.JWT_SECRET ? "YES" : "NO");
  console.log("DATABASE_URL loaded:", process.env.DATABASE_URL ? "YES" : "NO");
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      // Allow all origins for agent and client connections
      callback(null, true);
    },
    credentials: true,
  },
});

const prisma = new PrismaClient();

// Store connected users
const connectedUsers = new Map();

// Store connected PC agents
const connectedComputers = new Map();

// Store discovered services via UDP broadcast (TightVNC service discovery)
const discoveredServices = new Map();
const SERVICE_DISCOVERY_PORT = 41234;
const SERVICE_ANNOUNCEMENT_INTERVAL = 30000; // 30 seconds

// UDP Service Discovery Listener
const discoverySocket = dgram.createSocket('udp4');

discoverySocket.on('error', (err) => {
  console.error('[Discovery] UDP socket error:', err.message);
});

discoverySocket.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    
    // Validate service announcement
    if (data.type === 'tightvnc-announce' && data.computerId && data.ip && data.port) {
      const serviceKey = `${data.ip}:${data.port}`;
      const existingService = discoveredServices.get(serviceKey);
      
      // Only log new discoveries
      if (!existingService) {
        console.log(`[Discovery] New TightVNC service: ${data.hostname || data.computerId} at ${data.ip}:${data.port}`);
      }
      
      // Update or add service
      discoveredServices.set(serviceKey, {
        computerId: data.computerId,
        hostname: data.hostname || data.computerId,
        ip: data.ip,
        port: data.port,
        hasAgent: data.hasAgent || false,
        lastSeen: new Date(),
        source: 'broadcast'
      });
      
      // Broadcast to all connected clients via Socket.IO
      io.emit('service_discovered', {
        computerId: data.computerId,
        hostname: data.hostname,
        ip: data.ip,
        port: data.port,
        hasAgent: data.hasAgent,
        source: 'broadcast'
      });
    }
  } catch (err) {
    // Ignore invalid messages
  }
});

discoverySocket.on('listening', () => {
  const address = discoverySocket.address();
  console.log(`[Discovery] UDP service listener on ${address.address}:${address.port}`);
  
  // Enable broadcast
  discoverySocket.setBroadcast(true);
});

// Start listening for service announcements
discoverySocket.bind(SERVICE_DISCOVERY_PORT, () => {
  discoverySocket.setBroadcast(true);
});

// Cleanup old services periodically
setInterval(() => {
  const now = new Date();
  const timeout = 2 * 60 * 1000; // 2 minutes
  
  for (const [key, service] of discoveredServices.entries()) {
    if (now - service.lastSeen > timeout) {
      discoveredServices.delete(key);
      io.emit('service_offline', {
        computerId: service.computerId,
        ip: service.ip
      });
    }
  }
}, 60000); // Run every minute

// API endpoint to get discovered services
app.get('/api/discovery/services', (req, res) => {
  const services = Array.from(discoveredServices.values());
  res.json({
    services,
    count: services.length,
    timestamp: new Date()
  });
});

// Socket.io authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    // Check if this is an agent connection
    if (token === 'agent-token-placeholder' || token.startsWith('agent-')) {
      socket.isAgent = true;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, fullName: true, role: true },
    });

    if (!user) {
      return next(new Error("User not found"));
    }

    socket.user = user;
    next();
  } catch (error) {
    console.error("Socket auth error:", error.message);
    next(new Error("Invalid token"));
  }
});

// Socket.io connection handling
io.on("connection", (socket) => {
  // Handle agent connections differently from user connections
  if (socket.isAgent) {
    // PC Agent: Handle agent registration
    socket.on("agent_register", (computerData) => {
      console.log(`[Agent] Registered: ${computerData.name} (${computerData.ip})`);
      
      // Store computer connection
      connectedComputers.set(computerData.id, {
        socketId: socket.id,
        computer: computerData,
        lastSeen: new Date(),
        status: 'online'
      });
      
      // Join computer-specific room for targeted commands
      socket.join(`computer_${computerData.id}`);
      
      // Broadcast to instructors that a computer is online
      socket.broadcast.emit("computer_online", {
        computerId: computerData.id,
        name: computerData.name,
        ip: computerData.ip,
        user: computerData.user,
        specs: computerData.specs
      });
      
      // Acknowledge registration
      socket.emit("agent_registered", { success: true });
    });

    // PC Agent: Handle status updates
    socket.on("agent_status_update", (statusData) => {
      const computer = connectedComputers.get(statusData.computerId);
      if (computer) {
        computer.lastSeen = new Date();
        computer.status = statusData.status;
        computer.user = statusData.user;
        
        // Broadcast status update to instructors
        socket.broadcast.emit("computer_status_update", {
          computerId: statusData.computerId,
          status: statusData.status,
          user: statusData.user,
          timestamp: new Date()
        });
      }
    });

    // PC Agent: Return command results back to requesting user
    socket.on("command_result", (resultData) => {
      const {
        action,
        success,
        result,
        error,
        from
      } = resultData || {};

      let computerId = null;
      for (const [id, computer] of connectedComputers.entries()) {
        if (computer.socketId === socket.id) {
          computerId = id;
          break;
        }
      }

      if (from) {
        io.to(`user_${from}`).emit("agent_command_result", {
          computerId,
          action,
          success,
          result,
          error,
          timestamp: new Date()
        });
      }
    });

    // Handle agent disconnection
    socket.on("disconnect", () => {
      // Find and remove the computer
      for (const [computerId, computer] of connectedComputers.entries()) {
        if (computer.socketId === socket.id) {
          console.log(`[Agent] Disconnected: ${computer.computer.name}`);
          connectedComputers.delete(computerId);
          
          // Broadcast computer offline status
          socket.broadcast.emit("computer_offline", {
            computerId: computerId,
            name: computer.computer.name,
            lastSeen: new Date()
          });
          break;
        }
      }
    });
    
    return; // Skip user-specific handlers for agents
  }

  // User connection handling (only log in development)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[User] Connected: ${socket.user?.fullName} (${socket.user?.id})`);
  }

  // Store user connection
  connectedUsers.set(socket.user.id, {
    socketId: socket.id,
    user: socket.user,
    lastSeen: new Date(),
  });

  // Join personal room for direct messages
  socket.join(`user_${socket.user.id}`);

  // PC Agent: Handle commands from instructors
  socket.on("agent_command", (command) => {
    const { targetComputerId, action, params } = command;
    
    // Command received (logging only in development)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Command] ${action} for computer ${targetComputerId}`);
    }
    
    // Forward command to the target computer's agent
    io.to(`computer_${targetComputerId}`).emit("execute_command", {
      action,
      params,
      from: socket.user.id,
      timestamp: new Date()
    });
  });

  // Chat app: addUser event
  let activeUsers = [];
  socket.on("addUser", (userId) => {
    const isUserExist = activeUsers.find((user) => user.userId === userId);
    if (!isUserExist) {
      const user = { userId, socketId: socket.id };
      activeUsers.push(user);
      io.emit("getUsers", activeUsers);
    }
  });

  // Chat app: sendMessage event
  socket.on(
    "sendMessage",
    async ({ senderId, receiverId, message, conversationId }) => {
      const receiver = activeUsers.find((user) => user.userId === receiverId);
      const sender = activeUsers.find((user) => user.userId === senderId);
      const senderUser = await prisma.user.findUnique({
        where: { id: parseInt(senderId) },
        select: { id: true, fullName: true, username: true },
      });

      console.log("Message sent from", senderId, "to", receiverId);

      if (receiver) {
        io.to(receiver.socketId)
          .to(sender.socketId)
          .emit("getMessage", {
            senderId,
            message,
            conversationId,
            receiverId,
            user: { id: senderUser.id, fullName: senderUser.fullName },
          });
      } else if (sender) {
        io.to(sender.socketId).emit("getMessage", {
          senderId,
          message,
          conversationId,
          receiverId,
          user: { id: senderUser.id, fullName: senderUser.fullName },
        });
      }

      // Also emit to room for multi-device support
      io.to(`user_${receiverId}`).emit("getMessage", {
        senderId,
        message,
        conversationId,
        receiverId,
        user: { id: senderUser.id, fullName: senderUser.fullName },
      });
    },
  );

  // Join group rooms
  socket.on("join_groups", async () => {
    try {
      const memberships = await prisma.groupMember.findMany({
        where: { userId: socket.user.id },
        select: { groupId: true },
      });

      memberships.forEach((membership) => {
        socket.join(`group_${membership.groupId}`);
      });
      console.log(`User ${socket.user.id} joined ${memberships.length} groups`);
    } catch (error) {
      console.error("Error joining groups:", error);
    }
  });

  // Handle typing indicator
  socket.on("typing", (data) => {
    const { receiverId, groupId, isTyping } = data;

    if (groupId) {
      socket.to(`group_${groupId}`).emit("user_typing", {
        userId: socket.user.id,
        userName: socket.user.fullName,
        groupId,
        isTyping,
      });
    } else if (receiverId) {
      socket.to(`user_${receiverId}`).emit("user_typing", {
        userId: socket.user.id,
        userName: socket.user.fullName,
        isTyping,
      });
    }
  });

  // Handle message status updates
  socket.on("message_status", async (data) => {
    const { messageId, status } = data;

    try {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        select: { senderId: true },
      });

      if (message) {
        await prisma.message.update({
          where: { id: messageId },
          data: { status },
        });

        // Notify sender about status change
        io.to(`user_${message.senderId}`).emit("message_status_update", {
          messageId,
          status,
          updatedBy: socket.user.id,
        });
      }
    } catch (error) {
      console.error("Error updating message status:", error);
    }
  });

  // Handle user status request
  socket.on("get_user_status", (userId, callback) => {
    const user = connectedUsers.get(userId);
    callback({
      online: !!user,
      lastSeen: user?.lastSeen || null,
    });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(
      `User disconnected: ${socket.user.fullName} (${socket.user.id})`,
    );
    connectedUsers.delete(socket.user.id);

    // Remove from active users
    activeUsers = activeUsers.filter((user) => user.socketId !== socket.id);
    io.emit("getUsers", activeUsers);

    // Broadcast offline status to relevant users
    socket.broadcast.emit("user_offline", {
      userId: socket.user.id,
      lastSeen: new Date(),
    });
    
    // Check if this socket was a PC agent and clean up
    for (const [computerId, computer] of connectedComputers.entries()) {
      if (computer.socketId === socket.id) {
        console.log(`PC Agent disconnected: ${computer.computer.name}`);
        connectedComputers.delete(computerId);
        
        // Broadcast computer offline status
        socket.broadcast.emit("computer_offline", {
          computerId: computerId,
          name: computer.computer.name,
          lastSeen: new Date()
        });
        break;
      }
    }
  });
});

// Make io and connectedComputers accessible to routes
app.set("io", io);
app.set("connectedComputers", connectedComputers);

// Middleware
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow all origins for agent connections
      callback(null, true);
    },
    credentials: true,
  }),
);


app.use(express.json());

// Routes
import authRoutes from "./routes/auth.js";
import labsRoutes from "./routes/labs.js";
import usersRoutes from "./routes/users.js";
import computersRoutes from "./routes/computers.js";
import dashboardRoutes from "./routes/dashboard.js";
import messagingRoutes from "./routes/messaging.js";
import ticketsRoutes from "./routes/tickets.js";
import hardwareInventoryRoutes from "./routes/hardware-inventory.js";
import schedulesRoutes from "./routes/schedules.js";
import gradingRoutes from "./routes/grading.js";
import networkRoutes from "./routes/network.js";
import logsRoutes from "./routes/logs.js";
import agentsRoutes from "./routes/agents.js";
import { authenticateToken } from "./middleware/auth.js";
app.use("/api/auth", authRoutes);
app.use("/api/labs", authenticateToken, labsRoutes);
app.use("/api/users", authenticateToken, usersRoutes);
app.use("/api/computers", authenticateToken, computersRoutes);
app.use("/api/dashboard", authenticateToken, dashboardRoutes);
app.use("/api/messaging", authenticateToken, messagingRoutes);
app.use("/api/tickets", authenticateToken, ticketsRoutes);
app.use("/api/hardware-inventory", authenticateToken, hardwareInventoryRoutes);
app.use("/api/schedules", authenticateToken, schedulesRoutes);
app.use("/api/grading", authenticateToken, gradingRoutes);
app.use("/api/network", authenticateToken, networkRoutes);
app.use("/api/logs", authenticateToken, logsRoutes);
app.use("/api/agents", authenticateToken, agentsRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running",
    connectedUsers: connectedUsers.size,
  });
});

// Root health check for easier testing
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running",
    connectedUsers: connectedUsers.size,
  });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Socket.io is ready for real-time messaging`);
  console.log(
    `Client URL: ${process.env.CLIENT_URL || "http://localhost:5173"}`,
  );
});

export default app;
