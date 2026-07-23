'use strict';
import { $, $$, esc, stripEmoji } from './lib/dom.js';
import { daysBetween, fmtShort, parseISO } from './lib/dates.js';
import { isMultiDay, fmt12 } from './lib/weekgrid.js';
import { recurOccurrences, isRecurring } from './lib/recur.js';
import { monthGrid } from './lib/minical.js';
import { getPlan } from './lib/dayplan.js';
import { ensureRoute } from './lazyroutes.js';
import { makeMovable } from './dnd.js';
import { viewY, viewM, TODAY, allEvents, visible, catOf, safeCat, tasksOn, taskChipHTML, allTasks, isEvergreen, openModal, openSidePanel, dayPopover, gotoTask, birthdaysOn, birthdayChipHTML, gotoPerson, rescheduleEvent, goAgenda, goWeek } from './calendar.js';

function pad(n) { return String(n).padStart(2, '0'); }

const MONTH_SINGLES = 4;      // rows per cell — all chips, or 3 chips + "+N more" as the 4th row

// ENDLESS month: one continuous week-grid spanning the whole data range (the trip year —
// ~60 weeks, cheap enough to render whole; no virtual windowing). Month-separator rows sit above
// the week containing each 1st; the coordinator watches scroll and updates the label / mini-nav /
// cockpit to the month at the top of the viewport. Multi-day events chip on every covered day,
// Notion-style ("‹" when continuing from an earlier day). Evergreen spans are dropped from the grid
// (see the filter below) and reachable via the Find/add search popover + agenda, not a strip.
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// TRUE infinite scroll via a fixed-size SLIDING window (not the whole data range) — so there's no
// hard April "wall", and the DOM stays bounded (fast re-render, no growing lag). Reaching an end
// SLIDES the window (drop CAL_CHUNK off the far end, add it to the near end). Module state, so it
// persists across re-renders / route re-entry.
const stepYM = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const CAL_SIZE = 9;           // months kept in the DOM at once — small = fast initial paint + fast slide
const CAL_HALF = Math.floor(CAL_SIZE / 2);   // months either side of the centred month
const CAL_CHUNK = 3;          // months the window slides when you reach an edge
let _winLo = null, _winHi = null;   // YYYY-MM, inclusive (span = CAL_SIZE)
// CENTER the window on a month (target in the MIDDLE, with buffer above+below). Centring is what
// makes tab-switch safe: positioning to a CENTRED month lands mid-window, never at an edge, so the
// near-edge auto-extend can't fire on entry and run away. Returns true if the window changed.
export function centerWindowOn(ym) {
  const lo = stepYM(ym, -CAL_HALF), hi = stepYM(ym, CAL_SIZE - 1 - CAL_HALF);
  if (lo === _winLo && hi === _winHi) return false;
  _winLo = lo; _winHi = hi; return true;
}
function initWindow() { centerWindowOn(TODAY.slice(0, 7)); }
export function calWindow() { if (_winLo === null) initWindow(); return { lo: _winLo, hi: _winHi }; }
// slide the window one chunk toward dir — bounded DOM, truly infinite (no absolute cap). Always changes.
export function extendWindow(dir) {
  if (_winLo === null) initWindow();
  const n = dir < 0 ? -CAL_CHUNK : CAL_CHUNK;
  _winLo = stepYM(_winLo, n); _winHi = stepYM(_winHi, n);
  return true;
}
// explicit jumps (Prev/Next, Today, quick-add, mini-cal): re-center on the target if it's outside the
// window OR within a chunk of an edge (so scrolling to it doesn't immediately trip auto-extend). Returns changed.
export function ensureWindowCovers(ym) {
  if (_winLo === null) initWindow();
  if (ym >= stepYM(_winLo, CAL_CHUNK) && ym <= stepYM(_winHi, -CAL_CHUNK)) return false;   // safely mid-window
  return centerWindowOn(ym);
}
// anchor the current scroll to a day cell at the READING LINE (middle of the VISIBLE grid, below the
// sticky topbar/nav) so a prepend/append doesn't jump. Reuses topline()'s probe point on purpose —
// a fixed top+Npx offset would land inside the sticky chrome in window-scroll mode.
export function captureAnchor() {
  const grid = $('#calView .cal-grid'); if (!grid) return null;
  const gr = grid.getBoundingClientRect();
  const x = gr.left + gr.width / 2;
  const y = (Math.max(gr.top, 0) + Math.min(gr.bottom, window.innerHeight)) / 2;
  let cell = document.elementFromPoint(x, y)?.closest?.('.cal-cell[data-day]');
  if (!cell) {   // elementFromPoint can miss (a chip/overlay intercepts the point) — scan for the first cell past the reading line so a slide still preserves scroll
    for (const c of grid.querySelectorAll('.cal-cell[data-day]')) { if (c.getBoundingClientRect().bottom >= y) { cell = c; break; } }
  }
  if (!cell) return null;
  return { day: cell.dataset.day, offset: cell.getBoundingClientRect().top - gr.top };
}
export function restoreAnchor(a) {
  if (!a) return;
  const grid = $('#calView .cal-grid'); if (!grid) return;
  const cell = grid.querySelector(`.cal-cell[data-day="${a.day}"]`); if (!cell) return;
  const delta = (cell.getBoundingClientRect().top - grid.getBoundingClientRect().top) - a.offset;
  if (grid.scrollHeight > grid.clientHeight + 4) grid.scrollTop += delta; else window.scrollBy(0, delta);
}

