'use strict';
// Map page (#/map). PROGRESSIVE ENHANCEMENT over an always-rendered, offline-safe link
// index (#mapList): the grouped Google-Maps links ALWAYS render (the only part that works
// offline). Leaflet + markercluster (unpkg, lazy, network-only, never precached) + OSM
// tiles + Nominatim layer ADDITIVELY into #mapCanvas; if they fail, the link index stands.
//
// All user-place mutation goes through lib/places.js (one source of truth). Pins come from
// THREE sources unified by placesModel(): upcoming events, the baked catalogue (neighbourhood
// centroid + jitter = coordKind 'approx'), and user-saved places (exact for drop/search).
// fav/locked pins live on a separate un-clustered layer (pinTop) so they're always visible.

import { $, esc } from './lib/dom.js';
import { KEYS, get, set, getRaw } from './lib/store.js';
import { areaOf, AREA_ORDER, centroid, jitter } from './lib/geo.js';
import { allEvents } from './calendar.js';   // override-merged view (renames, area edits, reschedules, hidden) — raw DATA.calendar showed stale titles (review #136)
import { haversineKm, estimateMinutes, format as fmtMins, legLabel, totalTransit, areaCount } from './lib/transit.js';
import { directionsUrl } from './lib/directions.js';
import { placesVisitedStats } from './lib/placestats.js';
import {
  loadPlaces, placeById, placeByName, upsertPlace, patchPlace, deletePlace, toggleFav, setHomeBase, catId, slug,
} from './lib/places.js';
import { searchLocal } from './lib/placesearch.js';
import { prefersReducedMotion } from './motion.js';
import { askText, askDate, confirmModal, alertModal } from './lib/modal.js';
import { nowISO, fmtShort } from './lib/dates.js';
import { loadPlans, getPlan, hasPlan } from './lib/dayplan.js';
import { searchJP } from './lib/nominatim.js';
import { fetchNearby } from './lib/wiki.js';

let DATA = null, map = null, pinLayer = null, pinTop = null, routeLayer = null, leafletReady = false, leafletTried = false;
let routeMarkers = [];   // {n, marker} per drawn route stop — lets the detail card fly to a stop
let pendingOps = [];     // focus/route calls made before lazy Leaflet finished loading — flushed by initMap
let armed = false, openPlaceId = null, allBounds = [], mapActive = false, pinsDirty = false, pinsShown = false;
const markersById = new Map();
// milestone latches (per session) — a flourish fires only on CROSSING, not on every re-render
let hitAllAreas = false, hitTenVisited = false, statsPrimed = false;

