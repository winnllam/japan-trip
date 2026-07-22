'use strict';
// Backup & Restore. Every edit you make — events, places, checklist, reminders, notes —
// lives in this browser's localStorage and nowhere else. A cleared cache or a new phone
// would lose it. This exports all of it to a file and restores it anywhere.

import { confirmModal } from './lib/modal.js';

const PREFIX = 'jwh-';

function collect() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k);
  }
  return out;
}

function download() {
  const stamp = new Date().toISOString();
  const payload = { app: 'japan-working-holiday', version: 1, exported: stamp, data: collect() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `my-japan-trip-backup-${stamp.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function restore(file, statusEl) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const data = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : null;
      if (!data) throw new Error('unrecognised backup file');
      const keys = Object.keys(data).filter(k => k.startsWith(PREFIX) && typeof data[k] === 'string');
      if (!keys.length) throw new Error('no trip data in this file');
      if (!await confirmModal(`Restore ${keys.length} items? This REPLACES the trip data on this device (your login and theme are kept).`, { ok: 'Restore', danger: true })) return;
      // atomic replace: drop any existing jwh- key not in the backup, else the two stores desync
      // (e.g. a place.eventId pointing at an event the backup didn't have). Keep auth + theme local.
      const KEEP = new Set(['jwh-auth-v1', 'jwh-theme']);
      const incoming = new Set(keys);
      const existing = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) existing.push(k); }
      // write-first, delete-after: if a write throws (storage quota), the current data must
      // survive. A snapshot rolls back any keys the write pass already overwrote.
      const snapshot = {};
      existing.forEach(k => { snapshot[k] = localStorage.getItem(k); });
      try {
        keys.forEach(k => { if (!KEEP.has(k)) localStorage.setItem(k, data[k]); });
      } catch {
        Object.entries(snapshot).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* rollback is best-effort */ } });
        throw new Error('the backup did not fit in this browser’s storage — nothing was changed');
      }
      existing.forEach(k => { if (!incoming.has(k) && !KEEP.has(k)) localStorage.removeItem(k); });
      if (statusEl) statusEl.textContent = `Restored ${keys.length} items — reloading…`;
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Restore failed: ' + e.message + '.';
    }
  };
  reader.onerror = () => { if (statusEl) statusEl.textContent = 'Could not read that file.'; };
  reader.readAsText(file);
}

export function mountBackup() {
  const btnExport = document.querySelector('#backupExport');
  const btnImport = document.querySelector('#backupImport');
  const fileInput = document.querySelector('#backupFile');
  const status = document.querySelector('#backupStatus');
  if (!btnExport || !btnImport || !fileInput) return;
  btnExport.addEventListener('click', download);
  btnImport.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) restore(f, status);
    fileInput.value = '';
  });
}