export function monthHTML() {
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const { lo, hi } = calWindow();
  const rangeStart = (() => { const first = lo + '-01'; const dow = new Date(first + 'T00:00:00Z').getUTCDay(); return addDaysISO(first, -dow); })();
  const lastDay = (() => { const d = new Date(Date.UTC(+hi.slice(0, 4), +hi.slice(5, 7), 0)); return d.toISOString().slice(0, 10); })();
  const rangeEnd = (() => { const dow = new Date(lastDay + 'T00:00:00Z').getUTCDay(); return addDaysISO(lastDay, 6 - dow); })();

  const evs = allEvents().filter(visible);
  // evergreen (season-long / 'seasonal') events stay OUT of the day grid (they'd flood every cell).
  // The "Ongoing this season" strip that used to surface them was removed for vertical space
  // (owner) — they remain reachable via the Find/add search popover and the agenda view.

  // multi-day (non-evergreen, non-recurring) events → TRUE spanning BARS: one element per event per week,
  // spanning its day columns, so the FULL title shows across the width (Notion-style). Greedy lane packing.
  const spanEvents = [];   // { ev, s, en, fullEnd, lane }  — s/en clamped to the visible range; fullEnd = real end (dimming)
  {
    const seen = new Set();
    for (const e of evs) {
      if (isEvergreen(e) || !isMultiDay(e) || isRecurring(e) || seen.has(e.id)) continue;
      seen.add(e.id);
      const s = e.date.slice(0, 10), en = (e.endDate && parseISO(e.endDate)) ? e.endDate.slice(0, 10) : s;
      const cs = s < rangeStart ? rangeStart : s, ce = en > rangeEnd ? rangeEnd : en;
      if (cs > rangeEnd || ce < rangeStart) continue;
      spanEvents.push({ ev: e, s: cs, en: ce, fullEnd: en });
    }
    spanEvents.sort((a, b) => a.s.localeCompare(b.s) || b.en.localeCompare(a.en));   // earlier start, then longer, for stable lanes
    const laneEnd = [];   // laneEnd[l] = last day still covered in lane l
    for (const sp of spanEvents) { let l = 0; while (l < laneEnd.length && laneEnd[l] >= sp.s) l++; laneEnd[l] = sp.en; sp.lane = l; }
  }

  // single-day events + recurring occurrences bucket per day (multi-day non-recurring are bars, above)
  const singlesByDay = new Map();
  for (const e of evs) {
    if (isEvergreen(e) || (isMultiDay(e) && !isRecurring(e))) continue;
    for (const occ of recurOccurrences(e, rangeStart, rangeEnd)) {
      const s = occ.date;
      if (!singlesByDay.has(s)) singlesByDay.set(s, []);
      singlesByDay.get(s).push(e);
    }
  }
  for (const list of singlesByDay.values()) list.sort((a, b) => (a.time || '~').localeCompare(b.time || '~'));
  // single-day chip (event; tasks/birthdays have their own builders)
  const singleChip = (e) => {
    const tm = fmt12(e.time);
    const time = tm ? `<span class="cc-time">${esc(tm)}</span>` : '';
    const rec = isRecurring(e) ? '<span class="cc-recur" aria-hidden="true">↻</span>' : '';
    return `<button class="cal-chip cat-${esc(catOf(e))}${tm ? ' timed' : ''}${isRecurring(e) ? ' recurring' : ''}" data-ev="${esc(e.id)}" title="${esc(e.title)}${isRecurring(e) ? ' (repeats ' + esc(e.recur) + ')' : ''}">${time}${rec}<span class="cc-t">${esc(stripEmoji(e.title))}</span></button>`;
  };

  // ---- render week by week: a lane layer of spanning bars sits over the row of 7 day cells ----
  let out = '', day = rangeStart, w = 0;
  while (day <= rangeEnd) {
    const wStart = day, wEnd = addDaysISO(wStart, 6);
    // month separator sentinel above the week that contains a 1st (or the very first week)
    const firstOfMonth = wStart.slice(8, 10) === '01' ? wStart : (wEnd.slice(8, 10) < wStart.slice(8, 10) ? wEnd.slice(0, 8) + '01' : null);
    const sepYm = w === 0 ? lo : (firstOfMonth ? firstOfMonth.slice(0, 7) : null);
    if (sepYm) out += `<div class="cal-msep" data-ym="${esc(sepYm)}" role="heading" aria-level="3">${esc(MONTHS_LONG[+sepYm.slice(5, 7) - 1])} ${esc(sepYm.slice(0, 4))}</div>`;

    // spanning bars overlapping this week — grid-column start/end gives the FULL-WIDTH bar + full title
    const bars = spanEvents.filter(sp => sp.s <= wEnd && sp.en >= wStart).map(sp => {
      const segS = sp.s < wStart ? wStart : sp.s, segE = sp.en > wEnd ? wEnd : sp.en;
      return { sp, startCol: daysBetween(wStart, segS), endCol: daysBetween(wStart, segE),
        roundedL: sp.s >= wStart, roundedR: sp.en <= wEnd, dimmed: sp.fullEnd < TODAY };   // dim ONLY a fully-ended event, never an ongoing stay
    });
    const barRows = bars.reduce((m, b) => Math.max(m, b.sp.lane + 1), 0);
    const barsHTML = bars.map(b => {
      const e = b.sp.ev, ttl = esc(stripEmoji(e.title));
      const cls = `cal-bar cat-${esc(catOf(e))}${b.dimmed ? ' bar-past' : ''}${b.roundedL ? '' : ' seg-l'}${b.roundedR ? '' : ' seg-r'}`;
      const arr = b.roundedL ? '' : '<span class="cc-cont" aria-hidden="true">‹ </span>';
      return `<button class="${cls}" style="grid-column:${b.startCol + 1}/${b.endCol + 2};grid-row:${b.sp.lane + 1}" data-ev="${esc(e.id)}" title="${esc(e.title)}">${arr}<span class="cc-t">${ttl}</span></button>`;
    }).join('');

    // 7 day cells: day number + single-day chips + "+N more" (bars are the layer above, not per cell)
    let cellsHTML = '';
    for (let c = 0; c < 7; c++) {
      const date = addDaysISO(wStart, c), isToday = date === TODAY, past = date < TODAY, weekend = c === 0 || c === 6;
      const singles = singlesByDay.get(date) || [], tks = tasksOn(date), bds = birthdaysOn(date);
      const items = [...singles.map(e => ({ ev: e })), ...bds.map(b => ({ bd: b })), ...tks.map(t => ({ tk: t }))];
      const shown = items.length > MONTH_SINGLES ? MONTH_SINGLES - 1 : items.length;
      const chips = items.slice(0, shown).map(x => x.tk ? taskChipHTML(x.tk) : x.bd ? birthdayChipHTML(x.bd) : singleChip(x.ev)).join('');
      const moreN = items.length - shown;
      const more = moreN > 0 ? `<button type="button" class="cal-more" data-day="${esc(date)}">+${moreN} more</button>` : '';
      const bk = singles.some(e => e.bookBy) ? `<span class="bk-dot" role="img" aria-label="has a booking deadline" title="has a booking deadline"></span>` : '';
      const planN = (getPlan(date)?.stops || []).length;
      const planMark = planN ? `<button type="button" class="plan-dot" data-planday="${esc(date)}" title="${planN}-stop day plan — open" aria-label="Open the day plan for ${esc(date)}, ${planN} stop${planN === 1 ? '' : 's'}">📋</button>` : '';
      const nEv = singles.length + bars.filter(b => b.startCol <= c && b.endCol >= c).length;
      const aria = `${esc(date)}, ${nEv} event${nEv === 1 ? '' : 's'}${tks.length ? `, ${tks.length} task${tks.length === 1 ? '' : 's'}` : ''}`;
      const dayN = date.slice(8, 10).replace(/^0/, '');
      const label = date.slice(8, 10) === '01' ? `${esc(MONTHS_LONG[+date.slice(5, 7) - 1])} ${dayN}` : dayN;
      const cls = ['cal-cell', isToday && 'today', past && 'past', weekend && 'weekend'].filter(Boolean).join(' ');
      cellsHTML += `<div class="${cls}" data-day="${esc(date)}">
        <span class="cal-row"><button type="button" class="cal-date" data-day="${esc(date)}" aria-label="${aria}">${label}</button>${bk}${planMark}</span>
        <div class="cal-cbody">${chips}${more}</div></div>`;
    }
    out += `<div class="cal-week" style="--barrows:${barRows}">${barsHTML ? `<div class="cal-bars">${barsHTML}</div>` : ''}<div class="cal-weekgrid">${cellsHTML}</div></div>`;
    day = addDaysISO(wStart, 7); w++;
  }
  return `<div class="cal-dowrow">${dows.map(x => `<div class="cal-dow">${esc(x)}</div>`).join('')}</div><div class="cal-grid cal-endless">${out}</div>`;
}

