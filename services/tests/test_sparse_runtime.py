from __future__ import annotations

import subprocess
import sys

import pytest

import sparse_runtime as sr

torch = pytest.importorskip("torch")


class _Out:
    def __init__(self, h):
        self.last_hidden_state = h


class _Cfg:
    vocab_size = 11


class _FakeBert(torch.nn.Module):
    def __init__(self, hidden, vocab):
        super().__init__()
        self.emb = torch.nn.Embedding(vocab, hidden)

    def forward(self, input_ids=None, attention_mask=None, **_):
        return _Out(self.emb(input_ids))


class _FakeMLM(torch.nn.Module):
    def __init__(self, hidden=6, vocab=11):
        super().__init__()
        self.config = _Cfg()
        self.bert = _FakeBert(hidden, vocab)
        self.cls = torch.nn.Linear(hidden, vocab)


def _batch(T=7):
    torch.manual_seed(0)
    ids = torch.randint(0, 11, (2, T))
    mask = torch.ones(2, T, dtype=torch.long)
    mask[1, T - 3 :] = 0
    return ids, mask


@pytest.mark.parametrize("chunk", [1, 3, 7, 100])
def test_chunked_matches_reference(chunk):
    m = _FakeMLM().eval()
    ids, mask = _batch()
    with torch.no_grad():
        logits = m.cls(m.bert(input_ids=ids, attention_mask=mask).last_hidden_state)
    ref = sr.reference_pool(logits, mask)
    got = sr.splade_pool_chunked(m, ids, mask, chunk)
    assert got.shape == (2, 11)
    assert torch.allclose(ref, got, atol=1e-6)


def test_padding_masked_out():
    m = _FakeMLM().eval()
    ids, mask = _batch()
    ids2 = ids.clone()
    ids2[1, -3:] = (ids2[1, -3:] + 1) % 11
    a = sr.splade_pool_chunked(m, ids, mask, 3)
    b = sr.splade_pool_chunked(m, ids2, mask, 3)
    assert torch.equal(a[1], b[1])


def test_to_sparse_sorted_unique_positive():
    row = torch.tensor([0.0, 2.0, 0.0, 0.5, 1.0])
    idx, val = sr.to_sparse(row)
    assert idx == [1, 3, 4]
    assert all(isinstance(i, int) for i in idx)
    assert all(v > 0 for v in val)


def test_to_sparse_zero_row():
    assert sr.to_sparse(torch.zeros(5)) == ([], [])


def test_vocab_over_uint16_raises():
    with pytest.raises(ValueError):
        sr.assert_uint16_vocab(65537)
    sr.assert_uint16_vocab(65536)
    with pytest.raises(ValueError):
        sr.to_sparse(torch.ones(65537))


class _Tok:
    def __init__(self, toks, fail=False):
        self.toks, self.fail = toks, fail

    def tokenize(self, s):
        if self.fail:
            raise RuntimeError("mecab dict missing")
        return self.toks


def test_tokenizer_selftest():
    ok = sr.tokenizer_selftest(_Tok(["202", "##5"]), ["x"], ["202", "##5"])
    assert ok["ok"] is True
    bad = sr.tokenizer_selftest(_Tok(["2025"]), ["x"], ["202", "##5"])
    assert bad["ok"] is False and bad["error"]
    err = sr.tokenizer_selftest(_Tok([], fail=True), ["x"], ["202"])
    assert err["ok"] is False and "mecab" in err["error"]


def test_import_does_not_import_torch():
    code = "import sys; sys.path.insert(0, %r); import sparse_runtime; print('torch' in sys.modules)" % (
        sr.__file__.rsplit("/", 1)[0]
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert out.stdout.strip() == "False", out.stderr
