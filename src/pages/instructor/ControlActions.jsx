import { useEffect, useMemo, useState } from 'react';
import { 
  Users, CheckCircle, Lock, LockOpen, Monitor, Wifi, WifiOff, 
  MessageSquare, MonitorUp, X, ChevronDown, Eye, EyeOff, 
  AppWindow, Send, User
} from 'lucide-react';
import instructorSessionService from '../../services/instructorSessionService';
import { agentsApi } from '../../services/api';

function ControlActions() {
  const [selectedStudent, setSelectedStudent] = useState('');
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [toast, setToast] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState('');
  const [activeControls, setActiveControls] = useState({
    allScreensLocked: false,
    internetDisabled: false,
    screenSharing: false,
  });
  const [blockedApps, setBlockedApps] = useState({});

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
    return roster.map((r) => ({
      id: String(r.sessionStudentId ?? r.studentId),
      studentId: r.studentId,
      name: r?.student?.fullName || r?.student?.username || `Student ${r.studentId}`,
      seat: r?.computer?.seatNumber != null ? String(r.computer.seatNumber) : '—',
      status: r?.status || 'offline',
      pc: r?.computer || null,
      agent: r?.agent || null,
    }));
  }, [ctx]);

  const onlineStudents = students.filter(s => s.status === 'online');

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const sendCommandToOnline = async (action, params = {}) => {
    const targets = onlineStudents
      .map((s) => ({
        computerId: s?.agent?.id || null,
        meta: {
          ip: s?.pc?.ipAddress || undefined,
          mac: s?.pc?.macAddress || undefined,
        },
      }))
      .filter((t) => t.computerId || t.meta.ip || t.meta.mac);

    if (targets.length === 0) {
      showToast('No online agent PCs available for this action');
      return;
    }

    await Promise.allSettled(
      targets.map((t) => agentsApi.sendCommand(t.computerId, action, params, t.meta)),
    );
  };

  const handleLockAll = async () => {
    setActiveControls({ ...activeControls, allScreensLocked: true });
    try {
      await sendCommandToOnline('lock');
      showToast('Lock command sent to all online students');
    } catch {
      showToast('Failed to send lock command');
    }
  };

  const handleUnlockAll = async () => {
    setActiveControls({ ...activeControls, allScreensLocked: false });
    try {
      await sendCommandToOnline('unlock');
      showToast('Unlock command sent to all online students');
    } catch {
      showToast('Failed to send unlock command');
    }
  };

  const handleBlankAll = async () => {
    try {
      await sendCommandToOnline('blank_screen');
      showToast('Blank screen command sent');
    } catch {
      showToast('Failed to send blank screen command');
    }
  };

  const handleDisableInternet = async () => {
    setActiveControls({ ...activeControls, internetDisabled: true });
    try {
      await sendCommandToOnline('disable_wifi');
      showToast('Disable Wi-Fi command sent');
    } catch {
      showToast('Failed to disable internet');
    }
  };

  const handleEnableInternet = async () => {
    setActiveControls({ ...activeControls, internetDisabled: false });
    try {
      await sendCommandToOnline('enable_wifi');
      showToast('Enable Wi-Fi command sent');
    } catch {
      showToast('Failed to enable internet');
    }
  };

  const handleSendBroadcast = async () => {
    if (!broadcastMessage.trim()) return;
    await sendCommandToOnline('message', { message: broadcastMessage });
    showToast(`Broadcast sent to ${onlineStudents.length} student(s)`);
    setBroadcastMessage('');
    setShowBroadcastModal(false);
  };

  const handleScreenShare = () => {
    setActiveControls({ ...activeControls, screenSharing: !activeControls.screenSharing });
    showToast(activeControls.screenSharing ? 'Screen sharing stopped' : 'Screen sharing started');
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {!!error && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Control Actions</h1>
        <p className="text-gray-500">Manage student PCs in real-time with one-click commands</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Total Students</span>
            <Users className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{students.length}</div>
          <div className="text-xs text-gray-400 mt-1">In {ctx?.laboratory?.name || '—'}</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Online Students</span>
            <CheckCircle className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{onlineStudents.length}</div>
          <div className="text-xs text-gray-400 mt-1">Available for control</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Locked Screens</span>
            <Lock className="w-5 h-5 text-red-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{activeControls.allScreensLocked ? 'All' : '0'}</div>
          <div className="text-xs text-gray-400 mt-1">Currently restricted</div>
        </div>
      </div>

      {/* Quick Commands */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Quick Commands - Apply to All Online Students</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <button
            onClick={handleLockAll}
            className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all ${
              activeControls.allScreensLocked 
                ? 'border-red-500 bg-red-50 text-red-700' 
                : 'border-gray-200 hover:border-red-300 hover:bg-red-50 text-gray-700'
            }`}
          >
            <Lock className={`w-6 h-6 mb-2 ${activeControls.allScreensLocked ? 'text-red-600' : 'text-gray-500'}`} />
            <span className="text-sm font-medium">Lock All Screens</span>
          </button>

          <button
            onClick={handleUnlockAll}
            className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-gray-200 hover:border-green-300 hover:bg-green-50 text-gray-700 transition-all"
          >
            <LockOpen className="w-6 h-6 mb-2 text-gray-500" />
            <span className="text-sm font-medium">Unlock All Screens</span>
          </button>

          <button
            onClick={handleBlankAll}
            className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-gray-200 hover:border-gray-400 hover:bg-gray-100 text-gray-700 transition-all"
          >
            <Monitor className="w-6 h-6 mb-2 text-gray-500" />
            <span className="text-sm font-medium">Blank All Screens</span>
          </button>

          <button
            onClick={() => setShowBroadcastModal(true)}
            className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-gray-700 transition-all"
          >
            <MessageSquare className="w-6 h-6 mb-2 text-gray-500" />
            <span className="text-sm font-medium">Broadcast Message</span>
          </button>
        </div>
      </div>

      {/* Internet & App Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Internet & App Controls</h2>
          <div className="space-y-3">
            <button
              onClick={handleDisableInternet}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all ${
                activeControls.internetDisabled
                  ? 'border-red-500 bg-red-50 text-red-700'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-700'
              }`}
            >
              <div className="flex items-center gap-3">
                <WifiOff className={`w-5 h-5 ${activeControls.internetDisabled ? 'text-red-600' : 'text-gray-500'}`} />
                <span className="font-medium">Disable Internet for All</span>
              </div>
              {activeControls.internetDisabled && <span className="text-xs bg-red-200 text-red-800 px-2 py-1 rounded">Active</span>}
            </button>

            <button
              onClick={handleEnableInternet}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 transition-all"
            >
              <Wifi className="w-5 h-5 text-green-500" />
              <span className="font-medium">Enable Internet for All</span>
            </button>

            <div className="border-t border-gray-200 pt-3 mt-3">
              <p className="text-sm font-medium text-gray-700 mb-2">Block Applications</p>
              {['Chrome Browser', 'Notepad', 'Calculator', 'Games'].map((app) => (
                <div key={app} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2">
                    <AppWindow className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-600">{app}</span>
                  </div>
                  <button
                    onClick={() => {
                      const next = !blockedApps[app];
                      setBlockedApps(prev => ({ ...prev, [app]: next }));
                      sendCommandToOnline('message', {
                        message: next
                          ? `[Instructor] ${app} has been restricted on this computer.`
                          : `[Instructor] ${app} restriction has been lifted.`
                      });
                    }}
                    className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${blockedApps[app] ? 'bg-red-500' : 'bg-gray-200'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${blockedApps[app] ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Broadcast & Screen Share</h2>
          <div className="space-y-3">
            <button
              onClick={() => setShowBroadcastModal(true)}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 text-gray-700 transition-all"
            >
              <MessageSquare className="w-5 h-5 text-blue-500" />
              <span className="font-medium">Broadcast Message</span>
            </button>

            <button
              onClick={handleScreenShare}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all ${
                activeControls.screenSharing
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-700'
              }`}
            >
              <div className="flex items-center gap-3">
                <MonitorUp className={`w-5 h-5 ${activeControls.screenSharing ? 'text-green-600' : 'text-gray-500'}`} />
                <span className="font-medium">Share Screen</span>
              </div>
              {activeControls.screenSharing && <span className="text-xs bg-green-200 text-green-800 px-2 py-1 rounded">Active</span>}
            </button>
          </div>

          <div className="border-t border-gray-200 pt-4 mt-4">
            <p className="text-sm text-gray-500 mb-3">Select a student to apply individual controls</p>
            <div className="relative">
              <select
                value={selectedStudent}
                onChange={(e) => setSelectedStudent(e.target.value)}
                className="w-full p-3 border border-gray-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">Select a student...</option>
                {onlineStudents.map((student) => (
                  <option key={student.id} value={student.id}>
                    {student.name} - Seat {student.seat}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {selectedStudent && (
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button
                onClick={async () => {
                  const target = students.find((s) => s.id === selectedStudent);
                  if (!target) return;
                  try {
                    await agentsApi.sendCommand(
                      target?.agent?.id || null,
                      'lock',
                      {},
                      { ip: target?.pc?.ipAddress, mac: target?.pc?.macAddress },
                    );
                    showToast('Lock command sent');
                  } catch {
                    showToast('Failed to send lock command');
                  }
                }}
                className="flex items-center justify-center gap-2 p-2 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 text-sm font-medium"
              >
                <Lock className="w-4 h-4" />
                Lock
              </button>
              <button
                onClick={async () => {
                  const target = students.find((s) => s.id === selectedStudent);
                  if (!target) return;
                  try {
                    await agentsApi.sendCommand(
                      target?.agent?.id || null,
                      'screenshot',
                      {},
                      { ip: target?.pc?.ipAddress, mac: target?.pc?.macAddress },
                    );
                    showToast('Screenshot requested (check Screen Monitoring)');
                  } catch {
                    showToast('Failed to request screenshot');
                  }
                }}
                className="flex items-center justify-center gap-2 p-2 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 text-sm font-medium"
              >
                <Eye className="w-4 h-4" />
                View
              </button>
              <button
                onClick={async () => {
                  const target = students.find((s) => s.id === selectedStudent);
                  if (!target) return;
                  try {
                    await agentsApi.sendCommand(
                      target?.agent?.id || null,
                      'message',
                      { message: broadcastMessage || 'Please focus on the activity.' },
                      { ip: target?.pc?.ipAddress, mac: target?.pc?.macAddress },
                    );
                    showToast('Message command sent');
                  } catch {
                    showToast('Failed to send message');
                  }
                }}
                className="flex items-center justify-center gap-2 p-2 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-sm font-medium"
              >
                <MessageSquare className="w-4 h-4" />
                Message
              </button>
              <button
                onClick={async () => {
                  const target = students.find((s) => s.id === selectedStudent);
                  if (!target) return;
                  try {
                    await agentsApi.sendCommand(
                      target?.agent?.id || null,
                      activeControls.internetDisabled ? 'enable_wifi' : 'disable_wifi',
                      {},
                      { ip: target?.pc?.ipAddress, mac: target?.pc?.macAddress },
                    );
                    showToast(activeControls.internetDisabled ? 'Enable Wi-Fi sent' : 'Disable Wi-Fi sent');
                  } catch {
                    showToast('Failed to toggle internet');
                  }
                }}
                className="flex items-center justify-center gap-2 p-2 rounded-lg bg-yellow-50 text-yellow-700 hover:bg-yellow-100 text-sm font-medium"
              >
                <WifiOff className="w-4 h-4" />
                Internet
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Broadcast Modal */}
      {showBroadcastModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
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
              <textarea
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                placeholder="Type your message to broadcast to all students..."
                className="w-full h-32 p-3 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowBroadcastModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendBroadcast}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
                >
                  <Send className="w-4 h-4" />
                  Send Broadcast
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

export default ControlActions;
