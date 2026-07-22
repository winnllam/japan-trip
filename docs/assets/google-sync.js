'use strict';
// One-way push of app events → a dedicated "Japan Trip" Google calendar. GIS token model (no secret).
// The owner pastes their public OAuth Client ID below; until then the control shows "needs setup".
import { get, set, KEYS } from './lib/store.js';
import { eventToGcal, getMapped, setMapped, forgetCalendar } from './lib/gcal.js';
import { confirmModal, alertModal } from './lib/modal.js';
import { esc } from './lib/dom.js';

const CLIENT_ID = '';   // ← owner: paste your Google OAuth 2.0 Web Client ID (public).
                        //   Authorized JS origin = the Pages domain (+ localhost for dev).
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

let token = null;       // in-memory only — NEVER written to localStorage
let tokenClient = null;

// --- Map helpers (localStorage-backed) ---

function loadMap() {
  return get(KEYS.gcalMap, { calendarId: '', events: {} }) || { calendarId: '', events: {} };
}

function saveMap(m) {
  set(KEYS.gcalMap, m);
}

// --- GIS script loader ---

let gisLoadPromise = null;

export function loadGIS() {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.accounts) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadPromise = null;
      reject(new Error('Failed to load Google Identity Services. Check your network connection.'));
    };
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

// --- Calendar API calls (injectable for testing) ---

