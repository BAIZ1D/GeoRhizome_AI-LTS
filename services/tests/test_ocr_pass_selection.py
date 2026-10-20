"""Dual-PSM pass selection in collector/utils/markitdown_ocr_pipeline.py."""
from __future__ import annotations

import importlib.util
import os
import sys
import types

_PIPE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "georhizome-ai-source", "collector", "utils", "markitdown_ocr_pipeline.py")
)


def _load():
    for name in ("fitz", "pymupdf4llm", "pytesseract", "PIL"):
        sys.modules.setdefault(name, types.ModuleType(name))
    pil = sys.modules["PIL"]
    for attr in ("Image", "ImageEnhance"):
        if not hasattr(pil, attr):
            setattr(pil, attr, types.ModuleType(attr))
    spec = importlib.util.spec_from_file_location("ocr_pipe_under_test", _PIPE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Real Tesseract output (E2E-01, horizontal scanned page): the PSM 5 vertical pass is longer
# because of noise characters, but carries fewer Japanese characters.
HORIZ = "電線共同溝工事の施工基準第一条掘削深度は一・ニメートルとする。\n\n第二条管路の砂厚は十センチメートルとする。\n第三条台風接近時は工事を中止する。\n\n第四条埋戻しには良質な砂を使用する。\n\n第五条舗装復旧は翌日までに完了させる。"
VERT_GARBLE = "る\n\nO す O\n\nると 。 るかル 。 。 るせとトるすや 1\n\nル | す用了トメ止使完ーチ中をに誉メへを砂で基ニや事なま日・十工質日施 | はは良翌のは厚時はは事度砂近に 。 旧エエ深 6 接し復潮削路風戻装同中管台埋結共条条条条条線 | 1 三四回電第第第第第"


def test_horizontal_page_keeps_horizontal_pass_even_if_vertical_is_longer():
    m = _load()
    assert len(VERT_GARBLE) > len(HORIZ)
    assert m.select_ocr_pass(HORIZ, VERT_GARBLE) == HORIZ


def test_vertical_pass_wins_when_it_recognizes_more_japanese():
    m = _load()
    vert = "縦書きの日本語文書を正しく認識しました。" * 3
    assert m.select_ocr_pass("ABC 1 2", vert) == vert


def test_tie_prefers_horizontal():
    m = _load()
    assert m.select_ocr_pass("日本語", "語本日") == "日本語"


def test_parser_messages_are_routed_to_stderr(monkeypatch):
    """pymupdf.message() writes to stdout, which the collector reads as document text."""
    m = _load()
    calls = []
    monkeypatch.setattr(m.fitz, "set_messages", lambda **kw: calls.append(kw), raising=False)
    m.route_parser_messages_to_stderr()
    assert calls == [{"stream": sys.stderr}]
