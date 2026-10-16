#!/usr/bin/env python3
"""Static parity checks for the macOS (install.sh) and Windows (install.ps1) installers.

Usage: python scripts/check_installer_parity.py   (exit 1 on any failure)
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Callable, List, Tuple

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
INST = os.path.join(REPO, "installers")
SH = os.path.join(INST, "install.sh")
PS1 = os.path.join(INST, "install.ps1")
LAUNCH_SH = os.path.join(INST, "start_georhizome.command")
LAUNCH_BAT = os.path.join(INST, "start_georhizome.bat")
HELPER = os.path.join(INST, "georhizome_setup.py")

# Built by concatenation so this file does not itself match the stale-name scan.
STALE = ["Qwen3.5" + "-0.8B", "Qwen3" + "-0.6B", "Takenoko" + "12345678"]
HF_LEGACY_CLI = "huggingface" + "-cli"
EXPECTED_DEFAULTS = {
    "embedding": "cl-nagoya/ruri-v3-310m",
    "reranker": "cl-nagoya/ruri-v3-reranker-310m",
    "llm_repo": "dahara1/Qwen2.5-1.5B-Instruct-gguf-japanese-imatrix-128K",
    "llm_file": "Qwen2.5-1.5B-Instruct-Q3_K_M.gguf",
}
PINS = [
    "torch==2.5.1",
    "transformers==5.18.0",
    "sentence-transformers==6.1.0",
    "huggingface_hub>=1.31,<2",
    "llama-cpp-python[server]==0.3.4",
    "requests",
]
SCAN_SKIP_DIRS = {".git", "node_modules", ".planning", "graphify-out", "__pycache__", ".venv", "data", "dist"}
SCAN_SKIP_FILES = {
    os.path.join(REPO, "config", "model_catalog.json"),
    os.path.join(REPO, "CLAUDE.md"),
    os.path.join(REPO, "config", "active_models.json"),  # gitignored live runtime state
}
SCAN_EXT = {".py", ".js", ".jsx", ".mjs", ".json", ".sh", ".ps1", ".bat", ".command", ".yml", ".yaml", ".env", ".example", ".md"}


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


def _compose_blocks() -> List[Tuple[str, str]]:
    sh = _read(SH)
    ps = _read(PS1)
    out: List[Tuple[str, str]] = []
    m = re.search(r"<< 'EOF_COMPOSE'[^\n]*\n(.*?)\nEOF_COMPOSE", sh, re.S)
    if m:
        out.append(("install.sh", m.group(1)))
    m = re.search(r"\$ComposeContent = @(['\"])\r?\n(.*?)\r?\n\1@", ps, re.S)
    if m:
        body = m.group(2)
        out.append(("install.ps1", body if m.group(1) == "'" else body.replace("`$", "$")))
    return out


def _helper_defaults() -> dict:
    sys.path.insert(0, INST)
    import georhizome_setup  # noqa: E402

    return georhizome_setup.default_artifacts(os.path.join(REPO, "config"))


def _token_hits(text: str) -> list:
    """Installers must need no token: public GHCR image and public GitHub repo."""
    pats = [r"GHCR_READ_TOKEN", r"docker\s+login", r"ghp_", r"Authorization\s*[:=]\s*\"?(token|Bearer)", r"\$Token\b"]
    return [p for p in pats if re.search(p, text, re.IGNORECASE)]


def checks() -> List[Tuple[str, Callable[[], bool]]]:
    sh, ps = _read(SH), _read(PS1)
    both = {"install.sh": sh, "install.ps1": ps}

    def stale_scan() -> bool:
        hits = []
        for root, dirs, files in os.walk(REPO):
            dirs[:] = [d for d in dirs if d not in SCAN_SKIP_DIRS]
            for fn in files:
                p = os.path.join(root, fn)
                if p in SCAN_SKIP_FILES or os.path.splitext(fn)[1] not in SCAN_EXT and fn != ".env":
                    continue
                if p == os.path.abspath(__file__) or fn == "test_installer_parity.py":
                    continue
                try:
                    txt = _read(p)
                except Exception:
                    continue
                for s in STALE + [HF_LEGACY_CLI]:
                    if s in txt:
                        hits.append(f"{os.path.relpath(p, REPO)}: {s}")
        if hits:
            print("    " + "\n    ".join(hits[:20]))
        return not hits

    def defaults_same() -> bool:
        ok = all(re.search(r"georhizome_setup\.py\"?\s+download", t) for t in both.values())
        return ok and _helper_defaults() == EXPECTED_DEFAULTS

    def no_other_models() -> bool:
        return all(not re.search(r"[\w.-]+\.gguf", t) for t in both.values())

    def compose_valid() -> bool:
        import yaml

        blocks = _compose_blocks()
        if len(blocks) != 2:
            return False
        for _, b in blocks:
            d = yaml.safe_load(b)
            env = d["services"]["georhizome-core"]["environment"]
            if not isinstance(env, list) or not all(isinstance(e, str) and re.match(r"^[A-Z_]+=\S*$", e) for e in env):
                return False
            if not any(e.startswith("HARDWARE_SERVER_URL=") for e in env):
                return False
        return True

    return [
        ("both installers download the same three defaults via the helper", defaults_same),
        ("no hardcoded GGUF names in installers", no_other_models),
        ("no stale default names / legacy hf CLI outside catalog data", stale_scan),
        ("macOS uses GGML_METAL (not LLAMA_METAL)", lambda: 'CMAKE_ARGS="-DGGML_METAL=on"' in sh and "LLAMA_METAL" not in sh),
        ("Python >=3.10 check in both", lambda: all(re.search(r"\(3,\s*10\)", t) for t in both.values())),
        ("no token handling (public image/repo)", lambda: all(not _token_hits(t) for t in both.values())),
        ("pinned set in both", lambda: all(p in t for p in PINS for t in both.values())),
        ("no unpinned hub upgrade", lambda: all(not re.search(r"pip install -U huggingface_hub", t) for t in both.values())),
        ("install.sh: no /dev/null on pip/download lines", lambda: not [l for l in sh.splitlines() if re.search(r"pip|georhizome_setup|curl", l) and "/dev/null" in l and "command -v" not in l]),
        ("install.ps1: no Out-Null on pip/download lines", lambda: not [l for l in ps.splitlines() if re.search(r"pip|georhizome_setup|Invoke-RestMethod", l) and "Out-Null" in l]),
        ("install.ps1 checks $LASTEXITCODE", lambda: "$LASTEXITCODE" in ps),
        ("install.ps1 writes UTF-8 without BOM", lambda: "UTF8Encoding]::new($false)" in ps and "Out-File" not in ps),
        ("compose YAML blocks parse", compose_valid),
        ("launchers read LLM from config via helper", lambda: all("llm-path" in _read(p) and ".gguf" not in _read(p) for p in (LAUNCH_SH, LAUNCH_BAT))),
        ("OTA updaters migrate .env", lambda: all("georhizome_setup.py" in t and " migrate" in t for t in both.values())),
        ("nested georhizome-ai-source/services removed", lambda: not os.path.exists(os.path.join(REPO, "georhizome-ai-source", "services"))),
    ]


def main() -> int:
    failed = 0
    for name, fn in checks():
        try:
            ok = bool(fn())
        except Exception as e:  # report, don't crash
            print(f"    error: {e}")
            ok = False
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        failed += 0 if ok else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
