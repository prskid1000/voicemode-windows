import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDebugLog, logSession } from './debug-log';

// Must run before any other import that logs at module-init time.
initDebugLog();

import { startHotkeyListener, stopHotkeyListener, setHotkeyMode, setHotkeyCombo } from './hotkey';
import { transcribe, preloadWhisper } from './stt';
import { enhance, fetchModels, ensureLMStudio, preloadCurrentModel, resetAutoUnloadTimer, stopAutoUnloadTimer, getCurrentLLMModel } from './llm';
import { preloadKokoro } from './kokoro-voice';
import { captureActiveScreen } from './screen-capture';
import { typeText } from './typer';
import { createTray } from './tray';
import { hasSpeech, estimateDuration } from './vad';
import { addEntry } from './history';
import {
  startWhisper, startKokoro, stopAll as stopAllServices, restartService,
} from './services';
import { IPC, DEFAULT_SETTINGS, whisperUrlFor, type AppSettings, type PillState } from '../shared/types';

// Required for transparent windows on some Windows setups
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu-compositing');

// --- Settings persistence ---
const SETTINGS_DIR = path.join(os.homedir(), '.voxtype');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...data };
    }
  } catch (e) {
    console.error('[VoxType] Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: AppSettings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
  } catch (e) {
    console.error('[VoxType] Failed to save settings:', e);
  }
}

let mainWindow: BrowserWindow | null = null;
let settings: AppSettings = loadSettings();
let cancelled = false;
let pipelineRunning = false;

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
    show: false,
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
      saveSettings(settings);
    }, 300);
  });

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function sendState(state: PillState, detail?: string) {
  mainWindow?.webContents.send(IPC.STATE_CHANGE, state, detail);
}

// Reconcile child services with new settings. Called whenever settings change
// so toggling Whisper/Kokoro on/off, switching model/voice/device, or
// changing port immediately starts, stops, or restarts the right child.
async function applyServiceChanges(prev: AppSettings, next: AppSettings): Promise<void> {
  // Whisper
  if (prev.whisperEnabled !== next.whisperEnabled) {
    if (next.whisperEnabled) {
      await startWhisper({
        model: next.whisperModel,
        port: next.whisperPort,
        device: next.whisperDevice,
      });
    } else {
      await import('./services').then((s) => s.stopService('whisper'));
    }
  } else if (
    next.whisperEnabled &&
    (prev.whisperModel !== next.whisperModel ||
      prev.whisperPort !== next.whisperPort ||
      prev.whisperDevice !== next.whisperDevice)
  ) {
    await restartService('whisper', {
      model: next.whisperModel,
      port: next.whisperPort,
      device: next.whisperDevice,
    });
  }

  // Kokoro
  if (prev.kokoroEnabled !== next.kokoroEnabled) {
    if (next.kokoroEnabled) {
      await startKokoro({ port: next.kokoroPort, device: next.kokoroDevice });
    } else {
      await import('./services').then((s) => s.stopService('kokoro'));
    }
  } else if (
    next.kokoroEnabled &&
    (prev.kokoroPort !== next.kokoroPort || prev.kokoroDevice !== next.kokoroDevice)
  ) {
    await restartService('kokoro', { port: next.kokoroPort, device: next.kokoroDevice });
  }
}

function sendError(msg: string) {
  mainWindow?.webContents.send(IPC.ERROR, msg);
  sendState('error', msg);
}

