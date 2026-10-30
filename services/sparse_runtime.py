"""SPLADE runtime helpers: chunked MLM-head pooling, sparse conversion, tokenizer self-test.

torch is imported lazily inside functions so importing this module stays cheap.
No model ids, vocab sizes or max_length literals live here; callers pass config.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

UINT16_LIMIT = 1 << 16


def assert_uint16_vocab(vocab_size: int) -> None:
    if int(vocab_size) > UINT16_LIMIT:
        raise ValueError(f"vocab_size {vocab_size} does not fit uint16 indices")


def _trunk_and_head(model: Any) -> Tuple[Any, Any]:
    """Isolate BertForMaskedLM attribute names (.bert trunk, .cls head)."""
    return model.bert, model.cls


def reference_pool(logits: Any, mask: Any) -> Any:
    """Card formula: max over T of log1p(relu(logits)) * mask. logits [B,T,V], mask [B,T]."""
    import torch

    with torch.inference_mode():
        x = torch.log1p(torch.relu(logits)) * mask.unsqueeze(-1).to(logits.dtype)
        return x.max(dim=1).values


def splade_pool_chunked(model: Any, input_ids: Any, attention_mask: Any, chunk: int) -> Any:
    """Trunk once, MLM head over sequence slices, running max. Equals reference_pool."""
    import torch

    if chunk < 1:
        raise ValueError("chunk must be >= 1")
    trunk, head = _trunk_and_head(model)
    with torch.inference_mode():
        hidden = trunk(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        T = hidden.shape[1]
        out = None
        for s in range(0, T, chunk):
            e = min(s + chunk, T)
            lg = head(hidden[:, s:e, :])
            lg.relu_()
            lg.log1p_()
            lg.mul_(attention_mask[:, s:e].unsqueeze(-1).to(lg.dtype))
            part = lg.max(dim=1).values
            out = part if out is None else torch.maximum(out, part)
            del lg
        return out


def to_sparse(vec_row: Any) -> Tuple[List[int], List[float]]:
    """1-D weights -> (ascending unique uint16-safe indices, positive float values)."""
    import torch

    assert_uint16_vocab(vec_row.shape[-1])
    with torch.inference_mode():
        idx = torch.nonzero(vec_row > 0, as_tuple=False).flatten()
        vals = vec_row[idx]
    return [int(i) for i in idx.tolist()], [float(v) for v in vals.tolist()]


def tokenizer_selftest(tokenizer: Any, sentences: Sequence[str], expected_tokens: Sequence[str]) -> Dict[str, Any]:
    """Tokenize sentences; ok only if no exception and all expected tokens appear."""
    seen: List[str] = []
    try:
        for s in sentences:
            seen.extend(tokenizer.tokenize(s))
    except Exception as exc:  # noqa: BLE001 - report any tokenizer failure
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    missing = [t for t in expected_tokens if t not in seen]
    if missing:
        return {"ok": False, "error": f"expected tokens missing: {missing}"}
    return {"ok": True, "error": None}
