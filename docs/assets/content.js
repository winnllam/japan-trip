'use strict';
// Renders the data-driven content sections: deadlines, Canada notes, top moves,
// searchable domains, brew scratchpad, the pillar grids, and sources. Fed entirely
// by tips.json. (The dependency-aware checklist lives in checklist-page.js.)

import { $, $$, esc, srcLinks } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { fmtShort, windowStatus, nowISO } from './lib/dates.js';
import { makeSortable } from './dnd.js';
import { placeById, loadPlaces, upsertPlace, patchPlace, deletePlace, catId, dispatchChanged } from './lib/places.js';
import { approxCoord } from './lib/geo.js';
import { alertModal, confirmModal } from './lib/modal.js';
import { attachCardTranslate } from './cardtranslate.js';
import { mountChecklist } from './checklist-page.js';

let DATA = null;
let activeConf = 'all';
let query = '';

export function renderContent(data, today) {
  DATA = data;
  renderTimeSensitive();
  renderHome();
  renderTop(today);
  renderSources();
  renderDomains();
  initBrew();
  mountChecklist(data, today);
  renderPillar('activities', '#activitiesGrid', 'Researching the seasonal calendar…');
  renderPillar('restaurants', '#restaurantsGrid', 'Hunting down the best eats…');
  renderPillar('disney', '#disneyGrid', 'Mapping Disneyland &amp; DisneySea…');
  renderPillar('building', '#buildingGrid', 'Scouting coworking spots &amp; work cafés…');
  renderPillar('music', '#musicGrid', 'Digging through the music scene…');
  renderPillar('geek', '#geekGrid', 'Mapping arcades, anime spots &amp; tech…');
  renderPillar('meetups', '#meetupsGrid', 'Finding meetups &amp; conventions…');
  renderPillar('livemusic', '#livemusicGrid', 'Digging up Tokyo nightlife &amp; gigs…');
  wireControls();
  wireTierFilter();
  wireDiscoverFilter();
  wireCollapsibleCards();
}

// Explore cards: compact by default, click/Enter to expand the full description
function wireCollapsibleCards() {
  const ex = $('#view-explore');
  if (!ex) return;
  const toggle = (card) => {
    const on = card.classList.toggle('expanded');
    card.querySelector('.c-disclosure')?.setAttribute('aria-expanded', String(on));   // state lives on the button
  };
  ex.addEventListener('click', (e) => {
    const disc = e.target.closest('.c-disclosure');                          // the real disclosure button (keyboard handles Enter/Space natively)
    if (disc) { const card = disc.closest('.card2.collapsible'); if (card) toggle(card); return; }
    if (e.target.closest('button, a')) return;                               // other controls (★ Tabetai, links) don't toggle
    const card = e.target.closest('.card2.collapsible'); if (card) toggle(card);   // click anywhere else on the card still expands (mouse convenience)
  });
}

