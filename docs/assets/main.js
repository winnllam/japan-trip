'use strict';
// Boot: gate → load data → mount dashboard, calendar, tracker, content, TOC, service worker.

import { mountGate } from './gate.js';
import { renderContent } from './content.js';
import { mountCalendar, allEvents } from './calendar.js';
import { mountGoogleSync } from './google-sync.js';
import { mountTracker } from './tracker.js';
import { mountDashboard } from './dashboard.js';
import { mountEmergency } from './emergency.js';
import { mountPocket } from './pocket.js';
import { mountPrint } from './print.js';
import { mountEventSearch } from './eventsearch.js';
import { mountExpWeek } from './expweek.js';
import { mountLang } from './lang.js';
import { mountBackup } from './backup.js';
import { mountSync } from './sync.js';
import { initRouter } from './router.js';
import { registerLazyRoute } from './lazyroutes.js';
import { mountGestures } from './gestures.js';
import { mountPalette } from './palette.js';
import { mountGuide, applyCompact } from './guide.js';
import { initKonami } from './konami.js';
import { mountEaster } from './easter.js';
import { stagger } from './motion.js';
import { mountAnim } from './anim.js';
import { mountCountUp } from './countup.js';
import { nowISO } from './lib/dates.js';
import { $, $$, esc } from './lib/dom.js';
import { get, set, KEYS } from './lib/store.js';
import { TRIP_DAYPLANS } from './lib/tripseed.js';
import { customItem, loadChecklistCustom, saveChecklistCustom } from './lib/checklist.js';
import { bumpUsage } from './lib/usage.js';

// Clickjacking defense: a static host can't send X-Frame-Options and frame-ancestors is
// ignored in a <meta> CSP, so bust out of any (cross-origin) frame before rendering.
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch { document.documentElement.style.display = 'none'; }
}

// surface localStorage quota errors (otherwise saves fail silently → data loss)
document.addEventListener('jwh:storage-full', () => {
  import('./lib/modal.js').then(m => m.alertModal('Could not save — this browser’s storage may be full. Back up your data, then clear old items.'));
});

mountGate(boot);

