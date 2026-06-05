import { useEffect, useMemo, useRef, useState } from 'react';
import { Users, Wifi, Clock, WifiOff, Search, Monitor, Grid, Maximize2, X, Eye, Lock, MessageSquare } from 'lucide-react';
import instructorSessionService from '../../services/instructorSessionService';
import { agentsApi } from '../../services/api';
import socketService from '../../services/socketService';

function StudentScreenMonitoring() {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'focused'
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState('');
  const [screenshots, setScreenshots] = useState(() => new Map());
  const pendingRef = useRef(new Set());
  const lastRequestRef = useRef(new Map());

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

  useEffect(() => {
    socketService.connect();
    const unsub = socketService.on('agent_command_result', (data) => {
      if (!data || data.action !== 'screenshot') return;
      if (!data.success || !data.result?.screenshot) return;

      const computerId = data.computerId || data.resolvedComputerId || null;
      if (!computerId) return;

      const base64 = data.result.screenshot;
      const dataUrl = `data:image/png;base64,${base64}`;
      setScreenshots((prev) => {
        const next = new Map(prev);
        next.set(String(computerId), { dataUrl, timestamp: Date.now() });
        return next;
      });
      pendingRef.current.delete(String(computerId));
    });
    return () => {
      unsub?.();
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
        seat,
        status: r?.status || 'offline',
        pcName: r?.computer?.name || '—',
        pc: r?.computer || null,
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

  const requestScreenshot = async (student) => {
    if (!student) return;
    const targetKey = String(student.agent?.id || student.pc?.id || student.studentId);
    const now = Date.now();
    const last = lastRequestRef.current.get(targetKey) || 0;
    if (now - last < 4000) return; // throttle per target
    lastRequestRef.current.set(targetKey, now);

    const resolvedComputerId = student?.agent?.id || null;
    const meta = { ip: student?.pc?.ipAddress, mac: student?.pc?.macAddress };
    try {
      pendingRef.current.add(String(resolvedComputerId || meta.ip || meta.mac || targetKey));
      await agentsApi.sendCommand(resolvedComputerId, 'screenshot', {}, meta);
    } catch {
      // ignore; UI will keep last known thumbnail / placeholder
    }
  };

  useEffect(() => {
    // lightweight polling: refresh thumbnails for online students
    if (!students.length) return;
    const interval = setInterval(() => {
      students.filter((s) => s.status === 'online').slice(0, 12).forEach((s) => {
        requestScreenshot(s);
      });
    }, 8000);
    return () => clearInterval(interval);
  }, [students]);

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'online': return 'bg-green-500';
      case 'idle': return 'bg-yellow-500';
      case 'offline': return 'bg-gray-400';
      default: return 'bg-gray-400';
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'online': return 'Active';
      case 'idle': return 'Idle';
      case 'offline': return 'Offline';
      default: return 'Unknown';
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Student Screen Monitoring</h1>
        <p className="text-gray-500">View live previews or thumbnails of student screens for real-time classroom management</p>
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
          <div className="text-xs text-gray-400 mt-1">Active sessions</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Online</span>
            <Wifi className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{onlineCount}</div>
          <div className="text-xs text-green-600 mt-1">Working now</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Idle</span>
            <Clock className="w-5 h-5 text-yellow-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{idleCount}</div>
          <div className="text-xs text-gray-400 mt-1">Inactive</div>
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

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search students..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setViewMode('grid')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm ${viewMode === 'grid' ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-700 hover:bg-gray-100'}`}
            >
              <Grid className="w-4 h-4" />
              View All
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-700 rounded-lg hover:bg-gray-100 font-medium text-sm">
              <Maximize2 className="w-4 h-4" />
              Zoom In
            </button>
          </div>
        </div>
      </div>

      {/* Screen Monitoring Grid */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Screen Monitoring - {ctx?.laboratory?.name || '—'}</h2>
          <div className="flex items-center gap-2">
            <Monitor className="w-4 h-4 text-gray-400" />
            <span className="text-sm text-gray-500">Thumbnail Mode</span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filteredStudents.map((student) => (
            <div
              key={student.id}
              onClick={() => {
                setSelectedStudent(student);
                requestScreenshot(student);
              }}
              className="group cursor-pointer"
            >
              {/* Thumbnail Container */}
              <div className={`relative rounded-xl border-2 overflow-hidden transition-all hover:shadow-lg ${student.status === 'offline' ? 'border-gray-300 bg-gray-100' : 'border-gray-200 bg-gray-900'}`}>
                {/* Screen Preview Placeholder */}
                <div className={`aspect-video flex items-center justify-center ${student.status === 'offline' ? 'bg-gray-100' : 'bg-gray-800'}`}>
                  {student.status === 'offline' ? (
                    <div className="text-center">
                      <Monitor className="w-8 h-8 text-gray-400 mx-auto mb-1" />
                      <span className="text-xs text-gray-400">Offline</span>
                    </div>
                  ) : (
                    (() => {
                      const shot = student.agent?.id ? screenshots.get(String(student.agent.id)) : null;
                      if (shot?.dataUrl) {
                        return (
                          <img
                            src={shot.dataUrl}
                            alt={`${student.name} screen`}
                            className="w-full h-full object-cover"
                          />
                        );
                      }
                      return (
                        <div className="text-center">
                          <div className="w-16 h-10 bg-gray-700 rounded mx-auto mb-2 flex items-center justify-center">
                            <Monitor className="w-6 h-6 text-gray-500" />
                          </div>
                          <span className="text-xs text-gray-400">Waiting for preview…</span>
                        </div>
                      );
                    })()
                  )}
                </div>

                {/* Status Badge */}
                <div className="absolute top-2 right-2">
                  <span className={`px-2 py-1 text-xs font-medium text-white rounded-full flex items-center gap-1 ${getStatusBadgeColor(student.status)}`}>
                    <span className="w-1.5 h-1.5 bg-white rounded-full"></span>
                    {getStatusText(student.status)}
                  </span>
                </div>

                {/* Hover Overlay */}
                {student.status !== 'offline' && (
                  <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                    <Eye className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                )}
              </div>

              {/* Student Info Below Thumbnail */}
              <div className="mt-2 flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${student.status === 'offline' ? 'bg-gray-200' : 'bg-blue-100'}`}>
                  <span className={`text-xs font-semibold ${student.status === 'offline' ? 'text-gray-400' : 'text-blue-600'}`}>
                    {student.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${student.status === 'offline' ? 'text-gray-400' : 'text-gray-900'}`}>
                    {student.name}
                  </p>
                  <p className="text-xs text-gray-400">{student.seat} • {student.pcName}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Focused View Modal */}
      {selectedStudent && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                  <span className="text-sm font-semibold text-blue-600">
                    {selectedStudent.name.split(' ').map(n => n[0]).join('')}
                  </span>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{selectedStudent.name}</h3>
                  <p className="text-sm text-gray-500">{selectedStudent.pcName} • Seat {selectedStudent.seat}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedStudent(null)}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              {/* Large Screen Preview */}
              <div className={`rounded-xl border-2 overflow-hidden ${selectedStudent.status === 'offline' ? 'border-gray-300 bg-gray-100' : 'border-gray-200 bg-gray-900'} aspect-video flex items-center justify-center`}>
                {selectedStudent.status === 'offline' ? (
                  <div className="text-center">
                    <Monitor className="w-16 h-16 text-gray-400 mx-auto mb-2" />
                    <span className="text-lg text-gray-400">Student is offline</span>
                  </div>
                ) : (
                  (() => {
                    const shot = selectedStudent.agent?.id ? screenshots.get(String(selectedStudent.agent.id)) : null;
                    if (shot?.dataUrl) {
                      return (
                        <img
                          src={shot.dataUrl}
                          alt={`${selectedStudent.name} screen`}
                          className="w-full h-full object-cover"
                        />
                      );
                    }
                    return (
                      <div className="text-center">
                        <div className="w-32 h-20 bg-gray-700 rounded mx-auto mb-4 flex items-center justify-center">
                          <Monitor className="w-12 h-12 text-gray-500" />
                        </div>
                        <span className="text-lg text-gray-400">Fetching preview…</span>
                      </div>
                    );
                  })()
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex justify-center gap-3 mt-4">
                <button
                  onClick={() => requestScreenshot(selectedStudent)}
                  className="flex items-center gap-2 px-6 py-2 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium"
                >
                  <Eye className="w-4 h-4" />
                  Refresh
                </button>
                <button
                  onClick={async () => {
                    try {
                      await agentsApi.sendCommand(
                        selectedStudent?.agent?.id || null,
                        'lock',
                        {},
                        { ip: selectedStudent?.pc?.ipAddress, mac: selectedStudent?.pc?.macAddress },
                      );
                    } catch {
                      // ignore
                    }
                  }}
                  className="flex items-center gap-2 px-6 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium"
                >
                  <Lock className="w-4 h-4" />
                  Lock Screen
                </button>
                <button
                  onClick={async () => {
                    try {
                      await agentsApi.sendCommand(
                        selectedStudent?.agent?.id || null,
                        'message',
                        { message: 'Please focus on the activity.' },
                        { ip: selectedStudent?.pc?.ipAddress, mac: selectedStudent?.pc?.macAddress },
                      );
                    } catch {
                      // ignore
                    }
                  }}
                  className="flex items-center gap-2 px-6 py-2 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 font-medium"
                >
                  <MessageSquare className="w-4 h-4" />
                  Send Message
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default StudentScreenMonitoring;
