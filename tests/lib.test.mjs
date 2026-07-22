'use strict';
// Unit tests for the pure lib modules. Run: node --test (zero dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseISO, daysBetween, daysUntil, countdown, windowStatus, fmtShort } from '../docs/assets/lib/dates.js';
import { addDaysISO, legStatus, focusDays, itineraryDay, itineraryStops } from '../docs/assets/lib/itinerary.js';
import { computeAlerts, alertCount } from '../docs/assets/lib/notify.js';
import { toICS, parseICS, gcalUrl } from '../docs/assets/lib/ics.js';
import { parseEvent } from '../docs/assets/lib/nlevent.js';

const TODAY = '2026-06-15';
const ARRIVAL = '2026-06-30';

test('parseISO rejects junk, accepts ISO', () => {
  assert.equal(parseISO('nope'), null);
  assert.equal(parseISO(''), null);
  assert.ok(parseISO('2026-06-30'));
});

test('daysBetween / daysUntil are signed and tz-stable', () => {
  assert.equal(daysBetween('2026-06-15', '2026-06-30'), 15);
  assert.equal(daysBetween('2026-06-30', '2026-06-15'), -15);
  assert.equal(daysUntil(ARRIVAL, TODAY), 15);
});

test('countdown flips from before → arrived', () => {
  assert.deepEqual(countdown(ARRIVAL, TODAY), { days: 15, phase: 'before', label: '15 days to NRT' });
  assert.equal(countdown(ARRIVAL, '2026-06-29').label, '1 day to NRT');
  assert.equal(countdown(ARRIVAL, ARRIVAL).phase, 'arrived');
  assert.equal(countdown(ARRIVAL, '2026-07-04').label, 'Day 5 in Japan');
});

test('windowStatus buckets correctly (the as-of overdue logic)', () => {
  assert.equal(windowStatus('2026-06-10', TODAY), 'overdue');
  assert.equal(windowStatus('2026-06-16', TODAY), 'due-soon');
  assert.equal(windowStatus('2026-06-18', TODAY), 'due-soon');
  assert.equal(windowStatus('2026-06-25', TODAY), 'upcoming');
  assert.equal(windowStatus('2026-09-01', TODAY), 'later');
  assert.equal(windowStatus('', TODAY), 'none');
});

test('computeAlerts sorts by severity then days, drops later + dismissed', () => {
  const items = [
    { id: 'a', title: 'overdue thing', when: '2026-06-10' },
    { id: 'b', title: 'soon', when: '2026-06-17' },
    { id: 'c', title: 'upcoming', when: '2026-06-28' },
    { id: 'd', title: 'far', when: '2026-12-01' },
    { id: 'e', title: 'no date' },
  ];
  const a = computeAlerts(items, TODAY);
  assert.deepEqual(a.map(x => x.id), ['a', 'b', 'c']);
  assert.equal(a[0].severity, 'overdue');
  assert.equal(alertCount(items, TODAY, ['a']), 2);
});

test('toICS → parseICS round-trips an all-day event', () => {
  const ev = [{ id: 'x1', title: 'Sumida Hanabi', date: '2026-07-25', area: 'Asakusa', category: 'fireworks', bookingNotes: 'Arrive early; comma, and; semicolon test' }];
  const ics = toICS(ev);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260725/);
  const back = parseICS(ics);
  assert.equal(back.length, 1);
  assert.equal(back[0].title, 'Sumida Hanabi');
  assert.equal(back[0].date, '2026-07-25');
  assert.equal(back[0].area, 'Asakusa');
  assert.match(back[0].note, /semicolon test/);
});

test('multi-day event end date is exclusive next-day', () => {
  const ics = toICS([{ id: 'c1', title: 'Comiket', date: '2026-08-15', endDate: '2026-08-16' }]);
  assert.match(ics, /DTEND;VALUE=DATE:20260817/);
});

test('parseICS rejects an impossible DTEND instead of rolling it over', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Bad end\r\nDTSTART;VALUE=DATE:20260110\r\nDTEND;VALUE=DATE:20260145\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const back = parseICS(ics);
  assert.equal(back.length, 1);
  assert.equal(back[0].date, '2026-01-10');
  assert.equal(back[0].endDate, '');   // impossible end dropped → single-day
});

test('gcalUrl builds a template link', () => {
  const u = gcalUrl({ title: 'teamLab', date: '2026-07-10', area: 'Toyosu' });
  assert.match(u, /calendar\.google\.com/);
  assert.match(u, /dates=20260710%2F20260711/);
  assert.match(u, /text=teamLab/);
});

import { reorderIds } from '../docs/assets/dnd.js';
test('reorderIds moves an id before/after a target', () => {
  assert.deepEqual(reorderIds(['a','b','c'], 'a', 'c', true), ['b','c','a']);
  assert.deepEqual(reorderIds(['a','b','c'], 'c', 'a', false), ['c','a','b']);
  assert.deepEqual(reorderIds(['a','b','c'], 'b', null), ['a','c','b']);
  assert.deepEqual(reorderIds(['a','b','c'], 'a', 'a'), ['a','b','c']);
});

import { normalize, slug, catId, upsertInto, deleteFrom } from '../docs/assets/lib/places.js';

test('normalize back-fills new fields, infers coordKind, preserves data', () => {
  const legacy = { id: 'p1', name: 'Old Pin', lat: 35.6, lng: 139.7, eventId: 'e9' };
  const n = normalize(legacy);
  assert.equal(n.source, 'drop');
  assert.equal(n.fav, false);
  assert.equal(n.locked, false);
  assert.equal(n.coordKind, 'exact');           // had numeric coords
  assert.equal(n.eventId, 'e9');                 // existing data wins over defaults
  assert.equal(normalize({ id: 'x', name: 'NoCoords' }).coordKind, 'approx');
});

test('normalize: rating defaults to 0 (additive) and preserves a set eat rating', () => {
  assert.equal(normalize({ id: 'p2', name: 'Legacy' }).rating, 0);         // back-filled on old records
  const eat = normalize({ id: 'eat1', name: 'Kuroki', source: 'eat', rating: 4, note: 'great shio', visited: true });
  assert.equal(eat.rating, 4);
  assert.equal(eat.source, 'eat');
  assert.equal(eat.visited, true);
});

test('slug + catId are deterministic and url-safe', () => {
  assert.equal(slug('Big Love Records (Harajuku)!'), 'big-love-records-harajuku');
  assert.equal(catId('restaurants', 'Ichiran'), 'cat:restaurants:ichiran');
  assert.equal(catId('restaurants', 'Ichiran'), catId('restaurants', 'Ichiran'));  // stable
});

test('upsertInto is idempotent on repeat star (no duplicate)', () => {
  const rec = { id: 'cat:restaurants:ichiran', name: 'Ichiran', source: 'tabetai', fav: true };
  let arr = upsertInto([], rec);
  assert.equal(arr.length, 1);
  arr = upsertInto(arr, { ...rec, visited: true });   // second press updates, not appends
  assert.equal(arr.length, 1);
  assert.equal(arr[0].visited, true);
  assert.equal(arr[0].fav, true);
});

test('upsertInto does not mutate the input array (immutability)', () => {
  const a = [];
  const b = upsertInto(a, { id: 'z', name: 'Z' });
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
});

test('deleteFrom honours the lock and reports the removed record', () => {
  const arr = [{ id: 'a', name: 'A', locked: false, eventId: 'e1' }, { id: 'b', name: 'B', locked: true }];
  const ok = deleteFrom(arr, 'a');
  assert.equal(ok.arr.length, 1);
  assert.equal(ok.removed.eventId, 'e1');        // caller uses this to remove the linked event
  const blocked = deleteFrom(arr, 'b');
  assert.equal(blocked.arr.length, 2);           // locked → unchanged
  assert.equal(blocked.removed, null);
});

import { haversineKm, estimateMinutes, format, totalTransit, areaCount } from '../docs/assets/lib/transit.js';
import { newStop, upsertStopIn, removeStopIn, patchStopIn, reorderStopsIn, planToEvents } from '../docs/assets/lib/dayplan.js';

const GEO = { Shinjuku: { lat: 35.69376, lng: 139.70363 }, Shibuya: { lat: 35.66337, lng: 139.6965 },
  Nakano: { lat: 35.70862, lng: 139.66294 }, 'Around Tokyo': { lat: 35.68, lng: 139.74 } };

test('haversineKm: Shinjuku→Shibuya ≈ 3.4km', () => {
  const d = haversineKm(GEO.Shinjuku, GEO.Shibuya);
  assert.ok(d > 3 && d < 4, `got ${d}`);
});
test('estimateMinutes: same area → 10, override pair honoured, scales with distance', () => {
  assert.equal(estimateMinutes('Shibuya', 'Shibuya', GEO), 10);
  assert.equal(estimateMinutes('Nakano', 'Shinjuku', GEO), 16);          // express-corridor override
  assert.ok(estimateMinutes('Shinjuku', 'Shibuya', GEO) > 10);
});
test('format floors at ≈10 and rounds to 5-min buckets', () => {
  assert.equal(format(7), '≈10 min');
  assert.equal(format(23), '≈25 min');
  assert.equal(format(10), '≈10 min');
});
test('totalTransit + areaCount over a stop list', () => {
  const stops = [{ area: 'Shibuya' }, { area: 'Shibuya' }, { area: 'Shinjuku' }];
  assert.equal(areaCount(stops), 2);
  assert.ok(totalTransit(stops, GEO) >= 10);
});

test('dayplan upsertStopIn adds then updates by id (immutable)', () => {
  const s = newStop({ id: 'a', name: 'Disk Union', area: 'Shimokitazawa' });
  let plans = upsertStopIn({}, '2026-07-04', s);
  assert.equal(plans['2026-07-04'].stops.length, 1);
  plans = upsertStopIn(plans, '2026-07-04', { id: 'a', startTime: '13:00' });
  assert.equal(plans['2026-07-04'].stops.length, 1);                     // updated, not appended
  assert.equal(plans['2026-07-04'].stops[0].startTime, '13:00');
  assert.equal(plans['2026-07-04'].stops[0].name, 'Disk Union');         // snapshot preserved
});
test('dayplan reorderStopsIn reorders and keeps unlisted stops', () => {
  let plans = { d: { date: 'd', stops: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } };
  plans = reorderStopsIn(plans, 'd', ['c', 'a', 'b']);
  assert.deepEqual(plans.d.stops.map(s => s.id), ['c', 'a', 'b']);
});
test('dayplan removeStopIn isolates other dates; planToEvents → one all-day event', () => {
  const plans = { d1: { date: 'd1', stops: [{ id: 'x', name: 'X', area: 'Shibuya', startTime: '10:00' }] },
                  d2: { date: 'd2', stops: [{ id: 'y', name: 'Y' }] } };
  const after = removeStopIn(plans, 'd1', 'x');
  assert.equal(after.d1.stops.length, 0);
  assert.equal(after.d2.stops.length, 1);                                // untouched
  const evs = planToEvents({ date: 'd1', title: '', stops: plans.d1.stops });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].id, 'plan:d1');
  assert.ok(evs[0].note.includes('10:00 X'));
  assert.equal(planToEvents({ date: 'd', stops: [] }).length, 0);        // empty → no event
});

import { readFileSync } from 'node:fs';
import { setPlanMetaIn } from '../docs/assets/lib/dayplan.js';

