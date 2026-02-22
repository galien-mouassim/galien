let questions = [];
let index = 0;
let score = 0;
const mode = localStorage.getItem('mode') || 'training';
const correctionSystem = localStorage.getItem('correction_system') || 'tout_ou_rien';
let startTime = null;
let timerInterval = null;
let timeLimitSec = null;
let remainingSec = null;
let finished = false;
const favoriteTags = new Map();
const notesByQuestion = new Map();
const NOTE_MAX = 1000;
let noteAutoSaveTimer = null;
let noteDraftDirty = false;
let noteModalQuestionId = null;
const answeredScores = [];
const reviewRows = [];
let waitingForNextClick = false;
const userSelections = [];
const correctedByIndex = [];
let resumeDraft = null;

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function sameIdList(a, b) {
  const sa = [...new Set((a || []).map(String))].sort();
  const sb = [...new Set((b || []).map(String))].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

const moduleIds = parseIdList(localStorage.getItem('module_id'));
const courseIds = parseIdList(localStorage.getItem('course_id'));
const sourceIds = parseIdList(localStorage.getItem('source_id'));
const favoriteTagFilters = parseIdList(localStorage.getItem('favorite_tags'));
const questionLimitRaw = parseInt(localStorage.getItem('question_limit') || '', 10);
const questionLimit = Number.isFinite(questionLimitRaw) && questionLimitRaw > 0 ? questionLimitRaw : null;
const queryParams = new URLSearchParams();
if (moduleIds.length) queryParams.set('module', moduleIds.join(','));
if (courseIds.length) queryParams.set('course', courseIds.join(','));
if (sourceIds.length) queryParams.set('source', sourceIds.join(','));
const query = queryParams.toString() ? `?${queryParams.toString()}` : '';

fetch(`${API_URL}/questions${query}`, {
  headers: getAuthHeaders()
})
  .then(res => res.json())
  .then(async data => {
    questions = data.questions || data;
    questions.forEach(q => {
      const rawNote = typeof q.user_note === 'string' ? q.user_note.trim() : '';
      if (rawNote) {
        notesByQuestion.set(q.id, {
          note: rawNote,
          updated_at: q.user_note_updated_at || null,
          created_at: null
        });
      }
    });
    try {
      const favRes = await fetch(`${API_URL}/users/flags?type=favorite`, {
        headers: getAuthHeaders()
      });
      if (favRes.ok) {
        const favs = await favRes.json();
        favs.forEach(f => {
          if (f.id) favoriteTags.set(f.id, f.tags || '');
        });
      }
    } catch (err) {}

    if (favoriteTagFilters.length) {
      questions = questions.filter((q) => {
        const tagsRaw = favoriteTags.get(q.id) || '';
        const qTags = splitTags(tagsRaw);
        return favoriteTagFilters.some((t) => qTags.includes(t));
      });
    }

    if (questionLimit && questions.length > questionLimit) {
      questions = questions.slice(0, questionLimit);
    }
    if (!questions.length) {
      const qEl = document.getElementById('question');
      if (qEl) qEl.textContent = 'Aucune question trouvée pour ces filtres.';
      document.getElementById('options').innerHTML = '';
      document.getElementById('nextBtn')?.setAttribute('disabled', 'disabled');
      document.getElementById('prevBtn')?.setAttribute('disabled', 'disabled');
      return;
    }

    loadResumeDraft();
    applyResumeState();
    populateJumpSelector();
    startTimer();
    show();
  });

function loadResumeDraft() {
  if (localStorage.getItem('qcm_resume_requested') !== '1') return;
  try {
    const raw = localStorage.getItem('qcm_session_draft');
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft || !Array.isArray(draft.userSelections)) return;
    if (String(draft.mode || '') !== String(mode)) return;
    const draftModuleIds = parseIdList(draft.module_ids || draft.module_id);
    const draftCourseIds = parseIdList(draft.course_ids || draft.course_id);
    const draftSourceIds = parseIdList(draft.source_ids || draft.source_id);
    const draftFavoriteTags = parseIdList(draft.favorite_tags || '');
    if (!sameIdList(draftModuleIds, moduleIds)) return;
    if (!sameIdList(draftCourseIds, courseIds)) return;
    if (!sameIdList(draftSourceIds, sourceIds)) return;
    if (!sameIdList(draftFavoriteTags, favoriteTagFilters)) return;
    resumeDraft = draft;
  } catch (_) {}
}

