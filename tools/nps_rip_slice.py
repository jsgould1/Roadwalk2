#!/usr/bin/env python3
"""
nps_rip_slice.py -- slice the NPS RIP Cycle 6 geodatabase into per-park
bundles that Roadwalk2 can open offline.

The source .gdb is ~241 MB covering every NPS park at once; no browser can
read OpenFileGDB directly. This produces one compact JSON per park plus a
small index, so File > New > "From RIP Cycle 6" can list parks without
shipping the geodatabase.

  python nps_rip_slice.py --gdb "...\\NPS_C6.gdb" --out ..\\data\\rip
  python nps_rip_slice.py --gdb "..." --out ... --parks MORR,SHEN --gzip

Layers used
  AllRIPRoutes         road centerlines, one per route      -> routes
  Area_Conditions      parking polygons (richer than
                       AllRIPAreas: adds Status,
                       PAVEMENT_TREATMENT, CURB_*, API/FCI) -> lots
  Route_Conditions_20th 0.02 mi (105.6 ft) condition
                       segments -- the AECOM review interval -> segments

Route_Conditions_10th is deliberately skipped: it is 0.1 mi and therefore
redundant once the 0.02 mi layer is present.

Note on geometry: the source routes are Measured MultiLineStrings whose M
values carry the milepost, but GDAL's OpenFileGDB driver drops M. Segment
position therefore CANNOT be re-derived by interpolating BEG_MP/END_MP along
the parent centerline -- measured error was a median of 105 m on SHEN against
a 32 m segment length. So segment geometry is shipped, trimmed instead:
coordinates rounded to ~0.1 m and attributes limited to what actually varies
per interval.

Requires: pip install pyogrio shapely
"""

import argparse, collections, gzip, json, math, os, sys, warnings

warnings.filterwarnings("ignore")

try:
    import numpy as np
    from pyogrio.raw import read as ogr_read
    from pyogrio import list_layers
    from shapely import from_wkb
except ImportError as e:  # pragma: no cover
    sys.exit("missing dependency (%s)\n  pip install pyogrio shapely" % e)

FORMAT = "rw2-rip/1"

ROUTES_LAYER = "AllRIPRoutes"
LOTS_LAYER = "Area_Conditions"
SEGS_LAYER = "Route_Conditions_20th"

# Segment attributes worth carrying. Everything else on that layer (park,
# owner, route name, from/to text, asset code ...) is identical for every
# segment of a route and is inherited from the parent route record instead.
SEG_FIELDS = [
    "PARK_ALPHA", "ROUTE_IDENT", "BEG_MP", "END_MP", "INT_LENGTH",
    "CONDITION_RATING", "QR", "PCR", "RCI", "SCR", "IRI_AVG", "RUT_AVG",
    "SC_INDEX", "AC_INDEX", "LC_INDEX", "TC_INDEX", "PATCH_INDEX",
    "IMAGE_NAME", "VIDEO",
]

# -1 is the dataset's "not measured" sentinel, used across scores, widths,
# lane counts, mileposts and functional class. Carrying it through would make
# unmeasured pavement look like the worst pavement in the park, so any numeric
# -1 becomes null and the UI renders it blank.
#
# Applied to every numeric field except these, where a real value could
# legitimately be negative (and -1 is not a sentinel).
SENTINEL_EXEMPT = {"CENT_LAT", "CENT_LONG"}

# How widely this bites, for reference:
#   routes -- RCI and IRI_AVG are -1 on 89% of rows (rarely measured)
#   lots   -- RCI, SCR, IRI_AVG, RUT_INDEX and all five distress indices are
#             -1 on 100% of rows: NPS does not collect them for parking. Only
#             PCR, CONDITION_RATING, M_RATING, QR, API and FCI are real there,
#             so a lot-facing table should not offer the distress columns.

# Dropped from output: ESRI bookkeeping, or the grouping key we already know.
DROP_FIELDS = {"PARK_ALPHA", "Shape_Length", "Shape_Area", "SOURCE", "K_Link"}

COORD_DP = 6  # ~0.1 m


# ---------------------------------------------------------------------------
# value + geometry normalisation
# ---------------------------------------------------------------------------
def clean(field, v):
    """numpy/ESRI value -> JSON-safe value, applying the -1 sentinel rule."""
    if v is None:
        return None
    exempt = field in SENTINEL_EXEMPT
    if isinstance(v, np.integer):
        i = int(v)
        return None if (i == -1 and not exempt) else i
    if isinstance(v, np.floating):
        f = float(v)
        if f != f:  # NaN
            return None
        if f == -1.0 and not exempt:
            return None
        return round(f, 4)
    if isinstance(v, np.datetime64):
        s = str(v)
        return None if s in ("NaT",) else s[:10]
    s = str(v)
    return None if s in ("None", "nan", "NaT", "") else s


def _ring(seq):
    flat = []
    for xy in seq:
        flat.append(round(xy[0], COORD_DP))
        flat.append(round(xy[1], COORD_DP))
    return flat


def geom_parts(g):
    """(Multi)LineString/(Multi)Polygon -> [[lng,lat,...], ...].

    Lines give one array per part. Polygons give the exterior ring first,
    then any interior rings -- which lines up with how Roadwalk2 already
    stores an area section (alignment + holes)."""
    if g is None or g.is_empty:
        return None
    t = g.geom_type
    out = []
    if t in ("LineString", "LinearRing"):
        out.append(_ring(g.coords))
    elif t == "MultiLineString":
        for p in g.geoms:
            out.append(_ring(p.coords))
    elif t == "Polygon":
        out.append(_ring(g.exterior.coords))
        out.extend(_ring(r.coords) for r in g.interiors)
    elif t == "MultiPolygon":
        for poly in g.geoms:
            out.append(_ring(poly.exterior.coords))
            out.extend(_ring(r.coords) for r in poly.interiors)
    else:
        return None
    out = [p for p in out if len(p) >= 4]
    return out or None


