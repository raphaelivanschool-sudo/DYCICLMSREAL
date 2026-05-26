import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Ticket,
  Bell,
  LogOut,
  GraduationCap,
  MessageCircle,
  ClipboardList,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import sessionContextService from '../../services/sessionContextService';

const navigation = [
  { name: 'Session Dashboard', href: '/student/dashboard', icon: LayoutDashboard },
  { name: 'Support Ticket', href: '/student/tickets', icon: Ticket },
  { name: 'Messaging', href: '/student/messaging', icon: MessageCircle },
  { name: 'My Grades', href: '/student/my-grades', icon: ClipboardList },
];

function StudentLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState('');

  const handleLogout = () => {
    // Clear all localStorage items
    localStorage.clear();
    navigate('/');
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setCtxError('');
        const data = await sessionContextService.getStudentContext();
        if (!cancelled) setCtx(data);
      } catch (e) {
        if (!cancelled) setCtxError(e?.message || 'Failed to load session context');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sidebarSession = useMemo(() => {
    const labName = ctx?.laboratory?.name || 'No active session';
    const room = ctx?.laboratory?.roomNumber || ctx?.laboratory?.location || '';
    const isActive = !!ctx?.hasActiveSession;

    const user = (() => {
      const raw = localStorage.getItem('user');
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();

    const fullName = user?.fullName || user?.username || 'Student';
    const initials = String(fullName)
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join('') || 'S';

    const pcName = ctx?.assignment?.computer?.name || '';

    return { labName, room, isActive, fullName, initials, pcName };
  }, [ctx]);

  const getBreadcrumb = () => {
    const path = location.pathname;
    const currentNav = navigation.find(item => item.href === path);
    return currentNav ? currentNav.name : 'Dashboard';
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar - Orange accent for Student */}
      <div className="w-64 bg-[#1e293b] flex flex-col flex-shrink-0">
        {/* Logo Area */}
        <div className="h-16 flex items-center px-4 border-b border-slate-700">
          <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center mr-3">
            <GraduationCap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white font-semibold text-sm">DYCI Student</h1>
            <p className="text-slate-400 text-xs">Portal</p>
          </div>
        </div>

        {/* Current Session Info */}
        <div className="p-4 border-b border-slate-700">
          <p className="text-xs text-slate-400 mb-1">Current Session</p>
          <p className="text-sm font-medium text-white">{sidebarSession.labName}</p>
          <p className="text-xs text-slate-400">{sidebarSession.room}</p>
          <div className="mt-2 flex items-center">
            <span className={`w-2 h-2 rounded-full mr-2 ${sidebarSession.isActive ? 'bg-green-500' : 'bg-slate-500'}`}></span>
            <span className={`text-xs ${sidebarSession.isActive ? 'text-green-400' : 'text-slate-400'}`}>{sidebarSession.isActive ? 'Active' : 'Inactive'}</span>
          </div>
          {!!ctxError && (
            <p className="mt-2 text-[11px] text-amber-300">
              {ctxError}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <ul className="space-y-1">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href;
              const Icon = item.icon;
              return (
                <li key={item.name}>
                  <Link
                    to={item.href}
                    className={`flex items-center px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-[#ea580c] text-white'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className={`w-4 h-4 mr-3 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                    {item.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User Profile */}
        <div className="border-t border-slate-700 p-4">
          <div className="flex items-center mb-3">
            <div className="w-8 h-8 bg-orange-600 rounded-full flex items-center justify-center mr-3">
              <span className="text-white text-xs font-semibold">{sidebarSession.initials}</span>
            </div>
            <div>
              <p className="text-white text-sm font-medium">{sidebarSession.fullName}</p>
              <p className="text-slate-400 text-xs">{sidebarSession.pcName}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center w-full px-3 py-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md text-sm transition-colors"
          >
            <LogOut className="w-4 h-4 mr-3" />
            Logout
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 shadow-sm">
          {/* Breadcrumb */}
          <div className="flex items-center text-sm text-gray-500">
            <span className="text-gray-900 font-medium">{getBreadcrumb()}</span>
          </div>

          {/* Right Side Actions */}
          <div className="flex items-center space-x-4">
            <div className="flex items-center text-sm text-gray-500 mr-4">
              <span className="text-gray-900 font-medium mr-2">{new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</span>
            </div>
            <button className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
              <Bell className="w-5 h-5" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default StudentLayout;
