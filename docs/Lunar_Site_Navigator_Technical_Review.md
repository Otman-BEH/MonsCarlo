# Lunar Landing Site Navigator: Literature and Technical Review

NASA Space Apps 2026. Compiled 14 Nov 2026.

Legend used throughout: **[S]** = checked against a source during this review (see Sources). **[K]** = standard geometry or general domain knowledge that I did not re-verify today; sanity-check before you put it on a slide.

---

## 0. Read this first: five things that shape the build

1. **The whole problem reduces to two tracks and one curve per site.** For any site you need (a) Sun az/el vs time, (b) Earth az/el vs time, (c) the terrain horizon elevation vs azimuth (the "horizon mask"). Every metric in the brief (sunlit hours, time to sunset, DTE windows, power curve) is a comparison of (a) and (b) against (c). This is exactly the "horizon method" used by Mazarico et al. (2011) and Gläser et al. **[S]**.
2. **The ephemeris part is site-independent.** Compute the sub-solar point and sub-Earth point (selenographic lat/lon plus distance) once per timestep. Any site's az/el then follows from spherical trig in the browser. One small table serves every site and every custom coordinate **[K]**.
3. **The DEM never has to reach the browser for the core analysis.** Precompute horizon masks offline (a few hundred floats per site). Only ship a small heightmap crop if you want a 3D view.
4. **Programme news that changes how you label things** **[S]**: Artemis III was restructured in Feb 2026 into a 2027 low Earth orbit docking test; the first crewed landing is now Artemis IV, targeted for early 2028. The nine "Artemis III candidate regions" still exist as a published list, but call them "Artemis candidate regions (defined for the original Artemis III)". Chang'e-7's Aug 2026 launch slipped to 2027. VIPER is now manifested on Blue Origin's Blue Moon MK1 for late 2027.
5. **At the pole, small angles are everything.** The Sun moves within about ±1.5° of the horizontal plane and is 0.53° wide; Earth is about 1.9° wide and bobs by roughly ±6.5° each month. A 0.1° horizon error or a 5 m change in mast height changes the answer. Build mast height in as a first-class parameter.

---

## 1. Ephemeris and topographic data sources

### 1.1 Lunar topography

