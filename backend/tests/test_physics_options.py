"""The optional physics refinements: cover-glass reflection on fixed panels, a limb-darkened Sun, a minimum Earth
clearance for the radio link, battery discharge efficiency and touchdown charge, and a heat balance with heaters. All
are off by default, so the parity tests with main's JS engine are untouched. Earth eclipsing the Sun is always on and is
exactly 1 outside eclipses. These tests need no downloaded data: they run on the golden series."""
import math

import numpy as np
import pytest

from conftest import arr
from monscarlo.engine import geometry as G
from monscarlo.engine import landers as L
from monscarlo.engine import mission as M
from monscarlo.engine import power as PW
from monscarlo.engine import visibility as V
from monscarlo.engine.montecarlo import mission_batch


def series(golden, table, sid="shack", eye=2):
    s = golden["sites"][sid]
    m = arr(golden["profileMask"][sid][str(eye)]["mask"])
    return V.series(V.View(lat=s["lat"], lon=s["lon"], ground_m=s["h0"], sun_mask=m, earth_mask=m, array_h=eye, antenna_h=eye), table)


def lander(array=None, battery=None, loads=None):
    return {"power": {"array": array or {"type": "tracking", "peak_w": 200.0},
                      "battery": {"capacity_wh": 800.0, "min_soc": 0.2, "charge_eff": 0.9, **(battery or {})},
                      "loads": loads or {"sunlit_w": 120.0, "dark_w": 40.0}, "safe_mode": False}}


def test_glass_transmission_is_fresnel():
    T = PW.glass_transmission
    assert abs(float(T(1.0)) - 1) < 1e-12 and float(T(0.0)) == 0
    # one air to glass surface, n = 1.5, 60 deg, worked by hand: cos(refracted) = 0.81650, Rs = 0.17657, Rp = 0.00180,
    # so T = 1 - (Rs + Rp) / 2 = 0.91081, over 0.96 head-on
    assert abs(float(T(0.5)) - 0.91081 / 0.96) < 2e-5
    c = np.linspace(0, 1, 200)
    assert np.all(np.diff(T(c)) > 0)


def test_incidence_loss_only_touches_fixed_panels():
    el, az = np.array([1.5, 5.0, 30.0, 90.0]), np.array([10.0, 100.0, 200.0, 300.0])
    assert np.all(PW.shape({"type": "tracking", "peak_w": 100, "incidence_loss": True}, el, az) == 1)
    h0 = PW.shape({"type": "horizontal", "peak_w": 100}, el, az)
    h1 = PW.shape({"type": "horizontal", "peak_w": 100, "incidence_loss": True}, el, az)
    assert np.all(h1 <= h0) and abs(h1[3] - 1) < 1e-12 and h1[0] < 0.2 * h0[0]      # grazing Sun: most light reflects
    faces = [{"azimuth_deg": a, "peak_w": 50} for a in (0, 90, 180, 270)]
    v0 = PW.shape({"type": "vertical", "faces": faces}, el, az)
    v1 = PW.shape({"type": "vertical", "faces": faces, "incidence_loss": True}, el, az)
    assert np.all(v1 <= v0 + 1e-15) and np.all(v1[:3] > 0.9 * v0[:3])      # low Sun on upright faces: near head-on, small loss


@pytest.mark.parametrize("u", [0.3, 0.6, 1.0])
def test_limb_darkened_share_matches_numerical_integral(u):
    # brute force: integrate I(mu) = 1 - u (1 - mu) over the part of the unit disc above the line y = -d
    n = 1201
    x, y = np.meshgrid(np.linspace(-1, 1, n), np.linspace(-1, 1, n))
    r2 = x * x + y * y
    I = np.where(r2 <= 1, 1 - u * (1 - np.sqrt(np.clip(1 - r2, 0, 1))), 0.0)
    for d in (-0.9, -0.5, -0.1, 0.0, 0.3, 0.8):
        ref = I[y >= -d].sum() / I.sum()
        assert abs(float(M.lit_share(d, u)) - ref) < 3e-3, d
    assert float(M.lit_share(0.0, u)) == pytest.approx(0.5) and float(M.lit_share(1.0, u)) == 1 and float(M.lit_share(-1.0, u)) == 0
    assert float(M.lit_share(-0.8, u)) < float(M.lit_share(-0.8, 0))      # a sliver of limb is dimmer than its area


def test_defaults_change_nothing(golden, table):
    se = series(golden, table)
    spec = M.MissionSpec()
    assert spec.link_min_clearance_deg == 0 and spec.limb_darkening == 0
    assert L.Battery(capacity_wh=500).discharge_eff == 1 and L.Array(peak_w=100).incidence_loss is False
    cfg = M.make_cfg(lander(), spec)
    old = {k: v for k, v in cfg.items() if k not in ("linkMin", "limb", "dischargeEff")}      # a cfg from before this change
    for i0 in (0, 100, 333, 700):
        a, b = M.mission(se, i0, cfg, 0.3), M.mission(se, i0, old, 0.3)
        assert a["fails"] == b["fails"] and a["minSoc"] == b["minSoc"] and a["maxGapH"] == b["maxGapH"]