test('lang parity: every .jp accent in index.html has a glossary entry', () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const i18n = readFileSync(new URL('../docs/assets/i18n.js', import.meta.url), 'utf8');   // GLOSSARY moved here from lang.js
  const accents = [...html.matchAll(/class="jp"[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const missing = [...new Set(accents)].filter(a => !i18n.includes(`'${a}'`));
  assert.deepEqual(missing, [], `JP accents missing from the hover-dictionary glossary: ${missing.join(', ')}`);
});

test('routes parity: every ROUTES entry has a #view-<route> section and a nav link', () => {
  const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../docs/assets/router.js', import.meta.url), 'utf8');
  const routes = router.match(/export const ROUTES = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  const missingView = routes.filter(r => !html.includes(`id="view-${r}"`));
  const missingNav = routes.filter(r => !html.includes(`data-route="${r}"`));
  assert.deepEqual(missingView, [], `routes with no view section: ${missingView}`);
  assert.deepEqual(missingNav, [], `routes with no nav link: ${missingNav}`);
});

test('dayplan patchStopIn updates one field immutably; setPlanMetaIn sets title', () => {
  const plans = { d: { date: 'd', title: '', stops: [{ id: 'a', durationMin: 60 }, { id: 'b', durationMin: 60 }] } };
  const p2 = patchStopIn(plans, 'd', 'a', { durationMin: 90 });
  assert.equal(p2.d.stops[0].durationMin, 90);
  assert.equal(p2.d.stops[1].durationMin, 60);
  assert.equal(plans.d.stops[0].durationMin, 60);            // input unchanged (immutable)
  const p3 = setPlanMetaIn(plans, 'd', { title: 'Akihabara day' });
  assert.equal(p3.d.title, 'Akihabara day');
});

import { directionsUrl, waypointsUrl, groupByArea } from '../docs/assets/lib/directions.js';

test('directionsUrl: Google form omits origin when not a real coord, includes it when present', () => {
  const noOrig = directionsUrl({ to: { lat: 35.66, lng: 139.69 } });
  assert.match(noOrig, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(noOrig, /api=1/);
  assert.ok(!/origin=/.test(noOrig));                       // null/omitted device location → no origin
  assert.match(noOrig, /destination=35\.66%2C139\.69/);

  const withOrig = directionsUrl({ from: { lat: 35.69, lng: 139.70 }, to: { lat: 35.66, lng: 139.69 } });
  assert.match(withOrig, /origin=35\.69%2C139\.7/);
});

test('directionsUrl: transit is default travelmode; honours an override', () => {
  assert.match(directionsUrl({ to: { lat: 1, lng: 2 } }), /travelmode=transit/);
  assert.match(directionsUrl({ to: { lat: 1, lng: 2 }, mode: 'walking' }), /travelmode=walking/);
});

test('directionsUrl: a name destination is handed off as encoded text (not coords)', () => {
  const u = directionsUrl({ to: 'Disk Union, Shinjuku' });
  assert.match(u, /destination=Disk%20Union%2C%20Shinjuku/);
});

test('directionsUrl: ios → Apple Maps form with dirflg=r, saddr only when origin present', () => {
  const cur = directionsUrl({ to: { lat: 35.66, lng: 139.69 }, platform: 'ios' });
  assert.match(cur, /^https:\/\/maps\.apple\.com\/\?/);
  assert.match(cur, /daddr=35\.66%2C139\.69/);
  assert.match(cur, /dirflg=r/);
  assert.ok(!/saddr=/.test(cur));                           // no origin → current location
  const both = directionsUrl({ from: { lat: 35.69, lng: 139.70 }, to: { lat: 35.66, lng: 139.69 }, platform: 'ios' });
  assert.match(both, /saddr=35\.69%2C139\.7/);
});

test('waypointsUrl: drops coordless stops and reports them', () => {
  const stops = [{ lat: 35.69, lng: 139.70 }, { lat: 35.66, lng: 139.69 }, { name: 'no coords' }, null];
  const r = waypointsUrl(stops);
  assert.equal(r.used, 2);
  assert.equal(r.dropped, 2);                               // the coordless object + the null
  assert.match(r.url, /\/maps\/dir\/35\.69%2C139\.7\/35\.66%2C139\.69\?/);
  assert.match(r.url, /travelmode=transit/);
});

test('waypointsUrl: caps at 9 points and counts the overflow as dropped', () => {
  const stops = Array.from({ length: 12 }, (_, i) => ({ lat: 35 + i * 0.01, lng: 139 + i * 0.01 }));
  const r = waypointsUrl(stops);
  assert.equal(r.used, 9);
  assert.equal(r.dropped, 3);
  const path = r.url.match(/\/maps\/dir\/([^?]+)\?/)[1];
  assert.equal(path.split('/').length, 9);                 // exactly 9 LAT,LNG points in the path
});

test('waypointsUrl: fewer than 2 usable stops → empty url', () => {
  assert.equal(waypointsUrl([{ lat: 1, lng: 2 }]).url, '');
  assert.equal(waypointsUrl([]).url, '');
});

test('groupByArea: groups same-area stops, preserves first-seen + within-area order, no-area trails', () => {
  const stops = [
    { id: 'a', area: 'Shibuya' },
    { id: 'b', area: 'Shinjuku' },
    { id: 'c', area: 'Shibuya' },
    { id: 'd', area: null },
    { id: 'e', area: 'Shinjuku' },
  ];
  const out = groupByArea(stops, (s) => s.area);
  assert.deepEqual(out, ['a', 'c', 'b', 'e', 'd']);         // Shibuya bucket, Shinjuku bucket, then no-area
});

import { placesVisitedStats } from '../docs/assets/lib/placestats.js';

test('placesVisitedStats: counts total/visited and distinct areas (all vs visited)', () => {
  const areaOf = (s) => s.split(':')[0];                    // stub: bucket = text before the colon
  const places = [
    { address: 'Shibuya:1', visited: true },
    { address: 'Shibuya:2', visited: false },
    { area: 'Shinjuku:1', visited: true },
    { address: 'Nakano:1' },                                // unvisited
  ];
  const s = placesVisitedStats(places, areaOf);
  assert.equal(s.total, 4);
  assert.equal(s.visited, 2);
  assert.equal(s.areasTotal, 3);                            // Shibuya, Shinjuku, Nakano
  assert.equal(s.areasVisited, 2);                          // Shibuya, Shinjuku
  assert.deepEqual(placesVisitedStats(null, areaOf), { total: 0, visited: 0, areasTotal: 0, areasVisited: 0 });
});

import { seasonalEgg } from '../docs/assets/easter.js';

// seasonalEgg reads the JST wall clock via UTC getters, so build dates with Date.UTC.
const jst = (y, mo, d, h = 12) => new Date(Date.UTC(y, mo, d, h));

test('seasonalEgg: landing day, sakura, new year, night-owl, else null', () => {
  assert.equal(seasonalEgg(jst(2026, 5, 30)), 'landing');     // 2026-06-30 arrival
  assert.equal(seasonalEgg(jst(2027, 2, 25)), 'sakura');      // late March
  assert.equal(seasonalEgg(jst(2027, 0, 1)), 'newyear');      // Jan 1
  assert.equal(seasonalEgg(jst(2027, 5, 1, 2)), 'nightowl');  // 02:00 JST any day
  assert.equal(seasonalEgg(jst(2027, 5, 1, 12)), null);       // ordinary noon
  assert.equal(seasonalEgg('not a date'), null);
});

test('route-title parity: every route has a TITLES entry (drives the sr-only h1)', () => {
  const router = readFileSync(new URL('../docs/assets/router.js', import.meta.url), 'utf8');
  const routes = router.match(/export const ROUTES = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  const titlesBlock = router.match(/const TITLES = \{([\s\S]*?)\}/)[1];
  const missing = routes.filter(r => !new RegExp(`\\b${r}:`).test(titlesBlock));
  assert.deepEqual(missing, [], `routes missing a TITLES entry: ${missing}`);
});

import {
  yenAmounts, parseYen, parseRent, depositYen, moveInEstimate, monthlyAllIn,
  lineTokens, bookFromAbroad, noGuarantor, womenOnly, searchBlob, enrich, LINE_LABELS,
} from '../docs/assets/lib/rooms.js';

test('parseRent: ranges, compound dorm/private, /night ×30, ¥k shorthand, junk→null', () => {
  assert.deepEqual(parseRent('¥45,000–95,000 / mo'), { monthlyMin: 45000, monthlyMax: 95000, unit: 'mo' });
  assert.deepEqual(parseRent('Dorm ¥40,000–60,000 · private ¥60,000–95,000 / mo'),
    { monthlyMin: 40000, monthlyMax: 95000, unit: 'mo' });
  assert.deepEqual(parseRent('¥3,000–6,000 / night'), { monthlyMin: 90000, monthlyMax: 180000, unit: 'night' });
  assert.deepEqual(parseRent('Share ¥50k+ · 1K apt ¥70,000–120,000 / mo'),
    { monthlyMin: 50000, monthlyMax: 120000, unit: 'mo' });
  assert.deepEqual(parseRent('From ¥40,000 / mo'), { monthlyMin: 40000, monthlyMax: 40000, unit: 'mo' });
  assert.deepEqual(parseRent('Per house'), { monthlyMin: null, monthlyMax: null, unit: 'mo' });
});

test('parseYen / yenAmounts: first amount, ¥0, none→null, k-shorthand', () => {
  assert.equal(parseYen('~¥30,000 contract'), 30000);
  assert.equal(parseYen('¥0'), 0);
  assert.equal(parseYen('Included'), null);
  assert.deepEqual(yenAmounts('¥10,000–22,000 utilities/mo'), [10000, 22000]);
  assert.deepEqual(yenAmounts('avg ~¥54k'), [54000]);
});

test('moveInEstimate: first month + oneTime + deposit; months×rent; unknown→null', () => {
  assert.deepEqual(
    moveInEstimate({ rent: '¥45,000–95,000 / mo', oneTime: '~¥30,000 contract', deposit: 'Low' }),
    { total: 75000, isEstimate: true });
  assert.deepEqual(
    moveInEstimate({ rent: '¥60,000–80,000 / mo', oneTime: '~¥30,000', deposit: '~1 month' }),
    { total: 150000, isEstimate: true });
  assert.deepEqual(
    moveInEstimate({ rent: '¥50,000–90,000 / mo', oneTime: 'No key money', deposit: '¥20,000 (¥10,000 non-refundable)' }),
    { total: 70000, isEstimate: true });
  assert.deepEqual(moveInEstimate({ rent: 'Per house', oneTime: 'Low', deposit: 'Low' }),
    { total: null, isEstimate: true });
});

test('depositYen: ¥ amount wins; ¥0 is zero (not falsy-skipped); months×rent; junk→0', () => {
  assert.equal(depositYen({ deposit: '¥20,000 (¥10,000 non-refundable)' }, 60000), 20000);
  assert.equal(depositYen({ deposit: '¥0' }, 60000), 0);
  assert.equal(depositYen({ deposit: '~2–3 months' }, 60000), 120000);   // low end ×rent
  assert.equal(depositYen({ deposit: 'Low' }, 60000), 0);
  assert.equal(depositYen({ deposit: '~1 month' }, null), 0);            // unknown rent → 0
});

test('monthlyAllIn: rent floor + first fee amount; fees included → rent alone; junk→null', () => {
  assert.equal(monthlyAllIn({ rent: '¥45,000–95,000 / mo', fees: '¥10,000–22,000 utilities/mo' }), 55000);
  assert.equal(monthlyAllIn({ rent: '¥55,000–80,000 / mo', fees: 'Utilities included' }), 55000);
  assert.equal(monthlyAllIn({ rent: 'Per house', fees: '~¥15,000' }), null);
});

test('lineTokens: dictionary match over station + area', () => {
  assert.deepEqual(lineTokens({ station: 'Various', area: 'Nakano, Koenji, Oji, Kuramae' }).sort(),
    ['Asakusa/Kuramae', 'Koenji', 'Nakano'].sort());
  assert.ok(lineTokens({ station: 'Koenji (JR Chuo/Sobu)', area: 'Koenji / Suginami (Chuo line)' }).includes('Chuo line'));
  assert.deepEqual(lineTokens({ station: 'Filter', area: 'All Tokyo' }), []);
  assert.ok(Array.isArray(LINE_LABELS) && LINE_LABELS.length > 0);
});

test('flag derivations: bookFromAbroad / noGuarantor / womenOnly', () => {
  assert.equal(bookFromAbroad({ moveIn: 'Rolling — book from abroad', requirements: [] }), true);
  assert.equal(bookFromAbroad({ moveIn: 'Viewings encouraged', requirements: ['Visa'] }), false);
  assert.equal(noGuarantor({ requirements: ['No guarantor needed'] }), true);
  assert.equal(noGuarantor({ requirements: ['Guarantor company (they arrange)'] }), false);
  assert.equal(womenOnly({ gender: 'women-only' }), true);
  assert.equal(womenOnly({ gender: 'mixed (some women-only rooms)' }), false);
});

test('enrich: adds derived fields, leaves the source object untouched (immutable)', () => {
  const src = [{ id: 'x', name: 'X House', provider: 'P', area: 'Nakano', station: 'Various',
    rent: '¥45,000–95,000 / mo', fees: '~¥10,000', oneTime: '~¥30,000', deposit: 'Low',
    roomType: 'private', gender: 'mixed', noKeyMoney: true, moveIn: 'Rolling — apply online from abroad',
    requirements: ['No guarantor'], note: 'nice' }];
  const out = enrich(src);
  assert.equal(out[0]._allIn, 55000);
  assert.equal(out[0]._moveIn.total, 75000);
  assert.deepEqual(out[0]._price, { monthlyMin: 45000, monthlyMax: 95000, unit: 'mo' });
  assert.ok(out[0]._lines.includes('Nakano'));
  assert.equal(out[0]._bookAbroad, true);
  assert.equal(out[0]._noGuarantor, true);
  assert.equal(out[0]._women, false);
  assert.equal(out[0]._blob.includes('nakano'), true);
  assert.equal(out[0]._blob.includes('private'), true);   // roomType searchable
  assert.equal(out[0]._blob.includes('mixed'), true);     // gender searchable
  assert.equal(src[0]._allIn, undefined);
});

// Regressions found by running enrich() over the real 44-record dataset (adversarial review).
test('parseYen: "k" only multiplies a true ¥54k shorthand, never the "k" in a following word', () => {
  assert.equal(parseYen('~¥30,000 key money + cleaning (varies by house)'), 30000);   // was 30,000,000
  assert.equal(parseYen('avg ~¥54k'), 54000);
  assert.equal(parseYen('¥50k+ rooms'), 50000);
  assert.deepEqual(yenAmounts('¥40k–95k'), [40000, 95000]);
});

test('parseRent: discount/avg/maintenance figures after the "/mo" marker do not become the floor', () => {
  assert.deepEqual(parseRent('Share house from ~¥75,000 / mo (opening discount up to ¥7,000/mo off for first 3 months)'),
    { monthlyMin: 75000, monthlyMax: 75000, unit: 'mo' });
  assert.deepEqual(parseRent('¥77,000–79,000 / mo (avg ~¥54k across Social Apt portfolio; this building higher-end)'),
    { monthlyMin: 77000, monthlyMax: 79000, unit: 'mo' });
  assert.deepEqual(parseRent('~¥19,000–67,000+ / mo (studios cluster ¥24,800–41,000) + maintenance ~¥15,000/mo'),
    { monthlyMin: 19000, monthlyMax: 67000, unit: 'mo' });
});

test('noGuarantor: catches "No Japanese guarantor"/"no-guarantor", rejects company-required phrasings', () => {
  assert.equal(noGuarantor({ requirements: ['Passport', 'No Japanese guarantor required'] }), true);
  assert.equal(noGuarantor({ requirements: ['No-guarantor listings filterable directly'] }), true);
  assert.equal(noGuarantor({ requirements: ['Guarantor company (they arrange)'] }), false);
  assert.equal(noGuarantor({ requirements: ['No personal Japanese guarantor — a guarantor company (hosho) is used'] }), false);
});

test('bookFromAbroad: explicit "after arrival only / not bookable from abroad" overrides an "apply online"', () => {
  assert.equal(bookFromAbroad({ moveIn: 'After arrival only — not bookable from abroad', requirements: ['Apply online at a UR center'] }), false);
  assert.equal(bookFromAbroad({ moveIn: 'Rolling — apply online from abroad', requirements: [] }), true);
});

import { monthGrid, addMonths, isoToYM, MONTHS, WEEKDAYS_SHORT } from '../docs/assets/lib/minical.js';

test('monthGrid: full 6x7 rectangle, right in-month count + weekday alignment', () => {
  const g = monthGrid(2026, 6);                 // July 2026 (month is 0-indexed)
  assert.equal(g.length, 6);
  assert.ok(g.every(w => w.length === 7));
  const flat = g.flat();
  assert.equal(flat.length, 42);
  assert.equal(flat.filter(c => c.inMonth).length, 31);   // July has 31 days
  // July 1 2026 is a Wednesday → row 0, column 3
  assert.equal(g[0][3].iso, '2026-07-01');
  assert.equal(g[0][3].inMonth, true);
  assert.equal(g[0][0].iso, '2026-06-28');                // leading Sunday from June
  assert.equal(g[0][0].inMonth, false);
});

test('addMonths wraps year boundaries', () => {
  assert.deepEqual(addMonths(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(addMonths(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(addMonths(2026, 5, 0), { year: 2026, month: 5 });
});

test('isoToYM parses and rejects', () => {
  assert.deepEqual(isoToYM('2026-07-01'), { year: 2026, month: 6, day: 1 });
  assert.equal(isoToYM('nope'), null);
  assert.equal(MONTHS[6], 'July');
  assert.equal(WEEKDAYS_SHORT[0], 'Su');
});

import { normalizeTag, setTags, tagsFor, allTags, tagHue } from '../docs/assets/lib/tags.js';

import { parseNominatim } from '../docs/assets/lib/nominatim.js';

test('parseNominatim maps display_name/lat/lon and drops empties', () => {
  const out = parseNominatim([
    { display_name: 'Shinjuku Station, Shinjuku, Tokyo, Japan', lat: '35.69', lon: '139.70' },
    { display_name: '', lat: '0', lon: '0' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { name: 'Shinjuku Station', addr: 'Shinjuku Station, Shinjuku, Tokyo, Japan', lat: '35.69', lng: '139.70' });
  assert.deepEqual(parseNominatim(null), []);
});

test('normalizeTag: trims, strips #, strips commas, collapses ws, lowercases, caps length', () => {
  assert.equal(normalizeTag('  #Visa '), 'visa');
  assert.equal(normalizeTag('Ward  Office'), 'ward office');
  assert.equal(normalizeTag('##HOUSING'), 'housing');
  assert.equal(normalizeTag('visa,housing'), 'visa housing');   // commas → space (no commas in stored tags)
  assert.equal(normalizeTag('   '), '');
  assert.equal(normalizeTag(null), '');
  assert.equal(normalizeTag('a'.repeat(40)).length, 24);
});

test('setTags: normalizes+dedupes a whole list, deletes when empty', () => {
  assert.deepEqual(setTags({}, 'a', ['#Visa', 'visa', 'Money']), { a: ['visa', 'money'] });
  assert.deepEqual(setTags({ a: ['x'] }, 'a', []), {});
  assert.deepEqual(setTags({ a: ['x'] }, 'a', ['  ']), {});       // all-empty → deleted
});

test('tagsFor / allTags', () => {
  const m = { a: ['money', 'visa'], b: ['visa', 'health'] };
  assert.deepEqual(tagsFor(m, 'a'), ['money', 'visa']);
  assert.deepEqual(tagsFor(m, 'missing'), []);
  assert.deepEqual(allTags(m), ['health', 'money', 'visa']);     // distinct + sorted
  assert.deepEqual(allTags({}), []);
});

test('tagHue: deterministic, in range, stable across calls', () => {
  const h = tagHue('visa');
  assert.equal(h, tagHue('visa'));
  assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
});

test('tips.json checklist ids are present and unique', () => {
  const data = JSON.parse(readFileSync(new URL('../docs/data/tips.json', import.meta.url)));
  const ids = data.checklist.flatMap(p => (p.items || []).map(i => i.id));
  assert.ok(ids.length > 0, 'checklist has items');
  ids.forEach(id => assert.ok(typeof id === 'string' && id.length, `checklist item missing id: ${id}`));
  assert.equal(ids.length, new Set(ids).size, 'checklist ids are unique');
  // any requires[] prereq must reference a real checklist id (dependency-lock integrity)
  const idSet = new Set(ids);
  data.checklist.flatMap(p => p.items || []).forEach(it =>
    (it.requires || []).forEach(r => assert.ok(idSet.has(r), `requires points at missing id: ${r}`)));
});

import { eventToGcal, nextDayISO, getMapped, setMapped, forgetCalendar } from '../docs/assets/lib/gcal.js';

test('eventToGcal maps an all-day single + multi-day event with exclusive end', () => {
  assert.deepEqual(eventToGcal({ title: 'Sumida Hanabi', date: '2026-07-25', area: 'Asakusa', note: 'arrive early' }),
    { summary: 'Sumida Hanabi', location: 'Asakusa', description: 'arrive early', start: { date: '2026-07-25' }, end: { date: '2026-07-26' } });
  // multi-day: end is exclusive (Jul 7 stay → end.date Jul 8)
  assert.equal(eventToGcal({ title: 'x', date: '2026-06-30', endDate: '2026-07-07' }).end.date, '2026-07-08');
  assert.equal(nextDayISO('2026-12-31'), '2027-01-01');   // year roll
});

// --- google-sync idempotency logic (tested with a fake api, no network) ---

/**
 * Thin replica of the INSERT-then-PATCH idempotency logic from google-sync.js, driven by
 * an injectable `api` function so we can test it in Node without DOM/fetch/GIS.
 *
 * Logic under test:
 *   • First sync of an event: POST → setMapped → write map
 *   • Second sync of same event: PATCH (uses the stored google id) → no duplicate
 *   • Locally deleted event (in map but not in localIds): DELETE → unmap
 */
async function runSyncWithFakeApi(events, initialMap, fakeApi) {
  let map = { calendarId: 'cal-1', events: {}, ...initialMap };
  const calId = map.calendarId;
  const localIds = new Set(events.map(ev => ev.id));
  const log = [];
  let inserted = 0, updated = 0, deleted = 0;

  for (const ev of events) {
    const body = eventToGcal(ev);
    const googleId = getMapped(map, ev.id);
    if (googleId) {
      await fakeApi('PATCH', `/calendars/${calId}/events/${googleId}`, body);
      log.push({ op: 'PATCH', localId: ev.id, googleId });
      updated++;
    } else {
      const created = await fakeApi('POST', `/calendars/${calId}/events`, body);
      map = setMapped(map, ev.id, created.id);
      log.push({ op: 'POST', localId: ev.id, googleId: created.id });
      inserted++;
    }
  }

  // Deletions for locally-removed events.
  for (const [localId, googleId] of Object.entries(map.events || {})) {
    if (!localIds.has(localId)) {
      await fakeApi('DELETE', `/calendars/${calId}/events/${googleId}`);
      const { [localId]: _, ...rest } = map.events;
      map = { ...map, events: rest };
      log.push({ op: 'DELETE', localId, googleId });
      deleted++;
    }
  }

  return { map, log, inserted, updated, deleted };
}

test('gcal sync: INSERT-then-PATCH idempotency — second sync PATCHes, no duplicate POST', async () => {
  let nextId = 1;
  const calls = [];
  const fakeApi = async (method, path, body) => {
    calls.push({ method, path });
    if (method === 'POST') return { id: `g${nextId++}` };
    return null;
  };

  const events = [{ id: 'local-1', title: 'Hanabi', date: '2026-07-25' }];

  // First sync: no map → POST
  const r1 = await runSyncWithFakeApi(events, { events: {} }, fakeApi);
  assert.equal(r1.inserted, 1);
  assert.equal(r1.updated, 0);
  assert.equal(getMapped(r1.map, 'local-1'), 'g1');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);

  // Second sync: same event, map already has the google id → PATCH only
  const calls2 = [];
  const fakeApi2 = async (method, path) => { calls2.push({ method, path }); return null; };
  const r2 = await runSyncWithFakeApi(events, r1.map, fakeApi2);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 1);
  assert.equal(calls2.filter(c => c.method === 'POST').length, 0, 'no second POST — would be a duplicate');
  assert.equal(calls2.filter(c => c.method === 'PATCH').length, 1);
});

test('gcal sync: locally-deleted event is DELETEd from Google and unmapped', async () => {
  const calls = [];
  const fakeApi = async (method, path) => { calls.push({ method, path }); return null; };

  // Map has an event that is no longer in the local events list.
  const initialMap = { events: { 'old-1': 'g-old-1' } };
  const r = await runSyncWithFakeApi([], initialMap, fakeApi);
  assert.equal(r.deleted, 1);
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(getMapped(r.map, 'old-1'), undefined, 'unmapped after deletion');
});

test('gcal sync: forgetCalendar wipes calendarId and event map', () => {
  const m = { calendarId: 'cal-x', events: { 'a': 'g-a' } };
  const cleared = forgetCalendar(m);
  assert.equal(cleared.calendarId, '');
  assert.deepEqual(cleared.events, {});
  // immutable — original unchanged
  assert.equal(m.calendarId, 'cal-x');
});

test('gcal sync: setMapped is immutable — original map not mutated', () => {
  const m = { calendarId: 'cal-1', events: { 'x': 'g-x' } };
  const m2 = setMapped(m, 'y', 'g-y');
  assert.equal(getMapped(m, 'y'), undefined);   // original untouched
  assert.equal(getMapped(m2, 'y'), 'g-y');
  assert.equal(getMapped(m2, 'x'), 'g-x');      // existing entry preserved
});

// ---- natural-language quick-add (parseEvent) ----
const NL = '2026-06-30';   // a Tuesday
test('parseEvent: month-name date + pm time, clean title', () => {
  const r = parseEvent('Ramen with Kenji Jul 3 7pm', NL);
  assert.equal(r.title, 'Ramen with Kenji');
  assert.equal(r.date, '2026-07-03');
  assert.equal(r.time, '19:00');
});
test('parseEvent: relative today/tomorrow', () => {
  assert.equal(parseEvent('Call landlord today', NL).date, '2026-06-30');
  assert.equal(parseEvent('Dentist tomorrow 9am', NL).date, '2026-07-01');
  assert.equal(parseEvent('Dentist tomorrow 9am', NL).time, '09:00');
});
test('parseEvent: weekday resolves forward; "next" adds a week', () => {
  assert.equal(parseEvent('Gym friday', NL).date, '2026-07-03');   // Tue -> coming Fri
  assert.equal(parseEvent('Gym next friday', NL).date, '2026-07-10');
  assert.equal(parseEvent('Trash tuesday', NL).date, '2026-06-30'); // same weekday = today
});
test('parseEvent: ISO and numeric M/D, past date rolls to next year', () => {
  assert.equal(parseEvent('Flight 2026-07-11', NL).date, '2026-07-11');
  assert.equal(parseEvent('Viewing 7/2', NL).date, '2026-07-02');
  assert.equal(parseEvent('Party 1/5', NL).date, '2027-01-05');    // Jan already past -> next year
});
test('parseEvent: 24h time, no date defaults to today', () => {
  const r = parseEvent('Standup 09:30', NL);
  assert.equal(r.time, '09:30');
  assert.equal(r.date, '2026-06-30');
  assert.equal(r.title, 'Standup');
});
test('parseEvent: title-only, empty input safe', () => {
  assert.equal(parseEvent('Buy futon', NL).title, 'Buy futon');
  assert.equal(parseEvent('Buy futon', NL).date, '2026-06-30');
  const e = parseEvent('', NL);
  assert.equal(e.title, '');
  assert.equal(e.date, '2026-06-30');
});

// ---- lib/checklist.js applyPhaseMoves (cross-phase drag re-homing) ----
import { applyPhaseMoves } from '../docs/assets/lib/checklist.js';

const GROUPS = () => [
  { key: '0', items: [{ id: 'a' }, { id: 'b' }] },
  { key: '1', items: [{ id: 'c' }] },
  { key: 'mine', items: [{ id: 'x' }] },
];
test('applyPhaseMoves: re-homes a baked item into another phase', () => {
  const out = applyPhaseMoves(GROUPS(), { a: '1' });
  assert.deepEqual(out[0].items.map(i => i.id), ['b']);
  assert.deepEqual(out[1].items.map(i => i.id), ['c', 'a']);
});
test('applyPhaseMoves: moves into and out of the mine group', () => {
  const out = applyPhaseMoves(GROUPS(), { b: 'mine', x: '0' });
  assert.deepEqual(out[2].items.map(i => i.id), ['b']);
  assert.deepEqual(out[0].items.map(i => i.id), ['a', 'x']);
});
test('applyPhaseMoves: stale/unknown targets and same-group moves are no-ops', () => {
  const out = applyPhaseMoves(GROUPS(), { a: '9', c: '1', ghost: '0' });
  assert.deepEqual(out.map(g => g.items.map(i => i.id)), [['a', 'b'], ['c'], ['x']]);
});
test('applyPhaseMoves: does not mutate its input', () => {
  const g = GROUPS();
  applyPhaseMoves(g, { a: '1' });
  assert.deepEqual(g[0].items.map(i => i.id), ['a', 'b']);
});

// ---- lib/weather.js (Open-Meteo parse + WMO labels) ----
import { parseWeather, wmoInfo } from '../docs/assets/lib/weather.js';

test('parseWeather: maps a real Open-Meteo body to the view model', () => {
  const w = parseWeather({
    current: { temperature_2m: 22.6, apparent_temperature: 26.5, weather_code: 2 },
    daily: { temperature_2m_max: [29.1], temperature_2m_min: [21.8], precipitation_probability_max: [40] },
  });
  assert.deepEqual(w, { sunrise: null, sunset: null, temp: 23, feels: 27, code: 2, hi: 29, lo: 22, rainPct: 40 });
});
test('parseWeather: wrong/empty shapes return null; missing daily degrades to nulls', () => {
  assert.equal(parseWeather(null), null);
  assert.equal(parseWeather({}), null);
  assert.equal(parseWeather({ current: { temperature_2m: 'hot' } }), null);
  const w = parseWeather({ current: { temperature_2m: 30 } });
  assert.equal(w.temp, 30);
  assert.equal(w.hi, null);
  assert.equal(w.rainPct, null);
});
test('wmoInfo: known and unknown codes', () => {
  assert.equal(wmoInfo(0).label, 'Clear');
  assert.equal(wmoInfo(95).emoji, '⛈');
  assert.equal(wmoInfo(1234).label, 'Weather');
});

// ---- lib/quakes.js + lib/rates.js ----
import { parseQuakes, shindo } from '../docs/assets/lib/quakes.js';
import { parseUsdPerJpy } from '../docs/assets/lib/rates.js';

test('parseQuakes: maps rows, drops malformed, labels shindo/tsunami', () => {
  const q = parseQuakes([
    { earthquake: { time: '2026/07/02 13:48:00', maxScale: 45, domesticTsunami: 'Watch', hypocenter: { name: '青森県東方沖', magnitude: 4.5 } } },
    { earthquake: { hypocenter: {} } },
    null,
  ]);
  assert.equal(q.length, 1);
  assert.deepEqual(q[0], { time: '2026/07/02 13:48:00', name: '青森県東方沖', mag: 4.5, shindo: '5弱', tsunami: true });
  assert.equal(shindo(20), '2');
  assert.equal(shindo(99), null);
});
test('parseUsdPerJpy: success shape only', () => {
  assert.equal(parseUsdPerJpy({ result: 'success', rates: { USD: 0.00615 } }), 0.00615);
  assert.equal(parseUsdPerJpy({ result: 'error' }), null);
  assert.equal(parseUsdPerJpy({ result: 'success', rates: { USD: '0.006' } }), null);
  assert.equal(parseUsdPerJpy(null), null);
});
test('parseWeather: sunrise/sunset HH:MM extraction + absence', () => {
  const w = parseWeather({ current: { temperature_2m: 25 }, daily: { sunrise: ['2026-07-02T04:28'], sunset: ['2026-07-02T19:01'] } });
  assert.equal(w.sunrise, '04:28');
  assert.equal(w.sunset, '19:01');
  assert.equal(parseWeather({ current: { temperature_2m: 25 } }).sunrise, null);
});

// ---- lib/wiki.js (Wikipedia geosearch parse) ----
import { parseGeoSearch } from '../docs/assets/lib/wiki.js';

test('parseGeoSearch: maps, sorts by distance, drops malformed, encodes URL', () => {
  const r = parseGeoSearch({ query: { geosearch: [
    { title: 'Kita-Ayase Station', dist: 1092.1 },
    { title: 'Aoi Station', dist: 672 },
    { notitle: true },
  ] } });
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Aoi Station');
  assert.equal(r[0].dist, 672);
  assert.equal(r[1].url, 'https://en.wikipedia.org/wiki/Kita-Ayase%20Station'.replace('%20', '_') === r[1].url ? r[1].url : 'https://en.wikipedia.org/wiki/Kita-Ayase_Station');
  assert.deepEqual(parseGeoSearch({}), []);
  assert.deepEqual(parseGeoSearch(null), []);
});

// ---- lib/weekgrid.js time-grid helpers (parseHM, layoutDay) ----
import { parseHM, layoutDay, fmt12 } from '../docs/assets/lib/weekgrid.js';

test('parseHM: valid times → minutes, junk → null', () => {
  assert.equal(parseHM('00:00'), 0);
  assert.equal(parseHM('15:10'), 910);
  assert.equal(parseHM('9:05'), 545);
  assert.equal(parseHM('23:59'), 1439);
  assert.equal(parseHM('24:00'), null);
  assert.equal(parseHM('12:60'), null);
  assert.equal(parseHM('noon'), null);
  assert.equal(parseHM(''), null);
});
test('fmt12: 24h "HH:MM" → compact 12h label; junk → ""', () => {
  assert.equal(fmt12('13:10'), '1:10 PM');
  assert.equal(fmt12('09:00'), '9 AM');
  assert.equal(fmt12('00:00'), '12 AM');
  assert.equal(fmt12('12:00'), '12 PM');
  assert.equal(fmt12('23:59'), '11:59 PM');
  assert.equal(fmt12('x'), '');
  assert.equal(fmt12(''), '');
});
test('layoutDay: non-overlapping = single column each; overlaps split', () => {
  const a = layoutDay([{ id: 'a', startMin: 600, endMin: 660 }, { id: 'b', startMin: 700, endMin: 760 }]);
  assert.equal(a.find(x => x.id === 'a').cols, 1);
  assert.equal(a.find(x => x.id === 'b').cols, 1);
  const o = layoutDay([{ id: 'a', startMin: 600, endMin: 720 }, { id: 'b', startMin: 660, endMin: 780 }]);
  assert.equal(o.find(x => x.id === 'a').cols, 2);
  assert.equal(o.find(x => x.id === 'a').col, 0);
  assert.equal(o.find(x => x.id === 'b').col, 1);
  // a third overlapping all three → 3 cols
  const t = layoutDay([{ id: 'a', startMin: 600, endMin: 720 }, { id: 'b', startMin: 610, endMin: 730 }, { id: 'c', startMin: 620, endMin: 700 }]);
  assert.equal(Math.max(...t.map(x => x.cols)), 3);
});

// ---- ics.js timed export (review fix) ----
test('toICS: timed event emits floating DTSTART/DTEND, all-day unchanged', () => {
  const timed = toICS([{ id: 'f1', title: 'Flight', date: '2026-06-30', time: '08:25', endTime: '10:50' }]);
  assert.match(timed, /DTSTART:20260630T082500/);
  assert.match(timed, /DTEND:20260630T105000/);
  assert.ok(!/VALUE=DATE:20260630/.test(timed), 'timed event must not be all-day');
  const allday = toICS([{ id: 'a1', title: 'Stay', date: '2026-07-10', endDate: '2026-07-15' }]);
  assert.match(allday, /DTSTART;VALUE=DATE:20260710/);
});
test('toICS: timed with no endTime → default +1h', () => {
  const t = toICS([{ id: 'h', title: 'Haircut', date: '2026-07-07', time: '10:00' }]);
  assert.match(t, /DTSTART:20260707T100000/);
  assert.match(t, /DTEND:20260707T110000/);
});
test('gcalUrl: timed event carries a timed dates param + Tokyo tz', () => {
  const u = gcalUrl({ id: 'f', title: 'Flight', date: '2026-07-15', time: '15:10', endTime: '17:00' });
  assert.match(decodeURIComponent(u), /dates=20260715T151000\/20260715T170000/);
  assert.match(u, /ctz=Asia%2FTokyo/);
  const a = gcalUrl({ id: 'a', title: 'Stay', date: '2026-07-10', endDate: '2026-07-15' });
  assert.match(decodeURIComponent(a), /dates=20260710\/20260716/);
});

// ---- lib/usage.js (private, per-device usage counters) ----
import { bumpUsage, usageSummary, normalizeUsage } from '../docs/assets/lib/usage.js';

test('bumpUsage: counts routes + acts, stamps days, never mutates the input', () => {
  const start = normalizeUsage(null);
  const a = bumpUsage(start, 'route', 'calendar', '2026-07-08');
  const b = bumpUsage(a, 'route', 'calendar', '2026-07-08');
  const c = bumpUsage(b, 'act', 'edits', '2026-07-09');
  assert.equal(c.routes.calendar.n, 2);
  assert.equal(c.routes.calendar.last, '2026-07-08');
  assert.equal(c.acts.edits.n, 1);
  assert.deepEqual(Object.keys(c.days).sort(), ['2026-07-08', '2026-07-09']);
  assert.deepEqual(start, normalizeUsage(null));           // input untouched (immutability)
  assert.equal(a.routes.calendar.n, 1);                    // intermediate untouched too
});
test('bumpUsage: prunes the oldest day stamps beyond the cap', () => {
  let u = normalizeUsage(null);
  for (let i = 0; i < 405; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    u = bumpUsage(u, 'route', 'dashboard', d);
  }
  assert.equal(Object.keys(u.days).length, 400);
  assert.ok(!u.days['2026-01-01']);                         // oldest pruned
  assert.equal(u.routes.dashboard.n, 405);                  // counts survive pruning
});
test('usageSummary: ranks routes, totals visits/edits, flags never-used; guards corrupt input', () => {
  let u = normalizeUsage('corrupt string');                 // corrupt stored value → fresh state
  u = bumpUsage(u, 'route', 'map', '2026-07-08');
  u = bumpUsage(u, 'route', 'calendar', '2026-07-08');
  u = bumpUsage(u, 'route', 'calendar', '2026-07-08');
  u = bumpUsage(u, 'act', 'edits', '2026-07-08');
  const s = usageSummary(u, ['calendar', 'map', 'budget']);
  assert.deepEqual(s.routes.map(r => r.route), ['calendar', 'map']);   // ranked desc by visits
  assert.equal(s.totalVisits, 3);
  assert.equal(s.edits, 1);
  assert.equal(s.daysUsed, 1);
  assert.deepEqual(s.neverUsed, ['budget']);
});

// ---- 縁 People (trip PRM) pure lib — invented names only (public repo) ----
import { newPerson, searchPeople, sortPeople, tagSet, initialsOf, hueOf, flagOf, leavesLabel, isBirthday, isBirthdayMonth, birthdaysByDate } from '../docs/assets/lib/people.js';

test('birthdaysByDate: yearly instances across the range, Feb-29 falls to Feb-28 in non-leap years', () => {
  const people = [
    { id: 'a', name: 'Kenji', birthday: '08-14' },
    { id: 'b', name: 'Aya', birthday: '1990-11-02' },   // year-prefixed → MM-DD wins
    { id: 'c', name: 'Leap', birthday: '02-29' },
    { id: 'd', name: 'NoBday', birthday: '' },           // skipped
    { id: 'e', name: '', birthday: '05-01' },            // no name → skipped
  ];
  const map = birthdaysByDate(people, 2026, 2027);
  assert.deepEqual(map.get('2026-08-14'), [{ id: 'a', name: 'Kenji' }]);
  assert.deepEqual(map.get('2027-08-14'), [{ id: 'a', name: 'Kenji' }]);
  assert.deepEqual(map.get('2026-11-02'), [{ id: 'b', name: 'Aya' }]);
  assert.equal(map.get('2026-02-29'), undefined);        // 2026 is not a leap year
  assert.deepEqual(map.get('2026-02-28'), [{ id: 'c', name: 'Leap' }]);   // observed on the 28th
  assert.equal(map.has('2026-05-01'), false);            // nameless skipped
  assert.equal(map.has('2026-01-01'), false);            // empty birthday skipped
});
test('birthdaysByDate: shared birthday lists everyone together', () => {
  const map = birthdaysByDate([{ id: 'a', name: 'A', birthday: '03-03' }, { id: 'b', name: 'B', birthday: '03-03' }], 2026, 2026);
  assert.deepEqual(map.get('2026-03-03'), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
});

const _people = () => [
  newPerson({ name: 'Aria', tags: ['music', 'Ramen Nerd'], metDate: '2026-07-04', nextPlan: 'Knock Kōenji', lastSeen: '2026-07-06', star: true }, '2026-07-08', 'p1'),
  newPerson({ name: 'Bex', tags: ['share house'], metDate: '2026-07-01', notes: 'combini fried chicken', lastSeen: '2026-07-05' }, '2026-07-08', 'p2'),
  newPerson({ name: 'Cy', tags: ['music'], metDate: '2026-07-05', neighborhood: 'Somewhere' }, '2026-07-08', 'p3'),  // no lastSeen
];

test('searchPeople matches notes, tags, and nextPlan', () => {
  const ppl = _people();
  assert.deepEqual(searchPeople(ppl, 'combini').map(p => p.name), ['Bex']);      // notes
  assert.deepEqual(searchPeople(ppl, 'ramen').map(p => p.name), ['Aria']);       // tag (case-insensitive)
  assert.deepEqual(searchPeople(ppl, 'kōenji').map(p => p.name), ['Aria']);      // nextPlan
  assert.equal(searchPeople(ppl, '').length, 3);                                  // empty → all
});

test('sortPeople: starred first, then mode; missing lastSeen sorts last', () => {
  const ppl = _people();
  assert.deepEqual(sortPeople(ppl, 'met').map(p => p.name), ['Aria', 'Cy', 'Bex']);   // Aria starred → leads despite Cy being newer
  const byName = sortPeople(ppl, 'name').map(p => p.name);
  assert.equal(byName[0], 'Aria');                                                     // starred leads name mode too
  const bySeen = sortPeople(ppl, 'seen').map(p => p.name);
  assert.equal(bySeen[0], 'Aria');                                                     // starred first
  assert.equal(bySeen[bySeen.length - 1], 'Cy');                                       // no lastSeen → last
});

test('tagSet: unique, lowercase, sorted', () => {
  assert.deepEqual(tagSet(_people()), ['music', 'ramen nerd', 'share house']);
});

test('initialsOf: CJK first char, latin 1–2 chars', () => {
  assert.equal(initialsOf('山田'), '山');       // kanji → first char
  assert.equal(initialsOf('さくら'), 'さ');      // hiragana → first char
  assert.equal(initialsOf('Aria Vale'), 'AV');
  assert.equal(initialsOf('Bex'), 'BE');
  assert.equal(initialsOf(''), '?');
});

test('hueOf: deterministic + a valid palette name', () => {
  assert.equal(hueOf('p1'), hueOf('p1'));            // stable across calls
  assert.equal(hueOf('p1712000000000'), hueOf('p1712000000000'));   // stable for a realistic id
  assert.match(hueOf('p2'), /^(music|festival|convention|food|fireworks|illumination|nature|seasonal|personal|disney)$/);
});

test('flagOf: known name/code, empty on unknown', () => {
  assert.equal(flagOf('JP'), '🇯🇵');
  assert.equal(flagOf('australia'), '🇦🇺');
  assert.equal(flagOf('Canadian'), '🇨🇦');
  assert.equal(flagOf('Freedonia'), '');
  assert.equal(flagOf(''), '');
});

test('leavesLabel: future countdown, past, empty', () => {
  assert.equal(leavesLabel('2026-08-20', '2026-07-08'), '⏳ leaves Aug 20 — 6 weeks');
  assert.equal(leavesLabel('2026-07-05', '2026-07-08'), 'left Jul 5');
  assert.equal(leavesLabel('2026-07-08', '2026-07-08'), 'left Jul 8');   // today = departing/gone
  assert.equal(leavesLabel('', '2026-07-08'), '');
});

test('newPerson: name required, metDate defaults to today, tags normalized', () => {
  assert.throws(() => newPerson({ name: '   ' }, '2026-07-08', 'p9'), /name required/);
  const p = newPerson({ name: 'Dex' }, '2026-07-08', 'p9');
  assert.equal(p.metDate, '2026-07-08');
  assert.equal(p.star, false);
  assert.equal(p.seenCount, 0);
  const t = newPerson({ name: 'Ela', tags: ['Music', 'music', ' Climbing '] }, '2026-07-08', 'p10');
  assert.deepEqual(t.tags, ['music', 'climbing']);   // lowercased + deduped
});
test('sortPeople/searchPeople: malformed restored people never throw (missing name, non-string dates)', () => {
  const bad = [
    { id: 'x1', metDate: '2026-07-01' },                          // no name
    { id: 'x2', name: 'Aria', metDate: '2026-07-01' },            // date tie → secondary name compare
    { id: 'x3', name: 'Bex', metDate: 20260702, lastSeen: null }, // numeric date, null lastSeen
  ];
  for (const mode of ['met', 'name', 'seen']) {
    const out = sortPeople(bad, mode);
    assert.equal(out.length, 3);                                   // sorted without throwing
  }
  assert.doesNotThrow(() => searchPeople(bad, 'aria'));
});

test('compact-pages parity: settings control, CSS rules, and store key stay in sync', () => {
  const css = readFileSync(new URL('../docs/assets/style.css', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../docs/assets/guide.js', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../docs/assets/lib/store.js', import.meta.url), 'utf8');
  assert.ok(store.includes('compact:'), 'store.js KEYS must define compact');
  assert.ok(guide.includes("setCompact"), 'guide.js must render the Compact pages switch');
  assert.ok(guide.includes('applyCompact'), 'guide.js must export/apply the compact attribute');
  assert.ok(css.includes('[data-compact="on"] .pillar-head'), 'style.css must style compact mini-titles');
  assert.ok(css.includes('[data-compact="on"] .lede'), 'style.css must hide ledes in compact');
});

test('isBirthday/isBirthdayMonth: MM-DD and YYYY-MM-DD both work; junk never matches', () => {
  assert.equal(isBirthday('11-12', '2026-11-12'), true);
  assert.equal(isBirthday('1990-11-12', '2026-11-12'), true);
  assert.equal(isBirthday('11-12', '2026-11-13'), false);
  assert.equal(isBirthday('', '2026-11-12'), false);
  assert.equal(isBirthday('soon', '2026-11-12'), false);
  assert.equal(isBirthdayMonth('11-12', '2026-11-01'), true);
  assert.equal(isBirthdayMonth('1990-07-20', '2026-07-09'), true);
  assert.equal(isBirthdayMonth('11-12', '2026-10-31'), false);
});

// ---- lib/spend.js (budget actuals) ----
import { parseSpend, monthTotal, monthByCat, spendSummary, pruneSpend } from '../docs/assets/lib/spend.js';

test('parseSpend: plain, yen-sign+comma, k-suffix, bare amount', () => {
  assert.deepEqual(parseSpend('1200 ramen', '2026-07-09'), { amount: 1200, note: 'ramen', date: '2026-07-09' });
  assert.deepEqual(parseSpend('¥3,400 drinks with friends', '2026-07-09'), { amount: 3400, note: 'drinks with friends', date: '2026-07-09' });
  assert.deepEqual(parseSpend('1.2k combini', '2026-07-09'), { amount: 1200, note: 'combini', date: '2026-07-09' });
  assert.deepEqual(parseSpend('980', '2026-07-09'), { amount: 980, note: '', date: '2026-07-09' });
});
test('parseSpend: trailing date words — yesterday + PAST weekday (spends are history)', () => {
  assert.equal(parseSpend('1200 ramen yesterday', '2026-07-09').date, '2026-07-08');
  // 2026-07-09 is a Thursday → bare "mon" = most recent PAST Monday (Jul 6), never forward
  assert.equal(parseSpend('500 coffee mon', '2026-07-09').date, '2026-07-06');
  // bare weekday matching today rolls a full week BACK (a spend "thu" said on Thursday means last week? no — history semantics: not-today)
  assert.equal(parseSpend('500 coffee thu', '2026-07-09').date, '2026-07-02');
  assert.equal(parseSpend('500 coffee today', '2026-07-09').date, '2026-07-09');
});
test('parseSpend: garbage rejected', () => {
  assert.equal(parseSpend('ramen 1200', '2026-07-09'), null);   // amount must lead
  assert.equal(parseSpend('0 freebie', '2026-07-09'), null);
  assert.equal(parseSpend('', '2026-07-09'), null);
});
test('monthTotal/monthByCat: month-scoped sums, cat falls back to note', () => {
  const items = [
    { id: 's1', date: '2026-07-01', amount: 1000, cat: 'food' },
    { id: 's2', date: '2026-07-15', amount: 500, note: 'Coffee' },
    { id: 's3', date: '2026-06-30', amount: 9999, cat: 'food' },
  ];
  assert.equal(monthTotal(items, '2026-07'), 1500);
  assert.deepEqual(monthByCat(items, '2026-07'), { food: 1000, coffee: 500 });
});
test('spendSummary: trailing-30d actuals drive burn + runway; empty → null (plan fallback)', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, date: `2026-07-${String(i % 9 + 1).padStart(2, '0')}`, amount: 1000 }));
  const s = spendSummary(items, 190000, 900000, 0, '2026-07-09');
  assert.equal(s.actualThisMonth, 30000);
  assert.equal(s.actualMonthlyBurn, 30000);            // 30k over 30d → 1k/day → 30k monthly
  assert.equal(s.actualRunwayMonths, 29);              // (900k − 30k already spent) / 30k — savings are anchored now
  assert.ok(s.vsPlan < 0);                             // projected 31k < planned 190k
  assert.equal(spendSummary([], 190000, 900000, 0, '2026-07-09'), null);
  assert.equal(spendSummary([{ date: '2026-01-01', amount: 500 }], 1, 1, 0, '2026-07-09'), null);  // outside window
});
test('pruneSpend: drops entries older than the retention window, keeps the rest, never mutates', () => {
  const items = [{ id: 'a', date: '2024-01-05', amount: 1 }, { id: 'b', date: '2026-07-01', amount: 2 }];
  const out = pruneSpend(items, '2026-07-09');
  assert.deepEqual(out.map(i => i.id), ['b']);
  assert.equal(items.length, 2);
});
test('parseSpend: sub-0.5 decimals cannot mint a ¥0 entry; income>burn → Infinity runway', () => {
  assert.equal(parseSpend('0.4 x', '2026-07-09'), null);
  const s = spendSummary([{ date: '2026-07-08', amount: 30000 }], 190000, 900000, 500000, '2026-07-09');
  assert.equal(s.actualRunwayMonths, Infinity);   // income 500k > burn 30k
});

test('panel fixes: leap-day birthdays fold to Feb 28 in non-leap years; impossible dates rejected', () => {
  assert.equal(isBirthday('02-29', '2026-02-28'), true);    // 2026 not leap → celebrate the 28th
  assert.equal(isBirthday('02-29', '2028-02-29'), true);    // 2028 leap → the real day
  assert.equal(isBirthday('02-29', '2028-02-28'), false);
  assert.equal(isBirthdayMonth('11-31', '2026-11-05'), false);  // invalid day → no phantom badge
  assert.equal(isBirthdayMonth('13-05', '2026-01-05'), false);  // invalid month
});
test('panel fixes: runway gated on confidence + savings anchored to entry date', () => {
  // 3 entries on 3 days = not confident → callers hide runway
  const sparse = [{date:'2026-07-07',amount:500},{date:'2026-07-08',amount:600},{date:'2026-07-09',amount:550}];
  const s1 = spendSummary(sparse, 190000, 900000, 0, '2026-07-09');
  assert.equal(s1.confident, false);
  assert.equal(s1.sampleDays, 3);
  // 15 distinct days → confident; savings reduced by spends since savingsAsOf
  const dense = Array.from({length:15},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,amount:2000}));
  const s2 = spendSummary(dense, 190000, 100000, 0, '2026-07-15', '2026-07-01');
  assert.equal(s2.confident, true);
  assert.equal(s2.savingsNow, 100000 - 30000);              // 15×2000 logged since the anchor
  assert.equal(s2.actualRunwayMonths, 2);              // floor(70k/30k) — unanchored would say 3
  // spends BEFORE the anchor don't count against savings
  const s3 = spendSummary(dense, 190000, 100000, 0, '2026-07-15', '2026-07-10');
  assert.equal(s3.savingsNow, 100000 - 12000);              // only Jul 10-15 (6×2000)
});

// ---- People v1.1: drifting + vCard + event link ----
import { driftingPeople, driftLabel, toVCard } from '../docs/assets/lib/people.js';

test('driftingPeople: >14d since last contact; metDate fallback; left people excluded; most-drifted first', () => {
  const t = '2026-07-09';
  const list = [
    { id: 'p1', name: 'Aiko', lastSeen: '2026-07-05' },                       // 4d — fresh
    { id: 'p2', name: 'Bram', lastSeen: '2026-06-20' },                       // 19d — drifting
    { id: 'p3', name: 'Chie', metDate: '2026-05-01' },                        // never seen → metDate (69d)
    { id: 'p4', name: 'Dario', lastSeen: '2026-06-01', leaves: '2026-07-01' }, // left already
    { id: 'p5', name: 'Eri', lastSeen: '2026-06-01', leaves: '2026-08-01' },   // still here (38d)
    { id: 'p6', name: 'Fen' },                                                 // no dates at all
  ];
  const out = driftingPeople(list, t);
  assert.deepEqual(out.map(x => x.id), ['p3', 'p5', 'p2']);
  assert.equal(out[0].days, 69);
});
test('driftingPeople: threshold boundary is exclusive; malformed records never throw', () => {
  const t = '2026-07-15';
  assert.equal(driftingPeople([{ id: 'a', name: 'x', lastSeen: '2026-07-01' }], t).length, 0);   // exactly 14d
  assert.equal(driftingPeople([{ id: 'a', name: 'x', lastSeen: '2026-06-30' }], t).length, 1);   // 15d
  assert.deepEqual(driftingPeople([{ lastSeen: 42 }, null, { name: 'y', metDate: 'soon' }], t), []);
});
test('driftLabel spans: days → weeks → months', () => {
  assert.equal(driftLabel(13), '13 d');
  assert.equal(driftLabel(15), '2 wks');   // drifting entries start past 14d — weeks from there
  assert.equal(driftLabel(21), '3 wks');
  assert.equal(driftLabel(90), '3 mo');
});
test('toVCard: FN/N + TEL vs URL vs handle-in-NOTE; BDAY only with a full date; escaping; CRLF', () => {
  const v = toVCard([
    { name: 'Kenji; Barber', contact: '+81 90-1234-5678', birthday: '1994-04-20', metDate: '2026-07-02', metPlace: 'Koenji' },
    { name: 'Mia', contact: 'LINE @mia_tokyo', birthday: '04-20', notes: 'ramen,\nlate nights' },
    { name: 'Site Guy', contact: 'https://example.com/a' },
    { name: '', contact: '000' },   // nameless → skipped
  ]);
  assert.ok(v.includes('FN:Kenji\\; Barber'));   // vesc escapes the semicolon
  assert.ok(v.includes('TEL;TYPE=CELL:+81 90-1234-5678'));
  assert.ok(v.includes('BDAY:1994-04-20'));
  assert.ok(v.includes('NOTE:Met 2026-07-02 · Koenji'));
  assert.ok(v.includes('Birthday: 04-20\\nContact: LINE @mia_tokyo\\nramen\\,\\nlate nights'));
  assert.ok(v.includes('URL:https://example.com/a'));
  assert.equal((v.match(/BEGIN:VCARD/g) || []).length, 3);
  assert.ok(v.endsWith('END:VCARD\r\n'));
  assert.ok(!v.includes('\n\r') && v.split('\r\n').every(l => !l.includes('\n') || l === ''));
  assert.equal(toVCard([]), '');
});
test('newPerson carries metEventId (event link) and defaults it empty', () => {
  assert.equal(newPerson({ name: 'Aiko', metEventId: ' ev-x ' }, '2026-07-09').metEventId, 'ev-x');
  assert.equal(newPerson({ name: 'Aiko' }, '2026-07-09').metEventId, '');
});

// ---- Anki Core-2000 refresher: whole-deck export parsing ----
import { parseAnkiExport, cleanField, chunkCount, chunkSlice, chunkLabel, toggleShaky, shuffled } from '../docs/assets/lib/anki.js';

const CORE_SAMPLE = `#separator:tab
#html:true
食べ物\tたべもの\tfood\tこの食べ物はおいしいです。\tThis food is delicious.[sound:c1.mp3]
学校\tがっこう\tschool\t学校へ行きます。\tI go to school.
<b>水</b>\tみず\twater\t水を飲みます。[sound:c3.mp3]\tI drink water.`;

test('parseAnkiExport: header skip, tab sniff, column auto-detect, cleaning', () => {
  const { cards, cols, delim } = parseAnkiExport(CORE_SAMPLE);
  assert.equal(delim, '\t');
  assert.equal(cards.length, 3);
  assert.deepEqual({ w: cards[0].w, r: cards[0].r, m: cards[0].m }, { w: '食べ物', r: 'たべもの', m: 'food' });
  assert.equal(cards[0].s, 'この食べ物はおいしいです。');
  assert.equal(cards[0].sm, 'This food is delicious.');      // [sound:] stripped
  assert.equal(cards[2].w, '水');                              // <b> stripped
  assert.ok(cols.expression >= 0 && cols.reading >= 0 && cols.meaning >= 0);
});
test('parseAnkiExport: semicolon fallback + mapping override + furigana brackets', () => {
  const { cards } = parseAnkiExport('犬[いぬ];dog\n猫[ねこ];cat', { expression: 0, meaning: 1, reading: -1, sentence: -1, sentenceMeaning: -1 });
  assert.equal(cards[0].w, '犬');                              // furigana bracket removed
  assert.equal(cards[1].m, 'cat');
  assert.throws(() => parseAnkiExport('#separator:tab\n\n'), /no data rows/);
  assert.throws(() => parseAnkiExport('???\t???'), /could not detect|no usable/);
});
test('cleanField: entities, tags, sound, whitespace', () => {
  assert.equal(cleanField(' <i>a&amp;b</i> [sound:x.mp3]  c '), 'a&b c');
});
test('anki chunks + shaky + deterministic shuffle', () => {
  assert.equal(chunkCount(2000), 20);
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkLabel(3, 2000), '301–400');
  assert.equal(chunkLabel(19, 1950), '1901–1950');
  const cards = Array.from({ length: 250 }, (_, i) => ({ id: 'a' + i }));
  assert.equal(chunkSlice(cards, 2).length, 50);
  let sh = toggleShaky([], 'a5'); sh = toggleShaky(sh, 'a9'); sh = toggleShaky(sh, 'a5');
  assert.deepEqual(sh, ['a9']);
  const s1 = shuffled(cards, 42).map(c => c.id), s2 = shuffled(cards, 42).map(c => c.id);
  assert.deepEqual(s1, s2);                                    // same seed → same order
  assert.notDeepEqual(s1, cards.map(c => c.id));               // actually shuffles
});

// ---- Anki stage 3: pile snapshot ----
import { pileOrder, toAnkiTSV } from '../docs/assets/lib/anki.js';
test('pileOrder: deck order preserved, ids deduped by Set, empty/missing safe', () => {
  const cards = [{id:'a0'},{id:'a1'},{id:'a2'},{id:'a3'}];
  assert.deepEqual(pileOrder(cards, ['a3','a1','a1']).map(c=>c.id), ['a1','a3']);  // deck order, not flag order
  assert.deepEqual(pileOrder(cards, []), []);
  assert.deepEqual(pileOrder([], ['a1']), []);
  assert.deepEqual(pileOrder(cards, undefined), []);
});

// ---- lib/grammar.js (JLPT grammar reference, P1) ----
import { readingOf, tokenReading, exampleReading, kanaToRomaji, searchPoints, byLevel } from '../docs/assets/lib/grammar.js';
import { validatePoints, mcqOptions } from '../scripts/validate-grammar.mjs';

test('readingOf: per-segment furigana derives the kana reading', () => {
  assert.equal(readingOf([['食', 'た'], ['べて', '']]), 'たべて');
  assert.equal(readingOf([['明日', 'あした']]), 'あした');
  assert.equal(readingOf([]), '');
  assert.equal(readingOf(undefined), '');
  assert.equal(tokenReading('、'), '、');
  assert.equal(tokenReading({ t: '前に', f: [['前', 'まえ'], ['に', '']] }), 'まえに');
});

test('exampleReading: concatenates the kana reading of a mixed ja token array', () => {
  // kanji objects → their furigana readings; particle/punctuation strings pass through verbatim
  const ja = [
    { t: '昨日', f: [['昨日', 'きのう']] }, 'は',
    { t: '学校', f: [['学校', 'がっこう']] }, 'に',
    { t: '行った', f: [['行', 'い'], ['った', '']] }, '。',
  ];
  assert.equal(exampleReading(ja), 'きのうはがっこうにいった。');
  // homograph: the DATA reading wins (行った → いった, not おこなった)
  assert.equal(exampleReading([{ t: '行った', f: [['行', 'い'], ['った', '']] }]), 'いった');
  assert.equal(exampleReading([]), '');
  assert.equal(exampleReading(undefined), '');
});

test('kanaToRomaji: wapuro romaji incl. digraphs, gemination, chōon, katakana', () => {
  assert.equal(kanaToRomaji('たべて'), 'tabete');
  assert.equal(kanaToRomaji('きょう'), 'kyou');
  assert.equal(kanaToRomaji('がっこう'), 'gakkou');
  assert.equal(kanaToRomaji('しゃしん'), 'shashin');
  assert.equal(kanaToRomaji('ラーメン'), 'raamen');
  assert.equal(kanaToRomaji('まえに'), 'maeni');
  assert.equal(kanaToRomaji('も〜も'), 'momo');     // 〜 skipped, not an error
  assert.equal(kanaToRomaji(''), '');
});

test('searchPoints: pattern kanji, kana, romaji (spaces ignored), EN meaning', () => {
  const pts = [
    { id: 'n5-mae-ni', pattern: '〜前に', reading: 'まえに', meaning: 'before doing X' },
    { id: 'n5-te-kara', pattern: '〜てから', reading: 'てから', meaning: 'after doing X, Y' },
  ];
  assert.deepEqual(searchPoints(pts, '前').map(p => p.id), ['n5-mae-ni']);       // kanji the card shows
  assert.deepEqual(searchPoints(pts, 'まえに').map(p => p.id), ['n5-mae-ni']);   // kana
  assert.deepEqual(searchPoints(pts, 'mae ni').map(p => p.id), ['n5-mae-ni']);   // romaji, space ignored
  assert.deepEqual(searchPoints(pts, 'AFTER').map(p => p.id), ['n5-te-kara']);   // EN, case-insensitive
  assert.equal(searchPoints(pts, '').length, 2);                                  // empty query = all
  assert.equal(searchPoints(pts, 'zzz').length, 0);
});

test('byLevel filters', () => {
  const pts = [{ id: 'a', level: 'N5' }, { id: 'b', level: 'N4' }];
  assert.deepEqual(byLevel(pts, 'N5').map(p => p.id), ['a']);
});

test('all grammar-*.json files pass the validator (the data gate for every bake PR)', () => {
  const COUNTS = { n5: 82, n4: 86, n3: 72, n2: 66, n1: 47 };            // update per bake phase
  const files = Object.keys(COUNTS).map(l => [l.toUpperCase(),
    JSON.parse(readFileSync(new URL(`../docs/data/grammar-${l}.json`, import.meta.url), 'utf8'))]);
  const allIds = new Set(files.flatMap(([, pts]) => pts.map(p => p.id)));   // related[]/confusable[] cross levels
  // R7: pass the full id→point map so the confusable-symmetry check + the "every point can
  // assemble a 4-choice set (≥3 wrong-options)" corpus gate are ARMED. Red-pending-data until
  // the authoring agents add confusable[]/distractors[] to every point.
  const allById = new Map(files.flatMap(([, pts]) => pts).map(p => [p.id, p]));
  for (const [level, pts] of files) {
    assert.deepEqual(validatePoints(pts, level, allIds, allById), [], level);
    assert.equal(pts.length, COUNTS[level.toLowerCase()], level);
  }
  // plan acid tests: a non-contiguous pattern + a glossed p anchor survive every merge
  const n5 = files[0][1];
  const momo = n5.find(p => p.id === 'n5-mo-mo');
  assert.equal(momo.examples[0].ja.filter(tk => tk.p).length, 2);
  const maeni = n5.find(p => p.id === 'n5-mae-ni');
  assert.ok(maeni.examples[0].ja.find(tk => tk.p && tk.g));
});

// A valid single example (≥1 p token; non-p tokens glossed; f-concat === t).
const okEx = () => ({ en: 'I eat.', ja: [
  { t: '私', f: [['私', 'わたし']], g: 'I' },
  { t: 'は', f: [['は', '']], g: 'topic' },
  { t: '食べる', f: [['食', 'た'], ['べる', '']], p: 1 },
] });
// A fully-enriched valid point (verbatim peg + attribution, flag subset, exactly 3 examples).
const okPoint = (over = {}) => ({
  id: 'n5-ok', level: 'N5', pattern: '〜てから', reading: 'てから', meaning: 'x', connection: 'x',
  nuance: 'x', register: 'neutral', caution: 'x', confidence: 'high', tags: [], related: [],
  peg: { ja: '海賊王におれはなる', romaji: 'kaizokuou ni ore wa naru', en: "I'll be King of the Pirates", source: 'One Piece — Luffy', kind: 'verbatim' },
  flags: ['anime-common', 'casual-spoken'],
  examples: [okEx(), okEx(), okEx()],
  ...over,
});

test('validator rejects malformed tokens', () => {
  const bad = [{
    id: 'n5-bad', level: 'N5', pattern: '〜てから', reading: 'てから', meaning: 'x', connection: 'x',
    confidence: 'high', tags: [], related: ['n5-nope'],
    // 3 examples (exactly-3 rule) — the FIRST is malformed: f ≠ t, no p token
    examples: [
      { en: 'x', ja: [{ t: '食べて', f: [['食', 'た'], ['べ', '']], g: 'eat' }] },
      okEx(), okEx(),
    ],
  }];
  const errs = validatePoints(bad, 'N5', new Set(['n5-bad']));
  assert.ok(errs.some(e => e.includes('≠ t')));            // segment concat mismatch
  assert.ok(errs.some(e => e.includes('no p (pattern)'))); // missing p token
  assert.ok(errs.some(e => e.includes('unknown id')));     // dangling related ref
});

test('validator accepts an enriched point (verbatim peg, flags subset, 3 examples)', () => {
  assert.deepEqual(validatePoints([okPoint()], 'N5', new Set(['n5-ok'])), []);
});

test('validator accepts a styled peg (no attribution dash required)', () => {
  const styled = okPoint({ peg: { ja: 'いっちょやってみっか', romaji: 'iccho yatte mikka', en: "let's give it a shot", source: 'shounen-hero voice', kind: 'styled' } });
  assert.deepEqual(validatePoints([styled], 'N5', new Set(['n5-ok'])), []);
});

test('validator accepts empty flags (absence = neutral-polite)', () => {
  assert.deepEqual(validatePoints([okPoint({ flags: [] })], 'N5', new Set(['n5-ok'])), []);
});

test('validator rejects R5 enrichment violations (peg / flags / example-count)', () => {
  const S = new Set(['n5-ok']);
  const only = (over) => validatePoints([okPoint(over)], 'N5', S);
  // peg missing entirely
  assert.ok(only({ peg: undefined }).some(e => /missing peg/.test(e)));
  // verbatim peg over the 40 code-point cap
  const long = '海'.repeat(41);
  assert.ok(only({ peg: { ja: long, romaji: 'x', en: 'x', source: 'One Piece — Luffy', kind: 'verbatim' } }).some(e => /> 40 code points/.test(e)));
  // verbatim peg without an attribution dash
  assert.ok(only({ peg: { ja: 'よし', romaji: 'yoshi', en: 'ok', source: 'One Piece', kind: 'verbatim' } }).some(e => /needs attribution/.test(e)));
  // unknown flag value
  assert.ok(only({ flags: ['made-up-flag'] }).some(e => /unknown flag/.test(e)));
  // duplicate flag
  assert.ok(only({ flags: ['anime-common', 'anime-common'] }).some(e => /duplicate flag/.test(e)));
  // exactly-3 examples enforced (2 is now too few)
  assert.ok(only({ examples: [okEx(), okEx()] }).some(e => /exactly 3/.test(e)));
});

// ---- R7: confusable graph + distractors + mcqOptions ----
test('validator accepts a symmetric confusable pair with ≥3 MCQ options each', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜ように', confusable: ['n5-b'], distractors: ['〜ため', '〜べく'] });
  const B = okPoint({ id: 'n5-b', pattern: '〜ために', confusable: ['n5-a'], distractors: ['〜むけ', '〜よう'] });
  const allById = new Map([['n5-a', A], ['n5-b', B]]);
  assert.deepEqual(validatePoints([A, B], 'N5', new Set(['n5-a', 'n5-b']), allById), []);
});

test('validator rejects an asymmetric confusable edge (A→B but not B→A)', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜A', confusable: ['n5-b'], distractors: ['x', 'y'] });
  const B = okPoint({ id: 'n5-b', pattern: '〜B', confusable: [], distractors: ['x', 'y', 'z'] });
  const allById = new Map([['n5-a', A], ['n5-b', B]]);
  const errs = validatePoints([A, B], 'N5', new Set(['n5-a', 'n5-b']), allById);
  assert.ok(errs.some(e => /not symmetric/.test(e)));
});

test('validator rejects a self-referential confusable', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜A', confusable: ['n5-a'], distractors: ['x', 'y', 'z'] });
  const errs = validatePoints([A], 'N5', new Set(['n5-a']), new Map([['n5-a', A]]));
  assert.ok(errs.some(e => /self-reference/.test(e)));
});

