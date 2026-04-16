import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { HotkeyMode, HotkeyCombo } from '../shared/types';

type HotkeyCallbacks = {
  onActivate: () => void;
  onDeactivate: () => void;
};

let mode: HotkeyMode = 'hold';
let combo: HotkeyCombo = { key1: 29, key2: 3675, label: 'Ctrl + Win' };
let callbacks: HotkeyCallbacks | null = null;
let isActive = false;

// Track all currently held keys + when they were first pressed.
// The timestamp lets us expire stale entries caused by missed keyup events
// (common with Win/Meta — Windows intercepts them for the Start menu).
const heldKeys = new Set<number>();
const keyTimestamps = new Map<number, number>();

// Keys "held" longer than this are almost certainly stale (missed keyup).
const STALE_KEY_MS = 5000;

// Capture mode: next two keys become the new hotkey
let captureResolve: ((combo: HotkeyCombo) => void) | null = null;
let captureReady = false;
const captureKeys: number[] = [];

export function setHotkeyMode(m: HotkeyMode) {
  mode = m;
}

export function setHotkeyCombo(c: HotkeyCombo) {
  combo = c;
}

export function captureHotkey(): Promise<HotkeyCombo> {
  return new Promise((resolve) => {
    captureKeys.length = 0;
    captureReady = heldKeys.size === 0;
    captureResolve = resolve;
  });
}

// Keycode → human label
const KEY_NAMES: Record<number, string> = {
  [UiohookKey.Ctrl]: 'Ctrl',
  [UiohookKey.CtrlRight]: 'RCtrl',
  [UiohookKey.Shift]: 'Shift',
  [UiohookKey.ShiftRight]: 'RShift',
  [UiohookKey.Alt]: 'Alt',
  [UiohookKey.AltRight]: 'RAlt',
  [UiohookKey.Meta]: 'Win',
  [UiohookKey.MetaRight]: 'RWin',
  [UiohookKey.Space]: 'Space',
  [UiohookKey.Enter]: 'Enter',
  [UiohookKey.Tab]: 'Tab',
  [UiohookKey.CapsLock]: 'CapsLock',
  [UiohookKey.Escape]: 'Esc',
  [UiohookKey.Backspace]: 'Backspace',
  [UiohookKey.Delete]: 'Delete',
  [UiohookKey.Insert]: 'Insert',
  [UiohookKey.Home]: 'Home',
  [UiohookKey.End]: 'End',
  [UiohookKey.PageUp]: 'PageUp',
  [UiohookKey.PageDown]: 'PageDown',
  [UiohookKey.ArrowUp]: 'Up',
  [UiohookKey.ArrowDown]: 'Down',
  [UiohookKey.ArrowLeft]: 'Left',
  [UiohookKey.ArrowRight]: 'Right',
  [UiohookKey.F1]: 'F1', [UiohookKey.F2]: 'F2', [UiohookKey.F3]: 'F3',
  [UiohookKey.F4]: 'F4', [UiohookKey.F5]: 'F5', [UiohookKey.F6]: 'F6',
  [UiohookKey.F7]: 'F7', [UiohookKey.F8]: 'F8', [UiohookKey.F9]: 'F9',
  [UiohookKey.F10]: 'F10', [UiohookKey.F11]: 'F11', [UiohookKey.F12]: 'F12',
  // Letters
  30: 'A', 48: 'B', 46: 'C', 32: 'D', 18: 'E', 33: 'F', 34: 'G',
  35: 'H', 23: 'I', 36: 'J', 37: 'K', 38: 'L', 50: 'M', 49: 'N',
  24: 'O', 25: 'P', 16: 'Q', 19: 'R', 31: 'S', 20: 'T', 22: 'U',
  47: 'V', 17: 'W', 45: 'X', 21: 'Y', 44: 'Z',
  // Numbers
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5',
  7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  // Punctuation
  12: '-', 13: '=', 26: '[', 27: ']', 43: '\\',
  39: ';', 40: "'", 41: '`', 51: ',', 52: '.', 53: '/',
};

function keyName(code: number): string {
  return KEY_NAMES[code] || `Key${code}`;
}

