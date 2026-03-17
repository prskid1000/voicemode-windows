import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

export async function typeText(text: string, append: boolean = false): Promise<void> {
  if (!text.trim()) return;

  const content = append ? ' ' + text : text;
  const tmpFile = path.join(os.tmpdir(), `voxtype-${Date.now()}.txt`);
  await writeFileAsync(tmpFile, content, 'utf-8');

  try {
    // In append mode: press End to move cursor to end of line, then paste
    const moveToEnd = append ? "[System.Windows.Forms.SendKeys]::SendWait('{END}')\nStart-Sleep -Milliseconds 30\n" : '';

    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$saved = [System.Windows.Forms.Clipboard]::GetText()
$text = Get-Content -Path '${tmpFile.replace(/\\/g, '\\\\')}' -Raw
${moveToEnd}[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
if ($saved) {
  [System.Windows.Forms.Clipboard]::SetText($saved)
} else {
  [System.Windows.Forms.Clipboard]::Clear()
}
`;

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ps,
    ], { timeout: 5000 });
  } finally {
    unlinkAsync(tmpFile).catch(() => {});
  }
}