test('validator rejects an unknown confusable id (referential, gate off)', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜A', confusable: ['n5-ghost'], distractors: ['x', 'y', 'z'] });
  const errs = validatePoints([A], 'N5', new Set(['n5-a']));   // 3-arg: symmetry/gate off, referential still runs
  assert.ok(errs.some(e => /confusable → unknown id n5-ghost/.test(e)));
});

test('validator rejects a distractor equal to the point pattern', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜ように', distractors: ['〜ように', 'x', 'y'] });
  assert.ok(validatePoints([A], 'N5', new Set(['n5-a'])).some(e => /equals the point's own pattern/.test(e)));
});

test('validator rejects a distractors count outside 2–4', () => {
  const one = okPoint({ id: 'n5-a', pattern: '〜A', distractors: ['x'] });
  assert.ok(validatePoints([one], 'N5', new Set(['n5-a'])).some(e => /2–4 entries/.test(e)));
  const five = okPoint({ id: 'n5-a', pattern: '〜A', distractors: ['a', 'b', 'c', 'd', 'e'] });
  assert.ok(validatePoints([five], 'N5', new Set(['n5-a'])).some(e => /2–4 entries/.test(e)));
});

test('mcqOptions: confusable patterns ++ distractors, deduped, own pattern excluded', () => {
  const A = { id: 'n5-a', pattern: '〜ように', confusable: ['n5-b', 'n5-c'], distractors: ['〜ために', 'x'] };
  const B = { id: 'n5-b', pattern: '〜ために' };   // surfaces as a distractor too → deduped to one
  const C = { id: 'n5-c', pattern: '〜ように' };   // equals A's own pattern → excluded
  const allById = new Map([['n5-a', A], ['n5-b', B], ['n5-c', C]]);
  assert.deepEqual(mcqOptions(A, allById), ['〜ために', 'x']);
  assert.deepEqual(mcqOptions({ pattern: '〜A' }, allById), []);   // no confusable/distractors → empty
});

test('validator rejects a point that cannot assemble ≥3 MCQ wrong-options', () => {
  const A = okPoint({ id: 'n5-a', pattern: '〜A', distractors: ['x', 'y'] });   // 2 options, no confusables
  const errs = validatePoints([A], 'N5', new Set(['n5-a']), new Map([['n5-a', A]]));
  assert.ok(errs.some(e => /assemble ≥3 MCQ wrong-options/.test(e)));
});

// ---- R12: passage bank + validatePassages (文章の文法 / passage cloze) ----
import { validatePassages } from '../scripts/validate-grammar.mjs';

const P_IDS = new Set(['n5-wa']);
// A valid 4-choice blank (grammar kind → resolvable pointId).
const okBlank = (n, over = {}) => ({ n, answer: 'は', options: ['は', 'が', 'を', 'に'], kind: 'grammar', pointId: 'n5-wa', ...over });
// A valid passage: one furigana token + 4 blank markers, blanks[] in bijection by n.
const okPassage = (over = {}) => ({
  id: 'p-n5-1', level: 'N5', title: 'テスト',
  tokens: [
    { t: '店', f: [['店', 'みせ']], g: 'shop' },
    { blank: true, n: 0 }, { blank: true, n: 1 }, { blank: true, n: 2 }, { blank: true, n: 3 },
    '。',
  ],
  blanks: [okBlank(0), okBlank(1), okBlank(2), okBlank(3)],
  en: 'test.', confidence: 'high',
  ...over,
});
// A passage carrying exactly k blank markers + k matching blanks[] entries (for the count rule).
const passageWithBlanks = (k) => okPassage({
  tokens: [...Array(k)].map((_, i) => ({ blank: true, n: i })).concat(['。']),
  blanks: [...Array(k)].map((_, i) => okBlank(i)),
});
const onlyP = (over) => validatePassages({ passages: [okPassage(over)] }, P_IDS);

test('validatePassages accepts a well-formed passage', () => {
  assert.deepEqual(validatePassages({ passages: [okPassage()] }, P_IDS), []);
});

test('validatePassages accepts a discourse blank without a pointId', () => {
  const disc = okPassage({ blanks: [okBlank(0, { kind: 'discourse', answer: 'そして', options: ['そして', 'でも', 'だから', 'しかし'], pointId: undefined }), okBlank(1), okBlank(2), okBlank(3)] });
  assert.deepEqual(validatePassages({ passages: [disc] }, P_IDS), []);
});

test('validatePassages rejects a blank with no options', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { options: undefined }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /options must be an array/.test(e)));
});

