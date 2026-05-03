import { useState, useEffect } from 'react';
import {
  FileText,
  Download,
  Search,
  Filter,
  Calendar,
  Users,
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  RotateCcw
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Helper component for badges
const Badge = ({ variant, children }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    destructive: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant] || variants.default}`}>
      {children}
    </span>
  );
};

// Helper function to get auth token
const getAuthToken = () => {
  const token = localStorage.getItem('token');
  return token ? `Bearer ${token}` : null;
};

function SystemLogs() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [dateRange, setDateRange] = useState('week');
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ totalActions: 0, activeUsers: 0, criticalCommands: 0, errors: 0 });
  const [uniqueActions, setUniqueActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Fetch logs from API
  const fetchLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const params = new URLSearchParams({
        page: 1,
        limit: 100,
        dateRange,
        // Use explicit "all" — empty string was sent before and the API treated it as action=""
        actionFilter: actionFilter === 'all' ? 'all' : actionFilter,
        searchTerm
      });

      const response = await fetch(`${API_URL}/api/logs?${params}`, {
        headers: {
          'Authorization': getAuthToken()
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setLogs(data.logs || []);
      setStats(data.stats || { totalActions: 0, activeUsers: 0, criticalCommands: 0, errors: 0 });
      setUniqueActions(data.uniqueActions || []);
    } catch (error) {
      console.error('Error fetching logs:', error);
      setError('Failed to fetch logs. Please try again.');
      setLogs([]);
      setStats({ totalActions: 0, activeUsers: 0, criticalCommands: 0, errors: 0 });
      setUniqueActions([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch logs on component mount and when dependencies change
  useEffect(() => {
    fetchLogs();
  }, [dateRange, actionFilter, refreshKey]);

  // Debounced search effect
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchTerm !== undefined) {
        fetchLogs();
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchTerm]);

  const handleExportLogs = async () => {
    const auth = getAuthToken();
    if (!auth) {
      alert('You must be signed in to export logs.');
      return;
    }
    try {
      setExporting(true);
      const params = new URLSearchParams({
        dateRange,
        actionFilter: actionFilter === 'all' ? 'all' : actionFilter,
        searchTerm,
        statusFilter,
      });
      const response = await fetch(`${API_URL}/api/logs/export?${params}`, {
        headers: { Authorization: auth },
      });
      if (!response.ok) {
        let message = `Export failed (${response.status})`;
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch {
          /* response may not be JSON */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      let filename = `system-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      if (disposition) {
        const utf8Name = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition);
        const quoted = /filename="([^"]+)"/i.exec(disposition);
        const plain = /filename=([^;\s]+)/i.exec(disposition);
        if (utf8Name) filename = decodeURIComponent(utf8Name[1]);
        else if (quoted) filename = quoted[1];
        else if (plain) filename = plain[1].replace(/^["']|["']$/g, '');
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export logs:', err);
      alert(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const filteredLogs = logs.filter(log => {
    // Client-side filtering for status (since backend doesn't have status field)
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'success' && !log.action.includes('ERROR')) ||
      (statusFilter === 'error' && log.action.includes('ERROR')) ||
      (statusFilter === 'warning' && log.action.includes('WARNING'));
    
    return matchesStatus;
  });

  const getStatusBadge = (action) => {
    if (action.includes('ERROR')) return <Badge variant="destructive">Error</Badge>;
    if (action.includes('WARNING')) return <Badge variant="warning">Warning</Badge>;
    return <Badge variant="success">Success</Badge>;
  };

  const getStatusIcon = (action) => {
    if (action.includes('ERROR')) return <XCircle className="w-4 h-4 text-red-500" />;
    if (action.includes('WARNING')) return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    return <CheckCircle className="w-4 h-4 text-green-500" />;
  };


  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Logs & Reports</h1>
          <p className="text-gray-500">
            Audit trail for logins, lab/inventory/ticket/grading changes, network scans, and remote PC commands (lock,
            website block, Wi‑Fi, projection, etc.)
          </p>
        </div>
        <button
          type="button"
          onClick={handleExportLogs}
          disabled={exporting}
          className="flex items-center h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:pointer-events-none"
        >
          <Download className="w-4 h-4 mr-2 shrink-0" />
          {exporting ? 'Exporting…' : 'Export Logs'}
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center mr-3">
              <Activity className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Actions Logged</p>
              <p className="text-xl font-bold text-gray-900">{stats.totalActions}</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">In selected time range</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center mr-3">
              <Users className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Active Users</p>
              <p className="text-xl font-bold text-gray-900">{stats.activeUsers}</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Across all laboratories</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-orange-50 rounded-lg flex items-center justify-center mr-3">
              <AlertTriangle className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Critical Commands</p>
              <p className="text-xl font-bold text-gray-900">{stats.criticalCommands}</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Security & system actions</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center">
            <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center mr-3">
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Errors</p>
              <p className="text-xl font-bold text-gray-900">{stats.errors}</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Failed operations</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[200px] max-w-md relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search logs..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-10 pl-10 pr-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-500" />
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Actions</option>
              {uniqueActions.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
            <button 
              onClick={() => setRefreshKey(prev => prev + 1)}
              className="flex items-center h-9 px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">Activity Logs</h3>
        </div>
        <div className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-2 text-gray-500">Loading logs...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <XCircle className="w-12 h-12 text-red-300 mx-auto mb-4" />
              <p className="text-red-500 mb-2">{error}</p>
              <button 
                onClick={() => setRefreshKey(prev => prev + 1)}
                className="text-blue-600 hover:text-blue-800 text-sm"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">IP Address</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          <div>
                            <div className="font-medium">{log.user?.fullName || 'System'}</div>
                            <div className="text-xs text-gray-500">
                              @{log.user?.username || 'system'} • {log.user?.role || 'SYSTEM'}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            {getStatusIcon(log.action)}
                            <span className="ml-2 text-sm text-gray-900">{log.action}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                          {log.description || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                          {log.ipAddress || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {getStatusBadge(log.action)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredLogs.length === 0 && (
                <div className="text-center py-12">
                  <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500">No logs found matching your filters.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SystemLogs;
