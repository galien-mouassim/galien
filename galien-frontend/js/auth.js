let loginInFlight = false;

async function login() {
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const btn = document.getElementById('loginBtn') || document.querySelector('button[onclick="login()"]');
  const msg = document.getElementById('msg');
  if (!emailInput || !passwordInput || !btn || !msg) return;
  if (loginInFlight || btn.disabled) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    msg.textContent = 'Veuillez remplir tous les champs.';
    return;
  }

  btn.disabled = true;
  loginInFlight = true;
  btn.textContent = 'Connexion...';
  msg.textContent = '';

  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('role', data.role || '');
      localStorage.setItem('is_active', data.is_active === false ? 'false' : 'true');
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      if (data.is_active === false) {
        window.location.href = 'profile.html';
      } else if (next) {
        window.location.href = next;
      } else {
        window.location.href = (data.role === 'admin' || data.role === 'manager' || data.role === 'worker') ? 'admin.html' : 'dashboard.html';
      }
    } else {
      msg.textContent = data.message || 'Identifiants incorrects.';
    }
  } catch (err) {
    msg.textContent = 'Erreur reseau. Veuillez reessayer.';
  } finally {
    loginInFlight = false;
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat) return;
  const active = document.activeElement;
  const id = (active && active.id) || '';
  if (id === 'email' || id === 'password') login();
});
