<#
.SYNOPSIS
  Creates a Windows scheduled task to auto-start VoxType at logon.
.PARAMETER VoxTypePath
  Path to the VoxType directory. Defaults to the script's own directory.
#>
param(
    [string]$VoxTypePath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$taskName = 'VoxType-Dictation'
$username = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$vbsFile  = Join-Path $VoxTypePath 'start-voxtype.vbs'

if (-not (Test-Path $vbsFile)) {
    Write-Error "start-voxtype.vbs not found at $vbsFile"
    exit 1
}

Write-Host "Creating scheduled task: $taskName" -ForegroundColor Cyan

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host '  Removing existing task...'
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

# wscript runs the VBS which launches electron.exe directly (GUI app, no console)
$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('"' + $vbsFile + '"') `
    -WorkingDirectory $VoxTypePath

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $username

$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

# Interactive: runs in user's desktop session (needed for GUI)
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $taskSettings -Principal $principal -Force | Out-Null

Write-Host "  Task created successfully." -ForegroundColor Green
Write-Host '  VoxType will auto-start at next logon.' -ForegroundColor Green
