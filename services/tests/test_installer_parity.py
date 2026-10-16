from __future__ import annotations

import os
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