function boot() {
  applyCompact();      // set <html data-compact> just as early — mini-titles must not flash in
  fetch('data/tips.json', { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('Failed to load tips.json'); return r.json(); })
    .then(data => {
      const today = nowISO();
      const m = data.meta || {};
      setText('#footGen', m.generated || '');
      // Each mount is isolated: one feature throwing must NOT blank the whole app — the router
      // still starts and every other page keeps working. Failures log to the console.
      const safe = (fn) => { try { fn(); } catch (err) { console.error('[boot]', err); } };
      safe(seedOnce);                      // one-time: drop a central Tokyo home-base pin (before any mount reads it)
      // (Removed for the tourist revamp: the WHV/July seeders — near-base NE-Tokyo pins,
      //  share-house checklist fixups, the Jul 4 festival day-plan, the Jul 13–26 itinerary,
      //  and the WHV trip todos. Their defs remain below but are no longer invoked.)
      safe(() => mountCalendar(data, today));
      safe(() => mountGoogleSync(() => allEvents()));
      safe(() => mountTracker(data));
      safe(() => renderContent(data, today));
      // EF7: budget + packing are leaf route pages (imported only here, no inbound cross-module
      // events, both render at mount) — lazy-load on first #/budget|#/packing entry. The dashboard
      // budget/packing teasers + readiness widget read from lib/*.js + store, NOT these page modules,
      // so they stay accurate without the pages mounted.
      safe(() => registerLazyRoute(['budget'],  () => import('./budget.js').then(m => m.mountBudget(data))));
      safe(() => registerLazyRoute(['packing'], () => import('./packing.js').then(m => m.mountPacking(data))));
      // (Removed in the tourist revamp: Phrases / Survival Japanese, the JLPT Grammar reference
      //  (#/grammar) and The Grammar Almanac trainer (#/study), plus the phrase-of-the-day widget.
      //  Their modules — phraseday.js, phrasesboot.js, grammar.js, study*.js — stay on disk, unused.)
      // EF5: route-only pages lazy-load on first entry (~76KB off the boot path). people feeds the
      // calendar "縁 met here" jump (jwh:people-open) which awaits ensureRoute('people') in calendar.js.
      safe(() => registerLazyRoute(['eats'],   () => import('./eats.js').then(m => m.mountEats())));
      // EF6: map + plan share ONE lazy bundle. plan.js imports placesModel/drawRoute/clearRoute from
      // map.js, and placesModel() reads map's module-level DATA set ONLY by mountMap — so the bundle
      // always mounts BOTH (map first, to set DATA), on first #/map OR #/plan entry. Leaflet still
      // lazy-loads on top of that, only when #/map is actually shown (map.js enterMap).
      safe(() => registerLazyRoute(['map', 'plan'], () =>
        Promise.all([import('./map.js'), import('./plan.js')]).then(([m, p]) => { m.mountMap(data); p.mountPlan(data); })));
      safe(() => mountDashboard(data, today));   // reads calendar + content, so mount last
      safe(() => mountEmergency(data));    // emergency quick-reference (#/emergency) — read-only, offline
      safe(() => mountPocket(data));       // 🆘 top-bar pocket: dial + tonight's stay + offline, 2 taps away
      safe(() => mountPrint(data, today)); // 🖨 one-page printable trip summary (footer button)
      safe(() => mountEventSearch(data));  // search all events on the calendar page
      safe(() => mountExpWeek());          // "This week" band on #/explore (display-only)
      safe(() => mountLang());             // EN/日本語 chrome toggle + hover-dictionary
      safe(() => mountBackup());           // export/import all device-local trip data
      safe(() => mountSync());             // ☁ optional cloud sync + share link (off unless a store URL is set)
      // Local usage counters (aggregates only, never leaves this device — see ⚙ Guide → "Your usage").
      // Registered BEFORE initRouter so the boot route counts as the first visit.
      safe(() => {
        let _lastUsageRoute = null;   // same-route re-activations (legacy anchors, re-clicked tabs) must not inflate counts
        document.addEventListener('jwh:route', (e) => {
          if (e.detail.route === _lastUsageRoute) return;
          _lastUsageRoute = e.detail.route;
          set(KEYS.usage, bumpUsage(get(KEYS.usage, null), 'route', e.detail.route, nowISO()));
        });
        document.addEventListener('jwh:data-changed', () => set(KEYS.usage, bumpUsage(get(KEYS.usage, null), 'act', 'edits', nowISO())));
      });
      initRouter();                        // hash-router SPA: split views, animated transitions (unwrapped — if THIS fails nothing works anyway)
      safe(() => mountAnim());             // first-visit route-view entrance cascade (reduce-motion gated)
      safe(() => mountCountUp());          // count-up the readiness score on first dashboard view (reduce-motion gated)
      safe(() => mountGestures());         // swipe between pages, keyboard shortcuts, long-press menus
      safe(() => mountPalette(data));      // ⌘K / "/" command palette — jump to any route or content
      safe(() => mountGuide());            // ⚙ Guide & Settings overlay (tutorial + theme/arcade/reduce-motion toggles)
      safe(() => initKonami());            // ↑↑↓↓←→←→ b a → arcade mode
      safe(() => mountEaster());           // hidden interactions + seasonal/2am eggs + mini-synth + console art
      safe(() => stagger($$('.hero > *'), { y: 14, step: 60 }));   // signature hero entrance, once
    })
    .catch(err => {
      // Data (or the router) failed: show the error where it's actually VISIBLE — the views are all
      // hidden until the router activates one, so writing into a view would show a blank page.
      bootError(`Could not load trip data (${err.message}). Check your connection and reload — if running locally, serve over HTTP: python3 -m http.server`);
      try { initRouter(); } catch { /* keep at least the visible error */ }
    });
  registerSW();
}

function setText(sel, txt) { const el = $(sel); if (el) el.textContent = txt; }

