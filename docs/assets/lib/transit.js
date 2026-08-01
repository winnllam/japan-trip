'use strict';
// Pure, offline travel-time ESTIMATOR between Tokyo neighbourhoods. No routing API (zero-dep,
// works offline): straight-line distance between neighbourhood centroids × a rail-derived
// factor + transfer overhead. Always presented as an estimate ("≈"), confidence medium —
// it is NOT a routed time; verify in a maps app. Unit-tested like dates.js / ics.js.

import { areaOf, centroid } from './geo.js';

const R = 6371;                     // km
const OVERHEAD = 11;                // door-to-door access + egress + initial wait (min)
const SLOPE = 2.1;                  // min per straight-line km (rail-derived ~2.1–2.2)
const TRANSFER = 5;                 // min per modelled transfer
const transfers = (km) => km < 1.5 ? 0 : (km < 7 ? 1 : 2);

// known express corridors the linear model overshoots (sorted "A|B" keys)
const OVERRIDE = {
  'Nakano|Shinjuku': 16, 'Koenji|Shinjuku': 17, 'Kichijoji|Shinjuku': 28,
  'Akihabara|Shinjuku': 20, 'Asakusa|Shibuya': 40,
};

export function haversineKm(a, b) {
  if (!a || !b) return 0;
  const rad = Math.PI / 180;
  const dφ = (b.lat - a.lat) * rad, dλ = (b.lng - a.lng) * rad;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// minutes between two neighbourhood names, using the tips.json areaGeo centroid map
export function estimateMinutes(areaA, areaB, areaGeo) {
  const a = areaOf(areaA), b = areaOf(areaB);
  if (a === b) return 10;                                  // same neighbourhood ≈ a walk
  const key = [a, b].sort().join('|');
  if (OVERRIDE[key] != null) return OVERRIDE[key];
  const km = haversineKm(centroid(areaGeo, a), centroid(areaGeo, b));
  return Math.round(OVERHEAD + SLOPE * km + TRANSFER * transfers(km));
}

// Minutes from an EXACT origin coordinate to a destination given as either a {lat,lng} or a
// neighbourhood name. Lets the "≈ from home" estimate anchor to the home pin's TRUE coords instead
// of a name→centroid lookup that misses when home sits in an area absent from the centroid table
// (e.g. Kikukawa/Sumida). Same rail-derived formula as estimateMinutes. Returns null when the origin
// has no usable coords, so callers can fall back to the name-based estimate.
export function estimateMinutesFromCoord(origin, dest, areaGeo) {
  const okPt = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number' && !isNaN(p.lat) && !isNaN(p.lng);
  if (!okPt(origin)) return null;
  const to = okPt(dest) ? dest : centroid(areaGeo, areaOf(dest));
  const km = haversineKm(origin, to);
  return Math.round(OVERHEAD + SLOPE * km + TRANSFER * transfers(km));
}

// honest display: floored at ≈10 min, rounded to 5-min buckets
export function format(m) { return m <= 10 ? '≈10 min' : '≈' + (Math.round(m / 5) * 5) + ' min'; }

// label for the connector between two stops
export function legLabel(stopA, stopB, areaGeo) {
  const a = areaOf(stopA.area), b = areaOf(stopB.area);
  const minutes = estimateMinutes(a, b, areaGeo);
  const same = a === b;
  const fuzzy = stopA.coordKind === 'approx' || stopB.coordKind === 'approx';
  return { text: format(minutes) + (same ? ' · same area' : ' · est.'), minutes, fuzzy };
}

// total estimated transit minutes across an ordered stop list (sum of legs)
export function totalTransit(stops, areaGeo) {
  let sum = 0;
  for (let i = 1; i < stops.length; i++) sum += estimateMinutes(stops[i - 1].area, stops[i].area, areaGeo);
  return sum;
}

// distinct neighbourhoods touched (for the footer)
export function areaCount(stops) { return new Set(stops.map(s => areaOf(s.area))).size; }
