'use strict';
// Optional cloud sync + share. FEATURE-FLAGGED: with no store URL configured, this module does
// nothing and the app stays 100% local (localStorage), exactly as before.
//
// Model: one editable "trip" = one JSON document in a tiny Cloudflare Worker + KV store (see
// /sync), keyed by a random id carried in the ?trip=<id> link. Anyone with the link can read AND
// write — share it only with people you trust. Sync is whole-document, last-write-wins with an
// optimistic-concurrency rev guard, so a stale save can't silently clobber a newer one. Login, UI
// prefs and caches never sync — only trip CONTENT travels between devices/people.
//
// See docs: /sync/README.md.

import { esc } from './lib/dom.js';
import { openDialog, confirmModal } from './lib/modal.js';

// ---- config ---------------------------------------------------------------
// Optional hardcoded default. Normally you paste the Worker URL into the in-app Sync panel instead
// (stored device-local). Must be an https://*.workers.dev origin (allowed by the page CSP). Empty
// here + none saved = the whole feature is off.
const STORE_URL_DEFAULT = '';

const PREFIX = 'jwh-';
const K_URL = 'jwh-sync-url';       // device-local Worker URL (excluded from the synced payload)
const K_ID  = 'jwh-sync-id-v1';     // this device's active trip id
const K_REV = 'jwh-sync-rev-v1';    // last server rev we applied/pushed

// Keys that must NOT travel between devices/people: login, this sync meta, volatile caches, and
// personal UI prefs. Everything else under the jwh- prefix is trip CONTENT and syncs.
const EXCLUDE = new Set([
  'jwh-auth-v1', K_URL, K_ID, K_REV,
  'jwh-wx-v1', 'jwh-fx-v1', 'jwh-dict-cache-v1',
  'jwh-theme', 'jwh-lang', 'jwh-reduce-motion', 'jwh-compact-v1', 'jwh-sound',
  'jwh-celebrations', 'jwh-furi-v1', 'jwh-listctl-v1', 'jwh-cal-sidebar-v1',
  'jwh-navhidden-v1', 'jwh-navshow-v1', 'jwh-navorder-v1', 'jwh-usage-v1',
]);

const raw = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota */ } };
const del = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

const storeUrl = () => (raw(K_URL) || STORE_URL_DEFAULT || '').replace(/\/+$/, '');
const tripId   = () => raw(K_ID) || '';
const enabled  = () => !!(storeUrl() && tripId());

// ---- content payload (trip data only) -------------------------------------
function collect() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX) && !EXCLUDE.has(k)) out[k] = localStorage.getItem(k);
  }
  return out;
}
// Apply a remote content snapshot: atomic replace of CONTENT keys only (keeps login/prefs/caches).
function apply(data) {
  if (!data || typeof data !== 'object') return false;
  const incoming = Object.keys(data).filter(k => k.startsWith(PREFIX) && !EXCLUDE.has(k) && typeof data[k] === 'string');
  const existing = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX) && !EXCLUDE.has(k)) existing.push(k); }
  const inSet = new Set(incoming);
  incoming.forEach(k => put(k, data[k]));
  existing.forEach(k => { if (!inSet.has(k)) del(k); });   // atomic: drop content the snapshot omits
  return true;
}
const hasLocalContent = () => Object.keys(collect()).length > 0;

