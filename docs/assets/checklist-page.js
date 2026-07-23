'use strict';
// The dependency-aware checklist (extracted from content.js to keep both files focused).
// checklistItems() is exported for dashboard.js (the readiness widget + alert stream); all
// mutation handlers dispatch jwh:data-changed at the mutation site (never in render()).

import { $, $$, esc, srcLinks } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { fmtShort, windowStatus, nowISO, countdown } from './lib/dates.js';
import { makeSortableGroup } from './dnd.js';
import { mountAccordion, setCollapsed } from './collapse.js';
import { celebrate } from './celebrate.js';
import { customItem, partitionCustom, applyPhaseMoves, loadChecklistCustom, saveChecklistCustom, renameById } from './lib/checklist.js';
import { listCtl, LISTCTL } from './lib/listctl.js';
import { askDate, askTags, alertModal, confirmModal } from './lib/modal.js';
import { tagsFor, allTags, setTags, tagHue } from './lib/tags.js';
import { migratePriority, getLevel, setLevel, cyclePriority, priorityRank } from './lib/priority.js';
import { filterView, groupByDay } from './lib/smartviews.js';
import { shortcutsEnabled } from './lib/shortcuts.js';

let DATA = null;

// ---- store-backed phases -------------------------------------------------
// The default phased items used to be read-only from tips.json. They now live in the store
// (KEYS.checklistPhases), seeded ONCE from the tips.json defaults on first read, so every item
// is editable/deletable through the UI and rides the cross-device sync (like the calendar +
// tracker). `seed` (the mounted DATA, or the `data` a caller passes) is the seed source; after
// the first write the store is the source of truth — later tips.json edits won't re-seed.
function getPhases(seed) {
  let p = get(KEYS.checklistPhases, null);
  if (!Array.isArray(p) || !p.length) {
    const src = ((seed || DATA) && (seed || DATA).checklist) || [];
    p = src.map(ph => ({ phase: ph.phase, window: ph.window || '', items: (ph.items || []).map(it => ({ ...it })) }));
    if (p.length) set(KEYS.checklistPhases, p);
  }
  return p;
}
function savePhases(p) { set(KEYS.checklistPhases, p); }
// exported for print.js so a printed checklist reflects the user's store edits, not the tips.json seed
export function getChecklistPhases(seed) { return getPhases(seed); }
function findPhaseItem(id) {
  for (const p of getPhases()) { const it = (p.items || []).find(x => x.id === id); if (it) return it; }
  return null;
}
function renamePhaseItem(id, text) {
  const t = String(text ?? '').trim(); if (!t) return;
  savePhases(getPhases().map(p => ({ ...p, items: (p.items || []).map(it => it.id === id ? { ...it, task: t } : it) })));
}
function deletePhaseItem(id) {
  savePhases(getPhases().map(p => ({ ...p, items: (p.items || []).filter(it => it.id !== id) })));
}

let composerDue = '';   // ISO due date chosen in the add-composer; reset after each add
function setComposerDueLabel() {
  const b = $('#checkAddDue');
  if (b) b.textContent = composerDue ? `📅 ${fmtShort(composerDue)}` : '📅 Due';
}
function wireComposerDue() {
  setComposerDueLabel();
  $('#checkAddDue')?.addEventListener('click', async () => {
    const v = await askDate('Due date for the new task (blank to clear):', { value: composerDue });
    if (v === null) return;            // cancelled
    composerDue = v.trim();            // '' clears
    setComposerDueLabel();
  });
}

export function mountChecklist(data, today) {
  DATA = data;
  migratePriorityOnce();   // persist the v1→v2 priority migration once (not on every render)
  seedPhaseCollapseOnce(); // first visit: collapse all phases but the first one with open work
  seedArrivedCollapseOnce(today); // post-arrival, once: collapse the finished pre-departure + landing-day phases
  renderCheckTools();
  renderCheckToolbar();
  renderChecklist(today);
  wireCheckSettingsListener();
  wireCheckKeyboard();
}

