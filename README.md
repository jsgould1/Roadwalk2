# Roadwalk2

Memory-safe rebuild of the RoadWalk field pavement-inspection tool (AECOM / NPS
parking & roadway inspections). Single-page app with a clean import → library →
map/SLD workflow. Runs on-device (nothing leaves the machine).

## Run
Serve the folder over HTTP (ES modules + `fetch` need a server, not `file://`):

```
python -m http.server 5510
```

Then open http://localhost:5510.

## Structure
- `index.html` — the app (harvested from the RoadWalk June-1 donor; kept its look)
- `lib/` — vendored, proxy-safe: Leaflet (+rotate), proj4, shpjs, JSZip
- `modules/` — Roadwalk2 feature modules (separate files, talk to the app via
  `window._RW` hooks):
  - `park-import.js` — SHP/KMZ/zip + folder import, reproject, road-segment merge,
    RIP/FMSS + scope auto-assign
  - `library.js` — Project → Sections library (open one at a time, edits preserved)
  - `route-tools.js` — route list filter/sort + In-Scope toggle
  - `aecom-toggle.js` — NPS ⇄ AECOM geometry overlay
  - `scope-assign.js` — in-scope route assignment (confirm) panel
- `tools/` — one-time data prep (Python + pyogrio/pdfplumber/openpyxl):
  - `convert_gdb.py` — Esri File Geodatabase → per-layer shapefiles
  - `build_routeids.py` — NPS RIP RouteID PDFs → `route_ids.json`
  - `build_scope.py` — AECOM scope workbook → `scope.json`

## Data (not committed)
`data/` holds NPS/AECOM project data (park shapefiles, RIP reports, scope tables)
and is git-ignored per AECOM data-handling policy. Regenerate it locally with the
scripts in `tools/`. The app loads `data/_rip/route_ids.json` and
`data/_rip/scope.json` at runtime if present.