// ---- endless-scroll reactions ----
function scrollTargetTo(el, smooth, align) {
  if (!el) return;
  const grid = $('#calView .cal-grid');
  // 'instant' (not 'auto') for the non-smooth case: 'auto' follows the global html{scroll-behavior:smooth}
  // so "instant" positioning would actually animate — and a positioning scroll toward today's month (a
  // large offset) still running when you switch tabs clamps to the next page's BOTTOM. 'instant' jumps.
  const behavior = smooth ? 'smooth' : 'instant';
  if (grid && grid.scrollHeight > grid.clientHeight + 4) {
    // compact: the grid scrolls internally — scrollIntoView scrolls EVERY ancestor and would
    // drag the window past the app shell (footer sliver); move only the grid
    const delta = el.getBoundingClientRect().top - grid.getBoundingClientRect().top
      - (align === 'center' ? (grid.clientHeight - el.getBoundingClientRect().height) / 2 : 0);
    grid.scrollTo({ top: grid.scrollTop + delta, behavior });
  } else {
    el.scrollIntoView({ behavior, block: align });   // normal mode: the window scrolls (scroll-margin clears the sticky chrome)
  }
}
export function scrollToMonth(ym, smooth) { scrollTargetTo($(`#calView .cal-msep[data-ym="${ym}"]`), smooth, 'start'); }
export function scrollToDay(iso, smooth) { scrollTargetTo($(`#calView .cal-cell[data-day="${iso}"]`), smooth, 'center'); }
// watch scrolling; report the month whose separator is closest above the viewport top → the
// coordinator updates label / mini-nav / cockpit ("the rest of the page reacts").
export function wireEndless(onMonth, onExtend) {
  const grid = $('#calView .cal-grid'); if (!grid) return;
  let raf = 0, lastYm = '';
  // infinite scroll: -1 when within ~a screen of the top, +1 near the bottom, else 0. Works in both
  // scroll modes (internal grid ≥821px, window <821px).
  const nearEdge = () => {
    if (grid.scrollHeight > grid.clientHeight + 4) {   // internal grid scroll
      // load ~a screen ahead of the edge, but never more than 40% of the scroll range — so a CENTRED
      // month (the entry state) is never inside both edges' trigger zones on a tall screen (→ no runaway).
      const buf = Math.min(grid.clientHeight, (grid.scrollHeight - grid.clientHeight) * 0.4);
      if (grid.scrollTop < buf) return -1;
      if (grid.scrollTop > grid.scrollHeight - grid.clientHeight - buf) return 1;
      return 0;
    }
    const cells = grid.querySelectorAll('.cal-cell[data-day]');
    if (!cells.length) return 0;
    const top = cells[0].getBoundingClientRect().top, bot = cells[cells.length - 1].getBoundingClientRect().bottom;
    // same proportional cap as the internal-grid branch: never more than 40% of the scrollable extent,
    // so a centred month can't sit inside both edges' trigger zones on a tall-but-narrow viewport.
    const buf = Math.min(window.innerHeight, Math.max(0, (bot - top) - window.innerHeight) * 0.4);
    if (top > -buf) return -1;
    if (bot < window.innerHeight + buf) return 1;
    return 0;
  };
  const topline = () => {
    // month of the day cell at the READING LINE (middle of the grid's visible box, middle
    // column). The sentinels mark week TOPS and a week can straddle two months — the cell
    // under the line is what the user is actually looking at, in both scroll modes.
    const gr = grid.getBoundingClientRect();
    const x = gr.left + gr.width / 2;
    const y = (Math.max(gr.top, 0) + Math.min(gr.bottom, window.innerHeight)) / 2;
    const day = document.elementFromPoint(x, y)?.closest?.('.cal-cell[data-day]')?.dataset.day;
    if (day) return day.slice(0, 7);
    // fallback (overlay under the line, empty region): last month sentinel above it
    const seps = $$('#calView .cal-msep');
    if (!seps.length) return '';
    let cur = seps[0].dataset.ym;
    for (const s of seps) { if (s.getBoundingClientRect().top <= y) cur = s.dataset.ym; else break; }
    return cur;
  };
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (grid.offsetParent === null) return;   // hidden (left the route) — every rect is 0 and topline would pick the LAST month, clobbering viewY/viewM
      const ym = topline();
      if (ym && ym !== lastYm) { lastYm = ym; onMonth(+ym.slice(0, 4), +ym.slice(5, 7) - 1); }
      if (onExtend && !_extending) {   // grow the window when you reach an end (anchored re-render, no jump)
        const dir = nearEdge();
        const now = Date.now();
        if (dir && now - _lastExtend > 200) {   // cooldown: a pinned edge-scroll can't extend every frame
          _lastExtend = now; _extending = true; try { onExtend(dir); } finally { _extending = false; }
        }
      }
    });
  };
  grid.addEventListener('scroll', onScroll, { passive: true });          // compact: the grid scrolls internally
  _endlessOnScroll = onScroll;                                            // persistent listeners delegate to the CURRENT render's handler
  if (!_endlessWired) {
    _endlessWired = true;
    const relay = () => _endlessOnScroll && _endlessOnScroll();
    window.addEventListener('scroll', relay, { passive: true });          // normal mode: the page scrolls
    document.getElementById('main')?.addEventListener('scroll', relay, { passive: true });
  }
}
let _endlessWired = false, _endlessOnScroll = null, _extending = false, _lastExtend = 0;

