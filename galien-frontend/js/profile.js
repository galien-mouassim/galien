async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...getAuthHeaders(), ...(options.headers || {}) } });
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

let favoritesCache = [];
let flagsCache = [];
let editingFavoriteId = null;
let analyticsCache = null;
let selectedModuleForCourses = null;
let basicStatsCache = null;

function setActiveSection(name) {
  document.querySelectorAll('.profile-section').forEach((s) => {
    const active = s.id === `section-${name}`;
    s.classList.toggle('hidden', !active);
    s.classList.toggle('active', active);
  });
  document.querySelectorAll('.profile-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.section === name);
  });
}

function initProfileTabs() {
  document.querySelector('.profile-sidebar')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.profile-tab');
    if (!tab || !tab.dataset.section) return;
    setActiveSection(tab.dataset.section);
    if (tab.dataset.section === 'messages') loadMessages();
    if (tab.dataset.section === 'favorites') applyFavoriteFilters();
  });
}

function logout() {
  ['token', 'role', 'module_id', 'course_id', 'source_id', 'favorite_tags', 'question_limit', 'exam_minutes', 'correction_system', 'score', 'total', 'raw_total', 'elapsed_seconds', 'time_limit_seconds', 'exam_timeout', 'qcm_session_draft', 'pending_result_payload']
    .forEach((k) => localStorage.removeItem(k));
  window.location.href = 'login.html';
}

function normalizeTags(tags) {
  if (!tags) return [];
  return tags.split(',').map((t) => t.trim()).filter(Boolean);
}

function formatCorrection(label) {
  if (label === 'partiel_positive') return 'Partiel positif';
  if (label === 'partiel_negative') return 'Partiel negatif';
  return 'Tout ou rien';
}

