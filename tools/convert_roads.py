"""Convert NPS_ROAD.gdb (per-park layers) -> <UNIT>_ROADS shapefiles.
Keeps native CRS + writes a .prj so shpjs reprojects on import (same path as
the parking shapefiles). One layer per park; BLRI already split NC/VA."""
import os, sys, pyogrio

GDB = r"C:/Users/gouldj/OneDrive - AECOM/Documents/!DATA/EFL/2026 NC-TN-KY/405_Project INputs/04_SHP Files/NPS_ROAD.gdb"
OUT = sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/gouldj/OneDrive - AECOM/Documents/!AECOM/CLAUDE/Roadwalk2/data/_test_roads"
os.makedirs(OUT, exist_ok=True)

layers = [l[0] for l in pyogrio.list_layers(GDB)]
total = 0
for lyr in layers:
    unit = lyr[:-5] if lyr.upper().endswith("_ROAD") else lyr   # ABLI_ROAD -> ABLI
    meta, _fids, geom, fdata = pyogrio.raw.read(GDB, layer=lyr)
    if len(geom) == 0:
        print(f"  {unit}: 0 features (skip)"); continue
    gtype = meta["geometry_type"].replace(" Z", "")   # PolylineZ not needed for 2D map
    out = os.path.join(OUT, f"{unit}_ROADS.shp")
    pyogrio.raw.write(out, geom, fdata, fields=list(meta["fields"]),
                      geometry_type=gtype, crs=meta["crs"], driver="ESRI Shapefile",
                      promote_to_multi=True)
    total += len(geom)
    print(f"  {unit}_ROADS: {len(geom)} roads  ({meta['crs']})")
print(f"DONE -> {OUT}  ({len(layers)} layers, {total} roads)")
