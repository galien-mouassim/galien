if (!window.API_URL) {
  const PROD_BACKEND_URL = 'https://galien.onrender.com/api';
  const host = String(window.location.hostname || '').toLowerCase();
  const isFile = window.location.protocol === 'file:';
  const isPrivateHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  const isVercelHost = host.endsWith('.vercel.app');
  const forced = localStorage.getItem('api_url_override');
  const runtimeOverride = window.__API_BASE__;
  window.API_URL = forced
    || runtimeOverride
    || (isFile || isPrivateHost
      ? 'http://localhost:5000/api'
      : (isVercelHost ? PROD_BACKEND_URL : `${window.location.origin}/api`));
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
