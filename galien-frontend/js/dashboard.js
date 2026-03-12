if (localStorage.getItem('role') === 'worker') {
  window.location.href = 'admin.html';
}
if (localStorage.getItem('is_active') === 'false' || localStorage.getItem('is_expired') === 'true') {
  window.location.href = 'profile.html';
}

let currentMode = 'training';
let isPopulatingFilters = false;

const correctionHelpText = {
  tout_ou_rien: 'Vous devez cocher toutes les bonnes reponses et uniquement celles-ci.',
  partiel_positive: 'Les bonnes reponses rapportent une fraction. Les mauvaises en retirent (minimum 0).',
  partiel_negative: 'Une seule mauvaise reponse annule la question. Sinon, fraction des bonnes reponses.'
};

const modeTraining = document.getElementById('modeTraining');
const modeExam = document.getElementById('modeExam');
const trainingPanel = document.getElementById('trainingPanel');
const examPanel = document.getElementById('examPanel');
const questionsCountEls = Array.from(document.querySelectorAll('.js-questions-count'));
const resumeBtn = document.getElementById('resumeBtn');
const pausedSessionsPanel = document.getElementById('pausedSessionsPanel');
const pausedSessionsList = document.getElementById('pausedSessionsList');

const correctionSel = document.getElementById('correction_system');
const trainingCorrectionSel = document.getElementById('training_correction_system');
const correctionHelp = document.getElementById('correctionHelp');

const autoToggle = document.getElementById('autoAdvanceToggle');
const delayPanel = document.getElementById('delayPanel');
const delayPreset = document.getElementById('delayPreset');
const customDelayWrap = document.getElementById('customDelayWrap');
const customDelay = document.getElementById('customDelay');
const trainingQuestionCount = document.getElementById('training_question_count');
const examQuestionCount = document.getElementById('exam_question_count');
const trainingQuestionCountValue = document.getElementById('training_question_count_value');
const examQuestionCountValue = document.getElementById('exam_question_count_value');
const trainingSliderMax = document.getElementById('training_slider_max');
const examSliderMax = document.getElementById('exam_slider_max');
const trainingReviewModeSel = document.getElementById('training_review_mode');
const examReviewModeSel = document.getElementById('exam_review_mode');
const trainingHideMetaToggle = document.getElementById('training_hideMetaToggle');
const examHideMetaToggle = document.getElementById('exam_hideMetaToggle');
const examWarningInput = document.getElementById('exam_warning_minutes');

const selModule = document.getElementById('sel_module');
const selCourse = document.getElementById('sel_course');
const selSource = document.getElementById('sel_source');
const selFavTag = document.getElementById('sel_favtag');
let allCourses = [];
let questionsCache = null;
const favoriteTagsByQuestion = new Map();

function getSelectedValues(selectEl) {
  if (!selectEl) return [];
  return Array.from(selectEl.selectedOptions || [])
    .map(o => String(o.value || '').trim())
    .filter(Boolean);
}

function setOptions(selectEl, items, getLabel, selectedValues = []) {
  if (!selectEl) return;
  const selected = new Set((selectedValues || []).map(String));
  const hasSelection = selected.size > 0;
  selectEl.innerHTML = '';
  items.forEach(item => {
    const o = document.createElement('option');
    o.value = String(item.value ?? item.id);
    o.textContent = getLabel(item);
    o.selected = hasSelection && selected.has(String(item.value ?? item.id));
    selectEl.appendChild(o);
  });
  if (!hasSelection && selectEl.multiple) {
    Array.from(selectEl.options).forEach(o => { o.selected = false; });
    selectEl.selectedIndex = -1;
  }
}

let countTimer = null;

function selectMode(mode) {
  currentMode = mode;
  modeTraining.classList.toggle('selected', mode === 'training');
  modeExam.classList.toggle('selected', mode === 'exam');
  trainingPanel.classList.toggle('hidden', mode !== 'training');
  examPanel.classList.toggle('hidden', mode !== 'exam');
  scheduleCountRefresh();
}