async function handleAudioData(_event: Electron.IpcMainEvent, audioBuffer: Buffer) {
  if (pipelineRunning) {
    console.log('[VoxType] Pipeline already running — ignoring new audio');
    return;
  }
  pipelineRunning = true;
  cancelled = false;

  const t0 = Date.now();
  const duration = estimateDuration(audioBuffer);
  const audioKB = Math.round(audioBuffer.length / 1024);

  // Session record — filled in as the pipeline runs, flushed at the end.
  const rec: Parameters<typeof logSession>[0] = {
    ts: new Date().toISOString(),
    durationSec: +duration.toFixed(2),
    audioKB,
  };

  try {
    // VAD: skip if audio is silence or too short
    if (settings.vadEnabled && (duration < 0.3 || !hasSpeech(audioBuffer))) {
      console.log(`[VoxType] Skipped: ${duration.toFixed(1)}s, no speech detected`);
      rec.skipped = duration < 0.3 ? 'too-short' : 'no-speech';
      rec.totalMs = Date.now() - t0;
      logSession(rec);
      sendState('idle');
      return;
    }

    console.log(`[VoxType] Processing ${duration.toFixed(1)}s audio (${audioKB}KB)`);

    // Kick off screen capture in parallel with transcription so the screenshot
    // reflects what the user was looking at when they finished speaking,
    // without adding latency to the enhance step.
    const screenshotPromise: Promise<string | null> =
      settings.enhanceEnabled && settings.screenContext
        ? captureActiveScreen()
        : Promise.resolve(null);

    // Step 1: Transcribe
    sendState('processing');
    const sttStart = Date.now();
    const transcript = await transcribe(audioBuffer, whisperUrlFor(settings));
    rec.sttMs = Date.now() - sttStart;
    rec.raw = transcript;

    if (cancelled) { rec.skipped = 'cancelled'; rec.totalMs = Date.now() - t0; logSession(rec); return; }
    if (!transcript.trim()) {
      rec.skipped = 'empty-transcript';
      rec.totalMs = Date.now() - t0;
      logSession(rec);
      sendState('idle');
      return;
    }

    // Step 2: Enhance (optional)
    let finalText = transcript;
    if (settings.enhanceEnabled) {
      sendState('enhancing');
      try {
        const screenshot = await screenshotPromise;
        rec.hadScreenshot = !!screenshot;
        if (screenshot) rec.screenshotKB = Math.round((screenshot.length * 3) / 4 / 1024);
        rec.model = getCurrentLLMModel() ?? undefined;

        const llmStart = Date.now();
        finalText = await enhance(transcript, settings.lmStudioUrl, screenshot);
        rec.llmMs = Date.now() - llmStart;
        if (!finalText.trim()) finalText = transcript;
      } catch (err) {
        console.error('LLM enhancement failed, using raw transcript:', err);
        rec.error = err instanceof Error ? err.message : String(err);
        finalText = transcript;
      }
    }

    rec.enhanced = finalText;

    if (cancelled) { rec.skipped = 'cancelled'; rec.totalMs = Date.now() - t0; logSession(rec); return; }

    // Save to user-visible history (separate from sessions.jsonl debug log)
    if (settings.saveHistory) {
      addEntry(transcript, finalText);
    }

    // Step 3: Type
    sendState('typing');
    await typeText(finalText, settings.appendMode);

    sendState('idle');
    rec.totalMs = Date.now() - t0;
    logSession(rec);

    // Reset auto-unload timer after each successful use
    if (settings.autoUnloadMinutes > 0) {
      resetAutoUnloadTimer(settings.autoUnloadMinutes, settings.lmStudioUrl);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Pipeline error:', msg);
    rec.error = msg;
    rec.totalMs = Date.now() - t0;
    logSession(rec);
    sendError(msg);
    setTimeout(() => sendState('idle'), 3000);
  } finally {
    pipelineRunning = false;
  }
}

app.whenReady().then(() => {
  createWindow();

  if (!mainWindow) return;

  // IPC handlers
  ipcMain.on(IPC.AUDIO_DATA, handleAudioData);
  ipcMain.on(IPC.CANCEL, () => { cancelled = true; });
  ipcMain.handle(IPC.GET_SETTINGS, () => ({ ...settings }));
  ipcMain.handle(IPC.SET_SETTINGS, async (_e, partial: Partial<AppSettings>) => {
    const before = { ...settings };
    Object.assign(settings, partial);
    saveSettings(settings);
    if (partial.hotkeyMode) setHotkeyMode(partial.hotkeyMode);
    if (partial.hotkey) setHotkeyCombo(partial.hotkey as AppSettings['hotkey']);
    await applyServiceChanges(before, settings);
    return { ...settings };
  });

  // Build tray immediately so the user sees the app is alive — service
  // startup happens in the background and the tray reflects status changes.
  if (mainWindow) {
    createTray(mainWindow, () => settings, (partial) => {
      Object.assign(settings, partial);
      saveSettings(settings);
    });
  }

  // Spawn bundled services (Whisper, Kokoro) as child processes if enabled.
  // Health-check + preload run in parallel and are non-blocking.
  const whisperStartup = settings.whisperEnabled
    ? startWhisper({
        model: settings.whisperModel,
        port: settings.whisperPort,
        device: settings.whisperDevice,
      })
        .then(() =>
          settings.preloadModel
            ? preloadWhisper(whisperUrlFor(settings)).catch(() => {})
            : undefined,
        )
        .catch((e) => console.error('[VoxType] Whisper startup failed:', e))
    : Promise.resolve();

  const kokoroStartup = settings.kokoroEnabled
    ? startKokoro({ port: settings.kokoroPort, device: settings.kokoroDevice })
        .then(() =>
          settings.preloadModel
            ? preloadKokoro(settings.kokoroPort, settings.kokoroVoice).catch(() => {})
            : undefined,
        )
        .catch((e) => console.error('[VoxType] Kokoro startup failed:', e))
    : Promise.resolve();

  // LM Studio is external — VoxType doesn't manage it, just probes + preloads.
  const llmStartup = settings.preloadModel
    ? ensureLMStudio(settings.lmStudioUrl)
        .then(() => fetchModels(settings.lmStudioUrl, settings.llmModel))
        .then(() => preloadCurrentModel(settings.lmStudioUrl))
        .catch(() => {})
    : Promise.resolve();

  Promise.all([whisperStartup, kokoroStartup, llmStartup]).finally(() => {
    if (settings.autoUnloadMinutes > 0) {
      resetAutoUnloadTimer(settings.autoUnloadMinutes, settings.lmStudioUrl);
    }
  });

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

// Children must die with VoxType. before-quit fires once, early enough that
// async work can complete before the process exits.
let shuttingDown = false;
app.on('before-quit', async (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  e.preventDefault();
  console.log('[VoxType] Shutting down — stopping bundled services...');
  stopHotkeyListener();
  stopAutoUnloadTimer();
  try {
    await stopAllServices();
  } catch (err) {
    console.error('[VoxType] Service shutdown error (ignored):', err);
  }
  app.exit(0);
});

app.on('window-all-closed', () => {
  // Don't quit on window close — tray keeps app alive
});
