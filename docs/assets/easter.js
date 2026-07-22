'use strict';
// Easter eggs — 11 small, identity-free delights: hidden interactions (tap-hinomaru, long-press
// brand, magic words, swipe-konami), seasonal/date auto-eggs (landing day, sakura, new year,
// 2am night-owl), a secret mini-synth, and DevTools console art. See
// docs/superpowers/specs/2026-06-17-easter-eggs-design.md.
//
// Guardrails: every dynamic string through esc(); automatic *visual* eggs respect the Celebrations
// setting AND prefers-reduced-motion (drop movement, keep a subtle static nod); user-triggered
// eggs always fire. Time is computed in JST (UTC+9) explicitly, never the user's local clock.
//
// audio.js is loaded LAZILY (dynamic import) so this module stays import-safe in Node for the
// pure seasonalEgg() unit test, and so the AudioContext is only created on a real user gesture.

import { $, $$, esc } from './lib/dom.js';
import { KEYS, getRaw } from './lib/store.js';

// ---------------------------------------------------------------------------
// Pure, testable date/time logic
// ---------------------------------------------------------------------------

// "now in JST (UTC+9)" as a Date whose UTC fields read as the Tokyo wall clock. We shift the
// epoch by the local offset + 9h, so .getUTCHours()/.getUTCMonth()/.getUTCDate() are JST.
export function jstNow(base = new Date()) {
  return new Date(base.getTime() + base.getTimezoneOffset() * 60000 + 9 * 3600000);
}

// Pure: given a Date already in JST, which automatic egg (if any) applies. Read the JST wall
// clock via UTC getters (jstNow() bakes JST into the UTC fields). Precedence: a one-time landing
// day wins, then seasonal windows, then the recurring night-owl hour band.
export function seasonalEgg(jstDate) {
  if (!(jstDate instanceof Date) || isNaN(jstDate)) return null;
  const y = jstDate.getUTCFullYear();
  const mo = jstDate.getUTCMonth();   // 0-indexed
  const d = jstDate.getUTCDate();
  const h = jstDate.getUTCHours();

  if (y === 2026 && mo === 5 && d === 30) return 'landing';                 // 2026-06-30, arrival day
  if ((mo === 2 && d >= 20) || (mo === 3 && d <= 10)) return 'sakura';      // Mar 20 .. Apr 10
  if ((mo === 11 && d === 31) || (mo === 0 && d === 1)) return 'newyear';   // Dec 31 or Jan 1
  if (h >= 1 && h <= 3) return 'nightowl';                                  // 01:00 .. 03:59 JST
  return null;
}

// ---------------------------------------------------------------------------
// Small environment helpers
// ---------------------------------------------------------------------------

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const celebrationsOn = () => getRaw(KEYS.celebrations, '') !== 'off';   // default on

// audio is a no-op unless Sound is on (audio.js enforces this too); load it lazily so a single
// AudioContext is created on first gesture and Node never needs the browser-only module.
function blip(name) {
  import('./lib/audio.js').then(a => a.blip(name)).catch(() => {});
}

// reuse the existing .toast styling (same shape dnd.js uses); auto-dismisses
let eggToast = null;
function toast(msg, ms = 3600) {
  if (eggToast) eggToast.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  document.body.appendChild(t);
  eggToast = t;
  setTimeout(() => { if (t.isConnected) { t.classList.add('out'); setTimeout(() => t.remove(), 240); } }, ms);
}

// ---------------------------------------------------------------------------
// Particle / burst helpers (CSS classes styled by another agent)
// ---------------------------------------------------------------------------

const PETAL_COLORS = ['#ffd7e6', '#ffc2d6', '#ffb3cc', '#ffe0ec'];

// a short sparkle/sakura burst from a point (tap-hinomaru). Skipped under reduced motion.
function burst(x, y, n = 14) {
  if (reducedMotion()) return;
  const wrap = document.createElement('div');
  wrap.className = 'egg-burst'; wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    const ang = (i / n) * Math.PI * 2;
    const dist = 40 + Math.random() * 50;
    p.textContent = i % 2 ? '🌸' : '✨';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    p.style.animationDelay = (i % 5) * 30 + 'ms';
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1400);
}