// ---- network --------------------------------------------------------------
async function getRemote() {
  const r = await fetch(`${storeUrl()}/${tripId()}`, { method: 'GET', cache: 'no-store' });
  if (r.status === 404) return { rev: 0, data: null };
  if (!r.ok) throw new Error('GET ' + r.status);
  return r.json();                       // { rev, updatedAt, data }
}
async function putRemote(data, baseRev) {
  const r = await fetch(`${storeUrl()}/${tripId()}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, baseRev }),
  });
  if (r.status === 409) return { conflict: true, ...(await r.json()) };
  if (!r.ok) throw new Error('PUT ' + r.status);
  return r.json();                       // { ok, rev, updatedAt }
}

// ---- sync engine ----------------------------------------------------------
let localRev = parseInt(raw(K_REV) || '0', 10) || 0;
let lastSynced = null;                   // JSON string of the content we last agreed with the server
let status = 'idle';                     // idle | syncing | synced | conflict | offline | error
let statusAt = 0;
let timer = null;

function setStatus(s) { status = s; statusAt = Date.now(); document.dispatchEvent(new CustomEvent('jwh:sync', { detail: { status, at: statusAt } })); }
function markSynced(rev) { localRev = rev; put(K_REV, String(rev)); lastSynced = JSON.stringify(collect()); }

// Pull the server's copy and adopt it locally if it has moved past what we last saw.
async function pull() {
  if (!enabled()) return { changed: false };
  const remote = await getRemote();
  if (remote.data && remote.rev !== localRev) {
    apply(remote.data);
    markSynced(remote.rev);
    document.dispatchEvent(new CustomEvent('jwh:data-changed'));
    return { changed: true, rev: remote.rev };
  }
  if (remote.data && lastSynced === null) lastSynced = JSON.stringify(collect());
  return { changed: false, rev: remote.rev };
}

// Push local content up. Last-write-wins: on a 409 we adopt the server's rev as our base and re-push
// once so THIS (later) save lands; a second 409 means heavy contention, so we yield to the server.
async function push(retry = 0) {
  if (!enabled()) return;
  const content = collect();
  const cur = JSON.stringify(content);
  if (cur === lastSynced) { setStatus('synced'); return; }   // nothing new to send
  setStatus('syncing');
  try {
    const res = await putRemote(content, localRev);
    if (res.conflict) {
      localRev = res.rev; put(K_REV, String(res.rev));       // adopt server rev as the new base
      if (retry < 1) return push(retry + 1);                 // re-send our local as the latest write
      apply(res.data); markSynced(res.rev);                  // give up: converge on the server copy
      document.dispatchEvent(new CustomEvent('jwh:data-changed'));
      setStatus('conflict');
      return;
    }
    markSynced(res.rev);
    setStatus('synced');
  } catch {
    setStatus('offline');
  }
}

function schedulePush() {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => push(), 1500);
}

// Attach the ongoing listeners once (idempotent). The handlers self-gate on enabled(), so this is
// safe to call whether sync was on at boot or turned on later via the panel; Stop syncing just makes
// them no-ops. Without this, enabling sync mid-session wouldn't auto-push later edits until a reload.
let wired = false;
function refreshPull() { if (enabled() && !document.hidden) pull().catch(() => setStatus('offline')); }
function wireLive() {
  if (wired) return; wired = true;
  document.addEventListener('jwh:data-changed', schedulePush);
  window.addEventListener('focus', refreshPull);
  document.addEventListener('visibilitychange', refreshPull);
}

// Adopt a ?trip=<id> from the link. If this device already holds different local content, confirm
// before replacing it (a friend clicking a share link expects to see YOUR trip, but we shouldn't
// silently nuke someone's own data). Returns true if a (possibly new) trip is now active.
async function adoptFromUrl() {
  const m = /[?&]trip=([a-z0-9]{6,64})(?:&|#|$)/.exec(location.search + location.hash);
  if (!m) return;
  const id = m[1];
  if (id === tripId()) return;                               // already on this trip
  if (tripId() || hasLocalContent()) {
    const ok = await confirmModal(
      'Open this shared trip? It replaces the trip data on this device (your login and settings are kept). Back up first if you want to keep what you have.',
      { ok: 'Open shared trip', danger: true });
    if (!ok) return;
  }
  put(K_ID, id); put(K_REV, '0'); localRev = 0; lastSynced = null;
}

// ---- boot -----------------------------------------------------------------
export async function mountSync() {
  wireButton();                          // the footer panel works even when sync is off (to set it up)
  await adoptFromUrl();
  if (!enabled()) { setStatus('idle'); return; }
  try {
    const remote = await getRemote();
    if (!remote.data) {                  // nothing stored yet → seed the trip from this device
      await push();
    } else if (remote.rev === localRev) {
      await push();                      // server unchanged since our last sync → send any local edits
    } else {                             // server moved on (another device) → adopt it
      apply(remote.data); markSynced(remote.rev);
      document.dispatchEvent(new CustomEvent('jwh:data-changed'));
      setStatus('synced');
    }
  } catch { setStatus('offline'); }
  wireLive();
}

// ---- share / setup panel --------------------------------------------------
function newId() {
  const a = new Uint8Array(14); crypto.getRandomValues(a);
  return [...a].map(b => (b % 36).toString(36)).join('');    // 14 chars, a-z0-9 (a capability id)
}
function shareLink() { return `${location.origin}${location.pathname}?trip=${tripId()}`; }
function statusLine() {
  const map = { synced: 'Synced ✓', syncing: 'Syncing…', conflict: 'Synced (a newer edit from another device won)', offline: 'Offline — will retry', error: 'Error', idle: 'Not syncing' };
  return map[status] || status;
}

function panelHTML() {
  const url = storeUrl();
  if (!url) {
    return `<p class="sync-p">Sync your trip across devices and share it with a link. First, set up the free store (one-time) — see <code>sync/README.md</code> in the repo — then paste your Worker URL below.</p>
      <label class="sync-l" for="syncUrl">Store URL</label>
      <input class="app-modal-input" id="syncUrl" type="url" inputmode="url" placeholder="https://japan-trip-sync.you.workers.dev" aria-label="Store URL">
      <div class="app-modal-acts"><button type="button" class="am-btn" data-close>Close</button><button type="button" class="am-btn am-primary" data-saveurl>Save</button></div>`;
  }
  if (!tripId()) {
    return `<p class="sync-p">Store connected. Start syncing to upload this device's trip and get a shareable link. Anyone with the link can view and edit, so share it only with people you trust.</p>
      <p class="sync-meta">Store: <code>${esc(url)}</code></p>
      <div class="app-modal-acts"><button type="button" class="am-btn" data-changeurl>Change URL</button><button type="button" class="am-btn am-primary" data-start>Start syncing</button></div>`;
  }
  return `<p class="sync-p"><b>${esc(statusLine())}</b></p>
    <label class="sync-l" for="syncLink">Your trip link — open it on another device or send it to a friend</label>
    <input class="app-modal-input" id="syncLink" type="text" readonly value="${esc(shareLink())}" aria-label="Trip link">
    <p class="sync-warn">⚠ Anyone with this link can edit your trip. Don't post it publicly.</p>
    <div class="app-modal-acts">
      <button type="button" class="am-btn" data-stop>Stop syncing</button>
      <button type="button" class="am-btn" data-sync>Sync now</button>
      <button type="button" class="am-btn am-primary" data-copy>Copy link</button>
    </div>`;
}

function openPanel() {
  let syncListener = null;
  return openDialog(`<h2 id="amTitle" class="app-modal-title">☁ Sync &amp; share</h2><div class="sync-body"></div>`, {
    onMount: (card, done) => {
      const body = card.querySelector('.sync-body');
      const rerender = () => {
        body.innerHTML = panelHTML();
        wirePanel(card, body, done, rerender);
      };
      // live-update the status line while the panel is open (push/pull dispatch jwh:sync)
      syncListener = () => { if (tripId()) rerender(); };
      document.addEventListener('jwh:sync', syncListener);
      rerender();
    },
  }).then(() => { if (syncListener) document.removeEventListener('jwh:sync', syncListener); });
}

function wirePanel(card, body, done, rerender) {
  const q = (s) => body.querySelector(s);
  q('[data-close]')?.addEventListener('click', () => done(null));
  q('[data-saveurl]')?.addEventListener('click', () => {
    const v = (q('#syncUrl').value || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9.-]*workers\.dev$/i.test(v)) { q('#syncUrl').setAttribute('aria-invalid', 'true'); q('#syncUrl').focus(); return; }
    put(K_URL, v);
    if (enabled()) { wireLive(); pull().catch(() => {}); }   // a device that already had a trip id, just re-entering the URL
    rerender();
  });
  q('[data-changeurl]')?.addEventListener('click', () => { del(K_URL); rerender(); });
  q('[data-start]')?.addEventListener('click', async () => {
    put(K_ID, newId()); put(K_REV, '0'); localRev = 0; lastSynced = null;
    rerender();
    await push();                        // seed the store from this device
    wireLive();                          // start auto-pushing later edits + pulling on focus
    rerender();
  });
  q('[data-sync]')?.addEventListener('click', async () => { await pull().catch(() => {}); await push(); rerender(); });
  q('[data-copy]')?.addEventListener('click', async () => {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); } catch { const el = q('#syncLink'); el.select(); document.execCommand && document.execCommand('copy'); }
    const btn = q('[data-copy]'); if (btn) { btn.textContent = 'Copied ✓'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy link'; }, 1500); }
  });
  q('[data-stop]')?.addEventListener('click', async () => {
    if (!await confirmModal('Stop syncing this device? Your data stays here, but changes will no longer sync or update the shared link.', { ok: 'Stop syncing', danger: true })) return;
    del(K_ID); del(K_REV); localRev = 0; lastSynced = null; setStatus('idle');
    rerender();
  });
}

function wireButton() {
  document.querySelector('#syncShare')?.addEventListener('click', openPanel);
}
