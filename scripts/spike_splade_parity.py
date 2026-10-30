"""S1 spike: SPLADE load + parity + memory/timing on the pinned venv (one model, CPU fp32).

Usage: spike_splade_parity.py --corpus chunks.jsonl --max-length N [--chunk 128] [--batch-size 2] [--mps]
Model id and revision come from config/model_catalog.json sparse[0]; no literals here.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import socket
import statistics
import subprocess
import sys
import time
import unicodedata
import warnings
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "services"))

PORTS = (8000, 8001, 8002, 8003)
GOLDEN = [
    ("日本の首都は東京です。", {"首都": 1.83, "日本": 1.71, "東京": 1.64, "富士": 1.07, "地名": 0.91}),
    ("大阪万博は2025年に開催されます。", {"202": 1.61, "大阪": 1.5, "##5": 1.33, "開催": 1.15, "万博": 1.11}),
]
EXPECTED_TOKENS = ["202", "##5"]
CARD_TOL = 0.01
PAIR_TOL = 1e-5
TOPK = 20


def swap() -> str:
    try:
        return subprocess.run(["sysctl", "vm.swapusage"], capture_output=True, text=True).stdout.strip()
    except Exception as exc:  # noqa: BLE001
        return f"swap unavailable: {exc}"


def listening(port: int) -> bool:
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def load_corpus(path: str, n: int) -> List[str]:
    if not path or not os.path.isfile(path) or os.path.getsize(path) == 0:
        print(f"ERROR: --corpus missing or empty: {path}", file=sys.stderr)
        sys.exit(2)
    prov = os.path.join(os.path.dirname(os.path.abspath(path)), "chunks.provenance.json")
    if os.path.isfile(prov):
        doc = json.load(open(prov, encoding="utf-8"))
        for src in doc.get("sources", []):
            name = str(src.get("name", ""))
            if name.startswith("ks-") or "e2e" in name:
                print(f"ERROR: corpus provenance lists fixture source {name}", file=sys.stderr)
                sys.exit(2)
    rows: List[str] = []
    for line in open(path, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        if not isinstance(r.get("text"), str):
            print("ERROR: corpus row lacks string key 'text'", file=sys.stderr)
            sys.exit(2)
        rows.append(unicodedata.normalize("NFKC", r["text"]))
    if not rows:
        print("ERROR: corpus has no rows", file=sys.stderr)
        sys.exit(2)
    return rows


def top_terms(vec, tok, k: int):
    import torch

    vals, idx = torch.topk(vec, min(k, vec.shape[-1]))
    return [(tok.convert_ids_to_tokens(int(i)), float(v)) for v, i in zip(vals, idx)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "config", "model_catalog.json"))
    ap.add_argument("--model")
    ap.add_argument("--revision")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--max-length", type=int, required=True)
    ap.add_argument("--chunk", type=int, default=128)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--n-chunks", type=int, default=10)
    ap.add_argument("--mps", action="store_true")
    a = ap.parse_args()

    busy = [p for p in PORTS if listening(p)]
    if busy:
        print(f"ERROR: ports {busy} are listening. Stop :8000-:8003 services first (8 GB rule).", file=sys.stderr)
        return 2
    corpus = load_corpus(a.corpus, a.n_chunks)
    cat = json.load(open(a.config, encoding="utf-8"))["sparse"][0]
    model_id = a.model or cat["repo_id"]
    revision = a.revision or cat["revision"]

    import psutil
    import torch
    import transformers

    try:
        import fugashi
        import importlib.metadata as md

        vers = {n: md.version(n) for n in ("torch", "transformers", "fugashi", "unidic-lite")}
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: fugashi/unidic-lite not importable: {exc}", file=sys.stderr)
        return 2
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    from sparse_runtime import reference_pool, splade_pool_chunked, tokenizer_selftest, to_sparse

    proc = psutil.Process()
    print("versions:", vers)
    print("swap_before:", swap())
    results: Dict[str, Any] = {"versions": vers, "model": model_id, "revision": revision}
    peak = proc.memory_info().rss

    t0 = time.time()
    with warnings.catch_warnings(record=True) as wlog:
        warnings.simplefilter("always")
        tok = AutoTokenizer.from_pretrained(model_id, revision=revision)
        model, info = AutoModelForMaskedLM.from_pretrained(
            model_id, revision=revision, torch_dtype=torch.float32, output_loading_info=True
        )
    model.eval()
    load_s = time.time() - t0
    peak = max(peak, proc.memory_info().rss)
    bad = {k: v for k, v in info.items() if v}
    warn_txt = [str(w.message) for w in wlog]
    head_issue = [x for k, v in bad.items() for x in v if "cls.predictions" in x] + [
        w for w in warn_txt if "newly initialized" in w or "cls.predictions" in w
    ]
    print("loading_info_nonempty:", bad)
    print("warnings:", warn_txt)
    load_ok = not head_issue
    tok_name = type(tok).__name__
    print("tokenizer_class:", tok_name, "vocab:", model.config.vocab_size,
          "max_position_embeddings:", getattr(model.config, "max_position_embeddings", None))
    st = tokenizer_selftest(tok, [GOLDEN[1][0]], EXPECTED_TOKENS)
    print("tokenizer_selftest:", st)

    max_abs = 0.0
    overlap_ok = True
    order_ok = True
    card_ok = True
    nnz: List[int] = []
    for sent, card in GOLDEN:
        enc = tok(sent, return_tensors="pt", truncation=True, max_length=a.max_length)
        with torch.inference_mode():
            logits = model.cls(model.bert(**{k: v for k, v in enc.items() if k in ("input_ids", "attention_mask", "token_type_ids")}).last_hidden_state)
            ref = reference_pool(logits, enc["attention_mask"])
            del logits
        got = splade_pool_chunked(model, enc["input_ids"], enc["attention_mask"], a.chunk)
        d = float((ref - got).abs().max())
        max_abs = max(max_abs, d)
        tr, tg = top_terms(ref[0], tok, TOPK), top_terms(got[0], tok, TOPK)
        ov = len({t for t, _ in tr} & {t for t, _ in tg})
        overlap_ok &= ov == TOPK
        order_ok &= [t for t, _ in tr] == [t for t, _ in tg]
        asd = dict(tr)
        for term, v in card.items():
            if term not in asd or abs(asd[term] - v) > CARD_TOL:
                card_ok = False
                print(f"  card mismatch {term}: card={v} got={asd.get(term)}")
        idx, _ = to_sparse(got[0])
        nnz.append(len(idx))
        print(f"sentence {sent!r}: diff={d:.3e} overlap={ov}/{TOPK} nnz={len(idx)} top5={[(t, round(v, 2)) for t, v in tr[:5]]}")
    peak = max(peak, proc.memory_info().rss)

    # Timing on real chunks, batch of N
    texts = corpus[: a.n_chunks]
    per_batch: List[float] = []
    trunc = 0
    for i in range(0, len(texts), a.batch_size):
        b = texts[i : i + a.batch_size]
        t1 = time.time()
        enc = tok(b, return_tensors="pt", padding=True, truncation=True, max_length=a.max_length)
        raw = tok(b, truncation=False)["input_ids"]
        trunc += sum(1 for r in raw if len(r) > a.max_length)
        out = splade_pool_chunked(model, enc["input_ids"], enc["attention_mask"], a.chunk)
        for r in out:
            to_sparse(r)
        per_batch.append(time.time() - t1)
        peak = max(peak, proc.memory_info().rss)
    per_chunk = [x / a.batch_size for x in per_batch]
    srt = sorted(per_batch)
    p95 = srt[min(len(srt) - 1, int(round(0.95 * (len(srt) - 1))))]
    print("batch_seconds:", [round(x, 2) for x in per_batch])

    # MPS (optional, only after CPU passes)
    mps_verdict = "not run (CPU-only)"
    cpu_ok = load_ok and st["ok"] and tok_name == "BertJapaneseTokenizer" and max_abs <= PAIR_TOL and overlap_ok and order_ok and card_ok
    if a.mps and cpu_ok and torch.backends.mps.is_available():
        sent = GOLDEN[0][0] + GOLDEN[1][0]
        enc = tok(sent, return_tensors="pt", truncation=True, max_length=a.max_length)
        cpu_vec = splade_pool_chunked(model, enc["input_ids"], enc["attention_mask"], a.chunk)[0]
        m2 = model.to("mps").half()
        e2 = {k: v.to("mps") for k, v in enc.items()}
        mv = splade_pool_chunked(m2, e2["input_ids"], e2["attention_mask"], a.chunk)[0].float().cpu()
        a_ = {t for t, _ in top_terms(cpu_vec, tok, TOPK)}
        b_ = {t for t, _ in top_terms(mv, tok, TOPK)}
        o = len(a_ & b_) / TOPK
        mps_verdict = f"overlap {o:.2f} -> {'MPS fp16 allowed' if o >= 0.95 else 'CPU-only'}"
    rss_peak = peak / 1e6
    del model
    gc.collect()
    rss_after = proc.memory_info().rss / 1e6
    print("swap_after:", swap())

    results.update(
        load_ok=load_ok, tokenizer_class=tok_name, selftest=st, pooling_max_abs_diff=max_abs,
        overlap_ok=overlap_ok, order_ok=order_ok, card_ok=card_ok, load_seconds=load_s,
        batch_seconds=per_batch, per_chunk_seconds=per_chunk, batch_p95=p95, truncated=trunc,
        peak_rss_mb=rss_peak, rss_after_unload_mb=rss_after, mps=mps_verdict, nnz=nnz,
        n_timed=len(texts), max_length=a.max_length, chunk=a.chunk,
    )
    print("RESULT_JSON:", json.dumps(results, ensure_ascii=False, default=str))
    verdict = cpu_ok
    print("SPK-01:", "PASS" if verdict else "FAIL")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
