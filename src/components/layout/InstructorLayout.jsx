import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Monitor,
  Sliders,
  MessageCircle,
  LogOut,
  BookOpen,
  CheckCircle,
  GraduationCap,
  FileSpreadsheet
} from 'lucide-react';
import { getUser } from '../../utils/auth';

const navigation = [
  { name: 'Classroom Dashboard', href: '/instructor/dashboard', icon: LayoutDashboard },
  { name: 'Student Screen Monitoring', href: '/instructor/monitoring', icon: Monitor },
  { name: 'Control Actions', href: '/instructor/controls', icon: Sliders },
  { name: 'Messaging', href: '/instructor/messaging', icon: MessageCircle },
  { name: 'Ticket Approval', href: '/instructor/ticket-approval', icon: CheckCircle },
  { name: 'Reports', href: '/instructor/reports', icon: FileSpreadsheet },
  { name: 'Grading', href: '/instructor/grading', icon: GraduationCap },
];

function InstructorLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = getUser();
  const label = user?.fullName || 'Instructor';
  const initials = label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const roleLabel = user?.role ? user.role.charAt(0) + user.role.slice(1).toLowerCase() : 'Instructor';

  const handleLogout = () => {
    // Clear all localStorage items
    localStorage.clear();
    navigate('/');
  };

  const getBreadcrumb = () => {
    const path = location.pathname;
    const currentNav = navigation.find(item => item.href === path);
    return currentNav ? currentNav.name : 'Dashboard';
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar - Green accent for Instructor */}
      <div className="w-64 bg-[#1e293b] flex flex-col flex-shrink-0">
        {/* Logo Area */}
        <div className="h-16 flex items-center px-4 border-b border-slate-700">
          <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center mr-3">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white font-semibold text-sm">DYCI Instructor</h1>
            <p className="text-slate-400 text-xs">Portal</p>
          </div>
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
                        ? 'bg-[#16a34a] text-white'
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
            <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center mr-3">
              <span className="text-white text-xs font-semibold">{initials}</span>
            </div>
            <div>
              <p className="text-white text-sm font-medium">{label}</p>
              <p className="text-slate-400 text-xs">{roleLabel}</p>
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
            <div className="flex items-center">
              <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center mr-2">
                <span className="text-white text-xs font-semibold">{initials}</span>
              </div>
              <span className="text-sm font-medium text-gray-700">{label}</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto bg-gray-50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default InstructorLayout;