// Boot-failure banner: prepended to <main> (a direct child, OUTSIDE the router-hidden views)
// so it is visible even when no view ever activates.
function bootError(msg) {
  const host = $('#main') || document.body;
  const d = document.createElement('div');
  d.className = 'boot-error';
  d.setAttribute('role', 'alert');
  d.innerHTML = `<b>⚠ ${esc(msg)}</b>`;
  host.prepend(d);
}

// One-time seed (guarded by jwh-seed-v1): tick the items the owner has already completed
// (visa granted, passport ready, first accommodation booked, NCD permit in hand) and drop a
// Sakura House home base. Additive only — never un-checks, never overrides an existing home.
// Runs BEFORE any feature mounts so the checklist's first render shows the ticks (the hash
// router won't re-render it later) and the map/dashboard read the seeded place.
function seedOnce() {
  if (get(KEYS.seed, false)) return;
  // Tourist revamp: no WHV checklist to pre-tick. Just drop ONE central Tokyo home-base pin so the
  // Map + Day-planner have an anchor to measure travel from. Placeholder at Shinjuku Station — the
  // owner swaps in their real hotel/area on the Map. Respects the single-home invariant; idempotent.
  const places = get(KEYS.places, []) || [];
  if (!places.some(p => p.id === 'p-home-base')) {
    const hasHome = places.some(p => p.home);
    places.push({ id: 'p-home-base', name: 'My Tokyo base (change to your hotel)', address: '', area: 'Shinjuku', lat: 35.6896, lng: 139.7006, category: 'personal', source: 'seed', coordKind: 'approx', fav: false, locked: false, visited: false, emoji: '🏨', home: !hasHome });
    set(KEYS.places, places);
  }
  set(KEYS.seed, true);
}

// One-time seed (guarded by jwh-seed-nearby-v1): drop the near-base neighborhood pins + the
// World DJ Festival venue, so the map/day-planner can show travel from Makoto. Idempotent by id —
// only adds a pin that isn't already there; never marks any of them home. Runs once per device.
function seedNearby() {
  if (get(KEYS.seedNearby, false)) return;
  const NEARBY = [
    { id: 'p-kameari',   name: 'Kameari — KochiKame statues + Ario', area: 'Kameari',     lat: 35.7608, lng: 139.8487 },
    { id: 'p-shibamata', name: 'Shibamata — Taishakuten + Tora-san town', area: 'Shibamata', lat: 35.7596, lng: 139.8806 },
    { id: 'p-mizumoto',  name: 'Mizumoto Park', area: 'Mizumoto', lat: 35.7869, lng: 139.8689 },
    { id: 'p-tateishi',  name: 'Tateishi — Showa izakaya alley', area: 'Tateishi', lat: 35.7437, lng: 139.8470 },
    { id: 'p-kitasenju', name: 'Kita-Senju — food/izakaya hub', area: 'Kita-Senju', lat: 35.7497, lng: 139.8050 },
    { id: 'p-nishiarai', name: 'Nishiarai Daishi temple', area: 'Nishiarai', lat: 35.7766, lng: 139.7914 },
    { id: 'p-seaforest', name: 'World DJ Festival — Sea Forest Waterway (~2h)', area: 'Koto-ku (Tokyo Bay)', lat: 35.6047, lng: 139.8225 },
  ];
  const places = get(KEYS.places, []) || [];
  const have = new Set(places.map(p => p.id));
  let added = false;
  NEARBY.forEach(p => {
    if (have.has(p.id)) return;
    places.push({ id: p.id, name: p.name, address: '', area: p.area, lat: p.lat, lng: p.lng, category: 'personal', source: 'seed', coordKind: 'approx', fav: false, locked: false, visited: false, emoji: '', home: false });
    added = true;
  });
  if (added) set(KEYS.places, places);
  set(KEYS.seedNearby, true);
}

