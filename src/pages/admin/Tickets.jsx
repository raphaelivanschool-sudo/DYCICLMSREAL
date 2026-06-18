import { useState, useEffect } from 'react';
import {
  Ticket,
  Search,
  Clock,
  CheckCircle,
  AlertCircle,
  Eye,
  MessageSquare,
  Building2,
  User,
  Monitor,
  X,
  Wrench,
  Calendar,
  RefreshCw,
  HardDrive,
  Wifi,
  CheckCircle2
} from 'lucide-react';
import ticketService from '../../services/ticketService';

function Tickets() {
  const [tickets, setTickets] = useState([]);
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
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('APPROVED');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [toast, setToast] = useState(null);
  const [processingAction, setProcessingAction] = useState(false);

  // Load tickets and stats on component mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [ticketsData, statsData] = await Promise.all([
        ticketService.getAllTickets({ status: statusFilter !== 'all' ? statusFilter : undefined }),
        ticketService.getInstructorTicketStats()
      ]);
      setTickets(ticketsData);
      setStats(statsData);
    } catch (error) {
      console.error('Error loading data:', error);
      setToast('Error loading tickets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (statusFilter !== 'all') {
      loadData();
    }
  }, [statusFilter]);

  const filteredTickets = tickets.filter(ticket => {
    const matchesSearch = ticket.ticketId?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         ticket.creator?.fullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         ticket.category?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         ticket.title?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || ticket.priority === priorityFilter;
    return matchesSearch && matchesStatus && matchesPriority;
  });

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

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'HIGH': return 'text-red-600 bg-red-50 px-2 py-0.5 rounded';
      case 'MEDIUM': return 'text-orange-600 bg-orange-50 px-2 py-0.5 rounded';
      case 'LOW': return 'text-gray-600 bg-gray-100 px-2 py-0.5 rounded';
      default: return 'text-gray-600';
    }
  };

  const getCategoryIcon = (category) => {
    switch (category.toLowerCase()) {
      case 'hardware': return <HardDrive className="w-4 h-4 mr-1" />;
      case 'network': return <Wifi className="w-4 h-4 mr-1" />;
      default: return <Monitor className="w-4 h-4 mr-1" />;
    }
  };

  const handleUpdateStatus = async () => {
    if (!selectedStatus) {
      setToast('Please select a status');
      return;
    }

    try {
      setProcessingAction(true);
      await ticketService.updateTicketStatus(selectedTicket.id, selectedStatus);
      
      // Show success message
      setToast(`Ticket status updated to ${selectedStatus.replace('_', ' ')}`);
      setShowStatusModal(false);
      setSelectedStatus('');
      setResolutionNotes('');
      setSelectedTicket(null);
      await loadData();
    } catch (error) {
      console.error('Error updating status:', error);
      setToast('Error updating ticket status');
    } finally {
      setProcessingAction(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Ticket Management</h1>
          <p className="text-gray-500">Manage approved tickets from instructors and assign to technicians</p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Approved Tickets</p>
              <p className="text-2xl font-bold text-gray-900">{stats.approved}</p>
            </div>
            <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Ready for assignment</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Open Tickets</p>
              <p className="text-2xl font-bold text-gray-900">{stats.open}</p>
            </div>
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-blue-600" />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Assigned and active</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">In Progress</p>
              <p className="text-2xl font-bold text-gray-900">{stats.inProgress}</p>
            </div>
            <div className="w-10 h-10 bg-yellow-50 rounded-lg flex items-center justify-center">
              <Clock className="w-5 h-5 text-yellow-600" />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Being worked on</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">Resolved</p>
              <p className="text-2xl font-bold text-gray-900">{stats.resolved}</p>
            </div>
            <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Successfully fixed</p>
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
                placeholder="Search tickets..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-10 pl-10 pr-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="PENDING_APPROVAL">Pending Approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Priorities</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>
        </div>
      </div>

      {/* Tickets Table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">
            {statusFilter === 'all' ? 'All Tickets' : `${statusFilter.replace('_', ' ')} Tickets`}
            <span className="ml-2 text-sm text-gray-500">({filteredTickets.length})</span>
          </h3>
        </div>
        <div className="p-0">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : filteredTickets.length === 0 ? (
            <div className="text-center py-12">
              <Ticket className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No tickets found matching your filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Issue</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Priority</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredTickets.map((ticket) => (
                    <tr key={ticket.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-blue-600">
                        {ticket.ticketId}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div className="flex items-center">
                          <div className="w-6 h-6 bg-gray-300 rounded-full flex items-center justify-center text-xs font-medium mr-2">
                            {ticket.creator?.fullName?.charAt(0)}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">{ticket.creator?.fullName}</div>
                            <div className="text-xs text-gray-500">{ticket.creator?.role}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div className="max-w-xs truncate">{ticket.title}</div>
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
                        <div className="flex items-center">
                          <Calendar className="w-4 h-4 mr-1" />
                          {new Date(ticket.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => setSelectedTicket(ticket)}
                            className="p-1 hover:bg-gray-100 rounded"
                            title="View Details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {ticket.status === 'APPROVED' && (
                            <button
                              onClick={() => {
                                setSelectedTicket(ticket);
                                setShowStatusModal(true);
                              }}
                              className="p-1 hover:bg-blue-100 rounded text-blue-600"
                              title="Start Working"
                            >
                              <Wrench className="w-4 h-4" />
                            </button>
                          )}
                          {(ticket.status === 'OPEN' || ticket.status === 'IN_PROGRESS') && (
                            <button
                              onClick={() => {
                                setSelectedTicket(ticket);
                                setShowStatusModal(true);
                              }}
                              className="p-1 hover:bg-green-100 rounded text-green-600"
                              title="Update Status"
                            >
                              <Wrench className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Ticket Detail Modal */}
      {selectedTicket && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{selectedTicket.ticketId}</h2>
                  <p className="text-sm text-gray-500">Created: {new Date(selectedTicket.createdAt).toLocaleString()}</p>
                </div>
                <button 
                  onClick={() => setSelectedTicket(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Student</p>
                  <div className="flex items-center mt-1">
                    <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center text-sm font-medium mr-2">
                      {selectedTicket.creator?.fullName?.charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{selectedTicket.creator?.fullName}</p>
                      <p className="text-xs text-gray-500">{selectedTicket.creator?.role}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Priority</p>
                  <div className="mt-1">
                    <span className={getPriorityColor(selectedTicket.priority)}>{selectedTicket.priority}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Category</p>
                  <div className="mt-1 flex items-center">
                    {getCategoryIcon(selectedTicket.category)}
                    <span className="text-sm font-medium text-gray-900 ml-1">{selectedTicket.category}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Status</p>
                  <div className="mt-1">
                    <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getStatusBadgeColor(selectedTicket.status)}`}>
                      {selectedTicket.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-sm text-gray-500">Issue Title</p>
                <p className="text-sm font-medium text-gray-900 bg-gray-50 p-3 rounded-lg mt-1">{selectedTicket.title}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Description</p>
                <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded-lg mt-1">{selectedTicket.description}</p>
              </div>
              {selectedTicket.approver && (
                <div>
                  <p className="text-sm text-gray-500">Approved By</p>
                  <div className="flex items-center mt-1">
                    <CheckCircle className="w-4 h-4 text-green-500 mr-2" />
                    <span className="text-sm text-gray-900">{selectedTicket.approver.fullName}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      at {new Date(selectedTicket.approvedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                onClick={() => setSelectedTicket(null)}
              >
                Close
              </button>
              <button 
                onClick={() => setShowStatusModal(true)}
                className="flex items-center h-10 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors"
              >
                <Wrench className="w-4 h-4 mr-2" />
                Update Status
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update Status Modal */}
      {showStatusModal && selectedTicket && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Update Ticket Status</h3>
              <p className="text-sm text-gray-500 mt-1">Update status for {selectedTicket.ticketId}</p>
            </div>
            <div className="p-6">
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">New Status</label>
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">Select status...</option>
                  {selectedTicket.status === 'APPROVED' && (
                    <>
                      <option value="OPEN">Not Yet (Open)</option>
                      <option value="IN_PROGRESS">In Progress (Fixing)</option>
                      <option value="RESOLVED">Resolved</option>
                    </>
                  )}
                  {selectedTicket.status === 'OPEN' && (
                    <>
                      <option value="IN_PROGRESS">In Progress (Fixing)</option>
                      <option value="RESOLVED">Resolved</option>
                    </>
                  )}
                  {selectedTicket.status === 'IN_PROGRESS' && (
                    <>
                      <option value="OPEN">Not Yet (Back to Open)</option>
                      <option value="RESOLVED">Resolved</option>
                    </>
                  )}
                  <option value="CLOSED">Closed</option>
                </select>
              </div>
              {(selectedStatus === 'RESOLVED' || selectedStatus === 'CLOSED') && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Resolution Notes</label>
                  <textarea
                    value={resolutionNotes}
                    onChange={(e) => setResolutionNotes(e.target.value)}
                    placeholder="Describe the resolution..."
                    className="w-full h-24 px-3 py-2 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                onClick={() => {
                  setShowStatusModal(false);
                  setSelectedStatus('');
                  setResolutionNotes('');
                }}
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleUpdateStatus}
                disabled={processingAction || !selectedStatus}
                className="h-10 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors"
              >
                {processingAction ? 'Updating...' : 'Update Status'}
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

export default Tickets;
