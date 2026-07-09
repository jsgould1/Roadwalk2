"""Parse the AECOM scope workbook -> scope.json (in-scope routes) for Roadwalk2.

Keeps only Route ID + naming + type + coordinates (quantities intentionally
skipped for now). Coordinates let us spatially assign the correct (sub-)ROUTE_ID
to each imported segment/polygon and mark it in-scope.

Output: { "<PARK>": { "<ROUTE_ID>": {section_name, route_name, type,
                                     start:[lat,lng], end:[lat,lng]|null} } }
Usage:  python build_scope.py "<xlsx>" <out.json>
Requires openpyxl.
"""
import sys, json, re
import openpyxl

def norm_route_id(v):
    if v is None: return None
    s = str(v).strip().upper().replace(' ', '')
    if not s: return None
    m = re.match(r'^0*(\d+)([A-Z]*)$', s)        # 400 -> 0400 ; 225AZ -> 0225AZ ; 10AZ -> 0010AZ
    if m: return m.group(1).zfill(4) + m.group(2)
    return s

def fnum(v):
    try: return float(v)
    except Exception: return None

def main():
    xlsx, out = sys.argv[1], sys.argv[2]
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    ws = wb['Sheet1']
    rows = list(ws.iter_rows(min_row=1, values_only=True))
    hdr = [(h or '').strip() for h in rows[0]]
    def col(name):
        for i, h in enumerate(hdr):
            if h.lower() == name.lower(): return i
        return None
    ci = {k: col(k) for k in ['Park', 'Route ID', 'Section Name', 'Route Name', 'Road/Parking',
                              'Start Lat', 'Start Long', 'End Lat', 'End Long']}
    result = {}
    n = 0
    for r in rows[1:]:
        park = r[ci['Park']] if ci['Park'] is not None else None
        rid = norm_route_id(r[ci['Route ID']]) if ci['Route ID'] is not None else None
        if not park or not rid: continue
        slat, slng = fnum(r[ci['Start Lat']]), fnum(r[ci['Start Long']])
        elat, elng = fnum(r[ci['End Lat']]), fnum(r[ci['End Long']])
        rec = {
            'section_name': r[ci['Section Name']],
            'route_name': r[ci['Route Name']],
            'type': (r[ci['Road/Parking']] or '').strip().lower(),   # 'road' | 'parking'
            'start': [slat, slng] if slat is not None and slng is not None else None,
            'end': [elat, elng] if elat is not None and elng is not None else None,
        }
        result.setdefault(str(park).strip().upper(), {})[rid] = rec
        n += 1
    with open(out, 'w') as fp:
        json.dump(result, fp, indent=1)
    print('parks:', {k: len(v) for k, v in result.items()})
    print(f'DONE -> {out}  ({len(result)} parks, {n} in-scope routes)')

if __name__ == '__main__':
    main()
