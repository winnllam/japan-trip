// Cloudflare Worker — a tiny shared JSON store for the Japan trip dashboard.
//
// One editable "trip" = one document, keyed by a random id carried in the app's ?trip=<id> link.
// Anyone with the link can read AND write, so only share it with people you trust. Writes use an
// optimistic-concurrency `rev` counter: a PUT may send `baseRev`, and if the stored rev has moved
// on since, the write is rejected with 409 (the client re-pulls). This prevents a stale save from
// silently clobbering a newer one.
//
// Binding: a KV namespace bound as `TRIPS` (see wrangler.toml + README.md).

// App origins allowed to call this store. Add your own if you serve the app elsewhere.
const ALLOW = [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'https://winnllam.github.io',
];
const ID_RE = /^[a-z0-9]{6,64}$/;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB per trip — far more than a trip's data needs

function cors(origin) {
  const allow = ALLOW.includes(origin) ? origin : ALLOW[ALLOW.length - 1];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400, origin);

    if (request.method === 'GET') {
      const rawDoc = await env.TRIPS.get(id);
      if (!rawDoc) return json({ error: 'not found' }, 404, origin);
      return new Response(rawDoc, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
      });
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
      // optimistic concurrency: if the caller declared a base rev and it's stale, reject
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