// drifting cherry petals across the page (sakura season + tap burst flavour). One layer at a time.
let petalLayer = null;
function petals(count = 28, lifeMs = 9000) {
  if (reducedMotion() || petalLayer) return;
  const wrap = document.createElement('div');
  wrap.className = 'egg-petals'; wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.style.left = Math.round(Math.random() * 100) + '%';
    p.style.background = PETAL_COLORS[i % PETAL_COLORS.length];
    p.style.animationDelay = Math.round(Math.random() * 6000) + 'ms';
    p.style.animationDuration = (5 + Math.random() * 4).toFixed(1) + 's';
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  petalLayer = wrap;
  setTimeout(() => { wrap.remove(); if (petalLayer === wrap) petalLayer = null; }, lifeMs);
}

const KATA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
// a brief "matrix" katakana rain (magic word). Skipped under reduced motion.
function katakanaRain(lifeMs = 2600) {
  if (reducedMotion()) return;
  const wrap = document.createElement('div');
  wrap.className = 'egg-rain'; wrap.setAttribute('aria-hidden', 'true');
  const cols = Math.min(28, Math.max(10, Math.floor(window.innerWidth / 28)));
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('span');
    col.style.left = ((c + 0.5) / cols * 100).toFixed(2) + '%';
    col.style.animationDelay = Math.round(Math.random() * 600) + 'ms';
    col.style.animationDuration = (1.4 + Math.random() * 1.2).toFixed(1) + 's';
    let s = '';
    for (let r = 0; r < 12; r++) s += KATA[Math.floor(Math.random() * KATA.length)] + '\n';
    col.textContent = s;          // textContent — no esc needed, never innerHTML
    wrap.appendChild(col);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), lifeMs);
}

// confetti, same shape as content.js's celebrate() (reuses .confetti styling)
function confetti(n = 36) {
  if (reducedMotion()) return;
  const wrap = document.createElement('div');
  wrap.className = 'confetti'; wrap.setAttribute('aria-hidden', 'true');
  const colors = ['#bc002d', '#223a70', '#b8860b', '#1e8e3e', '#a8228d'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = Math.round((i / n) * 100) + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (i % 12) * 40 + 'ms';
    p.style.transform = `translateY(0) rotate(${i * 37}deg)`;
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 2600);
}

// a single floating emoji that rises and fades (ramen 🍜)
function floatEmoji(emoji) {
  if (reducedMotion()) return;
  const el = document.createElement('div');
  el.className = 'egg-burst';
  const span = document.createElement('i');
  span.textContent = emoji;
  span.style.left = (40 + Math.random() * 20) + 'vw';
  span.style.top = '70vh';
  span.style.setProperty('--dx', '0px');
  span.style.setProperty('--dy', '-220px');
  span.style.fontSize = '2.2rem';
  el.appendChild(span);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// the sun pulses (magic word "tokyo" / landing nod). Uses a transient animation, no persistent state.
function pulseSun() {
  if (reducedMotion()) return;
  $$('.tb-sun, .hero-mark .sun').forEach(el => {
    el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
      { duration: 700, easing: 'cubic-bezier(.34,1.56,.64,1)' }
    );
  });
}

// ---------------------------------------------------------------------------
// 1. Tap hinomaru ×5 → spin + burst + coin blip
// ---------------------------------------------------------------------------

function wireSunTaps() {
  const suns = $$('.tb-sun, .hero-mark .sun');
  let count = 0, timer = null;
  const onTap = (e) => {
    count++;
    clearTimeout(timer);
    timer = setTimeout(() => { count = 0; }, 700);   // taps must be fast (<700ms apart)
    if (count >= 5) {
      count = 0; clearTimeout(timer);
      const el = e.currentTarget;
      if (!reducedMotion()) {
        el.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }],
          { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
      const r = el.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2);
      blip('coin');
    }
  };
  suns.forEach(s => s.addEventListener('click', onTap));
}

// ---------------------------------------------------------------------------
// 2. Long-press brand (~600ms) → dismissible focus-trapped secret card
// ---------------------------------------------------------------------------

let secretCard = null, secretPrevFocus = null;
function closeSecret() {
  if (!secretCard) return;
  secretCard.remove(); secretCard = null;
  document.removeEventListener('keydown', onSecretKey, true);
  if (secretPrevFocus && secretPrevFocus.focus) secretPrevFocus.focus();
}
function onSecretKey(e) {
  if (!secretCard) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSecret(); return; }
  if (e.key !== 'Tab') return;
  const f = $$('button, a, [tabindex]:not([tabindex="-1"])', secretCard).filter(el => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openSecret() {
  if (secretCard) return;
  secretPrevFocus = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'egg-secret';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'eggSecretTitle');
  ov.innerHTML = `<div class="egg-secret-card">
    <button type="button" class="egg-secret-x" aria-label="Close">✕</button>
    <h2 class="egg-secret-title" id="eggSecretTitle">${esc('やあ — you found a secret 😉')}</h2>
    <p class="egg-secret-body">${esc('Built in vanilla JS — no frameworks, no build step, at 2am JST. Ship it.')}</p>
  </div>`;
  document.body.appendChild(ov);
  secretCard = ov;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeSecret(); });   // tap-out closes
  ov.querySelector('.egg-secret-x')?.addEventListener('click', closeSecret);
  document.addEventListener('keydown', onSecretKey, true);
  setTimeout(() => { if (ov.isConnected) ov.querySelector('.egg-secret-x')?.focus(); }, 20);
  blip('select');
}

