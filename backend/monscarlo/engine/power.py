"""Solar array output models.

With irr = (1 AU / sun distance)^2 and f = visible share of the Sun's disc after the terrain margin:
  tracking    P = peak_w * irr * f                                   (main's tracking: true)
  horizontal  P = peak_w * irr * f * max(0, sin(sun_el))             (main's tracking: false)
  vertical    P = sum(face.peak_w * irr * f * max(0, cos(sun_el) * cos(sun_az - (heading + face.azimuth))))

Fixed panels (horizontal, vertical) can also lose light to reflection off the cover glass (array.incidence_loss):
their output is multiplied by glass_transmission(cos i), the Fresnel transmission of one air-to-glass surface (n = 1.5,
unpolarised) relative to head-on light. It is 1.00 head-on, 0.98 at 50 deg, 0.86 at 70 deg, 0.64 at 80 deg, 0.40 at
85 deg and 0.15 at 88.5 deg from the panel normal. A tracking array faces the Sun, so it is not affected. Off by default.

Self-shadowing between vertical faces is ignored. Everything is expressed as a per-hour "shape" factor so that
P = peak_w * shape * irr * f, which lets the Monte Carlo scale the array output with one number per trial.
"""
from __future__ import annotations

import numpy as np

D2R = np.pi / 180.0


GLASS_N = 1.5


def glass_transmission(cos_i):
    """Light a flat cover glass lets through at incidence i, relative to head-on light (Fresnel, unpolarised)."""
    c = np.clip(np.asarray(cos_i, dtype=np.float64), 0.0, 1.0)
    ct = np.sqrt(1.0 - (1.0 - c * c) / (GLASS_N * GLASS_N))
    with np.errstate(invalid="ignore", divide="ignore"):
        rs = ((c - GLASS_N * ct) / (c + GLASS_N * ct)) ** 2
        rp = ((ct - GLASS_N * c) / (ct + GLASS_N * c)) ** 2
    t0 = 1.0 - ((GLASS_N - 1.0) / (GLASS_N + 1.0)) ** 2
    return (1.0 - 0.5 * (rs + rp)) / t0


def total_peak_w(array: dict) -> float:
    if array["type"] == "vertical":
        return float(sum(f["peak_w"] for f in array["faces"] or []))
    return float(array["peak_w"])


def shape(array: dict, sun_el: np.ndarray, sun_az: np.ndarray, heading_deg: float | np.ndarray | None = None) -> np.ndarray:
    """Per-hour output per watt of peak (before irradiance and disc fraction).

    heading_deg may be an array of shape (trials, 1) for Monte Carlo with a random heading, giving (trials, hours).
    """
    t = array["type"]
    if t == "tracking":
        return np.ones_like(np.asarray(sun_el, dtype=np.float64))
    glass = bool(array.get("incidence_loss"))
    if t == "horizontal":
        c = np.maximum(0.0, np.sin(np.asarray(sun_el) * D2R))
        return c * glass_transmission(c) if glass else c
    if t == "vertical":
        faces = array["faces"] or []
        tot = sum(f["peak_w"] for f in faces)
        if tot <= 0:
            return np.zeros_like(np.asarray(sun_el, dtype=np.float64))
        hd = array.get("heading_deg", 0.0) if heading_deg is None else heading_deg
        ce = np.cos(np.asarray(sun_el) * D2R)
        out = 0.0
        for f in faces:
            c = np.maximum(0.0, ce * np.cos((np.asarray(sun_az) - (hd + f["azimuth_deg"])) * D2R))
            out = out + (f["peak_w"] / tot) * (c * glass_transmission(c) if glass else c)
        return out
    raise ValueError(f"unknown array type {t!r}")