function gmaps(query) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query + ' Tokyo'); }
function dedupe(arr) { const seen = new Set(); return arr.filter(p => { const k = (p.name || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
function isSoon(d) { if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false; const diff = (Date.parse(d) - Date.now()) / 86400000; return diff >= -1 && diff <= 45; }
const todayISO = () => nowISO();   // local date, consistent with the rest of the app (not UTC)
const ARRIVAL = '2026-10-19';      // land HND — before this, device location is wrong, so route from home

// the single home base (or null). Lookup is just a flag on a user place (spec §1a).
function homeBase() { return loadPlaces().find(p => p.home) || null; }
// Directions origin: home-base coords while planning (today < arrival), else omitted so the
// native Maps app uses live device location. null when no real coord is available.
function dirOrigin() {
  if (todayISO() >= ARRIVAL) return null;
  const h = homeBase();
  return (h && typeof h.lat === 'number' && typeof h.lng === 'number' && !isNaN(h.lat) && !isNaN(h.lng))
    ? { lat: h.lat, lng: h.lng } : null;
}
// destination for a pin: real coords beat a jittered approx centroid (a name searches better)
function dirDest(pt) {
  return (pt.coordKind === 'exact' && typeof pt.lat === 'number' && typeof pt.lng === 'number' && !isNaN(pt.lat) && !isNaN(pt.lng))
    ? { lat: pt.lat, lng: pt.lng } : (pt.name + ' ' + (pt.area || '')).trim();
}
function directionsHref(pt) { return directionsUrl({ from: dirOrigin(), to: dirDest(pt) }); }
// before arrival with no home base, directions can't use a real origin — nudge the user
function dirHint() {
  return (todayISO() < ARRIVAL && !homeBase())
    ? `<div class="pin-hint">Set a 🏠 home base for accurate directions while planning.</div>` : '';
}
// honest neighbourhood-level "≈N min from home (est.)" reusing the area-level estimator.
// Returns a popup HTML fragment (or '' when no home base / the home pin itself).
function fromHomeLine(pt) {
  const h = homeBase(); if (!h || h.id === pt.id) return '';
  const mins = estimateMinutes(h.area || h.address || '', pt.area || pt.address || '', DATA.areaGeo);
  return `<div class="pin-fromhome">${esc(fmtMins(mins))} from home (est.)</div>`;
}

// ---- filter state (persisted) ----
const SRC_CAT = { music: 'music', livemusic: 'music', geek: 'geek', building: 'build', restaurants: 'food', activities: 'seasonal', disney: 'disney', meetups: 'meet', photoSpots: 'photo' };
const CAT_GLYPH = { photo: '📷', music: '🎵', geek: '🕹️', build: '🏙️', food: '🍜', meet: '👥', disney: '🏰', seasonal: '🎏', personal: '📍', stay: '🏠', event: '📅', mine: '⭐' };
// emoji by calendar category (events) — shown beside event names in lists + popups
const EVENT_EMOJI = { festival: '🎏', fireworks: '🎆', illumination: '✨', convention: '🎫', seasonal: '🍡', nature: '🌿', holiday: '🎌', food: '🍜', disney: '🏰', music: '🎵', personal: '📌', imported: '📅' };
// emoji by source pillar — shown beside catalogue places in the area index
const PILLAR_EMOJI = { music: '🎵', geek: '🕹️', building: '🏙️', restaurants: '🍜', livemusic: '🎤', activities: '🎡', disney: '🏰', meetups: '👥' };
const eventEmoji = (cat) => EVENT_EMOJI[cat] || '📅';
// curated, tappable pin-glyph palette (Map v2 §2c) — NOT free-form entry. Single-glyph
// emoji/symbols render inside the dot; the kaomoji are multi-char and render as a label
// beside the pin (see glyphFor / divIcon). '' resets to the category default.
const EMOJI_CHIPS = ['🍜', '🎵', '🕹️', '🏯', '⛩️', '🎏', '🐱', '☕', '🍣', '🗼', '♨', '〒', '(・∀・)', '╰(°▽°)╯'];
// a chip is a "kaomoji label" (renders beside the pin) when it's more than one visual glyph
const isKaomoji = (g) => !!g && [...g].length > 2;
const FILTER_CATS = [
  { key: 'event', label: 'Events' }, { key: 'music', label: 'Music' }, { key: 'food', label: 'Food' },
  { key: 'geek', label: 'Geek' }, { key: 'build', label: 'Buildings' }, { key: 'meet', label: 'Meetups' },
  { key: 'disney', label: 'Disney' }, { key: 'photo', label: 'Photo' }, { key: 'stay', label: 'Stays' }, { key: 'mine', label: 'Yours' },
];
function filters() { return { hidden: [], area: 'all', text: '', ...(get(KEYS.mapFilters, {}) || {}) }; }
function setFilters(f) { set(KEYS.mapFilters, f); }
// local text filter (Map v2 §3) — narrows ALREADY-loaded pins by name/area, no network.
// Distinct from #placeSearch (which geocodes + adds a place). Empty string = no narrowing.
function matchesText(pt, q) {
  if (!q) return true;
  const hay = ((pt.name || '') + ' ' + (pt.area || '') + ' ' + (pt.group || '')).toLowerCase();
  return hay.includes(q);
}
function bucketOf(pt) {
  if (pt.kind === 'user') return 'mine';
  if (pt.kind === 'event') return 'event';
  if (pt.cat === 'personal') return 'stay';          // rooms
  if (pt.cat === 'seasonal') return 'event';         // activities
  return pt.cat;                                      // music/geek/build/food/meet/disney
}

export function mountMap(data) {
  DATA = data;
  renderIndex();                                  // offline-safe link index — ALWAYS
  renderSaved();                                  // your-pins sidebar (works without Leaflet too)
  renderFilters();
  renderStats(true);                              // header "visited X of Y" line (prime latches; no flourish on boot)
  wireAddPlace();
  $('#mapFit')?.addEventListener('click', fitAllPins);
  $('#mapDrop')?.addEventListener('click', toggleArm);
  wireDaySelect();
  wireWiki();
  // detail-card interactions: ✕ clears the route; a stop row flies the map to that pin
  $('#mapRouteDetail')?.addEventListener('click', (e) => {
    if (e.target.closest('.mrd-clear')) { const sel = $('#mapDay'); if (sel) sel.value = ''; clearRoute(); sel?.focus(); return; }   // the focused ✕ was just destroyed — hand focus to the day picker
    const row = e.target.closest('.mrd-stop[data-lat]');
    if (row) focusStop(+row.dataset.lat, +row.dataset.lng, row.dataset.n);
  });
  document.addEventListener('jwh:route', (e) => {
    mapActive = e.detail?.route === 'map';
    if (mapActive) enterMap();
  });
  // off the map route, just mark pins dirty — defer the expensive 200+-marker rebuild until the map is next shown
  document.addEventListener('jwh:data-changed', () => {
    renderStats();   // cheap, pure-counter line — keep it fresh even off the map route
    if (mapActive) { renderSaved(); if (leafletReady) renderPins(); }
    else { pinsDirty = true; }
  });
  // EF6: lazy-mounted on entry — the jwh:route('map') that triggered this mount already fired, so
  // run the entry body here too (Leaflet cold-start). Hash-gated, not .is-active (the view-transition
  // toggle in motion.js runs a microtask later, so is-active is still false during mount).
  if (/^#\/?map$/.test(location.hash)) { mapActive = true; enterMap(); }
}

// the map-route entry body: init Leaflet (lazy), refresh pins + the day picker, redraw today's route.
function enterMap() {
  ensureLeaflet();
  renderSaved();
  populateDaySelect();                // refresh the day-plan list (plans may have changed since last visit)
  // "Today's route": default the picker to today's plan on open (keeps a prior manual pick), and
  // (re)draw the selected day — the route is cleared when leaving the map, so redraw on return.
  const sel = $('#mapDay'), today = nowISO();
  if (sel && !sel.value && hasPlan(today)) sel.value = today;
  if (sel && sel.value) { const p = getPlan(sel.value); if (p) drawRoute(p.stops, { title: p.title, date: sel.value }); }
  if (leafletReady) onMapShown();     // re-measure + catch up once the SPA actually reveals the container
}

// header stats line + visited milestones (Map v2 §2d). Injected into #mapTools (the markup
// is owned by index.html; this owns the live span). `prime` seeds the milestone latches on
// first render so an already-met milestone doesn't fire a flourish on page load.
function renderStats(prime = false) {
  const host = $('#mapTools'); if (!host) return;
  let el = $('#mapStats');
  if (!el) { el = document.createElement('span'); el.id = 'mapStats'; el.className = 'map-stats'; el.setAttribute('aria-live', 'polite'); el.setAttribute('aria-atomic', 'true'); host.appendChild(el); }
  const s = placesVisitedStats(loadPlaces(), areaOf);
  el.textContent = s.total
    ? `You’ve been to ${s.visited} of ${s.total} saved place${s.total === 1 ? '' : 's'} · ${s.areasVisited} of ${s.areasTotal} neighbourhood${s.areasTotal === 1 ? '' : 's'}`
    : '';
  const allAreas = s.areasTotal > 0 && s.areasVisited === s.areasTotal;
  const tenVisited = s.visited >= 10;
  if (prime || !statsPrimed) { hitAllAreas = allAreas; hitTenVisited = tenVisited; statsPrimed = true; return; }
  // fire only on the up-crossing edge; honour the Celebrations setting + reduced motion
  if ((allAreas && !hitAllAreas) || (tenVisited && !hitTenVisited)) milestoneFlourish();
  hitAllAreas = allAreas; hitTenVisited = tenVisited;
}
// a small confetti + torii flourish — reuses the .confetti styling from the celebration infra
function milestoneFlourish() {
  if (getRaw(KEYS.celebrations, '') === 'off') return;   // user disabled celebrations in Settings
  announce('Milestone reached — places visited!');
  if (prefersReducedMotion()) return;
  const wrap = document.createElement('div');
  wrap.className = 'confetti map-flourish'; wrap.setAttribute('aria-hidden', 'true');
  const colors = ['#bc002d', '#223a70', '#b8860b', '#1e8e3e', '#a8228d'];
  for (let i = 0; i < 32; i++) {
    const p = document.createElement('i');
    p.style.left = Math.round((i / 32) * 100) + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (i % 12) * 40 + 'ms';
    p.style.transform = `translateY(0) rotate(${i * 37}deg)`;
    wrap.appendChild(p);
  }
  const torii = document.createElement('b');
  torii.className = 'map-flourish-torii'; torii.textContent = '⛩️';
  wrap.appendChild(torii);
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2600);
}

// nearest neighbourhood bucket for an exact-coord pin, so the area filter matches its real
// location (not a text guess). Falls back to 'Around Tokyo' beyond a sane radius.
function nearestArea(lat, lng) {
  const geo = DATA.areaGeo || {};
  let best = 'Around Tokyo', bestKm = 8;   // ~8km: past this, "nearest" is meaningless in Tokyo
  AREA_ORDER.forEach(a => {
    const c = geo[a]; if (!c || a === 'Around Tokyo') return;
    const km = haversineKm({ lat, lng }, c);
    if (km < bestKm) { bestKm = km; best = a; }
  });
  return best;
}

// ====================================================================== the unified model
// Every map point with a STABLE id, shared by pins + list + sidebar (parity + sync).
// Exported so the Plan-a-Day add-stop picker reuses the same unified point list.
export function placesModel() {
  const today = todayISO();
  const out = [];
  const seenName = new Set();
  const seenId = new Set();
  const users = loadPlaces();
  users.forEach(p => seenName.add((p.name || '').toLowerCase().trim()));
  // 1) user-saved places (exact or approx) — always included. Derive `group` so the
  // neighbourhood filter doesn't hide every personal pin. For exact-coord pins (a dropped/
  // geocoded pin with no address text) bucket by the NEAREST area centroid, not text.
  users.forEach(p => {
    const group = (p.coordKind === 'exact' && typeof p.lat === 'number' && typeof p.lng === 'number')
      ? nearestArea(p.lat, p.lng)
      : areaOf(p.address || p.area || '');
    out.push({ ...p, kind: 'user', cat: p.category || 'personal', group }); seenId.add(p.id);
  });
  // 2) upcoming dated events
  allEvents().filter(e => e.source === 'baked').forEach(e => {
    if (!e.area || !e.date || e.date < today || e.category === 'holiday') return;
    const nm = (e.title || '').toLowerCase().trim();
    if (seenName.has(nm)) return; seenName.add(nm);
    const c = centroid(DATA.areaGeo, areaOf(e.area)), j = jitter(e.title);
    out.push({ id: 'evt:' + slug(e.title), kind: 'event', name: e.title, area: e.area, group: areaOf(e.area),
      lat: c.lat + j.dy, lng: c.lng + j.dx, cat: e.category || 'festival', coordKind: 'approx', date: e.date, pulse: isSoon(e.date) });
  });
  // 2b) user-CREATED calendar events → map + plan picker parity. Skip the auto-spawned
  // Visit:/⏰/plan: events that merely mirror a place (the place is already pinned).
  (get(KEYS.events, []) || []).forEach(e => {
    if (!e.date || e.date < today) return;
    if (/^(Visit: |⏰ )/.test(e.title || '') || String(e.id).startsWith('plan:')) return;
    const nm = (e.title || '').toLowerCase().trim();
    if (!nm || seenName.has(nm)) return; seenName.add(nm);
    const area = e.area || '';   // a free-text note is NOT a location — don't snap the pin to a word it happens to contain
    const c = centroid(DATA.areaGeo, areaOf(area)), j = jitter(e.title);
    out.push({ id: 'uevt:' + e.id, kind: 'event', name: e.title, area, group: areaOf(area),
      lat: c.lat + j.dy, lng: c.lng + j.dx, cat: e.category || 'personal', coordKind: 'approx', date: e.date, pulse: isSoon(e.date) });
  });
  // 3) baked catalogue (carry pillar for a stable catId that reconciles with a favourite)
  Object.keys(SRC_CAT).forEach(pillar => (DATA[pillar] || []).forEach(i => {
    if (!i.name) return;
    const id = catId(pillar, i.name);
    const nm = i.name.toLowerCase().trim();
    if (seenId.has(id) || seenName.has(nm)) return; seenId.add(id); seenName.add(nm);
    const area = i.area || i.area_or_park || '';
    const c = centroid(DATA.areaGeo, areaOf(area)), j = jitter(i.name);
    // catalogue items that carry REAL coords (photoSpots) pin exactly; others centroid+jitter
    const exact = typeof i.lat === 'number' && typeof i.lng === 'number';
    out.push({ id, kind: 'catalogue', pillar, name: i.name, area, group: areaOf(area),
      lat: exact ? i.lat : c.lat + j.dy, lng: exact ? i.lng : c.lng + j.dx, cat: SRC_CAT[pillar], coordKind: exact ? 'exact' : 'approx' });
  }));
  (DATA.rooms || []).forEach(r => {
    if (!r.name) return;
    const id = catId('rooms', r.name), nm = r.name.toLowerCase().trim();
    if (seenId.has(id) || seenName.has(nm)) return; seenId.add(id); seenName.add(nm);
    const c = centroid(DATA.areaGeo, areaOf(r.area)), j = jitter(r.name);
    out.push({ id, kind: 'catalogue', pillar: 'rooms', name: r.name, area: r.area, group: areaOf(r.area),
      lat: c.lat + j.dy, lng: c.lng + j.dx, cat: 'personal', coordKind: 'approx' });
  });
  return out;
}

// ====================================================================== Leaflet bootstrap
// Pinned Subresource-Integrity hashes (sha384, computed from the immutable @version files).
// A tampered/hijacked unpkg asset fails the integrity check → onerror → the offline link
// index stands alone. crossOrigin='anonymous' is required for SRI to be enforced.
const SRI = {
  leafletCss: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H',
  leafletJs: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH',
  mcCss: 'sha384-pmjIAcz2bAn0xukfxADbZIb3t8oRT9Sv0rvO+BR5Csr6Dhqq+nZs59P0pPKQJkEV',
  mcDefCss: 'sha384-wgw+aLYNQ7dlhK47ZPK7FRACiq7ROZwgFNg0m04avm4CaXS+Z9Y7nMu8yNjBKYC+',
  mcJs: 'sha384-eXVCORTRlv4FUUgS/xmOyr66XBVraen8ATNLMESp92FKXLAMiKkerixTiBvXriZr',
};
function loadCSS(href, integrity) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; if (integrity) { l.integrity = integrity; l.crossOrigin = 'anonymous'; } document.head.appendChild(l); }
function loadScript(src, ok, err, integrity) { const s = document.createElement('script'); s.src = src; if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; } s.onload = ok; s.onerror = err; document.head.appendChild(s); }
function ensureLeaflet() {
  if (leafletReady || leafletTried) return;
  leafletTried = true;
  const canvas = $('#mapCanvas'); if (canvas) canvas.classList.add('loading');   // spinner while the lazy CDN scripts arrive (blank canvas reads as broken)
  const fail = () => { leafletTried = false; const e = $('#mapCanvas'); if (e) { e.classList.remove('loading'); e.classList.add('failed'); } };  // offline / integrity-fail → link index stands; retry next visit
  if (window.L && window.L.markerClusterGroup) { initMap(); return; }
  loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', SRI.leafletCss);
  loadCSS('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css', SRI.mcCss);
  loadCSS('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css', SRI.mcDefCss);
  loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    () => loadScript('https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js', initMap, fail, SRI.mcJs), fail, SRI.leafletJs);
}
// The hash router fires jwh:route BEFORE the view is laid out (display:none→block), so a
// Leaflet map measured then reads 0×0 and markercluster renders nothing. Poll until the
// canvas is actually visible, then invalidateSize() (+ renderPins once if off-route edits queued).
function onMapShown(tries = 0) {
  if (!mapActive || !leafletReady) return;
  const el = $('#mapCanvas');
  if (el && el.offsetParent !== null && el.offsetWidth > 0) {
    map.invalidateSize();
    // force one render the first time the canvas has real size — markercluster places
    // nothing if initMap's renderPins() ran while the SPA container was still 0×0
    if (pinsDirty || !pinsShown) { pinsDirty = false; pinsShown = true; renderPins(); }
  } else if (tries < 25) {
    setTimeout(() => onMapShown(tries + 1), 40);
  }
}
function initMap() {
  const el = $('#mapCanvas');
  if (!el || map || !window.L) return;
  el.classList.remove('loading');
  // scrollWheelZoom off (the map is a short panel in a scrollable page — plain scroll must page,
  // not zoom); touchZoom on for mobile pinch; zoomSnap 0 for smooth trackpad-pinch (ctrl+wheel).
  // default view: YOUR neighborhood (the ⛩️ home-base pin) rather than generic central Tokyo —
  // when a day plan is selected, the auto-drawn route re-fits the view right after this anyway.
  const home = loadPlaces().find(p => p.home && typeof p.lat === 'number' && typeof p.lng === 'number');
  map = L.map(el, { scrollWheelZoom: false, touchZoom: true, zoomSnap: 0 })
    .setView(home ? [home.lat, home.lng] : [35.69, 139.73], home ? 14 : 12);
  // Basemap follows the app theme — CARTO light_all / dark_all (free, no key; retina @2x via {r}+detectRetina)
  const basemapUrl = (t) => `https://{s}.basemaps.cartocdn.com/${t === 'light' ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`;
  const curTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const tiles = L.tileLayer(basemapUrl(curTheme()), {
    maxZoom: 20, subdomains: 'abcd', detectRetina: true,
    attribution: '© OpenStreetMap contributors © CARTO',
  }).addTo(map);
  // the theme toggle flips <html data-theme> without firing an event, so watch it and swap tiles live
  new MutationObserver(() => tiles.setUrl(basemapUrl(curTheme())))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // trackpad / laptop 2-finger pinch arrives as ctrl+wheel → zoom around the cursor; a plain wheel
  // (no ctrl) is left alone so the page still scrolls past the map.
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const latlng = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
    // 0.04: owner likes a STRONG pinch — a full trackpad gesture (many small deltas) sweeps several
    // zoom levels. The per-event clamp keeps a single MOUSE ctrl+wheel notch (deltaY≈100) from
    // teleporting 4 levels in one click.
    const dz = Math.max(-1.2, Math.min(1.2, -e.deltaY * 0.04));
    map.setZoomAround(latlng, map.getZoom() + dz);
  }, { passive: false });
  pinLayer = window.L.markerClusterGroup
    ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 46, spiderfyOnMaxZoom: true })
    : L.layerGroup();
  pinTop = L.layerGroup();                          // fav/locked pins never cluster
  map.addLayer(pinLayer); map.addLayer(pinTop);
  // delegated popup buttons for catalogue/event pins (no per-marker listeners)
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'plan') planVisit(b.dataset.id);
    else if (act === 'save') saveCatalogue(b.dataset.id);
  });
  // drop-a-pin: Leaflet's own click (suppressed on markers/popups)
  map.on('click', (e) => { if (armed) dropPin(e.latlng); });
  // Backspace/Delete removes the open (unlocked, user) pin — never while typing
  document.addEventListener('keydown', onKeydown);
  leafletReady = true;
  pendingOps.splice(0).forEach(fn => { try { fn(); } catch { /* the op's target may be gone — fine */ } });
  el.classList.add('ready');
  // Cold-start fix: the canvas is often still 0×0 or short when the SPA reveals #/map, so the first
  // invalidateSize() cached a small size and Leaflet only fetched a strip of tiles. A ResizeObserver
  // re-invalidates whenever the container reaches (or changes to) its real height → full tile grid.
  if (window.ResizeObserver) {
    let last = 0;
    new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h && h !== last) { last = h; map.invalidateSize({ animate: false }); if (!pinsShown) onMapShown(); }   // backstop: if the poll timed out before the container had size, place pins now
    }).observe(el);
  }
  onMapShown();   // poll for real canvas size, then invalidateSize + place pins (cold-start: scripts finished after the route reveal)
}
async function onKeydown(e) {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return;
  const t = e.target;
  if (t && ((t.matches && t.matches('input,textarea,select,[contenteditable]')) || t.isContentEditable)) return;
  if (!openPlaceId) return;
  const id = openPlaceId, p = placeById(id);
  if (!p || p.locked) return;
  e.preventDefault();
  if (await confirmModal(`Delete “${p.name}”?`, { ok: 'Delete', danger: true })) { deletePlace(id); map.closePopup(); }
}

