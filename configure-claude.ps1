#Requires -Version 5.1
<#
.SYNOPSIS
    Configure Claude Code to use local VoiceMode MCP server
.DESCRIPTION
    Uses the claude CLI to safely add the MCP server configuration.
    Does NOT modify .claude.json directly (it may have duplicate keys).
#>
param(
    [string]$InstallDir = "$env:USERPROFILE\.voicemode-windows",
    [int]$WhisperPort = 6600,
    [int]$KokoroPort = 6500
)

$voiceModeExe = Join-Path $InstallDir "mcp-venv\Scripts\voice-mode.exe"

if (-not (Test-Path $voiceModeExe)) {
    Write-Host "    [FAIL] voice-mode.exe not found at $voiceModeExe" -ForegroundColor Red
    exit 1
}

# Check if claude CLI is available
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Host "    [FAIL] claude CLI not found. Install Claude Code first." -ForegroundColor Red
    Write-Host ""
    Write-Host "    Manual setup: run this command after installing Claude Code:" -ForegroundColor Yellow
    Write-Host "    claude mcp add --scope user voicemode ``" -ForegroundColor White
    Write-Host "      -e PYTHONIOENCODING=utf-8 ``" -ForegroundColor White
    Write-Host "      -e OPENAI_API_KEY=sk-local-dummy ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_STT_BASE_URLS=http://127.0.0.1:$WhisperPort/v1 ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_TTS_BASE_URLS=http://127.0.0.1:$KokoroPort/v1 ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_KOKORO_PORT=$KokoroPort ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_WHISPER_PORT=$WhisperPort ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_DISABLE_SILENCE_DETECTION=false ``" -ForegroundColor White
    Write-Host "      -e VOICEMODE_DEFAULT_LISTEN_DURATION=30 ``" -ForegroundColor White
    Write-Host "      -- `"$voiceModeExe`"" -ForegroundColor White
    exit 1
}

# Remove existing voicemode entry if present
claude mcp remove voicemode --scope user 2>&1 | Out-Null

# Add voicemode MCP server with all env vars
$envArgs = @(
    "-e", "PYTHONIOENCODING=utf-8",
    "-e", "OPENAI_API_KEY=sk-local-dummy",
    "-e", "VOICEMODE_STT_BASE_URLS=http://127.0.0.1:$WhisperPort/v1",
    "-e", "VOICEMODE_TTS_BASE_URLS=http://127.0.0.1:$KokoroPort/v1",
    "-e", "VOICEMODE_KOKORO_PORT=$KokoroPort",
    "-e", "VOICEMODE_WHISPER_PORT=$WhisperPort",
    "-e", "VOICEMODE_DISABLE_SILENCE_DETECTION=false",
    "-e", "VOICEMODE_DEFAULT_LISTEN_DURATION=30"
)

claude mcp add --scope user voicemode @envArgs -- $voiceModeExe 2>&1 | Out-Null

Write-Host "    [OK] Claude Code configured with VoiceMode MCP" -ForegroundColor Green
Write-Host "    Restart Claude Code to activate." -ForegroundColor Yellow
