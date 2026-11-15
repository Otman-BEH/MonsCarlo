# Mons Carlo: Literature and Technical Review

Team Mons Carlo, NASA Space Apps Challenge 2026 (challenge: "Lunar Landing Site Navigator"). First compiled 14 Nov 2026,
updated 15 Nov 2026 to match how Mons Carlo works now.

This started as our background reading before we wrote any code. We've kept the literature as it was and added notes
on what we actually picked, what we changed our minds about, and why. Wherever a section has a **How Mons Carlo uses
this** note, that's the current state of the build.

Legend: **[S]** means we checked it against a source (see Sources). **[K]** means standard geometry or general domain
knowledge we didn't re-verify, so please check it before it goes on a slide.

---

## 0. The short version

1. **The whole problem comes down to two tracks and one curve per site.** For any site you need (a) Sun azimuth and
   elevation over time, (b) Earth azimuth and elevation over time, and (c) the terrain horizon elevation against
   azimuth (the "horizon mask"). Every metric in the brief (sunlit hours, time to sunset, direct-to-Earth windows, the
   power curve) compares (a) and (b) against (c). This is the "horizon method" used by Mazarico et al. (2011) and Gläser
   et al. **[S]**.
2. **The ephemeris doesn't depend on the site.** Get the Moon-fixed Sun and Earth vectors once per timestep, and every
   site's azimuth and elevation follows from a bit of vector geometry. One table serves every site and every custom
   coordinate **[K]**.
3. **The DEM never has to reach the browser for the analysis.** Horizon masks are a few thousand floats per site. The
   browser only needs small height grids if it wants to draw terrain.
4. **Programme news changes how we label things** **[S]**: Artemis III was restructured in Feb 2026 into a 2027 low
   Earth orbit docking test, and the first crewed landing is now Artemis IV, targeted for early 2028. The nine "Artemis
   III candidate regions" still exist as a published list, but we call them "Artemis candidate regions (defined for the
   original Artemis III)". Chang'e-7's Aug 2026 launch slipped to 2027. VIPER is now manifested on Blue Origin's Blue
   Moon MK1 for late 2027.
5. **At the pole, small angles are everything.** The Sun stays within about ±1.5° of the horizontal and is 0.53° wide.
   Earth is about 1.9° wide and bobs by roughly ±6.5° each month. A 0.1° horizon error or a 5 m change in mast height
   can flip the answer, so mast height has to be a first-class input.

**How Mons Carlo uses this.** Points 1 to 3 became the architecture. A Python backend (FastAPI) does every calculation
from NASA data, and a static web page asks it for numbers and draws them. Points 2 and 5 decided the details: the
ephemeris is two JPL Horizons requests per month for the whole Moon, and the Sun and Earth are each judged against the
horizon at their own height (solar array height for the Sun, antenna height for Earth). Then we went one step further
than the brief: if one ridge or a few metres can decide a mission, a single answer for a single aim point isn't enough.
That's where the Monte Carlo landing-risk analysis (and the team name) comes from (section 2.6).

---

## 1. Ephemeris and topographic data sources

### 1.1 Lunar topography

