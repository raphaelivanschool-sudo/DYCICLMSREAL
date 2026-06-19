import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User,
  Clock,
  Ticket,
  CheckCircle,
  MessageCircle
} from 'lucide-react';

function formatElapsedTime(startTime) {
  const diff = new Date() - startTime;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

const formatDate = () => new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

function SessionDashboard() {
  const navigate = useNavigate();
  // Get actual user data from localStorage
  const [currentUser] = useState(() => {
    const stored = localStorage.getItem('user');
    return stored ? JSON.parse(stored) : null;
  });

  const [sessionStartTime] = useState(() => {
    // Store session start time when component mounts
    const stored = sessionStorage.getItem('sessionStartTime');
    if (stored) return new Date(stored);
    const now = new Date();
    sessionStorage.setItem('sessionStartTime', now.toISOString());
    return now;
  });

  const [elapsedTime, setElapsedTime] = useState(() => formatElapsedTime(sessionStartTime));
  const [currentDate, setCurrentDate] = useState(formatDate);

  // Timer - update elapsed time every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentDate(formatDate());
      setElapsedTime(formatElapsedTime(sessionStartTime));
    }, 1000); // Update every second

    return () => clearInterval(timer);
  }, [sessionStartTime]);

  const startTimeLabel = sessionStartTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Session Dashboard</h1>
        <p className="text-gray-500">View your current lab session</p>
      </div>

      {/* Welcome Banner */}
      <div className="bg-blue-50 rounded-xl p-6 mb-6 flex items-center justify-between">
        <div className="flex items-center">
          <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center mr-4">
            <User className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="text-lg font-semibold text-gray-900">Welcome, {currentUser?.fullName || currentUser?.username || 'Student'}!</p>
            <p className="text-sm text-gray-500">Your session started at {startTimeLabel} on {currentDate}</p>
          </div>
        </div>
        <div className="flex items-center">
          <span className="w-2 h-2 bg-green-500 rounded-full mr-2"></span>
          <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">Active</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
          {/* Chats */}
          <div onClick={() => navigate('/student/messaging')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <MessageCircle className="w-6 h-6 text-purple-600" />
            </div>
            <p className="font-medium text-gray-900">Chats</p>
            <p className="text-xs text-gray-400">Message your instructor</p>
          </div>

          {/* Submit Ticket */}
          <div onClick={() => navigate('/student/tickets')} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm text-center cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Ticket className="w-6 h-6 text-orange-600" />
            </div>
            <p className="font-medium text-gray-900">Submit Ticket</p>
            <p className="text-xs text-gray-400">Report issues</p>
          </div>
        </div>
      </div>

      {/* Session Info */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Session Duration */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-3">
            <Clock className="w-6 h-6 text-purple-600" />
          </div>
          <p className="text-3xl font-bold text-gray-900 tracking-tight">{elapsedTime}</p>
          <p className="text-sm font-medium text-gray-500 mt-1">Session Duration</p>
          <p className="text-xs text-gray-400 mt-1">Since {startTimeLabel}</p>
        </div>

        {/* Session Summary */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
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
