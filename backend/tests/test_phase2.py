"""Phase 2: Sunlight and Earth-view map, Site compare, DSN station view, Landing window, Mission design and the
opportunity atlas. Parity with main's JS (fixtures from tools/make_golden_phase2.js, run on afd9e78) and API tests.
Geometry is compared like for like by feeding the JS ephemeris table into Python."""
import gzip
import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import FIX
from skyline.api.app import app
from skyline.engine import design as D
from skyline.engine import landing as LW
from skyline.engine import mission as M
from skyline.engine import polarmap as PM
from skyline.engine import visibility as V
from skyline.engine.scan import verdict_scan
from skyline.prep import dsn as PD
from skyline.prep import horizons, spice
from skyline.engine.terrain import default_terrain
from test_api import _have_ephemeris
from test_parity_core import view_from_golden

T = "2026-12-01T06:00:00Z"
BASE = {"days": 10, "peakW": 400, "loadSun": 180, "loadDark": 60, "capWh": 2000, "minSoc": 0.2, "tracking": True, "needEarth": True,
        "maxGapH": 12, "margin": 0.3, "chargeEff": 0.9, "fault": {"kind": "none", "day": 3}, "safe": False, "autonomyH": 6}


@pytest.fixture(scope="module")
def g2():
    return json.loads((FIX / "golden_phase2.json").read_text())


@pytest.fixture(scope="module")
def tab2(g2):
    return np.array(g2["table"]["a"], dtype=np.float64).reshape(-1, 6)


@pytest.fixture(scope="module")
def ser2(golden, tab2):
    return {sid: V.series(view_from_golden(golden, sid), tab2) for sid in golden["sites"]}


def _close(a, b, tol=1e-9):
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(b)))


# ---------------------------------------------------------------- Phase 0: verdict scan
@pytest.mark.parametrize("over", [{}, {"tracking": False}, {"fault": {"kind": "battery", "day": 2}}, {"safe": True, "capWh": 900},
                                  {"needEarth": False, "capWh": 700}, {"fault": {"kind": "antenna", "day": 1}, "maxGapH": 30}])
def test_verdict_scan_equals_scalar(ser2, over):
    se = ser2["mala"]
    cfg = {**BASE, **over}
    idx = np.arange(0, 1500, 37)
    sc = verdict_scan(se, idx, cfg)
    for k, i in enumerate(idx):
        v = M.verdict(se, int(i), cfg)
        assert v["state"] == sc["state"][k]
        assert abs(v["nom"]["minSoc"] - sc["min_soc"][k]) < 1e-12
        assert v["nom"]["maxGapH"] == sc["max_gap_h"][k]
        if v["state"] == 0:
            assert M.cause_of(v["nom"]["fails"][0]) == sc["cause"][k] or sc["cause"][k] in (2, 5)


# ---------------------------------------------------------------- Phase 1a: map
@pytest.fixture(scope="module")
def map_ref(g2):
    raw = np.frombuffer(gzip.decompress((FIX / "golden_map.bin.gz").read_bytes()), dtype="<u2").astype(np.float64) / 65535
    return raw.reshape(-1, g2["map"]["size"], g2["map"]["size"])


@pytest.mark.skipif(default_terrain().p400 is None, reason="needs the 400 m raster (run precompute)")
def test_map_matches_main(g2, tab2, map_ref):
    """main's castPolar at 400 px, three times, both layers, on the grid built from main's 400 m raster."""
    G = PM.build_grid(400, "80m")
    ins = G["inside"]
    assert (ins == (map_ref[-1] > 0.5)).all()
    assert np.abs(G["hill"] - map_ref[-2]).max() < 1e-4
    for k, hh in enumerate(g2["map"]["hours"]):
        fs, inc = PM.cast(G, tab2[hh, :3], False, PM.SUN_RAD)
        fe, _ = PM.cast(G, tab2[hh, 3:], True, PM.EARTH_RAD)
        for got, ref in ((fs, map_ref[3 * k]), (inc, map_ref[3 * k + 1]), (fe, map_ref[3 * k + 2])):
            d = np.abs(got - ref)[ins]
            assert (d <= 0.02).mean() >= 0.99
            assert d.max() < 1e-4          # in fact identical up to the fixture's 16-bit rounding


