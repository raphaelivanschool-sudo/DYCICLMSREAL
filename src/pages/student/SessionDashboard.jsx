import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  User, 
  Monitor, 
  MapPin, 
  Clock, 
  UserCircle,
  Megaphone,
  Ticket,
  CheckCircle,
  HelpCircle,
  FileText,
  ChevronRight,
  MessageCircle
} from 'lucide-react';
import sessionContextService from '../../services/sessionContextService';

function SessionDashboard() {
  const navigate = useNavigate();
  // Get actual user data from localStorage
  const [currentUser, setCurrentUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });

  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState('');
  
  const [sessionStartTime] = useState(() => {
    // Store session start time when component mounts
    const stored = sessionStorage.getItem('sessionStartTime');
    if (stored) return new Date(stored);
    const now = new Date();
    sessionStorage.setItem('sessionStartTime', now.toISOString());
    return now;
  });
  
  const [elapsedTime, setElapsedTime] = useState('00:00:00');
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }));
  const [currentDate, setCurrentDate] = useState(new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));

  // Timer - update elapsed time every second
  useEffect(() => {
    const formatElapsedTime = (startTime) => {
      const now = new Date();
      const diff = now - startTime;
      
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };
    
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }));
      setCurrentDate(new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
      setElapsedTime(formatElapsedTime(sessionStartTime));
    }, 1000); // Update every second
    
    // Initial calculation
    setElapsedTime(formatElapsedTime(sessionStartTime));
    
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setCtxError('');
        const data = await sessionContextService.getStudentContext();
        if (!cancelled) setCtx(data);
      } catch (e) {
        if (!cancelled) setCtxError(e?.message || 'Failed to load session info');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const announcements = [];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Session Dashboard</h1>
        <p className="text-gray-500">View your current lab session and assigned seat information</p>
      </div>

      {/* Welcome Banner */}
      <div className="bg-blue-50 rounded-xl p-6 mb-6 flex items-center justify-between">
        <div className="flex items-center">
          <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center mr-4">
            <User className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="text-lg font-semibold text-gray-900">Welcome, {currentUser?.fullName || currentUser?.username || 'Student'}!</p>
            <p className="text-sm text-gray-500">Your session started at {sessionStartTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} on {currentDate}</p>
          </div>
        </div>
        <div className="flex items-center">
          <span className="w-2 h-2 bg-green-500 rounded-full mr-2"></span>
          <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">Active</span>
        </div>
      </div>

      {/* Info Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* Laboratory Card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Laboratory</span>
            <Monitor className="w-5 h-5 text-blue-500" />
          </div>
          <p className="font-semibold text-gray-900">{ctx?.laboratory?.name || 'No active session'}</p>
          <p className="text-xs text-gray-400">Current location</p>
        </div>

        {/* Assigned Seat Card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Assigned Seat</span>
            <MapPin className="w-5 h-5 text-green-500" />
          </div>
          <p className="font-semibold text-gray-900">
            {ctx?.assignment?.computer?.seatNumber != null ? `Seat ${ctx.assignment.computer.seatNumber}` : 'Seat —'}
          </p>
          <p className="text-xs text-gray-400">{ctx?.assignment?.computer?.name || '—'}</p>
        </div>

        {/* Session Duration Card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Session Duration</span>
            <Clock className="w-5 h-5 text-purple-500" />
          </div>
          <p className="font-semibold text-gray-900">{elapsedTime}</p>
          <p className="text-xs text-gray-400">Elapsed time</p>
        </div>

        {/* Instructor Card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-500">Instructor</span>
            <UserCircle className="w-5 h-5 text-orange-500" />
          </div>
          <p className="font-semibold text-gray-900">{ctx?.instructor?.fullName || '—'}</p>
          <p className="text-xs text-gray-400">Course facilitator</p>
        </div>
      </div>

      {!!ctxError && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {ctxError}
        </div>
      )}

      {/* Quick Actions */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {/* Announcements */}
          <div onClick={() => navigate('/student/messaging')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Megaphone className="w-6 h-6 text-blue-600" />
            </div>
            <p className="font-medium text-gray-900">Announcements</p>
            <p className="text-xs text-gray-400">View messages</p>
          </div>

          {/* Chats */}
          <div onClick={() => navigate('/student/messaging')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow relative">
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <MessageCircle className="w-6 h-6 text-purple-600" />
            </div>
            <p className="font-medium text-gray-900">Chats</p>
            <p className="text-xs text-gray-400">Open messages</p>
          </div>

          {/* Submit Ticket */}
          <div onClick={() => navigate('/student/tickets')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Ticket className="w-6 h-6 text-orange-600" />
            </div>
            <p className="font-medium text-gray-900">Submit Ticket</p>
            <p className="text-xs text-gray-400">Report issues</p>
          </div>

          {/* Help Request */}
          <div onClick={() => navigate('/student/tickets')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <HelpCircle className="w-6 h-6 text-purple-600" />
            </div>
            <p className="font-medium text-gray-900">Help Request</p>
            <p className="text-xs text-gray-400">Ask instructor</p>
          </div>
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="p-5 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
            <span className="text-xs text-gray-400">4 items</span>
          </div>
          <div className="p-5">
            {announcements.length === 0 ? (
              <div className="text-sm text-gray-500">No announcements.</div>
            ) : announcements.map((announcement) => (
              <div key={announcement.id} className="flex items-start mb-4 last:mb-0">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center mr-4 flex-shrink-0">
                  <FileText className="w-5 h-5 text-blue-600" />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{announcement.title}</p>
                  <p className="text-sm text-gray-500">{announcement.message}</p>
                  <p className="text-xs text-gray-400 mt-1">{announcement.time}</p>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400" />
              </div>
            ))}
          </div>
        </div>

        {/* Session Summary */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Session Summary</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Date</span>
              <span className="text-sm font-medium text-gray-900">{currentDate}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Status</span>
              <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">Active</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Subject</span>
              <span className="text-sm font-medium text-gray-900">—</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Section</span>
              <span className="text-sm font-medium text-gray-900">—</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Duration</span>
              <span className="text-sm font-medium text-gray-900">{elapsedTime}</span>
            </div>
            <div className="border-t border-gray-200 pt-4 mt-4">
              <div className="flex items-center">
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center mr-2">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                </div>
                <span className="text-sm text-green-600 font-medium">Session active</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SessionDashboard;
