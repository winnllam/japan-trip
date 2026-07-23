'use strict';
// Editable calendar — coordinator/state owner for the split view modules
// (calendar-month/-week/-agenda/-editor.js). Merges baked events (tips.json,
// read-only) with user events (localStorage, CRUD). The sidebar Calendars list
// filters by source + category; the cockpit lists book-by deadlines; clicking a
// day opens a popover. Month/Week/Day/Agenda modes; .ics/Google export + import.

import { $, $$, esc } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { parseISO, daysBetween, fmtDate, fmtShort, MONTHS, nowISO } from './lib/dates.js';
import { gcalUrl } from './lib/ics.js';
import { alertModal, confirmModal } from './lib/modal.js';
import { upsertStop, newStop, getPlan } from './lib/dayplan.js';
import { loadPlaces, patchPlace } from './lib/places.js';
import { approxCoord } from './lib/geo.js';
import { dndToast } from './dnd.js';
import { duplicateUserEvent, eventMenuSpec } from './lib/calevents.js';
import { shortcutsEnabled } from './lib/shortcuts.js';
import { customItem, loadChecklistCustom, saveChecklistCustom } from './lib/checklist.js';
import { checklistItems, revealChecklistItem } from './checklist-page.js';
import { parseEvent } from './lib/nlevent.js';
import { openMenu } from './lib/menu.js';
import { prefersReducedMotion } from './motion.js';
import { monthGrid, addMonths, WEEKDAYS_SHORT } from './lib/minical.js';
import { agendaHTML, wireAgenda } from './calendar-agenda.js';
import { weekHTML, dayHTML, wireWeek, weekLabel } from './calendar-week.js';
import { monthHTML, panelHTML, wirePanel, wireCells, wireMonthSelect, wireReschedule, wireEndless, scrollToMonth, scrollToDay, extendWindow, ensureWindowCovers, centerWindowOn, captureAnchor, restoreAnchor } from './calendar-month.js';
import { openModal, openExport, onImport } from './calendar-editor.js';
import { ensureRoute } from './lazyroutes.js';
import { markReveal } from './router.js';
import { birthdaysByDate } from './lib/people.js';
import { recurOccurrences, isRecurring } from './lib/recur.js';
import { askCalendar } from './lib/modal.js';
import { CAL_PALETTE, normalizeCalendars, addCalendar, updateCalendar, removeCalendar, nextColor } from './lib/calendars.js';
export { openModal };   // re-export so calendar-week.js / calendar-month.js keep importing it from here

// Jump helpers: an explicit month/day jump (Prev/Next, Today, quick-add, mini-cal) may target a
// month outside the infinite-scroll window — widen the window to include it (re-render), THEN scroll.
// Without this the target separator/cell wouldn't exist yet and the scroll would silently no-op.
function goMonth(ym, smooth) { if (ensureWindowCovers(ym)) render(); scrollToMonth(ym, smooth); }
function goDay(dayIso, smooth) { if (ensureWindowCovers(String(dayIso).slice(0, 7))) render(); scrollToDay(dayIso, smooth); }

let DATA = null;
export let viewY = 2026, viewM = 5;
let mode = 'month';        // 'month' | 'week' | 'day' | 'agenda'
export let weekAnchor = '2026-06-15';   // any ISO date inside the week the week-view shows
export let TODAY = '2026-06-15';
export let hiddenCats = new Set();
let showTasks = true;             // checklist tasks with a user-set due date appear on the calendar (filterable)
let showUser = true, showBaked = true;   // source "calendars": My events (user) / Researched (baked) visibility
let sideCollapsed = false;               // hide the sidebar (mini-nav + Calendars + cockpit) to give the grid full width
let _taskCache = null;            // per-render memo of task pseudo-events
let popEl = null, popCleanup = null;
let _sidePanelEv = null;          // currently open event id (null = closed)
let _sidePanelTrigger = null;     // element that opened the panel (focus restore)
let _sidePanelCleanup = null;     // remove side-panel document listeners
let _legendTimer = null;          // discriminate legend single-click (toggle) from double-click (isolate)

export const CATS = ['festival', 'fireworks', 'illumination', 'convention', 'seasonal', 'nature', 'holiday', 'food', 'park', 'music', 'personal', 'trip', 'imported'];
export const SPAN_CAP = 10;
// an "evergreen" event is a season-long span (start→end beyond SPAN_CAP): the ongoing/permanent
// layer (teamLab, club residencies, beer gardens). These belong in the month view's "Ongoing this
// season" strip — the week/day band and the agenda exclude them (they'd flood every row for months).
export function isEvergreen(e) { const en = (e.endDate || '').slice(0, 10); if (!en) return false; const span = daysBetween(e.date.slice(0, 10), en); return span != null && span > SPAN_CAP; }

export function loadUser() { return get(KEYS.events, []) || []; }
export function saveUser(a) { set(KEYS.events, a); changed(); }
// One-time: the 'disney' event category was renamed to 'park'. Rewrite any stored event still on
// the old category so it keeps a colour + shows under the right filter. Runs once (flag-guarded),
// writes silently (no changed() dispatch — mount hasn't rendered yet).
function migrateEventCats() {
  if (getRaw(KEYS.catMigrateV1) === '1') return;
  const evs = get(KEYS.events, []) || [];
  let touched = false;
  const next = evs.map(e => (e && e.category === 'disney') ? (touched = true, { ...e, category: 'park' }) : e);
  if (touched) set(KEYS.events, next);
  setRaw(KEYS.catMigrateV1, '1');
}
// A researched seasonal ESTIMATE (vs a fixed plan): explicitly marked "(approx)", a season-long
// span, the 'seasonal' bucket, or a low-confidence guess. Pure of the store — takes a raw event.
const SEASONAL_CAL_ID = 'cal-seasonal';
function isApproxEvent(e) {
  if (!e) return false;
  return /\(approx\)/i.test(e.title || '')
    || isEvergreen(e)
    || (e.category || 'personal') === 'seasonal'
    || String(e.confidence || '').toLowerCase() === 'low';
}
// One-time: gather those estimates (foliage/illumination markers, etc.) into ONE "Seasonal (approx)"
// calendar so they toggle as a single group instead of scattering across the type filters. Fixed
// plans (flights, Hakone nights, national holidays, Halloween) are left on their own categories.
// Runs after the disney→park pass, before the panel/colours are built. Flag-guarded, writes silently.
function ensureSeasonalCal() {
  if (!customCals().some(c => c.id === SEASONAL_CAL_ID)) {
    set(KEYS.calendars, addCalendar(customCals(), { name: 'Seasonal (approx)', color: '#b8541a' }, SEASONAL_CAL_ID));
  }
}
function migrateSeasonalCalendar() {
  if (getRaw(KEYS.seasonalCalMig) === '1') return;
  const evs = get(KEYS.events, []) || [];
  if (evs.some(isApproxEvent)) {
    ensureSeasonalCal();
    // GROUP (parent), don't retype: the event keeps its type category (colour + "Filter by type");
    // parent points at the Seasonal calendar so its toggle shows/hides the whole group.
    set(KEYS.events, evs.map(e => isApproxEvent(e) ? { ...e, parent: SEASONAL_CAL_ID } : e));
  }
  setRaw(KEYS.seasonalCalMig, '1');
}
// v1 of the seasonal migration OVERWROTE category with the calendar id (so events all showed the one
// calendar colour). Reverse it: restore each event's real TYPE (so it colours by type + rejoins the
// type filters) and move the grouping to `parent`. Original types come from the baked ids; anything
// else falls back to 'seasonal'. One-time, after ensureSeasonalCal so the calendar exists.
const APPROX_TYPE = {
  'trip-autumn-food': 'seasonal', 'trip-koyo-nikko': 'nature', 'trip-illum': 'illumination',
  'trip-kawaguchiko': 'nature', 'trip-meiji-yabusame': 'festival', 'trip-ramen-show': 'food',
  'trip-disney-xmas': 'park', 'trip-hakone-koyo': 'nature', 'trip-tokyo-parks': 'nature',
};
function migrateSeasonalTypes() {
  if (getRaw(KEYS.seasonalTypeMig) === '1') return;
  const evs = get(KEYS.events, []) || [];
  let touched = false;
  const next = evs.map(e => {
    if (!e || e.category !== SEASONAL_CAL_ID) return e;
    touched = true;
    return { ...e, category: APPROX_TYPE[e.id] || 'seasonal', parent: SEASONAL_CAL_ID };
  });
  if (touched) { ensureSeasonalCal(); set(KEYS.events, next); }
  setRaw(KEYS.seasonalTypeMig, '1');
}
export function goAgenda() { mode = 'agenda'; render(); }
function changed() { document.dispatchEvent(new CustomEvent('jwh:data-changed')); }

function loadOverrides() { return get(KEYS.eventOverrides, {}) || {}; }
function saveOverrides(o) { set(KEYS.eventOverrides, o); changed(); }
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// shift endDate by the same delta the start moved, so a multi-day event keeps its span
function shiftEnd(oldStart, newStart, endDate) {
  if (!endDate) return '';
  const delta = daysBetween(oldStart.slice(0, 10), newStart);
  return delta == null ? '' : addDaysISO(endDate.slice(0, 10), delta);
}
function bakedEvents() {
  const ov = loadOverrides();
  return (DATA.calendar || []).map(e => ov[e.id]
    ? { ...e, date: ov[e.id], endDate: shiftEnd(e.date, ov[e.id], e.endDate), source: 'baked', moved: true }
    : { ...e, source: 'baked' });
}
let _evCache = null;   // memoized for one render pass (eventsOn is called ~once per day cell)
export function allEvents() {
  if (_evCache) return _evCache;
  const user = loadUser().map(e => ({ ...e, source: 'user' }));
  const copied = new Set(user.map(e => e.copyOf).filter(Boolean));   // "Copy to my events" takes over the baked original — hide it to avoid a duplicate chip
  const areaOv = get(KEYS.evArea, {}) || {};   // user-edited locations (✎) — works for baked AND user events
  const hidden = new Set(get(KEYS.evHidden, []) || []);   // baked events the user deleted (tips.json itself is immutable)
  const titleOv = get(KEYS.evTitle, {}) || {};   // dblclick renames (side panel) — baked events only; user events edit their own store
  _evCache = [...bakedEvents().filter(e => !copied.has(e.id) && !hidden.has(e.id)), ...user]
    .filter(e => parseISO(e.date))
    .map(e => (typeof areaOv[e.id] === 'string' && areaOv[e.id]) ? { ...e, area: areaOv[e.id] } : e)
    .map(e => (e.source === 'baked' && typeof titleOv[e.id] === 'string' && titleOv[e.id]) ? { ...e, title: titleOv[e.id], renamed: true } : e);
  return _evCache;
}
// Invalidate the memo on ANY mutation, order-independently: this listener is registered at
// module-eval (import) time — before any mount() — so it runs before dashboard/calendar
// re-read allEvents(), regardless of listener registration order. (Every event writer —
// calendar saveUser/saveOverrides, map pushEvent/removeEvent, plan, deletePlace — dispatches
// jwh:data-changed.) render() still nulls it too, as belt-and-suspenders.
document.addEventListener('jwh:data-changed', () => { _evCache = null; _taskCache = null; });

