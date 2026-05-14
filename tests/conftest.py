"""Shared test setup.

Each test runs against an isolated VOXTYPE_DATA_DIR so the real
`voxtype/data/settings.json` is never touched. The env var is set
*before* any voxtype.config import so the module-level _ROOT
resolves to the tmp directory.

Works for both unittest and pytest.
"""
from __future__ import annotations

import os
import tempfile

# Set before any voxtype.* imports run.
_TMP = tempfile.mkdtemp(prefix="voxtype-tests-")
os.environ["VOXTYPE_DATA_DIR"] = _TMP