function wireLongPressBrand() {
  const brand = $('.topbar-brand');
  if (!brand) return;
  let timer = null, sx = 0, sy = 0;
  const start = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    sx = pt.clientX; sy = pt.clientY;
    timer = setTimeout(() => { timer = null; openSecret(); }, 600);
  };
  const move = (e) => {
    if (!timer) return;
    const pt = e.touches ? e.touches[0] : e;
    if (Math.hypot(pt.clientX - sx, pt.clientY - sy) > 10) { clearTimeout(timer); timer = null; }   // a drag/scroll cancels
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  brand.addEventListener('pointerdown', start);
  brand.addEventListener('pointermove', move);
  brand.addEventListener('pointerup', cancel);
  brand.addEventListener('pointerleave', cancel);
  // a fired long-press should not also navigate to #main on click
  brand.addEventListener('click', (e) => { if (secretCard) e.preventDefault(); });
}

// ---------------------------------------------------------------------------
// 3. Magic words in search inputs (debounced, once per match)
// ---------------------------------------------------------------------------

const SEARCH_SELECTORS = ['#search', '#discSearch', '#placeSearch', '#calSearch'];
const SYNTH_NAMES = ['juno', 'moog', 'korg'];

function wireMagicWords() {
  SEARCH_SELECTORS.forEach(sel => {
    const input = $(sel);
    if (!input) return;
    const fired = new Set();      // once per match per input
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const v = input.value.trim().toLowerCase();
        if (!v || fired.has(v)) return;
        let matched = true;
        if (v === 'synth') { fired.add(v); openSynth(input); return; }
        else if (v === 'ramen') floatEmoji('🍜');
        else if (v === 'matrix' || v === 'katakana') katakanaRain();
        else if (v === 'tokyo') pulseSun();
        else if (SYNTH_NAMES.includes(v)) blip('powerup');
        else if (v === 'konami') toast('🎮 hint: ↑↑↓↓←→←→ b a — or swipe it on a phone');
        else matched = false;
        if (matched) fired.add(v);
      }, 260);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Swipe-Konami on touch (↑↑↓↓←→←→) → unlock arcade mode
// ---------------------------------------------------------------------------

const SWIPE_SEQ = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'];
function wireSwipeKonami() {
  let i = 0, sx = 0, sy = 0, tracking = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.hypot(dx, dy) < 30) return;    // a tap, not a swipe
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (dir === SWIPE_SEQ[i]) {
      i++;
      if (i === SWIPE_SEQ.length) {
        i = 0;
        import('./konami.js').then(m => m.unlock()).catch(() => {});
      }
    } else {
      i = (dir === SWIPE_SEQ[0]) ? 1 : 0;
    }
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Secret mini-synth overlay (trigger: typing "synth" in a search box)
// ---------------------------------------------------------------------------

// one octave, white keys a..k → C major-ish. Pure note table (Hz).
const SYNTH_KEYS = [
  { key: 'a', label: 'C', freq: 261.63 },
  { key: 's', label: 'D', freq: 293.66 },
  { key: 'd', label: 'E', freq: 329.63 },
  { key: 'f', label: 'F', freq: 349.23 },
  { key: 'g', label: 'G', freq: 392.00 },
  { key: 'h', label: 'A', freq: 440.00 },
  { key: 'j', label: 'B', freq: 493.88 },
  { key: 'k', label: 'C', freq: 523.25 },
];

let synthOv = null, synthPrevFocus = null;
function playNote(freq) { import('./lib/audio.js').then(a => a.note(freq)).catch(() => {}); }
function closeSynth() {
  if (!synthOv) return;
  synthOv.remove(); synthOv = null;
  document.removeEventListener('keydown', onSynthKey, true);
  if (synthPrevFocus && synthPrevFocus.focus) synthPrevFocus.focus();
}
function onSynthKey(e) {
  if (!synthOv) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSynth(); return; }
  const hit = SYNTH_KEYS.find(k => k.key === (e.key || '').toLowerCase());
  if (hit) {
    e.preventDefault();
    playNote(hit.freq);
    synthOv.querySelector(`[data-k="${esc(hit.key)}"]`)?.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(3px)' }, { transform: 'translateY(0)' }],
      { duration: 140 });
  }
}
function openSynth(fromInput) {
  if (synthOv) return;
  if (fromInput) fromInput.value = '';     // clear the trigger word
  synthPrevFocus = document.activeElement;
  import('./lib/audio.js').then(a => a.blip('select')).catch(() => {});   // resume audio on open
  const ov = document.createElement('div');
  ov.className = 'egg-synth';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Mini synth');
  const keys = SYNTH_KEYS.map(k =>
    `<button type="button" class="egg-synth-key" data-k="${esc(k.key)}" data-freq="${esc(k.freq)}" aria-label="${esc(k.label + ' (' + k.key + ')')}">
      <span class="egg-synth-note">${esc(k.label)}</span><span class="egg-synth-hint">${esc(k.key)}</span>
    </button>`).join('');
  ov.innerHTML = `<div class="egg-synth-card">
    <button type="button" class="egg-synth-x" aria-label="Close">✕</button>
    <p class="egg-synth-title">${esc('mini-synth — click or press a–k')}</p>
    <div class="egg-synth-keys">${keys}</div>
  </div>`;
  document.body.appendChild(ov);
  synthOv = ov;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeSynth(); });
  ov.querySelector('.egg-synth-x')?.addEventListener('click', closeSynth);
  ov.querySelectorAll('.egg-synth-key').forEach(btn => {
    btn.addEventListener('click', () => playNote(parseFloat(btn.dataset.freq)));
  });
  document.addEventListener('keydown', onSynthKey, true);
  setTimeout(() => { if (ov.isConnected) ov.querySelector('.egg-synth-x')?.focus(); }, 20);
}

