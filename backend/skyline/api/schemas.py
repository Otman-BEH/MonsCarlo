"""Request bodies for the POST endpoints (GET endpoints take flat query parameters with the same names)."""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..engine.mission import MissionSpec
from ..engine.montecarlo import Uncertainty


class LocationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    site: Optional[str] = Field(default=None, description="site id from /sites")
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lon: Optional[float] = Field(default=None, ge=-360, le=360, description="east-positive")

    @model_validator(mode="after")
    def _one(self):
        if not self.site and (self.lat is None or self.lon is None):
            raise ValueError("give site, or both lat and lon")
        return self


LanderSpec = Union[str, dict[str, Any]]


class MissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [{
        "location": {"site": "shack"}, "landing_time": "2026-12-01T06:00:00Z",
        "lander": {"base": "reference", "power": {"battery": {"capacity_wh": 3000}}, "comms": {"antenna_height_m": 10}},
        "mission": {"duration_days": 14, "fault": {"kind": "array", "day": 3}}, "risk": False}]})
    location: LocationIn
    landing_time: Optional[str] = Field(default=None, description="ISO 8601 UTC; default now")
    lander: Optional[LanderSpec] = Field(default=None, description="preset or saved id, a full lander object, or {base: id, ...overrides}")
    mission: MissionSpec = MissionSpec()
    risk: bool = False
    uncertainty: Uncertainty = Uncertainty()
    include: list[Literal["trace"]] = []
    dem: Literal["best", "80m"] = "best"


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [{
        "location": {"site": "mala"}, "time": "2026-12-01T00:00:00Z", "include": ["risk"]}]})
    location: LocationIn
    time: Optional[str] = None
    window_days: float = Field(default=30, gt=0, le=400)
    lander: Optional[LanderSpec] = None
    mission: MissionSpec = MissionSpec()
    uncertainty: Uncertainty = Uncertainty()
    include: list[Literal["series", "horizon", "risk", "trace"]] = []
    dem: Literal["best", "80m"] = "best"
