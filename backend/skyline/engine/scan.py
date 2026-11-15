"""Verdict scan: the mission verdict at many landing hours on one series, for Landing window (and anyone else who needs
verdicts across time). Built on montecarlo.mission_batch, the vectorised port of main's Ana.mission, which keeps main's
pass or fail answers, failure order, faults, safe mode and the Earth-link rule. The tests check it against the scalar
mission.verdict at every index.
"""
from __future__ import annotations

import numpy as np

from . import mission as M
from .montecarlo import mission_batch


def verdict_scan(se: dict, indices, cfg: dict, shape: np.ndarray | None = None) -> dict:
    """For each landing index: verdict state (0 fails, 1 marginal, 2 meets), first failure cause (index into
    mission.CAUSES; nominal for state 0, with the terrain margin for state 1, -1 for state 2), and the nominal lowest
    charge (share of capacity) and longest link gap (h)."""
    shape = M.power_shape(se, cfg) if shape is None else shape
    i0s = np.asarray(indices, dtype=np.int64)
    T = len(i0s)
    full = lambda v: np.full(T, float(v))
    args = (full(cfg["peakW"]), full(cfg["loadSun"]), full(cfg["loadDark"]), full(cfg["capWh"]), shape)
    ok0, c0, s0 = mission_batch(se, i0s.copy(), cfg, full(0.0), *args, stats=True)
    ok1, c1 = mission_batch(se, i0s.copy(), cfg, full(cfg["margin"]), *args)
    state = np.where(~ok0, 0, np.where(ok1, 2, 1)).astype(np.int8)
    cause = np.where(state == 0, c0, np.where(state == 1, c1, -1)).astype(np.int8)
    return {"index": i0s, "state": state, "cause": cause, "min_soc": s0["min_soc"], "max_gap_h": s0["max_gap_h"].astype(np.int64)}


def runs(ok: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive index ranges [a, b] where ok is true."""
    out, a = [], None
    for k, v in enumerate(np.asarray(ok, dtype=bool)):
        if v and a is None:
            a = k
        elif not v and a is not None:
            out.append((a, k - 1))
            a = None
    if a is not None:
        out.append((a, len(ok) - 1))
    return out
