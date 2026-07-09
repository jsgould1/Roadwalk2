"""Convert any OpenFileGDB with per-park layers -> one flat folder of shapefiles.
Keeps native CRS + writes a .prj so shpjs reprojects on import (same path as the
existing parking shapefiles). Each layer -> <layerName>.shp.

Usage:
  python convert_gdb.py "<path to .gdb>" "<output folder>"

Requires pyogrio (pip install pyogrio — bundles GDAL, works on Python 3.14).
"""
import os, sys, pyogrio

if len(sys.argv) < 3:
    print("usage: python convert_gdb.py <input.gdb> <output_dir>"); sys.exit(1)
GDB, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

layers = [l[0] for l in pyogrio.list_layers(GDB)]
total = 0
for lyr in layers:
    meta, _fids, geom, fdata = pyogrio.raw.read(GDB, layer=lyr)
    if len(geom) == 0:
        print(f"  {lyr}: 0 features (skip)"); continue
    gtype = meta["geometry_type"].replace(" Z", "")   # drop Z; 2D map
    out = os.path.join(OUT, f"{lyr}.shp")
    pyogrio.raw.write(out, geom, fdata, fields=list(meta["fields"]),
                      geometry_type=gtype, crs=meta["crs"], driver="ESRI Shapefile",
                      promote_to_multi=True)
    total += len(geom)
    print(f"  {lyr}: {len(geom)} features  ({meta['crs']})")
print(f"DONE -> {OUT}  ({len(layers)} layers, {total} features)")