// Keyboard shortcuts — parity with the calendar (arrow/j-k to move between tasks, then act on the
// focused row). The checkbox is the focusable anchor per row; Space toggles it natively. Reuses the
// existing row buttons via .click() so behaviour and data flow stay single-path.
let _checkKbWired = false;
function visibleChecks() {
  return $$('#checkPhases input[type=checkbox]').filter(cb => cb.offsetParent !== null);   // skip collapsed accordions
}
function onCheckKeydown(e) {
  if (location.hash !== '#/checklist') return;
  if (document.querySelector('[aria-modal="true"]')) return;   // any open dialog (calendar/app/date-picker) owns the keyboard
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  // bail on text entry, but NOT on the task checkboxes (those are our nav anchors)
  const isText = (tag === 'input' && !['checkbox', 'radio'].includes(e.target.type)) || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (isText) return;
  if (!shortcutsEnabled() && e.key.length === 1) return;   // WCAG 2.1.4: single-char shortcuts (j/k/e/−/p/d) off; arrows + Del/Backspace stay
  const row = e.target.closest?.('.check-item');
  if (['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) {
    const boxes = visibleChecks();
    if (!boxes.length) return;
    const cur = row?.querySelector('input[type=checkbox]');
    const idx = cur ? boxes.indexOf(cur) : -1;
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const next = idx < 0 ? boxes[0] : boxes[idx + (down ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus({ preventScroll: true }); }
    return;
  }
  if (!row) return;
  const act = (sel) => { const b = row.querySelector(sel); if (b) { e.preventDefault(); b.click(); } };
  if (e.key === 'e' || e.key === 'E') return act('.check-edit');
  if (e.key === '-' || e.key === 'Delete' || e.key === 'Backspace') return act('.check-del');
  if (e.key === 'p' || e.key === 'P') return act('.ci-flag');
  if (e.key === 'd' || e.key === 'D') return act('.ci-due');
}
function wireCheckKeyboard() {
  if (_checkKbWired) return;
  _checkKbWired = true;
  document.addEventListener('keydown', onCheckKeydown);
}

// ---- dependency-aware checklist with due dates ----
function loadChecks() { return get(KEYS.checklist, {}) || {}; }
// First visit only: collapse every phase so the "all" view opens as a clean overview — progress
// bar + smart-view pills + one collapsed header per phase (each showing its done/total) — instead
// of one 20,000px+ scroll of 80+ verbose tasks. Drill into a phase, or use the Today/Upcoming/
// Overdue pills for what's actionable. Persists to the shared collapse set; user toggles stick.
function seedPhaseCollapseOnce() {
  if (getRaw(KEYS.checkPhaseCollapseSeed) === '1') return;
  const phases = getPhases();
  phases.forEach((p, pi) => setCollapsed(`chk-phase-${pi}`, true));
  setCollapsed('chk-phase-mine', true);
  setRaw(KEYS.checkPhaseCollapseSeed, '1');
}
// Post-arrival one-time seed: the pre-departure prep and the landing-day sprint are finished
// stories once you're in Japan — collapse them so the checklist opens on what's still actionable
// (First 14 Days / First Month / seasonal). Runs once ever, guarded by its own flag, and only
// once actually arrived; user toggles thereafter stick (shared collapse set).
const ARRIVED_SEED_KEY = 'jwh-checklist-arrived-seed-v2'   /* v2: phases renamed by the Do-Now restructure — v1 flags fired against the OLD names */;
function seedArrivedCollapseOnce(today) {
  if (getRaw(ARRIVED_SEED_KEY) === '1') return;
  if (countdown(DATA.meta?.arrival_date || '2026-06-30', today || nowISO()).phase !== 'arrived') return;
  const DONE = ['Done —'];   // the pre-arrival + landing archive phase
  getPhases().forEach((p, pi) => {
    if (DONE.some(d => (p.phase || '').startsWith(d))) setCollapsed(`chk-phase-${pi}`, true);
  });
  setRaw(ARRIVED_SEED_KEY, '1');
}
function saveChecks(s) { set(KEYS.checklist, s); }
function loadDue() { return get(KEYS.due, {}) || {}; }
function loadTags() { return get(KEYS.tags, {}) || {}; }
function saveTags(m) { set(KEYS.tags, m); }
let tagFilter = '';   // one active tag filter (view-only; never mutates data or progress, AND with smart view/search)
// checklist focus controls (reduce the 74-item yearlong list to what's actionable now)
const SMART_VIEWS = ['all', 'today', 'upcoming', 'overdue'];
function smartView() { const v = getRaw(KEYS.checkSmartView, 'all'); return SMART_VIEWS.includes(v) ? v : 'all'; }   // guard a stale/corrupt stored value → never crash the empty-state lookup
function hideDone() { return getRaw(KEYS.checkHideDone, '') === 'on'; }
// p1–p4 priorities (map {id: 1..4}). Migrates the legacy v1 binary-flag array (each flagged id → p1).
function loadPriority() {
  const v2 = get(KEYS.checkPriorityV2, null);
  if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) return v2;     // already on v2
  return migratePriority(get(KEYS.checkPriority, []));                    // legacy flags → { id: 1 }
}
function savePriority(map) { set(KEYS.checkPriorityV2, map); }
function migratePriorityOnce() {
  if (get(KEYS.checkPriorityV2, null) == null) {
    const m = migratePriority(get(KEYS.checkPriority, []));
    if (Object.keys(m).length) set(KEYS.checkPriorityV2, m);   // only write when there were legacy flags
  }
}
function renderCheckTools() {
  const el = $('#checkTools'); if (!el) return;
  const view = smartView(), hd = hideDone();
  const pill = (v, label) => `<button type="button" class="ct-chip ${view === v ? 'on' : ''}" data-view="${v}" aria-pressed="${view === v}">${label}</button>`;
  el.innerHTML = `
    <div class="ct-views" role="group" aria-label="Checklist view">
      ${pill('all', 'All')}${pill('today', 'Today')}${pill('upcoming', 'Upcoming')}${pill('overdue', 'Overdue')}
    </div>
    <button type="button" class="ct-toggle ${hd ? 'on' : ''}" data-hidedone aria-pressed="${hd}">${hd ? '☑' : '☐'} Hide done</button>
    ${tagFilter ? `<button type="button" class="ct-tagpill" data-cleartag style="--h:${tagHue(tagFilter)}" aria-label="Clear tag filter ${esc(tagFilter)}" title="Clear tag filter">🏷 ${esc(tagFilter)} <span aria-hidden="true">✕</span></button>` : ''}`;
  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { const v = b.dataset.view; setRaw(KEYS.checkSmartView, v); renderCheckTools(); renderChecklist(); $(`#checkTools [data-view="${v}"]`)?.focus({ preventScroll: true }); }));   // restore keyboard focus after the rebuild without auto-scrolling
  el.querySelector('[data-hidedone]')?.addEventListener('click', () => { setRaw(KEYS.checkHideDone, hideDone() ? '' : 'on'); renderCheckTools(); renderChecklist(); $('#checkTools [data-hidedone]')?.focus({ preventScroll: true }); });
  el.querySelector('[data-cleartag]')?.addEventListener('click', () => { tagFilter = ''; renderCheckTools(); renderChecklist(); });
}
function saveDue(s) { set(KEYS.due, s); }

