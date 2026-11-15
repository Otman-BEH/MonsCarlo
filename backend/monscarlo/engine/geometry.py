"""Site basis, topocentric look angles, disc fraction, sub-point. Port of main's src/engine.js, vectorised over time."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import AU_KM, REARTH, RM, RSUN

D2R = np.pi / 180.0
R2D = 180.0 / np.pi


@dataclass(frozen=True)
class Basis:
    up: np.ndarray
    north: np.ndarray
    east: np.ndarray
    r: float  # km from the Moon's centre


def site_basis(lat: float, lon: float, h_km: float = 0.0) -> Basis:
    la, lo = lat * D2R, lon * D2R
    cl, sl, co, so = np.cos(la), np.sin(la), np.cos(lo), np.sin(lo)
    return Basis(up=np.array([cl * co, cl * so, sl]), north=np.array([-sl * co, -sl * so, cl]),
                 east=np.array([-so, co, 0.0]), r=RM + (h_km or 0.0))


def look(b: Basis, v: np.ndarray, radius_km: float) -> dict[str, np.ndarray]:
    """Elevation, azimuth (deg, from north through east), angular radius (deg) and distance (km).

    v: (..., 3) Moon-fixed body vectors in km.
    """
    w = np.asarray(v, dtype=np.float64) - b.r * b.up
    d = np.sqrt((w * w).sum(-1))
    u = (w @ b.up) / d
    n = (w @ b.north) / d
    e = (w @ b.east) / d
    az = np.arctan2(e, n) * R2D
    az = np.where(az < 0, az + 360.0, az)
    return {"el": np.arcsin(np.clip(u, -1, 1)) * R2D, "az": az, "rad": np.arcsin(radius_km / d) * R2D, "dist": d}


def sub_point(v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    v = np.asarray(v, dtype=np.float64)
    d = np.sqrt((v * v).sum(-1))
    return np.arcsin(v[..., 2] / d) * R2D, np.arctan2(v[..., 1], v[..., 0]) * R2D


def disc_frac(el, r, hz):
    """Share of a disc (centre elevation el, angular radius r) above a straight horizon at elevation hz."""
    d = (np.asarray(el, dtype=np.float64) - hz) / r
    dc = np.clip(d, -1.0, 1.0)
    f = 1.0 - (np.arccos(dc) - dc * np.sqrt(1.0 - dc * dc)) / np.pi
    return np.where(d >= 1, 1.0, np.where(d <= -1, 0.0, f))


def disc_cover(sep, r, big):
    """Share of a disc of angular radius r that a disc of radius big covers when their centres are sep apart
    (same units, small angles, big >= r): 0 when apart, 1 when the small disc is wholly behind the big one."""
    sep, r, big = (np.asarray(a, dtype=np.float64) for a in (sep, r, big))
    d = np.clip(sep, np.abs(big - r) + 1e-12, big + r)
    with np.errstate(invalid="ignore", divide="ignore"):
        lens = (r * r * np.arccos(np.clip((d * d + r * r - big * big) / (2 * d * r), -1, 1))
                + big * big * np.arccos(np.clip((d * d + big * big - r * r) / (2 * d * big), -1, 1))
                - 0.5 * np.sqrt(np.maximum(0.0, (-d + r + big) * (d + r - big) * (d - r + big) * (d + r + big))))
    return np.where(sep >= big + r, 0.0, np.where(sep <= big - r, 1.0, lens / (np.pi * r * r)))


def separation(el1, az1, el2, az2):
    """Angle (deg) between two sky directions given as elevation and azimuth (deg)."""
    a, b = np.asarray(el1) * D2R, np.asarray(el2) * D2R
    c = np.sin(a) * np.sin(b) + np.cos(a) * np.cos(b) * np.cos((np.asarray(az1) - np.asarray(az2)) * D2R)
    return np.arccos(np.clip(c, -1, 1)) * R2D


def irradiance(sun_dist_km):
    """Solar irradiance factor relative to 1 AU."""
    return (AU_KM / np.asarray(sun_dist_km)) ** 2


__all__ = ["Basis", "site_basis", "look", "sub_point", "disc_frac", "disc_cover", "separation", "irradiance", "RM", "RSUN", "REARTH", "D2R", "R2D"]