def bbox_of(parts, box):
    for ring in parts:
        for i in range(0, len(ring), 2):
            x, y = ring[i], ring[i + 1]
            if x < box[0]: box[0] = x
            if y < box[1]: box[1] = y
            if x > box[2]: box[2] = x
            if y > box[3]: box[3] = y


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------
def read_grouped(gdb, layer, columns=None, want_geom=True):
    """One pass over a layer, grouped by PARK_ALPHA.

    Reading once and grouping beats 300+ per-park `where` queries by a wide
    margin. Note pyogrio silently returns zero rows if you filter on a column
    that isn't in `columns`, so PARK_ALPHA must always be selected -- hence it
    is required in `columns` here and stripped later by DROP_FIELDS.
    """
    if columns is not None and "PARK_ALPHA" not in columns:
        columns = ["PARK_ALPHA"] + list(columns)
    meta, _, geom, data = ogr_read(gdb, layer=layer, columns=columns,
                                   read_geometry=want_geom)
    fields = list(meta["fields"])
    park_i = fields.index("PARK_ALPHA")
    parks = collections.defaultdict(list)
    n = len(data[park_i])
    for i in range(n):
        rec = {}
        for f, col in zip(fields, data):
            if f in DROP_FIELDS:
                continue
            v = clean(f, col[i])
            if v is not None:
                rec[f] = v
        if want_geom:
            parts = geom_parts(from_wkb(geom[i]))
            if parts is None:
                continue
            rec["_g"] = parts
        parks[str(data[park_i][i])].append(rec)
    return parks


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Slice NPS RIP C6 gdb into per-park bundles")
    ap.add_argument("--gdb", required=True, help="path to NPS_C6.gdb")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--parks", default="all",
                    help="comma-separated PARK_ALPHA codes, or 'all' (default)")
    ap.add_argument("--gzip", action="store_true",
                    help="also write .json.gz next to each bundle")
    ap.add_argument("--cycle", type=int, default=6)
    args = ap.parse_args()

    if not os.path.isdir(args.gdb):
        sys.exit("not a geodatabase directory: %s" % args.gdb)
    have = {n for n, _ in list_layers(args.gdb)}
    for need in (ROUTES_LAYER, LOTS_LAYER, SEGS_LAYER):
        if need not in have:
            sys.exit("layer %r missing from %s (found: %s)" % (need, args.gdb, sorted(have)))
    os.makedirs(args.out, exist_ok=True)

    print("reading %s ..." % ROUTES_LAYER, flush=True)
    routes = read_grouped(args.gdb, ROUTES_LAYER)
    print("reading %s ..." % LOTS_LAYER, flush=True)
    lots = read_grouped(args.gdb, LOTS_LAYER)
    print("reading %s (0.02 mi segments) ..." % SEGS_LAYER, flush=True)
    segs = read_grouped(args.gdb, SEGS_LAYER, columns=SEG_FIELDS)

    all_parks = sorted(set(routes) | set(lots))
    if args.parks != "all":
        want = {p.strip().upper() for p in args.parks.split(",") if p.strip()}
        missing = want - set(all_parks)
        if missing:
            print("warning: no data for %s" % ", ".join(sorted(missing)), file=sys.stderr)
        all_parks = [p for p in all_parks if p in want]

    index = []
    for park in all_parks:
        r, l, s = routes.get(park, []), lots.get(park, []), segs.get(park, [])
        box = [180.0, 90.0, -180.0, -90.0]
        for rec in r:
            bbox_of(rec["_g"], box)
        for rec in l:
            bbox_of(rec["_g"], box)
        if box[0] > box[2]:
            box = None

        states = sorted({rec[k] for rec in r + l for k in ("STATE1",) if rec.get(k)})
        bundle = {
            "format": FORMAT,
            "cycle": args.cycle,
            "park": park,
            "states": states,
            "bbox": box,
            "counts": {"routes": len(r), "lots": len(l), "segments": len(s)},
            "routes": r,
            "lots": l,
            "segments": s,
        }

        name = "NPS_C%d_%s.json" % (args.cycle, park)
        path = os.path.join(args.out, name)
        blob = json.dumps(bundle, separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(blob)
        size = len(blob.encode("utf-8"))
        gz_size = None
        if args.gzip:
            gz = gzip.compress(blob.encode("utf-8"), 9)
            with open(path + ".gz", "wb") as fh:
                fh.write(gz)
            gz_size = len(gz)

        index.append({
            "park": park, "file": name, "states": states, "bbox": box,
            "counts": bundle["counts"], "bytes": size,
            **({"gz_bytes": gz_size} if gz_size is not None else {}),
        })
        print("  %-6s routes=%-4d lots=%-4d segs=%-6d %7.2f MB%s"
              % (park, len(r), len(l), len(s), size / 1048576,
                 "  (%.2f MB gz)" % (gz_size / 1048576) if gz_size else ""))

    idx = {
        "format": FORMAT, "cycle": args.cycle,
        "source": os.path.basename(os.path.normpath(args.gdb)),
        "interval_mi": 0.02, "parks": index,
    }
    with open(os.path.join(args.out, "parks_index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, separators=(",", ":"))

    tot = sum(p["bytes"] for p in index)
    print("\n%d parks -> %s  (%.1f MB total, index parks_index.json)"
          % (len(index), args.out, tot / 1048576))


if __name__ == "__main__":
    main()
