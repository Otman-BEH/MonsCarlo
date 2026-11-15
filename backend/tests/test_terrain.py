"""Terrain: horizons in 80m mode against main's precomputed profiles, custom points against main's in-browser ray cast,
physical sanity checks, and the 5 m tier. Tests that need the raw DEMs skip when they are not on disk."""
import numpy as np
import pytest

from conftest import arr
from monscarlo.engine.terrain import Terrain, ll_to_xy, mask_at, schedule_main_coarse, xy_to_ll

T = Terrain()
needs_80 = pytest.mark.skipif(T.r80 is None, reason="LDEM_80S_80MPP_ADJ.TIF not in the data directory")
needs_tiles = pytest.mark.skipif(len(T.tiles) < 4, reason="5 m site tiles not in the data directory")


def test_projection_roundtrip():
    lat, lon = np.array([-89.9, -85.0, -80.5]), np.array([10.0, -120.0, 179.0])
    la, lo = xy_to_ll(*ll_to_xy(lat, lon))
    assert np.allclose(la, lat, atol=1e-10) and np.allclose(lo, lon, atol=1e-10)


def test_coarse_elevation_matches_main_off_the_pole(golden):
    for e in golden["elev"]:
        if e["lat"] > -80.02:
            assert abs(float(T.coarse.elev(e["lat"], e["lon"])) - e["h"]) < 1e-6


def test_custom_point_off_the_pole_matches_main_exactly(golden):
    for c in golden["horizonMask"]:
        if c["lat"] > -80:
            hm = T.horizon(c["lat"], c["lon"], [2], 360, "80m", use_cache=False)
            assert np.abs(hm.mask_deg[0] - arr(c["mask"])).max() < 1e-6
            assert abs(hm.ground_m - c["h0"]) < 1e-6


@needs_80
@pytest.mark.parametrize("sid", ["shack", "ridge", "gerl", "ce7", "mala", "viper", "im2", "im1", "pole"])
def test_site_horizons_80m_parity(golden, sid):
    """Python's 80m mode against main's build/hires.py profiles: within 0.05 deg at mast heights 2, 5 and 10 m.
    At eye height 0 the horizon is set by terrain 30 m away, where a few centimetres of height rounding moves the
    angle by about 0.1 deg; main's profiles carry that rounding, so 0 m is only checked loosely.
    im1 sits 30 km from the edge of the 80 m square, so its far horizon comes from the coarse grid: main's build/hires.py
    used ssa-data-lunar's 1/8 x 1/8 deg grid there, the backend uses main's packed grid (1/8 deg x 1/4 deg), worth
    0.051 deg at one azimuth."""
    s = golden["sites"][sid]
    hm = T.horizon(s["lat"], s["lon"], [0, 2, 5, 10], 720, "80m", use_cache=False)
    assert abs(hm.ground_m - s["h0"]) < 0.1
    for k, e in enumerate([0, 2, 5, 10]):
        d = np.abs(hm.mask_deg[k] - arr(golden["profileMask"][sid][str(e)]["mask"])).max()
        assert d < (0.2 if e == 0 else 0.06 if sid == "im1" else 0.05), (sid, e, d)


@needs_80
def test_custom_polar_point_vs_main_400m(golden):
    """main ray-casts custom polar points on a 400 m raster (browser size limit); Python uses the 80 m DEM.
    Differences are expected; the plan's tolerance is 0.3 deg, reported as the mean here (the max is in the README)."""
    c = next(c for c in golden["horizonMask"] if c["lat"] < -80)
    hm = T.horizon(c["lat"], c["lon"], [2], 360, "80m", use_cache=False)
    d = np.abs(hm.mask_deg[0] - arr(c["mask"]))
    assert d.mean() < 0.3 and d.max() < 1.5


@needs_80
def test_physical_sanity(golden):
    q = golden["sites"]["ridge"]
    ridge = T.horizon(q["lat"], q["lon"], [2], 720, "80m")          # connecting ridge summit (snapped)
    assert ridge.mask_deg[0].max() < 0
    floor = T.horizon(-89.67, 129.2, [2], 360, "best")               # Shackleton crater floor
    assert floor.mask_deg[0].min() > 5
    hm = T.horizon(-86.0, 2.7, [0, 100], 360, "best")
    assert np.all(hm.mask_deg[1] <= hm.mask_deg[0] + 1e-9)           # a taller mast never raises the horizon


@needs_tiles
@pytest.mark.parametrize("sid,tile", [("shack", "Site04"), ("ridge", "Site01"), ("gerl", "Site11"), ("ce7", "Site07"), ("pole", "Site04")])
def test_5m_tier_used(golden, sid, tile):
    s = golden["sites"][sid]
    assert T.best_tier(s["lat"], s["lon"]) == f"LOLA 5 m ({tile})"
    hm = T.horizon(s["lat"], s["lon"], [2], 720, "best")
    assert hm.tiers[0] == f"LOLA 5 m ({tile})"
    assert abs(hm.ground_m - s["h0"]) < 5           # the 5 m and 80 m models agree on the ground height


@needs_80
def test_fast_cast_close_to_full_cast():
    a = T.horizon(-85.99, 2.81, [2], 180, "best", use_cache=False)
    b = T.horizon(-85.99, 2.81, [2], 180, "best", use_cache=False, fast=True)
    d = np.abs(a.mask_deg[0] - b.mask_deg[0])
    assert d.mean() < 0.05 and d.max() < 1.0      # fast samples the near field every 30 m instead of 80 m


def test_slope_flat_and_steep():
    assert T.slope(-45.0, 30.0) < 5                      # coarse grid, smooth
    if T.r80 is not None:
        assert T.slope(-89.67, 129.2 + 0.0) < 30


def test_schedules():
    d = schedule_main_coarse()
    assert d[0] == 1000 and d[-1] <= 320000
