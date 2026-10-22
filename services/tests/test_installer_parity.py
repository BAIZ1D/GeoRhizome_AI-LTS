from __future__ import annotations

import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "scripts"))

import check_installer_parity as cip  # noqa: E402


def test_installer_parity_checks_all_pass():
    failed = []
    for name, fn in cip.checks():
        try:
            ok = bool(fn())
        except Exception as e:
            ok = False
            name = f"{name} ({e})"
        if not ok:
            failed.append(name)
    assert not failed, failed


def test_installers_need_no_token():
    for path in (cip.SH, cip.PS1):
        text = open(path, encoding="utf-8-sig").read()
        assert not cip._token_hits(text), (path, cip._token_hits(text))
        assert "REPLACE_ME_BEFORE_DISTRIBUTION" not in text


def test_launchers_use_llm_args_and_safe_degrade_trigger():
    for path in (cip.LAUNCH_SH, cip.LAUNCH_BAT):
        text = open(path, encoding="utf-8").read()
        assert "16384" not in text
        assert text.count("llm-args") >= 2  # initial + degrade
        assert "requires flash" in text
        assert not re.search(r"grep\s+-qi\s+['\"]?flash|/c:\"flash\"", text, re.I)
        assert "$HELPER" in text or "%HELPER%" in text
    assert "seq 1 30" in open(cip.LAUNCH_SH, encoding="utf-8").read()
    assert cip._launcher_flash_ok(cip.LAUNCH_SH) and cip._launcher_flash_ok(cip.LAUNCH_BAT)
