/* Wizard filters: guided + non-guided */
const WB_CLASSES = {
  biologiques: {
    id: 'biologiques',
    name: 'Biologiques',
    icon: 'bi-capsule-pill',
    color: '#0d9488',
    ghost: '#f0fdfa',
    desc: 'Biochimie, Hemobiologie, Microbiologie, Parasitologie, Immunologie'
  },
  fondamentaux: {
    id: 'fondamentaux',
    name: 'Fondamentaux',
    icon: 'bi-bezier2',
    color: '#4f46e5',
    ghost: '#eef2ff',
    desc: 'Biophysique, Chimie analytique, Chimie minerale, Hydro bromatologie'
  },
  pharmaceutiques: {
    id: 'pharmaceutiques',
    name: 'Pharmaceutiques',
    icon: 'bi-heart-pulse',
    color: '#d97706',
    ghost: '#fffbeb',
    desc: 'Pharmacologie, Toxicologie, Pharmacie galenique, etc.'
  }
};

const WB_MODULE_ICONS = {
  biochimie: 'bi-droplet-half',
  hemobiologie: 'bi-virus2',
  microbiologie: 'bi-bug',
  parasitologie: 'bi-shield-bug',
  immunologie: 'bi-shield-check',
  biophysique: 'bi-rulers',
  'chimie analytique': 'bi-beaker',
  'chimie minerale': 'bi-gem',
  'hydro bromatologie': 'bi-cup-straw',
  pharmacologie: 'bi-capsule',
  toxicologie: 'bi-exclamation-triangle',
  'pharmacie galenique': 'bi-box-seam',
  pharmacognosie: 'bi-flower1',
  botanique: 'bi-tree',
  'chimie therapeutique': 'bi-bandaid'
};

let wbBlocks = [];
let wbWizard = null;
let wbEditingIndex = null;
let wbMode = 'guided';
let wbCourseCache = {};
let wbSourceCache = {};
let wbFavtagCache = [];
let wbSyncTimer = null;
let wbLastModuleSignature = '';

function wbNorm(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function wbModuleIcon(label) {
  return WB_MODULE_ICONS[wbNorm(label)] || 'bi-grid-3x3-gap';
}

(function hookSetOptions() {
  const original = window.setOptions;
  if (typeof original !== 'function') return;
  window.setOptions = function patchedSetOptions(selectEl, items, getLabel, selectedValues) {
    original(selectEl, items, getLabel, selectedValues);

    if (selectEl && selectEl.id === 'sel_favtag') {
      wbFavtagCache = Array.from(selectEl.options).map((o) => ({ id: o.value, label: o.textContent.trim() }));
      wbPopulateAdvancedFromNative();
      if (wbWizard && wbWizard.step === 4) wbRender();
    }
    if (selectEl && selectEl.id === 'sel_course') {
      items.forEach((c) => {
        const mid = String(c.module_id || '');
        if (!mid) return;
        if (!wbCourseCache[mid]) wbCourseCache[mid] = [];
        const id = String(c.id ?? c.value);
        if (!wbCourseCache[mid].find((x) => x.id === id)) wbCourseCache[mid].push({ id, label: getLabel(c) });
      });
      wbPopulateAdvancedFromNative();
    }
    if (selectEl && selectEl.id === 'sel_source') {
      items.forEach((s) => {
        const mid = String(s.module_id || '');
        if (!mid) return;
        if (!wbSourceCache[mid]) wbSourceCache[mid] = [];
        const id = String(s.id ?? s.value);
        if (!wbSourceCache[mid].find((x) => x.id === id)) wbSourceCache[mid].push({ id, label: getLabel(s) });
      });
      wbPopulateAdvancedFromNative();
    }
  };
})();

function wbSetSelectedValues(selectEl, values) {
  if (!selectEl) return;
  const set = new Set((values || []).map(String));
  Array.from(selectEl.options).forEach((o) => {
    o.selected = set.has(String(o.value));
  });
}

function wbClearNativeFilters() {
  ['sel_module', 'sel_course', 'sel_source', 'sel_favtag'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    Array.from(el.options).forEach((o) => {
      o.selected = false;
    });
  });
  wbLastModuleSignature = '';
  if (typeof scheduleCountRefresh === 'function') scheduleCountRefresh();
}

