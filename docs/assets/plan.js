'use strict';
// Plan a Day (#/plan). One day at a time: a horizontal day-chip rail picks the date; the body
// is an ordered timeline of stops with rough travel-time legs between them. Stops come from the
// unified placesModel() (saved pins + events + catalogue) or an ad-hoc typed name. Drag or ▲▼
// to reorder. Export the finished day to .ics / Google Calendar / the in-app calendar.
//
// Single-path data flow: every mutation goes through lib/dayplan.js (dispatches jwh:data-changed
// once); the listener re-renders. render() NEVER dispatches (no loop) and mutations never call
// render() directly.

import { $, esc } from './lib/dom.js';
import { nowISO, fmtShort } from './lib/dates.js';
import { areaOf } from './lib/geo.js';
import { legLabel, totalTransit, areaCount } from './lib/transit.js';
import { loadPlaces } from './lib/places.js';
import { placesModel, drawRoute, clearRoute } from './map.js';
import { toICS, gcalUrl } from './lib/ics.js';
import { directionsUrl, waypointsUrl } from './lib/directions.js';
import { KEYS, get, set } from './lib/store.js';
import {
  loadPlans, savePlans, getPlan, hasPlan, newStop, planToEvents,
  upsertStop, removeStop, patchStop, reorderStops, movePlanIn,
} from './lib/dayplan.js';
import { itineraryDay, itineraryStops } from './lib/itinerary.js';
import { makeSortable } from './dnd.js';
import { alertModal, confirmModal, askDate } from './lib/modal.js';

let DATA = null, activeDate = '';

const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };   // UTC-pure calendar add (no timezone off-by-one)
const hasCoord = (s) => s && typeof s.lat === 'number' && typeof s.lng === 'number' && !isNaN(s.lat) && !isNaN(s.lng);

export function mountPlan(data) {
  DATA = data;
  const arrival = (data.meta && data.meta.arrival_date) || '2026-06-30';
  const today = nowISO();
  activeDate = today >= arrival ? today : arrival;   // default to TODAY once the trip has started (else the arrival day)
  renderRail();
  render();
  deferCenter();   // land on today already centered in the rail (no manual scroll to reach it)
  $('#planBody')?.addEventListener('click', onBodyClick);
  // EF3: hidden → dirty-mark; render on next entry (a plan edit can only happen ON the page,
  // but cross-page writers — templates seed, map pushEvent, backup restore — dispatch too)
  let planDirty = false;
  document.addEventListener('jwh:data-changed', () => {
    if (document.getElementById('view-plan')?.classList.contains('is-active')) { renderRail(); render(); }
    else planDirty = true;
  });
  document.addEventListener('jwh:route', (e) => {
    if (e.detail?.route !== 'plan') return;
    if (planDirty) { planDirty = false; renderRail(); render(); }
    deferCenter();   // stage 5: entering mid-trip, the active chip can be deep in the 2000px strip — recentre it
  });
  document.addEventListener('jwh:plan-goto', (e) => { const d = e.detail?.date; if (d) { activeDate = d; planDirty = false; renderRail(); render(); centerActiveChip(); } });   // fresh render — clear dirty so the route listener doesn't repeat it (review)   // long-press a calendar day → plan it
  // the route line is drawn on demand (Show route on map); clear it only when leaving BOTH
  // plan and map (never auto-load Leaflet on #/plan).
  document.addEventListener('jwh:route', (e) => { const r = e.detail?.route; if (r !== 'plan' && r !== 'map') clearRoute(); });
}

