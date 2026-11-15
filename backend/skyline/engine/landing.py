"""Landing window: the best landing times at one or many sites, including after a schedule slip. Port of main's Mission
Rescue (src/app.js at afd9e78: computeRescue and the wording of drawRescue), on top of scan.verdict_scan.

Per site, exactly main's rule: candidate landings every step_h hours over the flexible window after the (slipped) date;
the first candidate that meets the needs, else the first with the best verdict; the number of days in the window whose
landing at the same hour is marginal or better. Sites are ranked by verdict, then the earliest landing, then the highest
lowest charge. New here: the windows (runs of candidate times with the same verdict, marginal or better), and an option
to drop landing times when no Deep Space Network station sees the Moon.
"""
from __future__ import annotations

import numpy as np

from . import mission as M
from .scan import verdict_scan

DSN_REASON = "no Deep Space Network station sees the Moon at landing"


def why(state: int, reasons: list[str], days: float) -> str:
    """One sentence per verdict, in the wording of main's Mission Rescue panel."""
    d = int(days) if float(days).is_integer() else days
    if state == 2:
        return f"Power and Earth contact hold for all {d} days, with the terrain margin."
    if state == 1:
        return f"Works on the modelled terrain; with the margin {reasons[0] if reasons else 'the mission fails'}."
    s = ", and ".join(reasons) if reasons else "the needs cannot be met"
    return s[:1].upper() + s[1:] + "."


def reasons_of(v: dict) -> list[str]:
    st = v["state"]
    return v["nom"]["fails"] if st == 0 else (v["rob"]["fails"] if st == 1 else [])


def search_site(se: dict, i_slip: int, flex_days: int, cfg: dict, step_h: int = 6, allowed: np.ndarray | None = None) -> dict:
    """One site: best landing index, its scalar verdict, good-day count, the scan and the windows.
    allowed: optional boolean per series hour; landing times where it is false are dropped (DSN option)."""
    shape = M.power_shape(se, cfg)
    cand = np.arange(i_slip, i_slip + flex_days * 24 + 1, step_h)
    daily = i_slip + np.arange(flex_days + 1) * 24
    sc = verdict_scan(se, np.concatenate([cand, daily]), cfg, shape)
    st = sc["state"][: len(cand)].astype(np.int64)
    sd = sc["state"][len(cand):].astype(np.int64)
    if allowed is not None:
        st = np.where(allowed[cand], st, -1)
        sd = np.where(allowed[daily], sd, -1)
    best_state = int(st.max())
    if best_state < 0:                                   # every candidate dropped by the DSN rule
        v = M.verdict(se, int(cand[0]), cfg, shape)
        return {"state": 0, "i": int(cand[0]), "verdict": v, "reasons": [DSN_REASON], "good_days": 0,
                "scan": {"index": cand, "state": np.zeros(len(cand), np.int64)}, "windows": []}
    j = int(np.argmax(st == best_state))
    i_best = int(cand[j])
    v = M.verdict(se, i_best, cfg, shape)
    wins = []
    k = 0
    while k < len(cand):
        if st[k] >= 1:
            e = k
            while e + 1 < len(cand) and st[e + 1] == st[k]:
                e += 1
            wins.append({"first": int(cand[k]), "last": int(cand[e]), "state": int(st[k]), "landings": e - k + 1})
            k = e + 1
        else:
            k += 1
    return {"state": int(v["state"]), "i": i_best, "verdict": v, "reasons": reasons_of(v), "good_days": int((sd > 0).sum()),
            "scan": {"index": cand, "state": np.maximum(st, 0)}, "windows": wins}


def rank_key(r: dict):
    return (-r["state"], (r["i"] if r["state"] else 0), -r["verdict"]["nom"]["minSoc"])