// ====================================================================== pins
function divIcon(pt) {
  const cat = (pt.cat || 'personal').toLowerCase();
  const isHome = pt.kind === 'user' && pt.home;
  const visited = pt.kind === 'user' && pt.visited;
  const cls = ['jwh-pin'];
  if (pt.pulse) cls.push('pulse');
  if (isHome) cls.push('home');
  if (visited) cls.push('visited');
  if (pt.kind === 'user' && pt.fav) cls.push('fav');
  if (pt.kind === 'user' && pt.locked) cls.push('locked');
  // home base ranks above the ★ fav / 🔒 lock badge it already carries
  const badge = isHome ? '<b class="jwh-pin-home">⛩️</b>'
    : (pt.kind === 'user' && pt.fav) ? '<b class="jwh-pin-star">★</b>'
    : (pt.kind === 'user' && pt.locked ? '<b class="jwh-pin-lock">🔒</b>' : '');
  // visited → a red hanko (済) stamp overlay; a custom kaomoji renders as a label beside the pin
  const stamp = visited ? '<b class="jwh-pin-hanko" aria-hidden="true">済</b>' : '';
  const kao = (!isHome && pt.kind === 'user' && isKaomoji(pt.emoji)) ? `<b class="jwh-pin-kao">${esc(pt.emoji)}</b>` : '';
  // a colour-emoji glyph (home torii or a single-glyph custom pick) needs the widened dot
  const g = glyphFor(pt);
  const dotCls = 'jwh-pin-dot cat-' + esc(cat) + (isHome || (pt.kind === 'user' && pt.emoji && !isKaomoji(pt.emoji)) ? ' has-emoji' : '');
  return L.divIcon({ className: cls.join(' '), html: `<i class="${dotCls}" data-g="${esc(g)}"></i>${badge}${stamp}${kao}`, iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10] });
}
// the glyph shown INSIDE the dot: home torii > a single-glyph custom emoji > the category letter.
// A multi-char kaomoji is NOT placed in the dot (it would clip) — it's a label (see divIcon).
function glyphFor(pt) {
  if (pt.kind === 'user' && pt.home) return '⛩️';
  if (pt.kind === 'user' && pt.emoji && !isKaomoji(pt.emoji)) return pt.emoji;
  const b = bucketOf(pt);
  return ({ event: 'E', music: '♪', food: 'F', geek: 'G', build: 'B', meet: 'M', disney: 'D', stay: 'H', mine: '★', photo: '✦' })[b] || '•';
}

