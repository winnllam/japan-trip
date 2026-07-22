'use strict';
// Top bar (theme + live countdown + top-right notifications bell) and the home widgets.
// Builds one unified alert stream from deadlines, book-by windows, checklist due dates,
// and calendar events, then drives the bell badge, the dropdown, and the widgets.

import { $, $$, esc } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { countdown, windowStatus, fmtShort, nowISO } from './lib/dates.js';
import { computeAlerts } from './lib/notify.js';
import { prefersReducedMotion } from './motion.js';
import { fetchWeather, wmoInfo } from './lib/weather.js';
import { fetchUsdPerJpy } from './lib/rates.js';
import { loadPlaces } from './lib/places.js';
import { checklistItems } from './checklist-page.js';
import { isBirthday } from './lib/people.js';
import { spendSummary, parseSpend, monthTotal, pruneSpend } from './lib/spend.js';
import { allEvents } from './calendar.js';
import { tripWindow, stayForNight, stayBooked } from './lib/trip.js';
import { loadPlans } from './lib/dayplan.js';
import { summary, fmtYen } from './lib/budget.js';
import { progress } from './lib/packing.js';
import { sekkiFor } from './lib/sekki.js';
import { legStatus, focusDays } from './lib/itinerary.js';

let DATA = null, TODAY = nowISO();

export function mountDashboard(data, today) {
  DATA = data;
  TODAY = today || nowISO();
  initTheme();
  renderSekki();
  renderCountdown();
  setInterval(renderCountdown, 60000);   // roll the countdown over at midnight without a reload (spec §6)
  wireBell();
  refresh();
  refreshWeather();   // async — re-fills the Today strip when the fetch lands
  refreshRates();     // async — the budget teaser picks the cached ¥→$ up on its next render
  document.addEventListener('jwh:data-changed', refresh);
  // Budget/packing mutations happen on their OWN routes and re-render locally; they intentionally
  // do NOT dispatch jwh:data-changed (that would trigger no-op re-renders across other listeners).
  // So landing back on the dashboard is the natural refresh trigger for their teasers.
  // A full refresh on landing (not just the teasers): the study widget + the reviews-due bell item
  // also read state mutated on #/study, which — like budget/packing — doesn't dispatch data-changed.
  document.addEventListener('jwh:route', (e) => { if (e.detail && e.detail.route === 'dashboard') { refresh(); refreshWeather(); } });
}

function gcDismissed() {
  // Keep a dismissal until 90 days AFTER its encoded @date, so a dismissed overdue item STAYS
  // dismissed (not resurrected the next day) while storage stays bounded. A RESCHEDULED date yields
  // a new @date → a new id → a fresh, non-dismissed alert (this gc never touches that new id).
  // Legacy bare ids (no @date) can no longer match a computed alert id, so drop them.
  const d = get(KEYS.dismissed, []) || [];
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const keep = d.filter(id => { const at = String(id).lastIndexOf('@'); return at >= 0 && String(id).slice(at + 1) >= cutoff; });
  if (keep.length !== d.length) set(KEYS.dismissed, keep);
}

function refresh() {
  TODAY = nowISO();   // a tab left open across midnight must not keep computing against yesterday
  gcDismissed();
  renderSekki();      // date-derived (sekki/kō/date lines) — must roll over at midnight too
  const alerts = computeAlerts(buildItems(), TODAY, get(KEYS.dismissed, []) || []);
  renderBadge(alerts);
  renderPanel(alerts);
  renderWidgets(alerts);
  refreshTeasers();
}