function wbGetGuidedEffectiveBlocks() {
  const list = wbBlocks.map((b) => ({ ...b }));
  if (!wbWizard || wbMode !== 'guided' || !wbWizard.moduleId) return list;

  const draft = {
    ...wbWizard,
    courseIds: [...(wbWizard.courseIds || [])],
    sourceIds: [...(wbWizard.sourceIds || [])],
    favtags: wbWizard.favEnabled ? [...(wbWizard.favtags || [])] : []
  };

  if (wbEditingIndex !== null && list[wbEditingIndex]) list[wbEditingIndex] = draft;
  else list.push(draft);
  return list;
}

function wbApplyGuidedFilters() {
  const sm = document.getElementById('sel_module');
  const sc = document.getElementById('sel_course');
  const ss = document.getElementById('sel_source');
  const sf = document.getElementById('sel_favtag');
  if (!sm || !sc || !ss || !sf) return;

  const blocks = wbGetGuidedEffectiveBlocks().filter((b) => b && b.moduleId);
  if (!blocks.length) {
    wbClearNativeFilters();
    return;
  }

  const moduleIds = [...new Set(blocks.map((b) => String(b.moduleId)))];
  const courseIds = [...new Set(blocks.flatMap((b) => b.courseIds || []).map(String))];
  const sourceIds = [...new Set(blocks.flatMap((b) => b.sourceIds || []).map(String))];
  const favtags = [...new Set(blocks.flatMap((b) => (b.favEnabled ? (b.favtags || []) : [])).map(String))];

  wbSetSelectedValues(sm, moduleIds);
  const moduleSig = moduleIds.join(',');
  const moduleChanged = moduleSig !== wbLastModuleSignature;
  wbLastModuleSignature = moduleSig;
  if (moduleChanged) sm.dispatchEvent(new Event('change'));

  clearTimeout(wbSyncTimer);
  wbSyncTimer = setTimeout(() => {
    wbSetSelectedValues(sc, courseIds);
    wbSetSelectedValues(ss, sourceIds);
    wbSetSelectedValues(sf, favtags);
    if (typeof scheduleCountRefresh === 'function') scheduleCountRefresh();
    wbPopulateAdvancedFromNative();
  }, moduleChanged ? 360 : 40);
}

function wbApplyAdvancedFilters() {
  // now delegates to libState â€” real implementation added below after lib setup
}

function wbApplyActiveFilters() {
  if (wbMode === 'advanced') wbApplyAdvancedFilters();
  else wbApplyGuidedFilters();
}

async function wbFetchCourses(moduleId) {
  const mid = String(moduleId);
  if (wbCourseCache[mid]) return wbCourseCache[mid];
  try {
    const res = await fetch(`${API_URL}/courses`);
    if (!res.ok) return [];
    const all = await res.json();
    all.forEach((c) => {
      const moduleKey = String(c.module_id || '');
      if (!moduleKey) return;
      if (!wbCourseCache[moduleKey]) wbCourseCache[moduleKey] = [];
      const id = String(c.id);
      if (!wbCourseCache[moduleKey].find((x) => x.id === id)) {
        wbCourseCache[moduleKey].push({ id, label: c.name });
      }
    });
    return wbCourseCache[mid] || [];
  } catch {
    return [];
  }
}

async function wbFetchSources(moduleId) {
  const mid = String(moduleId);
  if (wbSourceCache[mid]) return wbSourceCache[mid];
  try {
    const res = await fetch(`${API_URL}/sources?module_id=${mid}`);
    if (!res.ok) return [];
    const arr = await res.json();
    wbSourceCache[mid] = arr.map((s) => ({ id: String(s.id), label: s.name }));
    return wbSourceCache[mid];
  } catch {
    return [];
  }
}

function wbStartWizard(editIndex = null) {
  wbEditingIndex = Number.isInteger(editIndex) ? editIndex : null;
  if (wbEditingIndex !== null && wbBlocks[wbEditingIndex]) {
    const base = wbBlocks[wbEditingIndex];
    wbWizard = {
      step: 2,
      classId: base.classId,
      moduleId: base.moduleId,
      moduleLabel: base.moduleLabel,
      availCourses: [...(base.availCourses || [])],
      availSources: [...(base.availSources || [])],
      courseIds: [...(base.courseIds || [])],
      sourceIds: [...(base.sourceIds || [])],
      favtags: [...(base.favtags || [])],
      favEnabled: !!base.favEnabled
    };
  } else {
    wbWizard = {
      step: 0,
      classId: null,
      moduleId: null,
      moduleLabel: '',
      availCourses: [],
      availSources: [],
      courseIds: [],
      sourceIds: [],
      favtags: [],
      favEnabled: false
    };
  }
  wbRender();
  wbApplyActiveFilters();
}

