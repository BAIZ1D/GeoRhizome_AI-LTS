from __future__ import annotations

import os
import subprocess

import pytest

from core import platform_compat as pc


class _R:
    def __init__(self, out):
        self.stdout = out


def _setup(monkeypatch, out, windows):
    killed = []
    monkeypatch.setattr(pc, "IS_WINDOWS", windows)
    monkeypatch.setattr(pc, "kill_process_tree", lambda pid: killed.append(pid))
    calls = []

    def fake_run(argv, **kw):
        calls.append((argv, kw))
        return _R(out)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return killed, calls


def test_posix_kills_listeners(monkeypatch):
    killed, calls = _setup(monkeypatch, "123\n456\n123\n", False)
    assert pc.kill_port_listeners(8004) == [123, 456]
    assert killed == [123, 456]
    assert calls[0][0] == ["lsof", "-ti:8004"] and not calls[0][1].get("shell")


def test_posix_none(monkeypatch):
    killed, _ = _setup(monkeypatch, "", False)
    assert pc.kill_port_listeners(8004) == [] and killed == []


def test_excludes_self(monkeypatch):
    killed, _ = _setup(monkeypatch, f"{os.getpid()}\n77\n", False)
    assert pc.kill_port_listeners(8004) == [77]
    assert killed == [77]


def test_windows_netstat_parse(monkeypatch):
    out = (
        "  Proto  Local Address          Foreign Address        State           PID\n"
        "  TCP    127.0.0.1:8004         0.0.0.0:0              LISTENING       999\n"
        "  TCP    127.0.0.1:18004        0.0.0.0:0              LISTENING       111\n"
        "  TCP    127.0.0.1:8004         127.0.0.1:5000         ESTABLISHED     222\n"
    )
    killed, calls = _setup(monkeypatch, out, True)
    assert pc.kill_port_listeners(8004) == [999]
    assert calls[0][0] == ["netstat", "-ano"]


@pytest.mark.parametrize("bad", [0, -1, 65536, "8004", None, 1.5, True])
def test_invalid_port(bad):
    with pytest.raises(ValueError):
        pc.kill_port_listeners(bad)