function applyResumeState() {
  if (!resumeDraft) return;
  index = Math.min(Math.max(Number(resumeDraft.index) || 0, 0), Math.max(questions.length - 1, 0));
  score = Number(resumeDraft.score || 0);
  (resumeDraft.userSelections || []).forEach((v, i) => { userSelections[i] = Array.isArray(v) ? v : []; });
  (resumeDraft.correctedByIndex || []).forEach((v, i) => { correctedByIndex[i] = !!v; });
  (resumeDraft.answeredScores || []).forEach((v, i) => { answeredScores[i] = Number(v || 0); });
  (resumeDraft.reviewRows || []).forEach((v, i) => { reviewRows[i] = v; });
  if (mode === 'exam') {
    const draftLimit = Number(resumeDraft.timeLimitSec);
    const draftRemaining = Number(resumeDraft.remainingSec);
    if (Number.isFinite(draftLimit) && draftLimit > 0) timeLimitSec = draftLimit;
    if (Number.isFinite(draftRemaining) && draftRemaining > 0) remainingSec = draftRemaining;
  }
  localStorage.removeItem('qcm_resume_requested');
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function shouldAutoShowExplanation() {
  return localStorage.getItem('show_explanation_auto') !== '0';
}

function startTimer() {
  startTime = Date.now();
  const timerEl = document.getElementById('timer');

  if (mode === 'exam') {
    const minutesStr = localStorage.getItem('exam_minutes') || '';
    const customMinutes = parseInt(minutesStr, 10);
    if (Number.isFinite(customMinutes) && customMinutes > 0) {
      if (!Number.isFinite(Number(timeLimitSec)) || Number(timeLimitSec) <= 0) {
        timeLimitSec = customMinutes * 60;
      }
      if (!Number.isFinite(Number(remainingSec)) || Number(remainingSec) <= 0) {
        remainingSec = timeLimitSec;
      }
      timerEl.textContent = `Temps restant: ${formatTime(remainingSec)}`;

      timerInterval = setInterval(() => {
        remainingSec -= 1;
        if (remainingSec <= 0) {
          timerEl.textContent = 'Temps restant: 00:00';
          finishExam(true);
        } else {
          timerEl.textContent = `Temps restant: ${formatTime(remainingSec)}`;
        }
      }, 1000);
    } else {
      timeLimitSec = null;
      timerEl.textContent = 'Temps: 00:00';
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        timerEl.textContent = `Temps: ${formatTime(elapsed)}`;
      }, 1000);
    }
  } else {
    timerEl.textContent = 'Temps: 00:00';
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      timerEl.textContent = `Temps: ${formatTime(elapsed)}`;
    }, 1000);
  }
}

function evaluateCurrentQuestionIfNeeded() {
  if (!questions.length) return;
  const current = questions[index];
  if (!current || correctedByIndex[index]) return;

  const selectedOptions = [...document.querySelectorAll('#options input:checked')].map(i => i.value);
  userSelections[index] = selectedOptions;
  const correctOptions = parseCorrectOptions(current);
  const qScore = scoreQuestion(correctOptions, selectedOptions);

  correctedByIndex[index] = true;
  answeredScores[index] = qScore;
  score = answeredScores.reduce((acc, s) => acc + (Number(s) || 0), 0);
  saveReviewRow(current, selectedOptions, qScore);
}

async function finishExam(timeout = false, totalOverride = null) {
  if (finished) return;
  finished = true;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const computedDoneCount = Math.max(
    correctedByIndex.filter(Boolean).length,
    reviewRows.filter(Boolean).length,
    answeredScores.filter((v) => typeof v === 'number').length
  );
  let finalTotal = Number.isFinite(Number(totalOverride)) && Number(totalOverride) >= 0
    ? Number(totalOverride)
    : questions.length;
  if (!Number.isFinite(finalTotal) || finalTotal < 0) finalTotal = 0;
  if (finalTotal === 0 && computedDoneCount > 0) finalTotal = computedDoneCount;
  if (finalTotal === 0 && score > 0) finalTotal = 1;
  localStorage.setItem('score', score);
  localStorage.setItem('total', String(finalTotal));
  localStorage.setItem('raw_total', String(finalTotal));
  localStorage.setItem('elapsed_seconds', elapsed.toString());
  localStorage.setItem('time_limit_seconds', timeLimitSec ? timeLimitSec.toString() : '');
  localStorage.setItem('exam_timeout', timeout ? '1' : '0');
  localStorage.setItem('correction_system', correctionSystem);
  localStorage.setItem('result_review', JSON.stringify(reviewRows.filter(Boolean)));
  localStorage.removeItem('last_session_id');
  const question_results = reviewRows
    .filter(Boolean)
    .map((r, i) => ({
      question_id: r.question_id || null,
      question_num: i + 1,
      question_text: r.question || '',
      user_answer: Array.isArray(r.selected) ? r.selected.join(',') : '',
      correct_answer: Array.isArray(r.correct) ? r.correct.join(',') : '',
      score: Number(r.score || 0),
      option_a: r.options?.A || null,
      option_b: r.options?.B || null,
      option_c: r.options?.C || null,
      option_d: r.options?.D || null,
      option_e: r.options?.E || null,
      explanation: r.explanation || null
    }));

  localStorage.setItem('pending_result_payload', JSON.stringify({
    score,
    total: finalTotal,
    mode,
    elapsed_seconds: elapsed,
    correction_system: correctionSystem,
    time_limit_seconds: timeLimitSec,
    question_results
  }));
  localStorage.removeItem('qcm_session_draft');

  window.location.href = 'result.html';
}

