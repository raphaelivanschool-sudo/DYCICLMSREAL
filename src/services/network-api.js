import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Create axios instance with auth headers
const apiClient = axios.create({
  baseURL: API_BASE_URL,
});

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

const networkApi = {
  // Start network scan
  async startScan(range = null) {
    try {
      const response = await apiClient.post('/api/network/scan', { range });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to start network scan');
    }
  },

  // Start server-local scan across active subnets
  async startServerScan() {
    try {
      const response = await apiClient.post('/api/network/server-scan', {});
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to start server scan');
    }
  },

  // Get scan status
  async getScanStatus() {
    try {
      const response = await apiClient.get('/api/network/status');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to get scan status');
    }
  },

  // Get discovered devices
  async getDiscoveredDevices() {
    try {
      const response = await apiClient.get('/api/network/devices');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to get discovered devices');
    }
  },

  // Cancel active scan
  async cancelScan() {
    try {
      const response = await apiClient.post('/api/network/cancel');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to cancel scan');
    }
  },

  // Register discovered device
  async registerDevice(deviceData) {
    try {
      const response = await apiClient.post('/api/network/register', deviceData);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to register device');
    }
  }
};

export default networkApi;