test('validatePassages rejects answer not among options', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { answer: 'ぜ' }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /is not one of options/.test(e)));
});

test('validatePassages rejects a duplicate option', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { options: ['は', 'は', 'を', 'に'] }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /duplicate option/.test(e)));
});

test('validatePassages rejects an options count other than 4', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { options: ['は', 'が', 'を'] }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /exactly 4 entries/.test(e)));
});

test('validatePassages rejects an unresolvable grammar pointId', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { pointId: 'n5-ghost' }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /unknown grammar id n5-ghost/.test(e)));
});

test('validatePassages rejects a missing kind', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { kind: undefined }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /bad kind/.test(e)));
});

test('validatePassages rejects a grammar blank with no pointId', () => {
  assert.ok(onlyP({ blanks: [okBlank(0, { pointId: undefined }), okBlank(1), okBlank(2), okBlank(3)] }).some(e => /grammar blank needs a pointId/.test(e)));
});

test('validatePassages enforces 4–5 blanks per passage', () => {
  assert.ok(validatePassages({ passages: [passageWithBlanks(3)] }, P_IDS).some(e => /4–5 blanks/.test(e)));
  assert.ok(validatePassages({ passages: [passageWithBlanks(6)] }, P_IDS).some(e => /4–5 blanks/.test(e)));
  assert.deepEqual(validatePassages({ passages: [passageWithBlanks(5)] }, P_IDS), []);
});

test('validatePassages rejects a token whose f-segments do not concat to t', () => {
  assert.ok(onlyP({ tokens: [
    { t: '食べて', f: [['食', 'た'], ['べ', '']], g: 'eat' },   // 食べ ≠ 食べて
    { blank: true, n: 0 }, { blank: true, n: 1 }, { blank: true, n: 2 }, { blank: true, n: 3 }, '。',
  ] }).some(e => /≠ t/.test(e)));
});

test('validatePassages rejects a marker/entry mismatch (bijection by n)', () => {
  // marker n=3 present in tokens but no blanks[] entry for it, and a blanks[] entry n=9 with no marker
  const p = okPassage({ blanks: [okBlank(0), okBlank(1), okBlank(2), okBlank(9)] });
  const errs = validatePassages({ passages: [p] }, P_IDS);
  assert.ok(errs.some(e => /blank n=9 has no .*marker/.test(e)));
  assert.ok(errs.some(e => /blank marker n=3 in tokens has no blanks\[\] entry/.test(e)));
});

test('validatePassages rejects a bad id and confidence', () => {
  assert.ok(onlyP({ id: 'n5-1' }).some(e => /bad id format/.test(e)));
  assert.ok(onlyP({ confidence: 'certain' }).some(e => /bad confidence/.test(e)));
});

test('passages: validatePassages passes over the real seed bank (the R12 data gate)', () => {
  const files = ['n5', 'n4', 'n3', 'n2', 'n1'].map(l =>
    JSON.parse(readFileSync(new URL(`../docs/data/grammar-${l}.json`, import.meta.url), 'utf8')));
  const allIds = new Set(files.flat().map(p => p.id));
  const bank = JSON.parse(readFileSync(new URL('../docs/data/grammar-passages.json', import.meta.url), 'utf8'));
  assert.deepEqual(validatePassages(bank, allIds), []);
  assert.ok(bank.passages.length >= 2, 'seed needs ≥2 passages');
  bank.passages.forEach(p => assert.ok(p.blanks.length >= 4 && p.blanks.length <= 5, `${p.id} blank count`));
});


import { shakyRows } from '../docs/assets/lib/grammar.js';
test('shakyRows: level order N5→N1, deck order within, tags + TSV round-trip', () => {
  const byLevel = {
    N5: [{ id: 'n5-a', level: 'N5', pattern: '〜てから', meaning: 'after', connection: 'V-て + から' },
         { id: 'n5-b', level: 'N5', pattern: '〜たい', meaning: 'want', connection: 'stem + たい' }],
    N1: [{ id: 'n1-a', level: 'N1', pattern: '〜べく', meaning: 'in order to', connection: 'V-dict + べく' }],
  };
  const rows = shakyRows(byLevel, ['n1-a', 'n5-b']);
  assert.deepEqual(rows.map(r => r.front), ['〜たい', '〜べく']);   // N5 before N1, deck order kept
  assert.deepEqual(rows[0].tags, ['jwh-grammar', 'N5']);
  assert.equal(rows[0].back, 'want — stem + たい');
  assert.equal(toAnkiTSV(rows).split('\n').length, 2);
  assert.deepEqual(shakyRows(byLevel, []), []);
});

// ---- lib/peg.js (R6 — anime peg cards + register-flag chips; pure, esc-safe) ----
import { pegHTML, flagBadgesHTML, matchesFlag, FLAG_META } from '../docs/assets/lib/peg.js';
test('pegHTML: escapes a hostile peg (no raw < or unescaped quote survives)', () => {
  const html = pegHTML({ peg: {
    ja: '<img src=x onerror=alert(1)>「', romaji: 'a"b', en: '</figure><script>', source: 'Evil — "src" (styled)', kind: 'styled',
  } });
  assert.ok(!/<img/.test(html), 'raw <img must be escaped');
  assert.ok(!/<script>/.test(html), 'raw <script must be escaped');
  assert.ok(html.includes('&lt;img'), 'the payload survives as escaped text');
  assert.ok(html.includes('&quot;src&quot;'), 'attribution quotes escaped');
});
test('pegHTML: verbatim vs styled kind, empty when no peg, drops missing lines', () => {
  const v = pegHTML({ peg: { ja: 'なんだと', romaji: 'nanda to', en: 'What?!', source: 'X', kind: 'verbatim' } });
  assert.ok(v.includes('peg--verbatim') && v.includes('「なんだと」') && v.includes('— X'));
  const s = pegHTML({ peg: { ja: 'ですわ', kind: 'styled' } });
  assert.ok(s.includes('peg--styled'));
  assert.ok(!s.includes('peg-romaji') && !s.includes('peg-src'), 'absent romaji/source lines are omitted');
  assert.equal(pegHTML({}), '');
  assert.equal(pegHTML({ peg: {} }), '');
});
test('flagBadgesHTML: renders known flags, drops unknown, empty for none', () => {
  const h = flagBadgesHTML({ flags: ['keigo-critical', 'not-a-flag', 'rude-in-life'] });
  assert.ok(h.includes('flag-chip--keigo') && h.includes('flag-chip--rude'));
  assert.ok(!h.includes('not-a-flag'));
  assert.ok(h.includes(FLAG_META['keigo-critical'].title.replace(/'/g, '&#39;')), 'instruction tooltip present');
  assert.equal(flagBadgesHTML({ flags: [] }), '');
  assert.equal(flagBadgesHTML({}), '');
});
test('matchesFlag: All passes everything; recognize-only composes yakuwarigo + rude', () => {
  assert.equal(matchesFlag({ flags: ['casual-spoken'] }, ''), true);
  assert.equal(matchesFlag({ flags: ['written-formal'] }, 'written-formal'), true);
  assert.equal(matchesFlag({ flags: ['casual-spoken'] }, 'written-formal'), false);
  assert.equal(matchesFlag({ flags: ['rude-in-life'] }, 'recognize-only'), true);
  assert.equal(matchesFlag({ flags: ['yakuwarigo-recognize-only'] }, 'recognize-only'), true);
  assert.equal(matchesFlag({ flags: [] }, 'anime-common'), false);
});

// ---- lib/trip.js (trip-mode derivations, pre-trip plan PR A) ----
import { isStay, stayBooked, stayForNight, tripWindow } from '../docs/assets/lib/trip.js';
test('trip.js: contiguous 4-stay chain — boundaries, day counts (synthetic; NOT live bookings)', () => {
  // A fixed synthetic itinerary so the test never breaks when the owner rebooks a real
  // stay (it did — the Furano booking created a legit gap night, splitting the live chain).
  const cal = [
    { title: '🏠 Stay: A', date: '2026-07-15', endDate: '2026-07-18' },
    { title: '🛏️ Stay: Furano — NOT BOOKED yet', date: '2026-07-18', endDate: '2026-07-20' },
    { title: "🏔️ Stay: K's House (BOOKED)", date: '2026-07-20', endDate: '2026-07-22' },
    { title: '🛏️ Stay: D', date: '2026-07-22', endDate: '2026-07-24' },
    { title: 'Makoto Guesthouse — initial stay', date: '2026-06-30', endDate: '2026-07-10' },   // colon-less → NOT a stay
  ];
  const w = tripWindow(cal, '2026-07-17');
  assert.ok(w); assert.equal(w.start, '2026-07-15'); assert.equal(w.end, '2026-07-24');
  assert.equal(w.day, 3); assert.equal(w.total, 10); assert.equal(w.stays.length, 4);
  assert.match(stayForNight(cal, '2026-07-18').title, /Furano/);           // half-open: night 18 → Furano [18,20)
  assert.equal(stayBooked(stayForNight(cal, '2026-07-18')), false);
  assert.match(stayForNight(cal, '2026-07-20').title, /K's House/);
  assert.equal(tripWindow(cal, '2026-07-24').day, 10);                     // last day active, no stay that night
  assert.equal(stayForNight(cal, '2026-07-24'), null);
  assert.equal(tripWindow(cal, '2026-07-10'), null);
  assert.equal(tripWindow(cal, '2026-07-25'), null);
  assert.equal(cal.filter(isStay).length, 4);                             // the colon-less "initial stay" is excluded
});

test('trip.js: a mid-trip gap night splits the chain (the real Furano-booking case)', () => {
  // Live shape after the owner booked Mutsukari Jul 19–21: Jul 18 is an uncovered gap,
  // so Jul 17 sees only the first window (ends Jul 18), not the whole trip.
  const cal = [
    { title: 'Stay: A', date: '2026-07-15', endDate: '2026-07-18' },
    { title: 'Stay: Mutsukari (BOOKED)', date: '2026-07-19', endDate: '2026-07-21' },
  ];
  assert.equal(tripWindow(cal, '2026-07-17').end, '2026-07-18');   // window 1 (Jul 15–18)
  assert.equal(tripWindow(cal, '2026-07-18').end, '2026-07-18');   // Jul 18 = window-1 checkout day (day 4/4), band still shows
  assert.equal(stayForNight(cal, '2026-07-18'), null);             // …but no bed that night — the real gap
  assert.equal(tripWindow(cal, '2026-07-20').start, '2026-07-19'); // window 2 (Jul 19–21)
});

test('trip.js: synthetic gap splits the chain; overlaps extend via max endDate', () => {
  const mk = (d, e, t = 'Stay: x') => ({ title: t, date: d, endDate: e });
  const gap = [mk('2026-08-01', '2026-08-03'), mk('2026-08-05', '2026-08-07')];   // Aug 4 = gap night
  assert.equal(tripWindow(gap, '2026-08-04'), null);
  assert.equal(tripWindow(gap, '2026-08-02').end, '2026-08-03');
  assert.equal(tripWindow(gap, '2026-08-06').start, '2026-08-05');
  const overlap = [mk('2026-08-01', '2026-08-10'), mk('2026-08-03', '2026-08-05'), mk('2026-08-10', '2026-08-12')];
  const w = tripWindow(overlap, '2026-08-11');   // chained through the LONG stay's endDate
  assert.ok(w); assert.equal(w.start, '2026-08-01'); assert.equal(w.end, '2026-08-12');
  // tie on a night covered by two stays: prefer the booked one
  const tie = [mk('2026-08-01', '2026-08-05', 'Stay: A — NOT BOOKED yet'), mk('2026-08-02', '2026-08-04', 'Stay: B (BOOKED)')];
  assert.match(stayForNight(tie, '2026-08-03').title, /B/);
});

// ── zip.js: dependency-free ZIP reader ────────────────────────────────────────
import { deflateRawSync } from 'node:zlib';
import { listZip, readZipEntry } from '../docs/assets/lib/zip.js';

// Build a ZIP in-memory (local headers + data + central directory + EOCD) to
// spec-cross-check the reader. crc32 present but not verified by the reader.
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function buildZip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = f.data;
    const method = f.method;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const hdr = Buffer.alloc(30);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(method, 8);
    hdr.writeUInt32LE(crc32(raw), 14);
    hdr.writeUInt32LE(comp.length, 18);
    hdr.writeUInt32LE(raw.length, 22);
    hdr.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([hdr, Buffer.from(name), Buffer.from(comp)]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, Buffer.from(name)]));
    locals.push(local);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const cdStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, eocd]));
}

const _mediaJson = JSON.stringify({ '0': 'front.png', '1': 'audio.mp3' });
const _patterned = new Uint8Array(5000).map((_, i) => (i * 37 + 11) & 0xff);
const _zipFixture = buildZip([
  { name: 'media', method: 0, data: new TextEncoder().encode(_mediaJson) },
  { name: 'collection.anki2', method: 8, data: _patterned },
  { name: 'empty', method: 0, data: new Uint8Array(0) },
]);

test('zip.js: listZip finds all entries with right sizes/methods', () => {
  const list = listZip(_zipFixture);
  assert.equal(list.length, 3);
  const media = list.find(e => e.name === 'media');
  const coll = list.find(e => e.name === 'collection.anki2');
  const empty = list.find(e => e.name === 'empty');
  assert.equal(media.method, 0);
  assert.equal(media.size, new TextEncoder().encode(_mediaJson).length);
  assert.equal(coll.method, 8);
  assert.equal(coll.size, 5000);
  assert.ok(coll.csize < 5000);           // deflate actually shrank it
  assert.equal(empty.size, 0);
});

test('zip.js: readZipEntry round-trips stored, deflated, and empty entries', async () => {
  const list = listZip(_zipFixture);
  const media = await readZipEntry(_zipFixture, list.find(e => e.name === 'media'));
  assert.equal(new TextDecoder().decode(media), _mediaJson);
  const coll = await readZipEntry(_zipFixture, list.find(e => e.name === 'collection.anki2'));
  assert.deepEqual(coll, _patterned);
  const empty = await readZipEntry(_zipFixture, list.find(e => e.name === 'empty'));
  assert.equal(empty.length, 0);
});

test('zip.js: garbage / truncated buffers throw', () => {
  assert.throws(() => listZip(new Uint8Array(10)), /too small/);
  assert.throws(() => listZip(new Uint8Array(64)), /no EOCD/);
  const truncated = _zipFixture.subarray(0, _zipFixture.length - 4);   // chop the EOCD
  assert.throws(() => listZip(truncated), /no EOCD/);
});

// ---- lib/ankimedia.js (apkg media manifest + field refs, PURE half) ----
import { parseMediaManifest, soundRef, imgRef, mediaRefs, notesToRawCards } from '../docs/assets/lib/ankimedia.js';
test('ankimedia: parseMediaManifest inverts {entry→name} to name→entry, skips weird keys', () => {
  const json = JSON.stringify({ '0': '食べ物 audio.mp3', '1': 'ねこ.jpg', 'x': 'skip.me', '2': '' });
  const map = parseMediaManifest(new TextEncoder().encode(json));
  assert.equal(map.get('食べ物 audio.mp3'), '0');
  assert.equal(map.get('ねこ.jpg'), '1');
  assert.equal(map.has('skip.me'), false);   // non-numeric key skipped
  assert.equal(map.has(''), false);          // empty name skipped
  assert.equal(map.size, 2);
  // accepts a plain string too
  assert.equal(parseMediaManifest('{"5":"a.mp3"}').get('a.mp3'), '5');
});
test('ankimedia: parseMediaManifest rejects a non-object / bad JSON', () => {
  assert.throws(() => parseMediaManifest('[1,2,3]'), /not an object/);
  assert.throws(() => parseMediaManifest('"just a string"'), /not an object/);
  assert.throws(() => parseMediaManifest('not json'), /not valid JSON/);
});
test('ankimedia: soundRef first [sound:] wins, unicode + spaces preserved raw', () => {
  assert.equal(soundRef('食べ物です[sound:食べ物 audio.mp3] more'), '食べ物 audio.mp3');
  assert.equal(soundRef('[sound:a.mp3] mid [sound:b.mp3]'), 'a.mp3');   // first wins
  assert.equal(soundRef('no audio here'), null);
  assert.equal(soundRef(null), null);
});
test('ankimedia: imgRef handles double/single/unquoted src and <IMG> uppercase', () => {
  assert.equal(imgRef('<img src="pic one.png">'), 'pic one.png');
  assert.equal(imgRef("<img alt='x' src='ねこ.jpg' width=20>"), 'ねこ.jpg');
  assert.equal(imgRef('<img src=bare.gif >'), 'bare.gif');
  assert.equal(imgRef('<IMG SRC="UP.PNG">'), 'UP.PNG');
  assert.equal(imgRef('plain text &amp; no img'), null);
});
test('ankimedia: notesToRawCards splits on \\x1f, preserves empty trailing fields', () => {
  assert.deepEqual(notesToRawCards(['a\x1fb\x1f']), [['a', 'b', '']]);
  assert.deepEqual(notesToRawCards(['x\x1fy\x1fz']), [['x', 'y', 'z']]);
  assert.deepEqual(notesToRawCards(['solo']), [['solo']]);
  assert.deepEqual(notesToRawCards([]), []);
});
test('ankimedia: mediaRefs dedupes across audio + image', () => {
  const cards = [
    { a: '[sound:a.mp3]', img: '<img src="p.png">' },
    { a: '[sound:a.mp3]', img: '<img src="q.jpg">' },   // dup audio
    { a: 'no ref', img: 'no img' },
    null,
  ];
  const refs = mediaRefs(cards);
  assert.deepEqual([...refs].sort(), ['a.mp3', 'p.png', 'q.jpg']);
});

// ---- lib/sqlite.js (dependency-free read-only SQLite reader for Anki .apkg) ----
import { openSqlite, sqliteTables, sqliteRows } from '../docs/assets/lib/sqlite.js';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Build a fixture .sqlite via the system sqlite3 CLI (fallback: python3 sqlite3 module).
function buildSqliteFixture() {
  const big = 'あ'.repeat(8000) + 'X'.repeat(5000);            // >12000 chars → forces overflow chain
  assert.ok(big.length > 12000);
  const jp = ['表面日本語', '裏面ドリル'].join('\x1f');          // unicode + \x1f field separator
  const dbPath = join(tmpdir(), `jwh-sqlite-fixture-${process.pid}.sqlite`);
  const sqlPath = join(tmpdir(), `jwh-sqlite-fixture-${process.pid}.sql`);
  // assemble SQL; sqlite3 CLI reads it on stdin
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    let flds, tags = "'tag1 tag2'", sfld = "'sfld" + i + "'";
    if (i === 1) flds = "'" + big.replace(/'/g, "''") + "'";           // overflow row
    else if (i === 2) { flds = "'" + jp + "'"; tags = 'NULL'; }        // unicode + NULL tags
    else if (i === 3) flds = "'neg'";
    else flds = "'front" + i + "\x1fback" + i + "'";
    const mid = i === 3 ? -2147483648 : 1000 + i;                       // negative int
    const csum = i === 4 ? 9007199254740000 : 100 + i;                  // large int
    rows.push(`INSERT INTO notes VALUES(${i},'guid${i}',${mid},1600000000,0,${tags},${flds},${sfld},${csum},0,'');`);
  }
  const sql = [
    'PRAGMA journal_mode=DELETE;',
    'CREATE TABLE notes(id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT);',
    'CREATE TABLE col(id INTEGER PRIMARY KEY, crt INTEGER, mod INTEGER, scm INTEGER, ver INTEGER, dty INTEGER, usn INTEGER, ls INTEGER, conf TEXT, models TEXT, decks TEXT, dconf TEXT, tags TEXT);',
    "INSERT INTO col VALUES(1,1600000000,1600000000,0,11,0,0,0,'{}','{}','{}','{}','{}');",
    'CREATE TABLE metrics(id INTEGER PRIMARY KEY, ratio REAL, label TEXT);',
    "INSERT INTO metrics VALUES(1,3.14159,'pi');",
    "INSERT INTO metrics VALUES(2,-2.5,'neg');",
    ...rows,
  ].join('\n');
  try {
    writeFileSync(sqlPath, sql);
    execSync(`sqlite3 ${JSON.stringify(dbPath)} < ${JSON.stringify(sqlPath)}`, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    // fallback: python3 sqlite3
    const py = `import sqlite3,sys\ncon=sqlite3.connect(sys.argv[1])\ncon.executescript(open(sys.argv[2]).read())\ncon.commit();con.close()`;
    execSync(`python3 -c ${JSON.stringify(py)} ${JSON.stringify(dbPath)} ${JSON.stringify(sqlPath)}`);
  }
  const bytes = new Uint8Array(readFileSync(dbPath));
  try { unlinkSync(dbPath); unlinkSync(sqlPath); } catch { /* ignore */ }
  return { bytes, big, jp };
}

const _sqliteFx = buildSqliteFixture();

test('sqlite: bad magic throws', () => {
  assert.throws(() => openSqlite(new Uint8Array(200)), /not a sqlite file/);
  assert.throws(() => openSqlite(new Uint8Array([1, 2, 3])), /not a sqlite file/);
});

test('sqlite: sqliteTables finds notes, col, metrics with sql + rootpage', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const tables = sqliteTables(db);
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['col', 'metrics', 'notes']);
  const notes = tables.find((t) => t.name === 'notes');
  assert.ok(notes.rootpage >= 2);
  assert.match(notes.sql, /INTEGER PRIMARY KEY/);
});

test('sqlite: sqliteRows returns 60 notes with rowid-alias ids', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'notes');
  assert.equal(rows.length, 60);
  // id column (index 0) is INTEGER PRIMARY KEY → stored NULL, comes back via rowid
  const ids = rows.map((r) => r[0]).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 60 }, (_, i) => i + 1));
});

test('sqlite: overflow row round-trips exactly (length + content)', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'notes');
  const row1 = rows.find((r) => r[0] === 1);
  const flds = row1[6]; // flds column index
  assert.equal(flds.length, _sqliteFx.big.length);
  assert.equal(flds, _sqliteFx.big);
});

test('sqlite: unicode + \\x1f separators + NULL tags intact', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'notes');
  const row2 = rows.find((r) => r[0] === 2);
  assert.equal(row2[6], _sqliteFx.jp);
  assert.ok(row2[6].includes('\x1f'));
  assert.equal(row2[5], null); // tags NULL
  const row4 = rows.find((r) => r[0] === 4);
  assert.match(row4[6], /front4\x1fback4/);
});

test('sqlite: negative + large ints', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'notes');
  const row3 = rows.find((r) => r[0] === 3);
  assert.equal(row3[2], -2147483648);        // mid negative
  const row4 = rows.find((r) => r[0] === 4);
  assert.equal(row4[8], 9007199254740000);   // csum large
});

test('sqlite: float table (REAL serial type 7)', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'metrics');
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0][1] - 3.14159) < 1e-9);
  assert.ok(Math.abs(rows[1][1] - -2.5) < 1e-9);
  assert.equal(rows[0][2], 'pi');
});

test('sqlite: col table reads (single row)', () => {
  const db = openSqlite(_sqliteFx.bytes);
  const rows = sqliteRows(db, 'col');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 1);   // rowid alias
  assert.equal(rows[0][4], 11);  // ver
});

// ---- .apkg hostile-input hardening (review round: 2 blockers + majors) ----
test('zip: false EOCD signature inside a comment does not empty the archive', () => {
  // build a minimal 1-entry stored zip, then append a comment CONTAINING PK\x05\x06
  const name = 'x', data = new Uint8Array([65, 66, 67]);
  const le16 = n => [n & 255, (n >> 8) & 255];
  const le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const local = [0x50,0x4b,0x03,0x04, ...le16(20),...le16(0),...le16(0),...le16(0),...le16(0), ...le32(0),...le32(data.length),...le32(data.length), ...le16(name.length),...le16(0), ...[...name].map(c=>c.charCodeAt(0)), ...data];
  const cdOff = local.length;
  const cd = [0x50,0x4b,0x01,0x02, ...le16(20),...le16(20),...le16(0),...le16(0),...le16(0),...le16(0), ...le32(0),...le32(data.length),...le32(data.length), ...le16(name.length),...le16(0),...le16(0),...le16(0),...le16(0), ...le32(0),...le32(0), ...[...name].map(c=>c.charCodeAt(0))];
  const comment = [0x50,0x4b,0x05,0x06, 1,2,3,4];   // the fake-EOCD bytes live in the comment
  const eocd = [0x50,0x4b,0x05,0x06, ...le16(0),...le16(0),...le16(1),...le16(1), ...le32(cd.length),...le32(cdOff), ...le16(comment.length)];
  const buf = new Uint8Array([...local, ...cd, ...eocd, ...comment]);
  const entries = listZip(buf);
  assert.equal(entries.length, 1);            // the real EOCD wins; the comment's fake one is skipped
  assert.equal(entries[0].name, 'x');
});

import { readFileSync as _rf } from 'node:fs';
test('sqlite: 8-byte negative integer decodes correctly (not 0)', async () => {
  // craft a 1-row table with a type-6 (8-byte) value of -1 via the CLI, read it back
  const { execSync } = await import('node:child_process');
  const os = await import('node:os'); const path = await import('node:path');
  const f = path.join(os.tmpdir(), 'jwh-neg-' + Date.now() + '.db');
  try {
    execSync(`sqlite3 "${f}" "CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO t VALUES(1, -1); INSERT INTO t VALUES(2, -9223372036854775808);"`);
    const db = openSqlite(new Uint8Array(_rf(f)));
    const rows = sqliteRows(db, 't');
    assert.equal(rows.find(r => r[0] === 1)[1], -1);   // was decoding to 0 before the BigInt fix
  } finally { try { (await import('node:fs')).unlinkSync(f); } catch {} }
});

test('sqlite: corrupt payload length is rejected, not OOM-allocated', () => {
  // a buffer with valid header but a leaf cell claiming a giant payload → throw, not hang/OOM
  const buf = new Uint8Array(4096);
  const magic = 'SQLite format 3\0';
  for (let i = 0; i < magic.length; i++) buf[i] = magic.charCodeAt(i);
  buf[16] = 0x10; buf[17] = 0x00;    // page size 4096
  buf[56] = 0; buf[57] = 0; buf[58] = 0; buf[59] = 1;   // UTF-8
  buf[18] = 1; buf[19] = 1;          // legacy format
  buf[100] = 0x0d; buf[103] = 0; buf[104] = 1;          // leaf table, 1 cell
  buf[108] = 0x0f; buf[109] = 0xf0;  // cell pointer → 0x0ff0
  // at 0x0ff0: a 9-byte varint payload length of ~2^56, then rowid
  let o = 0x0ff0; for (let i = 0; i < 8; i++) buf[o++] = 0xff; buf[o++] = 0x7f; buf[o++] = 0x01;
  const db = openSqlite(buf);
  assert.throws(() => sqliteRows(db, 't'), /payload|range|corrupt/i);   // must throw, must not allocate 2^56 bytes
});