// ---- day-chip rail: the trip window (arrival → arrival+30), plus any planned dates ----
// Anchored to the TRIP, not "today": before the trip we start at the arrival day (so the rail shows
// the real trip dates, not ~3 months of empty pre-trip days); once travelling it rolls from today.
// End is arrival+30 so the whole stay (and a few buffer days) is always reachable.
function railDates(plans) {
  const today = nowISO();
  const arrival = (DATA.meta && DATA.meta.arrival_date) || '2026-06-30';
  const from = today < arrival ? arrival : today;
  const end = addDaysISO(arrival, 30);
  const set = new Set();
  for (let d = from, guard = 0; d <= end && guard < 400; d = addDaysISO(d, 1), guard++) set.add(d);
  Object.keys(plans).forEach(d => set.add(d));   // keep any existing plan's date reachable
  set.add(activeDate);
  return [...set].sort();
}
function renderRail() {
  const rail = $('#planDays'); if (!rail) return;
  const railHadFocus = rail.contains(document.activeElement);
  const today = nowISO();
  const plans = loadPlans();   // read the plans blob ONCE, not per chip (N+1 → 1)
  const isPlanned = (d) => { const p = plans[d]; return !!(p && p.stops && p.stops.length); };
  rail.innerHTML = railDates(plans).map(d => {
    const planned = isPlanned(d);
    const isToday = d === today;
    return `<button type="button" class="plan-chip${d === activeDate ? ' active' : ''}${planned ? ' has-plan' : ''}" data-date="${esc(d)}" aria-pressed="${d === activeDate ? 'true' : 'false'}" aria-label="${esc(fmtShort(d))}${isToday ? ', today' : ''}${planned ? ', has a plan' : ''}">
      <span class="plan-chip-d" aria-hidden="true">${esc(fmtShort(d))}</span>${isToday ? '<span class="plan-chip-tag" aria-hidden="true">today</span>' : ''}${planned ? '<span class="plan-chip-dot" aria-hidden="true"></span>' : ''}
    </button>`;
  }).join('') + `<label class="plan-pick">+ date<input type="date" id="planPick" aria-label="Jump to any date"></label>`;
  rail.querySelectorAll('.plan-chip').forEach(b => b.addEventListener('click', () => { activeDate = b.dataset.date; renderRail(); render(); centerActiveChip(); }));
  // stage 5: scroll-edge fades — only where content actually overflows (45 pills ≈ 2000px hidden)
  if (!rail.dataset.fadeWired) {
    rail.dataset.fadeWired = '1';
    const fades = () => { rail.classList.toggle('fade-l', rail.scrollLeft > 4); rail.classList.toggle('fade-r', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 4); };
    rail.addEventListener('scroll', fades, { passive: true });
    window.addEventListener('resize', fades);
    rail._fades = fades;
  }
  rail._fades?.();
  $('#planPick')?.addEventListener('change', (e) => { if (e.target.value) { activeDate = e.target.value; renderRail(); render(); centerActiveChip(); } });
  if (railHadFocus) $('#planDays .plan-chip.active')?.focus();   // keep keyboard focus on the selected day across the rebuild
}
// Put the active day in the MIDDLE of the rail. Manual scrollLeft (not scrollIntoView) because the
// page sets `html{scroll-behavior:smooth}` and the chips use scroll-snap — scrollIntoView fights
// both and mis-lands during the view transition. We center instantly and clamp to the ends.
function centerActiveChip() {
  const rail = $('#planDays'); if (!rail || !rail.clientWidth) return;   // hidden/not laid out → skip (deferCenter retries)
  const chip = rail.querySelector('.plan-chip.active'); if (!chip) return;
  const delta = (chip.getBoundingClientRect().left - rail.getBoundingClientRect().left) - (rail.clientWidth - chip.clientWidth) / 2;
  const prev = rail.style.scrollBehavior;
  rail.style.scrollBehavior = 'auto';   // bypass the global smooth-scroll so it lands in one frame
  rail.scrollLeft = Math.max(0, Math.min(rail.scrollLeft + delta, rail.scrollWidth - rail.clientWidth));
  rail.style.scrollBehavior = prev;
  rail._fades?.();
}
// entering the page via the router, the rail isn't laid out on the first frame — retry after it is
function deferCenter() { requestAnimationFrame(() => requestAnimationFrame(centerActiveChip)); }

