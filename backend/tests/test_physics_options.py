"""The optional physics refinements: cover-glass reflection on fixed panels, a limb-darkened Sun, a minimum Earth
clearance for the radio link, and battery discharge efficiency. All are off by default, so the parity tests with main's
JS engine are untouched. These tests need no downloaded data: they run on the golden series."""
import math

import numpy as np
import pytest

from conftest import arr
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
    se = series(golden, table)
    faces = [{"azimuth_deg": a, "peak_w": 110.0} for a in (0, 90, 180, 270)]
    for arr_ in ({"type": "tracking", "peak_w": 200.0}, {"type": "vertical", "faces": faces, "incidence_loss": True}):
        ld = lander(array=arr_, battery={"discharge_eff": 0.92})
        cfg = M.make_cfg(ld, M.MissionSpec(link_min_clearance_deg=0.95, limb_darkening=0.6, max_gap_h=48))
        shp = M.power_shape(se, cfg)
        i0 = np.arange(0, 1400, 7)
        full = lambda v: np.full(len(i0), float(v))
        states = set()
        for margin in (0.0, 0.3):
            ok, cause = mission_batch(se, i0.copy(), cfg, full(margin), full(cfg["peakW"]), full(cfg["loadSun"]), full(cfg["loadDark"]), full(cfg["capWh"]), shp)
            for k, i in enumerate(i0):
                r = M.mission(se, int(i), cfg, margin, False, shp)
                assert bool(ok[k]) == r["ok"], (arr_["type"], margin, int(i), r["fails"])
                if not r["ok"]:
                    assert int(cause[k]) == M.cause_of(r["fails"][0]), (int(i), r["fails"])
                states.add(r["ok"])
        assert states == {True, False}      # the comparison covers passing and failing landings