| Dataset | Coverage / resolution | Format | Use it for | Notes |
|---|---|---|---|---|
| **LOLA 5 m south pole mosaic** (PGDA product 81, Barker et al. 2021 method) | 87°S to 90°S, 5 m/pix | GeoTIFF, south polar stereographic, metres, MOON_ME (DE421). 3.3 GB height file; hillshade, slope and count maps also provided | Near-field horizon and 3D crops around Shackleton, de Gerlache, Connecting Ridge | Built from 97 fields of 20x20 km. Pixel-registered coordinates **[S]** |
| **LOLA 5 m site DEMs** (PGDA product 78) | 16x16 km boxes around named high-priority sites (Site01 Connecting Ridge, Site04, Site07, Site11, plus later additions) | GeoTIFF, same projection | Fast start: small files for exactly the sites judges care about | About 90% of 5 m pixels are interpolated because of LOLA track spacing; uncertainty maps are included **[S]** |
| **LOLA polar gridded LDEMs** (PDS LOLA GDR) | e.g. 75°S poleward at 240/120/60/30 m, 80°S at 20 m, 85°S at 10 m, 87.5°S at 5 m | PDS IMG (+ label) and JP2 | Far-field horizon out to 150 to 200 km; sites between 80°S and 87°S (Mons Mouton, Malapert, IM-1) | Product names like `LDEM_80S_20M`, `LDEM_75S_240M` **[K]**. Mazarico et al. (2011) used the 240 m grids reaching 75° latitude **[S]** |
| **SLDEM2015** (LOLA + Kaguya Terrain Camera, Barker et al. 2016) | Co-registered product covers ±60° latitude; 512 px/deg (about 60 m at equator); 128 and 256 px/deg global files | PDS float IMG and JPEG-2000; 512 ppd is tiled 30° x 45° | Equatorial and mid-latitude baselines (Apollo, Blue Ghost, Chang'e-6) | Typical vertical accuracy 3 to 4 m **[S]**. Not the right product for the poles |
| **Kaguya/SELENE** LALT and TC DTMs | Global laser altimetry; 10 m class stereo DTMs | PDS-like (JAXA DARTS) | Historical context only | Bussey et al. (2010) and Noda et al. (2008) did the pre-LOLA illumination work on Kaguya data **[S]**. Stereo fails in polar shadow, which is why LOLA wins there **[K]** |
| **LROC NAC DTMs / SfS** | 2 to 5 m, small footprints | GeoTIFF / PDS | Only if you want a showpiece close-up | Less well geodetically controlled than LOLA and hindered by shadows **[S]** |

**Practical handling tips [K]**

- Polar products share one projection: `+proj=stere +lat_0=-90 +lon_0=0 +k=1 +R=1737400 +units=m`. Read the GeoTIFF tags rather than assuming; watch pixel-registered vs grid-registered half-pixel offsets.
- Heights are relative to the 1737.4 km sphere. Keep everything spherical (no ellipsoid); the Moon's flattening is negligible for this purpose.
- PDS IMG files open directly in GDAL via the `.LBL` label. `gdal_translate -of COG` gives you a Cloud-Optimized GeoTIFF you can range-read with `rasterio` (server) or `geotiff.js` (browser).
- Build a three-ring pyramid per site instead of one giant raster: about 20 m within 15 km, 60 to 120 m out to 60 km, 240 m out to 200 km. `gdalwarp -tr <res> <res> -r average` for downsampling (average, not nearest, so peaks are not aliased away; consider `-r max` for a conservative horizon).
- For 3D in the browser, a 512x512 or 1024x1024 16-bit heightmap crop per site (PNG or raw Float32) is plenty for a three.js displaced plane. Do not try to tile the 3.3 GB mosaic during a hackathon.
- Custom coordinates: either (a) a tiny Python endpoint doing windowed COG reads and returning a horizon mask, or (b) restrict custom input to the region covered by a pre-downsampled 240 m polar grid loaded in a Web Worker. Option (b) has no backend to break during the demo.

### 1.2 Celestial ephemeris

| Method | What it gives | Accuracy | Performance / practicality | Verdict |
|---|---|---|---|---|
| **JPL Horizons API** (`ssd.jpl.nasa.gov/api/horizons.api`) | Observer tables with az/el (quantity 4), angular diameter (13), range (20), from user-defined topocentric sites on any body with a rotation model | Reference grade (DE441 class) | Text output that needs parsing; one target per request. Airless az/el columns are labelled `a-app` **[S]**. Elevation is relative to the local horizontal plane, not terrain. Test CORS before calling from the browser; a proxy or precompute is safer **[K]** | **Truth source for validation and for precomputed tables** |
| **SPICE** via SpiceyPy (or WebGeocalc GUI/API) | Everything; `azlcpo` returns az/el of a target for a fixed surface point **[S]** | Reference grade. Use `MOON_ME` (mean Earth, matches LOLA maps) not `IAU_MOON`; NAIF states IAU_MOON is unsuitable for high-accuracy work and differs from the DE-based ME frame by roughly 0.005° (about 155 m on the surface) **[S]** | Needs kernels: LSK, `de440s.bsp`, `moon_pa_de440_200625.bpc`, `moon_de440_*.tf`. Offline, fast, scriptable | **Best precompute engine if someone on the team knows SPICE** |
| **Skyfield** (Python) | Lunar surface observers through its `PlanetaryConstants` loader with the NAIF lunar frame and PCK files **[K]** | Same kernels, so effectively reference grade | Ten lines of Python; easiest route to a precomputed table | **Fastest route to trustworthy numbers** |
| **astropy** | Solar system positions; no built-in Moon-fixed topocentric frame. The `lunarsky` add-on provides `MoonLocation` / `LunarTopo` on top of SPICE **[K]** | High | More setup than Skyfield for the same result | Only if you already use it |
| **astronomy-engine** (JS/TS, also Python/C/C#) | Sun/Moon vectors, `Libration()` (sub-Earth libration angles), `RotationAxis()` for the Moon | Designed to stay within about 1 arcminute of NOVAS; verified against JPL Horizons; no dependencies; under 120 kB minified **[S]** | Runs entirely client-side, instant scrubbing, works for any date | **Best live engine in the browser** |

**Accuracy vs performance trade-off**

- 1 arcminute (0.017°) is small next to the Sun's 0.53° disc, so astronomy-engine is fine for visuals, daily and monthly windows, and comparisons.
- It is not negligible for grazing events. At the pole the Sun's elevation changes by hundredths of a degree per day, so a 0.02° error can move a predicted "last light" by many hours **[K]**. Show event times with an uncertainty band, and offer an "engineering" toggle that swaps to a table precomputed with SPICE/Horizons.
- Effects to include: physical plus optical libration (handled by the DE-based lunar orientation, or by `Libration()`), the 1.54° obliquity to the ecliptic **[S]**, the 18.6 year nodal cycle (automatic if you use real ephemerides), topocentric parallax for Earth (up to about 0.26° from a 1737 km baseline, so do the vector subtraction, do not use the sub-Earth point alone) **[K]**. Ignore: light-time and aberration subtleties (sub-arcminute), refraction (none).

**Recommended hybrid.** Offline: Skyfield or SpiceyPy writes hourly sub-solar and sub-Earth lat/lon/distance for, say, 2026 to 2032 (about 53k rows, well under 2 MB as Float32). Online: interpolate that table for "engineering" mode and use astronomy-engine for dates outside it. Validate three or four site/date pairs against the Horizons web app and put the residuals on a slide.

---

## 2. Physics and horizon mask algorithms

### 2.1 Horizon elevation profile

The standard approach (Mazarico et al. 2011; Gläser et al. 2014, 2018; Bryant 2009) **[S]**: for each observer, cast rays over the DEM in N azimuths, keep the maximum elevation angle along each ray, store it, and reuse it for every timestep. Mazarico et al. then evaluated illumination hourly over a full 18.6 year cycle from those stored horizons **[S]**.

Implementation notes **[K]**:

- **Do it in 3D, not on the map plane.** Convert each DEM sample to body-fixed Cartesian with radius `R + h`; subtract the observer position (radius `R + h0 + mast`); take the angle between that vector and the observer's local horizontal plane. Curvature is then exact. Equivalent closed form for central angle γ = d/R: `elev = atan2(r1·cos γ − r0, r1·sin γ)`.
- **Curvature matters at range.** Terrain drops by d²/(2R): about 0.7 km at 50 km, 2.9 km at 100 km, 11.5 km at 200 km. That sets the search radius: 150 to 200 km is enough for almost all polar sites. NASA SVS notes that mountains about 120 km away still cast shadows at the pole **[S]**.
- **No atmosphere** means no refraction correction and a hard-edged horizon. The smooth-sphere horizon for an observer at height h sits below horizontal by `dip ≈ sqrt(2h/R)`: 0.09° at 2 m, 0.19° at 10 m. Distance to that horizon is only about 2.6 km at 2 m eye height.
- **Sampling.** 0.5° azimuth steps (720 rays) is a good default; go to 0.25° near the Sun's seasonal track if you can, since the solar disc is only 0.53° wide. Step along each ray at the local DEM pixel size, switching rings of the pyramid with distance. Use bilinear interpolation.
- **Azimuth in polar stereographic.** Local north is not "up" on the map. Compute east/north/up unit vectors at the observer in Cartesian and derive azimuth from them. This is the most common source of rotated horizon masks.
- **Cost.** 720 rays x about 2,000 steps is roughly 1.5 million samples per site: milliseconds in NumPy, fine in a Web Worker. Classic reference for fast horizon computation over whole grids is Dozier and Frew (1990), not needed for per-site work.
- **Mast height sensitivity.** Barker et al. (2021) show that DEM height uncertainty propagates into horizon elevation and predicted illumination, and that the effect is much reduced 5 m above the surface **[S]**. Expose mast height as a slider (0, 2, 5, 10 m) and recompute.

### 2.2 Sun and Earth direction at a site

With sub-point (lat_s, lon_s) of the body and site (lat, lon) **[K]**:

- `sin(el) = sin(lat)·sin(lat_s) + cos(lat)·cos(lat_s)·cos(lon_s − lon)`
- azimuth from the usual `atan2` of the east and north components.

Use this directly for the Sun (parallax under 0.001°). For Earth, form the Earth vector at its true distance, subtract the site vector, then convert to az/el.

Useful magnitudes:

- Sun: elevation at latitude φ never exceeds roughly (90° − |φ|) + 1.54°. At 89.5°S that is about 2°. Azimuth advances about 12.2° per Earth day (360° per 29.53 day synodic month), so the Sun takes about an hour to move its own width **[K]**.
- Seasons: the lunar "year" for lighting is about 346.6 days (the nodal precession shortens it), so good-lighting months drift through the Earth calendar. NASA's site selection white paper makes the same point **[S]**.
- Earth: stays near one sky position and traces a libration box of roughly ±8° in longitude and ±6.5° in latitude each month **[S]**. At near-side longitude 0° and latitude φ, mean Earth elevation is about 90° − |φ|. So at 85°S Earth is around 5° ± 6.5°, at the pole 0° ± 6.5°: Earth rises and sets roughly once per month, with terrain deciding the details. Far-side sites never see it.

### 2.3 Illumination metrics

- **Visible solar disc fraction.** Treat the Sun as an extended source, as Gläser et al. do **[S]**. Simple version **[K]**: with x = (el_centre − horizon(az)) / r_sun clamped to [−1, 1], fraction = 0.5 + (x·sqrt(1 − x²) + asin x)/π. Better: integrate chord by chord across the disc using the horizon samples under it.
- **Power.** `P = S · η · A · cos(θ) · f_visible`, S about 1361 W/m² (varies about ±3.4% over Earth's orbit). θ is the incidence angle on the array normal: for a flat horizontal panel `cos θ = sin(el)`, which is hopeless at the pole; for a vertical Sun-tracking array `cos θ ≈ cos(el) ≈ 1`. Let the user choose array type; it is one of the clearest "why the pole is different" teaching moments **[K]**.
- **Derived metrics** worth computing per site/date: percent time illuminated over a window; longest continuous sunlit period; longest darkness (sets battery sizing); time to next sunset/sunrise; mean and minimum solar elevation above local horizon.
- **Peaks of Eternal Light vs PSRs.** LOLA modelling found no truly permanently lit points; the best sites reach roughly 70 to 83% average illumination at the surface, improving with height (Gläser et al. 2018 report 69.5 to 82.9% for their top sites) **[S]**. PSRs are pixels whose horizon is never cleared by any part of the Sun over the 18.6 year cycle; PGDA and LROC publish ready-made maps (see 3.2) so you can overlay rather than compute.
- **Thermal** is out of scope, but note for judges that low Sun plus long shadows drives it.

### 2.4 Direct-to-Earth windows

- Earth's apparent diameter from the Moon is about 1.8° to 2.0° **[K]**. Define three states: full disc above terrain, centre above terrain, any limb above terrain. Planners usually want the first plus margin.
- **DTE available** when Earth elevation exceeds horizon(az) + user margin. Offer margin presets (0°, 2°, 5°); low-elevation links suffer multipath off the surface, so real missions add margin **[K]**.
- With three DSN complexes (and ESTRACK) some ground station always faces the Moon, so "Earth visible from site" is a good first-order DTE criterion. Per-station visibility is a nice-to-have.
- Benchmark to quote: Bryant (2009, JPL), using horizon masks from Goldstone radar topography, found the best south pole site had about 92% multi-year solar availability but only about 51% DTE availability **[S]**. That gap between power and comms is the core story your tool should make visible.
- **Combined window** = sunlit AND DTE. Report it as its own metric and its own timeline bar.

### 2.5 Event finding

Sample at 10 to 60 min, detect sign changes of `el − horizon(az) ± radius`, refine by bisection to the minute. Report "time remaining until sunset / Earthset" from the selected instant, and flag events whose margin is under about 0.1° as low confidence **[K]**.

---

## 3. Existing tools and gap analysis

### 3.1 The three tools named in the brief

| Tool | Strengths | UX bottlenecks for this use case |
|---|---|---|
| **LROC QuickMap** (ASU / Applied Coherent Technology) | Deep layer catalogue (LOLA, SLDEM slope/azimuth, polar illumination maps); "TerrainShadows" (QTS) 2D/3D renders synthetic lighting tuned for grazing illumination and can show Sun and Earth on the horizon; a NAC layer shows real imagery matching the current QuickMap UTC time **[S]** | Expert layer tree; one place and one time at a time; you get a rendered scene, not a table of windows or time-to-sunset; no side-by-side of sites or dates |
| **NASA Moon Trek** (JPL Solar System Treks) | 2D/3D globe; distance, elevation profile, sun angle calculation; ray-traced lighting analysis over user-set areas and date ranges; line-of-sight analysis for comms; slope and hazard tools **[S]** | Analyses are run as jobs per area/time range; outputs are map products; comparison across scenarios is manual; heavy for casual users |
| **JPL Horizons** | Authoritative Sun/Earth az/el for any lunar site and time; fully scriptable **[S]** | Text tables; body/site/quantity codes; one target per query; no terrain, so "elevation > 0" is not "visible"; no visual output |

### 3.2 Other simulators and datasets

- **PGDA Lunar Polar Illumination (Mazarico et al. 2011)**: average illumination, PSR and sky/Earth visibility maps for both poles at 240 m, polar stereographic **[S]**. Good ready-made overlays.
- **LROC WAC polar illumination maps (Speyerer and Robinson 2013)**: empirical percent-illumination maps at 100 m from 88° to the pole, from about 3,800 south pole images over one lunar year, plus a year-long movie **[S]**. Useful as an independent check on your model.
- **Gläser et al. (2014, 2018)**: 20 m LOLA DTMs, hourly simulation 2017 to 2037, Sun as extended source; Connecting Ridge and Shackleton rim identified as top sites **[S]**.
- **NASA SVS 4930 and 5027**: rendered south pole illumination, 2023 to 2030 and 2025 to 2028 at two-hour steps to 80°S **[S]**. Good for visual validation and for the pitch.
- **Bryant (2009), JPL IPN Progress Report 42-176**: horizon masks plus Sun and Earth statistics; closest published analogue of your metric set **[S]**.
- **NASA-AMMOS MMGIS "Shade" tool**: open source, SPICE-backed az/el of Sun/Earth/orbiters with terrain shading; documented limitation that only on-screen terrain is considered **[S]**. Worth reading for interface ideas.
- **Solshade (JOSS 2026)**: open source Python, DEM horizon maps plus Skyfield solar geometry, written for Earth **[S]**. Readable reference implementation of the horizon method.
- Moon to Mars Architecture white paper "Lunar Site Selection" (2023): plain-language statement of lighting and DTE constraints **[S]**.

### 3.3 Gaps your tool should close

1. **No scenario matrix.** Existing tools answer "what is it like here, now". Planners ask "which of these N sites on these M dates works". Sites x dates grid with one score per cell is the missing artefact.
2. **Sun and Earth are never on one chart against the horizon.** A single sky plot with both tracks and the mask is absent from all three.
3. **No event-oriented readouts.** Time to sunset, time to Earthset, longest sunlit run, longest outage, combined sunlit-and-DTE hours are left for the user to derive.
4. **Schedule slip is awkward.** "What if we land 14 or 29 days later?" needs a date sweep with deltas, not a new job.
5. **"Elevation above zero" vs "above terrain" is not distinguished** in Horizons, and not quantified in the map tools.
6. **Hardware height is hidden.** No quick way to see how a 2 m vs 10 m mast changes windows.
7. **No progressive disclosure.** Tools open in expert mode; educators bounce off.
8. **Uncertainty is invisible.** Grazing events are presented with false precision.

---

## 4. Candidate landing sites and reference missions

Coordinates are planetocentric, east-positive, MOON_ME. "Approx." rows are region or feature positions good to a few tenths of a degree: pick the exact pixel (and its elevation) from the DEM or QuickMap before computing a horizon, because at these latitudes a few hundred metres changes the result.

| # | Site | Lat, Lon | Status | Why it is in the list |
|---|---|---|---|---|
| 1 | **Shackleton rim / "peak near Shackleton"** (Chang'e-7 target) | approx. 88.8°S, 123.4°E | Planned; preferred CE-7 site, final choice after orbit insertion; launch slipped to 2027 **[S]** | Sunlit rim beside a 21 km wide, 4 km deep PSR; classic high-illumination, marginal-Earth case |
| 2 | **Shackleton to de Gerlache Connecting Ridge** (Mazarico "Site 1") | approx. 89.45°S, 222.7°E **[K]** | Blue Moon MK1 "Endurance" pathfinder target; earlier IM-2 plan **[S]** | Among the highest average illumination at the south pole; longest continuous sunlit periods of the Barker et al. sites **[S]** |
| 3 | **de Gerlache Rim 2** | approx. 88.7°S, 292°E **[K]** | Artemis candidate region **[S]** | High illumination with different Earth geometry from site 2; good "small move, big change" pair |
| 4 | **Malapert Massif** | approx. 86.0°S, 0°E **[K]** | Artemis candidate region **[S]** | Tall near-side massif; the standard example of excellent Earth visibility with good sunlight |
| 5 | **Mons Mouton (IM-2 Athena)** | 84.7906°S, 29.1957°E **[S]** | Landed 6 Mar 2025, came to rest on its side **[S]** | Southernmost landing to date; inside an Artemis candidate region; flat-topped 6 km high plateau **[S]**. VIPER's originally selected area lies on Mons Mouton west of Nobile (roughly 85.4°S, 31.6°E **[K]**); VIPER now flies on Blue Moon MK1, late 2027, exact site to be confirmed **[S]** |
| 6 | **Malapert A (IM-1 Odysseus)** | 80.13°S, 1.44°E, +2579 m **[S]** | Landed 22 Feb 2024 **[S]** | About 10° from the pole: Sun a few degrees higher, Earth about 10° up. Shows how fast conditions ease away from the pole |
| 7 | **Statio Shiv Shakti (Chandrayaan-3)** | 69.373°S, 32.319°E **[S]** | Landed 23 Aug 2023 **[S]** | High-latitude but not polar: one clean 14 day sunlit span, Earth always visible. Mission ended at local sunset, which your timeline should reproduce |
| 8 | **Apollo basin south (Chang'e-6)** | 41.6385°S, 153.9852°W (206.0148°E) **[S]** | Landed 1 Jun 2024, sample return **[S]** | Far side: plenty of Sun, zero DTE ever, relay mandatory (Queqiao-2). The cleanest demonstration of the comms axis |
| 9 | **Mare Crisium (Blue Ghost Mission 1)** | 18.562°N, 61.810°E **[S]** | Landed 2 Mar 2025 **[S]** | Recent CLPS mid-latitude baseline; full lunar day of operations; Earth high and nearly fixed |
| 10 | **Mare Tranquillitatis (Apollo 11)** | 0.674°N, 23.473°E **[K]** | 1969 | The public's mental model of "the Moon": Sun climbs overhead, Earth parked high in the sky, horizon mask irrelevant |

The nine Artemis candidate regions (Oct 2024 list, defined for the original Artemis III) are: Peak near Cabeus B, Haworth, Malapert Massif, Mons Mouton Plateau, Mons Mouton, Nobile Rim 1, Nobile Rim 2, de Gerlache Rim 2, Slater Plain **[S]**. NASA's own rationale mentions that greater Earth visibility is preferred if a DTE architecture is used, and that several regions are kept to protect launch availability **[S]**: both are arguments for a compare-across-sites-and-dates tool. QuickMap carries these regions as an overlay if you want polygons.

Suggested demo pairings: (2) vs (3) for "a few km matters"; (2) on two dates half a lunar year apart for "date matters"; (4) vs (1) for the power vs comms trade; (8) and (10) as bookends.

---

## 5. UI/UX and visualisation

### 5.1 Views that carry the analysis

1. **Horizon panorama (hero view).** Unrolled azimuth (x, 0 to 360°) vs elevation (y, about −5° to +10° for polar sites, auto-scaled for others). Filled terrain silhouette; Sun drawn at true 0.53° size, Earth at true 1.9° size; faint track for the next 30 days; a time scrubber moves both. This reads instantly for the public and is quantitatively exact for engineers. For polar sites it beats a full sky dome, because everything happens in a 10° strip.
2. **Polar sky plot** as an alternate for mid and low latitude sites, where the Sun crosses the whole sky.
3. **Availability timeline (Gantt).** Three stacked bars per scenario: Sun (colour by visible disc fraction), Earth/DTE, combined. One lunar day by default, zoomable to a year. Cursor shows "sunset in 3 d 4 h, Earthset in 11 h".
4. **Scenario comparison matrix.** Rows are sites, columns are landing dates (or date offsets: +0, +14, +29 days). Cell shows a small three-bar sparkline plus one headline number (combined hours in the first 14 days, or longest outage). Click a cell to load it into the hero view. This is the feature none of the existing tools has.
5. **Year heatmap.** Day of year (x) by hour or by lunar-day phase (y), colour for sunlit/DTE/both. Makes seasons and the 346 day lighting year visible at a glance.
6. **Map and 3D context.** South polar stereographic map with site pins and an average-illumination underlay; optional three.js terrain crop with a directional light at the true Sun vector. Treat real-time ray-traced shadows as a stretch goal: it is the most expensive item and adds the least decision value.
7. **Sensitivity strip.** Mast height slider and a "nudge 500 m" control that re-evaluate the headline metrics, to show why small changes matter.

### 5.2 Progressive disclosure

- **Level 0 (anyone, 5 seconds).** Pick a site, pick a date. One sentence in plain language: "Sun is up for the next 6 days. Earth is hidden behind the ridge for the next 31 hours." Traffic-light chips for Power, Comms, Both.
- **Level 1 (student/educator).** Hero panorama with scrubber and play button; "compare with Apollo 11" one-click contrast; short "why?" tooltips (Sun never climbs because the Moon's tilt is only 1.5°; Earth wobbles because of libration).
- **Level 2 (planner).** Comparison matrix, timelines, date-slip control, margin and mast settings.
- **Level 3 (engineer).** Numeric panel: Sun/Earth az and el, elevation above local horizon, visible disc fraction, incidence angle, range, sub-solar and sub-Earth points, event times in UTC with uncertainty; CSV/JSON export; ephemeris source toggle; link that opens the same site in QuickMap.

Conventions: UTC everywhere with an optional "days since landing" axis; east-positive longitudes with a 0 to 360 / ±180 toggle; state the frame (MOON_ME) and DEM in a footer; encode state in the URL so a scenario set can be shared; never use colour alone for Sun vs Earth (use shape and label as well); put the confidence flag next to any grazing event.

### 5.3 Suggested minimum build and stretch order

1. Offline script: horizon masks for the 10 sites (start with the PGDA site GeoTIFFs and one 240 m polar grid), plus the ephemeris table. Validate against Horizons.
2. Browser: az/el from sub-points, mask comparison, event finder.
3. Hero panorama plus timeline for one site.
4. Comparison matrix and date slip.
5. Level 0 summary sentences and the Apollo contrast.
6. Stretch: custom coordinates, mast slider, 3D terrain, year heatmap.

### 5.4 Validation checklist for the pitch

- Three site/time pairs vs Horizons az/el (expect agreement within a few hundredths of a degree with SPICE-derived tables, within about an arcminute with astronomy-engine).
- Chandrayaan-3: predicted sunset should fall about 12 days after the 23 Aug 2023 landing **[S]**.
- IM-1: local sunset should fall about a week after the 22 Feb 2024 landing **[S]**.
- Connecting Ridge: annual illumination percentage should land in the range published by Mazarico/Gläser/Barker.
- Chang'e-6: DTE must be 0% for all time.

---

## Sources

Topography and illumination
- Barker et al. (2021), Improved LOLA elevation maps for south pole landing sites, Planet. Space Sci. 203, 105119. https://doi.org/10.1016/j.pss.2020.105119
- PGDA product 78, High-Resolution LOLA Topography for Lunar South Pole Sites. https://pgda.gsfc.nasa.gov/products/78
- PGDA product 81, South Pole LOLA DEM Mosaic. https://pgda.gsfc.nasa.gov/products/81 and https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/
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
- Dozier and Frew (1990), Rapid calculation of terrain parameters for radiation modeling from digital elevation data, IEEE TGRS 28(5). (Not re-checked today.)

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