// ---- checklist tasks as a display-only calendar layer ----
// Every OPEN checklist item with a due date appears — the date you set (KEYS.due, via the 📅) OR
// the built-in `dueBy` estimate. checklistItems() already resolves effectiveDue = your date ?? the
// baked estimate. (The notifications bell still fires on curated deadlines + dates you set only —
// this display layer is broader on purpose, since a short trip has few baked dates, not a flood.)
// Tasks are NOT real events: they carry data-task (not data-ev) so drag/reschedule/export ignore
// them; clicking jumps to the checklist. Memoized per render; invalidated with _evCache.
export function allTasks() {
  if (_taskCache) return _taskCache;
  if (!showTasks) return (_taskCache = []);
  const done = get(KEYS.checklist, {}) || {};
  _taskCache = checklistItems(DATA)
    .filter(it => it.effectiveDue && !done[it.id] && parseISO(it.effectiveDue))
    .map(it => ({ taskId: it.id, title: it.task, date: it.effectiveDue }));
  return _taskCache;
}
export function tasksOn(iso) { return showTasks ? allTasks().filter(t => t.date.slice(0, 10) === iso) : []; }
export function taskChipHTML(t) {
  return `<button type="button" class="cal-chip cal-task" data-task="${esc(t.taskId)}" title="Checklist task due — ${esc(t.title)}"><span class="cc-t">☑ ${esc(t.title)}</span></button>`;
}
// jump from a calendar task chip to the checklist item it represents
export function gotoTask(taskId) {
  dismissPopover();
  // markReveal() tells the router to skip its scroll-to-top reset for THIS nav, so revealChecklistItem's
  // scroll below isn't clobbered by the transition's late reset (which lands after this fixed delay).
  if (location.hash !== '#/checklist') { markReveal(); location.hash = '#/checklist'; }
  // let the route transition swap views before scrolling/focusing the target row
  setTimeout(() => revealChecklistItem(taskId), 60);
}

// ---- Birthdays as a display-only calendar layer (auto from the People page) ----
// Like tasks: not real events (no data-ev, so drag/reschedule/export ignore them). Toggled by the
// 'birthday' category in the Calendars panel; memoized per render, invalidated on jwh:data-changed.
let _bdayCache = null;
document.addEventListener('jwh:data-changed', () => { _bdayCache = null; });
function bdayMap() {
  if (_bdayCache) return _bdayCache;
  // span the whole endless range (a couple of years) so every year's birthday shows
  const years = [...new Set(allEvents().map(e => +String(e.date).slice(0, 4)).filter(Boolean))];
  const nowY = +nowISO().slice(0, 4);
  const y0 = Math.min(nowY, ...years), y1 = Math.max(nowY, ...years);
  return (_bdayCache = birthdaysByDate(get(KEYS.people, []) || [], y0, y1));
}
export function birthdaysOn(iso) {
  if (hiddenCats.has('birthday')) return [];
  return bdayMap().get(String(iso).slice(0, 10)) || [];
}
export function hasBirthdays() { return bdayMap().size > 0; }
export function birthdayChipHTML(b) {
  return `<button type="button" class="cal-chip cat-birthday bday" data-person="${esc(b.id)}" title="${esc(b.name)}’s birthday"><span class="cc-t">🎂 ${esc(b.name)}</span></button>`;
}
// jump from a birthday chip to that person on the People page (mirrors gotoTask)
export function gotoPerson(id) {
  dismissPopover();
  if (location.hash !== '#/people') location.hash = '#/people';
  if (!id) return;
  ensureRoute('people').then(() => requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('jwh:people-open', { detail: { id } }))));
}

// ---- user-created calendars (a calendar id doubles as an event category) ----
export function customCals() { return normalizeCalendars(get(KEYS.calendars, [])); }
function calMeta(id) { return customCals().find(c => c.id === id) || null; }
// display label for any category: a custom calendar's name, else the raw category id
export function catLabel(cat) { return calMeta(cat)?.name || cat; }
// Inject per-calendar --chip-cat rules so custom-category chips/swatches pick up their colour through
// the SAME machinery as the built-in cat-* tokens (CSP allows <style> under style-src 'unsafe-inline').
export function applyCalColors() {
  let el = document.getElementById('calCustomColors');
  if (!el) { el = document.createElement('style'); el.id = 'calCustomColors'; document.head.appendChild(el); }
  const escId = (id) => (window.CSS && CSS.escape) ? CSS.escape(id) : id;   // ids are already slug-validated in normalizeCalendars; escape too as defence-in-depth
  el.textContent = customCals().map(c =>
    `:is(.cal-chip,.cal-bar,.cal-opill,.calrow,.cp-cd,.sp-dot,.pop-sw).cat-${escId(c.id)}{--chip-cat:${c.color};}`).join('');
}

export function catOf(e) { return e.category || 'personal'; }
// An event's TYPE (category → colour + "Filter by type") is independent of its optional grouping
// CALENDAR (parent → a "Your calendars" toggle like "Seasonal (approx)"). Both dimensions share the
// hiddenCats set (type ids and calendar ids are disjoint); an event hides if EITHER is toggled off.
export function parentOf(e) { return e && e.parent ? e.parent : ''; }
export function visible(e) {
  if (hiddenCats.has(catOf(e))) return false;
  const par = parentOf(e);
  if (par && hiddenCats.has(par)) return false;   // its grouping calendar (parent) is hidden
  const isUser = e.source === 'user';   // baked events (incl. overrides) are 'baked'; user + imported .ics are 'user'
  if (isUser && !showUser) return false;
  if (!isUser && !showBaked) return false;
  return true;
}

function eventsOn(iso, capLong = false) {
  return allEvents().filter(e => {
    if (!visible(e)) return false;
    return recurOccurrences(e, iso, iso).some(occ => {   // recurring events match on any occurrence date
      const s = occ.date, en = (occ.endDate && parseISO(occ.endDate)) ? occ.endDate.slice(0, 10) : '';
      if (!en) return s === iso;
      if (capLong) { const span = daysBetween(s, en); if (span !== null && span > SPAN_CAP) return s === iso; }
      return iso >= s && iso <= en;
    });
  });
}

let _calMounted = false;
export function mountCalendar(data, today) {
  if (_calMounted) return; _calMounted = true;   // mount-once: document/window listeners below must not double-register
  DATA = data;
  TODAY = today || nowISO();
  migrateEventCats();          // disney → park (once), before any events are read/rendered
  migrateSeasonalCalendar();   // group approx/seasonal estimates under the Seasonal calendar (once)
  migrateSeasonalTypes();      // v1 fix: restore real types on already-grouped events (once)
  const cf = get(KEYS.calFilters, []); hiddenCats = new Set(Array.isArray(cf) ? cf : []);   // guard a corrupted (non-array) stored value
  showTasks = getRaw(KEYS.calShowTasks, '') !== 'off';  // on by default; the ☑ Tasks toggle persists your choice
  showUser = showBaked = true;   // the My-events/Researched source split was retired (all events are user events now) — visible() keeps both on
  const sb = getRaw(KEYS.calSidebar, '');
  sideCollapsed = sb === 'collapsed' ? true : sb === 'expanded' ? false : window.matchMedia('(max-width: 820px)').matches;   // sidebar visibility persists; no stored pref → collapsed on mobile
  const t = parseISO(TODAY);
  if (t) { viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); }
  weekAnchor = TODAY;
  // the 7-column month grid is cramped on a phone — open in the agenda (list) view on narrow
  // screens. The ☰ view toggle still switches to month/week; desktop is unchanged. Set once at
  // mount (like the sidebar-collapsed default above), so an in-session toggle sticks.
  if (window.matchMedia('(max-width: 700px)').matches) mode = 'agenda';
  wireToolbar();
  wireQuickAdd();
  wireCmdPop();
  applyCalColors();   // inject custom-calendar chip colours before the first render
  buildCalendars();
  applySidebar();   // apply the persisted collapsed/expanded state to the layout + toggle button
  render();
  document.addEventListener('jwh:route', (e) => { if (e.detail?.route !== 'calendar') { closeSidePanel(); dismissPopover(); } });   // the side panel + day popover are portaled to <body> (fixed) — close them when leaving the calendar so they don't hang over other pages
  window.addEventListener('resize', () => requestAnimationFrame(alignRail));   // toolbar can wrap to two rows — keep --cal-tb-h (sticky-chrome offset) exact
  // EF3: while the calendar is hidden, a data change marks it dirty instead of re-rendering
  // the whole month grid (render on next entry). The _evCache invalidation listener above is
  // separate and stays unconditional — other pages read allEvents() fresh.
  document.addEventListener('jwh:data-changed', () => {
    if (document.getElementById('view-calendar')?.classList.contains('is-active')) render();
    else _calDirty = true;
  });
  document.addEventListener('jwh:cal-quickadd', (e) => { const d = e.detail?.date; if (d) { if (location.hash !== '#/calendar') location.hash = '#/calendar'; openModal(null, d); } });   // long-press a day → add event
  // People drawer "📅 event" → open that event's side panel (cross-module via event, no import)
  document.addEventListener('jwh:cal-showevent', (e) => {
    const id = e.detail?.id; if (!id) return;
    const ev = allEvents().find(x => x.id === id);
    if (!ev) { dndToast('That event no longer exists.'); return; }
    if (location.hash !== '#/calendar') location.hash = '#/calendar';
    requestAnimationFrame(() => openSidePanel(ev));
  });
  document.addEventListener('keydown', onCalKeydown);      // Notion-style: ←→↑↓ move days, Enter open, − remove, t today, n new
  // right-click an event → context menu (delegated on document: the day popover lives on <body>,
  // outside #calView, so a view-scoped listener would miss its .pop-open events).
  document.addEventListener('contextmenu', (e) => {
    const items = getEventMenu(e.target);
    if (!items) return;                       // not an event → native menu
    e.preventDefault();
    openMenu(items, e.clientX, e.clientY, { label: 'Event actions' });
  });
  // keyboard: ContextMenu key / Shift+F10 on a focused event trigger opens the menu anchored to it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const items = getEventMenu(document.activeElement);
    if (!items) return;                       // focus isn't on an event trigger (so inputs are naturally excluded)
    e.preventDefault();
    openMenu(items, 0, 0, { anchor: document.activeElement, label: 'Event actions' });
  });
  // re-render the week view when crossing the mobile breakpoint (grid ↔ vertical list)
  window.matchMedia('(max-width: 700px)').addEventListener('change', () => { if (mode === 'week') render(); });
}

