const currentRole = localStorage.getItem('role');
const isAdmin = currentRole === 'admin';
const isWorker = currentRole === 'worker';
if (!isAdmin && !isWorker) {
  window.location.href = 'dashboard.html';
}

/* ══ Sidebar Navigation ══ */
const panelMeta = {
  questions: { title: 'Questions',      sub: 'Gérez la base de questions' },
  references:{ title: 'Référentiels',   sub: 'Modules, cours et sources' },
  import:    { title: 'Import CSV',     sub: 'Importez des questions en masse' },
  reports:   { title: 'Signalements',   sub: 'Questions signalées par les utilisateurs' },
  'login-alerts': { title: 'Alertes login', sub: 'Notifications des connexions non-admin' },
  messages:  { title: 'Messages',       sub: 'Contactez vos utilisateurs' },
  users:     { title: 'Utilisateurs',   sub: 'Créez et gérez les comptes' },
};

function switchPanel(name) {
  document.querySelectorAll('.adm-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.adm-panel').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-panel="${name}"]`).classList.add('active');
  document.getElementById(`panel-${name}`).classList.add('active');
  const m = panelMeta[name] || {};
  document.getElementById('topbarTitle').textContent = m.title || '';
  document.getElementById('topbarSub').textContent = m.sub || '';
  if (name === 'messages') {
    loadAdminInbox();
  }
  if (name === 'login-alerts') {
    loadAdminInbox();
    loadLoginAlertSettings();
  }
}

document.querySelectorAll('.adm-nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => {
    switchPanel(item.dataset.panel);
    // close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
  });
});

if (isWorker) {
  document.querySelectorAll('.adm-nav-item[data-panel]').forEach((item) => {
    if (item.dataset.panel !== 'questions') item.style.display = 'none';
  });
  document.getElementById('pendingWorkersCard')?.classList.add('hidden');
  document.getElementById('exportCsvCard')?.classList.add('hidden');
  document.getElementById('panel-references')?.classList.add('hidden');
  document.getElementById('panel-import')?.classList.add('hidden');
  document.getElementById('panel-reports')?.classList.add('hidden');
  document.getElementById('panel-login-alerts')?.classList.add('hidden');
  document.getElementById('panel-messages')?.classList.add('hidden');
  document.getElementById('panel-users')?.classList.add('hidden');
  const topbarSub = document.getElementById('topbarSub');
  if (topbarSub) topbarSub.textContent = 'Ajoutez des questions (validation admin requise)';
}

// Mobile sidebar
document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
});
document.getElementById('sidebarOverlay').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
});

// Import drop zone
const dropZone = document.getElementById('importDropZone');
const csvFileInput = document.getElementById('csvFile');
dropZone?.addEventListener('click', () => csvFileInput.click());
dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone?.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) { csvFileInput.files = e.dataTransfer.files; csvFileInput.dispatchEvent(new Event('change')); }
});

// Tab helper
function setActiveTab(btn) {
  btn.closest('.adm-tabs').querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
}

/* ══ All original JS below — no IDs changed ══ */

let allQuestions = [];
let allQuestionsForSimilarity = [];
let reportQuestionIds = new Set();
let similarityTimer = null;
let latestSimilarity = { maxPercent: 0, matches: [] };
let questionsPage = 1;
const questionsPageSize = 25;
let questionsTotal = 0;
const moduleNameById = new Map();
const courseNameById = new Map();
const sourceNameById = new Map();

function normalizeText(v) {
  return (v || '').toString().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(v) { const n = normalizeText(v); return n ? n.split(' ').filter(Boolean) : []; }
function jaccardSimilarity(a, b) {
  const sa = new Set(tokenize(a)), sb = new Set(tokenize(b));
  if (!sa.size && !sb.size) return 1;
  if (!sa.size || !sb.size) return 0;
  let inter = 0; sa.forEach(t => { if (sb.has(t)) inter++; });
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}
function getFormOptions() {
  return ['option_a','option_b','option_c','option_d','option_e']
    .map(id => document.getElementById(id).value || '').map(v => normalizeText(v)).filter(Boolean).sort();
}
function getQuestionOptions(q) {
  return [q.option_a,q.option_b,q.option_c,q.option_d,q.option_e]
    .map(v => normalizeText(v)).filter(Boolean).sort();
}
function propositionSimilarity(inputOptions, candidateOptions) {
  if (!inputOptions.length && !candidateOptions.length) return 1;
  if (!inputOptions.length || !candidateOptions.length) return 0;
  const used = new Set(); let total = 0, count = 0;
  inputOptions.forEach(inp => {
    let best = -1, bestScore = 0;
    candidateOptions.forEach((cand, idx) => {
      if (used.has(idx)) return; const s = jaccardSimilarity(inp, cand);
      if (s > bestScore) { bestScore = s; best = idx; }
    });
    if (best >= 0) { used.add(best); total += bestScore; count++; }
  });
  if (!count) return 0;
  return (total / count) * (count / Math.max(inputOptions.length, candidateOptions.length));
}
function parseCorrectionSet(v) {
  return new Set((v||'').toString().toUpperCase().split(/[\s,;|/]+/).map(x=>x.trim()).filter(Boolean));
}
function correctionSimilarity(a,b) {
  const sa=parseCorrectionSet(a),sb=parseCorrectionSet(b);
  if(!sa.size&&!sb.size) return 1; if(!sa.size||!sb.size) return 0;
  let inter=0; sa.forEach(v=>{if(sb.has(v))inter++;});
  return new Set([...sa,...sb]).size ? inter/new Set([...sa,...sb]).size : 0;
}
function getCurrentFormData() {
  return {
    question: document.getElementById('question').value||'',
    module_id: document.getElementById('module_id').value||'',
    course_id: document.getElementById('course_id').value||'',
    source_id: document.getElementById('source_id').value||'',
    correction: document.getElementById('correct_option').value||'',
    options: getFormOptions()
  };
}
function rowClassForPercent(p) { return p>=90?'sim-red':p>=70?'sim-orange':p>=50?'sim-yellow':''; }
function isDifferentSource(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (!sa || !sb) return false;
  return sa !== sb;
}
function refName(map, id, fallback='-') {
  const key = String(id || '').trim();
  if (!key) return fallback;
  return map.get(key) || key;
}
function resolveRefDisplay(idValue, nameValue, map, fallback='-') {
  const idKey = String(idValue || '').trim();
  const rawName = String(nameValue || '').trim();
  if (rawName) {
    // If CSV put an ID in *_name, resolve to real label when possible.
    if (/^\d+$/.test(rawName) && map.has(rawName)) return map.get(rawName);
    return rawName;
  }
  if (idKey && map.has(idKey)) return map.get(idKey);
  if (idKey) return idKey;
  return fallback;
}
async function refreshReferenceMaps() {
  try {
    const [mRes, cRes, sRes] = await Promise.all([
      fetch(`${API_URL}/modules`),
      fetch(`${API_URL}/courses`),
      fetch(`${API_URL}/sources`)
    ]);
    const modules = mRes.ok ? await mRes.json() : [];
    const courses = cRes.ok ? await cRes.json() : [];
    const sources = sRes.ok ? await sRes.json() : [];
    moduleNameById.clear(); courseNameById.clear(); sourceNameById.clear();
    modules.forEach(m => moduleNameById.set(String(m.id), m.name));
    courses.forEach(c => courseNameById.set(String(c.id), c.name));
    sources.forEach(s => sourceNameById.set(String(s.id), s.name));
  } catch (_) {}
}

function renderSimilarityUI(maxPercent, matches) {
  const selectedSourceId = document.getElementById('source_id')?.value || '';
  document.getElementById('similarityValue').textContent = `${maxPercent}%`;
  const warning = document.getElementById('similarityWarning');
  if (maxPercent>90) { warning.classList.remove('hidden'); warning.className='similarity-warning sim-red'; warning.textContent='Risque très élevé de doublon (>90%). Confirmation requise.'; }
  else if (maxPercent>80) { warning.classList.remove('hidden'); warning.className='similarity-warning sim-orange'; warning.textContent='Question très similaire détectée (>80%). Vérifiez avant de continuer.'; }
  else { warning.classList.add('hidden'); warning.textContent=''; }
  const list = document.getElementById('similarityList');
  if (!matches.length) { list.innerHTML='<p class="muted" style="font-size:.8rem">Aucune question similaire trouvée.</p>'; return; }
  list.innerHTML = matches.map(m=>{
    const showSourceDiff = selectedSourceId && isDifferentSource(m.source_id, selectedSourceId);
    const sourceDiffTag = showSourceDiff ? '<span class="sim-source-diff-tag">Source différente</span>' : '';
    return `
    <div class="similarity-item ${rowClassForPercent(m.percent)}">
      <div class="sim-head"><strong>${m.percent}%</strong><span class="muted">#${m.id}</span></div>
      <div class="sim-text">${sourceDiffTag}${m.question||''}</div>
      <div class="muted sim-meta">Module: ${m.module_name||'-'} | Cours: ${m.course_name||'-'} | Source: ${m.source_name||'-'}</div>
      <div style="margin-top:6px">
        <button type="button" class="btn-inline btn-sm" onclick="openSimilarityDetail(${m.id})">Voir détail</button>
      </div>
    </div>`;
  }).join('');
}
function setSimilarityLoading(b) { document.getElementById('similarityLoading')?.classList.toggle('hidden',!b); }
function calculateSimilarityNow() {
  const formData = getCurrentFormData();
  if (!normalizeText(formData.question)) { latestSimilarity={maxPercent:0,matches:[]}; renderSimilarityUI(0,[]); return; }
  const sourcePool = allQuestionsForSimilarity.length ? allQuestionsForSimilarity : allQuestions;
  const scored = sourcePool.map(q => {
    const qScore = jaccardSimilarity(formData.question, q.question||'');
    const pScore = propositionSimilarity(formData.options, getQuestionOptions(q));
    const cScore = correctionSimilarity(formData.correction, q.correct_option||q.correct_options||'');
    const mScore = formData.module_id?(String(q.module_id||'')===String(formData.module_id)?1:0):1;
    const coScore = formData.course_id?(String(q.course_id||'')===String(formData.course_id)?1:0):1;
    const sScore = formData.source_id?(String(q.source_id||'')===String(formData.source_id)?1:0):1;
    const locFactors = [];
    if (formData.module_id) locFactors.push(mScore);
    if (formData.course_id) locFactors.push(coScore);
    if (formData.source_id) locFactors.push(sScore);
    const loc = locFactors.length ? (locFactors.reduce((a,b)=>a+b,0) / locFactors.length) : 1;
    return {...q, percent: Math.round((qScore*.5+pScore*.4+cScore*.1)*loc*100)};
  }).sort((a,b)=>b.percent-a.percent);
  const top = scored.slice(0,5).filter(r=>r.percent>=50);
  latestSimilarity = {maxPercent:top.length?top[0].percent:0, matches:top};
  renderSimilarityUI(latestSimilarity.maxPercent, top);
}
function scheduleSimilarityCalculation() {
  if(similarityTimer) clearTimeout(similarityTimer);
  setSimilarityLoading(true);
  similarityTimer = setTimeout(()=>{calculateSimilarityNow();setSimilarityLoading(false);},350);
}

async function loadQuestionsAdmin() {
  const token = localStorage.getItem('token');
  const moduleId = document.getElementById('filter_module_id')?.value || '';
  const courseId = document.getElementById('filter_course_id')?.value || '';
  const sourceId = document.getElementById('filter_source_id')?.value || '';
  const search = (document.getElementById('filter_search')?.value || '').trim();
  const onlyReported = !!document.getElementById('filter_reported')?.checked;
  const params = new URLSearchParams();
  params.set('page', String(questionsPage));
  params.set('page_size', String(questionsPageSize));
  if (moduleId) params.set('module', moduleId);
  if (courseId) params.set('course', courseId);
  if (sourceId) params.set('source', sourceId);
  const res = await fetch(`${API_URL}/questions?${params.toString()}`,{headers:{'Authorization':'Bearer '+token}});
  const data = await res.json();
  const baseRows = data.questions||[];
  const localFiltered = baseRows.filter(q => {
    if (search && !(q.question || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (onlyReported && !reportQuestionIds.has(q.id)) return false;
    return true;
  });
  allQuestions = localFiltered;
  questionsTotal = Number(data.pagination?.total || 0);
  renderQuestions(localFiltered);
  renderQuestionsPagination();
  scheduleSimilarityCalculation();
}

async function loadSimilarityQuestionsPool() {
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`${API_URL}/questions?page=1&page_size=5000`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    allQuestionsForSimilarity = data.questions || [];
  } catch (_) {
    allQuestionsForSimilarity = [];
  }
}

function renderQuestionsPagination() {
  const info = document.getElementById('questionsPageInfo');
  const prev = document.getElementById('prevQuestionsPageBtn');
  const next = document.getElementById('nextQuestionsPageBtn');
  if (!info || !prev || !next) return;
  const totalPages = Math.max(1, Math.ceil(questionsTotal / questionsPageSize));
  if (questionsPage > totalPages) questionsPage = totalPages;
  info.textContent = `Page ${questionsPage} / ${totalPages} (${questionsTotal} questions)`;
  prev.disabled = questionsPage <= 1;
  next.disabled = questionsPage >= totalPages;
}

function renderQuestions(listData) {
  const list = document.getElementById('questionsList');
  if (!listData.length) {
    list.innerHTML = '<div class="adm-empty"><div class="adm-empty-icon"><i class="bi bi-search"></i></div><p>Aucune question trouvée.</p></div>';
    return;
  }
  list.innerHTML = listData.map(q => `
    <div class="question-item">
      <div class="question-item-text">${q.question}</div>
      <div class="question-item-meta">
        ${q.module_name?`<span class="question-item-tag">${q.module_name}</span>`:''}
        ${q.course_name?`<span class="question-item-tag">${q.course_name}</span>`:''}
        ${q.source_name?`<span class="question-item-tag">${q.source_name}</span>`:''}
        <span class="question-item-correct"><i class="bi bi-check2-circle"></i> ${q.correct_option}</span>
      </div>
      ${isWorker ? '' : `<div class="question-item-actions">
        <button class="btn-inline btn-sm" onclick="editQuestion(${q.id})"><i class="bi bi-pencil"></i> Modifier</button>
        <button class="btn-inline btn-sm" style="color:var(--red)" onclick="deleteQuestion(${q.id})"><i class="bi bi-trash"></i> Supprimer</button>
      </div>`}
    </div>`).join('');
}

function applyQuestionFilters() {
  questionsPage = 1;
  loadQuestionsAdmin();
}

function formatReportDate(v) { try { return new Date(v).toLocaleString('fr-FR'); } catch(e){return v;} }
let showResolvedReports = false;

async function loadReports() {
  const list = document.getElementById('reportsList');
  list.innerHTML = '<div class="loading-wrap"><div class="spinner"></div></div>';
  try {
    const res = await fetch(`${API_URL}/admin/reports?resolved=${showResolvedReports?'1':'0'}`,{headers:getAuthHeaders()});
    if (!res.ok) { list.innerHTML='<p class="muted">Impossible de charger les signalements.</p>'; return; }
    const data = await res.json();
    list.innerHTML = '';
    if (!data.length) {
      list.innerHTML = `<div class="adm-empty"><div class="adm-empty-icon"><i class="bi ${showResolvedReports?'bi-check2-circle':'bi-inbox'}"></i></div><p>${showResolvedReports?'Aucun signalement résolu.':'Aucun signalement en attente. Tout va bien !'}</p></div>`;
      reportQuestionIds = new Set(); applyQuestionFilters(); return;
    }
    reportQuestionIds = new Set(data.map(r=>r.question_id));
    applyQuestionFilters();
    // Update badge
    const badge = document.getElementById('reportsBadge');
    if (!showResolvedReports && data.length) { badge.textContent=data.length; badge.style.display=''; }
    else { badge.style.display='none'; }

    data.forEach(r => {
      const date = formatReportDate(r.created_at);
      const item = document.createElement('div');
      item.className = `report-item${r.resolved?' resolved':''}`;
      item.innerHTML = `
        <div class="report-meta">
          <strong>${r.user_email||'Utilisateur'}</strong>
          <span>${date}</span>
          ${r.resolved?`<span class="flag-status resolved"><i class="bi bi-check2-circle"></i> Résolu par ${r.resolved_by_email||'admin'}</span>`:'<span class="flag-status pending"><i class="bi bi-hourglass-split"></i> En attente</span>'}
        </div>
        <div class="report-question">${r.question||'Question #'+r.question_id}</div>
        ${r.reason?`<div class="report-reason">${r.reason}</div>`:''}
        <div class="report-actions">
          <button class="btn-inline btn-sm" onclick="editQuestion(${r.question_id})"><i class="bi bi-pencil"></i> Modifier la question</button>
          ${!r.resolved
            ? `<button class="btn-inline btn-sm resolve-btn" data-id="${r.id}" style="color:var(--green)"><i class="bi bi-check2"></i> Marquer résolu</button>`
            : `<button class="btn-inline btn-sm resolve-btn" data-id="${r.id}" data-unresolve="1"><i class="bi bi-arrow-counterclockwise"></i> Rouvrir</button>`}
        </div>`;
      list.appendChild(item);
    });

    list.querySelectorAll('.resolve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const unresolve = btn.getAttribute('data-unresolve')==='1';
        btn.textContent='...';
        try {
          await fetch(`${API_URL}/admin/reports/${id}/resolve`,{method:'PUT',headers:{...getAuthHeaders(),'Content-Type':'application/json'},body:JSON.stringify({resolved:!unresolve})});
          loadReports();
        } catch(e){loadReports();}
      });
    });
  } catch(err) { list.innerHTML='<p class="muted">Erreur lors du chargement.</p>'; }
}

async function loadUsersForMessages() {
  const token = localStorage.getItem('token');
  const res = await fetch(`${API_URL}/admin/users`,{headers:{'Authorization':'Bearer '+token}});
  const data = await res.json();
  const select = document.getElementById('message_user_id');
  select.innerHTML = '<option value="">-- Choisir un utilisateur --</option>';
  data.forEach(u=>{
    const opt = document.createElement('option'); opt.value=u.id;
    opt.textContent = u.display_name?`${u.display_name} (${u.email})`:u.email;
    select.appendChild(opt);
  });
}

async function loadAdminInbox() {
  const list = document.getElementById('adminInboxList');
  if(!list) return;
  list.innerHTML = '<p class="muted" style="margin:0">Chargement...</p>';
  try {
    const res = await fetch(`${API_URL}/messages?page_size=30`, { headers: getAuthHeaders() });
    if(!res.ok){
      list.innerHTML = '<p class="muted" style="margin:0">Impossible de charger les notifications.</p>';
      return;
    }
    const rows = await res.json();
    if(!Array.isArray(rows) || !rows.length){
      list.innerHTML = '<p class="muted" style="margin:0">Aucune notification.</p>';
      return;
    }

    list.innerHTML = rows.map(m=>{
      const sender = m.sender_name || m.sender_email || `Utilisateur #${m.sender_id || '?'}`;
      const date = formatReportDate(m.created_at);
      return `
        <div class="report-item${m.read_at ? ' resolved' : ''}" style="margin-bottom:8px">
          <div class="report-meta" style="margin-bottom:6px">
            <strong>${esc(sender)}</strong>
            <span>${esc(date)}</span>
          </div>
          <div class="report-reason" style="margin:0;white-space:pre-wrap">${esc(m.body || '')}</div>
        </div>
      `;
    }).join('');

    const unreadIds = rows
      .filter(m => !m.read_at)
      .map(m => Number(m.id))
      .filter(n => Number.isInteger(n) && n > 0);
    if(unreadIds.length){
      fetch(`${API_URL}/messages/mark-read`,{
        method:'POST',
        headers:{ ...getAuthHeaders(), 'Content-Type':'application/json' },
        body: JSON.stringify({ ids: unreadIds })
      }).catch(()=>{});
    }
  } catch(_) {
    list.innerHTML = '<p class="muted" style="margin:0">Erreur de chargement.</p>';
  }
}