// Discover/Explore filter: by interest (which pillar) + free-text across all pillar cards
function wireDiscoverFilter() {
  const bar = $('#discInterest');
  if (!bar) return;
  const SECMAP = { activities: '#activities', food: '#restaurants', disney: '#disney', building: '#building', gear: '#music', games: '#geek', meetups: '#meetups', nightlife: '#livemusic' };
  const search = $('#discSearch');
  const apply = () => {
    const q = (search?.value || '').trim().toLowerCase();
    const sec = $('#discInterest .chip.active')?.dataset.sec || 'all';
    const area = $('#discArea .chip.active')?.dataset.area || 'all';
    const tier = $('#tierFilters .chip.active')?.dataset.tier || 'all';
    Object.entries(SECMAP).forEach(([k, sel]) => { const el = $(sel); if (el) el.style.display = (sec === 'all' || sec === k) ? '' : 'none'; });
    if (q || area !== 'all') {
      $$('#view-explore .grid .card2').forEach(card => {
        const txt = card.textContent.toLowerCase();
        let show = (!q || txt.includes(q)) && (area === 'all' || txt.includes(area));
        if (show && card.closest('#restaurantsGrid')) show = (tier === 'all' || card.dataset.tier === tier);   // don't override the active tier chips
        card.style.display = show ? '' : 'none';
      });
    } else {
      $$('#view-explore .grid .card2').forEach(card => { card.style.display = ''; });   // clear any search/area-hidden
      applyTierFilter();                                                                // re-assert the restaurant tier filter (don't stomp it)
    }
    // empty-state when an active filter hides everything (ignore cards in interest-hidden sections)
    const filtering = q || area !== 'all' || sec !== 'all';
    const anyVisible = $$('#view-explore .grid .card2').some(c => c.style.display !== 'none' && c.closest('section')?.style.display !== 'none');
    let note = $('#discoverEmpty');
    if (filtering && !anyVisible) {
      if (!note) { note = document.createElement('p'); note.id = 'discoverEmpty'; note.className = 'discover-empty'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite'); bar.insertAdjacentElement('afterend', note); }
      note.textContent = `No matches${q ? ` for “${search.value.trim()}”` : ''}${area !== 'all' ? ` in ${area}` : ''} — try All areas or clear the search.`;
      note.hidden = false;
    } else if (note) { note.hidden = true; }
  };
  search?.addEventListener('input', apply);
  $$('#discInterest .chip, #discArea .chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('active') ? 'true' : 'false'));
  $$('#discInterest .chip, #discArea .chip').forEach(c => c.addEventListener('click', () => {
    [...c.parentElement.querySelectorAll('.chip')].forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    c.classList.add('active'); c.setAttribute('aria-pressed', 'true'); apply();
  }));
}

// ---- content cards (pillars) ----
function metaPills(item) {
  const out = [];
  if (item.area_or_park) out.push(`<span class="pill area">${esc(item.area_or_park)}</span>`);
  if (item.price_or_cost) out.push(`<span class="pill price">${esc(item.price_or_cost)}</span>`);
  return out.join('');
}
let cardSeq = 0;
function contentCard(item, withStar) {
  const tier = (item.tier || 'n/a').toLowerCase();
  const hasBody = !!(item.detail || item.how_or_when || (item.sources && item.sources.length));
  const star = withStar
    ? `<button type="button" class="tabetai-star" data-tb="${esc(catId('restaurants', item.name))}" data-name="${esc(item.name)}" data-area="${esc(item.area_or_park || '')}" aria-pressed="false" aria-label="Tabetai — want to eat ${esc(item.name)}" title="Tabetai (want to eat) — saves to your map &amp; list">☆</button>`
    : '';
  // disclosure pattern: a real <button> owns the expand (valid ARIA) instead of role=button on the
  // container wrapping the star/links as descendants. The star is a SIBLING of the button.
  const bodyId = hasBody ? 'cbody-' + (++cardSeq) : '';
  const head = hasBody
    ? `<button type="button" class="c-name c-disclosure" aria-expanded="false" aria-controls="${bodyId}">${esc(item.name)}<span class="c-chev" aria-hidden="true">▾</span></button>`
    : `<span class="c-name">${esc(item.name)}</span>`;
  return `
    <article class="card2 tier-${esc(tier)} ${hasBody ? 'collapsible' : ''}" data-tier="${esc(tier)}">
      <div class="c-top">${head}${star}</div>
      <div class="c-meta">${metaPills(item)}</div>
      ${hasBody ? `<div class="c-body" id="${bodyId}">
        ${item.detail ? `<div class="c-detail">${esc(item.detail)}</div>` : ''}
        ${item.how_or_when ? `<div class="c-detail"><b>↳</b> ${esc(item.how_or_when)}</div>` : ''}
        ${srcLinks(item.sources)}
      </div>` : ''}
    </article>`;
}
function renderPillar(key, sel, placeholder) {
  const grid = $(sel);
  if (!grid) return;
  const list = DATA[key] || [];
  const withStar = key === 'restaurants';                    // ★ Tabetai only on restaurants
  grid.innerHTML = list.length
    ? list.map(i => contentCard(i, withStar)).join('')
    : `<div class="empty">${placeholder} this fills in as research lands.</div>`;
  if (withStar) wireTabetai(grid);
  if (key === 'music') wireCardTranslate(grid);
}

// inject a 訳 (translate) control on each card of a grid + wire on-demand MT (one grid for now)
function wireCardTranslate(grid) {
  if (!grid) return;
  grid.querySelectorAll('.card2').forEach(card => {
    if (card.querySelector('.ct-btn')) return;                       // once
    const name = (card.querySelector('.c-name')?.textContent || '').replace('▾', '').trim();
    const detail = [...card.querySelectorAll('.c-detail')].map(d => d.textContent.trim()).join(' ');
    if (!name && !detail) return;
    const top = card.querySelector('.c-top'); if (!top) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ct-btn'; btn.setAttribute('aria-label', 'Translate to Japanese'); btn.textContent = '訳';
    const out = document.createElement('div'); out.className = 'ct-out'; out.hidden = true;
    top.appendChild(btn); card.appendChild(out);
    attachCardTranslate(btn, [name, detail], out);
  });
}

// ---- Tabetai (want-to-eat): ★ a restaurant -> a source:'tabetai' place (map pin + saved list) ----
function syncStars(grid) {
  const favs = new Map(loadPlaces().map(p => [p.id, !!p.fav]));   // one read+parse per sync (was one per star)
  grid.querySelectorAll('.tabetai-star').forEach(b => {
    const on = favs.get(b.dataset.tb) === true;                  // ★ reflects the FAV flag, not mere existence (a planned visit is a place but not a star)
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function wireTabetai(grid) {
  syncStars(grid);
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.tabetai-star');
    if (!b) return;
    e.stopPropagation();                                     // don't toggle the card's expand
    const id = b.dataset.tb, existing = placeById(id);
    if (existing && existing.fav) {                          // currently starred → unstar
      if (existing.date || existing.eventId || existing.locked) { patchPlace(id, { fav: false }); dispatchChanged(); }  // keep a planned/locked visit, just un-pin (patchPlace is silent → dispatch)
      else deletePlace(id);                                  // plain want-to-eat -> remove (dispatches)
    } else if (existing) {                                   // exists but unstarred (e.g. a planned visit) → re-star (toggles both ways)
      patchPlace(id, { fav: true }); dispatchChanged();
    } else {
      const c = approxCoord(DATA.areaGeo, b.dataset.area, b.dataset.name);
      upsertPlace({ id, name: b.dataset.name, address: b.dataset.area, lat: c.lat, lng: c.lng, category: 'food', source: 'tabetai', fav: true, coordKind: 'approx', visited: false });
    }
  });
  document.addEventListener('jwh:data-changed', () => syncStars(grid));
}

// ---- deadlines table ----
function renderTimeSensitive() {
  const tb = $('#timeTable tbody');
  const rows = DATA.timeSensitive || [];
  if (!rows.length) { const s = $('#timeSensitiveSection'); if (s) s.style.display = 'none'; return; }
  tb.innerHTML = rows.map(r => {
    const st = r.dueBy ? windowStatus(r.dueBy, nowISO()) : 'none';
    const due = r.dueBy ? `<span class="due-tag ${st}">${esc(fmtShort(r.dueBy))}</span>` : '';
    return `<tr>
      <td>${esc(r.item)} ${due}</td>
      <td>${esc(r.timing)}</td>
      <td>${esc(r.action)}</td>
    </tr>`;
  }).join('');
}

function renderHome() {
  const list = DATA.homeNotes || [];
  const sec = $('#homeSection');
  if (!list.length) { if (sec) sec.style.display = 'none'; return; }
  $('#homeList').innerHTML = list.map(n => `<li>${esc(n)}</li>`).join('');
}

function renderTop() {
  const list = DATA.top10 || [];
  const sec = $('#topSection');
  if (!list.length) { if (sec) sec.style.display = 'none'; return; }
  $('#topGrid').innerHTML = list.map(t => `
    <div class="top-card">
      <div class="t-tip">${esc(t.tip)}</div>
      <div class="t-reason">${esc(t.reason)}</div>
      <div class="t-domain">${esc(t.domain || '')}</div>
    </div>`).join('');
}

function renderSources() {
  const list = DATA.sources || [];
  const sec = $('#sourcesSection');
  if (!list.length) { if (sec) sec.style.display = 'none'; return; }
  $('#sourcesList').innerHTML = list.map(u =>
    `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`).join('');
}

// ---- searchable domains ----
function matches(f) {
  if (activeConf !== 'all' && (f.confidence || '').toLowerCase() !== activeConf) return false;
  if (!query) return true;
  return `${f.tip} ${f.why} ${f.how} ${f.impact}`.toLowerCase().includes(query);
}
function findingHTML(f) {
  const conf = (f.confidence || 'medium').toLowerCase();
  return `
    <div class="finding">
      <div class="finding-top">
        <p class="f-tip">${esc(f.tip)}</p>
        <span class="badge ${conf}">${esc(conf)}</span>
      </div>
      ${f.why ? `<p class="f-why">${esc(f.why)}</p>` : ''}
      ${f.how ? `<p class="f-how"><b>How:</b> ${esc(f.how)}</p>` : ''}
      ${f.impact ? `<p class="f-impact"><b>Impact:</b> ${esc(f.impact)}</p>` : ''}
      ${srcLinks(f.sources, 'f-sources')}
    </div>`;
}
function renderDomains() {
  const wrap = $('#domains');
  if (!wrap) return;
  const domains = DATA.domains || [];
  const visible = domains.filter(d => (d.findings || []).filter(matches).length);
  const any = visible.length > 0;
  // sticky table-of-contents so the long page is navigable without scrolling (reflects active filter)
  const nav = visible.length > 1
    ? `<nav class="domain-nav" aria-label="Jump to a topic">${visible.map(d =>
        `<button type="button" class="dn-chip" data-jump="d-${esc(d.key)}">${esc(d.icon || '•')} ${esc(d.title)}</button>`).join('')}</nav>`
    : '';
  wrap.innerHTML = nav + visible.map(d =>
    `<section class="domain" id="d-${esc(d.key)}">
      <h3 class="domain-head"><span class="d-icon">${esc(d.icon || '•')}</span>${esc(d.title)}</h3>
      ${(d.findings || []).filter(matches).map(findingHTML).join('')}
    </section>`).join('');
  wrap.setAttribute('aria-busy', 'false');
  const reduceM = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reduceMotion === 'on';
  wrap.querySelectorAll('.dn-chip').forEach(b => b.addEventListener('click',
    () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: reduceM ? 'auto' : 'smooth', block: 'start' })));
  if (!any) {
    const filtered = !!query || activeConf !== 'all';
    wrap.innerHTML = `<div class="empty empty-state">
      <div class="empty-emoji" aria-hidden="true">🔍</div>
      <p class="empty-h">${filtered ? 'No tips match your filters.' : 'No tips here yet.'}</p>
      ${filtered ? '<button type="button" class="empty-action" id="domainsClear">Clear filters</button>' : ''}
    </div>`;
    $('#domainsClear')?.addEventListener('click', () => {
      query = ''; activeConf = 'all';
      const s = $('#search'); if (s) s.value = '';
      $$('#confFilters .chip').forEach(c => { const on = c.dataset.conf === 'all'; c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); });
      renderDomains();
    });
  }
}
function wireControls() {
  const s = $('#search');
  if (s) s.addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderDomains(); });
  $$('#confFilters .chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('active') ? 'true' : 'false'));
  $$('#confFilters .chip').forEach(chip => chip.addEventListener('click', () => {
    $$('#confFilters .chip').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
    chip.classList.add('active'); chip.setAttribute('aria-pressed', 'true');
    activeConf = chip.dataset.conf;
    renderDomains();
  }));
}
function applyTierFilter() {
  const t = $('#tierFilters .chip.active')?.dataset.tier || 'all';
  const q = ($('#discSearch')?.value || '').trim().toLowerCase();   // also honour an active search so a tier click doesn't un-hide searched-out cards
  const area = $('#discArea .chip.active')?.dataset.area || 'all';
  $$('#restaurantsGrid .card2').forEach(card => {
    const tierOk = t === 'all' || card.dataset.tier === t;
    const txt = (q || area !== 'all') ? card.textContent.toLowerCase() : '';
    const searchOk = (!q || txt.includes(q)) && (area === 'all' || txt.includes(area));
    card.style.display = (tierOk && searchOk) ? '' : 'none';
  });
}
function wireTierFilter() {
  $$('#tierFilters .chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('active') ? 'true' : 'false'));
  $$('#tierFilters .chip').forEach(chip => chip.addEventListener('click', () => {
    $$('#tierFilters .chip').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-pressed', 'false'); });
    chip.classList.add('active'); chip.setAttribute('aria-pressed', 'true');
    applyTierFilter();
  }));
}

// ---- Brainstorm & Brew ----
function loadIdeas() { return get(KEYS.brewIdeas, []) || []; }
function saveIdeas(arr) { set(KEYS.brewIdeas, arr); }
function initBrew() {
  const pad = $('#brewNotes'), saved = $('#brewSaved');
  if (pad) {
    pad.value = getRaw(KEYS.brewNotes, '');
    let t;
    pad.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        setRaw(KEYS.brewNotes, pad.value);
        if (saved) { saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1200); }
      }, 350);
    });
  }
  const form = $('#brewForm'), input = $('#brewInput');
  if (form && input) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) return;
    // collision-proof id (the old id.slice(1)+ideas.length scheme produced NaN/duplicate keys
    // since ids contain a hyphen → wrong-card deletes + lost reorders)
    saveIdeas([{ id: 'i' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), text: val }, ...loadIdeas()]);
    input.value = '';
    renderIdeas();
  });
  renderIdeas();
}
function renderIdeas() {
  const list = $('#brewList');
  if (!list) return;
  const ideas = loadIdeas();
  if (!ideas.length) { list.innerHTML = `<li class="brew-empty">No idea cards yet — add one above.</li>`; return; }
  list.innerHTML = ideas.map(i => `
    <li class="brew-card" data-id="${esc(i.id)}">
      <button type="button" class="dnd-handle">⠿</button>
      <span>${esc(i.text)}</span>
      <button type="button" data-del="${esc(i.id)}" aria-label="Delete idea">✕</button>
    </li>`).join('');
  list.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', () => {
    saveIdeas(loadIdeas().filter(x => x.id !== b.dataset.del));
    renderIdeas();
  }));
  makeSortable(list, {
    itemSelector: '.brew-card', handleSelector: '.dnd-handle', label: 'idea',
    idOf: el => el.dataset.id,
    onReorder: (ids) => { const by = loadIdeas(); saveIdeas(ids.map(id => by.find(x => x.id === id)).filter(Boolean)); renderIdeas(); },
  });
}