// ---- month cockpit: up next · book by · tasks due ----
function sevOf(iso) { const d = daysBetween(TODAY, iso); if (d === null) return ''; if (d < 0) return 'overdue'; if (d <= 14) return 'due-soon'; return 'upcoming'; }
export function panelHTML() {
  const monthKey = `${viewY}-${pad(viewM + 1)}`;
  const isPast = monthKey < TODAY.slice(0, 7);
  const evs = allEvents().filter(visible);
  // full (uncapped) lists so the count badge + "+N more" are honest, then a display slice.
  // Up next = discrete upcoming events. Exclude the 'seasonal' category (this dataset's evergreen /
  // ongoing / permanent bucket — teamLab, "retro hunting"; genuinely-dated seasonal things use the
  // fireworks/festival/holiday/nature categories instead) AND any long-span residency (isEvergreen).
  const upAll = evs.filter(e => !isEvergreen(e) && catOf(e) !== 'seasonal' && e.date.slice(0, 7) === monthKey && e.date.slice(0, 10) >= TODAY)
    .sort((a, b) => a.date.localeCompare(b.date));
  const deadAll = evs.filter(e => e.bookBy && /^\d{4}-\d{2}-\d{2}$/.test(e.bookBy) && e.bookBy.slice(0, 7) <= monthKey && (e.endDate || e.date).slice(0, 10) >= TODAY)
    .sort((a, b) => a.bookBy.localeCompare(b.bookBy));
  const taskAll = allTasks().filter(t => t.date.slice(0, 7) === monthKey).sort((a, b) => a.date.localeCompare(b.date));
  const upnext = upAll.slice(0, 5), deadlines = deadAll.slice(0, 5), tasks = taskAll.slice(0, 6);
  const more = (total, shown) => total > shown ? `<button type="button" class="cp-more" data-goagenda>+${total - shown} more →</button>` : '';
  const count = (n) => n ? ` <span class="cp-count">${n}</span>` : '';

  const upHTML = upnext.length ? upnext.map(e => {
    const d = daysBetween(TODAY, e.date.slice(0, 10));
    const cd = d == null ? '' : d <= 0 ? 'now' : `${d}d`;
    return `<button class="cp-up" data-ev="${esc(e.id)}">
      <span class="cp-cd cat-${safeCat(e)}">${esc(cd)}<small>${esc(fmtShort(e.date))}</small></span>
      <span class="cp-uptt">${esc(e.title)}</span></button>`;
  }).join('') + more(upAll.length, upnext.length) : `<p class="cp-empty">${isPast ? 'This month has passed.' : 'Nothing more coming up this month.'}</p>`;

  const dlHTML = deadlines.length ? deadlines.map(e => {
    const sev = sevOf(e.bookBy), days = daysBetween(TODAY, e.bookBy);
    const badge = days < 0 ? 'overdue' : `${days}d`;
    return `<button class="cp-deadline" data-ev="${esc(e.id)}">
      <span class="cp-dot sev-${sev}"></span>
      <span class="cp-body"><span class="cp-title">${esc(e.title)}</span>
        <span class="cp-sub">book by ${esc(fmtShort(e.bookBy))}</span></span>
      <span class="cp-badge sev-${sev}">${esc(badge)}</span></button>`;
  }).join('') + more(deadAll.length, deadlines.length) : `<p class="cp-empty">Nothing to book${isPast ? '.' : " — you're clear 🎏"}</p>`;

  const taskHTML = tasks.length ? tasks.map(t => `<button class="cp-task" data-task="${esc(t.taskId)}" title="Open on the checklist">
    <span class="cp-tdue">${esc(fmtShort(t.date))}</span>
    <span class="cp-ttt">${esc(t.title)}</span>
    <span class="cp-tgo" aria-hidden="true">›</span></button>`).join('') + more(taskAll.length, tasks.length) : `<p class="cp-empty">No due dates — set them on the checklist.</p>`;

  return `<h3 class="cp-head">Up next</h3>
    <div class="cp-list">${upHTML}</div>
    <hr class="cp-hr"><h3 class="cp-head">Book by${count(deadAll.length)}</h3><div class="cp-list">${dlHTML}</div>
    <hr class="cp-hr"><h3 class="cp-head">Tasks due${count(taskAll.length)}</h3><div class="cp-list">${taskHTML}</div>`;
}
export function wirePanel() {
  $$('#calPanel .cp-up, #calPanel .cp-deadline').forEach(b => b.addEventListener('click', () => {
    const ev = allEvents().find(x => x.id === b.dataset.ev); if (ev) openSidePanel(ev, b);
  }));
  $$('#calPanel .cp-task').forEach(b => b.addEventListener('click', () => gotoTask(b.dataset.task)));
  $$('#calPanel .cp-more').forEach(b => b.addEventListener('click', () => goAgenda()));   // "+N more" → the full uncapped agenda
}

