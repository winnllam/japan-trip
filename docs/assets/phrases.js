'use strict';
// Phrasebook page (#/phrases) — a curated survival-Japanese reference: categorized,
// collapsible (shared accordion), each phrase with the Japanese (.jp, hover-dictionary),
// a reading, an English meaning, and a ★ favorite toggle. Read-only content from
// tips.json.phrases; favorites are the only device-local state (jwh-phrasefav-v1).
// Nothing here dispatches jwh:data-changed (nothing else derives from it).
//
// Reuses lib/packing.js groupByCategory (generic) + collapse.js accordion. After each
// render it calls wireJpAccents() so the JS-rendered .jp phrases get keyboard access.

import { $, $$, esc } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { slug } from './lib/places.js';
import { mountAccordion } from './collapse.js';
import { groupByCategory } from './lib/packing.js';
import { wireJpAccents, lookupWord } from './lang.js';
import { toAnkiTSV, stripHtml, parseAnkiTSV, mapNoteFields } from './lib/anki.js';
import { isAvailable, invoke } from './lib/ankiconnect.js';
import { alertModal, confirmModal, showModal } from './lib/modal.js';
import { userPhrase, addUserPhrases, removeUserPhrase } from './lib/userphrases.js';
import { speak, canSpeak } from './speak.js';
import { rubyHTML } from './lib/furigana.js';
import { MAX_LEN } from './lib/translate.js';
import { translate } from './lib/translatecache.js';

const SPK = canSpeak();   // platform supports speech synthesis?

// fixed category render order (unknown cats fall to the end, per groupByCategory)
const CATEGORY_ORDER = ['Daily', 'Konbini', 'Restaurant', 'Dietary', 'Transit', 'Ward office', 'Bank', 'Phone/SIM', 'Apartment', 'Pharmacy', 'Emergency', 'Job', 'Work/meetup'];

let DATA = null;

function bakedPhrases() { return DATA && Array.isArray(DATA.phrases) ? DATA.phrases : []; }
function loadUser() { return get(KEYS.userPhrases, []) || []; }
function saveUser(list) { set(KEYS.userPhrases, list); }
function loadFavs() { return get(KEYS.phraseFav, {}) || {}; }
function saveFavs(m) { set(KEYS.phraseFav, m); }
function favOnly() { return getRaw(KEYS.phraseFavView, '') === 'on'; }
function furiOff() { return getRaw(KEYS.furi, '') === 'off'; }
// Reflect the furigana on/off state on the persistent #phraseList wrap (.furi-off hides <rt>
// + the reading line via CSS). The wrap survives render() (innerHTML swaps, class stays).
function applyFuri() {
  const off = furiOff();
  $('#phrases')?.classList.toggle('furi-off', off);   // whole phrases section → covers phrase list + vocab
  const btn = $('#phraseFuri');
  if (btn) { btn.setAttribute('aria-pressed', off ? 'false' : 'true'); btn.textContent = off ? 'あ Furigana off' : 'あ Furigana'; }
}

export function mountPhrases(data) {
  DATA = data || {};
  const list = $('#phraseList');
  if (!list) return;
  wireControls();
  wireLookup();
  wireTranslate();
  render();
}

function wireTranslate() {
  const btn = $('#jtTranslateBtn'), panel = $('#jtTranslatePanel');
  if (!btn || !panel || btn.dataset.wired) return; btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = panel.hidden; panel.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && !panel.dataset.built) {
      panel.dataset.built = '1';
      panel.innerHTML = `<textarea id="jtTaIn" maxlength="${MAX_LEN}" rows="2" placeholder="Type English or Japanese…"></textarea>
        <div class="jt-trow"><button type="button" id="jtDir" class="jt-btn" data-dir="en-ja">EN → 日本語 ⇄</button>
        <button type="button" id="jtGo" class="jt-btn">Translate</button><span id="jtCount" class="jt-count">0/${MAX_LEN}</span></div>
        <div id="jtTaOut" class="jt-out" aria-live="polite"></div>
        <p class="jt-note">Translations are sent to MyMemory (a free service) — see their terms.</p>`;
      wireTranslateInner();
    }
  });
}
function wireTranslateInner() {
  const inp = $('#jtTaIn'), dir = $('#jtDir');
  inp?.addEventListener('input', () => { const c = $('#jtCount'); if (c) c.textContent = `${inp.value.length}/${MAX_LEN}`; });
  dir?.addEventListener('click', () => { const ej = dir.dataset.dir === 'en-ja'; dir.dataset.dir = ej ? 'ja-en' : 'en-ja'; dir.textContent = ej ? '日本語 → EN ⇄' : 'EN → 日本語 ⇄'; });
  $('#jtGo')?.addEventListener('click', async () => {
    const text = (inp.value || '').trim(); if (!text) return;
    const [from, to] = ($('#jtDir').dataset.dir === 'en-ja') ? ['en', 'ja'] : ['ja', 'en'];
    const out = $('#jtTaOut'); out.innerHTML = '<span class="jt-load">translating…</span>';
    try {
      const res = await translate(text, from, to);
      const outLang = to === 'ja' ? ' lang="ja"' : '';   // mark JP output for SR voice + CJK glyphs (WCAG 3.1.2)
      out.innerHTML = res.text
        ? `<div class="jt-res"><div class="jt-mean"${outLang}>${esc(res.text)}</div><div class="jt-act"><button type="button" id="jtCopy">Copy</button> <a href="https://jisho.org/search/${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer">Dictionary ↗</a></div></div>`
        : `<div class="jt-res">${esc(res.warning || 'translation unavailable')}</div>`;
      const cp = $('#jtCopy'); if (cp) cp.addEventListener('click', () => navigator.clipboard?.writeText(res.text));
    } catch { out.innerHTML = `<div class="jt-res">Translation unavailable.</div>`; }
  });
}

