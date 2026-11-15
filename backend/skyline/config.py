"""Paths and constants shared by prep/ and engine/."""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
DATA_DIR = Path(os.environ.get("SKYLINE_DATA", BACKEND_DIR / "data")).resolve()
RAW_DIR = DATA_DIR / "raw"
DERIVED_DIR = DATA_DIR / "derived"
DB_PATH = DATA_DIR / "skyline.db"
MANIFEST_PATH = BACKEND_DIR / "manifest.json"
# small files shipped with the code: the coarse global LOLA grid (1/4 deg, polar caps 1/8 deg by 1/4 deg, metres, int16)
# and the Moon mosaic used by the web page's globe. Both were derived from the LLNL ssa-data-lunar package.
ASSETS_DIR = Path(__file__).resolve().parent / "assets"

API_VERSION = "0.1.0"
# Bump when precompute logic or the site list changes: the stamp then no longer matches and precompute reruns.
CODE_VERSION = "4"

# Geometry (km), as in main's src/engine.js
RM = 1737.4
RSUN = 695700.0
REARTH = 6378.137
AU_KM = 149597870.7

# Polar stereographic rasters (PGDA convention): sphere R in metres
R_M = 1737400.0

# Ephemeris
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_TIMEOUT_S = 10.0
HORIZONS_PAUSE_S = 1.0
PREFETCH_MONTHS = 14
USER_AGENT = "lunar-skyline-backend"

# Horizon masks
EYES_M = [0, 2, 5, 10, 20, 50, 100]
NAZ = 720