function formatTime(seconds) {
  if (!Number.isFinite(Number(seconds))) return '-';
  const total = Number(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = Math.floor(total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatDuration(totalSeconds) {
  const secs = Number(totalSeconds || 0);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

function renderResults(rows) {
  if (!rows.length) return '<p class="muted">Aucun resultat pour le moment.</p>';
  return `<div class="result-header"><div>Session</div><div>Score</div><div>Temps</div><div>Correction</div></div>${rows.map((r) => {
    const pct = r.total ? Math.round((Number(r.score || 0) / Number(r.total || 1)) * 100) : 0;
    const date = new Date(r.created_at).toLocaleString('fr-FR');
    const qs = new URLSearchParams({
      session_id: String(r.id),
      score: String(Number(r.score || 0)),
      total: String(Number(r.total || 0)),
      elapsed_seconds: String(Number(r.elapsed_seconds || 0)),
      mode: String(r.mode || 'training'),
      correction_system: String(r.correction_system || 'tout_ou_rien')
    });
    return `<a class="result-row" href="result.html?${qs.toString()}" style="text-decoration:none;color:inherit;cursor:pointer"><div><strong style="text-transform:capitalize">${r.mode}</strong> <span class="muted">· ${date}</span></div><div><strong>${Number(r.score || 0).toFixed(2)}</strong> / ${r.total} <span class="muted">(${pct}%)</span></div><div>${formatTime(r.elapsed_seconds)}</div><div>${formatCorrection(r.correction_system || 'tout_ou_rien')}</div></a>`;
  }).join('')}`;
}

function renderSavedSessions(rows) {
  if (!rows.length) return '<p class="muted">Aucune session sauvegardee.</p>';
  return `<div class="result-header"><div>Session</div><div>Score</div><div>Temps</div><div>Actions</div></div>${rows.map((r) => {
    const pct = r.total ? Math.round((Number(r.score || 0) / Number(r.total || 1)) * 100) : 0;
    const date = new Date(r.created_at).toLocaleString('fr-FR');
    const name = r.session_name || `${r.mode === 'exam' ? 'Examen' : 'Entrainement'} ${date}`;
    const qs = new URLSearchParams({
      session_id: String(r.id),
      score: String(Number(r.score || 0)),
      total: String(Number(r.total || 0)),
      elapsed_seconds: String(Number(r.elapsed_seconds || 0)),
      mode: String(r.mode || 'training'),
      correction_system: String(r.correction_system || 'tout_ou_rien')
    });
    return `<div class="result-row saved-row"><div><a href="result.html?${qs.toString()}" style="text-decoration:none;color:inherit"><strong>${escHtml(name)}</strong></a><div class="muted">${date}</div></div><div><strong>${Number(r.score || 0).toFixed(2)}</strong> / ${r.total} <span class="muted">(${pct}%)</span></div><div>${formatTime(r.elapsed_seconds)}</div><div class="saved-edit"><input type="text" value="${escHtml(name)}" data-save-name="${r.id}" maxlength="120"><button class="btn-inline" data-save-rename="${r.id}"><i class="bi bi-pencil"></i> Renommer</button></div></div>`;
  }).join('')}`;
}

function renderFavoriteTags(tags) {
  if (!tags.length) return '';
  return `<div class="favorite-tags">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>`;
}

function renderFavoritesList(rows) {
  if (!rows.length) return '<p class="muted">Aucun favori.</p>';
  return rows.map((r) => {
    const tags = normalizeTags(r.tags);
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString('fr-FR') : '';
    return `
      <article class="favorite-item modern" data-favorite-id="${r.id}">
        <header class="favorite-head">
          <button type="button" class="favorite-title-btn" data-toggle-fav="${r.id}">
            <span class="favorite-title">${r.question}</span>
            <span class="favorite-chevron"><i class="bi bi-chevron-down"></i></span>
          </button>
          <span class="favorite-date">${date}</span>
        </header>
        <div class="favorite-meta-line">
          ${renderFavoriteTags(tags) || '<span class="muted">Aucun tag</span>'}
        </div>
        <div class="favorite-preview hidden" id="fav_preview_${r.id}">
          <div class="favorite-preview-q">${r.question}</div>
        </div>
        <footer class="favorite-actions">
          <button class="btn-inline favorite-edit" data-id="${r.id}" data-tags="${r.tags || ''}">
            <i class="bi bi-tags"></i> Modifier tags
          </button>
          <button class="btn-inline favorite-remove" data-id="${r.id}" style="color:var(--red)">
            <i class="bi bi-heartbreak"></i> Retirer
          </button>
        </footer>
      </article>
    `;
  }).join('');
}

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderFavoriteDetail(detail) {
  const opts = ['A', 'B', 'C', 'D', 'E']
    .map((l) => {
      const key = `option_${l.toLowerCase()}`;
      const val = detail[key];
      if (!val) return '';
      return `<div class="favorite-opt"><strong>${l}.</strong> ${escHtml(val)}</div>`;
    })
    .filter(Boolean)
    .join('');

  const comments = Array.isArray(detail.comments) ? detail.comments : [];
  const commentsHtml = comments.length
    ? comments.slice(0, 8).map((c) => {
        const author = c.display_name || c.email || 'Utilisateur';
        const date = c.created_at ? new Date(c.created_at).toLocaleString('fr-FR') : '';
        return `<div class="favorite-comment"><div><strong>${escHtml(author)}</strong> <span class="muted">${date}</span></div><div>${escHtml(c.body)}</div></div>`;
      }).join('')
    : '<div class="muted">Aucun commentaire.</div>';

  const correct = Array.isArray(detail.correct_options) ? detail.correct_options.join(', ') : '-';
  const note = detail.user_note ? escHtml(detail.user_note) : '<span class="muted">Aucune note personnelle.</span>';

  return `
    <div class="favorite-detail-grid">
      <div><strong>Module:</strong> ${escHtml(detail.module_name || '-')}</div>
      <div><strong>Cours:</strong> ${escHtml(detail.course_name || '-')}</div>
      <div><strong>Source:</strong> ${escHtml(detail.source_name || '-')}</div>
      <div><strong>Correction:</strong> ${escHtml(correct)}</div>
    </div>
    <div class="favorite-detail-block">
      <strong>Propositions</strong>
      ${opts || '<div class="muted">-</div>'}
    </div>
    <div class="favorite-detail-block">
      <strong>Explication</strong>
      <div>${detail.explanation ? escHtml(detail.explanation) : '<span class="muted">Aucune explication.</span>'}</div>
    </div>
    <div class="favorite-detail-block">
      <strong>Ma note</strong>
      <div>${note}</div>
    </div>
    <div class="favorite-detail-block">
      <strong>Commentaires (${comments.length})</strong>
      ${commentsHtml}
    </div>
  `;
}

function fillFavoriteTagFilter(rows) {
  const select = document.getElementById('favoriteTagFilter');
  if (!select) return;
  const set = new Set();
  rows.forEach((r) => normalizeTags(r.tags).forEach((t) => set.add(t)));
  const tags = Array.from(set).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Tous les tags</option>' + tags.map((t) => `<option value="${t}">${t}</option>`).join('');
}

function applyFavoriteFilters() {
  const tag = document.getElementById('favoriteTagFilter')?.value || '';
  const sort = document.getElementById('favoriteSort')?.value || 'recent';
  const search = (document.getElementById('favoriteSearch')?.value || '').toLowerCase().trim();

  let rows = favoritesCache.slice();
  if (tag) rows = rows.filter((r) => normalizeTags(r.tags).includes(tag));
  if (search) rows = rows.filter((r) => (r.question || '').toLowerCase().includes(search));
  if (sort === 'alpha') rows.sort((a, b) => (a.question || '').localeCompare(b.question || ''));
  else if (sort === 'oldest') rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  else rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  document.getElementById('favoritesList').innerHTML = renderFavoritesList(rows);
}

function renderFlagList(rows) {
  if (!rows.length) return '<p class="muted">Aucun signalement.</p>';
  return rows.map((r) => {
    const date = r.created_at ? new Date(r.created_at).toLocaleString('fr-FR') : '';
    const isResolved = !!r.resolved;
    return `<div class="flag-item ${isResolved ? 'resolved' : ''}"><div class="flag-question">${r.question || 'Question non disponible'}</div>${r.reason ? `<div class="flag-reason"><strong>Votre signalement :</strong> ${r.reason}</div>` : ''}<div class="flag-meta"><span class="flag-status ${isResolved ? 'resolved' : 'pending'}">${isResolved ? 'Resolu' : 'En attente'}</span><span>${date}</span></div><div class="flag-actions">${!isResolved ? `<button class="btn-inline report-remove" data-id="${r.id}" style="color:var(--red)"><i class="bi bi-x-circle"></i> Retirer</button>` : ''}</div></div>`;
  }).join('');
}

function renderMessages(rows) {
  if (!rows.length) return '<p class="muted">Aucun message.</p>';
  return rows.map((r) => {
    const date = r.created_at ? new Date(r.created_at).toLocaleString('fr-FR') : '';
    const sender = r.sender_name || r.sender_email || 'Admin';
    return `<div class="message-item ${!r.read_at ? 'unread' : ''}"><div class="message-meta"><span><strong>${sender}</strong></span><span>${date}</span></div><div class="message-body">${r.body}</div></div>`;
  }).join('');
}

function renderAnalytics(analytics, basicStats) {
  const profileStats = document.getElementById('profileStats');
  const insights = document.getElementById('statsInsights');
  const moduleWrap = document.getElementById('moduleScoresWrap');
  const courseWrap = document.getElementById('courseScoresWrap');
  const failedWrap = document.getElementById('failedQuestionsWrap');
  const timelineWrap = document.getElementById('timelineWrap');
  if (!profileStats || !insights || !moduleWrap || !courseWrap || !failedWrap || !timelineWrap) return;

  const sessions = analytics?.sessions || {};
  const qp = analytics?.questions_progress || {};
  const timeline = analytics?.progression_timeline || {};
  const avgPercent = basicStats?.avg_percent ? Math.round(Number(basicStats.avg_percent)) : 0;

  profileStats.innerHTML = `
    <div class="stat-item"><div class="stat-val">${sessions.total || 0}</div><div class="stat-lbl">Sessions</div></div>
    <div class="stat-item"><div class="stat-val">${sessions.training || 0}</div><div class="stat-lbl">Entrainement</div></div>
    <div class="stat-item"><div class="stat-val">${sessions.exam || 0}</div><div class="stat-lbl">Examen</div></div>
    <div class="stat-item"><div class="stat-val">${avgPercent}%</div><div class="stat-lbl">Moyenne globale</div></div>
    <div class="stat-item"><div class="stat-val">${qp.unique_done || 0} / ${qp.total_questions || 0}</div><div class="stat-lbl">Questions uniques faites</div></div>
    <div class="stat-item"><div class="stat-val">${qp.done_with_duplicates || 0}</div><div class="stat-lbl">Questions faites (doublons inclus)</div></div>
  `;

  insights.innerHTML = `
    <div class="analytics-pill"><div class="k">Temps total revise</div><div class="v">${formatDuration(analytics?.total_revision_seconds || 0)}</div></div>
    <div class="analytics-pill"><div class="k">Streak</div><div class="v">${analytics?.streak_days || 0} jours</div></div>
    <div class="analytics-pill"><div class="k">Favoris</div><div class="v">${analytics?.favorites_count || 0}</div></div>
    <div class="analytics-pill"><div class="k">Cours le plus maitrise</div><div class="v">${analytics?.strongest_course?.course_name || '-'}</div></div>
    <div class="analytics-pill"><div class="k">Cours le plus faible</div><div class="v">${analytics?.weakest_course?.course_name || '-'}</div></div>
    <div class="analytics-pill"><div class="k">Tendance</div><div class="v">${timeline.improving == null ? '-' : (timeline.improving ? 'En progression' : 'A retravailler')}</div></div>
  `;

  const modules = analytics?.avg_score_by_module || [];
  moduleWrap.innerHTML = `<h4>Score moyen par module (cliquer pour voir les cours)</h4>
    <div class="score-list">
      ${modules.length
        ? modules.map((m) => {
            const id = m.module_id == null ? 'none' : String(m.module_id);
            const active = selectedModuleForCourses === id;
            return `<button type="button" class="score-chip ${active ? 'active' : ''}" data-module-score="${id}">
              <strong>${m.module_name || 'Sans module'}</strong>
              <small>${Number(m.avg_percent || 0).toFixed(1)}% · ${m.attempts} tentatives</small>
            </button>`;
          }).join('')
        : '<span class="muted">Aucune donnee.</span>'}
    </div>`;

  const courses = analytics?.avg_score_by_course || [];
  const filteredCourses = selectedModuleForCourses == null
    ? courses
    : courses.filter((c) => String(c.module_id == null ? 'none' : c.module_id) === selectedModuleForCourses);
  courseWrap.innerHTML = `<h4>Scores par cours${selectedModuleForCourses == null ? '' : ' (module selectionne)'}</h4>
    <div class="mini-table">
      ${filteredCourses.length
        ? filteredCourses.slice(0, 20).map((c) => `
          <div class="mini-row">
            <div>${c.course_name || 'Sans cours'} <div class="muted">${c.attempts} tentatives</div></div>
            <div class="pct ${Number(c.avg_percent || 0) >= 60 ? 'good' : 'bad'}">${Number(c.avg_percent || 0).toFixed(1)}%</div>
            <div></div>
          </div>
        `).join('')
        : '<span class="muted">Aucun cours pour ce module.</span>'}
    </div>`;

  const failedRows = analytics?.most_failed_questions_top10 || [];
  failedWrap.innerHTML = `<h4>Top 10 questions les plus ratees</h4>
    <div class="mini-table">
      ${failedRows.length
        ? failedRows.map((r) => `
          <div class="mini-row">
            <div>${escHtml(r.question || '')}</div>
            <div class="pct bad">${Number(r.fail_rate_percent || 0).toFixed(1)}%</div>
            <div class="muted">${r.fail_count}/${r.attempts}</div>
          </div>
        `).join('')
        : '<span class="muted">Pas assez de tentatives.</span>'}
    </div>`;

  const trend = timeline.trend_delta_percent;
  const daily = Array.isArray(timeline.by_day) ? timeline.by_day : [];
  timelineWrap.innerHTML = `<h4>Progression dans le temps</h4>
    <div class="timeline-note">
      ${trend == null ? 'Pas assez de donnees pour la tendance.' : `Variation recente: ${trend > 0 ? '+' : ''}${trend}%`}
    </div>
    <div class="timeline-list">
      ${daily.slice(-10).map((d) => `<div class="timeline-day"><span>${new Date(d.day).toLocaleDateString('fr-FR')}</span><strong>${Number(d.avg_percent || 0).toFixed(1)}%</strong></div>`).join('')}
    </div>`;
}

async function loadMessages() {
  const list = document.getElementById('messagesList');
  if (!list) return;
  list.innerHTML = '<div class="loading-wrap"><div class="spinner"></div></div>';
  try {
    const rows = await fetchJSON(`${API_URL}/messages`);
    list.innerHTML = renderMessages(rows);
    const unreadIds = rows.filter((r) => !r.read_at).map((r) => r.id);
    if (unreadIds.length) {
      await fetchJSON(`${API_URL}/messages/mark-read`, { method: 'POST', body: JSON.stringify({ ids: unreadIds }) });
    }
    await loadUnreadCount();
  } catch (_) {
    list.innerHTML = '<p class="muted">Impossible de charger les messages.</p>';
  }
}

async function loadUnreadCount() {
  const badge = document.getElementById('messageBadge');
  if (!badge) return;
  try {
    const data = await fetchJSON(`${API_URL}/messages/unread-count`);
    const unread = Number(data.unread || 0);
    badge.textContent = String(unread);
    badge.classList.toggle('hidden', unread === 0);
  } catch (_) {}
}

function getBaseUrl() { return API_URL.replace(/\/api\/?$/, ''); }
function resolvePhotoUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
  return `${getBaseUrl()}${v}`;
}

async function loadProfile() {
  if (!localStorage.getItem('token')) { window.location.href = 'login.html'; return; }

  try {
    const [me, stats, prefs, results, savedResults, favorites, flags, analytics] = await Promise.all([
      fetchJSON(`${API_URL}/users/me`),
      fetchJSON(`${API_URL}/users/stats`),
      fetchJSON(`${API_URL}/users/preferences`),
      fetchJSON(`${API_URL}/users/results?saved=all`),
      fetchJSON(`${API_URL}/users/results?saved=1`),
      fetchJSON(`${API_URL}/users/flags?type=favorite`),
      fetchJSON(`${API_URL}/users/flags?type=flag`),
      fetchJSON(`${API_URL}/users/analytics`)
    ]);

    await loadUnreadCount();

    document.getElementById('profileInfo').innerHTML = `<p><strong>Email</strong><br>${me.email}</p><p><strong>Role</strong><br><span style="text-transform:capitalize">${me.role}</span></p>`;
    document.getElementById('display_name').value = me.display_name || '';
    const adminShortcutTab = document.getElementById('adminShortcutTab');
    if (adminShortcutTab) {
      adminShortcutTab.classList.toggle('hidden', me.role !== 'admin');
    }

    const fallback = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="%23f1f5f9"/><circle cx="48" cy="36" r="16" fill="%23ccfbf1"/><path d="M16 86c6-16 20-24 32-24s26 8 32 24" fill="%23ccfbf1"/></svg>`;
    const photoUrl = me.profile_photo ? resolvePhotoUrl(me.profile_photo) : fallback;
    document.getElementById('profilePhoto').src = photoUrl;
    document.getElementById('sidebarPhoto').src = photoUrl;
    document.getElementById('sidebarDisplayName').textContent = me.display_name || me.email || 'Utilisateur';

    basicStatsCache = stats || null;
    analyticsCache = analytics || null;
    selectedModuleForCourses = null;
    renderAnalytics(analyticsCache, basicStatsCache);

    document.getElementById('default_exam_minutes').value = prefs.default_exam_minutes || '';
    document.getElementById('default_correction_system').value = prefs.correction_system || 'tout_ou_rien';
    document.getElementById('pref_auto_next_enabled').value = prefs.auto_next_enabled ? '1' : '0';
    document.getElementById('pref_auto_next_delay_sec').value = Number(prefs.auto_next_delay_sec || 2);
    document.getElementById('pref_show_explanation_auto').value = prefs.show_explanation_auto === false ? '0' : '1';
    document.getElementById('pref_show_notes_inline').value = prefs.show_notes_inline ? '1' : '0';
    document.getElementById('pref_theme_preference').value = prefs.theme_preference || 'system';
    localStorage.setItem('show_notes_inline', prefs.show_notes_inline ? '1' : '0');
    localStorage.setItem('show_explanation_auto', prefs.show_explanation_auto === false ? '0' : '1');
    const themePref = prefs.theme_preference || 'system';
    localStorage.setItem('theme_preference', themePref);
    if (themePref === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', themePref);
    if (window.__applyThemePreference) window.__applyThemePreference();

    document.getElementById('resultsTable').innerHTML = renderResults(results);
    document.getElementById('savedSessionsTable').innerHTML = renderSavedSessions(savedResults);

    favoritesCache = favorites;
    fillFavoriteTagFilter(favoritesCache);
    applyFavoriteFilters();

    flagsCache = flags;
    document.getElementById('flagsList').innerHTML = renderFlagList(flagsCache);
  } catch (err) {
    console.error('Profile load error:', err);
  }
}

async function saveProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const displayName = document.getElementById('display_name').value.trim();
  btn.textContent = '...';
  try {
    await fetchJSON(`${API_URL}/users/me`, { method: 'PUT', body: JSON.stringify({ display_name: displayName }) });
    btn.innerHTML = '<i class="bi bi-check2"></i> Enregistre';
    setTimeout(() => { btn.textContent = 'Enregistrer'; }, 1400);
    loadProfile();
  } catch (_) {
    btn.textContent = 'Enregistrer';
  }
}

async function savePrefs() {
  const btn = document.getElementById('savePrefsBtn');
  const defaultExam = document.getElementById('default_exam_minutes').value || null;
  const correction = document.getElementById('default_correction_system').value;
  const autoNextEnabled = document.getElementById('pref_auto_next_enabled').value === '1';
  const autoNextDelaySec = Number(document.getElementById('pref_auto_next_delay_sec').value || 2);
  const showExplanationAuto = document.getElementById('pref_show_explanation_auto').value === '1';
  const showNotesInline = document.getElementById('pref_show_notes_inline').value === '1';
  const themePreference = document.getElementById('pref_theme_preference').value || 'system';
  btn.textContent = '...';
  try {
    await fetchJSON(`${API_URL}/users/preferences`, {
      method: 'PUT',
      body: JSON.stringify({
        default_exam_minutes: defaultExam,
        correction_system: correction,
        auto_next_enabled: autoNextEnabled,
        auto_next_delay_sec: autoNextDelaySec,
        show_explanation_auto: showExplanationAuto,
        show_notes_inline: showNotesInline,
        theme_preference: themePreference
      })
    });
    localStorage.setItem('show_notes_inline', showNotesInline ? '1' : '0');
    localStorage.setItem('show_explanation_auto', showExplanationAuto ? '1' : '0');
    localStorage.setItem('theme_preference', themePreference);
    if (themePreference === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', themePreference);
    if (window.__applyThemePreference) window.__applyThemePreference();
    btn.innerHTML = '<i class="bi bi-check2"></i> Enregistre';
    setTimeout(() => { btn.textContent = 'Enregistrer'; }, 1400);
  } catch (_) {
    btn.textContent = 'Enregistrer';
  }
}

async function uploadPhoto() {
  const input = document.getElementById('photoInput');
  if (!input.files || !input.files[0]) return;
  const btn = document.getElementById('uploadPhotoBtn');
  btn.textContent = 'Envoi...';
  try {
    const formData = new FormData();
    formData.append('photo', input.files[0]);
    const res = await fetch(`${API_URL}/users/me/photo`, {
      method: 'POST',
      headers: { Authorization: getAuthHeaders().Authorization },
      body: formData
    });
    if (res.ok) {
      btn.textContent = 'Mis a jour';
      await loadProfile();
    } else {
      btn.textContent = 'Mettre a jour';
    }
  } catch (_) {
    btn.textContent = 'Mettre a jour';
  }
}

function openFavoriteTagModal(id, tags) {
  editingFavoriteId = id;
  const modal = document.getElementById('favoriteTagModal');
  const input = document.getElementById('favoriteTagInput');
  if (input) input.value = tags || '';
  modal?.classList.remove('hidden');
}

function closeFavoriteTagModal() {
  editingFavoriteId = null;
  document.getElementById('favoriteTagModal')?.classList.add('hidden');
}

document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
document.getElementById('savePrefsBtn').addEventListener('click', savePrefs);
document.getElementById('uploadPhotoBtn').addEventListener('click', uploadPhoto);
document.getElementById('refreshMessagesBtn')?.addEventListener('click', loadMessages);
document.getElementById('favoriteTagFilter')?.addEventListener('change', applyFavoriteFilters);
document.getElementById('favoriteSort')?.addEventListener('change', applyFavoriteFilters);
document.getElementById('favoriteSearch')?.addEventListener('input', applyFavoriteFilters);
document.getElementById('favoriteTagCancelBtn')?.addEventListener('click', closeFavoriteTagModal);
document.getElementById('favoriteTagSaveBtn')?.addEventListener('click', async () => {
  if (!editingFavoriteId) return;
  const tags = (document.getElementById('favoriteTagInput')?.value || '').trim();
  try {
    await fetchJSON(`${API_URL}/users/questions/${editingFavoriteId}/flag`, { method: 'POST', body: JSON.stringify({ flag_type: 'favorite', tags }) });
    const idx = favoritesCache.findIndex((f) => String(f.id) === String(editingFavoriteId));
    if (idx !== -1) favoritesCache[idx].tags = tags;
    fillFavoriteTagFilter(favoritesCache);
    applyFavoriteFilters();
    closeFavoriteTagModal();
  } catch (_) {}
});

document.getElementById('favoritesList')?.addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('[data-toggle-fav]');
  if (toggleBtn) {
    const id = toggleBtn.getAttribute('data-toggle-fav');
    const panel = document.getElementById(`fav_preview_${id}`);
    const card = e.target.closest('.favorite-item');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    card?.classList.toggle('expanded', isHidden);
    if (!isHidden) return;
    if (panel.dataset.loaded === '1') return;
    panel.innerHTML = '<div class="muted">Chargement...</div>';
    try {
      const detail = await fetchJSON(`${API_URL}/users/questions/${id}/detail`);
      panel.innerHTML = renderFavoriteDetail(detail);
      panel.dataset.loaded = '1';
    } catch (_) {
      panel.innerHTML = '<div class="muted">Impossible de charger les details.</div>';
    }
    return;
  }

  const removeBtn = e.target.closest('.favorite-remove');
  const editBtn = e.target.closest('.favorite-edit');

  if (removeBtn) {
    const id = removeBtn.getAttribute('data-id');
    if (!id) return;
    removeBtn.textContent = '...';
    try {
      await fetchJSON(`${API_URL}/users/questions/${id}/flag?type=favorite`, { method: 'DELETE' });
      favoritesCache = favoritesCache.filter((f) => String(f.id) !== String(id));
      fillFavoriteTagFilter(favoritesCache);
      applyFavoriteFilters();
    } catch (_) {
      removeBtn.innerHTML = '<i class="bi bi-heart-slash"></i> Retirer';
    }
  }

  if (editBtn) {
    const id = editBtn.getAttribute('data-id');
    const tags = editBtn.getAttribute('data-tags') || '';
    openFavoriteTagModal(id, tags);
  }
});

document.getElementById('flagsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.report-remove');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!id) return;
  if (!window.confirm('Retirer ce signalement ?')) return;
  btn.textContent = '...';
  try {
    await fetchJSON(`${API_URL}/users/reports/${id}`, { method: 'DELETE' });
    loadProfile();
  } catch (_) {
    btn.innerHTML = '<i class="bi bi-x-circle"></i> Retirer';
  }
});

document.getElementById('savedSessionsTable')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save-rename]');
  if (!btn) return;
  const id = btn.getAttribute('data-save-rename');
  const input = document.querySelector(`[data-save-name="${id}"]`);
  if (!id || !input) return;
  const name = (input.value || '').trim();
  btn.textContent = '...';
  try {
    await fetchJSON(`${API_URL}/results/${id}/meta`, {
      method: 'PATCH',
      body: JSON.stringify({ session_name: name, is_saved: true })
    });
    btn.innerHTML = '<i class="bi bi-check2"></i> OK';
    setTimeout(() => loadProfile(), 350);
  } catch (_) {
    btn.innerHTML = '<i class="bi bi-pencil"></i> Renommer';
  }
});

document.getElementById('profilePhoto')?.addEventListener('click', () => {
  const src = document.getElementById('profilePhoto')?.getAttribute('src') || '';
  if (!src) return;
  const img = document.getElementById('photoViewerImage');
  if (img) img.src = src;
  document.getElementById('photoViewerModal')?.classList.remove('hidden');
});
document.getElementById('photoViewerCloseBtn')?.addEventListener('click', () => {
  document.getElementById('photoViewerModal')?.classList.add('hidden');
});

initProfileTabs();
setActiveSection('profile');
document.getElementById('sidebarLogoutBtn')?.addEventListener('click', logout);
document.getElementById('adminShortcutTab')?.addEventListener('click', () => {
  window.location.href = 'admin.html';
});
loadProfile();

document.getElementById('moduleScoresWrap')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-module-score]');
  if (!btn || !analyticsCache) return;
  const id = btn.getAttribute('data-module-score');
  selectedModuleForCourses = selectedModuleForCourses === id ? null : id;
  renderAnalytics(analyticsCache, basicStatsCache || {});
});
