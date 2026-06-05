import { useState, useEffect } from 'react';
import { 
  Plus,
  Monitor,
  MapPin,
  User,
  AlertCircle,
  CheckCircle,
  Clock,
  X,
  Eye,
  Wifi,
  HardDrive,
  MoreHorizontal
} from 'lucide-react';
import ticketService from '../../services/ticketService';
import sessionContextService from '../../services/sessionContextService';

function SupportTicket() {
  const [tickets, setTickets] = useState([]);
  const [sessionCtx, setSessionCtx] = useState(null);
  const [stats, setStats] = useState({
    total: 0,
    pendingApproval: 0,
    approved: 0,
    rejected: 0,
    open: 0,
    inProgress: 0,
    resolved: 0,
    closed: 0
  });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [viewingTicket, setViewingTicket] = useState(null);
  const [toast, setToast] = useState(null);
  const [formData, setFormData] = useState({
    title: '',
    category: 'Hardware Issue',
    priority: 'LOW',
    description: ''
  });

  // Load tickets and stats on component mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [ticketsData, statsData, ctxData] = await Promise.all([
        ticketService.getMyTickets(),
        ticketService.getMyTicketStats(),
        sessionContextService.getStudentContext().catch(() => null),
      ]);
      setTickets(ticketsData);
      setStats(statsData);
      setSessionCtx(ctxData);
    } catch (error) {
      console.error('Error loading data:', error);
      setToast('Error loading tickets');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      const ticketData = {
        title: formData.title,
        category: formData.category,
        priority: formData.priority,
        description: formData.description
      };

      const newTicket = await ticketService.createTicket(ticketData);
      
      setTickets([newTicket, ...tickets]);
      
      // Update stats
      setStats(prev => ({
        ...prev,
        total: prev.total + 1,
        pendingApproval: prev.pendingApproval + 1
      }));

      setFormData({ title: '', category: 'Hardware Issue', priority: 'LOW', description: '' });
      setShowForm(false);
      setToast('Ticket submitted successfully! It is now pending instructor approval.');
      setTimeout(() => setToast(null), 5000);
    } catch (error) {
      console.error('Error submitting ticket:', error);
      setToast('Error submitting ticket. Please try again.');
      setTimeout(() => setToast(null), 3000);
    }
  };

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'PENDING_APPROVAL': return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'APPROVED': return 'bg-green-100 text-green-700 border-green-300';
      case 'REJECTED': return 'bg-red-100 text-red-700 border-red-300';
      case 'OPEN': return 'bg-blue-100 text-blue-700 border-blue-300';
      case 'IN_PROGRESS': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'RESOLVED': return 'bg-green-100 text-green-700 border-green-300';
      case 'CLOSED': return 'bg-gray-100 text-gray-700 border-gray-300';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getCategoryIcon = (category) => {
    switch (category.toLowerCase()) {
      case 'hardware': return <HardDrive className="w-4 h-4 mr-1" />;
      case 'network': return <Wifi className="w-4 h-4 mr-1" />;
      default: return <Monitor className="w-4 h-4 mr-1" />;
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'HIGH': return 'text-red-600 bg-red-50 px-2 py-0.5 rounded';
      case 'MEDIUM': return 'text-orange-600 bg-orange-50 px-2 py-0.5 rounded';
      case 'LOW': return 'text-gray-600 bg-gray-100 px-2 py-0.5 rounded';
      default: return 'text-gray-600';
    }
  };

  const ticketStats = {
    total: stats.total,
    open: stats.open,
    inProgress: stats.inProgress,
    resolved: stats.resolved
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Submit Support Ticket</h1>
        <p className="text-gray-500">Report technical issues or request assistance</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Total Tickets</span>
            <Monitor className="w-5 h-5 text-blue-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{ticketStats.total}</div>
          <div className="text-xs text-gray-400 mt-1">All time</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Pending Approval</span>
            <AlertCircle className="w-5 h-5 text-orange-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{stats.pendingApproval}</div>
          <div className="text-xs text-gray-400 mt-1">Awaiting instructor review</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">In Progress</span>
            <Clock className="w-5 h-5 text-yellow-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{ticketStats.inProgress}</div>
          <div className="text-xs text-gray-400 mt-1">Being addressed</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-500">Resolved</span>
            <CheckCircle className="w-5 h-5 text-green-500" />
          </div>
          <div className="text-3xl font-bold text-gray-900">{ticketStats.resolved}</div>
          <div className="text-xs text-gray-400 mt-1">Completed</div>
        </div>
      </div>

      {/* Session Info Bar */}
      <div className="bg-blue-50 rounded-xl border border-blue-100 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center">
            <Monitor className="w-5 h-5 text-blue-500 mr-2" />
            <span className="text-sm font-medium text-gray-700">Laboratory</span>
            <span className="mx-2 text-gray-400">|</span>
            <span className="text-sm text-gray-600">{sessionCtx?.laboratory?.name || '—'}</span>
          </div>
          <div className="flex items-center">
            <MapPin className="w-5 h-5 text-green-500 mr-2" />
            <span className="text-sm font-medium text-gray-700">Seat Number</span>
            <span className="mx-2 text-gray-400">|</span>
            <span className="text-sm text-gray-600">
              {sessionCtx?.assignment?.computer?.seatNumber != null ? `Seat ${sessionCtx.assignment.computer.seatNumber}` : '—'}
            </span>
          </div>
          <div className="flex items-center">
            <Monitor className="w-5 h-5 text-purple-500 mr-2" />
            <span className="text-sm font-medium text-gray-700">Computer</span>
            <span className="mx-2 text-gray-400">|</span>
            <span className="text-sm text-gray-600">{sessionCtx?.assignment?.computer?.name || '—'}</span>
          </div>
          <div className="flex items-center">
            <User className="w-5 h-5 text-orange-500 mr-2" />
            <span className="text-sm font-medium text-gray-700">Student</span>
            <span className="mx-2 text-gray-400">|</span>
            <span className="text-sm text-gray-600">{(() => {
              const raw = localStorage.getItem('user');
              if (!raw) return '—';
              try {
                const u = JSON.parse(raw);
                return u?.fullName || u?.username || '—';
              } catch {
                return '—';
              }
            })()}</span>
          </div>
        </div>
      </div>

      {/* New Ticket Button */}
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium"
        >
          <Plus className="w-4 h-4" />
          New Ticket
        </button>
      </div>

      {/* Ticket Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Submit New Ticket</h3>
              <button
                onClick={() => setShowForm(false)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({...formData, title: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    placeholder="Brief description of the issue"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                    <select
                      value={formData.category}
                      onChange={(e) => setFormData({...formData, category: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      <option>Hardware Issue</option>
                      <option>Software Issue</option>
                      <option>Network Issue</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                    <select
                      value={formData.priority}
                      onChange={(e) => setFormData({...formData, priority: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({...formData, description: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 h-32 resize-none"
                    placeholder="Detailed description of the problem..."
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 font-medium"
                >
                  Submit Ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tickets Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">My Tickets</h2>
        </div>
        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
            </div>
          ) : tickets.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No tickets found. Submit your first ticket to get started.
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket ID</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Issue</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Priority</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
                      {ticket.ticketId}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {ticket.title}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      <span className="flex items-center">
                        {getCategoryIcon(ticket.category)}
                        {ticket.category}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <span className={getPriorityColor(ticket.priority)}>{ticket.priority}</span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getStatusBadgeColor(ticket.status)}`}>
                        {ticket.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(ticket.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <button onClick={() => setViewingTicket(ticket)} className="p-1 hover:bg-gray-100 rounded">
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Ticket Detail Modal */}
      {viewingTicket && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Ticket Details</h3>
              <button onClick={() => setViewingTicket(null)} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Ticket ID</span>
                <span className="text-sm font-medium text-blue-600">{viewingTicket.ticketId}</span>
              </div>
              <div className="flex justify-between items-start">
                <span className="text-sm text-gray-500">Title</span>
                <span className="text-sm font-medium text-gray-900 text-right max-w-[60%]">{viewingTicket.title}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Category</span>
                <span className="text-sm text-gray-700">{viewingTicket.category}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Priority</span>
                <span className={`text-sm font-medium ${getPriorityColor(viewingTicket.priority)}`}>{viewingTicket.priority}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Status</span>
                <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getStatusBadgeColor(viewingTicket.status)}`}>
                  {viewingTicket.status.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Created</span>
                <span className="text-sm text-gray-700">{new Date(viewingTicket.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              {viewingTicket.updatedAt && viewingTicket.updatedAt !== viewingTicket.createdAt && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-500">Updated</span>
                  <span className="text-sm text-gray-700">{new Date(viewingTicket.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              )}
              {viewingTicket.description && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-sm text-gray-500 mb-1">Description</p>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{viewingTicket.description}</p>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end">
              <button onClick={() => setViewingTicket(null)} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium text-sm">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg z-50 flex items-center">
          <CheckCircle className="w-5 h-5 mr-2" />
          {toast}
        </div>
      )}
    </div>
  );
}

export default SupportTicket;
