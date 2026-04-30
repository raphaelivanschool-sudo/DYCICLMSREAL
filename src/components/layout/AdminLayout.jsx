import { Link, useLocation, useNavigate } from "react-router-dom";
import { Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Monitor,
  Network,
  Shield,
  FileText,
  Ticket,
  Package,
  Building2,
  Bell,
  LogOut,
  User,
  Users,
  Calendar,
  GraduationCap,
} from "lucide-react";

const navigation = [
  {
    name: "Dashboard Overview",
    href: "/admin/dashboard",
    icon: LayoutDashboard,
  },
  { name: "User Management", href: "/admin/users", icon: Users },
  { name: "Schedule Management", href: "/admin/schedules", icon: Calendar },
  {
    name: "Laboratories Management",
    href: "/admin/laboratories",
    icon: Building2,
  },
  { name: "Computers Panel", href: "/admin/computers", icon: Monitor },
  { name: "Network Control", href: "/admin/network", icon: Network },
  { name: "Security Settings", href: "/admin/security", icon: Shield },
  { name: "System Logs & Reports", href: "/admin/logs", icon: FileText },
  { name: "Tickets / Support", href: "/admin/tickets", icon: Ticket },
  { name: "Inventory", href: "/admin/hardware-inventory", icon: Package },
  { name: "Grading", href: "/admin/grading", icon: GraduationCap },
];

function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    // Clear all localStorage items
    localStorage.clear();
    navigate("/");
  };

  const getBreadcrumb = () => {
    const path = location.pathname;
    const currentNav = navigation.find((item) => item.href === path);
    return currentNav ? currentNav.name : "Dashboard";
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <div className="w-64 bg-[#1e293b] flex flex-col flex-shrink-0">
        {/* Logo Area */}
        <div className="h-16 flex items-center px-4 border-b border-slate-700">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center mr-3">
            <Monitor className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-white font-semibold text-sm">DYCI Classroom</h1>
            <p className="text-slate-400 text-xs">Management</p>
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
                        ? "bg-blue-600 text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 mr-3 ${isActive ? "text-white" : "text-slate-400"}`}
                    />
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
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center mr-3">
              <User className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-white text-sm font-medium">Administrator</p>
              <p className="text-slate-400 text-xs">admin@dyci.edu</p>
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
            <button className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
              <Bell className="w-5 h-5" />
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
            </button>
            <div className="w-px h-6 bg-gray-300"></div>
            <div className="flex items-center">
              <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center mr-2">
                <span className="text-white text-xs font-semibold">AD</span>
              </div>
              <span className="text-sm font-medium text-gray-700">Admin</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>

    </div>
  );
}

export default AdminLayout;
