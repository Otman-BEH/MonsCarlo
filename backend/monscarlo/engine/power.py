"""Solar array output models.

With irr = (1 AU / sun distance)^2 and f = visible share of the Sun's disc after the terrain margin:
  tracking    P = peak_w * irr * f                                   (main's tracking: true)
  horizontal  P = peak_w * irr * f * max(0, sin(sun_el))             (main's tracking: false)
  vertical    P = sum(face.peak_w * irr * f * max(0, cos(sun_el) * cos(sun_az - (heading + face.azimuth))))

Self-shadowing between vertical faces is ignored. Everything is expressed as a per-hour "shape" factor so that
P = peak_w * shape * irr * f, which lets the Monte Carlo scale the array output with one number per trial.
"""
from __future__ import annotations

import numpy as np

D2R = np.pi / 180.0


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
    if t == "horizontal":
        return np.maximum(0.0, np.sin(np.asarray(sun_el) * D2R))
    if t == "vertical":
        faces = array["faces"] or []
        tot = sum(f["peak_w"] for f in faces)
        if tot <= 0:
            return np.zeros_like(np.asarray(sun_el, dtype=np.float64))
        hd = array.get("heading_deg", 0.0) if heading_deg is None else heading_deg
        ce = np.cos(np.asarray(sun_el) * D2R)
        out = 0.0
        for f in faces:
            out = out + (f["peak_w"] / tot) * np.maximum(0.0, ce * np.cos((np.asarray(sun_az) - (hd + f["azimuth_deg"])) * D2R))
        return out
    raise ValueError(f"unknown array type {t!r}")