// show/hide the left side panels; the toolbar toggle IS the reachability (no floating popover)
function applySidebar() {
  document.querySelector('.cal-layout')?.classList.toggle('side-collapsed', sideCollapsed);
  if (sideCollapsed && document.getElementById('calSidebar')?.contains(document.activeElement)) $('#calSideToggle')?.focus();   // don't strand focus inside a display:none sidebar
  const btn = $('#calSideToggle');
  if (!btn) return;
  const lbl = sideCollapsed ? 'Show side panels' : 'Hide side panels';
  btn.setAttribute('aria-expanded', String(!sideCollapsed));
  btn.setAttribute('aria-label', lbl); btn.title = lbl;
  btn.textContent = sideCollapsed ? '⊞' : '⊟';
}

function wireToolbar() {
  $('#calSideToggle')?.addEventListener('click', () => { sideCollapsed = !sideCollapsed; setRaw(KEYS.calSidebar, sideCollapsed ? 'collapsed' : 'expanded'); applySidebar(); });
  // compact: Import/Export/Google collapse into a ⋯ menu (items just trigger the hidden buttons, so
  // their existing wiring — file input, export dialog, google sync — is untouched)
  $('#calMore')?.addEventListener('click', () => {
    const g = $('#calGoogle');   // disabled when Google sync isn't configured — .click() would be a silent no-op
    openMenu([
      { label: 'Import .ics…', run: () => $('#calImport')?.click() },
      { label: 'Export…', run: () => $('#calExport')?.click() },
      ...(g && !g.disabled ? [{ label: 'Google…', run: () => g.click() }] : []),
    ], 0, 0, { anchor: $('#calMore'), label: 'More calendar actions' });
  });
  $('#calPrev')?.addEventListener('click', () => shift(-1));
  $('#calNext')?.addEventListener('click', () => shift(1));
  $('#calToday')?.addEventListener('click', () => {
    const t = parseISO(TODAY); weekAnchor = TODAY;
    if (mode === 'month') { goDay(TODAY, !prefersReducedMotion()); return; }   // endless: navigate by scroll
    viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); render();
  });
  $('#calModeMonth')?.addEventListener('click', () => { mode = 'month'; render(); });
  $('#calModeWeek')?.addEventListener('click', () => { mode = 'week'; render(); });
  $('#calModeDay')?.addEventListener('click', () => { mode = 'day'; render(); });
  $('#calModeAgenda')?.addEventListener('click', () => { mode = 'agenda'; render(); });
  $('#calAdd')?.addEventListener('click', () => openModal(null, TODAY));
  $('#calExport')?.addEventListener('click', openExport);
  $('#calImportBtn')?.addEventListener('click', () => $('#calImport').click());
  $('#calImport')?.addEventListener('change', onImport);
}
// Natural-language quick-add (Fantastical-style): type "Ramen with Kenji Jul 3 7pm" → an event.
// Creates a USER event via saveUser (device-local); a live hint previews the parsed date/time.
function wireQuickAdd() {
  const form = $('#calQuickAdd'), input = $('#calQuickInput'), hint = $('#calQuickHint');
  if (!form || !input || form.dataset.wired) return;
  form.dataset.wired = '1';
  input.addEventListener('input', () => {
    const v = input.value.trim();
    const p = v ? parseEvent(v, TODAY) : null;
    hint.textContent = (p && p.title) ? `→ ${fmtShort(p.date)}${p.time ? ' · ' + p.time : ''}` : '';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    const p = parseEvent(v, TODAY);
    const title = p.title || v;
    const t = parseISO(p.date);
    if (t) { viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); mode = 'month'; }
    const id = 'u' + Date.now();
    saveUser([...loadUser(), { id, title, date: p.date, endDate: '', time: p.time || '', category: 'personal', note: '' }]);
    input.value = ''; hint.textContent = '';
    dndToast(`Added: ${title} · ${fmtShort(p.date)}`);
    input.focus({ preventScroll: true });                                       // a bare focus() yanked the endless grid back to the top
    requestAnimationFrame(() => goDay(p.date, !prefersReducedMotion()));  // land on the new event
  });
}
// Quick-add + search live in a popover (owner: keep the toolbar row clear for calendar space).
// The inputs keep their IDs, so wireQuickAdd()/mountEventSearch() are untouched — this only owns
// open/close/placement. Opened by the 🔍 toolbar button or the `f` key (‘/’ is the global palette).
let _openCmdPop = null;
function wireCmdPop() {
  const btn = $('#calCmd'), pop = $('#calCmdPop');
  if (!btn || !pop || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const place = () => {
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth || 340, h = pop.offsetHeight || 0;
    pop.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + 'px';   // below the button, but never past the viewport bottom (short screens)
    pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';   // right-align to the button, clamp to the viewport
  };
  const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); place(); $('#calQuickInput')?.focus({ preventScroll: true }); };
  const close = (refocus) => { if (pop.hidden) return; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus({ preventScroll: true }); };
  btn.addEventListener('click', () => pop.hidden ? open() : close(true));
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } });   // stopPropagation: don't also trip the global ? / palette Esc handlers
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !e.target.closest('#calCmdPop, #calCmd')) close(false); });
  pop.addEventListener('click', (e) => { if (e.target.closest('[data-go], [data-plan]')) close(false); });   // picking a search result navigates — get out of the way
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  document.addEventListener('jwh:route', () => close(false));   // never persist an open popover across a route change
  _openCmdPop = open;
}
function shift(d) {
  if (mode === 'week') { weekAnchor = addDaysISO(weekAnchor, 7 * d); render(); return; }   // week mode steps by a week
  if (mode === 'day') { weekAnchor = addDaysISO(weekAnchor, d); render(); return; }          // day mode steps by a day
  // endless month: ‹ › scroll to the neighbouring month's separator; the scroll handler updates the label
  let y = viewY, m = viewM + d; while (m < 0) { m += 12; y--; } while (m > 11) { m -= 12; y++; }
  goMonth(`${y}-${String(m + 1).padStart(2, '0')}`, !prefersReducedMotion());
}

// jump the month view to a given ISO date (used by event search)
export function goToDate(iso) {
  const t = parseISO(iso); if (!t) return;
  viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); mode = 'month'; render();
}

