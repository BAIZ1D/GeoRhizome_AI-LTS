from __future__ import annotations

import os
import shutil
import sys
from typing import Any, Dict, List, Optional

import pytest

SERVICES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_ROOT = os.path.abspath(os.path.join(SERVICES_DIR, ".."))
REPO_CONFIG = os.path.join(REPO_ROOT, "config")

for p in (SERVICES_DIR, REPO_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture
def tmp_config_dir(tmp_path, monkeypatch):
    d = tmp_path / "config"
    d.mkdir()
    for name in os.listdir(REPO_CONFIG):
        src = os.path.join(REPO_CONFIG, name)
        if os.path.isfile(src):
            shutil.copy(src, d / name)
    monkeypatch.setenv("GEORHIZOME_CONFIG_DIR", str(d))
    return str(d)


class _Param:
    def __init__(self, dtype: Any) -> None:
        self.dtype = dtype


class _Inner:
    def __init__(self, dtype: Any) -> None:
        self._p = _Param(dtype)

    def parameters(self):
        yield self._p


class FakeCrossEncoder:
    """Stand-in for sentence_transformers.CrossEncoder (no model load)."""

    instances: List["FakeCrossEncoder"] = []

    def __init__(self, model_name: str, **kwargs: Any) -> None:
        import torch

        self.model_name = model_name
        self.kwargs = kwargs
        dt = (kwargs.get("model_kwargs") or {}).get("dtype", torch.float32)
        self.model = _Inner(dt)
        self.predict_calls: List[Dict[str, Any]] = []
        self.force_dtype: Optional[Any] = None
        FakeCrossEncoder.instances.append(self)

    def half(self) -> "FakeCrossEncoder":
        import torch

        self.model._p.dtype = torch.float16
        return self

    def predict(self, pairs, batch_size: int = 32, show_progress_bar: bool = False, **kw):
        import numpy as np

        self.predict_calls.append({"batch_size": batch_size, "n": len(pairs)})
        # deterministic: longer shared prefix -> higher score
        return np.array([float(len(p[1]) % 97) - 40.0 for p in pairs], dtype=np.float32)


@pytest.fixture
def fake_ce():
    FakeCrossEncoder.instances = []
    return FakeCrossEncoder