// ---- the day ----
// identify the focused stop control so render() can restore it after the innerHTML rebuild
// (skip 'note' — its change fires on blur, so focus is already leaving)
function captureBodyFocus(body) {
  const a = document.activeElement;
  if (!a || !body.contains(a)) return null;
  if (a.dataset?.act) return { act: a.dataset.act };
  if (a.classList?.contains('stop-grab')) return { id: a.dataset.id, grab: true };
  if (a.dataset?.edit && a.dataset.edit !== 'note') return { id: a.dataset.id, edit: a.dataset.edit };
  return null;
}
function restoreBodyFocus(body, f) {
  if (!f) return;
  const cs = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
  if (f.act) { body.querySelector(`[data-act="${cs(f.act)}"]`)?.focus(); return; }
  if (f.grab && f.id) { body.querySelector(`.stop[data-id="${cs(f.id)}"] .stop-grab`)?.focus(); return; }
  if (!f.id || !f.edit) return;
  let el = body.querySelector(`[data-id="${cs(f.id)}"][data-edit="${cs(f.edit)}"]`);
  if (el && el.disabled) {   // ▲/▼ became disabled at an end → fall back to the sibling stepper, then the grab
    const other = f.edit === 'up' ? 'down' : f.edit === 'down' ? 'up' : null;
    const sib = other && body.querySelector(`[data-id="${cs(f.id)}"][data-edit="${cs(other)}"]`);
    el = (sib && !sib.disabled) ? sib : body.querySelector(`.stop[data-id="${cs(f.id)}"] .stop-grab`);
  }
  el?.focus();
}
// copy a baked template into the active (stop-less) day — fresh stop ids, approx coords.
// A title/note the user already gave the day is PRESERVED (review finding: a stop-less plan
// object can carry meta the template must not discard).
function applyTemplate(tid) {
  const t = ((DATA && DATA.planTemplates) || []).find(x => x.id === tid);
  if (!t || hasPlan(activeDate)) return;
  const prior = getPlan(activeDate);
  const plans = loadPlans();
  savePlans({
    ...plans,
    [activeDate]: {
      date: activeDate, title: (prior && prior.title) || t.title, note: (prior && prior.note) || t.note || '',
      stops: (t.stops || []).map((s, i) => newStop({
        name: s.name, lat: s.lat ?? null, lng: s.lng ?? null, coordKind: 'approx',
        area: s.area || '', startTime: s.startTime || '', durationMin: s.durationMin ?? 60, note: s.note || '',
        id: 'tp' + Date.now() + '-' + i,
      })),
    },
  });   // dispatches jwh:data-changed → this page + dashboard/map re-derive
  // the strip (and the focused chip) was just rebuilt away — keep keyboard focus on the new plan
  $('#planBody .stop-grab, #planBody button, #planBody [tabindex="0"]')?.focus();
}

// seed the active (stop-less) day from the baked Hokkaido `itinerary` for that exact date — the
// schedule becomes editable stops. Single source: reads DATA.itinerary, never a duplicated copy.
function applyItinerary() {
  const day = itineraryDay(DATA && DATA.itinerary, activeDate);
  if (!day || hasPlan(activeDate)) return;
  const prior = getPlan(activeDate);
  const plans = loadPlans();
  savePlans({
    ...plans,
    [activeDate]: {
      date: activeDate,
      title: (prior && prior.title) || day.title || 'Hokkaido',
      note: (prior && prior.note) || (day.base ? `Hokkaido — ${day.base}` : ''),
      stops: itineraryStops(day).map((s, i) => newStop({ ...s, coordKind: 'approx', id: 'hok' + Date.now() + '-' + i })),
    },
  });   // dispatches jwh:data-changed → this page + dashboard/map re-derive
  $('#planBody .stop-grab, #planBody button, #planBody [tabindex="0"]')?.focus();
}

