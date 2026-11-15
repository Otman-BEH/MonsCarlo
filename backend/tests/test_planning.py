"""Design lab, calendar, rescue, DSN and the endpoints the web page uses."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import arr
from skyline.api.app import app
from skyline.engine import design as D
from skyline.engine import mission as M
from skyline.engine import planning as P
from skyline.engine import visibility as V
from skyline.prep import spice
from test_api import _have_ephemeris
from test_parity_core import view_from_golden

T = "2026-12-01T06:00:00Z"


def _eq(a, b):
    return all((x is None and y is None) or (x is not None and y is not None and abs(x - y) <= 1e-9 * max(1, abs(y))) for x, y in zip(a, b))


@pytest.mark.parametrize("case", range(3))
def test_design_lab_matches_main(golden, table, case):
    d = golden["design"][case]
    se = V.series(view_from_golden(golden, d["site"]), table)
    cfg = dict(d["cfg"])
    F = D.frontier(se, d["i0"], cfg, (80, 160), 36, 12, True)
    assert np.allclose(F["caps"], d["caps"], rtol=1e-12, atol=0)
    assert _eq(F["rob"], d["rob"]) and _eq(F["nom"], d["nom"])
    assert F["best"] == {k: float(v) for k, v in d["best"].items()}
    shp = M.power_shape(se, cfg)
    cb = D.bisect_up(lambda c: D._ok(se, d["i0"], cfg, cfg["margin"], np.full(len(c), cfg["peakW"]), c, shp), np.array([10.0]), np.array([60000.0]), 16)[0]
    assert (np.isnan(cb) and d["minBatteryAtArray"] is None) or abs(cb - d["minBatteryAtArray"]) < 1e-9
    A = D.atlas(se, d["i0"], cfg, (80, 160), 20, 12)
    for a, b in zip(A, d["atlas"]):
        assert (a is None and b is None) or (a["peakW"] == b[0] and a["capWh"] == b[1])


def test_batch_verdicts_equal_scalar(golden, table):
    se = V.series(view_from_golden(golden, "mala"), table)
    cfg = {"days": 10, "peakW": 400, "loadSun": 180, "loadDark": 60, "capWh": 2000, "minSoc": 0.2, "tracking": True, "needEarth": True,
           "maxGapH": 12, "margin": 0.3, "chargeEff": 0.9, "fault": {"kind": "none", "day": 3}, "safe": False, "autonomyH": 6}
    i0s = np.arange(0, 700, 7)
    st, cause = P.verdicts(se, i0s, cfg)
    for k, i in enumerate(i0s):
        v = M.verdict(se, int(i), cfg)
        assert v["state"] == st[k]
        if v["state"] == 0:
            assert M.cause_of(v["nom"]["fails"][0]) == cause[k]


@pytest.mark.skipif(not spice.available(), reason="SPICE kernels not in the data directory")
def test_dsn_matches_main_above_15_degrees(golden):
    """Geometric elevation; main's Astronomy Engine values include refraction, which matters only near the horizon."""
    for c in golden["dsn"]:
        for a, b in zip(spice.dsn_view(c["ms"] / 1000), c["v"]):
            assert a["name"] == b["name"]
            if b["el"] > 15:
                assert abs(a["elevation_deg"] - b["el"]) < 0.1


api = pytest.mark.skipif(not _have_ephemeris(), reason="no ephemeris cached and no SPICE kernels")


@pytest.fixture(scope="module")
def c():
    return TestClient(app)


@api
def test_series_and_ephemeris(c):
    s = c.get("/series", params={"site": "shack", "start": T, "hours": 48}).json()
    assert s["n"] == 49 and len(s["series"]["sunEl"]) == 49 and len(s["skyline"]["sun"]) == 720
    e = c.get("/ephemeris", params={"start": T, "hours": 48}).json()
    assert e["n"] == 49 and len(e["sun_km"][0]) == 3
    assert c.get("/series", params={"site": "shack", "hours": 99999}).status_code == 422


@api
def test_design_calendar_rescue(c):
    d = c.post("/design", json={"location": {"site": "mala"}, "landing_time": T}).json()
    assert len(d["frontier"]["caps"]) == 36 and len(d["atlas"]) == 120 and d["landing_time"] == T
    cal = c.post("/calendar", json={"locations": [{"site": "mala"}, {"lat": -85.4, "lon": 31.6}], "start": T, "days": 30}).json()
    assert [len(s["state"]) for s in cal["sites"]] == [30, 30]
    r = c.post("/rescue", json={"plan": {"site": "mala"}, "plan_time": T, "sites": [{"site": "shack"}], "slip_days": 3, "flex_days": 5}).json()
    assert r["alternatives"][0]["location"]["id"] in ("mala", "shack") and len(r["alternatives"]) == 2
    states = [a["state"] for a in r["alternatives"]]
    assert states == sorted(states, reverse=True)


@api
def test_mission_stress_block(c):
    r = c.get("/mission", params={"site": "mala", "landing_time": T, "fault_kind": "load", "fault_day": 2, "trace": True}).json()
    assert set(r["stress"]) == {"without_fault", "safe_mode_toggled"}
    assert len(r["trace"]["state_of_charge_with_margin"]) == len(r["trace"]["state_of_charge"])


@api
def test_terrain_files_and_page(c):
    p = c.get("/terrain/patch", params={"lat": -89.78, "lon": -155.7}).json()
    assert p["patches"]["a"]["n"] == 150 and len(p["patches"]["a"]["h"]) == 150 * 150
    r = c.get("/terrain/polar400")
    if r.status_code == 200:
        n = int(r.headers["X-Size"])
        assert len(r.content) == n * n * 2
    assert c.get("/terrain/moon.jpg").headers["content-type"] == "image/jpeg"
    assert c.get("/").json()["docs"] == "/docs"         # API only: the page is served separately
    assert c.get("/sky", params={"site": "mala", "time": T}).json()["vectors_km"]["sun"]
