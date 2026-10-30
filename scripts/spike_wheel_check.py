"""Spike S5: wheel/sdist availability evidence from PyPI JSON (stdlib only)."""
from __future__ import annotations

import json
import urllib.request
from typing import Any, Dict, List

PACKAGES = [("fugashi", "1.5.2"), ("unidic-lite", "1.0.8")]
PYS = ["cp310", "cp311", "cp312"]


def fetch(pkg: str, ver: str) -> Dict[str, Any]:
    url = f"https://pypi.org/pypi/{pkg}/{ver}/json"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def has(files: List[Dict[str, Any]], py: str, pred) -> bool:
    for f in files:
        if f.get("packagetype") != "bdist_wheel":
            continue
        n = f["filename"]
        if (py in n or "py3-none-any" in n or "py2.py3-none-any" in n) and pred(n):
            return True
    return False


def main() -> int:
    rows = {
        "macosx arm64": lambda n: "macosx" in n and ("arm64" in n or "universal2" in n),
        "win_amd64": lambda n: "win_amd64" in n or "none-any" in n,
        "manylinux x86_64": lambda n: ("manylinux" in n and "x86_64" in n) or "none-any" in n,
        "manylinux aarch64": lambda n: ("manylinux" in n and "aarch64" in n) or "none-any" in n,
    }
    for pkg, ver in PACKAGES:
        try:
            data = fetch(pkg, ver)
        except Exception as e:  # evidence tool, never a gate
            print(f"{pkg}=={ver}: fetch failed: {e}")
            continue
        files = data["urls"]
        sd = [f for f in files if f["packagetype"] == "sdist"]
        print(f"\n### {pkg}=={ver}")
        print("| platform | " + " | ".join(PYS) + " |")
        print("|---|" + "---|" * len(PYS))
        for name, pred in rows.items():
            cells = ["yes" if has(files, py, pred) else "no" for py in PYS]
            print(f"| {name} | " + " | ".join(cells) + " |")
        print(f"sdist present: {'yes' if sd else 'no'}" + (f" ({sd[0]['size']} bytes)" if sd else ""))
        print("wheels: " + ", ".join(f["filename"] for f in files if f["packagetype"] == "bdist_wheel"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