def test_png_writer_roundtrip():
    import zlib
    img = np.zeros((3, 5, 4), np.uint8)
    img[1, 2] = [10, 20, 30, 255]
    b = PM.png(img)
    assert b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR"
    n = int.from_bytes(b[33:37], "big")
    raw = np.frombuffer(zlib.decompress(b[41:41 + n]), np.uint8).reshape(3, 1 + 20)
    assert (raw[:, 1:].reshape(3, 5, 4) == img).all()


def test_map_steps_are_mains_at_400():
    s = [d for d in range(1, 9)]
    d = 9.0
    while d < 190:
        s.append(d)
        d *= 1.12
    assert np.allclose(PM.steps(400), s)
    assert PM.steps(1200)[0] == 1 and PM.steps(1200).max() == pytest.approx(3 * max(s))


# ---------------------------------------------------------------- Phase 1b: compare (stats identical to /windows, and to main)
def test_compare_stats_match_main(golden, table):
    from skyline.engine.service import Engine
    for sid in ("shack", "mala", "im2"):
        se = V.series(view_from_golden(golden, sid), table)
        st = Engine.window_stats(se, 30 * 24)
        ref = golden["series"][sid]["stats"]
        for a, b in (("sunlit_pct", "litPct"), ("earth_in_view_pct", "linkPct"), ("power_share_tracking_pct", "pTrack"),
                     ("power_share_horizontal_pct", "pFlat"), ("longest_dark_h", "maxDarkD"), ("longest_radio_gap_h", "maxOutD"),
                     ("longest_sunlit_h", "maxLitD")):
            want = ref[b] * (24 if b.startswith("max") else 1)
            assert abs(st[a] - want) <= 1e-6 * max(1, abs(want)), (sid, a)


# ---------------------------------------------------------------- Phase 2a: DSN
@pytest.mark.skipif(not spice.available(), reason="SPICE kernels not in the data directory")
def test_dsn_spice_matches_main_airless(g2):
    t = np.array([c["ms"] / 1000 for c in g2["dsn"]])
    az, el = spice.dsn_azel(t)
    ref = np.array([[v["el"] for v in c["airless"]] for c in g2["dsn"]]).T
    refaz = np.array([[v["az"] for v in c["airless"]] for c in g2["dsn"]]).T
    assert np.abs(el - ref).max() < 0.05
    daz = np.abs((az - refaz + 180) % 360 - 180)[ref < 80]
    assert daz.max() < 0.05


@pytest.mark.skipif(not spice.available(), reason="SPICE kernels not in the data directory")
def test_dsn_spice_matches_main_panel_above_15_degrees(g2):
    """main's status panel used refraction 'normal', which only matters near the horizon."""
    t = np.array([c["ms"] / 1000 for c in g2["dsn"]])
    _, el = spice.dsn_azel(t)
    ref = np.array([[v["el"] for v in c["v"]] for c in g2["dsn"]]).T
    m = ref > 15
    assert np.abs(el - ref)[m].max() < 0.1


def test_dsn_horizons_request_and_parse():
    p = PD.request_params("Madrid", "2026-12")
    assert p["COMMAND"] == "'301'" and p["CENTER"] == "'coord@399'" and p["QUANTITIES"] == "'4'"
    assert p["SITE_COORD"] == "'-4.2481,40.4314,0.900'" and p["START_TIME"] == "'2026-12-01 00:00'" and p["STOP_TIME"] == "'2026-12-31 23:00'"
    text = (FIX / "horizons_sun_2026-12.txt").read_text()      # same OBSERVER layout; the range column is optional
    t, az, el, rg = horizons.parse(text.replace("             delta,", "             dummy,"))
    assert len(t) == 31 * 24 and np.isnan(rg).all() and np.isfinite(el).all()


@pytest.mark.live
def test_dsn_horizons_live_vs_spice():
    t, az, el = PD.fetch_month("Canberra", "2026-12")
    _, e2 = spice.dsn_azel(t)
    assert np.abs(el - e2[2]).max() < 0.05