// Default implementation uses fetch + in-memory token.
async function defaultApi(method, path, body) {
  if (!token) throw Object.assign(new Error('No access token'), { status: 401 });
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${CAL_API}${path}`, opts);
  if (!res.ok) {
    const err = Object.assign(new Error(`Calendar API ${method} ${path} → ${res.status}`), { status: res.status });
    throw err;
  }
  // DELETE returns 204 (no body)
  if (res.status === 204) return null;
  return res.json();
}

// Exported for unit testing: swap in a fake api.
export let _api = defaultApi;
export function _setApi(fn) { _api = fn; }

// --- Token management ---

function requestToken(silent = false) {
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
        } else {
          token = resp;
          resolve(resp);
        }
      },
    });
    try {
      if (silent) {
        tokenClient.requestAccessToken({ prompt: '' });
      } else {
        tokenClient.requestAccessToken();
      }
    } catch (e) {
      reject(e);
    }
  });
}

// --- Calendar ensure ---

async function ensureCalendar() {
  let map = loadMap();

  // If we have a stored calendarId, verify it still exists.
  if (map.calendarId) {
    try {
      await _api('GET', `/calendars/${encodeURIComponent(map.calendarId)}`);
      return map.calendarId;
    } catch (e) {
      if (e.status === 404) {
        // Calendar was deleted — clear the map (its events died with it).
        map = forgetCalendar(map);
        saveMap(map);
      } else {
        throw e;
      }
    }
  }

  // Create a new "Japan Trip" calendar.
  const cal = await _api('POST', '/calendars', { summary: 'Japan Trip' });
  map = { ...map, calendarId: cal.id };
  saveMap(map);
  return cal.id;
}

// --- Public API ---

/**
 * connect()
 * Shows consent modal → loads GIS → requests token → ensures the "Japan Trip" calendar exists.
 */
export async function connect() {
  if (!CLIENT_ID) {
    await alertModal('Google Sync is not yet configured. Paste your OAuth Client ID into google-sync.js to enable it.');
    return false;
  }

  const consented = await confirmModal(
    'This will connect to Google Calendar and create a dedicated "Japan Trip" calendar to push your events into. Your token is kept in memory only and is never saved to disk.',
    { ok: 'Connect', cancel: 'Cancel' },
  );
  if (!consented) return false;

  try {
    await loadGIS();
  } catch (e) {
    await alertModal(`Could not load Google Identity Services: ${esc(e.message)}`);
    return false;
  }

  try {
    await requestToken(false);
  } catch (e) {
    const msg = e.message || String(e);
    if (/popup/.test(msg.toLowerCase())) {
      await alertModal('The sign-in popup was blocked. Please allow popups for this site and try again.');
    } else if (/access_denied|scope/.test(msg.toLowerCase())) {
      await alertModal('Calendar access was denied. Please grant the requested permission and try again.');
    } else {
      await alertModal(`Sign-in failed: ${esc(msg)}`);
    }
    return false;
  }

  try {
    await ensureCalendar();
  } catch (e) {
    await alertModal(`Could not set up the Google Calendar: ${esc(e.message)}`);
    return false;
  }

  return true;
}

/**
 * syncNow(getEvents)
 * Pushes all app events into the "Japan Trip" calendar.
 * INSERT new, PATCH existing, DELETE locally-removed. Writes the map after each success.
 * Recovery: 401/403 → re-auth + resume; 404 calendar → recreate + re-insert.
 */
export async function syncNow(getEvents) {
  if (!token) {
    // Try a silent re-auth first.
    try {
      await loadGIS();
      await requestToken(true);
    } catch {
      await alertModal('Not connected to Google Calendar. Please connect first.');
      return null;
    }
  }

  let map = loadMap();

  // Ensure the calendar still exists before starting the batch.
  let calendarId;
  try {
    calendarId = await ensureCalendar();
    map = loadMap(); // ensureCalendar may have mutated the map (404 path)
  } catch (e) {
    await alertModal(`Cannot reach the Google Calendar: ${esc(e.message)}`);
    return null;
  }

  const events = getEvents();
  const localIds = new Set(events.map(ev => ev.id));
  let inserted = 0;
  let updated = 0;

  // Helper that handles 401/403 by requesting a new token and retrying once.
  async function callWithRetry(method, path, body) {
    try {
      return await _api(method, path, body);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // Re-auth and resume — do NOT clear the map (would cause re-INSERT = duplicates).
        try {
          await requestToken(true);
        } catch {
          throw e; // Re-auth failed; bubble up.
        }
        return _api(method, path, body);
      }
      throw e;
    }
  }

  // Push each local event.
  for (const ev of events) {
    const body = eventToGcal(ev);
    const googleId = getMapped(map, ev.id);
    try {
      if (googleId) {
        // PATCH existing.
        await callWithRetry('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`, body);
        saveMap(map);   // write after each success (spec: per-success; future-proofs storing etag/version)
        updated++;
      } else {
        // POST new.
        const created = await callWithRetry('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
        map = setMapped(map, ev.id, created.id);
        saveMap(map);   // write after each success
        inserted++;
      }
    } catch (e) {
      if (e.status === 404 && googleId) {
        // The event was removed from the calendar (or the calendar was recreated underneath us).
        // Re-insert as new.
        try {
          const created = await callWithRetry('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
          map = setMapped(map, ev.id, created.id);
          saveMap(map);
          inserted++;
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.warn('[google-sync] failed to re-insert event', ev.id, e2);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('[google-sync] failed to push event', ev.id, e);
      }
    }
  }

  // Delete any events that were mapped but no longer exist locally.
  let deleted = 0;
  const mappedIds = Object.keys(map.events || {});
  for (const localId of mappedIds) {
    if (!localIds.has(localId)) {
      const googleId = map.events[localId];
      try {
        await callWithRetry('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`);
        map = { ...map, events: Object.fromEntries(Object.entries(map.events).filter(([k]) => k !== localId)) };
        saveMap(map);
        deleted++;
      } catch (e) {
        if (e.status !== 404) {
          // eslint-disable-next-line no-console
          console.warn('[google-sync] failed to delete remote event', localId, e);
        } else {
          // Already gone — unmap it.
          map = { ...map, events: Object.fromEntries(Object.entries(map.events).filter(([k]) => k !== localId)) };
          saveMap(map);
        }
      }
    }
  }

  return { inserted, updated, deleted };
}

/**
 * disconnect()
 * Revokes the token (best-effort), clears the in-memory token, and wipes the calendar map.
 */
export async function disconnect() {
  if (token) {
    try {
      await loadGIS();
      window.google.accounts.oauth2.revoke(token.access_token, () => {});
    } catch {
      // Best-effort — ignore errors during revoke.
    }
  }
  token = null;
  tokenClient = null;
  saveMap(forgetCalendar(loadMap()));
}

/**
 * isConnected() → boolean
 * True if an in-memory access token is currently held.
 */
export function isConnected() {
  return !!token;
}

/**
 * mountGoogleSync(getEvents)
 * getEvents is a thunk returning allEvents() — avoids a direct import of calendar.js (no cycle).
 * Wires the #calGoogle toolbar button:
 *   - CLIENT_ID === '' → disabled + title "Google sync — needs setup"
 *   - not connected    → click opens connect flow
 *   - connected        → click shows sync/disconnect menu
 */
export function mountGoogleSync(getEvents) {
  const btn = document.getElementById('calGoogle');
  if (!btn) return { connect, syncNow: () => syncNow(getEvents), disconnect, isConnected };

  // Last-synced timestamp (display only, not persisted across sessions).
  let lastSynced = null;

  function updateButton() {
    if (!CLIENT_ID) {
      btn.disabled = true;
      btn.title = 'Google sync — needs setup';
      btn.textContent = 'Google';
      return;
    }
    btn.disabled = false;
    if (isConnected()) {
      const ts = lastSynced ? ` (synced ${lastSynced})` : '';
      btn.textContent = `Google ⌄`;
      btn.title = `Sync now or disconnect${ts}`;
    } else {
      btn.textContent = 'Google';
      btn.title = 'Connect to Google Calendar';
    }
  }

  btn.addEventListener('click', async () => {
    if (!CLIENT_ID) {
      await alertModal('Google Sync needs setup: paste your OAuth Client ID into google-sync.js.');
      return;
    }

    if (!isConnected()) {
      const ok = await connect();
      if (ok) {
        updateButton();
        // Offer an immediate sync after connecting.
        const doSync = await confirmModal('Connected! Push your events to Google Calendar now?', { ok: 'Sync now', cancel: 'Later' });
        if (doSync) await runSync();
      }
      return;
    }

    // Already connected — show sync/disconnect choice.
    const choice = await confirmModal(
      lastSynced
        ? `Last synced: ${esc(lastSynced)}. Push events to Google Calendar now?`
        : 'Push your events to Google Calendar now?',
      { ok: 'Sync now', cancel: 'Disconnect' },
    );

    if (choice) {
      await runSync();
    } else {
      const sure = await confirmModal('Disconnect from Google Calendar? Your local events are unaffected.', { ok: 'Disconnect', cancel: 'Cancel', danger: true });
      if (sure) {
        await disconnect();
        lastSynced = null;
        updateButton();
      }
    }
  });

  async function runSync() {
    let result = null;
    try {
      result = await syncNow(getEvents);
    } catch (e) {
      await alertModal(`Sync failed: ${esc(e.message || String(e))}`);
      updateButton();
      return;
    }
    if (result) {
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lastSynced = now;
      await alertModal(`Synced: ${result.inserted} added, ${result.updated} updated, ${result.deleted} removed.`);
    }
    updateButton();
  }

  updateButton();
  return { connect, syncNow: () => syncNow(getEvents), disconnect, isConnected };
}
