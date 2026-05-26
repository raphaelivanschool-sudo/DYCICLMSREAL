const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function authHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const sessionContextService = {
  async getStudentContext() {
    const resp = await fetch(`${API_BASE_URL}/api/session-context/student`, {
      headers: authHeaders(),
    });
    const data = await safeJson(resp);
    if (!resp.ok) {
      throw new Error(data?.error || data?.message || 'Failed to load student session context');
    }
    return data;
  },

  async getInstructorContext() {
    const resp = await fetch(`${API_BASE_URL}/api/session-context/instructor`, {
      headers: authHeaders(),
    });
    const data = await safeJson(resp);
    if (!resp.ok) {
      throw new Error(data?.error || data?.message || 'Failed to load instructor session context');
    }
    return data;
  },
};

export default sessionContextService;