function getActiveReviewMode() {
  const sel = currentMode === 'exam' ? examReviewModeSel : trainingReviewModeSel;
  return sel?.value || 'all';
}

function getActiveHideMeta() {
  const toggle = currentMode === 'exam' ? examHideMetaToggle : trainingHideMetaToggle;
  return !!toggle?.checked;
}

function syncSharedOptions(fromMode) {
  const fromReview = fromMode === 'exam' ? examReviewModeSel : trainingReviewModeSel;
  const toReview = fromMode === 'exam' ? trainingReviewModeSel : examReviewModeSel;
  const fromHide = fromMode === 'exam' ? examHideMetaToggle : trainingHideMetaToggle;
  const toHide = fromMode === 'exam' ? trainingHideMetaToggle : examHideMetaToggle;
  if (fromReview && toReview) toReview.value = fromReview.value;
  if (fromHide && toHide) toHide.checked = !!fromHide.checked;
}

function updateCorrectionHelp() {
  correctionHelp.textContent = correctionHelpText[correctionSel.value] || '';
}

function syncCorrectionSelects(fromExam) {
  if (fromExam) trainingCorrectionSel.value = correctionSel.value;
  else correctionSel.value = trainingCorrectionSel.value;
  updateCorrectionHelp();
}

modeTraining.addEventListener('click', () => selectMode('training'));
modeExam.addEventListener('click', () => selectMode('exam'));
correctionSel.addEventListener('change', () => syncCorrectionSelects(true));
trainingCorrectionSel.addEventListener('change', () => syncCorrectionSelects(false));
updateCorrectionHelp();

autoToggle.addEventListener('change', () => {
  delayPanel.classList.toggle('hidden', !autoToggle.checked);
});

delayPreset.addEventListener('change', () => {
  customDelayWrap.classList.toggle('hidden', delayPreset.value !== 'custom');
});

function getDelaySeconds() {
  if (!autoToggle.checked) return 0;
  if (delayPreset.value === 'custom') {
    const v = parseInt(customDelay.value || '5', 10);
    return Number.isNaN(v) || v < 1 ? 5 : v;
  }
  return parseInt(delayPreset.value, 10) || 2;
}

