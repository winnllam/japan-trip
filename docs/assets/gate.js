'use strict';
// Access gate REMOVED. The site is public anyway (GitHub Pages + public repo), so the passphrase was
// only obfuscation against a shoulder-surfer, never real security. mountGate() now boots straight
// through. The exports are kept so the boot call site (main.js) and any importer stay valid.
// (The former passphrase lives in git history if it's ever wanted back.)

export function isUnlocked() { return true; }

export function mountGate(onUnlock) { onUnlock(); }
