import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Users,
  Plus,
  Edit,
  Trash2,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Key,
  Loader2,
  AlertCircle,
  CheckCircle,
  XCircle,
  UserPlus,
  UserCog,
  Shield,
  GraduationCap
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

// Role Badge component
const RoleBadge = ({ role }) => {
  const roleConfig = {
    ADMIN: { icon: Shield, variant: 'destructive', label: 'Admin' },
    INSTRUCTOR: { icon: UserCog, variant: 'info', label: 'Instructor' },
    STUDENT: { icon: GraduationCap, variant: 'success', label: 'Student' }
  };

  const config = roleConfig[role] || roleConfig.STUDENT;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant}>
      <Icon className="w-3 h-3 mr-1" />
      {config.label}
    </Badge>
  );
};

const UserManagement = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showPasswordResetModal, setShowPasswordResetModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  // Form states
  const [formData, setFormData] = useState({
    username: '',
    fullName: '',
    email: '',
    role: 'STUDENT',
    password: ''
  });
  const [formErrors, setFormErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Fetch users
  const fetchUsers = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: currentPage,
        limit: 10
      });

      if (searchTerm) params.append('search', searchTerm);
      if (roleFilter) params.append('role', roleFilter);

      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_BASE_URL}/users?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data.success) {
        setUsers(response.data.data);
        setTotalPages(response.data.pagination.pages);
        setTotalUsers(response.data.pagination.total);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [currentPage, searchTerm, roleFilter]);

  // Form validation
  const validateForm = () => {
    const errors = {};

    if (!formData.username.trim()) {
      errors.username = 'Username is required';
    } else if (formData.username.length < 3) {
      errors.username = 'Username must be at least 3 characters';
    }

    if (!formData.fullName.trim()) {
      errors.fullName = 'Full name is required';
    }

    if (!showEditModal && !formData.password) {
      errors.password = 'Password is required';
    } else if (formData.password && formData.password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }

    if (formData.email && !/\S+@\S+\.\S+/.test(formData.email)) {
      errors.email = 'Invalid email format';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');

      if (showEditModal) {
        // Update user
        const { password, ...updateData } = formData;
        await axios.put(`${API_BASE_URL}/users/${selectedUser.id}`, updateData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        // Create user
        await axios.post(`${API_BASE_URL}/users`, formData, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      // Reset form and close modal
      setFormData({ username: '', fullName: '', email: '', role: 'STUDENT', password: '' });
      setShowCreateModal(false);
      setShowEditModal(false);
      fetchUsers();
    } catch (err) {
      setError(err.response?.data?.message || 'Operation failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle user deletion
  const handleDelete = async () => {
    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');
      await axios.delete(`${API_BASE_URL}/users/${selectedUser.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setShowDeleteModal(false);
      setSelectedUser(null);
      fetchUsers();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete user');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle password reset
  const handlePasswordReset = async () => {
    try {
      setSubmitting(true);
      const token = localStorage.getItem('token');
      await axios.post(`${API_BASE_URL}/users/${selectedUser.id}/reset-password`, {
        newPassword: formData.password
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setShowPasswordResetModal(false);
      setSelectedUser(null);
      setFormData({ ...formData, password: '' });
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reset password');
    } finally {
      setSubmitting(false);
    }
  };

  // Open edit modal
  const openEditModal = (user) => {
    setSelectedUser(user);
    setFormData({
      username: user.username,
      fullName: user.fullName,
      email: user.email || '',
      role: user.role,
      password: ''
    });
    setShowEditModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-gray-600 mt-1">Manage system users and their roles</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <UserPlus className="w-4 h-4 mr-2" />
          Add User
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Users</p>
              <p className="text-2xl font-bold text-gray-900">{totalUsers}</p>
            </div>
            <Users className="w-8 h-8 text-blue-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Admins</p>
              <p className="text-2xl font-bold text-red-600">{users.filter(u => u.role === 'ADMIN').length}</p>
            </div>
            <Shield className="w-8 h-8 text-red-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Instructors</p>
              <p className="text-2xl font-bold text-blue-600">{users.filter(u => u.role === 'INSTRUCTOR').length}</p>
            </div>
            <UserCog className="w-8 h-8 text-blue-600" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Students</p>
              <p className="text-2xl font-bold text-green-600">{users.filter(u => u.role === 'STUDENT').length}</p>
            </div>
            <GraduationCap className="w-8 h-8 text-green-600" />
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
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Roles</option>
            <option value="ADMIN">Admin</option>
            <option value="INSTRUCTOR">Instructor</option>
            <option value="STUDENT">Student</option>
          </select>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-lg border border-gray-200">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-12">
            <Users className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No users found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{user.fullName}</div>
                        <div className="text-sm text-gray-500">@{user.username}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{user.email || '—'}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-2">
                        <button
                          onClick={() => openEditModal(user)}
                          className="text-blue-600 hover:text-blue-900"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            setSelectedUser(user);
                            setShowPasswordResetModal(true);
                            setFormData({ ...formData, password: '' });
                          }}
                          className="text-yellow-600 hover:text-yellow-900"
                        >
                          <Key className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            setSelectedUser(user);
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
              Showing {((currentPage - 1) * 10) + 1} to {Math.min(currentPage * 10, totalUsers)} of {totalUsers} results
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

      {/* Create/Edit User Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold mb-4">
              {showEditModal ? 'Edit User' : 'Create New User'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
                {formErrors.username && (
                  <p className="text-red-600 text-sm mt-1">{formErrors.username}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  value={formData.fullName}
                  onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
                {formErrors.fullName && (
                  <p className="text-red-600 text-sm mt-1">{formErrors.fullName}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                {formErrors.email && (
                  <p className="text-red-600 text-sm mt-1">{formErrors.email}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Role
                </label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                >
                  <option value="STUDENT">Student</option>
                  <option value="INSTRUCTOR">Instructor</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>

              {!showEditModal && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                  {formErrors.password && (
                    <p className="text-red-600 text-sm mt-1">{formErrors.password}</p>
                  )}
                </div>
              )}

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setFormData({ username: '', fullName: '', email: '', role: 'STUDENT', password: '' });
                    setFormErrors({});
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
      {showDeleteModal && selectedUser && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm">
            <div className="flex items-center mb-4">
              <AlertCircle className="w-6 h-6 text-red-600 mr-2" />
              <h2 className="text-xl font-bold">Delete User</h2>
            </div>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete <strong>{selectedUser.fullName}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSelectedUser(null);
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

      {/* Password Reset Modal */}
      {showPasswordResetModal && selectedUser && (
        <div className="modal-overlay">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm">
            <div className="flex items-center mb-4">
              <Key className="w-6 h-6 text-yellow-600 mr-2" />
              <h2 className="text-xl font-bold">Reset Password</h2>
            </div>
            <p className="text-gray-600 mb-4">
              Set a new password for <strong>{selectedUser.fullName}</strong>
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                />
                {formErrors.password && (
                  <p className="text-red-600 text-sm mt-1">{formErrors.password}</p>
                )}
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setShowPasswordResetModal(false);
                    setSelectedUser(null);
                    setFormData({ ...formData, password: '' });
                    setFormErrors({});
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePasswordReset}
                  disabled={submitting}
                  className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    'Reset Password'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
