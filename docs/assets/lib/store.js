'use strict';
// Versioned localStorage helpers. All state is device-local; nothing leaves the browser.

export const KEYS = {
  auth: 'jwh-auth-v1',
  events: 'jwh-events-v1',
  calFilters: 'jwh-calfilters-v1',
  calResOpen: 'jwh-cal-resopen-v1',  // Calendars panel: is the collapsible "Researched" group expanded ('open'/'')
  calendars: 'jwh-calendars-v1',     // user-created calendars: [{ id, name, color }] (id doubles as an event category)
  calGoingOnly: 'jwh-cal-goingonly-v1',
  calShowTasks: 'jwh-cal-showtasks-v1',
  calSources: 'jwh-cal-sources-v1',
  calSidebar: 'jwh-cal-sidebar-v1',
  usage: 'jwh-usage-v1',
  people: 'jwh-people-v1',
  compact: 'jwh-compact-v1',
  spend: 'jwh-spend-v1',
  eventOverrides: 'jwh-event-overrides-v1',
  places: 'jwh-places-v1',
  mapFilters: 'jwh-mapfilters-v1',
  dayPlans: 'jwh-dayplans-v1',
  checkOrder: 'jwh-checkorder-v1',
  checkMoves: 'jwh-checkmoves-v1',   // baked checklist item id → the phase-group key it was dragged into
  weather: 'jwh-wx-v1',              // { at: epoch-ms, data: parseWeather() } — dashboard strip cache
  fx: 'jwh-fx-v1',                   // { at: epoch-ms, usd: USD-per-JPY } — budget teaser cache
  evArea: 'jwh-evarea-v1',           // event id → user-edited location/area (Going page ✎)
  evTitle: 'jwh-evtitle-v1',         // event id → user-renamed title (side-panel dblclick; baked events — user events edit their own store)
  evHidden: 'jwh-evhidden-v1',       // baked event ids the user deleted (researched data stays in tips.json)
  widgetOrder: 'jwh-widgetorder-v1',
  arcade: 'jwh-arcade-v1',
  due: 'jwh-due-v1',
  drops: 'jwh-drops-v1',              // timed-release / booking-window tracker cards (editable, synced)
  dismissed: 'jwh-notif-dismissed-v1',
  checklist: 'jwh-checklist-v1',
  catMigrateV1: 'jwh-cal-catmig-v1',            // one-time flag: disney→park event-category rename applied
  seasonalCalMig: 'jwh-cal-seasonalmig-v1',     // one-time flag: researched approx/seasonal events gathered into the "Seasonal (approx)" calendar
  checklistPhases: 'jwh-checklist-phases-v1',   // the phased default items, moved into the store (seeded once from tips.json) — editable + synced
  checklistCustom: 'jwh-checklist-custom-v1',
  checkHideDone: 'jwh-check-hidedone-v1',
  checkPriority: 'jwh-check-priority-v1',
  checkPriorityV2: 'jwh-check-priority-v2',
  checkSmartView: 'jwh-check-smartview',
  theme: 'jwh-theme',
  lang: 'jwh-lang',
  reduceMotion: 'jwh-reduce-motion',
  listCtl: 'jwh-listctl-v1',
  celebrations: 'jwh-celebrations',
  sound: 'jwh-sound',
  brewNotes: 'jwh-brew-notes-v1',
  brewIdeas: 'jwh-brew-ideas-v1',
  rooms: 'jwh-rooms-v1',
  collapse: 'jwh-collapse-v1',
  packing: 'jwh-packing-v1',
  packCustom: 'jwh-pack-custom-v1',
  packOrder: 'jwh-pack-order-v1',
  packHideDone: 'jwh-pack-hidedone-v1',
  budget: 'jwh-budget-v1',
  phraseFav: 'jwh-phrasefav-v1',
  furi: 'jwh-furi-v1',
  dictCache: 'jwh-dict-cache-v1',
  quizStats: 'jwh-quiz-stats-v1',
  phraseCollapseSeed: 'jwh-phrase-collapse-seed-v1',
  checkPhaseCollapseSeed: 'jwh-check-phase-collapse-seed-v1',
  phraseFavView: 'jwh-phrase-favview-v1',
  userPhrases: 'jwh-phrases-user-v1',
  ankiDeck: 'jwh-anki-deck-v1',
  anki: 'jwh-anki-v1',               // Core-2000 rapid refresher: LEGACY single deck (migrated into ankiLib on first load)
  ankiLib: 'jwh-anki-lib-v1',        // deck library INDEX: { v, active, decks:[{id,name,cardCount,importedAt}] }; each deck's data lives under jwh-anki-d-<id>
  ankiHira: 'jwh-anki-hira-v1',      // refresher: hide the reading (hiragana) on cards — 'off' = hidden, '' = shown (default shown)
  ankiEn: 'jwh-anki-en-v1',          // refresher: hide the English meaning on cards — 'off' = hidden (DEFAULT), '' = shown
  ankiEx: 'jwh-anki-ex-v1',          // refresher: hide the example sentence on cards — 'off' = hidden, '' = shown (default shown)
  ankiAutoAdv: 'jwh-anki-autoadv-v1', // refresher: auto-advance delay in seconds ('' = off, e.g. '4' | '8')
  grammar: 'jwh-grammar-v1',         // JLPT grammar reference: { v, done[], shaky[] } (✓ studied / ◆ shaky per point id)
  study: 'jwh-study-v1',             // grammar gym SRS engine: { v, points, session, units, log, examLog, settings } (lib/study.js)
  studyTts: 'jwh-study-tts-v1',      // grammar gym autoplay TTS opt-in ('on'/'') — string sentinel, getRaw/setRaw ONLY (default OFF)
  studyAuto: 'jwh-study-auto-v1',    // grammar gym auto-advance-on-correct opt-in ('on'/'') — string sentinel, getRaw/setRaw ONLY (default OFF, K5)
  kbd: 'jwh-kbd-v1',                 // keyboard shortcuts on/off (WCAG 2.1.4) — string sentinel, getRaw/setRaw ONLY ('' = ON default, 'off' = disabled)
  kbdNudge: 'jwh-kbd-nudge-v1',      // one-time "press ? for shortcuts" nudge seen-flag ('seen'/'') — string sentinel, getRaw/setRaw ONLY (K3)
  mapDark: 'jwh-mapdark-v1',         // dark map tiles opt-in ('on'/'') — CSS filter, dark theme only
  navShow: 'jwh-navshow-v1',         // (legacy) optional routes surfaced in the nav — migrated into navHidden on first read
  navOrder: 'jwh-navorder-v1',       // user's nav page order (array of route ids across ALL candidates)
  navHidden: 'jwh-navhidden-v1',     // routes hidden from the nav (array of ids; deep links still work)
  translateCache: 'jwh-translate-cache-v1',
  tags: 'jwh-tags-v1',
  seed: 'jwh-seed-v1',
  gcalMap: 'jwh-gcal-map-v1',
  seedNearby: 'jwh-seed-nearby-v1',
  fixHousing: 'jwh-fix-housing-v1',
  seedPlan: 'jwh-seed-plan-v1',
  seedPlanTrip: 'jwh-seed-plan-trip-v1',   // one-time: bake the whole Jul 13–26 itinerary into Plan a Day
  seedTodos: 'jwh-seed-todos-v1',          // one-time: drop live trip action-items into the checklist's "My tasks"
};

export function get(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const parsed = JSON.parse(v);
    // type-guard against a corrupted/wrong-typed value (e.g. a bad backup restore) bricking a
    // consumer that does .map()/Object.keys() — when the caller passes a typed fallback, enforce it
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) return fallback;
    return parsed;
  }
  catch { return fallback; }
}
export function set(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch { try { document.dispatchEvent(new CustomEvent('jwh:storage-full')); } catch { /* Node */ } return false; }   // quota → global warning
}
export function getRaw(key, fallback = '') {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; }
}
export function setRaw(key, val) {
  try { localStorage.setItem(key, val); return true; } catch { return false; }
}
export function del(key) { try { localStorage.removeItem(key); } catch {} }
