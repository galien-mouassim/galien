async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...getAuthHeaders(), ...(options.headers || {}) } });
  if (!res.ok) {
    let msg = 'Request failed';
    try {
      const payload = await res.json();
      if (payload?.message) msg = payload.message;
      else if (payload?.error) msg = payload.error;
    } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

let favoritesCache = [];
let flagsCache = [];
let editingFavoriteId = null;
let analyticsCache = null;
let selectedModuleForCourses = null;
let basicStatsCache = null;
let referencesCache = { modules: [], courses: [], sources: [] };
let failedFilterState = { module_id: '', course_id: '', source_id: '' };
let failedOverrideRows = null;
let notesCache = [];
let notesPage = 1;
let notesTotalPages = 1;
let noteEditingQuestionId = null;
const noteFilters = { module_id: '', course_id: '', source_id: '', fav_tag: '', search: '', sort: 'recent' };

let historyPage = 1;
let historyLoaded = false;
let savedPage = 1;
let savedLoaded = false;
const RESULTS_PAGE_SIZE = 20;

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
    if (tab.dataset.section === 'notes') loadNotes(1);
    if (tab.dataset.section === 'history' && !historyLoaded) loadHistoryPage(1);
    if (tab.dataset.section === 'saved' && !savedLoaded) loadSavedPage(1);
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

function formatActiveUntil(value) {
  if (!value) return 'Illimitee';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Illimitee';
  return d.toLocaleString('fr-FR');
}

function renderResults(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-icon">📋</div><p class="muted">Aucun résultat pour le moment.</p></div>';
  return `<div class="session-list">${rows.map((r) => {
    const pct = r.total ? Math.round((Number(r.score || 0) / Number(r.total || 1)) * 100) : 0;
    const scoreClass = pct >= 70 ? 'score-ok' : pct >= 50 ? 'score-mid' : 'score-low';
    const date = new Date(r.created_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const modeLabel = r.mode === 'exam' ? 'Examen' : 'Entraînement';
    const modeClass = r.mode === 'exam' ? 'badge-exam' : 'badge-train';
    const qs = new URLSearchParams({
      session_id: String(r.id),
      score: String(Number(r.score || 0)),
      total: String(Number(r.total || 0)),
      elapsed_seconds: String(Number(r.elapsed_seconds || 0)),
      mode: String(r.mode || 'training'),
      correction_system: String(r.correction_system || 'tout_ou_rien')
    });
    return `<a class="session-card" href="result.html?${qs.toString()}">
      <div class="session-card-body">
        <div class="session-card-top">
          <span class="session-badge ${modeClass}">${modeLabel}</span>
          <span class="session-card-date">${date}</span>
        </div>
        <div class="session-card-bottom">
          <span class="session-info-label">${formatCorrection(r.correction_system || 'tout_ou_rien')}</span>
          <span class="session-info-label">⏱ ${formatTime(r.elapsed_seconds)}</span>
        </div>
      </div>
      <div class="session-score-block ${scoreClass}">
        <span class="session-pct">${pct}%</span>
        <span class="session-raw">${Number(r.score || 0).toFixed(1)} / ${r.total}</span>
      </div>
    </a>`;
  }).join('')}</div>`;
}

function renderSavedSessions(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-icon">🔖</div><p class="muted">Aucune session sauvegardée.</p></div>';
  return `<div class="session-list">${rows.map((r) => {
    const pct = r.total ? Math.round((Number(r.score || 0) / Number(r.total || 1)) * 100) : 0;
    const scoreClass = pct >= 70 ? 'score-ok' : pct >= 50 ? 'score-mid' : 'score-low';
    const date = new Date(r.created_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const name = r.session_name || `${r.mode === 'exam' ? 'Examen' : 'Entraînement'} · ${date}`;
    const modeClass = r.mode === 'exam' ? 'badge-exam' : 'badge-train';
    const qs = new URLSearchParams({
      session_id: String(r.id),
      score: String(Number(r.score || 0)),
      total: String(Number(r.total || 0)),
      elapsed_seconds: String(Number(r.elapsed_seconds || 0)),
      mode: String(r.mode || 'training'),
      correction_system: String(r.correction_system || 'tout_ou_rien')
    });
    return `<div class="session-card saved-session-card">
      <div class="session-card-main">
        <div class="session-card-body">
          <div class="session-card-top">
            <span class="session-badge ${modeClass}">${r.mode === 'exam' ? 'Examen' : 'Entraînement'}</span>
            <a href="result.html?${qs.toString()}" class="session-name-link">${escHtml(name)}</a>
          </div>
          <div class="session-card-bottom">
            <span class="session-card-date">${date}</span>
            <span class="session-info-label">⏱ ${formatTime(r.elapsed_seconds)}</span>
          </div>
        </div>
        <div class="session-score-block ${scoreClass}">
          <span class="session-pct">${pct}%</span>
          <span class="session-raw">${Number(r.score || 0).toFixed(1)} / ${r.total}</span>
        </div>
      </div>
      <div class="session-rename-row">
        <input type="text" value="${escHtml(name)}" data-save-name="${r.id}" maxlength="120" placeholder="Nom de la session">
        <button class="btn-inline" data-save-rename="${r.id}">✏️ Renommer</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderFavoritesList(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-icon">⭐</div><p class="muted">Aucun favori pour le moment.</p></div>';
  return rows.map((r) => {
    const tags = normalizeTags(r.tags);
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const tagsHtml = tags.length
      ? tags.map((t) => `<span class="fav-tag">${escHtml(t)}</span>`).join('')
      : '<span class="fav-no-tags">Aucun tag</span>';
    return `
      <article class="fav-card favorite-item" data-favorite-id="${r.id}">
        <div class="fav-card-top">
          <button type="button" class="fav-expand-btn" data-toggle-fav="${r.id}">
            <span class="fav-heart">♥</span>
            <span class="fav-question">${escHtml(r.question)}</span>
            <span class="fav-chevron">▾</span>
          </button>
          <span class="fav-date">${date}</span>
        </div>
        <div class="fav-card-meta">${tagsHtml}</div>
        <div class="fav-detail hidden" id="fav_preview_${r.id}"></div>
        <div class="fav-card-actions">
          <button class="btn-inline favorite-edit" data-id="${r.id}" data-tags="${escAttr(r.tags || '')}">🏷️ Modifier tags</button>
          <button class="btn-inline favorite-remove" data-id="${r.id}" style="color:var(--red)">✕ Retirer</button>
        </div>
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

function escAttr(value) {
  return escHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderFavoriteDetail(detail) {
  const correctSet = new Set(Array.isArray(detail.correct_options) ? detail.correct_options : []);
  const opts = ['A', 'B', 'C', 'D', 'E'].map((l) => {
    const val = detail[`option_${l.toLowerCase()}`];
    if (!val) return '';
    const ok = correctSet.has(l);
    return `<div class="fav-opt ${ok ? 'fav-opt-correct' : ''}">
      <span class="fav-opt-letter ${ok ? 'fav-opt-letter-correct' : ''}">${l}</span>
      <span class="fav-opt-text">${escHtml(val)}</span>
      ${ok ? '<span class="fav-opt-check">✓</span>' : ''}
    </div>`;
  }).filter(Boolean).join('');

  const chips = [
    detail.module_name ? `<span class="note-chip note-chip-module">${escHtml(detail.module_name)}</span>` : '',
    detail.course_name ? `<span class="note-chip">${escHtml(detail.course_name)}</span>` : '',
    detail.source_name ? `<span class="note-chip note-chip-source">${escHtml(detail.source_name)}</span>` : '',
  ].filter(Boolean).join('');

  const comments = Array.isArray(detail.comments) ? detail.comments : [];
  const commentsHtml = comments.length
    ? comments.slice(0, 8).map((c) => {
        const author = c.display_name || c.email || 'Utilisateur';
        const date = c.created_at ? new Date(c.created_at).toLocaleDateString('fr-FR') : '';
        return `<div class="fav-comment">
          <div class="fav-comment-header"><strong>${escHtml(author)}</strong><span class="muted">${date}</span></div>
          <div class="fav-comment-body">${escHtml(c.body)}</div>
        </div>`;
      }).join('')
    : '<p class="muted" style="margin:0">Aucun commentaire.</p>';

  const noteHtml = detail.user_note
    ? `<div class="fav-note-text">${escHtml(detail.user_note)}</div>`
    : '<span class="muted">Aucune note personnelle.</span>';

  return `<div class="fav-detail-inner">
    ${chips ? `<div class="fav-detail-chips">${chips}</div>` : ''}
    ${opts ? `<div class="fav-detail-section"><div class="fav-section-label">Propositions</div><div class="fav-opts">${opts}</div></div>` : ''}
    ${detail.explanation ? `<div class="fav-detail-section"><div class="fav-section-label">Explication</div><div class="fav-explanation">${escHtml(detail.explanation)}</div></div>` : ''}
    <div class="fav-detail-section"><div class="fav-section-label">Ma note</div>${noteHtml}</div>
    <div class="fav-detail-section"><div class="fav-section-label">Commentaires (${comments.length})</div>${commentsHtml}</div>
  </div>`;
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

function parseCsvTags(tags) {
  return String(tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

function syncNoteCourseFilterOptions() {
  const select = document.getElementById('noteFilterCourse');
  if (!select) return;
  const moduleId = Number(noteFilters.module_id || 0);
  const courses = referencesCache.courses || [];
  const visible = moduleId ? courses.filter((c) => Number(c.module_id) === moduleId) : courses;
  const opts = ['<option value="">Tous les cours</option>']
    .concat(visible.map((c) => `<option value="${c.id}">${escHtml(c.name)}</option>`));
  select.innerHTML = opts.join('');
  if (noteFilters.course_id && visible.some((c) => String(c.id) === String(noteFilters.course_id))) {
    select.value = String(noteFilters.course_id);
  } else {
    noteFilters.course_id = '';
    select.value = '';
  }
}

function buildNoteTagFilterOptions() {
  const select = document.getElementById('noteFilterTag');
  if (!select) return;
  const tags = new Set();
  favoritesCache.forEach((f) => parseCsvTags(f.tags).forEach((t) => tags.add(t)));
  const list = Array.from(tags).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Tous les tags favoris</option>' + list.map((t) => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join('');
  if (noteFilters.fav_tag && list.includes(noteFilters.fav_tag)) select.value = noteFilters.fav_tag;
  else noteFilters.fav_tag = '';
}

function renderNotesList(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-icon">📝</div><p class="muted">Aucune note trouvée.</p></div>';
  return rows.map((r) => {
    const updated = r.updated_at ? new Date(r.updated_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
    const favTags = parseCsvTags(r.favorite_tags);
    const tagHtml = favTags.length ? `<div class="note-tags">${favTags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : '';
    const notePreview = (r.note || '').length > 200 ? escHtml(r.note.slice(0, 200)) + '…' : escHtml(r.note || '');
    return `
      <article class="note-card-v2" data-note-qid="${r.question_id}">
        <div class="note-card-meta">
          ${r.module_name ? `<span class="note-chip note-chip-module">${escHtml(r.module_name)}</span>` : ''}
          ${r.course_name ? `<span class="note-chip">${escHtml(r.course_name)}</span>` : ''}
          ${r.source_name ? `<span class="note-chip note-chip-source">${escHtml(r.source_name)}</span>` : ''}
          <span class="note-updated">Mis à jour ${updated}</span>
        </div>
        <div class="note-card-question">${escHtml(r.question || `Question #${r.question_id}`)}</div>
        ${tagHtml}
        ${notePreview ? `<div class="note-card-text">${notePreview}</div>` : ''}
        <div class="note-card-actions">
          <button class="btn-inline" data-note-open="${r.question_id}">↗ Ouvrir question</button>
          <button class="btn-inline" data-note-edit="${r.question_id}">✏️ Modifier</button>
          <button class="btn-inline" style="color:var(--red)" data-note-delete="${r.question_id}">🗑 Supprimer</button>
        </div>
        <div id="note_detail_${r.question_id}" class="favorite-preview hidden"></div>
      </article>
    `;
  }).join('');
}

async function loadNotes(page = 1) {
  const list = document.getElementById('notesList');
  if (!list) return;
  notesPage = Math.max(1, Number(page || 1));
  list.innerHTML = '<p class="muted">Chargement...</p>';
  try {
    const params = new URLSearchParams({
      page: String(notesPage),
      page_size: '10',
      sort: noteFilters.sort || 'recent'
    });
    if (noteFilters.module_id) params.set('module_id', noteFilters.module_id);
    if (noteFilters.course_id) params.set('course_id', noteFilters.course_id);
    if (noteFilters.source_id) params.set('source_id', noteFilters.source_id);
    if (noteFilters.fav_tag) params.set('fav_tag', noteFilters.fav_tag);
    if (noteFilters.search) params.set('search', noteFilters.search);
    const payload = await fetchJSON(`${API_URL}/users/notes?${params.toString()}`);
    notesCache = payload.data || [];
    notesTotalPages = Number(payload.pagination?.total_pages || 1);
    list.innerHTML = renderNotesList(notesCache);
    const info = document.getElementById('notesPageInfo');
    if (info) info.textContent = `Page ${notesPage} / ${notesTotalPages}`;
    const prev = document.getElementById('notesPrevBtn');
    const next = document.getElementById('notesNextBtn');
    if (prev) prev.disabled = notesPage <= 1;
    if (next) next.disabled = notesPage >= notesTotalPages;
  } catch (err) {
    list.innerHTML = `<p class="muted">Erreur: ${escHtml(err.message || 'Chargement impossible')}</p>`;
  }
}

function renderFlagList(rows) {
  if (!rows.length) return '<div class="empty-state"><div class="empty-icon">🚩</div><p class="muted">Aucun signalement.</p></div>';
  return rows.map((r) => {
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const isResolved = !!r.resolved;
    return `<div class="flag-card ${isResolved ? 'flag-resolved' : 'flag-pending'}">
      <div class="flag-card-header">
        <span class="flag-status-pill ${isResolved ? 'pill-ok' : 'pill-warn'}">${isResolved ? '✓ Résolu' : '⏳ En attente'}</span>
        <span class="flag-card-date">${date}</span>
      </div>
      <div class="flag-card-question">${escHtml(r.question || 'Question non disponible')}</div>
      ${r.reason ? `<div class="flag-card-reason"><strong>Votre signalement :</strong> ${escHtml(r.reason)}</div>` : ''}
      ${!isResolved ? `<div class="flag-card-actions"><button class="btn-inline report-remove" data-id="${r.id}" style="color:var(--red)">✕ Retirer le signalement</button></div>` : ''}
    </div>`;
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
  const chartsRow = document.getElementById('statsChartsRow');
  const insights = document.getElementById('statsInsights');
  const moduleWrap = document.getElementById('moduleScoresWrap');
  const courseWrap = document.getElementById('courseScoresWrap');
  const failedWrap = document.getElementById('failedQuestionsWrap');
  const timelineWrap = document.getElementById('timelineWrap');
  if (!profileStats || !insights || !moduleWrap || !courseWrap || !failedWrap || !timelineWrap) return;

  // Destroy any existing Chart.js instances before re-rendering
  if (window._galienCharts) {
    Object.values(window._galienCharts).forEach((c) => { try { c.destroy(); } catch (_) {} });
  }
  window._galienCharts = {};

  const sessions = analytics?.sessions || {};
  const qp = analytics?.questions_progress || {};
  const timeline = analytics?.progression_timeline || {};
  const avgPercent = basicStats?.avg_percent ? Math.round(Number(basicStats.avg_percent)) : 0;
  const avgColor = avgPercent >= 70 ? '#22c55e' : avgPercent >= 50 ? '#f59e0b' : '#ef4444';

  // ── Stat cards ──────────────────────────────────────────────────────────
  const statItems = [
    { val: sessions.total || 0,   lbl: 'Sessions totales',   icon: '📊', bg: '#6366f1' },
    { val: sessions.training || 0, lbl: 'Entraînement',      icon: '📖', bg: '#0d9488' },
    { val: sessions.exam || 0,     lbl: 'Examens',           icon: '🎓', bg: '#f59e0b' },
    { val: `${avgPercent}%`,        lbl: 'Moyenne globale',  icon: '🎯', bg: avgColor  },
    { val: `${qp.unique_done || 0} / ${qp.total_questions || 0}`, lbl: 'Questions uniques', icon: '✅', bg: '#0d9488' },
    { val: qp.done_with_duplicates || 0, lbl: 'Tentatives totales', icon: '🔁', bg: '#64748b' },
  ];
  profileStats.innerHTML = statItems.map((s) => `
    <div class="stat-item">
      <div class="stat-item-icon" style="background:${s.bg}18">${s.icon}</div>
      <div class="stat-val">${s.val}</div>
      <div class="stat-lbl">${s.lbl}</div>
    </div>
  `).join('');

  // ── Extra stat cards ─────────────────────────────────────────────────────
  const daily = Array.isArray(timeline.by_day) ? timeline.by_day : [];
  const daysStudied = daily.length;
  const bestDay = daily.reduce((best, d) => {
    const p = Number(d.avg_percent || 0);
    return p > best ? p : best;
  }, 0);
  const avgQPerSession = (sessions.total || 0) > 0
    ? Math.round((qp.done_with_duplicates || 0) / sessions.total)
    : 0;
  const lastActivity = basicStats?.last_exam_at
    ? new Date(basicStats.last_exam_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
  // Sessions this week (Mon→Sun)
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); weekStart.setHours(0,0,0,0);
  const sessionsThisWeek = daily.filter((d) => new Date(d.day) >= weekStart).reduce((s, d) => s + (Number(d.sessions) || 0), 0);
  const extraItems = [
    { val: daysStudied,      lbl: 'Jours de révision', icon: '📅', bg: '#6366f1' },
    { val: avgQPerSession,   lbl: 'Questions / session', icon: '🔢', bg: '#0891b2' },
    { val: `${bestDay.toFixed(1)}%`, lbl: 'Meilleur jour', icon: '🏆', bg: '#f59e0b' },
    { val: sessionsThisWeek, lbl: 'Sessions cette semaine', icon: '📆', bg: '#8b5cf6' },
    { val: lastActivity,     lbl: 'Dernière activité', icon: '🕐', bg: '#64748b' },
  ];
  const statsExtra = document.getElementById('statsExtra');
  if (statsExtra) {
    statsExtra.innerHTML = extraItems.map((s) => `
      <div class="stat-item stat-item-sm">
        <div class="stat-item-icon" style="background:${s.bg}18;width:30px;height:30px;font-size:.95rem">${s.icon}</div>
        <div class="stat-val stat-val-sm">${s.val}</div>
        <div class="stat-lbl">${s.lbl}</div>
      </div>
    `).join('');
  }

  // ── Donut charts row ────────────────────────────────────────────────────
  if (chartsRow) {
    chartsRow.innerHTML = `
      <div class="analytics-block chart-donut-wrap">
        <h4>Répartition des sessions</h4>
        <canvas id="chartSessions" width="180" height="180"></canvas>
        <div id="chartSessionsLegend" class="chart-legend"></div>
      </div>
      <div class="analytics-block chart-donut-wrap">
        <h4>Questions réalisées</h4>
        <canvas id="chartProgress" width="180" height="180"></canvas>
        <div id="chartProgressLegend" class="chart-legend"></div>
      </div>
    `;
    requestAnimationFrame(() => {
      const trainCount = Number(sessions.training || 0);
      const examCount  = Number(sessions.exam || 0);
      const ctxSessions = document.getElementById('chartSessions')?.getContext('2d');
      if (ctxSessions && (trainCount + examCount) > 0) {
        window._galienCharts.sessions = new Chart(ctxSessions, {
          type: 'doughnut',
          data: {
            labels: ['Entraînement', 'Examens'],
            datasets: [{ data: [trainCount, examCount], backgroundColor: ['#0d9488', '#f59e0b'], borderWidth: 0, hoverOffset: 4 }]
          },
          options: { responsive: false, cutout: '70%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed}` } } } }
        });
        document.getElementById('chartSessionsLegend').innerHTML = `
          <div class="chart-legend-item"><div class="chart-legend-dot" style="background:#0d9488"></div>Entraînement (${trainCount})</div>
          <div class="chart-legend-item"><div class="chart-legend-dot" style="background:#f59e0b"></div>Examens (${examCount})</div>
        `;
      } else if (ctxSessions) {
        document.getElementById('chartSessionsLegend').innerHTML = '<span class="muted">Aucune session.</span>';
      }

      const done      = Number(qp.unique_done || 0);
      const total     = Number(qp.total_questions || 0);
      const remaining = Math.max(0, total - done);
      const ctxProgress = document.getElementById('chartProgress')?.getContext('2d');
      if (ctxProgress && total > 0) {
        window._galienCharts.progress = new Chart(ctxProgress, {
          type: 'doughnut',
          data: {
            labels: ['Faites', 'Restantes'],
            datasets: [{ data: [done, remaining], backgroundColor: ['#22c55e', '#e2e8f0'], borderWidth: 0, hoverOffset: 4 }]
          },
          options: { responsive: false, cutout: '70%', plugins: { legend: { display: false } } }
        });
        const pct = Math.round(done / total * 100);
        document.getElementById('chartProgressLegend').innerHTML = `
          <div class="chart-legend-item"><div class="chart-legend-dot" style="background:#22c55e"></div>Faites (${done} · ${pct}%)</div>
          <div class="chart-legend-item"><div class="chart-legend-dot" style="background:#e2e8f0"></div>Restantes (${remaining})</div>
        `;
      } else if (ctxProgress) {
        document.getElementById('chartProgressLegend').innerHTML = '<span class="muted">Aucune donnée.</span>';
      }
    });
  }

  // ── Insights pills ──────────────────────────────────────────────────────
  const improving = timeline.improving;
  const trendIcon = improving == null ? '—' : (improving ? '📈' : '📉');
  const trendText = improving == null ? '—' : (improving ? 'En progression' : 'À retravailler');
  insights.innerHTML = `
    <div class="analytics-pill"><div class="pill-icon">⏱️</div><div class="k">Temps révisé</div><div class="v">${formatDuration(analytics?.total_revision_seconds || 0)}</div></div>
    <div class="analytics-pill"><div class="pill-icon">🔥</div><div class="k">Streak</div><div class="v">${analytics?.streak_days || 0} jours</div></div>
    <div class="analytics-pill"><div class="pill-icon">⭐</div><div class="k">Favoris</div><div class="v">${analytics?.favorites_count || 0}</div></div>
    <div class="analytics-pill"><div class="pill-icon">💪</div><div class="k">Cours le plus maîtrisé</div><div class="v">${escHtml(analytics?.strongest_course?.course_name || '—')}</div></div>
    <div class="analytics-pill"><div class="pill-icon">⚠️</div><div class="k">Cours le plus faible</div><div class="v">${escHtml(analytics?.weakest_course?.course_name || '—')}</div></div>
    <div class="analytics-pill"><div class="pill-icon">${trendIcon}</div><div class="k">Tendance</div><div class="v">${trendText}</div></div>
  `;

  // ── Module scores — interactive bar rows ────────────────────────────────
  const modules = analytics?.avg_score_by_module || [];
  const maxPct   = modules.length ? Math.max(...modules.map((m) => Number(m.avg_percent || 0)), 1) : 1;
  moduleWrap.innerHTML = `
    <div class="block-header">
      <h4>Score par module</h4>
      <span class="muted" style="font-size:.75rem">Cliquer pour filtrer les cours</span>
    </div>
    <div class="module-bar-list">
      ${modules.length
        ? modules.map((m) => {
            const id     = m.module_id == null ? 'none' : String(m.module_id);
            const active = selectedModuleForCourses === id;
            const pct    = Number(m.avg_percent || 0);
            const fill   = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
            const barW   = maxPct > 0 ? (pct / maxPct * 100).toFixed(1) : 0;
            return `<div class="module-bar-row ${active ? 'active' : ''}" data-module-score="${id}" role="button" tabindex="0">
              <div class="module-bar-label" title="${escHtml(m.module_name || 'Sans module')}">${escHtml(m.module_name || 'Sans module')}</div>
              <div class="module-bar-track"><div class="module-bar-fill" style="width:${barW}%;background:${fill}"></div></div>
              <div class="module-bar-pct" style="color:${fill}">${pct.toFixed(1)}%</div>
              <div class="module-bar-attempts">${m.attempts} tent.</div>
            </div>`;
          }).join('')
        : '<span class="muted">Aucune donnée.</span>'}
    </div>
  `;

  // ── Radar chart — module mastery ─────────────────────────────────────────
  const chartRadarWrap = document.getElementById('chartRadarWrap');
  if (chartRadarWrap) {
    if (modules.length >= 3) {
      chartRadarWrap.innerHTML = `
        <div class="block-header"><h4>Maîtrise par module</h4></div>
        <div class="radar-chart-wrap"><canvas id="chartRadar"></canvas></div>
      `;
      requestAnimationFrame(() => {
        const ctxRadar = document.getElementById('chartRadar')?.getContext('2d');
        if (!ctxRadar) return;
        window._galienCharts.radar = new Chart(ctxRadar, {
          type: 'radar',
          data: {
            labels: modules.map((m) => m.module_name || 'Sans module'),
            datasets: [{
              data: modules.map((m) => Number(m.avg_percent || 0).toFixed(1)),
              backgroundColor: 'rgba(13,148,136,.15)',
              borderColor: '#0d9488',
              borderWidth: 2,
              pointBackgroundColor: modules.map((m) => {
                const p = Number(m.avg_percent || 0);
                return p >= 70 ? '#22c55e' : p >= 50 ? '#f59e0b' : '#ef4444';
              }),
              pointRadius: 5,
              pointHoverRadius: 7,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                min: 0, max: 100,
                ticks: { stepSize: 25, callback: (v) => `${v}%`, font: { size: 10 } },
                grid: { color: 'rgba(100,116,139,.12)' },
                angleLines: { color: 'rgba(100,116,139,.12)' },
                pointLabels: { font: { size: 11 }, color: '#334155' },
              }
            },
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (ctx) => ` ${ctx.raw}%` } }
            }
          }
        });
      });
    } else {
      chartRadarWrap.innerHTML = '';
    }
  }

  // ── Course scores ───────────────────────────────────────────────────────
  const courses = analytics?.avg_score_by_course || [];
  const filteredCourses = selectedModuleForCourses == null
    ? courses
    : courses.filter((c) => String(c.module_id == null ? 'none' : c.module_id) === selectedModuleForCourses);
  courseWrap.innerHTML = `
    <div class="block-header">
      <h4>Scores par cours</h4>
      ${selectedModuleForCourses != null ? '<span class="label" style="font-size:.7rem">module filtré</span>' : ''}
    </div>
    <div class="course-list">
      ${filteredCourses.length
        ? filteredCourses.slice(0, 20).map((c) => {
            const pct  = Number(c.avg_percent || 0);
            const fill = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
            return `<div class="course-row">
              <div class="course-row-name">${escHtml(c.course_name || 'Sans cours')}<span class="muted"> · ${c.attempts} tent.</span></div>
              <div class="course-row-bar"><div class="course-row-bar-fill" style="width:${pct}%;background:${fill}"></div></div>
              <div class="course-row-pct" style="color:${fill}">${pct.toFixed(1)}%</div>
            </div>`;
          }).join('')
        : '<span class="muted">Aucun cours pour ce module.</span>'}
    </div>
  `;

  // ── Progression timeline — line chart + daily list ─────────────────────
  const trendDelta = timeline.trend_delta_percent;
  const last10     = daily.slice(-10);
  timelineWrap.innerHTML = `
    <div class="block-header">
      <h4>Progression dans le temps</h4>
      ${trendDelta != null ? `<span class="trend-badge" style="color:${trendDelta >= 0 ? '#22c55e' : '#ef4444'};background:${trendDelta >= 0 ? '#f0fdf4' : '#fef2f2'}">
        ${trendDelta >= 0 ? '▲' : '▼'} ${trendDelta > 0 ? '+' : ''}${trendDelta}%
      </span>` : ''}
    </div>
    ${last10.length > 1 ? '<div class="timeline-chart-wrap"><canvas id="chartTimeline"></canvas></div>' : '<p class="muted">Pas assez de données pour la tendance.</p>'}
    <div class="timeline-list">
      ${last10.map((d) => {
        const p = Number(d.avg_percent || 0);
        const c = p >= 70 ? '#22c55e' : p >= 50 ? '#f59e0b' : '#ef4444';
        return `<div class="timeline-day">
          <span>${new Date(d.day).toLocaleDateString('fr-FR')}</span>
          <div class="timeline-bar-track"><div class="timeline-bar-fill" style="width:${p}%;background:${c}"></div></div>
          <strong style="color:${c};min-width:40px;text-align:right">${p.toFixed(1)}%</strong>
        </div>`;
      }).join('')}
    </div>
  `;
  if (last10.length > 1) {
    requestAnimationFrame(() => {
      const ctxTl = document.getElementById('chartTimeline')?.getContext('2d');
      if (!ctxTl) return;
      window._galienCharts.timeline = new Chart(ctxTl, {
        type: 'line',
        data: {
          labels: last10.map((d) => new Date(d.day).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })),
          datasets: [{
            data: last10.map((d) => Number(d.avg_percent || 0).toFixed(1)),
            borderColor: '#0d9488',
            backgroundColor: 'rgba(13,148,136,.1)',
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#0d9488',
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y}%` } } },
          scales: {
            y: { min: 0, max: 100, grid: { color: 'rgba(100,116,139,.08)' }, ticks: { callback: (v) => `${v}%`, font: { size: 11 } } },
            x: { grid: { display: false }, ticks: { font: { size: 10 } } }
          }
        }
      });
    });
  }

  // ── Weekly activity bar chart ────────────────────────────────────────────
  const chartWeeklyWrap = document.getElementById('chartWeeklyWrap');
  if (chartWeeklyWrap) {
    // Aggregate sessions + avg score by ISO day of week (1=Mon … 7=Sun)
    const dayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    const weeklyBuckets = Array.from({ length: 7 }, () => ({ sessions: 0, scoreSum: 0, scoreDays: 0 }));
    daily.forEach((d) => {
      const dow = (new Date(d.day).getDay() + 6) % 7; // 0=Mon
      weeklyBuckets[dow].sessions += Number(d.sessions) || 0;
      if (d.avg_percent != null) { weeklyBuckets[dow].scoreSum += Number(d.avg_percent); weeklyBuckets[dow].scoreDays++; }
    });
    const weeklyScores = weeklyBuckets.map((b) => b.scoreDays > 0 ? (b.scoreSum / b.scoreDays).toFixed(1) : null);
    const weeklySessions = weeklyBuckets.map((b) => b.sessions);
    const hasData = weeklySessions.some((v) => v > 0);
    if (hasData) {
      chartWeeklyWrap.innerHTML = `
        <div class="block-header"><h4>Activité par jour de la semaine</h4><span class="muted" style="font-size:.75rem">Sessions cumulées</span></div>
        <div class="weekly-chart-wrap"><canvas id="chartWeekly"></canvas></div>
      `;
      requestAnimationFrame(() => {
        const ctxW = document.getElementById('chartWeekly')?.getContext('2d');
        if (!ctxW) return;
        window._galienCharts.weekly = new Chart(ctxW, {
          type: 'bar',
          data: {
            labels: dayLabels,
            datasets: [
              {
                label: 'Sessions',
                data: weeklySessions,
                backgroundColor: weeklySessions.map((v) => v > 0 ? 'rgba(13,148,136,.75)' : 'rgba(226,232,240,.6)'),
                borderRadius: 6,
                yAxisID: 'ySessions',
              },
              {
                label: 'Score moyen',
                data: weeklyScores,
                type: 'line',
                borderColor: '#f59e0b',
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointBackgroundColor: '#f59e0b',
                pointRadius: 4,
                tension: 0.3,
                yAxisID: 'yScore',
                spanGaps: true,
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 12 } },
              tooltip: { callbacks: {
                label: (ctx) => ctx.dataset.label === 'Sessions'
                  ? ` ${ctx.parsed.y} session${ctx.parsed.y !== 1 ? 's' : ''}`
                  : ctx.parsed.y != null ? ` Score moy. ${ctx.parsed.y}%` : ''
              }}
            },
            scales: {
              ySessions: { position: 'left',  beginAtZero: true, ticks: { stepSize: 1, font: { size: 10 } }, grid: { color: 'rgba(100,116,139,.08)' } },
              yScore:    { position: 'right', min: 0, max: 100, ticks: { callback: (v) => `${v}%`, font: { size: 10 } }, grid: { display: false } },
              x:         { grid: { display: false }, ticks: { font: { size: 11 } } }
            }
          }
        });
      });
    } else {
      chartWeeklyWrap.innerHTML = '';
    }
  }

  // ── Top 10 failed questions ─────────────────────────────────────────────
  const failedRows     = Array.isArray(failedOverrideRows) ? failedOverrideRows : (analytics?.most_failed_questions_top10 || []);
  const moduleValue    = String(failedFilterState.module_id || '');
  const courseValue    = String(failedFilterState.course_id || '');
  const sourceValue    = String(failedFilterState.source_id || '');
  const coursesFiltered = moduleValue
    ? referencesCache.courses.filter((c) => String(c.module_id || '') === moduleValue)
    : referencesCache.courses;
  const sourcesFiltered = moduleValue
    ? referencesCache.sources.filter((s) => !s.module_id || String(s.module_id) === moduleValue)
    : referencesCache.sources;
  failedWrap.innerHTML = `
    <div class="block-header" style="margin-bottom:12px">
      <h4>Top 10 questions les plus ratées</h4>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px">
      <label class="field" style="margin:0"><span>Module</span>
        <select id="failedFilterModule">
          <option value="">Tous</option>
          ${referencesCache.modules.map((m) => `<option value="${m.id}" ${String(m.id)===moduleValue?'selected':''}>${escHtml(m.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field" style="margin:0"><span>Cours</span>
        <select id="failedFilterCourse">
          <option value="">Tous</option>
          ${coursesFiltered.map((c) => `<option value="${c.id}" ${String(c.id)===courseValue?'selected':''}>${escHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field" style="margin:0"><span>Référence</span>
        <select id="failedFilterSource">
          <option value="">Toutes</option>
          ${sourcesFiltered.map((s) => `<option value="${s.id}" ${String(s.id)===sourceValue?'selected':''}>${escHtml(s.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="failed-list">
      ${failedRows.length
        ? failedRows.map((r) => `
          <div class="failed-card">
            <div class="failed-card-header" data-failed-toggle="${r.question_id}">
              <div class="failed-card-main">
                <div class="failed-card-q">${escHtml(r.question || '')}</div>
                <div class="failed-card-meta">${escHtml(r.module_name || '—')}${r.course_name ? ` · ${escHtml(r.course_name)}` : ''}${r.source_name ? ` · ${escHtml(r.source_name)}` : ''}</div>
              </div>
              <div class="failed-card-rate">${Number(r.fail_rate_percent || 0).toFixed(0)}<span>%</span></div>
              <div class="failed-card-count">${r.fail_count}/${r.attempts}<div class="muted" style="font-size:.68rem">raté/tent.</div></div>
              <button class="btn-inline" type="button" data-failed-toggle="${r.question_id}">Détails</button>
            </div>
            <div class="failed-card-detail hidden" id="failedDetail-${r.question_id}">
              ${['a','b','c','d','e'].filter((l) => r[`option_${l}`]).map((l) => `
                <div class="failed-opt"><strong>${l.toUpperCase()}</strong><span>${escHtml(r[`option_${l}`] || '')}</span></div>
              `).join('')}
              <div class="failed-answer"><span>✓ Correction :</span> ${escHtml(r.correct_options || '—')}</div>
              ${r.explanation ? `<div class="failed-explication">${escHtml(r.explanation)}</div>` : ''}
            </div>
          </div>
        `).join('')
        : '<span class="muted">Pas assez de tentatives.</span>'}
    </div>
  `;
}

async function loadReferencesForStats() {
  try {
    const [modules, courses, sources] = await Promise.all([
      fetchJSON(`${API_URL}/modules`),
      fetchJSON(`${API_URL}/courses`),
      fetchJSON(`${API_URL}/sources`)
    ]);
    referencesCache = {
      modules: Array.isArray(modules) ? modules : [],
      courses: Array.isArray(courses) ? courses : [],
      sources: Array.isArray(sources) ? sources : []
    };
  } catch (_) {
    referencesCache = { modules: [], courses: [], sources: [] };
  }
}

async function refreshFailedQuestionsAnalytics() {
  if (!analyticsCache) return;
  const params = new URLSearchParams();
  if (failedFilterState.module_id) params.set('module_id', failedFilterState.module_id);
  if (failedFilterState.course_id) params.set('course_id', failedFilterState.course_id);
  if (failedFilterState.source_id) params.set('source_id', failedFilterState.source_id);
  if (!params.toString()) {
    failedOverrideRows = null;
    renderAnalytics(analyticsCache, basicStatsCache || {});
    return;
  }
  try {
    const scoped = await fetchJSON(`${API_URL}/users/analytics?${params.toString()}`);
    failedOverrideRows = scoped?.most_failed_questions_top10 || [];
  } catch (_) {
    failedOverrideRows = [];
  }
  renderAnalytics(analyticsCache, basicStatsCache || {});
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
const PROFILE_FALLBACK_SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="%23f1f5f9"/><circle cx="48" cy="36" r="16" fill="%23ccfbf1"/><path d="M16 86c6-16 20-24 32-24s26 8 32 24" fill="%23ccfbf1"/></svg>';

function bindPhotoFallback(el) {
  if (!el) return;
  el.onerror = () => {
    el.onerror = null;
    el.src = PROFILE_FALLBACK_SVG;
  };
}

function renderPagination(page, count, fnName) {
  if (page === 1 && count < RESULTS_PAGE_SIZE) return '';
  const hasPrev = page > 1;
  const hasNext = count === RESULTS_PAGE_SIZE;
  return `<div class="pagination-bar">
    <button class="btn-inline" onclick="${fnName}(${page - 1})" ${hasPrev ? '' : 'disabled'}>← Précédent</button>
    <span class="muted">Page ${page}</span>
    <button class="btn-inline" onclick="${fnName}(${page + 1})" ${hasNext ? '' : 'disabled'}>Suivant →</button>
  </div>`;
}

async function loadHistoryPage(page) {
  const wrap = document.getElementById('resultsTable');
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">Chargement...</p>';
  historyPage = page;
  historyLoaded = true;
  try {
    const rows = await fetchJSON(`${API_URL}/users/results?saved=all&page=${page}&page_size=${RESULTS_PAGE_SIZE}`);
    wrap.innerHTML = renderResults(Array.isArray(rows) ? rows : []) + renderPagination(page, rows.length, 'loadHistoryPage');
  } catch (_) {
    wrap.innerHTML = '<p class="muted">Erreur de chargement.</p>';
  }
}

async function loadSavedPage(page) {
  const wrap = document.getElementById('savedSessionsTable');
  if (!wrap) return;
  wrap.innerHTML = '<p class="muted">Chargement...</p>';
  savedPage = page;
  savedLoaded = true;
  try {
    const rows = await fetchJSON(`${API_URL}/users/results?saved=1&page=${page}&page_size=${RESULTS_PAGE_SIZE}`);
    wrap.innerHTML = renderSavedSessions(Array.isArray(rows) ? rows : []) + renderPagination(page, rows.length, 'loadSavedPage');
  } catch (_) {
    wrap.innerHTML = '<p class="muted">Erreur de chargement.</p>';
  }
}

async function loadProfile() {
  if (!localStorage.getItem('token')) { window.location.href = 'login.html'; return; }

  try {
    const [me, stats, prefs, favorites, flags, analytics] = await Promise.all([
      fetchJSON(`${API_URL}/users/me`),
      fetchJSON(`${API_URL}/users/stats`),
      fetchJSON(`${API_URL}/users/preferences`),
      fetchJSON(`${API_URL}/users/flags?type=favorite&page_size=500`),
      fetchJSON(`${API_URL}/users/flags?type=flag`),
      fetchJSON(`${API_URL}/users/analytics`)
    ]);
    // Reset lazy-load state so tab switches re-fetch fresh data
    historyLoaded = false;
    savedLoaded = false;
    await loadReferencesForStats();

    await loadUnreadCount();

    const nowTs = Date.now();
    const activeUntilTs = me.active_until ? new Date(me.active_until).getTime() : null;
    const accountStatus = activeUntilTs && activeUntilTs <= nowTs ? 'Expire' : 'Actif';
    const statusClass = accountStatus === 'Expire' ? 'color:var(--red);font-weight:700' : 'color:var(--ok);font-weight:700';
    document.getElementById('profileInfo').innerHTML = `
      <p><strong>Email</strong><br>${me.email}</p>
      <p><strong>Role</strong><br><span style="text-transform:capitalize">${me.role}</span></p>
      <p><strong>Statut du compte</strong><br><span style="${statusClass}">${accountStatus}</span></p>
      <p><strong>Actif jusqu'au</strong><br>${formatActiveUntil(me.active_until)}</p>
    `;
    document.getElementById('display_name').value = me.display_name || '';
    const adminShortcutTab = document.getElementById('adminShortcutTab');
    if (adminShortcutTab) {
      const canManage = me.role === 'admin' || me.role === 'manager';
      adminShortcutTab.classList.toggle('hidden', !canManage);
      adminShortcutTab.textContent = me.role === 'manager' ? 'Panel manager' : 'Admin panel';
    }

    const photoUrl = me.profile_photo ? resolvePhotoUrl(me.profile_photo) : PROFILE_FALLBACK_SVG;
    const profilePhotoEl = document.getElementById('profilePhoto');
    const sidebarPhotoEl = document.getElementById('sidebarPhoto');
    bindPhotoFallback(profilePhotoEl);
    bindPhotoFallback(sidebarPhotoEl);
    if (profilePhotoEl) profilePhotoEl.src = photoUrl;
    if (sidebarPhotoEl) sidebarPhotoEl.src = photoUrl;
    document.getElementById('sidebarDisplayName').textContent = me.display_name || me.email || 'Utilisateur';

    basicStatsCache = stats || null;
    analyticsCache = analytics || null;
    selectedModuleForCourses = null;
    failedOverrideRows = null;
    failedFilterState = { module_id: '', course_id: '', source_id: '' };
    renderAnalytics(analyticsCache, basicStatsCache);

    document.getElementById('default_exam_minutes').value = prefs.default_exam_minutes || '';
    document.getElementById('pref_question_limit').value = prefs.question_limit || '';
    document.getElementById('default_correction_system').value = prefs.correction_system || 'tout_ou_rien';
    document.getElementById('pref_auto_next_enabled').checked = !!prefs.auto_next_enabled;
    document.getElementById('pref_auto_next_delay_sec').value = Number(prefs.auto_next_delay_sec || 2);
    document.getElementById('pref_show_explanation_auto').checked = prefs.show_explanation_auto !== false;
    document.getElementById('pref_show_notes_inline').checked = !!prefs.show_notes_inline;
    document.getElementById('pref_hide_question_meta').checked = !!prefs.hide_question_meta;
    applyThemePicker(prefs.theme_preference || 'system');
    applyAutoNextDelayVisibility();
    localStorage.setItem('show_notes_inline', prefs.show_notes_inline ? '1' : '0');
    localStorage.setItem('show_explanation_auto', prefs.show_explanation_auto === false ? '0' : '1');
    localStorage.setItem('hide_question_meta', prefs.hide_question_meta ? '1' : '0');
    if (prefs.question_limit) localStorage.setItem('question_limit', String(prefs.question_limit));
    else localStorage.removeItem('question_limit');
    const themePref = prefs.theme_preference || 'system';
    localStorage.setItem('theme_preference', themePref);
    if (themePref === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', themePref);
    if (window.__applyThemePreference) window.__applyThemePreference();

    favoritesCache = favorites;
    fillFavoriteTagFilter(favoritesCache);
    applyFavoriteFilters();
    const moduleSel = document.getElementById('noteFilterModule');
    const sourceSel = document.getElementById('noteFilterSource');
    if (moduleSel) {
      moduleSel.innerHTML = '<option value="">Tous les modules</option>' +
        (referencesCache.modules || []).map((m) => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
      moduleSel.value = noteFilters.module_id || '';
    }
    if (sourceSel) {
      sourceSel.innerHTML = '<option value="">Toutes les sources</option>' +
        (referencesCache.sources || []).map((s) => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
      sourceSel.value = noteFilters.source_id || '';
    }
    syncNoteCourseFilterOptions();
    buildNoteTagFilterOptions();

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

function applyThemePicker(theme) {
  document.querySelectorAll('[data-theme-pick]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themePick === theme);
  });
}

function applyAutoNextDelayVisibility() {
  const checked = document.getElementById('pref_auto_next_enabled')?.checked;
  const row = document.getElementById('autoNextDelayRow');
  if (row) row.classList.toggle('hidden', !checked);
}

async function savePrefs() {
  const btn = document.getElementById('savePrefsBtn');
  const msg = document.getElementById('prefsSavedMsg');
  const defaultExam = document.getElementById('default_exam_minutes').value || null;
  const questionLimit = document.getElementById('pref_question_limit').value || null;
  const correction = document.getElementById('default_correction_system').value;
  const autoNextEnabled = document.getElementById('pref_auto_next_enabled').checked;
  const autoNextDelaySec = Number(document.getElementById('pref_auto_next_delay_sec').value || 2);
  const showExplanationAuto = document.getElementById('pref_show_explanation_auto').checked;
  const showNotesInline = document.getElementById('pref_show_notes_inline').checked;
  const hideQuestionMeta = document.getElementById('pref_hide_question_meta').checked;
  const themePreference = document.querySelector('[data-theme-pick].active')?.dataset.themePick || 'system';
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Enregistrement...';
  if (msg) msg.textContent = '';
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
        theme_preference: themePreference,
        question_limit: questionLimit,
        hide_question_meta: hideQuestionMeta
      })
    });
    localStorage.setItem('show_notes_inline', showNotesInline ? '1' : '0');
    localStorage.setItem('show_explanation_auto', showExplanationAuto ? '1' : '0');
    localStorage.setItem('hide_question_meta', hideQuestionMeta ? '1' : '0');
    if (questionLimit) localStorage.setItem('question_limit', String(questionLimit));
    else localStorage.removeItem('question_limit');
    localStorage.setItem('theme_preference', themePreference);
    if (themePreference === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', themePreference);
    if (window.__applyThemePreference) window.__applyThemePreference();
    btn.innerHTML = '<i class="bi bi-check2"></i> Enregistré';
    if (msg) { msg.textContent = 'Préférences sauvegardées.'; msg.className = 'prefs-msg ok'; }
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = 'Enregistrer les préférences';
      if (msg) { msg.textContent = ''; msg.className = 'prefs-msg'; }
    }, 2500);
  } catch (_) {
    btn.disabled = false;
    btn.innerHTML = 'Enregistrer les préférences';
    if (msg) { msg.textContent = 'Erreur lors de la sauvegarde.'; msg.className = 'prefs-msg err'; }
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

document.getElementById('themePicker')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-pick]');
  if (!btn) return;
  applyThemePicker(btn.dataset.themePick);
});

document.getElementById('pref_auto_next_enabled')?.addEventListener('change', applyAutoNextDelayVisibility);
document.getElementById('uploadPhotoBtn').addEventListener('click', uploadPhoto);
document.getElementById('refreshMessagesBtn')?.addEventListener('click', loadMessages);
document.getElementById('refreshNotesBtn')?.addEventListener('click', () => loadNotes(1));
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

document.getElementById('noteFilterModule')?.addEventListener('change', (e) => {
  noteFilters.module_id = e.target.value || '';
  syncNoteCourseFilterOptions();
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('noteFilterCourse')?.addEventListener('change', (e) => {
  noteFilters.course_id = e.target.value || '';
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('noteFilterSource')?.addEventListener('change', (e) => {
  noteFilters.source_id = e.target.value || '';
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('noteFilterTag')?.addEventListener('change', (e) => {
  noteFilters.fav_tag = e.target.value || '';
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('noteSort')?.addEventListener('change', (e) => {
  noteFilters.sort = e.target.value || 'recent';
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('noteSearch')?.addEventListener('input', (e) => {
  noteFilters.search = (e.target.value || '').trim();
  notesPage = 1;
  loadNotes(1);
});
document.getElementById('notesPrevBtn')?.addEventListener('click', () => {
  if (notesPage > 1) loadNotes(notesPage - 1);
});
document.getElementById('notesNextBtn')?.addEventListener('click', () => {
  if (notesPage < notesTotalPages) loadNotes(notesPage + 1);
});

document.getElementById('notesList')?.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-note-open]');
  const editBtn = e.target.closest('[data-note-edit]');
  const deleteBtn = e.target.closest('[data-note-delete]');

  if (openBtn) {
    const id = openBtn.getAttribute('data-note-open');
    const panel = document.getElementById(`note_detail_${id}`);
    if (!id || !panel) return;
    const hidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (!hidden) return;
    if (panel.dataset.loaded === '1') return;
    panel.innerHTML = '<div class="muted">Chargement...</div>';
    try {
      const detail = await fetchJSON(`${API_URL}/users/questions/${id}/detail`);
      panel.innerHTML = renderFavoriteDetail(detail);
      panel.dataset.loaded = '1';
    } catch (_) {
      panel.innerHTML = '<div class="muted">Impossible de charger la question.</div>';
    }
    return;
  }

  if (editBtn) {
    const id = Number(editBtn.getAttribute('data-note-edit'));
    if (!Number.isInteger(id) || id <= 0) return;
    const item = notesCache.find((n) => Number(n.question_id) === id);
    noteEditingQuestionId = id;
    document.getElementById('noteEditorInput').value = item?.note || '';
    document.getElementById('noteEditorModal')?.classList.remove('hidden');
    return;
  }

  if (deleteBtn) {
    const id = Number(deleteBtn.getAttribute('data-note-delete'));
    if (!Number.isInteger(id) || id <= 0) return;
    const ok = window.confirm('Supprimer cette note ?');
    if (!ok) return;
    try {
      await fetchJSON(`${API_URL}/users/questions/${id}/note`, { method: 'DELETE' });
      loadNotes(notesPage);
    } catch (_) {}
  }
});

document.getElementById('noteEditorCancelBtn')?.addEventListener('click', () => {
  noteEditingQuestionId = null;
  document.getElementById('noteEditorModal')?.classList.add('hidden');
});
document.getElementById('noteEditorSaveBtn')?.addEventListener('click', async () => {
  if (!noteEditingQuestionId) return;
  const note = (document.getElementById('noteEditorInput')?.value || '').trim();
  if (!note) return;
  try {
    await fetchJSON(`${API_URL}/users/questions/${noteEditingQuestionId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note })
    });
    document.getElementById('noteEditorModal')?.classList.add('hidden');
    noteEditingQuestionId = null;
    loadNotes(notesPage);
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
    await fetchJSON(`${API_URL}/users/questions/${id}/flag?type=flag`, { method: 'DELETE' });
    flagsCache = flagsCache.filter((r) => String(r.id) !== String(id));
    const list = document.getElementById('flagsList');
    if (list) list.innerHTML = renderFlagList(flagsCache);
  } catch (err) {
    btn.textContent = '✕ Retirer le signalement';
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
    setTimeout(() => loadSavedPage(savedPage), 350);
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

document.getElementById('failedQuestionsWrap')?.addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === 'failedFilterModule') {
    failedFilterState.module_id = target.value || '';
    if (failedFilterState.course_id) {
      const hasCourse = referencesCache.courses.some((c) => String(c.id) === String(failedFilterState.course_id) && String(c.module_id || '') === String(failedFilterState.module_id || c.module_id || ''));
      if (!hasCourse) failedFilterState.course_id = '';
    }
  }
  if (target.id === 'failedFilterCourse') failedFilterState.course_id = target.value || '';
  if (target.id === 'failedFilterSource') failedFilterState.source_id = target.value || '';
  refreshFailedQuestionsAnalytics();
});

document.getElementById('failedQuestionsWrap')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-failed-toggle]');
  if (!btn) return;
  const id = btn.getAttribute('data-failed-toggle');
  const detail = document.getElementById(`failedDetail-${id}`);
  if (!detail) return;
  detail.classList.toggle('hidden');
  btn.textContent = detail.classList.contains('hidden') ? 'Details' : 'Masquer';
});