import { TRIP_DAYPLANS } from '../docs/assets/lib/tripseed.js';
import { normalizePlan } from '../docs/assets/lib/dayplan.js';
test('tripseed: every baked day is a well-formed, normalizer-safe plan with unique stop ids', () => {
  const dates = Object.keys(TRIP_DAYPLANS);
  assert.ok(dates.length >= 14, 'expected the full Jul 13–26 arc');
  const allIds = [];
  for (const [date, day] of Object.entries(TRIP_DAYPLANS)) {
    assert.equal(day.date, date, `date key must match day.date for ${date}`);
    const norm = normalizePlan(date, day);                 // must survive the app's own normalizer
    assert.equal(norm.stops.length, day.stops.length, `no stops dropped for ${date}`);
    assert.ok(day.stops.length > 0, `${date} has stops`);
    for (const s of day.stops) {
      assert.ok(s.id && s.name, `${date} stop needs id + name`);
      assert.equal(typeof s.durationMin, 'number', `${date} ${s.id} durationMin is a number`);
      assert.match(s.startTime, /^([01]\d|2[0-3]):[0-5]\d$/, `${date} ${s.id} startTime is HH:MM`);
      allIds.push(s.id);
    }
  }
  assert.equal(new Set(allIds).size, allIds.length, 'stop ids are globally unique');
});

import { CAL_PALETTE, normalizeCalendars, addCalendar, updateCalendar, removeCalendar, nextColor } from '../docs/assets/lib/calendars.js';
test('calendars: add/update/remove with validation', () => {
  let list = [];
  list = addCalendar(list, { name: '  Work  ', color: CAL_PALETTE[1] }, 'cal-1');
  assert.deepEqual(list, [{ id: 'cal-1', name: 'Work', color: CAL_PALETTE[1] }]);   // trimmed
  list = addCalendar(list, { name: '', color: CAL_PALETTE[2] }, 'cal-2');            // blank name → no-op
  assert.equal(list.length, 1);
  list = addCalendar(list, { name: 'Dup', color: CAL_PALETTE[2] }, 'cal-1');         // dup id → no-op
  assert.equal(list.length, 1);
  list = addCalendar(list, { name: 'Anniv', color: 'not-a-color' }, 'cal-3');        // bad color → palette[0]
  assert.equal(list.find(c => c.id === 'cal-3').color, CAL_PALETTE[0]);
  list = updateCalendar(list, 'cal-1', { name: 'Job', color: CAL_PALETTE[4] });
  assert.deepEqual(list.find(c => c.id === 'cal-1'), { id: 'cal-1', name: 'Job', color: CAL_PALETTE[4] });
  list = updateCalendar(list, 'cal-1', { name: '   ' });                             // blank rename ignored
  assert.equal(list.find(c => c.id === 'cal-1').name, 'Job');
  list = removeCalendar(list, 'cal-3');
  assert.deepEqual(list.map(c => c.id), ['cal-1']);
});
test('calendars: normalize drops malformed + dedupes; nextColor avoids used', () => {
  const norm = normalizeCalendars([{ id: 'a', name: 'A', color: CAL_PALETTE[0] }, { id: '', name: 'x' }, { id: 'a', name: 'dup' }, null, { name: 'noid' }]);
  assert.deepEqual(norm.map(c => c.id), ['a']);
  assert.equal(normalizeCalendars('nonsense').length, 0);
  assert.equal(normalizeCalendars([{ id: 'x{}body', name: 'Evil', color: CAL_PALETTE[0] }]).length, 0);   // unsafe id charset rejected
  assert.equal(nextColor([{ id: 'a', name: 'A', color: CAL_PALETTE[0] }]), CAL_PALETTE[1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// study.js — R1 SRS engine (FSRS-lite scheduler, stage ladder + gate, queue builder)
// ─────────────────────────────────────────────────────────────────────────────
import {
  STAGES, stageOf, retrievability, nextInterval, effectiveGrade, gateMode,
  newState, migrate, review, undoReview, buildQueue, interleave, deferCard, amnesty,
  seedImport, hash, sessionStart, sessionRecord, sessionEnd,
  lessonOrder, unitProgress, testOutResult,
  checkpointQuestions, recordCheckpoint, checkpointPassed, nextCheckpointUnit,
  leechList, ghostCount, unsuspend,
  recordSession, streakInfo, weeklyInfo, masteryStats, LEVEL_TOTALS,
  courseRollup, isMasterComplete, estimatedRetention, mockTrend, clusterWeakness,
  mockClustersFromLog, masteryLagDays, paceProjection, repaceNewPerDay, certStats, CORPUS_TOTAL,
} from '../docs/assets/lib/study.js';

const DAY = 86400000, MIN = 60000;
const T0 = Date.UTC(2026, 7, 1);   // Aug 1 2026 epoch for the sims

test('study: retrievability — next interval ≈ S at retention 0.90', () => {
  for (const S of [1, 3, 7, 21, 60]) {
    assert.ok(Math.abs(nextInterval(S) - S) < 1e-9, `nextInterval(${S})≈${S}`);
    // seen exactly on schedule (t=S) → recall ≈ 0.90
    assert.ok(Math.abs(retrievability(S, S) - 0.90) < 1e-9);
  }
  assert.ok(retrievability(0, 7) === 1);            // just reviewed → full recall
  assert.ok(retrievability(100, 7) < 0.5);          // long overdue → low recall
});

test('study: first-rating S0/D0 table', () => {
  const cases = [[1, 0.4, 8], [2, 0.6, 6.5], [3, 2.4, 5], [4, 5.8, 3.5]];
  for (const [g, s0, d0] of cases) {
    const st = review(newState(T0), 'x', { pass: g > 1, grade: g }, T0);
    assert.equal(st.points.x.S, s0, `S0 for g=${g}`);
    assert.equal(st.points.x.D, d0, `D0 for g=${g}`);
  }
});

test('study: success grows S monotonically; Hard < Good < Easy', () => {
  const base = review(newState(T0), 'p', { pass: true, grade: 3 }, T0);  // Seed S=2.4
  const at = base.points.p.due;                                          // review on schedule
  const S0 = base.points.p.S;
  const hard = review(base, 'p', { pass: true, grade: 2 }, at).points.p.S;
  const good = review(base, 'p', { pass: true, grade: 3 }, at).points.p.S;
  const easy = review(base, 'p', { pass: true, grade: 4 }, at).points.p.S;
  assert.ok(hard > S0 && good > hard && easy > good, `growth ${S0}→${hard}/${good}/${easy}`);
});

test('study: fail penalises S, sets 10-min relearn, bumps lapses', () => {
  let st = review(newState(T0), 'p', { pass: true, grade: 4 }, T0);      // S=5.8
  const before = st.points.p.S;
  st = review(st, 'p', { pass: false, grade: 1 }, st.points.p.due);
  assert.ok(st.points.p.S < before && st.points.p.S >= 0.3);
  assert.equal(st.points.p.lapses, 1);
  assert.ok(st.points.p.due - st.points.p.last === 10 * MIN, 'relearn +10min');
});

test('study: stage thresholds; mastered only via gate', () => {
  assert.deepEqual(STAGES, ['seed', 'sprout', 'young', 'mature', 'deep', 'mastered']);
  const mk = (S, reps = 3, gate = null) => stageOf({ S, reps, gate });
  assert.equal(mk(0.5), 'seed');
  assert.equal(stageOf({ S: 9, reps: 0 }), 'seed');   // reps 0 → seed regardless of S
  assert.equal(mk(2), 'sprout');
  assert.equal(mk(5), 'young');
  assert.equal(mk(15), 'mature');
  assert.equal(mk(30), 'deep');
  assert.equal(mk(999), 'deep');                       // high S alone is NOT mastered
  assert.equal(stageOf({ S: 30, reps: 3, gate: { passed: true } }), 'mastered');
});

test('study: effectiveGrade full matrix', () => {
  assert.equal(effectiveGrade({ typedCorrect: false, chosen: 4 }), 1);          // typed wrong beats Easy
  assert.equal(effectiveGrade({ closeAccepted: true, chosen: 4 }), 2);          // close caps Hard
  assert.equal(effectiveGrade({ hintTier: 'gloss', chosen: 4 }), 3);            // gloss caps Good
  assert.equal(effectiveGrade({ hintTier: 'structure', chosen: 4 }), 3);        // structure caps Good
  assert.equal(effectiveGrade({ hintTier: 'kana', chosen: 4 }), 2);             // kana caps Hard
  assert.equal(effectiveGrade({ hintTier: 'reveal', chosen: 4 }), 1);           // reveal → Again
  assert.equal(effectiveGrade({ chosen: 3 }), 3);                               // clean chosen
  assert.equal(effectiveGrade({ chosen: 4 }), 4);
  assert.equal(effectiveGrade({ typedCorrect: true, chosen: 2 }), 2);
});

test('study: gateMode keys on register (N1 / written-formal), not just level', () => {
  assert.equal(gateMode({}, { level: 'N1', flags: [] }), 'recognition');
  assert.equal(gateMode({}, { level: 'N4', flags: ['written-formal'] }), 'recognition');
  assert.equal(gateMode({}, { level: 'N4', flags: ['casual-spoken'] }), 'production');
  assert.equal(gateMode({}, { level: 'N4', flags: [] }), 'production');
});

// helper: force a point straight to Deep for gate tests
function deepPoint(now) {
  const p = { D: 5, S: 30, last: now - 30 * DAY, reps: 5, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: now };
  return { ...newState(now), points: { g: { ...p, stage: 'deep' } } };
}

test('study: gate happy path — 3 distinct example indices → Mastered', () => {
  let st = deepPoint(T0);
  st = review(st, 'g', { pass: true, grade: 3, exampleIdx: 0, mode: 'gate' }, st.points.g.due);
  assert.deepEqual(st.points.g.gate.passes, [0]);
  assert.notEqual(st.points.g.stage, 'mastered');
  st = review(st, 'g', { pass: true, grade: 3, exampleIdx: 1, mode: 'gate' }, st.points.g.due);
  st = review(st, 'g', { pass: true, grade: 3, exampleIdx: 2, mode: 'gate' }, st.points.g.due);
  assert.equal(st.points.g.stage, 'mastered');
  assert.equal(st.points.g.gate.passed, true);
});

test('study: gate — distinct-example requirement (repeat idx does not count twice)', () => {
  let st = deepPoint(T0);
  st = review(st, 'g', { pass: true, grade: 3, exampleIdx: 0, mode: 'gate' }, st.points.g.due);
  st = review(st, 'g', { pass: true, grade: 3, exampleIdx: 0, mode: 'gate' }, st.points.g.due);  // same idx
  assert.deepEqual(st.points.g.gate.passes, [0]);
  assert.notEqual(st.points.g.stage, 'mastered');
});

test('study: gate fail resets passes AND demotes below Deep', () => {
  // freshly-Deep point (S≈24) carrying 2 accumulated gate passes → a fail must wipe both and
  // drop it out of Deep (S·0.5 ≈ 12) so it has to re-climb before re-gating.
  let st = deepPoint(T0);
  st = { ...st, points: { g: { ...st.points.g, S: 24, gate: { passes: [0, 1] } } } };
  st = review(st, 'g', { pass: false, grade: 1, exampleIdx: 2, mode: 'gate' }, st.points.g.due);
  assert.deepEqual(st.points.g.gate.passes, []);              // reset
  assert.notEqual(stageOf(st.points.g), 'deep');             // demoted below Deep
  assert.ok(st.points.g.S < 21);
});

// R10 integration: the gate goes live on real reviews. Drive a fresh point up the ladder with
// on-schedule passes until it reaches Deep, THEN run its scheduled reviews in gate mode — the
// end-to-end path R10 wires up (the mechanics are unit-tested above; this asserts the whole climb).
test('study: R10 gate end-to-end — reviews reach Deep, then 3 distinct passes → Mastered', () => {
  let st = review(newState(T0), 'e', { pass: true, grade: 4 }, T0);
  let guard = 0;
  while (stageOf(st.points.e) !== 'deep' && guard++ < 60) {
    st = review(st, 'e', { pass: true, grade: 4, exampleIdx: 0, mode: 'review' }, st.points.e.due);
  }
  assert.equal(stageOf(st.points.e), 'deep', 'on-schedule passes climb organically to Deep');
  assert.ok(!st.points.e.gate || !st.points.e.gate.passed, 'not yet mastered at Deep');
  // now Deep → scheduled reviews are gate-mode; 3 passes on DISTINCT examples complete the gate
  st = review(st, 'e', { pass: true, grade: 3, exampleIdx: 0, mode: 'gate' }, st.points.e.due);
  assert.deepEqual(st.points.e.gate.passes, [0]);
  st = review(st, 'e', { pass: true, grade: 3, exampleIdx: 0, mode: 'gate' }, st.points.e.due);  // REPEAT idx
  assert.deepEqual(st.points.e.gate.passes, [0], 'a repeated example index does not advance the count');
  assert.notEqual(stageOf(st.points.e), 'mastered');
  st = review(st, 'e', { pass: true, grade: 3, exampleIdx: 1, mode: 'gate' }, st.points.e.due);
  st = review(st, 'e', { pass: true, grade: 3, exampleIdx: 2, mode: 'gate' }, st.points.e.due);
  assert.equal(stageOf(st.points.e), 'mastered');
  assert.equal(st.points.e.gate.passed, true);
});

// A failed gate check halves S and demotes a FRESHLY-Deep point below Deep (S≈22 → ≈11). (The
// accumulated-passes reset — a fail wiping [0,1] — is the synthetic unit test above; here we assert
// the halving+demotion on the organic climb, which only holds while S is close to the Deep floor:
// after several real gate passes S grows well past 42, so halving no longer demotes, by design.)
test('study: R10 gate end-to-end — a fail at fresh Deep halves S and demotes below Deep', () => {
  let st = review(newState(T0), 'f', { pass: true, grade: 4 }, T0);
  let guard = 0;
  while (stageOf(st.points.f) !== 'deep' && guard++ < 60) {
    st = review(st, 'f', { pass: true, grade: 4, exampleIdx: 0, mode: 'review' }, st.points.f.due);
  }
  assert.equal(stageOf(st.points.f), 'deep');
  const sBefore = st.points.f.S;
  assert.ok(sBefore < 42, 'freshly Deep — S below twice the Deep floor');
  st = review(st, 'f', { pass: false, grade: 1, exampleIdx: 0, mode: 'gate' }, st.points.f.due);
  assert.deepEqual(st.points.f.gate.passes, [], 'fail leaves no banked passes');
  assert.ok(st.points.f.S <= sBefore * 0.5 + 1e-9, 'fail at least halves S');
  assert.notEqual(stageOf(st.points.f), 'deep', 'demoted below Deep — must re-climb before re-gating');
  assert.notEqual(stageOf(st.points.f), 'mastered');
});

test('study: ghost ladder — 2 consecutive passes exit, S ≥ 3', () => {
  let st = seedImport(newState(T0), { shaky: ['s'] }, T0);
  assert.ok(st.points.s.ghost);
  st = review(st, 's', { pass: true, grade: 3 }, st.points.s.due);       // pass 1
  assert.ok(st.points.s.ghost && st.points.s.ghost.streak === 1);
  st = review(st, 's', { pass: false, grade: 1 }, st.points.s.due);      // relapse → streak resets
  assert.equal(st.points.s.ghost.streak, 0);
  st = review(st, 's', { pass: true, grade: 3 }, st.points.s.due);       // pass 1
  st = review(st, 's', { pass: true, grade: 3 }, st.points.s.due);       // pass 2 → exit
  assert.equal(st.points.s.ghost, null);
  assert.ok(st.points.s.S >= 3);
});

test('study: leech at 5 lapses, suspend at 8, suspended excluded from queue', () => {
  let st = review(newState(T0), 'L', { pass: true, grade: 4 }, T0);
  for (let i = 0; i < 4; i++) st = review(st, 'L', { pass: false, grade: 1 }, st.points.L.due + DAY);
  assert.equal(st.points.L.lapses, 4);
  assert.ok(!st.points.L.leech);
  st = review(st, 'L', { pass: false, grade: 1 }, st.points.L.due + DAY);
  assert.equal(st.points.L.leech, true);                                  // 5th lapse → leech
  for (let i = 0; i < 3; i++) st = review(st, 'L', { pass: false, grade: 1 }, st.points.L.due + DAY);
  assert.equal(st.points.L.lapses, 8);
  assert.equal(st.points.L.suspended, true);                              // 8th → suspend
  const q = buildQueue(st, st.points.L.due + 10 * DAY);
  assert.ok(!q.reviews.includes('L'), 'suspended point never queued');
});

// ── R9 struggle-UX selectors ─────────────────────────────────────────────────
test('study: leechList — leeches only, sorted by lapses desc, suspended flagged', () => {
  const st = { ...newState(T0), points: {
    a: { leech: true, suspended: false, lapses: 5 },
    b: { leech: true, suspended: true, lapses: 8 },
    c: { leech: false, lapses: 2 },                 // not a leech → excluded
    d: { leech: true, suspended: false, lapses: 6 },
  } };
  const list = leechList(st);
  assert.deepEqual(list.map(l => l.id), ['b', 'd', 'a']);   // 8, 6, 5 lapses
  assert.equal(list.length, 3);
  assert.equal(list.find(l => l.id === 'b').suspended, true);
  assert.equal(list.find(l => l.id === 'a').suspended, false);
  assert.deepEqual(leechList(newState(T0)), []);            // empty state → no leeches
});

test('study: ghostCount — counts points currently haunting', () => {
  const st = { ...newState(T0), points: {
    a: { ghost: { step: 0, streak: 0 } },
    b: { ghost: null },
    c: { ghost: { step: 1, streak: 1 } },
  } };
  assert.equal(ghostCount(st), 2);
  assert.equal(ghostCount(newState(T0)), 0);
});

test('study: unsuspend — clears suspended, keeps leech, due now, immutable, re-queues', () => {
  const st = { ...newState(T0), points: { L: { leech: true, suspended: true, lapses: 8, S: 0.5, last: T0 - DAY, due: T0 - DAY } } };
  const ns = unsuspend(st, 'L', T0);
  assert.equal(ns.points.L.suspended, false);
  assert.equal(ns.points.L.leech, true);            // still a leech, but with a real second chance
  assert.equal(ns.points.L.lapses, 7);              // dropped just below SUSPEND_AT (8)
  assert.equal(ns.points.L.due, T0);
  assert.equal(st.points.L.suspended, true);        // input untouched (immutable)
  assert.equal(st.points.L.lapses, 8);              // input untouched
  assert.ok(!buildQueue(st, T0).reviews.includes('L'), 'suspended → excluded');
  assert.ok(buildQueue(ns, T0).reviews.includes('L'), 'unsuspended + due now → queued');
  // a PASS after unsuspend must NOT re-suspend (the bug R9 review caught)
  const afterPass = review(ns, 'L', { pass: true, grade: 3, mode: 'review' }, T0);
  assert.equal(afterPass.points.L.suspended, false, 'a correct answer keeps the point in play');
  // but a FAIL does re-suspend (lapses back to 8)
  const afterFail = review(ns, 'L', { pass: false, grade: 1, mode: 'review' }, T0);
  assert.equal(afterFail.points.L.suspended, true, 'a fresh fail re-suspends');
  assert.equal(unsuspend(st, 'nope', T0), st);      // unknown id → same state
});

test('study: queue cap + deferral bound (force-entry on the 3rd)', () => {
  // 50 due cards, all fresh → 45 reviewed, 5 deferred
  let st = newState(T0);
  const pts = {};
  for (let i = 0; i < 50; i++) pts['c' + i] = { D: 5, S: 5, last: T0 - 5 * DAY, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 - i * 1000, stage: 'young' };
  st = { ...st, points: pts };
  let q = buildQueue(st, T0);
  assert.equal(q.reviews.length, 45);
  assert.equal(q.deferred.length, 5);
  // a card at defers=2 force-enters even over cap
  st = { ...st, points: { ...st.points, c49: { ...st.points.c49, defers: 2 } } };
  q = buildQueue(st, T0);
  assert.ok(q.reviews.includes('c49'), 'defers≥2 forces over-cap entry');
  assert.equal(q.reviews.length, 46);
});

test('study: deferral never exceeds 2 across days (force-entry on day 3)', () => {
  // A persistent backlog of 50 cards, all perpetually overdue (we only defer — never review —
  // so the overflow tail keeps re-presenting). The 5 highest-retrievability cards land in the
  // overflow tail every day: deferred day 1 (→1), day 2 (→2), then FORCED over cap on day 3.
  let st = newState(T0);
  const pts = {};
  for (let i = 0; i < 50; i++) pts['c' + i] = { D: 5, S: 5, last: T0 - 5 * DAY, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 - (50 - i) * 1000, stage: 'young' };
  st = { ...st, points: pts };
  const tail = ['c45', 'c46', 'c47', 'c48', 'c49'];   // newest-due → highest R → overflow tail
  let maxDefers = 0, forcedDay = -1;
  for (let d = 0; d < 3; d++) {
    const now = T0 + d * DAY;
    const q = buildQueue(st, now);
    if (tail.every(id => q.reviews.includes(id)) && d === 2) forcedDay = d;   // all forced in on day 3
    for (const id of q.deferred) st = deferCard(st, id, now);
    for (const id of Object.keys(st.points)) maxDefers = Math.max(maxDefers, st.points[id].defers || 0);
  }
  assert.ok(maxDefers <= 2, `max defers ${maxDefers} ≤ 2`);
  assert.equal(forcedDay, 2, 'twice-deferred cards force-enter over cap on the 3rd day');
});

test('study: drip throttle — lessons 0 when due > 0.8·cap', () => {
  const mkDue = (n) => {
    const pts = {};
    for (let i = 0; i < n; i++) pts['c' + i] = { D: 5, S: 5, last: T0 - 5 * DAY, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 - i * 1000, stage: 'young' };
    return { ...newState(T0), points: pts };
  };
  assert.equal(buildQueue(mkDue(36), T0).lessons, 4);   // exactly 0.8·45 → not throttled
  assert.equal(buildQueue(mkDue(37), T0).lessons, 0);   // over → throttled to 0
  assert.equal(buildQueue(mkDue(0), T0).lessons, 4);
});

test('study: lapse amnesty re-spreads backlog over 7 days after a gap', () => {
  let st = newState(T0);
  const pts = {};
  for (let i = 0; i < 100; i++) pts['c' + i] = { D: 5, S: 3, last: T0 - 10 * DAY, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 - (5 * DAY) - i * 1000, stage: 'young' };
  st = { ...st, points: pts, lastSession: T0 - 5 * DAY };   // 5-day gap
  const now = T0;
  const after = amnesty(st, now);
  const dueToday = Object.values(after.points).filter(p => p.due <= now).length;
  assert.equal(dueToday, 45, 'keeps only cap today');
  for (const p of Object.values(after.points)) {
    if (p.due > now) assert.ok(p.due <= now + 7 * DAY, 'backlog spread within 7 days');
  }
  // no gap → no-op (returns the same object reference untouched)
  const noGap = { ...st, lastSession: now - DAY };
  assert.equal(amnesty(noGap, now), noGap);
});

test('study: interleave — no two identical entries adjacent', () => {
  const out = interleave(['a', 'a', 'a', 'b', 'b', 'c']);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i], out[i - 1]);
  assert.equal(out.length, 6);
  const unique = ['x', 'y', 'z'];
  assert.deepEqual(interleave(unique), unique);    // unique list untouched (order preserved)
});

test('study: coSchedule pulls related ids due within 2 days into today', () => {
  let st = newState(T0);
  st = { ...st, points: {
    a: { D: 5, S: 5, last: T0 - 5 * DAY, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 - 1000, stage: 'young' },
    b: { D: 5, S: 5, last: T0, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 + DAY, stage: 'young' },        // due tomorrow
    c: { D: 5, S: 5, last: T0, reps: 2, lapses: 0, ghost: null, gate: null, leech: false, suspended: false, defers: 0, due: T0 + 5 * DAY, stage: 'young' },    // due in 5d — too far
  } };
  const q = buildQueue(st, T0, { coSchedule: { a: ['b', 'c'] } });
  assert.ok(q.reviews.includes('a') && q.reviews.includes('b'));
  assert.ok(!q.reviews.includes('c'), 'related card >2 days out is not pulled in');
});

test('study: seedImport — deterministic stagger + ghost import', () => {
  const st1 = seedImport(newState(T0), { done: ['d1', 'd2', 'd3'], shaky: ['s1'] }, T0);
  const st2 = seedImport(newState(T0), { done: ['d1', 'd2', 'd3'], shaky: ['s1'] }, T0);
  assert.deepEqual(st1.points, st2.points);                            // deterministic
  for (const id of ['d1', 'd2', 'd3']) {
    const p = st1.points[id];
    assert.equal(p.S, 7); assert.equal(p.stage, 'young');
    const off = (p.due - T0) / DAY;
    assert.ok(off >= 1 && off <= 21, '21-day stagger');
  }
  assert.ok(st1.points.s1.ghost, 'shaky imports as ghost');
  assert.equal(hash('d1'), hash('d1'));                                // hash is pure
});

test('study: migrate — corrupt → fresh, current-version passthrough', () => {
  assert.equal(migrate(null).v, 3);
  assert.equal(migrate({ nope: 1 }).v, 3);
  assert.deepEqual(migrate(null).points, {});
  assert.equal(migrate({ v: 99, points: { x: 1 } }).v, 3);            // unknown/future version → fresh
  assert.deepEqual(migrate({ v: 99 }).points, {});
  const good = newState(T0);
  assert.equal(migrate(good), good);                                   // current-version identity passthrough
});

test('study: migrate v1→v3 preserves points, gains v2 (placed/examLevel) + v3 (streak/week) shape', () => {
  const v1 = {
    v: 1, points: { 'n5-wa': { S: 7, D: 5, due: 100 } }, session: null, units: {}, log: [],
    lastSession: 0,
    settings: { newPerDay: 4, capReviews: 45, weeklyGoal: 5, streak: { count: 4, last: '2026-08-01' }, freezes: 1 },
  };
  const v3 = migrate(v1);
  assert.equal(v3.v, 3);
  assert.deepEqual(v3.points, { 'n5-wa': { S: 7, D: 5, due: 100 } });  // real points survive the chain
  assert.deepEqual(v3.settings.placed, []);                            // v2 field
  assert.equal(v3.settings.examLevel, null);                           // v2 field
  assert.equal(v3.settings.newPerDay, 4);                              // old settings preserved
  // v3 folds the old top-level freezes + streak.last into the streak sub-shape, keeping progress
  assert.deepEqual(v3.settings.streak, { count: 4, lastDay: '2026-08-01', freezes: 1, lastFreezeMonth: null });
  assert.deepEqual(v3.settings.week, { done: 0, weekStart: null });    // v3 field
  assert.equal(v3.settings.freezes, undefined);                        // top-level freezes dropped
  assert.equal(v1.settings.placed, undefined);                         // input untouched (immutable)
});

// ── R11: streak + weekly-goal habit engine + mastery rollup ─────────────────────
const withSettings = (over) => ({ ...newState(0), settings: { ...newState(0).settings, ...over } });

test('study R11: recordSession — first session starts the streak + weekly counter', () => {
  const s1 = recordSession(newState(0), '2026-08-03');            // a Monday
  assert.equal(s1.settings.streak.count, 1);
  assert.equal(s1.settings.streak.lastDay, '2026-08-03');
  assert.equal(s1.settings.streak.lastFreezeMonth, '2026-08');
  assert.equal(s1.settings.week.done, 1);
  assert.equal(s1.settings.week.weekStart, '2026-08-03');
});

test('study R11: a lessons day then a review day = one count (the M1 fix relies on this)', () => {
  // A lessons/checkpoint completion and a review-session summary both call recordSession;
  // on the same calendar day the second is a no-op, so streak/weekly count exactly once.
  let s = recordSession(newState(0), '2026-08-03');   // lessons flow completes
  s = recordSession(s, '2026-08-03');                 // a review session finishes later the same day
  assert.equal(s.settings.streak.count, 1);
  assert.equal(s.settings.week.done, 1);
  // next day a lessons-only completion still advances the streak (was M1: it didn't)
  const s2 = recordSession(s, '2026-08-04');
  assert.equal(s2.settings.streak.count, 2);
  assert.equal(s2.settings.streak.freezes, 2, 'perfect attendance never spends a freeze');
});

test('study R11: recordSession — same-day is a no-op (max 1/day, idempotent by reference)', () => {
  const s1 = recordSession(newState(0), '2026-08-03');
  assert.equal(recordSession(s1, '2026-08-03'), s1);             // identity → no double count
});

test('study R11: recordSession — next day increments streak + weekly', () => {
  const s1 = recordSession(newState(0), '2026-08-03');
  const s2 = recordSession(s1, '2026-08-04');
  assert.equal(s2.settings.streak.count, 2);
  assert.equal(s2.settings.week.done, 2);
});

test('study R11: recordSession — a gap beyond the freeze budget resets the streak to 1', () => {
  const s1 = recordSession(newState(0), '2026-08-03');           // freezes replenished to 2
  const s = recordSession(s1, '2026-08-10');                     // 6 missed days > 2 freezes
  assert.equal(s.settings.streak.count, 1);
});

test('study R11: recordSession — a single freeze bridges one missed day', () => {
  const s1 = recordSession(newState(0), '2026-08-03');           // freezes: 2
  const s = recordSession(s1, '2026-08-05');                     // 1 missed day → spend 1 freeze
  assert.equal(s.settings.streak.count, 2);
  assert.equal(s.settings.streak.freezes, 1);
});

test('study R11: recordSession — freezes replenish at each new month', () => {
  const base = withSettings({ streak: { count: 5, lastDay: '2026-08-31', freezes: 0, lastFreezeMonth: '2026-08' } });
  const s = recordSession(base, '2026-09-01');                   // next day, new month → freezes back to 2
  assert.equal(s.settings.streak.count, 6);
  assert.equal(s.settings.streak.freezes, 2);
  assert.equal(s.settings.streak.lastFreezeMonth, '2026-09');
  // and the fresh budget can bridge a gap that the drained old month couldn't
  const base2 = withSettings({ streak: { count: 3, lastDay: '2026-08-30', freezes: 0, lastFreezeMonth: '2026-08' } });
  const s2 = recordSession(base2, '2026-09-01');                 // 1 missed day, bridged by a replenished freeze
  assert.equal(s2.settings.streak.count, 4);
  assert.equal(s2.settings.streak.freezes, 1);
});

test('study R11: recordSession — weekly counter resets when the Monday week rolls over', () => {
  let s = recordSession(newState(0), '2026-08-03');              // week of Aug 3
  s = recordSession(s, '2026-08-04');
  assert.equal(s.settings.week.done, 2);
  const next = recordSession(s, '2026-08-11');                   // week of Aug 10 → counter resets
  assert.equal(next.settings.week.done, 1);
  assert.equal(next.settings.week.weekStart, '2026-08-10');
});

test('study R11: streakInfo — atRisk = shown-up-yesterday-not-today; freezes replenish in the read path', () => {
  const st = withSettings({ streak: { count: 4, lastDay: '2026-08-04', freezes: 1, lastFreezeMonth: '2026-08' } });
  assert.deepEqual(streakInfo(st, '2026-08-05'), { count: 4, freezes: 1, atRisk: true });   // yesterday, not today
  assert.equal(streakInfo(st, '2026-08-04').atRisk, false);      // already shown up today
  assert.equal(streakInfo(st, '2026-08-06').atRisk, false);      // two-day gap — not "yesterday"
  assert.equal(streakInfo(st, '2026-09-10').freezes, 2);         // new month → effective replenish (no mutation)
});

test('study R11: weeklyInfo — done within the week, 0 once the week rolls over', () => {
  const wk = withSettings({ weeklyGoal: 5, week: { done: 3, weekStart: '2026-08-03' } });
  assert.deepEqual(weeklyInfo(wk, '2026-08-05'), { done: 3, goal: 5, weekStart: '2026-08-03' });
  assert.equal(weeklyInfo(wk, '2026-08-17').done, 0);            // a later week reads 0
});

test('study R11: masteryStats — per-level mastered counts, inGate, fixed corpus totals', () => {
  const ms = { ...newState(0), points: {
    'n5-a': { gate: { passed: true }, reps: 3, S: 30 },
    'n5-b': { gate: { passed: true }, reps: 3, S: 30 },
    'n4-c': { gate: { passed: true }, reps: 3, S: 30 },
    'n4-d': { reps: 3, S: 25 },                                   // Deep, not gated yet → inGate
  } };
  const out = masteryStats(ms);
  assert.equal(out.perLevel.N5, 2);
  assert.equal(out.perLevel.N4, 1);
  assert.equal(out.inGate, 1);
  assert.equal(out.totals.N4, 86);
  assert.deepEqual(LEVEL_TOTALS, { N5: 82, N4: 86, N3: 72, N2: 66, N1: 47 });
});

test('study: lessonOrder walks N5-first, unit order, unseeded only', () => {
  const units = [
    { id: 'n4-u1', level: 'N4', title: '', points: ['n4-a', 'n4-b'] },  // deliberately N4 first in the array
    { id: 'n5-u1', level: 'N5', title: '', points: ['n5-a', 'n5-b'] },
    { id: 'n5-u2', level: 'N5', title: '', points: ['n5-c', 'n5-d'] },
  ];
  const order = lessonOrder(units, { 'n5-b': { S: 7 } });               // n5-b already seeded → skipped
  assert.deepEqual(order, ['n5-a', 'n5-c', 'n5-d', 'n4-a', 'n4-b']);    // N5 units before N4, unit order kept
});

test('study: lessonOrder emits unseeded same/lower-level prereqs first (higher-level skipped)', () => {
  const units = [
    { id: 'n5-u1', level: 'N5', title: '', points: ['n5-base'] },
    { id: 'n4-u1', level: 'N4', title: '', points: ['n4-x'] },
  ];
  const related = { 'n4-x': ['n4-y', 'n5-base', 'n1-nope'] };           // n1-nope is higher-level → not a prereq
  const order = lessonOrder(units, {}, { related });
  assert.deepEqual(order, ['n5-base', 'n4-y', 'n4-x']);                 // n4-y pulled before n4-x; n5-base once
  assert.ok(!order.includes('n1-nope'));
});

test('study: lessonOrder — exam lever jumps that level first, pulling prereqs (closure)', () => {
  const units = [
    { id: 'n5-u1', level: 'N5', title: '', points: ['n5-p'] },
    { id: 'n4-u1', level: 'N4', title: '', points: ['n4-q'] },
    { id: 'n3-u1', level: 'N3', title: '', points: ['n3-goal'] },
  ];
  const related = { 'n3-goal': ['n5-p', 'n4-q'] };
  const order = lessonOrder(units, {}, { examLevel: 'N3', related });
  assert.deepEqual(order, ['n5-p', 'n4-q', 'n3-goal']);                 // N3 first, prereqs ahead, no later dup
  assert.equal(order.length, 3);
});

test('study: unitProgress — untouched / inprogress / done', () => {
  const unit = { id: 'n5-u1', level: 'N5', title: '', points: ['a', 'b', 'c'] };
  assert.deepEqual(unitProgress(unit, {}), { introduced: 0, total: 3, state: 'untouched' });
  assert.deepEqual(unitProgress(unit, { a: { S: 1 } }), { introduced: 1, total: 3, state: 'inprogress' });
  assert.deepEqual(unitProgress(unit, { a: {}, b: {}, c: {} }), { introduced: 3, total: 3, state: 'done' });
});

test('study: testOutResult — 2 passes land Mature ~2wk; any fail leaves state unchanged', () => {
  const now = T0, s0 = newState(now);
  const st = testOutResult(s0, 'n5-wa', [true, true], now);
  const p = st.points['n5-wa'];
  assert.equal(p.stage, 'mature');
  assert.equal(p.S, 14);
  assert.equal(p.D, 5);
  assert.equal(p.due, now + 14 * DAY);
  assert.equal(testOutResult(s0, 'n5-wa', [true, false], now), s0);     // any fail → unchanged
  assert.equal(testOutResult(s0, 'n5-wa', [true], now), s0);           // too few checks → unchanged
});

// ── R8: unit checkpoints ──────────────────────────────────────────────────────
test('study: checkpointQuestions — 10 items, no identical (id+example+type) twice, deterministic', () => {
  const unit = { id: 'n5-u1', level: 'N5', points: ['a', 'b', 'c', 'd', 'e', 'f'] };   // 6-point unit (<10)
  const byId = {};
  for (const id of unit.points) byId[id] = { id, examples: [{ ja: [] }, { ja: [] }, { ja: [] }] };   // 3 examples each
  const qs = checkpointQuestions(unit, byId, 12345);
  assert.equal(qs.length, 10);
  const keys = qs.map(q => `${q.id}|${q.exampleIdx}|${q.type}`);
  assert.equal(new Set(keys).size, 10, 'no identical item twice');
  for (const q of qs) {
    assert.ok(unit.points.includes(q.id));
    assert.ok(['mcq', 'scramble', 'cloze'].includes(q.type));
    assert.ok(q.exampleIdx >= 0 && q.exampleIdx < 3);
  }
  assert.deepEqual(checkpointQuestions(unit, byId, 12345), qs);                     // deterministic by seed
  assert.notDeepEqual(checkpointQuestions(unit, byId, 999), qs);                    // different seed → different draw
  const types = new Set(qs.map(q => q.type));
  assert.ok(types.size >= 2, 'mixes formats');
});

test('study: checkpointQuestions — big unit covers distinct points; empty unit → []', () => {
  const pts = Array.from({ length: 14 }, (_, i) => 'p' + i);
  const unit = { id: 'n3-u1', level: 'N3', points: pts };
  const byId = {}; for (const id of pts) byId[id] = { id, examples: [{ ja: [] }, { ja: [] }, { ja: [] }] };
  const qs = checkpointQuestions(unit, byId, 7);
  assert.equal(qs.length, 10);
  assert.ok(new Set(qs.map(q => q.id)).size >= 8, 'draws from many distinct points');
  assert.deepEqual(checkpointQuestions({ id: 'x', points: [] }, byId, 1), []);
});

test('study: recordCheckpoint — attempts/best/passed accumulate; formative (points untouched)', () => {
  let st = newState(T0);
  st = { ...st, points: { 'n5-a': { S: 7, reps: 1 } } };
  const pointsBefore = st.points;
  st = recordCheckpoint(st, 'n5-u1', 6);                     // below pass mark
  assert.deepEqual(st.units['n5-u1'].checkpoint, { passed: false, best: 6, attempts: 1 });
  assert.equal(checkpointPassed(st, 'n5-u1'), false);
  st = recordCheckpoint(st, 'n5-u1', 9);                     // pass
  assert.deepEqual(st.units['n5-u1'].checkpoint, { passed: true, best: 9, attempts: 2 });
  assert.equal(checkpointPassed(st, 'n5-u1'), true);
  st = recordCheckpoint(st, 'n5-u1', 4);                     // a later worse retake keeps passed + best
  assert.deepEqual(st.units['n5-u1'].checkpoint, { passed: true, best: 9, attempts: 3 });
  assert.equal(st.points, pointsBefore, 'scheduling untouched (formative)');   // same points ref → no writes
});

test('study: recordCheckpoint — works on a migrated state with no units key (no schema bump)', () => {
  const v1 = { v: 1, points: {}, session: null, log: [], lastSession: 0, settings: { newPerDay: 4, capReviews: 45, weeklyGoal: 5, streak: { count: 0, last: null }, freezes: 2 } };
  const s = migrate(v1);                                     // v1→v2, still no units key guaranteed
  const out = recordCheckpoint(s, 'n5-u1', 10);
  assert.equal(out.units['n5-u1'].checkpoint.passed, true);
  assert.equal(checkpointPassed(out, 'n5-u1'), true);
});

test('study: nextCheckpointUnit — first lessons-done, unpassed unit in order (Continue priority)', () => {
  const units = [
    { id: 'n5-u1', level: 'N5', points: ['a', 'b'] },
    { id: 'n5-u2', level: 'N5', points: ['c', 'd'] },
    { id: 'n5-u3', level: 'N5', points: ['e', 'f'] },
  ];
  // u1 fully introduced + passed, u2 fully introduced + unpassed, u3 partial
  const statePoints = { a: {}, b: {}, c: {}, d: {}, e: {} };
  const unitsState = { 'n5-u1': { checkpoint: { passed: true, best: 10, attempts: 1 } } };
  const next = nextCheckpointUnit(units, statePoints, unitsState);
  assert.equal(next.id, 'n5-u2', 'skips passed u1, skips partial u3');
  // everything done + passed → null
  assert.equal(nextCheckpointUnit(units, { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} },
    { 'n5-u1': { checkpoint: { passed: true } }, 'n5-u2': { checkpoint: { passed: true } }, 'n5-u3': { checkpoint: { passed: true } } }), null);
  assert.equal(nextCheckpointUnit([], {}, {}), null);
});

// deterministic ~88% pass LCG shared by the sims below
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}
function answer(rnd) {
  const pass = rnd() < 0.88;
  if (!pass) return { pass: false, grade: 1 };
  const r = rnd();
  const grade = r < 0.15 ? 2 : r < 0.85 ? 3 : 4;
  return { pass: true, grade };
}
function gateArgs(p) {
  if (stageOf(p) === 'deep') {
    const idx = p.gate && p.gate.passes ? p.gate.passes.length % 3 : 0;
    return { mode: 'gate', exampleIdx: idx };
  }
  return { mode: 'review', exampleIdx: 0 };
}