| Dataset | Coverage / resolution | Format | Use it for | Notes |
|---|---|---|---|---|
| **LOLA 5 m south pole mosaic** (PGDA product 81, Barker et al. 2021 method) | 87°S to 90°S, 5 m/pix | GeoTIFF, south polar stereographic, metres, MOON_ME (DE421). 3.3 GB height file; hillshade, slope and count maps too | Near-field horizon and 3D crops around Shackleton, de Gerlache, Connecting Ridge | Built from 97 fields of 20x20 km. Pixel-registered coordinates **[S]** |
| **LOLA 5 m site DEMs** (PGDA product 78) | 16x16 km boxes around named high-priority sites (Site01 Connecting Ridge, Site04, Site07, Site11, plus later additions) | GeoTIFF, same projection | Small files for exactly the sites people care about | About 90% of 5 m pixels are interpolated because of LOLA track spacing; uncertainty maps are included **[S]** |
| **LOLA south polar regional DEMs** (PGDA product 90, Barker et al.) | 80°S to the pole at 80 m, 60°S to the pole at 240 m | Deflate-compressed GeoTIFF with a floating-point predictor | Mid- and far-field horizon for every polar site | Same projection and reference sphere as products 78 and 81 **[S]** |
| **LOLA polar gridded LDEMs** (PDS LOLA GDR) | e.g. 75°S poleward at 240/120/60/30 m, 80°S at 20 m, 85°S at 10 m, 87.5°S at 5 m | PDS IMG (+ label) and JP2 | Far-field horizon out to 150 to 200 km | Product names like `LDEM_80S_20M`, `LDEM_75S_240M` **[K]**. Mazarico et al. (2011) used the 240 m grids reaching 75° latitude **[S]** |
| **SLDEM2015** (LOLA + Kaguya Terrain Camera, Barker et al. 2016) | ±60° latitude; 512 px/deg (about 60 m at the equator); 128 and 256 px/deg global files | PDS float IMG and JPEG-2000 | Equatorial and mid-latitude baselines (Apollo, Blue Ghost, Chang'e-6) | Typical vertical accuracy 3 to 4 m **[S]**. Not the right product for the poles |
| **Kaguya/SELENE** LALT and TC DTMs | Global laser altimetry; 10 m class stereo DTMs | PDS-like (JAXA DARTS) | Historical context | Bussey et al. (2010) and Noda et al. (2008) did the pre-LOLA illumination work on Kaguya data **[S]**. Stereo fails in polar shadow, which is why LOLA wins there **[K]** |
| **LROC NAC DTMs / SfS** | 2 to 5 m, small footprints | GeoTIFF / PDS | A showpiece close-up | Less well geodetically controlled than LOLA and hindered by shadows **[S]** |

**Practical handling tips [K]**

- Polar products share one projection: `+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1737400 +units=m`. Read the GeoTIFF tags
  rather than assuming, and watch pixel-registered vs grid-registered half-pixel offsets.
- Heights are relative to the 1737.4 km sphere. Keep everything spherical; the Moon's flattening doesn't matter here.
- Use a pyramid of resolutions per site instead of one giant raster: fine close in, coarse far out. Downsample with
  averaging, not nearest neighbour, so peaks aren't aliased away.
- Don't try to tile the 3.3 GB mosaic during a hackathon.

**How Mons Carlo uses this.** Terrain comes in four tiers, and every site says which tiers its horizon came from:

| Tier | Source | Used for |
|---|---|---|
| 5 m | PGDA product 78 site tiles (Site01, 04, 07, 11 by default; LM4, LM6, Haworth and Site23 optional) | out to the tile edge |
| 80 m | PGDA product 90, `LDEM_80S_80MPP_ADJ` | 80°S to the pole, out to 60 km |
| 240 m | PGDA product 90, `LDEM_60S_240MPP_ADJ` | 60°S to the pole, out to 330 km |
| coarse | LOLA global grid (1/4°, 1/8° by 1/4° in the polar caps), from LLNL's `ssa-data-lunar` | everywhere else, including Apollo-era and far-side sites |

We went with product 78 rather than the 3.3 GB product 81 mosaic. It covers the sites that matter for a few hundred MB,
and the default download stays around 620 MB. The regional DEMs are converted once to `.npy` and memory-mapped. We
compared horizons with and without the 5 m tiles: at most sites the horizon moves by 0.5° to 1.5°, which changes annual
sunlight by a few percentage points. At the pole itself, sitting on the wall of Shackleton, it moves by up to 2.8° and
Earth visibility drops from 29% to 18% of the year. That's a good argument for the finest terrain near the site.

We didn't use SLDEM2015. Away from the poles the horizon hardly matters (the Sun climbs high and Earth sits high), so
the coarse LOLA grid is enough there for now.

### 1.2 Celestial ephemeris

| Method | What it gives | Accuracy | Practicality | Verdict |
|---|---|---|---|---|
| **JPL Horizons API** (`ssd.jpl.nasa.gov/api/horizons.api`) | Observer tables with az/el (quantity 4), angular diameter (13), range (20), from user-defined topocentric sites on any body with a rotation model | Reference grade (DE441 class) | Text output that needs parsing; one target per request. Airless az/el columns are labelled `a-app` **[S]**. Elevation is relative to the local horizontal plane, not terrain | **Truth source** |
| **SPICE** via SpiceyPy (or WebGeocalc) | Everything; `azlcpo` returns az/el of a target for a fixed surface point **[S]** | Reference grade. Use `MOON_ME` (matches the LOLA maps), not `IAU_MOON`; NAIF says IAU_MOON is unsuitable for high-accuracy work and differs from the DE-based frame by roughly 0.005° (about 155 m on the surface) **[S]** | Needs kernels: LSK, `de440s.bsp`, `moon_pa_de440_200625.bpc`, `moon_de440_*.tf`. Offline, fast, scriptable | **Best offline engine** |
| **Skyfield** (Python) | Lunar surface observers through `PlanetaryConstants` with the NAIF lunar frame and PCK files **[K]** | Same kernels, so reference grade | A few lines of Python | Good alternative to SpiceyPy |
| **astropy** | No built-in Moon-fixed topocentric frame; the `lunarsky` add-on provides one on top of SPICE **[K]** | High | More setup than Skyfield for the same result | Only if you already use it |
| **astronomy-engine** (JS/TS, also Python/C/C#) | Sun/Moon vectors, `Libration()`, `RotationAxis()` for the Moon | Within about 1 arcminute of NOVAS; checked against JPL Horizons; no dependencies; under 120 kB minified **[S]** | Runs in the browser, instant scrubbing, any date | Good for a browser-only build |

**Accuracy against cost**

- 1 arcminute (0.017°) is small next to the Sun's 0.53° disc, so astronomy-engine is fine for visuals and for daily and
  monthly windows.
- It isn't negligible for grazing events. At the pole the Sun's elevation changes by hundredths of a degree per day, so
  a 0.02° error can move a predicted "last light" by hours **[K]**.
- Effects to include: physical and optical libration (handled by the DE-based lunar orientation), the 1.54° obliquity
  to the ecliptic **[S]**, the 18.6 year nodal cycle (automatic with real ephemerides), and topocentric parallax for
  Earth (up to about 0.26° from a 1737 km baseline, so subtract the site vector instead of using the sub-Earth point
  alone) **[K]**. Light-time and aberration subtleties are sub-arcminute, and there's no refraction.

**How Mons Carlo uses this.** Our first prototype ran astronomy-engine in the browser. Once we moved the maths to a
backend we could afford reference-grade positions everywhere, so we did:

- **JPL Horizons is the primary source.** We make one OBSERVER request per body per calendar month from a reference
  point on the lunar equator at longitude 0, asking for quantities 4 and 20. Each row rebuilds the Moon-fixed Sun or
  Earth vector exactly, and the view from any site (including Earth parallax) is a vector subtraction and a rotation
  into that site's east-north-up frame. So two requests a month cover the whole Moon, every custom point and every
  Monte Carlo cell. Months are cached in SQLite for good, and the first start pre-fetches 14 months.
- **SPICE (DE440, `MOON_ME`) is the fallback.** If Horizons can't be reached, that month comes from SPICE and is
  flagged, and a later run replaces it with Horizons data. Every response says which source served each month.
- **Validation.** SPICE DE440 against a DE421 truth file at 3,166 epochs over six sites: largest difference 0.000015°.
  Our Horizons reconstruction against SPICE: within 0.00001°. That's three orders of magnitude below anything visible
  on the page.
- Rise and set times come from an hourly search refined with 4-point Lagrange interpolation and bisection, down to a
  few seconds.

---

## 2. Physics and horizon mask algorithms

### 2.1 Horizon elevation profile

The standard approach (Mazarico et al. 2011; Gläser et al. 2014, 2018; Bryant 2009) **[S]**: for each observer, cast
rays over the DEM in N azimuths, keep the maximum elevation angle along each ray, store it, and reuse it for every
timestep. Mazarico et al. then evaluated illumination hourly over a full 18.6 year cycle from those stored horizons
**[S]**.

Implementation notes **[K]**:

- **Do it in 3D, not on the map plane.** Convert each DEM sample to body-fixed Cartesian with radius `R + h`, subtract
  the observer position (radius `R + h0 + mast`), and take the angle between that vector and the observer's local
  horizontal plane. Curvature is then exact. The closed form for central angle γ = d/R is
  `elev = atan2(r1·cos γ − r0, r1·sin γ)`.
- **Curvature matters at range.** Terrain drops by d²/(2R): about 0.7 km at 50 km, 2.9 km at 100 km, 11.5 km at 200 km.
  NASA SVS notes that mountains about 120 km away still cast shadows at the pole **[S]**.
- **No atmosphere** means no refraction and a hard-edged horizon. The smooth-sphere horizon for an observer at height h
  sits below horizontal by `dip ≈ sqrt(2h/R)`: 0.09° at 2 m, 0.19° at 10 m.
- **Sampling.** 0.5° azimuth steps (720 rays) is a good default; the solar disc is only 0.53° wide.
- **Azimuth in polar stereographic.** Local north isn't "up" on the map. Compute east/north/up vectors at the observer
  and take azimuth from those. Getting this wrong is the most common cause of rotated horizon masks.
- **Mast height sensitivity.** Barker et al. (2021) show that DEM height uncertainty feeds into horizon elevation and
  predicted illumination, and that the effect is much smaller 5 m above the surface **[S]**.

**How Mons Carlo uses this.** We cast 720 rays per site in body-fixed 3D, out to 330 km, switching to the finest
available tier at each distance (5 m, then 80 m, then 240 m, then the coarse grid). Listed polar sites are precomputed
at seven heights (0, 2, 5, 10, 20, 50 and 100 m) in both terrain modes. Custom points are cast on demand in about half a
second. The array height and the antenna height each get their own horizon, so raising the antenna mast can open an
Earth window without touching the power side. There's also a "terrain margin" setting that lifts every horizon by a
few degrees, which is how we stress a plan against terrain error.

### 2.2 Sun and Earth direction at a site

With the body's sub-point (lat_s, lon_s) and the site (lat, lon) **[K]**:

- `sin(el) = sin(lat)·sin(lat_s) + cos(lat)·cos(lat_s)·cos(lon_s − lon)`
- azimuth from the usual `atan2` of the east and north components.

That's fine for the Sun (parallax under 0.001°). For Earth, take the Earth vector at its true distance, subtract the
site vector, then convert to az/el.

Useful magnitudes:

- Sun: elevation at latitude φ never goes above roughly (90° − |φ|) + 1.54°. At 89.5°S that's about 2°. Azimuth
  advances about 12.2° per Earth day, so the Sun takes about an hour to move its own width **[K]**.
- Seasons: the lunar lighting "year" is about 346.6 days because of nodal precession, so good-lighting months drift
  through the calendar. NASA's site selection white paper makes the same point **[S]**.
- Earth: stays near one spot in the sky and traces a libration box of roughly ±8° in longitude and ±6.5° in latitude
  each month **[S]**. At near-side longitude 0° and latitude φ, mean Earth elevation is about 90° − |φ|. So at 85°S
  Earth sits around 5° ± 6.5°, and at the pole around 0° ± 6.5°: it rises and sets roughly once a month, with terrain
  deciding the details. Far-side sites never see it.

**How Mons Carlo uses this.** We skip the sub-point formulas and work with full vectors throughout, which handles Earth
parallax for free. The "Why the pole?" view on the page is built on these magnitudes: it puts Apollo 11's sky next to
Shackleton rim's at the same moment.

### 2.3 Illumination metrics

- **Visible solar disc fraction.** Treat the Sun as an extended source, as Gläser et al. do **[S]**. With
  d = (el_centre − horizon(az)) / r_sun clamped to [−1, 1], the visible share of the disc is
  1 − (acos d − d·sqrt(1 − d²))/π **[K]**.
- **Power.** `P = S · η · A · cos(θ) · f_visible`, with S about 1361 W/m², varying about ±3.4% over Earth's orbit. For a
  flat horizontal panel `cos θ = sin(el)`, which is hopeless at the pole. For a vertical Sun-tracking array
  `cos θ ≈ 1` **[K]**.
- **Derived metrics** worth having per site and date: percent of time lit over a window, longest sunlit run, longest
  darkness (which sets battery size), time to the next sunset or sunrise.
- **Peaks of Eternal Light vs PSRs.** LOLA modelling found no truly permanently lit points. The best sites reach roughly
  70 to 83% average illumination at the surface, improving with height (Gläser et al. 2018 report 69.5 to 82.9% for
  their top sites) **[S]**.
- **Thermal** is out of scope for now, but low Sun and long shadows are what drive it.

**How Mons Carlo uses this.** We use exactly that disc-fraction formula against the horizon at the Sun's azimuth.
Power is array output in full Sun × visible disc fraction × (1 AU / distance)², with 90% charge efficiency. Arrays can
be Sun-tracking, horizontal, or vertical with 1 to 8 fixed faces at set directions relative to the lander heading. The
mission simulation steps a battery hour by hour through the whole mission. It's geometric on purpose: temperature,
dust, pointing limits and degradation aren't modelled, and the page says so.

### 2.4 Direct-to-Earth windows

- Earth's apparent diameter from the Moon is about 1.8° to 2.0° **[K]**.
- **DTE is available** when Earth's elevation is above horizon(az) plus a margin. Low-elevation links suffer multipath
  off the surface, so real missions add margin **[K]**.
- With three DSN complexes (and ESTRACK), some ground station always faces the Moon, so "Earth visible from the site" is
  a good first-order DTE test.
- The benchmark worth quoting: Bryant (2009, JPL), using horizon masks from Goldstone radar topography, found the best
  south pole site had about 92% multi-year solar availability but only about 51% DTE availability **[S]**. That gap
  between power and comms is the core story a tool like this should make visible.
- **Combined window** = sunlit AND Earth in view, reported as its own metric.

**How Mons Carlo uses this.** Earth contact is line of sight to Earth's centre over the antenna-height horizon. We also
compute the Moon's elevation at Goldstone, Madrid and Canberra with SPICE, so the page can say which DSN stations could
take the call right now. Missions can require a link and set a longest acceptable gap. Antenna pointing, link budgets
and station scheduling aren't modelled yet. Our numbers land close to Bryant's: our polar sites typically show 75 to
88% sunlight against 50 to 57% Earth visibility over a year.

### 2.5 Event finding

Sample every 10 to 60 minutes, look for sign changes of `el − horizon(az) ± radius`, and refine by bisection to the
minute. Report the time left until sunset or Earthset from the selected instant, and flag events with under about
0.1° of margin as low confidence **[K]**.

**How Mons Carlo uses this.** Hourly sampling, then interpolation and bisection down to seconds. The catch is that a
visibility window shorter than an hour can be missed. That's listed as a known limit.

### 2.6 Uncertainty and landing risk

Nothing in the brief asks for this, but sections 0.5 and 2.1 make it unavoidable. If 0.1° of horizon or a few hundred
metres of position can change the answer, then a lander that touches down somewhere inside its landing ellipse, at a
slightly different time, with hardware that's a few percent off nominal, needs a probability rather than a yes or no.

**How Mons Carlo does it.** The landing-risk analysis puts a grid of cells over the landing ellipse (15 × 15 by
default) and runs a batch of simulated missions in each one (48 by default), varying:

- the touchdown point (from the lander's 3-sigma landing accuracy),
- the landing time (6 h 3-sigma by default),
- terrain height error (0.15° on the horizon),
- array output, loads and battery capacity (a few percent each, with an optional "loads high, battery low together"
  link for a cold-case check),
- and, for vertical arrays, an optional random heading.

Ground steeper than the lander's slope limit counts as a failure, with slope measured over about 160 m. Every cell gets
its own horizon (a faster cast at 180 azimuths, within 0.03° of the full one on average), and all trials run together as
one vectorised simulation. The result is the chance of success with a 95% Wilson interval, a breakdown of why missions
failed, which inputs drive the risk, a map of where touchdown still works, and a better aim point when one holds up on
a separate set of random draws. The seed is in every response, so any result can be reproduced exactly.

The 95% interval only covers the finite number of simulated missions. It doesn't cover errors in the terrain data or in
the spreads themselves, which are assumptions the user can change.

---

## 3. Existing tools and gap analysis

### 3.1 The three tools named in the brief

| Tool | Strengths | Where it falls short for this use case |
|---|---|---|
| **LROC QuickMap** (ASU / Applied Coherent Technology) | Deep layer catalogue (LOLA, SLDEM slope/azimuth, polar illumination maps); "TerrainShadows" 2D/3D renders tuned for grazing light that can show the Sun and Earth on the horizon; a NAC layer shows real imagery matching the current QuickMap time **[S]** | Expert layer tree; one place and one time at a time; you get a rendered scene, not a table of windows or time to sunset; no side-by-side of sites or dates |
| **NASA Moon Trek** (JPL Solar System Treks) | 2D/3D globe; distance, elevation profile, sun angle; ray-traced lighting over user-set areas and date ranges; line-of-sight analysis for comms; slope and hazard tools **[S]** | Analyses run as jobs per area and time range; outputs are map products; comparing scenarios is manual; heavy for casual users |
| **JPL Horizons** | Authoritative Sun and Earth az/el for any lunar site and time; fully scriptable **[S]** | Text tables; body/site/quantity codes; one target per query; no terrain, so "elevation > 0" doesn't mean "visible"; no visual output |

### 3.2 Other simulators and datasets

- **PGDA Lunar Polar Illumination (Mazarico et al. 2011)**: average illumination, PSR and sky/Earth visibility maps for
  both poles at 240 m **[S]**.
- **LROC WAC polar illumination maps (Speyerer and Robinson 2013)**: empirical percent-illumination maps at 100 m from
  88° to the pole, from about 3,800 south pole images over one lunar year **[S]**. A useful independent check.
- **Gläser et al. (2014, 2018)**: 20 m LOLA DTMs, hourly simulation 2017 to 2037, Sun as an extended source; Connecting
  Ridge and Shackleton rim come out as the top sites **[S]**.
- **NASA SVS 4930 and 5027**: rendered south pole illumination, 2023 to 2030 and 2025 to 2028 at two-hour steps to 80°S
  **[S]**.
- **Bryant (2009), JPL IPN Progress Report 42-176**: horizon masks plus Sun and Earth statistics; the closest published
  match to our set of metrics **[S]**.
- **NASA-AMMOS MMGIS "Shade" tool**: open source, SPICE-backed Sun/Earth/orbiter az/el with terrain shading; only
  on-screen terrain is considered **[S]**.
- **Solshade (JOSS 2026)**: open source Python, DEM horizon maps plus Skyfield solar geometry, written for Earth
  **[S]**. A readable reference implementation of the horizon method.
- Moon to Mars Architecture white paper "Lunar Site Selection" (2023): a plain-language statement of the lighting and
  DTE constraints **[S]**.

### 3.3 The gaps, and where Mons Carlo stands on each

| Gap in existing tools | Mons Carlo now |
|---|---|
| **No scenario matrix.** Existing tools answer "what is it like here, now", while planners ask "which of these sites on these dates works". | Compare view: one horizon panorama per site at the same instant, side-by-side statistics, and a twelve-month landing-date calendar across up to 8 sites. |
| **Sun and Earth never share one chart against the horizon.** | The horizon panorama shows the terrain, the Sun and Earth at true size, and their paths. |
| **No event-oriented readouts.** | Time to sunset and Earthset, longest dark period, longest radio gap, and combined sunlit-and-Earth hours on every view. |
| **Schedule slips are awkward.** | Mission Rescue: apply a slip and get a ranked list of sites and landing times that still work. |
| **"Above zero" vs "above terrain" isn't distinguished.** | Every number is against the terrain horizon, and clearance above it is shown in degrees. |
| **Hardware height is hidden.** | Separate mast heights for the array and the antenna, adjustable on every view. |
| **No progressive disclosure.** | An "at a glance" strip with plain answers, a guided tour, and a "Why the pole?" view for the public, with the method and numbers one click away. |
| **Uncertainty is invisible.** | Terrain margin on every mission verdict, a stress test with injected faults, and the Monte Carlo landing risk with a confidence interval. |

---

## 4. Candidate landing sites and reference missions

Coordinates are planetocentric, east-positive, MOON_ME. "Approx." rows are region or feature positions good to a few
tenths of a degree. Pick the exact pixel from the DEM before computing a horizon, because at these latitudes a few
hundred metres changes the result.

| # | Site | Lat, Lon | Status | Why it's in the list |
|---|---|---|---|---|
| 1 | **Shackleton rim / "peak near Shackleton"** (Chang'e-7 target) | approx. 88.8°S, 123.4°E | Planned; preferred CE-7 site, final choice after orbit insertion; launch slipped to 2027 **[S]** | Sunlit rim beside a 21 km wide, 4 km deep PSR; the classic high-sunlight, marginal-Earth case |
| 2 | **Shackleton to de Gerlache Connecting Ridge** (Mazarico "Site 1") | approx. 89.45°S, 222.7°E **[K]** | Blue Moon MK1 "Endurance" pathfinder target; earlier IM-2 plan **[S]** | Among the highest average illumination at the south pole; longest continuous sunlit periods of the Barker et al. sites **[S]** |
| 3 | **de Gerlache Rim 2** | approx. 88.7°S, 292°E **[K]** | Artemis candidate region **[S]** | High illumination with different Earth geometry from site 2; a good "small move, big change" pair |
| 4 | **Malapert Massif** | approx. 86.0°S, 0°E **[K]** | Artemis candidate region **[S]** | Tall near-side massif; the standard example of excellent Earth visibility with good sunlight |
| 5 | **Mons Mouton (IM-2 Athena)** | 84.7906°S, 29.1957°E **[S]** | Landed 6 Mar 2025, came to rest on its side **[S]** | Southernmost landing to date; inside an Artemis candidate region **[S]**. VIPER's original area lies on Mons Mouton west of Nobile (roughly 85.4°S, 31.6°E **[K]**); VIPER now flies on Blue Moon MK1, late 2027, site to be confirmed **[S]** |
| 6 | **Malapert A (IM-1 Odysseus)** | 80.13°S, 1.44°E, +2579 m **[S]** | Landed 22 Feb 2024 **[S]** | About 10° from the pole: the Sun a few degrees higher, Earth about 10° up. Shows how fast conditions ease away from the pole |
| 7 | **Statio Shiv Shakti (Chandrayaan-3)** | 69.373°S, 32.319°E **[S]** | Landed 23 Aug 2023 **[S]** | High-latitude but not polar: one clean 14 day sunlit span, Earth always visible. The mission ended at local sunset, which the timeline should reproduce |
| 8 | **Apollo basin south (Chang'e-6)** | 41.6385°S, 153.9852°W (206.0148°E) **[S]** | Landed 1 Jun 2024, sample return **[S]** | Far side: plenty of Sun, no DTE ever, relay required (Queqiao-2). The cleanest demonstration of the comms side |
| 9 | **Mare Crisium (Blue Ghost Mission 1)** | 18.562°N, 61.810°E **[S]** | Landed 2 Mar 2025 **[S]** | Recent CLPS mid-latitude baseline; a full lunar day of operations; Earth high and nearly fixed |
| 10 | **Mare Tranquillitatis (Apollo 11)** | 0.674°N, 23.473°E **[K]** | 1969 | The public's mental model of the Moon: the Sun climbs overhead, Earth parked high in the sky, horizon irrelevant |

The nine Artemis candidate regions (Oct 2024 list, defined for the original Artemis III) are: Peak near Cabeus B,
Haworth, Malapert Massif, Mons Mouton Plateau, Mons Mouton, Nobile Rim 1, Nobile Rim 2, de Gerlache Rim 2 and Slater
Plain **[S]**. NASA's own reasoning says more Earth visibility is preferred if a DTE architecture is used, and that
several regions are kept to protect launch availability **[S]**. Both are arguments for comparing across sites and
dates.

**How Mons Carlo uses this.** The catalogue has 16 sites: the nine polar sites (Shackleton rim, Connecting ridge,
de Gerlache rim, the Chang'e 7 target, Malapert Massif, the VIPER site, IM-2, IM-1 and the pole itself), four planned
missions (IM-3 at Reiner Gamma, Blue Ghost Missions 2 and 3, and ispace Mission 3 at Schrödinger basin) and three past
landings (Apollo 11, Chang'e 4 and Chandrayaan-3). Shackleton rim, Connecting
ridge, de Gerlache rim and Malapert Massif are placed on the highest ground within 600 m of their published coordinates,
because that's where anyone would actually land. Any other point can be entered as custom coordinates. Coordinates for
planned missions are published targets and should be checked before anyone relies on a result.

---

## 5. UI/UX and visualisation

### 5.1 Views worth having

1. **Horizon panorama.** Azimuth unrolled along x (0 to 360°), elevation on y (about −5° to +10° for polar sites,
   auto-scaled elsewhere). Filled terrain silhouette, the Sun at its true 0.53° and Earth at its true 1.9°, faint paths
   for the coming days, and a time scrubber. It reads instantly for the public and is still exact for engineers.
2. **Availability timeline.** Stacked bars for Sun, Earth and both, zoomable from one lunar day to a year.
3. **Scenario comparison.** Sites against landing dates, one headline number per cell.
4. **Year view.** Makes seasons and the 346 day lighting year visible at a glance.
5. **Map and 3D context.** A south polar map with site pins, plus a terrain view lit from the true Sun direction.
6. **Sensitivity controls.** Mast height and small position nudges, to show why small changes matter.

### 5.2 Progressive disclosure

- **Anyone, five seconds.** Pick a site and a date, get one plain sentence and a simple status for Power, Comms and
  Both.
- **Student or educator.** The panorama with a play button, a one-click contrast with Apollo 11, and short "why?"
  explanations.
- **Planner.** Comparison, timelines, date slips, margins and mast settings.
- **Engineer.** Raw numbers, event times in UTC, CSV export and the ephemeris source.

Conventions: UTC everywhere; east-positive longitudes; state the frame and DEM; put the scenario in the URL so it can be
shared; never use colour alone to tell the Sun from Earth.

**How Mons Carlo uses this.** The page has five views: Site, Plan a mission, Compare, Why the pole?, and Method. On top
of what we planned above:

- an "at a glance" strip on every working view with the challenge's core answers (Sun and Earth above the terrain, time
  to sunset and Earthset, solar power now, and whether a direct link is possible and through which DSN stations);
- a first-person surface view from mast height on the real LOLA terrain, with cast shadows and the Sun and Earth (with
  its phase) at true size;
- a 3D globe of the whole Moon lit from the true Sun direction, and a live south-pole shadow map;
- **Mission planning**: a battery simulation with a verdict (meets, marginal, fails) and the reason, a design lab that
  works back from the mission to the lightest array and battery that pass, a stress test with injected faults and an
  optional safe mode, Mission Rescue for schedule slips, and the Monte Carlo landing risk;
- a guided tour, share links that capture the whole scenario, and CSV and Markdown export.

The page only asks the server for the expensive results when they're on screen, never while playing or dragging, and
cancels requests that have gone stale.

### 5.3 Validation, planned and done

What we planned to check:

- Site and time pairs against Horizons az/el.
- Chandrayaan-3: predicted sunset about 12 days after the 23 Aug 2023 landing **[S]**.
- IM-1: local sunset about a week after the 22 Feb 2024 landing **[S]**.
- Connecting Ridge: annual illumination in the range published by Mazarico, Gläser and Barker.
- Chang'e-6: DTE has to be 0% for all time.

What's in the test suite now:

| Check | Result |
|---|---|
| SPICE DE440 vs a DE421 truth file (3,166 epochs, 6 sites) | largest difference 0.000015° |
| Our Horizons reconstruction vs SPICE (December 2026, 4 sites) | largest difference 0.000006° |
| Backend vs our original in-browser engine: sky geometry, 48 mission cases, random numbers, design lab, Monte Carlo cells | identical, or equal to float32 rounding |
| Site horizons in 80 m mode vs the original precomputed profiles (2 to 10 m masts) | within 0.05° |
| DSN Moon elevation vs Astronomy Engine | within 0.06° above 15° elevation |

The annual numbers for our polar sites (75 to 88% sunlight at the rim and ridge sites) fall inside the published ranges
in section 2.3. The mission-history checks (Chandrayaan-3, IM-1, Chang'e-6) are next on the list to turn into automated
tests.

### 5.4 Where it could go next

- Several faults at once, scheduled activities, and a planner that picks recovery actions.
- Hazard-scale landing safety from slope, roughness and boulders in the 5 m LOLA maps and LROC images, and LOLA's own
  height-error maps feeding the Monte Carlo.
- Relay orbiters (for example ESA's Lunar Pathfinder) as a second route to Earth, which matters most for far-side and
  crater-floor sites.
- Rover traverses that stay in sunlight and in contact.
- A thermal model, since temperature often limits a mission before power does.
- The north pole (only the matching LOLA file is needed), and later Mercury's poles.

---

## Sources

Topography and illumination
- Barker et al. (2021), Improved LOLA elevation maps for south pole landing sites, Planet. Space Sci. 203, 105119. https://doi.org/10.1016/j.pss.2020.105119
- PGDA product 78, High-Resolution LOLA Topography for Lunar South Pole Sites. https://pgda.gsfc.nasa.gov/products/78
- PGDA product 81, South Pole LOLA DEM Mosaic. https://pgda.gsfc.nasa.gov/products/81 and https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/
- PGDA product 90, LOLA south polar regional DEMs. https://pgda.gsfc.nasa.gov/products/90
- Barker et al. (2016), SLDEM2015, Icarus 273. https://doi.org/10.1016/j.icarus.2015.07.039 ; product description: https://ode.rsl.wustl.edu/moon/pagehelp/Content/Missions_Instruments/LRO/LOLA/SLDEM.htm ; data: https://imbrium.mit.edu/DATA/SLDEM2015/
- Mazarico et al. (2011), Illumination conditions of the lunar polar regions using LOLA topography, Icarus 211, 1066-1081. https://doi.org/10.1016/j.icarus.2010.10.030 ; https://ntrs.nasa.gov/citations/20120010094
- PGDA product 69, Lunar Polar Illumination. https://pgda.gsfc.nasa.gov/products/69
- Bussey et al. (2010), Illumination conditions of the south pole of the Moon derived using Kaguya topography, Icarus 208, 558-564. https://doi.org/10.1016/j.icarus.2010.03.028
- Noda et al. (2008), Illumination conditions at the lunar polar regions by KAGUYA laser altimeter, GRL 35, L24203. https://doi.org/10.1029/2008GL035692
- Speyerer and Robinson (2013), Persistently illuminated regions at the lunar poles, Icarus 222, 122-136. https://doi.org/10.1016/j.icarus.2012.10.010 ; LROC illumination maps: https://www.lroc.asu.edu/images/991 ; https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_POLE_ILL_TWI_SOUTH
- Gläser et al. (2014), Illumination conditions at the lunar south pole using high resolution DTMs from LOLA, Icarus 243, 78-90.
- Gläser et al. (2018), Illumination conditions at the lunar poles: implications for future exploration, Planet. Space Sci. 162. https://doi.org/10.1016/j.pss.2017.07.006 ; https://ntrs.nasa.gov/archive/nasa/casi.ntrs.nasa.gov/20170007365.pdf
- Bryant (2009), Lunar pole illumination and communications statistics computed from GSSR elevation data, IPN Progress Report 42-176. https://ipnpr.jpl.nasa.gov/progress_report/42-176/176C.html
- NASA SVS, Illumination at the Moon's South Pole. https://svs.gsfc.nasa.gov/4930/ ; https://svs.gsfc.nasa.gov/5027 ; Shadows near the Moon's South Pole: https://svs.gsfc.nasa.gov/4893
- NASA Moon to Mars Architecture white paper, Lunar Site Selection (2023). https://ntrs.nasa.gov/api/citations/20230016267/downloads/Lunar%20Site%20Selection.pdf
- LLNL `ssa-data-lunar` (MIT licence): LOLA-derived global grid and Moon mosaic.
- Dozier and Frew (1990), Rapid calculation of terrain parameters for radiation modeling from digital elevation data, IEEE TGRS 28(5). (Not re-checked.)

Ephemeris and frames
- JPL Horizons manual and API. https://ssd.jpl.nasa.gov/horizons/manual.html ; https://ssd-api.jpl.nasa.gov/doc/horizons.html ; airless az/el column note: https://ssd.jpl.nasa.gov/announcements/an20210929.html
- NAIF lunar frame kernel and binary PCK. https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/aareadme.txt ; https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/ ; SPICE `azlcpo`: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/MATLAB/mice/cspice_azlcpo.html
- Park et al. (2021), The JPL Planetary and Lunar Ephemerides DE440 and DE441, AJ 161, 105.
- Astronomy Engine. https://github.com/cosinekitty/astronomy
- Solshade. https://doi.org/10.21105/joss.09944

Tools
- QuickMap. https://quickmap.lroc.asu.edu/ ; feature notes: https://www.actgate.com/post/quickmap-year-2022 ; https://www.actgate.com/post/july-2024-quickmap-release
- Moon Trek. https://trek.nasa.gov/moon/ ; https://ntrs.nasa.gov/citations/20220010585 ; https://doi.org/10.5194/epsc2022-93 ; https://doi.org/10.5194/egusphere-egu23-969
- NASA-AMMOS MMGIS Shade tool. https://nasa-ammos.github.io/MMGIS/tools/shade

Sites and missions
- Artemis candidate regions. https://ntrs.nasa.gov/citations/20250011660 ; https://www.nasa.gov/?p=748006
- Artemis restructure (Feb 2026). https://www.theregister.com/2026/03/02/nasa_artemis_reshuffle/ ; https://aerospace.csis.org/artemis-rewritten-nasas-new-moon-plan-its-risks-and-whether-the-u-s-can-still-beat-china/
- IM-2. https://www.lroc.asu.edu/images/1401 ; https://en.wikipedia.org/wiki/Mons_Mouton
- IM-1. https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/
- Chandrayaan-3. https://en.wikipedia.org/wiki/Statio_Shiv_Shakti
- Chang'e-6. https://lroc.im-ldi.com/images/1374
- Chang'e-7. https://www.planetary.org/space-missions/change-7 ; delay note: https://scientificamerican.com/article/chinas-change-7-moonshot-will-seek-water-ice-at-the-lunar-south-pole
- VIPER on Blue Moon MK1. https://www.nasa.gov/?p=916870 ; https://www.geekwire.com/2025/nasa-order-blue-origin-viper-rover-moon/
- Blue Moon MK1 Endurance target. https://www.leonarddavid.com/?p=48524
- NSSDC lunar spacecraft coordinates table. https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html