# ---------------------------------------------------------------- Phase 2b: landing window
@pytest.mark.parametrize("case", range(3))
def test_landing_window_matches_main(g2, ser2, case):
    L = g2["landing"][case]
    cfg = dict(L["cfg"])
    rows = []
    for sid in ["shack", "ridge", "gerl", "ce7", "mala", "viper", "im2", "im1", "pole"]:
        r = LW.search_site(ser2[sid], L["iS"], L["flex"], cfg, 6)
        rows.append((sid, r))
    rows.sort(key=lambda x: LW.rank_key(x[1]))
    assert [s for s, _ in rows] == [a["id"] for a in L["alts"]]
    for (sid, r), a in zip(rows, L["alts"]):
        assert r["state"] == a["state"] and r["i"] == a["i"] and r["good_days"] == a["days"]
        assert list(r["scan"]["state"]) == a["st6"]
        assert abs(r["verdict"]["nom"]["minSoc"] - a["minSoc"]) <= 1e-6 * max(1, a["minSoc"])
        assert r["verdict"]["nom"]["maxGapH"] == a["maxGapH"] and r["reasons"] == a["fails"]
    pse = ser2[L["plan"]]
    assert M.verdict(pse, L["iP"], cfg)["state"] == L["base"] and M.verdict(pse, L["iS"], cfg)["state"] == L["slipped"]