// flat list of every checklist item (used by the dashboard for alerts)
export function checklistItems(data) {
  const due = loadDue();
  const out = [];
  getPhases(data).forEach(p => (p.items || []).forEach(it => {
    if (!it.id) return;
    out.push({ ...it, phase: p.phase, effectiveDue: due[it.id] || it.dueBy || '' });
  }));
  // user-added custom items — so progress / due-soon / knownIds account for them too
  loadChecklistCustom().forEach(c => {
    if (!c.id) return;
    out.push({ ...c, phase: c.phase, effectiveDue: due[c.id] || c.dueBy || '', _custom: true });
  });
  return out;
}

// Jump to a checklist item from elsewhere (e.g. clicking a task chip on the calendar): expand its
// phase, drop any smart-view/hide-done filter that could hide it, re-render, then scroll + flash it.
export function revealChecklistItem(id) {
  if (!DATA || !id) return;
  let accId = null;
  getPhases().forEach((p, pi) => { if ((p.items || []).some(it => it.id === id)) accId = `chk-phase-${pi}`; });
  if (!accId && loadChecklistCustom().some(c => c.id === id)) accId = 'chk-phase-mine';
  if (accId) setCollapsed(accId, false);
  setRaw(KEYS.checkSmartView, 'all');                  // a Today/Overdue view could hide it
  if (hideDone()) setRaw(KEYS.checkHideDone, '');      // and so could Hide-done
  renderCheckTools();
  renderChecklist();
  requestAnimationFrame(() => {
    const esc2 = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    const li = $(`#checkPhases .check-item[data-id="${esc2}"]`);
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    li.classList.add('flash');
    setTimeout(() => li.classList.remove('flash'), 1500);
    li.querySelector('input[type=checkbox]')?.focus({ preventScroll: true });
  });
}

// reconcile a phase's items against a saved id order (unknown/new ids append). Pure.
function orderItems(items, savedOrder) {
  if (!savedOrder || !savedOrder.length) return items;
  const map = new Map(items.map(it => [it.id, it]));
  const out = [];
  savedOrder.forEach(id => { if (map.has(id)) { out.push(map.get(id)); map.delete(id); } });
  items.forEach(it => { if (map.has(it.id)) out.push(it); });
  return out;
}
function loadCheckOrder() { return get(KEYS.checkOrder, {}) || {}; }
function saveCheckOrder(o) { set(KEYS.checkOrder, o); }
function loadPhaseMoves() { return get(KEYS.checkMoves, {}) || {}; }
function savePhaseMoves(m) { set(KEYS.checkMoves, m); }

// A drag/keyboard move landed an item in a DIFFERENT group. Custom items genuinely change
// phase (their stored field); baked items (from tips.json) get a display re-home in
// KEYS.checkMoves — dragging one back to its natural phase clears the entry.
function applyPhaseMove(id, toKey) {
  const phases = getPhases();
  const customs = loadChecklistCustom();
  if (customs.some(c => c.id === id)) {
    const label = toKey === 'mine' ? 'My tasks' : (phases[+toKey]?.phase || 'My tasks');
    saveChecklistCustom(customs.map(c => c.id === id ? { ...c, phase: label } : c));
    return;
  }
  const natural = String(phases.findIndex(p => (p.items || []).some(it => it.id === id)));
  const moves = loadPhaseMoves();
  if (toKey === natural) delete moves[id]; else moves[id] = toKey;
  savePhaseMoves(moves);
}

let checkSearchQ = '';   // live search/filter query (view-only; never mutates data, doesn't affect progress)

// ---- toolbar (#checkQuickline) — variant A (quick-line) or B (two pills) ----
// Both variants expose #checkSearch (the live filter input) and #checkAddPhase (the target-group
// select) so the shared filter (checkSearchQ→renderChecklist) and add path (addCheckFromQuickline)
// work identically. The toolbar lives OUTSIDE #checkPhases, so renderChecklist()'s rebuild doesn't
// touch it — it's re-rendered only on mount + settings change.
function checkPhaseOptions() {
  const labels = [...getPhases().map(p => p.phase), 'My tasks'];
  return labels.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
}
function renderCheckToolbar() {
  const host = $('#checkQuickline');
  if (!host) return;
  const opts = checkPhaseOptions();
  if (listCtl() === LISTCTL.PILLS) {
    host.innerHTML = `
      <div class="lc-pills">
        <button type="button" class="lc-pill" id="checkSearchPill" aria-expanded="false" aria-controls="checkSearchWrap"><span class="lc-gx" aria-hidden="true">🔍</span> Search</button>
        <button type="button" class="lc-pill" id="checkAddPill" aria-expanded="false" aria-controls="checkAddWrap"><span class="lc-gx" aria-hidden="true">＋</span> Add</button>
      </div>
      <div class="lc-search-wrap" id="checkSearchWrap">
        <div class="ql-field">
          <span class="ql-icon" aria-hidden="true">🔍</span>
          <input type="search" id="checkSearch" class="ql-input" placeholder="Filter tasks…" aria-label="Filter checklist tasks" autocomplete="off">
          <button type="button" class="lc-miniclose" id="checkSearchClose" aria-label="Close search">✕</button>
        </div>
      </div>
      <div class="ql-reveal lc-add-wrap" id="checkAddWrap"><div>
        <div class="lc-composer">
          <input type="text" id="checkAddText" class="ql-input lc-add-input" placeholder="New task…" aria-label="New task" autocomplete="off">
          <select id="checkAddPhase" class="ql-sel" aria-label="Phase">${opts}</select>
          <button type="button" class="ql-due" id="checkAddDue" aria-label="Set due date for new task">📅 Due</button>
          <button type="button" class="ql-addsuggest lc-add-go" id="checkAddGo">＋ Add</button>
          <button type="button" class="lc-miniclose" id="checkAddClose" aria-label="Cancel">✕</button>
        </div>
      </div></div>`;
  } else {
    host.innerHTML = `
      <div class="ql-field">
        <span class="ql-icon" aria-hidden="true">🔍</span>
        <input type="search" id="checkSearch" class="ql-input" placeholder="Search or add a task…" aria-label="Search or add a checklist task" autocomplete="off">
        <span class="ql-hint" id="checkQlHint" aria-hidden="true">enter ↵ filtering</span>
      </div>
      <div class="ql-reveal" id="checkAddRow"><div>
        <div class="ql-quickadd">
          <span class="ql-lab">add to</span>
          <select id="checkAddPhase" class="ql-sel" aria-label="Phase">${opts}</select>
          <button type="button" class="ql-due" id="checkAddDue" aria-label="Set due date for new task">📅 Due</button>
          <button type="button" class="ql-addsuggest" id="checkAddBtn">＋ Add “<span class="ql-q" id="checkAddQ"></span>"</button>
        </div>
      </div></div>`;
  }
  $('#checkAddPhase').value = 'My tasks';
  wireCheckSearch();
  wireComposerDue();
}