function wbRender() {
  const blocksEl = document.getElementById('wb-blocks');
  const wizardEl = document.getElementById('wb-wizard');
  const addWrap = document.getElementById('wb-add-wrap');
  if (!blocksEl || !wizardEl || !addWrap) return;

  blocksEl.innerHTML = wbBlocks
    .map((b, i) => {
      const cls = WB_CLASSES[b.classId] || WB_CLASSES.pharmaceutiques;
      const moduleIcon = wbModuleIcon(b.moduleLabel);
      const courseChips = (b.courseIds || []).length
        ? b.courseIds
            .map((id) => {
              const c = (b.availCourses || []).find((x) => x.id === id);
              return `<span class="wb-chip wb-chip--course">${c ? c.label : id}</span>`;
            })
            .join('')
        : '<span class="wb-chip wb-chip--muted">Tous les cours</span>';
      const sourceChips = (b.sourceIds || [])
        .map((id) => {
          const s = (b.availSources || []).find((x) => x.id === id);
          return `<span class="wb-chip wb-chip--source"><i class="bi bi-file-earmark-text"></i> ${s ? s.label : id}</span>`;
        })
        .join('');
      const favChips = (b.favEnabled ? b.favtags || [] : []).map((t) => `<span class="wb-chip wb-chip--fav"><i class="bi bi-heart-fill"></i> ${t}</span>`).join('');

      return `<div class="wb-block">
        <div class="wb-block-num" style="background:${cls.color}">${i + 1}</div>
        <div class="wb-block-info">
          <div class="wb-block-title">
            <span class="wb-block-cls" style="color:${cls.color}"><i class="bi ${cls.icon}"></i> ${cls.name}</span>
            <span class="wb-block-mod"><i class="bi ${moduleIcon}"></i> ${b.moduleLabel}</span>
          </div>
          <div class="wb-block-chips">${courseChips}${sourceChips}${favChips}</div>
        </div>
        <div class="wb-block-actions">
          <button class="wb-edit-btn" data-edit="${i}" title="Modifier"><i class="bi bi-pencil-square"></i></button>
          <button class="wb-del-btn" data-del="${i}" title="Supprimer"><i class="bi bi-trash"></i></button>
        </div>
      </div>`;
    })
    .join('');

  blocksEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      wbStartWizard(parseInt(btn.dataset.edit, 10));
    });
  });

  blocksEl.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.del, 10);
      if (Number.isNaN(idx)) return;
      wbBlocks.splice(idx, 1);
      if (wbEditingIndex === idx) {
        wbWizard = null;
        wbEditingIndex = null;
      } else if (wbEditingIndex !== null && wbEditingIndex > idx) {
        wbEditingIndex -= 1;
      }
      if (!wbBlocks.length && !wbWizard) wbStartWizard();
      wbRender();
      wbApplyActiveFilters();
    });
  });

  addWrap.style.display = wbMode === 'guided' && wbBlocks.length > 0 && !wbWizard ? 'block' : 'none';
  if (!wbWizard || wbMode !== 'guided') {
    wizardEl.innerHTML = '';
    return;
  }

  const { step, classId, moduleId, moduleLabel, availCourses, availSources, courseIds, sourceIds, favtags, favEnabled } = wbWizard;
  const cls = WB_CLASSES[classId] || WB_CLASSES.pharmaceutiques;
  const allModules = Array.isArray(window.__dashboardModules) ? window.__dashboardModules : [];
  const usedModuleIds = new Set(wbBlocks.map((b, idx) => (idx === wbEditingIndex ? null : String(b.moduleId))).filter(Boolean));
  const dots = Array.from({ length: 5 }, (_, s) => `<div class="wb-dot${s === step ? ' active' : s < step ? ' done' : ''}"></div>`).join('');

  let body = '';

  if (step === 0) {
    const cards = Object.values(WB_CLASSES)
      .map((c) => {
        const available = allModules.filter((m) => (m.module_class || 'pharmaceutiques').toLowerCase() === c.id && !usedModuleIds.has(String(m.id)));
        if (!available.length) return '';
        return `<button class="wb-class-card${classId === c.id ? ' selected' : ''}" data-class="${c.id}" type="button" style="--cc:${c.color};--cg:${c.ghost}">
          <div class="wb-cc-top"><i class="bi ${c.icon} wb-cc-icon"></i><span class="wb-cc-name">${c.name}</span></div>
          <div class="wb-cc-desc">${c.desc}</div>
        </button>`;
      })
      .join('');

    body = `<div class="wb-step-hd"><div class="wb-snum">1</div><span class="wb-slbl">Choisissez une categorie</span></div>
      <div class="wb-class-grid">${cards || '<span class="wb-empty">Aucune categorie disponible.</span>'}</div>`;
  }

  if (step === 1) {
    const mods = allModules.filter((m) => (m.module_class || 'pharmaceutiques').toLowerCase() === classId && !usedModuleIds.has(String(m.id)));
    const cards = mods
      .map((m) => {
        const icon = wbModuleIcon(m.name);
        return `<button class="wb-mod-card${moduleId === String(m.id) ? ' selected' : ''}" data-mid="${m.id}" data-mlbl="${m.name}" type="button">
          <div class="wb-mod-head"><i class="bi ${icon} wb-mod-icon"></i><span class="wb-mod-name">${m.name}</span></div>
        </button>`;
      })
      .join('');

    body = `<div class="wb-crumb" style="--cc:${cls.color}">
      <div class="wb-snum done"><i class="bi bi-check"></i></div>
      <span style="color:${cls.color};font-weight:700"><i class="bi ${cls.icon}"></i> ${cls.name}</span>
    </div>
    <div class="wb-step-hd"><div class="wb-snum">2</div><span class="wb-slbl">Choisissez un module</span></div>
    <div class="wb-mod-grid">${cards || '<span class="wb-empty">Aucun module disponible.</span>'}</div>
    <div class="wb-nav"><button class="wb-back" id="wbB1" type="button"><i class="bi bi-arrow-left"></i> Retour</button><span></span></div>`;
  }

  if (step === 2) {
    const chips = (availCourses || [])
      .map((c) => `<button class="wb-course-chip${courseIds.includes(c.id) ? ' selected' : ''}" data-cid="${c.id}" type="button">${c.label}</button>`)
      .join('');
    const countLabel = courseIds.length ? `${courseIds.length} selectionne(s)` : 'Tous si vide';

    body = `<div class="wb-crumb" style="--cc:${cls.color}">
      <div class="wb-snum done"><i class="bi bi-check"></i></div>
      <span style="color:${cls.color};font-weight:700"><i class="bi ${cls.icon}"></i> ${cls.name}</span>
      <span class="wb-crumb-val"><i class="bi ${wbModuleIcon(moduleLabel)}"></i> ${moduleLabel}</span>
    </div>
    <div class="wb-step-hd"><div class="wb-snum">3</div><span class="wb-slbl">Cours a inclure</span><span class="wb-sval">${countLabel}</span></div>
    <div class="wb-chips-wrap">${chips || '<span class="wb-empty">Aucun cours pour ce module.</span>'}</div>
    <div class="wb-nav"><button class="wb-back" id="wbB2" type="button"><i class="bi bi-arrow-left"></i> Retour</button><button class="wb-next" id="wbN2" type="button" style="background:${cls.color}">Suivant <i class="bi bi-arrow-right"></i></button></div>`;
  }

  if (step === 3) {
    const pills = (availSources || [])
      .map((s) => `<button class="wb-src-pill${sourceIds.includes(s.id) ? ' selected' : ''}" data-sid="${s.id}" type="button"><span class="wb-src-dot"></span><span>${s.label}</span>${sourceIds.includes(s.id) ? '<i class="bi bi-check wb-src-check"></i>' : ''}</button>`)
      .join('');
    const label = sourceIds.length ? `${sourceIds.length} selectionnee(s)` : 'Optionnel';

    body = `<div class="wb-crumb" style="--cc:${cls.color}">
      <div class="wb-snum done"><i class="bi bi-check"></i></div>
      <span style="color:${cls.color};font-weight:700"><i class="bi ${cls.icon}"></i> ${cls.name}</span>
      <span class="wb-crumb-val"><i class="bi ${wbModuleIcon(moduleLabel)}"></i> ${moduleLabel}</span>
    </div>
    <div class="wb-step-hd"><div class="wb-snum">4</div><span class="wb-slbl">Sources</span><span class="wb-sval">${label}</span></div>
    <div class="wb-src-grid">${pills || '<span class="wb-empty">Aucune source disponible.</span>'}</div>
    <div class="wb-nav"><button class="wb-back" id="wbB3" type="button"><i class="bi bi-arrow-left"></i> Retour</button><button class="wb-next" id="wbN3" type="button" style="background:${cls.color}">Suivant <i class="bi bi-arrow-right"></i></button></div>`;
  }

  if (step === 4) {
    const tagChips = wbFavtagCache
      .map((t) => `<button class="wb-fav-chip${favtags.includes(t.id) ? ' selected' : ''}" data-tid="${t.id}" type="button">${t.label}</button>`)
      .join('');

    body = `<div class="wb-crumb" style="--cc:${cls.color}">
      <div class="wb-snum done"><i class="bi bi-check"></i></div>
      <span style="color:${cls.color};font-weight:700"><i class="bi ${cls.icon}"></i> ${cls.name}</span>
      <span class="wb-crumb-val"><i class="bi ${wbModuleIcon(moduleLabel)}"></i> ${moduleLabel}</span>
    </div>
    <div class="wb-step-hd"><div class="wb-snum">5</div><span class="wb-slbl">Tags favoris</span><span class="wb-sval">Optionnel</span></div>
    <div class="wb-fav-toggle-row">
      <div class="wb-fav-toggle-left">
        <div class="wb-fav-icon"><i class="bi bi-heart-fill"></i></div>
        <div><div class="wb-fav-lbl">Filtrer par tag favori</div><div class="wb-fav-sub">Uniquement les questions marquees favoris</div></div>
      </div>
      <label class="toggle-switch"><input type="checkbox" id="wbFavToggle" ${favEnabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
    ${favEnabled ? `<div class="wb-chips-wrap wb-chips-fav">${tagChips || '<span class="wb-empty">Aucun tag favori.</span>'}</div>` : ''}
    <div class="wb-nav"><button class="wb-back" id="wbB4" type="button"><i class="bi bi-arrow-left"></i> Retour</button><button class="wb-confirm" id="wbConfirm" type="button"><i class="bi bi-check-lg"></i> ${wbEditingIndex !== null ? 'Mettre a jour le filtre' : 'Confirmer ce filtre'}</button></div>`;
  }

  wizardEl.innerHTML = `<div class="wb-wizard-wrap">
    <div class="wb-meta">
      <span class="wb-bloc-label">${wbEditingIndex !== null ? `Edition filtre ${wbEditingIndex + 1}` : wbBlocks.length ? `Bloc ${wbBlocks.length + 1}` : 'Nouveau filtre'}</span>
      <div class="wb-meta-right">
        <div class="wb-dots">${dots}</div>
        <button class="wb-cancel" id="wbCancelWizard" type="button">Annuler</button>
      </div>
    </div>
    ${body}
  </div>`;

  wbAttachWizardEvents();
}