function renderPins() {
  if (!pinLayer || !window.L) return;
  pinLayer.clearLayers(); pinTop.clearLayers(); markersById.clear();
  const f = filters();
  const q = (f.text || '').trim().toLowerCase();
  const bounds = [];
  let shown = 0, total = 0;
  placesModel().forEach(pt => {
    if (typeof pt.lat !== 'number' || typeof pt.lng !== 'number' || isNaN(pt.lat) || isNaN(pt.lng)) return;
    total++;
    if (f.hidden.includes(bucketOf(pt))) return;
    if (f.area !== 'all' && pt.group !== f.area) return;
    if (!matchesText(pt, q)) return;
    shown++;
    const top = pt.kind === 'user' && (pt.fav || pt.locked);
    // only YOUR saved pins are tab stops (with a real name for SRs) — the ~200 catalogue pins
    // would otherwise be unnamed keyboard stops; they're all duplicated in the sidebar list
    const m = L.marker([pt.lat, pt.lng], { icon: divIcon(pt), riseOnHover: true, keyboard: pt.kind === 'user' });
    if (pt.kind === 'user') m.on('add', () => { const el = m.getElement(); if (el) { el.setAttribute('role', 'button'); el.setAttribute('aria-label', pt.name); } });
    m.bindPopup(popupFor(pt));
    if (pt.kind === 'user') m.on('popupopen', (e) => { openPlaceId = pt.id; wireUserPopup(pt, e.popup); }).on('popupclose', () => { if (openPlaceId === pt.id) openPlaceId = null; });
    (top ? pinTop : pinLayer).addLayer(m);
    markersById.set(pt.id, m);
    bounds.push([pt.lat, pt.lng]);
  });
  allBounds = bounds;
  const el = $('#mapCount'); if (el) el.textContent = total ? `showing ${shown} of ${total}` : '';
  updateFindCount();   // keep the text-filter match count in sync after any re-render
}

function fitAllPins() {
  if (!map || !allBounds.length) return;
  map.invalidateSize();
  map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 15, animate: !prefersReducedMotion() });
}
// list/sidebar → map: fly to a pin (un-clustering it first if needed) and open its popup
function focusPlace(id) {
  ensureLeaflet();
  const go = () => {
    const m = markersById.get(id);
    if (!m || !map) return;
    const open = () => { map.setView(m.getLatLng(), 15, { animate: !prefersReducedMotion() }); m.openPopup(); announce('Centred map on ' + (placeById(id)?.name || 'pin')); };
    if (pinLayer.zoomToShowLayer && pinLayer.hasLayer(m)) pinLayer.zoomToShowLayer(m, open); else open();
  };
  if (leafletReady) go(); else pendingOps.push(go);   // queue until lazy Leaflet finishes (a fixed timer raced slow CDNs and silently dropped the op)
}
function announce(msg) { const el = $('#mapLive'); if (el) el.textContent = msg; }

// ---- day-plan route line (numbered stops + polyline), called from plan.js ----
export function drawRoute(stops, meta = {}) {
  ensureLeaflet();
  renderRouteDetail(stops, meta);
  const go = () => {
    if (!map || !window.L) return;
    const all = stops || [];
    // keep each stop's FULL-list index so pin numbers match the itinerary even when some stops have no coords
    const pts = all.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => typeof s.lat === 'number' && typeof s.lng === 'number' && !isNaN(s.lat) && !isNaN(s.lng));
    if (!pts.length) { alertModal('These stops have no map location yet — set a pin or pick a place with coordinates.'); return; }   // don't clear a prior route or recenter on nothing
    if (!routeLayer) routeLayer = L.layerGroup().addTo(map);
    routeLayer.clearLayers();
    routeMarkers = [];
    pts.forEach(({ s, n }) => {
      const m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'jwh-route-pin' + (s.coordKind === 'approx' ? ' approx' : ''), html: `<b>${esc(String(n))}</b>`, iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] }), zIndexOffset: 1000, keyboard: false });   // the detail-card legend is the accessible surface for route stops
      m.bindPopup(`<div class="pin-pop"><b>${esc(String(n))}. ${esc(s.name)}</b></div>`);
      routeLayer.addLayer(m);
      routeMarkers.push({ n, marker: m });
    });
    $('#mapCanvas')?.classList.add('route-focus');   // dim the catalogue/saved pins so the route stands out (Flighty focus)
    if (pts.length > 1) {
      const latlngs = pts.map(({ s }) => [s.lat, s.lng]);
      const approx = pts.some(({ s }) => s.coordKind === 'approx');
      const casing = L.polyline(latlngs, { color: '#0a84ff', weight: 9, opacity: .22, lineCap: 'round', lineJoin: 'round', interactive: false });   // Flighty-style glow casing
      routeLayer.addLayer(casing);
      const line = L.polyline(latlngs, { color: '#0a84ff', weight: 3.5, opacity: .95, lineCap: 'round', lineJoin: 'round', dashArray: approx ? '6 7' : null });
      routeLayer.addLayer(line);
      if (!approx) animateDraw(casing, line);   // Flighty-style: the arc draws itself in (dashed/approx routes keep their pattern, no draw-in)
      map.fitBounds(line.getBounds(), { padding: [50, 50], maxZoom: 15, animate: !prefersReducedMotion() });
    } else { map.setView([pts[0].s.lat, pts[0].s.lng], 14, { animate: !prefersReducedMotion() }); }
    const dropped = all.length - pts.length;
    announce(dropped ? `${dropped} stop${dropped > 1 ? 's have' : ' has'} no map location and ${dropped > 1 ? 'are' : 'is'} not shown.` : 'Route drawn.');
  };
  if (leafletReady) go(); else pendingOps.push(go);   // queue until lazy Leaflet finishes (a fixed timer raced slow CDNs and silently dropped the route)
}
export function clearRoute() { if (routeLayer) routeLayer.clearLayers(); routeMarkers = []; $('#mapCanvas')?.classList.remove('route-focus'); const h = $('#mapRouteDetail'); if (h) { h.hidden = true; h.innerHTML = ''; } announce('Route cleared.'); }

// fly the map to a route stop + open its pin (from a detail-card row click)
function focusStop(lat, lng, n) {
  if (!map) return;
  map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: !prefersReducedMotion() });
  const hit = routeMarkers.find(x => String(x.n) === String(n));
  if (hit) hit.marker.openPopup();
}

