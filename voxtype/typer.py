"""Paste text at the cursor via clipboard + Ctrl+V (PowerShell SendKeys).

Matches voxtype/src/main/typer.ts exactly — same save/restore dance for
the user's clipboard contents. Using PowerShell (rather than pyautogui)
so pasted text keeps unicode and newlines intact regardless of the
target app's IME / input mode."""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time

log = logging.getLogger("voxtype.typer")

_PS_TEMPLATE = r"""
Add-Type -AssemblyName System.Windows.Forms
$saved = [System.Windows.Forms.Clipboard]::GetText()
$text = Get-Content -Path '{path}' -Raw
{move_to_end}[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
if ($saved) {{
  [System.Windows.Forms.Clipboard]::SetText($saved)
}} else {{
  [System.Windows.Forms.Clipboard]::Clear()
}}
"""


def type_text(text: str, append: bool = False) -> None:
    """Paste `text` at the current cursor position.

    If `append` is True, sends {END} first so the new text lands after
    the existing line content.
    """
    if not text.strip():
        log.info("type_text: empty after strip — skipping")
        return
    preview = text if len(text) <= 80 else text[:77] + "..."
    log.info("type_text: pasting %d chars (append=%s): %r",
             len(text), append, preview)
    content = (" " + text) if append else text
    fd, path = tempfile.mkstemp(prefix="voxtype-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        move_to_end = ""
        if append:
            move_to_end = (
                "[System.Windows.Forms.SendKeys]::SendWait('{END}')\n"
                "Start-Sleep -Milliseconds 30\n"
            )
        ps = _PS_TEMPLATE.format(path=path.replace("\\", "\\\\"), move_to_end=move_to_end)
        t0 = time.monotonic()
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True, timeout=5.0, check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            dur = time.monotonic() - t0
            if result.returncode != 0:
                log.error(
                    "type_text: PowerShell exited %d after %.2fs — stderr: %s",
                    result.returncode, dur,
                    result.stderr.decode("utf-8", errors="replace")[:500],
                )
                return
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            if stderr:
                log.warning("type_text: PowerShell stderr: %s", stderr[:500])
            log.info("type_text: paste sent in %.2fs", dur)
        except subprocess.TimeoutExpired as exc:
            log.warning("type_text timed out: %s", exc)
    finally:
        # Give the target app a moment to read the clipboard before we
        # remove the temp file; delete never fails silently in the
        # background.
        time.sleep(0.05)
        try:
            os.unlink(path)
        except OSError:
            pass
