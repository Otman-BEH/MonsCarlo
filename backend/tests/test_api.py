"""API tests with FastAPI's TestClient against the local data directory (needs the ephemeris for Dec 2026 to Feb 2027,
from the SQLite cache, Horizons, or the SPICE kernels)."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import arr
from skyline.api.app import app
from skyline.engine import ephemeris as EP
from skyline.prep import spice
from skyline.prep.store import default_store

T = "2026-12-01T06:00:00Z"


def _have_ephemeris():
    st = default_store()
    return spice.available() or all(st.month_info(b, m) for b in ("sun", "earth") for m in ("2026-12", "2027-01", "2027-02", "2027-03"))


pytestmark = pytest.mark.skipif(not _have_ephemeris(), reason="no ephemeris cached and no SPICE kernels")


@pytest.fixture(scope="module")
def c():
    return TestClient(app)


def test_root_and_health(c):
    assert c.get("/api").json()["docs"] == "/docs"
    h = c.get("/health").json()
    assert h["status"] in ("ok", "degraded") and "files" in h and "ephemeris" in h and h["meta"]["api_version"]


def test_sites(c):
    s = c.get("/sites").json()["sites"]
    assert len(s) == 26
    shack = next(x for x in s if x["id"] == "shack")
    assert shack["snapped"] and shack["lat"] != shack["nominal"]["lat"]
    assert len(c.get("/sites", params={"group": "South pole"}).json()["sites"]) == 9


def test_sky_matches_main(c, golden):
    """/sky in 80m mode at an hour of the golden table: the remaining difference is the ephemeris source
    (JPL Horizons here, Astronomy Engine in main), validated by main at 0.004 deg."""
    r = c.get("/sky", params={"site": "shack", "time": T, "dem": "80m"}).json()
    ref = golden["series"]["shack"]
    i = 6
    assert abs(r["sun"]["elevation_deg"] - ref["sunEl"][i]) < 0.01
    assert abs(((r["sun"]["azimuth_deg"] - ref["sunAz"][i]) + 180) % 360 - 180) < 0.02
    assert abs(r["earth"]["elevation_deg"] - ref["earthEl"][i]) < 0.01
    assert abs(r["sun"]["clearance_deg"] - ref["sunClr"][i]) < 0.03
    assert r["meta"]["lander_resolved"]["id"] == "reference"
    assert "time" not in r["meta"]["defaults_used"] and "lander" in r["meta"]["defaults_used"]
    assert r["meta"]["sources"]["ephemeris"]["2026-12"]["sun"] in ("jpl-horizons", "spice-de440")
    assert r["meta"]["sources"]["citations"]


def test_sky_events_and_heights(c):
    r = c.get("/sky", params={"site": "mala", "time": T, "antenna_height_m": 10}).json()
    assert r["heights"]["antenna_m"] == 10 and r["heights"]["array_m"] == 2
    for k in ("next_sunset", "next_sunrise"):
        ev = r["sun"][k]
        if ev["time"]:
            assert ev["in_hours"] > 0
    # the two skylines really differ: a taller antenna never sees a higher skyline
    lo = c.get("/sky", params={"site": "mala", "time": T}).json()
    assert r["earth"]["skyline_deg"] <= lo["earth"]["skyline_deg"] + 1e-9
    assert r["sun"]["skyline_deg"] == lo["sun"]["skyline_deg"]


def test_windows_json_and_csv(c):
    r = c.get("/windows", params={"site": "mala", "start": T, "end": "2026-12-11T06:00:00Z", "series": True}).json()
    assert r["samples"] == 241 and len(r["series"]["time"]) == 241
    st = r["stats"]
    assert 0 <= st["both_pct"] <= min(st["sunlit_pct"], st["earth_in_view_pct"]) + 1e-9
    for iv in r["intervals"]["sunlit"]:
        assert iv["end"] > iv["start"]
    csv = c.get("/windows", params={"site": "mala", "start": T, "end": "2026-12-02T06:00:00Z", "format": "csv"})
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert csv.text.splitlines()[0].startswith("time,sunEl")


def test_mission_get_overrides_and_echo(c):
    r = c.get("/mission", params={"site": "shack", "landing_time": T, "battery_wh": 5000, "antenna_height_m": 10, "trace": True}).json()
    lr = r["meta"]["lander_resolved"]
    assert lr["power"]["battery"]["capacity_wh"] == 5000 and lr["comms"]["antenna_height_m"] == 10 and lr["id"] == "reference-custom"
    assert r["verdict"] in ("meets", "marginal", "fails")
    assert len(r["trace"]["state_of_charge"]) == r["nominal"]["hours_simulated"] + 1


def test_mission_post_matches_get(c):
    g = c.get("/mission", params={"site": "shack", "landing_time": T, "battery_wh": 3000}).json()
    p = c.post("/mission", json={"location": {"site": "shack"}, "landing_time": T,
                                  "lander": {"base": "reference", "power": {"battery": {"capacity_wh": 3000}}}}).json()
    assert g["verdict"] == p["verdict"] and g["nominal"] == p["nominal"]


def test_mission_fault_and_vertical(c):
    r = c.post("/mission", json={"location": {"site": "ridge"}, "landing_time": T, "lander": "polar-vertical",
                                  "mission": {"fault": {"kind": "battery", "day": 2}}}).json()
    assert r["meta"]["lander_resolved"]["power"]["array"]["type"] == "vertical"
    assert r["mission"]["fault"]["kind"] == "battery"


def test_mission_parity_with_main_80m(c, golden):
    """POST /mission in 80m mode for the reference lander against main's verdict on the same landing hour. Only the
    ephemeris source differs (Horizons vs Astronomy Engine), so verdicts should agree except right at a threshold."""
    agree = total = 0
    for case in golden["mission"]:
        if case["site"] != "shack" or case["name"] not in ("reference", "horizontal", "small_battery"):
            continue
        t0 = golden["table"]["t0_ms"] / 1000 + case["i0"] * 3600
        cfg = case["cfg"]
        lander = {"base": "reference", "power": {"array": {"type": "tracking" if cfg["tracking"] else "horizontal"},
                                                 "battery": {"capacity_wh": cfg["capWh"]}}}
        r = c.post("/mission", json={"location": {"site": "shack"}, "landing_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)),
                                      "lander": lander, "mission": {"max_gap_h": cfg["maxGapH"]}, "dem": "80m"}).json()
        total += 1
        agree += {"fails": 0, "marginal": 1, "meets": 2}[r["verdict"]] == case["verdict"]
    assert total >= 6 and agree == total


def test_report_defaults_and_includes(c):
    r = c.get("/report", params={"site": "shack", "time": T}).json()
    assert r["summary"].startswith("At Shackleton rim on 1 Dec 2026")
    assert set(r) >= {"summary", "sky", "windows", "mission", "details", "meta"}
    assert "lander" in r["meta"]["defaults_used"]
    r2 = c.get("/report", params={"site": "shack", "time": T, "include": "horizon,series"}).json()
    assert "horizon" in r2 and "series" in r2["windows"]
    assert c.get("/report", params={"site": "shack", "include": "nope"}).status_code == 422


def test_report_post(c):
    r = c.post("/report", json={"location": {"lat": -85.4, "lon": 31.6}, "time": T, "window_days": 10}).json()
    assert "Over the next 10 days" in r["summary"]


def test_risk_small_grid(c):
    r = c.post("/mission", json={"location": {"site": "shack"}, "landing_time": "2026-12-14T00:00:00Z", "risk": True,
                                  "uncertainty": {"grid_n": 7, "trials_per_cell": 12}}).json()
    k = r["risk"]
    assert k["available"] and 0 <= k["success_p"] <= 1 and k["ci95"][0] <= k["success_p"] <= k["ci95"][1]
    assert abs(sum(k["causes"].values()) - (1 - k["success_p"])) < 0.05
    assert r["meta"]["seed"] == 20261114 and k["total_missions"] == 7 * 7 * 12
    again = c.post("/mission", json={"location": {"site": "shack"}, "landing_time": "2026-12-14T00:00:00Z", "risk": True,
                                      "uncertainty": {"grid_n": 7, "trials_per_cell": 12}}).json()
    assert again["risk"]["success_p"] == k["success_p"]          # seeded: same inputs, same answer
    eq = c.get("/mission", params={"site": "a11", "landing_time": T, "risk": True}).json()
    assert eq["risk"]["available"] is False


def test_landers_crud(c):
    c.delete("/landers/test-big")
    assert {l["id"] for l in c.get("/landers").json()["landers"]} >= {"reference", "polar-vertical"}
    r = c.post("/landers", json={"base": "reference", "id": "test-big", "name": "Big battery", "power": {"battery": {"capacity_wh": 9000}}})
    assert r.status_code == 201 and r.json()["lander"]["power"]["battery"]["capacity_wh"] == 9000
    assert c.post("/landers", json={"base": "reference", "id": "test-big", "name": "again"}).status_code == 409
    assert c.post("/landers", json={"base": "reference", "id": "reference", "name": "clash"}).status_code == 409
    assert c.get("/mission", params={"site": "shack", "landing_time": T, "lander": "test-big"}).json()["meta"]["lander_resolved"]["id"] == "test-big"
    assert c.delete("/landers/test-big").status_code == 204
    assert c.delete("/landers/test-big").status_code == 404
    assert c.delete("/landers/reference").status_code == 409


def test_errors(c):
    assert c.get("/sky", params={"site": "nowhere"}).status_code == 404
    assert c.get("/sky", params={"lander": "nobody", "site": "shack"}).status_code == 404
    assert c.get("/sky").status_code == 422                                  # no location
    assert c.get("/sky", params={"lat": -95, "lon": 0}).status_code == 422
    assert c.get("/sky", params={"site": "shack", "time": "yesterday"}).status_code == 422
    assert c.get("/sky", params={"site": "shack", "time": "1850-01-01T00:00:00Z"}).status_code == 400
    assert c.get("/mission", params={"site": "shack", "min_soc": 1.5}).status_code == 422
    bad = c.post("/landers", json={"id": "x", "name": "x", "power": {"array": {"type": "vertical", "height_m": 2},
                                                                  "battery": {"capacity_wh": 100}, "loads": {"sunlit_w": 1, "dark_w": 1}}})
    assert bad.status_code == 422                                             # vertical without faces
    assert c.get("/windows", params={"site": "shack", "start": T, "end": "2026-11-01T00:00:00Z"}).status_code == 422


def test_latency_targets(c):
    """Warm-cache targets from the plan (laptop figures; generous margins here)."""
    c.get("/report", params={"site": "mala", "time": T})            # warm
    for url, params, limit in (("/sky", {"site": "mala", "time": T}, 0.2), ("/windows", {"site": "mala", "start": T}, 0.3),
                               ("/mission", {"site": "mala", "landing_time": T}, 0.3), ("/report", {"site": "mala", "time": T}, 0.5)):
        t = time.time()
        assert c.get(url, params=params).status_code == 200
        assert time.time() - t < limit, url