function getRequestedQuestionCount() {
  const source = currentMode === 'exam' ? examQuestionCount : trainingQuestionCount;
  const v = parseInt((source?.value || '').trim(), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function paintSlider(slider, valueEl) {
  if (!slider) return;
  const min = Number(slider.min || 1);
  const max = Number(slider.max || 1);
  const value = Number(slider.value || min);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 100;
  slider.style.setProperty('--pct', `${pct}%`);
  if (valueEl) {
    valueEl.innerHTML = `${value} <span>questions</span>`;
  }
}

function syncQuestionSliders(maxQ) {
  [trainingQuestionCount, examQuestionCount].forEach((slider) => {
    if (!slider) return;
    slider.max = String(maxQ);
    const touched = slider.dataset.touched === '1';
    let val = parseInt(slider.value || '1', 10);
    if (!touched || !Number.isFinite(val) || val < 1) val = maxQ;
    if (val > maxQ) val = maxQ;
    slider.value = String(val);
  });
  paintSlider(trainingQuestionCount, trainingQuestionCountValue);
  paintSlider(examQuestionCount, examQuestionCountValue);
  if (trainingSliderMax) trainingSliderMax.textContent = String(maxQ);
  if (examSliderMax) examSliderMax.textContent = String(maxQ);
}

async function loadModules() {
  try {
    isPopulatingFilters = true;
    const res = await fetch(`${API_URL}/modules`);
    if (!res.ok) return;
    const modules = await res.json();
    window.__dashboardModules = Array.isArray(modules) ? modules : [];
    setOptions(selModule, modules, (m) => m.name, getSelectedValues(selModule));
    window.dispatchEvent(new CustomEvent('dashboard:modules-loaded', { detail: { modules: window.__dashboardModules } }));
  } catch (_) {}
  finally { isPopulatingFilters = false; }
}

async function loadCourses() {
  const selectedModules = getSelectedValues(selModule).map(Number);
  const prevSelectedCourses = getSelectedValues(selCourse);
  if (!selectedModules.length) {
    selCourse.innerHTML = '';
    return;
  }
  try {
    isPopulatingFilters = true;
    const res = await fetch(`${API_URL}/courses`);
    if (!res.ok) return;
    allCourses = await res.json();
    const visibleCourses = selectedModules.length
      ? allCourses.filter(c => selectedModules.includes(Number(c.module_id)))
      : allCourses;
    setOptions(selCourse, visibleCourses, (c) => c.name, prevSelectedCourses);
  } catch (_) {}
  finally { isPopulatingFilters = false; }
}

async function loadSources() {
  const selectedModules = getSelectedValues(selModule);
  const prevSelectedSources = getSelectedValues(selSource);
  if (!selectedModules.length) {
    selSource.innerHTML = '';
    return;
  }
  try {
    isPopulatingFilters = true;
    const res = await fetch(`${API_URL}/sources?module_id=${selectedModules.join(',')}`);
    if (!res.ok) return;
    const sources = await res.json();
    setOptions(selSource, sources, (s) => s.name, prevSelectedSources);
  } catch (_) {}
  finally { isPopulatingFilters = false; }
}

async function loadFavoriteTags() {
  if (!selFavTag) return;
  try {
    isPopulatingFilters = true;
    const res = await fetch(`${API_URL}/users/flags?type=favorite`, { headers: getAuthHeaders() });
    if (!res.ok) {
      setOptions(selFavTag, [], (t) => t.name, []);
      return;
    }
    const rows = await res.json();
    favoriteTagsByQuestion.clear();
    const tagSet = new Set();
    rows.forEach((r) => {
      const qid = String(r.id || '').trim();
      const tags = String(r.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (!qid || !tags.length) return;
      favoriteTagsByQuestion.set(qid, tags);
      tags.forEach((t) => tagSet.add(t));
    });
    const tagItems = Array.from(tagSet)
      .sort((a, b) => a.localeCompare(b, 'fr'))
      .map((name, idx) => ({ id: `tag_${idx}`, name, value: name }));
    const selected = (localStorage.getItem('favorite_tags') || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    setOptions(selFavTag, tagItems, (t) => t.name, []);
    Array.from(selFavTag.options).forEach((o) => { o.selected = selected.includes(o.value); });
    setTimeout(() => scheduleCountRefresh(), 0);
  } catch (_) {
    setOptions(selFavTag, [], (t) => t.name, []);
  } finally { isPopulatingFilters = false; }
}

async function refreshQuestionCount() {
  if (!questionsCountEls.length) return;
  const setCountText = (v) => questionsCountEls.forEach((el) => { el.textContent = v; });
  try {
    if (isPopulatingFilters) return;
    setCountText('...');

    const moduleIds = getSelectedValues(selModule);
    const courseIds = getSelectedValues(selCourse);
    const sourceIds = getSelectedValues(selSource);
    const favoriteTags = getSelectedValues(selFavTag);
    const reviewMode = getActiveReviewMode();
    const wbMode = localStorage.getItem('wb_mode') || 'guided';
    const guidedFiltersRaw = localStorage.getItem('guided_filters');
    const countParams = new URLSearchParams();
    if (wbMode === 'guided' && guidedFiltersRaw) {
      countParams.set('guided_filters', guidedFiltersRaw);
    } else {
      if (moduleIds.length) countParams.set('module', moduleIds.join(','));
      if (courseIds.length) countParams.set('course', courseIds.join(','));
      if (sourceIds.length) countParams.set('source', sourceIds.join(','));
    }
    if (reviewMode && reviewMode !== 'all') countParams.set('review_mode', reviewMode);

    let total = 0;
    const countRes = await fetch(`${API_URL}/questions/count?${countParams.toString()}`, { headers: getAuthHeaders() });
    if (!countRes.ok) {
      setCountText('-');
      return;
    }
    const countData = await countRes.json();
    total = Number(countData.total || 0);

    if (favoriteTags.length) {
      const qRes = await fetch(`${API_URL}/questions?${countParams.toString()}&page=1&page_size=5000`, { headers: getAuthHeaders() });
      if (!qRes.ok) {
        setCountText('-');
        return;
      }
      const data = await qRes.json();
      const rows = data.questions || data || [];
      total = rows.filter((q) => {
        const qId = String(q.id || '');
        const qTags = favoriteTagsByQuestion.get(qId) || [];
        return favoriteTags.some((t) => qTags.includes(t));
      }).length;
    }

    setCountText(Number(total).toLocaleString('fr-FR'));
    const maxQ = Math.max(1, total);
    syncQuestionSliders(maxQ);
  } catch (_) {
    setCountText('-');
  }
}

function scheduleCountRefresh() {
  if (isPopulatingFilters) return;
  if (countTimer) clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    refreshQuestionCount();
  }, 300);
}

async function loadPreferences() {
  try {
    const res = await fetch(`${API_URL}/users/preferences`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const prefs = await res.json();
    if (prefs.default_exam_minutes) {
      document.getElementById('exam_minutes').value = prefs.default_exam_minutes;
    }
    if (prefs.exam_warning_minutes) {
      if (examWarningInput) examWarningInput.value = prefs.exam_warning_minutes;
    }
    if (prefs.correction_system) {
      correctionSel.value = prefs.correction_system;
      trainingCorrectionSel.value = prefs.correction_system;
    }
    autoToggle.checked = !!prefs.auto_next_enabled;
    delayPanel.classList.toggle('hidden', !autoToggle.checked);
    const delay = Number(prefs.auto_next_delay_sec || 2);
    if ([2, 3, 5, 10].includes(delay)) {
      delayPreset.value = String(delay);
      customDelayWrap.classList.add('hidden');
    } else {
      delayPreset.value = 'custom';
      customDelayWrap.classList.remove('hidden');
      customDelay.value = String(delay);
    }
    localStorage.setItem('show_explanation_auto', prefs.show_explanation_auto === false ? '0' : '1');
    localStorage.setItem('show_notes_inline', prefs.show_notes_inline ? '1' : '0');
    const themePref = prefs.theme_preference || 'system';
    localStorage.setItem('theme_preference', themePref);
    if (themePref === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', themePref);
    if (window.__applyThemePreference) window.__applyThemePreference();
    updateCorrectionHelp();
  } catch (_) {}
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

async function loadUser() {
  try {
    const [userRes, notifRes] = await Promise.all([
      fetch(`${API_URL}/users/me`, { headers: getAuthHeaders() }),
      fetch(`${API_URL}/messages/unread-count`, { headers: getAuthHeaders() })
    ]);
    if (!userRes.ok) return;
    const user = await userRes.json();
    const notif = notifRes.ok ? await notifRes.json() : { unread: 0 };
    const unread = notif.unread || 0;

    const area = document.getElementById('dashUserArea');
    if (!area) return;

    const initials = getInitials(user.display_name || user.email);
    const avatarImg = user.profile_photo
      ? `<img src="${user.profile_photo}" alt="${initials}" class="topbar-avatar-img">`
      : `<span>${initials}</span>`;

    area.innerHTML = `
      <div class="topbar-right">
        <a href="profile.html" class="topbar-notif-btn" title="Messages">
          <i class="bi bi-bell"></i>
          ${unread > 0 ? `<span class="topbar-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </a>
        <div class="topbar-avatar-wrap">
          <button class="topbar-avatar" type="button" id="topbarAvatarBtn" aria-haspopup="true" aria-expanded="false">
            ${avatarImg}
          </button>
          <div class="topbar-dropdown hidden" id="topbarDropdown">
            <div class="topbar-dropdown-name">${user.display_name || user.email}</div>
            <div class="topbar-dropdown-divider"></div>
            <a href="profile.html" class="topbar-dropdown-item">
              <i class="bi bi-person"></i> Mon profil
            </a>
            <div class="topbar-dropdown-divider"></div>
            <button type="button" class="topbar-dropdown-item topbar-dropdown-item--danger" id="topbarLogoutBtn">
              <i class="bi bi-box-arrow-right"></i> Déconnexion
            </button>
          </div>
        </div>
      </div>`;

    // Avatar dropdown
    const avatarBtn = document.getElementById('topbarAvatarBtn');
    const dropdown = document.getElementById('topbarDropdown');
    avatarBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !dropdown.classList.contains('hidden');
      dropdown.classList.toggle('hidden');
      avatarBtn.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', () => {
      dropdown?.classList.add('hidden');
      avatarBtn?.setAttribute('aria-expanded', 'false');
    });

    // Logout
    document.getElementById('topbarLogoutBtn')?.addEventListener('click', () => {
      clearAuthState();
      window.location.href = 'login.html';
    });
  } catch (_) {}
}

function setupResumeButton() {
  if (!resumeBtn) return;
  const paused = loadPausedSessions();
  if (!paused.length && !localStorage.getItem('qcm_session_draft')) return;

  if (paused.length) {
    renderPausedSessions(paused);
    pausedSessionsPanel?.classList.remove('hidden');
    resumeBtn.classList.add('hidden');
    return;
  }

  resumeBtn.classList.remove('hidden');
  resumeBtn.addEventListener('click', () => {
    localStorage.setItem('qcm_resume_requested', '1');
    window.location.href = 'qcm.html';
  });
}

function loadPausedSessions() {
  try {
    const raw = localStorage.getItem('qcm_paused_sessions');
    const rows = JSON.parse(raw || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function savePausedSessions(rows) {
  try {
    localStorage.setItem('qcm_paused_sessions', JSON.stringify(rows || []));
  } catch (_) {}
}

function renderPausedSessions(rows) {
  if (!pausedSessionsList) return;
  if (!rows.length) {
    pausedSessionsList.innerHTML = '<div class="muted">Aucune session en pause.</div>';
    return;
  }
  pausedSessionsList.innerHTML = rows.map((s) => {
    const modeLabel = s.mode === 'exam' ? 'Examen' : 'Entrainement';
    const name = s.name || `${modeLabel} - ${new Date(s.created_at || Date.now()).toLocaleString('fr-FR')}`;
    return `<div class="mini-row"><div><strong>${name}</strong><div class="muted">${modeLabel}</div></div><div class="muted">Q${Number(s.index || 0) + 1}</div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-inline" data-resume-paused="${s.id}"><i class="bi bi-play-fill"></i> Reprendre</button><button class="btn-inline" data-delete-paused="${s.id}" style="color:var(--red)"><i class="bi bi-trash"></i> Supprimer</button></div></div>`;
  }).join('');

  pausedSessionsList.querySelectorAll('[data-resume-paused]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-resume-paused');
      const found = rows.find((r) => String(r.id) === String(id));
      if (!found || !found.draft) return;
      try {
        localStorage.setItem('qcm_session_draft', JSON.stringify(found.draft));
      } catch (_) {}
      localStorage.setItem('qcm_resumed_paused_id', String(id));
      localStorage.setItem('qcm_resume_requested', '1');
      window.location.href = 'qcm.html';
    });
  });
  pausedSessionsList.querySelectorAll('[data-delete-paused]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-delete-paused');
      const next = rows.filter((r) => String(r.id) !== String(id));
      savePausedSessions(next);
      renderPausedSessions(next);
      if (!next.length) pausedSessionsPanel?.classList.add('hidden');
    });
  });
}

