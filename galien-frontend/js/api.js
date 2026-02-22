if (!window.API_URL) {
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  window.API_URL = isLocal
    ? 'http://localhost:5000/api'
    : `${window.location.origin}/api`;
}

(function enforceRouteAuth() {
  const path = (window.location.pathname || '').toLowerCase();
  const isPublic = path.endsWith('/index.html') || path.endsWith('/login.html') || path === '/' || path.endsWith('/galien-frontend/');
  const token = localStorage.getItem('token');
  if (!token && !isPublic) {
    const next = encodeURIComponent((window.location.pathname || '') + (window.location.search || ''));
    window.location.href = `login.html?next=${next}`;
  }
})();

function clearAuthState() {
  const keys = [
    'token',
    'role',
    'module_id',
    'favorite_tags',
    'question_limit',
    'exam_minutes',
    'correction_system',
    'score',
    'total',
    'raw_total',
    'elapsed_seconds',
    'time_limit_seconds',
    'exam_timeout'
  ];
  keys.forEach(k => localStorage.removeItem(k));
}

if (!window.__galienFetchWrapped) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    const url = String(args[0] || '');
    const isLoginCall = url.includes('/api/auth/login');

    if (res.status === 401 && !isLoginCall) {
      clearAuthState();
      if (!window.location.pathname.toLowerCase().endsWith('login.html')) {
        window.location.href = 'login.html?reason=session';
      }
    }

    return res;
  };
  window.__galienFetchWrapped = true;
}

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}
