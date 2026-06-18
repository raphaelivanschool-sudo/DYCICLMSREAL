import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const gradingApi = axios.create({
  baseURL: `${API}/api/grading`,
  headers: { 'Content-Type': 'application/json' },
});

gradingApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const gradingService = {
  // --- Semesters ---
  getSemesters: () => gradingApi.get('/semesters'),
  createSemester: (data) => gradingApi.post('/semesters', data),
  updateSemester: (id, data) => gradingApi.patch(`/semesters/${id}`, data),
  lockSemester: (id) => gradingApi.post(`/semesters/${id}/lock`),
  unlockSemester: (id, reason) => gradingApi.post(`/semesters/${id}/unlock`, { reason }),

  // --- Subjects ---
  getSubjects: () => gradingApi.get('/subjects'),
  createSubject: (data) => gradingApi.post('/subjects', data),
  updateSubject: (id, data) => gradingApi.patch(`/subjects/${id}`, data),
  deleteSubject: (id) => gradingApi.delete(`/subjects/${id}`),

  // --- Sections ---
  getInstructors: () => gradingApi.get('/instructors'),
  getSections: (semesterId) => gradingApi.get('/sections', { params: semesterId ? { semesterId } : {} }),
  createSection: (data) => gradingApi.post('/sections', data),
  deleteSection: (id) => gradingApi.delete(`/sections/${id}`),

  // --- Enrollment ---
  searchStudents: (search) => gradingApi.get('/students', { params: { search } }),
  enrollStudent: (sectionId, studentId) => gradingApi.post(`/sections/${sectionId}/enroll`, { studentId }),
  unenrollStudent: (sectionId, studentId) => gradingApi.delete(`/sections/${sectionId}/enroll/${studentId}`),

  // --- Gradebook ---
  getGradebook: (sectionId) => gradingApi.get(`/sections/${sectionId}/gradebook`),
  createCategory: (sectionId, data) => gradingApi.post(`/sections/${sectionId}/categories`, data),
  updateCategory: (id, data) => gradingApi.patch(`/categories/${id}`, data),
  deleteCategory: (id) => gradingApi.delete(`/categories/${id}`),
  createActivity: (categoryId, data) => gradingApi.post(`/categories/${categoryId}/activities`, data),
  updateActivity: (id, data) => gradingApi.patch(`/activities/${id}`, data),
  deleteActivity: (id) => gradingApi.delete(`/activities/${id}`),
  saveScore: (activityId, enrollmentId, data) => gradingApi.put(`/activities/${activityId}/scores/${enrollmentId}`, data),
  saveScoresBulk: (activityId, scores) => gradingApi.put(`/activities/${activityId}/scores`, { scores }),

  // --- Transmutation scale / INC / submit ---
  getScale: () => gradingApi.get('/scale'),
  updateScale: (rows) => gradingApi.put('/scale', { rows }),
  markInc: (enrollmentId) => gradingApi.post(`/enrollments/${enrollmentId}/inc`),
  resolveInc: (enrollmentId) => gradingApi.post(`/enrollments/${enrollmentId}/resolve-inc`),
  submitSection: (sectionId) => gradingApi.post(`/sections/${sectionId}/submit`),

  // --- Admin oversight ---
  lockSection: (sectionId) => gradingApi.post(`/sections/${sectionId}/lock`),
  unlockSection: (sectionId, reason) => gradingApi.post(`/sections/${sectionId}/unlock`, { reason }),
  getAudit: () => gradingApi.get('/audit'),
  getSectionReport: (sectionId) => gradingApi.get(`/reports/section/${sectionId}`),
  getSemesterReport: (semesterId) => gradingApi.get(`/reports/semester/${semesterId}`),

  // --- Student ---
  getMyGrades: () => gradingApi.get('/my-grades'),
};
