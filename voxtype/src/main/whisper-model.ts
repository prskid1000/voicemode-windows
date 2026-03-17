import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const INSTALL_DIR = path.join(os.homedir(), '.voicemode-windows');
const BAT_FILE = path.join(INSTALL_DIR, 'start-whisper-stt.bat');
const TASK_NAME = 'VoiceMode-Whisper-STT';

export const WHISPER_MODELS = [
  { id: 'Systran/faster-whisper-tiny', label: 'Tiny (fastest)' },
  { id: 'Systran/faster-whisper-base', label: 'Base' },
  { id: 'Systran/faster-whisper-small', label: 'Small (default)' },
  { id: 'Systran/faster-whisper-medium', label: 'Medium' },
  { id: 'Systran/faster-whisper-large-v3', label: 'Large v3 (best)' },
] as const;

export function getCurrentModel(): string {
  try {
    const content = fs.readFileSync(BAT_FILE, 'utf-8');
    const match = content.match(/faster-whisper-server\.exe"\s+(\S+)/);
    return match?.[1] || 'Systran/faster-whisper-small';
  } catch {
    return 'Systran/faster-whisper-small';
  }
}

export async function switchModel(modelId: string): Promise<void> {
  // Read current bat
  const content = fs.readFileSync(BAT_FILE, 'utf-8');

  // Replace model in the command line
  const updated = content.replace(
    /(faster-whisper-server\.exe"\s+)\S+/,
    `$1${modelId}`,
  );

  fs.writeFileSync(BAT_FILE, updated, 'utf-8');
  console.log(`[VoxType] Whisper model set to: ${modelId}`);

  // Kill running Whisper process, then restart task
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      [
        // Stop the scheduled task
        `Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
        // Kill the actual process (faster-whisper-server)
        `Get-Process -Name 'faster-whisper-server' -ErrorAction SilentlyContinue | Stop-Process -Force`,
        `Start-Sleep -Seconds 2`,
        // Start task again with new model
        `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
      ].join('; '),
    ], { timeout: 15000 });
    console.log(`[VoxType] Whisper task restarted`);
  } catch (err) {
    console.error('[VoxType] Failed to restart Whisper task:', err);
  }
}
