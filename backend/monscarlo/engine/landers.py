"""Lander model (hardware), presets, merge and override rules, validation.

A lander is hardware. A mission is what you ask of it (engine.mission.MissionSpec). Monte Carlo spreads live in
engine.montecarlo.Uncertainty.
"""
from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..prep.store import Store, default_store

PRESETS_PATH = Path(__file__).resolve().parent / "presets" / "landers.json"


class Face(BaseModel):
    model_config = ConfigDict(extra="forbid")
    azimuth_deg: float = Field(ge=-360, le=360, description="face normal, relative to the lander heading")
    peak_w: float = Field(ge=0, description="output at 1 AU with the Sun normal to the face")


class Array(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["tracking", "horizontal", "vertical"] = "tracking"
    peak_w: Optional[float] = Field(default=None, ge=0, description="total output at 1 AU, Sun normal to the panel (tracking/horizontal)")
    faces: Optional[list[Face]] = Field(default=None, description="vertical only")
    heading_deg: float = Field(default=0.0, ge=-360, le=360, description="vertical only: lander yaw from true north")
    height_m: float = Field(default=2.0, ge=0, le=100, description="array height above ground: sets the Sun horizon")

    @model_validator(mode="after")
    def _check(self):
        if self.type == "vertical":
            if not self.faces or not (1 <= len(self.faces) <= 8):
                raise ValueError("a vertical array needs 1 to 8 faces")
        elif self.peak_w is None:
            raise ValueError(f"a {self.type} array needs peak_w")
        return self


class Battery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capacity_wh: float = Field(gt=0)
    min_soc: float = Field(default=0.2, ge=0, lt=1)
    charge_eff: float = Field(default=0.9, gt=0, le=1)


class Loads(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sunlit_w: float = Field(ge=0)
    dark_w: float = Field(ge=0)


class Power(BaseModel):
    model_config = ConfigDict(extra="forbid")
    array: Array
    battery: Battery
    loads: Loads
    safe_mode: bool = Field(default=False, description="shed to the dark load below 40% charge, resume above 70%")


class Comms(BaseModel):
    model_config = ConfigDict(extra="forbid")
    antenna_height_m: float = Field(default=2.0, ge=0, le=100, description="sets the Earth horizon")


class Landing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accuracy_m_3sigma: float = Field(default=500, gt=0, le=20000)
    max_slope_deg: float = Field(default=12, gt=0, le=60)


class Mass(BaseModel):
    model_config = ConfigDict(extra="forbid")
    array_w_per_kg: Optional[float] = Field(default=None, gt=0)
    battery_wh_per_kg: Optional[float] = Field(default=None, gt=0)


class Lander(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    source: str = Field(default="illustrative", max_length=500)
    illustrative: bool = True
    power: Power
    comms: Comms = Comms()
    landing: Landing = Landing()
    mass: Mass = Mass()

    @field_validator("id")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


@lru_cache(maxsize=1)
def _presets() -> dict[str, dict]:
    d = json.loads(PRESETS_PATH.read_text())
    out = {}
    for l in d["landers"]:
        Lander.model_validate(l)
        out[l["id"]] = l
    return out


def presets() -> dict[str, dict]:
    return copy.deepcopy(_presets())


def is_preset(lid: str) -> bool:
    return lid in _presets()


def deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class UnknownLander(KeyError):
    pass


def get(lid: str, store: Store | None = None) -> dict:
    p = _presets().get(lid)
    if p is not None:
        return copy.deepcopy(p)
    s = (store or default_store()).get_lander(lid)
    if s is None:
        raise UnknownLander(lid)
    return s


def list_all(store: Store | None = None) -> list[dict]:
    out = [{"id": l["id"], "name": l["name"], "source": l["source"], "illustrative": l["illustrative"], "kind": "preset"} for l in _presets().values()]
    out += [{"id": l["id"], "name": l["name"], "source": l["source"], "illustrative": l["illustrative"], "kind": "saved"} for l in (store or default_store()).list_landers()]
    return out


# GET flat aliases -> nested paths
FLAT = {
    "array_type": ("power", "array", "type"),
    "array_peak_w": ("power", "array", "peak_w"),
    "array_height_m": ("power", "array", "height_m"),
    "heading_deg": ("power", "array", "heading_deg"),
    "antenna_height_m": ("comms", "antenna_height_m"),
    "battery_wh": ("power", "battery", "capacity_wh"),
    "min_soc": ("power", "battery", "min_soc"),
    "charge_eff": ("power", "battery", "charge_eff"),
    "load_sunlit_w": ("power", "loads", "sunlit_w"),
    "load_dark_w": ("power", "loads", "dark_w"),
    "safe_mode": ("power", "safe_mode"),
}


def flat_to_nested(flat: dict) -> dict:
    out: dict = {}
    for k, v in flat.items():
        if v is None:
            continue
        path = FLAT[k]
        d = out
        for p in path[:-1]:
            d = d.setdefault(p, {})
        d[path[-1]] = v
    return out


def resolve(spec, store: Store | None = None) -> dict:
    """spec: None | id string | full lander dict | {"base": id, ...overrides}. Returns a validated lander dict."""
    if spec is None:
        spec = "reference"
    if isinstance(spec, str):
        lander = get(spec, store)
    elif isinstance(spec, dict):
        if "base" in spec:
            over = {k: v for k, v in spec.items() if k != "base"}
            base = get(spec["base"], store)
            lander = deep_merge(base, over)
            if over and "id" not in over:
                lander["id"] = base["id"] + "-custom"
        else:
            lander = spec
    else:
        raise TypeError("lander must be an id, an object, or {base, ...overrides}")
    arr = lander.get("power", {}).get("array")
    if isinstance(arr, dict) and arr.get("type", "tracking") != "vertical":
        arr["faces"] = None
    return Lander.model_validate(lander).model_dump()


def with_overrides(base: dict, flat: dict) -> dict:
    nested = flat_to_nested(flat)
    if not nested:
        return base
    merged = deep_merge(base, nested)
    if merged["id"] == base["id"]:
        merged["id"] = re.sub(r"(-custom)?$", "-custom", base["id"])
    if merged["power"]["array"]["type"] != "vertical":
        merged["power"]["array"]["faces"] = None
        if merged["power"]["array"].get("peak_w") is None:
            # switching a vertical lander to tracking/horizontal: use the faces' total as the peak
            merged["power"]["array"]["peak_w"] = sum(f["peak_w"] for f in base["power"]["array"].get("faces") or [])
    return Lander.model_validate(merged).model_dump()
