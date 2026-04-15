// Whisper model catalog. Selection is now stored in AppSettings.whisperModel
// and applied by restarting the Whisper child process (see services.ts).

export const WHISPER_MODELS = [
  { id: 'Systran/faster-whisper-tiny', label: 'Tiny (fastest)' },
  { id: 'Systran/faster-whisper-base', label: 'Base' },
  { id: 'Systran/faster-whisper-small', label: 'Small (default)' },
  { id: 'Systran/faster-whisper-medium', label: 'Medium' },
  { id: 'Systran/faster-whisper-large-v3', label: 'Large v3 (best)' },
] as const;
