import { useState, useEffect } from 'react';
import { computersApi, labsApi } from '../../services/api.js';
import {
  Monitor,
  Search,
  Filter,
  Power,
  MessageSquare,
  MoreVertical,
  Lock,
  Unlock,
  Loader2,
  AlertCircle,
  Trash2,
  Edit2,
  X,
  CheckCircle,
  Cpu,
  HardDrive,
  MemoryStick,
  MonitorPlay,
  Settings,
  Copy,
  CheckSquare,
  Square,
  FileSpreadsheet,
  Wrench,
  Package,
  Plus
} from 'lucide-react';

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

// Toast notification component
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 z-50 ${
      type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
    }`}>
      {type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
      <span className="text-sm font-medium">{message}</span>
    </div>
  );
};

function Computers() {
  const [computers, setComputers] = useState([]);
  const [labs, setLabs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [labFilter, setLabFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  
  // Toast notification
  const [toast, setToast] = useState(null);

  // Edit Specs Modal
  const [editSpecsModal, setEditSpecsModal] = useState(null);
  const [specsForm, setSpecsForm] = useState({
    processor: '',
    ram: '',
    storageType: 'SSD',
    storageSize: '',
    gpu: '',
    osVersion: '',
    ipAddress: '',
    macAddress: ''
  });

  // Software Modal
  const [softwareModal, setSoftwareModal] = useState(null);
  const [softwareList, setSoftwareList] = useState([]);
  const [newSoftware, setNewSoftware] = useState({ name: '', version: '' });

  // Bulk Selection
  const [selectedComputers, setSelectedComputers] = useState([]);
  const [bulkMode, setBulkMode] = useState(false);

  // Bulk Edit Modal
  const [bulkEditModal, setBulkEditModal] = useState(false);

  // Clone Specs Modal
  const [cloneModal, setCloneModal] = useState(null);

  // Fetch computers and labs on mount
  useEffect(() => {
    fetchData();
  }, []);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [computersRes, labsRes] = await Promise.all([
        computersApi.getAll(),
        labsApi.getAll()
      ]);
      
      console.log('Computers API response:', computersRes);
      console.log('Labs API response:', labsRes);
      
      setComputers(computersRes.data.data || []);
      setLabs(labsRes.data.data || []);
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to load computers. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    await fetchData();
    showToast('Computer status refreshed');
  };

  const handleDeleteComputer = async (computerId) => {
    if (!confirm('Are you sure you want to delete this computer?')) return;
    
    try {
      await computersApi.delete(computerId);
      showToast('Computer deleted successfully');
      await fetchData();
    } catch (err) {
      console.error('Error deleting computer:', err);
      showToast(err.response?.data?.message || 'Failed to delete computer', 'error');
    }
  };

  const handleToggleLock = async (computer) => {
    try {
      await computersApi.update(computer.id, { isLocked: !computer.isLocked });
      showToast(`Computer ${computer.isLocked ? 'unlocked' : 'locked'} successfully`);
      await fetchData();
    } catch (err) {
      console.error('Error updating computer:', err);
      showToast('Failed to update computer lock status', 'error');
    }
  };

  // Edit Specs Handlers
  const handleOpenEditSpecs = (computer) => {
    setSpecsForm({
      processor: computer.processor || '',
      ram: computer.ram || '',
      storageType: computer.storageType || 'SSD',
      storageSize: computer.storageSize || '',
      gpu: computer.gpu || '',
      osVersion: computer.osVersion || '',
      ipAddress: computer.ipAddress || '',
      macAddress: computer.macAddress || ''
    });
    setEditSpecsModal(computer);
  };

  const handleSaveSpecs = async () => {
    try {
      await computersApi.update(editSpecsModal.id, specsForm);
      showToast('Computer specifications updated');
      setEditSpecsModal(null);
      await fetchData();
    } catch (err) {
      console.error('Error updating specs:', err);
      showToast('Failed to update specifications', 'error');
    }
  };

  // Software Handlers
  const handleOpenSoftware = async (computer) => {
    setSoftwareModal(computer);
    try {
      const res = await computersApi.getSoftware(computer.id);
      setSoftwareList(res.data);
    } catch (err) {
      console.error('Error fetching software:', err);
      setSoftwareList([]);
    }
  };

  const handleAddSoftware = async () => {
    if (!newSoftware.name.trim()) return;
    
    try {
      await computersApi.addSoftware(softwareModal.id, {
        softwareName: newSoftware.name,
        version: newSoftware.version
      });
      showToast('Software added successfully');
      setNewSoftware({ name: '', version: '' });
      
      // Refresh software list
      const res = await computersApi.getSoftware(softwareModal.id);
      setSoftwareList(res.data);
    } catch (err) {
      console.error('Error adding software:', err);
      showToast(err.response?.data?.message || 'Failed to add software', 'error');
    }
  };

  const handleRemoveSoftware = async (softwareId) => {
    try {
      await computersApi.removeSoftware(softwareModal.id, softwareId);
      showToast('Software removed');
      
      // Refresh software list
      const res = await computersApi.getSoftware(softwareModal.id);
      setSoftwareList(res.data);
    } catch (err) {
      console.error('Error removing software:', err);
      showToast('Failed to remove software', 'error');
    }
  };

  // Bulk Selection Handlers
  const handleToggleSelect = (computerId) => {
    setSelectedComputers(prev => 
      prev.includes(computerId) 
        ? prev.filter(id => id !== computerId)
        : [...prev, computerId]
    );
  };

  // Add safety check for computers array
  const safeComputers = Array.isArray(computers) ? computers : [];

  const handleSelectAll = () => {
    if (selectedComputers.length === filteredComputers.length) {
      setSelectedComputers([]);
    } else {
      setSelectedComputers(filteredComputers.map(c => c.id));
    }
  };

  const handleBulkUpdate = async () => {
    try {
      await computersApi.bulkUpdate(selectedComputers, specsForm);
      showToast(`Updated ${selectedComputers.length} computers`);
      setBulkEditModal(false);
      setSelectedComputers([]);
      setBulkMode(false);
      await fetchData();
    } catch (err) {
      console.error('Error bulk updating:', err);
      showToast('Failed to update computers', 'error');
    }
  };

  // Clone Specs Handler
  const handleOpenClone = (sourceComputer) => {
    setCloneModal({ source: sourceComputer, targets: [] });
  };

  const handleCloneSpecs = async () => {
    try {
      const sourceSpecs = {
        processor: cloneModal.source.processor,
        ram: cloneModal.source.ram,
        storageType: cloneModal.source.storageType,
        storageSize: cloneModal.source.storageSize,
        gpu: cloneModal.source.gpu,
        osVersion: cloneModal.source.osVersion
      };
      
      await computersApi.bulkUpdate(cloneModal.targets, sourceSpecs);
      showToast(`Cloned specs to ${cloneModal.targets.length} computers`);
      setCloneModal(null);
      await fetchData();
    } catch (err) {
      console.error('Error cloning specs:', err);
      showToast('Failed to clone specifications', 'error');
    }
  };

  // Filter computers based on search, lab, and status
  const filteredComputers = Array.isArray(computers) ? computers.filter(comp => {
    const matchesSearch = 
      comp.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (comp.user && comp.user.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (comp.ipAddress && comp.ipAddress.includes(searchTerm));
    
    const matchesLab = labFilter === 'all' || comp.labId === parseInt(labFilter);
    const matchesStatus = statusFilter === 'all' || comp.status === statusFilter;
    
    return matchesSearch && matchesLab && matchesStatus;
  }) : [];

  const getStatusBadge = (status) => {
    const variants = {
      online: 'success',
      idle: 'warning',
      offline: 'destructive',
      in_use: 'info',
      maintenance: 'default'
    };
    const labels = {
      online: 'Online',
      idle: 'Idle',
      offline: 'Offline',
      in_use: 'In Use',
      maintenance: 'Maintenance'
    };
    return <Badge variant={variants[status] || 'default'}>{labels[status] || status}</Badge>;
  };

  const getStatusDot = (status) => {
    const colors = {
      online: 'bg-green-500',
      idle: 'bg-yellow-500',
      offline: 'bg-red-500',
      in_use: 'bg-blue-500',
      maintenance: 'bg-gray-500'
    };
    return <div className={`w-2 h-2 rounded-full ${colors[status] || 'bg-gray-500'}`}></div>;
  };

  const hasSpecs = (computer) => {
    return computer.processor || computer.ram || computer.storageSize || computer.osVersion;
  };

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Computers Panel</h1>
            <p className="text-gray-500">Monitor and manage all computers across laboratories</p>
          </div>
        </div>
        
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <span className="ml-2 text-gray-600">Loading computers...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toast && (
        <Toast 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(null)} 
        />
      )}

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Computers Panel</h1>
          <p className="text-gray-500">Monitor and manage all computers across laboratories</p>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setBulkMode(!bulkMode)}
            className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              bulkMode 
                ? 'bg-blue-600 text-white' 
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <CheckSquare className="w-4 h-4 mr-2" />
            {bulkMode ? 'Exit Bulk Mode' : 'Bulk Select'}
          </button>
          {bulkMode && selectedComputers.length > 0 && (
            <button 
              onClick={() => setBulkEditModal(true)}
              className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              <Settings className="w-4 h-4 mr-2" />
              Edit Selected ({selectedComputers.length})
            </button>
          )}
          <button 
            onClick={handleRefresh}
            className="flex items-center px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Power className="w-4 h-4 mr-2" />
            Refresh Status
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-700">{error}</span>
          <button 
            onClick={fetchData}
            className="ml-auto text-sm text-red-600 hover:text-red-800 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[200px] max-w-md relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search computer or user..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-10 pl-10 pr-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500" />
              <select 
                value={labFilter} 
                onChange={(e) => setLabFilter(e.target.value)}
                className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-[180px]"
              >
                <option value="all">All Labs</option>
                {Array.isArray(labs) ? labs.map(lab => (
                  <option key={lab.id} value={lab.id}>{lab.name}</option>
                )) : <option value="">No labs available</option>}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="in_use">In Use</option>
                <option value="idle">Idle</option>
              </select>
            </div>
          </div>
          
          {/* Bulk Selection Bar */}
          {bulkMode && (
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  onClick={handleSelectAll}
                  className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  {selectedComputers.length === filteredComputers.length ? (
                    <><CheckSquare className="w-4 h-4" /> Deselect All</>
                  ) : (
                    <><Square className="w-4 h-4" /> Select All ({filteredComputers.length})</>
                  )}
                </button>
                <span className="text-sm text-gray-500">
                  {selectedComputers.length} selected
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Computers Grid */}
      {filteredComputers.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <Monitor className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 text-lg">
            {computers.length === 0 
              ? 'No computers found. Add laboratories with computers to get started.'
              : 'No computers found matching your filters.'
            }
          </p>
          {computers.length === 0 && (
            <p className="mt-2 text-sm text-gray-400">
              Go to Laboratories Management to create labs with computers.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredComputers.map((computer) => (
            <div key={computer.id} className={`bg-white rounded-lg border shadow-sm hover:shadow-md transition-shadow ${
              selectedComputers.includes(computer.id) ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200'
            }`}>
              <div className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center">
                    {bulkMode && (
                      <button
                        onClick={() => handleToggleSelect(computer.id)}
                        className="mr-2 text-gray-400 hover:text-blue-600"
                      >
                        {selectedComputers.includes(computer.id) ? (
                          <CheckSquare className="w-5 h-5 text-blue-600" />
                        ) : (
                          <Square className="w-5 h-5" />
                        )}
                      </button>
                    )}
                    <Monitor className="w-5 h-5 text-gray-600 mr-2" />
                    <div>
                      <p className="font-semibold text-gray-900">{computer.name}</p>
                      <p className="text-xs text-gray-500">{computer.lab}</p>
                    </div>
                  </div>
                  {getStatusDot(computer.status)}
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Status:</span>
                    {getStatusBadge(computer.status)}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Seat:</span>
                    <span className="text-gray-700">#{computer.seatNumber || '-'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">User:</span>
                    <span className="text-gray-700">{computer.user || 'No user'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">IP Address:</span>
                    <span className="text-gray-700 font-mono">{computer.ipAddress || 'Not assigned'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Uptime:</span>
                    <span className="text-gray-700">{computer.uptime || '-'}</span>
                  </div>
                  {computer.isLocked && (
                    <div className="flex items-center justify-between">
                      <span className="text-gray-500">Lock Status:</span>
                      <Badge variant="warning">Locked</Badge>
                    </div>
                  )}
                  
                  {/* Specs Summary */}
                  {hasSpecs(computer) && (
                    <div className="mt-2 pt-2 border-t border-gray-100">
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Cpu className="w-3 h-3" />
                        <span className="truncate">{computer.processor || 'No CPU info'}</span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
                        <MemoryStick className="w-3 h-3" />
                        <span>{computer.ram || '-'} RAM</span>
                        <span className="mx-1">•</span>
                        <HardDrive className="w-3 h-3" />
                        <span>{computer.storageSize || '-'}</span>
                      </div>
                    </div>
                  )}
                </div>

                {computer.status !== 'offline' && (
                  <div className="mt-4 space-y-2">
                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500">CPU</span>
                        <span className="text-gray-700">{computer.cpu || 0}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${(computer.cpu || 0) > 70 ? 'bg-red-500' : (computer.cpu || 0) > 40 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${computer.cpu || 0}%` }}
                        ></div>
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500">Memory</span>
                        <span className="text-gray-700">{computer.memory || 0}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full ${(computer.memory || 0) > 70 ? 'bg-red-500' : (computer.memory || 0) > 40 ? 'bg-yellow-500' : 'bg-green-500'}`}
                          style={{ width: `${computer.memory || 0}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between">
                  <button 
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                    title={computer.isLocked ? 'Unlock Screen' : 'Lock Screen'}
                    onClick={() => handleToggleLock(computer)}
                  >
                    {computer.isLocked ? (
                      <Unlock className="w-4 h-4 text-yellow-600" />
                    ) : (
                      <Lock className="w-4 h-4 text-gray-600" />
                    )}
                  </button>
                  <button 
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                    title="View Software"
                    onClick={() => handleOpenSoftware(computer)}
                  >
                    <Package className="w-4 h-4 text-purple-600" />
                  </button>
                  <button 
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                    title="Edit Specs"
                    onClick={() => handleOpenEditSpecs(computer)}
                  >
                    <Wrench className="w-4 h-4 text-blue-600" />
                  </button>
                  <button 
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                    title="Clone Specs"
                    onClick={() => handleOpenClone(computer)}
                  >
                    <Copy className="w-4 h-4 text-green-600" />
                  </button>
                  <button 
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                    title="Delete Computer"
                    onClick={() => handleDeleteComputer(computer.id)}
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Specs Modal */}
      {editSpecsModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Wrench className="w-5 h-5" />
                  Edit PC Specifications
                </h2>
                <button 
                  onClick={() => setEditSpecsModal(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">{editSpecsModal.name} - {editSpecsModal.lab}</p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Processor (CPU)</label>
                  <input
                    type="text"
                    placeholder="e.g., Intel Core i7-10700"
                    value={specsForm.processor}
                    onChange={(e) => setSpecsForm({...specsForm, processor: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">RAM</label>
                  <input
                    type="text"
                    placeholder="e.g., 16GB DDR4"
                    value={specsForm.ram}
                    onChange={(e) => setSpecsForm({...specsForm, ram: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Storage Type</label>
                  <select
                    value={specsForm.storageType}
                    onChange={(e) => setSpecsForm({...specsForm, storageType: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="SSD">SSD</option>
                    <option value="HDD">HDD</option>
                    <option value="NVMe">NVMe SSD</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Storage Size</label>
                  <input
                    type="text"
                    placeholder="e.g., 512GB"
                    value={specsForm.storageSize}
                    onChange={(e) => setSpecsForm({...specsForm, storageSize: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">GPU (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g., NVIDIA GTX 1650"
                  value={specsForm.gpu}
                  onChange={(e) => setSpecsForm({...specsForm, gpu: e.target.value})}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">IP Address</label>
                  <input
                    type="text"
                    placeholder="e.g., 192.168.1.100"
                    value={specsForm.ipAddress}
                    onChange={(e) => setSpecsForm({...specsForm, ipAddress: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">MAC Address</label>
                  <input
                    type="text"
                    placeholder="e.g., 00:1A:2B:3C:4D:5E"
                    value={specsForm.macAddress}
                    onChange={(e) => setSpecsForm({...specsForm, macAddress: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">OS Version</label>
                <input
                  type="text"
                  placeholder="e.g., Windows 10 Pro"
                  value={specsForm.osVersion}
                  onChange={(e) => setSpecsForm({...specsForm, osVersion: e.target.value})}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50"
                onClick={() => setEditSpecsModal(null)}
              >
                Cancel
              </button>
              <button 
                className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
                onClick={handleSaveSpecs}
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Save Specifications
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Software Modal */}
      {softwareModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  Installed Software
                </h2>
                <button 
                  onClick={() => setSoftwareModal(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">{softwareModal.name} - {softwareModal.lab}</p>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[50vh]">
              {/* Add Software Form */}
              <div className="mb-4 p-4 bg-gray-50 rounded-lg">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Add Software</h4>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Software name"
                    value={newSoftware.name}
                    onChange={(e) => setNewSoftware({...newSoftware, name: e.target.value})}
                    className="flex-1 h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="Version (optional)"
                    value={newSoftware.version}
                    onChange={(e) => setNewSoftware({...newSoftware, version: e.target.value})}
                    className="w-32 h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleAddSoftware}
                    className="h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 flex items-center"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add
                  </button>
                </div>
              </div>

              {/* Software List */}
              {softwareList.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>No software recorded for this computer.</p>
                  <p className="text-sm text-gray-400 mt-1">Add software using the form above.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {softwareList.map((software) => (
                    <div key={software.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <p className="font-medium text-gray-900">{software.softwareName}</p>
                        <p className="text-xs text-gray-500">
                          {software.version && `Version: ${software.version} • `}
                          Installed: {new Date(software.installedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        onClick={() => handleRemoveSoftware(software.id)}
                        className="p-2 hover:bg-red-100 rounded-lg transition-colors"
                        title="Remove software"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50"
                onClick={() => setSoftwareModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Edit Modal */}
      {bulkEditModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Bulk Update Specs
                </h2>
                <button 
                  onClick={() => setBulkEditModal(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Update specifications for {selectedComputers.length} selected computers
              </p>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-800">
                  <strong>Note:</strong> Only fill in the fields you want to update. 
                  Leave others blank to keep existing values.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Processor</label>
                  <input
                    type="text"
                    placeholder="e.g., Intel Core i7"
                    value={specsForm.processor}
                    onChange={(e) => setSpecsForm({...specsForm, processor: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">RAM</label>
                  <input
                    type="text"
                    placeholder="e.g., 16GB"
                    value={specsForm.ram}
                    onChange={(e) => setSpecsForm({...specsForm, ram: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Storage Type</label>
                  <select
                    value={specsForm.storageType}
                    onChange={(e) => setSpecsForm({...specsForm, storageType: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">-- Keep existing --</option>
                    <option value="SSD">SSD</option>
                    <option value="HDD">HDD</option>
                    <option value="NVMe">NVMe SSD</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Storage Size</label>
                  <input
                    type="text"
                    placeholder="e.g., 512GB"
                    value={specsForm.storageSize}
                    onChange={(e) => setSpecsForm({...specsForm, storageSize: e.target.value})}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">GPU</label>
                <input
                  type="text"
                  placeholder="e.g., NVIDIA GTX 1650"
                  value={specsForm.gpu}
                  onChange={(e) => setSpecsForm({...specsForm, gpu: e.target.value})}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">OS Version</label>
                <input
                  type="text"
                  placeholder="e.g., Windows 10 Pro"
                  value={specsForm.osVersion}
                  onChange={(e) => setSpecsForm({...specsForm, osVersion: e.target.value})}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50"
                onClick={() => setBulkEditModal(false)}
              >
                Cancel
              </button>
              <button 
                className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
                onClick={handleBulkUpdate}
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Update {selectedComputers.length} Computers
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clone Specs Modal */}
      {cloneModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  <Copy className="w-5 h-5" />
                  Clone Specifications
                </h2>
                <button 
                  onClick={() => setCloneModal(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Copy specs from <strong>{cloneModal.source.name}</strong> to other computers
              </p>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[50vh]">
              {/* Source Specs Preview */}
              <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="text-sm font-semibold text-blue-900 mb-2">Source Specifications</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {cloneModal.source.processor && (
                    <div><span className="text-blue-700">CPU:</span> {cloneModal.source.processor}</div>
                  )}
                  {cloneModal.source.ram && (
                    <div><span className="text-blue-700">RAM:</span> {cloneModal.source.ram}</div>
                  )}
                  {cloneModal.source.storageType && (
                    <div><span className="text-blue-700">Storage:</span> {cloneModal.source.storageType} {cloneModal.source.storageSize}</div>
                  )}
                  {cloneModal.source.gpu && (
                    <div><span className="text-blue-700">GPU:</span> {cloneModal.source.gpu}</div>
                  )}
                  {cloneModal.source.osVersion && (
                    <div><span className="text-blue-700">OS:</span> {cloneModal.source.osVersion}</div>
                  )}
                </div>
              </div>

              {/* Target Selection */}
              <h4 className="text-sm font-medium text-gray-700 mb-3">Select Target Computers</h4>
              <div className="space-y-2">
                {safeComputers
                  .filter(c => c.id !== cloneModal.source.id && c.labId === cloneModal.source.labId)
                  .map((computer) => (
                    <label key={computer.id} className="flex items-center p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={cloneModal.targets.includes(computer.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setCloneModal({...cloneModal, targets: [...cloneModal.targets, computer.id]});
                          } else {
                            setCloneModal({...cloneModal, targets: cloneModal.targets.filter(id => id !== computer.id)});
                          }
                        }}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <span className="ml-3 font-medium text-gray-900">{computer.name}</span>
                      <span className="ml-2 text-sm text-gray-500">({computer.lab})</span>
                    </label>
                  ))}
              </div>
              
              {safeComputers.filter(c => c.id !== cloneModal.source.id && c.labId === cloneModal.source.labId).length === 0 && (
                <div className="text-center py-4 text-gray-500">
                  <p>No other computers in this lab to clone to.</p>
                </div>
              )}
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50"
                onClick={() => setCloneModal(null)}
              >
                Cancel
              </button>
              <button 
                className="flex items-center h-10 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                onClick={handleCloneSpecs}
                disabled={cloneModal.targets.length === 0}
              >
                <Copy className="w-4 h-4 mr-2" />
                Clone to {cloneModal.targets.length} Computers
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Computers;
