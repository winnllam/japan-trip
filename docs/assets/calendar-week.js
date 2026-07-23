'use strict';
import { $, $$, esc, stripEmoji } from './lib/dom.js';
import { parseISO, MONTHS, fmtShort } from './lib/dates.js';
import { weekDays, isMultiDay, packLanes, parseHM, layoutDay } from './lib/weekgrid.js';
import { recurOccurrences, isRecurring } from './lib/recur.js';
import { getPlan } from './lib/dayplan.js';
import { ensureRoute } from './lazyroutes.js';
import { makeMovable } from './dnd.js';
import { weekAnchor, TODAY, allEvents, visible, safeCat, isEvergreen, openModal, openSidePanel, rescheduleEvent, saveUser, loadUser } from './calendar.js';

// ---- WEEK view (all-day lane + per-day add; bars/drag land in later stages) ----
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function weekLabel() {
  const days = weekDays(weekAnchor);
  const a = parseISO(days[0]), b = parseISO(days[6]);
  const am = MONTHS[a.getUTCMonth()].slice(0, 3), bm = MONTHS[b.getUTCMonth()].slice(0, 3);
  return am === bm
    ? `${am} ${a.getUTCDate()} – ${b.getUTCDate()}, ${b.getUTCFullYear()}`
    : `${am} ${a.getUTCDate()} – ${bm} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}
const isNarrowWeek = () => window.matchMedia('(max-width: 700px)').matches;
// mobile: a vertical day-by-day list (the 7-col grid is unusable on a phone; a vertical list also
// avoids the horizontal route-swipe conflict). Each day lists its overlapping events; multi-day
// events get a continues marker. Reuses the per-day ＋ (.wk-add) + click→openSidePanel wiring.
function weekListHTML() {
  const days = weekDays(weekAnchor);
  const evs = allEvents().filter(e => visible(e) && !isEvergreen(e));   // evergreen residencies live in the month view's Ongoing strip, not the band
  return `<div class="wk-list">` + days.map(d => {
    const t = parseISO(d), dow = t.getUTCDay();
    const dayEvs = evs.filter(e => { const s = e.date.slice(0, 10), en = e.endDate ? e.endDate.slice(0, 10) : s; return s <= d && en >= d; })
      .sort((a, b) => a.date.localeCompare(b.date));
    const rows = dayEvs.map(e => {
      const s = e.date.slice(0, 10), en = e.endDate ? e.endDate.slice(0, 10) : s;
      const cont = isMultiDay(e) ? (d === s ? `<span class="wkl-cont">→ ${esc(fmtShort(en))}</span>` : d === en ? '<span class="wkl-cont">ends</span>' : '<span class="wkl-cont">ongoing ┄</span>') : '';
      return `<button type="button" class="wkl-ev" data-id="${esc(e.id)}" data-ev="${esc(e.id)}" style="--cat:var(--c-${safeCat(e)}-ink)"><span class="wk-dot" aria-hidden="true"></span><span class="wk-bt">${esc(stripEmoji(e.title))}</span>${cont}</button>`;
    }).join('') || '<p class="wkl-empty">No events</p>';
    const cls = (d === TODAY ? ' today' : '') + (dow === 0 || dow === 6 ? ' weekend' : '');
    return `<section class="wkl-day${cls}">
      <div class="wkl-head"><span class="wkl-dn">${DOW[dow]} ${t.getUTCDate()}</span>${d === TODAY ? '<span class="wkl-today">TODAY</span>' : ''}<button type="button" class="wk-add wkl-add" data-day="${esc(d)}" aria-label="Add event on ${esc(fmtShort(d))}">＋</button></div>
      <div class="wkl-evs">${rows}</div>
    </section>`;
  }).join('') + `</div>`;
}
const WK_HH = 44;   // px per hour in the time grid

// the shared time-grid builder — `days` is the array of ISO dates to show (7 for week, 1 for day).
// isDay adds the .is-day class so the CSS collapses the 7-col tracks to a single full-width column.
function gridHTML(days, isDay) {
  const hd = days.map(d => {
    const t = parseISO(d), dow = t.getUTCDay();
    const cls = (d === TODAY ? ' today' : '') + (dow === 0 || dow === 6 ? ' weekend' : '');
    return `<div class="wk2-dayhd${cls}" data-day="${esc(d)}"><span class="wk2-dn">${DOW[dow]}</span><span class="wk2-dd">${t.getUTCDate()}</span><button type="button" class="wk2-add" data-day="${esc(d)}" aria-label="Add event on ${esc(fmtShort(d))}">＋</button></div>`;
  }).join('');

  const evs = allEvents().filter(e => visible(e) && !isEvergreen(e));   // evergreen residencies live in the month view's Ongoing strip, not the band
  // multi-day → lane-packed BARS in the all-day band (reuses barHTML + the drag-resize wiring). Recurring
  // events are single-day occurrences, never span bars.
  const packed = packLanes(evs.filter(e => isMultiDay(e) && !isRecurring(e)), days);
  const laneN = packed.reduce((m, p) => Math.max(m, p.lane + 1), 0);
  let lanes = '';
  for (let ln = 0; ln < laneN; ln++) lanes += `<div class="wk-lane">${packed.filter(p => p.lane === ln).map(barHTML).join('')}</div>`;
  // single-day, NO time → chips in the band; single-day WITH time → positioned in the hour grid. Recurring
  // events place a single-day occurrence on each matching day within this week.
  const bandCols = Array.from({ length: days.length }, () => []);
  const timedCols = Array.from({ length: days.length }, () => []);
  evs.forEach(e => {
    if (isMultiDay(e) && !isRecurring(e)) return;   // handled by the span bars above
    for (const occ of recurOccurrences(e, days[0], days[days.length - 1])) {
      if (occ.endDate && occ.endDate > occ.date) continue;   // a non-recurring multi-day slipped in — bars own it
      const i = days.indexOf(occ.date); if (i < 0) continue;
      const start = parseHM(e.time);
      if (start != null) { let end = parseHM(e.endTime); if (end == null || end <= start) end = Math.min(24 * 60, start + 60); timedCols[i].push({ id: e.id, ev: e, startMin: start, endMin: end }); }
      else bandCols[i].push(e);
    }
  });
  // Day-plan stops with a start time render as timed blocks too (live from getPlan). A stop that's
  // been promoted to a calendar event (evstop-DATE-ID via Plan a Day) is skipped here so it shows
  // once — as its event — never doubled.
  const promoted = new Set(evs.map(e => e.id));
  days.forEach((d, i) => {
    (getPlan(d)?.stops || []).forEach(s => {
      if (promoted.has(`evstop-${d}-${s.id}`)) return;
      const startMin = parseHM(s.startTime); if (startMin == null) return;   // only timed stops land on the grid
      const endMin = Math.min(24 * 60, startMin + (s.durationMin || 60));
      const eh = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      timedCols[i].push({ id: `planstop-${d}-${s.id}`, plan: true, planday: d, startMin, endMin, ev: { title: s.name, time: s.startTime, endTime: eh, category: 'personal' } });
    });
  });
  const chips = bandCols.map(c => `<div class="wk-chipcol">${c.map(chipHTML).join('')}</div>`).join('');
  const anyTimed = timedCols.some(c => c.length);   // a fully all-day week → the hour grid would be an empty void; show a hint instead

  // hour gutter (JST, 24h) — a label sits at the top of each hour block
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="wk2-hr" style="height:${WK_HH}px"><span>${String(h).padStart(2, '0')}</span></div>`).join('');

  // 7 day columns: hour rules (bg gradient) + absolutely-positioned timed blocks + now-line on today
  const nowMin = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();
  const dayCols = days.map((d, i) => {
    const laid = layoutDay(timedCols[i]);
    const blocks = laid.map(b => {
      const top = Math.round(b.startMin / 60 * WK_HH);
      const h = Math.max(20, Math.round((b.endMin - b.startMin) / 60 * WK_HH));
      const w = 100 / b.cols, left = b.col * w;
      const tm = b.ev.time + (b.ev.endTime ? '–' + b.ev.endTime : '');
      const pos = `top:${top}px;height:${h}px;left:calc(${left}% + 2px);width:calc(${w}% - 4px)`;
      if (b.plan) {   // a day-plan stop — opens Plan a Day, not the event editor
        return `<button type="button" class="wk2-ev wk2-planblock" data-planday="${esc(b.planday)}" style="${pos}" aria-label="Day plan — ${esc(b.ev.title)} at ${esc(b.ev.time)}">`
          + `<span class="wk2-etime" aria-hidden="true">${esc(tm)}</span><span class="wk2-et" aria-hidden="true">📋 ${esc(stripEmoji(b.ev.title))}</span></button>`;
      }
      const aria = `${b.ev.time}${b.ev.endTime ? ' to ' + b.ev.endTime : ''}, ${b.ev.title}`;
      return `<button type="button" class="wk2-ev" data-id="${esc(b.id)}" data-ev="${esc(b.id)}" style="${pos};--cat:var(--c-${safeCat(b.ev)}-ink)" aria-label="${esc(aria)}">`
        + `<span class="wk2-etime" aria-hidden="true">${esc(tm)}</span><span class="wk2-et" aria-hidden="true">${esc(stripEmoji(b.ev.title))}</span></button>`;
    }).join('');
    const now = d === TODAY ? `<div class="wk2-now" style="top:${Math.round(nowMin / 60 * WK_HH)}px"><span class="wk2-now-dot"></span></div>` : '';
    return `<div class="wk2-col${d === TODAY ? ' today' : d < TODAY ? ' past' : ''}" data-day="${esc(d)}" style="height:${24 * WK_HH}px">${now}${blocks}</div>`;
  }).join('');

  return `<div class="wk2${isDay ? ' is-day' : ''}">
    <div class="wk2-head"><div class="wk2-corner"></div>${hd}</div>
    <div class="wk2-band">
      <div class="wk2-blabel"><span class="sr-only">All-day</span></div>
      <div class="wk2-bcols" id="wkAllday">
        ${lanes || '<div class="wk-lane"></div>'}
        <div class="wk-chips">${chips}</div>
      </div>
    </div>
    <div class="wk2-scroll" id="wkScroll" tabindex="0" role="group" aria-label="Hour grid — scroll through the day">
      <div class="wk2-inner" style="height:${24 * WK_HH}px">
        <div class="wk2-hours">${hours}</div>
        ${dayCols}
        ${anyTimed ? '' : `<div class="wk2-emptyhint"><span class="wk2-emptyhint-ic" aria-hidden="true">🕑</span>No timed events this ${isDay ? 'day' : 'week'} — your stays &amp; day plans are in the band above ↑</div>`}
      </div>
    </div>
  </div>`;
}
export function weekHTML() {
  if (isNarrowWeek()) return weekListHTML();
  return gridHTML(weekDays(weekAnchor), false);
}
// single-day view: the same time-grid with one full-width column (works at any width, so no list fallback).
export function dayHTML() {
  return gridHTML([weekAnchor], true);
}
// the ISO dates actually rendered in the grid, in column order — 7 for week, 1 for day. Reading from
// the DOM keeps the drag/resize column math correct in BOTH modes (and is inherently live).
const gridDays = () => $$('#calView .wk2-dayhd[data-day]').map(el => el.dataset.day);
function barHTML(p) {
  const e = p.ev, cls = (p.contL ? ' cont-l' : '') + (p.contR ? ' cont-r' : '')
    + ((e.endDate || e.date).slice(0, 10) < TODAY ? ' wk-past' : '');   // fully-over spans dim; ongoing ones stay bright
  const user = e.source === 'user';   // only your own events resize (baked spans are fixed research)
  const gl = (user && !p.contL) ? '<span class="wk-resize wk-resize-l" aria-hidden="true"></span>' : '';   // grips only on edges visible this week
  const gr = (user && !p.contR) ? '<span class="wk-resize wk-resize-r" aria-hidden="true"></span>' : '';
  return `<button type="button" class="wk-bar${cls}${user ? ' wk-user' : ''}" data-id="${esc(e.id)}" data-ev="${esc(e.id)}" style="grid-column:${p.col0 + 1}/${p.col1 + 2};--cat:var(--c-${safeCat(e)}-ink)" title="${esc(e.title)}">`
    + `${gl}${p.contL ? '<span class="wk-arr" aria-hidden="true">‹</span>' : ''}<span class="wk-dot" aria-hidden="true"></span><span class="wk-bt">${esc(stripEmoji(e.title))}</span>${p.contR ? '<span class="wk-arr" aria-hidden="true">›</span>' : ''}${gr}</button>`;
}
function chipHTML(e) {
  const rec = isRecurring(e);
  return `<button type="button" class="wk-chip${rec ? ' recurring' : ''}" data-id="${esc(e.id)}" data-ev="${esc(e.id)}" style="--cat:var(--c-${safeCat(e)}-ink)" title="${esc(e.title)}${rec ? ' (repeats ' + esc(e.recur) + ')' : ''}"><span class="wk-dot" aria-hidden="true"></span><span class="wk-bt">${esc(stripEmoji(e.title))}</span>${rec ? '<span class="cc-recur" aria-hidden="true">↻</span>' : ''}</button>`;
}
// a 📋 plan block → jump to Plan a Day for that date (plan is a lazy route; mount then select).
function openDayPlan(date) {
  if (!date) return;
  if (location.hash !== '#/plan') location.hash = '#/plan';
  ensureRoute('plan').then(() => requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('jwh:plan-goto', { detail: { date } }))));
}

