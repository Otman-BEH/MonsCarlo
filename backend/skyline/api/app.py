"""FastAPI app: routes, error handlers. Run with `python run.py` (prepares the data first) or
`uvicorn skyline.api.app:app --port 8000` when the data is already prepared."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .. import config
from ..engine.ephemeris import EphemerisError
from ..engine.landers import UnknownLander
from ..engine.service import OutOfCoverage
from ..engine.sites import BadLocation, UnknownSite
from .routes import router

DESCRIPTION = """
Sun and Earth against the real lunar skyline, for any site, date and lander.

**One call answers the challenge question** (`/report`). Five more give you every number behind it:
`/sky` (Sun and Earth now), `/windows` (power and radio windows), `/mission` (verdict for a lander, optional Monte Carlo
landing risk), `/horizon` (the skyline), `/sites` and `/landers`.

Ephemeris: JPL Horizons API, cached by month in SQLite (SPICE DE440 fallback). Terrain: NASA LOLA elevation models
(PGDA products 78 and 90). Every response names its sources in `meta`.
"""

app = FastAPI(title="Mons Carlo API", version=config.API_VERSION, description=DESCRIPTION)
# local use by the web app and other tools on this machine
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=2000)
app.include_router(router)


def _err(status: int, detail: str, **extra):
    return JSONResponse(status_code=status, content={"detail": detail, **extra})


@app.exception_handler(UnknownSite)
async def _unknown_site(_: Request, ex: UnknownSite):
    return _err(404, f"unknown site {ex.args[0]!r}; see /sites")


@app.exception_handler(UnknownLander)
async def _unknown_lander(_: Request, ex: UnknownLander):
    return _err(404, f"unknown lander {ex.args[0]!r}; see /landers")


@app.exception_handler(BadLocation)
async def _bad_location(_: Request, ex: BadLocation):
    return _err(422, str(ex))


@app.exception_handler(ValidationError)
async def _validation(_: Request, ex: ValidationError):
    return _err(422, "invalid input", errors=[{"loc": list(e["loc"]), "msg": e["msg"]} for e in ex.errors()])


@app.exception_handler(OutOfCoverage)
async def _coverage(_: Request, ex: OutOfCoverage):
    return _err(400, str(ex))


@app.exception_handler(EphemerisError)
async def _eph(_: Request, ex: EphemerisError):
    return _err(503, str(ex), hint="Horizons could not be reached and the SPICE kernels are missing: run python -m skyline.prep.fetch_data")


@app.exception_handler(ValueError)
async def _value(_: Request, ex: ValueError):
    return _err(422, str(ex))


@app.get("/api", include_in_schema=False)
def api_root():
    return {"name": "Mons Carlo API", "version": config.API_VERSION, "docs": "/docs",
            "try": ["/report?site=shack", "/sky?site=mala", "/sites", "/landers"]}


# the web page (repo folder web/): the same server answers the API and serves the page that uses it
WEB_DIR = config.REPO_DIR / "web"
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
