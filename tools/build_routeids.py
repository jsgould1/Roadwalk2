"""Parse NPS RIP 'RouteID' PDFs -> route_ids.json for Roadwalk2.

Output: { "<UNITCODE>": { "<FMSS/FACLOCID>": { full RIP record } , ... }, ... }
so the importer can join each route's FACLOCID -> ROUTE_ID + all RIP attributes
(name, From/To description, FLTP, access level, area, surface type, area map).

Usage:
  python build_routeids.py <folder-of-RouteID-pdfs> <out.json>
PDFs must be named like ABLI_C6_RouteID.pdf (UNITCODE prefix).

Requires pdfplumber (pip install pdfplumber).
"""
import sys, os, re, json, glob
import pdfplumber

def cell(v):
    s = (v or '').replace('\n', ' ').strip()
    return '' if s in ('', 'NC', '<Null>') else s

def num(v):
    s = cell(v).replace(',', '')
    try: return float(s)
    except Exception: return None

def parse_pdf(path):
    recs = {}
    section = 'road'
    with pdfplumber.open(path) as f:
        for p in f.pages:
            for t in p.extract_tables():
                if not t: continue
                for row in t:
                    c0 = cell(row[0]).upper()
                    if 'PARKING AREA' in c0: section = 'parking'; continue
                    if 'ROAD INVENTORY' in c0 or 'NON-NPS ROAD' in c0: section = 'road'; continue
                    rno = cell(row[0])
                    if not re.match(r'^\d{4}[A-Z]*$', rno): continue      # data rows start with a route no
                    r = [cell(x) for x in row]
                    def g(i): return r[i] if i < len(r) else ''
                    if section == 'parking' and len(r) >= 14:
                        rec = {'route_id': rno, 'fmss': g(3), 'name': g(5), 'desc_from': g(6), 'desc_to': g(7),
                               'fltp': g(9), 'access_level': g(10), 'area_sqft': num(row[11] if len(row) > 11 else ''),
                               'surf_type': g(12), 'area_map': g(13), 'rip_type': 'parking'}
                    else:  # road-style (17 cols): paved/unpaved/total miles + class
                        rec = {'route_id': rno, 'fmss': g(3), 'name': g(5), 'desc_from': g(6), 'desc_to': g(7),
                               'fltp': g(9), 'paved_mi': num(row[10] if len(row) > 10 else ''),
                               'unpaved_mi': num(row[11] if len(row) > 11 else ''), 'total_mi': num(row[12] if len(row) > 12 else ''),
                               'func_class': g(13), 'surf_type': g(15), 'area_map': g(16), 'rip_type': 'road'}
                    recs[rno] = rec      # key by ROUTE_ID (unique per park); FMSS kept as a field
                                         # (sub-routes share a dummy FMSS "2", so FMSS can't be the key)
    return recs

def main():
    if len(sys.argv) < 3:
        print('usage: python build_routeids.py <pdf-folder> <out.json>'); sys.exit(1)
    folder, out = sys.argv[1], sys.argv[2]
    result = {}
    for pdf in sorted(glob.glob(os.path.join(folder, '*_RouteID.pdf'))) + sorted(glob.glob(os.path.join(folder, '*.pdf'))):
        base = os.path.basename(pdf)
        unit = base.split('_')[0].upper()
        recs = parse_pdf(pdf)
        if recs:
            result.setdefault(unit, {}).update(recs)
            print(f'  {unit}: {len(recs)} routes  ({base})')
    with open(out, 'w') as fp:
        json.dump(result, fp, indent=1)
    total = sum(len(v) for v in result.values())
    print(f'DONE -> {out}  ({len(result)} parks, {total} routes)')

if __name__ == '__main__':
    main()