// Budget + packing teasers — read localStorage fresh each call (no staleness). Cheap (two
// teaser() calls), so the dual trigger (refresh + jwh:route) isn't a meaningful double-render.
// budget/packing DON'T dispatch jwh:data-changed by design (see mountDashboard) — don't "fix"
// this into a global dispatch.
function refreshTeasers() {
  const s = summary(DATA.budget || { currency: 'JPY', oneTime: [], monthly: [] }, get(KEYS.budget, {}) || {});
  const savings = (get(KEYS.budget, {}) || {}).savings || 0;
  const fx = get(KEYS.fx, null);
  const usd = (fx && Number.isFinite(fx.usd) && Number.isFinite(fx.at) && Date.now() - fx.at < 48 * 3600e3) ? fx.usd : null;
  const arrived = countdown(DATA.meta?.arrival_date || '2026-10-19', nowISO()).phase === 'arrived';
  // "to land" is a paid sunk cost once arrived — show monthly burn instead. USD twin follows suit.
  const yenFig = arrived ? s.monthlyTotal : s.toLand;
  const inUsd = (usd && yenFig > 0) ? ` (~$${Math.round(yenFig * usd).toLocaleString('en-US')})` : '';
  // actuals beat estimates: with real spends in the trailing 30 days, show measured burn + runway
  const bs = get(KEYS.budget, {}) || {};
  const sp = arrived ? spendSummary((get(KEYS.spend, {}) || {}).items || [], s.monthlyTotal, bs.savings || 0, bs.monthlyIncome || 0, nowISO(), bs.savingsAsOf) : null;
  // real logged spends ALWAYS beat the onboarding nudge — actuals are the feature's whole premise
  const budgetText = sp
    ? `spent ${fmtYen(sp.actualThisMonth)}${s.monthlyTotal > 0 ? ` of ${fmtYen(s.monthlyTotal)}` : ''}${sp.confident ? ` · runway ~${sp.actualRunwayMonths === Infinity ? '∞' : sp.actualRunwayMonths + ' mo'} (logged)` : ' · keep logging for real runway'}`
    : (s.oneTimeTotal === 0 && s.monthlyTotal === 0 && savings === 0)
      ? 'Set up your budget'
      : `Runway: ${s.runwayMonths === Infinity ? 'sustainable' : s.runwayMonths + ' mo'} · ${arrived ? `burn ${fmtYen(s.monthlyTotal)}/mo` : `to land ${fmtYen(s.toLand)}`}${inUsd}`;
  teaser('#tBudget', budgetText, '#/budget');

  renderProgress();   // budget/packing bits inside 進捗 read localStorage fresh — same trigger as the teasers
}

function dismiss(id) {
  if (!id) return;
  const d = get(KEYS.dismissed, []) || [];
  set(KEYS.dismissed, [...d, id]); refresh();
}

function buildItems() {
  const checks = get(KEYS.checklist, {}) || {};
  const items = [];
  // dismiss ids encode the date (@when) so re-setting a date yields a FRESH, non-dismissed alert
  (DATA.timeSensitive || []).forEach((t, i) => {
    if (t.dueBy) items.push({ id: 'ts-' + i + '@' + t.dueBy, title: t.item, when: t.dueBy, kind: 'deadline', detail: t.action });
  });
  (DATA.bookByTimeline || []).forEach((b) =>
    items.push({ id: b.id + '@' + b.when, title: b.what, when: b.when, kind: 'book', detail: b.action }));
  const userDue = get(KEYS.due, {}) || {};
  checklistItems(DATA).forEach(it => {           // only YOUR added due dates notify (baked deadlines already live in timeSensitive/bookBy)
    if (userDue[it.id] && !checks[it.id]) items.push({ id: 'ck-' + it.id + '@' + userDue[it.id], title: it.task, when: userDue[it.id], kind: 'task', detail: it.note });
  });
  allEvents().forEach(e => {
    const start = e.date.slice(0, 10);
    if (start >= TODAY) items.push({ id: 'ev-' + e.id + '@' + start, title: e.title, when: start, kind: 'event', detail: e.area }); // future starts only — not already-running seasons
    if (e.bookBy && e.source === 'user') items.push({ id: 'bk-' + e.id + '@' + e.bookBy, title: 'Book: ' + e.title, when: e.bookBy, kind: 'book', detail: e.bookingNotes });   // baked book-by already covered by bookByTimeline — don't double-count
  });
  // Drop dead history: a deadline/book/task more than 30 days past isn't actionable — it's just
  // clutter that re-floods the bell. Future + ≤30-day-past items are kept (still worth surfacing).
  const floor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return items.filter(it => it.when >= floor);
}

// ---- hero: the season band (lib/sekki.js) — sekki name, current/next kō, season kanji ----
const WDAY_JP = ['日', '月', '火', '水', '木', '金', '土'];
const WDAY_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function renderSekki() {
  const s = sekkiFor(TODAY);
  if (!s) return;   // lookup failed — the static "My Japan Trip" heading stays
  const h1 = $('#heroTitleH');
  if (h1) h1.innerHTML = `${esc(s.sekki.kanji)}<small>${esc(s.sekki.romaji)} — ${esc(s.sekki.en)} · ${esc(fmtShort(s.sekki.startISO))} – ${esc(fmtShort(s.sekki.endISO))}</small>`;
  const ko = $('#sekkiKo');
  if (ko) {
    ko.hidden = false;
    ko.innerHTML = `<span lang="ja">七十二候</span> <b lang="ja">${esc(s.ko.kanji)}</b> <em>${esc(s.ko.romaji)}</em> — ${esc(s.ko.en)} · ${esc(fmtShort(s.ko.startISO))}–${esc(fmtShort(s.ko.endISO))}`
      + `<br><span class="next">next <span lang="ja">${esc(s.nextKo.kanji)}</span> — ${esc(s.nextKo.en)} · ${esc(fmtShort(s.nextKo.startISO))}</span>`;
  }
  const season = $('#sekkiSeason');
  if (season) season.innerHTML = `<span class="k" lang="ja">${esc(s.season.kanji)}</span><span class="e">${esc(s.season.en)}</span>`;
  // date lines in the column headings
  const t = new Date(TODAY + 'T00:00:00Z'), dow = t.getUTCDay();
  const rom = $('#todayRom');
  if (rom) rom.textContent = `today · ${WDAY_EN[dow]} ${fmtShort(TODAY).toLowerCase()}`;
  const wk = $('#weekRom');
  if (wk) {
    const end = new Date(t); end.setUTCDate(end.getUTCDate() + 6);
    wk.textContent = `this week · ${fmtShort(TODAY).toLowerCase()} – ${fmtShort(end.toISOString().slice(0, 10)).toLowerCase()}`;
  }
}

