'use strict';
// Guide & Settings — a top-right ⚙ button opens an overlay (NOT a main route) with a short
// how-to-use tutorial plus toggleable settings (theme, arcade mode, reduce motion). All
// settings persist to localStorage and apply via data-attributes on <html>.

import { $, $$, esc } from './lib/dom.js';
import { KEYS, get, set, getRaw, setRaw } from './lib/store.js';
import { listCtl, LISTCTL } from './lib/listctl.js';
import { usageSummary } from './lib/usage.js';
import { ROUTES, routeLabel } from './router.js';
import { makeSortable } from './dnd.js';
import { STRINGS } from './i18n.js';

const LISTCTL_OPTS = [
  { v: LISTCTL.QUICKLINE, label: 'Quick-line' },
  { v: LISTCTL.PILLS, label: 'Pills' },
];

// Compact pages: <html data-compact="on"> shrinks every pillar-head to a one-line mini-title
// (kanji + lede hidden), merges the route-nav INTO the topbar (desktop only — on mobile the nav
// is a drawer and must stay put), and lets the calendar height-lock to the viewport.
export function applyCompact() {
  document.documentElement.dataset.compact = getRaw(KEYS.compact, '') === 'on' ? 'on' : '';
  relocateNav();
}
// Move #routeNav into the .topbar in compact desktop; restore it to its original slot (right after
// the topbar) otherwise. Element identity is preserved, so router/gesture queries keep working.
const DESKTOP = window.matchMedia('(min-width: 821px)');
function relocateNav() {
  const nav = document.getElementById('routeNav'), topbar = document.querySelector('.topbar');
  if (!nav || !topbar) return;
  const wantInBar = document.documentElement.dataset.compact === 'on' && DESKTOP.matches;
  const inBar = nav.parentElement === topbar;
  if (wantInBar && !inBar) topbar.insertBefore(nav, topbar.querySelector('.countdown'));
  else if (!wantInBar && inBar) topbar.parentNode.insertBefore(nav, topbar.nextSibling);
  wireNavFades(nav);
}
// stage 2b (design loop): below ~1240px the compact in-topbar nav scrolls with a hidden
// scrollbar and no hint — fade-l/fade-r classes (same pattern as the Plan-a-Day strip) drive
// CSS mask fades only where content actually overflows.
function wireNavFades(nav) {
  const fades = () => {
    const inBar = nav.parentElement?.classList?.contains('topbar');
    nav.classList.toggle('fade-l', inBar && nav.scrollLeft > 4);
    nav.classList.toggle('fade-r', inBar && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
  };
  if (!nav.dataset.fadeWired) {
    nav.dataset.fadeWired = '1';
    nav.addEventListener('scroll', fades, { passive: true });
    window.addEventListener('resize', fades);
  }
  requestAnimationFrame(fades);
}
DESKTOP.addEventListener('change', relocateNav);   // crossing 820px must restore the drawer / re-merge

// ---- Nav customization (owner 2026-07-13: show/hide + reorder ANY page in the top nav; grew out
// of the earlier "surface the Phrases page" toggle). Deep links keep working for hidden routes —
// parseRoute validates against router ROUTES + HIDDEN, independent of nav visibility. ----
const NAV_ALL = [
  { r: 'dashboard', label: 'Dashboard', i18n: 'nav.dashboard' },
  { r: 'calendar', label: 'Calendar', i18n: 'nav.calendar' },
  { r: 'plan', label: 'Plan a Day', i18n: 'nav.plan' },
  { r: 'map', label: 'Map', i18n: 'nav.map' },
  { r: 'explore', label: 'Explore', i18n: 'nav.explore' },
  { r: 'eats', label: 'Eats', i18n: 'nav.eats' },
  { r: 'checklist', label: 'Checklist', i18n: 'nav.checklist' },
  { r: 'budget', label: 'Budget', i18n: 'nav.budget' },
  { r: 'emergency', label: 'Emergency', i18n: 'nav.emergency' },
  { r: 'packing', label: 'Packing', i18n: 'nav.packing' },
  { r: 'deadlines', label: 'Deadlines', i18n: 'nav.deadlines' },
];
const NAV_KNOWN = new Set(NAV_ALL.map(o => o.r));
const NAV_META = (r) => NAV_ALL.find(o => o.r === r);

// migrate the legacy navShow (which optional routes were surfaced) into a hidden set. Default (no
// stored navHidden): hide all optional routes except phrases, PLUS the routes the owner doesn't use
// (emergency/map/explore) — all still reachable by deep link and re-enableable in this panel.
const NAV_HIDDEN_DEFAULT = [];   // tourist revamp: show the full tourist nav (map/explore/emergency included). Rooms + People routes were removed entirely.
function navHiddenSet() {
  const v = get(KEYS.navHidden, null);
  if (Array.isArray(v)) return v.filter(r => NAV_KNOWN.has(r));
  const OPT = ['packing', 'deadlines'];
  const shown = get(KEYS.navShow, null);
  const shownArr = Array.isArray(shown) ? shown : [];
  return [...OPT.filter(r => !shownArr.includes(r)), ...NAV_HIDDEN_DEFAULT];
}
function navOrder() {
  const v = get(KEYS.navOrder, null);
  let order = Array.isArray(v) ? v.filter(r => NAV_KNOWN.has(r)) : NAV_ALL.map(o => o.r);
  for (const o of NAV_ALL) if (!order.includes(o.r)) order.push(o.r);   // append any route missing from a stored order (forward-compat)
  return [...new Set(order)];   // dedupe defensively (a hand-edited / bad-restore storage value could repeat an id)
}

// Reconcile the live #routeNav <a> list with the stored order + hidden set: create/remove/reorder.
export function applyNav() {
  const nav = document.getElementById('routeNav');
  if (!nav) return;
  const foot = nav.querySelector('.nav-drawer-foot');
  const hidden = new Set(navHiddenSet());
  const curHash = location.hash.replace(/^#\//, '');
  for (const r of navOrder()) {
    const meta = NAV_META(r); if (!meta) continue;
    let a = nav.querySelector(`a[data-route="${r}"]`);
    if (hidden.has(r)) { if (a) a.remove(); continue; }
    if (!a) {
      a = document.createElement('a');
      a.href = '#/' + r; a.dataset.route = r; if (meta.i18n) a.dataset.i18n = meta.i18n;
      const ja = getRaw(KEYS.lang, 'en') === 'ja';   // keep a re-shown link in the active language (lang.js only re-scans on toggle)
      a.textContent = (ja && meta.i18n && STRINGS[meta.i18n]) ? STRINGS[meta.i18n] : meta.label;
    }
    if (curHash === r) a.setAttribute('aria-current', 'page');
    nav.insertBefore(a, foot || null);   // insertBefore re-positions an existing node / appends a new one, in order, ahead of the drawer foot
  }
}

export function mountGuide() {
  applyNav();
  // apply persisted reduce-motion on boot (theme + arcade are restored by their own modules)
  if (getRaw(KEYS.reduceMotion, '') === 'on') document.documentElement.dataset.reduceMotion = 'on';
  if (getRaw(KEYS.mapDark, '') === 'on') document.documentElement.dataset.mapDark = 'on';
  $('#guideBtn')?.addEventListener('click', () => openGuide());
}

let ov = null, lastFocus = null;
function closeGuide() {
  if (!ov) return;
  ov.remove(); ov = null;
  document.removeEventListener('keydown', onKey, true);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function onKey(e) {
  if (!ov) return;
  if (e.key === 'Escape') { e.preventDefault(); closeGuide(); return; }
  if (e.key !== 'Tab') return;
  const f = $$('button, a, [tabindex]:not([tabindex="-1"])', ov).filter(el => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function row(id, label, sub, on) {
  return `<div class="set-row">
    <div class="set-text"><span class="set-label">${label}</span><span class="set-sub">${sub}</span></div>
    <button type="button" class="set-switch" id="${id}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}"><span class="set-knob" aria-hidden="true"></span></button>
  </div>`;
}

// "Your usage" — private, per-device aggregates (lib/usage.js) so the owner can see which
// pages actually earn their keep. Hidden until there's at least one recorded visit.
function usageSectionHTML() {
  const s = usageSummary(get(KEYS.usage, null), ROUTES);
  if (!s.totalVisits) return '';
  const max = s.routes[0]?.n || 1;
  const rows = s.routes.slice(0, 10).map(r =>
    `<div class="use-row"><span class="use-name">${esc(routeLabel(r.route))}</span><span class="use-bar"><i style="width:${Math.max(4, Math.round(r.n / max * 100))}%"></i></span><span class="use-n">${r.n}</span></div>`).join('');
  const never = s.neverUsed.map(r => esc(routeLabel(r))).join(', ');
  return `<section class="guide-sec">
    <h3 class="guide-h">Your usage <span class="use-sub">— this device only, never leaves it</span></h3>
    <p class="use-stats">${s.daysUsed} day${s.daysUsed === 1 ? '' : 's'} active · ${s.totalVisits} page visit${s.totalVisits === 1 ? '' : 's'} · ${s.edits} edit${s.edits === 1 ? '' : 's'}</p>
    <div class="use-list">${rows}</div>
    ${never ? `<p class="use-hint">Never opened on this device: ${never} — candidates to improve or retire.</p>` : ''}
  </section>`;
}

function openGuide() {
  if (ov) { closeGuide(); return; }
  lastFocus = document.activeElement;
  const dark = document.documentElement.dataset.theme === 'dark';
  const arcade = document.documentElement.dataset.arcade === 'on';
  const reduce = document.documentElement.dataset.reduceMotion === 'on';
  const compact = document.documentElement.dataset.compact === 'on';
  const mapDark = document.documentElement.dataset.mapDark === 'on';
  const celebrate = getRaw(KEYS.celebrations, '') !== 'off';   // default on
  const sound = getRaw(KEYS.sound, '') === 'on';               // default off
  const kbd = getRaw(KEYS.kbd, '') !== 'off';                  // keyboard shortcuts, default on (WCAG 2.1.4)
  const listCtlCur = listCtl();
  const navHidden = new Set(navHiddenSet());
  ov = document.createElement('div');
  ov.className = 'guide-overlay';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'guideTitle');
  ov.innerHTML = `<div class="guide-panel">
    <button type="button" class="guide-x" aria-label="Close">✕</button>
    <h2 class="guide-title" id="guideTitle">Guide &amp; Settings</h2>

    <section class="guide-sec">
      <h3 class="guide-h">How to use this</h3>
      <ul class="guide-list">
        <li><b>The pages</b> — Dashboard (your at-a-glance), Calendar (trip events + your own), Plan a Day (build an itinerary), Map (everything pinned), Explore (places &amp; tips), Eats (rate what you eat), Checklist (trip prep), Budget, and Emergency. Phrases has a survival Japanese phrasebook.</li>
        <li><b>Get around</b> — tap the nav, <b>swipe</b> left/right between pages on a phone, or press <b>1–8</b> and <b>[ ]</b> on a keyboard (<b>?</b> shows every shortcut).</li>
        <li><b>Quick actions</b> — <b>long-press</b> a calendar day, an Explore card, or a checklist item for a pop-up menu. Tap <b>★</b> on a restaurant to add it to your map (Tabetai).</li>
        <li><b>Rearrange</b> — drag the ⠿ handle to reorder lists; drag an event chip to another day to reschedule.</li>
        <li><b>Keyboard</b> — press <b>?</b> for the full list; <b>⌘K</b> / <b>/</b> opens the command palette. Turn every single-key shortcut off under <b>Keyboard shortcuts</b> below.</li>
        <li><b>Your data</b> — everything saves on <i>this device only</i>. Use <b>⬇ Back up my data</b> (bottom of the page) before switching phones.</li>
        <li><b>Languages</b> — the <b>あ</b> button toggles a Japanese chrome + hover-dictionary; <b>🌙</b> switches dark mode.</li>
        <li><b>Anki sync</b> — works when you run this dashboard locally (http://localhost) with Anki + the AnkiConnect add-on open, and add that origin to AnkiConnect's webCorsOriginList (per-origin, all-or-nothing — only add origins you trust). On the live site, Export/Import fall back to a file.</li>
      </ul>
    </section>

    <section class="guide-sec">
      <h3 class="guide-h">Settings</h3>
      <div class="set-row">
        <div class="set-text"><span class="set-label">List controls</span><span class="set-sub">How Checklist &amp; Packing search and add</span></div>
        <div class="set-seg" role="radiogroup" aria-label="List controls">
          ${LISTCTL_OPTS.map(o => `<button type="button" class="seg-btn" role="radio" data-listctl-opt="${o.v}" aria-checked="${o.v === listCtlCur ? 'true' : 'false'}">${o.label}</button>`).join('')}
        </div>
      </div>
      ${row('setTheme', 'Dark mode', 'Easier on the eyes at night', dark)}
      ${row('setArcade', 'Arcade mode', 'Extra retro CRT glow &amp; pixel flair', arcade)}
      ${row('setReduce', 'Reduce motion', 'Minimise animations and transitions', reduce)}
      ${row('setCompact', 'Compact pages', 'Small titles, more content — the calendar fits one screen', compact)}
      ${row('setMapDark', 'Dark map tiles', 'Night-mode map when dark theme is on (opt-in)', mapDark)}
      ${row('setCelebrate', 'Celebrations', 'Confetti when you finish things', celebrate)}
      ${row('setSound', 'Sound effects', 'Chiptune blips on milestones &amp; eggs', sound)}
      ${row('setKbd', 'Keyboard shortcuts', 'Single-key shortcuts (grade with 1–4, [ ] to switch pages…)', kbd)}
    </section>

    <section class="guide-sec">
      <h3 class="guide-h">Navigation <span class="use-sub">— show, hide &amp; reorder your pages</span></h3>
      <p class="set-sub nav-cfg-hint">Toggle a page off to hide it from the top nav (deep links still work). Drag the ⠿ handle to reorder — swipe and number shortcuts follow this order.</p>
      <ul class="nav-cfg" id="navCfg" aria-label="Navigation pages">
        ${navOrder().map(r => { const o = NAV_META(r); const shown = !navHidden.has(r); return `<li class="nav-cfg-row" data-r="${esc(r)}">
          <span class="nav-cfg-grip" aria-hidden="true">⠿</span>
          <span class="nav-cfg-name">${esc(o.label)}</span>
          <button type="button" class="set-switch" role="switch" aria-checked="${shown ? 'true' : 'false'}" data-navtoggle="${esc(r)}" aria-label="Show ${esc(o.label)} in the navigation"><span class="set-knob" aria-hidden="true"></span></button>
        </li>`; }).join('')}
      </ul>
    </section>
    ${usageSectionHTML()}
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.guide-x')) closeGuide(); });

  // --- settings wiring ---
  const setSwitch = (id, on) => { const b = $('#' + id, ov); if (b) b.setAttribute('aria-checked', on ? 'true' : 'false'); };
  $('#setTheme', ov)?.addEventListener('click', () => {
    $('#themeToggle')?.click();                                   // single source of truth (also updates the topbar button)
    setSwitch('setTheme', document.documentElement.dataset.theme === 'dark');
  });
  $('#setArcade', ov)?.addEventListener('click', () => {
    const on = document.documentElement.dataset.arcade === 'on';
    document.documentElement.dataset.arcade = on ? '' : 'on';
    setRaw(KEYS.arcade, on ? '' : 'on');
    setSwitch('setArcade', !on);
  });
  $('#setReduce', ov)?.addEventListener('click', () => {
    const on = document.documentElement.dataset.reduceMotion === 'on';
    document.documentElement.dataset.reduceMotion = on ? '' : 'on';
    setRaw(KEYS.reduceMotion, on ? '' : 'on');
    setSwitch('setReduce', !on);
  });
  $('#setCompact', ov)?.addEventListener('click', () => {
    const on = document.documentElement.dataset.compact === 'on';
    setRaw(KEYS.compact, on ? '' : 'on');
    applyCompact();
    setSwitch('setCompact', !on);
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));   // active views re-render so compact-aware bits (month chip cap) flip instantly
  });
  // Nav customization: per-page show/hide switches + drag-to-reorder (keyboard-accessible via dnd.js)
  const navCfg = $('#navCfg', ov);
  navCfg?.querySelectorAll('[data-navtoggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.navtoggle;
      const hid = new Set(navHiddenSet());
      if (hid.has(r)) hid.delete(r); else hid.add(r);
      set(KEYS.navHidden, [...hid]);
      applyNav();
      btn.setAttribute('aria-checked', hid.has(r) ? 'false' : 'true');
    });
  });
  makeSortable(navCfg, {
    itemSelector: '.nav-cfg-row', handleSelector: '.nav-cfg-grip', label: 'page',
    idOf: el => el.dataset.r,
    onReorder: (ids) => { set(KEYS.navOrder, ids); applyNav(); },
  });
  $('#setMapDark', ov)?.addEventListener('click', () => {
    const on = document.documentElement.dataset.mapDark === 'on';
    document.documentElement.dataset.mapDark = on ? '' : 'on';
    setRaw(KEYS.mapDark, on ? '' : 'on');
    setSwitch('setMapDark', !on);
  });
  $('#setCelebrate', ov)?.addEventListener('click', () => {
    const on = getRaw(KEYS.celebrations, '') !== 'off';        // currently on?
    setRaw(KEYS.celebrations, on ? 'off' : 'on');
    setSwitch('setCelebrate', !on);
  });
  $('#setSound', ov)?.addEventListener('click', () => {
    const on = getRaw(KEYS.sound, '') === 'on';               // currently on? (default off)
    setRaw(KEYS.sound, on ? 'off' : 'on');
    setSwitch('setSound', !on);
  });
  $('#setKbd', ov)?.addEventListener('click', () => {
    const on = getRaw(KEYS.kbd, '') !== 'off';               // currently on? (default on)
    setRaw(KEYS.kbd, on ? 'off' : '');                        // '' = on sentinel (default), 'off' = disabled
    setSwitch('setKbd', !on);
  });
  $$('.set-seg [data-listctl-opt]', ov).forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.listctlOpt === LISTCTL.PILLS ? LISTCTL.PILLS : LISTCTL.QUICKLINE;
    setRaw(KEYS.listCtl, v);
    $$('.set-seg [data-listctl-opt]', ov).forEach(x => x.setAttribute('aria-checked', x.dataset.listctlOpt === v ? 'true' : 'false'));
    document.dispatchEvent(new CustomEvent('jwh:settings-changed'));   // checklist + packing re-render their toolbars
  }));

  document.addEventListener('keydown', onKey, true);
  const panel = ov;   // capture locally — closeGuide() may null the module-level `ov` before this fires
  setTimeout(() => { if (panel.isConnected) panel.querySelector('.guide-x')?.focus(); }, 20);
}
