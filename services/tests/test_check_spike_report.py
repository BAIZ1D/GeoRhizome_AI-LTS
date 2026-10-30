from __future__ import annotations

import importlib.util
import re
import shutil
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_spike_report.py"
SRC = REPO / ".planning" / "phases" / "10-spike-gate-sparse-server"
FILES = ["10-SPIKE-REPORT.md", "10-SPIKE-S1.md", "10-SPIKE-S2S5.md", "10-SPIKE-S3S4.md"]

pytestmark = pytest.mark.skipif(not SRC.exists(), reason=".planning is local-only")

SMOKE = """
## Server smoke
- health_initial_loaded: false
- status_413_long: 413
- status_413_many: 413
- rss_loaded_mb: 500
- rss_after_unload_mb: 300
- port_freed: true
"""
CONTAINER = """
## Container reachability
- HTTP=200 http://host.docker.internal:8004/health
- container_loaded_before: false
- container_loaded_after: false
- port_freed: true
"""


def _load():
    spec = importlib.util.spec_from_file_location("check_spike_report", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def env(tmp_path):
    for f in FILES:
        shutil.copy(SRC / f, tmp_path / f)
    # Later plans append these sections to the live S1; tests add their own.
    edit(
        tmp_path,
        "10-SPIKE-S1.md",
        lambda t: re.sub(
            r"^## (Server smoke|Container reachability)\s*\n.*?(?=^## |\Z)",
            "",
            t,
            flags=re.M | re.S,
        ),
    )
    mod = _load()
    mod.PHASE_DIR = str(tmp_path)
    return mod, tmp_path


def run(mod, tmp, *extra):
    return mod.main([str(tmp / "10-SPIKE-REPORT.md"), *extra])


def edit(tmp, name, fn):
    p = tmp / name
    p.write_text(fn(p.read_text(encoding="utf-8")), encoding="utf-8")


def append(tmp, name, text):
    edit(tmp, name, lambda t: t + text)


def test_baseline_passes(env):
    mod, tmp = env
    assert run(mod, tmp) == 0


@pytest.mark.parametrize(
    "name,fn",
    [
        ("10-SPIKE-REPORT.md", lambda t: t.replace("SPK-03: PASS", "SPK-03: FAIL")),
        ("10-SPIKE-REPORT.md", lambda t: t + "\nthis was not run\n"),
        ("10-SPIKE-REPORT.md", lambda t: t.replace("SPK-05-WINDOWS: UNVERIFIED", "SPK-05-WINDOWS: PASS")),
        ("10-SPIKE-REPORT.md", lambda t: "\n".join(l for l in t.splitlines() if not l.startswith("SPK-05-WINDOWS"))),
        ("10-SPIKE-S2S5.md", lambda t: t.replace("real sources only:", "ks-e2e-test source:")),
        ("10-SPIKE-S2S5.md", lambda t: t.replace("CORPUS-LIMIT-ACCEPTED:", "ACCEPTED:")),
        ("10-SPIKE-S1.md", lambda t: t.replace("pooling_max_abs_diff: 0.0", "pooling_max_abs_diff: 1e-3")),
    ],
)
def test_spike_failures(env, name, fn):
    mod, tmp = env
    edit(tmp, name, fn)
    assert run(mod, tmp) == 1


def test_smoke_ok_and_failures(env):
    mod, tmp = env
    assert run(mod, tmp, "--stage", "smoke") == 1  # section absent
    append(tmp, "10-SPIKE-S1.md", SMOKE)
    assert run(mod, tmp, "--stage", "smoke") == 0
    edit(tmp, "10-SPIKE-S1.md", lambda t: t.replace("status_413_many: 413\n", ""))
    assert run(mod, tmp, "--stage", "smoke") == 1


def test_smoke_rss_and_port(env):
    mod, tmp = env
    append(tmp, "10-SPIKE-S1.md", SMOKE.replace("rss_after_unload_mb: 300", "rss_after_unload_mb: 600"))
    assert run(mod, tmp, "--stage", "smoke") == 1
    edit(tmp, "10-SPIKE-S1.md", lambda t: t.replace("rss_after_unload_mb: 600", "rss_after_unload_mb: 300").replace("port_freed: true", "port_freed: false"))
    assert run(mod, tmp, "--stage", "smoke") == 1


def test_final(env):
    mod, tmp = env
    append(tmp, "10-SPIKE-S1.md", SMOKE)
    assert run(mod, tmp, "--stage", "final") == 1
    append(tmp, "10-SPIKE-S1.md", CONTAINER)
    assert run(mod, tmp, "--stage", "final") == 0
    edit(tmp, "10-SPIKE-S1.md", lambda t: t.replace("container_loaded_before: false", "container_loaded_before: false").replace("container_loaded_after: false", "container_loaded_after: true"))
    assert run(mod, tmp, "--stage", "final") == 1


def test_final_no_http(env):
    mod, tmp = env
    append(tmp, "10-SPIKE-S1.md", SMOKE + CONTAINER.replace("HTTP=200", "HTTP=500"))
    assert run(mod, tmp, "--stage", "final") == 1