let lookCtrl = null, lookTimer = null;
function wireLookup() {
  const btn = $('#jtLookupBtn'), panel = $('#jtLookupPanel');
  if (!btn || !panel || btn.dataset.wired) return; btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      panel.innerHTML = `<label class="jt-lk"><span class="sr-only">Look up a word</span><input type="search" id="jtLookInput" placeholder="Look up a word (日本語, or try English)"></label><div id="jtLookOut" class="jt-out" aria-live="polite"></div>`;
      $('#jtLookInput')?.focus(); wireLookInput();
    }
  });
}
function wireLookInput() {
  const inp = $('#jtLookInput'); if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    clearTimeout(lookTimer);
    if (q.length < 1) { const o = $('#jtLookOut'); if (o) o.innerHTML = ''; return; }
    lookTimer = setTimeout(() => runLookup(q), 250);
  });
}
async function runLookup(q) {
  const out = $('#jtLookOut'); if (!out) return;
  if (lookCtrl) lookCtrl.abort(); lookCtrl = new AbortController();
  out.innerHTML = '<span class="jt-load">looking up…</span>';
  const jisho = `https://jisho.org/search/${encodeURIComponent(q)}`;
  const ctrl = lookCtrl, killer = setTimeout(() => ctrl.abort(), 4000);   // a slow/hung Jotoba must fall back, not hang on "looking up…" (mirrors the hover's timeout)
  try {
    const res = await lookupWord(q, { signal: lookCtrl.signal });
    clearTimeout(killer);
    if (res) {
      out.innerHTML = `<div class="jt-res"><div class="jt-read" lang="ja">${esc(res.reading)}</div><div class="jt-mean">${esc(res.gloss)}</div>`
        + `<div class="jt-act"><button type="button" class="jt-save" data-jp="${esc(q)}" data-read="${esc(res.reading)}" data-en="${esc(res.gloss)}">★ Save to my phrases</button> <a href="${esc(jisho)}" target="_blank" rel="noopener noreferrer">Jisho ↗</a></div></div>`;
      wireSave();
    } else {
      out.innerHTML = `<div class="jt-res">No dictionary match. <a href="${esc(jisho)}" target="_blank" rel="noopener noreferrer">Open Jisho ↗</a></div>`;
    }
  } catch { clearTimeout(killer); out.innerHTML = `<div class="jt-res">Lookup unavailable. <a href="${esc(jisho)}" target="_blank" rel="noopener noreferrer">Open Jisho ↗</a></div>`; }
}
function wireSave() {
  const b = $('#jtLookOut .jt-save'); if (!b) return;
  b.addEventListener('click', () => {
    const p = userPhrase({ jp: b.dataset.jp, read: b.dataset.read, en: b.dataset.en, cat: 'Saved', src: 'jisho' }, 'uph' + Date.now());
    saveUser(addUserPhrases(loadUser(), [p])); render();
    b.textContent = '★ Saved'; b.disabled = true;
  });
}

