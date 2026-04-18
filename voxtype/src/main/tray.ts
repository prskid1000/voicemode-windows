import { app, Menu, Tray, BrowserWindow, nativeImage, NativeImage, clipboard, screen } from 'electron';
import path from 'path';
import type { AppSettings, DeviceMode } from '../shared/types';
import { setHotkeyMode, setHotkeyCombo, captureHotkey } from './hotkey';
import { getEntries, clearHistory } from './history';
import { WHISPER_MODELS } from './whisper-model';
import { FEATURED_VOICES } from './kokoro-voice';
import {
  getAvailableModels, getCurrentLLMModel, setLLMModel, fetchModels,
  resetAutoUnloadTimer, stopAutoUnloadTimer,
  unloadCurrentModel, preloadCurrentModel,
} from './llm';
import {
  restartService, isRunning, getStatus,
  startWhisper, startKokoro, stopService,
} from './services';

let tray: Tray | null = null;

export function createTray(
  mainWindow: BrowserWindow,
  getSettings: () => AppSettings,
  updateSettings: (s: Partial<AppSettings>) => void,
) {
  const iconPath = path.join(__dirname, '../../../resources/icon.png');

  let icon: NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    icon = nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0), { width: 16, height: 16 });
  }

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('VoxType');

  // ─── Service status helpers (live, not cached) ─────────────────────
  function statusBadge(name: 'whisper' | 'kokoro'): string {
    const s = getStatus(name);
    if (!s.running) return '○ off';
    if (!s.ready) return '… starting';
    return '● ready';
  }

  // ─── Submenu builders ──────────────────────────────────────────────

  function whisperMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: `Status: ${statusBadge('whisper')}`,
        enabled: false,
      },
      {
        label: 'Enabled',
        type: 'checkbox',
        checked: s.whisperEnabled,
        click: (item: any) => { updateSettings({ whisperEnabled: item.checked }); rebuildMenu(); },
      },
      { type: 'separator' },
      { label: '── Model ──', enabled: false },
      ...WHISPER_MODELS.map((m) => ({
        label: m.label,
        type: 'radio' as const,
        checked: s.whisperModel === m.id,
        enabled: s.whisperEnabled,
        click: () => { updateSettings({ whisperModel: m.id }); rebuildMenu(); },
      })),
      { type: 'separator' },
      { label: '── Device ──', enabled: false },
      ...(['gpu', 'cpu'] as DeviceMode[]).map((d) => ({
        label: d === 'gpu' ? 'GPU' : 'CPU',
        type: 'radio' as const,
        checked: s.whisperDevice === d,
        enabled: s.whisperEnabled,
        click: () => { updateSettings({ whisperDevice: d }); rebuildMenu(); },
      })),
      { type: 'separator' },
      {
        label: 'Restart now',
        enabled: s.whisperEnabled && isRunning('whisper'),
        click: async () => {
          await restartService('whisper', {
            model: s.whisperModel, port: s.whisperPort, device: s.whisperDevice,
          });
          rebuildMenu();
        },
      },
    ];
    return { label: `Whisper (STT) — ${statusBadge('whisper')}`, submenu: items };
  }

  function kokoroMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: `Status: ${statusBadge('kokoro')}`,
        enabled: false,
      },
      {
        label: 'Enabled',
        type: 'checkbox',
        checked: s.kokoroEnabled,
        click: (item: any) => { updateSettings({ kokoroEnabled: item.checked }); rebuildMenu(); },
      },
      { type: 'separator' },
      { label: '── Voice ──', enabled: false },
      ...FEATURED_VOICES.map((v) => ({
        label: v.label,
        type: 'radio' as const,
        checked: s.kokoroVoice === v.id,
        enabled: s.kokoroEnabled,
        click: () => { updateSettings({ kokoroVoice: v.id }); rebuildMenu(); },
      })),
      { type: 'separator' },
      { label: '── Device ──', enabled: false },
      ...(['gpu', 'cpu'] as DeviceMode[]).map((d) => ({
        label: d === 'gpu' ? 'GPU' : 'CPU',
        type: 'radio' as const,
        checked: s.kokoroDevice === d,
        enabled: s.kokoroEnabled,
        click: () => { updateSettings({ kokoroDevice: d }); rebuildMenu(); },
      })),
      { type: 'separator' },
      {
        label: 'Restart now',
        enabled: s.kokoroEnabled && isRunning('kokoro'),
        click: async () => {
          await restartService('kokoro', { port: s.kokoroPort, device: s.kokoroDevice });
          rebuildMenu();
        },
      },
    ];
    return { label: `Kokoro (TTS) — ${statusBadge('kokoro')}`, submenu: items };
  }

  function llmMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    const models = getAvailableModels();
    const current = getCurrentLLMModel();
    const modelItems: Electron.MenuItemConstructorOptions[] = models.length === 0
      ? [{ label: 'No models found', enabled: false }]
      : models.map((m) => ({
          label: `${m.id}${m.state === 'loaded' ? ' (loaded)' : ''}`,
          type: 'radio' as const,
          checked: current === m.id,
          click: () => { setLLMModel(m.id); updateSettings({ llmModel: m.id }); rebuildMenu(); },
        }));

    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Enhance transcript',
        type: 'checkbox',
        checked: s.enhanceEnabled,
        click: (item: any) => { updateSettings({ enhanceEnabled: item.checked }); rebuildMenu(); },
      },
      {
        label: 'Screen context (vision)',
        type: 'checkbox',
        checked: s.screenContext,
        click: (item: any) => { updateSettings({ screenContext: item.checked }); rebuildMenu(); },
      },
      { type: 'separator' },
      { label: '── Model ──', enabled: false },
      ...modelItems,
      { type: 'separator' },
      {
        label: 'Refresh models',
        click: async () => { await fetchModels(s.lmStudioUrl); rebuildMenu(); },
      },
    ];
    return { label: 'LM Studio (LLM)', submenu: items };
  }

  async function loadAll(s: AppSettings): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (s.whisperEnabled && !isRunning('whisper')) {
      tasks.push(startWhisper({ model: s.whisperModel, port: s.whisperPort, device: s.whisperDevice }));
    }
    if (s.kokoroEnabled && !isRunning('kokoro')) {
      tasks.push(startKokoro({ port: s.kokoroPort, device: s.kokoroDevice }));
    }
    tasks.push(preloadCurrentModel(s.lmStudioUrl));
    await Promise.allSettled(tasks);
    if (s.autoUnloadMinutes > 0) resetAutoUnloadTimer(s.autoUnloadMinutes, s.lmStudioUrl);
  }

  async function unloadAll(s: AppSettings): Promise<void> {
    stopAutoUnloadTimer();
    const tasks: Promise<unknown>[] = [];
    if (isRunning('whisper')) tasks.push(stopService('whisper'));
    if (isRunning('kokoro')) tasks.push(stopService('kokoro'));
    tasks.push(unloadCurrentModel(s.lmStudioUrl));
    await Promise.allSettled(tasks);
  }

  function powerMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    const unloadOptions = [0, 5, 10, 15, 30, 60];
    return {
      label: 'Power',
      submenu: [
        {
          label: 'Load all',
          click: async () => { await loadAll(s); rebuildMenu(); },
        },
        {
          label: 'Unload all',
          click: async () => { await unloadAll(s); rebuildMenu(); },
        },
        { type: 'separator' },
        {
          label: 'Preload on startup',
          type: 'checkbox',
          checked: s.preloadModel,
          click: (item: any) => { updateSettings({ preloadModel: item.checked }); rebuildMenu(); },
        },
        {
          label: 'Auto-unload after',
          submenu: unloadOptions.map((mins) => ({
            label: mins === 0 ? 'Off' : `${mins} min`,
            type: 'radio' as const,
            checked: s.autoUnloadMinutes === mins,
            click: () => {
              updateSettings({ autoUnloadMinutes: mins });
              if (mins > 0) resetAutoUnloadTimer(mins, s.lmStudioUrl);
              else stopAutoUnloadTimer();
              rebuildMenu();
            },
          })),
        },
      ],
    };
  }

  function recordingMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    return {
      label: 'Recording',
      submenu: [
        {
          label: 'Auto-stop on silence',
          type: 'checkbox',
          checked: s.autoStopOnSilence,
          click: (item) => { updateSettings({ autoStopOnSilence: item.checked }); rebuildMenu(); },
        },
        {
          label: 'Skip silence (VAD)',
          type: 'checkbox',
          checked: s.vadEnabled,
          click: (item) => { updateSettings({ vadEnabled: item.checked }); rebuildMenu(); },
        },
        {
          label: 'Append mode (preserve clipboard)',
          type: 'checkbox',
          checked: s.appendMode,
          click: (item) => { updateSettings({ appendMode: item.checked }); rebuildMenu(); },
        },
      ],
    };
  }

  function historyMenu(s: AppSettings): Electron.MenuItemConstructorOptions {
    const history = getEntries();
    const recent: Electron.MenuItemConstructorOptions[] = history.slice(0, 10).map((entry) => {
      const label = entry.enhanced.length > 50 ? entry.enhanced.substring(0, 50) + '…' : entry.enhanced;
      const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { label: `${time}  ${label}`, click: () => clipboard.writeText(entry.enhanced) };
    });
    if (recent.length === 0) recent.push({ label: 'No history yet', enabled: false });

    return {
      label: 'History',
      submenu: [
        {
          label: 'Save history',
          type: 'checkbox',
          checked: s.saveHistory,
          click: (item) => { updateSettings({ saveHistory: item.checked }); rebuildMenu(); },
        },
        { type: 'separator' },
        { label: '── Recent ──', enabled: false },
        ...recent,
        { type: 'separator' },
        { label: 'Clear history', click: () => { clearHistory(); rebuildMenu(); } },
      ],
    };
  }

  function pillMenu(): Electron.MenuItemConstructorOptions {
    return {
      label: 'Pill',
      submenu: [
        {
          label: mainWindow.isVisible() ? 'Hide pill' : 'Show pill',
          click: () => { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); rebuildMenu(); },
        },
        {
          label: 'Reset position',
          click: () => {
            updateSettings({ pillX: -1, pillY: -1 });
            const { width, height } = screen.getPrimaryDisplay().workAreaSize;
            mainWindow.setPosition(Math.round(width / 2 - 100), height - 100);
            rebuildMenu();
          },
        },
      ],
    };
  }

  // ─── Top-level menu ────────────────────────────────────────────────

  function rebuildMenu() {
    const s = getSettings();
    const menu = Menu.buildFromTemplate([
      {
        label: 'Hold to talk',
        type: 'radio',
        checked: s.hotkeyMode === 'hold',
        click: () => { updateSettings({ hotkeyMode: 'hold' }); setHotkeyMode('hold'); rebuildMenu(); },
      },
      {
        label: 'Toggle on / off',
        type: 'radio',
        checked: s.hotkeyMode === 'toggle',
        click: () => { updateSettings({ hotkeyMode: 'toggle' }); setHotkeyMode('toggle'); rebuildMenu(); },
      },
      { type: 'separator' },
      {
        label: `Hotkey: ${s.hotkey.label}`,
        click: async () => {
          tray?.setToolTip('Press your hotkey…');
          const newCombo = await captureHotkey();
          updateSettings({ hotkey: newCombo });
          setHotkeyCombo(newCombo);
          tray?.setToolTip('VoxType');
          rebuildMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Services',
        submenu: [
          whisperMenu(s), kokoroMenu(s), llmMenu(s),
          { type: 'separator' },
          powerMenu(s),
        ],
      },
      recordingMenu(s),
      historyMenu(s),
      pillMenu(),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray?.setContextMenu(menu);
  }

  rebuildMenu();
  tray.on('click', () => { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); rebuildMenu(); });

  // Periodically refresh the menu so service status badges (○ off / …
  // starting / ● ready) update without the user having to reopen it.
  setInterval(() => rebuildMenu(), 5000);

  return { rebuildMenu };
}