// ---- countdown: the hinomaru year dial (canonical) + small topbar copy ----
// Recomputes "today" each call so the minute-timer (mountDashboard) rolls the count over at midnight.
const DIAL_C = 2 * Math.PI * 52;   // circumference of the r=52 dial circle
const TRIP_DAYS = 26;              // trip length, land HND 2026-10-19 → depart 2026-11-13 (inclusive)
function renderCountdown() {
  if (nowISO() !== TODAY) refresh();   // midnight rolled over — recompute alerts/widgets, not just the number
  const c = countdown(DATA.meta?.arrival_date || '2026-10-19', nowISO());
  const arrived = c.phase === 'arrived';
  // day-in-Japan counts INCLUSIVELY (landing day = day 1) — matches the Progress card
  const dayN = arrived ? (c.days ?? 0) + 1 : c.days;
  // topbar (decorative, aria-hidden in markup)
  const el = $('#countdown');
  if (el) {
    const unit = arrived ? (dayN === 1 ? 'DAY IN' : 'DAYS IN') : (dayN === 1 ? 'DAY TO HND' : 'DAYS TO HND');
    const html = `<span class="cd-num">${dayN ?? ''}</span><span class="cd-label">${unit}</span><span class="cd-credit">CREDIT 01</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle('arrived', arrived);
  }
  // dial (the aria-live region) — only mutate when the day count actually changes, so the
  // minute-timer never re-announces the same number to screen readers.
  const hero = $('#heroCount');
  if (hero) {
    const num = String(dayN ?? '');
    const numEl = hero.querySelector('.hc-num');
    if (numEl?.textContent !== num) {
      const unit = arrived ? `of ${TRIP_DAYS} 日` : (dayN === 1 ? 'day to HND' : 'days to HND');
      if (numEl) numEl.textContent = num;
      const unitEl = hero.querySelector('.hc-unit');
      if (unitEl) unitEl.textContent = unit;
      hero.setAttribute('aria-label', arrived ? `Day ${num} of ${TRIP_DAYS} in Japan` : `${num} days until landing`);
      // the red arc: elapsed share of the trip (CSS transitions the first set → a one-time draw-in)
      const arc = $('#dialArc');
      if (arc) arc.style.strokeDasharray = `${arrived ? Math.min(DIAL_C, (Number(dayN) / TRIP_DAYS) * DIAL_C).toFixed(1) : 0} 999`;
      const dateEl = $('.dial-cap');
      if (dateEl) dateEl.textContent = arrived ? 'landed HND · 2026-10-19' : 'HND · 2026-10-19';
    }
    hero.classList.toggle('arrived', arrived);
  }
}

// ---- bell + panel ----
function wireBell() {
  const bell = $('#notifBell'), panel = $('#notifPanel');
  if (!bell || !panel) return;
  if (bell.dataset.wired) return;   // guard: the two document-level listeners must mount once
  bell.dataset.wired = '1';
  panel.setAttribute('role', 'region');   // a non-modal dropdown, not a modal dialog (dialog would imply a focus trap we don't have)
  panel.setAttribute('aria-label', 'Notifications');
  const close = (restoreFocus) => { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); if (restoreFocus) bell.focus(); };
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    bell.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) setTimeout(() => panel.querySelector('button, a, [tabindex]')?.focus(), 20);   // move focus in
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== bell) close(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(true); });   // Esc closes + returns focus to the bell
}
function renderBadge(alerts) {
  const badge = $('#notifBadge');
  if (!badge) return;
  const n = alerts.length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.hidden = n === 0;
  const overdue = alerts.some(a => a.severity === 'overdue');
  badge.classList.toggle('hot', overdue);
}
const ICON = { deadline: '⚖️', book: '🎟️', task: '✅', event: '📅' };
const ROUTE_FOR = { deadline: '#/deadlines', book: '#/deadlines', task: '#/checklist', event: '#/calendar' };
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function renderPanel(alerts) {
  const panel = $('#notifPanel');
  if (!panel) return;
  if (!alerts.length) {
    panel.innerHTML = `<div class="np-head">Notifications</div><div class="np-empty">ALL CLEAR — STANDBY 🎏</div>`;
    return;
  }
  panel.innerHTML = `<div class="np-head">Notifications <button id="npClear" class="np-clear">dismiss all</button></div>
    <ul class="np-list">${alerts.slice(0, 30).map(a => `
      <li class="np-item sev-${a.severity}">
        <span class="np-ico" aria-hidden="true">${ICON[a.kind] || '•'}</span>
        <a class="np-body" href="${ROUTE_FOR[a.kind] || '#/dashboard'}"><span class="np-title">${esc(clip(a.title, 76))}</span>
          <span class="np-when">${a.severity === 'overdue' ? 'overdue · ' : ''}${esc(fmtShort(a.when))}${a.days >= 0 ? ` · in ${a.days}d` : ''}</span></a>
        <button class="np-x" data-dismiss="${esc(a.id)}" aria-label="Dismiss">✕</button>
      </li>`).join('')}</ul>`;
  $$('#notifPanel .np-body').forEach(a => a.addEventListener('click', () => { panel.hidden = true; }));   // navigate (hash) + close
  $$('#notifPanel .np-x').forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const idx = $$('#notifPanel .np-x').indexOf(b);
    dismiss(b.dataset.dismiss);
    // dismiss() re-rendered the panel and destroyed the focused ✕ — keep keyboard focus in the list
    const xs = $$('#notifPanel .np-x');
    (xs[Math.min(idx, xs.length - 1)] || $('#notifBell'))?.focus();
  }));
  // swipe-to-dismiss (pointer; tap still navigates, vertical scroll preserved)
  const reduce = prefersReducedMotion();   // honours the app's ⚙ toggle as well as the OS setting
  $$('#notifPanel .np-item').forEach(li => {
    let sx = 0, dx = 0, dragging = false, captured = false;
    li.addEventListener('pointerdown', e => {
      if (e.target.closest('.np-x')) return;   // pressing ✕ is a dismiss click, never a swipe — don't hijack it
      sx = e.clientX; dx = 0; dragging = true; captured = false;
    });
    li.addEventListener('pointermove', e => {
      if (!dragging) return;
      dx = e.clientX - sx;
      if (Math.abs(dx) > 6) {
        // capture ONLY once a real drag starts — capturing on pointerdown retargets the ✕'s click
        // to the <li>, so tapping ✕ never fires its dismiss handler (the reported bug)
        if (!captured) { li.setPointerCapture?.(e.pointerId); captured = true; }
        e.preventDefault();
        if (!reduce) { li.style.transform = `translateX(${dx}px)`; li.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 180)); }
      }
    });
    const end = () => {
      if (!dragging) return; dragging = false;
      const id = li.querySelector('.np-x')?.dataset.dismiss;
      if (Math.abs(dx) > 90 && id) dismiss(id);
      else { li.style.transform = ''; li.style.opacity = ''; }
    };
    li.addEventListener('pointerup', end);
    li.addEventListener('pointercancel', end);
  });
  $('#npClear')?.addEventListener('click', () => {
    const d = get(KEYS.dismissed, []) || [];
    set(KEYS.dismissed, [...new Set([...d, ...alerts.map(a => a.id)])]); refresh();
    $('#notifBell')?.focus();   // the clicked button just re-rendered away
  });
}

// ---- home: promoted "needs me" cards + demoted teasers ----
function renderWidgets(alerts) {
  renderToday();
  renderHokkaido();
  renderWeek();
  renderSpend();
  fill('#wDeadlines', alerts.filter(a => a.kind === 'deadline' || a.kind === 'task' || a.kind === 'book'), 6);
  renderProgress();
  renderTeasers();
}

// ---- 北海道 Hokkaido week — the baked `itinerary` day-by-day, spotlit during the trip -----------
// "Add this page to the main page for the next couple of days": the widget SELF-HIDES outside the
// trip window (legStatus → null), and while travelling opens today + tomorrow to their full
// hour-by-hour while the other days collapse to a tap-to-expand <details>. tips.json's `itinerary`
// is the single source of truth for the schedule (the calendar events carry only summaries). Native
// <details> means no JS animation, so reduce-motion is a non-issue. Every dynamic string via esc().
function hokDayHTML(d, i, todayIdx, open) {
  const isToday = i === todayIdx;
  const rows = (Array.isArray(d.schedule) ? d.schedule : []).map(s =>
    `<li><span class="hok-t">${esc(s.t || '')}</span><span class="hok-w"><b>${esc(s.what || '')}</b>${s.note ? `<small>${esc(s.note)}</small>` : ''}</span></li>`).join('');
  const chips = (d.highlights || []).map(h => `<span class="hok-chip">${esc(h)}</span>`).join('');
  const notes = (d.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
  const fb = (d.fallback || []).length
    ? `<p class="hok-note"><b>Fallbacks:</b> ${d.fallback.map(f => esc(f)).join(' · ')}</p>` : '';
  const safety = d.safety ? `<p class="hok-safety"><b>⚠ Safety:</b> ${esc(d.safety)}</p>` : '';
  const move = d.move ? `<p class="hok-move">↝ ${esc(d.move)}</p>` : '';
  const cost = d.cost ? `<p class="hok-cost">${esc(d.cost)}</p>` : '';
  return `<details class="hok-day${isToday ? ' is-today' : ''}"${open ? ' open' : ''}>
    <summary><span class="hok-date"><b>${esc(fmtShort(d.date))}</b><small>${esc(d.dow || '')}</small></span>`
    + `<span class="hok-sum"><b>${esc(d.title)}</b><small>${esc(d.base || '')}${d.stay ? ` · ${esc(clip(d.stay, 48))}` : ''}</small></span>`
    + `${isToday ? '<span class="hok-badge">today</span>' : ''}</summary>`
    + `<div class="hok-detail">${move}${chips ? `<div class="hok-chips">${chips}</div>` : ''}`
    + `${rows ? `<ul class="hok-sched">${rows}</ul>` : ''}`
    + `${notes ? `<ul class="hok-notes">${notes}</ul>` : ''}${fb}${safety}${cost}</div></details>`;
}
function renderHokkaido() {
  const el = $('#wHokkaido');
  if (!el) return;
  const status = legStatus(DATA.itinerary, TODAY);
  if (!status) { el.hidden = true; return; }   // outside the trip window — stay out of the way
  el.hidden = false;
  const body = el.querySelector('.widget-body');
  if (!body) return;
  const focus = new Set(focusDays(status));
  const total = status.days.length;
  const todayDay = status.todayIdx >= 0 ? status.days[status.todayIdx] : null;
  const lead = status.phase === 'before'
    ? `Starts ${esc(fmtShort(status.start))} · ${total}-day leg — here's day one`
    : `Day ${status.todayIdx + 1} of ${total}${todayDay ? ` · ${esc(todayDay.base)}` : ''}`;
  body.innerHTML = `<p class="hok-lead">${lead}</p>`
    + status.days.map((d, i) => hokDayHTML(d, i, status.todayIdx, focus.has(i))).join('')
    + `<p class="hok-foot"><a href="#/calendar">open in the calendar →</a></p>`;
}

// Trip-mode band — leads the Today widget while a stay-event chain covers today
// (lib/trip.js). Links to #/emergency: the SW-cached page where the stay card lives
// (deliberate offline-page compromise). No animation — glanced daily.
function tripBandHTML() {
  const evs = allEvents();
  const w = tripWindow(evs, TODAY);
  if (!w) return '';
  const stay = stayForNight(evs, TODAY);
  if (!stay) return `<a class="w-tripband" href="#/emergency">✈️ Trip day ${w.day}/${w.total} — checkout day</a>`;
  if (!stayBooked(stay)) {
    const by = stay.bookBy ? ` — book by ${esc(fmtShort(stay.bookBy))}` : '';
    return `<a class="w-tripband w-tripband-warn" href="#/emergency">⚠ Trip day ${w.day}/${w.total} · tonight: NOT BOOKED${by}</a>`;
  }
  const name = String(stay.title).split(/stay:\s*/i).pop().replace(/\s*\(BOOKED\)\s*/i, '');
  return `<a class="w-tripband" href="#/emergency">✈️ Trip day ${w.day}/${w.total} · tonight: ${esc(clip(name, 44))}</a>`;
}


// 💴 Quick spend — one-line phone-first entry into the SAME jwh-spend-v1 the budget page
// reads ("1200 ramen" · "3.4k drinks yesterday"). SKIPS its own re-render while focus is
// inside the widget: an unrelated jwh:data-changed must never wipe a half-typed entry
// (review finding). Submit re-queries #spendInput AFTER the synchronous refresh — the
// dispatched event rebuilds the node, so a captured reference would be detached.
function renderSpend() {
  const el = $('#wSpend');
  if (!el) return;
  if (el.contains(document.activeElement)) return;   // mid-typing — totals catch up next refresh
  const items = (get(KEYS.spend, {}) || {}).items || [];
  el.querySelector('.widget-body').innerHTML = `
    <p class="spd-line" id="spendTot">${spendTotalsHTML(items)}</p>
    <form id="spendQuick" class="w-spend-form">
      <input id="spendInput" class="w-spend-in" type="text" inputmode="text" enterkeyhint="done"
        placeholder="1200 ramen" aria-label="Quick spend — amount then note, e.g. 1200 ramen" autocomplete="off">
      <button type="submit" class="w-spend-add" aria-label="Add spend">＋</button>
    </form>
    <p class="w-spend-hint" id="spendQHint" role="status"></p>`;
  el.querySelector('#spendQuick').addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = parseSpend(el.querySelector('#spendInput').value, nowISO());
    if (!parsed) { const h = el.querySelector('#spendQHint'); if (h) h.textContent = 'amount first — e.g. “1200 ramen”'; return; }
    const cur = (get(KEYS.spend, {}) || {}).items || [];
    const next = pruneSpend([{ id: 's' + Date.now(), ...parsed }, ...cur], nowISO());
    set(KEYS.spend, { v: 1, items: next });
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
    // focus never left the input, so the guard above SKIPPED the rebuild — reset explicitly
    // (same node): clear value + hint, recompute the totals line, keep the flow going.
    const inp = $('#spendInput');
    if (inp) { inp.value = ''; inp.focus({ preventScroll: true }); }
    const h = $('#spendQHint'); if (h) h.textContent = '';
    const tot = $('#spendTot');
    if (tot) tot.innerHTML = spendTotalsHTML(next);
  });
}

