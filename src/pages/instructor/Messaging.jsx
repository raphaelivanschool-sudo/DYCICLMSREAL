import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Send, Search, MessageCircle, Megaphone, X, Plus } from 'lucide-react';
import messagingService from '../../services/messagingService';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

function Messaging() {
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [students, setStudents] = useState([]);
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
        console.log('Instructor socket connected:', socketRef.current.id);
        setSocketConnected(true);
        socketRef.current.emit('addUser', user?.id);
      });

      socketRef.current.on('disconnect', () => {
        setSocketConnected(false);
      });

      socketRef.current.on('getMessage', (data) => {
        console.log('Instructor received message:', data);
        handleNewMessage(data);
      });

      socketRef.current.on('getUsers', (users) => {
        console.log('Active users:', users);
      });

      socketRef.current.on('user_typing', (data) => {
        handleTypingIndicator(data);
      });
    }

    loadStudents();

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

    // Check if message is from the selected student
    const isFromSelectedStudent = selectedStudent && selectedStudent.id === senderId;

    if (isFromSelectedStudent) {
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId,
        senderName: senderInfo?.fullName || 'Student',
        message,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: false,
        sentBy: 'student'
      }]);
    }

    // Refresh student list to show new message
    loadStudents();
  }, [selectedStudent]);

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

  const loadStudents = async () => {
    try {
      setLoading(true);
      const users = await messagingService.getUsers();
      // Filter only students
      const studentUsers = users.filter(u => u.role === 'STUDENT');
      setStudents(studentUsers);
    } catch (error) {
      console.error('Error loading students:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (student) => {
    try {
      setLoading(true);
      const data = await messagingService.getMessages(student.id);
      // Transform messages to match the UI format
      const formattedMessages = data.map(msg => ({
        id: msg.id,
        senderId: msg.senderId,
        senderName: msg.senderName,
        message: msg.message,
        time: msg.time,
        isMe: msg.senderId === currentUser?.id,
        sentBy: msg.senderId === currentUser?.id ? 'instructor' : 'student'
      }));
      setMessages(formattedMessages);
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectStudent = (student) => {
    setSelectedStudent(student);
    loadMessages(student);
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedStudent || !currentUser) return;

    const content = messageInput.trim();
    setMessageInput('');

    try {
      // Send via socket for real-time
      if (socketRef.current) {
        socketRef.current.emit('sendMessage', {
          senderId: currentUser.id,
          receiverId: selectedStudent.id,
          message: content,
          conversationId: null
        });
      }

      // Send via API for persistence
      await messagingService.sendMessage(selectedStudent.id, content);

      // Add to local messages
      setMessages(prev => [...prev, {
        id: Date.now(),
        senderId: currentUser.id,
        senderName: currentUser.fullName || currentUser.username,
        message: content,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isMe: true,
        sentBy: 'instructor'
      }]);

      // Clear typing indicator
      handleTyping(false);
      loadStudents();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  const handleTyping = (isTyping) => {
    if (!selectedStudent || !socketRef.current || !currentUser) return;
    
    socketRef.current.emit('typing', {
      senderId: currentUser.id,
      receiverId: selectedStudent.id,
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

  const filteredStudents = students.filter(student =>
    student.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleBroadcast = async () => {
    if (!broadcastMessage.trim()) return;
    const msg = broadcastMessage.trim();
    setBroadcastMessage('');
    setShowBroadcastModal(false);
    let sent = 0;
    for (const student of students) {
      try {
        await messagingService.sendMessage(student.id, msg);
        sent++;
      } catch {
        // skip unreachable
      }
    }
    console.log(`[Messaging] Broadcast sent to ${sent}/${students.length} student(s)`);
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Page Header */}
      <div className="p-6 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Messaging</h1>
            <p className="text-gray-500">Communicate with students in real-time</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm text-gray-500">
                {socketConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <button
              onClick={() => setShowBroadcastModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              <Megaphone className="w-4 h-4" />
              Broadcast Message
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Student List */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
          {/* Search */}
          <div className="p-4 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search students..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>

          {/* Connection Status */}
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs text-gray-500">Real-time {socketConnected ? 'connected' : 'disconnected'}</span>
            <div className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          </div>

          {/* Student List */}
          <div className="flex-1 overflow-y-auto">
            {loading && students.length === 0 && (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              </div>
            )}
            
            {filteredStudents.map((student) => {
              const studentMessages = messages.filter(m => m.senderId === student.id || (m.isMe && selectedStudent?.id === student.id));
              const lastMessage = studentMessages[studentMessages.length - 1];
              const unreadCount = studentMessages.filter(m => !m.isMe && m.sentBy === 'student').length;

              return (
                <div
                  key={student.id}
                  onClick={() => handleSelectStudent(student)}
                  className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedStudent?.id === student.id ? 'bg-blue-50 border-l-4 border-blue-500' : 'border-l-4 border-transparent'
                  }`}
                >
                  {/* Avatar with Status */}
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium">
                      {student.name?.charAt(0)}
                    </div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${getStatusDotColor(student.id)}`}></span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium truncate text-gray-900">
                        {student.name}
                      </p>
                      {unreadCount > 0 && (
                        <span className="ml-2 px-1.5 py-0.5 bg-blue-500 text-white text-xs rounded-full min-w-[18px] text-center">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">Student</p>
                    {isUserTyping(student.id) ? (
                      <p className="text-xs text-blue-500 italic">typing...</p>
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
          {selectedStudent ? (
            <>
              {/* Chat Header */}
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium">
                      {selectedStudent.name?.charAt(0)}
                    </div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${getStatusDotColor(selectedStudent.id)}`}></span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{selectedStudent.name}</p>
                    <p className="text-xs text-gray-500">
                      {isUserTyping(selectedStudent.id) 
                        ? 'typing...' 
                        : onlineUsers[selectedStudent.id]?.online 
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
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                  </div>
                )}
                
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <MessageCircle className="w-12 h-12 mb-2" />
                    <p>No messages yet</p>
                    <p className="text-sm">Start a conversation with {selectedStudent.name}</p>
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
                            ? 'bg-blue-500 text-white rounded-br-none'
                            : 'bg-gray-100 text-gray-800 rounded-bl-none'
                        }`}
                      >
                        <p className="text-sm">{message.message}</p>
                        <p className={`text-xs mt-1 ${message.isMe ? 'text-blue-200' : 'text-gray-400'}`}>
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
                  <input
                    type="text"
                    placeholder={`Message ${selectedStudent.name}...`}
                    value={messageInput}
                    onChange={handleInputChange}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    className="flex-1 px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={!messageInput.trim()}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
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
                <h3 className="text-lg font-medium text-gray-900 mb-2">Select a student</h3>
                <p className="text-gray-500">Choose a student from the list to start messaging</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Broadcast Modal */}
      {showBroadcastModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Broadcast Message</h3>
              <button
                onClick={() => setShowBroadcastModal(false)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-gray-500 mb-3">This message will be sent to all students</p>
              <textarea
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                placeholder="Type your broadcast message..."
                className="w-full h-32 p-3 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowBroadcastModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBroadcast}
                  disabled={!broadcastMessage.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
                >
                  <Megaphone className="w-4 h-4" />
                  Broadcast
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Messaging;