function show() {
  const q = questions[index];
  waitingForNextClick = false;
  updateProgressUI();
  const jump = document.getElementById('jumpQuestion');
  if (jump) jump.value = String(index);
  document.getElementById('question').innerText = q.question;
  const prevBtn = document.getElementById('prevBtn');
  const navWrap = document.querySelector('.q-nav');
  const hasPrevious = index > 0;
  if (prevBtn) {
    prevBtn.toggleAttribute('disabled', !hasPrevious);
    prevBtn.classList.toggle('hidden', !hasPrevious);
  }
  navWrap?.classList.toggle('single-next', !hasPrevious);

  const favBtn = document.getElementById('favBtn');
  favBtn?.classList.toggle('active', favoriteTags.has(q.id));
  document.getElementById('commentBtn')?.classList.remove('active');
  document.getElementById('flagBtn')?.classList.remove('active');
  updateNoteVisualState(q.id);
  renderInlineNote(q.id);

  const moduleTag = document.getElementById('moduleTag');
  const courseTag = document.getElementById('courseTag');
  const moduleName = q.module_name ? q.module_name : '';
  const courseName = q.course_name ? q.course_name : '';

  if (moduleName) {
    moduleTag.textContent = moduleName;
    moduleTag.style.display = 'inline-block';
  } else {
    moduleTag.textContent = '';
    moduleTag.style.display = 'none';
  }

  if (courseName) {
    courseTag.textContent = courseName;
    courseTag.style.display = 'inline-block';
  } else {
    courseTag.textContent = '';
    courseTag.style.display = 'none';
  }

  const opts = ['A','B','C','D','E'];
  const container = document.getElementById('options');
  container.innerHTML = '';
  const explanation = document.getElementById('explanation');
  explanation.textContent = '';
  explanation.classList.remove('visible');
  const commentInput = document.getElementById('commentInput');
  if (commentInput) commentInput.value = '';
  const commentBox = document.getElementById('commentBox');
  if (commentBox) commentBox.classList.add('hidden');

  opts.forEach(letter => {
    container.innerHTML += `
      <label class="option">
        <input type="checkbox" value="${letter}">
        ${q[`option_${letter.toLowerCase()}`]}
      </label>`;
  });

  const saved = userSelections[index] || [];
  document.querySelectorAll('#options input[type="checkbox"]').forEach((input) => {
    input.checked = saved.includes(input.value);
  });

  const nextBtn = document.getElementById('nextBtn');
  if (mode === 'training') {
    if (correctedByIndex[index]) {
      nextBtn.textContent = 'Question suivante';
      applyCorrectionVisuals(q, saved);
      if (q.explanation && shouldAutoShowExplanation()) {
        explanation.textContent = q.explanation;
        explanation.classList.add('visible');
      }
      document.querySelectorAll('#options input[type="checkbox"]').forEach(input => {
        input.disabled = true;
      });
    } else {
      nextBtn.textContent = 'Corriger';
    }
  } else {
    nextBtn.textContent = 'Question suivante';
  }

  // Comments are loaded on demand
}

function updateProgressUI() {
  const done = correctedByIndex.filter(Boolean).length;
  const total = questions.length || 1;
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const progressEl = document.getElementById('progress');
  if (progressEl) {
    progressEl.innerText = `Question ${index + 1} / ${questions.length} - ${done} terminees`;
  }
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = `${pct}%`;
}

function populateJumpSelector() {
  const jump = document.getElementById('jumpQuestion');
  if (!jump) return;
  jump.innerHTML = questions.map((_, i) => `<option value="${i}">Q${i + 1}</option>`).join('');
  jump.addEventListener('change', () => {
    const to = Number(jump.value);
    if (!Number.isInteger(to) || to < 0 || to >= questions.length) return;
    index = to;
    show();
  });
}

