from __future__ import annotations

import json
import os
import threading

import pytest
import yaml

from core import config_io


def _leftovers(d):
    return [n for n in os.listdir(d) if n.startswith(".tmp-")]


def test_atomic_write_json_roundtrip(tmp_path):
    p = str(tmp_path / "a.json")
    config_io.atomic_write_json(p, {"x": 1, "y": "日本"})
    assert json.load(open(p, encoding="utf-8")) == {"x": 1, "y": "日本"}
    assert _leftovers(tmp_path) == []


def test_atomic_write_failure_leaves_no_tmp(tmp_path, monkeypatch):
    p = str(tmp_path / "a.json")
    config_io.atomic_write_json(p, {"keep": True})

    def boom(*a, **k):
        raise OSError("disk")

    monkeypatch.setattr(config_io.os, "replace", boom)
    with pytest.raises(OSError):
        config_io.atomic_write_json(p, {"keep": False})
    assert json.load(open(p)) == {"keep": True}
    assert _leftovers(tmp_path) == []


def test_atomic_write_yaml_preserves_order(tmp_path):
    p = str(tmp_path / "a.yaml")
    config_io.atomic_write_yaml(p, {"z": 1, "a": {"m": "日本", "b": 2}})
    text = open(p, encoding="utf-8").read()
    assert text.index("z:") < text.index("a:")
    assert "日本" in text
    assert yaml.safe_load(text)["a"]["b"] == 2


def test_replace_retried_on_permission_error(tmp_path, monkeypatch):
    p = str(tmp_path / "a.json")
    real = os.replace
    calls = {"n": 0}

    def flaky(a, b):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise PermissionError("locked")
        return real(a, b)

    monkeypatch.setattr(config_io.os, "replace", flaky)
    monkeypatch.setattr(config_io.time, "sleep", lambda s: None)
    config_io.atomic_write_json(p, {"ok": 1})
    assert calls["n"] == 3
    assert json.load(open(p)) == {"ok": 1}


def test_replace_gives_up_after_10(tmp_path, monkeypatch):
    p = str(tmp_path / "a.json")

    def always(a, b):
        raise PermissionError("locked")

    monkeypatch.setattr(config_io.os, "replace", always)
    monkeypatch.setattr(config_io.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        config_io.atomic_write_json(p, {"ok": 1})
    assert _leftovers(tmp_path) == []


def test_get_config_dir_env_and_default(monkeypatch):
    monkeypatch.setenv("GEORHIZOME_CONFIG_DIR", "/x/y")
    assert config_io.get_config_dir() == "/x/y"
    monkeypatch.delenv("GEORHIZOME_CONFIG_DIR")
    d = config_io.get_config_dir()
    assert d.endswith("config") and os.path.isfile(os.path.join(d, "app_config.json"))


def test_lock_is_reentrant():
    with config_io.CONFIG_LOCK:
        assert config_io.CONFIG_LOCK.acquire(blocking=False)
        config_io.CONFIG_LOCK.release()
    assert isinstance(config_io.CONFIG_LOCK, type(threading.RLock()))


def test_read_missing_returns_empty(tmp_path):
    assert config_io.read_json(str(tmp_path / "no.json")) == {}
    assert config_io.read_yaml(str(tmp_path / "no.yaml")) == {}