function render() {
  const body = $('#planBody'); if (!body) return;
  const focus = captureBodyFocus(body);
  const plan = getPlan(activeDate);
  const stops = plan ? plan.stops : [];
  if (!stops.length) {
    // date-aware Hokkaido seed: on an empty day that has a baked itinerary, offer it prominently
    const iday = itineraryDay(DATA && DATA.itinerary, activeDate);
    const hokHtml = iday ? `<div class="plan-hok" role="group" aria-label="Load the baked trip plan">
        <button type="button" class="plan-tpl plan-tpl-hok" data-hok="1">🗾 Load this day’s plan — ${esc(iday.title)} <span class="pt-n">${itineraryStops(iday).length} stops</span></button>
      </div>` : '';
    // additive template library (S2): only offered on an EMPTY day — never overwrites a plan
    const tpls = (DATA && DATA.planTemplates) || [];
    const tplHtml = tpls.length ? `<div class="plan-tpls" role="group" aria-label="Start from a template">
        <p class="plan-tpls-h">…or start from a template:</p>
        ${tpls.map(t => `<button type="button" class="plan-tpl" data-tpl="${esc(t.id)}">${esc(t.title)} <span class="pt-n">${(t.stops || []).length} stops</span></button>`).join('')}
      </div>` : '';
    body.innerHTML = `<div class="plan-empty">
      <p class="plan-empty-h">No plan for <b>${esc(fmtShort(activeDate))}</b> yet.</p>
      <p>Add your first stop — pull from your saved pins, the catalogue, upcoming events, or type your own.</p>
      <button type="button" class="plan-add" data-act="add">＋ Add a stop</button>${hokHtml}${tplHtml}</div>`;
    body.querySelector('[data-hok]')?.addEventListener('click', () => applyItinerary());
    body.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => applyTemplate(b.dataset.tpl)));
    restoreBodyFocus(body, focus);
    return;
  }
  const rows = stops.map((s, i) => stopRow(s, i, stops)).join('');
  const mins = totalTransit(stops, DATA.areaGeo);
  const pace = stops.length >= 5 ? `<span class="plan-pace">⚠ ${stops.length} stops — that's a full day; consider trimming.</span>` : '';
  // whole-day directions: one Google waypoints link (drops coordless stops, caps at the
  // 9-point limit). Only render when ≥2 stops have real coords.
  const dayDir = waypointsUrl(stops);
  body.innerHTML = `
    <div class="plan-foot-top">
      <span class="plan-summary">${stops.length} stop${stops.length > 1 ? 's' : ''} · ≈${mins} min between · ${areaCount(stops)} area${areaCount(stops) > 1 ? 's' : ''}</span>
      ${pace}
    </div>
    <ol class="stop-list" aria-label="Itinerary for ${esc(fmtShort(activeDate))}">${rows}</ol>
    <div class="plan-actions">
      <button type="button" class="plan-add" data-act="add">＋ Add a stop</button>
      <button type="button" class="plan-btn" data-act="map">🗺 Show route on map</button>
      ${dayDir.url ? `<a class="plan-btn" href="${esc(dayDir.url)}" target="_blank" rel="noopener noreferrer">🧭 Directions for the day</a>` : ''}
      <button type="button" class="plan-btn" data-act="move">↪ Move day…</button>
      <button type="button" class="plan-btn" data-act="ics">⬇ .ics</button>
      <button type="button" class="plan-btn" data-act="gcal">📅 Google</button>
      <button type="button" class="plan-btn" data-act="addcal">＋ Add to calendar</button>
    </div>`;
  wireSortable();
  restoreBodyFocus(body, focus);
}

function stopRow(s, i, stops) {
  const leg = i > 0 ? legLabel(stops[i - 1], s, DATA.areaGeo) : null;
  // per-leg Directions handoff — only when BOTH adjacent stops have real coords (a jittered
  // approx centroid isn't a route endpoint); keyless deep-link, opens the native Maps app.
  const legDir = (leg && hasCoord(stops[i - 1]) && hasCoord(s))
    ? ` <a class="leg-dir" href="${esc(directionsUrl({ from: { lat: stops[i - 1].lat, lng: stops[i - 1].lng }, to: { lat: s.lat, lng: s.lng } }))}" target="_blank" rel="noopener noreferrer" aria-label="Directions from ${esc(stops[i - 1].name)} to ${esc(s.name)}">🧭 Directions</a>` : '';
  const legHTML = leg ? `<li class="leg${leg.fuzzy ? ' fuzzy' : ''}" role="presentation"><span>${esc(leg.text)}</span>${legDir}</li>` : '';
  const end = s.startTime ? endTime(s.startTime, s.durationMin) : '';
  return `${legHTML}
    <li class="stop" data-id="${esc(s.id)}">
      <button type="button" class="stop-grab dnd-handle" aria-label="Reorder ${esc(s.name)} — drag, or use the arrow buttons">⠿</button>
      <span class="stop-num">${i + 1}</span>
      <div class="stop-main">
        <div class="stop-name">${esc(s.name)}${s.coordKind === 'approx' ? ' <span class="stop-approx" title="neighbourhood-level location">≈</span>' : ''}${s.locked ? ' <span title="fixed time">🔒</span>' : ''}</div>
        <div class="stop-sub">${esc(areaOf(s.area))}${s.area && areaOf(s.area) !== s.area ? '' : ''}</div>
        <div class="stop-controls">
          <label class="stop-time">🕑 <input type="time" value="${esc(s.startTime || '')}" data-edit="time" data-id="${esc(s.id)}" aria-label="Start time for ${esc(s.name)}"></label>
          <span class="stop-dur" role="group" aria-label="Duration for ${esc(s.name)}">
            <button type="button" class="dur-btn" data-edit="dur-" data-id="${esc(s.id)}" aria-label="Less time">−</button>
            <span class="dur-val" aria-live="polite">${s.durationMin} min</span>
            <button type="button" class="dur-btn" data-edit="dur+" data-id="${esc(s.id)}" aria-label="More time">＋</button>
          </span>
          ${end ? `<span class="stop-end">→ ${esc(end)}</span>` : ''}
          ${(get(KEYS.events, []) || []).some(e => e.id === `evstop-${activeDate}-${s.id}`)
            ? `<button type="button" class="stop-cal on" data-edit="stopcal" data-id="${esc(s.id)}" title="On the Month calendar — click to remove">✓ 📅 On calendar</button>`
            : `<button type="button" class="stop-cal" data-edit="stopcal" data-id="${esc(s.id)}" title="Add this stop to the calendar (shows in Month view)">＋ 📅 Calendar</button>`}
        </div>
        <input type="text" class="stop-note" value="${esc(s.note || '')}" title="${esc(s.note || '')}" data-edit="note" data-id="${esc(s.id)}" placeholder="note…" aria-label="Note for ${esc(s.name)}">
      </div>
      <span class="stop-rail">
        <span class="stop-move">
          <button type="button" class="mv" data-edit="up" data-id="${esc(s.id)}" aria-label="Move ${esc(s.name)} earlier"${i === 0 ? ' disabled' : ''}>▲</button>
          <button type="button" class="mv" data-edit="down" data-id="${esc(s.id)}" aria-label="Move ${esc(s.name)} later"${i === stops.length - 1 ? ' disabled' : ''}>▼</button>
        </span>
        <button type="button" class="stop-del" data-edit="del" data-id="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">✕</button>
      </span>
    </li>`;
}
function endTime(start, dur) {
  const [h, m] = start.split(':').map(Number);
  if (isNaN(h)) return '';
  const t = h * 60 + m + (dur || 0);
  const nextDay = Math.floor(t / 60) >= 24 ? ' +1' : '';   // flag a plan that runs past midnight
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0') + nextDay;
}