def test_landing_window_windows_and_dsn_rule(ser2):
    se = ser2["mala"]
    r = LW.search_site(se, 0, 21, BASE, 6)
    st = r["scan"]["state"]
    for w in r["windows"]:
        a, b = (w["first"] // 6), (w["last"] // 6)
        assert (st[a:b + 1] == w["state"]).all() and w["state"] >= 1 and w["landings"] == b - a + 1
    assert sum(w["landings"] for w in r["windows"]) == int((st >= 1).sum())
    none = np.zeros(se["n"], bool)
    r0 = LW.search_site(se, 0, 21, BASE, 6, allowed=none)
    assert r0["state"] == 0 and r0["reasons"] == [LW.DSN_REASON] and r0["windows"] == []


def test_why_wording():
    assert LW.why(2, [], 10) == "Power and Earth contact hold for all 10 days, with the terrain margin."
    assert LW.why(1, ["battery falls to 12% on day 3.0"], 10) == "Works on the modelled terrain; with the margin battery falls to 12% on day 3.0."
    assert LW.why(0, ["the Sun is not up at landing", "no Earth line of sight at landing"], 10) == \
        "The Sun is not up at landing, and no Earth line of sight at landing."


# ---------------------------------------------------------------- Phase 3: mission design and atlas
@pytest.mark.parametrize("case", range(4))
def test_mission_design_matches_main(g2, ser2, case):
    d = g2["design"][case]
    se = ser2[d["site"]]
    cfg = dict(d["cfg"])
    r = D.lab(se, d["i0"], cfg, (80, 160))
    F = r["frontier"]
    assert np.allclose(F["caps"], d["caps"], rtol=1e-12, atol=0)
    assert all(_close(a, b) for a, b in zip(F["rob"], d["rob"])) and all(_close(a, b) for a, b in zip(F["nom"], d["nom"]))
    assert F["best"] == ({k: float(v) for k, v in d["best"].items()} if d["best"] else None)
    assert M.verdict(se, d["i0"], cfg)["state"] == d["state"]
    if d["best"]:
        assert _close(r["min_array_at_your_battery_w"], d["minArrayAtCap"]) and _close(r["min_battery_at_your_array_wh"], d["minBatteryAtArray"])
        if "maxLoad" in d:
            assert _close(r["max_sunlit_load_w"], d["maxLoad"])
        fx = D.fixes(cfg, r["min_array_at_your_battery_w"], r["min_battery_at_your_array_wh"], r.get("max_sunlit_load_w"), d["state"], (80, 160))
        assert [f["text"] for f in fx] == d["alts"]
    else:
        assert r["why_none"] == d["whyNone"]


@pytest.mark.parametrize("case", range(2))
def test_atlas_matches_main(g2, ser2, case):
    a = g2["atlas"][case]
    A = D.atlas(ser2[a["site"]], a["a0"], dict(a["cfg"]), (80, 160), 120, 12)
    for got, m, p, c in zip(A, a["mass"], a["peakW"], a["capWh"]):
        assert (got is None) == (m is None)
        if got:
            assert got["peakW"] == p and got["capWh"] == c and abs(got["mass"] - m) < 1e-9
    assert D.best_dates([x["mass"] if x else None for x in A], 4, 6) == a["top"]


def test_fmt_like_js():
    assert D.fmt_w(13099.5) == "13,100 W" and D.fmt_cap(470) == "470 Wh"
    assert D.fmt_kg(5.1875) == "5.2 kg" and D.fmt_kg(10.5) == "11 kg" and D.fmt_kg(0.05) == "0.1 kg"


# ---------------------------------------------------------------- API
api = pytest.mark.skipif(not _have_ephemeris(), reason="no ephemeris cached and no SPICE kernels")


@pytest.fixture(scope="module")
def c():
    return TestClient(app)


@api
def test_map_api(c):
    r = c.get("/map", params={"time": T})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content[:4] == b"\x89PNG"
    assert r.headers["x-map-time"] == T and int(r.headers["x-map-size"]) == 400
    j = c.get("/map", params={"time": "2026-12-01T06:20:00Z", "layer": "earth", "format": "json", "sites": True, "size": 200}).json()
    assert j["time"] == T and j["rounded_to_hour"] and j["size"] == 200
    import base64
    assert len(base64.b64decode(j["grid"]["visible_share"])) == 200 * 200 and "incidence" not in j["grid"]
    assert {s["id"] for s in j["sites"]} >= {"shack", "mala", "pole"} and j["sites"][0]["report"].startswith("/report?")
    assert j["meta"]["pixel_m"] == pytest.approx(2 * PM.RHO_KM * 1000 / 200) and "projection" in j["meta"]
    s = c.get("/map", params={"time": T, "format": "json", "exact": True, "hillshade": True}).json()
    assert "incidence" in s["grid"] and "hillshade" in s["grid"] and not s["rounded_to_hour"]
    assert c.get("/map", params={"size": 5000}).status_code == 422
    assert c.get("/map", params={"layer": "moon"}).status_code == 422


@api
def test_compare_api_matches_windows(c):
    j = c.get("/compare", params={"sites": "shack,mala", "points": "-85.4,31.6", "start": T, "end": "2026-12-11T06:00:00Z"}).json()
    assert len(j["sites"]) == 3 and j["sites"][2]["id"] is None
    for k, s in enumerate(j["sites"]):
        q = {"site": s["id"]} if s["id"] else {"lat": -85.4, "lon": 31.6}
        w = c.get("/windows", params={**q, "start": T, "end": "2026-12-11T06:00:00Z"}).json()
        for col in j["columns"]:
            assert j["stats"][col["key"]][k] == w["stats"][col["key"]]
    for col in j["columns"]:
        vals = j["stats"][col["key"]]
        b = max(vals) if col["better"] == "higher" else min(vals)
        assert all(vals[i] == pytest.approx(b) for i in j["best_by"][col["key"]])
    assert j["meta"]["lander_resolved"]["id"] == "reference" and "end" not in j["meta"]["defaults_used"]


@api
def test_compare_verdicts_and_panorama(c):
    j = c.get("/compare", params={"sites": "shack,ridge", "start": T, "landing_time": T, "include": "panorama", "battery_wh": 3000}).json()
    assert len(j["verdicts"]["verdict"]) == 2 and all(isinstance(t, str) and t.endswith(".") for t in j["verdicts"]["text"])
    p = j["panorama"]
    assert len(p["azimuth_deg"]) == 180 and len(p["sites"][0]["skyline_sun_deg"]) == 180
    assert len(p["path_time"]) == len(p["sites"][1]["sun_path"]["azimuth_deg"]) == int(29.5 * 24 // 6) + 1
    assert j["meta"]["lander_resolved"]["power"]["battery"]["capacity_wh"] == 3000
    m = c.get("/mission", params={"site": "ridge", "landing_time": T, "battery_wh": 3000}).json()
    assert j["verdicts"]["verdict"][1] == m["verdict"]
    assert c.get("/compare", params={"sites": "shack"}).status_code == 422
    assert c.get("/compare", params={"sites": "shack,nowhere"}).status_code == 404
    assert c.get("/compare", params={"sites": "shack", "points": "1;2"}).status_code == 422
    assert c.get("/compare", params={"sites": "shack,ridge", "include": "calendar"}).status_code == 422


@api
def test_dsn_api_and_contact(c):
    d = c.get("/dsn", params={"time": T}).json()
    assert [s["name"] for s in d["stations"]] == ["Goldstone", "Madrid", "Canberra"] and "dsn" in d["meta"]["sources"]
    w = c.get("/dsn", params={"start": T, "end": "2026-12-03T06:00:00Z", "min_el_deg": 20}).json()
    assert w["samples"] == 49 and len(w["stations"][0]["elevation_deg"]) == 49 and w["min_el_deg"] == 20
    el = np.array([s["elevation_deg"] for s in w["stations"]])
    assert w["any_station"]["sees_moon_pct"] == pytest.approx(100 * (el >= 20).any(axis=0).mean())
    s = c.get("/sky", params={"site": "mala", "time": T, "dsn": True}).json()
    assert set(s["dsn"]["seeing_moon"]) <= {"Goldstone", "Madrid", "Canberra"}
    assert "dsn" not in c.get("/sky", params={"site": "mala", "time": T}).json()
    a = c.get("/windows", params={"site": "mala", "start": T, "dsn": True, "series": True}).json()
    K = np.array(a["series"]["earthClr"]) > 0
    S = np.array(a["series"]["dsn_any_station"]) > 0
    assert a["stats"]["contact_pct"] == pytest.approx(100 * (K & S).mean())
    assert a["stats"]["contact_pct"] <= a["stats"]["earth_in_view_pct"]
    assert c.get("/dsn", params={"start": T, "end": "2026-11-01T00:00:00Z"}).status_code == 422


@api
def test_landing_window_api(c):
    j = c.get("/landing-window", params={"site": "mala", "plan_time": T, "slip_days": 14}).json()
    assert len(j["sites"]) == 9 and j["slip_days"] == 14 and j["after_slip"]["landing_time"] == "2026-12-15T06:00:00Z"
    st = [s["state"] for s in j["sites"]]
    assert st == sorted(st, reverse=True) and j["sites"][0]["rank"] == 1 and j["summary"].startswith("Searched 9 sites")
    top = j["sites"][0]
    assert top["links"]["report"].startswith("/report?") and top["links"]["mission_design"].startswith("/mission-design?")
    assert all(w["verdict"] in ("meets", "marginal") for w in top["windows"])
    # the best landing time and its verdict agree with /mission there
    m = c.get("/mission", params={"site": top["location"]["id"], "landing_time": top["best_landing_time"]}).json()
    assert m["verdict"] == top["verdict"]
    d0 = c.get("/landing-window", params={"site": "mala", "plan_time": T}).json()
    assert d0["slip_days"] == 0 and "slip_days" in d0 and "plan_time" not in d0["meta"]["defaults_used"]
    p = c.post("/landing-window", json={"plan": {"site": "mala"}, "plan_time": T, "sites": [{"site": "shack"}, {"lat": -85.4, "lon": 31.6}],
                                        "needs_dsn_at_landing": True, "lander": {"base": "reference", "power": {"battery": {"capacity_wh": 2500}}}}).json()
    assert len(p["sites"]) == 3 and p["search"]["needs_dsn_at_landing"] and p["meta"]["lander_resolved"]["power"]["battery"]["capacity_wh"] == 2500
    assert c.get("/landing-window", params={"site": "nowhere"}).status_code == 404
    assert c.get("/landing-window", params={"site": "mala", "flex_days": 61}).status_code == 422
    assert c.get("/landing-window", params={"site": "mala", "lander": "nope"}).status_code == 404


@api
def test_mission_design_api(c):
    j = c.get("/mission-design", params={"site": "mala", "landing_time": T}).json()
    f = j["frontier"]
    assert len(f["capacity_wh"]) == len(f["min_array_w_robust"]) == len(f["min_array_w_nominal"]) == 36
    assert j["lightest"]["mass_kg"] == pytest.approx(j["lightest"]["array_w"] / 80 + j["lightest"]["battery_wh"] / 160)
    assert j["yours"]["mass_kg"] == pytest.approx(400 / 80 + 2000 / 160) and j["yours"]["text"].startswith("400 W + 2,000 Wh")
    assert all(x["text"].endswith(".") for x in j["fixes"]) and len(j["traces"]["state_of_charge_lightest"]) == len(j["traces"]["time"])
    assert "array_w_per_kg (main's 80 W/kg)" in j["meta"]["defaults_used"] and j["links"]["atlas"].startswith("/mission-design/atlas?")
    m = c.get("/mission", params={"site": "mala", "landing_time": T}).json()
    assert m["verdict"] == j["yours"]["verdict"]
    # the lightest design passes when sent back to /mission
    L = j["lightest"]
    mm = c.get("/mission", params={"site": "mala", "landing_time": T, "array_peak_w": L["array_w"], "battery_wh": L["battery_wh"]}).json()
    assert mm["verdict"] == "meets"
    # "use this design": the body saves as a lander
    body = dict(j["use_this_design"]["body"], id="test-design-mala")
    r = c.post("/landers", json=body)
    assert r.status_code in (201, 409)
    c.delete("/landers/test-design-mala")
    # mass figures: query, then the lander's mass block
    k = c.post("/mission-design", json={"location": {"site": "mala"}, "landing_time": T,
                                        "lander": {"base": "reference", "mass": {"array_w_per_kg": 100, "battery_wh_per_kg": 200}}}).json()
    assert k["mass_figures"]["array_w_per_kg"] == 100 and "array_w_per_kg (from the lander's mass block)" in k["meta"]["defaults_used"]
    q = c.get("/mission-design", params={"site": "mala", "landing_time": T, "array_w_per_kg": 120}).json()
    assert q["mass_figures"]["array_w_per_kg"] == 120
    v = c.get("/mission-design", params={"site": "mala", "landing_time": T, "lander": "polar-vertical"}).json()
    assert "vertical_note" in v and len(v["use_this_design"]["body"]["power"]["array"]["faces"]) == 4
    assert c.get("/mission-design", params={"site": "mala", "battery_wh": -1}).status_code == 422


@api
def test_atlas_api(c):
    j = c.get("/mission-design/atlas", params={"site": "mala", "landing_time": T, "days": 30}).json()
    assert len(j["time"]) == len(j["lightest_mass_kg"]) == 60 and j["start"] == "2026-11-26T00:00:00Z" and j["step_h"] == 12
    for b in j["best_dates"]:
        k = j["time"].index(b["landing_time"])
        assert j["lightest_mass_kg"][k] == b["mass_kg"] and b["link"].startswith("/mission-design?")
    ts = [j["time"].index(b["landing_time"]) for b in j["best_dates"]]
    assert all(abs(a - b) >= 6 for i, a in enumerate(ts) for b in ts[i + 1:])
    p = c.post("/mission-design/atlas", json={"location": {"site": "mala"}, "landing_time": T, "days": 10, "step_h": 24}).json()
    assert len(p["time"]) == 10
    assert c.get("/mission-design/atlas", params={"site": "mala", "days": 500}).status_code == 422


@api
def test_report_links_and_version(c):
    r = c.get("/report", params={"site": "mala", "time": T}).json()
    for k in ("landing_window", "mission_design", "mission_design_atlas", "dsn", "map"):
        assert k in r["details"]
    assert r["meta"]["api_version"] == "0.2.0"
    root = c.get("/api").json()
    assert "/compare?sites=shack,ridge,mala" in root["plan"]["where"]
    paths = c.get("/openapi.json").json()["paths"]
    for p in ("/map", "/compare", "/dsn", "/landing-window", "/mission-design", "/mission-design/atlas"):
        assert p in paths


@api
def test_cli_forms(capsys):
    from skyline.__main__ import main
    assert main(["compare", "sites=shack,mala", f"start={T}", "end=2026-12-05T00:00:00Z"]) == 0
    assert '"best_by"' in capsys.readouterr().out
    assert main(["mission-design/atlas", "site=mala", f"landing_time={T}", "days=5"]) == 0
    assert '"best_dates"' in capsys.readouterr().out
    assert main(["landing-window", "site=mala", f"plan_time={T}", "flex_days=3", "sites=mala,shack"]) == 0
    assert '"windows"' in capsys.readouterr().out
