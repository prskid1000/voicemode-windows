"""Helper to give each test its own settings.json sandbox.

`unittest discover` doesn't auto-load conftest.py, so each test module
imports this first. Idempotent — only sets VOXTYPE_DATA_DIR once."""
from __future__ import annotations

import os
import tempfile

if "VOXTYPE_DATA_DIR" not in os.environ:
    os.environ["VOXTYPE_DATA_DIR"] = tempfile.mkdtemp(prefix="voxtype-tests-")


def fresh_data_dir() -> str:
    """Create + return a brand-new isolated data dir for one test."""
    path = tempfile.mkdtemp(prefix="voxtype-tests-")
    os.environ["VOXTYPE_DATA_DIR"] = path
    # Reset config module state so it picks up the new dir.
    import importlib
    from voxtype import config
    importlib.reload(config)
    return path