// route detail card (paper-themed, beside the map): numbered stops + per-leg transit time + totals
function renderRouteDetail(stops, meta = {}) {
  const host = $('#mapRouteDetail'); if (!host) return;
  const all = stops || [];
  const coord = all.filter(s => typeof s.lat === 'number' && !isNaN(s.lat));
  if (!coord.length) { host.hidden = true; host.innerHTML = ''; return; }
  const ag = DATA && DATA.areaGeo;
  const total = totalTransit(coord, ag), areas = areaCount(coord);
  const title = meta.title || (meta.date ? fmtShort(meta.date) : 'Day route');
  const parts = [];
  all.forEach((s, i) => {
    const hasC = typeof s.lat === 'number' && !isNaN(s.lat);
    const inner = `<span class="mrd-n">${i + 1}</span><span class="mrd-body"><span class="mrd-name">${esc(s.name)}</span>${hasC ? (s.area ? `<span class="mrd-area">${esc(areaOf(s.area))}</span>` : '') : '<span class="mrd-nocoord-t">no map location</span>'}</span>`;
    parts.push(hasC
      ? `<li><button type="button" class="mrd-stop" data-lat="${s.lat}" data-lng="${s.lng}" data-n="${i + 1}" title="Show ${esc(s.name)} on the map">${inner}<span class="mrd-go" aria-hidden="true">›</span></button></li>`
      : `<li class="mrd-stop nocoord">${inner}</li>`);
    if (i < all.length - 1) {
      const next = all[i + 1];
      const leg = (hasC && typeof next.lat === 'number' && !isNaN(next.lat)) ? legLabel(s, next, ag) : null;
      parts.push(`<li class="mrd-leg${leg && leg.fuzzy ? ' fuzzy' : ''}"><span class="mrd-legt">${esc(leg ? leg.text : '·')}</span></li>`);
    }
  });
  host.innerHTML = `<div class="mrd-head"><b class="mrd-title">${esc(title)}</b><span class="mrd-sum">${all.length} stop${all.length > 1 ? 's' : ''} · ≈${total} min · ${areas} area${areas > 1 ? 's' : ''}</span><button type="button" class="mrd-clear" aria-label="Clear route from the map">✕</button></div><ol class="mrd-list">${parts.join('')}</ol>`;
  host.hidden = false;
}

// Flighty-style reveal: draw the route polyline(s) in via the SVG stroke-dashoffset trick.
function animateDraw(...lines) {
  if (prefersReducedMotion()) return;
  requestAnimationFrame(() => {
    lines.forEach(l => {
      const p = l && l._path;                       // Leaflet's SVG <path> for this polyline
      if (!p || !p.getTotalLength) return;
      const len = p.getTotalLength();
      if (!len) return;
      p.style.transition = 'none';
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
      void p.getBoundingClientRect();               // reflow so 0 animates instead of snapping
      p.style.transition = 'stroke-dashoffset 950ms cubic-bezier(.22,.61,.36,1)';
      p.style.strokeDashoffset = '0';
    });
  });
}

// ---- map-page day-plan picker: choose a planned day → draw its itinerary path here ----
function populateDaySelect() {
  const sel = $('#mapDay'), wrap = $('#mapDayWrap');
  if (!sel || !wrap) return;
  const plans = loadPlans();
  const dates = Object.keys(plans).filter(hasPlan).sort();
  if (!dates.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Day route…</option>' + dates.map(d => {
    const p = plans[d]; const label = fmtShort(d) + (p.title ? ' · ' + p.title : '');
    return `<option value="${esc(d)}">${esc(label)}</option>`;
  }).join('');
  if (prev && dates.includes(prev)) sel.value = prev;
}
// "📖 What's here?" — Wikipedia geosearch around the current map view (home base before
// Leaflet loads). Read-only card; links open Wikipedia. Reuses the route-detail card styling.
function wireWiki() {
  const btn = $('#mapWikiBtn'), card = $('#mapWiki');
  if (!btn || !card || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const closeRow = `<button type="button" class="mrd-clear" id="mapWikiClose" aria-label="Close nearby articles">✕</button>`;
  btn.addEventListener('click', async () => {
    if (!card.hidden) { card.hidden = true; card.innerHTML = ''; return; }   // toggle off
    const c = (map && leafletReady) ? map.getCenter() : null;
    const home = loadPlaces().find(p => p.home && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const [lat, lng] = c ? [c.lat, c.lng] : home ? [home.lat, home.lng] : [35.68, 139.77];
    card.hidden = false;
    card.innerHTML = `<div class="mrd-head"><b class="mrd-title">📖 Near this view…</b></div>`;
    try {
      const hits = await fetchNearby(lat, lng);
      card.innerHTML = `<div class="mrd-head"><b class="mrd-title">📖 Near this view</b>${closeRow}</div>`
        + (hits.length
          ? `<ol class="mrd-list">${hits.map(h => `<li class="mrd-stop nocoord"><span class="mrd-name"><a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title)} ↗</a></span>${h.dist != null ? `<span class="mrd-leg fuzzy">${esc(String(h.dist))} m</span>` : ''}</li>`).join('')}</ol>`
          : '<p class="mrd-nocoord-t">Nothing on Wikipedia within ~1.5 km of this view.</p>');
      announce(`${hits.length} nearby article${hits.length === 1 ? '' : 's'}.`);
    } catch {
      card.innerHTML = `<div class="mrd-head"><b class="mrd-title">📖 Near this view</b>${closeRow}</div><p class="mrd-nocoord-t">Wikipedia unavailable (offline?).</p>`;
    }
    $('#mapWikiClose')?.addEventListener('click', () => { card.hidden = true; card.innerHTML = ''; btn.focus(); });
  });
}

function wireDaySelect() {
  const sel = $('#mapDay');
  if (!sel || sel.dataset.wired) return;
  sel.dataset.wired = '1';
  sel.addEventListener('change', () => {
    const d = sel.value;
    if (!d) { clearRoute(); return; }
    const plan = getPlan(d);
    if (plan) drawRoute(plan.stops, { title: plan.title, date: d });
  });
}

