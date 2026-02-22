(function () {
  const KEY = 'theme';
  const PREF_KEY = 'theme_preference';

  function getThemePreference() {
    try {
      const pref = localStorage.getItem(PREF_KEY);
      if (pref === 'system' || pref === 'light' || pref === 'dark') return pref;
      const legacy = localStorage.getItem(KEY);
      if (legacy === 'light' || legacy === 'dark') return legacy;
    } catch (_) {}
    return 'system';
  }

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function applyThemePreference() {
    const pref = getThemePreference();
    const resolved = resolveTheme(pref);
    applyTheme(resolved);
    return { pref, resolved };
  }

  window.__applyThemePreference = applyThemePreference;

  function renderToggle(initialResolved) {
    if (document.getElementById('themeToggle')) return;
    const btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.className = 'theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Changer le theme');

    const updateBtn = (resolved) => {
      btn.title = resolved === 'dark' ? 'Passer en mode clair' : 'Passer en mode nuit';
      btn.innerHTML = resolved === 'dark' ? '☀' : '🌙';
    };
    updateBtn(initialResolved);

    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(PREF_KEY, next);
        localStorage.setItem(KEY, next);
      } catch (_) {}
      updateBtn(next);
    });

    document.body.appendChild(btn);
  }

  const initial = applyThemePreference();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => renderToggle(initial.resolved));
  } else {
    renderToggle(initial.resolved);
  }

  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media) {
    media.addEventListener('change', () => {
      if (getThemePreference() === 'system') {
        const applied = applyThemePreference();
        const btn = document.getElementById('themeToggle');
        if (btn) btn.innerHTML = applied.resolved === 'dark' ? '☀' : '🌙';
      }
    });
  }
})();
