'use strict';
// Printable one-page summary. A #printBtn (in the footer) renders a fresh snapshot of the
// current device-local state into #printView, then calls window.print(). The @media print
// rule (style.css) hides all chrome and reveals #printView. Read-only — no mutation.
//
// XSS: every interpolated string passes through esc() with double-quoted attributes only.
// User free-text (custom budget labels, custom packing items, user event titles) is never
// rendered as raw HTML — we render baked checklist/deadline text (esc'd anyway) plus numeric
// progress/totals, so untrusted strings can't break out.

import { $, esc } from './lib/dom.js';
import { get, KEYS } from './lib/store.js';
import { countdown, fmtShort } from './lib/dates.js';
import { progress } from './lib/packing.js';
import { summary, fmtYen, fmtCad } from './lib/budget.js';

const ARRIVAL = '2026-10-19';

export function mountPrint(data, today) {
  const btn = $('#printBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    renderPrintSummary(data, today);
    window.print();
  });
}

// build the checklist "next open items" directly from data (NOT via lib/notify) — open =
// unchecked; sorted by dueBy soonest (items without a due date sink to the end); top 8.
function nextOpenChecklist(data) {
  const checked = get(KEYS.checklist, {}) || {};
  const due = get(KEYS.due, {}) || {};
  return (data.checklist || [])
    .flatMap(p => p.items || [])
    .filter(it => it && it.id && !checked[it.id])
    .map(it => ({ ...it, _due: due[it.id] || it.dueBy || '' }))
    .sort((a, b) => {
      if (a._due && b._due) return a._due < b._due ? -1 : a._due > b._due ? 1 : 0;
      if (a._due) return -1;
      if (b._due) return 1;
      return 0;
    })
    .slice(0, 8);
}

function checklistProgress(data) {
  const checked = get(KEYS.checklist, {}) || {};
  const items = (data.checklist || []).flatMap(p => p.items || []).filter(it => it && it.id);
  const total = items.length;
  const done = items.filter(it => checked[it.id]).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { done, total, pct };
}

function packingState(data) {
  const items = [
    ...(Array.isArray(data.packing) ? data.packing : []),
    ...(get(KEYS.packCustom, []) || []),
  ];
  const checked = get(KEYS.packing, {}) || {};
  const prog = progress(items, checked);
  // "essentials" = the survival categories; count how many remain unpacked.
  const ESSENTIAL = new Set(['Documents', 'Money', 'Health']);
  const essentialsLeft = items.filter(it => it && ESSENTIAL.has(it.cat) && !checked[it.id]).length;
  return { ...prog, essentialsLeft };
}

// next ~6 upcoming deadlines: book-by (when/what) + time-sensitive (dueBy/item), soonest first.
function upcomingDeadlines(data) {
  const book = (data.bookByTimeline || [])
    .filter(b => b && b.when)
    .map(b => ({ date: b.when, text: b.what || '', kind: 'Book by' }));
  const ts = (data.timeSensitive || [])
    .filter(t => t && t.dueBy)
    .map(t => ({ date: t.dueBy, text: t.item || '', kind: 'Deadline' }));
  return [...book, ...ts]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, 6);
}

export function renderPrintSummary(data, today) {
  const view = $('#printView');
  if (!view) return;

  const cd = countdown(ARRIVAL, today);
  const daysLine = cd.phase === 'before'
    ? `${esc(String(cd.days))} days to HND (land ${esc(ARRIVAL)})`
    : cd.phase === 'arrived' ? `Day ${esc(String(cd.days + 1))} in Japan` : '';

  const chk = checklistProgress(data);
  const openItems = nextOpenChecklist(data);
  const openList = openItems.length
    ? `<ul class="pv-list">${openItems.map(it => {
        const d = it._due ? ` <span class="pv-due">(${esc(fmtShort(it._due))})</span>` : '';
        return `<li>${esc(it.task || it.title || it.id)}${d}</li>`;
      }).join('')}</ul>`
    : `<p class="pv-empty">All checklist items complete.</p>`;

  const pk = packingState(data);

  const state = get(KEYS.budget, {}) || {};
  const baked = (data && data.budget && typeof data.budget === 'object') ? data.budget : {};
  const s = summary(baked, state);
  const rate = +(state.cadRate) || 0;
  const cadTwin = (yen) => { const c = fmtCad(yen, rate); return c ? ` (${esc(c)})` : ''; };
  const runway = s.runwayMonths === Infinity ? '∞ (sustainable)' : `${esc(String(s.runwayMonths))} months`;

  const deadlines = upcomingDeadlines(data);
  const deadlineList = deadlines.length
    ? `<ul class="pv-list">${deadlines.map(d =>
        `<li><span class="pv-date">${esc(fmtShort(d.date))}</span> ${esc(d.kind)} — ${esc(d.text)}</li>`).join('')}</ul>`
    : `<p class="pv-empty">No upcoming deadlines.</p>`;

  view.innerHTML = `
    <header class="pv-header">
      <h1>My Japan Trip — trip summary</h1>
      <p class="pv-meta">Generated ${esc(today)}${daysLine ? ` · ${daysLine}` : ''}</p>
    </header>

    <section class="pv-section">
      <h2>Checklist</h2>
      <p class="pv-stat">${esc(String(chk.pct))}% · ${esc(String(chk.done))}/${esc(String(chk.total))} done</p>
      <h3>Next open items</h3>
      ${openList}
    </section>

    <section class="pv-section">
      <h2>Packing</h2>
      <p class="pv-stat">${esc(String(pk.pct))}% · ${esc(String(pk.done))}/${esc(String(pk.total))} packed · ${esc(String(pk.essentialsLeft))} essential${pk.essentialsLeft === 1 ? '' : 's'} left</p>
    </section>

    <section class="pv-section">
      <h2>Budget</h2>
      <p class="pv-stat">To land: ${esc(fmtYen(s.toLand))}${cadTwin(s.toLand)}</p>
      <p class="pv-stat">Monthly burn: ${esc(fmtYen(s.monthlyTotal))}${cadTwin(s.monthlyTotal)}</p>
      <p class="pv-stat">Runway: ${runway}</p>
    </section>

    <section class="pv-section">
      <h2>Upcoming deadlines</h2>
      ${deadlineList}
    </section>
  `;
}
