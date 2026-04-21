import { useState, useEffect } from 'react';
import { dashboardApi } from '../../services/api.js';
import {
  Building2,
  Monitor,
  Users,
  Ticket,
  Activity,
  RefreshCw,
  AlertCircle,
  ArrowRight,
  Loader2,
  Lock,
  Clock,
  CheckCircle,
  XCircle,
  Zap,
  UserCog,
  GraduationCap,
  Shield,
  Code2
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// Inline Badge component
const Badge = ({ variant, children }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    destructive: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800'
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
};

// Skeleton card for loading state
const SkeletonCard = () => (
  <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 animate-pulse">
    <div className="flex items-center justify-between">
      <div className="space-y-3">
        <div className="h-4 w-24 bg-gray-200 rounded"></div>
        <div className="h-8 w-16 bg-gray-300 rounded"></div>
      </div>
      <div className="w-12 h-12 bg-gray-200 rounded-lg"></div>
    </div>
    <div className="mt-4 flex items-center">
      <div className="h-4 w-20 bg-gray-200 rounded"></div>
    </div>
  </div>
);

// Skeleton for lab cards
const SkeletonLabCard = () => (
  <div className="p-4 border border-gray-200 rounded-lg animate-pulse">
    <div className="flex items-start justify-between mb-3">
      <div className="space-y-2">
        <div className="h-5 w-32 bg-gray-200 rounded"></div>
        <div className="h-3 w-40 bg-gray-200 rounded"></div>
      </div>
      <div className="h-6 w-16 bg-gray-200 rounded-full"></div>
    </div>
    <div className="flex items-center justify-between">
      <div className="flex items-center space-x-4">
        <div className="h-3 w-16 bg-gray-200 rounded"></div>
        <div className="h-3 w-16 bg-gray-200 rounded"></div>
      </div>
      <div className="h-3 w-12 bg-gray-200 rounded"></div>
    </div>
    <div className="mt-3 h-2 bg-gray-200 rounded-full"></div>
  </div>
);

function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Fetch dashboard data
  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [statsRes, activityRes] = await Promise.all([
        dashboardApi.getStats(),
        dashboardApi.getRecentActivity()
      ]);
      
      setStats(statsRes.data);
      setRecentActivity(activityRes.data);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError('Failed to load dashboard data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleRefresh = async () => {
    await fetchDashboardData();
  };

  const formatTimestamp = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  };

  const formatLogDate = (timestamp) => {
    if (!timestamp) return 'Unknown';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const getStatusBadge = (status) => {
    const variants = {
      ACTIVE: 'success',
      INACTIVE: 'destructive',
      MAINTENANCE: 'warning'
    };
    return <Badge variant={variants[status] || 'default'}>{status}</Badge>;
  };

  // Render stats cards
  const renderStatsCards = () => {
    if (loading || !stats) {
      return (
        <>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </>
      );
    }

    const cards = [
      {
        name: 'Total Laboratories',
        value: stats.labs.total,
        subText: `${stats.labs.active} Active, ${stats.labs.inactive} Inactive`,
        icon: Building2,
        color: 'blue',
        onClick: () => navigate('/admin/laboratories')
      },
      {
        name: 'Total Computers',
        value: stats.computers.total,
        subText: `${stats.computers.online} Online, ${stats.computers.offline} Offline`,
        icon: Monitor,
        color: 'green',
        onClick: () => navigate('/admin/computers')
      },
      {
        name: 'Active Sessions',
        value: stats.sessions.active,
        subText: `${stats.sessions.totalToday} sessions today`,
        icon: Activity,
        color: 'purple',
        onClick: () => {}
      },
      {
        name: 'Open Tickets',
        value: stats.tickets.open,
        subText: `${stats.tickets.inProgress} in progress`,
        icon: Ticket,
        color: 'orange',
        onClick: () => {}
      },
      {
        name: 'Total Users',
        value: stats.users.total,
        subText: `${stats.users.instructors} Instructors, ${stats.users.students} Students`,
        icon: Users,
        color: 'teal',
        onClick: () => navigate('/admin/users')
      }
    ];

    const colorClasses = {
      blue: 'bg-blue-50 text-blue-600',
      green: 'bg-green-50 text-green-600',
      purple: 'bg-purple-50 text-purple-600',
      orange: 'bg-orange-50 text-orange-600',
      teal: 'bg-teal-50 text-teal-600'
    };

    return cards.map((card) => {
      const Icon = card.icon;
      return (
        <div 
          key={card.name} 
          className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 cursor-pointer hover:shadow-md transition-shadow"
          onClick={card.onClick}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-500">{card.name}</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">{card.value}</p>
            </div>
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${colorClasses[card.color]}`}>
              <Icon className="w-6 h-6" />
            </div>
          </div>
          <div className="flex items-center mt-4">
            <span className="text-sm text-gray-500">
              {card.subText}
            </span>
          </div>
        </div>
      );
    });
  };

  // Render computer status breakdown
  const renderComputerStatus = () => {
    if (loading || !stats) {
      return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 animate-pulse">
          <div className="h-5 w-40 bg-gray-200 rounded mb-4"></div>
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      );
    }

    const { computers } = stats;
    const items = [
      { label: 'Online', value: computers.online, icon: CheckCircle, color: 'bg-green-500', textColor: 'text-green-600' },
      { label: 'Offline', value: computers.offline, icon: XCircle, color: 'bg-gray-500', textColor: 'text-gray-600' },
      { label: 'In Use', value: computers.inUse, icon: Zap, color: 'bg-blue-500', textColor: 'text-blue-600' },
      { label: 'Locked', value: computers.locked, icon: Lock, color: 'bg-red-500', textColor: 'text-red-600' }
    ];

    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Computer Status Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 ${item.color} rounded-lg flex items-center justify-center`}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{item.value}</p>
                    <p className={`text-sm ${item.textColor}`}>{item.label}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render labs overview
  const renderLabsOverview = () => {
    if (loading) {
      return (
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="p-6 border-b border-gray-100">
              <div className="h-6 w-48 bg-gray-200 rounded animate-pulse"></div>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <SkeletonLabCard key={i} />
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!stats || stats.labsOverview.length === 0) {
      return (
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Laboratory Status Overview</h3>
            </div>
            <div className="p-12 text-center">
              <Building2 className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 text-lg">No laboratories added yet.</p>
              <button
                onClick={() => navigate('/admin/laboratories')}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Add Your First Laboratory
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="lg:col-span-2">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="p-6 border-b border-gray-100">
            <h3 className="text-lg font-semibold text-gray-900">Laboratory Status Overview</h3>
            <p className="text-sm text-gray-500 mt-1">Real-time status of all computer laboratories</p>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {stats.labsOverview.map((lab) => (
                <div key={lab.id} className="p-4 border border-gray-200 rounded-lg hover:border-blue-300 transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-gray-900">{lab.name}</h3>
                      <p className="text-sm text-gray-500">
                        {lab.location || 'No location'} • {lab.assignedInstructor?.fullName || 'Unassigned'}
                      </p>
                    </div>
                    {getStatusBadge(lab.status)}
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center">
                        <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                        <span className="text-gray-600">{lab.onlineCount} Online</span>
                      </div>
                      <div className="flex items-center">
                        <div className="w-2 h-2 bg-gray-400 rounded-full mr-2"></div>
                        <span className="text-gray-600">{lab.offlineCount} Offline</span>
                      </div>
                      {lab.inUseCount > 0 && (
                        <div className="flex items-center">
                          <div className="w-2 h-2 bg-blue-500 rounded-full mr-2"></div>
                          <span className="text-gray-600">{lab.inUseCount} In Use</span>
                        </div>
                      )}
                    </div>
                    <span className="text-gray-400">{lab.computerCount} Total</span>
                  </div>
                  <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-green-500 rounded-full transition-all duration-500"
                      style={{ 
                        width: `${lab.computerCount > 0 ? (lab.onlineCount / lab.computerCount) * 100 : 0}%` 
                      }}
                    ></div>
                  </div>
                </div>
              ))}
            </div>
            <button 
              onClick={() => navigate('/admin/laboratories')}
              className="w-full mt-6 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50 rounded-lg transition-colors flex items-center justify-center"
            >
              View All Laboratories
              <ArrowRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Render recent activity
  const renderRecentActivity = () => {
    if (loading) {
      return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm animate-pulse">
          <div className="p-6 border-b border-gray-100">
            <div className="h-6 w-32 bg-gray-200 rounded"></div>
          </div>
          <div className="p-6 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start space-x-3">
                <div className="w-8 h-8 bg-gray-200 rounded-lg flex-shrink-0"></div>
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-gray-200 rounded"></div>
                  <div className="h-3 w-24 bg-gray-200 rounded"></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <Activity className="w-5 h-5 mr-2 text-blue-600" />
            Recent System Activity
          </h3>
          <p className="text-sm text-gray-500 mt-1">Latest activities across all labs</p>
        </div>
        <div className="p-6">
          {recentActivity.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No recent activity</p>
              <p className="text-sm text-gray-400 mt-1">System logs will appear here</p>
            </div>
          ) : (
            <div className="space-y-4">
              {recentActivity.slice(0, 10).map((log) => (
                <div key={log.id} className="flex items-start space-x-3 p-3 hover:bg-gray-50 rounded-lg transition-colors">
                  <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Clock className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{log.action}</p>
                    <p className="text-xs text-gray-500">
                      {log.user?.fullName || 'System'} 
                      {log.targetComputer && ` • ${log.targetComputer}`}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{formatLogDate(log.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button 
            onClick={() => navigate('/admin/logs')}
            className="w-full mt-4 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50 rounded-lg transition-colors"
          >
            View All Logs →
          </button>
        </div>
      </div>
    );
  };

  // Render quick stats summary
  const renderQuickStats = () => {
    if (loading || !stats) return null;

    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Stats Summary</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Total Students</p>
                <p className="text-xs text-gray-500">Enrolled in system</p>
              </div>
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.users.students}</p>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center">
                <UserCog className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Total Instructors</p>
                <p className="text-xs text-gray-500">Managing laboratories</p>
              </div>
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.users.instructors}</p>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Administrators</p>
                <p className="text-xs text-gray-500">System admins</p>
              </div>
            </div>
            <p className="text-2xl font-bold text-gray-900">{stats.users.admins}</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <span className="text-red-700">{error}</span>
          <button 
            onClick={fetchDashboardData}
            className="ml-auto text-sm text-red-600 hover:text-red-800 underline font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard Overview</h1>
          <p className="text-gray-500">Welcome back! Here's what's happening in your laboratories.</p>
        </div>
        <div className="flex items-center gap-4">
          {lastUpdated && (
            <span className="text-sm text-gray-500">
              Last updated: {formatTimestamp(lastUpdated)}
            </span>
          )}
          <button 
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => navigate('/admin/developer')}
            className="flex items-center px-4 py-2 bg-indigo-600 border border-indigo-600 rounded-lg text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
          >
            <Code2 className="w-4 h-4 mr-2" />
            Developer Mode
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {renderStatsCards()}
      </div>

      {/* Computer Status Breakdown */}
      {renderComputerStatus()}

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Labs Overview */}
        {renderLabsOverview()}

        {/* Right Column */}
        <div className="space-y-6">
          {/* Recent Activity */}
          {renderRecentActivity()}
          
          {/* Quick Stats */}
          {renderQuickStats()}
        </div>
      </div>

    </div>
  );
}

export default Dashboard;
