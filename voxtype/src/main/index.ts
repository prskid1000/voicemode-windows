import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { startHotkeyListener, stopHotkeyListener, setHotkeyMode, setHotkeyCombo } from './hotkey';
import { transcribe } from './stt';
import { enhance } from './llm';
import { typeText } from './typer';
import { createTray } from './tray';
import { hasSpeech, estimateDuration } from './vad';
import { addEntry } from './history';
import { IPC, DEFAULT_SETTINGS, type AppSettings, type PillState } from '../shared/types';

// Required for transparent windows on some Windows setups
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow: BrowserWindow | null = null;
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let cancelled = false;

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  // Use saved position or default to bottom-center
  const pillX = settings.pillX >= 0 ? settings.pillX : Math.round(screenWidth / 2 - 100);
  const pillY = settings.pillY >= 0 ? settings.pillY : screenHeight - 100;

  mainWindow = new BrowserWindow({
    width: 200,
    height: 60,
    x: pillX,
    y: pillY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.argv.includes('--dev') || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.setSkipTaskbar(true);

  // Persist pill position on drag
  let moveTimeout: ReturnType<typeof setTimeout>;
  mainWindow.on('move', () => {
    clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      const [x, y] = mainWindow!.getPosition();
      settings.pillX = x;
      settings.pillY = y;
    }, 300);
  });

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function sendState(state: PillState, detail?: string) {
  mainWindow?.webContents.send(IPC.STATE_CHANGE, state, detail);
}

function sendError(msg: string) {
  mainWindow?.webContents.send(IPC.ERROR, msg);
  sendState('error', msg);
}

async function handleAudioData(_event: Electron.IpcMainEvent, audioBuffer: Buffer) {
  cancelled = false;

  try {
    // VAD: skip if audio is silence or too short
    const duration = estimateDuration(audioBuffer);
    if (settings.vadEnabled && (duration < 0.3 || !hasSpeech(audioBuffer))) {
      console.log(`[VoxType] Skipped: ${duration.toFixed(1)}s, no speech detected`);
      sendState('idle');
      return;
    }

    console.log(`[VoxType] Processing ${duration.toFixed(1)}s audio (${(audioBuffer.length / 1024).toFixed(0)}KB)`);

    // Step 1: Transcribe
    sendState('processing');
    const transcript = await transcribe(audioBuffer, settings.whisperUrl);

    if (cancelled) return;
    if (!transcript.trim()) {
      sendState('idle');
      return;
    }

    // Step 2: Enhance (optional)
    let finalText = transcript;
    if (settings.enhanceEnabled) {
      sendState('enhancing');
      try {
        finalText = await enhance(transcript, settings.lmStudioUrl);
        if (!finalText.trim()) finalText = transcript;
      } catch (err) {
        console.error('LLM enhancement failed, using raw transcript:', err);
        finalText = transcript;
      }
    }

    if (cancelled) return;

    // Save to history
    if (settings.saveHistory) {
      addEntry(transcript, finalText);
    }

    // Step 3: Type
    sendState('typing');
    await typeText(finalText, settings.appendMode);

    sendState('idle');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Pipeline error:', msg);
    sendError(msg);
    setTimeout(() => sendState('idle'), 3000);
  }
}

app.whenReady().then(() => {
  createWindow();

  if (!mainWindow) return;

  // IPC handlers
  ipcMain.on(IPC.AUDIO_DATA, handleAudioData);
  ipcMain.on(IPC.CANCEL, () => { cancelled = true; });
  ipcMain.handle(IPC.GET_SETTINGS, () => ({ ...settings }));
  ipcMain.handle(IPC.SET_SETTINGS, (_e, partial: Partial<AppSettings>) => {
    Object.assign(settings, partial);
    if (partial.hotkeyMode) setHotkeyMode(partial.hotkeyMode);
    if (partial.hotkey) setHotkeyCombo(partial.hotkey as AppSettings['hotkey']);
    return { ...settings };
  });

  // Tray
  createTray(mainWindow, () => settings, (partial) => Object.assign(settings, partial));

  // Hotkey listener
  setHotkeyMode(settings.hotkeyMode);
  setHotkeyCombo(settings.hotkey);
  startHotkeyListener({
    onActivate: () => {
      cancelled = false;

      // Multi-monitor: move pill to the display with the cursor
      if (settings.pillX < 0) {
        const cursorPos = screen.getCursorScreenPoint();
        const activeDisplay = screen.getDisplayNearestPoint(cursorPos);
        const { x: dx, y: dy, width: dw, height: dh } = activeDisplay.workArea;
        mainWindow?.setPosition(
          Math.round(dx + dw / 2 - 100),
          dy + dh - 100,
        );
      }

      mainWindow?.webContents.send(IPC.START_RECORDING);
      sendState('recording');
    },
    onDeactivate: () => {
      mainWindow?.webContents.send(IPC.STOP_RECORDING);
    },
  });
});

app.on('will-quit', () => {
  stopHotkeyListener();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — tray keeps app alive
});