function renderUsersAdminList(rows){
  const wrap = document.getElementById('usersAdminList');
  if(!wrap) return;
  if(!rows?.length){
    wrap.innerHTML = '<div class="adm-empty"><p>Aucun utilisateur.</p></div>';
    return;
  }
  wrap.innerHTML = rows.map(u => `
    <div class="question-item" data-user-row="${u.id}">
      <div class="question-item-text">#${u.id} - ${esc(u.email)}</div>
      <div class="grid-3" style="margin:10px 0 8px">
        <label class="field" style="margin:0">
          <span>Nom affiché</span>
          <input type="text" data-user-display="${u.id}" value="${esc(u.display_name||'')}">
        </label>
        <label class="field" style="margin:0">
          <span>Rôle</span>
          <select data-user-role="${u.id}">
            <option value="user" ${u.role==='user'?'selected':''}>user</option>
            <option value="worker" ${u.role==='worker'?'selected':''}>worker</option>
            <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
          </select>
        </label>
        <label class="field" style="margin:0">
          <span>Nouveau mot de passe</span>
          <input type="text" data-user-password="${u.id}" placeholder="laisser vide si inchangé">
        </label>
      </div>
      <div class="question-item-actions">
        <button class="btn-inline btn-sm" data-user-save="${u.id}">💾 Enregistrer</button>
        <button class="btn-inline btn-sm" style="color:var(--red)" data-user-delete="${u.id}"><i class="bi bi-trash"></i> Supprimer</button>
      </div>
    </div>
  `).join('');
}