function exportRows(favScope) {
  const favs = loadFavs();
  const src = favScope ? bakedPhrases().filter(p => favs[p.id]) : bakedPhrases();
  const users = get(KEYS.userPhrases, []) || [];
  const all = [...src, ...(favScope ? users.filter(p => favs[p.id]) : users)];
  const rows = all.map(p => ({ front: p.jp, back: [p.read, p.en].filter(Boolean).join(' <br> '), tags: ['whv', p.cat || 'Phrase'] }));
  if (!favScope) {   // a full export also includes the N5 + food study vocabulary
    const vocab = DATA && Array.isArray(DATA.vocab) ? DATA.vocab : [];
    vocab.forEach(v => rows.push({ front: v.jp, back: [v.read, v.en].filter(Boolean).join(' <br> '), tags: ['whv', 'vocab', v.theme || 'Vocab'] }));
  }
  return rows;
}

async function doExport() {
  const favScope = $('#jtFavScope')?.checked;
  const rows = exportRows(favScope);
  if (!rows.length) { alertModal('No phrases to export.'); return; }
  const deck = getRaw(KEYS.ankiDeck, 'Japan Trip');
  if (await isAvailable()) {
    try {
      await invoke('createDeck', { deck });
      const notes = rows.map(r => ({ deckName: deck, modelName: 'Basic', fields: { Front: r.front, Back: r.back }, tags: r.tags, options: { allowDuplicate: false } }));
      const can = await invoke('canAddNotes', { notes });
      const res = await invoke('addNotes', { notes });
      const added = (res || []).filter(x => x != null).length;
      const skipped = notes.length - (can || []).filter(Boolean).length;
      alertModal(`Added ${added} to “${deck}”${skipped ? ` (${skipped} duplicates skipped)` : ''}.`);
      return;
    } catch (e) { /* fall through to file */ }
  }
  const blob = new Blob([toAnkiTSV(rows)], { type: 'text/tab-separated-values' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'japan-phrases.txt';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  alertModal('Anki not detected — downloaded japan-phrases.txt. In Anki: File → Import.');
}

const MAX_IMPORT = 1000;

function commitImport(rows, srcLabel) {           // rows: [{jp, en, read}]
  if (!rows.length) { alertModal('Nothing to import.'); return; }
  let r = rows;
  if (r.length > MAX_IMPORT) { r = r.slice(0, MAX_IMPORT); alertModal(`Imported ${MAX_IMPORT} of ${rows.length} — the rest were skipped.`); }
  const base = Date.now();
  const list = r.map((x, i) => userPhrase({ jp: stripHtml(x.jp), read: stripHtml(x.read || ''), en: stripHtml(x.en), cat: 'Imported', src: srcLabel }, 'uph' + (base + i)));
  saveUser(addUserPhrases(loadUser(), list)); render();
}

// confirmModal resolves true(ok)/false(cancel|dismiss) and esc()s its own message — pass RAW text.
// Frame so dismiss is safe: dismiss==false keeps the auto-detected orientation (never a silent swap).
async function importWithPreview(rows, srcLabel) {       // rows already mapped to {jp,en,read}
  const sample = rows.find(x => x.jp || x.en) || rows[0] || { jp: '', en: '' };
  const swap = await confirmModal(
    `Import ${rows.length} phrase(s). Detected Front → Japanese 「${sample.jp}」, Back → English 「${sample.en}」. Swap front/back?`,
    { ok: 'Swap', cancel: 'Looks right' });
  const final = swap ? rows.map(x => ({ jp: x.en, en: x.jp, read: x.read })) : rows;
  commitImport(final, srcLabel);
}

function doImportFile() {
  const inp = $('#jtImportFile'); if (!inp) return;
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const parsed = parseAnkiTSV(String(rd.result || ''));   // [{front, back, tags}]
      const m = mapNoteFields(parsed.length ? ['c0', 'c1', 'c2'] : []);  // file = no field names → positional 0/1/2
      const rows = parsed.map(p => { const cols = [p.front, p.back]; return { jp: cols[m.jpIdx] ?? p.front, en: cols[m.enIdx] ?? p.back, read: '' }; });
      importWithPreview(rows, 'anki-file');
      inp.value = '';
    };
    rd.readAsText(f);
  };
  inp.click();
}

// deck picker on showModal: render a button per deck; resolve the chosen name + close via [data-ok].
function pickFromList(items) {
  return new Promise(resolve => {
    const list = (items || []).map(d => `<button type="button" class="am-btn jt-deck" data-deck="${esc(d)}">${esc(d)}</button>`).join('');
    showModal('Pick a deck to import', `<div class="jt-decks">${list || 'No decks.'}</div>`, { closeLabel: 'Cancel' });
    setTimeout(() => document.querySelectorAll('.jt-deck').forEach(b => b.addEventListener('click', () => {
      resolve(b.dataset.deck);
      document.querySelector('.app-modal-acts [data-ok]')?.click();
    })), 0);
  });
}