// ---- the "Calendars" sidebar list: the ☑ Tasks toggle + any custom calendars up top, then a
// collapsible "Filter by type" group of category toggles (nature/holiday/…) that filter your
// events. The old My-events/Researched source split was retired — every event is a user event
// now, so those two source toggles were removed. Category toggles drive hiddenCats. ----
function buildCalendars() {
  const el = $('#calCalendars');
  if (!el) return;
  const resOpen = getRaw(KEYS.calResOpen, 'open') !== 'closed';   // type filters default open (they filter your own events now)
  // allCats drives the aggregate ops (isolate / Hide all) — always includes 'birthday' (a togglable
  // calendar even though it's a People-derived layer, not in allEvents()). present is the RENDER list
  // for the Researched group only (birthday shows under Your calendars, so it's excluded there).
  const cals = customCals();
  // allCats drives the aggregate ops: every category present + every custom calendar (togglable
  // even with no events yet, so not always in allEvents()).
  const allCats = [...new Set([...allEvents().map(catOf), ...cals.map(c => c.id)])].sort();
  const present = allCats.filter(c => !cals.some(x => x.id === c));   // Researched render list: researched categories only
  // btnCls (e.g. cat-festival) goes on the row so the category :is() rule sets --chip-cat, which the
  // child swatch inherits; swCls (sw-user/sw-baked/sw-task) colours the source/task swatches directly.
  const row = (attrs, btnCls, swCls, name, on) =>
    `<button class="calrow${btnCls ? ' ' + btnCls : ''}${on ? '' : ' off'}" role="switch" aria-checked="${on}" type="button" ${attrs}><span class="cal-sw${swCls ? ' ' + swCls : ''}"></span><span class="cal-nm">${name}</span></button>`;
  // a custom-calendar row = the toggle row + a hover ✎ edit button (siblings — can't nest a <button>)
  const calRow = (c) => `<div class="calrow-wrap">`
    + row(`data-cat="${esc(c.id)}" title="Click to toggle · double-click to show only this"`, `cat-${esc(c.id)}`, '', esc(c.name), !hiddenCats.has(c.id))
    + `<button type="button" class="cal-edit" data-editcal="${esc(c.id)}" aria-label="Edit ${esc(c.name)}">✎</button></div>`;
  el.innerHTML =
    `<div class="cal-cals-head"><span>Calendars</span><button class="cal-cals-all" id="calAll" type="button">${hiddenCats.size ? 'Show all' : 'Hide all'}</button></div>`
    + row('id="lgTasks"', '', 'sw-task', '☑ Tasks', showTasks)
    + cals.map(calRow).join('')
    + `<button type="button" class="cal-newcal" id="calNew">＋ New calendar</button>`
    + (present.length
        ? `<button class="cal-grp-head" id="calResHead" type="button" aria-expanded="${resOpen}" aria-controls="calResBody"><span class="cal-grp-chev" aria-hidden="true">${resOpen ? '▾' : '▸'}</span>Filter by type</button>`
          + `<div class="cal-grp-body" id="calResBody"${resOpen ? '' : ' hidden'}>`
          + present.map(c => row(`data-cat="${esc(c)}" title="Click to toggle · double-click or Shift+Enter to show only ${esc(c)}"`, `cat-${esc(c)}`, '', esc(c), !hiddenCats.has(c))).join('')
          + `</div>`
        : '');

  const focusRow = (sel) => $(sel)?.focus({ preventScroll: true });   // restore keyboard focus across the rebuild
  const catSel = (c) => `#calCalendars .calrow[data-cat="${window.CSS ? CSS.escape(c) : c}"]`;
  // "show only this" (or un-isolate back to all if it's already the only one shown) — shared by
  // double-click AND Shift+activation (Shift+click / Shift+Enter, the keyboard path to isolate).
  const calIds = new Set(cals.map(c => c.id));
  const isolate = (c) => {
    if (_legendTimer) { clearTimeout(_legendTimer); _legendTimer = null; }
    // isolate WITHIN one dimension — grouping calendars vs types — so "show only this type" never
    // also hides a type via a calendar's parent, and vice-versa (they share hiddenCats but are disjoint)
    const universe = calIds.has(c) ? [...calIds] : present;
    const others = universe.filter(x => x !== c);
    const isolated = !hiddenCats.has(c) && others.every(x => hiddenCats.has(x));
    universe.forEach(x => hiddenCats.delete(x));   // clear only this dimension's hides
    if (!isolated) others.forEach(x => hiddenCats.add(x));   // isolate to c; if already isolated, un-isolate
    persistFilters(); buildCalendars(); render(); focusRow(catSel(c));
  };
  $$('#calCalendars .calrow[data-cat]').forEach(b => {
    // single click toggles this category; double click / Shift+activate isolates it. A 200ms timer
    // lets the dblclick cancel the pending single-click toggle so the two don't fight.
    b.addEventListener('click', (e) => {
      if (e.shiftKey) { isolate(b.dataset.cat); return; }     // Enter/Space fire click with shiftKey intact
      if (_legendTimer) { clearTimeout(_legendTimer); _legendTimer = null; return; }
      const c = b.dataset.cat;
      _legendTimer = setTimeout(() => {
        _legendTimer = null;
        if (hiddenCats.has(c)) hiddenCats.delete(c); else hiddenCats.add(c);
        persistFilters(); buildCalendars(); render(); focusRow(catSel(c));
      }, 200);
    });
    b.addEventListener('dblclick', () => isolate(b.dataset.cat));
  });
  $('#calResHead')?.addEventListener('click', () => { setRaw(KEYS.calResOpen, resOpen ? 'closed' : 'open'); buildCalendars(); focusRow('#calResHead'); });   // collapse/expand the type-filter group (no re-render — visibility unchanged)
  $('#lgTasks')?.addEventListener('click', () => {
    showTasks = !showTasks; setRaw(KEYS.calShowTasks, showTasks ? 'on' : 'off'); _taskCache = null;
    buildCalendars(); render(); focusRow('#lgTasks');
  });
  $('#calAll')?.addEventListener('click', () => {
    if (hiddenCats.size) hiddenCats.clear(); else allCats.forEach(c => hiddenCats.add(c));   // Hide all covers Birthdays + custom calendars too
    persistFilters(); buildCalendars(); render(); focusRow('#calAll');
  });
  // create / edit / delete custom calendars (persist → recolour → rebuild panel + grid)
  const persistCals = (list) => { set(KEYS.calendars, list); applyCalColors(); buildCalendars(); render(); };
  $('#calNew')?.addEventListener('click', async () => {
    const r = await askCalendar(CAL_PALETTE, null);
    if (!r || r.remove || !r.name) return;
    const id = 'cal-' + Date.now().toString(36);
    persistCals(addCalendar(customCals(), { name: r.name, color: r.color }, id));
    dndToast(`Calendar “${r.name}” created — pick it in the event editor`);
  });
  $$('#calCalendars .cal-edit').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const cal = customCals().find(c => c.id === b.dataset.editcal); if (!cal) return;
    const r = await askCalendar(CAL_PALETTE, cal);
    if (!r) return;
    if (r.remove) {
      if (!await confirmModal(`Delete “${cal.name}”? Its events keep their date + type — they’re just no longer grouped.`, { ok: 'Delete', danger: true })) return;
      const reassigned = loadUser().map(e => {
        if (e.parent === cal.id) { const { parent, ...rest } = e; return rest; }   // ungroup — keep the event + its type category
        if (e.category === cal.id) return { ...e, category: 'personal' };          // legacy: a cal-id-as-category event → personal
        return e;
      });
      saveUser(reassigned);   // no orphaned calendar refs left behind (dispatches jwh:data-changed)
      persistCals(removeCalendar(customCals(), cal.id));
      dndToast(`Calendar “${cal.name}” deleted`);
      return;
    }
    persistCals(updateCalendar(customCals(), cal.id, { name: r.name, color: r.color }));
  }));
}
function persistFilters() { set(KEYS.calFilters, [...hiddenCats]); }

// ---- Notion-style keyboard shortcuts (active only on #/calendar) ----
// remove the focused/open event: user events delete; baked events hide (researched
// suggestions can't be deleted, only hidden from the merged stream).
function removeEventByKey(id) {
  const ev = allEvents().find(x => x.id === id);
  if (!ev) return;
  if (ev.source === 'user') deleteUserEvent(id);            // → saveUser → data-changed → render + side-panel auto-close
  else hideBakedEvent(id, ev.title);                        // baked → hide from the merged stream (undoable via the toast)
}
// "Delete" for a researched event: tips.json is immutable, so hide its id from allEvents()
// (calendar, map, dashboard all re-derive). The toast offers Undo.
function hideBakedEvent(id, title) {
  set(KEYS.evHidden, [...new Set([...(get(KEYS.evHidden, []) || []), id])]);
  document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  closeSidePanel();
  dndToast(`Deleted “${title}”`, () => {
    set(KEYS.evHidden, (get(KEYS.evHidden, []) || []).filter(x => x !== id));
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  });
}
function onCalKeydown(e) {
  if (location.hash !== '#/calendar') return;
  // any open dialog (event editor/app/date-picker) owns the keyboard — EXCEPT our own event
  // side panel: it's aria-modal too, and it's exactly where −/Del/Backspace should delete the
  // open event (this guard used to kill the panel path, so Backspace "never worked")
  const sp = document.getElementById('calSidePanel');
  const inSidePanel = !!(sp && !sp.hidden && sp.classList.contains('is-open'));   // the popover is role=dialog, not aria-modal — detect it directly
  const modal = document.querySelector('[aria-modal="true"]');                    // a genuine modal (event editor / day popover)
  if (modal && !inSidePanel) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;           // leave combos to the global/browser handlers
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
  if (!shortcutsEnabled() && e.key.length === 1) return;   // WCAG 2.1.4: single-char shortcuts (t/n/f/m/w/d/a/−) off; arrows + Del/Backspace stay

  if (e.key === '-' || e.key === 'Delete' || e.key === 'Backspace') {
    const chip = e.target.closest?.('.cal-chip[data-ev], .cal-bar[data-ev], .agenda-row[data-ev], .wkl-ev[data-ev], .wk-chip[data-ev], .wk-bar[data-ev], .wk2-ev[data-ev]');
    const id = _sidePanelEv || chip?.dataset.ev;
    if (id) { e.preventDefault(); removeEventByKey(id); }
    return;
  }
  if (inSidePanel) return;   // with the panel open, ONLY the remove keys apply — arrows/n/t stay out of a dialog
  if (e.key === 't' || e.key === 'T') {
    e.preventDefault(); weekAnchor = TODAY;
    if (mode !== 'month') { const t = parseISO(TODAY); if (t) { viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); } mode = 'month'; render(); }
    goDay(TODAY, !prefersReducedMotion());
    $(`#calView .cal-date[data-day="${TODAY}"]`)?.focus({ preventScroll: true }); return;
  }
  if (e.key === 'n' || e.key === 'N') {
    // fall back to the shown day in week/day mode (weekAnchor), not TODAY — after a mode switch, render()
    // drops focus to <body> so there's no focused cell to read.
    e.preventDefault(); const day = e.target.closest?.('.cal-cell[data-day], .wk2-dayhd[data-day], .wk2-add[data-day]')?.dataset.day || ((mode === 'day' || mode === 'week') ? weekAnchor : TODAY); openModal(null, day); return;
  }
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); _openCmdPop?.(); return; }   // Find/add popover (‘/’ is taken by the global command palette)
  // view switch (m/w/a) — Google-Calendar-style
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); if (mode !== 'month') { mode = 'month'; _kbSwitch = true; render(); } return; }
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); if (mode !== 'week') { mode = 'week'; _kbSwitch = true; render(); } return; }
  if (e.key === 'd' || e.key === 'D') { e.preventDefault(); if (mode !== 'day') { mode = 'day'; _kbSwitch = true; render(); } return; }
  if (e.key === 'a' || e.key === 'A') { e.preventDefault(); if (mode !== 'agenda') { mode = 'agenda'; _kbSwitch = true; render(); } return; }
  // Shift+←/→ steps the whole period (month, or week in week mode) — distinct from plain arrows (day focus)
  if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); shift(e.key === 'ArrowLeft' ? -1 : 1); return; }
  if (mode === 'month' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    const cells = $$('#calView .cal-date[data-day]');
    if (!cells.length) return;
    const idx = cells.indexOf(e.target.closest?.('.cal-date'));
    // endless grid: cells span the whole trip year — entry lands on TODAY (cells[0] is the top of
    // the range), and focus must be followed by a scroll or it walks off-screen invisibly
    if (idx < 0) {
      e.preventDefault();
      const start = $('#calView .cal-cell.today .cal-date') || cells[0];
      start.focus({ preventScroll: true });
      (start.closest('.cal-cell') || start).scrollIntoView({ block: 'nearest' });   // scroll the CELL — nearest on the small date button leaves only a sliver of the row visible
      return;
    }
    const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -7 : 7;
    const next = cells[idx + delta];
    if (next) { e.preventDefault(); next.focus({ preventScroll: true }); (next.closest('.cal-cell') || next).scrollIntoView({ block: 'nearest' }); }
  }
}