// ====================================================================== popups
const approxNote = (pt) => pt.coordKind === 'approx' ? `<div class="pin-approx">≈ neighbourhood location</div>` : '';
function popupFor(pt) { return pt.kind === 'user' ? userPopup(pt) : cataloguePopup(pt); }
function cataloguePopup(pt) {
  const saved = !!placeById(pt.id);
  const isFood = pt.cat === 'food';
  const emoji = pt.kind === 'event' ? eventEmoji(pt.cat) : (CAT_GLYPH[bucketOf(pt)] || '📍');
  return `<div class="pin-pop"><b><span aria-hidden="true">${emoji}</span> ${esc(pt.name)}</b>
    ${pt.area ? `<div class="pin-addr">${esc(pt.area)}</div>` : ''}
    ${pt.date ? `<div class="pin-rem">📅 ${esc(pt.date)}</div>` : ''}
    ${approxNote(pt)}
    ${fromHomeLine(pt)}
    <div class="pin-acts">
      <a href="${esc(gmaps(pt.name + ' ' + (pt.area || '')))}" target="_blank" rel="noopener noreferrer">Maps ↗</a>
      <a href="${esc(directionsHref(pt))}" target="_blank" rel="noopener noreferrer">🧭 Directions</a>
      ${pt.kind === 'catalogue' ? `<button type="button" data-act="save" data-id="${esc(pt.id)}">${saved ? '★ Saved' : (isFood ? '⭐ Tabetai' : '★ Save')}</button>` : ''}
      <button type="button" data-act="plan" data-id="${esc(pt.id)}">📅 Plan a visit</button>
    </div></div>`;
}
// curated tappable glyph palette + a "category default" reset (Map v2 §2c). Not a free-form
// picker — selection writes pt.emoji. The currently-set chip is aria-pressed.
function emojiChips(p) {
  const chips = EMOJI_CHIPS.map(g =>
    `<button type="button" class="pin-emoji${p.emoji === g ? ' on' : ''}" data-uact="emoji" data-g="${esc(g)}" aria-pressed="${p.emoji === g ? 'true' : 'false'}" aria-label="Use ${esc(g)} as the pin glyph">${esc(g)}</button>`).join('');
  // stage 22 (design loop): the 15-glyph strip rendered unconditionally in EVERY popup — an
  // edit-once affordance permanently occupying the card (25 interactive els measured vs the
  // site-card ~6). Native <details> collapses it; the delegated .pin-emojis listener still works.
  return `<details class="pin-emowrap">
    <summary class="pin-emosum">${esc(p.emoji || '📍')} change glyph</summary>
    <div class="pin-emojis" role="group" aria-label="Pin glyph">
    ${chips}
    <button type="button" class="pin-emoji pin-emoji-reset${p.emoji ? '' : ' on'}" data-uact="emoji" data-g="" aria-pressed="${p.emoji ? 'false' : 'true'}" aria-label="Reset to the category default glyph" title="Category default">↺</button>
  </div></details>`;
}
function userPopup(p) {
  const safeLink = (p.link && /^https:\/\//i.test(p.link)) ? p.link : '';
  return `<div class="pin-pop">
    <b>${p.home ? '<span aria-hidden="true">⛩️</span> ' : ''}${esc(p.name)}${p.home ? ' <span class="pin-homebadge">home base</span>' : ''}${p.visited ? ' <span class="pin-visited" aria-label="Visited">済</span>' : ''}</b>
    ${p.address ? `<div class="pin-addr">${esc(p.address)}</div>` : ''}
    ${p.note ? `<div class="pin-note">${esc(p.note)}</div>` : ''}
    ${p.remindDate ? `<div class="pin-rem">⏰ ${esc(p.remindDate)}</div>` : ''}
    ${approxNote(p)}
    ${fromHomeLine(p)}
    ${dirHint()}
    ${emojiChips(p)}
    <div class="pin-acts">
      <a href="${esc(directionsHref(p))}" target="_blank" rel="noopener noreferrer">🧭 Directions</a>
      <button type="button" data-uact="visited" aria-pressed="${p.visited ? 'true' : 'false'}" aria-label="${p.visited ? 'Mark as not visited' : 'Mark as visited'}">${p.visited ? '済 Visited' : '✓ Visited'}</button>
      <button type="button" data-uact="note">✎ Note</button>
      <button type="button" data-uact="home" aria-pressed="${p.home ? 'true' : 'false'}" aria-label="${p.home ? 'Unset home base' : 'Set as home base'}">${p.home ? '⛩️ Unset home base' : '🏠 Set as home base'}</button>
      <button type="button" data-uact="fav" aria-pressed="${p.fav ? 'true' : 'false'}">${p.fav ? '★' : '☆'} ${p.fav ? 'Pinned' : 'Pin'}</button>
      <button type="button" data-uact="lock" aria-pressed="${p.locked ? 'true' : 'false'}">${p.locked ? '🔒' : '🔓'}</button>
      <button type="button" data-uact="cal">📅</button>
      <button type="button" data-uact="rem">⏰</button>
      ${p.coordKind === 'approx' ? `<button type="button" data-uact="exact">📍 set exact</button>` : ''}
      ${safeLink ? `<a href="${esc(safeLink)}" target="_blank" rel="noopener noreferrer">🎟 ticket ↗</a>` : ''}
      <button type="button" data-uact="del" aria-label="Delete place"${p.locked ? ' disabled title="unlock to delete"' : ''}>✕</button>
    </div></div>`;
}
function wireUserPopup(p, popup) {
  // Scope to THIS marker's popup element (from the popupopen event), not a global querySelector:
  // during a re-render a closing/stale .leaflet-popup can linger in the DOM, and grabbing the first
  // one wired the buttons onto the dead popup — so the live pin's "set exact" etc. did nothing.
  const root = (popup && popup.getElement && popup.getElement()) || document.querySelector('.leaflet-popup');
  const pop = root && root.querySelector('.pin-pop');
  if (!pop) return;
  const on = (sel, fn) => pop.querySelector(`.pin-acts [data-uact="${sel}"]`)?.addEventListener('click', fn);
  // setHomeBase is a self-dispatching writer (enforces the single-home invariant in one
  // write + ONE change) — do NOT also call change() here, or it double-dispatches.
  on('home', () => { if (p.home) { patchPlace(p.id, { home: false }); change(); } else setHomeBase(p.id); if (map) map.closePopup(); });   // true toggle: set, or un-designate
  on('visited', () => { patchPlace(p.id, { visited: !p.visited }); if (map) map.closePopup(); change(); });
  on('note', () => editNote(p));
  on('fav', () => { patchPlace(p.id, { fav: !p.fav }); map.closePopup(); change(); });
  on('lock', () => { patchPlace(p.id, { locked: !p.locked }); map.closePopup(); change(); });
  on('cal', () => addToCalendar(p));
  on('rem', () => setReminder(p));
  on('exact', () => setExact(p));
  on('del', async () => { if (await confirmModal(`Delete “${p.name}”?`, { ok: 'Delete', danger: true }) && deletePlace(p.id) && map) map.closePopup(); });
  // emoji chips — a curated tappable set; each writes pt.emoji ('' resets to category default)
  pop.querySelector('.pin-emojis')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-uact="emoji"]'); if (!b) return;
    patchPlace(p.id, { emoji: b.dataset.g }); if (map) map.closePopup(); change();
  });
}

// ====================================================================== actions
function pushEvent(title, date, note) {
  const id = 'u' + Date.now();
  set(KEYS.events, [...(get(KEYS.events, []) || []), { id, title, date, endDate: '', category: 'personal', note: note || '' }]);
  return id;
}
function change() { document.dispatchEvent(new CustomEvent('jwh:data-changed')); }

// NOTE: upsertPlace/deletePlace dispatch jwh:data-changed themselves; patchPlace is a SILENT
// writer, so only the patchPlace branches call change() — never double-dispatch (CLAUDE.md).
function saveCatalogue(id) {
  const pt = placesModel().find(x => x.id === id);
  if (!pt) return;
  if (placeById(id)) { patchPlace(id, { fav: true }); change(); }   // already saved → ensure pinned
  else upsertPlace({ id, name: pt.name, address: pt.area || '', lat: pt.lat, lng: pt.lng, category: pt.cat,
    source: pt.pillar === 'restaurants' ? 'tabetai' : 'catalogue', fav: true, coordKind: 'approx', visited: false });
  if (map) map.closePopup();
}
async function planVisit(id) {
  const pt = placesModel().find(x => x.id === id);
  if (!pt) return;
  const existing = placeById(id) || placeByName(pt.name);
  const date = await askDate(`Plan a visit to “${pt.name}” on:`, { value: existing?.date || (DATA.meta?.arrival_date || '2026-06-30') });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return;
  const d = date.trim();
  if (existing?.eventId) removeEvent(existing.eventId);   // clear the old event so we don't orphan it
  const eid = pushEvent('Visit: ' + pt.name, d, pt.area || '');
  // a visit's "Visit:" event IS its reminder — don't also set remindDate (that made clear-reminder delete the visit)
  if (existing) { patchPlace(existing.id, { date: d, remindDate: '', eventId: eid }); change(); }
  else upsertPlace({ id, name: pt.name, address: pt.area || '', lat: pt.lat, lng: pt.lng, category: pt.cat,
    source: pt.pillar === 'restaurants' ? 'tabetai' : 'catalogue', coordKind: 'approx', date: d, remindDate: '', eventId: eid });
  if (map) map.closePopup();
}
async function dropPin(latlng) {
  const name = await askText('Name this pin:', { ok: 'Drop pin' });
  if (!name) { toggleArm(false); return; }
  toggleArm(false);
  const pid = 'p' + Date.now();
  upsertPlace({ id: pid, name, address: '', lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6),
    category: 'personal', source: 'drop', coordKind: 'exact' });   // dispatches → renders synchronously
  setTimeout(() => focusPlace(pid), 50);   // focus by the id we just created (name may collide with an existing place)
}
async function addToCalendar(p) {
  const date = await askDate(`Add “${p.name}” to the calendar on:`, { value: p.date || (DATA.meta?.arrival_date || '2026-06-30') });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return;
  if (p.eventId) removeEvent(p.eventId);
  const eid = pushEvent('Visit: ' + p.name, date.trim(), p.address);
  patchPlace(p.id, { date: date.trim(), eventId: eid, remindDate: '' });   // one event slot per place — clear the stale reminder
  if (map) map.closePopup(); change();
}
// free-text note editor (Map v2 §2b) — prefilled with the current note, prompt nudges
// useful day-of info. No hours schema; one patchPlace + one change().
async function editNote(p) {
  const note = await askText(`Note for “${p.name}” — hours, closed days, cash-only?`, { value: p.note || '', placeholder: 'e.g. closed Tue · cash only · last order 21:00', ok: 'Save note' });
  if (note === null) return;   // cancelled — leave the existing note untouched
  patchPlace(p.id, { note }); if (map) map.closePopup(); change();
}
async function setReminder(p) {
  const date = await askText(`Remind me about “${p.name}” on (blank to clear) — shows in notifications:`, { type: 'date', value: p.remindDate || '', ok: 'Set', min: '2026-01-01', max: '2027-12-31' });
  if (date === null) return;
  const d = date.trim();
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { alertModal('Use a valid date (YYYY-MM-DD).'); return; }
  if (!d) {                                  // clearing a reminder — the shared event slot may hold a VISIT; never destroy that
    if (!p.remindDate) { if (map) map.closePopup(); return; }   // nothing to clear; leave a planned visit intact
    if (p.date) { patchPlace(p.id, { remindDate: '' }); if (map) map.closePopup(); change(); return; }   // a planned visit owns the event — keep it
    if (p.eventId) removeEvent(p.eventId);
    patchPlace(p.id, { remindDate: '', eventId: '' });
    if (map) map.closePopup(); change(); return;
  }
  if (p.eventId) removeEvent(p.eventId);      // setting a reminder replaces whatever the slot held (visit or prior reminder)
  const eid = pushEvent('⏰ ' + p.name, d, p.address);
  patchPlace(p.id, { remindDate: d, eventId: eid, date: '' });
  if (map) map.closePopup(); change();
}
async function setExact(p) {
  const q = await askText(`Address for “${p.name}” (or paste "lat, lng"):`, { value: p.address || '', ok: 'Find' });
  if (!q) return;
  const m = q.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (m) {
    const lat = +m[1], lng = +m[2];
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { alertModal('Those coordinates are out of range.'); return; }
    patchPlace(p.id, { lat, lng, coordKind: 'exact' }); if (map) map.closePopup(); change(); return;
  }
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);   // never hang on a stalled request
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=jp&limit=1&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' }, signal: ctrl.signal });
    const d = r.ok ? await r.json() : [];
    if (!d.length) { alertModal('No match — try a different address or "lat, lng".'); return; }
    const glat = +d[0].lat, glng = +d[0].lon;   // validate the API result before persisting (don't store NaN/out-of-range)
    if (isNaN(glat) || isNaN(glng) || glat < -90 || glat > 90 || glng < -180 || glng > 180) { alertModal('Geocoding returned invalid coordinates.'); return; }
    patchPlace(p.id, { lat: glat, lng: glng, address: d[0].display_name, coordKind: 'exact' });
    if (map) map.closePopup(); change();
  } catch { alertModal('Geocoding unavailable.'); }
  finally { clearTimeout(to); }
}
// SILENT writers — pushEvent/removeEvent do NOT dispatch; every caller follows with change()
// or upsertPlace() (which dispatches), so exactly one jwh:data-changed fires per action.
function removeEvent(id) { set(KEYS.events, (get(KEYS.events, []) || []).filter(x => x.id !== id)); }

