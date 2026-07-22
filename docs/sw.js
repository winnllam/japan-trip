'use strict';
// Offline service worker — network-first so data/code updates always land when online,
// with a cached fallback so the whole planner still works at Narita / the ward office.

const CACHE = 'jwh-v395';
const ASSETS = [
  './', 'index.html', 'data/tips.json', 'data/grammar-n5.json', 'data/grammar-n4.json', 'data/grammar-n3.json', 'data/grammar-n2.json', 'data/grammar-n1.json', 'data/grammar-units.json', 'data/grammar-passages.json', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png',
  'assets/style.css', 'assets/preboot.js', 'assets/main.js', 'assets/content.js', 'assets/checklist-page.js', 'assets/calendar.js', 'assets/calendar-agenda.js', 'assets/calendar-week.js', 'assets/calendar-month.js', 'assets/calendar-editor.js',
  'assets/dashboard.js', 'assets/collapse.js', 'assets/celebrate.js', 'assets/packing.js', 'assets/budget.js', 'assets/phrases.js', 'assets/tracker.js', 'assets/gate.js', 'assets/router.js', 'assets/motion.js', 'assets/anim.js', 'assets/countup.js', 'assets/speak.js', 'assets/pointtosay.js', 'assets/vocab.js', 'assets/kana.js', 'assets/numbers.js', 'assets/signs.js', 'assets/phraseday.js', 'assets/quiz.js', 'assets/pronunciation.js', 'assets/particles.js', 'assets/verbs.js', 'assets/adjectives.js', 'assets/dnd.js', 'assets/konami.js', 'assets/rooms.js', 'assets/map.js', 'assets/plan.js', 'assets/eats.js', 'assets/eventsearch.js', 'assets/expweek.js', 'assets/phrasesboot.js', 'assets/phrases-anki.js', 'assets/grammar.js', 'assets/study.js', 'assets/study-lessons.js', 'assets/study-scramble.js', 'assets/study-mcq.js', 'assets/study-duel.js', 'assets/study-gate.js', 'assets/study-build.js', 'assets/study-exam.js', 'assets/study-stats.js', 'assets/lang.js', 'assets/i18n.js', 'assets/backup.js', 'assets/gestures.js', 'assets/guide.js', 'assets/easter.js', 'assets/people.js', 'assets/lazyroutes.js', 'assets/palette.js', 'assets/emergency.js', 'assets/pocket.js', 'assets/print.js', 'assets/cardtranslate.js', 'assets/datepicker.js', 'assets/google-sync.js', 'assets/sync.js',
  'assets/lib/dom.js', 'assets/lib/furigana.js', 'assets/lib/jpdate.js', 'assets/lib/store.js', 'assets/lib/shortcuts.js', 'assets/lib/usage.js', 'assets/lib/people.js', 'assets/lib/rooms.js', 'assets/lib/dates.js', 'assets/lib/recur.js', 'assets/lib/sekki.js', 'assets/lib/packing.js', 'assets/lib/budget.js', 'assets/lib/spend.js', 'assets/lib/tripseed.js',
  'assets/lib/notify.js', 'assets/lib/ics.js', 'assets/lib/places.js', 'assets/lib/geo.js', 'assets/lib/transit.js', 'assets/lib/dayplan.js', 'assets/lib/trip.js', 'assets/lib/modal.js', 'assets/lib/directions.js', 'assets/lib/audio.js', 'assets/lib/placestats.js', 'assets/lib/menu.js', 'assets/lib/calevents.js', 'assets/lib/calendars.js', 'assets/lib/placesearch.js', 'assets/lib/palette.js', 'assets/lib/checklist.js', 'assets/lib/listctl.js', 'assets/lib/readiness.js', 'assets/lib/anki.js', 'assets/lib/grammar.js', 'assets/lib/zip.js', 'assets/lib/sqlite.js', 'assets/lib/ankimedia.js', 'assets/lib/ankiconnect.js', 'assets/lib/translate.js', 'assets/lib/userphrases.js', 'assets/lib/translatecache.js', 'assets/lib/priority.js', 'assets/lib/nlevent.js', 'assets/lib/smartviews.js', 'assets/lib/weekgrid.js', 'assets/lib/minical.js', 'assets/lib/tags.js', 'assets/lib/gcal.js', 'assets/lib/nominatim.js', 'assets/lib/weather.js', 'assets/lib/quakes.js', 'assets/lib/rates.js', 'assets/lib/wiki.js', 'assets/lib/study.js', 'assets/lib/questions.js', 'assets/lib/exam.js', 'assets/lib/peg.js', 'assets/lib/emergency-render.js', 'assets/lib/itinerary.js',
];

self.addEventListener('install', (e) => {
  // cache:'reload' here too — otherwise install fills the NEW cache version from the browser's
  // http-cache (GH Pages max-age), and a fresh deploy can precache a stale, mixed-version build
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // EF2: tips.json is 156KB gz and was re-downloaded on EVERY load (page fetches no-store;
  // this handler re-fetched with cache:'reload'). Stale-while-revalidate instead: serve the
  // SW-cached copy instantly, refresh the cache in the background. Trade-off (deliberate,
  // owner-approved in the efficiency plan): a data deploy shows on the NEXT load, not the
  // current one. Code/asset updates keep the network-first guarantee below.
  if (/\/data\/(tips|grammar-n[1-5]|grammar-units|grammar-passages)\.json$/.test(url.pathname)) {   // grammar-*.json + the units map + the passage bank share the SWR path — same big-JSON pathology
    e.respondWith(caches.match(e.request).then(cached => {
      const net = fetch(e.request, { cache: 'reload' }).then(resp => {
        if (resp && resp.ok && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      });
      if (cached) { e.waitUntil(net.catch(() => {})); return cached; }   // instant paint; refresh lands for next visit
      return net.catch(() => caches.match(e.request));                   // first load / cold cache: network (or precache, keyed off THIS request)
    }));
    return;
  }
  e.respondWith(
    // cache:'reload' bypasses the BROWSER http-cache so network-first truly hits the network —
    // otherwise a deploy can be shadowed by the browser's own cached copy (GH Pages sends
    // max-age on assets), and "updates always land when online" silently fails. The SW's own
    // CACHE (updated below) remains the offline fallback.
    fetch(e.request, { cache: 'reload' })
      .then(resp => {
        // only cache a clean 200 — never poison the offline cache with a 4xx/5xx/redirect/partial
        if (resp && resp.ok && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});   // .put rejects on 206 — swallow
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(c => {
        if (c) return c;
        // shell fallback ONLY for page navigations — an uncached asset/JSON request must fail
        // cleanly, not come back as HTML with a 200 (MIME/parse chaos downstream)
        return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error();
      }))
  );
});