// ---- day popover ----
// 📋 day-plan marker → jump to Plan a Day for that date (plan is a lazy route; mount it first,
// then fire jwh:plan-goto which plan.js listens for to select + centre the date).
function openDayPlan(date) {
  if (!date) return;
  if (location.hash !== '#/plan') location.hash = '#/plan';
  ensureRoute('plan').then(() => requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('jwh:plan-goto', { detail: { date } }))));
}

export function wireCells() {
  $$('#calView .cal-cell[data-day]').forEach(c => {
    // the .cal-date button is the keyboard-focusable trigger; its click bubbles here. A chip click
    // opens the event; on a day WITH items, a bare click peeks the day popover; on an EMPTY day it
    // goes straight to the new-event editor (Notion-style — no empty popover in the way).
    c.addEventListener('click', (e) => {
      const pd = e.target.closest('.plan-dot');
      if (pd) { e.stopPropagation(); openDayPlan(pd.dataset.planday); return; }   // 📋 marker → open that day's plan
      if (_calDragSelected) { _calDragSelected = false; return; }              // a range-drag just ended — don't also add/peek
      if (_plainClickDone) { _plainClickDone = false; return; }               // finish() already handled this click (pointer-capture fallback browsers)
      // date number or "+N more" → zoom into that WEEK — POINTER only (e.detail 0 = keyboard
      // activation, which keeps the popover: it has tasks, per-event +G and add-event that the
      // week view lacks — the only keyboard path to them)
      if (e.detail > 0 && e.target.closest('.cal-date, .cal-more')) { goWeek(c.dataset.day); return; }
      const chip = e.target.closest('.cal-chip');
      if (chip) {
        if (chip.dataset.task) { gotoTask(chip.dataset.task); return; }     // task chip → jump to the checklist item
        if (chip.dataset.person) { gotoPerson(chip.dataset.person); return; }   // birthday chip → open that person
        const ev = allEvents().find(x => x.id === chip.dataset.ev); if (ev) openSidePanel(ev, chip); return;
      }
      if (c.querySelector('.cal-chip, .cal-more')) dayPopover(c.dataset.day, c);   // day has events/tasks → peek (pointer path; keyboard = Enter on the date → week)
      else openModal(null, c.dataset.day);                                        // empty day → add straight away
    });
  });
  // multi-day BARS live in the lane layer (a sibling of the day cells), so the per-cell handler above
  // never sees them — give them their own click/Enter → open the event.
  $$('#calView .cal-bar[data-ev]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const ev = allEvents().find(x => x.id === b.dataset.ev); if (ev) openSidePanel(ev, b);
    });
  });
}
// Notion-style: drag across the month grid to select a date range → opens the editor pre-filled with
// that span. A plain click (no drag) falls through to wireCells (add / peek). Chips/date-buttons excluded.
let _calDragSelected = false;
let _plainClickDone = false;   // set by finish()'s plain-click branch; consumed by the cell click listener
export function wireMonthSelect() {
  const grid = $('#calView .cal-grid');
  if (!grid || grid.dataset.selWired) return;
  grid.dataset.selWired = '1';
  const cellAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.cal-cell[data-day]');
  const clear = () => $$('#calView .cal-cell.cal-selecting').forEach(c => c.classList.remove('cal-selecting'));
  const paint = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    $$('#calView .cal-cell[data-day]').forEach(c => c.classList.toggle('cal-selecting', c.dataset.day >= lo && c.dataset.day <= hi));
  };
  let startDay = null, moved = false;
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.cal-chip, .cal-more, button, a')) return;   // let chips/date-button/more work
    const cell = e.target.closest('.cal-cell[data-day]'); if (!cell) return;
    startDay = cell.dataset.day; moved = false;
    try { grid.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    paint(startDay, startDay);
  });
  grid.addEventListener('pointermove', (e) => {
    if (startDay == null) return;
    const cell = cellAt(e.clientX, e.clientY); if (!cell) return;
    if (cell.dataset.day !== startDay) moved = true;
    paint(startDay, cell.dataset.day);
  });
  const finish = (e) => {
    if (startDay == null) return;
    const endDay = cellAt(e.clientX, e.clientY)?.dataset.day || startDay;
    const s = startDay; startDay = null; clear();
    if (!moved || endDay === s) {
      // plain click on the cell BODY. setPointerCapture retargets the ensuing click at the GRID,
      // so the per-cell click listener never fires for real pointers — handle the peek/add here.
      // (Chips/buttons never reach this: pointerdown skips them, so their own clicks still work.)
      const cell = $(`#calView .cal-cell[data-day="${s}"]`);
      if (cell) {
        _plainClickDone = true; setTimeout(() => { _plainClickDone = false; }, 0);   // if capture FAILED, the click still lands on the cell — don't double-handle
        if (cell.querySelector('.cal-chip, .cal-more')) dayPopover(s, cell);   // day has items → peek
        else openModal(null, s);                                               // empty day → add
      }
      return;
    }
    _calDragSelected = true; setTimeout(() => { _calDragSelected = false; }, 350);
    const lo = s < endDay ? s : endDay, hi = s < endDay ? endDay : s;
    openModal(null, lo, hi);
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', () => { startDay = null; clear(); });
}
// drag a USER event chip onto another day to reschedule (baked events are fixed)
export function wireReschedule() {
  const view = $('#calView');
  if (!view) return;
  makeMovable(view, {
    // .recurring excluded: a recurring chip is one occurrence — dragging it would move the whole series.
    // Multi-day events are .cal-bar (never .cal-chip), so they can't match; rescheduleEvent hard-guards them too.
    itemSelector: '.cal-chip[data-ev]:not(.recurring)', label: 'event',
    canDrag: () => true,                       // any event can be rescheduled now (baked → override layer)
    idOf: el => el.dataset.ev,
    targetSelector: '.cal-cell[data-day]', keyOf: t => t.dataset.day,
    onMove: rescheduleEvent,
  });
}
