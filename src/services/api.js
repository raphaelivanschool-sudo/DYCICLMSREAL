import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Labs API
export const labsApi = {
  // Get all labs
  getAll: () => api.get("/api/labs"),

  // Get single lab by ID
  getById: (id) => api.get(`/api/labs/${id}`),

  // Create new lab
  create: (data) => api.post("/api/labs", data),

  // Update lab
  update: (id, data) => api.put(`/api/labs/${id}`, data),

  // Delete lab
  delete: (id) => api.delete(`/api/labs/${id}`),
};

// Users API
export const usersApi = {
  // Get all users with optional role filter
  getAll: (role) => {
    const params = role ? { role } : {};
    return api.get("/api/users", { params });
  },
};

// Computers API
export const computersApi = {
  // Get all computers with optional filters
  getAll: (filters = {}) => api.get("/api/computers", { params: filters }),

  // Get single computer by ID
  getById: (id) => api.get(`/api/computers/${id}`),

  // Update computer
  update: (id, data) => api.put(`/api/computers/${id}`, data),

  // Delete computer
  delete: (id) => api.delete(`/api/computers/${id}`),

  // Get software installed on a computer
  getSoftware: (id) => api.get(`/api/computers/${id}/software`),

  // Add software to a computer
  addSoftware: (id, data) => api.post(`/api/computers/${id}/software`, data),

  // Remove software from a computer
  removeSoftware: (computerId, softwareId) =>
    api.delete(`/api/computers/${computerId}/software/${softwareId}`),

  // Bulk update computers
  bulkUpdate: (computerIds, specs) =>
    api.post("/api/computers/bulk-update", { computerIds, specs }),
};

// Dashboard API
export const dashboardApi = {
  // Get all dashboard statistics
  getStats: () => api.get("/api/dashboard/stats"),

  // Get recent activity logs
  getRecentActivity: () => api.get("/api/dashboard/recent-activity"),
};

// Hardware Inventory API
export const hardwareInventoryApi = {
  // Get all hardware inventory items for a specific lab
  getByLaboratory: (laboratoryId, filters = {}) => {
    const params = new URLSearchParams();
    Object.keys(filters).forEach((key) => {
      if (filters[key]) {
        params.append(key, filters[key]);
      }
    });
    return api.get(
      `/api/hardware-inventory/laboratory/${laboratoryId}?${params}`,
    );
  },

  // Get statistics for a specific lab
  getStats: (laboratoryId) =>
    api.get(`/api/hardware-inventory/laboratory/${laboratoryId}/stats`),

  // Get single item by ID
  getById: (id) => api.get(`/api/hardware-inventory/${id}`),

  // Create new item
  create: (data) => api.post("/api/hardware-inventory", data),

  // Update item
  update: (id, data) => api.put(`/api/hardware-inventory/${id}`, data),

  // Delete item
  delete: (id) => api.delete(`/api/hardware-inventory/${id}`),

  // Get computers for a laboratory (for assignment dropdown)
  getComputers: (laboratoryId) =>
    api.get(`/api/hardware-inventory/computers/laboratory/${laboratoryId}`),
};

// Agents API (for PC agent management)
export const agentsApi = {
  // Get all connected agent PCs
  getConnected: () => api.get("/api/agents/connected"),

  // Get specific agent PC details
  getById: (computerId) => api.get(`/api/agents/connected/${computerId}`),

  // Send command to agent PC (optional ip/mac when computerId unknown — server resolves online agent)
  sendCommand: (computerId, action, params = {}, meta = {}) => {
    const body = { action, params: params ?? {} };
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/command", body);
  },

  // Generate agent installer
  createInstaller: (room, serverUrl, computerName) =>
    api.post("/api/agents/installer", { room, serverUrl, computerName }),

  // Get all registered agents
  getAll: () => api.get("/api/agents"),

  // Get agent stats
  getStats: () => api.get("/api/agents/stats"),

  // Wake on LAN
  wakeOnLAN: (mac) => api.post("/api/agents/wake", { mac }),

  /** Host→guest screen projection (server forwards to Flask agent /project on port 5555). */
  openProjectionWindow: (computerId, meta = {}) => {
    const body = {};
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/projection/open", body);
  },

  sendProjectionFrame: (computerId, payload = {}, meta = {}) => {
    const body = { ...payload };
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/projection/frame", body);
  },

  requestProjectionPermission: (computerId, payload = {}, meta = {}) => {
    const body = { ...payload };
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/projection/request", body);
  },

  stopProjectionHttp: (computerId, meta = {}) => {
    const body = {};
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/projection/stop", body);
  },

  startRtspStream: (computerId, payload = {}, meta = {}) => {
    const body = { ...payload };
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/stream/start", body);
  },

  stopRtspStream: (computerId, meta = {}) => {
    const body = {};
    if (computerId) body.computerId = computerId;
    if (meta.ip) body.ip = meta.ip;
    if (meta.mac) body.mac = meta.mac;
    return api.post("/api/agents/stream/stop", body);
  },

  stopHostRtspStream: () => api.post("/api/agents/stream/host/stop", {}),
};

export default api;