function renderMiniNav() {
  const host = $('#calMiniNav'); if (!host) return;
  const weeks = monthGrid(viewY, viewM);
  const rows = weeks.map(w => `<tr>${w.map(c =>
    `<td><button type="button" class="mn-day${c.inMonth ? '' : ' mn-out'}${c.iso === TODAY ? ' mn-today' : ''}" data-iso="${esc(c.iso)}" aria-label="${esc(c.iso)}">${c.day}</button></td>`
  ).join('')}</tr>`).join('');
  host.innerHTML = `
    <div class="mn-head">
      <button type="button" class="mn-arrow" data-mn="-1" aria-label="Previous month">&#x2039;</button>
      <span class="mn-title">${esc(MONTHS[viewM])} ${viewY}</span>
      <button type="button" class="mn-arrow" data-mn="1" aria-label="Next month">&#x203a;</button>
    </div>
    <table class="mn-grid"><thead><tr>${WEEKDAYS_SHORT.map(d => `<th scope="col">${esc(d)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  host.querySelectorAll('[data-mn]').forEach(b => b.addEventListener('click', () => { ({ year: viewY, month: viewM } = addMonths(viewY, viewM, +b.dataset.mn)); render(); }));
  host.querySelectorAll('.mn-day[data-iso]').forEach(b => b.addEventListener('click', () => jumpToDate(b.dataset.iso)));
}

function jumpToDate(iso) {
  const t = parseISO(iso); if (!t) return;
  if (mode === 'week' || mode === 'day') { weekAnchor = iso; viewY = t.getUTCFullYear(); viewM = t.getUTCMonth(); render(); return; }
  goDay(iso, !prefersReducedMotion());   // endless month: navigate by scrolling, not re-rendering
}

// month grid: clicking a date number (or "+N more") zooms into that WEEK — the re-render
// destroys the clicked button, so focus lands on the label (which render() just set to the week)
export function goWeek(iso) {
  const t = parseISO(iso); if (!t) return;
  weekAnchor = iso; viewY = t.getUTCFullYear(); viewM = t.getUTCMonth();
  mode = 'week';
  render();
  requestAnimationFrame(() => { const h = $('#calLabel'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } });
}

function render() {
  TODAY = nowISO();   // a tab left open across midnight must not keep highlighting yesterday
  _evCache = null; _taskCache = null;   // invalidate the per-render caches (data may have changed since last render)
  dismissPopover();
  const mEl = $('#calModeMonth'), wEl = $('#calModeWeek'), dEl = $('#calModeDay'), aEl = $('#calModeAgenda');
  mEl?.classList.toggle('active', mode === 'month'); mEl?.setAttribute('aria-pressed', String(mode === 'month'));
  wEl?.classList.toggle('active', mode === 'week'); wEl?.setAttribute('aria-pressed', String(mode === 'week'));
  dEl?.classList.toggle('active', mode === 'day'); dEl?.setAttribute('aria-pressed', String(mode === 'day'));
  aEl?.classList.toggle('active', mode === 'agenda'); aEl?.setAttribute('aria-pressed', String(mode === 'agenda'));
  const label = $('#calLabel');
  if (label) label.textContent = mode === 'agenda' ? `Agenda — from ${MONTHS[viewM]} ${viewY}` : mode === 'week' ? weekLabel() : mode === 'day' ? fmtDate(weekAnchor) : `${MONTHS[viewM]} ${viewY}`;
  const unit = mode === 'week' ? 'week' : mode === 'day' ? 'day' : 'month';   // prev/next step by week/day in those modes
  $('#calPrev')?.setAttribute('aria-label', 'Previous ' + unit); $('#calNext')?.setAttribute('aria-label', 'Next ' + unit);
  const view = $('#calView'); if (!view) return;
  const panel = $('#calPanel');
  // stage 15: switching OUT of month inherits the endless grid's big window scroll, which clamps
  // against the much shorter week/day/agenda page and buries the chrome (head measured -138px).
  // Reset only on a real mode CHANGE — data re-renders keep the user's scroll.
  if (_lastMode !== null && _lastMode !== mode && mode !== 'month') window.scrollTo(0, 0);
  if (mode === 'month') {
    // endless grid: a re-render (data change) must not teleport the user — capture + restore scroll
    const oldGrid = view.querySelector('.cal-grid');
    const gridTop = oldGrid?.scrollTop || 0;
    const mainEl = document.getElementById('main');
    const pageTop = mainEl?.scrollTop || 0, winTop = window.scrollY || 0;
    view.innerHTML = monthHTML();
    if (panel) { panel.hidden = false; panel.innerHTML = panelHTML(); wirePanel(); }
    wireCells();
    wireReschedule();
    wireMonthSelect();
    // "the rest of the page reacts": scrolling updates the label, mini-nav and cockpit for the month in view
    wireEndless((y, m) => {
      // While a re-entry restore is pending, positionEndless owns the month. In window-scroll mode
      // (viewport <821px) the window sits at the top (earliest month) for a beat on re-entry; without
      // this guard a transient scroll here would clobber viewY/viewM to that top month, and
      // positionEndless would then "restore" it — landing on April instead of the month you left.
      if (_entryPos || _endlessNeedsPos) return;
      viewY = y; viewM = m;
      const lb = $('#calLabel'); if (lb) lb.textContent = `${MONTHS[viewM]} ${viewY}`;
      // announce to screen readers only after scrolling settles — a live #calLabel would queue
      // an announcement for every month crossed in one fling through the 19-month grid
      clearTimeout(_liveT);
      _liveT = setTimeout(() => { const n = document.getElementById('calLive'); if (n) n.textContent = `${MONTHS[viewM]} ${viewY}`; }, 600);
      renderMiniNav();
      dimFocus();
      if (panel && !panel.hidden) { panel.innerHTML = panelHTML(); wirePanel(); }
    }, (dir) => {
      // reached an end → SLIDE the window and re-render, anchored so the view doesn't jump (infinite
      // scroll). CRITICAL: don't slide while a re-entry restore is pending — on tab-switch the grid
      // sits at the top for a beat, which would trigger an upward slide that fights positionEndless
      // and strands you at the top month instead of the current one.
      if (_entryPos || _endlessNeedsPos) return;
      const a = captureAnchor();
      if (extendWindow(dir)) { render(); restoreAnchor(a); }
    });
    dimFocus();   // initial focal state (re-renders too — cells are rebuilt without .moff)
    if (oldGrid) {   // restore (same-session re-render)
      const g = view.querySelector('.cal-grid'); if (g) g.scrollTop = gridTop;
      if (mainEl) mainEl.scrollTop = pageTop;
      if (winTop) window.scrollTo(0, winTop);
    } else {
      _endlessNeedsPos = true;   // first render may happen while the view is hidden (boot) — scrollIntoView would no-op
      requestAnimationFrame(positionEndless);
    }
  } else if (mode === 'week') {
    view.innerHTML = weekHTML();
    if (panel) panel.hidden = true;   // the week view shows the whole week; the month deadline panel would duplicate
    wireWeek();
  } else if (mode === 'day') {
    view.innerHTML = dayHTML();
    if (panel) panel.hidden = true;   // single day — no month deadline panel
    wireWeek();                       // same wiring; drag/resize read the column count from the DOM (1 in day mode)
  } else {
    view.innerHTML = agendaHTML();
    if (panel) panel.hidden = true;   // agenda already lists everything; panel would duplicate
    wireAgenda();
  }
  renderMiniNav();
  requestAnimationFrame(alignRail);
  // mode switches get a soft entrance (200ms ease-out rise) — data re-renders in the SAME mode
  // stay instant so quick-add/toggles never feel laggy
  if (_lastMode !== mode) {
    // no animation for KEYBOARD-initiated switches (m/w/d/a — repeated constantly, animation
    // makes them feel slow); pointer clicks on the mode buttons keep the soft entrance
    if (_lastMode !== null && !_kbSwitch && !prefersReducedMotion()) {
      view.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    _lastMode = mode;
  }
  _kbSwitch = false;
}
let _lastMode = null;
let _kbSwitch = false;   // set by the m/w/d/a keyboard shortcuts before render()

// align the sidebar rail to the GRID's real height (owner: "aligned so we just scroll") — the
// rail scrolls internally instead of running past the month. Boot renders while the view is
// hidden (rects are 0), so this also re-runs on every entry to #/calendar. Non-month uncaps.
function alignRail() {
  // endless month: the grid spans the whole trip year, so grid-bottom geometry is meaningless —
  // the panel's own CSS max-height (min(100vh−4rem, 700px)) governs in every mode now.
  document.querySelector('.cal-panel')?.style.removeProperty('max-height');
  // sticky-chrome offset: the dow row + sidebar pin under the toolbar in normal desktop mode;
  // measure its real height (flex-wrap can make it 1–2 rows) so the CSS offset stays exact
  const tb = document.querySelector('#view-calendar .cal-toolbar');
  if (tb?.offsetHeight) document.getElementById('calendarSection')?.style.setProperty('--cal-tb-h', tb.offsetHeight + 'px');
}
let _endlessNeedsPos = false;
let _entryPos = false;   // set on each entry to #/calendar; consumed once the endless grid is visible
let _liveT = 0;          // debounce for the #calLive month announcement
// Notion focal month: dim the date numbers of every cell OUTSIDE the labeled month
function dimFocus() {
  const ym = `${viewY}-${String(viewM + 1).padStart(2, '0')}`;
  for (const c of $$('#calView .cal-cell[data-day]')) c.classList.toggle('moff', c.dataset.day.slice(0, 7) !== ym);
}
function positionEndless() {
  if ((!_endlessNeedsPos && !_entryPos) || mode !== 'month') return;
  const grid = $('#calView .cal-grid');
  if (!grid || grid.offsetParent === null) return;   // still hidden (view-transition class toggle is async) — the retry loop catches it
  // Always land on the current month (owner: tab-switch should show "now", not where I'd scrolled).
  const targetDay = _endlessNeedsPos ? (weekAnchor || TODAY) : TODAY;
  const targetYm = targetDay.slice(0, 7);
  // Self-sufficient centring: if the target month isn't CENTRED in the window (window-scroll mode can
  // drift the window while the view is hidden, so the target month may be absent entirely), re-centre
  // and rebuild, then let the retry loop scroll on the fresh, centred DOM. A centred target lands
  // mid-window with buffer on both sides — never at an edge, so the auto-extend can't run away. Without
  // this, a target month missing from the window made the "landed" check below give up at the top.
  if (centerWindowOn(targetYm)) { render(); return; }
  // Anchor the current MONTH's start at the reading line (not today-centred): centring today scrolls
  // July 1–16 above the viewport, so you land mid-month reading into August ("stuck at the bottom").
  // Month-start puts July 1 at the top — a clean month view — and today stays visible (it's within
  // the month). This also keeps the target mid-window, so the near-edge auto-extend never fires.
  scrollToMonth(targetYm, false);
  // web-font load reflows the months ABOVE (serif separators) and the scroll drifts — re-anchor once
  // metrics are final (no-op when fonts were cached). Skip if the user has already scrolled away.
  const y0 = window.scrollY, g0 = $('#calView .cal-grid')?.scrollTop || 0;
  document.fonts?.ready?.then(() => {
    const g = $('#calView .cal-grid')?.scrollTop || 0;
    if (Math.abs(window.scrollY - y0) > 80 || Math.abs(g - g0) > 80) return;
    scrollToMonth(targetYm, false);
  });
  // VERIFY the scroll actually landed on the target month (a scroll issued mid-view-transition can be
  // measured against stale metrics and no-op, leaving the grid at the top). Only clear the retry flags
  // once the reading-line month matches — otherwise scheduleEntryPosition tries again. This is what
  // makes tab-switch reliably show the current month, not the top.
  // Mode-aware landed check. In INTERNAL-grid mode the reading line is the grid's top; in WINDOW-scroll
  // mode (viewport <821px) the grid IS full-height so grid.clientHeight is a useless tolerance — the
  // target sits at the viewport reading line instead. Clear the retry flags ONLY once the target month
  // is actually there; if it's absent (window drifted), keep retrying rather than giving up at the top —
  // otherwise onExtend unblocks with the grid at an edge and slides the window away from the target.
  const sep = grid.querySelector(`.cal-msep[data-ym="${targetYm}"]`);
  const internal = grid.scrollHeight > grid.clientHeight + 4;
  const landed = !sep ? false
    : internal ? Math.abs(sep.getBoundingClientRect().top - grid.getBoundingClientRect().top) < grid.clientHeight
    : Math.abs(sep.getBoundingClientRect().top - window.innerHeight / 2) < window.innerHeight;
  if (landed) { _endlessNeedsPos = false; _entryPos = false; }
}
// Retry positionEndless until it actually runs (the view can stay hidden past a fixed 300ms on a
// slow device / long view-transition). Condition-based, not fixed timeouts — so the month restore
// always completes AND the flags always clear (the onMonth guard above must never stick, or scroll
// tracking would silently stop). Hard ceiling ~2s: give up positioning but force-clear the flags.
function scheduleEntryPosition() {
  let tries = 0;
  const attempt = () => {
    if (!_entryPos && !_endlessNeedsPos) return;   // positioned (positionEndless cleared the flags)
    positionEndless();
    if (!_entryPos && !_endlessNeedsPos) return;   // just succeeded
    if (++tries > 20) { _endlessNeedsPos = false; _entryPos = false; return; }   // failsafe: never leave the guard stuck
    setTimeout(attempt, 100);
  };
  requestAnimationFrame(attempt);
}
let _calDirty = false;
document.addEventListener('jwh:route', (e) => {
  if (e.detail?.route !== 'calendar') return;
  if (mode === 'month') {
    // CENTER the window on today before positioning: a centred month lands mid-window (buffer both
    // sides), so the scroll never lands at an edge → the near-edge auto-extend can't fire on entry
    // and climb "higher and higher". Re-render only when the window actually moved (or data changed).
    const changed = centerWindowOn(TODAY.slice(0, 7));
    if (changed || _calDirty) render();
    _calDirty = false;
    _entryPos = true;
    scheduleEntryPosition();
  } else {
    if (_calDirty) { _calDirty = false; render(); }   // EF3: catch up on changes made while hidden

    window.scrollTo(0, 0);   // the router no longer resets the window for #/calendar (endless month owns it) — non-month modes still start at top
  }
  requestAnimationFrame(alignRail);
  setTimeout(alignRail, 300);   // again after the view transition settles — the rAF can land mid-swap
});

// a category guaranteed to have a --c-* token (an imported .ics could carry an arbitrary one →
// var(--c-<unknown>) would be undefined and the bar would render unstyled/unreadable)
export function safeCat(e) { const c = catOf(e); return (CATS.includes(c) || calMeta(c)) ? c : 'imported'; }
// shared reschedule (month grid + week chips): user → edit date (keep span); baked → date override.
export function rescheduleEvent(id, day) {
  const ev = allEvents().find(x => x.id === id);
  if (!ev) return;
  if (isRecurring(ev)) return;                 // a recurring chip is an occurrence, not a movable instance — dragging it would silently rewrite the whole series' anchor. Edit the event to change its date/cadence.
  if (ev.endDate && ev.endDate.slice(0, 10) !== ev.date.slice(0, 10)) return;   // multi-day events must NEVER move via drag — only their bars render them and bars aren't drag targets, but enforce it here too so no future selector regression can teleport a whole stay. Move/resize via the editor or the week grips.
  if (ev.date.slice(0, 10) === day) return;   // dropped on its own day — not a real move (no phantom override / "moved" flag)
  if (ev.source === 'user') {
    saveUser(loadUser().map(x => x.id === id ? { ...x, date: day, endDate: shiftEnd(x.date, day, x.endDate) } : x));   // keep multi-day span
    syncPlaceDate(id, day);                   // a linked "Visit:" place must follow its event's new date
  } else {                                    // baked event → store a date override (tips.json stays untouched)
    const orig = (DATA.calendar || []).find(c => c.id === id);
    if (orig && day === (orig.date || '').slice(0, 10)) { const { [id]: _d, ...o } = loadOverrides(); saveOverrides(o); }   // back to researched date → drop the override
    else saveOverrides({ ...loadOverrides(), [id]: day });
  }
}
// keep a place's stored date in step when its linked calendar event is rescheduled (place↔event parity)
export function syncPlaceDate(eventId, day) {
  const linked = loadPlaces().find(p => p.eventId === eventId);
  if (linked) patchPlace(linked.id, linked.remindDate ? { remindDate: day } : { date: day });
}

function dismissPopover() {
  if (popCleanup) { popCleanup(); popCleanup = null; }
  if (popEl) { popEl.remove(); popEl = null; }
}
export function dayPopover(date, anchor) {
  dismissPopover();
  const evs = eventsOn(date);
  const tks = tasksOn(date);
  const evRows = evs.map(e => `
    <div class="pop-row">
      <span class="pop-sw cat-${esc(catOf(e))}"></span>
      <span class="pop-body"><button class="pop-open" data-ev="${esc(e.id)}">${esc(e.title)}</button>
        ${e.bookBy ? `<span class="pop-book">book by ${esc(fmtShort(e.bookBy))}</span>` : ''}</span>
      <a class="pop-gcal" href="${esc(gcalUrl(e))}" target="_blank" rel="noopener noreferrer" title="Add to Google Calendar">+G</a>
    </div>`).join('');
  const tkRows = tks.map(t => `
    <div class="pop-row">
      <span class="pop-sw cat-task"></span>
      <span class="pop-body"><button class="pop-task" data-task="${esc(t.taskId)}">☑ ${esc(t.title)}</button>
        <span class="pop-book">checklist task</span></span>
    </div>`).join('');
  const rows = (evs.length || tks.length) ? evRows + tkRows : `<p class="pop-empty">Nothing booked this day.</p>`;
  popEl = document.createElement('div');
  popEl.className = 'cal-pop';
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-modal', 'true');
  popEl.setAttribute('aria-label', 'Events on ' + fmtDate(date));
  popEl.innerHTML = `<div class="pop-head">${esc(fmtDate(date))}</div>${rows}
    <button class="pop-add" data-add="${esc(date)}">+ Add your own event</button>`;
  document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect();
  const top = window.scrollY + r.bottom + 6, left = Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - popEl.offsetWidth - 12);
  const flipUp = r.bottom + popEl.offsetHeight + 12 > window.innerHeight;
  popEl.style.top = (flipUp ? window.scrollY + r.top - popEl.offsetHeight - 6 : top) + 'px';
  popEl.style.left = Math.max(window.scrollX + 8, left) + 'px';
  popEl.querySelectorAll('.pop-open').forEach(b => b.addEventListener('click', () => { const ev = allEvents().find(x => x.id === b.dataset.ev); dismissPopover(); if (ev) openSidePanel(ev, anchor); }));
  popEl.querySelectorAll('.pop-task').forEach(b => b.addEventListener('click', () => gotoTask(b.dataset.task)));
  popEl.querySelector('.pop-add').addEventListener('click', () => { dismissPopover(); openModal(null, date); });
  const onDoc = (e) => { if (popEl && !popEl.contains(e.target) && e.target !== anchor) dismissPopover(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { dismissPopover(); anchor.focus?.(); return; }   // Esc returns focus to the day cell
    if (e.key !== 'Tab' || !popEl) return;
    const f = [...popEl.querySelectorAll('button,[href]')].filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const onScroll = () => dismissPopover();
  const thisPop = popEl;   // guard: if the popover was dismissed before this task ran, don't attach unremovable listeners
  const mainEl = document.getElementById('main');   // app-shell: content scrolls INSIDE main, not the window
  const gridEl = document.querySelector('#calView .cal-grid');   // …and the endless month grid scrolls internally (both compact + normal now)
  setTimeout(() => { if (popEl !== thisPop) return; document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey); window.addEventListener('scroll', onScroll, { passive: true }); mainEl?.addEventListener('scroll', onScroll, { passive: true }); gridEl?.addEventListener('scroll', onScroll, { passive: true }); popEl.querySelector('.pop-open, .pop-add')?.focus({ preventScroll: true }); }, 0);   // preventScroll: a bare focus() + html scroll-behavior:smooth started a window scroll whose FIRST tick hit onScroll and dismissed the popover it was focusing
  popCleanup = () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); mainEl?.removeEventListener('scroll', onScroll); gridEl?.removeEventListener('scroll', onScroll); };
}

