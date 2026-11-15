"""Data preparation: fetch_data skip / re-download on checksum mismatch / resume, precompute stamp, SQLite landers."""
import hashlib
import json

import pytest

from skyline import config
from skyline.prep import fetch_data as FD
from skyline.prep import precompute as PC
from skyline.prep.store import Store


class FakeResp:
    def __init__(self, body: bytes, status=200):
        self.body, self.status_code = body, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _entry(body: bytes, name="f.bin"):
    return {"name": name, "save": f"raw/x/{name}", "url": "https://example.invalid/" + name, "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(), "source": "test"}


def test_fetch_downloads_then_skips(tmp_path, monkeypatch):
    body = b"lunar" * 1000
    calls = []
    monkeypatch.setattr(FD.requests, "get", lambda url, **kw: calls.append(kw) or FakeResp(body))
    st = Store(tmp_path / "s.db")
    e = _entry(body)
    r = FD.check_entry(e, st, tmp_path, log=lambda *a: None)
    assert r.status == "downloaded" and r.detail == "sha256 verified" and len(calls) == 1
    r = FD.check_entry(e, st, tmp_path, log=lambda *a: None)
    assert r.status == "ok" and r.detail == "size checked" and len(calls) == 1      # recorded: no re-hash, no download


def test_fetch_redownloads_on_checksum_mismatch(tmp_path, monkeypatch):
    good = b"good data" * 100
    p = tmp_path / "raw/x/f.bin"
    p.parent.mkdir(parents=True)
    p.write_bytes(b"bad! data" * 100)          # same size, wrong content
    monkeypatch.setattr(FD.requests, "get", lambda url, **kw: FakeResp(good))
    r = FD.check_entry(_entry(good), Store(tmp_path / "s.db"), tmp_path, log=lambda *a: None)
    assert r.status == "downloaded" and p.read_bytes() == good


def test_fetch_gives_up_after_bad_downloads(tmp_path, monkeypatch):
    good = b"x" * 50
    monkeypatch.setattr(FD.requests, "get", lambda url, **kw: FakeResp(b"y" * 50))
    monkeypatch.setattr(FD.time, "sleep", lambda s: None)
    r = FD.check_entry(_entry(good), Store(tmp_path / "s.db"), tmp_path, log=lambda *a: None)
    assert r.status == "failed"


def test_fetch_resumes_partial_download(tmp_path, monkeypatch):
    body = bytes(range(256)) * 40
    part = tmp_path / "raw/x/f.bin.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(body[:3000])
    seen = {}

    def get(url, **kw):
        seen.update(kw["headers"])
        return FakeResp(body[3000:], status=206)
    monkeypatch.setattr(FD.requests, "get", get)
    r = FD.check_entry(_entry(body), Store(tmp_path / "s.db"), tmp_path, log=lambda *a: None)
    assert seen.get("Range") == "bytes=3000-" and r.status == "downloaded"
    assert (tmp_path / "raw/x/f.bin").read_bytes() == body


def test_manifest_is_complete():
    files = FD.load_manifest()
    required = [e for e in files if not e.get("optional")]
    assert len(required) >= 11
    for e in files:
        assert e["url"].startswith("https://") and e["save"].startswith("raw/") and e["source"]
        assert e["bytes"] and e["bytes"] > 0
    assert all(e["sha256"] for e in required), "every required file has a pinned checksum"


def test_precompute_stamp(tmp_path, monkeypatch):
    st = Store(tmp_path / "s.db")
    calls = []
    monkeypatch.setattr(PC, "build_main_derived", lambda *a, **k: calls.append("main"))
    monkeypatch.setattr(PC, "_convert_compressed", lambda log: None)

    def fake_skylines(log=print):
        (config.DERIVED_DIR / "skylines").mkdir(parents=True, exist_ok=True)
        (config.DERIVED_DIR / "skylines" / "index.json").write_text("{}")
        calls.append("sky")
    monkeypatch.setattr(PC, "build_skylines", fake_skylines)
    monkeypatch.setattr(config, "DERIVED_DIR", tmp_path / "derived")
    assert PC.run(store=st, log=lambda *a: None) is True
    assert PC.run(store=st, log=lambda *a: None) is False                 # stamp matches: skipped
    monkeypatch.setattr(config, "CODE_VERSION", config.CODE_VERSION + "-bumped")
    assert PC.run(store=st, log=lambda *a: None) is True                  # version bump: reruns
    assert calls.count("sky") == 2


def test_main_packing_roundtrip(tmp_path):
    PC.build_main_derived(tmp_path)
    import numpy as np
    z = np.load(tmp_path / "coarse.npz")
    assert z["g"].shape == (720, 1440) and z["s"].shape == (120, 1440)
    pr = np.load(tmp_path / "main_profiles.npz")
    assert pr["shack"].shape == (7, 720)


def test_store_landers(tmp_path):
    st = Store(tmp_path / "s.db")
    assert st.put_lander({"id": "a", "name": "A"}) is True
    assert st.put_lander({"id": "a", "name": "A2"}) is False
    assert st.get_lander("a")["name"] == "A"
    assert st.delete_lander("a") is True and st.delete_lander("a") is False
