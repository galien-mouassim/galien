(function () {
  const currentPath = (window.location.pathname || '').toLowerCase();
  const currentFile = currentPath.split('/').pop() || '';
  if (currentFile !== 'qcm.html') {
    return;
  }

  function addProfileMenu(photoUrl, unread = 0) {
    if (document.querySelector('.profile-menu')) return;
    const wrap = document.createElement('div');
    wrap.className = 'profile-menu';

    const btn = document.createElement('button');
    btn.className = 'profile-trigger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Menu profil');

    const img = document.createElement('img');
    img.className = 'profile-link-img';
    img.alt = 'Profil';
    img.src = photoUrl;

    btn.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'profile-badge' + (unread > 0 ? '' : ' hidden');
    badge.textContent = unread > 0 ? String(unread) : '';
    btn.appendChild(badge);

    const menu = document.createElement('div');
    menu.className = 'profile-menu-list hidden';
    menu.innerHTML = `
      <a class="profile-menu-item" href="profile.html">Mon profil</a>
      <button class="profile-menu-item logout" type="button">Deconnexion</button>
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    menu.querySelector('.logout')?.addEventListener('click', () => {
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
      window.location.href = 'login.html';
    });

    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    document.body.appendChild(wrap);
  }

  const fallback = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect width="36" height="36" rx="18" fill="%23f2f5f3"/><circle cx="18" cy="14" r="6" fill="%23cfe8e6"/><path d="M6 32c3-6 8-9 12-9s9 3 12 9" fill="%23cfe8e6"/></svg>';

  if (typeof API_URL !== 'string') {
    addProfileMenu(fallback);
    return;
  }

  function getBaseUrl() {
    return API_URL.replace(/\/api\/?$/, '');
  }

  function resolvePhotoUrl(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
    const base = getBaseUrl();
    return base ? `${base}${v}` : v;
  }

  const token = localStorage.getItem('token');
  if (!token) {
    addProfileMenu(fallback);
    return;
  }

  Promise.all([
    fetch(`${API_URL}/users/me`, {
      headers: { Authorization: 'Bearer ' + token }
    }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${API_URL}/messages/unread-count`, {
      headers: { Authorization: 'Bearer ' + token }
    }).then(r => r.ok ? r.json() : { unread: 0 }).catch(() => ({ unread: 0 }))
  ])
    .then(([me, count]) => {
      const unread = count && typeof count.unread === 'number' ? count.unread : 0;
      if (!me || !me.profile_photo) {
        addProfileMenu(fallback, unread);
        return;
      }
      const url = resolvePhotoUrl(me.profile_photo);
      addProfileMenu(url, unread);
    })
    .catch(() => addProfileMenu(fallback));
})();

