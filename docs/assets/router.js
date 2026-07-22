'use strict';
// Tiny hash router for the SPA. Routes #/dashboard #/calendar #/deadlines #/checklist
// #/explore; maps legacy section anchors to their route; animates view swaps via
// motion.transitionView; moves focus to the view heading for a11y.

import { transitionView } from './motion.js';

// deadlines/packing/phrases retired from the nav post-arrival (their views + data remain for the
// dashboard/notifications; re-add here + in index.html to restore).
export const ROUTES = ['dashboard', 'calendar', 'plan', 'map', 'explore', 'eats', 'checklist', 'budget', 'emergency'];

// retired from the nav but still deep-linkable — dashboard teasers/notifications link here
// (#/deadlines, #/packing) and the views stay mounted; they're just not in the swipe/nav order.
const HIDDEN = ['deadlines', 'packing'];

// legacy section id → route (for intercepting old in-app anchor links)
const LEGACY = {
  main: 'dashboard', dashHome: 'dashboard',
  calendarSection: 'calendar',
  trackerSection: 'dashboard', timeSensitiveSection: 'dashboard', topSection: 'dashboard',   // deadlines route retired → land on the dashboard
  checklist: 'checklist',
  controls: 'explore', brew: 'explore', activities: 'explore', restaurants: 'explore',
  disney: 'explore', building: 'explore', music: 'explore', geek: 'explore',
  meetups: 'explore', homeSection: 'explore', sourcesSection: 'explore',
  livemusic: 'explore', rooms: 'dashboard', people: 'dashboard', map: 'map', plan: 'plan',
};

// pure: parse a hash string into a route (exported for unit testing)
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  if (ROUTES.includes(h) || HIDDEN.includes(h)) return h;
  if (LEGACY[h]) return LEGACY[h];
  return 'dashboard';
}

let current = null;

// Route-swap source flag (K1 motion): gestures sets this to 'keyboard' BEFORE mutating location.hash
// on a keyboard route-swap; activate() reads + consumes it before transitionView() to render the swap
// INSTANTLY (no View Transition) — a keyboard nav should never animate (Binding Principle 6). The
// jwh:route event fires AFTER transitionView, so a route-detail flag couldn't gate the animation; a
// pre-set module flag can. Mouse/tap/swipe navs leave it null and keep their animation.
let pendingNavSource = null;
export function markNavSource(src) { pendingNavSource = src; }

// per-route document title so browser tabs + history entries read like real pages
const TITLES = {
  dashboard: 'Dashboard', calendar: 'Calendar', people: 'People', checklist: 'Checklist',
  budget: 'Budget', explore: 'Explore', eats: 'Eats', rooms: 'Rooms', map: 'Map', plan: 'Plan a Day', emergency: 'Emergency',
  deadlines: 'Deadlines', packing: 'Packing', phrases: 'Phrases', grammar: 'Grammar', survival: 'Useful phrases', study: 'The Grammar Almanac',
};
const SITE = 'My Japan Trip';

// route → human label (for the command palette). TITLES stays module-local.
export function routeLabel(route) { return TITLES[route] || route; }