// ---------------------------------------------------------------------------
// Seasonal / automatic eggs (Celebrations + reduced-motion gated for movement)
// ---------------------------------------------------------------------------

const LANDING_SEEN = 'jwh-egg-landing-seen';   // session-only flag; one torii+confetti per visit

function runSeasonal() {
  if (!celebrationsOn()) return;       // user disabled Celebrations
  const egg = seasonalEgg(jstNow());
  if (!egg) return;
  if (egg === 'landing') {
    try { document.dispatchEvent(new CustomEvent('jwh:landing')); } catch {}
    if (!sessionStorage.getItem(LANDING_SEEN)) {
      try { sessionStorage.setItem(LANDING_SEEN, '1'); } catch {}
      toast('着いた — DAY 1. Welcome to Tokyo ⛩️', 6000);
      confetti();
      pulseSun();
    }
  } else if (egg === 'sakura') {
    petals();
  } else if (egg === 'newyear') {
    toast('明けましておめでとう ⛩️ — hatsumōde awaits', 6000);
    confetti(28);
  } else if (egg === 'nightowl') {
    document.documentElement.dataset.nightowl = 'on';   // brief warm-CRT nod (CSS-gated)
    setTimeout(() => { delete document.documentElement.dataset.nightowl; }, 8000);
    toast('still shipping at 2am? 🌙');
  }
}

// ---------------------------------------------------------------------------
// Console art (always on, zero UI cost)
// ---------------------------------------------------------------------------

export function consoleArt() {
  try {
    const sun = [
      '  ▄▄███████▄▄  ',
      ' ███████████████ ',
      '███████████████████',
      '████████▟█▙████████',   // a hinomaru wink
      '████████▜█▛████████',
      '███████████████████',
      ' ███████████████ ',
      '  ▀▀███████▀▀  ',
    ].join('\n');
    console.log('%c' + sun, 'color:#bc002d;font-weight:700;line-height:1.05');
    console.log('%cMy Japan Trip — built in vanilla JS, no frameworks, no build step. Land HND 2026-10-19. ⛩️',
      'color:#223a70;font-weight:600');
    console.log('%cpsst — try ↑↑↓↓←→←→ b a, or type "synth" in a search box.', 'color:#b8860b');
  } catch {}
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountEaster() {
  consoleArt();
  wireSunTaps();
  wireLongPressBrand();
  wireMagicWords();
  wireSwipeKonami();
  runSeasonal();
}