function normalize(code: number): number {
  if (code === UiohookKey.CtrlRight) return UiohookKey.Ctrl;
  if (code === UiohookKey.ShiftRight) return UiohookKey.Shift;
  if (code === UiohookKey.AltRight) return UiohookKey.Alt;
  if (code === UiohookKey.MetaRight) return UiohookKey.Meta;
  return code;
}

let staleKeyTimer: ReturnType<typeof setInterval> | null = null;

export function startHotkeyListener(cbs: HotkeyCallbacks) {
  callbacks = cbs;

  // Periodically clear stale keys from heldKeys. If a keyup event was
  // lost (Windows Start menu interception, focus steal, etc.), the key
  // will look permanently held and break all future combo detection.
  // Auto-repeat keydowns refresh the timestamp, so genuinely-held keys
  // won't expire.
  staleKeyTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, ts] of keyTimestamps) {
      if (now - ts > STALE_KEY_MS) {
        heldKeys.delete(k);
        keyTimestamps.delete(k);
        console.log(`[Hotkey] Cleared stale key: ${keyName(k)} (held for ${((now - ts) / 1000).toFixed(1)}s — likely missed keyup)`);
      }
    }
  }, 2000);

  uIOhook.on('keydown', (e) => {
    const key = normalize(e.keycode);

    // Always refresh the timestamp so genuinely-held keys don't expire.
    keyTimestamps.set(key, Date.now());

    // Ignore OS keydown auto-repeats — Windows fires keydown continuously
    // while a key is held.
    if (heldKeys.has(key)) return;
    heldKeys.add(key);

    // Capture mode
    if (captureResolve) {
      if (!captureReady) return;
      if (!captureKeys.includes(key)) {
        captureKeys.push(key);
      }
      if (captureKeys.length >= 2) {
        const [k1, k2] = captureKeys;
        const label = `${keyName(k1)} + ${keyName(k2)}`;
        const result: HotkeyCombo = { key1: k1, key2: k2, label };
        captureKeys.length = 0;
        const resolve = captureResolve;
        captureResolve = null;
        resolve(result);
      }
      return;
    }

    // Normal mode: check if all combo keys are held
    const key1Match = heldKeys.has(normalize(combo.key1));
    const key2Match = combo.key2 === undefined || heldKeys.has(normalize(combo.key2));

    if (key1Match && key2Match) {
      if (mode === 'hold') {
        if (!isActive) {
          isActive = true;
          console.log(`[Hotkey] ACTIVATE (hold) — key=${keyName(key)} held=[${[...heldKeys].map(keyName).join(',')}]`);
          callbacks?.onActivate();
        }
      } else {
        // Toggle mode
        if (!isActive) {
          isActive = true;
          console.log(`[Hotkey] ACTIVATE (toggle) — key=${keyName(key)}`);
          callbacks?.onActivate();
        } else {
          isActive = false;
          console.log(`[Hotkey] DEACTIVATE (toggle) — key=${keyName(key)}`);
          callbacks?.onDeactivate();
        }
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    const key = normalize(e.keycode);
    heldKeys.delete(key);
    keyTimestamps.delete(key);

    // Capture mode: once all pre-capture keys have been released, arm capture.
    if (captureResolve && !captureReady && heldKeys.size === 0) {
      captureReady = true;
      return;
    }

    // Capture mode: if user released all keys with exactly one captured,
    // finalize as a single-key hotkey.
    if (captureResolve && captureReady && captureKeys.length === 1 && heldKeys.size === 0) {
      const [k1] = captureKeys;
      const result: HotkeyCombo = { key1: k1, label: keyName(k1) };
      captureKeys.length = 0;
      const resolve = captureResolve;
      captureResolve = null;
      resolve(result);
      return;
    }

    // Hold mode: deactivate when any combo key is released
    if (mode === 'hold' && isActive) {
      const k2 = combo.key2 === undefined ? -1 : normalize(combo.key2);
      if (key === normalize(combo.key1) || key === k2) {
        isActive = false;
        console.log(`[Hotkey] DEACTIVATE (hold release) — key=${keyName(key)}`);
        callbacks?.onDeactivate();
      }
    }
  });

  uIOhook.start();
}

export function stopHotkeyListener() {
  uIOhook.stop();
  if (staleKeyTimer) { clearInterval(staleKeyTimer); staleKeyTimer = null; }
  callbacks = null;
  isActive = false;
  heldKeys.clear();
  keyTimestamps.clear();
}