async function doImportLive() {
  const decks = await invoke('deckNames');
  const deck = await pickFromList(decks);
  if (!deck) return;
  const ids = await invoke('findNotes', { query: `deck:"${deck}"` });
  const infos = await invoke('notesInfo', { notes: (ids || []).slice(0, MAX_IMPORT) });
  if (!infos || !infos.length) { alertModal('That deck has no notes.'); return; }
  const fieldOrder = Object.entries(infos[0].fields).sort((a, b) => a[1].order - b[1].order).map(([name]) => ({ name }));
  const m = mapNoteFields(fieldOrder);
  const valsOf = (note) => Object.entries(note.fields).sort((a, b) => a[1].order - b[1].order).map(([, v]) => v.value);
  const rows = infos.map(n => { const v = valsOf(n); return { jp: v[m.jpIdx] || '', en: v[m.enIdx] || '', read: v[m.readIdx] || '' }; });
  importWithPreview(rows, 'anki:' + deck);
}

async function doImport() { (await isAvailable()) ? doImportLive() : doImportFile(); }

function wireControls() {
  const fav = $('#phraseFavOnly');
  if (fav && !fav.dataset.wired) {
    fav.dataset.wired = '1';
    fav.addEventListener('click', () => {
      const on = !favOnly();
      setRaw(KEYS.phraseFavView, on ? 'on' : '');
      fav.setAttribute('aria-pressed', on ? 'true' : 'false');
      fav.textContent = on ? '★ Favorites only' : '☆ Favorites only';
      render();
    });
    // reflect persisted state on mount
    const on = favOnly();
    fav.setAttribute('aria-pressed', on ? 'true' : 'false');
    fav.textContent = on ? '★ Favorites only' : '☆ Favorites only';
  }
  const furi = $('#phraseFuri');
  if (furi && !furi.dataset.wired) {
    furi.dataset.wired = '1';
    furi.addEventListener('click', () => { setRaw(KEYS.furi, furiOff() ? '' : 'off'); applyFuri(); });
  }
  applyFuri();   // reflect persisted state on mount
  $('#jtExport')?.addEventListener('click', doExport);
  $('#jtImport')?.addEventListener('click', doImport);
}

function rowHTML(p, favs) {
  const id = p.id;
  const on = !!favs[id];
  const mine = p._user
    ? `<button type="button" class="phrase-del" data-del="${esc(p.id)}" aria-label="Remove ${esc(p.en || p.jp)}">✕</button>`
    : '';
  return `
    <li class="phrase-row" data-id="${esc(id)}">
      <div class="phrase-main">
        <span class="jp phrase-jp" lang="ja" data-word="${esc(p.jp)}">${rubyHTML(p.furi, p.jp)}</span>
        <span class="phrase-read">${esc(p.read)}</span>
        <span class="phrase-en">${esc(p.en)}${p.reg ? ` <span class="phrase-reg reg-${esc(p.reg)}" title="${p.reg === 'keigo' ? 'extra-formal / humble register' : 'casual / plain form'}">${esc(p.reg)}</span>` : ''}</span>
        ${p._user ? `<span class="phrase-mine" aria-label="your phrase" title="yours">★</span>` : ''}
      </div>
      ${SPK ? `<button type="button" class="phrase-spk" data-jp="${esc(p.jp)}" aria-label="Play pronunciation of ${esc(p.en || p.jp)}">🔊</button>` : ''}
      <button type="button" class="phrase-fav${on ? ' is-on' : ''}" data-fav="${esc(id)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="Favorite: ${esc(p.en)}">${on ? '★' : '☆'}</button>
      ${mine}
    </li>`;
}