function parseCorrectOptions(question) {
  if (Array.isArray(question.correct_options)) return question.correct_options;
  if (typeof question.correct_option === 'string') {
    return question.correct_option
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

function applyCorrectionVisuals(question, selectedOptions) {
  const correctOptions = parseCorrectOptions(question);
  const options = document.querySelectorAll('.option');

  options.forEach((opt) => {
    const input = opt.querySelector('input');
    const value = input.value;

    opt.classList.remove('correct', 'wrong');

    if (correctOptions.includes(value)) {
      opt.classList.add('correct');
    }
    if (selectedOptions.includes(value) && !correctOptions.includes(value)) {
      opt.classList.add('wrong');
    }
  });
}

function saveReviewRow(question, selectedOptions, qScore) {
  const correctOptions = parseCorrectOptions(question);
  reviewRows[index] = {
    index,
    question_id: question.id,
    question: question.question,
    explanation: question.explanation || '',
    options: {
      A: question.option_a,
      B: question.option_b,
      C: question.option_c,
      D: question.option_d,
      E: question.option_e
    },
    selected: selectedOptions,
    correct: correctOptions,
    score: qScore
  };
  localStorage.setItem('result_review', JSON.stringify(reviewRows.filter(Boolean)));
}

function scoreQuestion(correctOptions, selectedOptions) {
  const correct = new Set(correctOptions);
  const selected = new Set(selectedOptions);

  const correctCount = correctOptions.length;

  // Single-answer questions are always "tout ou rien"
  if (correctCount === 1 || correctionSystem === 'tout_ou_rien') {
    const selectedSorted = [...selected].sort().join(',');
    const correctSorted = [...correct].sort().join(',');
    return selectedSorted === correctSorted ? 1 : 0;
  }

  let correctSelected = 0;
  let wrongSelected = 0;

  selected.forEach(opt => {
    if (correct.has(opt)) correctSelected++;
    else wrongSelected++;
  });

  if (correctionSystem === 'partiel_negative') {
    if (wrongSelected > 0) return 0;
    return correctSelected / correctCount;
  }

  // partiel_positive
  const fraction = (correctSelected - wrongSelected) / correctCount;
  return Math.max(0, fraction);
}

function next() {
  if (!questions.length) return;
  const current = questions[index];
  const selectedOptions = [...document.querySelectorAll('#options input:checked')].map(i => i.value);
  userSelections[index] = selectedOptions;

  if (mode === 'training' && correctedByIndex[index]) {
    index += 1;
    if (index < questions.length) show();
    else finishExam(false);
    return;
  }

  const correctOptions = parseCorrectOptions(current);
  const qScore = scoreQuestion(correctOptions, selectedOptions);

  if (!correctedByIndex[index]) {
    correctedByIndex[index] = true;
    answeredScores[index] = qScore;
    score = answeredScores.reduce((acc, s) => acc + (Number(s) || 0), 0);
  }

  applyCorrectionVisuals(current, selectedOptions);
  document.querySelectorAll('#options input[type="checkbox"]').forEach(input => {
    input.disabled = true;
  });

  const explanation = document.getElementById('explanation');
  if (mode === 'training' && current.explanation && shouldAutoShowExplanation()) {
    explanation.textContent = current.explanation;
    explanation.classList.add('visible');
  }

  saveReviewRow(current, selectedOptions, qScore);

  if (mode === 'training') {
    const nextBtn = document.getElementById('nextBtn');
    waitingForNextClick = true;
    if (nextBtn) nextBtn.textContent = 'Question suivante';

    const nextMode =
      (localStorage.getItem('training_next_mode') || '').trim() ||
      (localStorage.getItem('auto_advance') === '1' ? 'auto' : 'manual');
    const delaySource =
      localStorage.getItem('training_delay_seconds') ||
      (localStorage.getItem('auto_advance_delay')
        ? String(Math.max(1, Math.round(Number(localStorage.getItem('auto_advance_delay')) / 1000)))
        : '2');
    const delay = parseInt(delaySource || '2', 10);
    if (nextMode === 'auto') {
      const delayMs = Math.max(1, Number.isFinite(delay) ? delay : 2) * 1000;
      setTimeout(() => {
        if (!waitingForNextClick || index >= questions.length) return;
        index += 1;
        if (index < questions.length) show();
        else finishExam(false);
      }, delayMs);
    }
    return;
  }

  index += 1;
  if (index < questions.length) show();
  else finishExam(false);
}

function prevQuestion() {
  if (index <= 0) return;
  index -= 1;
  show();
}

function buildSessionDraftPayload() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  return {
    mode,
    module_id: moduleIds.join(','),
    course_id: courseIds.join(','),
    source_id: sourceIds.join(','),
    favorite_tags: favoriteTagFilters.join(','),
    module_ids: moduleIds,
    course_ids: courseIds,
    source_ids: sourceIds,
    index,
    score,
    answeredScores,
    userSelections,
    correctedByIndex,
    reviewRows,
    elapsed,
    timeLimitSec,
    remainingSec
  };
}

function saveSessionDraft() {
  if (!questions.length || finished) return;
  try {
    localStorage.setItem('qcm_session_draft', JSON.stringify(buildSessionDraftPayload()));
    localStorage.removeItem('qcm_resume_requested');
  } catch (_) {}
}

function pauseSession() {
  if (!questions.length || finished) return;
  saveSessionDraft();
  window.location.href = 'dashboard.html';
}

function endSessionNow() {
  if (!questions.length || finished) return;
  const modal = document.getElementById('endSessionModal');
  const confirmBtn = document.getElementById('confirmEndSessionBtn');
  const cancelBtn = document.getElementById('cancelEndSessionBtn');
  if (!modal || !confirmBtn || !cancelBtn) return;

  const close = () => modal.classList.add('hidden');
  confirmBtn.onclick = () => {
    close();
    evaluateCurrentQuestionIfNeeded();
    const doneCount = Math.max(
      correctedByIndex.filter(Boolean).length,
      reviewRows.filter(Boolean).length,
      answeredScores.filter((v) => typeof v === 'number').length
    );
    finishExam(false, doneCount);
  };
  cancelBtn.onclick = close;
  modal.classList.remove('hidden');
}

function splitTags(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function collectExistingFavoriteTags() {
  const set = new Set();
  favoriteTags.forEach((tagsRaw) => {
    splitTags(tagsRaw).forEach((t) => set.add(t));
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
}

function renderFavoriteTagSuggestions(currentTagsRaw) {
  const select = document.getElementById('favoriteTagSuggestions');
  if (!select) return;
  const existing = collectExistingFavoriteTags();
  const selected = new Set(splitTags(currentTagsRaw));
  if (!existing.length) {
    select.innerHTML = '';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = existing
    .map((tag) => `<option value="${tag.replace(/"/g, '&quot;')}" ${selected.has(tag) ? 'selected' : ''}>${tag}</option>`)
    .join('');
}

async function favoriteCurrent() {
  const current = questions[index];
  if (!current) return;
  const modal = document.getElementById('favoriteModal');
  const input = document.getElementById('favoriteTagsInput');
  const saveBtn = document.getElementById('saveFavoriteBtn');
  const removeBtn = document.getElementById('removeFavoriteBtn');
  const cancelBtn = document.getElementById('cancelFavoriteBtn');
  const favBtn = document.getElementById('favBtn');

  const isActive = favBtn?.classList.contains('active');
  const existingTags = favoriteTags.get(current.id) || '';
  if (input) {
    input.value = existingTags;
    renderFavoriteTagSuggestions(existingTags);
    input.oninput = () => renderFavoriteTagSuggestions(input.value);
  }
  if (removeBtn) removeBtn.disabled = !isActive;

  const close = () => {
    modal.classList.add('hidden');
  };

  saveBtn.onclick = async () => {
    const tags = input.value.trim();
    try {
      await fetch(`${API_URL}/users/questions/${current.id}/flag`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ flag_type: 'favorite', tags })
      });
      favBtn?.classList.add('active');
      favoriteTags.set(current.id, tags);
      close();
    } catch (err) {}
  };

  removeBtn.onclick = async () => {
    try {
      await fetch(`${API_URL}/users/questions/${current.id}/flag?type=favorite`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      favBtn?.classList.remove('active');
      favoriteTags.delete(current.id);
      close();
    } catch (err) {}
  };

  cancelBtn.onclick = () => close();
  const suggestionsWrap = document.getElementById('favoriteTagSuggestions');
  if (suggestionsWrap && input) {
    suggestionsWrap.onchange = () => {
      const selectedFromList = Array.from(suggestionsWrap.selectedOptions).map((o) => o.value);
      const existingSet = new Set(Array.from(suggestionsWrap.options).map((o) => o.value));
      const customOnly = splitTags(input.value).filter((t) => !existingSet.has(t));
      input.value = [...selectedFromList, ...customOnly].join(', ');
    };
  }
  modal.classList.remove('hidden');
}

function getInitials(name) {
  return name
    .split(' ')
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .substring(0, 2);
}

function showLoadingSkeleton(list) {
  list.innerHTML = `
    <div class="comment-skeleton">
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
    </div>
    <div class="comment-skeleton">
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line"></div>
    </div>
  `;
}

function showEmptyState(list) {
  list.innerHTML = `
    <div class="comment-empty">
      <i class="bi bi-chat-dots"></i>
      <p>Aucun commentaire pour le moment.<br>Soyez le premier à commenter!</p>
    </div>
  `;
}

async function loadComments(questionId) {
  const list = document.getElementById('commentsList');
  const count = document.getElementById('commentCount');
  if (!list) return;

  showLoadingSkeleton(list);

  try {
    const res = await fetch(`${API_URL}/questions/${questionId}/comments`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Failed to load comments');

    const data = await res.json();
    if (count) count.textContent = `(${data.length})`;

    if (!data.length) {
      showEmptyState(list);
      return;
    }

    list.innerHTML = '';
    const baseUrl = API_URL.replace(/\/api\/?$/, '');

    data.forEach(c => {
      const item = document.createElement('div');
      item.className = 'comment-item';

      const author = c.display_name || c.email || 'Anonyme';
      const initials = getInitials(author);
      const date = c.created_at
        ? new Date(c.created_at).toLocaleString('fr-FR', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
          })
        : '';

      const likes = Number(c.likes || 0);
      const dislikes = Number(c.dislikes || 0);
      const my = Number(c.my_reaction || 0);
      const canEdit = !!c.can_edit;

      const photo = c.profile_photo
        ? (c.profile_photo.startsWith('http') ? c.profile_photo : `${baseUrl}${c.profile_photo}`)
        : '';
      const avatarHtml = photo ? `<img src="${photo}" alt="">` : initials;

      const editHtml = canEdit
        ? `<div class="comment-menu">
            <button class="comment-menu-btn" type="button">
              <i class="bi bi-three-dots-vertical"></i>
            </button>
            <div class="comment-menu-list hidden">
              <button class="comment-menu-item edit" data-id="${c.id}" type="button">
                <i class="bi bi-pencil"></i>
                Modifier
              </button>
              <button class="comment-menu-item delete" data-id="${c.id}" type="button">
                <i class="bi bi-trash"></i>
                Supprimer
              </button>
            </div>
          </div>`
        : '';

      item.innerHTML = `
        <div class="comment-row">
          <div class="comment-avatar">${avatarHtml}</div>
          <div class="comment-content">
            <div class="comment-meta">
              <span class="comment-author">${author}</span>
              <span class="comment-date muted">${date}</span>
              ${editHtml}
            </div>
            <div class="comment-body">${c.body}</div>
            <div class="comment-actions">
              <button class="comment-action like ${my === 1 ? 'active' : ''}" data-id="${c.id}" data-value="1" type="button">
                <i class="bi bi-heart-fill"></i>
                <span>${likes}</span>
              </button>
              <button class="comment-action dislike ${my === -1 ? 'active' : ''}" data-id="${c.id}" data-value="-1" type="button">
                <i class="bi bi-hand-thumbs-down-fill"></i>
                <span>${dislikes}</span>
              </button>
            </div>
          </div>
        </div>
      `;
      list.appendChild(item);
    });

    attachCommentEventListeners(list, questionId);
  } catch (err) {
    list.innerHTML = '<div class="comment-empty"><i class="bi bi-exclamation-circle"></i><p>Impossible de charger les commentaires.</p></div>';
  }
}

function attachCommentEventListeners(list, questionId) {
  list.querySelectorAll('.comment-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const commentId = btn.getAttribute('data-id');
      const valueAttr = btn.getAttribute('data-value');
      if (!valueAttr) return;
      const value = Number(valueAttr);
      const group = btn.closest('.comment-actions');
      if (!group) return;
      const likeBtn = group.querySelector('.comment-action.like');
      const dislikeBtn = group.querySelector('.comment-action.dislike');
      const likeCount = likeBtn?.querySelector('span');
      const dislikeCount = dislikeBtn?.querySelector('span');

      const wasLike = likeBtn?.classList.contains('active');
      const wasDislike = dislikeBtn?.classList.contains('active');

      let nextLike = wasLike;
      let nextDislike = wasDislike;

      if (value === 1) {
        nextLike = !wasLike;
        nextDislike = false;
      } else if (value === -1) {
        nextDislike = !wasDislike;
        nextLike = false;
      }

      const likeBase = Number(likeCount?.textContent || 0);
      const dislikeBase = Number(dislikeCount?.textContent || 0);
      const likeDelta = (nextLike ? 1 : 0) - (wasLike ? 1 : 0);
      const dislikeDelta = (nextDislike ? 1 : 0) - (wasDislike ? 1 : 0);

      if (likeCount) likeCount.textContent = String(Math.max(0, likeBase + likeDelta));
      if (dislikeCount) dislikeCount.textContent = String(Math.max(0, dislikeBase + dislikeDelta));
      likeBtn?.classList.toggle('active', nextLike);
      dislikeBtn?.classList.toggle('active', nextDislike);

      try {
        await fetch(`${API_URL}/comments/${commentId}/reaction`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ value })
        });
      } catch (err) {
        if (likeCount) likeCount.textContent = String(likeBase);
        if (dislikeCount) dislikeCount.textContent = String(dislikeBase);
        likeBtn?.classList.toggle('active', wasLike);
        dislikeBtn?.classList.toggle('active', wasDislike);
      }
    });
  });

  list.querySelectorAll('.comment-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      list.querySelectorAll('.comment-menu-list').forEach(menu => menu.classList.add('hidden'));
      const menu = btn.parentElement?.querySelector('.comment-menu-list');
      if (!menu) return;
      menu.classList.toggle('hidden');
    });
  });

  list.querySelectorAll('.comment-menu-item.edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const commentId = btn.getAttribute('data-id');
      if (!commentId) return;
      const bodyEl = btn.closest('.comment-item')?.querySelector('.comment-body');
      const currentBody = bodyEl?.textContent || '';
      const modal = document.getElementById('commentEditModal');
      const input = document.getElementById('commentEditInput');
      const saveBtn = document.getElementById('commentEditSave');
      const cancelBtn = document.getElementById('commentEditCancel');

      const close = () => {
        modal?.classList.add('hidden');
        if (input) input.value = '';
      };

      if (input) input.value = currentBody;

      const onSave = async () => {
        const trimmed = input.value.trim();
        if (!trimmed) return;
        try {
          const res = await fetch(`${API_URL}/comments/${commentId}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ body: trimmed })
          });
          if (res.ok) {
            if (bodyEl) bodyEl.textContent = trimmed;
            close();
          }
        } catch (err) {}
      };

      saveBtn.onclick = onSave;
      cancelBtn.onclick = close;
      modal?.classList.remove('hidden');
    });
  });

  list.querySelectorAll('.comment-menu-item.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const commentId = btn.getAttribute('data-id');
      if (!commentId) return;
      const modal = document.getElementById('commentDeleteModal');
      const confirmBtn = document.getElementById('commentDeleteConfirm');
      const cancelBtn = document.getElementById('commentDeleteCancel');

      const close = () => modal?.classList.add('hidden');

      const onConfirm = async () => {
        try {
          const res = await fetch(`${API_URL}/comments/${commentId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          });
          if (res.ok) {
            close();
            loadComments(questionId);
          }
        } catch (err) {}
      };

      confirmBtn.onclick = onConfirm;
      cancelBtn.onclick = close;
      modal?.classList.remove('hidden');
    });
  });

  if (!window.__commentOutsideListener) {
    window.__commentOutsideListener = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.comment-menu-list').forEach(menu => menu.classList.add('hidden'));
    });
  }
}

