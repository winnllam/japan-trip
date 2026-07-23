'use strict';
// Lottery & timed-release tracker — STORE-BACKED cards (jwh-drops-v1), editable in-app + synced.
// Two groups: "Fixed timed-release rules" (recurring, kind:'fixed') and "Dated booking windows"
// (kind:'window', a book-by date). Add/edit/delete cards from the UI — no code edits needed.
// Until the store key is seeded, it renders baked defaults (these rules + the matching
// bookByTimeline rows) so a fresh copy still works. Dated cards also feed the notifications bell
// (see dashboard.js buildItems, which reads the same jwh-drops-v1).

import { $, esc } from './lib/dom.js';
import { fmtShort, windowStatus, nowISO } from './lib/dates.js';
import { gcalUrl } from './lib/ics.js';
import { KEYS, get, set } from './lib/store.js';
import { openDialog, confirmModal } from './lib/modal.js';

// Baked fallbacks (used only until jwh-drops-v1 exists). Verify closer.
const DEFAULT_FIXED = [
  { id: 'fx-ghibli-museum', kind: 'fixed', title: 'Ghibli Museum (Mitaka) tickets', when: '10th of each month · 10:00 JST', detail: 'Next month’s dated/timed tickets go on sale via Lawson. Sell out in minutes — be logged in and ready at 10:00 sharp.', url: 'https://www.ghibli-museum.jp/en/tickets/' },
  { id: 'fx-ghibli-park', kind: 'fixed', title: 'Ghibli Park tickets', when: '10th of each month · 14:00 JST', detail: 'Two months ahead via Boo-Woo/Lawson. Dated + timed entry; the Grand Warehouse area is the bottleneck.', url: 'https://ghibli-park.jp/en/' },
  { id: 'fx-disney', kind: 'fixed', title: 'Tokyo Disney date-tickets', when: 'Daily · rolling 60 days ahead (~14:00 JST)', detail: 'Date-specific park tickets release on a 60-day rolling window. Hotel/Vacation-Package guests get earlier access; NYE & big seasonals are separate lotteries.', url: 'https://www.tokyodisneyresort.jp/en/' },
  { id: 'fx-sumo', kind: 'fixed', title: 'Grand Sumo tickets', when: '~1 month before each basho (on-sale date varies)', detail: 'Ticket Pia / Oosumo advance lottery then general sale. Tokyo basho: Jan, May, Sep at Ryogoku Kokugikan.', url: 'https://sumo.pia.jp/en/' },
];
const RX = /(lottery|timed|release|on-sale|on sale|jst|10:00|14:00|sells? out|advance ticket|wristband)/i;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function bakedWindows(data) {
  return (data.bookByTimeline || []).filter(b => RX.test((b.what || '') + (b.action || ''))).map(b => ({
    id: 'win-' + String(b.id || b.what || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
    kind: 'window', title: b.what || '', dueBy: isDate(b.when) ? b.when : '',
    when: isDate(b.when) ? '' : (b.when || ''), detail: b.action || '', url: '',
  }));
}

let DATA = null;
function loadCards() { const c = get(KEYS.drops, null); return Array.isArray(c) ? c : [...DEFAULT_FIXED, ...bakedWindows(DATA)]; }
function saveCards(cards) { set(KEYS.drops, cards); document.dispatchEvent(new CustomEvent('jwh:data-changed')); }

export function mountTracker(data) {
  DATA = data;
  render();
  document.addEventListener('jwh:data-changed', render);   // reflect adds/deletes + sync pulls
}

function cardHTML(c) {
  const dated = c.kind === 'window' && isDate(c.dueBy);
  const whenTxt = dated ? fmtShort(c.dueBy) : (c.when || (c.kind === 'window' ? 'TBD' : ''));
  const st = dated ? windowStatus(c.dueBy, nowISO()) : '';
  const link = c.url ? `<a class="trk-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">official ↗</a>` : '';
  const rem = dated ? `<a class="trk-link" href="${esc(gcalUrl({ title: c.title, date: c.dueBy, note: c.detail }))}" target="_blank" rel="noopener noreferrer">+ reminder</a>` : '';
  return `<div class="trk-card${c.kind === 'fixed' ? ' recurring' : ''}" data-id="${esc(c.id)}">
    <button type="button" class="trk-del" data-del="${esc(c.id)}" aria-label="Remove ${esc(c.title)}" title="Remove">✕</button>
    <div class="trk-when ${esc(st)}">${esc(whenTxt)}</div>
    <div class="trk-title">${esc(c.title)}</div>
    <div class="trk-detail">${esc(c.detail || '')}</div>${link}${rem}</div>`;
}

function render() {
  const wrap = $('#trackerList'); if (!wrap) return;
  const cards = loadCards();
  const fixed = cards.filter(c => c.kind === 'fixed');
  const windows = cards.filter(c => c.kind === 'window').sort((a, b) => ((a.dueBy || '9999') < (b.dueBy || '9999') ? -1 : 1));
  wrap.innerHTML = `
    <div class="trk-actions"><button type="button" class="trk-add" id="trkAdd">＋ Add card</button></div>
    ${fixed.length ? `<div class="trk-group"><h3 class="trk-h">Fixed timed-release rules</h3><div class="trk-grid">${fixed.map(cardHTML).join('')}</div></div>` : ''}
    ${windows.length ? `<div class="trk-group"><h3 class="trk-h">Dated booking windows</h3><div class="trk-grid">${windows.map(cardHTML).join('')}</div></div>` : ''}`;
  $('#trkAdd')?.addEventListener('click', addCard);
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (await confirmModal('Remove this card?', { ok: 'Remove', danger: true })) saveCards(loadCards().filter(c => c.id !== b.dataset.del));
  }));
}

