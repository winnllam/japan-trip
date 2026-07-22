'use strict';
// Command palette overlay — Cmd/Ctrl+K or "/" opens a centered, focus-trapped search dialog
// over all 11 nav routes + the reachable hidden ones (study, grammar) + baked content
// (pillars, phrases, checklist, packing, deadlines).
// Pure index/ranking lives in lib/palette.js; this file is the DOM + interaction shell.
// Every dynamic string goes through esc() with double-quoted attributes only.

import { ROUTES, routeLabel, markNavSource, parseRoute } from './router.js';
import { buildIndex, searchIndex, buildUserEntries, routeKeys } from './lib/palette.js';
import { KEYS, get } from './lib/store.js';
import { shortcutsEnabled } from './lib/shortcuts.js';
import { esc } from './lib/dom.js';

const KIND_ICON = { route: '➜', content: '◦' };
// K5: the two research-blessed HIDDEN routes the palette also reaches (they're excluded from the
// nav-ordered ROUTES, so they'd otherwise be unreachable here). Both are deep-linkable + parseRoute-known.
const HIDDEN_REACHABLE = [];

let BAKED = [];          // static baked half, built once at mount
let INDEX = [];          // BAKED + user content, rebuilt fresh each open
let overlay = null;      // the live .cmdk-overlay (single instance) or null
let activeIdx = -1;      // highlighted option index
let results = [];        // current rendered entries

export function mountPalette(data) {
  const routeLabels = Object.fromEntries(ROUTES.map(r => [r, routeLabel(r)]));
  for (const r of HIDDEN_REACHABLE) routeLabels[r] = routeLabel(r);   // reach #/study + #/grammar
  BAKED = buildIndex(data, routeLabels);
}

// the VISIBLE nav order (same read as gestures.js) — drives the 1–9 route-jump key chips.
function visibleRoutes() {
  const nav = document.getElementById('routeNav');
  const rs = nav ? [...nav.querySelectorAll('a[data-route]')].map(a => a.dataset.route).filter(Boolean) : [];
  return rs.length ? rs : ROUTES;
}

// public: open the palette (no-op if one is already open). The trigger (gestures.js) calls this.
export function openPalette() {
  if (overlay || document.querySelector('.cmdk-overlay')) return;
  // rebuild the user half fresh every open so add/edit/delete is reflected without a data-changed listener
  INDEX = [...BAKED, ...buildUserEntries({
    events: get(KEYS.events, []),
    places: get(KEYS.places, []),
    checklistCustom: get(KEYS.checklistCustom, []),
    packCustom: get(KEYS.packCustom, []),
  })];
  const prevFocus = document.activeElement;

  overlay = document.createElement('div');
  overlay.className = 'cmdk-overlay';
  overlay.innerHTML = `
    <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
      <input class="cmdk-input" type="text" autocomplete="off" autocapitalize="off"
        spellcheck="false" placeholder="Jump to a page or find anything…"
        role="combobox" aria-expanded="true" aria-controls="cmdkList" aria-autocomplete="list">
      <ul class="cmdk-list" id="cmdkList" role="listbox" aria-label="Results"></ul>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.cmdk-input');
  const list = overlay.querySelector('.cmdk-list');
  // K5 Superhuman-teaches: each route row that has a live direct key shows it as a right-aligned chip.
  // Empty when shortcuts are turned off (WCAG 2.1.4) — a chip would point at a key that no longer commands.
  const keyMap = shortcutsEnabled() ? routeKeys(visibleRoutes()) : {};

  const close = () => {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null; activeIdx = -1; results = [];
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };

  const render = () => {
    results = searchIndex(INDEX, input.value);
    activeIdx = results.length ? 0 : -1;
    if (!results.length) {
      list.innerHTML = `<li class="cmdk-empty" role="option" aria-disabled="true">No matches</li>`;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    list.innerHTML = results.map((e, i) => {
      const sub = e.sub ? `<span class="cmdk-sub">${esc(e.sub)}</span>` : '';
      const mine = e.mine ? `<span class="cmdk-mine" aria-label="your content" title="yours">★</span>` : '';
      const k = e.kind === 'route' ? keyMap[e.route] : null;
      const key = k ? `<kbd class="cmdk-key" aria-hidden="true">${esc(k)}</kbd>` : '';
      return `<li class="cmdk-opt${i === activeIdx ? ' is-active' : ''}" role="option" id="cmdk-opt-${i}"`
        + ` data-i="${i}" aria-selected="${i === activeIdx ? 'true' : 'false'}">`
        + `<span class="cmdk-ic" aria-hidden="true">${esc(KIND_ICON[e.kind] || '')}</span>`
        + `<span class="cmdk-lab">${esc(e.label)}</span>${sub}${mine}${key}</li>`;
    }).join('');
    input.setAttribute('aria-activedescendant', 'cmdk-opt-' + activeIdx);
  };

  const setActive = (i) => {
    if (!results.length) return;
    activeIdx = (i + results.length) % results.length;
    overlay.querySelectorAll('.cmdk-opt').forEach((li, idx) => {
      const on = idx === activeIdx;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    input.setAttribute('aria-activedescendant', 'cmdk-opt-' + activeIdx);
    overlay.querySelector('.cmdk-opt.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const activate = (i, viaKey = false) => {
    const entry = results[i];
    if (!entry) return;
    close();
    // Enter-driven selection swaps instantly like the 1-9/[/] nav keys; a tapped row keeps the
    // normal view transition (same keyboard-skips-the-swipe rule as gestures' goKbd — including its
    // same-route guard: an identical hash fires no hashchange, which would strand a stale flag).
    if (viaKey && entry.route !== parseRoute(location.hash)) markNavSource('keyboard');
    location.hash = '#/' + entry.route;   // route comes from ROUTES or HIDDEN_REACHABLE — both hardcoded, safe
  };

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0) activate(activeIdx, true); return; }
    if (e.key === 'Tab') {   // trap focus — input is the only focusable, keep it focused
      e.preventDefault(); input.focus();
    }
  }

  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', render);
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.cmdk-opt[data-i]');
    if (li) activate(+li.dataset.i);
  });
  list.addEventListener('pointermove', (e) => {
    const li = e.target.closest('.cmdk-opt[data-i]');
    if (li) setActive(+li.dataset.i);
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });   // backdrop

  render();
  setTimeout(() => input.focus(), 20);
}
