// Cloudflare Worker — a tiny shared JSON store for the Japan trip dashboard.
//
// One editable "trip" = one document, keyed by a random id carried in the app's ?trip=<id> link.
// Anyone with the link can read AND write, so only share it with people you trust. Writes use an
// optimistic-concurrency `rev` counter: a PUT may send `baseRev`, and if the stored rev has moved
// on since, the write is rejected with 409 (the client re-pulls).
//
// Read-only calendar feed (share your events without giving away the trip):
//   PUT  /<tripId>/publish-calendar   → mints a separate public calendar id (calId) → { calId }
//   GET  /cal/<calId>.json            → { updatedAt, events: [...] }   (CORS *, read-only)
//   GET  /cal/<calId>.ics             → an iCalendar feed              (CORS *, read-only)
// The calId only unlocks the calendar (never the full doc, never writes). Revoke by re-publishing
// (mints a new calId) — the old one keeps working until its KV entry is deleted.
//
// Binding: a KV namespace bound as `TRIPS` (see wrangler.toml + README.md).

const ALLOW = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://winnllam.github.io',
];
const ID_RE = /^[a-z0-9]{6,64}$/;
const MAX_BYTES = 3 * 1024 * 1024;

function cors(origin) {
  const allow = ALLOW.includes(origin) ? origin : ALLOW[ALLOW.length - 1];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
}
const PUBLIC_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) } });
}

// ---- iCalendar feed --------------------------------------------------------
const icsEsc = (s) => String(s == null ? '' : s).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
const ymd = (d) => String(d || '').slice(0, 10).replace(/-/g, '');
function nextDayYmd(d) { const t = new Date((d || '').slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10).replace(/-/g, ''); }
const stamp = (iso) => (iso ? new Date(iso) : new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
function toICS(events, name, updatedAt) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//japan-trip//calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc(name), 'X-WR-TIMEZONE:Asia/Tokyo'];
  const ds = stamp(updatedAt);
  for (const e of events) {
    const start = (e.date || '').slice(0, 10); if (!start) continue;
    L.push('BEGIN:VEVENT', 'UID:' + icsEsc((e.id || start)) + '@japan-trip', 'DTSTAMP:' + ds);
    if (e.time && /^\d{1,2}:\d{2}$/.test(e.time)) {
      const [h, m] = e.time.split(':'); const hh = h.padStart(2, '0');
      L.push('DTSTART;TZID=Asia/Tokyo:' + ymd(start) + 'T' + hh + m + '00');
      const endH = String(Math.min(23, (+hh) + 1)).padStart(2, '0');
      L.push('DTEND;TZID=Asia/Tokyo:' + ymd(start) + 'T' + endH + m + '00');
    } else {
      L.push('DTSTART;VALUE=DATE:' + ymd(start));
      L.push('DTEND;VALUE=DATE:' + (e.endDate ? ymd(e.endDate) : nextDayYmd(start)));
    }
    L.push('SUMMARY:' + icsEsc(e.title));
    if (e.area) L.push('LOCATION:' + icsEsc(e.area));
    const desc = e.note || e.bookingNotes; if (desc) L.push('DESCRIPTION:' + icsEsc(desc));
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const seg = url.pathname.replace(/^\/+/, '').split('/');

    if (request.method === 'OPTIONS') {
      const headers = seg[0] === 'cal' ? PUBLIC_CORS : cors(origin);
      return new Response(null, { status: 204, headers });
    }

    // ---- public read-only calendar feed: GET /cal/<calId>[.json|.ics] ----
    if (seg[0] === 'cal') {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: PUBLIC_CORS });
      let calId = seg[1] || ''; let fmt = 'json';
      if (calId.endsWith('.ics')) { fmt = 'ics'; calId = calId.slice(0, -4); }
      else if (calId.endsWith('.json')) { calId = calId.slice(0, -5); }
      if (!ID_RE.test(calId)) return new Response('bad calendar id', { status: 400, headers: PUBLIC_CORS });
      const tripId = await env.TRIPS.get('cal:' + calId);
      if (!tripId) return new Response('not found', { status: 404, headers: PUBLIC_CORS });
      const rawDoc = await env.TRIPS.get(tripId);
      const doc = rawDoc ? JSON.parse(rawDoc) : null;
      let events = [];
      try { events = doc && doc.data && doc.data['jwh-events-v1'] ? JSON.parse(doc.data['jwh-events-v1']) : []; } catch { events = []; }
      if (fmt === 'ics') {
        return new Response(toICS(events, 'My Japan Trip', doc && doc.updatedAt), { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...PUBLIC_CORS } });
      }
      return new Response(JSON.stringify({ updatedAt: doc && doc.updatedAt, events }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...PUBLIC_CORS } });
    }

    // ---- trip document routes ----
    const id = seg[0];
    if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400, origin);

    // mint a read-only calendar id for this trip (requires knowing the trip id = the capability)
    if (seg[1] === 'publish-calendar' && request.method === 'PUT') {
      if (!(await env.TRIPS.get(id))) return json({ error: 'trip not found' }, 404, origin);
      const calId = crypto.randomUUID().replace(/-/g, '');
      await env.TRIPS.put('cal:' + calId, id);
      return json({ ok: true, calId }, 200, origin);
    }

    if (request.method === 'GET') {
      const rawDoc = await env.TRIPS.get(id);
      if (!rawDoc) return json({ error: 'not found' }, 404, origin);
      return new Response(rawDoc, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) } });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: 'too large' }, 413, origin);
      let incoming;
      try { incoming = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400, origin); }
      const data = incoming && incoming.data;
      if (data == null || typeof data !== 'object') return json({ error: 'missing data' }, 400, origin);
      const baseRev = Number.isInteger(incoming.baseRev) ? incoming.baseRev : null;
      const curRaw = await env.TRIPS.get(id);
      const cur = curRaw ? JSON.parse(curRaw) : null;
      const curRev = cur ? cur.rev : 0;
      if (cur && baseRev !== null && baseRev !== curRev) {
        return json({ error: 'conflict', rev: curRev, updatedAt: cur.updatedAt, data: cur.data }, 409, origin);
      }
      const rev = curRev + 1;
      const updatedAt = new Date().toISOString();
      await env.TRIPS.put(id, JSON.stringify({ rev, updatedAt, data }));
      return json({ ok: true, rev, updatedAt }, 200, origin);
    }

    return json({ error: 'method not allowed' }, 405, origin);
  },
};