function addCard() {
  openDialog(`
    <h2 id="amTitle" class="app-modal-title">Add a tracker card</h2>
    <div class="trk-form">
      <label class="trk-l">Type
        <select class="app-modal-input" id="tkKind"><option value="window">Dated booking window</option><option value="fixed">Fixed / recurring rule</option></select>
      </label>
      <label class="trk-l">Title<input class="app-modal-input" id="tkTitle" placeholder="e.g. Ghibli Museum tickets" autocomplete="off"></label>
      <label class="trk-l" id="tkDateWrap">Book-by date<input class="app-modal-input" id="tkDate" type="date" min="2026-01-01" max="2027-12-31"></label>
      <label class="trk-l" id="tkWhenWrap" hidden>When (rule)<input class="app-modal-input" id="tkWhen" placeholder="e.g. 10th of each month · 10:00 JST" autocomplete="off"></label>
      <label class="trk-l">Details<textarea class="app-modal-input" id="tkDetail" rows="2"></textarea></label>
      <label class="trk-l">Official link (optional)<input class="app-modal-input" id="tkUrl" type="url" placeholder="https://…" autocomplete="off"></label>
    </div>
    <div class="app-modal-acts"><button type="button" class="am-btn" data-cancel>Cancel</button><button type="button" class="am-btn am-primary" data-ok>Add</button></div>`, {
    onMount: (card, done) => {
      const kind = card.querySelector('#tkKind');
      const dw = card.querySelector('#tkDateWrap'), ww = card.querySelector('#tkWhenWrap');
      const sync = () => { const w = kind.value === 'window'; dw.hidden = !w; ww.hidden = w; };
      kind.addEventListener('change', sync); sync();
      card.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      card.querySelector('[data-ok]').addEventListener('click', () => {
        const title = card.querySelector('#tkTitle').value.trim();
        if (!title) { card.querySelector('#tkTitle').focus(); return; }
        const k = kind.value;
        done({
          id: 'drop-' + Date.now().toString(36), kind: k, title,
          dueBy: k === 'window' ? (card.querySelector('#tkDate').value || '') : '',
          when: k === 'fixed' ? card.querySelector('#tkWhen').value.trim() : '',
          detail: card.querySelector('#tkDetail').value.trim(), url: card.querySelector('#tkUrl').value.trim(),
        });
      });
    }, initialFocus: '#tkTitle',
  }).then(c => { if (c) saveCards([...loadCards(), c]); });
}