def test_each_option_is_conservative(golden, table):
    se = series(golden, table)
    base = M.mission(se, 200, M.make_cfg(lander(), M.MissionSpec()), 0.0)
    dis = M.mission(se, 200, M.make_cfg(lander(battery={"discharge_eff": 0.9}), M.MissionSpec()), 0.0)
    assert dis["minSoc"] <= base["minSoc"] and dis["battNeedWh"] >= base["battNeedWh"]
    link = M.mission(se, 200, M.make_cfg(lander(), M.MissionSpec(link_min_clearance_deg=0.95)), 0.0)
    assert link["linkPct"] <= base["linkPct"] and link["maxGapH"] >= base["maxGapH"]
    hor = lander(array={"type": "horizontal", "peak_w": 4000.0})
    glass = lander(array={"type": "horizontal", "peak_w": 4000.0, "incidence_loss": True})
    assert M.mission(se, 200, M.make_cfg(glass, M.MissionSpec()), 0.0)["minSoc"] <= M.mission(se, 200, M.make_cfg(hor, M.MissionSpec()), 0.0)["minSoc"]


def test_scalar_and_batch_agree_with_options_on(golden, table):
    """mission() and mission_batch() are two copies of one simulation: they must agree with every option switched on."""
    faces = [{"azimuth_deg": a, "peak_w": 110.0} for a in (0, 90, 180, 270)]
    states, heated = set(), 0
    for sid in ("shack", "mala", "im1"):                                  # always lit, lit then dark, mostly dark
        se = series(golden, table, sid)
        for arr_ in ({"type": "tracking", "peak_w": 200.0}, {"type": "vertical", "faces": faces, "incidence_loss": True}):
            ld = lander(array=arr_, battery={"discharge_eff": 0.92, "initial_soc": 0.8}, loads={"sunlit_w": 120.0, "dark_w": 25.0})
            ld["thermal"] = L.Thermal(radiating_area_m2=0.6).model_dump()
            cfg = M.make_cfg(ld, M.MissionSpec(link_min_clearance_deg=0.95, limb_darkening=0.6, max_gap_h=48, duration_days=6))
            shp = M.power_shape(se, cfg)
            i0 = np.arange(0, 800, 9)
            full = lambda v: np.full(len(i0), float(v))
            for margin in (0.0, 0.3):
                ok, cause = mission_batch(se, i0.copy(), cfg, full(margin), full(cfg["peakW"]), full(cfg["loadSun"]), full(cfg["loadDark"]), full(cfg["capWh"]), shp)
                for k, i in enumerate(i0):
                    r = M.mission(se, int(i), cfg, margin, False, shp)
                    assert bool(ok[k]) == r["ok"], (sid, arr_["type"], margin, int(i), r["fails"])
                    if not r["ok"]:
                        assert int(cause[k]) == M.cause_of(r["fails"][0]), (sid, int(i), r["fails"])
                    states.add(r["ok"])
                    heated += r["thermal"]["heater_hours"] > 0
    assert states == {True, False} and heated > 50      # the comparison covers passes, failures and heater use


# ---------------------------------------------------------------- Earth in front of the Sun
def test_disc_cover_matches_numerical_overlap():
    r, big = 0.27, 0.95
    n = 1401
    x, y = np.meshgrid(np.linspace(-r, r, n), np.linspace(-r, r, n))
    inside = x * x + y * y <= r * r
    for sep in (0.2, 0.7, 0.9, 0.95, 1.1, 1.21, 1.3):
        ref = (inside & ((x - sep) ** 2 + y * y <= big * big)).sum() / inside.sum()
        assert abs(float(G.disc_cover(sep, r, big)) - ref) < 2e-3, sep
    assert float(G.disc_cover(1.5, r, big)) == 0 and float(G.disc_cover(0.5, r, big)) == 1


def test_eclipse_scales_irradiance_and_is_exactly_one_otherwise(golden, table):
    flat = np.zeros(720)
    v = V.View(lat=-89.5, lon=10.0, ground_m=0.0, sun_mask=flat, earth_mask=flat, array_h=2, antenna_h=2)
    st = V.state_at(v, table[:, :3], table[:, 3:])
    assert np.all(st["sunEcl"] == 1.0)                                    # no eclipse in the golden window: nothing changes
    assert np.array_equal(st["irr"], G.irradiance(st["sunDist"]))
    earth = np.array([[0.0, 3.8e5, -3.0e4]])
    behind = V.state_at(v, earth * 389.0, earth)                          # the Sun straight behind Earth
    assert float(behind["sunEcl"][0]) == 0 and float(behind["irr"][0]) == 0
    part = V.state_at(v, earth * 389.0 + np.array([[1.2e6, 0.0, 2.2e6]]), earth)      # the Sun about 1 deg off Earth's centre
    sep = float(G.separation(part["sunEl"], part["sunAz"], part["earthEl"], part["earthAz"])[0])
    assert 0.7 < sep < 1.2 and 0 < float(part["sunEcl"][0]) < 1
    assert float(part["sunEcl"][0]) == pytest.approx(1 - float(G.disc_cover(sep, part["sunRad"][0], part["earthRad"][0])))
    assert float(part["irr"][0]) == pytest.approx(float(G.irradiance(part["sunDist"])[0] * part["sunEcl"][0]))


