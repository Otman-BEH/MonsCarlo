"""Verify or download the raw NASA / JPL files listed in manifest.json.

Per entry: missing -> download (stream to .part, then rename) -> check size and sha256 (two tries, then fail loudly).
Present -> check size; a full sha256 runs on first verification or with --full, and is recorded in SQLite.

    python -m skyline.prep.fetch_data              # required files
    python -m skyline.prep.fetch_data --all        # also the optional ones
    python -m skyline.prep.fetch_data --full       # re-hash everything present
    python -m skyline.prep.fetch_data --hash       # print manifest entries with sha256 computed from local copies
    python -m skyline.prep.fetch_data --write-hashes   # fill empty sha256 fields in manifest.json from local copies
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests

from .. import config
from .store import Store, default_store

CHUNK = 1 << 20
MAX_TRIES = 3


@dataclass
class Result:
    name: str
    status: str          # ok | downloaded | missing | failed | skipped
    detail: str = ""


def load_manifest(path: Path | None = None) -> list[dict]:
    return json.loads(Path(path or config.MANIFEST_PATH).read_text())["files"]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h.hexdigest()


def _download(url: str, dest: Path, nbytes: int | None, log=print) -> None:
    """Stream to <dest>.part, resuming a partial .part with an HTTP Range request (some servers drop long transfers)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    if nbytes and have > nbytes:
        part.unlink()
        have = 0
    headers = {"User-Agent": config.USER_AGENT}
    if have:
        headers["Range"] = f"bytes={have}-"
    with requests.get(url, stream=True, timeout=60, headers=headers) as r:
        r.raise_for_status()
        resumed = have > 0 and r.status_code == 206
        if have and not resumed:
            have = 0
        got, t0, last = have, time.time(), 0.0
        with open(part, "ab" if resumed else "wb") as f:
            for b in r.iter_content(CHUNK):
                f.write(b)
                got += len(b)
                if nbytes and time.time() - last > 5:
                    last = time.time()
                    log(f"    {dest.name}: {100 * got / nbytes:5.1f}%  {got / 1e6 / max(1e-3, last - t0):.1f} MB/s")
    part.replace(dest)


def check_entry(e: dict, store: Store, data_dir: Path, full: bool = False, download: bool = True, log=print) -> Result:
    dest = data_dir / e["save"]
    rel = e["save"]
    want_sha = (e.get("sha256") or "").lower()
    tries = 0
    last_err = ""
    while True:
        downloaded = False
        if not dest.exists():
            if not download:
                return Result(e["name"], "missing")
            if tries >= MAX_TRIES:
                return Result(e["name"], "failed", f"no valid file after {MAX_TRIES} downloads ({last_err})")
            tries += 1
            log(f"  downloading {e['name']} ({(e.get('bytes') or 0) / 1e6:.1f} MB) from {e['url']}")
            try:
                _download(e["url"], dest, e.get("bytes"), log)
            except Exception as ex:  # network errors, HTTP errors, truncated transfers
                last_err = f"download error: {ex}"
                log(f"    {last_err}")
                time.sleep(2 * tries)
                continue
            store.drop_file_check(rel)
            downloaded = True
        size = dest.stat().st_size
        if e.get("bytes") and size != e["bytes"]:
            last_err = f"size {size} != manifest {e['bytes']}"
            log(f"  {e['name']}: {last_err}, removing and fetching again")
            dest.unlink()
            store.drop_file_check(rel)
            continue
        rec = store.file_check(rel)
        if rec and not full and rec["bytes"] == size and (not want_sha or rec["sha256"] == want_sha):
            return Result(e["name"], "downloaded" if downloaded else "ok", "size checked")
        got = sha256_of(dest)
        if want_sha and got != want_sha:
            last_err = "sha256 mismatch"
            log(f"  {e['name']}: sha256 mismatch, removing and fetching again")
            dest.unlink()
            store.drop_file_check(rel)
            continue
        store.put_file_check(rel, size, got)
        return Result(e["name"], "downloaded" if downloaded else "ok", "sha256 verified" if want_sha else "sha256 not pinned in manifest")


def run(include_optional: bool = False, full: bool = False, download: bool = True, store: Store | None = None,
        data_dir: Path | None = None, manifest: Path | None = None, log=print) -> list[Result]:
    store = store or default_store()
    data_dir = data_dir or config.DATA_DIR
    out = []
    for e in load_manifest(manifest):
        if e.get("optional") and not include_optional and not (data_dir / e["save"]).exists():
            out.append(Result(e["name"], "skipped", "optional"))
            continue
        out.append(check_entry(e, store, data_dir, full=full, download=download, log=log))
    return out


def status(store: Store | None = None, data_dir: Path | None = None) -> dict:
    """Readiness for /health: which required files are present (size check only, no hashing)."""
    data_dir = data_dir or config.DATA_DIR
    req = [e for e in load_manifest() if not e.get("optional")]
    missing = [e["save"] for e in req if not (data_dir / e["save"]).exists() or (e.get("bytes") and (data_dir / e["save"]).stat().st_size != e["bytes"])]
    return {"required": len(req), "ok": len(req) - len(missing), "missing": missing}


def _print_table(rs: list[Result]) -> None:
    w = max(len(r.name) for r in rs)
    for r in rs:
        print(f"  {r.name:<{w}}  {r.status:<10}  {r.detail}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="include optional files")
    ap.add_argument("--full", action="store_true", help="re-hash every present file")
    ap.add_argument("--no-download", action="store_true", help="only check what is on disk")
    ap.add_argument("--hash", action="store_true", help="print manifest entries with sha256 from local copies")
    ap.add_argument("--write-hashes", action="store_true", help="fill empty sha256 fields in manifest.json from local copies")
    a = ap.parse_args(argv)
    if a.hash or a.write_hashes:
        doc = json.loads(config.MANIFEST_PATH.read_text())
        for e in doc["files"]:
            p = config.DATA_DIR / e["save"]
            if p.exists():
                e["bytes"] = p.stat().st_size
                h = sha256_of(p)
                if e.get("sha256") and e["sha256"] != h:
                    print(f"WARNING {e['name']}: local sha256 differs from manifest", file=sys.stderr)
                if a.write_hashes and not e.get("sha256"):
                    e["sha256"] = h
                if a.hash:
                    print(json.dumps({**e, "sha256": h}))
        if a.write_hashes:
            config.MANIFEST_PATH.write_text(json.dumps(doc, indent=2) + "\n")
            print("manifest.json updated")
        return 0
    rs = run(include_optional=a.all, full=a.full, download=not a.no_download)
    _print_table(rs)
    bad = [r for r in rs if r.status in ("failed", "missing")]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