// ---- interactions (delegated on #planBody) ----
function onBodyClick(e) {
  const b = e.target.closest('[data-act],[data-edit]'); if (!b) return;
  const act = b.dataset.act, edit = b.dataset.edit, id = b.dataset.id;
  if (act === 'add') return openPicker();
  const plan = getPlan(activeDate);                    // every action below needs a plan with stops
  if ((act && act !== 'add') || edit) { if (!plan?.stops?.length) return; }
  if (act === 'map') { drawRoute(plan.stops, { title: plan.title, date: activeDate }); location.hash = '#/map'; return; }
  if (act === 'ics') return downloadICS();
  if (act === 'gcal') { const evs = planToEvents(plan); if (evs[0]) window.open(gcalUrl(evs[0]), '_blank', 'noopener'); return; }
  if (act === 'addcal') return addToCalendar();
  if (act === 'move') return moveDay();
  if (edit === 'del') {
    const cur = getPlan(activeDate);
    if (cur && cur.stops.length === 1 && cur.stops[0].id === id) {   // last stop → also drop the linked 'plan:DATE' calendar event so it isn't orphaned
      set(KEYS.events, (get(KEYS.events, []) || []).filter(ev => ev.id !== 'plan:' + activeDate));
    }
    removeStop(activeDate, id);   // one dispatch re-renders plan + calendar
    announce('Removed stop');
    return;
  }
  if (edit === 'up' || edit === 'down') return moveStop(id, edit);
  if (edit === 'dur-' || edit === 'dur+') return bumpDuration(id, edit === 'dur+' ? 15 : -15);
  if (edit === 'stopcal') return toggleStopCal(id);
}

