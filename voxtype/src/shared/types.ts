export type PillState = 'idle' | 'recording' | 'processing' | 'enhancing' | 'typing' | 'error';

export type HotkeyMode = 'hold' | 'toggle';

// One or two keycodes that must be held together to activate
export interface HotkeyCombo {
  key1: number; // uiohook keycode
  key2?: number; // uiohook keycode (optional — omit for single-key hotkey)
  label: string; // human-readable, e.g. "Ctrl + Win" or "F9"
}

export type DeviceMode = 'gpu' | 'cpu';

export interface AppSettings {
  // Recording behavior
  hotkeyMode: HotkeyMode;
  hotkey: HotkeyCombo;
  autoStopOnSilence: boolean;
  vadEnabled: boolean;
  appendMode: boolean;

  // Pill UI
  pillX: number;
  pillY: number;

  // Whisper STT (managed as child process by VoxType)
  whisperEnabled: boolean;
  whisperPort: number;
  whisperModel: string;
  whisperDevice: DeviceMode;

  // Kokoro TTS (managed as child process by VoxType — off by default; nothing in
  // VoxType currently consumes TTS, but the toggle is here for users who want
  // the service available to other tools)
  kokoroEnabled: boolean;
  kokoroPort: number;
  kokoroVoice: string;
  kokoroDevice: DeviceMode;

  // LM Studio LLM (external — VoxType does not manage its lifecycle)
  enhanceEnabled: boolean;
  screenContext: boolean;
  lmStudioUrl: string;
  llmModel: string;
  preloadModel: boolean;
  autoUnloadMinutes: number;

  // History
  saveHistory: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkeyMode: 'hold',
  hotkey: { key1: 29, key2: 3675, label: 'Ctrl + Win' },
  autoStopOnSilence: true,
  vadEnabled: true,
  appendMode: false,

  pillX: -1,
  pillY: -1,

  whisperEnabled: true,
  whisperPort: 6600,
  whisperModel: 'Systran/faster-whisper-small',
  whisperDevice: 'gpu',

  kokoroEnabled: false,
  kokoroPort: 6500,
  kokoroVoice: 'af_sky',
  kokoroDevice: 'gpu',

  enhanceEnabled: true,
  screenContext: true,
  lmStudioUrl: 'http://127.0.0.1:1234',
  llmModel: '',
  preloadModel: true,
  autoUnloadMinutes: 0,

  saveHistory: true,
};

// Convenience: derive Whisper URL from port (no longer a stored setting since
// VoxType always points at its own child process on localhost).
export function whisperUrlFor(s: AppSettings): string {
    return `http://127.0.0.1:${s.whisperPort}`;
}

// IPC channel names
export const IPC = {
  // Main → Renderer
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  STATE_CHANGE: 'state-change',
  ERROR: 'error',

  // Renderer → Main
  AUDIO_DATA: 'audio-data',
  GET_SETTINGS: 'get-settings',
  SET_SETTINGS: 'set-settings',
  CANCEL: 'cancel',
} as const;