function wbAttachWizardEvents() {
  if (!wbWizard) return;

  document.getElementById('wbCancelWizard')?.addEventListener('click', () => {
    wbWizard = null;
    wbEditingIndex = null;
    if (!wbBlocks.length) wbStartWizard();
    else {
      wbRender();
      wbApplyActiveFilters();
    }
  });

  if (wbWizard.step === 0) {
    document.querySelectorAll('.wb-class-card').forEach((card) => {
      card.addEventListener('click', () => {
        wbWizard.classId = card.dataset.class;
        wbWizard.moduleId = null;
        wbWizard.moduleLabel = '';
        wbWizard.courseIds = [];
        wbWizard.sourceIds = [];
        wbWizard.step = 1;
        wbRender();
        wbApplyActiveFilters();
      });
    });
  }

  if (wbWizard.step === 1) {
    document.getElementById('wbB1')?.addEventListener('click', () => {
      wbWizard.step = 0;
      wbRender();
    });

    document.querySelectorAll('.wb-mod-card').forEach((card) => {
      card.addEventListener('click', async () => {
        const mid = String(card.dataset.mid);
        wbWizard.moduleId = mid;
        wbWizard.moduleLabel = card.dataset.mlbl;
        wbWizard.courseIds = [];
        wbWizard.sourceIds = [];
        wbWizard.availCourses = await wbFetchCourses(mid);
        wbWizard.availSources = await wbFetchSources(mid);
        wbWizard.step = 2;
        wbRender();
        wbApplyActiveFilters();
      });
    });
  }

  if (wbWizard.step === 2) {
    document.getElementById('wbB2')?.addEventListener('click', () => {
      wbWizard.step = 1;
      wbRender();
    });
    document.getElementById('wbN2')?.addEventListener('click', () => {
      wbWizard.step = 3;
      wbRender();
    });
    document.querySelectorAll('.wb-course-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const cid = chip.dataset.cid;
        const i = wbWizard.courseIds.indexOf(cid);
        if (i >= 0) { wbWizard.courseIds.splice(i, 1); chip.classList.remove('selected'); }
        else         { wbWizard.courseIds.push(cid);    chip.classList.add('selected'); }
        const sval = document.querySelector('#wb-wizard .wb-sval');
        if (sval) sval.textContent = wbWizard.courseIds.length ? wbWizard.courseIds.length + ' selectionne(s)' : 'Tous si vide';
        wbApplyActiveFilters();
      });
    });
  }

  if (wbWizard.step === 3) {
    document.getElementById('wbB3')?.addEventListener('click', () => {
      wbWizard.step = 2;
      wbRender();
    });
    document.getElementById('wbN3')?.addEventListener('click', () => {
      wbWizard.step = 4;
      wbRender();
    });
    document.querySelectorAll('.wb-src-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const sid = pill.dataset.sid;
        const i = wbWizard.sourceIds.indexOf(sid);
        if (i >= 0) {
          wbWizard.sourceIds.splice(i, 1);
          pill.classList.remove('selected');
          pill.querySelector('.wb-src-check')?.remove();
        } else {
          wbWizard.sourceIds.push(sid);
          pill.classList.add('selected');
          if (!pill.querySelector('.wb-src-check')) {
            const chk = document.createElement('i');
            chk.className = 'bi bi-check wb-src-check';
            pill.appendChild(chk);
          }
        }
        const sval = document.querySelector('#wb-wizard .wb-sval');
        if (sval) sval.textContent = wbWizard.sourceIds.length ? wbWizard.sourceIds.length + ' selectionnee(s)' : 'Optionnel';
        wbApplyActiveFilters();
      });
    });
  }

  if (wbWizard.step === 4) {
    document.getElementById('wbB4')?.addEventListener('click', () => {
      wbWizard.step = 3;
      wbRender();
    });
    document.getElementById('wbFavToggle')?.addEventListener('change', (e) => {
      wbWizard.favEnabled = e.target.checked;
      if (!wbWizard.favEnabled) wbWizard.favtags = [];
      wbRender();
      wbApplyActiveFilters();
    });
    document.querySelectorAll('.wb-fav-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tid = chip.dataset.tid;
        const i = wbWizard.favtags.indexOf(tid);
        if (i >= 0) { wbWizard.favtags.splice(i, 1); chip.classList.remove('selected'); }
        else         { wbWizard.favtags.push(tid);    chip.classList.add('selected'); }
        wbApplyActiveFilters();
      });
    });
    document.getElementById('wbConfirm')?.addEventListener('click', () => {
      const ready = {
        ...wbWizard,
        courseIds: [...(wbWizard.courseIds || [])],
        sourceIds: [...(wbWizard.sourceIds || [])],
        favtags: wbWizard.favEnabled ? [...(wbWizard.favtags || [])] : []
      };
      if (!ready.moduleId) return;
      if (wbEditingIndex !== null && wbBlocks[wbEditingIndex]) wbBlocks[wbEditingIndex] = ready;
      else wbBlocks.push(ready);
      wbWizard = null;
      wbEditingIndex = null;
      wbRender();
      wbApplyActiveFilters();
    });
  }
}