// Wire the active toolbar variant. Re-run on each toolbar render (fresh nodes each time).
function wireCheckSearch() {
  const search = $('#checkSearch');
  if (!search) return;
  // shared filter sync — updates the live query + re-renders the list
  const filterSync = () => {
    checkSearchQ = (search.value || '').trim().toLowerCase();
    renderChecklist();
  };

  if (listCtl() === LISTCTL.PILLS) {
    const searchPill = $('#checkSearchPill'), searchWrap = $('#checkSearchWrap');
    const addPill = $('#checkAddPill'), addWrap = $('#checkAddWrap'), addText = $('#checkAddText');
    const reduce = document.documentElement.dataset.reduceMotion === 'on';
    const openSearch = (open) => {
      searchPill.classList.toggle('is-on', open);
      searchPill.setAttribute('aria-expanded', String(open));
      searchWrap.classList.toggle('is-open', open);
      if (open) { setTimeout(() => search.focus(), reduce ? 0 : 120); }
      else { search.value = ''; checkSearchQ = ''; renderChecklist(); searchPill.focus(); }
    };
    const openAdd = (open) => {
      addPill.classList.toggle('is-on', open);
      addPill.setAttribute('aria-expanded', String(open));
      addWrap.classList.toggle('is-open', open);
      if (open) { setTimeout(() => addText.focus(), reduce ? 0 : 120); }
      else { addText.value = ''; addPill.focus(); }
    };
    searchPill.addEventListener('click', () => openSearch(searchPill.getAttribute('aria-expanded') !== 'true'));
    $('#checkSearchClose')?.addEventListener('click', () => openSearch(false));
    search.addEventListener('input', filterSync);
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); openSearch(false); } });
    addPill.addEventListener('click', () => openAdd(addPill.getAttribute('aria-expanded') !== 'true'));
    $('#checkAddClose')?.addEventListener('click', () => openAdd(false));
    $('#checkAddGo')?.addEventListener('click', () => { if (addText.value.trim()) { addCheckFromComposer(); openAdd(false); } });
    addText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (addText.value.trim()) { addCheckFromComposer(); openAdd(false); } }
      else if (e.key === 'Escape') { e.preventDefault(); openAdd(false); }
    });
    // the no-match empty state's ＋ Add opens the composer pre-filled with the current query
    checkPillsOpenAdd = (prefill) => { addText.value = prefill || ''; openAdd(true); };
  } else {
    checkPillsOpenAdd = null;
    const addRow = $('#checkAddRow'), hint = $('#checkQlHint'), qEcho = $('#checkAddQ');
    const sync = () => {
      const raw = search.value;
      checkSearchQ = raw.trim().toLowerCase();
      const has = raw.trim().length > 0;
      if (qEcho) qEcho.textContent = raw.trim();
      addRow?.classList.toggle('is-open', has);
      renderChecklist();
      // hint reflects what Enter does: filter at rest, add (always commits) once there's a query
      if (hint) hint.textContent = has ? 'enter ↵ = add' : 'enter ↵ filtering';
    };
    search.addEventListener('input', sync);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (search.value.trim()) addCheckFromQuickline(); }
      else if (e.key === 'Escape') { e.preventDefault(); search.value = ''; sync(); }
    });
    $('#checkAddBtn')?.addEventListener('click', () => { if (search.value.trim()) addCheckFromQuickline(); });
  }
}
// In the pills variant, the no-match empty state opens the Add composer pre-filled. Set by wireCheckSearch.
let checkPillsOpenAdd = null;
// Re-render the toolbar (and reset the live filter) when the List-controls setting flips. Wire once.
let checkSettingsWired = false;
function wireCheckSettingsListener() {
  if (checkSettingsWired) return;
  checkSettingsWired = true;
  document.addEventListener('jwh:settings-changed', () => {
    if (!$('#checkQuickline')) return;
    checkSearchQ = '';
    tagFilter = '';
    renderCheckToolbar();
    renderChecklist();
  });
}
// Shared add path: persist a custom task in the selected phase, then re-render + notify. Pure of
// which variant called it. `focusEl` (optional) gets focus after the rebuild.
function commitCheckTask(task, focusEl) {
  task = (task || '').trim();
  if (!task) return;
  const phase = $('#checkAddPhase')?.value || 'My tasks';
  saveChecklistCustom([...loadChecklistCustom(), customItem(task, phase, composerDue, 'cku' + Date.now())]);
  composerDue = '';                  // clear the picked due date after adding
  setComposerDueLabel();
  renderChecklist();                                              // re-render the list
  document.dispatchEvent(new CustomEvent('jwh:data-changed'));    // refresh dashboard teaser/bell
  focusEl?.focus();
}
// Variant A: commit the quick-line query, then clear it (restores the full list + hides the add row).
function addCheckFromQuickline() {
  const search = $('#checkSearch');
  const task = (search?.value || '').trim();
  if (!task) return;
  if (search) search.value = '';
  checkSearchQ = '';
  $('#checkAddRow')?.classList.remove('is-open');
  const hint = $('#checkQlHint'); if (hint) hint.textContent = 'enter ↵ filtering';
  commitCheckTask(task, search);
}
// Variant B: commit the composer text, then clear it.
function addCheckFromComposer() {
  const text = $('#checkAddText');
  const task = (text?.value || '').trim();
  if (!task) return;
  if (text) text.value = '';
  commitCheckTask(task, text);
}