test('study: idempotency control-run — kill mid-session then resume = byte-identical D/S/due', () => {
  // build a session of reviews over a seeded store
  const ids = Array.from({ length: 30 }, (_, i) => 'k' + i);
  let base = seedImport(newState(T0), { done: ids }, T0 - 30 * DAY);
  const now = T0;
  const queue = buildQueue(base, now).reviews;
  const nowFor = (i) => now + i * 1000;   // stable per-index clock

  // run A: never killed
  let A = sessionStart(base, queue);
  const rndA = lcg(777);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    A = review(A, id, { ...answer(rndA), ...gateArgs(A.points[id]) }, nowFor(i));
    A = sessionRecord(A, { id });
  }
  A = sessionEnd(A);

  // run B: killed after 12, state carried, then resumed
  let B = sessionStart(base, queue);
  const rndB = lcg(777);
  const KILL = 12;
  for (let i = 0; i < KILL; i++) {
    const id = queue[i];
    B = review(B, id, { ...answer(rndB), ...gateArgs(B.points[id]) }, nowFor(i));
    B = sessionRecord(B, { id });
  }
  // — tab dies here; B is what was persisted —
  assert.equal(B.session.pos, KILL, 'resume position preserved');
  assert.equal(B.session.results.length, KILL);
  // resume: continue at pos, NEVER re-applying the first 12
  for (let i = B.session.pos; i < queue.length; i++) {
    const id = queue[i];
    B = review(B, id, { ...answer(rndB), ...gateArgs(B.points[id]) }, nowFor(i));
    B = sessionRecord(B, { id });
  }
  B = sessionEnd(B);

  assert.deepStrictEqual(B.points, A.points, 'resumed run yields identical scheduling state');
});

test('study: 400-day simulation — bounded load, no deferral >2, seeding + mastery targets', () => {
  const N = 353, CAP = 45;
  const levels = ['N5', 'N4', 'N3', 'N2', 'N1'];
  const ids = [];
  for (let i = 0; i < N; i++) ids.push('p' + i);   // levels/flags mix implied; scheduler is register-agnostic

  let st = newState(T0);
  st = { ...st, lastSession: T0 };
  // seed ~200 done + 30 shaky at day 0
  const done = ids.slice(0, 200), shaky = ids.slice(200, 230);
  st = seedImport(st, { done, shaky }, T0);
  const unseeded = ids.slice(230);   // 123 introduced by drip
  let dripPtr = 0;

  const rnd = lcg(4242);
  let maxDaily = 0, maxReviews = 0, maxDefers = 0;
  let seededByDay105 = 0, masteredByDay330 = 0, masteredByEnd = 0;

  for (let d = 0; d < 400; d++) {
    const now = T0 + d * DAY + 12 * 3600000;   // midday
    st = amnesty(st, now);
    st = { ...st, lastSession: now };
    const q = buildQueue(st, now);
    for (const id of q.deferred) st = deferCard(st, id, now);

    // reviews
    let counter = 0;
    for (const id of q.reviews) {
      const nowI = now + (counter++) * 1000;
      st = review(st, id, { ...answer(rnd), ...gateArgs(st.points[id]) }, nowI);
    }
    // lessons (drip) — introduce up to q.lessons new points
    let lessonsUsed = 0;
    for (let k = 0; k < q.lessons && dripPtr < unseeded.length; k++) {
      const id = unseeded[dripPtr++];
      st = review(st, id, { ...answer(rnd) }, now + (counter++) * 1000);   // first encounter → Seed
      lessonsUsed++;
    }

    for (const id of Object.keys(st.points)) maxDefers = Math.max(maxDefers, st.points[id].defers || 0);
    maxReviews = Math.max(maxReviews, q.reviews.length);
    maxDaily = Math.max(maxDaily, q.reviews.length + lessonsUsed);

    if (d === 105) {
      seededByDay105 = ids.filter(id => st.points[id] && (st.points[id].reps || 0) > 0).length;
    }
    const passed = () => ids.filter(id => st.points[id] && st.points[id].gate && st.points[id].gate.passed).length;
    if (d === 330) masteredByDay330 = passed();
    if (d === 399) masteredByEnd = passed();
  }

  // — Hard invariants (never weakened): debt protection + bounded load —
  assert.ok(maxReviews <= CAP + 5, `displayed reviews ≤ cap+5 (was ${maxReviews})`);
  assert.ok(maxDaily <= 60, `total daily load ≤ 60 (was ${maxDaily})`);
  assert.ok(maxDefers <= 2, `no card deferred >2 (was ${maxDefers})`);
  assert.equal(seededByDay105, N, `all ${N} seeded by day 105 (was ${seededByDay105})`);
  // — Mastery targets —
  // The 353-point corpus reaches Deep fast (≈318 Deep by day 105), but each gate needs 3
  // scheduled Deep-interval reviews, and FSRS stability balloons those intervals (30→60→120d),
  // so gate throughput — not climbing — is the limiter. Faithful mechanics (documented
  // GROWTH=1.2, ~88% pass, gate-fail demotion) reach ~84% mastered by day 330 and cross 90%
  // near day ~375 — consistent with the plan's own honest hedge ("all gates ≈ Jun 2027, tail
  // into early Jul") and the round-3 critic's "optimistic-but-honestly-hedged" note. Bumping
  // GROWTH upward (the spec's suggested first remedy) was tested and REJECTED: it lengthens
  // Deep intervals and *lowers* mastery (223/353 at 1.6). So day 330 asserts an 80% progress
  // floor and the 90% bar rides the end-of-sim tail instead.
  assert.ok(masteredByDay330 >= 0.80 * N, `≥80% mastered by day 330 (was ${masteredByDay330}/${N})`);
  assert.ok(masteredByEnd >= 0.90 * N, `≥90% mastered by end of 400-day sim (was ${masteredByEnd}/${N})`);
});

test('study: migrate — upgraders are INVOKED and user data survives the chain', () => {
  const st = { v: 1, points: { a: { S: 9, D: 5 } }, session: null, log: [] };
  const up = {
    1: (s) => ({ ...s, v: 2, marked: true }),
    2: (s) => ({ ...s, v: 3, settings: { newPerDay: 4 } }),
  };
  const out = migrate(st, up, 3);
  assert.equal(out.v, 3);
  assert.equal(out.marked, true);                       // upgrader 1 actually ran
  assert.deepEqual(out.points, { a: { S: 9, D: 5 } });  // data preserved, not wiped
  assert.deepEqual(st.points, { a: { S: 9, D: 5 } });   // input untouched
  // chain that cannot reach the target still resets to fresh (newState = current version)
  assert.equal(migrate({ v: 1 }, {}, 3).v, 3);
});

test('study: normal-mode lapse voids in-progress gate passes; Mastered stays sticky', () => {
  const T = Date.UTC(2026, 7, 1, 12);
  let st = newState(T);
  st = { ...st, points: { g1: { D: 5, S: 25, last: T, due: T, stage: 'deep', reps: 9, lapses: 0, ghost: null, gate: { passes: [0, 1] } } } };
  st = review(st, 'g1', { pass: false, grade: 1, mode: 'review' }, T);
  assert.deepEqual(st.points.g1.gate, { passes: [] });   // one-from-Mastered progress voided
  let st2 = newState(T);
  st2 = { ...st2, points: { g2: { D: 5, S: 60, last: T, due: T, stage: 'mastered', reps: 15, lapses: 0, ghost: null, gate: { passes: [0, 1, 2], passed: true } } } };
  st2 = review(st2, 'g2', { pass: false, grade: 1, mode: 'review' }, T);
  assert.equal(st2.points.g2.gate.passed, true);         // Mastered is not revoked by a lapse
});

// ─────────────────────────────────────────────────────────────────────────────
// study.js — R15 analytics, pacing projection, the Master moment (pure)
// ─────────────────────────────────────────────────────────────────────────────
// a point at Mastered = its gate passed; a mid-ladder point = has reps + a stability.
const mastered = () => ({ D: 5, S: 60, last: T0, due: T0 + 40 * DAY, reps: 15, lapses: 0, ghost: null, gate: { passes: [0, 1, 2], passed: true } });
const midYoung = (over = {}) => ({ D: 5, S: 6, last: T0, due: T0 + 6 * DAY, reps: 3, lapses: 0, ghost: null, gate: null, ...over });

test('study R15: isMasterComplete — 353/353 true, 352 false', () => {
  assert.equal(CORPUS_TOTAL, 353);
  const full = newState(T0);
  for (let i = 0; i < 353; i++) full.points['p' + i] = mastered();
  assert.equal(isMasterComplete(full), true, '353 mastered → complete');
  const one = full.points['p0'];
  delete full.points['p0'];
  full.points['p0'] = midYoung();               // one point knocked back below Mastered
  assert.equal(Object.keys(full.points).length, 353);
  assert.equal(isMasterComplete(full), false, '352 mastered → not complete');
  assert.equal(isMasterComplete(newState(T0)), false, 'empty store → not complete');
  void one;
});

test('study R15: courseRollup — % KEYED ON MASTERY (gates), never on checkpoints', () => {
  const units = [
    { id: 'n5-u1', level: 'N5', title: 'U1', points: ['n5-a', 'n5-b', 'n5-c', 'n5-d'] },
    { id: 'n4-u1', level: 'N4', title: 'U1', points: ['n4-a', 'n4-b'] },
  ];
  let s = newState(T0);
  s.points['n5-a'] = mastered();
  s.points['n5-b'] = mastered();
  s.points['n5-c'] = midYoung();                 // seeded but NOT mastered
  s.points['n4-a'] = mastered();
  // pass EVERY unit's checkpoint — must NOT change any course-%
  s = { ...s, units: { 'n5-u1': { checkpoint: { passed: true } }, 'n4-u1': { checkpoint: { passed: true } } } };
  const r = courseRollup(s, units);
  const u1 = r.units.find(u => u.id === 'n5-u1');
  assert.equal(u1.mastered, 2);
  assert.equal(u1.pct, 50, 'unit % = mastered/total, unaffected by a passed checkpoint');
  // level % keys on the FIXED LEVEL_TOTALS denominator (honest 0% before seeding)
  assert.equal(r.perLevel.N5.mastered, 2);
  assert.equal(r.perLevel.N5.total, LEVEL_TOTALS.N5);
  assert.equal(r.perLevel.N5.pct, Math.round(2 / LEVEL_TOTALS.N5 * 100));
  assert.equal(r.perLevel.N1.pct, 0, 'untouched level reads 0%, not undefined');
  assert.equal(r.overall.total, 353);
  assert.equal(r.overall.mastered, 3);
});

test('study R15: estimatedRetention — mean retrievability, decays with elapsed time', () => {
  let s = newState(T0);
  s.points['a'] = { S: 10, last: T0, reps: 2, suspended: false };
  s.points['b'] = { S: 10, last: T0, reps: 2, suspended: false };
  assert.equal(estimatedRetention(s, T0).mean, 1, 'seen right now → full recall');
  assert.equal(estimatedRetention(s, T0).n, 2);
  const later = estimatedRetention(s, T0 + 20 * DAY);
  assert.ok(later.mean > 0 && later.mean < 1, 'decays below 1 as days pass');
  // suspended + no-stability points are excluded
  s.points['c'] = { S: 10, last: T0, suspended: true };
  s.points['d'] = { S: 0, last: T0 };
  assert.equal(estimatedRetention(s, T0).n, 2, 'suspended + S=0 excluded');
});

test('study R15: mockTrend + mockClustersFromLog — extracted per level from examLog', () => {
  const s = { ...newState(T0), examLog: [
    { level: 'N3', date: '2026-11-01', raw: 12, total: 24, byCluster: { c1: { count: 2, cluster: 'n3-x' }, other: { count: 1 } } },
    { level: 'N3', date: '2026-11-08', raw: 18, total: 24 },
    { level: 'N2', date: '2027-03-01', raw: 10, total: 22 },
  ] };
  const t = mockTrend(s);
  assert.equal(t.N3.length, 2);
  assert.deepEqual(t.N3.map(e => e.pct), [50, 75], 'oldest→newest, pct computed');
  assert.equal(t.N2[0].pct, Math.round(10 / 22 * 100));
  const mc = mockClustersFromLog(s);
  assert.equal(mc['n3-x'], 2, 'wrong picks aggregate by confusable id; "other" dropped');
  assert.equal(mc.other, undefined);
});

test('study R15: clusterWeakness — worst trap families first, empty when no signal', () => {
  const clusters = [
    { key: 'cond', label: 'Conditionals', ids: ['a', 'b'] },
    { key: 'evid', label: 'Evidentials', ids: ['c', 'd'] },
    { key: 'calm', label: 'Calm', ids: ['e'] },
  ];
  const points = {
    a: { lapses: 3, leech: false }, b: { lapses: 5, leech: true },   // cond: 8 + 2 = 10 + mock
    c: { lapses: 2, leech: false }, d: { lapses: 1, leech: false },   // evid: 3
    e: { lapses: 0, leech: false },                                   // calm: 0 → dropped
  };
  const w = clusterWeakness(clusters, points, { cond: 4 });
  assert.equal(w.length, 2, 'no-signal family dropped');
  assert.equal(w[0].key, 'cond');
  assert.equal(w[0].score, 3 + 5 + 2 * 1 + 4, 'lapses + 2·leeches + mock');
  assert.equal(w[1].key, 'evid');
  assert.deepEqual(clusterWeakness([], {}, {}), []);
});

test('study R15: masteryLagDays — engine-derived, ordered by grade, deterministic', () => {
  const good = masteryLagDays(3);
  assert.ok(good > 120 && good < 400, `Seed→Mastered lag is a sane ~months figure (${good}d)`);
  assert.equal(masteryLagDays(3), good, 'memoised — identical on re-call');
  assert.ok(masteryLagDays(2) < good && good < masteryLagDays(4), 'a higher grade grows S faster → longer intervals → more days to reach the gate: Hard < Good < Easy');
});

test('study R15: paceProjection — sane future date, pulls in as points master', () => {
  let s = seedImport(newState(T0), { done: Array.from({ length: 50 }, (_, i) => 'n5-p' + i) }, T0);
  const p = paceProjection(s, T0);
  assert.equal(p.done, false);
  assert.equal(p.total, 353);
  assert.equal(p.unseeded, 303);
  assert.ok(p.projected > T0, 'projected finish is in the future');
  assert.ok(p.daysOut > p.lag, 'finish = seed time + a maturation lag');
  // a fully-mastered store → done, zero days out
  const full = newState(T0);
  for (let i = 0; i < 353; i++) full.points['p' + i] = mastered();
  const pf = paceProjection(full, T0);
  assert.equal(pf.done, true);
  assert.equal(pf.daysOut, 0);
  // more seeding pulls the projection IN (fewer unseeded → less seed time)
  let s2 = seedImport(newState(T0), { done: Array.from({ length: 200 }, (_, i) => 'n5-p' + i) }, T0);
  assert.ok(paceProjection(s2, T0).daysOut < p.daysOut, 'seeding more shortens the projection');
});

test('study R15: repaceNewPerDay — clamps 1..40, explicit target math', () => {
  const s = seedImport(newState(T0), { done: Array.from({ length: 50 }, (_, i) => 'n5-p' + i) }, T0);
  // a comfortable far target needs a modest drip
  const far = repaceNewPerDay(s, '2027-07-04', T0);
  assert.ok(far >= 1 && far <= 40);
  // an infeasible near target (inside one maturation lag) → the 40 ceiling, never above the cap
  assert.equal(repaceNewPerDay(s, '2026-12-06', T0), 40);
  // nothing unseeded → keep current newPerDay
  const full = newState(T0);
  for (let i = 0; i < 353; i++) full.points['p' + i] = mastered();
  assert.equal(repaceNewPerDay(full, '2027-07-04', T0), full.settings.newPerDay);
  // a garbage target → current newPerDay (never NaN)
  assert.equal(repaceNewPerDay(s, 'not-a-date', T0), s.settings.newPerDay);
});