function makeTextareaAutoExpand(textarea) {
  textarea.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const commentInput = document.getElementById('commentInput');
  if (commentInput) makeTextareaAutoExpand(commentInput);
});

async function sendComment() {
  const current = questions[index];
  if (!current) return;
  const input = document.getElementById('commentInput');
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  try {
    const res = await fetch(`${API_URL}/questions/${current.id}/comments`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ body })
    });
    if (res.ok) {
      input.value = '';
      loadComments(current.id);
    }
  } catch (err) {}
}

function toggleComments() {
  const box = document.getElementById('commentBox');
  const btn = document.getElementById('commentBtn');
  if (!box || !btn) return;
  const isOpen = !box.classList.contains('hidden');
  if (isOpen) {
    box.classList.add('hidden');
    btn.classList.remove('active');
  } else {
    box.classList.remove('hidden');
    btn.classList.add('active');
    const current = questions[index];
    if (current) loadComments(current.id);
  }
}

async function flagCurrent() {
  const current = questions[index];
  if (!current) return;
  const modal = document.getElementById('reportModal');
  const reasonInput = document.getElementById('reportReason');
  const sendBtn = document.getElementById('sendReportBtn');
  const cancelBtn = document.getElementById('cancelReportBtn');
  const flagBtn = document.getElementById('flagBtn');
  const isActive = flagBtn?.classList.contains('active');

  if (isActive) {
    try {
      await fetch(`${API_URL}/users/questions/${current.id}/flag?type=flag`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      flagBtn?.classList.remove('active');
    } catch (err) {}
    return;
  }

  const close = () => {
    modal.classList.add('hidden');
    reasonInput.value = '';
  };

  const onSend = async () => {
    const reason = reasonInput.value.trim();
    if (!reason) return;
    try {
      await fetch(`${API_URL}/users/questions/${current.id}/report`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ reason })
      });
      await fetch(`${API_URL}/users/questions/${current.id}/flag`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ flag_type: 'flag' })
      });
      flagBtn?.classList.add('active');
      close();
    } catch (err) {}
  };

  const onCancel = () => {
    close();
  };

  sendBtn.onclick = onSend;
  cancelBtn.onclick = onCancel;
  modal.classList.remove('hidden');
}

