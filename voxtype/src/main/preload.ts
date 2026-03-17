import { contextBridge, ipcRenderer } from 'electron';

// IPC channel names — duplicated here because preload runs in a sandbox
// and cannot resolve relative imports to shared modules
const IPC = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  STATE_CHANGE: 'state-change',
  ERROR: 'error',
  AUDIO_DATA: 'audio-data',
  GET_SETTINGS: 'get-settings',
  SET_SETTINGS: 'set-settings',
  CANCEL: 'cancel',
} as const;

contextBridge.exposeInMainWorld('voxtype', {
  // Main → Renderer (listen)
  onStartRecording: (cb: () => void) => {
    ipcRenderer.on(IPC.START_RECORDING, () => cb());
    return () => { ipcRenderer.removeAllListeners(IPC.START_RECORDING); };
  },
  onStopRecording: (cb: () => void) => {
    ipcRenderer.on(IPC.STOP_RECORDING, () => cb());
    return () => { ipcRenderer.removeAllListeners(IPC.STOP_RECORDING); };
  },
  onStateChange: (cb: (state: string, detail?: string) => void) => {
    ipcRenderer.on(IPC.STATE_CHANGE, (_e, state, detail) => cb(state, detail));
    return () => { ipcRenderer.removeAllListeners(IPC.STATE_CHANGE); };
  },
  onError: (cb: (msg: string) => void) => {
    ipcRenderer.on(IPC.ERROR, (_e, msg) => cb(msg));
    return () => { ipcRenderer.removeAllListeners(IPC.ERROR); };
  },

  // Renderer → Main (send)
  sendAudioData: (buffer: ArrayBuffer) => {
    ipcRenderer.send(IPC.AUDIO_DATA, Buffer.from(buffer));
  },
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke(IPC.SET_SETTINGS, settings),
  cancel: () => ipcRenderer.send(IPC.CANCEL),
});
