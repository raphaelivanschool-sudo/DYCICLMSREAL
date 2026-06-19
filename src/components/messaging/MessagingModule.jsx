import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { X, Search, Send, MessageCircle, Users, Plus } from 'lucide-react';
import messagingService from '../../services/messagingService';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

const MessagingModule = ({ isOpen, onClose, userRole }) => {
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [availableUsers, setAvailableUsers] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [typingUsers, setTypingUsers] = useState({});
  const [onlineUsers, setOnlineUsers] = useState({});
  
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const socketRef = useRef(null);

  // Initialize socket and load data
  useEffect(() => {
    if (!isOpen) return;

    const user = JSON.parse(localStorage.getItem('user'));
    setCurrentUser(user);

    // Connect socket
    const token = localStorage.getItem('token');
    if (token) {
      socketRef.current = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling']
      });

      socketRef.current.on('connect', () => {
        console.log('Socket connected:', socketRef.current.id);
        setSocketConnected(true);
        socketRef.current.emit('addUser', user?.id);
      });

      socketRef.current.on('disconnect', () => {
        setSocketConnected(false);
      });

      socketRef.current.on('getMessage', (data) => {
        console.log('New message received:', data);
        handleNewMessage(data);
      });

      socketRef.current.on('getUsers', (users) => {
        console.log('Active users:', users);
      });

      socketRef.current.on('user_typing', (data) => {
        handleTypingIndicator(data);
      });
    }

    loadConversations();
    loadAvailableUsers();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [isOpen]);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewMessage = useCallback((data) => {
    const { senderId, receiverId, message, conversationId, user: senderInfo } = data;

    // Check if message belongs to current chat
    const isCurrentChat = selectedChat && (
      (selectedChat.userId === senderId) ||
      (selectedChat.id === senderId) ||
      (selectedChat.conversationId === conversationId)
    );

    if (isCurrentChat) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId,
        senderName: senderInfo?.fullName || 'Unknown',
        message,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: senderId === currentUser?.id
      }]);
    }

    // Refresh conversations to show new message
    loadConversations();
  }, [selectedChat, currentUser]);

  const handleTypingIndicator = useCallback((data) => {
    const { userId, isTyping } = data;
    setTypingUsers(prev => ({
      ...prev,
      [userId]: isTyping
    }));

    if (isTyping) {
      setTimeout(() => {
        setTypingUsers(prev => ({ ...prev, [userId]: false }));
      }, 3000);
    }
  }, []);

 const loadConversations = async () => {
    try {
      setLoading(true);
      const data = await messagingService.getConversations();
      setConversations(data);
    } catch (error) {
      console.error('Error loading conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (chat) => {
    try {
      setLoading(true);
      let data;
      if (chat.isGroup) {
        data = await messagingService.getGroupMessages(chat.groupId);
      } else {
        data = await messagingService.getMessages(chat.userId || chat.id);
      }
      setMessages(data);
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableUsers = async () => {
    try {
      const users = await messagingService.getUsers();
      setAvailableUsers(users);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedChat || !currentUser) return;

    const content = messageInput.trim();
    setMessageInput('');

    const receiverId = selectedChat.userId || selectedChat.id;
    const conversationId = selectedChat.conversationId;

    try {
      // Send via socket for real-time
      if (socketRef.current) {
        socketRef.current.emit('sendMessage', {
          senderId: currentUser.id,
          receiverId,
          message: content,
          conversationId
        });
      }

      // Send via API for persistence
      await messagingService.sendMessage(receiverId, content);

      // Add to local messages
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId: currentUser.id,
        senderName: currentUser.fullName || currentUser.username,
        message: content,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: true
      }]);

      // Clear typing indicator
      handleTyping(false);
      loadConversations();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleTyping = (isTyping) => {
    if (!selectedChat || !socketRef.current || !currentUser) return;
    
    const receiverId = selectedChat.userId || selectedChat.id;
    socketRef.current.emit('typing', {
      senderId: currentUser.id,
      receiverId,
      isTyping
    });
  };

  const handleInputChange = (e) => {
    setMessageInput(e.target.value);
    handleTyping(true);
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    typingTimeoutRef.current = setTimeout(() => {
      handleTyping(false);
    }, 2000);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSelectChat = (chat) => {
    setSelectedChat(chat);
    loadMessages(chat);
  };

  const startNewChat = (user) => {
    const newChat = {
      id: user.id,
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      avatar: user.avatar,
      lastMessage: '',
      time: 'Just now',
      unread: 0,
      online: false
    };
    
    setConversations(prev => [newChat, ...prev]);
    setSelectedChat(newChat);
    setShowNewChat(false);
    setMessages([]);
  };

  const getRoleColor = (role) => {
    switch (role) {
      case 'INSTRUCTOR': return 'bg-green-100 text-green-700';
      case 'ADMIN': return 'bg-blue-100 text-blue-700';
      case 'STUDENT': return 'bg-yellow-100 text-yellow-700';
      case 'Group': return 'bg-purple-100 text-purple-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const isUserOnline = (userId) => {
    return onlineUsers[userId]?.online || false;
  };

  const isUserTyping = (userId) => {
    return typingUsers[userId] || false;
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="bg-white rounded-xl w-full max-w-6xl h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center">
            <MessageCircle className="w-6 h-6 text-blue-600 mr-3" />
            <h2 className="text-xl font-semibold text-gray-900">Messages</h2>
            <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
              {conversations.reduce((sum, c) => sum + (c.unread || 0), 0)} unread
            </span>
            <div className={`ml-3 w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            {!socketConnected && (
              <button 
                onClick={() => window.location.reload()}
                className="ml-2 px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded hover:bg-yellow-200"
              >
                Reconnect
              </button>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowNewChat(true)}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="New Chat"
            >
              <Plus className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar - Conversations */}
          <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
            {/* User Profile */}
            <div className="flex items-center p-4 border-b border-gray-100">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-medium">
                {currentUser?.fullName?.charAt(0) || currentUser?.username?.charAt(0) || 'U'}
              </div>
              <div className="ml-3">
                <h3 className="text-lg font-semibold">{currentUser?.fullName || currentUser?.username}</h3>
                <p className="text-sm text-gray-500 capitalize">{currentUser?.role?.toLowerCase()}</p>
              </div>
            </div>

            {/* Search */}
            <div className="p-3 border-b border-gray-100">
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search conversations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* New Chat Panel */}
            {showNewChat && (
              <div className="absolute top-20 left-4 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-96 overflow-y-auto">
                <div className="p-3 border-b border-gray-200 flex items-center justify-between">
                  <span className="font-medium text-sm">Start New Chat</span>
                  <button onClick={() => setShowNewChat(false)}>
                    <X className="w-4 h-4 text-gray-500" />
                  </button>
                </div>
                {availableUsers.map(user => (
                  <button
                    key={user.id}
                    onClick={() => startNewChat(user)}
                    className="w-full p-3 flex items-center hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-medium text-sm">
                      {user.avatar}
                    </div>
                    <div className="ml-3">
                      <p className="font-medium text-sm text-gray-900">{user.name}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${getRoleColor(user.role)}`}>
                        {user.role}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Connection Status */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-500">Real-time {socketConnected ? 'connected' : 'disconnected'}</span>
              <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            </div>

            {/* Conversations List */}
            <div className="flex-1 overflow-y-auto">
              {conversations.filter(conv => 
                conv.name?.toLowerCase().includes(searchQuery.toLowerCase())
              ).map((conversation) => (
                <div
                  key={conversation.id}
                  onClick={() => handleSelectChat(conversation)}
                  className={`p-3 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedChat?.id === conversation.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                  }`}
                >
                  <div className="flex items-center">
                    <div className="relative">
                      <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-medium">
                        {conversation.isGroup ? <Users className="w-5 h-5" /> : conversation.avatar}
                      </div>
                      {isUserOnline(conversation.userId || conversation.id) && (
                        <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                      )}
                    </div>
                    <div className="ml-3 flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-gray-900 text-sm truncate">{conversation.name}</p>
                        <span className="text-xs text-gray-400">
                          {conversation.time && typeof conversation.time === 'string' 
                            ? conversation.time 
                            : new Date(conversation.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">
                        {isUserTyping(conversation.userId || conversation.id) 
                          ? <span className="text-blue-500 italic">typing...</span>
                          : conversation.lastMessage || 'Start a conversation'}
                      </p>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${getRoleColor(conversation.role)}`}>
                        {conversation.role}
                      </span>
                    </div>
                    {conversation.unread > 0 && (
                      <span className="ml-2 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                        {conversation.unread}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Main Chat Area */}
          <div className="flex-1 flex flex-col bg-gray-50">
            {selectedChat ? (
              <>
                {/* Chat Header */}
                <div className="p-4 bg-white border-b border-gray-200 flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="relative">
                      <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-medium">
                        {selectedChat.isGroup ? <Users className="w-5 h-5" /> : selectedChat.avatar}
                      </div>
                      {isUserOnline(selectedChat.userId || selectedChat.id) && (
                        <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white"></div>
                      )}
                    </div>
                    <div className="ml-3">
                      <p className="font-medium text-gray-900">{selectedChat.name}</p>
                      <p className="text-xs text-gray-500">
                        {isUserTyping(selectedChat.userId || selectedChat.id) 
                          ? 'typing...' 
                          : isUserOnline(selectedChat.userId || selectedChat.id) 
                            ? 'Active now' 
                            : 'Offline'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {loading && messages.length === 0 && (
                    <div className="flex justify-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                    </div>
                  )}
                  
                  {messages.map((msg, index) => {
                    const showAvatar = !msg.isMe && (!messages[index - 1] || messages[index - 1].senderId !== msg.senderId);
                    
                    return (
                      <div
                        key={msg.id || index}
                        className={`flex ${msg.isMe ? 'justify-end' : 'justify-start'}`}
                      >
                        {!msg.isMe && showAvatar && (
                          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-xs font-medium mr-2 flex-shrink-0">
                            {msg.senderName?.charAt(0)}
                          </div>
                        )}
                        {!msg.isMe && !showAvatar && <div className="w-8 mr-2 flex-shrink-0" />}
                        
                        <div className={`max-w-xs lg:max-w-md ${msg.isMe ? 'order-2' : 'order-1'}`}>
                          {!msg.isMe && showAvatar && (
                            <p className="text-xs text-gray-500 mb-1 ml-1">{msg.senderName}</p>
                          )}
                          <div
                            className={`px-4 py-2 rounded-2xl ${
                              msg.isMe
                                ? 'bg-blue-600 text-white rounded-br-none'
                                : 'bg-white text-gray-900 rounded-bl-none shadow-sm'
                            }`}
                          >
                            <p className="text-sm">{msg.message}</p>
                          </div>
                          <p className={`text-xs text-gray-400 mt-1 ${msg.isMe ? 'text-right' : 'text-left'}`}>
                            {msg.time}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Message Input */}
                <div className="p-4 bg-white border-t border-gray-200">
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={messageInput}
                      onChange={handleInputChange}
                      onKeyPress={handleKeyPress}
                      placeholder="Type a message..."
                      className="flex-1 px-4 py-2.5 bg-gray-100 border-0 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={handleSendMessage}
                      disabled={!messageInput.trim()}
                      className="p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <MessageCircle className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">Select a conversation</h3>
                  <p className="text-gray-500 mb-4">Choose a conversation from the list to start messaging</p>
                  <button
                    onClick={() => setShowNewChat(true)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    <Plus className="w-4 h-4 inline mr-2" />
                    Start New Chat
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Sidebar - Online Users */}
          <div className="w-64 border-l border-gray-200 bg-white hidden lg:block">
            <div className="p-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">People</h3>
            </div>
            <div className="p-2">
              {availableUsers.map(user => (
                <div key={user.id} className="flex items-center p-2 hover:bg-gray-50 rounded-lg cursor-pointer">
                  <div className="relative">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-medium text-sm">
                      {user.avatar}
                    </div>
                    {isUserOnline(user.id) && (
                      <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-white"></div>
                    )}
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-900">{user.name}</p>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${getRoleColor(user.role)}`}>
                      {user.role}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessagingModule;