// One-time correction (jwh-fix-housing-v1): an earlier seed wrongly ticked the LONG-TERM share-house
// items as done. The owner only booked the temporary Makoto Guesthouse — the long-term share house is
// still a real to-do (chk-lock-long-term-housing). Un-tick those two once so the checklist reads true.
// (If the owner has genuinely found their long-term place, they can re-tick — runs only once.)
function fixHousingSeed() {
  if (get(KEYS.fixHousing, false)) return;
  const checks = get(KEYS.checklist, {}) || {};
  let changed = false;
  ['chk-reserve-a-furnished-share-hous', 'chk-line-up-a-no-key-money-share-h-2'].forEach(id => {
    if (checks[id]) { delete checks[id]; changed = true; }
  });
  if (changed) set(KEYS.checklist, checks);
  set(KEYS.fixHousing, true);
}

// One-time seed (jwh-seed-plan-v1): a ready-made Plan-a-Day for the World DJ Festival (Jul 4) so the
// #/plan timeline shows the door-to-door route from Makoto to Sea Forest Waterway with the ~2h buffer
// and the all-important return plan. Won't overwrite a plan the owner already made for that date.
function seedDayPlanJul4() {
  if (get(KEYS.seedPlan, false)) return;
  const DATE = '2026-07-04';
  const plans = get(KEYS.dayPlans, {}) || {};
  if (!plans[DATE]) {
    plans[DATE] = {
      date: DATE,
      title: 'World DJ Festival — Day 1 (Sea Forest Waterway)',
      note: 'Door-to-door ~2h from Makoto. Bring: ticket QR, cash, sunscreen, hat, portable charger, water. SORT YOUR RETURN before you go in — last trains from the bay are ~midnight.',
      stops: [
        { id: 's-jul4-depart', placeId: 'p-sakura-house-makoto', name: 'Depart — Makoto Guesthouse', lat: 35.7684, lng: 139.8264, coordKind: 'approx', area: 'Ayase', startTime: '13:00', durationMin: 0, note: 'Eat first; leave by ~1pm to comfortably catch an afternoon set.', locked: false },
        { id: 's-jul4-transit', placeId: '', name: 'Transit → the bay (Rinkai line)', lat: null, lng: null, coordKind: 'approx', area: 'Shin-Kiba / Tokyo Teleport', startTime: '13:10', durationMin: 90, note: 'Ayase → Yurakucho line → Shin-Kiba → Rinkai line → Tokyo Teleport (Toei bus to the venue) OR Kokusai-Tenjijo (free festival shuttle). Confirm the shuttle stop + times on the official WDJF site.', locked: false },
        { id: 's-jul4-festival', placeId: 'p-seaforest', name: 'World DJ Festival — Sea Forest Waterway', lat: 35.6047, lng: 139.8225, coordKind: 'approx', area: 'Koto-ku (Tokyo Bay)', startTime: '15:00', durationMin: 480, note: 'Day 1: Martin Garrix, Porter Robinson, KSHMR, Galantis, Alok. 3-6-44 Uminomori, Koto-ku.', locked: false },
        { id: 's-jul4-return', placeId: 'p-sakura-house-makoto', name: 'Return — Makoto (plan the exit!)', lat: 35.7684, lng: 139.8264, coordKind: 'approx', area: 'Ayase', startTime: '23:00', durationMin: 0, note: 'THE HARD PART: last trains from the bay are ~midnight. If sets run later, use the official late shuttle to a hub, or budget a taxi (~¥3-5k) to Shin-Kiba then a night route home.', locked: false },
      ],
    };
    set(KEYS.dayPlans, plans);
  }
  set(KEYS.seedPlan, true);
}

// Versioned seed (jwh-seed-plan-trip-v1 stores the applied TRIP_SEED_VERSION): bake the whole
// Jul 13–26 itinerary into Plan a Day so the timeline is ready without any manual paste. A day is
// (re)applied only if it's ABSENT or still a PRISTINE prior seed (every stop id matches the seed
// pattern) — so hand-edited/authored days are always preserved. Bump TRIP_SEED_VERSION to push a
// revised itinerary (e.g. a day swap) to everyone who hasn't customised those days.
const TRIP_SEED_VERSION = 5;
const isPristineSeedDay = (p) => p && Array.isArray(p.stops) && p.stops.length > 0
  && p.stops.every(s => /^p\d{4}[a-z]$/.test(String(s && s.id)));