function render() {
  const wrap = $('#phraseList');
  if (!wrap) return;
  // Owner (2026-07-11): the baked survival phrases are beneath their level now — the page
  // list is USER phrases only (Translate-save + Anki import). Baked phrases stay in tips.json
  // for the dashboard phrase-of-the-day widget and the emergency page.
  const all = loadUser();
  const favs = loadFavs();
  const filtered = favOnly() ? all.filter(p => favs[p.id]) : all;

  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty">${favOnly() ? 'No favorites yet — tap ☆ on a phrase to pin it.' : 'No saved phrases yet — save one from あ→A Translate, or ⬆ import your Anki deck.'}</div>`;
    return;
  }

  const groups = groupByCategory(filtered, CATEGORY_ORDER);
  wrap.innerHTML = groups.map(g => {
    const accId = `ph-cat-${slug(g.cat)}`;
    const rows = g.items.map(p => rowHTML(p, favs)).join('');
    return `<section class="acc phrase-cat" data-acc="${esc(accId)}">
      <button type="button" class="acc-head" aria-expanded="true" aria-controls="acc-panel-${esc(accId)}" aria-label="${esc(g.cat)}">
        <span class="acc-chevron" aria-hidden="true">›</span>
        <span class="acc-title">${esc(g.cat)}</span>
        <span class="acc-count">${esc(String(g.items.length))}</span>
      </button>
      <div class="acc-panel" id="acc-panel-${esc(accId)}" role="region" aria-label="${esc(g.cat)}">
        <div class="acc-inner">
          <ul class="phrase-list">${rows}</ul>
        </div>
      </div>
    </section>`;
  }).join('');

  wireRows();
  wireJpAccents(wrap);                 // keyboard-enable the JS-rendered .jp phrases
  mountAccordion(wrap, { allToggle: $('#phraseCollapseAll') });
}

function wireRows() {
  $$('#phraseList .phrase-fav').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.fav;
    const m = { ...loadFavs() };
    if (m[id]) delete m[id]; else m[id] = true;
    saveFavs(m);
    render();
  }));
  $$('#phraseList .phrase-del').forEach(b => b.addEventListener('click', () => {
    saveUser(removeUserPhrase(loadUser(), b.dataset.del)); render();
  }));
  $$('#phraseList .phrase-spk').forEach(b => b.addEventListener('click', () => speak(b.dataset.jp, b)));
}

// ==== #/survival — "Useful phrases" on its own page (owner 2026-07-11) ====
// The baked survival categories moved here from #/phrases (which is now the study studio).
// Shares the favorites store and the site-wide furigana sentinel; ☆-filter is page-local.
let svFav = false;
export function mountSurvival(data) {
  if (data) DATA = data;
  if (!$('#svList')) return;
  applySvFuri();
  $('#svFuri')?.addEventListener('click', () => { setRaw(KEYS.furi, furiOff() ? '' : 'off'); applySvFuri(); applyFuri(); });
  $('#svFavOnly')?.addEventListener('click', () => {
    svFav = !svFav;
    $('#svFavOnly')?.setAttribute('aria-pressed', String(svFav));
    renderSurvival();
  });
  renderSurvival();
}
function applySvFuri() {
  const off = furiOff();
  $('#survival')?.classList.toggle('furi-off', off);
  const btn = $('#svFuri');
  if (btn) { btn.setAttribute('aria-pressed', off ? 'false' : 'true'); btn.textContent = off ? 'あ Furigana off' : 'あ Furigana'; }
}
function renderSurvival() {
  const wrap = $('#svList'); if (!wrap) return;
  const favs = loadFavs();
  const filtered = svFav ? bakedPhrases().filter(p => favs[p.id]) : bakedPhrases();
  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty">${svFav ? 'No favorites yet — tap ☆ on a phrase to pin it.' : 'No phrases in the dataset.'}</div>`;
    return;
  }
  const groups = groupByCategory(filtered, CATEGORY_ORDER);
  wrap.innerHTML = groups.map(g => {
    const accId = `sv-cat-${slug(g.cat)}`;
    const rows = g.items.map(p => rowHTML(p, favs)).join('');
    return `<section class="acc phrase-cat" data-acc="${esc(accId)}">
      <button type="button" class="acc-head" aria-expanded="true" aria-controls="acc-panel-${esc(accId)}" aria-label="${esc(g.cat)}">
        <span class="acc-chevron" aria-hidden="true">›</span>
        <span class="acc-title">${esc(g.cat)}</span>
        <span class="acc-count">${esc(String(g.items.length))}</span>
      </button>
      <div class="acc-panel" id="acc-panel-${esc(accId)}" role="region" aria-label="${esc(g.cat)}">
        <div class="acc-inner"><ul class="phrase-list">${rows}</ul></div>
      </div>
    </section>`;
  }).join('');
  $$('#svList .phrase-fav').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.fav;
    const m = { ...loadFavs() };
    if (m[id]) delete m[id]; else m[id] = true;
    saveFavs(m);
    renderSurvival();
  }));
  $$('#svList .phrase-spk').forEach(b => b.addEventListener('click', () => speak(b.dataset.jp, b)));
  wireJpAccents(wrap);
  mountAccordion(wrap, { allToggle: $('#svCollapseAll') });
}
