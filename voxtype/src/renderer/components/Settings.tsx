import { useState, useEffect } from 'react';
import type { HotkeyMode } from '@shared/types';

interface SettingsData {
  hotkeyMode: HotkeyMode;
  enhanceEnabled: boolean;
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData>({
    hotkeyMode: 'hold',
    enhanceEnabled: true,
  });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    window.voxtype.getSettings().then((s) => {
      setSettings(s as unknown as SettingsData);
    });
  }, [open]);

  const update = (partial: Partial<SettingsData>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    window.voxtype.setSettings(partial);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-2 right-2 w-6 h-6 rounded-full bg-white/10 hover:bg-white/20
                   text-white/60 text-xs flex items-center justify-center transition-colors"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        ?
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-gray-900/95 backdrop-blur-xl rounded-2xl p-4 text-white text-sm"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="flex justify-between items-center mb-4">
        <span className="font-semibold">Settings</span>
        <button onClick={() => setOpen(false)} className="text-white/60 hover:text-white">
          X
        </button>
      </div>

      <label className="flex items-center justify-between mb-3">
        <span>Mode</span>
        <select
          value={settings.hotkeyMode}
          onChange={(e) => update({ hotkeyMode: e.target.value as HotkeyMode })}
          className="bg-gray-800 rounded px-2 py-1 text-xs"
        >
          <option value="hold">Hold-to-talk</option>
          <option value="toggle">Toggle</option>
        </select>
      </label>

      <label className="flex items-center justify-between mb-3">
        <span>LLM Enhancement</span>
        <input
          type="checkbox"
          checked={settings.enhanceEnabled}
          onChange={(e) => update({ enhanceEnabled: e.target.checked })}
          className="accent-blue-500"
        />
      </label>

      <div className="text-white/40 text-xs mt-4">
        Hotkey: Ctrl+Win
      </div>
    </div>
  );
}