// ---- slide-in side panel (replaces openDetail as the event-detail surface) ----
function closeSidePanel() {
  const panel = $('#calSidePanel');
  if (!panel) return;
  panel.classList.remove('is-open');
  // wait for CSS transition before hiding (150ms exit, matches CSS)
  setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 160);
  if (_sidePanelCleanup) { _sidePanelCleanup(); _sidePanelCleanup = null; }
  const trig = _sidePanelTrigger;
  _sidePanelEv = null;
  _sidePanelTrigger = null;
  if (trig && document.contains(trig)) trig.focus({ preventScroll: true });
  else $('#calAdd')?.focus({ preventScroll: true });
}

// Anchor the detail CARD beside the clicked event, flipping to the side with room so the event
// stays visible (owner: "on the left if the event is on the right"). Desktop only — ≤699px is a
// bottom sheet (CSS), so we clear any inline coords there.
function positionSidePanel(panel) {
  const card = panel.querySelector('.sp-inner');
  if (!card) return;
  if (!window.matchMedia('(min-width: 700px)').matches) { card.style.left = card.style.top = card.style.width = ''; return; }
  const trig = _sidePanelTrigger;
  const W = window.innerWidth < 900 ? 320 : 380, gap = 10, m = 8;   // owner: notes were cramped — a little longer (380); 700–820px keeps 320 so the card doesn't smother its trigger
  const vw = window.innerWidth, vh = window.innerHeight;
  const sx = window.scrollX, sy = window.scrollY;                    // the card is DOCUMENT-anchored → add scroll so it scrolls WITH the page (owner: "fixed in place", not floating in the viewport)
  card.style.width = W + 'px';
  const r = (trig && document.contains(trig)) ? trig.getBoundingClientRect() : null;
  let left, top;
  if (r && r.width && r.height) {
    if (r.width > vw * 0.5) {                                        // a wide multi-day bar: no room beside it → sit just below, left-aligned
      left = r.left; top = r.bottom + gap;
    } else {
      const mid = (r.left + r.right) / 2;
      const placeLeft = mid > vw * 0.55 || (vw - r.right - gap) < W; // right-ish event or no room right → go left
      left = placeLeft ? r.left - gap - W : r.right + gap;
      top = r.top;
    }
  } else { left = vw - W - m; top = 72; }                            // no trigger → top-right fallback
  left = Math.max(m, Math.min(left, vw - W - m));
  card.style.left = (left + sx) + 'px';
  card.style.top = (sy) + 'px';                                      // set, then correct with real height below
  const ch = Math.min(card.offsetHeight, vh * 0.85);
  top = Math.max(m, Math.min(top, vh - ch - m));                     // start on-screen, but in doc coords so it travels with the event on scroll
  card.style.top = (top + sy) + 'px';
}

