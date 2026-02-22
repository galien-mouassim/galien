async function login() {
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const btn = document.getElementById('loginBtn') || document.querySelector('button[onclick="login()"]');
  const msg = document.getElementById('msg');
  if (!emailInput || !passwordInput || !btn || !msg) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    msg.textContent = 'Veuillez remplir tous les champs.';
    return;
  }

  btn.disabled = true;
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
      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      if (next) {
        window.location.href = next;
      } else {
        window.location.href = (data.role === 'admin') ? 'admin.html' : 'dashboard.html';
      }
    } else {
      msg.textContent = data.message || 'Identifiants incorrects.';
    }
  } catch (err) {
    msg.textContent = 'Erreur reseau. Veuillez reessayer.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Se connecter';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