# ---------------------------------------------------------------- heat balance and heaters
def test_thermal_step_limits_and_against_fine_integration():
    c = M.thermal_consts(L.Thermal().model_dump())
    leak = c["g"] * (c["lo"] ** 4 - c["Ts4"])
    assert 60 < leak < 75                                                 # 0.3 m2 at -20 C leaks about 68 W
    T, h = M.thermal_step(c["lo"], 20.0, c)                               # at the set point with 20 W inside: heaters fill the gap
    assert float(T) == c["lo"] and abs(float(h) - (leak - 20.0)) < 1e-9
    T, h = M.thermal_step(c["lo"], leak + 50.0, c)                        # more heat than the leak: it warms, no heater
    assert float(T) > c["lo"] and float(h) == 0
    T, h = M.thermal_step(c["hi"], 5000.0, c)                             # the radiator caps the hot side
    assert float(T) == c["hi"] and float(h) == 0
    # cooling from +40 C with 30 W inside: the hourly step tracks a 1 s integration of C dT/dt = q - g (T^4 - Ts^4)
    for area in (0.3, 3.0):
        c = M.thermal_consts(L.Thermal(radiating_area_m2=area, keep_above_c=-150).model_dump())
        Th = Tf = 313.15
        for _ in range(12):
            Th = float(M.thermal_step(Th, 30.0, c)[0])
            for _ in range(3600):
                Tf += (30.0 - c["g"] * (Tf ** 4 - c["Ts4"])) / c["C"]
        assert abs(Th - Tf) < 2.5, (area, Th, Tf)


def test_thermal_and_touchdown_charge_cost_battery(golden, table):
    se = series(golden, table, "mala")                                    # Malapert: lit at hour 0, dark from hour 121
    cold = lander(battery={"capacity_wh": 20000.0}, loads={"sunlit_w": 120.0, "dark_w": 15.0})      # a deep sleep: 15 W in the dark
    base = M.mission(se, 0, M.make_cfg(cold, M.MissionSpec()), 0.0)
    warm = dict(cold, thermal=L.Thermal().model_dump())
    r = M.mission(se, 0, M.make_cfg(warm, M.MissionSpec()), 0.0)
    assert base["thermal"] is None and "thermal" not in M.summary_of(base, 800.0)
    th = M.summary_of(r, 800.0)["thermal"]
    assert th["heater_hours"] > 0 and th["heater_wh"] > 0 and th["coldest_c"] == pytest.approx(-20) and th["warmest_c"] <= 40 + 1e-9
    assert 0 < r["minSoc"] < base["minSoc"] - 0.1                         # staying warm costs energy the sleep load ignored
    # the extra drain is the heater energy: the two runs differ by it and nothing else while the Sun is down
    assert (base["minSoc"] - r["minSoc"]) * 20000.0 == pytest.approx(th["heater_wh"], rel=0.05)
    low = M.mission(se, 0, M.make_cfg(lander(battery={"initial_soc": 0.6}), M.MissionSpec()), 0.0)
    assert low["minSoc"] <= 0.6 + 1e-12
    with pytest.raises(Exception):
        L.Thermal(keep_above_c=10, keep_below_c=0)


# ---------------------------------------------------------------- what the design lab's bisection relies on
def test_more_hardware_never_hurts_without_safe_mode(golden, table):
    """The design lab bisects on array and battery size, which is only right if a larger one never turns a pass into a
    fail. That holds without safe mode. With safe mode it does not (shedding load early can save a smaller design), so
    the lab's answer is then a passing design, not always the smallest."""
    caps, peaks = np.geomspace(100, 60000, 60), np.geomspace(20, 5000, 60)
    full = lambda v: np.full(60, float(v))
    for sid in ("mala", "viper", "im1"):
        se = series(golden, table, sid)
        cfg = M.make_cfg(lander(array={"type": "tracking", "peak_w": 400.0}, loads={"sunlit_w": 180.0, "dark_w": 60.0}), M.MissionSpec(needs_earth=False))
        shp = M.power_shape(se, cfg)
        for i0 in range(0, 700, 60):
            okc, _ = mission_batch(se, np.full(60, i0), cfg, full(0.3), full(400), full(180), full(60), caps.copy(), shp)
            okp, _ = mission_batch(se, np.full(60, i0), cfg, full(0.3), peaks.copy(), full(180), full(60), full(2000), shp)
            assert not np.any(okc[:-1] & ~okc[1:]) and not np.any(okp[:-1] & ~okp[1:]), (sid, i0)