selModule.addEventListener('change', () => {
  if (isPopulatingFilters) return;
  Promise.all([loadCourses(), loadSources()]).then(scheduleCountRefresh);
});
selCourse.addEventListener('change', () => { if (!isPopulatingFilters) scheduleCountRefresh(); });
selSource.addEventListener('change', () => { if (!isPopulatingFilters) scheduleCountRefresh(); });
selFavTag?.addEventListener('change', () => { if (!isPopulatingFilters) scheduleCountRefresh(); });
trainingReviewModeSel?.addEventListener('change', () => { syncSharedOptions('training'); if (!isPopulatingFilters) scheduleCountRefresh(); });
examReviewModeSel?.addEventListener('change', () => { syncSharedOptions('exam'); if (!isPopulatingFilters) scheduleCountRefresh(); });
trainingHideMetaToggle?.addEventListener('change', () => syncSharedOptions('training'));
examHideMetaToggle?.addEventListener('change', () => syncSharedOptions('exam'));

const startBtn = document.getElementById('startBtn');
startBtn.addEventListener('click', () => {
  localStorage.removeItem('qcm_session_draft');
  localStorage.removeItem('qcm_resume_requested');

  localStorage.setItem('mode', currentMode);
  localStorage.setItem('module_id', getSelectedValues(selModule).join(','));
  localStorage.setItem('course_id', getSelectedValues(selCourse).join(','));
  localStorage.setItem('source_id', getSelectedValues(selSource).join(','));
  localStorage.setItem('favorite_tags', getSelectedValues(selFavTag).join(','));
  localStorage.setItem('review_mode', getActiveReviewMode());
  localStorage.setItem('hide_question_meta', getActiveHideMeta() ? '1' : '0');

  const corrSystem = currentMode === 'exam' ? correctionSel.value : trainingCorrectionSel.value;
  localStorage.setItem('correction_system', corrSystem);
  const questionLimit = getRequestedQuestionCount();
  if (questionLimit) localStorage.setItem('question_limit', String(questionLimit));
  else localStorage.removeItem('question_limit');

  if (currentMode === 'exam') {
    const minutesStr = document.getElementById('exam_minutes').value || '';
    localStorage.setItem('exam_minutes', minutesStr);
    const warningMins = parseInt((examWarningInput?.value || '').trim(), 10);
    if (Number.isFinite(warningMins) && warningMins > 0) localStorage.setItem('exam_warning_minutes', String(warningMins));
    else localStorage.removeItem('exam_warning_minutes');
    localStorage.removeItem('auto_advance');
    localStorage.removeItem('auto_advance_delay');
    localStorage.setItem('training_next_mode', 'manual');
    localStorage.removeItem('training_delay_seconds');
  } else {
    localStorage.removeItem('exam_minutes');
    if (autoToggle.checked) {
      localStorage.setItem('auto_advance', '1');
      localStorage.setItem('auto_advance_delay', String(getDelaySeconds() * 1000));
      localStorage.setItem('training_next_mode', 'auto');
      localStorage.setItem('training_delay_seconds', String(getDelaySeconds()));
    } else {
      localStorage.removeItem('auto_advance');
      localStorage.removeItem('auto_advance_delay');
      localStorage.setItem('training_next_mode', 'manual');
      localStorage.removeItem('training_delay_seconds');
    }
  }

  window.location.href = 'qcm.html';
});

[trainingQuestionCount, examQuestionCount].forEach((slider, idx) => {
  if (!slider) return;
  const valueEl = idx === 0 ? trainingQuestionCountValue : examQuestionCountValue;
  slider.addEventListener('input', () => {
    slider.dataset.touched = '1';
    paintSlider(slider, valueEl);
  });
});

const reviewModeSaved = localStorage.getItem('review_mode') || 'all';
if (trainingReviewModeSel) trainingReviewModeSel.value = reviewModeSaved;
if (examReviewModeSel) examReviewModeSel.value = reviewModeSaved;
const hideMetaSaved = localStorage.getItem('hide_question_meta') === '1';
if (trainingHideMetaToggle) trainingHideMetaToggle.checked = hideMetaSaved;
if (examHideMetaToggle) examHideMetaToggle.checked = hideMetaSaved;
if (examWarningInput && localStorage.getItem('exam_warning_minutes')) {
  examWarningInput.value = localStorage.getItem('exam_warning_minutes');
}

loadModules();
loadSources();
loadFavoriteTags();
loadPreferences();
loadUser();
setupResumeButton();
scheduleCountRefresh();



