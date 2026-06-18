import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Calendar,
  Clock,
  Users,
  MapPin,
  Plus,
  Edit,
  Trash2,
  Search,
  Filter,
  AlertCircle,
  CheckCircle,
  XCircle,
  Loader2,
  Building2,
  User,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Save,
  X
} from 'lucide-react';

const API_BASE_URL = 'http://localhost:3001/api';

// Badge component
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

const ScheduleManagement = () => {
  const [schedules, setSchedules] = useState([]);
  const [laboratories, setLaboratories] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLab, setSelectedLab] = useState('');
  const [selectedInstructor, setSelectedInstructor] = useState('');
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedSemester, setSelectedSemester] = useState('First');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalSchedules, setTotalSchedules] = useState(0);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [conflicts, setConflicts] = useState([]);

  // Form states
  const [formData, setFormData] = useState({
    laboratoryId: '',
    instructorId: '',
    day: 'Monday',
    startTime: '',
    endTime: '',
    className: '',
    subjectCode: ''
  });
  const [formErrors, setFormErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Calendar view state
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'calendar'
  const [expandedDays, setExpandedDays] = useState({});

  // Days of week
  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  
  // Time slots
  const timeSlots = [
    '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', 
    '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'
  ];

  // Fetch data
  const fetchData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      // Fetch schedules with filters
      const scheduleParams = new URLSearchParams({
        page: currentPage,
        limit: 50
      });

      // Temporarily remove semester filtering for testing
      // if (selectedSemester) scheduleParams.append('semester', selectedSemester);
      // if (selectedYear) scheduleParams.append('year', selectedYear);

      if (selectedLab) scheduleParams.append('laboratoryId', selectedLab);
      if (selectedInstructor) scheduleParams.append('instructorId', selectedInstructor);
      if (selectedDay) scheduleParams.append('day', selectedDay);

      const [schedulesRes, labsRes, instructorsRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/schedules?${scheduleParams}`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get(`${API_BASE_URL}/labs`, {
          headers: { Authorization: `Bearer ${token}` }
        }).catch(err => {
          console.error('Labs API error:', err);
          return { data: { success: false, message: err.message } };
        }),
        axios.get(`${API_BASE_URL}/users?role=INSTRUCTOR`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      if (schedulesRes.data.success) {
        setSchedules(schedulesRes.data.data);
        setTotalPages(schedulesRes.data.pagination.pages);
        setTotalSchedules(schedulesRes.data.pagination.total);
      }

      if (labsRes.data.success) {
        setLaboratories(labsRes.data.data);
      }

      if (instructorsRes.data.success) {
        setInstructors(instructorsRes.data.data);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setError(err.response?.data?.message || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [currentPage, selectedLab, selectedInstructor, selectedDay, selectedSemester, selectedYear]);

  // Form validation
  const validateForm = () => {
    const errors = {};

    if (!formData.laboratoryId) {
      errors.laboratoryId = 'Laboratory is required';
    }

    if (!formData.instructorId) {
      errors.instructorId = 'Instructor is required';
    }

    if (!formData.day) {
      errors.day = 'Day is required';
    }

    if (!formData.startTime) {
      errors.startTime = 'Start time is required';
    } else if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(formData.startTime)) {
      errors.startTime = 'Invalid time format (use HH:MM)';
    }

    if (!formData.endTime) {
      errors.endTime = 'End time is required';
    } else if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(formData.endTime)) {
      errors.endTime = 'Invalid time format (use HH:MM)';
    } else if (formData.startTime >= formData.endTime) {
      errors.endTime = 'End time must be after start time';
    }

    if (!formData.className.trim()) {
      errors.className = 'Class name is required';
    }

    if (!formData.subjectCode.trim()) {
      errors.subjectCode = 'Subject code is required';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Check for conflicts
  const checkConflicts = async () => {
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({
        laboratoryId: formData.laboratoryId,
        instructorId: formData.instructorId,
        day: formData.day,
        startTime: formData.startTime,
        endTime: formData.endTime
      });

      if (showEditModal && selectedSchedule) {
        params.append('excludeId', selectedSchedule.id);
      }

      const response = await axios.get(`${API_BASE_URL}/schedules/availability/check?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data.success) {
        setConflicts(response.data.conflicts);
        return response.data.available;
      }
    } catch (err) {
      console.error('Error checking conflicts:', err);
      return false;
    }
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    // Check for conflicts
    const isAvailable = await checkConflicts();
    if (!isAvailable) {
      setError('Schedule conflict detected. Please check the conflicts below.');
      return;
    }

    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');

      if (showEditModal) {
        await axios.put(`${API_BASE_URL}/schedules/${selectedSchedule.id}`, formData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.post(`${API_BASE_URL}/schedules`, formData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      // Reset form and close modal
      setFormData({
        laboratoryId: '',
        instructorId: '',
        day: 'Monday',
        startTime: '',
        endTime: '',
        className: '',
        subjectCode: ''
      });
      setShowCreateModal(false);
      setShowEditModal(false);
      setConflicts([]);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.message || 'Operation failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle schedule deletion
  const handleDelete = async () => {
    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');
      await axios.delete(`${API_BASE_URL}/schedules/${selectedSchedule.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setShowDeleteModal(false);
      setSelectedSchedule(null);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete schedule');
    } finally {
      setSubmitting(false);
    }
  };

  // Open edit modal
  const openEditModal = (schedule) => {
    setSelectedSchedule(schedule);
    setFormData({
      laboratoryId: schedule.laboratoryId.toString(),
      instructorId: schedule.instructorId.toString(),
      day: schedule.day,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      className: schedule.className,
      subjectCode: schedule.subjectCode
    });
    setShowEditModal(true);
  };

  // Organize schedules by day for calendar view
  const getSchedulesByDay = () => {
    const grouped = {};
    daysOfWeek.forEach(day => {
      grouped[day] = schedules.filter(schedule => schedule.day === day);
    });
    return grouped;
  };

  const schedulesByDay = getSchedulesByDay();

  // Toggle day expansion
  const toggleDayExpansion = (day) => {
    setExpandedDays(prev => ({
      ...prev,
      [day]: !prev[day]
    }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Schedule Management</h1>
          <p className="text-gray-600 mt-1">Manage instructor lab schedules for {selectedSemester} Semester {selectedYear}</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setViewMode(viewMode === 'list' ? 'calendar' : 'list')}
            className="flex items-center px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {viewMode === 'list' ? <Calendar className="w-4 h-4 mr-2" /> : <Users className="w-4 h-4 mr-2" />}
            {viewMode === 'list' ? 'Calendar View' : 'List View'}
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Schedule
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Schedules</p>
              <p className="text-2xl font-bold text-gray-900">{totalSchedules}</p>
            </div>
            <Calendar className="w-8 h-8 text-blue-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Labs</p>
              <p className="text-2xl font-bold text-green-600">{laboratories.filter(l => l.status === 'ACTIVE').length}</p>
            </div>
            <Building2 className="w-8 h-8 text-green-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Instructors</p>
              <p className="text-2xl font-bold text-purple-600">{instructors.length}</p>
            </div>
            <Users className="w-8 h-8 text-purple-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Current Semester</p>
              <p className="text-lg font-bold text-orange-600">{selectedSemester} {selectedYear}</p>
            </div>
            <BookOpen className="w-8 h-8 text-orange-600" />
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center">
          <AlertCircle className="w-5 h-5 text-red-600 mr-2" />
          <span className="text-red-800">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <XCircle className="w-5 h-5 text-red-600" />
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search schedules..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <select
            value={selectedSemester}
            onChange={(e) => setSelectedSemester(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="First">First Semester</option>
            <option value="Second">Second Semester</option>
            <option value="Summer">Summer</option>
          </select>

          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {[2023, 2024, 2025, 2026].map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>

          <select
            value={selectedLab}
            onChange={(e) => setSelectedLab(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Laboratories</option>
            {laboratories.map(lab => (
              <option key={lab.id} value={lab.id}>{lab.name}</option>
            ))}
          </select>

          <select
            value={selectedInstructor}
            onChange={(e) => setSelectedInstructor(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Instructors</option>
            {instructors.map(instructor => (
              <option key={instructor.id} value={instructor.id}>{instructor.fullName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Calendar View */}
      {viewMode === 'calendar' ? (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Weekly Schedule View</h2>
            <div className="space-y-4">
              {daysOfWeek.map(day => {
                const daySchedules = schedulesByDay[day];
                const isExpanded = expandedDays[day];
                
                return (
                  <div key={day} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleDayExpansion(day)}
                      className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between"
                    >
                      <div className="flex items-center">
                        <span className="font-medium text-gray-900">{day}</span>
                        <Badge variant="info" className="ml-2">
                          {daySchedules.length} schedules
                        </Badge>
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    
                    {isExpanded && (
                      <div className="p-4 space-y-2">
                        {daySchedules.length === 0 ? (
                          <p className="text-gray-500 text-center py-4">No schedules for {day}</p>
                        ) : (
                          daySchedules.map(schedule => (
                            <div key={schedule.id} className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center space-x-4">
                                    <div className="flex items-center">
                                      <Clock className="w-4 h-4 text-gray-400 mr-1" />
                                      <span className="text-sm font-medium">{schedule.startTime} - {schedule.endTime}</span>
                                    </div>
                                    <div className="flex items-center">
                                      <Building2 className="w-4 h-4 text-gray-400 mr-1" />
                                      <span className="text-sm">{schedule.laboratory.name}</span>
                                    </div>
                                    <div className="flex items-center">
                                      <User className="w-4 h-4 text-gray-400 mr-1" />
                                      <span className="text-sm">{schedule.instructor.fullName}</span>
                                    </div>
                                    <Badge variant="default">{schedule.className}</Badge>
                                    <Badge variant="info">{schedule.subjectCode}</Badge>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-2">
                                  <button
                                    onClick={() => openEditModal(schedule)}
                                    className="text-blue-600 hover:text-blue-900"
                                  >
                                    <Edit className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      setSelectedSchedule(schedule);
                                      setShowDeleteModal(true);
                                    }}
                                    className="text-red-600 hover:text-red-900"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* List View */
        <div className="bg-white rounded-lg border border-gray-200">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            </div>
          ) : schedules.length === 0 ? (
            <div className="text-center py-12">
              <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No schedules found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Day & Time
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Laboratory
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Instructor
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Class
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Subject
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {schedules.map((schedule) => (
                    <tr key={schedule.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-gray-900">{schedule.day}</div>
                          <div className="text-sm text-gray-500">{schedule.startTime} - {schedule.endTime}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{schedule.laboratory.name}</div>
                        <div className="text-sm text-gray-500">{schedule.laboratory.roomNumber}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{schedule.instructor.fullName}</div>
                        <div className="text-sm text-gray-500">{schedule.instructor.email}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant="default">{schedule.className}</Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge variant="info">{schedule.subjectCode}</Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => openEditModal(schedule)}
                            className="text-blue-600 hover:text-blue-900"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              setSelectedSchedule(schedule);
                              setShowDeleteModal(true);
                            }}
                            className="text-red-600 hover:text-red-900"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-700">
                Showing {((currentPage - 1) * 50) + 1} to {Math.min(currentPage * 50, totalSchedules)} of {totalSchedules} results
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setCurrentPage(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="p-2 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-3 py-1 text-sm">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="p-2 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Schedule Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {showEditModal ? 'Edit Schedule' : 'Create New Schedule'}
            </h2>
            
            {conflicts.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                <div className="flex items-center mb-2">
                  <AlertCircle className="w-5 h-5 text-red-600 mr-2" />
                  <h3 className="font-medium text-red-800">Schedule Conflicts Detected</h3>
                </div>
                <div className="space-y-2">
                  {conflicts.map((conflict, index) => (
                    <div key={index} className="text-sm text-red-700">
                      <p>• {conflict.laboratory.name} - {conflict.day} {conflict.startTime}-{conflict.endTime}</p>
                      <p className="ml-4">Instructor: {conflict.instructor.fullName}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Laboratory
                  </label>
                  <select
                    value={formData.laboratoryId}
                    onChange={(e) => setFormData({ ...formData, laboratoryId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    <option value="">Select Laboratory</option>
                    {laboratories.map(lab => (
                      <option key={lab.id} value={lab.id}>{lab.name} - {lab.roomNumber}</option>
                    ))}
                  </select>
                  {formErrors.laboratoryId && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.laboratoryId}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Instructor
                  </label>
                  <select
                    value={formData.instructorId}
                    onChange={(e) => setFormData({ ...formData, instructorId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    <option value="">Select Instructor</option>
                    {instructors.map(instructor => (
                      <option key={instructor.id} value={instructor.id}>{instructor.fullName}</option>
                    ))}
                  </select>
                  {formErrors.instructorId && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.instructorId}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Day
                  </label>
                  <select
                    value={formData.day}
                    onChange={(e) => setFormData({ ...formData, day: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    {daysOfWeek.map(day => (
                      <option key={day} value={day}>{day}</option>
                    ))}
                  </select>
                  {formErrors.day && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.day}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Start Time
                  </label>
                  <select
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    <option value="">Select Time</option>
                    {timeSlots.map(time => (
                      <option key={time} value={time}>{time}</option>
                    ))}
                  </select>
                  {formErrors.startTime && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.startTime}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    End Time
                  </label>
                  <select
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  >
                    <option value="">Select Time</option>
                    {timeSlots.map(time => (
                      <option key={time} value={time}>{time}</option>
                    ))}
                  </select>
                  {formErrors.endTime && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.endTime}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Class Name
                  </label>
                  <input
                    type="text"
                    value={formData.className}
                    onChange={(e) => setFormData({ ...formData, className: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., BSIT 3A"
                    required
                  />
                  {formErrors.className && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.className}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Subject Code
                  </label>
                  <input
                    type="text"
                    value={formData.subjectCode}
                    onChange={(e) => setFormData({ ...formData, subjectCode: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="e.g., AIA 313"
                    required
                  />
                  {formErrors.subjectCode && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.subjectCode}</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setFormData({
                      laboratoryId: '',
                      instructorId: '',
                      day: 'Monday',
                      startTime: '',
                      endTime: '',
                      className: '',
                      subjectCode: ''
                    });
                    setFormErrors({});
                    setConflicts([]);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    showEditModal ? 'Update' : 'Create'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && selectedSchedule && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm">
            <div className="flex items-center mb-4">
              <AlertCircle className="w-6 h-6 text-red-600 mr-2" />
              <h2 className="text-xl font-bold">Delete Schedule</h2>
            </div>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete the schedule for <strong>{selectedSchedule.className}</strong> on {selectedSchedule.day}? This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSelectedSchedule(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={submitting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Delete'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScheduleManagement;