function renderChecklist(today) {
  const phases = getPhases();
  const wrap = $('#checkPhases');
  if (!wrap) return;
  if (!phases.length) { wrap.innerHTML = `<div class="empty">Building the yearlong plan…</div>`; return; }
  const state = loadChecks();
  const due = loadDue();
  const order = loadCheckOrder();
  const now = today || nowISO();
  const prio = loadPriority();
  const hd = hideDone();
  const tags = loadTags();
  const searching = !!checkSearchQ;
  // a search query forces the grouped All view (don't drop into a flat smart view while searching)
  const view = searching ? 'all' : smartView();
  const match = it => !searching || (it.task || '').toLowerCase().includes(checkSearchQ);
  const tagActive = !!tagFilter;
  const matchTag = it => !tagActive || tagsFor(tags, it.id).includes(tagFilter);
  const focusSel = captureCheckFocus();   // preserve keyboard focus across the innerHTML rebuild
  const knownIds = new Set(phases.flatMap(p => (p.items || []).map(it => it.id)));

  if (view !== 'all') {
    // a flat, date-driven smart view (Today / Upcoming / Overdue), undone only, P1-first then soonest
    // undone AND actionable (a requires[]-locked item isn't actionable → don't surface it as "Today")
    const undone = checklistItems(DATA).filter(it => !state[it.id] && !(it.requires || []).some(r => knownIds.has(r) && !state[r])).filter(matchTag);
    const items = filterView(undone, view, now).sort((a, b) => {
      const pa = priorityRank(getLevel(prio, a.id)), pb = priorityRank(getLevel(prio, b.id));   // P1 first … none last
      if (pa !== pb) return pa - pb;
      return (a.effectiveDue || '9999').localeCompare(b.effectiveDue || '9999');
    });
    const renderRow = it => checkItemHTML(it, state, due, now, knownIds, { prio, showPhase: true, tags });
    if (!items.length) {
      const e = { today: ['🎏', 'Nothing due today.', 'You’re clear for today — peek at “Upcoming”.'],
                  upcoming: ['🗓', 'Nothing in the next 7 days.', 'Set due dates on tasks to see them land here.'],
                  overdue: ['✅', 'Nothing overdue.', 'Nice — you’re on top of it.'] }[view];
      const sub = tagActive ? `No "${esc(tagFilter)}" tasks in this view.` : esc(e[2]);
      wrap.innerHTML = `<div class="empty empty-state"><div class="empty-emoji" aria-hidden="true">${e[0]}</div><p class="empty-h">${esc(e[1])}</p><p class="empty-sub">${sub}</p></div>`;
    } else if (view === 'upcoming') {
      // group by day with date subheaders (already date-sorted within filterView/groupByDay)
      wrap.innerHTML = groupByDay(items).map(g =>
        `<div class="check-daygroup"><h3 class="check-dayhead">${esc(fmtShort(g.day))}</h3><ul class="check-list check-soon">${g.items.map(renderRow).join('')}</ul></div>`).join('');
    } else {
      wrap.innerHTML = `<ul class="check-list check-soon">${items.map(renderRow).join('')}</ul>`;
    }
  } else {
    // merge user-added custom items: grouped under their baked phase, or the synthetic "My tasks" group
    const { byPhase, mine } = partitionCustom(
      loadChecklistCustom().map(c => ({ ...c, _custom: true })),
      phases.map(p => p.phase));
    // per-group item lists (baked + custom under their phase), then re-home per drag moves
    let groups = phases.map((p, pi) => ({ key: String(pi), items: [...(p.items || []), ...(byPhase.get(p.phase) || [])] }));
    groups.push({ key: 'mine', items: mine });
    groups = applyPhaseMoves(groups, loadPhaseMoves());
    const groupItems = new Map(groups.map(g => [g.key, g.items]));
    const drag = !hd && !searching && !tagActive;   // drag is meaningless over a hidden/searched/tag-filtered view
    let html = phases.map((p, pi) => {
      const all = groupItems.get(String(pi)) || [];
      const its = orderItems(all, order[pi]).filter(it => it.id).filter(it => !(hd && state[it.id])).filter(match).filter(matchTag);   // it.id guard: never render a cb-undefined row from a malformed item
      if (!its.length) return '';                           // skip a phase fully done/hidden, or with no search match
      // count over the FULL phase (not the hide-done/search-filtered list) so progress math is stable
      const total = all.filter(it => it.id).length;
      const done = all.filter(it => it.id && state[it.id]).length;
      const accId = `chk-phase-${pi}`;
      const phaseName = `${p.phase}${p.window ? ' · ' + p.window : ''}`;
      return `<section class="acc phase-block" data-acc="${esc(accId)}">
        <button type="button" class="acc-head" aria-expanded="true" aria-controls="acc-panel-${esc(accId)}" aria-label="${esc(phaseName)}">
          <span class="acc-chevron" aria-hidden="true">›</span>
          <span class="acc-title">${esc(p.phase)} <span class="window">${esc(p.window || '')}</span></span>
          <span class="acc-count">${esc(String(done))}/${esc(String(total))}</span>
        </button>
        <div class="acc-panel" id="acc-panel-${esc(accId)}" role="region" aria-label="${esc(phaseName)}">
          <div class="acc-inner">
            <ul class="check-list" data-phase="${pi}">${its.map(it => checkItemHTML(it, state, due, now, knownIds, { prio, drag, tags })).join('')}</ul>
          </div>
        </div>
      </section>`;
    }).join('');
    // synthetic "My tasks" group — custom items with phase "My tasks" or an orphan label.
    // Reorder key is the string "mine" (distinct from numeric baked phase indices).
    const mineAll = groupItems.get('mine') || [];
    if (mineAll.length) {
      const all = orderItems(mineAll, order['mine']);
      const its = all.filter(it => !(hd && state[it.id])).filter(match).filter(matchTag);
      if (its.length) {
        const total = mineAll.length;
        const done = mineAll.filter(it => state[it.id]).length;
        html += `<section class="acc phase-block" data-acc="chk-phase-mine">
        <button type="button" class="acc-head" aria-expanded="true" aria-controls="acc-panel-chk-phase-mine" aria-label="My tasks">
          <span class="acc-chevron" aria-hidden="true">›</span>
          <span class="acc-title">My tasks <span class="window"></span></span>
          <span class="acc-count">${esc(String(done))}/${esc(String(total))}</span>
        </button>
        <div class="acc-panel" id="acc-panel-chk-phase-mine" role="region" aria-label="My tasks">
          <div class="acc-inner">
            <ul class="check-list" data-phase="mine">${its.map(it => checkItemHTML(it, state, due, now, knownIds, { prio, drag, tags })).join('')}</ul>
          </div>
        </div>
      </section>`;
      }
    }
    wrap.innerHTML = (!html && (searching || tagActive))
      ? `<div class="empty list-empty">No ${searching
            ? `matches for “${esc(checkSearchQ)}”`
            : `tasks tagged “${esc(tagFilter)}”`}.${searching
            ? `<br><button type="button" class="list-empty-add" id="checkEmptyAdd">＋ Add “<span class="lea-q">${esc(checkSearchQ)}</span>”</button>`
            : ''}</div>`
      : html;
  }
  const prog = $('#checkProgress');
  if (prog) prog.hidden = false;
  wireCheckEmptyAdd();
  wireChecklist();
  if (view === 'all' && !hd && !searching && !tagActive) {   // dnd reorder only in the full grouped, unsearched, unfiltered view (reordering a filtered list is meaningless)
    makeSortableGroup($$('#checkPhases .check-list'), {
      itemSelector: '.check-item', handleSelector: '.dnd-handle', label: 'task',
      idOf: el => el.dataset.id, keyOf: ul => ul.dataset.phase,
      onChange: ({ id, fromKey, toKey, orders }) => {
        if (fromKey !== toKey) applyPhaseMove(id, toKey);
        const o = loadCheckOrder();
        orders.forEach(({ key, ids }) => { o[key] = ids; });
        saveCheckOrder(o);
        if (fromKey !== toKey) renderChecklist();   // group counts changed; captureCheckFocus keeps keyboard focus
      },
    });
  }
  // wire/restore collapse AFTER makeSortable (phase view only); force-expand while searching so matches show
  if (view === 'all') mountAccordion($('#checkPhases'), { forceExpanded: searching });
  if (focusSel) wrap.querySelector(focusSel)?.focus();
  // keep the smart-view pills' active state in sync with the EFFECTIVE view (a search forces 'all')
  $$('#checkTools [data-view]').forEach(b => { const on = b.dataset.view === view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  updateProgress();
}
// identify the focused checklist control so renderChecklist() can restore it after the rebuild
function captureCheckFocus() {
  const a = document.activeElement, wrap = $('#checkPhases');
  if (!a || !wrap || !wrap.contains(a)) return null;
  const esc2 = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
  if (a.classList.contains('acc-head')) {
    const acc = a.closest('.acc');
    if (acc?.dataset.acc) return `.acc[data-acc="${esc2(acc.dataset.acc)}"] .acc-head`;
  }
  if (a.dataset.cid) return `input[data-cid="${esc2(a.dataset.cid)}"]`;
  if (a.dataset.due) return `.ci-due[data-due="${esc2(a.dataset.due)}"]`;
  if (a.dataset.tagbtn) return `.ci-tag[data-tagbtn="${esc2(a.dataset.tagbtn)}"]`;
  if (a.dataset.flag) return `.ci-flag[data-flag="${esc2(a.dataset.flag)}"]`;
  const li = a.closest?.('.check-item');
  if (li && a.classList.contains('dnd-handle')) return `.check-item[data-id="${esc2(li.dataset.id)}"] .dnd-handle`;
  return null;
}
function checkItemHTML(it, state, due, now, knownIds, opts = {}) {
  const id = it.id;
  const checked = state[id] ? 'checked' : '';
  const kind = (it.kind || 'experience').toLowerCase();
  const reqs = it.requires || [];
  // ignore prereqs that don't exist in the checklist (typo / removed item) — else the item locks forever
  const locked = reqs.some(r => (!knownIds || knownIds.has(r)) && !state[r]) && !state[id];
  const eff = due[id] || it.dueBy || '';
  const st = eff ? windowStatus(eff, now) : 'none';
  const dueTag = eff ? `<span class="due-tag ${st}">due ${esc(fmtShort(eff))}</span>` : '';
  const lvl = opts.prio ? getLevel(opts.prio, id) : 0;   // 0 = none, 1–4 = P1–P4
  const flagged = lvl > 0;
  const nextLbl = lvl >= 4 ? 'none' : 'P' + (lvl + 1);   // what a press will set (cyclePriority)
  const phaseTag = opts.showPhase && it.phase ? `<span class="ci-phase">${esc(it.phase)}</span>` : '';
  const conf = (it.confidence || '').toLowerCase();
  const confBadge = (conf === 'low' || conf === 'medium') ? `<span class="badge ${conf}">verify</span>` : '';   // flag estimates (matches Explore/Budget/Packing)
  // every item is store-backed now (defaults seeded from tips.json, additions in the custom store),
  // so all rows get edit + delete — the handlers route to the right store by id
  const del =
    `<button type="button" class="check-edit" data-edit="${esc(id)}" aria-label="Edit ${esc(it.task)}">✎</button>`
    + `<button type="button" class="check-del" data-del="${esc(id)}" aria-label="Remove ${esc(it.task)}">✕</button>`;
  const tagBtns = (opts.tags ? tagsFor(opts.tags, id) : [])
    .map(t => `<button type="button" class="chip-tag" data-tagfilter="${esc(t)}" style="--h:${tagHue(t)}" title="Filter by ${esc(t)}">${esc(t)}</button>`)
    .join('');
  const tagsBlock = tagBtns ? `<span class="ci-tags">${tagBtns}</span>` : '';
  return `
    <li class="check-item ${locked ? 'locked' : ''}${flagged ? ' flagged' : ''}" data-id="${esc(id)}">
      ${opts.drag ? '<button type="button" class="dnd-handle" aria-label="Reorder task" tabindex="0">⠿</button>' : ''}
      <input type="checkbox" id="cb-${esc(id)}" data-cid="${esc(id)}" ${checked} ${locked ? 'disabled' : ''}
             aria-label="${esc(it.task)}">
      <label class="ci-body" for="cb-${esc(id)}">
        <span class="ci-task">${esc(it.task)}<span class="kind-tag kind-${esc(kind)}">${esc(kind)}</span>${phaseTag}${dueTag}${confBadge}${locked ? '<span class="lock">🔒 do prerequisite first</span>' : ''}</span>
        ${it.note ? `<span class="ci-note">${esc(it.note)}</span>` : ''}
        ${srcLinks(it.sources, 'ci-src')}
      </label>
      ${tagsBlock}
      <button type="button" class="ci-flag${lvl ? ' on p' + lvl : ''}" data-flag="${esc(id)}" aria-label="${lvl ? 'Priority P' + lvl + ' — press to set ' + nextLbl : 'Set priority — press to set P1'}" title="Priority — P1 (urgent) → P4, press to cycle">⚑<sub class="ci-flvl" aria-hidden="true">${lvl || ''}</sub></button>
      <button type="button" class="ci-due" data-due="${esc(id)}" title="Set a due date" aria-label="Set due date">📅</button>
      <button type="button" class="ci-tag" data-tagbtn="${esc(id)}" title="Edit tags" aria-label="Edit tags for ${esc(it.task)}">🏷</button>
      ${del}
    </li>`;
}
function wireChecklist() {
  $$('#checkPhases input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    const id = cb.dataset.cid;
    const state = { ...loadChecks() };
    if (cb.checked) state[id] = true; else delete state[id];
    saveChecks(state);
    renderChecklist();                 // re-render so dependent locks update
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
    // keep keyboard focus on the toggled row (or nearest visible) so you can keep arrowing
    const esc2 = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
    ($(`#cb-${esc2}`) || $('#checkPhases input[type=checkbox]'))?.focus({ preventScroll: true });
  }));
  $$('#checkPhases .ci-flag').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.flag, p = loadPriority();
    savePriority(setLevel(p, id, cyclePriority(getLevel(p, id))));   // cycle none→P1→P2→P3→P4→none
    renderChecklist();   // re-render: priority dot + (in Due-soon) the item's position/inclusion
  }));
  $$('#checkPhases .check-del').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    const custom = loadChecklistCustom();
    const isCustom = custom.some(x => x.id === id);
    // deleting a default (store-seeded) item is permanent, so confirm; a user-added task deletes fast
    if (!isCustom) {
      const task = findPhaseItem(id)?.task || 'this task';
      if (!await confirmModal(`Delete “${task}” from the checklist?`, { ok: 'Delete', danger: true })) return;
      deletePhaseItem(id);                                                // drop from the phase store
    } else {
      saveChecklistCustom(custom.filter(x => x.id !== id));               // drop from the custom store
    }
    const m = { ...loadChecks() }; delete m[id]; saveChecks(m);            // clear its checked entry
    const o = loadCheckOrder();                                           // lazy-clean order maps (skip orphaned id)
    Object.keys(o).forEach(k => { o[k] = (o[k] || []).filter(x => x !== id); });
    saveCheckOrder(o);
    renderChecklist();                                                   // re-render the list (no jwh:data-changed→renderChecklist listener)
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));          // refresh the dashboard teaser/bell
  }));
  $$('#checkPhases .check-edit').forEach(b => b.addEventListener('click', () => {
    openCheckEditor(b.dataset.edit);
  }));
  $$('#checkPhases .ci-due').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.due;
    const due = { ...loadDue() };
    const v = await askDate('Due date (blank to clear):', { value: due[id] || '' });
    if (v === null) return;                                  // cancelled
    if (v.trim() === '') delete due[id];
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) due[id] = v.trim();
    else { alertModal('Use a valid date (YYYY-MM-DD).'); return; }
    saveDue(due);
    renderChecklist();                 // direct render refreshes dependency locks now; the dispatch only refreshes the dashboard/bell (no jwh:data-changed→renderChecklist listener exists, so no double-render)
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  }));
  $$('#checkPhases .chip-tag').forEach(btn => btn.addEventListener('click', (e) => {
    e.preventDefault();                                   // chips are not in a label, but be safe
    const t = btn.dataset.tagfilter || '';
    tagFilter = (tagFilter === t) ? '' : t;               // click the active tag again to clear
    renderCheckTools();                                   // refresh the active-tag pill
    renderChecklist();                                    // view-only re-render (no jwh:data-changed)
  }));
  $$('#checkPhases .ci-tag').forEach(btn => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const id = btn.dataset.tagbtn;
    const label = btn.closest('.check-item')?.querySelector('input[type=checkbox]')?.getAttribute('aria-label') || '';
    const map = loadTags();
    const res = await askTags(label, tagsFor(map, id), allTags(map));
    if (res === null) return;                             // cancelled
    saveTags(setTags(map, id, res));                      // mutation → save + dispatch
    renderChecklist();
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  }));
  wireReset();
}
// Inline-edit a custom checklist task. Swaps the .ci-task text for a focused <input>; Enter/blur
// saves (renameById → save → re-render), Esc cancels. A re-render rebuilds innerHTML, so only one
// editor can ever be open at once. Blank/whitespace save is a no-op (lib renameById ignores it).
function openCheckEditor(id) {
  const li = $(`#checkPhases .check-item[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
  if (!li) return;
  const task = li.querySelector('.ci-task');
  if (!task || li.querySelector('.ci-edit-input')) return;
  const custom = loadChecklistCustom();
  const isCustom = custom.some(x => x.id === id);
  const it = isCustom ? custom.find(x => x.id === id) : findPhaseItem(id);   // default items edit in the phase store
  if (!it) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ci-edit-input';
  input.setAttribute('aria-label', 'Edit task');
  input.value = it.task || '';              // .value (DOM property) — safe, no innerHTML of user text
  task.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save, refocus) => {
    if (done) return; done = true;
    if (save) {
      const val = input.value;
      if (isCustom) saveChecklistCustom(renameById(loadChecklistCustom(), id, 'task', val));
      else renamePhaseItem(id, val);
      renderChecklist();                                            // save → close → re-render (matches add/remove)
      document.dispatchEvent(new CustomEvent('jwh:data-changed'));  // refresh dashboard teaser/bell
    } else {
      renderChecklist();                    // cancel → re-render restores the original row (closes the editor)
    }
    if (refocus) {                          // keyboard commit (Enter/Esc): return focus to the row; NOT on blur (would hijack a click)
      const cssId = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
      ($(`#checkPhases .check-edit[data-edit="${cssId}"]`) || $(`#checkPhases input[data-cid="${cssId}"]`))?.focus();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false, true); }
  });
  input.addEventListener('blur', () => commit(true, false));
}
// #checkReset lives OUTSIDE #checkPhases, so renderChecklist() doesn't replace it — wire it ONCE
let resetWired = false;
function wireReset() {
  const reset = $('#checkReset');
  if (!reset || resetWired) return;
  resetWired = true;
  reset.addEventListener('click', async () => {
    if (!await confirmModal('Reset all checkmarks?', { ok: 'Reset', danger: true })) return;
    saveChecks({});
    renderChecklist();
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  });
}
// Search → Add shortcut: the inline ＋ Add “<q>” button in the no-match empty state.
// Re-rendered with the list, so (re)bind each render. In A it commits the query straight
// from #checkSearch; in B it opens the Add composer pre-filled (the search input stays the filter).
function wireCheckEmptyAdd() {
  const btn = $('#checkEmptyAdd');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (listCtl() === LISTCTL.PILLS && checkPillsOpenAdd) checkPillsOpenAdd(checkSearchQ);
    else addCheckFromQuickline();
  });
}
let lastPct = null;
function updateProgress() {
  // count ALL checklist items (not just the ones the current view renders — Due-soon/Hide-done filter)
  const all = checklistItems(DATA);
  if (!all.length) return;
  const checks = loadChecks();
  const done = all.filter(it => checks[it.id]).length;
  const pct = Math.round((done / all.length) * 100);
  const bar = $('#checkBar'), pctEl = $('#checkPct');
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = `${pct}% · ${done}/${all.length}`;
  // peak-end moment: celebrate the transition to 100% (not on first load if already complete)
  if (pct === 100 && lastPct !== null && lastPct < 100) celebrate('🎉 Checklist complete — you’re ready for Japan!');
  lastPct = pct;
}
