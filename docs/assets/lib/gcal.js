'use strict';
// Pure Google Calendar object mapper.
// No DOM, no localStorage, no imports from app code.

/**
 * nextDayISO('YYYY-MM-DD') → 'YYYY-MM-DD' (UTC-safe +1 day)
 * Mirrors ics.js nextDay() to produce the exclusive end date for all-day events.
 */
export function nextDayISO(iso) {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * eventToGcal(ev) → { summary, location, description, start:{date}, end:{date} }
 * Maps a calendar event to a Google Calendar all-day event body.
 * end.date is exclusive (the day after endDate || date).
 * description field order: bookingNotes (baked) → note (user) → why (baked) → ''
 */
// The app is JST-centric — a `time` is a Tokyo wall-clock time — so timed events sync with an
// explicit Asia/Tokyo zone (Google places them correctly regardless of the viewer's timezone).
// Events with no `time` stay all-day (DATE, exclusive end), unchanged.
const TZ = 'Asia/Tokyo';
const hhmm = (t) => /^\d{1,2}:\d{2}$/.test(t || '') ? String(t).padStart(5, '0') : '';
function plusHour(dateISO, t) {   // end = +1h, rolling to the next day if it crosses midnight
  let [h, m] = t.split(':').map(Number); h += 1; let d = dateISO;
  if (h >= 24) { h -= 24; d = nextDayISO(dateISO); }
  return `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}
export function eventToGcal(ev) {
  const base = { summary: ev.title || '', location: ev.area || '', description: ev.bookingNotes || ev.note || ev.why || '' };
  const t = hhmm(ev.time);
  if (t) {
    const endT = hhmm(ev.endTime);
    return {
      ...base,
      start: { dateTime: `${ev.date}T${t}:00`, timeZone: TZ },
      end: { dateTime: endT ? `${ev.date}T${endT}:00` : plusHour(ev.date, t), timeZone: TZ },
    };
  }
  return { ...base, start: { date: ev.date }, end: { date: nextDayISO(ev.endDate || ev.date) } };
}

// --- Map helpers (immutable) ---

/**
 * getMapped(map, localId) → googleId | undefined
 * Returns the Google event ID previously stored for a local event ID.
 */
export function getMapped(map, localId) {
  return (map && map.events) ? map.events[localId] : undefined;
}

/**
 * setMapped(map, localId, googleId) → new map object
 * Returns a new map with the localId→googleId association added/updated.
 */
export function setMapped(map, localId, googleId) {
  return {
    ...map,
    events: { ...(map && map.events), [localId]: googleId },
  };
}

/**
 * forgetCalendar(map) → { calendarId: '', events: {} }
 * Returns a blank map (used when the user disconnects a calendar).
 */
export function forgetCalendar(_map) {
  return { calendarId: '', events: {} };
}
