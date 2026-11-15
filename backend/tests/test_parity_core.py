"""Parity with main's JS engine (fixtures from tools/make_golden.js). Geometry is compared like for like by feeding the
JS ephemeris table into Python."""
import math

import numpy as np
import pytest

from conftest import arr, num
from skyline.engine import geometry as G
from skyline.engine import mission as M
from skyline.engine import visibility as V
from skyline.engine.terrain import mask_at


def view_from_golden(golden, sid, eye=2):
    s = golden["sites"][sid]
    m = arr(golden["profileMask"][sid][str(eye)]["mask"])
    return V.View(lat=s["lat"], lon=s["lon"], ground_m=s["h0"], sun_mask=m, earth_mask=m, array_h=eye, antenna_h=eye)


def test_disc_frac_basics():
    assert G.disc_frac(1, 0.266, 0) == 1
    assert G.disc_frac(-1, 0.266, 0) == 0
    assert abs(G.disc_frac(0.5, 0.266, 0.5) - 0.5) < 1e-12


def test_look_zenith_horizon_east():
    b = G.site_basis(-45, 30, 0)
    assert abs(G.look(b, b.up * 4e5, 1)["el"] - 90) < 1e-6
    assert abs(G.look(b, b.north * 1e9 + b.up * b.r, 1)["el"]) < 1e-6
    assert abs(G.look(b, b.east * 1e9 + b.up * b.r, 1)["az"] - 90) < 1e-6


@pytest.mark.parametrize("sid", ["shack", "mala", "im2"])
def test_series_matches_js(golden, table, sid):
    se = V.series(view_from_golden(golden, sid), table)
    ref = golden["series"][sid]
    for k in V.SERIES_KEYS:
        a, b = se[k], arr(ref[k])
        if k.endswith("Az"):
            d = np.abs(((a - b) + 180) % 360 - 180)
        else:
            d = np.abs(a - b)
        tol = 1e-6 * (1 if k in ("sunFrac", "irr") else 1)
        # both sides are float32-rounded: allow one float32 ulp
        ulp = np.spacing(np.abs(b).astype(np.float32)).astype(np.float64)
        assert np.all(d <= np.maximum(tol, 2 * ulp)), (k, float(d.max()))


@pytest.mark.parametrize("sid", ["shack", "mala", "im2"])
def test_stats_match_js(golden, table, sid):
    se = V.series(view_from_golden(golden, sid), table)
    st = V.stats(se, 0, 30 * 24, 1, True)
    for k, v in golden["series"][sid]["stats"].items():
        assert abs(st[k] - v) < 1e-6, k


def test_next_cross(golden):
    for c in golden["nextCross"]:
        r = V.next_cross(np.array(c["a"], dtype=float), c["x"], len(c["a"]))
        if c["r"] is None:
            assert r is None
        else:
            assert abs(r[0] - c["r"]["idx"]) < 1e-12 and r[1] == c["r"]["rising"]


def test_mission_and_verdict_match_js(golden, table):
    sers = {sid: V.series(view_from_golden(golden, sid), table) for sid in ("shack", "mala")}
    for case in golden["mission"]:
        se, cfg, i0 = sers[case["site"]], dict(case["cfg"]), case["i0"]
        for key, margin, keep in (("nominal", 0, True), ("margin", cfg["margin"], False)):
            r = M.mission(se, i0, cfg, margin, keep)
            ref = case[key]
            assert r["fails"] == ref["fails"], (case["name"], case["site"], i0, key)
            assert r["ok"] == ref["ok"]
            for k in ("kMin", "kFail", "maxGapH", "maxDarkH", "n", "safeH", "faultK"):
                assert r[k] == ref[k], (case["name"], key, k)
            for k in ("minSoc", "linkPct", "litPct", "battNeedWh"):
                a, b = r[k], num(ref[k])
                assert (math.isinf(a) and math.isinf(b)) or abs(a - b) <= 1e-6 * max(1, abs(b)), (case["name"], key, k, a, b)
            if keep:
                assert np.allclose(r["soc"], arr(ref["soc"]), rtol=1e-6, atol=1e-7)
        assert M.verdict(se, i0, cfg)["state"] == case["verdict"], (case["name"], case["site"], i0)


def test_js_formatting():
    assert M.js_fixed(0.25, 1) == "0.3"     # JS toFixed rounds exact ties up
    assert M.js_fixed(0.35, 1) == "0.3"     # 0.35 is below the tie in binary
    assert M.js_fixed(2.5, 0) == "3"
    assert M.js_round(2.5) == 3 and M.js_round(-2.5) == -2
    assert M.js_num(6) == "6" and M.js_num(6.5) == "6.5"


def test_mask_at_wraps():
    m = np.arange(360.0)
    assert abs(mask_at(m, 359.5) - 179.5) < 1e-12
    assert abs(mask_at(m, -0.5) - 179.5) < 1e-12