/* â”€â”€ Advanced filters now use libState instead of wb_adv_ selects â”€â”€ */
function wbApplyAdvancedFilters() {
  const sm = document.getElementById('sel_module');
  const sc = document.getElementById('sel_course');
  const ss = document.getElementById('sel_source');
  const sf = document.getElementById('sel_favtag');
  if (!sm) return;
  const mods = [...libState.module];
  const cors = [...libState.course];
  const srcs = [...libState.source];
  const favs = [...libState.favtag];
  wbSetSelectedValues(sm, mods);
  const sig = mods.join(',');
  const changed = sig !== wbLastModuleSignature;
  wbLastModuleSignature = sig;
  if (changed) sm.dispatchEvent(new Event('change'));
  clearTimeout(wbSyncTimer);
  wbSyncTimer = setTimeout(() => {
    wbSetSelectedValues(sc, cors);
    wbSetSelectedValues(ss, srcs);
    wbSetSelectedValues(sf, favs);
    if (typeof scheduleCountRefresh === 'function') scheduleCountRefresh();
    libRebuildFromNative('course');
    libRebuildFromNative('source');
    libRebuildFromNative('favtag');
  }, changed ? 360 : 40);
}

/* â”€â”€ Libre dropdown helpers â”€â”€ */
const LIB_KEYS = ['module','course','source','favtag'];
const LIB_PH = {module:'Tous les modules',course:'Tous les cours',source:'Toutes les sources',favtag:'Tous les tags'};
const libState = {module:new Set(),course:new Set(),source:new Set(),favtag:new Set()};