function spendTotalsHTML(items) {
  const todaySum = items.filter(i => i && i.date === TODAY).reduce((s, i) => s + (i.amount || 0), 0);
  return `<span lang="ja">今日</span> <b>¥${todaySum.toLocaleString()}</b><span class="sep">│</span><span lang="ja">月</span> <b>¥${monthTotal(items, TODAY.slice(0, 7)).toLocaleString()}</b><span class="sep">│</span><a href="#/budget">budget →</a>`;
}

// "今日 Today" — the lead almanac column: today's day plan, today's events, tasks due today.
function renderToday() {
  const el = $('#wToday');
  if (!el) return;
  const row = (href, t, title, small) =>
    `<li><a href="${href}"><span class="tdy-t">${t}</span><span class="tdy-what"><b>${title}</b>${small ? `<small>${small}</small>` : ''}</span></a></li>`;
  const bits = [];
  const plan = (loadPlans() || {})[TODAY];
  if (plan && plan.stops && plan.stops.length) {
    const t = plan.stops.find(s => s.startTime)?.startTime || '';
    bits.push(row('#/plan', esc(t || 'plan'), esc(clip(plan.title || 'Day plan', 44)), `${plan.stops.length} stop${plan.stops.length === 1 ? '' : 's'} · open the planner`));
  }
  allEvents()
    .filter(e => { const d = (e.date || '').slice(0, 10); const end = (e.endDate || '').slice(0, 10); return d === TODAY || (d < TODAY && end >= TODAY); })
    .slice(0, 3)
    .forEach(e => bits.push(row('#/calendar', esc(e.time || 'today'), esc(clip(e.title, 52)), e.area ? esc(clip(e.area, 44)) : '')));
  const due = get(KEYS.due, {}) || {};
  const checks = get(KEYS.checklist, {}) || {};
  checklistItems(DATA).filter(it => due[it.id] === TODAY && !checks[it.id]).slice(0, 2)
    .forEach(it => bits.push(row('#/checklist', 'due', esc(clip(it.task, 52)), '')));
  // 縁 birthdays — device-local People data; only ever appears ON the day (zero ambient noise)
  (get(KEYS.people, []) || []).filter(p => isBirthday(p.birthday, TODAY)).slice(0, 2)
    .forEach(p => bits.push(row('#/people', '🎂', esc(clip(String(p.name || ''), 40)) + '’s birthday', '')));
  const body = el.querySelector('.widget-body'); if (!body) return;
  body.innerHTML = tripBandHTML() + (bits.length
    ? `<ul class="tdy-list">${bits.join('')}</ul>`
    : `<p class="w-empty">Nothing on for today — <a href="#/plan">plan a day</a> or <a href="#/explore">find something</a>.</p>`);
}

