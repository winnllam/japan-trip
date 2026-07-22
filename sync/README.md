# Trip sync store (Cloudflare Worker + KV)

A ~60-line serverless store so your trip data syncs across your devices and a shared link shows
your current trip. The frontend stays plain `fetch` — this is the only backend.

**Model:** one editable "trip" = one JSON document keyed by a random id in the app's `?trip=<id>`
link. Anyone with the link can read **and write**, so only share it with people you trust. Sync is
whole-document, last-write-wins with a `rev` guard (a stale save is rejected, not silently
clobbered). Login, UI prefs and caches never leave the device — only trip content syncs.

## One-time setup (~15 min)

You need [Node.js](https://nodejs.org) installed. Then, from this `sync/` folder:

```bash
npm i -g wrangler          # Cloudflare's CLI
wrangler login             # opens a browser to your (free) Cloudflare account
wrangler kv namespace create TRIPS
```

That last command prints an `id = "…"`. Paste it into `wrangler.toml` (replace
`REPLACE_WITH_YOUR_KV_ID`). Then deploy:

```bash
wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://japan-trip-sync.<your-subdomain>.workers.dev`.

## Turn it on in the app

1. Open the dashboard → footer → **☁ Sync & share**.
2. Paste the Worker URL and **Save**.
3. Click **Start syncing** — it uploads your current trip and shows your link.
4. Open that link on your phone (or send it to a friend) to see the same trip. Edits from any
   device sync back to the store.

## Notes

- **Free tier** (100k requests/day, 1 GB storage) is far beyond a personal trip.
- **The link is the key.** Anyone with it can edit your trip — don't post it publicly. To rotate,
  Stop syncing and Start again (new id); the old link then points at a stale, orphaned document.
- **Allowed origins** are listed in `worker.js` (`ALLOW`): `localhost:8000`, `127.0.0.1:8000`, and
  `https://winnllam.github.io`. If you serve the app somewhere else, add it there and redeploy.
- **Conflicts:** taking-turns editing is seamless. If two people save within the ~2s sync window,
  the last save wins the whole document (the other's in-flight change may be dropped). True
  simultaneous merge (CRDT) is a future upgrade, not built here.