async function loadUsersAdminManagement(){
  const status = document.getElementById('userManageStatus');
  try{
    const res = await fetch(`${API_URL}/admin/users?page_size=500`, { headers: getAuthHeaders() });
    if(!res.ok) throw new Error('load failed');
    const rows = await res.json();
    renderUsersAdminList(rows);
    loadUsersForMessages();
    if(status) status.textContent = '';
  }catch(_){
    if(status) status.textContent = 'Impossible de charger les utilisateurs.';
  }
}

async function loadPendingQuestions() {
  const wrap = document.getElementById('pendingQuestionsList');
  if (!wrap || isWorker) return;
  wrap.textContent = 'Chargement...';
  try {
    const res = await fetch(`${API_URL}/admin/pending-questions?status=pending&page=1&page_size=20`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    const rows = data.data || [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="muted">Aucune question en attente.</div>';
      return;
    }
    wrap.innerHTML = rows.map((r) => `
      <div class="question-item">
        <div class="question-item-text">${esc(r.question)}</div>
        <div class="question-item-meta">
          <span class="question-item-tag">Worker: ${esc(r.submitted_by_email || r.submitted_by)}</span>
          ${r.module_name ? `<span class="question-item-tag">${esc(r.module_name)}</span>` : ''}
          ${r.course_name ? `<span class="question-item-tag">${esc(r.course_name)}</span>` : ''}
          ${r.source_name ? `<span class="question-item-tag">${esc(r.source_name)}</span>` : ''}
        </div>
        <div class="question-item-actions">
          <button class="btn-inline btn-sm" onclick="showPendingQuestionDetail(${r.id})">Voir</button>
          <button class="btn-inline btn-sm" onclick="approvePendingQuestion(${r.id})">Approuver</button>
          <button class="btn-inline btn-sm" style="color:var(--red)" onclick="rejectPendingQuestion(${r.id})">Rejeter</button>
        </div>
      </div>
    `).join('');
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Erreur de chargement.</div>';
  }
}

async function showPendingQuestionDetail(id) {
  const res = await fetch(`${API_URL}/admin/pending-questions?status=pending&page=1&page_size=100`, { headers: getAuthHeaders() });
  const data = await res.json();
  const q = (data.data || []).find(x => Number(x.id) === Number(id));
  if (!q) return;
  const body = [
    `Question: ${q.question}`,
    `Module: ${q.module_name || '-'}`,
    `Cours: ${q.course_name || '-'}`,
    `Source: ${q.source_name || '-'}`,
    `Correction: ${q.correct_options || '-'}`,
    '',
    `A. ${q.option_a || ''}`,
    `B. ${q.option_b || ''}`,
    `C. ${q.option_c || ''}`,
    `D. ${q.option_d || ''}`,
    `E. ${q.option_e || ''}`,
    '',
    `Explication: ${q.explanation || '-'}`
  ].join('\n');
  document.getElementById('similarityDetailBody').textContent = body;
  document.getElementById('similarityDetailModal').classList.remove('hidden');
}
window.showPendingQuestionDetail = showPendingQuestionDetail;

function closeSimilarityDetailModal() {
  document.getElementById('similarityDetailModal')?.classList.add('hidden');
}
window.closeSimilarityDetailModal = closeSimilarityDetailModal;

function openSimilarityDetail(questionId) {
  const q = (allQuestionsForSimilarity.length ? allQuestionsForSimilarity : allQuestions)
    .find((x) => Number(x.id) === Number(questionId));
  if (!q) return;
  const body = [
    `Question: ${q.question || '-'}`,
    `Module: ${q.module_name || '-'}`,
    `Cours: ${q.course_name || '-'}`,
    `Source: ${q.source_name || '-'}`,
    `Correction: ${q.correct_option || q.correct_options || '-'}`,
    '',
    `A. ${q.option_a || ''}`,
    `B. ${q.option_b || ''}`,
    `C. ${q.option_c || ''}`,
    `D. ${q.option_d || ''}`,
    `E. ${q.option_e || ''}`,
    '',
    `Explication: ${q.explanation || '-'}`
  ].join('\n');
  document.getElementById('similarityDetailBody').textContent = body;
  document.getElementById('similarityDetailModal').classList.remove('hidden');
}
window.openSimilarityDetail = openSimilarityDetail;

async function approvePendingQuestion(id) {
  if (!confirm('Approuver cette question ?')) return;
  const res = await fetch(`${API_URL}/admin/pending-questions/${id}/approve`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!res.ok) return alert('Erreur lors de l’approbation.');
  await loadPendingQuestions();
  await loadQuestionsAdmin();
  await loadSimilarityQuestionsPool();
}
window.approvePendingQuestion = approvePendingQuestion;

async function rejectPendingQuestion(id) {
  if (!confirm('Rejeter cette question ?')) return;
  const res = await fetch(`${API_URL}/admin/pending-questions/${id}/reject`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (!res.ok) return alert('Erreur lors du rejet.');
  await loadPendingQuestions();
}
window.rejectPendingQuestion = rejectPendingQuestion;

async function loadLoginAlertSettings() {
  const toggle = document.getElementById('loginAlertsEnabledToggle');
  const status = document.getElementById('loginAlertStatus');
  if (!toggle || !status) return;
  try {
    const res = await fetch(`${API_URL}/admin/login-alert-settings`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('load failed');
    const data = await res.json();
    toggle.checked = !!data.enabled;
    status.textContent = data.enabled ? 'Alertes activées.' : 'Alertes désactivées.';
  } catch (_) {
    status.textContent = 'Impossible de charger le paramètre.';
  }
}

const form = document.getElementById('addQuestionForm');
form.addEventListener('submit', async e => {
  e.preventDefault();
  const token = localStorage.getItem('token');
  calculateSimilarityNow();
  if (latestSimilarity.maxPercent>90) { if(!confirm('Similarité > 90%. Voulez-vous vraiment enregistrer ?')) return; }
  const questionData = {
    question: document.getElementById('question').value,
    option_a: document.getElementById('option_a').value,
    option_b: document.getElementById('option_b').value,
    option_c: document.getElementById('option_c').value,
    option_d: document.getElementById('option_d').value,
    option_e: document.getElementById('option_e').value,
    correct_option: document.getElementById('correct_option').value.toUpperCase(),
    module_id: document.getElementById('module_id').value,
    course_id: document.getElementById('course_id').value||null,
    source_id: document.getElementById('source_id').value||null,
    explanation: document.getElementById('explanation').value||null
  };
  const res = await fetch(`${API_URL}/questions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(questionData)});
  if(res.ok){
    ['question','option_a','option_b','option_c','option_d','option_e','correct_option','explanation']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    latestSimilarity={maxPercent:0,matches:[]};
    renderSimilarityUI(0,[]);
    loadQuestionsAdmin();
    loadPendingQuestions();
    if (res.status === 202) {
      alert('Question envoyée pour validation admin.');
    }
  }
  else if(res.status===409){const d=await res.json().catch(()=>({}));alert(d.message||'Question déjà existante.');}
  else{alert('Erreur lors de l\'ajout de la question');}
});

function bindSimilarityInputs() {
  ['question','option_a','option_b','option_c','option_d','option_e','correct_option'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    el.addEventListener('input',scheduleSimilarityCalculation);
    el.addEventListener('change',scheduleSimilarityCalculation);
  });
  document.getElementById('module_id')?.addEventListener('change',async()=>{
    await loadCourses();
    await loadSources();
    scheduleSimilarityCalculation();
  });
  document.getElementById('course_id')?.addEventListener('change',scheduleSimilarityCalculation);
}
bindSimilarityInputs();

async function deleteQuestion(id) {
  if (isWorker) return;
  if(!confirm('Voulez-vous vraiment supprimer cette question ?'))return;
  const token = localStorage.getItem('token');
  await fetch(`${API_URL}/questions/${id}`,{method:'DELETE',headers:{'Authorization':'Bearer '+token}});
  loadQuestionsAdmin();
}

async function editQuestion(id) {
  if (isWorker) return;
  const token = localStorage.getItem('token');
  const res = await fetch(`${API_URL}/questions`,{headers:{'Authorization':'Bearer '+token}});
  const data = await res.json();
  const q = data.questions.find(x=>x.id===id);
  if(!q)return;
  document.getElementById('edit_id').value=q.id;
  document.getElementById('edit_question').value=q.question||'';
  document.getElementById('edit_option_a').value=q.option_a||'';
  document.getElementById('edit_option_b').value=q.option_b||'';
  document.getElementById('edit_option_c').value=q.option_c||'';
  document.getElementById('edit_option_d').value=q.option_d||'';
  document.getElementById('edit_option_e').value=q.option_e||'';
  document.getElementById('edit_correct_option').value=q.correct_option||'';
  document.getElementById('edit_explanation').value=q.explanation||'';
  await loadModulesForEdit(q.module_id);
  await loadCoursesForEdit(q.module_id,q.course_id);
  await loadSourcesForEdit(q.source_id, q.module_id);
  openEditModal();
  // Switch to questions panel so modal makes sense
  switchPanel('questions');
}
function openEditModal(){document.getElementById('editModal').classList.remove('hidden');}
function closeEditModal(){document.getElementById('editModal').classList.add('hidden');}
document.getElementById('closeEditBtn').addEventListener('click',closeEditModal);
document.getElementById('saveEditBtn').addEventListener('click',async()=>{
  const token=localStorage.getItem('token');
  const id=document.getElementById('edit_id').value;
  const payload={
    question:document.getElementById('edit_question').value,
    option_a:document.getElementById('edit_option_a').value,
    option_b:document.getElementById('edit_option_b').value,
    option_c:document.getElementById('edit_option_c').value,
    option_d:document.getElementById('edit_option_d').value,
    option_e:document.getElementById('edit_option_e').value,
    correct_option:document.getElementById('edit_correct_option').value.toUpperCase(),
    explanation:document.getElementById('edit_explanation').value||null,
    module_id:document.getElementById('edit_module_id').value,
    course_id:document.getElementById('edit_course_id').value||null,
    source_id:document.getElementById('edit_source_id').value||null
  };
  const res=await fetch(`${API_URL}/questions/${id}`,{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(payload)});
  if(res.ok){closeEditModal();loadQuestionsAdmin();}
  else{alert('Erreur lors de la modification de la question');}
});

// Load on init
loadQuestionsAdmin();
loadSimilarityQuestionsPool();
if (isAdmin) {
  loadReports();
  loadUsersForMessages();
  loadAdminInbox();
  loadUsersAdminManagement();
  loadPendingQuestions();
  loadLoginAlertSettings();
}

async function loadModules() {
  const res=await fetch(`${API_URL}/modules`);
  const modules=await res.json();
  const select=document.getElementById('module_id');
  select.innerHTML='<option value="">-- Module --</option>';
  modules.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;select.appendChild(o);});
  const filterSelect=document.getElementById('filter_module_id');
  filterSelect.innerHTML='<option value="">Tous les modules</option>';
  modules.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;filterSelect.appendChild(o);});
}
loadModules();

async function loadSources() {
  const moduleId=document.getElementById('module_id').value;
  const url=moduleId?`${API_URL}/sources?module_id=${moduleId}`:`${API_URL}/sources`;
  const res=await fetch(url);
  const sources=await res.json();
  const select=document.getElementById('source_id');
  select.innerHTML='<option value="">-- Source --</option>';
  sources.forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;select.appendChild(o);});
  const manage=document.getElementById('manage_source_id');
  if(manage){
    manage.innerHTML='<option value="">Choisir une source…</option>';
    sources.forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;manage.appendChild(o);});
  }
}
loadSources();

async function loadModulesForEdit(selectedId) {
  const res=await fetch(`${API_URL}/modules`);
  const modules=await res.json();
  const select=document.getElementById('edit_module_id');
  select.innerHTML='<option value="">-- Module --</option>';
  modules.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;select.appendChild(o);});
  if(selectedId)select.value=selectedId;
}

async function loadCourses() {
  const moduleId=document.getElementById('module_id').value;
  const url=moduleId?`${API_URL}/courses?module_id=${moduleId}`:`${API_URL}/courses`;
  const res=await fetch(url);
  const courses=await res.json();
  const select=document.getElementById('course_id');
  select.innerHTML='<option value="">-- Cours --</option>';
  courses.forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;select.appendChild(o);});
  const manage=document.getElementById('manage_course_id');
  if(manage){
    manage.innerHTML='<option value="">Choisir un cours…</option>';
    courses.forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;manage.appendChild(o);});
  }
}
loadCourses();

async function loadFilterCourses() {
  const moduleId=document.getElementById('filter_module_id').value;
  const url=moduleId?`${API_URL}/courses?module_id=${moduleId}`:`${API_URL}/courses`;
  const res=await fetch(url);
  const courses=await res.json();
  const select=document.getElementById('filter_course_id');
  select.innerHTML='<option value="">Tous les cours</option>';
  courses.forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;select.appendChild(o);});
}
loadFilterCourses();

async function loadFilterSources() {
  const moduleId=document.getElementById('filter_module_id').value;
  const url=moduleId?`${API_URL}/sources?module_id=${moduleId}`:`${API_URL}/sources`;
  const res=await fetch(url);
  const sources=await res.json();
  const select=document.getElementById('filter_source_id');
  select.innerHTML='<option value="">Toutes les sources</option>';
  sources.forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;select.appendChild(o);});
}
loadFilterSources();

async function loadCoursesForEdit(moduleId,selectedId) {
  const url=moduleId?`${API_URL}/courses?module_id=${moduleId}`:`${API_URL}/courses`;
  const res=await fetch(url);
  const courses=await res.json();
  const select=document.getElementById('edit_course_id');
  select.innerHTML='<option value="">-- Cours --</option>';
  courses.forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name;select.appendChild(o);});
  if(selectedId)select.value=selectedId;
}

async function loadSourcesForEdit(selectedId, moduleId) {
  const url=moduleId?`${API_URL}/sources?module_id=${moduleId}`:`${API_URL}/sources`;
  const res=await fetch(url);
  const sources=await res.json();
  const select=document.getElementById('edit_source_id');
  select.innerHTML='<option value="">-- Source --</option>';
  sources.forEach(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;select.appendChild(o);});
  if(selectedId)select.value=selectedId;
}

document.getElementById('edit_module_id').addEventListener('change',()=>{
  const moduleId = document.getElementById('edit_module_id').value;
  loadCoursesForEdit(moduleId,null);
  loadSourcesForEdit(null, moduleId);
});
document.getElementById('filter_module_id').addEventListener('change',()=>loadFilterCourses().then(()=>loadFilterSources()).then(()=>applyQuestionFilters()));
document.getElementById('filter_course_id').addEventListener('change',applyQuestionFilters);
document.getElementById('filter_source_id').addEventListener('change',applyQuestionFilters);
document.getElementById('filter_search').addEventListener('input',applyQuestionFilters);
document.getElementById('filter_reported').addEventListener('change',applyQuestionFilters);
document.getElementById('resetFiltersBtn').addEventListener('click',()=>{
  ['filter_module_id','filter_course_id','filter_source_id','filter_search'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('filter_reported').checked=false;
  loadFilterCourses().then(()=>applyQuestionFilters());
  loadFilterSources();
});
document.getElementById('prevQuestionsPageBtn')?.addEventListener('click', () => {
  if (questionsPage <= 1) return;
  questionsPage -= 1;
  loadQuestionsAdmin();
});
document.getElementById('nextQuestionsPageBtn')?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(questionsTotal / questionsPageSize));
  if (questionsPage >= totalPages) return;
  questionsPage += 1;
  loadQuestionsAdmin();
});

document.getElementById('sendMessageBtn').addEventListener('click',async()=>{
  const token=localStorage.getItem('token');
  const userId=document.getElementById('message_user_id').value;
  const body=document.getElementById('message_body').value.trim();
  const status=document.getElementById('messageStatus');
  status.textContent='';
  if(!userId||!body){status.textContent='Choisissez un utilisateur et écrivez un message.';return;}
  const res=await fetch(`${API_URL}/admin/messages`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({recipient_id:Number(userId),body})});
  if(res.ok){document.getElementById('message_body').value='';status.textContent='Message envoyé.';}
  else{status.textContent='Erreur lors de l\'envoi.';}
});

document.getElementById('refreshAdminInboxBtn')?.addEventListener('click', loadAdminInbox);
document.getElementById('refreshPendingBtn')?.addEventListener('click', loadPendingQuestions);
document.getElementById('loginAlertsEnabledToggle')?.addEventListener('change', async (e) => {
  const status = document.getElementById('loginAlertStatus');
  try {
    const res = await fetch(`${API_URL}/admin/login-alert-settings`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ enabled: !!e.target.checked })
    });
    if (!res.ok) throw new Error('save failed');
    status.textContent = e.target.checked ? 'Alertes activées.' : 'Alertes désactivées.';
  } catch (_) {
    status.textContent = 'Échec de sauvegarde.';
  }
});
document.getElementById('exportCsvBtn')?.addEventListener('click', async () => {
  const pass = (document.getElementById('exportPass')?.value || '').trim();
  const status = document.getElementById('exportCsvStatus');
  if (!pass) {
    status.textContent = 'Entrez le mot de passe export.';
    return;
  }
  status.textContent = 'Préparation export...';
  const res = await fetch(`${API_URL}/admin/questions/export-csv?pass=${encodeURIComponent(pass)}`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) {
    status.textContent = 'Export refusé ou erreur serveur.';
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'questions_export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  status.textContent = 'Export CSV téléchargé.';
});

document.getElementById('createUserBtn')?.addEventListener('click', async () => {
  const status = document.getElementById('userManageStatus');
  const email = document.getElementById('new_user_email').value.trim();
  const display_name = document.getElementById('new_user_display_name').value.trim();
  const password = document.getElementById('new_user_password').value;
  const role = document.getElementById('new_user_role').value;
  if(!email || !password){
    status.textContent = 'Email et mot de passe sont requis.';
    return;
  }
  status.textContent = 'Création...';
  try{
    const res = await fetch(`${API_URL}/admin/users`, {
      method:'POST',
      headers:getAuthHeaders(),
      body:JSON.stringify({ email, display_name, password, role })
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){
      status.textContent = data.message || data.error || 'Erreur lors de la création.';
      return;
    }
    document.getElementById('new_user_email').value='';
    document.getElementById('new_user_display_name').value='';
    document.getElementById('new_user_password').value='';
    document.getElementById('new_user_role').value='user';
    status.textContent = 'Compte créé.';
    await loadUsersAdminManagement();
  }catch(_){
    status.textContent = 'Erreur lors de la création.';
  }
});

document.getElementById('refreshUsersBtn')?.addEventListener('click', loadUsersAdminManagement);

document.getElementById('usersAdminList')?.addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('[data-user-save]');
  const deleteBtn = e.target.closest('[data-user-delete]');
  const status = document.getElementById('userManageStatus');

  if(saveBtn){
    const userId = saveBtn.getAttribute('data-user-save');
    const display_name = document.querySelector(`[data-user-display="${userId}"]`)?.value?.trim() ?? '';
    const role = document.querySelector(`[data-user-role="${userId}"]`)?.value ?? 'user';
    const password = document.querySelector(`[data-user-password="${userId}"]`)?.value ?? '';
    const payload = { display_name, role };
    if(password.trim()) payload.password = password.trim();
    saveBtn.disabled = true;
    status.textContent = 'Mise à jour...';
    try{
      const res = await fetch(`${API_URL}/admin/users/${userId}`, {
        method:'PUT',
        headers:getAuthHeaders(),
        body:JSON.stringify(payload)
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        status.textContent = data.message || data.error || 'Erreur de mise à jour.';
      }else{
        status.textContent = 'Utilisateur mis à jour.';
        await loadUsersAdminManagement();
      }
    }catch(_){
      status.textContent = 'Erreur de mise à jour.';
    }finally{
      saveBtn.disabled = false;
    }
    return;
  }

  if(deleteBtn){
    const userId = deleteBtn.getAttribute('data-user-delete');
    openRefConfirm('Supprimer ce compte utilisateur ?', async () => {
      status.textContent = 'Suppression...';
      const res = await fetch(`${API_URL}/admin/users/${userId}`, {
        method:'DELETE',
        headers:getAuthHeaders()
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        status.textContent = data.message || data.error || 'Erreur de suppression.';
      }else{
        status.textContent = 'Utilisateur supprimé.';
        await loadUsersAdminManagement();
      }
    });
  }
});

function openRefConfirm(message, onConfirm){
  const modal=document.getElementById('refConfirmModal');
  const text=document.getElementById('refConfirmText');
  const yes=document.getElementById('refConfirmYesBtn');
  const no=document.getElementById('refConfirmNoBtn');
  if(!modal||!text||!yes||!no){
    if(typeof onConfirm==='function') onConfirm();
    return;
  }
  text.textContent=message||'Confirmer ?';
  const close=()=>modal.classList.add('hidden');
  yes.onclick=async()=>{yes.disabled=true;try{await onConfirm?.();}finally{yes.disabled=false;close();}};
  no.onclick=close;
  modal.classList.remove('hidden');
}

document.getElementById('addCourseInlineBtn').addEventListener('click',async()=>{
  const status=document.getElementById('courseManageStatus');
  status.textContent='';
  const name=document.getElementById('new_course_name').value.trim();
  const moduleId=document.getElementById('module_id').value;
  if(!name)return;
  if(!moduleId){status.textContent='Sélectionnez un module avant d’ajouter un cours.';return;}
  const res=await fetch(`${API_URL}/courses`,{method:'POST',headers:getAuthHeaders(),body:JSON.stringify({name,module_id:moduleId})});
  if(!res.ok){status.textContent='Erreur lors de l’ajout du cours.';return;}
  document.getElementById('new_course_name').value='';
  status.textContent='Cours ajouté.';
  loadCourses();
});
document.getElementById('deleteCourseInlineBtn').addEventListener('click',async()=>{
  const status=document.getElementById('courseManageStatus');
  status.textContent='';
  const courseId=document.getElementById('manage_course_id').value;
  if(!courseId){status.textContent='Choisissez un cours à supprimer.';return;}
  openRefConfirm('Supprimer ce cours ?', async () => {
    const res=await fetch(`${API_URL}/courses/${courseId}`,{method:'DELETE',headers:getAuthHeaders()});
    if(res.ok){
      await loadCourses();
      await loadFilterCourses();
      applyQuestionFilters();
      status.textContent='Cours supprimé.';
    }else{
      const err=await res.json().catch(()=>({}));
      status.textContent=err.message||err.error||'Suppression impossible.';
    }
  });
});

document.getElementById('addModuleInlineBtn').addEventListener('click',async()=>{
  const name=document.getElementById('new_module_name').value.trim();
  if(!name)return;
  const res=await fetch(`${API_URL}/modules`,{method:'POST',headers:getAuthHeaders(),body:JSON.stringify({name})});
  if(!res.ok){alert('Erreur lors de l\'ajout du module.');return;}
  document.getElementById('new_module_name').value='';
  await loadModules();
});

document.getElementById('addSourceInlineBtn').addEventListener('click',async()=>{
  const status=document.getElementById('sourceManageStatus');
  status.textContent='';
  const name=document.getElementById('new_source_name').value.trim();
  const moduleId=document.getElementById('module_id').value;
  if(!name)return;
  if(!moduleId){status.textContent='Sélectionnez un module avant d’ajouter une source.';return;}
  const res=await fetch(`${API_URL}/sources`,{method:'POST',headers:getAuthHeaders(),body:JSON.stringify({name,module_id:moduleId})});
  if(!res.ok){status.textContent='Erreur lors de l’ajout de la source.';return;}
  document.getElementById('new_source_name').value='';
  status.textContent='Source ajoutée.';
  await loadSources();
  await loadFilterSources();
});
document.getElementById('deleteSourceInlineBtn').addEventListener('click',async()=>{
  const status=document.getElementById('sourceManageStatus');
  status.textContent='';
  const sourceId=document.getElementById('manage_source_id').value;
  if(!sourceId){status.textContent='Choisissez une source à supprimer.';return;}
  openRefConfirm('Supprimer cette source ?', async () => {
    const res=await fetch(`${API_URL}/sources/${sourceId}`,{method:'DELETE',headers:getAuthHeaders()});
    if(res.ok){
      await loadSources();
      await loadFilterSources();
      applyQuestionFilters();
      status.textContent='Source supprimée.';
    }else{
      const err=await res.json().catch(()=>({}));
      status.textContent=err.message||err.error||'Suppression impossible.';
    }
  });
});

// CSV Import
let importRows=[];
let analyzedImportRows=[];
let importPage=1;
const importPageSize=100;
const analyzeImportBtn=document.getElementById('analyzeImportBtn');
const importStatus=document.getElementById('importStatus');
const importPreview=document.getElementById('importPreview');
const importPreviewTable=document.getElementById('importPreviewTable');
const importSummary=document.getElementById('importSummary');
const importPageInfo=document.getElementById('importPageInfo');
const autoExcludeThreshold=document.getElementById('autoExcludeThreshold');
const autoExcludeLabel=document.getElementById('autoExcludeLabel');
const importProgressWrap=document.getElementById('importProgressWrap');
const importProgressText=document.getElementById('importProgressText');
const importProgressBar=document.getElementById('importProgressBar');

function parseCSVLine(line,delimiter){
  const result=[];let current='';let inQuotes=false;
  for(let i=0;i<line.length;i++){
    const char=line[i],next=line[i+1];
    if(char==='"'){if(inQuotes&&next==='"'){current+='"';i++;}else{inQuotes=!inQuotes;}}
    else if(char===delimiter&&!inQuotes){result.push(current);current='';}
    else{current+=char;}
  }
  result.push(current);return result;
}
function detectDelimiter(text){const first=text.split('\n')[0]||'';const commas=(first.match(/,/g)||[]).length;const semicolons=(first.match(/;/g)||[]).length;return semicolons>commas?';':',';}
function parseCSV(text){
  const delimiter=detectDelimiter(text);const lines=text.split('\n').filter(l=>l.trim());
  if(!lines.length)return[];
  const headers=parseCSVLine(lines[0],delimiter).map(h=>h.trim().toLowerCase().replace(/^"|"$/g,''));
  return lines.slice(1).map((line,idx)=>{
    const vals=parseCSVLine(line,delimiter);
    const row={};headers.forEach((h,i)=>{row[h]=(vals[i]||'').trim().replace(/^"|"$/g,'');});
    row.__row_number=idx+2;return row;
  }).filter(r=>Object.values(r).some(v=>v&&v!==String(r.__row_number)));
}
function validateCsvRow(row){
  const required=['question','option_a','option_b','option_c','option_d','option_e','correct_option','module_id'];
  for(const f of required){if(!row[f])return`Champ manquant: ${f}`;}
  return null;
}
function updateImportProgress(current,total,dups){
  const pct=Math.round((current/total)*100);
  importProgressBar.style.width=pct+'%';
  importProgressText.textContent=`Analyse en cours: ${current}/${total} lignes — ${dups} doublons potentiels`;
  importProgressWrap.classList.remove('hidden');
}
function esc(s){
  return (s==null?'':String(s))
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#39;');
}
function csvLocationSimilarity(inputRow, candidate){
  const expectedModule = (inputRow.module_id||'').toString().trim();
  const expectedCourse = (inputRow.course_id||'').toString().trim();
  const expectedSource = (inputRow.source_id||'').toString().trim();
  const pieces = [];
  if (expectedModule) pieces.push(String(candidate.module_id||'')===expectedModule?1:0);
  if (expectedCourse) pieces.push(String(candidate.course_id||'')===expectedCourse?1:0);
  if (expectedSource) pieces.push(String(candidate.source_id||'')===expectedSource?1:0);
  if (!pieces.length) return 1;
  return pieces.reduce((a,b)=>a+b,0)/pieces.length;
}
function computeRowSimilarity(row,existingQs,alreadyImported){
  const inputOpts=[row.option_a,row.option_b,row.option_c,row.option_d,row.option_e].map(v=>normalizeText(v)).filter(Boolean).sort();
  let bestDb={percent:0,id:null,question:null,module_id:null,course_id:null,source_id:null,module_name:null,course_name:null,source_name:null};
  for(const q of existingQs){
    const qS=jaccardSimilarity(row.question,q.question||'');
    const pS=propositionSimilarity(inputOpts,getQuestionOptions(q));
    const cS=correctionSimilarity(row.correct_option,q.correct_option||q.correct_options||'');
    const locS=csvLocationSimilarity(row,q);
    const p=Math.round((qS*.5+pS*.4+cS*.1)*locS*100);
    if(p>bestDb.percent){bestDb={percent:p,id:q.id,question:q.question,module_id:q.module_id,course_id:q.course_id,source_id:q.source_id,module_name:q.module_name,course_name:q.course_name,source_name:q.source_name};}
  }
  let bestCsv={percent:0,rowNumber:null,question:null,module_id:null,course_id:null,source_id:null};
  for(const prev of alreadyImported){
    const prevOpts=[prev.raw.option_a,prev.raw.option_b,prev.raw.option_c,prev.raw.option_d,prev.raw.option_e].map(v=>normalizeText(v)).filter(Boolean).sort();
    const qS=jaccardSimilarity(row.question,prev.raw.question||'');
    const pS=propositionSimilarity(inputOpts,prevOpts);
    const cS=correctionSimilarity(row.correct_option,prev.raw.correct_option||'');
    const locS=csvLocationSimilarity(row,prev.raw);
    const p=Math.round((qS*.5+pS*.4+cS*.1)*locS*100);
    if(p>bestCsv.percent){bestCsv={percent:p,rowNumber:prev.rowNumber,question:prev.raw.question,module_id:prev.raw.module_id,course_id:prev.raw.course_id,source_id:prev.raw.source_id};}
  }
  const best=bestDb.percent>=bestCsv.percent?bestDb:bestCsv;
  return{percent:best.percent,matchedAgainst:best.question||null,bestDb,bestCsv};
}
function getIncludedImportRows(){return analyzedImportRows.filter(r=>r.include);}
function applyAutoExclude(){
  const threshold=parseInt(autoExcludeThreshold?.value||'80',10);
  if(autoExcludeLabel)autoExcludeLabel.textContent=threshold+'%';
  analyzedImportRows.forEach(r=>{if(!r.validationError){r.include=r.percent<threshold;}});
  updateImportSummary();renderImportPreviewPage();
}
function updateImportSummary(){
  const total=analyzedImportRows.length;
  const included=analyzedImportRows.filter(r=>r.include).length;
  const excluded=total-included;
  const dups=analyzedImportRows.filter(r=>r.percent>=70).length;
  if(importSummary)importSummary.textContent=`Total: ${total} | Sélectionnés: ${included} | Exclus: ${excluded} | Doublons potentiels: ${dups}`;
}
function renderImportPreviewPage(){
  if(!importPreviewTable)return;
  const totalPages=Math.max(1,Math.ceil(analyzedImportRows.length/importPageSize));
  if(importPage>totalPages)importPage=totalPages;
  const start=(importPage-1)*importPageSize;
  const pageRows=analyzedImportRows.slice(start,start+importPageSize);
  if(importPageInfo)importPageInfo.textContent=`Page ${importPage}/${totalPages}`;
  importPreviewTable.innerHTML=`<table style="width:100%;border-collapse:collapse;font-size:.8rem">
    <thead><tr style="background:var(--surface-2);text-align:left">
      <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Inclure</th>
      <th style="padding:8px 10px;border-bottom:1px solid var(--border)">#</th>
      <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Question</th>
      <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Similarité</th>
      <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Statut</th>
    </tr></thead>
    <tbody>${pageRows.map((r,i)=>{
      const rowClass=r.validationError?'sim-red':r.percent>=90?'sim-red':r.percent>=70?'sim-orange':'';
      const absIndex=start+i;
      const rowSourceName = resolveRefDisplay(r.raw?.source_id, r.raw?.source_name, sourceNameById);
      const bestDbSourceName = resolveRefDisplay(r.bestDb?.source_id, r.bestDb?.source_name, sourceNameById);
      const sourceDiffTag = (r.bestDb && r.bestDb.id && isDifferentSource(rowSourceName?.toLowerCase?.(), bestDbSourceName?.toLowerCase?.()))
        ? '<span class="sim-source-diff-tag">Source différente</span>'
        : '';
      return`<tr class="${rowClass}" style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px"><input type="checkbox" ${r.include?'checked':''} ${r.validationError?'disabled':''} onchange="analyzedImportRows[${start+i}].include=this.checked;updateImportSummary()"></td>
        <td style="padding:8px 10px;color:var(--ink-4)">${r.rowNumber}</td>
        <td style="padding:8px 10px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" onclick="toggleImportDetail(${absIndex})" title="Voir détails">${sourceDiffTag}${esc(r.raw.question||'')}</td>
        <td style="padding:8px 10px;font-weight:700">${r.percent}%</td>
        <td style="padding:8px 10px">${r.validationError?`<span style="color:var(--red);font-size:.75rem">${r.validationError}</span>`:r.percent>=90?'<span style="color:#991b1b">Doublon probable</span>':r.percent>=70?'<span style="color:#92400e">Similaire</span>':'<span style="color:#166534">OK</span>'}</td>
      </tr>
      <tr id="import_detail_${absIndex}" class="hidden">
        <td colspan="5" style="padding:0 10px 10px 10px">
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--surface-2)">
            ${renderImportDetail(r)}
          </div>
        </td>
      </tr>`;}).join('')}
    </tbody></table>`;
}
function renderImportDetail(r){
  const row = r.raw || {};
  const rowModuleName = resolveRefDisplay(row.module_id, row.module_name, moduleNameById);
  const rowCourseName = resolveRefDisplay(row.course_id, row.course_name, courseNameById);
  const rowSourceName = resolveRefDisplay(row.source_id, row.source_name, sourceNameById);
  const opts = ['option_a','option_b','option_c','option_d','option_e']
    .map((k,idx)=>`<div><strong>${String.fromCharCode(65+idx)}.</strong> ${esc(row[k]||'')}</div>`)
    .join('');
  const bestDbText = r.bestDb && r.bestDb.id
    ? `#${r.bestDb.id} (${r.bestDb.percent}%) — ${esc(r.bestDb.question||'')}<br><span class="muted">Module: ${esc(r.bestDb.module_name||r.bestDb.module_id||'-')} | Cours: ${esc(r.bestDb.course_name||r.bestDb.course_id||'-')} | Source: ${esc(r.bestDb.source_name||r.bestDb.source_id||'-')}</span>`
    : 'Aucun';
  const bestCsvText = r.bestCsv && r.bestCsv.rowNumber
    ? `Ligne ${r.bestCsv.rowNumber} (${r.bestCsv.percent}%) — ${esc(r.bestCsv.question||'')}`
    : 'Aucun';
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div>
        <div><strong>Question:</strong> ${esc(row.question||'')}</div>
        <div style="margin-top:6px"><strong>Module/Cours/Source:</strong> ${esc(rowModuleName)} / ${esc(rowCourseName)} / ${esc(rowSourceName)}</div>
        <div style="margin-top:6px"><strong>Correction:</strong> ${esc(row.correct_option||row.correct_options||'-')}</div>
        <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">${opts}</div>
      </div>
      <div>
        <div><strong>Meilleur match DB:</strong><br>${bestDbText}</div>
        <div style="margin-top:10px"><strong>Meilleur match CSV:</strong><br>${bestCsvText}</div>
      </div>
    </div>`;
}
function toggleImportDetail(index){
  const row = document.getElementById(`import_detail_${index}`);
  if(!row) return;
  row.classList.toggle('hidden');
}
async function analyzeCsvRows(){
  if(!importRows.length){importStatus.textContent='Chargez un fichier CSV d\'abord.';return;}
  await refreshReferenceMaps();
  if(!allQuestions.length)await loadQuestionsAdmin();
  analyzedImportRows=[];importPage=1;let potentialDupCount=0;
  const chunk=50;
  for(let i=0;i<importRows.length;i++){
    const row=importRows[i];const validationError=validateCsvRow(row);
    const sim=computeRowSimilarity(row,allQuestions,analyzedImportRows);
    if(sim.percent>=70)potentialDupCount++;
    analyzedImportRows.push({rowNumber:row.__row_number||(i+2),raw:row,percent:sim.percent,matchedAgainst:sim.matchedAgainst,bestDb:sim.bestDb,bestCsv:sim.bestCsv,validationError,include:!validationError});
    if((i+1)%chunk===0||i===importRows.length-1){updateImportProgress(i+1,importRows.length,potentialDupCount);await new Promise(r=>setTimeout(r,0));}
  }
  importProgressWrap.classList.add('hidden');
  importPreview.classList.remove('hidden');
  applyAutoExclude();
  importStatus.textContent=`Analyse terminée: ${importRows.length} lignes, ${potentialDupCount} doublons potentiels.`;
}
async function runImport(rowsToImport){
  const token=localStorage.getItem('token');
  if(!rowsToImport.length){importStatus.textContent='Aucune ligne sélectionnée.';return;}
  const payloadRows=rowsToImport.map(r=>{const clone={...r.raw};delete clone.__row_number;return clone;});
  const res=await fetch(`${API_URL}/questions/import`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({rows:payloadRows})});
  if(res.ok){
    const data=await res.json();importStatus.textContent=`Import terminé. ${data.inserted||0} questions importées.`;
    importPreview.classList.add('hidden');loadQuestionsAdmin();
  }else{const err=await res.json().catch(()=>({}));importStatus.textContent=err.error||'Erreur d\'import';}
}
csvFileInput?.addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  const text=await file.text();importRows=parseCSV(text);analyzedImportRows=[];
  importPreview.classList.add('hidden');
  importStatus.textContent=importRows.length?`Fichier chargé: ${importRows.length} lignes`:'Aucune ligne valide trouvée';
  dropZone.querySelector('p').innerHTML=`<strong>${file.name}</strong> — ${importRows.length} lignes`;
});
analyzeImportBtn?.addEventListener('click',analyzeCsvRows);
autoExcludeThreshold?.addEventListener('input',applyAutoExclude);
document.getElementById('selectAllImportBtn')?.addEventListener('click',()=>{analyzedImportRows.forEach(r=>{if(!r.validationError)r.include=true;});updateImportSummary();renderImportPreviewPage();});
document.getElementById('deselectAllImportBtn')?.addEventListener('click',()=>{analyzedImportRows.forEach(r=>{r.include=false;});updateImportSummary();renderImportPreviewPage();});
document.getElementById('cancelImportPreviewBtn')?.addEventListener('click',()=>{importPreview.classList.add('hidden');importStatus.textContent='Analyse annulée.';});
document.getElementById('importSelectedBtn')?.addEventListener('click',()=>runImport(getIncludedImportRows()));
document.getElementById('importAllBtn')?.addEventListener('click',()=>{analyzedImportRows.forEach(r=>{r.include=!r.validationError;});runImport(analyzedImportRows.filter(r=>!r.validationError));});
document.getElementById('prevImportPageBtn')?.addEventListener('click',()=>{if(importPage>1){importPage--;renderImportPreviewPage();}});
document.getElementById('nextImportPageBtn')?.addEventListener('click',()=>{const t=Math.max(1,Math.ceil(analyzedImportRows.length/importPageSize));if(importPage<t){importPage++;renderImportPreviewPage();}});