function libGetOpts(key)  { return Array.from(document.querySelectorAll('#lib_opts_'+key+' .lib-opt')); }
function libGetVis(key)   { return libGetOpts(key).filter(o=>!o.classList.contains('lib-hidden')); }

function libRebuildFromNative(key) {
  const nMap = {module:'sel_module',course:'sel_course',source:'sel_source',favtag:'sel_favtag'};
  const native = document.getElementById(nMap[key]);
  const container = document.getElementById('lib_opts_'+key);
  if (!native||!container) return;
  container.innerHTML = '';
  Array.from(native.options).forEach(opt=>{
    const d=document.createElement('div');
    d.className='lib-opt'+(libState[key].has(opt.value)?' selected':'');
    d.dataset.val=opt.value;
    d.innerHTML='<div class="lib-cb"></div>'+opt.textContent;
    container.appendChild(d);
  });
  libRenderAllbox(key);
  libRenderTrigger(key);
}

function wbPopulateAdvancedFromNative() {
  LIB_KEYS.forEach(k=>libRebuildFromNative(k));
}

function libRenderTrigger(key) {
  const vals=[...libState[key]];
  const textEl=document.getElementById('lib_text_'+key);
  const badge=document.getElementById('lib_badge_'+key);
  if (!textEl||!badge) return;
  if (!vals.length) {
    textEl.textContent=LIB_PH[key]; textEl.className='lib-trig-txt ph';
    badge.textContent='Tous'; badge.classList.remove('active');
  } else {
    const first=(document.querySelector('#lib_opts_'+key+' [data-val="'+CSS.escape(vals[0])+'"]')?.textContent||vals[0]).trim();
    const short=first.length>17?first.slice(0,15)+'...':first;
    const more=vals.length>1?'<span class="lib-tag-more">+'+( vals.length-1)+'</span>':'';
    textEl.innerHTML='<span class="lib-tags"><span class="lib-tag">'+short+'</span>'+more+'</span>';
    textEl.className='lib-trig-txt';
    badge.textContent=vals.length+' sel.'; badge.classList.add('active');
  }
}

