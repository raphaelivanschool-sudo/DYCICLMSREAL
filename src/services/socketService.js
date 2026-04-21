import { io } from 'socket.io-client';

const getToken = () => localStorage.getItem('token');

class SocketService {
  constructor() {
    this.socket = null;
    this.callbacks = {};
    this.isConnected = false;
  }

    connect() {
    if (this.socket?.connected) {
      console.log('Socket already connected');
      return;
    }

    const token = getToken();
    console.log('Attempting socket connection, token exists:', !!token);
    
    if (!token) {
      console.error('No authentication token available - cannot connect socket');
      console.log('localStorage contents:', Object.keys(localStorage));
      return;
    }

    const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
    console.log('Connecting to socket at:', SOCKET_URL);

    try {
      console.log('Creating socket.io instance...');
      this.socket = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });
      console.log('Socket instance created, setting up listeners...');

      this.socket.on('connect', () => {
        console.log('Socket connected successfully! ID:', this.socket.id);
        this.isConnected = true;
        this.emit('connection_status', { connected: true });
        
        // Join group rooms
        this.socket.emit('join_groups');
      });

      this.socket.on('disconnect', (reason) => {
        console.log('Socket disconnected. Reason:', reason);
        this.isConnected = false;
        this.emit('connection_status', { connected: false, reason });
      });

      this.socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error.message);
        this.emit('connection_error', error);
        this.emit('connection_status', { connected: false, error: error.message });
      });

      this.socket.on('error', (error) => {
        console.error('Socket error:', error);
      });

      // Listen for new messages
      this.socket.on('new_message', (data) => {
        console.log('Socket received new_message:', data);
        this.emit('new_message', data);
      });

      // Listen for sent message confirmation
      this.socket.on('message_sent', (data) => {
        console.log('Socket received message_sent:', data);
        this.emit('message_sent', data);
      });

      // Listen for typing indicators
      this.socket.on('user_typing', (data) => {
        this.emit('user_typing', data);
      });

      // Listen for message status updates
      this.socket.on('message_status_update', (data) => {
        this.emit('message_status_update', data);
      });

      // Listen for user online/offline status
      this.socket.on('user_offline', (data) => {
        this.emit('user_offline', data);
      });

      // Listen for group creation
      this.socket.on('group_created', (data) => {
        this.emit('group_created', data);
      });

      // Listen for PC service discovery (TightVNC broadcast)
      this.socket.on('service_discovered', (data) => {
        this.emit('service_discovered', data);
      });

      // Listen for PC service going offline
      this.socket.on('service_offline', (data) => {
        this.emit('service_offline', data);
      });

      // Listen for computer online/offline via agent
      this.socket.on('computer_online', (data) => {
        this.emit('computer_online', data);
      });

      this.socket.on('computer_offline', (data) => {
        this.emit('computer_offline', data);
      });

      // Listen for command results from PC agents
      this.socket.on('agent_command_result', (data) => {
        this.emit('agent_command_result', data);
      });
      
      console.log('Socket listeners registered');
    } catch (error) {
      console.error('Error creating socket:', error);
      console.error('Error stack:', error.stack);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }

  // Subscribe to events
  on(event, callback) {
    if (!this.callbacks[event]) {
      this.callbacks[event] = [];
    }
    this.callbacks[event].push(callback);

    // Return unsubscribe function
    return () => {
      this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback);
    };
  }

  // Emit events to subscribers
  emit(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in ${event} callback:`, error);
        }
      });
    }
  }

  // Send typing indicator
  sendTyping(receiverId, isTyping) {
    if (this.socket?.connected) {
      this.socket.emit('typing', { receiverId, isTyping });
    }
  }

  // Send group typing indicator
  sendGroupTyping(groupId, isTyping) {
    if (this.socket?.connected) {
      this.socket.emit('typing', { groupId, isTyping });
    }
  }

  // Update message status
  updateMessageStatus(messageId, status) {
    if (this.socket?.connected) {
      this.socket.emit('message_status', { messageId, status });
    }
  }

  // Get user online status
  getUserStatus(userId, callback) {
    if (this.socket?.connected) {
      this.socket.emit('get_user_status', userId, callback);
    }
  }

  // Check if socket is connected
  connected() {
    return this.isConnected && this.socket?.connected;
  }
}

// Create singleton instance
const socketService = new SocketService();

export default socketService;