function toggleArm(force) {
  armed = (force === true || force === false) ? force : !armed;
  const btn = $('#mapDrop'), el = $('#mapCanvas');
  if (btn) { btn.classList.toggle('armed', armed); btn.setAttribute('aria-pressed', armed ? 'true' : 'false'); btn.textContent = armed ? '✕ Cancel drop' : '＋ Drop a pin'; }
  if (el) el.classList.toggle('arming', armed);
}

// ====================================================================== filters UI
function renderFilters() {
  const wrap = $('#mapFilters'); if (!wrap) return;
  const f = filters();
  const areaOpts = ['<option value="all">All neighbourhoods</option>']
    .concat(AREA_ORDER.map(a => `<option value="${esc(a)}"${f.area === a ? ' selected' : ''}>${esc(a)}</option>`)).join('');
  wrap.innerHTML = `
    <div class="map-chiprow" role="group" aria-label="Filter pins by category">
      ${FILTER_CATS.map(c => `<button type="button" class="map-chip cat-${esc(c.key)}" data-cat="${esc(c.key)}" aria-pressed="${f.hidden.includes(c.key) ? 'false' : 'true'}"><span class="map-chip-dot"></span>${esc(c.label)}</button>`).join('')}
    </div>
    <label class="map-arealbl">Area <select id="mapArea">${areaOpts}</select></label>
    <label class="map-find" title="Narrow the pins already on the map by name or area">
      <span class="map-find-ic" aria-hidden="true">🔎</span>
      <input id="mapFind" type="search" inputmode="search" autocomplete="off" placeholder="Filter pins…" aria-label="Filter shown pins by name or area" value="${esc(f.text || '')}">
    </label>
    <span id="mapFindCount" class="map-find-count" aria-live="polite"></span>`;
  wrap.querySelector('.map-chiprow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    const f2 = filters(); const k = b.dataset.cat;
    f2.hidden = f2.hidden.includes(k) ? f2.hidden.filter(x => x !== k) : [...f2.hidden, k];
    setFilters(f2); b.setAttribute('aria-pressed', f2.hidden.includes(k) ? 'false' : 'true');
    if (leafletReady) renderPins();
  });
  wrap.querySelector('#mapArea').addEventListener('change', (e) => {
    const f2 = filters(); f2.area = e.target.value; setFilters(f2); if (leafletReady) renderPins();
  });
  // text filter: narrow shown pins locally + zoom-to-fit the matches with a live count.
  // Reuses the existing renderPins() filter path — no parallel render.
  const find = wrap.querySelector('#mapFind');
  find.addEventListener('input', () => {
    const f2 = filters(); f2.text = find.value; setFilters(f2);
    if (leafletReady) { renderPins(); fitFiltered(); }
    updateFindCount();
  });
  updateFindCount();
}
// live "N of M shown" beside the text filter; also zoom-fits to the matched pins so a
// search for "shibuya" actually flies there. Only fits while a query is active (no jolt
// when the box is cleared) — clearing restores all pins (renderPins) without moving the map.
function updateFindCount() {
  const el = $('#mapFindCount'); if (!el) return;
  const q = (filters().text || '').trim();
  el.textContent = (q && leafletReady) ? `${allBounds.length} match${allBounds.length === 1 ? '' : 'es'}` : '';
}
function fitFiltered() {
  if (!map || !(filters().text || '').trim() || !allBounds.length) return;
  map.fitBounds(allBounds, { padding: [40, 40], maxZoom: 16, animate: !prefersReducedMotion() });
}