function libRenderAllbox(key) {
  const box=document.getElementById('lib_allbox_'+key);
  const txt=document.getElementById('lib_alltext_'+key);
  if (!box||!txt) return;
  const vis=libGetVis(key);
  const sel=vis.filter(o=>libState[key].has(o.dataset.val)).length;
  box.className='lib-allbox'+(key==='favtag'?' lib-allbox--fav':'');
  if (sel===0)            { txt.textContent='Tout selectionner'; }
  else if (sel===vis.length){ box.classList.add('all'); txt.textContent='Tout deselectionner'; }
  else                    { box.classList.add('partial'); txt.textContent=sel+' / '+vis.length; }
}

function libRenderOpts(key) { libGetOpts(key).forEach(o=>o.classList.toggle('selected',libState[key].has(o.dataset.val))); }

function libSearch(key,q) {
  q=(q||'').toLowerCase().trim();
  libGetOpts(key).forEach(o=>o.classList.toggle('lib-hidden',!!q&&!o.textContent.toLowerCase().includes(q)));
  const ctr=document.getElementById('lib_opts_'+key);
  const empty=document.getElementById('lib_empty_'+key);
  if (!libGetVis(key).length) {
    if (!empty){const d=document.createElement('div');d.className='lib-empty';d.id='lib_empty_'+key;d.textContent='Aucun resultat';ctr.appendChild(d);}
  } else empty?.remove();
}

