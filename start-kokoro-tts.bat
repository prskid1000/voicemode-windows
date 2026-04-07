@echo off
title Kokoro TTS Server (port 6500)
set PYTHONUTF8=1
set USE_GPU=false
set USE_ONNX=false
set PROJECT_ROOT=C:\Users\prith\.voicemode-windows\Kokoro-FastAPI
set PYTHONPATH=%PROJECT_ROOT%;%PROJECT_ROOT%\api
set MODEL_DIR=src\models
set VOICES_DIR=src\voices\v1_0
set WEB_PLAYER_PATH=%PROJECT_ROOT%\web
cd /d %PROJECT_ROOT%
"C:\Users\prith\.voicemode-windows\tts-venv\Scripts\uvicorn.exe" api.src.main:app --host 127.0.0.1 --port 6500
