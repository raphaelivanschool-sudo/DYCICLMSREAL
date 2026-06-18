import { useState, useEffect } from 'react';
import { 
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  User,
  Calendar,
  Filter,
  Search,
  Eye,
  MoreHorizontal,
  HardDrive,
  Wifi,
  Monitor,
  RefreshCw
} from 'lucide-react';
import ticketService from '../../services/ticketService';

function TicketApproval() {
  const [tickets, setTickets] = useState([]);
  const [allTickets, setAllTickets] = useState([]);
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
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('PENDING_APPROVAL');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [processingAction, setProcessingAction] = useState(false);

  // Load data on component mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [pendingTickets, allTicketsData, statsData] = await Promise.all([
        ticketService.getPendingApprovalTickets(),
        ticketService.getAllTickets(),
        ticketService.getInstructorTicketStats()
      ]);
      setTickets(pendingTickets);
      setAllTickets(allTicketsData);
      setStats(statsData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (ticketId, assignedTo = null) => {
    try {
      setProcessingAction(true);
      await ticketService.approveTicket(ticketId, assignedTo);
      
      // Refresh data
      await loadData();
      setSelectedTicket(null);
      setProcessingAction(false);
    } catch (error) {
      console.error('Error approving ticket:', error);
      setProcessingAction(false);
    }
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      alert('Please provide a reason for rejection');
      return;
    }

    try {
      setProcessingAction(true);
      await ticketService.rejectTicket(selectedTicket.id, rejectionReason);
      
      // Refresh data
      await loadData();
      setSelectedTicket(null);
      setShowRejectModal(false);
      setRejectionReason('');
      setProcessingAction(false);
    } catch (error) {
      console.error('Error rejecting ticket:', error);
      setProcessingAction(false);
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

  const filteredTickets = statusFilter === 'PENDING_APPROVAL' 
    ? tickets.filter(ticket => 
        ticket.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        ticket.category?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : allTickets.filter(ticket => 
        ticket.status === statusFilter &&
        (ticket.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        ticket.category?.toLowerCase().includes(searchTerm.toLowerCase()))
      );

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Page Header */}
      <div className="p-6 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Ticket Approval</h1>
            <p className="text-gray-500">Review and approve student support tickets</p>
          </div>
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500">Pending Approval</span>
              <AlertTriangle className="w-5 h-5 text-orange-500" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{stats.pendingApproval}</div>
            <div className="text-xs text-gray-400 mt-1">Awaiting review</div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500">Approved</span>
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{stats.approved}</div>
            <div className="text-xs text-gray-400 mt-1">Approved tickets</div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500">Rejected</span>
              <XCircle className="w-5 h-5 text-red-500" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{stats.rejected}</div>
            <div className="text-xs text-gray-400 mt-1">Rejected tickets</div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-500">Total Tickets</span>
              <Monitor className="w-5 h-5 text-blue-500" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{stats.total}</div>
            <div className="text-xs text-gray-400 mt-1">All tickets</div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm mb-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search tickets..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="PENDING_APPROVAL">Pending Approval</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="OPEN">Open</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="RESOLVED">Resolved</option>
                <option value="CLOSED">Closed</option>
              </select>
            </div>
          </div>
        </div>

        {/* Tickets Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-5 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {statusFilter.replace('_', ' ')} Tickets 
              <span className="ml-2 text-sm text-gray-500">({filteredTickets.length})</span>
            </h2>
          </div>
          <div className="overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500"></div>
              </div>
            ) : filteredTickets.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No tickets found for the selected filter.
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
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
                    <tr key={ticket.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-blue-600">
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
                            onClick={() => {
                              setSelectedTicket(ticket);
                              setShowDetailsModal(true);
                            }}
                            className="p-1 hover:bg-gray-100 rounded"
                            title="View Details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {ticket.status === 'PENDING_APPROVAL' && (
                            <>
                              <button
                                onClick={() => handleApprove(ticket.id)}
                                disabled={processingAction}
                                className="p-1 hover:bg-green-100 rounded text-green-600"
                                title="Approve"
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => {
                                  setSelectedTicket(ticket);
                                  setShowRejectModal(true);
                                }}
                                disabled={processingAction}
                                className="p-1 hover:bg-red-100 rounded text-red-600"
                                title="Reject"
                              >
                                <XCircle className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Ticket Details Modal */}
      {showDetailsModal && selectedTicket && (
        <div className="modal-overlay">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Ticket Details</h3>
              <button
                onClick={() => setShowDetailsModal(false)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <XCircle className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Ticket Information</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Ticket ID:</span>
                      <span className="ml-2 font-medium">{selectedTicket.ticketId}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Status:</span>
                      <span className={`ml-2 px-2 py-1 text-xs font-medium rounded-full border ${getStatusBadgeColor(selectedTicket.status)}`}>
                        {selectedTicket.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Priority:</span>
                      <span className={`ml-2 ${getPriorityColor(selectedTicket.priority)}`}>{selectedTicket.priority}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Category:</span>
                      <span className="ml-2 flex items-center">
                        {getCategoryIcon(selectedTicket.category)}
                        {selectedTicket.category}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Issue Description</h4>
                  <p className="text-gray-700 text-sm bg-gray-50 p-3 rounded-lg">
                    {selectedTicket.title}
                  </p>
                  <p className="text-gray-600 text-sm mt-2 bg-gray-50 p-3 rounded-lg">
                    {selectedTicket.description}
                  </p>
                </div>

                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Student Information</h4>
                  <div className="flex items-center">
                    <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center text-sm font-medium mr-3">
                      {selectedTicket.creator?.fullName?.charAt(0)}
                    </div>
                    <div>
                      <div className="font-medium text-gray-900">{selectedTicket.creator?.fullName}</div>
                      <div className="text-sm text-gray-500">{selectedTicket.creator?.role} • {selectedTicket.creator?.username}</div>
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Timeline</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center">
                      <Calendar className="w-4 h-4 mr-2 text-gray-400" />
                      <span className="text-gray-500">Created:</span>
                      <span className="ml-2">{new Date(selectedTicket.createdAt).toLocaleString()}</span>
                    </div>
                    {selectedTicket.approvedAt && (
                      <div className="flex items-center">
                        <CheckCircle className="w-4 h-4 mr-2 text-green-500" />
                        <span className="text-gray-500">Approved:</span>
                        <span className="ml-2">{new Date(selectedTicket.approvedAt).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {showRejectModal && selectedTicket && (
        <div className="modal-overlay">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Reject Ticket</h3>
              <button
                onClick={() => setShowRejectModal(false)}
                className="p-1 hover:bg-gray-100 rounded-lg"
              >
                <XCircle className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-gray-500 mb-4">
                Please provide a reason for rejecting ticket {selectedTicket.ticketId}
              </p>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Enter rejection reason..."
                className="w-full h-32 p-3 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-red-500"
                required
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowRejectModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReject}
                  disabled={processingAction || !rejectionReason.trim()}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {processingAction ? 'Processing...' : 'Reject Ticket'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TicketApproval;