// "今週 This week" — a horizontal chip strip of the next 7 days' events; stays carry booked state.
function renderWeek() {
  const el = $('#wWeek');
  if (!el) return;
  const body = el.querySelector('.widget-body'); if (!body) return;
  const end = new Date(TODAY + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 6);
  const endISO = end.toISOString().slice(0, 10);
  const evs = allEvents()
    .filter(e => { const d = (e.date || '').slice(0, 10); return d >= TODAY && d <= endISO; })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, 12);
  if (!evs.length) { body.innerHTML = `<p class="w-empty">A quiet week so far — <a href="#/calendar">open the calendar</a>.</p>`; return; }
  body.innerHTML = `<div class="awk-strip">${evs.map(e => {
    const d = new Date(e.date.slice(0, 10) + 'T00:00:00Z');
    const cat = /^[a-z]+$/.test(e.category || '') ? e.category : 'personal';
    const isStay = /^stay:/i.test(e.title || '');
    const status = isStay ? (stayBooked(e) ? '<small class="ok2">✓ booked</small>' : '<small class="warn2">not booked yet</small>') : '';
    return `<a class="awk-chip" href="#/calendar"><span class="d" lang="ja">${WDAY_JP[d.getUTCDay()]}<b>${d.getUTCDate()}</b></span>`
      + `<span class="dot" style="background:var(--c-${cat})" aria-hidden="true"></span>`
      + `<span class="w">${esc(clip(e.title, 60))}${status}</span></a>`;
  }).join('')}</div>`;
}

