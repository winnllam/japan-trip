'use strict';
// Casual access gate. NOT real security — the password lives in this file and the repo
// is public. It only keeps a shoulder-surfer out. Remembered after first unlock.

import { KEYS, getRaw, setRaw } from './lib/store.js';

const PASSWORD = 'lkjjapan';

export function isUnlocked() {
  return getRaw(KEYS.auth, '') === 'ok';
}

const SHELL = '.topbar, .route-nav, header.hero, main, footer';
function setShellInert(on) { document.querySelectorAll(SHELL).forEach(el => { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); }); }

export function mountGate(onUnlock) {
  if (isUnlocked()) { onUnlock(); return; }
  document.documentElement.classList.add('gated');
  setShellInert(true);   // make the gated content non-interactive + AT-hidden while the overlay is up
  const ov = document.createElement('div');
  ov.className = 'gate';
  ov.innerHTML = `
    <form class="gate-card" id="gateForm" autocomplete="off">
      <div class="gate-mark" aria-hidden="true"></div>
      <h1 class="gate-title">私の一年</h1>
      <p class="gate-sub">My Japan Trip</p>
      <label class="gate-label" for="gatePw">Enter passphrase</label>
      <input class="gate-input" id="gatePw" type="password" inputmode="text"
             autocomplete="off" aria-label="Passphrase" autofocus>
      <button class="gate-btn" type="submit">Unlock</button>
      <p class="gate-err" id="gateErr" role="alert" hidden>Not quite — try again.</p>
    </form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector('#gateForm');
  const input = ov.querySelector('#gatePw');
  const err = ov.querySelector('#gateErr');
  input.focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value === PASSWORD) {
      setRaw(KEYS.auth, 'ok');
      document.documentElement.classList.remove('gated');
      setShellInert(false);
      ov.classList.add('gate-out');
      setTimeout(() => ov.remove(), 280);
      onUnlock();
    } else {
      err.hidden = false;
      ov.querySelector('.gate-card').classList.remove('shake');
      void ov.offsetWidth;
      ov.querySelector('.gate-card').classList.add('shake');
      input.select();
    }
  });
}