function activate(route, { scroll = true } = {}) {
  const target = document.getElementById('view-' + route);
  if (!target) return;
  document.title = TITLES[route] ? `${TITLES[route]} · ${SITE}` : SITE;
  const rh = document.getElementById('routeH1');
  if (rh) { rh.hidden = route === 'dashboard'; rh.textContent = TITLES[route] || SITE; }
  // Kill smooth scrolling for the DURATION of the swap. Leaving the calendar (window scrolled far down
  // in window-scroll mode), the browser animates the window toward the new page's clamped BOTTOM — with
  // the global html{scroll-behavior:smooth} that animation is a visible ~300ms "scroll down for a
  // second" flash before the reset lands. Forcing 'auto' makes every scroll during the transition
  // instant, so the reset inside the swap holds and nothing animates. Restored in .then below.
  const changing = route !== current;   // only reset scroll on a real route change (clicking the active tab shouldn't)
  const de = document.documentElement;
  if (changing) de.style.scrollBehavior = 'auto';   // only touch it for a real nav; ALWAYS restored to '' in .then (unconditional, so it can never latch 'auto' — a guarded restore could)
  const resetTop = () => {
    document.getElementById('main')?.scrollTo({ top: 0 });
    if (route !== 'calendar') window.scrollTo({ top: 0 });   // calendar owns its own scroll (positions to today)
  };
  const swap = () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('is-active'));
    target.classList.add('is-active');
    // reset IN the swap: same frame the new (short) layout applies, so the window never renders at the
    // clamped bottom — this is what removes the flash (the pre-swap reset ran while the tall calendar
    // was still laid out; the shrink then re-clamped it)
    if (scroll && changing) resetTop();
  };
  // consume the keyboard-nav flag: a keyboard route-swap renders instantly (no View Transition).
  const instant = pendingNavSource === 'keyboard';
  pendingNavSource = null;
  const swapped = instant ? (swap(), Promise.resolve()) : transitionView(swap);
  swapped.then(() => {
    if (scroll && changing && route === current) resetTop();   // belt-and-suspenders; skip if a faster later nav superseded this
    de.style.scrollBehavior = '';                  // restore CSS-default smooth for in-page scrolling
    // prefer a VISIBLE heading (compact hides some page titles; focusing a display:none node is a silent no-op)
    const h = [...target.querySelectorAll('h1, h2, h3')].find(x => x.offsetParent !== null) || target.querySelector('h1, h2, h3');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  });
  let activeNav = null;
  document.querySelectorAll('#routeNav a[data-route]').forEach(a => {
    if (a.dataset.route === route) { a.setAttribute('aria-current', 'page'); activeNav = a; }
    else a.removeAttribute('aria-current');
  });
  // Keep the active tab centered when the nav is a horizontally-scrollable bar (compact desktop) —
  // scroll the NAV container HORIZONTALLY only. NOT scrollIntoView: on mobile the nav is a drawer and
  // scrollIntoView scrolls the WINDOW down to it, which (leaving the calendar in window-scroll mode)
  // smooth-animates the page to the bottom and outlives the instant reset below. Skip when the bar
  // doesn't overflow (desktop wrap nav / mobile drawer) so the window is never touched.
  if (activeNav) {
    const bar = activeNav.parentElement;
    if (bar && bar.scrollWidth > bar.clientWidth + 4) {
      // measure the link RELATIVE TO THE BAR via rects (not offsetLeft — the bar is position:static so
      // its offsetParent is the sticky .topbar, and offsetLeft would include the brand/hamburger width)
      const target = activeNav.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft
        - (bar.clientWidth - activeNav.offsetWidth) / 2;
      bar.scrollTo({ left: target, behavior: 'instant' });
    }
  }
  current = route;
  document.body.dataset.route = route;   // lets CSS scope per-route (e.g. the calendar opts out of the app-shell internal scroll)
  document.dispatchEvent(new CustomEvent('jwh:route', { detail: { route } }));
}

function onHash() { activate(parseRoute(location.hash)); }

export function initRouter() {
  document.documentElement.classList.add('js-router');
  // own scroll position ourselves — the browser's default 'auto' restoration would re-apply the
  // calendar's large window offset onto a shorter page (back/forward), stranding it at the bottom
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  // intercept legacy section anchors (skip-link, brand, widget links, sources) → route
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    if (a.classList.contains('skip-link')) {       // 2.4.1: skip = focus main, NOT a navigation
      e.preventDefault();
      document.getElementById('main')?.focus();
      return;
    }
    const href = a.getAttribute('href');
    if (href.startsWith('#/')) return;             // real route link — let hashchange run
    const id = href.slice(1);
    if (LEGACY[id] !== undefined) { e.preventDefault(); location.hash = '#/' + LEGACY[id]; }
  });
  window.addEventListener('hashchange', onHash);
  onHash();
}