function seedTripPlans() {
  if ((get(KEYS.seedPlanTrip, 0) || 0) >= TRIP_SEED_VERSION) return;   // old boolean `true` → 1 → still < 2, so it re-seeds once
  const plans = get(KEYS.dayPlans, {}) || {};
  let changed = false;
  for (const [date, day] of Object.entries(TRIP_DAYPLANS)) {
    if (!plans[date] || isPristineSeedDay(plans[date])) { plans[date] = day; changed = true; }
  }
  if (changed) set(KEYS.dayPlans, plans);
  set(KEYS.seedPlanTrip, TRIP_SEED_VERSION);
}

// One-time seed (jwh-seed-todos-v1): drop the live trip action-items into the checklist's "My tasks"
// group so they live on the site, and their due dates feed the notifications bell. Skips any id the
// owner already has (never duplicates); items are normal custom tasks they can tick/edit/delete.
const TODOS_SEED_VERSION = 2;   // bump to add newly-tracked todos; add-only, never removes user items
function seedTripTodos() {
  if ((get(KEYS.seedTodos, 0) || 0) >= TODOS_SEED_VERSION) return;   // old boolean `true` → 1 < 2 → re-runs once to add new ids
  const TODOS = [
    ['todo-call-eye-clinic', 'Call Shinagawa LASIK to lock today’s eye-clinic slot (0120-412-049)', '2026-07-13'],
    ['todo-comiket-wristband', 'Buy the Comiket C108 wristband in Akihabara (¥440 afternoon-advance)', '2026-07-14'],
    ['todo-correct-glasses', 'Get correct-prescription glasses same-day (JINS/Zoff, ~¥5–8k) for the trip', '2026-07-14'],
    ['todo-pack-hokkaido', 'Pack for Hokkaido — rain shell, warm layer, hiking shoes', '2026-07-14'],
    ['todo-cash-hokkaido', 'Withdraw cash for rural Hokkaido (7-Bank ATM)', '2026-07-14'],
    ['todo-lavender-express', 'Reserve the Furano/Lavender Express seat (Sapporo→Furano, Jul 19)', '2026-07-15'],
    ['todo-bed-jul23', 'Book the Jul 23 Sapporo return-night bed', '2026-07-18'],
    ['todo-beds-jul2426', 'Book Tokyo beds for Jul 24–26 (or a bridge hostel)', '2026-07-22'],
    ['todo-book-lasik', 'Book LASIK surgery for after Hokkaido (~Jul 27)', '2026-07-24'],
    ['todo-sharehouse', 'Keep hunting the share house (¥60–80k)', ''],
  ];
  const custom = loadChecklistCustom();
  const have = new Set(custom.map(it => it && it.id));
  const add = TODOS.filter(([id]) => !have.has(id)).map(([id, task, dueBy]) => customItem(task, 'My tasks', dueBy, id));
  if (add.length) saveChecklistCustom([...custom, ...add]);
  set(KEYS.seedTodos, TODOS_SEED_VERSION);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // auto-reload once when a new SW takes control, so users never get stuck on a stale build
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    // don't yank the page out from under an in-progress interaction (typing, an open dialog, a
    // drag-reorder, or the long-press quick-action menu) — a reload mid-drag would drop the unsaved
    // reorder. The fresh build simply lands on the user's next natural reload instead.
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (typing || document.querySelector('[aria-modal="true"], .dnd-dragging, .dnd-grabbed, .lp-menu')) return;
    reloaded = true; location.reload();
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').then((reg) => {
    if (!reg) return;
    // A hash-router SPA does no real navigations, so the browser rarely re-checks sw.js on its own — a
    // tab left open across a deploy keeps running stale code (e.g. an old calendar build). Poll for a
    // new worker at natural moments (tab refocus, in-app route change); when one is found it installs
    // → skipWaiting → claims → the controllerchange handler above reloads. Throttled so it's cheap.
    let last = 0;
    const check = () => {
      const now = Date.now();
      if (now - last < 30000) return;   // at most once / 30s
      last = now; reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    document.addEventListener('jwh:route', check);
  }).catch(() => {}));
}
