'use strict';
// First-paint route selector. Every route's view lives in the one document; the hash router
// (router.js initRouter) only activates the right one at the END of boot — after gate, the
// tips.json fetch, and every feature mount (~200ms+). Until then CSS shows EVERY .view
// (style.css: `.view{display:block}` applies until `html.js-router` exists), so a refresh on
// e.g. #/map paints #view-dashboard (first view in the DOM) for those ~200ms before the router
// swaps to the real page. This classic script runs before that paint: it adds `js-router`
// (which hides all views) and marks the hash's view active immediately, so a reload lands on the
// correct page with no dashboard flash. initRouter later re-applies the SAME state, so there is
// no double-swap. Must be a file, not inline: the page CSP forbids inline scripts.
//
// Route detection mirrors the direct-hash case of router.js `parseRoute`; unknown or legacy
// (#/main …) hashes fall back to the dashboard, and boot's full parseRoute corrects them.
(function () {
  document.documentElement.classList.add('js-router');
  // Compact pages must not flash in either (owner report: full-size titles/nav paint for a
  // beat before boot's applyCompact runs): set <html data-compact> before first paint, and —
  // in the after-body run — seat the nav inside the topbar the way relocateNav will.
  // applyCompact() at boot re-applies the SAME state idempotently (and owns resize/fade wiring).
  var compact = '';
  // key literal duplicated on purpose (classic script, can't import) — keep in sync with KEYS.compact in lib/store.js
  try { compact = localStorage.getItem('jwh-compact-v1') === 'on' ? 'on' : ''; } catch (e) { /* storage blocked — boot's applyCompact settles it */ }
  document.documentElement.dataset.compact = compact;
  if (compact && document.body && window.matchMedia('(min-width: 821px)').matches) {
    var nav = document.getElementById('routeNav'), topbar = document.querySelector('.topbar');
    if (nav && topbar && nav.parentElement !== topbar) topbar.insertBefore(nav, topbar.querySelector('.countdown'));
  }
  // Trim hidden tabs + surface Phrases (2nd) BEFORE first paint, so the nav doesn't flash the full
  // static set and then re-filter when boot's applyNav runs. applyNav re-applies the SAME state
  // idempotently, so no double-swap. Default-hidden logic is duplicated here (classic script, can't
  // import) — KEEP IN SYNC with guide.js navHiddenSet() / NAV_HIDDEN_DEFAULT / the Phrases position.
  var routeNav = document.getElementById('routeNav');   // null in the head run (body not parsed yet) — settles in the after-body run
  if (routeNav) {
    var hidden = (function () {
      try { var v = JSON.parse(localStorage.getItem('jwh-navhidden-v1') || 'null'); if (v && v.length !== undefined) return v; } catch (e) { /* ignore */ }
      var shownArr = [];
      try { var s = JSON.parse(localStorage.getItem('jwh-navshow-v1') || 'null'); if (s && s.length !== undefined) shownArr = s; } catch (e) { /* ignore */ }
      var opt = ['packing', 'deadlines'], out = [];
      for (var i = 0; i < opt.length; i++) if (shownArr.indexOf(opt[i]) < 0) out.push(opt[i]);
      return out;   // tourist revamp: show map/explore/emergency by default; rooms/people routes removed. KEEP IN SYNC with guide.js NAV_HIDDEN_DEFAULT.
    })();
    for (var k = 0; k < hidden.length; k++) {
      var a = routeNav.querySelector('a[data-route="' + hidden[k] + '"]');
      if (a && a.parentNode) a.parentNode.removeChild(a);
    }
  }
  // Match router.js parseRoute exactly (it does NOT strip a query): only an exact `#/<route>`
  // whose view exists activates; anything else falls back to dashboard, same as parseRoute.
  var h = (location.hash || '').replace(/^#\/?/, '');
  var view = h && document.getElementById('view-' + h);
  if (!view) { h = 'dashboard'; view = document.getElementById('view-dashboard'); }
  if (!view) return;   // views not parsed yet (head run) — js-router is still applied above
  document.querySelectorAll('.view.is-active').forEach(function (v) { v.classList.remove('is-active'); });
  view.classList.add('is-active');
  if (document.body) document.body.dataset.route = h;
})();