// ---- local weather strip (Open-Meteo, keyless) — top of the Today widget ----
const WX_FRESH_MS = 30 * 60e3;    // don't re-fetch more than every 30 min
const WX_MAX_AGE_MS = 3 * 3600e3; // never show a reading older than 3h (hide instead of lying)
// shape-validated cache read — get()'s type guard is inert with a null fallback, and a backup
// import can write ANY shape into jwh-wx-v1, so validate the fields this module dereferences
function wxCache() {
  const c = get(KEYS.weather, null);
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  if (!Number.isFinite(c.at) || c.at - Date.now() > 60e3) return null;   // non-numeric/NaN or future 'at' would defeat the age math
  if (!c.data || typeof c.data !== 'object' || typeof c.data.temp !== 'number') return null;
  return c;
}
function renderWxStrip() {
  const el = $('#wxStrip');
  if (!el) return;
  const c = wxCache();
  if (!c || Date.now() - c.at > WX_MAX_AGE_MS) { el.hidden = true; return; }
  const w = c.data, i = wmoInfo(w.code);
  el.hidden = false;
  el.innerHTML = `<span aria-hidden="true">${esc(i.emoji)}</span> ${esc(String(w.temp))}°`
    + (w.feels != null && w.feels !== w.temp ? ` <span class="wx-dim">feels ${esc(String(w.feels))}°</span>` : '')
    + ` · ${esc(i.label)}`
    + (w.hi != null && w.lo != null ? ` <span class="wx-dim">· H${esc(String(w.hi))}° L${esc(String(w.lo))}°</span>` : '')
    // "☔ 100%" is the DAY'S max, not the current sky — say so, and give SRs the word the emoji carries
    + (w.rainPct != null && w.rainPct > 0 ? ` · <span aria-hidden="true">☔</span> <span class="sr-only">rain </span>${esc(String(w.rainPct))}% <span class="wx-dim">today</span>` : '')
    + (w.sunrise && w.sunset ? ` <span class="wx-dim">· <span aria-hidden="true">🌅</span><span class="sr-only">sunrise </span>${esc(w.sunrise)} <span aria-hidden="true">🌇</span><span class="sr-only">sunset </span>${esc(w.sunset)}</span>` : '');
}
// ¥→USD for the budget teaser (er-api, keyless). 24h TTL — FX day-precision is plenty here.
let fxInFlight = false;
async function refreshRates() {
  const fx = get(KEYS.fx, null);
  if (fx && Number.isFinite(fx.at) && Date.now() - fx.at < 24 * 3600e3) return;
  if (fxInFlight) return;
  fxInFlight = true;
  try {
    const usd = await fetchUsdPerJpy();
    if (usd) { set(KEYS.fx, { at: Date.now(), usd }); refreshTeasers(); }
  } catch { /* offline — the teaser just shows yen only */ }
  finally { fxInFlight = false; }
}