// ====================================================================== your-pins sidebar
function renderSaved() {
  const wrap = $('#mapSaved'); if (!wrap) return;
  const a = document.activeElement;   // preserve keyboard focus across the rebuild (pin/unpin is chainable)
  const focus = (a && wrap.contains(a) && (a.dataset.fav || a.dataset.del || a.dataset.pid))
    ? (a.dataset.fav ? ['fav', a.dataset.fav] : a.dataset.del ? ['del', a.dataset.del] : ['pid', a.dataset.pid]) : null;
  const places = loadPlaces();
  if (!places.length) { wrap.innerHTML = `<h3 class="map-side-h">Your pins</h3><p class="map-empty">No saved pins yet — search a place above, ⭐ a restaurant, or “Drop a pin”.</p>`; return; }
  const home = homeBase();
  // editorial index meta: neighbourhood + (when a home base exists) "≈N min from home"
  const metaFor = (p) => {
    if (p.home) return 'home base';
    const area = areaOf(p.address || p.area || '');
    const mins = (home && (p.area || p.address)) ? ` · ${fmtMins(estimateMinutes(home.area || home.address || '', p.area || p.address || '', DATA.areaGeo))} from home` : '';
    return area + mins;
  };
  const row = (p, i) => {
    // custom emoji (single-glyph or kaomoji) wins over the category default in the sidebar too
    const icon = p.home ? '⛩️' : (p.emoji || CAT_GLYPH[p.source === 'tabetai' ? 'food' : (p.fav ? 'mine' : (p.category || 'personal'))] || '📍');
    const links = [
      (p.date || p.eventId) ? `<a href="#/calendar" class="map-ic" title="On your calendar" aria-label="Open calendar">📅</a>` : '',
      (p.link && /^https:\/\//i.test(p.link)) ? `<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer" class="map-ic" title="Ticket / booking" aria-label="Open ticket link">🎟️</a>` : '',
      `<a href="#/checklist" class="map-ic" title="Your checklist" aria-label="Open checklist">✓</a>`,
    ].join('');
    return `<li class="map-srow${p.fav ? ' is-fav' : ''}${p.home ? ' is-home' : ''}${p.visited ? ' is-visited' : ''}" data-pid="${esc(p.id)}">
      <button type="button" class="map-sgo" data-pid="${esc(p.id)}" aria-label="Show ${esc(p.name)} on map${p.visited ? ' (visited)' : ''}" title="Show on map">
        <span class="map-sno" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
        <span class="map-sicon" aria-hidden="true">${esc(icon)}</span>
        <span class="map-sbody">
          <span class="map-sname">${esc(p.name)}${p.coordKind === 'approx' ? ' <span class="map-approx" aria-hidden="true">≈</span>' : ''}${p.visited ? ' <span class="map-shanko" aria-hidden="true">済</span>' : ''}</span>
          <span class="map-smeta">${esc(metaFor(p))}</span>
        </span>
      </button>
      <span class="map-slinks">${links}
        <button type="button" class="map-ic" data-fav="${esc(p.id)}" aria-pressed="${p.fav ? 'true' : 'false'}" aria-label="${p.fav ? 'Unpin' : 'Pin'} ${esc(p.name)}" title="${p.fav ? 'Pinned — always visible' : 'Pin — always visible'}">${p.fav ? '★' : '☆'}</button>
        <button type="button" class="map-ic" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.name)}"${p.locked ? ' disabled title="locked"' : ''}>✕</button>
      </span></li>`;
  };
  wrap.innerHTML = `<h3 class="map-side-h">Your pins <span class="map-count">${places.length}</span></h3>
    <ul class="map-slist dense-list">${places.map((p, i) => row(p, i)).join('')}</ul>`;
  wrap.querySelectorAll('.map-sgo').forEach(b => b.addEventListener('click', () => focusPlace(b.dataset.pid)));
  wrap.querySelectorAll('[data-fav]').forEach(b => b.addEventListener('click', () => toggleFav(b.dataset.fav)));
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => { if (await confirmModal('Delete this pin?', { ok: 'Delete', danger: true }) && !deletePlace(b.dataset.del)) alertModal('This pin is locked — unlock it first.'); }));
  if (focus) {
    const cs = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
    const sel = focus[0] === 'pid' ? `.map-sgo[data-pid="${cs(focus[1])}"]` : `[data-${focus[0]}="${cs(focus[1])}"]`;
    wrap.querySelector(sel)?.focus();
  }
}

// ====================================================================== offline link index
function renderIndex() {
  const wrap = $('#mapList'); if (!wrap) return;
  const places = [];
  const add = (arr, emoji) => (arr || []).forEach(i => { const area = i.area || i.area_or_park || ''; if (i.name) places.push({ name: i.name, area, group: areaOf(area), emoji }); });
  ['music', 'geek', 'building', 'restaurants', 'livemusic', 'activities', 'disney', 'meetups'].forEach(k => add(DATA[k], PILLAR_EMOJI[k] || '📍'));
  (DATA.rooms || []).forEach(r => places.push({ name: r.name, area: r.area, group: areaOf(r.area), emoji: '🏠' }));
  allEvents().filter(e => e.source === 'baked').forEach(e => { if (e.area && e.category !== 'holiday') places.push({ name: e.title, area: e.area, group: areaOf(e.area), emoji: eventEmoji(e.category) }); });
  const groups = {};
  places.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
  wrap.innerHTML = `<h3 class="map-side-h">All places by area</h3>` + AREA_ORDER.filter(k => groups[k]).map(k => `
    <details class="map-group" open>
      <summary class="map-area"><a href="${esc(gmaps(k))}" target="_blank" rel="noopener noreferrer">📍 ${esc(k)}</a> <span class="map-count">${dedupe(groups[k]).length}</span></summary>
      <ul class="map-places dense-list">${dedupe(groups[k]).map(p => `<li><a href="${esc(gmaps(p.name + ' ' + (p.area || '')))}" target="_blank" rel="noopener noreferrer"><span class="map-emoji" aria-hidden="true">${esc(p.emoji || '📍')}</span> ${esc(p.name)}</a></li>`).join('')}</ul>
    </details>`).join('');
}

// ====================================================================== unified place search
// Two stacked sections in #placeSug that update on their OWN clocks (spec §3.1):
//   .sug-local — INSTANT, offline, synchronous on every keystroke (≥2 chars): searchLocal()
//     over the unified placesModel(). Rows carry data-id → focusPlace() (no place created).
//   .sug-geo   — the UNCHANGED debounced Nominatim path (≥3 chars, 450ms, 1 req/s, abort).
//     Rows carry data-lat/lng/name/addr → geocode-add (+ optional #placeDate→event).
// Each section renders into its own <li> wrapper so the slow geocode fetch never clobbers
// (or is clobbered by) the instant local results.
const SUG_SRC = { user: '★', catalogue: '◆' };       // source badge: ★ saved, ◆ catalogue
function localRow(pt) {
  const badge = SUG_SRC[pt.kind] || '◆';
  const label = pt.kind === 'user' ? 'saved' : 'catalogue';
  const prec = pt.coordKind === 'exact' ? 'exact' : '≈';
  const area = pt.area ? `<span class="sug-area">${esc(pt.area)}</span>` : '';
  return `<li><button type="button" data-id="${esc(String(pt.id))}">
    <span class="sug-badge sug-${esc(pt.kind)}" title="${label}" aria-hidden="true">${badge}</span>
    <span class="sug-name">${esc(pt.name)}</span>${area}
    <span class="sug-prec" aria-hidden="true">${prec}</span>
  </button></li>`;
}
function renderLocalSug(host, q) {
  const hits = q.length >= 2 ? searchLocal(placesModel(), q) : [];
  host.innerHTML = hits.map(localRow).join('');
}
function wireAddPlace() {
  const input = $('#placeSearch'), sug = $('#placeSug');
  if (!input || !sug) return;
  // two independent section containers (created once); local on top, divider + geo below.
  sug.innerHTML = `<li class="sug-local-wrap"><ul class="sug-local"></ul></li><li class="sug-geo-wrap"><ul class="sug-geo"></ul></li>`;
  const localEl = sug.querySelector('.sug-local'), geoEl = sug.querySelector('.sug-geo');
  let timer, controller, lastReq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    renderLocalSug(localEl, q);                       // INSTANT, synchronous, offline — every keystroke
    if (q.length < 3) { geoEl.innerHTML = ''; return; }
    const run = async () => {
      const now = Date.now();
      const wait = 1100 - (now - lastReq);
      if (wait > 0) { timer = setTimeout(run, wait); return; }   // reschedule instead of dropping the follow-up query
      lastReq = now;
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        const matches = await searchJP(q, controller.signal);
        const rows = matches.length ? matches.map(m =>
          `<li><button type="button" data-lat="${esc(String(m.lat))}" data-lng="${esc(String(m.lng))}" data-name="${esc(m.name)}" data-addr="${esc(m.addr)}">${esc(m.addr)}</button></li>`).join('')
          : '<li class="sug-msg">No matches</li>';
        geoEl.innerHTML = `<li class="sug-div" aria-hidden="true">🔍 add new</li>` + rows;
      } catch (e) { if (e.name !== 'AbortError') geoEl.innerHTML = '<li class="sug-msg">Search unavailable — try again</li>'; }
    };
    timer = setTimeout(run, 450);
  });
  const reset = (dateEl) => { input.value = ''; localEl.innerHTML = ''; geoEl.innerHTML = ''; if (dateEl) dateEl.value = ''; };
  sug.addEventListener('click', (e) => {
    // geocode-add path (existing): adds a place + optional #placeDate→event linking
    const g = e.target.closest('button[data-lat]');
    if (g) {
      const dateEl = $('#placeDate');
      const date = (dateEl?.value || '').trim();
      const id = 'p' + Date.now();
      const rec = { id, name: g.dataset.name, address: g.dataset.addr, lat: +g.dataset.lat, lng: +g.dataset.lng, category: 'personal', source: 'searched', coordKind: 'exact' };
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { rec.date = date; rec.remindDate = ''; rec.eventId = pushEvent('Visit: ' + rec.name, date, rec.address); }
      upsertPlace(rec);
      reset(dateEl);
      ensureLeaflet();
      focusPlace(id);
      return;
    }
    // local-focus path: an existing pin (saved or catalogue) — focus it, never create a place.
    // #placeDate is ignored here (documented: it applies only to the geocode-add path).
    const l = e.target.closest('button[data-id]');
    if (!l) return;
    reset($('#placeDate'));
    ensureLeaflet();
    focusPlace(l.dataset.id);
  });
}
