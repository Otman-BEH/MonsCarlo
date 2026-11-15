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


class CalendarRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    locations: list[LocationIn] = Field(min_length=1, max_length=8)
    start: Optional[str] = Field(default=None, description="first day (default today)")
    days: int = Field(default=366, ge=1, le=400)
    lander: Optional[LanderSpec] = None
    mission: MissionSpec = MissionSpec()
    dem: Literal["best", "80m"] = "best"


class LandingWindowRequest(BaseModel):
    """POST /landing-window: the nested form (like POST /mission)."""
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [{
        "plan": {"site": "mala"}, "plan_time": "2026-12-01T06:00:00Z", "slip_days": 14, "flex_days": 21, "scope": "pole",
        "lander": "reference", "mission": {"duration_days": 10}}]})
    plan: LocationIn
    plan_time: Optional[str] = Field(default=None, description="ISO 8601 UTC; default now")
    slip_days: int = Field(default=0, ge=0, le=365, description="schedule slip before the search starts (main's default was 14)")
    flex_days: int = Field(default=21, ge=0, le=60, description="how many days after the slipped date to search")
    scope: Literal["pole", "all"] = Field(default="pole", description="pole: every catalogue site at or below 80S; all: every site")
    sites: Optional[list[LocationIn]] = Field(default=None, max_length=30, description="search these instead of scope")
    step_h: int = Field(default=6, ge=1, le=24)
    needs_dsn_at_landing: bool = False
    min_el_deg: float = Field(default=10, ge=0, le=90)
    lander: Optional[LanderSpec] = None
    mission: MissionSpec = MissionSpec()
    dem: Literal["best", "80m"] = "best"


class MissionDesignRequest(BaseModel):
    """POST /mission-design and POST /mission-design/atlas: everything POST /mission takes, plus the mass figures."""
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [{
        "location": {"site": "mala"}, "landing_time": "2026-12-01T06:00:00Z", "lander": "reference", "mission": {"duration_days": 10}}]})
    location: LocationIn
    landing_time: Optional[str] = None
    lander: Optional[LanderSpec] = None
    mission: MissionSpec = MissionSpec()
    array_w_per_kg: Optional[float] = Field(default=None, ge=5, le=500, description="default: the lander's mass block, else 80")
    battery_wh_per_kg: Optional[float] = Field(default=None, ge=20, le=500, description="default: the lander's mass block, else 160")
    start: Optional[str] = Field(default=None, description="atlas only: first landing time (default 5 days before the landing day)")
    days: float = Field(default=60, ge=1, le=120, description="atlas only")
    step_h: int = Field(default=12, ge=1, le=48, description="atlas only")
    dem: Literal["best", "80m"] = "best"