document.getElementById('sendCommentBtn')?.addEventListener('click', sendComment);

// Safety: ensure no modal overlay stays open after load.
document.addEventListener('DOMContentLoaded', () => {
  ['noteModal', 'reportModal', 'favoriteModal', 'commentEditModal', 'commentDeleteModal', 'endSessionModal']
    .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
});

function formatNoteDate(isoDate) {
  if (!isoDate) return 'Aucune note pour cette question.';
  return `Derniere modification: ${new Date(isoDate).toLocaleString('fr-FR')}`;
}

function notePreview(note) {
  const txt = (note || '').trim();
  if (!txt) return '';
  return txt.length > 50 ? `${txt.slice(0, 50)}...` : txt;
}

function updateNoteVisualState(questionId) {
  const noteBtn = document.getElementById('noteBtn');
  if (!noteBtn) return;

  const item = notesByQuestion.get(questionId);
  const hasNote = !!(item && item.note);
  noteBtn.classList.toggle('active', hasNote);
  noteBtn.title = hasNote ? `Note: ${notePreview(item.note)}` : 'Ajouter une note personnelle';
}

function renderInlineNote(questionId) {
  const box = document.getElementById('questionNoteInline');
  if (!box) return;

  const item = notesByQuestion.get(questionId);
  const hasNote = !!(item && item.note);
  const shouldShow = localStorage.getItem('show_notes_inline') === '1';

  if (!hasNote || !shouldShow) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="question-note-inline-head">
      <i class="bi bi-journal-text"></i>
      <strong>Ma note</strong>
      <span class="muted">${formatNoteDate(item.updated_at).replace('Derniere modification: ', '')}</span>
    </div>
    <div class="question-note-inline-body"></div>
  `;
  const body = box.querySelector('.question-note-inline-body');
  if (body) body.textContent = item.note;
}

function updateNoteCounter() {
  const input = document.getElementById('noteInput');
  const counter = document.getElementById('noteCounter');
  if (!input || !counter) return;
  counter.textContent = `${input.value.length} / ${NOTE_MAX}`;
}

function closeNoteEditor() {
  const modal = document.getElementById('noteModal');
  if (modal) modal.classList.add('hidden');
  if (noteAutoSaveTimer) {
    clearInterval(noteAutoSaveTimer);
    noteAutoSaveTimer = null;
  }
  noteDraftDirty = false;
  noteModalQuestionId = null;
}

async function persistCurrentNote({ silent = false } = {}) {
  if (!noteModalQuestionId) return;

  const input = document.getElementById('noteInput');
  const lastEdited = document.getElementById('noteLastEdited');
  if (!input) return;

  const note = input.value.trim();
  if (!note) return;
  if (note.length > NOTE_MAX) return;

  try {
    const res = await fetch(`${API_URL}/users/questions/${noteModalQuestionId}/note`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ note })
    });
    if (!res.ok) return;
    const saved = await res.json();
    notesByQuestion.set(noteModalQuestionId, saved);
    updateNoteVisualState(noteModalQuestionId);
    renderInlineNote(noteModalQuestionId);
    if (lastEdited) lastEdited.textContent = formatNoteDate(saved.updated_at);
    noteDraftDirty = false;
    if (!silent) {
      // no-op: kept silent for clean UX
    }
  } catch (err) {}
}

function startNoteAutoSave() {
  if (noteAutoSaveTimer) clearInterval(noteAutoSaveTimer);
  noteAutoSaveTimer = setInterval(() => {
    if (!noteDraftDirty) return;
    persistCurrentNote({ silent: true });
  }, 5000);
}

async function openNoteEditor() {
  const current = questions[index];
  if (!current) return;

  const modal = document.getElementById('noteModal');
  const input = document.getElementById('noteInput');
  const counter = document.getElementById('noteCounter');
  const lastEdited = document.getElementById('noteLastEdited');
  const saveBtn = document.getElementById('saveNoteBtn');
  const deleteBtn = document.getElementById('deleteNoteBtn');
  const cancelBtn = document.getElementById('cancelNoteBtn');
  const toggle = document.getElementById('showNoteInlineToggle');

  noteModalQuestionId = current.id;
  const cached = notesByQuestion.get(current.id);
  if (input) input.value = cached?.note || '';
  if (counter) counter.textContent = `${input?.value.length || 0} / ${NOTE_MAX}`;
  if (lastEdited) lastEdited.textContent = formatNoteDate(cached?.updated_at || null);
  if (toggle) toggle.checked = localStorage.getItem('show_notes_inline') === '1';

  if (input) {
    input.oninput = () => {
      updateNoteCounter();
      noteDraftDirty = true;
    };
  }

  saveBtn.onclick = async () => {
    await persistCurrentNote();
    closeNoteEditor();
  };

  deleteBtn.onclick = async () => {
    if (!notesByQuestion.has(current.id)) {
      closeNoteEditor();
      return;
    }
    const confirmed = window.confirm('Supprimer cette note ?');
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_URL}/users/questions/${current.id}/note`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (!res.ok) return;
      notesByQuestion.delete(current.id);
      updateNoteVisualState(current.id);
      renderInlineNote(current.id);
      closeNoteEditor();
    } catch (err) {}
  };

  cancelBtn.onclick = () => closeNoteEditor();
  if (toggle) {
    toggle.onchange = () => {
      localStorage.setItem('show_notes_inline', toggle.checked ? '1' : '0');
      renderInlineNote(current.id);
    };
  }

  modal?.classList.remove('hidden');
  noteDraftDirty = false;
  startNoteAutoSave();
}

window.addEventListener('pagehide', () => {
  saveSessionDraft();
});

window.addEventListener('beforeunload', () => {
  saveSessionDraft();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveSessionDraft();
  }
});