// Per-stop "add to calendar": create/remove a user calendar event for one stop (id
// evstop-DATE-ID), so it shows in Month view. The Week/Day grids render plan stops already and
// skip a promoted stop, so it never doubles there. One dispatch re-renders plan + calendar.
function toggleStopCal(id) {
  const s = getPlan(activeDate)?.stops?.find(x => x.id === id); if (!s) return;
  const evId = `evstop-${activeDate}-${id}`;
  const evs = get(KEYS.events, []) || [];
  if (evs.some(e => e.id === evId)) {
    set(KEYS.events, evs.filter(e => e.id !== evId));
    announce('Removed from calendar');
  } else {
    const end = s.startTime ? endTime(s.startTime, s.durationMin).replace(/ \+1$/, '') : '';
    evs.push({ id: evId, title: s.name, date: activeDate, endDate: '', time: s.startTime || '', endTime: end, category: 'personal', area: s.area || '', note: s.note || '', fromStop: `${activeDate}:${id}` });
    set(KEYS.events, evs);
    announce('Added to calendar');
  }
  document.dispatchEvent(new CustomEvent('jwh:data-changed'));
}
// note + time use change events (delegated)
function onBodyChange(e) {
  const t = e.target; const id = t.dataset.id;
  if (t.dataset.edit === 'note') patchStop(activeDate, id, { note: t.value });
  else if (t.dataset.edit === 'time') patchStop(activeDate, id, { startTime: t.value });
}
function moveStop(id, dir) {
  const stops = getPlan(activeDate).stops;
  const i = stops.findIndex(s => s.id === id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= stops.length) return;
  const ids = stops.map(s => s.id);
  ids.splice(i, 1); ids.splice(j, 0, id);
  reorderStops(activeDate, ids);
  announce(`Moved to position ${j + 1} of ${stops.length}`);
}
function bumpDuration(id, delta) {
  const s = getPlan(activeDate).stops.find(x => x.id === id); if (!s) return;
  const next = Math.max(15, (s.durationMin || 60) + delta);
  patchStop(activeDate, id, { durationMin: next });
  announce(`${s.name}: ${next} minutes`);   // the per-row aria-live node is recreated on render; announce via the stable region
}
function wireSortable() {
  const ol = $('#planBody .stop-list'); if (!ol) return;
  makeSortable(ol, {
    itemSelector: '.stop', handleSelector: '.stop-grab', idOf: el => el.dataset.id, label: 'stop',
    onReorder: (ids) => { reorderStops(activeDate, ids.filter(Boolean)); announce('Reordered itinerary'); },
  });
}
function announce(msg) { const el = $('#planLive'); if (el) el.textContent = msg; }

// ---- add-stop picker (modal sheet over placesModel + saved) ----
function openPicker() {
  const prev = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'plan-modal';
  ov.innerHTML = `<div class="plan-sheet" role="dialog" aria-modal="true" aria-label="Add a stop">
    <div class="plan-sheet-top">
      <input type="search" id="pkFilter" placeholder="filter places…" aria-label="Filter places" autocomplete="off">
      <button type="button" class="plan-sheet-x" data-x aria-label="Close">✕</button>
    </div>
    <div class="plan-tabs" role="group" aria-label="Stop source">
      <button type="button" class="pk-tab active" data-src="saved" aria-pressed="true">★ Saved</button>
      <button type="button" class="pk-tab" data-src="catalogue" aria-pressed="false">Catalogue</button>
      <button type="button" class="pk-tab" data-src="event" aria-pressed="false">Events</button>
    </div>
    <ul class="pk-list" id="pkList" aria-live="polite"></ul>
  </div>`;
  document.body.appendChild(ov);
  let src = 'saved', q = '';
  const points = () => {
    const model = placesModel();
    if (src === 'saved') return model.filter(p => p.kind === 'user');
    if (src === 'event') return model.filter(p => p.kind === 'event');
    return model.filter(p => p.kind === 'catalogue');
  };
  const draw = () => {
    const list = points().filter(p => !q || (p.name + ' ' + (p.area || '')).toLowerCase().includes(q));
    const rows = list.slice(0, 80).map(p => `<li><button type="button" class="pk-item" data-id="${esc(p.id)}">
      <span class="pk-name">${esc(p.name)}${p.coordKind === 'approx' ? ' <span class="stop-approx">≈</span>' : ''}</span>
      <span class="pk-area">${esc(areaOf(p.area))}</span></button></li>`).join('');
    const adhoc = q ? `<li><button type="button" class="pk-item pk-adhoc" data-adhoc="${esc(q)}">＋ Add “${esc(q)}” as a custom stop</button></li>` : '';
    $('#pkList').innerHTML = (rows || '') + adhoc || `<li class="pk-empty">No matches — type a name to add a custom stop.</li>`;
  };
  draw();
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); if (prev?.focus) prev.focus(); };
  const focusables = () => [...ov.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('[data-x]')) return close();
    const tab = e.target.closest('.pk-tab');
    if (tab) { src = tab.dataset.src; ov.querySelectorAll('.pk-tab').forEach(t => { const on = t === tab; t.classList.toggle('active', on); t.setAttribute('aria-pressed', String(on)); }); draw(); return; }
    const adhoc = e.target.closest('[data-adhoc]');
    if (adhoc) { addAdhoc(adhoc.dataset.adhoc); close(); return; }
    const item = e.target.closest('.pk-item');
    if (item) { addFromModel(item.dataset.id); close(); }
  });
  ov.querySelector('#pkFilter').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  setTimeout(() => ov.querySelector('#pkFilter')?.focus(), 30);
}
function addFromModel(id) {
  const pt = placesModel().find(p => p.id === id); if (!pt) return;
  upsertStop(activeDate, newStop({ placeId: pt.id, name: pt.name, lat: pt.lat, lng: pt.lng, coordKind: pt.coordKind, area: pt.area, seed: Math.random() }));
  announce(`Added ${pt.name}`);
}
function addAdhoc(name) {
  upsertStop(activeDate, newStop({ name, area: '', coordKind: 'approx', seed: Math.random() }));
  announce(`Added ${name}`);
}

