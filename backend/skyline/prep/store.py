"""SQLite store: ephemeris cache, saved landers, file checks and precompute stamps.

One connection per thread (FastAPI runs sync handlers in a thread pool). WAL mode so readers do not block the writer.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .. import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS ephemeris (
  body TEXT NOT NULL, t INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (body, t));
CREATE TABLE IF NOT EXISTS ephem_months (
  body TEXT NOT NULL, month TEXT NOT NULL, source TEXT NOT NULL, fetched_utc TEXT NOT NULL, rows INTEGER NOT NULL,
  PRIMARY KEY (body, month));
CREATE TABLE IF NOT EXISTS landers (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, verified_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stamps (step TEXT PRIMARY KEY, inputs_hash TEXT NOT NULL, code_version TEXT NOT NULL, done_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dsn (
  station TEXT NOT NULL, t INTEGER NOT NULL, az REAL NOT NULL, el REAL NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (station, t));
CREATE TABLE IF NOT EXISTS dsn_months (
  station TEXT NOT NULL, month TEXT NOT NULL, source TEXT NOT NULL, fetched_utc TEXT NOT NULL, rows INTEGER NOT NULL,
  PRIMARY KEY (station, month));
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path else config.DB_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.conn().executescript(SCHEMA)   # executescript manages its own transaction

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            self._local.c = c
        return c

    class _Tx:
        def __init__(self, c: sqlite3.Connection):
            self.c = c

        def __enter__(self):
            self.c.execute("BEGIN IMMEDIATE")
            return self.c

        def __exit__(self, et, ev, tb):
            self.c.execute("ROLLBACK" if et else "COMMIT")
            return False

    def tx(self) -> "Store._Tx":
        """A write transaction: everything inside is stored, or nothing is."""
        return Store._Tx(self.conn())

    # ---------- ephemeris ----------
    def month_info(self, body: str, month: str) -> dict | None:
        r = self.conn().execute("SELECT source, fetched_utc, rows FROM ephem_months WHERE body=? AND month=?", (body, month)).fetchone()
        return {"source": r[0], "fetched_utc": r[1], "rows": r[2]} if r else None

    def put_month(self, body: str, month: str, t: np.ndarray, xyz: np.ndarray, source: str) -> None:
        rows = [(body, int(ti), float(v[0]), float(v[1]), float(v[2]), source) for ti, v in zip(t, xyz)]
        with self.tx() as c:
            c.executemany("INSERT OR REPLACE INTO ephemeris (body, t, x, y, z, source) VALUES (?,?,?,?,?,?)", rows)
            c.execute("INSERT OR REPLACE INTO ephem_months (body, month, source, fetched_utc, rows) VALUES (?,?,?,?,?)",
                      (body, month, source, utcnow(), len(rows)))

    def get_vectors(self, body: str, t0: int, t1: int) -> tuple[np.ndarray, np.ndarray, list[str]]:
        cur = self.conn().execute("SELECT t, x, y, z, source FROM ephemeris WHERE body=? AND t>=? AND t<=? ORDER BY t", (body, t0, t1))
        rows = cur.fetchall()
        if not rows:
            return np.zeros(0, np.int64), np.zeros((0, 3)), []
        t = np.fromiter((r[0] for r in rows), np.int64, len(rows))
        xyz = np.array([(r[1], r[2], r[3]) for r in rows], dtype=np.float64)
        return t, xyz, [r[4] for r in rows]

    def months(self) -> list[dict]:
        cur = self.conn().execute("SELECT body, month, source, fetched_utc, rows FROM ephem_months ORDER BY month, body")
        return [dict(zip(("body", "month", "source", "fetched_utc", "rows"), r)) for r in cur.fetchall()]

    # ---------- Deep Space Network: Moon azimuth and elevation per station ----------
    def dsn_month_info(self, station: str, month: str) -> dict | None:
        r = self.conn().execute("SELECT source, fetched_utc, rows FROM dsn_months WHERE station=? AND month=?", (station, month)).fetchone()
        return {"source": r[0], "fetched_utc": r[1], "rows": r[2]} if r else None

    def put_dsn_month(self, station: str, month: str, t: np.ndarray, az: np.ndarray, el: np.ndarray, source: str) -> None:
        rows = [(station, int(ti), float(a), float(e), source) for ti, a, e in zip(t, az, el)]
        with self.tx() as c:
            c.executemany("INSERT OR REPLACE INTO dsn (station, t, az, el, source) VALUES (?,?,?,?,?)", rows)
            c.execute("INSERT OR REPLACE INTO dsn_months (station, month, source, fetched_utc, rows) VALUES (?,?,?,?,?)",
                      (station, month, source, utcnow(), len(rows)))

    def get_dsn(self, station: str, t0: int, t1: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
        rows = self.conn().execute("SELECT t, az, el, source FROM dsn WHERE station=? AND t>=? AND t<=? ORDER BY t", (station, t0, t1)).fetchall()
        if not rows:
            return np.zeros(0, np.int64), np.zeros(0), np.zeros(0), []
        return (np.fromiter((r[0] for r in rows), np.int64, len(rows)), np.array([r[1] for r in rows]),
                np.array([r[2] for r in rows]), [r[3] for r in rows])

    def dsn_months(self) -> list[dict]:
        cur = self.conn().execute("SELECT station, month, source, fetched_utc, rows FROM dsn_months ORDER BY month, station")
        return [dict(zip(("station", "month", "source", "fetched_utc", "rows"), r)) for r in cur.fetchall()]

    # ---------- landers ----------
    def list_landers(self) -> list[dict]:
        return [json.loads(r[0]) for r in self.conn().execute("SELECT body FROM landers ORDER BY id").fetchall()]

    def get_lander(self, lid: str) -> dict | None:
        r = self.conn().execute("SELECT body FROM landers WHERE id=?", (lid,)).fetchone()
        return json.loads(r[0]) if r else None

    def put_lander(self, lander: dict) -> bool:
        """Insert a new lander. False if the id is taken."""
        try:
            with self.tx() as c:
                c.execute("INSERT INTO landers (id, body, created_utc) VALUES (?,?,?)", (lander["id"], json.dumps(lander), utcnow()))
            return True
        except sqlite3.IntegrityError:
            return False

    def delete_lander(self, lid: str) -> bool:
        with self.tx() as c:
            return c.execute("DELETE FROM landers WHERE id=?", (lid,)).rowcount > 0

    # ---------- file checks ----------
    def file_check(self, path: str) -> dict | None:
        r = self.conn().execute("SELECT bytes, sha256, verified_utc FROM files WHERE path=?", (path,)).fetchone()
        return {"bytes": r[0], "sha256": r[1], "verified_utc": r[2]} if r else None

    def put_file_check(self, path: str, nbytes: int, sha256: str) -> None:
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO files (path, bytes, sha256, verified_utc) VALUES (?,?,?,?)", (path, nbytes, sha256, utcnow()))

    def drop_file_check(self, path: str) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM files WHERE path=?", (path,))

    # ---------- stamps ----------
    def stamp(self, step: str) -> dict | None:
        r = self.conn().execute("SELECT inputs_hash, code_version, done_utc FROM stamps WHERE step=?", (step,)).fetchone()
        return {"inputs_hash": r[0], "code_version": r[1], "done_utc": r[2]} if r else None

    def put_stamp(self, step: str, inputs_hash: str, code_version: str) -> None:
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO stamps (step, inputs_hash, code_version, done_utc) VALUES (?,?,?,?)",
                      (step, inputs_hash, code_version, utcnow()))


_default: Store | None = None
_default_lock = threading.Lock()


def default_store() -> Store:
    global _default
    with _default_lock:
        if _default is None or _default.path != config.DB_PATH:
            _default = Store(config.DB_PATH)
        return _default
