"""Monte Carlo pieces against main's JS: bit-exact random numbers, cellTrials, aimStats, wilson; and the vectorised batch
simulation against the scalar port."""
import numpy as np
import pytest

from conftest import arr
from skyline.engine import mission as M
from skyline.engine import montecarlo as MC
from skyline.engine import visibility as V
from test_parity_core import view_from_golden


@pytest.fixture(autouse=True)
def _match_golden_arch(golden):
    """The golden file records the CPU it was made on: V8's Math.log differs by an ulp between arm64 (fused
    multiply-add) and x64 builds, so pick the matching variant."""
    old = MC.Rng.FMA_DEFAULT
    MC.Rng.FMA_DEFAULT = golden.get("arch") == "arm64"
    yield
    MC.Rng.FMA_DEFAULT = old


def test_rng_bit_exact(golden):
    for case in golden["rng"]:
        R = MC.Rng(case["seed"])
        assert [R.u() for _ in range(20)] == case["u"]
        R = MC.Rng(case["seed"])
        assert [R.n() for _ in range(20)] == case["n"]
    # the uniform stream needs no log: it is bit-exact whatever the CPU
    assert all(MC.Rng(c["seed"], fma=f).u() == c["u"][0] for c in golden["rng"] for f in (False, True))


def test_js_log_against_v8(golden):
    xs = golden.get("logs") or []
    fma = golden.get("arch") == "arm64"
    assert xs and all(MC.js_log(x, fma) == y for x, y in xs)


def test_mix_bit_exact(golden):
    for c in golden["mix"]:
        assert MC.mix(c["seed"], c["k"], c["salt"]) == c["h"]


def test_wilson(golden):
    for c in golden["wilson"]:
        lo, hi = MC.wilson(c["p"], c["n"])
        assert abs(lo - c["ci"][0]) < 1e-12 and abs(hi - c["ci"][1]) < 1e-12


def test_aim_stats(golden):
    a = golden["aimStats"]
    P = arr(a["P"])
    for c in a["cases"]:
        r = MC.aim_stats(P, a["n"], c["s"], c["ax"], c["ay"], c["sigma"], c["K"])
        for k in ("p", "var", "nEff", "lo", "hi"):
            assert abs(r[k] - c["r"][k]) <= 1e-9 * max(1, abs(c["r"][k])), k
        assert r["inside"] == c["r"]["inside"]
        pr = MC.aim_prob(P, a["n"], c["s"], c["ax"], c["ay"], c["sigma"])
        assert abs(pr["p"] - c["prob"]["p"]) < 1e-9 and abs(pr["nEff"] - c["prob"]["nEff"]) < 1e-9


def test_cell_trials(golden, table):
    se = V.series(view_from_golden(golden, "mala"), table)
    for c in golden["cellTrials"]:
        counts = np.zeros(6)
        cfg = dict(c["cfg"])
        p = MC.cell_trials(se, c["i0"], cfg, c["sig"], MC.Rng(c["seed"]), c["K"], counts, M.power_shape(se, cfg))
        assert abs(p - c["p"]) < 1e-9, (c["i0"], p, c["p"])
        assert counts.tolist() == c["counts"]


@pytest.mark.parametrize("fault", ["none", "array", "battery", "load", "antenna"])
@pytest.mark.parametrize("safe", [False, True])
def test_batch_equals_scalar(golden, table, fault, safe):
    se = V.series(view_from_golden(golden, "shack"), table)
    cfg = {"days": 10, "peakW": 400, "loadSun": 180, "loadDark": 60, "capWh": 1400, "minSoc": 0.2, "tracking": True,
           "needEarth": True, "maxGapH": 12, "margin": 0.3, "chargeEff": 0.9, "fault": {"kind": fault, "day": 2}, "safe": safe, "autonomyH": 6}
    rng = np.random.default_rng(5)
    T = 64
    i0 = rng.integers(0, 600, T)
    margin = rng.normal(0, 0.3, T)
    peak = 400 * (1 + rng.normal(0, 0.2, T))
    l = 1 + rng.normal(0, 0.2, T)
    cap = 1400 * (1 + rng.normal(0, 0.2, T))
    shp = M.power_shape(se, cfg)
    ok, cause = MC.mission_batch(se, i0, cfg, margin, peak, 180 * l, 60 * l, cap, shp)
    for t in range(T):
        c = dict(cfg, peakW=peak[t], loadSun=180 * l[t], loadDark=60 * l[t], capWh=cap[t])
        r = M.mission(se, int(i0[t]), c, margin[t], False, shp)
        assert r["ok"] == bool(ok[t]), t
        if not r["ok"]:
            assert M.cause_of(r["fails"][0]) == cause[t], (t, r["fails"])
