'use strict';
// Add/edit event modal + tag-filtered .ics/Google export + .ics import.
// Extracted from calendar.js (coordinator); shares state/mutation helpers via live-binding imports.

import { $, $$, esc } from './lib/dom.js';
import { gcalUrl, toICS, parseICS } from './lib/ics.js';
import { alertModal, confirmModal } from './lib/modal.js';
import { searchJP } from './lib/nominatim.js';
import { TODAY, CATS, allEvents, catOf, loadUser, saveUser, syncPlaceDate, deleteUserEvent, customCals } from './calendar.js';

// ---- add/edit modal ----
export function openModal(ev, presetDate, presetEnd, presetTime) {
  const e = ev || { id: '', title: '', date: presetDate || TODAY, endDate: presetEnd || '', time: presetTime || '', endTime: '', category: 'personal', note: '' };
  // Your calendars first (as an optgroup), then the researched categories. Preserve a non-standard
  // (e.g. imported .ics) category that matches neither, so editing never silently rewrites it.
  const cals = customCals();
  const known = new Set([...CATS, ...cals.map(c => c.id)]);
  const extra = (e.category && !known.has(e.category)) ? [e.category] : [];
  const optCals = cals.length ? `<optgroup label="Your calendars">${cals.map(c => `<option value="${esc(c.id)}" ${c.id === e.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : '';
  const opts = optCals + [...extra, ...CATS].map(c => `<option value="${esc(c)}" ${c === (e.category || 'personal') ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const gbtn = ev ? `<a class="btn ghost" href="${esc(gcalUrl(e))}" target="_blank" rel="noopener noreferrer">+ Google</a>` : '';
  const body = `
    <h3 class="modal-title">${ev ? 'Edit event' : 'Add event'}</h3>
    <form id="evForm" class="modal-form">
      <label>Title<input name="title" value="${esc(e.title)}" required></label>
      <div class="row2">
        <label>Date<input name="date" type="date" value="${esc((e.date || '').slice(0, 10))}" required></label>
        <label>End date (optional)<input name="endDate" type="date" value="${esc((e.endDate || '').slice(0, 10))}"></label>
      </div>
      <div class="row2">
        <label>Start time (optional)<input name="time" type="time" value="${esc(e.time || '')}"></label>
        <label>End time (optional)<input name="endTime" type="time" value="${esc(e.endTime || '')}"></label>
      </div>
      <div class="row2">
        <label>Category<select name="category">${opts}</select></label>
        <label>Repeats<select name="recur" id="evRecur">
          <option value="none"${!e.recur || e.recur === 'none' ? ' selected' : ''}>Doesn’t repeat</option>
          <option value="weekly"${e.recur === 'weekly' ? ' selected' : ''}>Weekly</option>
          <option value="monthly"${e.recur === 'monthly' ? ' selected' : ''}>Monthly</option>
          <option value="yearly"${e.recur === 'yearly' ? ' selected' : ''}>Yearly (birthday, anniversary…)</option>
        </select></label>
      </div>
      <label class="ev-loc-field">Location (optional)
        <input name="area" id="evArea" value="${esc(e.area || '')}" placeholder="Search an address…" autocomplete="off">
        <ul id="evAreaSug" class="ev-loc-sug" role="listbox" aria-label="Address suggestions"></ul>
      </label>
      <label>Note<textarea name="note" rows="3">${esc(e.note || '')}</textarea></label>
      <div class="modal-actions">
        ${ev ? '<button type="button" class="btn danger" id="mdDel">Delete</button>' : ''}
        ${gbtn}
        <button type="submit" class="btn primary">${ev ? 'Save' : 'Add'}</button>
      </div>
    </form>`;
  const ov = showModal(body);
  wireLocationField(ov);
  // a recurring event is single-day (it repeats a date), so an end date is meaningless — grey it out
  const recurSel = ov.querySelector('#evRecur'), endInput = ov.querySelector('input[name="endDate"]');
  const syncRecur = () => { const on = recurSel && recurSel.value !== 'none'; if (endInput) { endInput.disabled = on; if (on) endInput.value = ''; } };
  recurSel?.addEventListener('change', syncRecur); syncRecur();
  ov.querySelector('#evForm').addEventListener('submit', (sub) => {
    sub.preventDefault();
    const obj = Object.fromEntries(new FormData(sub.target).entries());
    if (!obj.title.trim() || !obj.date) return;
    if (obj.recur && obj.recur !== 'none') obj.endDate = '';   // recurring = single-day; drop any stale end date
    if (obj.endDate && obj.endDate < obj.date) { alertModal('End date can’t be before the start date.'); return; }   // else the event is invisible on the grid but counts in alerts
    if (obj.endTime && !obj.time) { alertModal('Add a start time before an end time.'); return; }
    if (obj.time && obj.endTime && !obj.endDate && obj.endTime <= obj.time) { alertModal('End time must be after the start time (same day).'); return; }
    const u = (ev && ev.id)
      ? loadUser().map(x => x.id === ev.id ? { ...x, ...obj } : x)
      : [...loadUser(), { id: 'u' + Date.now(), ...obj }];
    saveUser(u);
    if (ev && ev.id && obj.date !== (ev.date || '').slice(0, 10)) syncPlaceDate(ev.id, obj.date);   // a linked place follows the edited date
    closeModal(ov, { rerender: true });   // jwh:data-changed → render() (single path)
  });
  ov.querySelector('#mdDel')?.addEventListener('click', () => { deleteUserEvent(ev.id); closeModal(ov, { rerender: true }); });
}

// Debounced Nominatim autocomplete for the event form's Location (area) field. Mirrors the map's
// add-place throttle (>=1.1s between requests). Picking a suggestion fills the input; FormData then
// persists it as event.area. Every remote string is esc()'d before innerHTML.
function wireLocationField(ov) {
  const input = ov.querySelector('#evArea'), sug = ov.querySelector('#evAreaSug');
  if (!input || !sug) return;
  let timer, controller, lastReq = 0;
  const clear = () => { sug.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { clear(); return; }
    const run = async () => {
      const now = Date.now();
      const wait = 1100 - (now - lastReq);
      if (wait > 0) { timer = setTimeout(run, wait); return; }   // throttle, don't drop
      lastReq = now;
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        const matches = await searchJP(q, controller.signal);
        if (!sug.isConnected) return;                            // modal closed mid-request → bail (no detached write)
        sug.innerHTML = matches.length
          ? matches.map(m => `<li><button type="button" class="ev-loc-opt" data-addr="${esc(m.addr)}">${esc(m.addr)}</button></li>`).join('')
          : '<li class="ev-loc-msg">No matches</li>';
      } catch (e) { if (e.name !== 'AbortError' && sug.isConnected) sug.innerHTML = '<li class="ev-loc-msg">Search unavailable — try again</li>'; }
    };
    timer = setTimeout(run, 450);
  });
  // Select on mousedown (fires BEFORE the input's blur) + preventDefault so focus/selection isn't lost —
  // avoids the blur-vs-click race entirely (no timing-dependent setTimeout).
  sug.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.ev-loc-opt'); if (!b) return;
    e.preventDefault();
    input.value = b.dataset.addr; clear();
  });
  input.addEventListener('blur', clear);   // mousedown already committed any selection, so a plain clear is safe
}

// ---- bulk add: tag-filtered .ics + Google import how-to ----
export function openExport() {
  const present = [...new Set(allEvents().map(catOf))].sort();
  const checks = present.map(c => `<label class="exp-tag"><input type="checkbox" value="${esc(c)}" checked> ${esc(c)}</label>`).join('');
  const body = `
    <h3 class="modal-title">Add to my calendar</h3>
    <p class="modal-line">Pick the tags, then download an <b>.ics</b> — import it into Google, Apple, or Outlook Calendar (one-time, with everything in it).</p>
    <div class="exp-tags">${checks}</div>
    <div class="modal-actions">
      <button class="btn" id="expAll">Toggle all</button>
      <button class="btn primary" id="expIcs">Download .ics</button>
    </div>
    <p class="modal-hint"><b>Google Calendar:</b> Settings → Import &amp; export → Import the .ics. Or open any single event and hit “+ Google Calendar”. (Two-way sync would need a backend — out of scope for this private, no-server planner.)</p>`;
  const ov = showModal(body);
  const picked = () => $$('.exp-tags input:checked', ov).map(i => i.value);
  ov.querySelector('#expAll').addEventListener('click', () => { const bx = $$('.exp-tags input', ov); const on = bx.every(b => b.checked); bx.forEach(b => b.checked = !on); });
  ov.querySelector('#expIcs').addEventListener('click', () => {
    const sel = new Set(picked());
    const evs = allEvents().filter(e => sel.has(catOf(e)));
    if (!evs.length) { alertModal('Pick at least one tag.'); return; }
    download(`my-japan-trip-${[...sel].join('-')}.ics`, toICS(evs, 'My Japan Trip'));
    closeModal(ov);
  });
}
function download(name, text) {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
export function onImport(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const parsed = parseICS(reader.result);
    if (!parsed.length) { alertModal('No events found in that .ics file.'); return; }
    if (!await confirmModal(`Import ${parsed.length} event(s) into your calendar?`, { ok: 'Import' })) return;
    const added = parsed.map((p, i) => ({ id: 'u' + Date.now() + '-' + i, title: p.title, date: p.date, endDate: p.endDate || '', category: p.category || 'imported', note: p.note || '', area: p.area || '' }));
    saveUser([...loadUser(), ...added]);   // jwh:data-changed → render()
  };
  reader.onerror = () => alertModal('Could not read that .ics file.');
  reader.readAsText(file); e.target.value = '';
}

// ---- modal shell ----
function showModal(html) {
  const prev = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="calModalTitle" tabindex="-1"><button type="button" class="modal-x" aria-label="Close">✕</button>${html}</div>`;
  document.body.appendChild(ov);
  const h = ov.querySelector('h2, h3, .modal-title'); if (h && !h.id) h.id = 'calModalTitle';   // label the dialog
  const focusables = () => [...ov.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  const restore = () => { if (prev && prev.focus) prev.focus(); };
  ov.addEventListener('click', (e) => { if (e.target === ov) { closeModal(ov); restore(); } });
  ov.querySelector('.modal-x').addEventListener('click', () => { closeModal(ov); restore(); });
  ov.addEventListener('keydown', (e) => {     // listener lives on ov (focus is trapped inside) → auto-cleans on close
    if (e.key === 'Escape') { closeModal(ov); restore(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  setTimeout(() => (ov.querySelector('.modal input,.modal select,.modal textarea') || focusables()[0])?.focus(), 30);
  ov._restore = restore;   // commit paths call closeModal(ov, { rerender }) which restores focus
  return ov;
}
// rerender:true → the trigger element is destroyed by render(); send focus to the stable toolbar +Add button instead
function closeModal(ov, opts) {
  ov.classList.add('out'); setTimeout(() => ov.remove(), 180);
  if (opts && opts.rerender) $('#calAdd')?.focus();
  else ov._restore?.();
}
