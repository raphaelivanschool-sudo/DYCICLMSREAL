import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';
import { recordActivity, clientIp } from '../utils/activityLog.js';

const prisma = new PrismaClient();
const router = express.Router();

// POST /api/auth/login - Login user
router.post('/login', async (req, res) => {
  console.log('=== LOGIN ATTEMPT ===');
  console.log('Request body:', req.body);
  console.log('Request headers:', req.headers);
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    // Find user by username
    const user = await prisma.user.findUnique({
      where: { username }
    });

    console.log('DEBUG - User found:', user ? 'YES' : 'NO');
    if (user) {
      console.log('DEBUG - User ID:', user.id);
      console.log('DEBUG - User role:', user.role);
      console.log('DEBUG - Stored password hash:', user.password.substring(0, 20) + '...');
    }

    if (!user) {
      console.log('DEBUG - User not found, returning 401');
      await recordActivity(prisma, {
        action: 'LOGIN_FAILED',
        description: `Failed login for "${username}" (no such user)`,
        ipAddress: clientIp(req),
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Compare password
    console.log('DEBUG - Attempting password comparison...');
    console.log('DEBUG - Input password length:', password.length);
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log('DEBUG - Password valid:', isPasswordValid);

    if (!isPasswordValid) {
      console.log('DEBUG - Password invalid, returning 401');
      await recordActivity(prisma, {
        action: 'LOGIN_FAILED',
        description: `Failed login for "${username}" (invalid password)`,
        userId: user.id,
        ipAddress: clientIp(req),
      });
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Log the login to SystemLog
    console.log('Attempting to log login for user:', user.username, 'ID:', user.id);
    try {
      await prisma.systemLog.create({
        data: {
          action: 'LOGIN',
          description: `User ${user.username} logged in`,
          userId: user.id,
          ipAddress: req.ip || req.connection.remoteAddress
        }
      });
      console.log('Successfully logged login to SystemLog');
    } catch (logError) {
      console.error('Error logging to SystemLog:', logError);
    }

    // Return success response
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.fullName
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// GET /api/auth/me - Get current user (protected)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        role: true,
        fullName: true,
        email: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/auth/logout - Logout user (protected)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Log the logout to SystemLog
    await prisma.systemLog.create({
      data: {
        action: 'LOGOUT',
        description: `User ${req.user.username} logged out`,
        userId: req.user.id,
        ipAddress: req.ip || req.connection.remoteAddress
      }
    });

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
