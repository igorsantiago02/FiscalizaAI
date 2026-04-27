const API_BASE = import.meta.env.VITE_API_URL || 'https://fiscalizaai-backend.onrender.com';const API_BASE = import.meta.env.VITE_API_URL || 'https://fiscalizaai-backend.onrender.com';
const TOKEN_KEY = 'fiscalizaai_admin_token';
const USER_KEY = 'fiscalizaai_admin_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function setSession(accessToken, user) {
  if (accessToken) setToken(accessToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

let refreshPromise = null;

async function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.accessToken) {
          throw new Error(data.error || 'Sessão expirada.');
        }
        setSession(data.accessToken, data.user);
        return data;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function request(url, options = {}, retry = true) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (options.auth && token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers,
    credentials: 'include'
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && options.auth && retry) {
    try {
      await refreshSession();
      return request(url, options, false);
    } catch {
      clearSession();
    }
  }

  if (!res.ok) {
    const message = data.error || `Falha em ${url}`;
    const error = new Error(message);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export function apiGet(url, options = {}) {
  return request(url, { method: 'GET', auth: options.auth || false });
}

export function apiSend(url, method, body, options = {}) {
  return request(url, {
    method,
    auth: options.auth || false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export function loginAdmin(email, password) {
  return apiSend('/api/auth/login', 'POST', { email, password });
}

export function fetchMe() {
  return apiGet('/api/auth/me', { auth: true });
}

export function logoutAdmin() {
  return apiSend('/api/auth/logout', 'POST', {}, { auth: true });
}

