"""VoxType — local voice dictation overlay for Windows.

Pure-Python / PySide6 app. STT and TTS run in-process via ONNX Runtime.
An embedded OpenAI-compatible HTTP server (default port 6600) exposes
both to external clients (telecode, MCP tools, etc.). LLM transcript
cleanup is routed through telecode's dual-protocol proxy at
http://127.0.0.1:1235."""
__version__ = "0.3.0"