export function wireWeek() {
  const view = $('#calView'); if (!view) return;
  $$('#calView .wk2-planblock[data-planday]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); openDayPlan(el.dataset.planday); }));
  $$('#calView .wk-add, #calView .wk2-add').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openModal(null, b.dataset.day); }));   // per-day add (mobile list ＋ and desktop day-header ＋) — keyboard-reachable
  wireWeekDragCreate();
  wireWeekResize();
  // LOCKED decision: only SINGLE-DAY chips are draggable to reschedule (a multi-day seasonal bar must
  // never drag — that would shift the whole window). Bars are click-to-edit only. Day headers = drop targets.
  makeMovable(view, {
    itemSelector: '.wk-chip[data-id]:not(.recurring)', label: 'event',   // a recurring chip is one occurrence — not draggable (would move the series)
    idOf: el => el.dataset.id,
    targetSelector: '.wk2-dayhd[data-day]', keyOf: t => t.dataset.day,
    onMove: rescheduleEvent,
  });
  // click an EMPTY spot in a day column → new event at that day + rounded hour (grid view only)
  $$('#calView .wk2-col[data-day]').forEach(col => col.addEventListener('click', (e) => {
    if (e.target.closest('.wk2-ev')) return;                  // a block owns its own click → panel
    const rect = col.getBoundingClientRect();
    const min = Math.max(0, Math.min(23 * 60, Math.round((e.clientY - rect.top) / WK_HH * 60 / 30) * 30));
    const hh = String(Math.floor(min / 60)).padStart(2, '0'), mm = String(min % 60).padStart(2, '0');
    openModal(null, col.dataset.day, '', `${hh}:${mm}`);
  }));
  // auto-scroll the hour grid so you LAND ON THE EVENTS, not a random empty hour: to ~30min before the
  // earliest timed event this week (most of a trip is all-day, so the grid is often morning-light and
  // "now" lands in a dead afternoon). Fallbacks: an hour before now if today's in view, else 7am.
  const scroll = $('#wkScroll');
  if (scroll && !scroll.dataset.scrolled) {
    scroll.dataset.scrolled = '1';
    const blocks = $$('#calView .wk2-ev');
    if (blocks.length) {
      const minTop = Math.min(...blocks.map(b => parseFloat(b.style.top) || 0));
      scroll.scrollTop = Math.max(0, minTop - WK_HH * 0.5);
    } else {
      scroll.scrollTop = 0;   // no timed events → keep the top (all-day band + the empty-grid hint) in view
    }
  }
  // click/Enter a chip OR bar → openSidePanel (baked → detail view w/ Reset/Copy; user → edit modal).
  // A real drag releases over a day header, so it never also fires this.
  $$('#calView .wk-chip[data-id], #calView .wk-bar[data-id], #calView .wkl-ev[data-id], #calView .wk2-ev[data-id]').forEach(el => el.addEventListener('click', () => {
    if (_wkResizeSuppressClick) return;                       // a resize drag just ended on this bar — don't also open it
    const ev = allEvents().find(x => x.id === el.dataset.id);
    if (ev) openSidePanel(ev, el);
  }));
}
// Drag a USER bar's left/right edge grip to reschedule its start / end day (multi-day user events).
// Only edges visible this week have grips (barHTML), so we never truncate the off-screen part.
let _wkResizeSuppressClick = false;
function wireWeekResize() {
  // Bind ONCE on the persistent #calView (render() only swaps its innerHTML, never the node itself),
  // and read `days` LIVE inside each handler — capturing weekDays(weekAnchor) once would go stale
  // after week navigation and, combined with re-binding every render, persist wrong dates.
  const view = $('#calView'); if (!view || view.dataset.wkResizeWired) return;
  view.dataset.wkResizeWired = '1';
  const colOf = (clientX, rect, n) => Math.max(0, Math.min(n - 1, Math.floor((clientX - rect.left) / (rect.width / n))));
  let st = null;   // { bar, ev, side, rect, moved }
  view.addEventListener('pointerdown', (e) => {
    if (isNarrowWeek()) return;                              // narrow week is a list (no bars/grips)
    const grip = e.target.closest('.wk-resize'); if (!grip) return;
    const bar = grip.closest('.wk-bar[data-id]'); if (!bar) return;
    const evObj = allEvents().find(x => x.id === bar.dataset.id); if (!evObj || evObj.source !== 'user') return;
    e.preventDefault(); e.stopPropagation();
    const lane = bar.closest('#wkAllday') || bar.parentElement;
    st = { bar, ev: evObj, side: grip.classList.contains('wk-resize-l') ? 'l' : 'r', rect: lane.getBoundingClientRect(), moved: false };
    try { view.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  });
  view.addEventListener('pointermove', (e) => {
    if (!st) return;
    st.moved = true;
    const days = gridDays();
    const col = colOf(e.clientX, st.rect, days.length);
    const s0 = days.indexOf(st.ev.date.slice(0, 10)), e0 = days.indexOf((st.ev.endDate || st.ev.date).slice(0, 10));
    let lo = s0 < 0 ? 0 : s0, hi = e0 < 0 ? days.length - 1 : e0;
    if (st.side === 'r') hi = Math.max(lo, col); else lo = Math.min(hi, col);
    st.bar.style.gridColumn = `${lo + 1}/${hi + 2}`;         // live preview; discarded on the save re-render
  });
  const finish = (e) => {
    if (!st) return;
    const { ev, side, moved, rect } = st; st = null;
    if (!moved) return;
    _wkResizeSuppressClick = true; setTimeout(() => { _wkResizeSuppressClick = false; }, 350);
    const days = gridDays();
    const col = colOf(e.clientX, rect, days.length);
    const s0 = ev.date.slice(0, 10), en0 = (ev.endDate || ev.date).slice(0, 10);
    let start = s0, end = en0;
    if (side === 'r') end = days[col] >= s0 ? days[col] : s0;            // clamp end ≥ start
    else start = days[col] <= en0 ? days[col] : en0;                     // clamp start ≤ end
    saveUser(loadUser().map(x => x.id === ev.id ? { ...x, date: start, endDate: (end && end !== start) ? end : '' } : x));
  };
  view.addEventListener('pointerup', finish);
  view.addEventListener('pointercancel', () => { st = null; });
}
// Drag across the week's all-day area to block out a date range → opens the editor pre-filled with
// that span (a plain click = a single-day add, matching the month grid). Desktop grid only.
function wireWeekDragCreate() {
  if (isNarrowWeek()) return;
  const lane = $('#wkAllday');
  if (!lane || lane.dataset.dragWired) return;
  lane.dataset.dragWired = '1';
  const days = gridDays();          // 7 (week) or 1 (day) — column count drives the ruler below
  const n = days.length;
  // capture the grid geometry ONCE per drag (the week grid never moves mid-drag, and re-reading it
  // live drifted the end column by ±1 when a scrollbar toggled) → start and end map with the same ruler
  let startCol = null, ghost = null, dragRect = null;
  const colOf = (clientX) => Math.max(0, Math.min(n - 1, Math.floor((clientX - dragRect.left) / (dragRect.width / n))));
  const clearGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };
  const draw = (a, b) => {
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'wk-dragsel'; ghost.setAttribute('aria-hidden', 'true'); lane.appendChild(ghost); }
    const lo = Math.min(a, b), hi = Math.max(a, b);
    ghost.style.left = `${(lo / n) * 100}%`;
    ghost.style.width = `${((hi - lo + 1) / n) * 100}%`;
  };
  lane.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.wk-bar, .wk-chip, button, a')) return;   // leave existing items/controls alone
    dragRect = lane.getBoundingClientRect();
    startCol = colOf(e.clientX);
    try { lane.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    draw(startCol, startCol);
    e.preventDefault();
  });
  lane.addEventListener('pointermove', (e) => {
    if (startCol == null) return;
    draw(startCol, colOf(e.clientX));
  });
  const finish = (e) => {
    if (startCol == null) return;
    const endCol = colOf(e.clientX);
    const lo = Math.min(startCol, endCol), hi = Math.max(startCol, endCol);
    startCol = null; dragRect = null; clearGhost();
    openModal(null, days[lo], lo === hi ? '' : days[hi]);   // single col → one-day add; span → pre-fill End
  };
  lane.addEventListener('pointerup', finish);
  lane.addEventListener('pointercancel', () => { startCol = null; clearGhost(); });
}
