import { useState, useEffect } from 'react';
import { labsApi, usersApi } from '../../services/api.js';
import { 
  Users, 
  Search, 
  Plus, 
  Monitor, 
  Edit2, 
  Trash2, 
  X, 
  Save, 
  Loader2, 
  AlertCircle, 
  CheckCircle, 
  Eye, 
  LayoutGrid,
  Clock
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

// Hardcoded building options - reusable constant
const BUILDING_OPTIONS = [
  { value: 'Building A', label: 'Building A' },
  { value: 'Building B', label: 'Building B' }
];

// Hardcoded schedule configuration
const SCHEDULE_CONFIG = {
  'Monday': {
    '13:00-15:00': { instructor: 'Mr. Alberto Cruz', class: 'BSIT 3A', subjectCode: 'AIA 313' },
    '16:00-17:00': { instructor: 'Mr. Jeremy Agapito', class: 'BSIT 3A', subjectCode: 'FRE 213' }
  }
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

function Laboratories() {
  // State management
  const [labs, setLabs] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('add'); // 'add' or 'edit'
  const [selectedLab, setSelectedLab] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  
  // View lab modal (for seating layout)
  const [viewLab, setViewLab] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  
  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  
  // Toast notification
  const [toast, setToast] = useState(null);
  
  // Form state
  const [formData, setFormData] = useState({
    name: '',
    location: '',
    building: '',
    roomNumber: '',
    capacity: '',
    computerCount: '',
    status: 'ACTIVE',
    assignedInstructorId: '',
    // Schedule fields
    scheduleDay: '',
    scheduleTimeSlot: '',
    scheduleClass: '',
    scheduleSubjectCode: ''
  });

  // Fetch labs and instructors on mount
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [labsRes, instructorsRes] = await Promise.all([
        labsApi.getAll(),
        usersApi.getAll('INSTRUCTOR')
      ]);
      
      setLabs(labsRes.data.data || []);
      setInstructors(instructorsRes.data.data || []);
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to load laboratories. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
  };

  const handleOpenAddModal = () => {
    setModalMode('add');
    setSelectedLab(null);
    setFormData({
      name: '',
      location: '',
      building: '',
      roomNumber: '',
      capacity: '',
      computerCount: '',
      status: 'ACTIVE',
      assignedInstructorId: '',
      scheduleDay: '',
      scheduleTimeSlot: '',
      scheduleClass: '',
      scheduleSubjectCode: ''
    });
    setModalError(null);
    setShowModal(true);
  };

  const handleOpenEditModal = (lab) => {
    setModalMode('edit');
    setSelectedLab(lab);
    setFormData({
      name: lab.name || '',
      location: lab.location || '',
      building: lab.building || '',
      roomNumber: lab.roomNumber || '',
      capacity: lab.capacity || '',
      computerCount: lab.computerCount || 0,
      status: lab.status || 'ACTIVE',
      assignedInstructorId: lab.assignedInstructor?.id?.toString() || '',
      scheduleDay: lab.scheduleDay || '',
      scheduleTimeSlot: lab.scheduleTimeSlot || '',
      scheduleClass: lab.scheduleClass || '',
      scheduleSubjectCode: lab.scheduleSubjectCode || ''
    });
    setModalError(null);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setSelectedLab(null);
    setModalError(null);
    setSubmitLoading(false);
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => {
      const newData = { ...prev, [name]: value };
      
      // Auto-populate instructor based on day and time slot
      if (name === 'scheduleDay' || name === 'scheduleTimeSlot') {
        const day = name === 'scheduleDay' ? value : prev.scheduleDay;
        const timeSlot = name === 'scheduleTimeSlot' ? value : prev.scheduleTimeSlot;
        
        if (day && timeSlot && SCHEDULE_CONFIG[day] && SCHEDULE_CONFIG[day][timeSlot]) {
          const schedule = SCHEDULE_CONFIG[day][timeSlot];
          newData.scheduleClass = schedule.class;
          newData.scheduleSubjectCode = schedule.subjectCode;
          // Find instructor by name and set ID
          const instructor = instructors.find(inst => inst.fullName === schedule.instructor);
          if (instructor) {
            newData.assignedInstructorId = instructor.id.toString();
          }
        }
      }
      
      return newData;
    });
  };

  const handleSubmit = async () => {
    // Validation
    if (!formData.name.trim()) {
      setModalError('Lab name is required');
      return;
    }
    
    if (!formData.capacity || isNaN(formData.capacity) || parseInt(formData.capacity) <= 0) {
      setModalError('Valid capacity is required');
      return;
    }

    if (modalMode === 'add' && (!formData.computerCount || isNaN(formData.computerCount) || parseInt(formData.computerCount) <= 0)) {
      setModalError('Valid computer count is required (minimum 1)');
      return;
    }

    try {
      setSubmitLoading(true);
      setModalError(null);

      const payload = {
        name: formData.name.trim(),
        location: formData.location.trim() || null,
        building: formData.building || null,
        roomNumber: formData.roomNumber.trim() || formData.name.trim(),
        capacity: parseInt(formData.capacity),
        status: formData.status,
        assignedInstructorId: formData.assignedInstructorId || null,
        computerCount: parseInt(formData.computerCount),
        // Schedule fields
        scheduleDay: formData.scheduleDay || null,
        scheduleTimeSlot: formData.scheduleTimeSlot || null,
        scheduleClass: formData.scheduleClass || null,
        scheduleSubjectCode: formData.scheduleSubjectCode || null
      };

      if (modalMode === 'add') {
        await labsApi.create(payload);
        showToast('Laboratory added successfully');
      } else {
        const response = await labsApi.update(selectedLab.id, payload);
        if (response.data.warning) {
          showToast(response.data.warning.message, 'error');
        } else {
          showToast('Laboratory updated successfully');
        }
      }

      handleCloseModal();
      await fetchData();
    } catch (err) {
      console.error('Error saving lab:', err);
      setModalError(err.response?.data?.message || 'Failed to save laboratory. Please try again.');
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleDeleteClick = (lab) => {
    setDeleteConfirm(lab);
    setDeleteLoading(false);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;

    try {
      setDeleteLoading(true);
      await labsApi.delete(deleteConfirm.id);
      showToast('Laboratory deleted successfully');
      setDeleteConfirm(null);
      await fetchData();
    } catch (err) {
      console.error('Error deleting lab:', err);
      const errorMessage = err.response?.data?.message || 'Failed to delete laboratory';
      showToast(errorMessage, 'error');
      setDeleteConfirm(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleViewLab = async (lab) => {
    try {
      setViewLoading(true);
      const response = await labsApi.getById(lab.id);
      setViewLab(response.data);
    } catch (err) {
      console.error('Error fetching lab details:', err);
      showToast('Failed to load lab details', 'error');
    } finally {
      setViewLoading(false);
    }
  };

  // Filter labs based on search
  const filteredLabs = Array.isArray(labs) ? labs.filter(lab => 
    lab.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (lab.location && lab.location.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (lab.assignedInstructor?.fullName && lab.assignedInstructor.fullName.toLowerCase().includes(searchTerm.toLowerCase()))
  ) : [];

  // Status badge helper
  const getStatusBadge = (status) => {
    const variant = status === 'ACTIVE' ? 'success' : 'destructive';
    const label = status === 'ACTIVE' ? 'Active' : 'Inactive';
    return <Badge variant={variant}>{label}</Badge>;
  };

  // Generate seating grid for view modal
  const generateSeatingGrid = (lab) => {
    if (!lab || !lab.capacity) return [];
    
    const cols = 6;
    const rows = Math.ceil(lab.capacity / cols);
    const grid = [];
    let seatNum = 1;
    
    // Create a map of assigned computers
    const assignedComputers = new Map();
    if (lab.computers) {
      lab.computers.forEach((computer, index) => {
        assignedComputers.set(index + 1, computer);
      });
    }
    
    for (let r = 0; r < rows; r++) {
      const row = { row: r + 1, seats: [] };
      for (let c = 0; c < cols && seatNum <= lab.capacity; c++) {
        const computer = assignedComputers.get(seatNum);
        row.seats.push({
          id: seatNum,
          computer: computer || null,
          hasComputer: !!computer
        });
        seatNum++;
      }
      grid.push(row);
    }
    return grid;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-600">Loading laboratories...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
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
          <h1 className="text-2xl font-bold text-gray-900">Laboratories Management</h1>
          <p className="text-gray-500">Manage laboratory rooms, assignments, and seating</p>
        </div>
        <button 
          className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
          onClick={handleOpenAddModal}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Laboratory
        </button>
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

      {/* Search Bar */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1 max-w-md relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search laboratories..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-10 pl-10 pr-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Labs Grid */}
      {filteredLabs.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 text-lg">
            {searchTerm ? 'No laboratories found matching your search.' : 'No laboratories found.'}
          </p>
          {!searchTerm && (
            <button
              onClick={handleOpenAddModal}
              className="mt-4 text-blue-600 hover:text-blue-800 text-sm font-medium"
            >
              Add your first laboratory
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredLabs.map((lab) => (
            <div key={lab.id} className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
              {/* Card Header */}
              <div className="p-5 border-b border-gray-100">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{lab.name}</h3>
                    {lab.building && (
                      <p className="text-sm text-gray-500">{lab.building}</p>
                    )}
                    {lab.roomNumber && (
                      <p className="text-xs text-gray-400">Room {lab.roomNumber}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button 
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                      title="View Details"
                      onClick={() => handleViewLab(lab)}
                    >
                      <Eye className="w-4 h-4 text-gray-600" />
                    </button>
                    <button 
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                      title="Edit"
                      onClick={() => handleOpenEditModal(lab)}
                    >
                      <Edit2 className="w-4 h-4 text-blue-600" />
                    </button>
                    <button 
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors" 
                      title="Delete"
                      onClick={() => handleDeleteClick(lab)}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </button>
                  </div>
                </div>
                
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm">
                    <span className="text-gray-500">Instructor: </span>
                    <span className="font-medium text-gray-900">
                      {lab.assignedInstructor?.fullName || 'Unassigned'}
                    </span>
                  </div>
                  {getStatusBadge(lab.status)}
                </div>
              </div>

              {/* Lab Stats */}
              <div className="p-5 bg-gray-50">
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-600">
                      Capacity: <span className="font-medium text-gray-900">{lab.capacity}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Monitor className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-600">
                      Computers: <span className="font-medium text-gray-900">{lab.computerCount || 0} / {lab.capacity}</span>
                    </span>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <span className="text-xs text-gray-500">
                    Created {new Date(lab.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900">
                  {modalMode === 'add' ? 'Add New Laboratory' : 'Edit Laboratory'}
                </h2>
                <button 
                  onClick={handleCloseModal}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>
            
            <div className="p-6 space-y-4">
              {/* Modal Error */}
              {modalError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                  <span className="text-sm text-red-700">{modalError}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Lab Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="name"
                  placeholder="e.g., Computer Lab 1"
                  value={formData.name}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Building <span className="text-red-500">*</span>
                </label>
                <select
                  name="building"
                  value={formData.building}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">-- Select Building --</option>
                  {BUILDING_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Room Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="roomNumber"
                  placeholder="e.g., Lab 101"
                  value={formData.roomNumber}
                  onChange={handleInputChange}
                  className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Capacity <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    name="capacity"
                    placeholder="30"
                    value={formData.capacity}
                    onChange={handleInputChange}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {modalMode === 'add' ? (
                      <>Number of Computers <span className="text-red-500">*</span></>
                    ) : (
                      'Number of Computers'
                    )}
                  </label>
                  <input
                    type="number"
                    name="computerCount"
                    placeholder={modalMode === 'add' ? "5" : `${selectedLab?.computerCount || 0}`}
                    value={formData.computerCount}
                    onChange={handleInputChange}
                    min="1"
                    max="200"
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {modalMode === 'add' && formData.name && formData.computerCount > 0 && (
                    <p className="mt-1 text-xs text-blue-600">
                      This will create {formData.computerCount} computers named{' '}
                      {formData.name.split(' ').map(w => w[0]?.toUpperCase()).join('')}-PC01 to{' '}
                      {formData.name.split(' ').map(w => w[0]?.toUpperCase()).join('')}-PC{String(formData.computerCount).padStart(2, '0')}
                    </p>
                  )}
                  {modalMode === 'edit' && selectedLab && (
                    <div className="mt-1 text-xs">
                      {parseInt(formData.computerCount) > (selectedLab.computerCount || 0) ? (
                        <span className="text-blue-600">
                          Will add {parseInt(formData.computerCount) - (selectedLab.computerCount || 0)} more computers
                        </span>
                      ) : parseInt(formData.computerCount) < (selectedLab.computerCount || 0) ? (
                        <span className="text-yellow-600">
                          Warning: Reducing count won't delete existing computers. Remove them manually in Computers Panel.
                        </span>
                      ) : (
                        <span className="text-gray-500">
                          Currently has {selectedLab.computerCount || 0} computers
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select
                    name="status"
                    value={formData.status}
                    onChange={handleInputChange}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Assigned Instructor
                    {formData.assignedInstructorId && (
                      <span className="text-xs text-green-600 ml-1">(Auto-assigned)</span>
                    )}
                  </label>
                  <select
                    name="assignedInstructorId"
                    value={formData.assignedInstructorId}
                    onChange={handleInputChange}
                    disabled={!!formData.scheduleDay && !!formData.scheduleTimeSlot}
                    className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                  >
                    <option value="">-- Unassigned --</option>
                    {instructors.map(inst => (
                      <option key={inst.id} value={inst.id}>
                        {inst.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Schedule Section */}
              <div className="border-t border-gray-200 pt-4 mt-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Schedule-Based Assignment
                </h4>
                <p className="text-xs text-gray-500 mb-3">
                  Select day and time to auto-assign instructor based on schedule
                </p>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Day</label>
                    <select
                      name="scheduleDay"
                      value={formData.scheduleDay}
                      onChange={handleInputChange}
                      className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">-- Select Day --</option>
                      <option value="Monday">Monday</option>
                      <option value="Tuesday">Tuesday</option>
                      <option value="Wednesday">Wednesday</option>
                      <option value="Thursday">Thursday</option>
                      <option value="Friday">Friday</option>
                      <option value="Saturday">Saturday</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Time Slot</label>
                    <select
                      name="scheduleTimeSlot"
                      value={formData.scheduleTimeSlot}
                      onChange={handleInputChange}
                      className="w-full h-10 px-3 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">-- Select Time --</option>
                      <option value="13:00-15:00">1:00 PM - 3:00 PM</option>
                      <option value="16:00-17:00">4:00 PM - 5:00 PM</option>
                    </select>
                  </div>
                </div>

                {/* Auto-populated Schedule Info */}
                {formData.scheduleClass && formData.scheduleSubjectCode && (
                  <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-gray-500">Class:</span>
                        <span className="ml-1 font-medium text-gray-900">{formData.scheduleClass}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Subject:</span>
                        <span className="ml-1 font-medium text-gray-900">{formData.scheduleSubjectCode}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button 
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                onClick={handleCloseModal}
                disabled={submitLoading}
              >
                Cancel
              </button>
              <button 
                className="flex items-center h-10 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                onClick={handleSubmit}
                disabled={submitLoading}
              >
                {submitLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    {modalMode === 'add' ? 'Save Laboratory' : 'Update Laboratory'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-100 rounded-full">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Delete Laboratory</h3>
            </div>
            <p className="text-gray-600 mb-2">
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>?
            </p>
            {deleteConfirm.computerCount > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-sm text-yellow-800">
                  <strong>Warning:</strong> This laboratory has {deleteConfirm.computerCount} computer{deleteConfirm.computerCount !== 1 ? 's' : ''} assigned to it. 
                  Deleting this lab will also delete all associated computers. This action cannot be undone.
                </p>
              </div>
            )}
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
                className="h-10 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md text-sm font-medium hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleteLoading}
                className="flex items-center h-10 px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 transition-colors disabled:opacity-50"
              >
                {deleteLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  'Delete Laboratory'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Lab Modal (Seating Layout) */}
      {viewLab && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200 sticky top-0 bg-white">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{viewLab.name}</h2>
                  <p className="text-sm text-gray-500">
                    {viewLab.location || viewLab.roomNumber} • Capacity: {viewLab.capacity} seats
                  </p>
                </div>
                <button 
                  onClick={() => setViewLab(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>
            
            <div className="p-6">
              {viewLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  <span className="ml-2 text-gray-600">Loading details...</span>
                </div>
              ) : (
                <>
                  {/* Lab Info */}
                  <div className="mb-6 grid grid-cols-3 gap-4 p-4 bg-gray-50 rounded-lg">
                    <div>
                      <span className="text-sm text-gray-500">Instructor</span>
                      <p className="font-medium text-gray-900">
                        {viewLab.assignedInstructor?.fullName || 'Unassigned'}
                      </p>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">Status</span>
                      <p className="font-medium text-gray-900">{viewLab.status}</p>
                    </div>
                    <div>
                      <span className="text-sm text-gray-500">Computers</span>
                      <p className="font-medium text-gray-900">
                        {viewLab.computers?.length || 0} / {viewLab.capacity}
                      </p>
                    </div>
                  </div>

                  {/* Seating Grid */}
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                      <LayoutGrid className="w-5 h-5" />
                      Seating Layout
                    </h3>
                    
                    <div className="space-y-3">
                      {generateSeatingGrid(viewLab).map((row, rowIndex) => (
                        <div key={rowIndex} className="flex items-center justify-center gap-2">
                          <span className="text-xs text-gray-400 w-8 text-right">R{row.row}</span>
                          <div className="flex gap-2">
                            {row.seats.map((seat) => (
                              <div
                                key={seat.id}
                                className={`w-10 h-10 rounded flex items-center justify-center text-xs font-medium transition-colors ${
                                  seat.hasComputer 
                                    ? 'bg-blue-500 text-white' 
                                    : 'bg-gray-200 text-gray-600'
                                }`}
                                title={seat.hasComputer 
                                  ? `Seat ${seat.id}: ${seat.computer.name} (${seat.computer.status})` 
                                  : `Seat ${seat.id}: Empty`
                                }
                              >
                                {seat.id}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    
                    {/* Legend */}
                    <div className="flex items-center justify-center gap-6 mt-6 text-sm">
                      <div className="flex items-center">
                        <div className="w-4 h-4 bg-blue-500 rounded mr-2"></div>
                        <span className="text-gray-600">Has Computer ({viewLab.computers?.length || 0})</span>
                      </div>
                      <div className="flex items-center">
                        <div className="w-4 h-4 bg-gray-200 rounded mr-2"></div>
                        <span className="text-gray-600">
                          Empty ({viewLab.capacity - (viewLab.computers?.length || 0)})
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Computers List */}
                  {viewLab.computers && viewLab.computers.length > 0 && (
                    <div className="mt-6 pt-6 border-t border-gray-200">
                      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <Monitor className="w-5 h-5" />
                        Assigned Computers
                      </h3>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                        {viewLab.computers.map((computer) => (
                          <div 
                            key={computer.id} 
                            className="p-3 bg-gray-50 rounded-lg border border-gray-200"
                          >
                            <p className="font-medium text-gray-900">{computer.name}</p>
                            <p className="text-xs text-gray-500">{computer.status}</p>
                            {computer.ipAddress && (
                              <p className="text-xs text-gray-400">{computer.ipAddress}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Laboratories;
