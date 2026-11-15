"""Landing-date planning: verdicts for many landing times at once and the 12-month calendar. Port of main's
src/app.js calStates. Mission Rescue is now engine/landing.py (/landing-window)."""
from __future__ import annotations

import numpy as np

from . import mission as M
from .montecarlo import mission_batch

CAUSE_TEXT = {0: "the Sun is not up at landing", 1: "no Earth line of sight at landing", 2: "the battery runs too low",
              3: "Earth is out of view for too long", 4: "the ground is too steep", 5: "the ephemeris window ends before the mission does"}


def verdicts(se: dict, i0s, cfg: dict, shape=None) -> tuple[np.ndarray, np.ndarray]:
    """Verdict state (0 fails, 1 marginal, 2 meets) for each landing index, and the first failure cause
    (nominal for state 0, with the terrain margin for state 1, -1 for state 2)."""
    shape = M.power_shape(se, cfg) if shape is None else shape
    i0s = np.asarray(i0s, dtype=np.int64)
    T = len(i0s)
    full = lambda v: np.full(T, float(v))
    args = (full(cfg["peakW"]), full(cfg["loadSun"]), full(cfg["loadDark"]), full(cfg["capWh"]), shape)
    ok0, c0 = mission_batch(se, i0s.copy(), cfg, full(0.0), *args)
    ok1, c1 = mission_batch(se, i0s.copy(), cfg, full(cfg["margin"]), *args)
    state = np.where(~ok0, 0, np.where(ok1, 2, 1))
    cause = np.where(state == 0, c0, np.where(state == 1, c1, -1))
    return state.astype(np.int8), cause.astype(np.int8)


def calendar(se: dict, cfg: dict, days: int = 366, shape=None) -> dict:
    """Verdict for a landing at the start of each day of the series (main's 12-month calendar)."""
    st, cz = verdicts(se, np.arange(days) * 24, cfg, shape)
    return {"state": st.tolist(), "cause": [CAUSE_TEXT.get(int(c)) if c >= 0 else None for c in cz],
            "good_days": int((st == 2).sum()), "marginal_days": int((st == 1).sum())}