function libCloseAll(except) {
  LIB_KEYS.forEach(key=>{
    if (key===except) return;
    document.getElementById('lib_drop_'+key)?.classList.add('hidden');
    document.getElementById('lib_trig_'+key)?.classList.remove('open');
  });
}

LIB_KEYS.forEach(key=>{
  const trig=document.getElementById('lib_trig_'+key);
  const drop=document.getElementById('lib_drop_'+key);
  const search=document.getElementById('lib_search_'+key);
  const allRow=document.getElementById('lib_all_'+key);
  const opts=document.getElementById('lib_opts_'+key);
  if (!trig||!drop) return;
  trig.addEventListener('click',e=>{
    e.stopPropagation();
    const isOpen=!drop.classList.contains('hidden');
    libCloseAll(key);
    drop.classList.toggle('hidden',isOpen);
    trig.classList.toggle('open',!isOpen);
    if (!isOpen&&search){search.value='';libSearch(key,'');setTimeout(()=>search.focus(),40);}
  });
  opts?.addEventListener('click',e=>{
    const opt=e.target.closest('.lib-opt'); if (!opt) return;
    const val=opt.dataset.val;
    libState[key].has(val)?libState[key].delete(val):libState[key].add(val);
    libRenderOpts(key);libRenderTrigger(key);libRenderAllbox(key);
    wbApplyActiveFilters();
  });
  allRow?.addEventListener('click',()=>{
    const vis=libGetVis(key).map(o=>o.dataset.val);
    const allSel=vis.every(v=>libState[key].has(v));
    allSel?vis.forEach(v=>libState[key].delete(v)):vis.forEach(v=>libState[key].add(v));
    libRenderOpts(key);libRenderTrigger(key);libRenderAllbox(key);
    wbApplyActiveFilters();
  });
  search?.addEventListener('input',()=>{libSearch(key,search.value);libRenderAllbox(key);});
  search?.addEventListener('click',e=>e.stopPropagation());
  drop?.addEventListener('click',e=>e.stopPropagation());
});
document.addEventListener('click',()=>libCloseAll(null));

/* â”€â”€ Mode switch â”€â”€ */
function wbSetMode(mode) {
  wbMode = mode==='advanced'?'advanced':'guided';
  document.getElementById('wbGuidedBtn')?.classList.toggle('active',wbMode==='guided');
  document.getElementById('wbAdvancedBtn')?.classList.toggle('active',wbMode==='advanced');
  document.getElementById('wb-guided-mode')?.classList.toggle('hidden',wbMode!=='guided');
  document.getElementById('wb-advanced-mode')?.classList.toggle('hidden',wbMode!=='advanced');
  if (wbMode==='guided'&&!wbWizard&&!wbBlocks.length) wbStartWizard();
  if (wbMode==='advanced') wbPopulateAdvancedFromNative();
  wbApplyActiveFilters();
}

/* â”€â”€ Wire events â”€â”€ */
function wbWireCommonEvents() {
  document.getElementById('wb-add-btn')?.addEventListener('click',()=>wbStartWizard());
  document.getElementById('filterResetBtn')?.addEventListener('click',()=>{
    wbBlocks=[];wbWizard=null;wbEditingIndex=null;
    LIB_KEYS.forEach(k=>{libState[k].clear();libRenderOpts(k);libRenderTrigger(k);libRenderAllbox(k);});
    wbRender();wbApplyActiveFilters();
    if (wbMode==='guided') wbStartWizard();
  });
  document.getElementById('wbGuidedBtn')?.addEventListener('click',()=>wbSetMode('guided'));
  document.getElementById('wbAdvancedBtn')?.addEventListener('click',()=>wbSetMode('advanced'));
  window.addEventListener('dashboard:modules-loaded',()=>{
    wbRender();wbPopulateAdvancedFromNative();wbApplyActiveFilters();
  });
}

wbWireCommonEvents();
wbStartWizard();
wbSetMode('guided');

[['training_question_count','training_slider_max'],['exam_question_count','exam_slider_max']].forEach(([sid,mid])=>{
  const s=document.getElementById(sid),m=document.getElementById(mid);
  if (!s||!m) return;
  new MutationObserver(()=>{m.textContent=s.max||'-';}).observe(s,{attributes:true,attributeFilter:['max']});
});