test('study R15: certStats — reviews Σreps, accuracy from lapses, days from lifetime tally', () => {
  let s = newState(T0);
  s.points['a'] = { reps: 10, lapses: 1 };
  s.points['b'] = { reps: 10, lapses: 1 };
  s = { ...s, settings: { ...s.settings, daysStudied: 42 } };
  const c = certStats(s);
  assert.equal(c.reviews, 20);
  assert.equal(c.accuracy, Math.round((20 - 2) / 20 * 100));   // 90
  assert.equal(c.days, 42);
  assert.equal(certStats(newState(T0)).accuracy, 0, 'no reviews → 0, never NaN');
});

test('study R15: recordSession bumps the lifetime daysStudied tally (once/day)', () => {
  let s = recordSession(newState(T0), '2026-08-03');
  assert.equal(s.settings.daysStudied, 1);
  s = recordSession(s, '2026-08-03');            // same day → no-op
  assert.equal(s.settings.daysStudied, 1);
  s = recordSession(s, '2026-08-04');            // new day → +1
  assert.equal(s.settings.daysStudied, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// questions.js — R2 typed-cloze generator + answer arbitration (pure)
// ─────────────────────────────────────────────────────────────────────────────
import { clozeFor, normalizeAnswer, levenshtein, checkAnswer, scrambleFor, scramblable, mcqFor } from '../docs/assets/lib/questions.js';

// real-shaped fixture: p tokens are objects, non-p tokens mix string + object, p is
// NON-contiguous (indices 2 and 4), and the p surfaces differ from their kana readings.
const clozePoint = {
  id: 'x-tabete-kara',
  examples: [{
    ja: [
      { t: '朝', f: [['朝', 'あさ']], g: 'morning' },
      'ご飯',                                              // string token (mixed)
      { t: '食べ', f: [['食', 'た'], ['べ', '']], p: 1 },   // p — surface 食べ / reading たべ
      'て',
      { t: 'から', f: [['から', '']], p: 1 },              // p (non-contiguous) — から / から
      { t: '行く', f: [['行', 'い'], ['く', '']], g: 'go' },
      '。',
    ],
    en: 'After eating breakfast, I go.',
  }],
};

test('questions: clozeFor blanks exactly the p tokens, preserves the rest', () => {
  const { blankedTokens, exampleIdx } = clozeFor(clozePoint, 0);
  assert.equal(exampleIdx, 0);
  assert.equal(blankedTokens.length, 7);
  const blanks = blankedTokens.map(b => !!b.blank);
  assert.deepEqual(blanks, [false, false, true, false, true, false, false]);   // p at 2 and 4
  assert.equal(blankedTokens[1].token, 'ご飯');                                 // string token intact
  assert.equal(blankedTokens[0].token.t, '朝');                                 // object token intact
});

test('questions: answers include the concatenated surface AND the kana reading', () => {
  const { answers } = clozeFor(clozePoint, 0);
  assert.ok(answers.includes('食べから'), 'surface accepted');
  assert.ok(answers.includes('たべから'), 'kana reading accepted');
});

test('questions: normalizeAnswer folds katakana + full-width and strips space/、。', () => {
  assert.equal(normalizeAnswer('カラ'), 'から');            // katakana → hiragana
  assert.equal(normalizeAnswer(' から 。'), 'から');        // trim + strip space + 。
  assert.equal(normalizeAnswer('た　べ、'), 'たべ');        // full-width space (NFKC) + 、 stripped
  assert.equal(normalizeAnswer('ｶﾗ'), 'から');            // half-width katakana → hiragana via NFKC
});

test('questions: levenshtein basic distances', () => {
  assert.equal(levenshtein('たべから', 'たべから'), 0);
  assert.equal(levenshtein('たべから', 'たべかろ'), 1);     // one substitution
  assert.equal(levenshtein('から', 'かﾗ'), 1);
});

test('questions: checkAnswer — exact match on surface or kana', () => {
  const { answers } = clozeFor(clozePoint, 0);
  assert.deepEqual(checkAnswer('たべから', answers), { ok: true, close: false });
  assert.deepEqual(checkAnswer('食べから', answers), { ok: true, close: false });
  assert.deepEqual(checkAnswer('タベカラ', answers), { ok: true, close: false });   // katakana input folds
});

test('questions: checkAnswer — close (distance 1) and wrong', () => {
  const { answers } = clozeFor(clozePoint, 0);
  assert.deepEqual(checkAnswer('たべかろ', answers), { ok: false, close: true });   // 1 off
  assert.deepEqual(checkAnswer('ぜんぜんちがう', answers), { ok: false, close: false });
  assert.deepEqual(checkAnswer('', answers), { ok: false, close: false });          // empty never matches
});

test('questions: multi-p cloze — each blank carries ITS OWN fill, answers stay merged', () => {
  const pt = { examples: [{ ja: [
    { t: '掃除し', f: [['掃除し', 'そうじし']], g: 'clean' },
    { t: 'たり', f: [['たり', '']], p: 1 },
    { t: '洗濯し', f: [['洗濯し', 'せんたくし']], g: 'laundry' },
    { t: 'たり', f: [['たり', '']], p: 1 },
    'します', '。',
  ], en: 'I do things like cleaning and laundry.' }] };
  const c = clozeFor(pt, 0);
  const blanks = c.blankedTokens.filter(b => b.blank);
  assert.equal(blanks.length, 2);
  assert.deepEqual(blanks.map(b => b.fill), ['たり', 'たり']);  // per-blank reveal text
  assert.ok(c.answers.includes('たりたり'));                     // typed answer stays merged
});

// ─────────────────────────────────────────────────────────────────────────────
// questions.js — R4 ★-scramble (文の組み立て) generator (pure)
// ─────────────────────────────────────────────────────────────────────────────
// real-shaped fixture: 6 usable units after punctuation is glued to the preceding chunk.
const scramblePoint = {
  id: 'x-scram',
  examples: [{
    ja: [
      { t: '駅', f: [['駅', 'えき']], g: 'station' },
      'に',
      { t: '着い', f: [['着', 'つ'], ['い', '']], g: 'arrive' },
      { t: 'たら', f: [['たら', '']], p: 1 },
      '、',
      { t: '電話', f: [['電', 'でん'], ['話', 'わ']], g: 'phone' },
      'します', '。',
    ],
    en: 'When I arrive at the station, I call.',
  }],
};
const surfaceOfJa = (ja) => ja.map(t => (typeof t === 'string' ? t : (t.t || ''))).join('');

test('questions: scrambleFor — 4 chunks, exact reassembly, star ∈ {1,2}', () => {
  const s = scrambleFor(scramblePoint, 0);
  assert.equal(s.chunks.length, 4);
  assert.equal(s.order.length, 4);
  assert.equal(s.order.map(i => s.chunks[i].text).join(''), surfaceOfJa(scramblePoint.examples[0].ja));
  assert.ok(s.star === 1 || s.star === 2, `star ${s.star} in {1,2}`);
  assert.deepEqual([...s.order].sort(), [0, 1, 2, 3]);   // order is a permutation of the 4 chunk indices
});

test('questions: scrambleFor — deterministic; seed shuffles PRESENTATION only', () => {
  assert.deepEqual(scrambleFor(scramblePoint, 0, 12345), scrambleFor(scramblePoint, 0, 12345));  // fixed seed reproducible
  assert.deepEqual(scrambleFor(scramblePoint, 0), scrambleFor(scramblePoint, 0));                 // default seed reproducible
  const surf = surfaceOfJa(scramblePoint.examples[0].ja);
  for (const seed of [1, 2, 7, 99]) {                     // any seed still reassembles the same sentence
    const s = scrambleFor(scramblePoint, 0, seed);
    assert.equal(s.chunks.length, 4);
    assert.equal(s.order.map(i => s.chunks[i].text).join(''), surf);
  }
});

test('questions: scramblable — < 4 usable tokens degrades cleanly to null', () => {
  const short = { examples: [{ ja: [{ t: 'もう', f: [['もう', '']] }, { t: '帰らなきゃ', f: [['帰', 'かえ'], ['らなきゃ', '']], p: 1 }, '。'], en: 'gotta go' }] };
  assert.equal(scrambleFor(short, 0), null);
  assert.equal(scramblable(short), false);
  assert.equal(scramblable(scramblePoint), true);
  assert.equal(scrambleFor({ examples: [] }, 0), null);   // no example → null
});

test('questions: scrambleFor — corpus-wide validity ≥97%, exact reassembly + star everywhere', () => {
  const dir = new URL('../docs/data/', import.meta.url);
  const levels = ['n5', 'n4', 'n3', 'n2', 'n1'];
  let total = 0, valid = 0;
  for (const l of levels) {
    const pts = JSON.parse(readFileSync(new URL(`grammar-${l}.json`, dir), 'utf8'));
    for (const p of pts) {
      for (let i = 0; i < (p.examples || []).length; i++) {
        total++;
        const s = scrambleFor(p, i);
        if (!s) continue;
        valid++;
        assert.equal(s.chunks.length, 4, `${p.id}#${i} chunks`);
        assert.equal(s.order.map(k => s.chunks[k].text).join(''), surfaceOfJa(p.examples[i].ja), `${p.id}#${i} reassembly`);
        assert.ok(s.star === 1 || s.star === 2, `${p.id}#${i} star`);
        assert.ok(s.order.some((v, k) => v !== k), `${p.id}#${i} presented pre-solved (identity)`);
      }
    }
  }
  assert.ok(valid / total >= 0.97, `scramble coverage ${(valid / total * 100).toFixed(1)}% ≥ 97%`);
});

test('questions: scramblable — the known scramble-less points degrade', () => {
  // R5's third examples rescued n5-wa-dou-desu-ka AND n4-nakya (their new examples are long
  // enough to chunk) — n4-te-sumimasen is the one point whose every example stays under 4 units.
  const pool = ['n5', 'n4'].flatMap(l =>
    JSON.parse(readFileSync(new URL(`../docs/data/grammar-${l}.json`, import.meta.url), 'utf8')));
  for (const id of ['n4-te-sumimasen']) {
    const p = pool.find(x => x.id === id);
    assert.ok(p, `${id} present`);
    assert.equal(scramblable(p), false, `${id} is not scramble-able`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// questions.js — R8 文法形式 MCQ generator (pure)
// ─────────────────────────────────────────────────────────────────────────────
const mcqA = { id: 'n5-a', pattern: '〜ように', level: 'N5', confusable: ['n5-b', 'n5-c'], distractors: ['〜そうに'],
  examples: [{ ja: [{ t: '会議', f: [['会議', 'かいぎ']], g: 'meeting' }, 'に', { t: '間に合う', f: [['間に合う', 'まにあう']], g: 'in time' }, { t: 'ように', f: [['ように', '']], p: 1 }, '。'], en: 'so as to make the meeting.' }] };
const mcqB = { id: 'n5-b', pattern: '〜ために', level: 'N5', confusable: ['n5-a'] };
const mcqC = { id: 'n5-c', pattern: '〜のに', level: 'N5', confusable: ['n5-a'] };

test('questions: mcqFor — 4 options, one correct = the pattern, wrongs ⊆ mcqOptions, blanked stem', () => {
  const byId = new Map([['n5-a', mcqA], ['n5-b', mcqB], ['n5-c', mcqC]]);
  const m = mcqFor(mcqA, byId, 0, 42);
  assert.equal(m.options.length, 4);
  assert.equal(new Set(m.options).size, 4, 'no duplicate option');
  assert.equal(m.options[m.correct], '〜ように', 'correct option is the point pattern');
  assert.equal(m.options.filter(o => o === '〜ように').length, 1, 'exactly one correct');
  const pool = mcqOptions(mcqA, byId);                              // the validator helper
  for (const o of m.options) if (o !== '〜ように') assert.ok(pool.includes(o), `wrong "${o}" from mcqOptions`);
  assert.ok(m.stem.some(t => t.blank), 'stem has a blank');
  assert.ok(m.stem.some(t => !t.blank), 'stem keeps non-p tokens');
  assert.equal(m.en, 'so as to make the meeting.');
});

test('questions: mcqFor — deterministic by seed; null when <3 wrong options', () => {
  const byId = new Map([['n5-a', mcqA], ['n5-b', mcqB], ['n5-c', mcqC]]);
  assert.deepEqual(mcqFor(mcqA, byId, 0, 7), mcqFor(mcqA, byId, 0, 7));       // same seed reproducible
  assert.deepEqual(mcqFor(mcqA, byId, 0), mcqFor(mcqA, byId, 0));             // default seed reproducible
  // mcqB has one confusable (n5-a) and no distractors → only 1 wrong option → cannot make a 4-set
  assert.equal(mcqFor(mcqB, byId, 0, 1), null);
  assert.equal(mcqFor(null, byId, 0), null);
});

test('questions: mcqFor — every one of the 353 real points yields a valid 4-option MCQ (leans on R7 ≥3 gate)', () => {
  const dir = new URL('../docs/data/', import.meta.url);
  const files = ['n5', 'n4', 'n3', 'n2', 'n1'].map(l => JSON.parse(readFileSync(new URL(`grammar-${l}.json`, dir), 'utf8')));
  const all = files.flat();
  const byId = new Map(all.map(p => [p.id, p]));
  let n = 0;
  for (const p of all) {
    const m = mcqFor(p, byId, 0);
    assert.ok(m, `${p.id} → MCQ`);
    assert.equal(m.options.length, 4, `${p.id} options`);
    assert.equal(new Set(m.options).size, 4, `${p.id} distinct options`);
    assert.equal(m.options[m.correct], p.pattern, `${p.id} correct = pattern`);
    const pool = mcqOptions(p, byId);
    for (const o of m.options) if (o !== p.pattern) assert.ok(pool.includes(o), `${p.id} wrong "${o}" ⊆ mcqOptions`);
    n++;
  }
  assert.equal(n, 353);
});

// ─────────────────────────────────────────────────────────────────────────────
// grammar-units.json — R3 unit map + validateUnits, run against the REAL corpus
// ─────────────────────────────────────────────────────────────────────────────
import { validateUnits } from '../scripts/validate-grammar.mjs';

test('units: validateUnits passes over the real corpus (all 353 points, each in one unit)', () => {
  const dir = new URL('../docs/data/', import.meta.url);
  const levels = ['n5', 'n4', 'n3', 'n2', 'n1'];
  const loaded = levels.map(l => ({
    level: l.toUpperCase(),
    points: JSON.parse(readFileSync(new URL(`grammar-${l}.json`, dir), 'utf8')),
  }));
  const allIds = new Set(loaded.flatMap(x => x.points.map(p => p.id)));
  assert.equal([...allIds].length, 353);
  for (const { level, points } of loaded) assert.deepEqual(validatePoints(points, level, allIds), []);
  const units = JSON.parse(readFileSync(new URL('grammar-units.json', dir), 'utf8'));
  assert.deepEqual(validateUnits(units, allIds), []);
});

test('units: validateUnits catches size, unknown-id, duplicate-coverage, gap and level errors', () => {
  const allIds = new Set(['n5-a', 'n5-b', 'n5-c', 'n5-d', 'n5-e', 'n5-f']);
  const full = ['n5-a', 'n5-b', 'n5-c', 'n5-d', 'n5-e', 'n5-f'];
  assert.deepEqual(validateUnits([{ id: 'n5-u1', level: 'N5', title: 'T', points: full }], allIds), []);
  assert.ok(validateUnits([{ id: 'n5-u1', level: 'N5', title: 'T', points: ['n5-a'] }], allIds).some(e => /out of range/.test(e)));
  assert.ok(validateUnits([{ id: 'n5-u1', level: 'N5', title: 'T', points: ['n5-a', 'n5-b', 'n5-c', 'n5-d', 'n5-e', 'n5-x'] }], allIds).some(e => /unknown point id n5-x/.test(e)));
  const dup = [
    { id: 'n5-u1', level: 'N5', title: 'T', points: full },
    { id: 'n5-u2', level: 'N5', title: 'T', points: full },
  ];
  assert.ok(validateUnits(dup, allIds).some(e => /appears in 2 units/.test(e)));
  assert.ok(validateUnits([{ id: 'n5-u1', level: 'N5', title: 'T', points: ['n5-a', 'n5-b', 'n5-c', 'n5-d', 'n5-e'] }], allIds).some(e => /is in no unit/.test(e)));  // n5-f gap
  assert.ok(validateUnits([{ id: 'n5-x1', level: 'N5', title: 'T', points: full }], allIds).some(e => /bad unit id/.test(e)));
  assert.ok(validateUnits([{ id: 'n4-u1', level: 'N4', title: 'T', points: full }], allIds).some(e => /not level N4/.test(e)));
});

// ─────────────────────────────────────────────────────────────────────────────
// exam.js — R13 mock-exam assembly + scoring (pure, deterministic)
// ─────────────────────────────────────────────────────────────────────────────
import { buildExam, scoreExam, examBand, recordExam, KATA_COUNT, STAR_COUNT, PASSAGE_COUNT } from '../docs/assets/lib/exam.js';

function loadCorpus() {
  const dir = new URL('../docs/data/', import.meta.url);
  const byLevel = {};
  for (const l of ['n5', 'n4', 'n3', 'n2', 'n1']) {
    byLevel['N' + l[1]] = JSON.parse(readFileSync(new URL(`grammar-${l}.json`, dir), 'utf8'));
  }
  const passages = JSON.parse(readFileSync(new URL('grammar-passages.json', dir), 'utf8'));
  return { byLevel, passages };
}

test('exam: buildExam — per-level composition matches the JLPT format facts (N5/N4/N3 fill every quota)', () => {
  const { byLevel, passages } = loadCorpus();
  for (const level of ['N5', 'N4', 'N3']) {
    const ex = buildExam(level, byLevel, passages, 42);
    assert.equal(ex.counts.kata, KATA_COUNT[level], `${level} 形式`);
    assert.equal(ex.counts.star, STAR_COUNT, `${level} ★`);
    assert.equal(ex.counts.passage, PASSAGE_COUNT, `${level} passage`);
    assert.deepEqual(ex.shortfall, { kata: 0, star: 0, passage: 0 }, `${level} no shortfall`);
    assert.equal(ex.items.length, KATA_COUNT[level] + STAR_COUNT + PASSAGE_COUNT, `${level} total`);
    assert.equal(ex.budgetSec, ex.items.length * 60, `${level} budget = 1min/item`);
    // every item is well-formed for its format
    for (const it of ex.items) {
      if (it.format === 'kata') { assert.equal(it.mcq.options.length, 4); assert.equal(it.mcq.options[it.mcq.correct], it.pattern); }
      else if (it.format === 'star') { assert.equal(it.scramble.chunks.length, 4); assert.equal(it.scramble.order.length, 4); }
      else if (it.format === 'passage') { assert.ok(it.blank.options.includes(it.blank.answer), 'answer in options'); }
      else assert.fail('unknown format ' + it.format);
    }
  }
});

test('exam: buildExam — N2/N1 fill their full passage quota (R14 banks landed)', () => {
  const { byLevel, passages } = loadCorpus();
  for (const level of ['N2', 'N1']) {
    const ex = buildExam(level, byLevel, passages, 7);
    assert.equal(ex.counts.kata, KATA_COUNT[level], `${level} 形式`);
    assert.equal(ex.counts.star, STAR_COUNT, `${level} ★`);
    assert.equal(ex.counts.passage, PASSAGE_COUNT, `${level} now fills all 5 passage items`);
    assert.equal(ex.shortfall.passage, 0, `${level} no longer has a passage gap`);
    assert.equal(ex.items.length, KATA_COUNT[level] + STAR_COUNT + PASSAGE_COUNT, `${level} full-length mock`);
  }
});

test('exam: buildExam — empty passages arg still degrades gracefully (shortfall path)', () => {
  const { byLevel } = loadCorpus();
  const ex = buildExam('N2', byLevel, [], 7);
  assert.equal(ex.counts.passage, 0);
  assert.equal(ex.shortfall.passage, PASSAGE_COUNT);
  assert.ok(ex.items.every(it => it.format !== 'passage'));
});

test('exam: buildExam — deterministic by seed; different seed → different draw', () => {
  const { byLevel, passages } = loadCorpus();
  assert.deepEqual(buildExam('N5', byLevel, passages, 123), buildExam('N5', byLevel, passages, 123));
  const a = buildExam('N5', byLevel, passages, 1).items.map(i => i.pointId || (i.passage && i.passage.id));
  const b = buildExam('N5', byLevel, passages, 2).items.map(i => i.pointId || (i.passage && i.passage.id));
  assert.notDeepEqual(a, b);
});

test('exam: buildExam — empty passages arg still yields a full 形式+★ mock with a passage shortfall', () => {
  const { byLevel } = loadCorpus();
  const ex = buildExam('N3', byLevel, [], 5);
  assert.equal(ex.counts.kata, KATA_COUNT.N3);
  assert.equal(ex.counts.star, STAR_COUNT);
  assert.equal(ex.counts.passage, 0);
  assert.equal(ex.shortfall.passage, PASSAGE_COUNT);
});

test('exam: scoreExam — raw + per-format + all-correct/all-wrong', () => {
  const questions = [
    { format: 'kata', pattern: '〜ように', optionClusters: { '〜ために': 'n5-b' }, mcq: { options: ['〜ように', '〜ために', '〜のに', '〜そうに'], correct: 0 } },
    { format: 'kata', pattern: '〜ために', optionClusters: { '〜ように': 'n5-a' }, mcq: { options: ['〜ために', '〜ように', '〜のに', '〜だけ'], correct: 0 } },
    { format: 'star', scramble: { order: [2, 0, 3, 1] } },
    { format: 'passage', blank: { answer: 'に', options: ['に', 'で', 'を', 'へ'] } },
    { format: 'passage', blank: { answer: 'だけ', options: ['だけ', 'しか', 'まで', 'ごろ'] } },
  ];
  // all correct
  const allRight = [0, 0, [2, 0, 3, 1], 0, 0];
  let r = scoreExam(allRight, questions);
  assert.equal(r.raw, 5); assert.equal(r.total, 5);
  assert.deepEqual(r.byFormat, { kata: { correct: 2, total: 2 }, star: { correct: 1, total: 1 }, passage: { correct: 2, total: 2 } });
  assert.deepEqual(r.byCluster, {});
  // all wrong / unanswered
  const allWrong = [1, 3, [0, 1, 2, 3], 1, null];
  r = scoreExam(allWrong, questions);
  assert.equal(r.raw, 0);
  assert.deepEqual(r.byFormat, { kata: { correct: 0, total: 2 }, star: { correct: 0, total: 1 }, passage: { correct: 0, total: 2 } });
  assert.equal(r.skipped, 1, 'the one null answer is counted as skipped');
  // a skipped (blank) 文法形式 item is NOT attributed to a trap cluster — only real mis-picks are
  const rSkip = scoreExam([null, null, null, null, null], questions);
  assert.equal(rSkip.skipped, 5);
  assert.deepEqual(rSkip.byCluster, {}, 'blanks never populate a confusable trap bucket');
});

test('exam: scoreExam — byCluster attributes a wrong 形式 pick to the confusable cluster (else other)', () => {
  const questions = [
    { format: 'kata', pattern: '〜ように', optionClusters: { '〜ために': 'n5-b' }, mcq: { options: ['〜ように', '〜ために', '〜のに', '〜そうに'], correct: 0 } },
  ];
  // picked 〜ために (index 1) — a known confusable → cluster n5-b
  let r = scoreExam([1], questions);
  assert.equal(r.raw, 0);
  assert.equal(r.byCluster['n5-b'].count, 1);
  assert.equal(r.byCluster['n5-b'].chosen, '〜ために');
  // picked 〜そうに (index 3) — a plain distractor, not in optionClusters → 'other'
  r = scoreExam([3], questions);
  assert.equal(r.byCluster.other.count, 1);
});

test('exam: examBand — directional band thresholds', () => {
  assert.deepEqual(examBand(0, 10), { pct: 0, label: 'Well below' });
  assert.deepEqual(examBand(5, 10), { pct: 50, label: 'Approaching' });
  assert.deepEqual(examBand(7, 10), { pct: 70, label: 'Borderline' });
  assert.deepEqual(examBand(8, 10), { pct: 80, label: 'On track' });
  assert.deepEqual(examBand(10, 10), { pct: 100, label: 'Strong' });
  assert.deepEqual(examBand(0, 0), { pct: 0, label: 'Well below' });
});

test('exam: recordExam — pure append, bounded ring, initialises from a state without examLog', () => {
  const s0 = {};                                     // pre-R13 state shape, no examLog
  const e1 = { level: 'N3', date: '2026-11-01', raw: 15, total: 26, byFormat: {} };
  const s1 = recordExam(s0, e1);
  assert.deepEqual(s1.examLog, [e1]);
  assert.deepEqual(s0, {}, 'input not mutated');
  const s2 = recordExam(s1, { level: 'N3', date: '2026-11-08', raw: 18, total: 26, byFormat: {} });
  assert.equal(s2.examLog.length, 2);
  // bounded: 120 appends keep only the last 100
  let s = {};
  for (let i = 0; i < 120; i++) s = recordExam(s, { level: 'N3', date: 'd' + i, raw: i, total: 26, byFormat: {} });
  assert.equal(s.examLog.length, 100);
  assert.equal(s.examLog[0].date, 'd20');
  assert.equal(s.examLog[99].date, 'd119');
});

// ---- lib/itinerary.js — Hokkaido leg-window logic ------------------------------------------
const ITIN = { days: [
  { date: '2026-07-18' }, { date: '2026-07-19' }, { date: '2026-07-20' }, { date: '2026-07-21' },
  { date: '2026-07-22' }, { date: '2026-07-23' }, { date: '2026-07-24' },
] };

test('addDaysISO shifts UTC-stably and tolerates junk', () => {
  assert.equal(addDaysISO('2026-07-18', -3), '2026-07-15');
  assert.equal(addDaysISO('2026-07-31', 1), '2026-08-01');
  assert.equal(addDaysISO('nope', 1), 'nope');
});

test('legStatus hides before the lead-in and after the trip', () => {
  assert.equal(legStatus(ITIN, '2026-07-14'), null);          // >3 days before start → hidden
  assert.equal(legStatus(ITIN, '2026-07-25'), null);          // past the last day → hidden
  assert.equal(legStatus(null, '2026-07-20'), null);          // no data → hidden
  assert.equal(legStatus({ days: [] }, '2026-07-20'), null);
});

test('legStatus phases: lead-in / during / last', () => {
  const before = legStatus(ITIN, '2026-07-16');               // within lead-in, before start
  assert.equal(before.phase, 'before');
  assert.equal(before.todayIdx, -1);
  const during = legStatus(ITIN, '2026-07-20');
  assert.equal(during.phase, 'during');
  assert.equal(during.todayIdx, 2);
  const last = legStatus(ITIN, '2026-07-24');
  assert.equal(last.phase, 'last');
  assert.equal(last.todayIdx, 6);
});

test('focusDays picks today+tomorrow, clamps at the ends', () => {
  assert.deepEqual(focusDays(legStatus(ITIN, '2026-07-16')), [0]);       // lead-in → preview day 1
  assert.deepEqual(focusDays(legStatus(ITIN, '2026-07-20')), [2, 3]);    // during → today + tomorrow
  assert.deepEqual(focusDays(legStatus(ITIN, '2026-07-24')), [6]);       // last day → just today
  assert.deepEqual(focusDays(null), []);
});

// ---- lib/itinerary.js — day-plan seeding (itineraryDay / itineraryStops) --------------------
const ITIN2 = { days: [
  { date: '2026-07-20', base: 'Furano (day trip)', schedule: [
    { t: '08:12', what: 'Train Furano → Biei', note: 'arr ~08:50' },
    { t: '~15:00', what: 'Lunch at Biei Senka' },
    { t: 'the hills', what: 'Patchwork Road by e-bike', note: '~2 hr loop' },
    { t: 'evening', what: 'Train home' },
  ] },
] };

test('itineraryDay finds a day by ISO date, else null', () => {
  assert.equal(itineraryDay(ITIN2, '2026-07-20').base, 'Furano (day trip)');
  assert.equal(itineraryDay(ITIN2, '2026-07-21'), null);
  assert.equal(itineraryDay(null, '2026-07-20'), null);
});

test('itineraryStops maps schedule → stop fields, times parsed, labels folded to note', () => {
  const stops = itineraryStops(itineraryDay(ITIN2, '2026-07-20'));
  assert.equal(stops.length, 4);
  assert.deepEqual(
    { name: stops[0].name, startTime: stops[0].startTime, note: stops[0].note, area: stops[0].area },
    { name: 'Train Furano → Biei', startTime: '08:12', note: 'arr ~08:50', area: 'Furano (day trip)' });
  assert.equal(stops[1].startTime, '15:00');            // "~15:00" → 15:00, tilde stripped
  assert.equal(stops[1].note, '');                       // no soft label, no note
  assert.equal(stops[2].startTime, '');                  // "the hills" is not a time
  assert.equal(stops[2].note, 'the hills · ~2 hr loop'); // soft label folded in with the note
  assert.equal(stops[3].note, 'evening');                // soft label alone
  assert.equal(itineraryStops(null).length, 0);
});

// ── K1: keyboard binding registry + pure resolver (lib/shortcuts.js) ──────────
import { BINDINGS, resolveKey } from '../docs/assets/lib/shortcuts.js';

test('shortcuts: BINDINGS is a well-formed registry (unique ids, non-empty keys)', () => {
  assert.ok(Array.isArray(BINDINGS) && BINDINGS.length > 0);
  const ids = BINDINGS.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length, 'binding ids are unique');
  for (const b of BINDINGS) {
    assert.ok(Array.isArray(b.keys) && b.keys.length, `${b.id} has keys`);
    assert.ok(typeof b.phase === 'string' && b.phase, `${b.id} has a phase`);
    assert.ok(typeof b.label === 'string' && b.label, `${b.id} has a label`);
  }
});

test('resolveKey: disabled → null (WCAG 2.1.4 turn-off)', () => {
  assert.equal(resolveKey({ key: '3', phase: 'graded', targetKind: 'button', enabled: false }), null);
  assert.equal(resolveKey({ key: 'Enter', phase: 'input', targetKind: 'input', enabled: false }), null);
});

test('resolveKey: composing → null (never command mid-変換)', () => {
  assert.equal(resolveKey({ key: '3', phase: 'graded', targetKind: 'button', composing: true, enabled: true }), null);
  assert.equal(resolveKey({ key: 'Enter', phase: 'input', targetKind: 'input', composing: true, enabled: true }), null);
});

test('resolveKey: a printable single-char key over a text field types, never commands', () => {
  // digit/letter must fall through to the field (return null) while the kana input is focused
  assert.equal(resolveKey({ key: '3', phase: 'graded', targetKind: 'input', enabled: true }), null);
  assert.equal(resolveKey({ key: '1', phase: 'graded', targetKind: 'input', enabled: true }), null);
  // …but Enter is NOT a printable key, so it still commands inside the input (that is how submit fires)
  assert.equal(resolveKey({ key: 'Enter', phase: 'input', targetKind: 'input', enabled: true }), 'submit');
});

test('resolveKey: Enter/Space on a focused BUTTON → null (native activation, no double-fire)', () => {
  assert.equal(resolveKey({ key: 'Enter', phase: 'graded', targetKind: 'button', enabled: true }), null);
  assert.equal(resolveKey({ key: 'Enter', phase: 'close', targetKind: 'button', enabled: true }), null);
  assert.equal(resolveKey({ key: ' ', phase: 'wrong', targetKind: 'button', enabled: true }), null);
  // a digit grade key is NOT native-activating, so it still resolves even on a focused button
  assert.equal(resolveKey({ key: '3', phase: 'graded', targetKind: 'button', enabled: true }), 'grade-3');
});

test('resolveKey: correct (key, phase) → actionId mapping', () => {
  assert.equal(resolveKey({ key: 'Enter', phase: 'input', targetKind: 'other', enabled: true }), 'submit');
  assert.equal(resolveKey({ key: '1', phase: 'graded', targetKind: 'other', enabled: true }), null); // correct answers have no Again
  assert.equal(resolveKey({ key: '2', phase: 'graded', targetKind: 'other', enabled: true }), 'grade-2');
  assert.equal(resolveKey({ key: '3', phase: 'graded', targetKind: 'other', enabled: true }), 'grade-3');
  assert.equal(resolveKey({ key: '4', phase: 'graded', targetKind: 'other', enabled: true }), 'grade-4');
  assert.equal(resolveKey({ key: 'Enter', phase: 'graded', targetKind: 'other', enabled: true }), 'grade-default');
  assert.equal(resolveKey({ key: 'Enter', phase: 'wrong', targetKind: 'other', enabled: true }), 'advance');
  assert.equal(resolveKey({ key: ' ', phase: 'wrong', targetKind: 'other', enabled: true }), 'advance');
  assert.equal(resolveKey({ key: 'Enter', phase: 'close', targetKind: 'other', enabled: true }), 'accept');
  assert.equal(resolveKey({ key: 'Escape', phase: 'close', targetKind: 'other', enabled: true }), 'reject');
});

test('resolveKey: 1 has no study binding in any phase — gestures owns route-nav 1-9', () => {
  assert.equal(resolveKey({ key: '1', phase: 'graded', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: '1', phase: 'input', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: '1', phase: 'idle', targetKind: 'other', enabled: true }), null);
});

test('resolveKey: unknown key or phase → null', () => {
  assert.equal(resolveKey({ key: 'q', phase: 'graded', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: '5', phase: 'graded', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: 'Enter', phase: 'nonsense', targetKind: 'other', enabled: true }), null);
});

// ── K2a: reviewer audio power keys (R replay, A autoplay) ──────────────────────
test('resolveKey (K2a): R replays audio ONLY post-answer (graded/wrong), never pre-answer', () => {
  assert.equal(resolveKey({ key: 'r', phase: 'graded', targetKind: 'other', enabled: true }), 'speak-graded');
  assert.equal(resolveKey({ key: 'R', phase: 'wrong', targetKind: 'other', enabled: true }), 'speak-wrong');
  assert.equal(resolveKey({ key: 'r', phase: 'wrong', targetKind: 'button', enabled: true }), 'speak-wrong'); // a bare letter still commands on a focused button
  // no leak: R is unbound pre-answer (would speak the answer-bearing sentence aloud)
  assert.equal(resolveKey({ key: 'r', phase: 'input', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: 'r', phase: 'close', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: 'r', phase: 'idle', targetKind: 'other', enabled: true }), null);
});

test('resolveKey (K2a): A toggles autoplay ONLY on the course home (idle) where the visible toggle lives', () => {
  assert.equal(resolveKey({ key: 'a', phase: 'idle', targetKind: 'other', enabled: true }), 'autoplay');
  assert.equal(resolveKey({ key: 'A', phase: 'idle', targetKind: 'other', enabled: true }), 'autoplay');
  // scoped to idle: mid-session A is unbound — the autoplay tap control (.stu-tts-toggle) only
  // exists on the course home, so binding A there keeps keyboard/touch parity (Principle 5)
  assert.equal(resolveKey({ key: 'A', phase: 'graded', targetKind: 'button', enabled: true }), null);
  assert.equal(resolveKey({ key: 'a', phase: 'wrong', targetKind: 'other', enabled: true }), null);
  // a bare letter must still type into the kana field
  assert.equal(resolveKey({ key: 'a', phase: 'input', targetKind: 'input', enabled: true }), null);
  // WCAG turn-off silences both audio keys
  assert.equal(resolveKey({ key: 'a', phase: 'idle', targetKind: 'other', enabled: false }), null);
  assert.equal(resolveKey({ key: 'r', phase: 'graded', targetKind: 'other', enabled: false }), null);
});

import { recurOccurrences, isRecurring } from '../docs/assets/lib/recur.js';
test('recur: a non-recurring event passes through as one span (multi-day preserved)', () => {
  const e = { date: '2026-07-20', endDate: '2026-07-28' };
  assert.equal(isRecurring(e), false);
  assert.deepEqual(recurOccurrences(e, '2026-07-01', '2026-08-31'), [{ date: '2026-07-20', endDate: '2026-07-28' }]);
});
test('recur: yearly repeats the month-day each year within the window, never before the anchor', () => {
  const e = { date: '2026-08-08', recur: 'yearly' };
  const occ = recurOccurrences(e, '2025-01-01', '2029-12-31').map(o => o.date);
  assert.deepEqual(occ, ['2026-08-08', '2027-08-08', '2028-08-08', '2029-08-08']);   // no 2025 (before anchor)
  assert.equal(recurOccurrences(e, '2026-08-08', '2026-08-08').length, 1);           // matches its own day
  assert.equal(recurOccurrences(e, '2026-08-09', '2026-12-31').length, 0);           // not on a non-anniversary day
});
test('recur: yearly Feb-29 anchor clamps to Feb-28 in common years', () => {
  const e = { date: '2028-02-29', recur: 'yearly' };
  const occ = recurOccurrences(e, '2028-01-01', '2030-12-31').map(o => o.date);
  assert.deepEqual(occ, ['2028-02-29', '2029-02-28', '2030-02-28']);
});
test('recur: monthly clamps Jan-31 to short months and stays in window', () => {
  const e = { date: '2026-01-31', recur: 'monthly' };
  const occ = recurOccurrences(e, '2026-01-01', '2026-04-30').map(o => o.date);
  assert.deepEqual(occ, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});
test('recur: weekly steps every 7 days and fast-forwards into a later window', () => {
  const e = { date: '2026-07-01', recur: 'weekly' };
  assert.deepEqual(recurOccurrences(e, '2026-07-01', '2026-07-22').map(o => o.date), ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22']);
  const far = recurOccurrences(e, '2026-08-01', '2026-08-14').map(o => o.date);
  assert.deepEqual(far, ['2026-08-05', '2026-08-12']);   // aligned to the weekly cadence, not the window edge
});
test('recur: occurrences are single-day (no endDate) and reversed windows yield nothing', () => {
  const e = { date: '2026-08-08', recur: 'yearly' };
  assert.equal(recurOccurrences(e, '2026-01-01', '2027-12-31').every(o => o.endDate === ''), true);
  assert.deepEqual(recurOccurrences(e, '2027-01-01', '2026-01-01'), []);
});

// ── K2b: undo the last grade (Z) + session wrap-up (Enter) ────────────────────
test('undoReview: review()→undo round-trips to a state deep-equal to the pre-grade state', () => {
  const s0 = review(newState(T0), 'n5-1', { pass: true, grade: 3, exampleIdx: 0 }, T0 + DAY);
  const snap = structuredClone(s0);                       // the shell snapshots BEFORE the next grade
  const s1 = review(s0, 'n5-1', { pass: false, grade: 1 }, T0 + 2 * DAY);   // a lapse: really moves D/S/lapses/due
  assert.deepStrictEqual(s0, snap, 'review() did not mutate its input (immutable)');
  assert.notDeepStrictEqual(s1.points['n5-1'], s0.points['n5-1'], 'the grade actually changed the point');
  const undone = undoReview(snap);
  assert.deepStrictEqual(undone, s0, 'undo restores the pre-grade state byte-for-byte');
  // the restore is a fresh clone — mutating it must not reach back into the snapshot (no aliasing)
  undone.points['n5-1'].D = 99;
  assert.notEqual(snap.points['n5-1'].D, 99);
});

test('undoReview: session position + results revert together with the graded point', () => {
  let s = sessionStart(review(newState(T0), 'n5-1', { pass: true, grade: 3 }, T0), ['n5-1', 'n5-2']);
  const snap = structuredClone(s);                        // pos 0, no results
  s = review(s, 'n5-1', { pass: true, grade: 4 }, T0 + DAY);
  s = sessionRecord(s, { id: 'n5-1', grade: 4, ok: true });   // pos → 1, one result
  assert.equal(s.session.pos, 1);
  assert.equal(s.session.results.length, 1);
  const undone = undoReview(snap);
  assert.equal(undone.session.pos, 0, 'pos reverted');
  assert.equal(undone.session.results.length, 0, 'results reverted');
  assert.deepStrictEqual(undone, snap);
});

test('resolveKey (K2b): Z undoes the last grade in the reveal phases only', () => {
  assert.equal(resolveKey({ key: 'z', phase: 'graded', targetKind: 'other', enabled: true }), 'undo-graded');
  assert.equal(resolveKey({ key: 'Z', phase: 'wrong', targetKind: 'other', enabled: true }), 'undo-wrong');
  // a bare letter still commands on a focused grade/Continue button
  assert.equal(resolveKey({ key: 'z', phase: 'graded', targetKind: 'button', enabled: true }), 'undo-graded');
  // NOT during input ("nothing to undo yet"), and never over the focused kana field (rule 3)
  assert.equal(resolveKey({ key: 'z', phase: 'input', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: 'z', phase: 'graded', targetKind: 'input', enabled: true }), null);
  // WCAG turn-off silences it; not a command key on the course home or summary
  assert.equal(resolveKey({ key: 'z', phase: 'graded', targetKind: 'other', enabled: false }), null);
  assert.equal(resolveKey({ key: 'z', phase: 'idle', targetKind: 'other', enabled: true }), null);
  assert.equal(resolveKey({ key: 'z', phase: 'summary', targetKind: 'other', enabled: true }), null);
});

test('resolveKey (K2b): summary Enter → native on the focused button, else routed to summary-done', () => {
  // focus on the Done button → null so the browser activates it natively (no double-fire)
  assert.equal(resolveKey({ key: 'Enter', phase: 'summary', targetKind: 'button', enabled: true }), null);
  // focus elsewhere → the registry routes Enter to the wrap-up action
  assert.equal(resolveKey({ key: 'Enter', phase: 'summary', targetKind: 'other', enabled: true }), 'summary-done');
});

// ── K3: the ? sheet renders FROM the registry — drift guard (sheet ⇔ registry ⇔ dispatcher) ─────
import { helpSheetModel, keyGlyph } from '../docs/assets/lib/shortcuts.js';

test('K3 drift: the sheet documents EVERY binding, invents none (sheet ⇔ registry)', () => {
  const model = helpSheetModel(BINDINGS, { enabled: true });
  const covered = model.flatMap(g => g.rows.flatMap(r => r.ids));
  // every binding id is documented, and nothing outside the registry appears
  assert.deepEqual(new Set(covered), new Set(BINDINGS.map(b => b.id)));
});

test('K3 drift: each binding lands in exactly one sheet group', () => {
  const model = helpSheetModel(BINDINGS, { enabled: true });
  for (const b of BINDINGS) {
    const groupsWith = model.filter(g => g.rows.some(r => r.ids.includes(b.id)));
    assert.equal(groupsWith.length, 1, `${b.id} appears in exactly one group`);
  }
});

test('K3 drift: the sheet renders no key that is not in the registry', () => {
  const registryKeys = new Set(BINDINGS.flatMap(b => b.keys));
  const model = helpSheetModel(BINDINGS, { enabled: true });
  for (const g of model) for (const r of g.rows) for (const k of r.keys) {
    assert.ok(registryKeys.has(k), `sheet key ${k} is not declared in BINDINGS`);
  }
});

test('K3 drift: the page-jump binding expands to the live nav labels when pages are supplied', () => {
  const pages = [{ key: '1', label: 'Home' }, { key: '2', label: 'Calendar' }];
  const model = helpSheetModel(BINDINGS, { enabled: true, pages });
  const nav = model.find(g => g.surface === 'nav');
  assert.ok(nav.rows.some(r => r.keys[0] === '1' && r.label === 'Home'));
  assert.ok(nav.rows.some(r => r.keys[0] === '2' && r.label === 'Calendar'));
  // still exactly one group for nav-page even when expanded to many rows
  assert.equal(model.filter(g => g.rows.some(r => r.ids.includes('nav-page'))).length, 1);
});

test('K3 drift: every routed (resolveKey-dispatched) binding actually resolves (registry ⇔ dispatcher)', () => {
  const routed = BINDINGS.filter(b => b.routed !== false);
  assert.ok(routed.length >= 12, 'the study surface is resolveKey-routed');
  for (const b of routed) {
    // a routed binding must resolve to its own id for its first key + phase (targetKind:'other' so
    // Enter/Space still command). This is what catches a key added to the dispatcher but not the
    // sheet, or removed from one side only.
    const id = resolveKey({ key: b.keys[0], phase: b.phase, targetKind: 'other', enabled: true });
    assert.equal(id, b.id, `${b.id} resolves through resolveKey`);
    assert.ok(b.surface === 'study', `${b.id} routed bindings live on the study surface`);
  }
});

test('K3 drift: declarative (routed:false) bindings are marked and never mistaken for routed', () => {
  const declarative = BINDINGS.filter(b => b.routed === false);
  // the global/nav + calendar/checklist + modifier combos are all declarative documentation.
  // K5.1 exception: 'pick-option' documents the cardCtl-owned in-card digits (MCQ pick / tile
  // place) — study-surface for the sheet, but dispatched by the card controller, never resolveKey.
  assert.ok(declarative.length > 0);
  for (const b of declarative) {
    if (b.id === 'pick-option') continue;
    assert.notEqual(b.surface, 'study');
  }
  // resolveKey matches generically by (key, phase) over ALL of BINDINGS (the K4a exam-phase lesson),
  // so the entry WOULD resolve if handed phase 'card' — but the runtime never passes it: study.js's
  // cardCtl short-circuit returns before the resolver whenever an MCQ/scramble card is live.
  assert.equal(resolveKey({ key: '1', phase: 'card', targetKind: 'other', composing: false, enabled: true }), 'pick-option');
});

// ── K4a: mock-exam keyboard bindings (declarative, handler-owned by study-exam.js) ────
test('K4a: the mock-exam bindings are declarative, documented, and in their own sheet group', () => {
  const exam = BINDINGS.filter(b => b.surface === 'exam');
  assert.ok(exam.length >= 6, 'the mock exam surface carries its bindings (flag/prev/next/pick/palette/submit/exit)');
  // handler-owned (study-exam.js onKey + a run-container listener), never resolveKey-DISPATCHED: the
  // exam runs as activeFlow, so study.js returns before the resolver — phase 'exam' is never passed to
  // resolveKey/runAction. These entries exist only so the ? sheet documents them from one registry.
  for (const b of exam) {
    assert.equal(b.routed, false, `${b.id} is handler-owned (routed:false)`);
    assert.notEqual(b.surface, 'study', `${b.id} is NOT the resolveKey-routed study surface`);
  }
  // the K3 sheet documents every one of them, in exactly one "In a mock exam" group
  const model = helpSheetModel(BINDINGS, { enabled: true });
  const group = model.find(g => g.surface === 'exam');
  assert.ok(group && /mock exam/i.test(group.title), 'the exam bindings render under a mock-exam sheet group');
  const covered = new Set(group.rows.flatMap(r => r.ids));
  for (const b of exam) assert.ok(covered.has(b.id), `${b.id} appears in the exam sheet group`);
  // the flag key F and the ←/→ nav keys are surfaced
  assert.ok(exam.some(b => b.keys.includes('f') && b.keys.includes('F')), 'F flags a question');
  assert.ok(exam.some(b => b.keys.includes('ArrowLeft')) && exam.some(b => b.keys.includes('ArrowRight')), '←/→ move between questions');
});

// ── K4b: heat-grid roving bindings (declarative, handler-owned by study-stats.js) ────
test('K4b: the mastery-map bindings are declarative, documented, and in their own sheet group', () => {
  const stats = BINDINGS.filter(b => b.surface === 'stats');
  assert.ok(stats.length >= 5, 'the mastery map carries its roving-grid bindings (move/row-ends/ends/page/open)');
  // handler-owned (study-stats.js's grid-container listener), never resolveKey-DISPATCHED: the grid runs
  // as activeFlow, so study.js returns before the resolver — phase 'stats' is never passed to resolveKey.
  for (const b of stats) {
    assert.equal(b.routed, false, `${b.id} is handler-owned (routed:false)`);
    assert.notEqual(b.surface, 'study', `${b.id} is NOT the resolveKey-routed study surface`);
  }
  // every key is a WCAG-2.1.4-EXEMPT named key (or a modifier combo) — no bare printable single char.
  for (const b of stats) for (const k of b.keys) {
    const named = k.length > 1 || k === ' ';   // ' ' (Space) is a named key too, exempt on a focused button
    assert.ok(named, `${b.id} key ${JSON.stringify(k)} is a named/exempt key, never a bare printable char`);
  }
  // the K3 sheet documents every one of them, in exactly one "mastery map" group
  const model = helpSheetModel(BINDINGS, { enabled: true });
  const group = model.find(g => g.surface === 'stats');
  assert.ok(group && /mastery map/i.test(group.title), 'the stats bindings render under a mastery-map sheet group');
  const covered = new Set(group.rows.flatMap(r => r.ids));
  for (const b of stats) assert.ok(covered.has(b.id), `${b.id} appears in the stats sheet group`);
  // the arrow-move + Ctrl+Home/End + PageUp/Down keys are surfaced
  assert.ok(stats.some(b => b.keys.includes('ArrowUp') && b.keys.includes('ArrowDown')), '↑/↓ move vertically');
  assert.ok(stats.some(b => b.keys.includes('PageUp') && b.keys.includes('PageDown')), 'PageUp/Down jump levels');
  assert.ok(stats.some(b => b.keys.includes('⌃Home') && b.keys.includes('⌃End') && b.mod === true), 'Ctrl+Home/End are modifier combos');
  // handler-owned means study.js never PASSES phase 'stats' to resolveKey (the activeFlow path returns
  // before the resolver); the grid-container listener owns these keys directly. That the dispatcher is
  // never invoked for 'stats' is a dispatch-site fact, mirrored by the same routed:false marking K4a uses.
});

test('K3: keyGlyph maps raw event keys to readable chips, passes combos through', () => {
  assert.equal(keyGlyph('Enter'), '⏎');
  assert.equal(keyGlyph(' '), 'Space');
  assert.equal(keyGlyph('ArrowLeft'), '←');
  assert.equal(keyGlyph('-'), '−');
  assert.equal(keyGlyph('⌘K'), '⌘K');   // mod-combo display strings pass through untouched
  assert.equal(keyGlyph('2'), '2');
  assert.equal(keyGlyph('PageUp'), 'PgUp');    // K4b heat-grid keys
  assert.equal(keyGlyph('PageDown'), 'PgDn');
  assert.equal(keyGlyph('⌃Home'), '⌃Home');   // Ctrl combo display string passes through
});

// ── K5: palette route→key map + auto-advance eligibility ──────────────────────
import { routeKeys } from '../docs/assets/lib/palette.js';
import { shouldAutoAdvance } from '../docs/assets/lib/shortcuts.js';

test('routeKeys: first 9 visible routes get 1–9, emergency gets 0, rest none', () => {
  const vr = ['dashboard', 'calendar', 'plan', 'map', 'explore', 'eats', 'people', 'checklist', 'budget', 'rooms', 'emergency'];
  const m = routeKeys(vr);
  assert.equal(m.dashboard, '1');
  assert.equal(m.calendar, '2');
  assert.equal(m.budget, '9');       // 9th visible route
  assert.equal(m.rooms, undefined);  // 10th — past the digit range, no key
  assert.equal(m.emergency, '0');    // always the 0 route (not in the first 9 here)
  assert.equal(m.study, undefined);  // hidden route — no direct key → no chip
});

test('routeKeys: emergency keeps its own digit when it lands in the first 9 (no 0 override)', () => {
  const vr = ['dashboard', 'emergency', 'calendar'];
  const m = routeKeys(vr);
  assert.equal(m.emergency, '2');    // earned a digit → not overwritten by 0
});

test('routeKeys: empty / non-array input → just the emergency 0 fallback', () => {
  assert.deepEqual(routeKeys([]), { emergency: '0' });
  assert.deepEqual(routeKeys(null), { emergency: '0' });
});

test('shouldAutoAdvance: fires only on a correct answer, opt-in on, non-gate', () => {
  assert.equal(shouldAutoAdvance({ enabled: true, correct: true, gate: false }), true);
  assert.equal(shouldAutoAdvance({ enabled: false, correct: true, gate: false }), false);  // opt-in off
  assert.equal(shouldAutoAdvance({ enabled: true, correct: false, gate: false }), false);  // wrong answer never advances
  assert.equal(shouldAutoAdvance({ enabled: true, correct: true, gate: true }), false);    // gate cards excluded
  assert.equal(shouldAutoAdvance(), false);                                                // defaults → off
});

import { stripEmoji } from '../docs/assets/lib/dom.js';
test('stripEmoji removes pictographs/flags but keeps arrows, kana, punctuation', () => {
  assert.equal(stripEmoji('🎌 teamLab Planets'), 'teamLab Planets');
  assert.equal(stripEmoji('✈️ OZ271 SEA→ICN'), 'OZ271 SEA→ICN');
  assert.equal(stripEmoji('🇯🇵 Comiket C108'), 'Comiket C108');
  assert.equal(stripEmoji('Anniversary 💛'), 'Anniversary');
  assert.equal(stripEmoji('‹ Makoto Guesthouse → 10'), '‹ Makoto Guesthouse → 10');   // arrows/marks survive
  assert.equal(stripEmoji('渋谷 の カフェ'), '渋谷 の カフェ');                          // kana/kanji survive
  assert.equal(stripEmoji(''), '');
  assert.equal(stripEmoji(null), '');
});

import { dialHTML, dialsHTML, linkifyIntlPhones } from '../docs/assets/lib/emergency-render.js';
test('dialHTML builds a tel: target, esc()s, gates the note to hero tier', () => {
  const police = { num: '110', label: 'Police', note: 'Crime, theft & accidents.' };
  const hero = dialHTML(police, 'hero');
  assert.ok(hero.includes('href="tel:110"'));
  assert.ok(hero.includes('sos-dial--hero'));
  assert.ok(hero.includes('aria-label="Call Police, 110"'));
  assert.ok(hero.includes('Crime, theft'));                       // hero shows the note
  assert.ok(!dialHTML(police, 'sub').includes('sos-dial-note'));  // sub/compact hide it
  assert.ok(!dialHTML(police, 'compact').includes('sos-dial-note'));
  assert.equal(dialHTML({ num: '' }), '');                        // no number → nothing
  assert.equal(dialHTML(null), '');
  assert.ok(dialHTML({ num: '119', label: '<b>x</b>' }).includes('&lt;b&gt;'));  // esc'd
});
test('dialsHTML: hero-count splits tiers on the page, compact flattens for the pocket', () => {
  const nums = [{ num: '110', label: 'Police' }, { num: '119', label: 'Fire' },
    { num: '118', label: 'Coast Guard' }, { num: '', label: 'skip me' }];
  const page = dialsHTML(nums, { hero: 2 });
  assert.equal((page.match(/sos-dial--hero/g) || []).length, 2);
  assert.equal((page.match(/sos-dial--sub/g) || []).length, 1);   // 118; blank entry dropped
  const pocket = dialsHTML(nums, { compact: true });
  assert.equal((pocket.match(/sos-dial--compact/g) || []).length, 3);
  assert.ok(!pocket.includes('sos-dial--hero'));
  assert.equal(dialsHTML(null), '');
  assert.equal(dialsHTML([]), '');
});
test('linkifyIntlPhones links +-numbers, leaves postal/street codes alone', () => {
  const out = linkifyIntlPhones('+81-3-5412-6200 · 7-3-38 Akasaka, Tokyo 107-8503');
  assert.ok(out.includes('href="tel:+81-3-5412-6200"'));
  assert.ok(out.includes('>+81-3-5412-6200</a>'));
  assert.ok(!out.includes('tel:7-3-38'));       // street number stays text
  assert.ok(!out.includes('tel:107-8503'));     // postal code stays text
  const collect = linkifyIntlPhones('Ottawa +1-613-996-8885 (call collect)');
  assert.ok(collect.includes('href="tel:+1-613-996-8885"'));
  assert.ok(collect.includes('(call collect)'));
  assert.ok(linkifyIntlPhones('<script>').includes('&lt;script&gt;'));  // plain text esc'd
  assert.equal(linkifyIntlPhones(''), '');
  assert.equal(linkifyIntlPhones(null), '');
  // greedy-merge guard: a trailing space-separated digit run must NEVER fuse into the tel: target
  // (a corrupted dial number). Spaces terminate a match — spaced phones stay plain text (safe).
  const greedy = linkifyIntlPhones('+81-3-1234-5678 90 more');
  assert.ok(greedy.includes('href="tel:+81-3-1234-5678"'));
  assert.ok(!greedy.includes('tel:+81-3-1234-567890'));
  assert.ok(!linkifyIntlPhones('+81 3 5412 6200').includes('<a'));  // spaced → under-link, not corrupt
});