let wxInFlight = false;   // dedupe: mount + the boot jwh:route both call this before the cache exists
async function refreshWeather() {
  const c = wxCache();
  if (c && Date.now() - c.at < WX_FRESH_MS) { renderWxStrip(); return; }
  if (wxInFlight) return;
  wxInFlight = true;
  try {   // everything after the flag is inside try — a throw anywhere must not wedge the flag
    const home = loadPlaces().find(p => p.home && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    // ~1km precision is plenty for weather — don't hand a third party the exact address
    const rnd = (v) => Math.round(v * 100) / 100;
    const [lat, lng] = home ? [rnd(home.lat), rnd(home.lng)] : [35.68, 139.77];
    const data = await fetchWeather(lat, lng);
    if (data) set(KEYS.weather, { at: Date.now(), data });
  } catch { /* offline / API down — a fresh-enough cached strip stays; a stale one hides */ }
  finally { wxInFlight = false; }
  renderWxStrip();
}
function renderTeasers() {
  // book-by alerts fold into 締切 (fill above); upcoming events live in the 今週 strip
  const plans = loadPlans();
  const date = Object.keys(plans).filter(d => plans[d] && plans[d].stops && plans[d].stops.length && d >= TODAY).sort()[0];
  teaser('#tPlan', date ? `${date === TODAY ? 'Today' : fmtShort(date)} · ${plans[date].stops.length} stop${plans[date].stops.length === 1 ? '' : 's'}` : 'Plan a day', '#/plan');
}
function teaser(sel, text, route) {
  const el = $(sel);
  if (!el) return;
  const body = el.querySelector('.teaser-body');
  if (body) body.innerHTML = `<a href="${route}">${esc(text)} <span class="teaser-go" aria-hidden="true">→</span></a>`;
}
function fill(sel, list, max = 5) {
  const el = $(sel);
  if (!el) return;
  const body = list.length
    ? `<ul class="ddl-list">${list.slice(0, max).map(a => `<li class="sev-${a.severity}">
        <a href="#/${a.kind === 'event' ? 'calendar' : (a.kind === 'book' || a.kind === 'deadline') ? 'deadlines' : 'checklist'}">
        <span class="ddl-d">${esc(fmtShort(a.when))}</span>
        <span class="ddl-w">${esc(clip(a.title, 56))}${a.days === 0 ? ' <span class="ddl-tag">today</span>' : a.severity === 'overdue' ? ' <span class="ddl-tag">overdue</span>' : ''}</span></a></li>`).join('')}</ul>`
    : `<p class="w-empty">Nothing due soon</p>`;
  el.querySelector('.widget-body').innerHTML = body;
}
// "進捗 Progress" — the settling-in + checklist bars (post-arrival) or checklist + packing
// (pre-arrival), with a budget word and the year-so-far stats. Reads localStorage fresh.
function renderProgress() {
  const el = $('#wProgress');
  if (!el) return;
  const checks = get(KEYS.checklist, {}) || {};
  const budgetState = get(KEYS.budget, {}) || {};
  const s = summary(DATA.budget || { currency: 'JPY', oneTime: [], monthly: [] }, budgetState);
  const noBudget = s.oneTimeTotal === 0 && s.monthlyTotal === 0 && !(budgetState.savings > 0);
  const budgetWord = noBudget ? 'unset' : (s.runwayMonths === Infinity || s.runwayMonths >= 6) ? 'ready' : 'tight';
  const bar = (jp, en, done, total, href) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<a class="prg-lbl" href="${href}"><span class="n"><b lang="ja">${jp}</b>${en}</span><span class="v">${done} / ${total}</span></a>
      <div class="prg-bar" role="img" aria-label="${esc(en)} ${done} of ${total}"><i style="width:${pct}%"></i></div>`;
  };
  const allChecks = checklistItems(DATA);
  const pk = progress([...(DATA.packing || []), ...(get(KEYS.packCustom, []) || [])], get(KEYS.packing, {}) || {});
  const rows = `<div class="prg-row">${bar('準備', 'checklist', allChecks.filter(it => checks[it.id]).length, allChecks.length, '#/checklist')}</div>
      <div class="prg-row">${bar('荷造り', 'packing', pk.done, pk.total, '#/packing')}</div>`;
  el.querySelector('.widget-body').innerHTML = rows
    + `<p class="prg-meta"><a href="#/budget">budget ${esc(budgetWord)}</a><span aria-hidden="true">·</span>${yearStatsInline()}</p>`;
}
function yearStatsInline() {
  const visited = loadPlaces().filter(p => p.visited).length;
  const tasksDone = Object.keys(get(KEYS.checklist, {}) || {}).length;
  return `<span>${esc(String(visited))} places visited</span><span aria-hidden="true">·</span><span>${esc(String(tasksDone))} tasks done</span>`;
}

// ---- theme (owns the top-bar toggle) ----
function initTheme() {
  const saved = getRaw(KEYS.theme, '');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = (saved === 'dark' || saved === 'light') ? saved : (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  updateToggle(theme);
  $('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setRaw(KEYS.theme, next);
    updateToggle(next);
  });
}
function updateToggle(theme) {
  const b = $('#themeToggle');
  if (!b) return;
  const isDark = theme === 'dark';
  (b.querySelector('span') || b).textContent = isDark ? '☀️' : '🌙';
  b.setAttribute('aria-pressed', String(isDark));
  b.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
}
