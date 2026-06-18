import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Send, Search, MessageCircle, Smile, Paperclip } from 'lucide-react';
import messagingService from '../../services/messagingService';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

function Messaging() {
  const [selectedContact, setSelectedContact] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [socketConnected, setSocketConnected] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [typingUsers, setTypingUsers] = useState({});
  const [onlineUsers, setOnlineUsers] = useState({});
  const [loading, setLoading] = useState(false);
  
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const socketRef = useRef(null);

  // Initialize socket and load data
  useEffect(() => {
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
        console.log('Student socket connected:', socketRef.current.id);
        setSocketConnected(true);
        socketRef.current.emit('addUser', user?.id);
      });

      socketRef.current.on('disconnect', () => {
        setSocketConnected(false);
      });

      socketRef.current.on('getMessage', (data) => {
        console.log('Student received message:', data);
        handleNewMessage(data);
      });

      socketRef.current.on('getUsers', (users) => {
        console.log('Active users:', users);
      });

      socketRef.current.on('user_typing', (data) => {
        handleTypingIndicator(data);
      });
    }

    loadContacts();

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewMessage = useCallback((data) => {
    const { senderId, message, user: senderInfo } = data;

    // Check if message is from the selected contact
    const isFromSelectedContact = selectedContact && selectedContact.id === senderId;

    if (isFromSelectedContact) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId,
        senderName: senderInfo?.fullName || 'Contact',
        message,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: false,
        sentBy: 'contact'
      }]);
    }

    // Refresh contact list to show new message
    loadContacts();
  }, [selectedContact]);

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

  const loadContacts = async () => {
    try {
      setLoading(true);
      const users = await messagingService.getUsers();
      // Filter only instructors and other students (exclude self)
      const filteredContacts = users.filter(u => 
        u.id !== currentUser?.id && (u.role === 'INSTRUCTOR' || u.role === 'STUDENT')
      );
      setContacts(filteredContacts);
    } catch (error) {
      console.error('Error loading contacts:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (contact) => {
    try {
      setLoading(true);
      const data = await messagingService.getMessages(contact.id);
      // Transform messages to match the UI format
      const formattedMessages = data.map(msg => ({
        id: msg.id,
        senderId: msg.senderId,
        senderName: msg.senderName,
        message: msg.message,
        time: msg.time,
        isMe: msg.senderId === currentUser?.id,
        sentBy: msg.senderId === currentUser?.id ? 'student' : 'contact'
      }));
      setMessages(formattedMessages);
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectContact = (contact) => {
    setSelectedContact(contact);
    loadMessages(contact);
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedContact || !currentUser) return;

    const content = messageInput.trim();
    setMessageInput('');

    try {
      // Send via socket for real-time
      if (socketRef.current) {
        socketRef.current.emit('sendMessage', {
          senderId: currentUser.id,
          receiverId: selectedContact.id,
          message: content,
          conversationId: null
        });
      }

      // Send via API for persistence
      await messagingService.sendMessage(selectedContact.id, content);

      // Add to local messages
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId: currentUser.id,
        senderName: currentUser.fullName || currentUser.username,
        message: content,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: true,
        sentBy: 'student'
      }]);

      // Clear typing indicator
      handleTyping(false);
      loadContacts();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleTyping = (isTyping) => {
    if (!selectedContact || !socketRef.current || !currentUser) return;
    
    socketRef.current.emit('typing', {
      senderId: currentUser.id,
      receiverId: selectedContact.id,
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const getStatusDotColor = (userId) => {
    const isOnline = onlineUsers[userId]?.online;
    return isOnline ? 'bg-green-500' : 'bg-gray-400';
  };

  const isUserTyping = (userId) => {
    return typingUsers[userId] || false;
  };

  const filteredContacts = contacts.filter(contact =>
    contact.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getRoleColor = (role) => {
    switch (role) {
      case 'INSTRUCTOR': return 'bg-green-100 text-green-700';
      case 'STUDENT': return 'bg-blue-100 text-blue-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Page Header */}
      <div className="p-6 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Messaging</h1>
            <p className="text-gray-500">Communicate with instructors and classmates in real-time</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm text-gray-500">
                {socketConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Contact List */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
          {/* Search */}
          <div className="p-4 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search contacts..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
          </div>

          {/* Connection Status */}
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs text-gray-500">Real-time {socketConnected ? 'connected' : 'disconnected'}</span>
            <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          </div>

          {/* Contact List */}
          <div className="flex-1 overflow-y-auto">
            {loading && contacts.length === 0 && (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
              </div>
            )}
            
            {filteredContacts.map((contact) => {
              const contactMessages = messages.filter(m => m.senderId === contact.id || (m.isMe && selectedContact?.id === contact.id));
              const lastMessage = contactMessages[contactMessages.length - 1];
              const unreadCount = contactMessages.filter(m => !m.isMe && m.sentBy === 'contact').length;

              return (
                <div
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedContact?.id === contact.id ? 'bg-orange-50 border-l-4 border-orange-500' : 'border-l-4 border-transparent'
                  }`}
                >
                  {/* Avatar with Status */}
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white font-medium">
                      {contact.name?.charAt(0)}
                    </div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${getStatusDotColor(contact.id)}`}></span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium truncate text-gray-900">
                        {contact.name}
                      </p>
                      {unreadCount > 0 && (
                        <span className="ml-2 px-1.5 py-0.5 bg-orange-500 text-white text-xs rounded-full min-w-[18px] text-center">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${getRoleColor(contact.role)}`}>
                      {contact.role}
                    </span>
                    {isUserTyping(contact.id) ? (
                      <p className="text-xs text-orange-500 italic">typing...</p>
                    ) : lastMessage && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{lastMessage.message}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Panel - Chat Window */}
        <div className="flex-1 flex flex-col bg-white">
          {selectedContact ? (
            <>
              {/* Chat Header */}
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white font-medium">
                      {selectedContact.name?.charAt(0)}
                    </div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${getStatusDotColor(selectedContact.id)}`}></span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{selectedContact.name}</p>
                    <p className="text-xs text-gray-500">
                      {isUserTyping(selectedContact.id) 
                        ? 'typing...' 
                        : onlineUsers[selectedContact.id]?.online 
                          ? 'Online' 
                          : 'Offline'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loading && messages.length === 0 && (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
                  </div>
                )}
                
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <MessageCircle className="w-12 h-12 mb-2" />
                    <p>No messages yet</p>
                    <p className="text-sm">Start a conversation with {selectedContact.name}</p>
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.isMe ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                          message.isMe
                            ? 'bg-orange-500 text-white rounded-br-none'
                            : 'bg-gray-100 text-gray-800 rounded-bl-none'
                        }`}
                      >
                        <p className="text-sm">{message.message}</p>
                        <p className={`text-xs mt-1 ${message.isMe ? 'text-orange-200' : 'text-gray-400'}`}>
                          {message.time}
                        </p>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-4 border-t border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                  <button className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                    <Paperclip className="w-5 h-5 text-gray-500" />
                  </button>
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      placeholder={`Message ${selectedContact.name}...`}
                      value={messageInput}
                      onChange={handleInputChange}
                      onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                      className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                    <button className="absolute right-3 top-2 p-1 hover:bg-gray-200 rounded-full transition-colors">
                      <Smile className="w-4 h-4 text-gray-500" />
                    </button>
                  </div>
                  <button
                    onClick={handleSendMessage}
                    disabled={!messageInput.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    <Send className="w-4 h-4" />
                    Send
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <MessageCircle className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">Select a contact</h3>
                <p className="text-gray-500">Choose a contact from the list to start messaging</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Messaging;
