'use strict';
// Day plans (jwh-dayplans-v1): an object keyed by ISO date, each {date, title, note, stops[]}.
// A stop is an ORDERED, denormalized snapshot — it survives if the referenced place changes
// or is deleted. order IS the itinerary sequence (+ the map route order). Pure transforms
// (testable in Node) plus thin storage wrappers; all mutation dispatches jwh:data-changed once.

import { KEYS, get, set } from './store.js';

// ---- pure shape helpers (no localStorage/document) ----
export function newStop(fields) {
  return {
    id: fields.id || ('s' + Date.now() + Math.floor((fields.seed || 0) * 1e4 % 1e4)),
    placeId: fields.placeId || '',
    name: fields.name || 'Stop',
    lat: typeof fields.lat === 'number' ? fields.lat : null,
    lng: typeof fields.lng === 'number' ? fields.lng : null,
    coordKind: fields.coordKind || (typeof fields.lat === 'number' ? 'exact' : 'approx'),
    area: fields.area || '',
    startTime: fields.startTime || '',
    durationMin: typeof fields.durationMin === 'number' ? fields.durationMin : 60,
    note: fields.note || '',
    locked: !!fields.locked,
  };
}
export function normalizePlan(date, p) {
  const plan = p || {};
  return { date, title: plan.title || '', note: plan.note || '', stops: Array.isArray(plan.stops) ? plan.stops : [] };
}

// immutable transforms over the whole plans object (return new copies)
export function upsertStopIn(plans, date, stop) {
  const plan = normalizePlan(date, plans[date]);
  const i = plan.stops.findIndex(s => s.id === stop.id);
  const stops = i >= 0 ? plan.stops.map(s => s.id === stop.id ? { ...s, ...stop } : s) : [...plan.stops, stop];
  return { ...plans, [date]: { ...plan, stops } };
}
export function removeStopIn(plans, date, stopId) {
  const plan = normalizePlan(date, plans[date]);
  return { ...plans, [date]: { ...plan, stops: plan.stops.filter(s => s.id !== stopId) } };
}
export function patchStopIn(plans, date, stopId, fields) {
  const plan = normalizePlan(date, plans[date]);
  return { ...plans, [date]: { ...plan, stops: plan.stops.map(s => s.id === stopId ? { ...s, ...fields } : s) } };
}
export function reorderStopsIn(plans, date, orderedIds) {
  const plan = normalizePlan(date, plans[date]);
  const byId = new Map(plan.stops.map(s => [s.id, s]));
  const next = orderedIds.map(id => byId.get(id)).filter(Boolean);
  plan.stops.forEach(s => { if (!orderedIds.includes(s.id)) next.push(s); });   // keep any unlisted
  return { ...plans, [date]: { ...plan, stops: next } };
}
export function setPlanMetaIn(plans, date, fields) {
  return { ...plans, [date]: { ...normalizePlan(date, plans[date]), ...fields } };
}
// Move a whole day plan from one date to another (re-dating the plan object). If `merge` and the
// target already has stops, the moved stops are appended to the target's (target title/note win);
// otherwise the target is replaced. The source date is removed. No-op if from===to or nothing at
// `from`. Pure — returns a new plans object.
export function movePlanIn(plans, fromDate, toDate, { merge = false } = {}) {
  if (!fromDate || !toDate || fromDate === toDate || !plans[fromDate]) return plans;
  const moved = normalizePlan(toDate, plans[fromDate]);   // same title/note/stops, re-dated to toDate
  const next = { ...plans };
  const dest = next[toDate];
  if (merge && dest && Array.isArray(dest.stops) && dest.stops.length) {
    const d = normalizePlan(toDate, dest);
    next[toDate] = { ...d, title: d.title || moved.title, note: d.note || moved.note, stops: [...d.stops, ...moved.stops] };
  } else {
    next[toDate] = moved;
  }
  delete next[fromDate];
  return next;
}

// one all-day calendar event summarising a plan (reuses lib/ics.js + the events store)
export function planToEvents(plan) {
  if (!plan || !plan.stops || !plan.stops.length) return [];
  return [{
    id: 'plan:' + plan.date,
    title: plan.title || ('Plan — ' + plan.date),
    date: plan.date, endDate: '',
    category: 'personal',
    area: plan.stops[0].area || '',
    note: plan.stops.map(s => `${s.startTime ? s.startTime + ' ' : ''}${s.name}${s.note ? ' — ' + s.note : ''}`).join('\n'),
  }];
}

// ---- storage-bound wrappers ----
export function loadPlans() { return get(KEYS.dayPlans, {}) || {}; }
export function savePlans(plans) { if (set(KEYS.dayPlans, plans)) dispatchChanged(); }   // skip re-render on quota fail (would read stale LS → edit appears to vanish)
export function getPlan(date) { const p = loadPlans()[date]; return p ? normalizePlan(date, p) : null; }
export function hasPlan(date) { const p = loadPlans()[date]; return !!(p && p.stops && p.stops.length); }

export function upsertStop(date, stop) { savePlans(upsertStopIn(loadPlans(), date, stop)); }
export function removeStop(date, stopId) { savePlans(removeStopIn(loadPlans(), date, stopId)); }
export function patchStop(date, stopId, fields) { savePlans(patchStopIn(loadPlans(), date, stopId, fields)); }
export function reorderStops(date, orderedIds) { savePlans(reorderStopsIn(loadPlans(), date, orderedIds)); }
export function setPlanMeta(date, fields) { savePlans(setPlanMetaIn(loadPlans(), date, fields)); }

export function dispatchChanged() { try { document.dispatchEvent(new CustomEvent('jwh:data-changed')); } catch { /* Node */ } }