// 縁: people whose "met at" links to this event (reads jwh-people-v1 via store — calendar
// imports nothing from people.js; names are user-typed → esc()'d)
function metHereLine(evId) {
  const linked = (get(KEYS.people, []) || []).filter(p => p && p.metEventId === evId && p.name);
  if (!linked.length) return '';
  return `<p class="sp-en">縁 Met here: ${linked.map(p =>
    `<button type="button" class="sp-enp" data-pid="${esc(p.id)}">${esc(String(p.name))}</button>`).join('<span aria-hidden="true"> · </span>')}</p>`;
}

export function openSidePanel(ev, trigger) {
  if (_sidePanelCleanup) { _sidePanelCleanup(); _sidePanelCleanup = null; }
  _sidePanelTrigger = trigger || document.activeElement;
  _sidePanelEv = ev.id;
  const panel = $('#calSidePanel');
  if (!panel) return;
  // Portal to <body>: the panel is position:fixed but lives inside <main> (z-index:1), which
  // traps its z-index:101 in main's stacking context — so the sticky route-nav (z40) and topbar
  // (z50) paint OVER the panel's header + close button. Reparenting to body lets z-index:101 win.
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  const isBaked = ev.source !== 'user';
  // event art: BAKED events only, and a strict URL charset — no quotes/parens/spaces means the
  // value can never escape a CSS url() context. It is assigned via the CSSOM after render (not
  // string-built into a style attribute): esc() is an HTML escaper, and HTML entities DECODE
  // BEFORE the CSS parser runs — the wrong tool for this context (review #136).
  const imgOk = isBaked && /^https:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&*+,;=%-]+$/.test(ev.image || '') && !/['"()\s<>]/.test(ev.image);
  const alreadyPlanned = !!getPlan(ev.date.slice(0, 10))?.stops?.some(s => s.name === ev.title);
  const dateRange = esc(fmtDate(ev.date)) + (ev.endDate ? ' – ' + esc(fmtDate(ev.endDate)) : '');
  // friendly countdown chip: "in N days" / today / tomorrow / on now / past, + "· N-day" duration
  const startISO = ev.date.slice(0, 10), endISO = (ev.endDate || ev.date).slice(0, 10);
  const dTo = daysBetween(TODAY, startISO);
  let cd = '';
  if (dTo != null) cd = dTo > 1 ? `in ${dTo} days` : dTo === 1 ? 'tomorrow' : dTo === 0 ? 'today' : (endISO >= TODAY ? 'on now' : 'past');
  const span = ev.endDate ? (daysBetween(startISO, endISO) ?? 0) + 1 : 0;
  const cdFull = [cd, span > 1 ? `${span}-day` : ''].filter(Boolean).join(' · ');
  const gcal = `<a class="btn ghost" href="${esc(gcalUrl(ev))}" target="_blank" rel="noopener noreferrer">Google Cal</a>`;
  const actions = isBaked
    ? `<div class="sp-sec">${ev.moved ? '<button class="btn" id="spReset">↺ Reset date</button>' : ''}${ev.renamed ? '<button class="btn" id="spResetName">↩ Reset name</button>' : ''}${alreadyPlanned ? '' : '<button class="btn" id="spPlan">＋ Day plan</button>'}${gcal}<button class="btn" id="spCopy">Copy</button></div>`
    : `<div class="sp-sec"><button class="btn" id="spEdit">Edit</button>${gcal}<button class="btn danger" id="spDel">Delete</button></div>`;

  panel.innerHTML = `
    <div class="sp-backdrop" id="spBackdrop" aria-hidden="true"></div>
    <div class="sp-inner" role="dialog" aria-label="${esc(ev.title)}" style="--cat:var(--c-${safeCat(ev)}-ink)">
      <div class="sp-band${imgOk ? ' has-img' : ''}">
        ${imgOk ? `<div class="sp-img" aria-hidden="true"></div>` : ''}
        <div class="sp-cattop">
          <span class="sp-cat"><span class="sp-dot" aria-hidden="true"></span>${esc(catLabel(ev.category) || 'event')}</span>
          <button class="sp-close" id="spClose" aria-label="Close">✕</button>
        </div>
        <div class="sp-titlerow">
          <h2 class="sp-title" title="Double-click to rename">${esc(ev.title)}</h2>
          <button type="button" class="sp-rename" id="spRename" aria-label="Rename event">✎</button>
        </div>
        ${cdFull ? `<span class="sp-cd">${esc(cdFull)}</span>` : ''}
      </div>
      <div class="sp-body" tabindex="0">
        <div class="sp-meta">
          <span class="sp-k">When</span><span class="sp-v">${dateRange}</span>
          ${ev.area ? `<span class="sp-k">Where</span><span class="sp-v">${esc(ev.area)}</span>` : ''}
          ${ev.cost ? `<span class="sp-k">Cost</span><span class="sp-v">${esc(ev.cost)}</span>` : ''}
          ${ev.bookBy ? `<span class="sp-k">Book by</span><span class="sp-v sp-bookby">${esc(fmtDate(ev.bookBy))}</span>` : ''}
        </div>
        ${(ev.note || ev.bookingNotes || ev.why) ? `<p class="sp-note">${esc(ev.note || ev.bookingNotes || ev.why || '')}</p>` : ''}
        ${ev.moved ? '<p class="sp-moved">↩ You rescheduled this from its researched date.</p>' : ''}
        ${ev.renamed ? '<p class="sp-moved">✏ You renamed this event.</p>' : ''}
        ${metHereLine(ev.id)}
        ${srcline(ev.sources)}
      </div>
      <div class="sp-actions">${actions}</div>
    </div>`;

  panel.hidden = false;
  positionSidePanel(panel);            // desktop: anchor the card beside the clicked event (flip L/R)
  void panel.offsetWidth;              // force one reflow so the entrance transition fires immediately
  panel.classList.add('is-open');

  // wire actions
  panel.querySelector('#spClose')?.addEventListener('click', closeSidePanel);
  if (imgOk) {                                              // art loads via CSSOM, fades in on real load (no pop; reduce-motion kill covers the transition)
    const imgEl = panel.querySelector('.sp-img');
    const im = new Image();
    im.onload = () => { if (imgEl.isConnected) { imgEl.style.backgroundImage = `url("${ev.image}")`; imgEl.classList.add('is-loaded'); } };
    im.src = ev.image;
  }
  // Rename: the visible ✎ button is the touch/keyboard path (dblclick stays as the desktop
  // power path — hover-only affordances don't exist on a phone, review #136). User events
  // patch their own store; baked events use the evTitle override map (the evArea pattern).
  const startRename = () => {
    const titleEl = panel.querySelector('.sp-title');
    if (!titleEl || panel.querySelector('.sp-title-in')) return;
    const inp = document.createElement('input');
    inp.className = 'sp-title-in'; inp.value = ev.title; inp.maxLength = 120;
    inp.setAttribute('aria-label', 'Event name');
    titleEl.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (save && v && v !== ev.title) {
        if (ev.source === 'user') saveUser(loadUser().map(x => x.id === ev.id ? { ...x, title: v } : x));
        else {
          const m = { ...(get(KEYS.evTitle, {}) || {}) };
          const orig = (DATA.calendar || []).find(x => x.id === ev.id);
          if (orig && orig.title === v) delete m[ev.id]; else m[ev.id] = v;   // typing the researched name back clears the override
          set(KEYS.evTitle, m); changed();
        }
        const fresh = allEvents().find(x => x.id === ev.id);
        if (fresh) { openSidePanel(fresh, _sidePanelTrigger); return; }
      }
      inp.replaceWith(titleEl);
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();                                   // the panel's Tab trap + Esc-close listen in capture
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    });
    inp.addEventListener('blur', () => commit(true));
  };
  panel.querySelector('#spRename')?.addEventListener('click', startRename);
  panel.querySelector('.sp-title')?.addEventListener('dblclick', startRename);
  panel.querySelector('#spResetName')?.addEventListener('click', () => {
    const m2 = { ...(get(KEYS.evTitle, {}) || {}) };
    delete m2[ev.id];
    set(KEYS.evTitle, m2); changed();
    const fresh = allEvents().find(x => x.id === ev.id);
    if (fresh) openSidePanel(fresh, _sidePanelTrigger);
  });
  panel.querySelectorAll('.sp-enp').forEach(b => b.addEventListener('click', () => {   // 縁: name → open that person's drawer on #/people
    closeSidePanel();
    if (location.hash !== '#/people') location.hash = '#/people';
    // EF5: #/people is lazy — await its mount before firing, or the listener isn't attached yet.
    const pid = b.dataset.pid;
    ensureRoute('people').then(() => requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('jwh:people-open', { detail: { id: pid } }))));
  }));
  // click-away + reposition-on-resize, bound ONCE at the document/window level. Desktop: the container
  // is pointer-events:none so a real click lands on an event (→ switch) or empty space (→ close);
  // mobile: the backdrop tap also lands here (its own click listener would double-close → stole focus).
  if (!document._spAway) {
    document._spAway = true;
    document.addEventListener('pointerdown', (e) => {
      if (!_sidePanelEv) return;
      if (e.target.closest('.sp-inner, [data-ev], .wk2-ev, .wk-bar, .wk-chip, .wkl-ev, .modal-overlay, .app-modal, .dp-overlay, .lp-menu')) return;   // clicking any event switches (its handler reopens); everything else closes
      closeSidePanel();
    });
    window.addEventListener('resize', () => { const p = $('#calSidePanel'); if (p && !p.hidden && p.classList.contains('is-open')) positionSidePanel(p); });   // re-anchor / reset inline coords across the desktop↔mobile breakpoint
    // viewport-fit (both modes now): the grid scrolls INSIDE main (window.scrollY stays 0), so the
    // document-anchored panel would visibly detach from its chip — dismiss on internal scroll,
    // mirroring the day-popover (which already listens on #main + the grid).
    document.getElementById('main')?.addEventListener('scroll', () => { if (_sidePanelEv) closeSidePanel(); }, { passive: true });
    document.addEventListener('scroll', (e) => { if (_sidePanelEv && e.target?.classList?.contains('cal-grid')) closeSidePanel(); }, { capture: true, passive: true });
  }
  if (isBaked) {
    panel.querySelector('#spReset')?.addEventListener('click', () => { const { [ev.id]: _d, ...o } = loadOverrides(); saveOverrides(o); closeSidePanel(); });
    panel.querySelector('#spPlan')?.addEventListener('click', () => { addEventToPlan(ev); closeSidePanel(); });
    panel.querySelector('#spCopy')?.addEventListener('click', () => { copyBakedToUser(ev); closeSidePanel(); });
  } else {
    panel.querySelector('#spEdit')?.addEventListener('click', () => { closeSidePanel(); openModal(ev); });
    panel.querySelector('#spDel')?.addEventListener('click', () => { deleteUserEvent(ev.id); });  // single-path: deleteUserEvent→saveUser→jwh:data-changed→render; auto-close below
  }

  // Source links: open reliably in a new tab on click (user-initiated window.open can't be popup-
  // blocked). Keep the href for middle-click / new-tab / screen readers.
  panel.querySelectorAll('.sp-body .modal-src a[href]').forEach(a => {
    a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); });
  });

  // Esc closes; Tab is contained inside the dialog for keyboard convenience while it's open. It is a
  // role=dialog but NOT aria-modal — the background stays live (click another event to switch), so we
  // don't claim modality to AT; we just keep Tab from wandering behind an open popover.
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (e.target?.classList?.contains('sp-title-in')) return;   // a rename is active — its own handler cancels; don't close the panel over it
      e.stopPropagation(); closeSidePanel(); return;
    }
    if (e.key !== 'Tab') return;
    const f = [...panel.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  _sidePanelCleanup = () => document.removeEventListener('keydown', onKey, true);

  // focus first focusable element inside the panel
  setTimeout(() => { panel.querySelector('#spClose, button, [href]')?.focus({ preventScroll: true }); }, 40);
}

