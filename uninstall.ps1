#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstall VoxType — kills services, removes the scheduled task, optionally
    removes the install directory + user data.
#>
param(
    [string]$InstallDir = "$env:USERPROFILE\.voicemode-windows"
)

function Ok($msg)   { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

Write-Host "`n  VoxType Uninstaller`n" -ForegroundColor Cyan

# 1. Stop running VoxType (which will cleanly stop its child services)
$tasks = @(
    'VoxType-Dictation',
    # Legacy task names from the old multi-task layout — clean these up too
    'VoiceMode-Whisper-STT',
    'VoiceMode-Kokoro-TTS'
)
foreach ($t in $tasks) {
    $existing = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask    -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Ok "Removed task: $t"
    }
}

# 2. Kill any orphaned child processes (in case VoxType was killed without
#    chance to clean up its children)
foreach ($p in @('faster-whisper-server', 'uvicorn', 'electron')) {
    $procs = Get-Process -Name $p -ErrorAction SilentlyContinue
    foreach ($proc in $procs) {
        try {
            $proc | Stop-Process -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}
Ok "Killed any orphaned service processes"

# 3. VoxType user data
$voxTypeData = Join-Path $env:USERPROFILE ".voxtype"
if (Test-Path $voxTypeData) {
    $confirm = Read-Host "  Delete VoxType user data at $voxTypeData (settings, history, logs)? (y/N)"
    if ($confirm -eq 'y') {
        Remove-Item -Recurse -Force $voxTypeData -ErrorAction SilentlyContinue
        Ok "Removed $voxTypeData"
    }
}

# 4. Legacy ~/.voicemode dir (only existed for the old voice-mode MCP)
$legacyVoicemode = Join-Path $env:USERPROFILE ".voicemode"
if (Test-Path $legacyVoicemode) {
    $confirm = Read-Host "  Delete legacy voice-mode MCP data at $legacyVoicemode? (y/N)"
    if ($confirm -eq 'y') {
        Remove-Item -Recurse -Force $legacyVoicemode -ErrorAction SilentlyContinue
        Ok "Removed $legacyVoicemode"
    }
}

# 5. Install directory (venvs, Kokoro repo + model, built VoxType)
if (Test-Path $InstallDir) {
    $confirm = Read-Host "  Delete install directory $InstallDir (~3 GB)? (y/N)"
    if ($confirm -eq 'y') {
        Remove-Item -Recurse -Force $InstallDir
        Ok "Removed $InstallDir"
    } else {
        Warn "Install directory kept — re-run setup.ps1 anytime to reinstall the task."
    }
}

Write-Host "`n  Uninstall complete.`n" -ForegroundColor Green
