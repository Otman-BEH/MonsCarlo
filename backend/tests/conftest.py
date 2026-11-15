import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
FIX = Path(__file__).resolve().parent / "fixtures"


def pytest_configure(config):
    config.addinivalue_line("markers", "live: needs network access to JPL Horizons (skipped by default; run with -m live)")
    config.addinivalue_line("markers", "data: needs the raw NASA files in the data directory")


def pytest_collection_modifyitems(config, items):
    if config.getoption("-m") and "live" in config.getoption("-m"):
        return
    skip = pytest.mark.skip(reason="live network test (run with -m live)")
    for it in items:
        if "live" in it.keywords:
            it.add_marker(skip)


@pytest.fixture(scope="session")
def golden():
    return json.loads((FIX / "golden.json").read_text())


@pytest.fixture(scope="session")
def table(golden):
    t = golden["table"]
    return np.array(t["a"], dtype=np.float64).reshape(-1, 6)


def num(x):
    return float(x) if not isinstance(x, str) else float(x.replace("Infinity", "inf"))


def arr(a):
    return np.array([num(v) for v in a])