// Auto-close side panel when the open event disappears (delete / external change)
document.addEventListener('jwh:data-changed', () => {
  if (!_sidePanelEv) return;
  if (!allEvents().find(x => x.id === _sidePanelEv)) closeSidePanel();
});

// ---- shared event actions (used by both the modal handlers and the context menu) ----
function addEventToPlan(ev) {
  const c = approxCoord(DATA.areaGeo, ev.area || '', ev.title);
  upsertStop(ev.date.slice(0, 10), newStop({ name: ev.title, area: ev.area || '', lat: c.lat, lng: c.lng, coordKind: 'approx', seed: Math.random() }));   // upsertStop → dispatch
  alertModal(`Added “${ev.title}” to your plan for ${fmtDate(ev.date)}.`);
}
// "＋ Add to checklist": create a custom checklist item from the event (title + its
// date as the due hint), landing in "My tasks". Re-renders the checklist + dashboard
// via their jwh:data-changed listeners (no content.js import → no cycle).
function addEventToChecklist(ev) {
  saveChecklistCustom([...loadChecklistCustom(),
    customItem(ev.title, 'My tasks', (ev.date || '').slice(0, 10), 'cku' + Date.now())]);
  document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  dndToast('Added to checklist');
}
function copyBakedToUser(ev) {
  saveUser([...loadUser(), { id: 'u' + Date.now(), title: ev.title, date: ev.date.slice(0, 10), endDate: (ev.endDate || '').slice(0, 10), time: ev.time || '', endTime: ev.endTime || '', category: ev.category || 'personal', note: ev.bookingNotes || ev.why || '', area: ev.area || '', bookBy: ev.bookBy || '', copyOf: ev.id }]);   // carry time so a copied flight stays in the grid (review)
}
let pendingUndo = null, undoTimer = null;
function clearPending() { pendingUndo = null; if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; } }

export function deleteUserEvent(id) {
  const event = loadUser().find(x => x.id === id);
  if (!event) return;                                          // already gone — nothing to delete/undo
  const lp = loadPlaces().find(p => p.eventId === id);         // the place (if any) linked to this event
  const place = lp ? { id: lp.id, eventId: lp.eventId, date: lp.date, remindDate: lp.remindDate } : null;   // snapshot BEFORE teardown
  if (lp) patchPlace(lp.id, { eventId: '', date: '', remindDate: '' });   // clear the back-ref (silent — patchPlace doesn't dispatch)
  saveUser(loadUser().filter(x => x.id !== id));               // saveUser dispatches once → render
  clearPending();                                              // supersede any prior undoable delete (it becomes permanent)
  pendingUndo = { event, place };
  undoTimer = setTimeout(clearPending, 4200);                  // window matches dndToast's auto-dismiss
  dndToast(`Deleted “${event.title}”`, undoLastDelete);        // dndToast uses textContent → title is injection-safe
}

// Restore the most-recently-deleted event (Undo button or Ctrl/Cmd+Z). Returns true if it undid something.
export function undoLastDelete() {
  if (!pendingUndo) return false;
  const { event, place } = pendingUndo;                        // atomic consume: capture, then clear BEFORE mutating
  clearPending();
  if (place) patchPlace(place.id, { eventId: place.eventId, date: place.date, remindDate: place.remindDate });   // re-link first (silent) …
  saveUser([...loadUser(), event]);                            // … then save: one dispatch renders both. Original id → place links reconnect.
  return true;
}
function focusAdd() { $('#calAdd')?.focus(); }                 // after a mutating menu action, render destroys the trigger

// Map an event object to concrete menu items (label + run). Spec (labels/order/danger) is pure (lib/calevents).
function eventMenuItems(ev) {
  const RUN = {
    open: () => openSidePanel(ev),
    edit: () => openModal(ev),
    duplicate: () => { saveUser([...loadUser(), duplicateUserEvent(ev, 'u' + Date.now())]); focusAdd(); },
    plan: () => addEventToPlan(ev),
    checklist: () => addEventToChecklist(ev),
    gcal: () => window.open(gcalUrl(ev), '_blank', 'noopener'),
    copy: () => { copyBakedToUser(ev); focusAdd(); },
    delete: () => { deleteUserEvent(ev.id); focusAdd(); },
  };
  return eventMenuSpec(ev, { alreadyPlanned: !!getPlan(ev.date.slice(0, 10))?.stops?.some(s => s.name === ev.title) }).map(it => it.sep ? { sep: true } : { label: it.label, danger: it.danger, run: RUN[it.key] });
}

// Resolve a DOM node to event menu items, or null if it's not an event trigger. Exported for gestures.js.
export function getEventMenu(node) {
  const trig = node?.closest?.('.cal-chip[data-ev], .cal-bar[data-ev], .agenda-title[data-ev], .agenda-row[data-ev], .pop-open[data-ev], .cp-deadline[data-ev], .wkl-ev[data-ev], .wk-chip[data-ev], .wk-bar[data-ev], .wk2-ev[data-ev]');
  if (!trig) return null;
  const ev = allEvents().find(x => x.id === trig.dataset.ev);
  return ev ? eventMenuItems(ev) : null;
}
function srcline(s) {
  const arr = (s || []).filter(u => /^https?:\/\//i.test(u));   // only real web URLs into href (no javascript:)
  if (!arr.length) return '';
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  if (arr.length <= 3) return `<p class="modal-src">${arr.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(host(u))}">source ${i + 1} ↗</a>`).join('')}</p>`;
  // 4+ sources: compact HOST-labelled chips on ONE line (blind numbers made touch users tap
  // blind — review #136; hostnames were the whole point of exposing more sources)
  const short = (u) => { const h = host(u); const l = h.split('.')[0] || h; return l.length > 14 ? l.slice(0, 13) + '…' : l; };
  return `<p class="modal-src src-many">${arr.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(host(u))}" aria-label="source ${i + 1} — ${esc(host(u))}">${esc(short(u))}↗</a>`).join('')}</p>`;
}

