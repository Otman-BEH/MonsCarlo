"""Ephemeris: SPICE against main's DE421 truth, the Horizons reconstruction against SPICE, the month cache and its lock,
interpolation, and a live Horizons check (skipped unless -m live)."""
import json
import threading
from pathlib import Path

import numpy as np
import pytest

from skyline import config
from skyline.engine import ephemeris as EP
from skyline.engine.geometry import look, site_basis
from skyline.prep import horizons as H
from skyline.prep import spice
from skyline.prep.store import Store

FIX = Path(__file__).resolve().parent / "fixtures"
needs_kernels = pytest.mark.skipif(not spice.available(), reason="SPICE kernels not in the data directory")


def _angles(v, lat, lon):
    return look(site_basis(lat, lon, 0), v, 1.0)


def _diff(a, b):
    de = np.abs(a["el"] - b["el"])
    da = np.abs(((a["az"] - b["az"]) + 180) % 360 - 180) * np.cos(np.radians(b["el"]))
    return max(de.max(), da.max())


@needs_kernels
def test_spice_matches_main_truth():
    tr = json.loads((FIX / "truth.json").read_text())      # main's build/truth.py: SPICE DE421, 6-hourly
    t = tr["t0"] + np.arange(len(tr["rows"])) * tr["step"]
    s, e = spice.vectors(t)
    rows = np.array(tr["rows"])
    worst = 0.0
    for j, (_, lat, lon) in enumerate(tr["sites"]):
        for k, v in enumerate((s, e)):
            a = _angles(v, lat, lon)
            worst = max(worst, _diff(a, {"el": rows[:, j * 4 + k * 2], "az": rows[:, j * 4 + k * 2 + 1]}))
    assert worst < 0.005, worst


@needs_kernels
@pytest.mark.parametrize("body", ["sun", "earth"])
def test_horizons_reconstruction_matches_spice(body):
    t, az, el, rg = H.parse((FIX / f"horizons_{body}_2026-12.txt").read_text())
    assert len(t) == 31 * 24
    v = H.reconstruct(az, el, rg)
    s, e = spice.vectors(t)
    ref = s if body == "sun" else e
    for lat, lon in [(-89.99, 0), (-89.78, -155.73), (0.6741, 23.473), (-45.4446, 177.5991)]:
        assert _diff(_angles(v, lat, lon), _angles(ref, lat, lon)) < 0.01


def test_horizons_parse_and_bounds():
    t, az, el, rg = H.parse((FIX / "horizons_sun_2026-12.txt").read_text())
    t0, t1 = H.month_bounds("2026-12")
    assert t[0] == t0 and t[-1] == t1 - 3600 and np.all(np.diff(t) == 3600)
    with pytest.raises(H.HorizonsError):
        H.parse("no table here")


class FakeHorizons:
    """Serves the recorded December fixture; fails for other months; counts calls."""
    def __init__(self):
        self.calls = 0
        self.lock = threading.Lock()

    def __call__(self, body, month, timeout=None, session=None):
        with self.lock:
            self.calls += 1
        if month != "2026-12":
            raise H.HorizonsError("offline")
        text = (FIX / f"horizons_{body}_2026-12.txt").read_text()
        t, az, el, rg = H.parse(text)
        return t, H.reconstruct(az, el, rg), text


def test_month_cache_and_lock(tmp_path, monkeypatch):
    fake = FakeHorizons()
    monkeypatch.setattr(H, "fetch_month", fake)
    eph = EP.Ephemeris(Store(tmp_path / "e.db"))
    threads = [threading.Thread(target=eph.ensure_month, args=("sun", "2026-12")) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert fake.calls == 1                                   # the per-month lock stops duplicate fetches
    assert eph.ensure_month("sun", "2026-12") == H.SOURCE    # cached: no new call
    assert fake.calls == 1
    tab, src = eph.get_table(H.month_bounds("2026-12")[0] + 5 * 3600, 48)
    assert tab.shape == (48, 6) and src["2026-12"] == {"sun": H.SOURCE, "earth": H.SOURCE}


@needs_kernels
def test_spice_fallback_and_refresh(tmp_path, monkeypatch):
    fake = FakeHorizons()
    monkeypatch.setattr(H, "fetch_month", fake)
    eph = EP.Ephemeris(Store(tmp_path / "e.db"))
    assert eph.ensure_month("earth", "2027-01") == spice.SOURCE    # Horizons "offline" for January
    info = eph.store.month_info("earth", "2027-01")
    assert info["source"] == spice.SOURCE and info["rows"] == 31 * 24
    # a table spanning both months mixes sources and says so
    t0 = H.month_bounds("2027-01")[0] - 24 * 3600
    tab, src = eph.get_table(t0, 72)
    assert src["2026-12"]["sun"] == H.SOURCE and src["2027-01"]["earth"] == spice.SOURCE
    # continuity across the month boundary: Horizons and SPICE agree closely
    v = tab[:, 3:]
    step = np.linalg.norm(np.diff(v, axis=0), axis=1)
    assert step.max() / np.median(step) < 1.5


@needs_kernels
def test_exact_interpolation_error(tmp_path, monkeypatch):
    monkeypatch.setattr(H, "fetch_month", FakeHorizons())
    eph = EP.Ephemeris(Store(tmp_path / "e.db"), use_horizons=False)
    t = H.month_bounds("2027-02")[0] + 10 * 86400 + 1234.5
    s, e = eph.exact(t)
    s2, e2 = spice.vectors(np.array([t]))
    for a, b, lat, lon in ((s, s2[0], -89.78, -155.73), (e, e2[0], -89.78, -155.73), (e, e2[0], 0.67, 23.47)):
        assert _diff(_angles(a[None], lat, lon), _angles(b[None], lat, lon)) < 0.001


def test_months_helpers():
    assert EP.add_months("2026-11", 14) == "2028-01"
    t0 = H.month_bounds("2026-11")[0]
    assert EP.months_between(t0, t0 + 40 * 86400) == ["2026-11", "2026-12"]


@pytest.mark.live
@pytest.mark.parametrize("body", ["sun", "earth"])
def test_live_horizons(body):
    """Run on the laptop: python -m pytest -m live"""
    t, v, _ = H.fetch_month(body, "2027-03", timeout=60)
    assert len(t) == 31 * 24
    if spice.available():
        s, e = spice.vectors(t)
        assert _diff(_angles(v, -89.78, -155.73), _angles(s if body == "sun" else e, -89.78, -155.73)) < 0.01
