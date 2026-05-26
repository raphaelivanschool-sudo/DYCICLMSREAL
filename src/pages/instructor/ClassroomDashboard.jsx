import { useEffect, useMemo, useState } from 'react';
import { Users, Wifi, Clock, WifiOff, Search, Monitor, Lock, MessageSquare, Eye, X } from 'lucide-react';
import instructorSessionService from '../../services/instructorSessionService';

function ClassroomDashboard() {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setError('');
        const data = await instructorSessionService.getActiveSession();
        if (!cancelled) setCtx(data);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load session');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const students = useMemo(() => {
    const roster = ctx?.roster || [];
    return roster.map((r) => {
      const seat = r?.computer?.seatNumber != null ? String(r.computer.seatNumber) : '—';
      return {
        id: String(r.sessionStudentId ?? r.studentId),
        studentId: r.studentId,
        name: r?.student?.fullName || r?.student?.username || `Student ${r.studentId}`,
        seat: seat,
        status: r?.status || 'offline',
        pcName: r?.computer?.name || '—',
        agent: r?.agent || null,
      };
    });
  }, [ctx]);

  const filteredStudents = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return students;
    return students.filter((student) =>
      student.name.toLowerCase().includes(q) ||
      String(student.seat).toLowerCase().includes(q) ||
      String(student.pcName).toLowerCase().includes(q)
    );
  }, [students, searchTerm]);

  const onlineCount = students.filter(s => s.status === 'online').length;
  const idleCount = students.filter(s => s.status === 'idle').length;
  const offlineCount = students.filter(s => s.status === 'offline').length;

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return 'border-green-500 bg-white';
      case 'idle': return 'border-yellow-500 bg-white';
      case 'offline': return 'border-gray-300 bg-gray-50';
      default: return 'border-gray-300 bg-white';
    }
  };

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'online': return 'bg-green-100 text-green-700 border-green-300';
      case 'idle': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'offline': return 'bg-gray-100 text-gray-500 border-gray-300';
      default: return 'bg-gray-100 text-gray-500';
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'online': return 'Online';
      case 'idle': return 'Idle';
      case 'offline': return 'Offline';
      default: return 'Unknown';
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Classroom Dashboard</h1>
        <p className="text-gray-500">Visual overview of student PCs, showing online/offline status and quick access to controls</p>
      </div>

      {/* Class Session Info */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center">
            <Monitor className="w-5 h-5 text-gray-400 mr-2" />
            <span className="text-sm font-medium text-gray-900">{ctx?.laboratory?.name || 'No active session'}</span>
            <span className="mx-2 text-gray-300">|</span>
            <span className="text-sm text-gray-500">{ctx?.laboratory?.roomNumber || ctx?.laboratory?.location || ''}</span>
          </div>
          <div className="h-6 w-px bg-gray-300"></div>
          <div className="flex items-center">
            <span className="text-sm font-medium text-gray-900">{ctx?.session?.name || '—'}</span>
          </div>
          <div className="h-6 w-px bg-gray-300"></div>
          <div className="text-sm text-gray-500">
            {ctx?.session?.startTime ? new Date(ctx.session.startTime).toLocaleString() : '—'}
          </div>
        </div>
      </div>
      {!!error && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Total Students</span>
            <Users className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{students.length}</div>
          <div className="text-xs text-gray-400 mt-1">Logged in today</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Online</span>
            <Wifi className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{onlineCount}</div>
          <div className="text-xs text-green-600 mt-1">Active right now</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Idle</span>
            <Clock className="w-5 h-5 text-yellow-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{idleCount}</div>
          <div className="text-xs text-gray-400 mt-1">No recent activity</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Offline</span>
            <WifiOff className="w-5 h-5 text-gray-400" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{offlineCount}</div>
          <div className="text-xs text-gray-400 mt-1">Not connected</div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search students..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Student PC Grid */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Student PC Grid - {ctx?.laboratory?.name || '—'}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filteredStudents.map((student) => (
            <div
              key={student.id}
              onClick={() => setSelectedStudent(student)}
              className={`relative rounded-xl border-2 p-4 cursor-pointer transition-all hover:shadow-md ${getStatusColor(student.status)}`}
            >
              {/* Seat Label */}
              <div className="absolute top-2 left-2">
                <span className="text-xs font-medium text-gray-400">Seat {student.seat}</span>
              </div>

              {/* Avatar */}
              <div className="flex justify-center mt-4 mb-3">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${student.status === 'offline' ? 'bg-gray-200' : 'bg-blue-100'}`}>
                  <span className={`text-sm font-semibold ${student.status === 'offline' ? 'text-gray-400' : 'text-blue-600'}`}>
                    {student.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
              </div>

              {/* Student Info */}
              <div className="text-center mb-3">
                <p className={`text-sm font-medium ${student.status === 'offline' ? 'text-gray-400' : 'text-gray-900'}`}>
                  {student.name}
                </p>
                <p className="text-xs text-gray-400">{student.pcName}</p>
              </div>

              {/* Status Badge */}
              <div className="flex justify-center mb-3">
                <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getStatusBadgeColor(student.status)}`}>
                  {getStatusText(student.status)}
                </span>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-center gap-2">
                <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                  <Eye className="w-4 h-4" />
                </button>
                <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                  <Lock className="w-4 h-4" />
                </button>
                <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                  <MessageSquare className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selected Student Modal */}
      {selectedStudent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Student Controls</h3>
              <button
                onClick={() => setSelectedStudent(null)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <div className="flex items-center mb-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mr-3">
                  <span className="text-sm font-semibold text-blue-600">
                    {selectedStudent.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <div>
                  <p className="font-medium text-gray-900">{selectedStudent.name}</p>
                  <p className="text-sm text-gray-500">{selectedStudent.pcName} • Seat {selectedStudent.seat}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button className="flex items-center justify-center gap-2 px-4 py-2 bg-green-50 text-green-700 rounded-lg hover:bg-green-100">
                  <Eye className="w-4 h-4" />
                  View Screen
                </button>
                <button className="flex items-center justify-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100">
                  <Lock className="w-4 h-4" />
                  Lock Screen
                </button>
                <button className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100">
                  <MessageSquare className="w-4 h-4" />
                  Message
                </button>
                <button className="flex items-center justify-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100">
                  <Monitor className="w-4 h-4" />
                  Remote Control
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ClassroomDashboard;