// ---- export ----
function downloadICS() {
  const evs = planToEvents(getPlan(activeDate)); if (!evs.length) return;
  const blob = new Blob([toICS(evs, 'My Tokyo Day')], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `tokyo-plan-${activeDate}.ics`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function addToCalendar() {
  const evs = planToEvents(getPlan(activeDate)); if (!evs.length) return;
  const u = (get(KEYS.events, []) || []).filter(e => e.id !== evs[0].id);   // replace any prior plan event for this day
  u.push(evs[0]); set(KEYS.events, u);
  document.dispatchEvent(new CustomEvent('jwh:data-changed'));
  announce('Added the day to your calendar');
  alertModal('Added this day to your calendar — see it on the Calendar page.');
}

// ---- move the whole day to another date ----
// Prompts for the target date; if that day already has a plan, offers to merge the stops. Any
// calendar events linked to this day (per-stop evstop-* and the whole-day plan:* summary) follow
// to the new date. One dispatch (via savePlans) re-renders the rail + body; we land on the target.
async function moveDay() {
  const plan = getPlan(activeDate);
  if (!plan?.stops?.length) return;
  const to = await askDate('Move this day’s plan to which date?', { value: activeDate });
  if (to === null) return;                                   // cancelled
  const toDate = (to || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) { if (toDate) alertModal('Use a valid date (YYYY-MM-DD).'); return; }
  if (toDate === activeDate) return;                         // same day → no-op
  let merge = false;
  if (hasPlan(toDate)) {
    if (!await confirmModal(`${fmtShort(toDate)} already has a plan. Merge this day’s stops into it?`, { ok: 'Merge' })) return;
    merge = true;
  }
  const from = activeDate;
  activeDate = toDate;                                         // set BEFORE the write so the re-render lands on the moved day
  rekeyPlanEvents(from, toDate, merge);                        // move linked calendar events (no dispatch)
  savePlans(movePlanIn(loadPlans(), from, toDate, { merge })); // dispatches jwh:data-changed once → re-render (rail + body on toDate)
  announce(`Moved the plan to ${fmtShort(toDate)}`);
}
// Re-date the calendar events linked to a day when its plan moves: the per-stop "add to calendar"
// events (evstop-<date>-<stopId>) and the whole-day summary (plan:<date>). set() (no dispatch) —
// the savePlans call in moveDay fires the single jwh:data-changed.
function rekeyPlanEvents(fromDate, toDate, merge) {
  const stopPrefix = `evstop-${fromDate}-`;
  const evs = get(KEYS.events, []) || [];
  const destHasSummary = evs.some(e => e.id === `plan:${toDate}`);
  const next = evs.map(e => {
    if (e.id && e.id.startsWith(stopPrefix)) {
      const stopId = e.id.slice(stopPrefix.length);
      return { ...e, id: `evstop-${toDate}-${stopId}`, date: toDate, fromStop: `${toDate}:${stopId}` };
    }
    if (e.id === `plan:${fromDate}`) {
      if (merge && destHasSummary) return null;                // target already summarised → drop the moved one (dedupe)
      return { ...e, id: `plan:${toDate}`, date: toDate };
    }
    return e;
  }).filter(Boolean);
  set(KEYS.events, next);
}

// wire the change-event listener once at module init (delegated)
document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('#planBody')) onBodyChange(e); });
