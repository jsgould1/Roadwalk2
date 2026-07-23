/* =========================================================================
 * rip-data.js — the RIP module: filterable review of an imported NPS RIP
 * Cycle 6 park, across several tabs over one shared filter set.
 *
 *   Assets      one row per road / lot (the inventory) + in-scope toggle
 *   Conditions  one row per 0.02 mi (105.6 ft) segment
 *   Geometry    per-feature geometry facts (parts, vertices, length/area, MP)
 *   Custom      user-defined columns, editable per asset, exported
 *
 * Everything from the geodatabase is available: the table shows a chosen set
 * of columns (Columns… picker), and clicking any row opens a drawer with
 * every field grouped. Scope is built in bulk (filter, then "set filtered in
 * scope"), not by tapping hundreds of routes.
 *
 * Two dataset facts shape the UI:
 *  - -1 means "not measured"; the slicer nulled it, so a blank cell is truly
 *    blank and is never coloured as a bad score. A metric range excludes
 *    blanks rather than treating them as zero.
 *  - lots carry NO distress data (RCI/SCR/IRI/RUT + the five indices are -1
 *    on 100% of rows), so those metrics/columns hide when the view is lots.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const sections = () => (RW().SECTIONS) || [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PAGE = 300;   // rows rendered before "show more"; big parks have 26k

  // ---- field catalog ----------------------------------------------------
  // label (l) + group (g) for every gdb field, plus a few synthetic columns.
  // Anything not listed falls back to a humanised key and the "Other" group.
  const GROUPS = ['Identity', 'Ownership', 'Location', 'Physical',
                  'Condition', 'Distress', 'Work', 'Media', 'Custom', 'Other'];
  const F = {
    ROUTE_IDENT: { l: 'Route ID', g: 'Identity' }, FMSS_NO: { l: 'FMSS #', g: 'Identity' },
    RTE_NAME: { l: 'Route name', g: 'Identity' }, RTE_NO: { l: 'Route #', g: 'Identity' },
    RTE_SERIES: { l: 'Series', g: 'Identity' }, PARK_ALPHA: { l: 'Park', g: 'Identity' },
    FEATURE_CLASS: { l: 'Feature class', g: 'Identity' }, ASSET_CODE: { l: 'Asset code', g: 'Identity' },
    Asset_Code: { l: 'Asset code', g: 'Identity' }, FACILITY_TYPE: { l: 'Facility type', g: 'Identity' },
    OWNER: { l: 'Owner', g: 'Ownership' }, MAINTAINER: { l: 'Maintainer', g: 'Ownership' },
    FLTP: { l: 'FLTP', g: 'Ownership' }, USER_ACCESS: { l: 'Access', g: 'Ownership' },
    UNPAVED: { l: 'Unpaved', g: 'Ownership' }, FUNCT_CLASS: { l: 'Functional class', g: 'Ownership' },
    STATE1: { l: 'State', g: 'Ownership' }, STATE2: { l: 'State 2', g: 'Ownership' }, STATE3: { l: 'State 3', g: 'Ownership' },
    FROM_DESC: { l: 'From', g: 'Location' }, TO_DESC: { l: 'To', g: 'Location' },
    BEG_MP_DCV: { l: 'Begin MP', g: 'Location', u: 'mi', d: 3 }, END_MP_DCV: { l: 'End MP', g: 'Location', u: 'mi', d: 3 },
    BEG_MP: { l: 'Begin MP', g: 'Location', u: 'mi', d: 2 }, END_MP: { l: 'End MP', g: 'Location', u: 'mi', d: 2 },
    INT_LENGTH: { l: 'Segment length', g: 'Location', u: 'ft', d: 1 }, RTE_LENGTH: { l: 'Route length', g: 'Location', u: 'mi', d: 3 },
    PAVED_MI: { l: 'Paved', g: 'Location', u: 'mi', d: 3 }, UNPAVED_MI: { l: 'Unpaved', g: 'Location', u: 'mi', d: 3 },
    CENT_LAT: { l: 'Centroid lat', g: 'Location' }, CENT_LONG: { l: 'Centroid lng', g: 'Location' },
    SQ_FEET: { l: 'Area', g: 'Location', u: 'sf' },
    SURF_TYPE: { l: 'Surface', g: 'Physical' }, PAVEMENT_TREATMENT: { l: 'Treatment', g: 'Physical' },
    NO_LANES: { l: 'Lanes', g: 'Physical' }, LANE_WIDTH: { l: 'Lane width', g: 'Physical', u: 'ft' },
    SPEED: { l: 'Speed', g: 'Physical', u: 'mph' }, CURB: { l: 'Curb', g: 'Physical' },
    CURB_GUTTER: { l: 'Curb & gutter', g: 'Physical' }, CURB_RECOMMENDATION: { l: 'Curb rec.', g: 'Physical' },
    RIP_CYCLE: { l: 'RIP cycle', g: 'Condition' }, RIP_ITERATION: { l: 'Iteration', g: 'Condition' },
    INSP_DATE: { l: 'Inspected', g: 'Condition' }, M_RATING: { l: 'M rating', g: 'Condition' },
    CONDITION_RATING: { l: 'Condition', g: 'Condition' }, QR: { l: 'QR', g: 'Condition' },
    PCR: { l: 'PCR', g: 'Condition' }, RCI: { l: 'RCI', g: 'Condition' }, SCR: { l: 'SCR', g: 'Condition' },
    IRI_AVG: { l: 'IRI', g: 'Condition' }, RUT_AVG: { l: 'Rut', g: 'Condition' }, RUT_INDEX: { l: 'Rut index', g: 'Condition' },
    Status: { l: 'Status', g: 'Condition' },
    SC_INDEX: { l: 'Surface idx', g: 'Distress' }, AC_INDEX: { l: 'Alligator idx', g: 'Distress' },
    LC_INDEX: { l: 'Long. crack idx', g: 'Distress' }, TC_INDEX: { l: 'Trans. crack idx', g: 'Distress' },
    PATCH_INDEX: { l: 'Patch idx', g: 'Distress' },
    API: { l: 'API', g: 'Work' }, FCI: { l: 'FCI', g: 'Work' }, UM: { l: 'Unit', g: 'Work' }, Quantity: { l: 'Quantity', g: 'Work' },
    IMAGE_NAME: { l: 'Image', g: 'Media' }, VIDEO: { l: 'Video', g: 'Media' },
    // synthetic
    kind: { l: 'Kind', g: 'Identity', syn: true }, size: { l: 'Size', g: 'Location', syn: true, num: true },
    station: { l: 'MP range', g: 'Location', syn: true },
  };
  const humanize = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const meta = (k) => F[k] || (F[k] = { l: humanize(k), g: 'Other' });
  // Column label, resolving custom "cust:<key>" columns to their field label.
  function colLabel(k) {
    if (k.slice(0, 5) === 'cust:') { const c = state.custom.find((x) => x.key === k.slice(5)); return c ? c.label : k.slice(5); }
    return meta(k).l;
  }
  const numFmt = (v, d) => (d != null ? Number(v).toFixed(d) : (Number.isInteger(v) ? v : Number(v).toFixed(2)));

  // ---- metrics (numeric fields that get a colour ramp) ------------------
  const METRICS = {
    PCR: { dir: 'high', max: 100 }, CONDITION_RATING: { dir: 'high', max: 100 },
    SCR: { dir: 'high', max: 100 }, RCI: { dir: 'high', max: 100 },
    SC_INDEX: { dir: 'high', max: 100 }, AC_INDEX: { dir: 'high', max: 100 },
    LC_INDEX: { dir: 'high', max: 100 }, TC_INDEX: { dir: 'high', max: 100 },
    PATCH_INDEX: { dir: 'high', max: 100 }, RUT_INDEX: { dir: 'high', max: 100 },
    IRI_AVG: { dir: 'low', max: 400 }, RUT_AVG: { dir: 'low', max: 1 }, FCI: { dir: 'low', max: 1 },
  };
  const LOT_METRICS = ['PCR', 'CONDITION_RATING', 'FCI'];

  // Official NPS RIP condition colour bands — taken verbatim from the EFLHD-RIP
  // dashboard's own layer renderer (field RATING): EXCELLENT 95-100, GOOD
  // 85-94, FAIR 61-84, POOR 0-60, NOT RATED. Applied to PCR and every 0-100
  // index. IRI (roughness, in/mi) reuses the same colours on its own
  // thresholds. -1 is nulled upstream, so null here = "not measured" (no
  // colour). These exact breaks/hex match the official Cycle 7 dashboard.
  const BAND = { excellent: '#0072b2', good: '#1b9e77', fair: '#e69f00', poor: '#c51b7d', nr: '#000000', none: '#c3cad2' };
  // 0-100 score → band (higher is better)
  function scoreColor(v) {
    if (v == null || isNaN(v)) return null;
    v = Number(v);
    return v >= 95 ? BAND.excellent : v >= 85 ? BAND.good : v >= 61 ? BAND.fair : BAND.poor;
  }
  // IRI in in/mi → band (lower is better), same palette
  function iriColor(v) {
    if (v == null || isNaN(v)) return null;
    v = Number(v);
    return v < 60 ? BAND.excellent : v < 95 ? BAND.good : v < 135 ? BAND.fair : BAND.poor;
  }
  const SCORE_FIELDS = new Set(['PCR', 'CONDITION_RATING', 'SCR', 'RCI', 'SC_INDEX',
    'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX', 'RUT_INDEX', 'API']);
  // Colour a table cell's value by field: 0-100 scores use the RIP bands, IRI
  // its own scale; everything else (RUT_AVG, FCI, non-metrics) stays uncoloured.
  function cellColor(key, v) { return key === 'IRI_AVG' ? iriColor(v) : SCORE_FIELDS.has(key) ? scoreColor(v) : null; }
  const SCORE_LEGEND = [['95–100', BAND.excellent], ['85–94', BAND.good], ['61–84', BAND.fair], ['0–60', BAND.poor]];
  const IRI_LEGEND = [['< 60', BAND.excellent], ['60–95', BAND.good], ['95–135', BAND.fair], ['≥ 135', BAND.poor]];

  // ---- default columns per tab ------------------------------------------
  const DEFAULT_COLS = {
    assets: ['ROUTE_IDENT', 'RTE_NAME', 'kind', 'SURF_TYPE', 'size', 'PCR', 'M_RATING'],
    conditions: ['ROUTE_IDENT', 'RTE_NAME', 'station', 'PCR', 'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX', 'QR'],
  };
  // Fields offered in the Columns… picker, per tab (order = display order).
  const COL_MENU = {
    assets: ['ROUTE_IDENT', 'RTE_NAME', 'kind', 'FMSS_NO', 'FACILITY_TYPE', 'ASSET_CODE',
      'SURF_TYPE', 'size', 'SQ_FEET', 'RTE_LENGTH', 'NO_LANES', 'LANE_WIDTH', 'SPEED',
      'USER_ACCESS', 'UNPAVED', 'FLTP', 'OWNER', 'MAINTAINER', 'FUNCT_CLASS', 'RTE_SERIES', 'STATE1',
      'BEG_MP_DCV', 'END_MP_DCV', 'PAVED_MI', 'UNPAVED_MI',
      'PAVEMENT_TREATMENT', 'CURB', 'CURB_GUTTER', 'CURB_RECOMMENDATION',
      'PCR', 'CONDITION_RATING', 'M_RATING', 'QR', 'SCR', 'RCI', 'IRI_AVG', 'RUT_INDEX',
      'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX',
      'API', 'FCI', 'UM', 'Quantity', 'INSP_DATE', 'RIP_ITERATION', 'FROM_DESC', 'TO_DESC'],
    conditions: ['ROUTE_IDENT', 'RTE_NAME', 'station', 'INT_LENGTH', 'SURF_TYPE', 'NO_LANES',
      'LANE_WIDTH', 'SPEED', 'Status', 'CONDITION_RATING', 'QR', 'PCR', 'SCR', 'RCI', 'IRI_AVG',
      'RUT_AVG', 'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX',
      'API', 'FCI', 'UM', 'Quantity', 'IMAGE_NAME', 'VIDEO'],
  };

  // ---- state ------------------------------------------------------------
  const state = {
    park: null, bundle: null, segments: [], segsByRoute: new Map(),
    tab: 'assets', metric: 'PCR', limit: PAGE,
    sort: { key: 'ROUTE_IDENT', dir: 1 },
    q: '', kind: 'all', scope: 'all', facets: {}, range: { min: '', max: '' },
    cols: { assets: DEFAULT_COLS.assets.slice(), conditions: DEFAULT_COLS.conditions.slice() },
    custom: [],        // [{ key, label }]
    expanded: new Set(),   // route ids expanded in the Conditions tree
    colMenuOpen: false,
    cycle: 'c6',       // condition data source for Conditions/Analysis: 'c6' | 'c7'
    analMetric: 'PCR', // metric featured in the Analysis (Δ) tab
    analRes: 0.02,     // Analysis granularity in miles: 0.02 | 0.1
  };
  // Metrics that exist in BOTH cycles (drives the Analysis metric picker).
  const CYCLE_METRICS = ['PCR', 'SCR', 'RCI', 'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX', 'RUT_INDEX'];

  const FACETS = [
    ['SURF_TYPE', 'Surface'], ['FACILITY_TYPE', 'Facility'], ['USER_ACCESS', 'Access'],
    ['UNPAVED', 'Unpaved'], ['FLTP', 'FLTP'], ['OWNER', 'Owner'], ['M_RATING', 'Rating'],
    ['RTE_SERIES', 'Series'], ['CURB', 'Curb'], ['PAVEMENT_TREATMENT', 'Treatment'], ['Status', 'Status'],
  ];

  // ---- persistence ------------------------------------------------------
  const DB = 'roadwalk2_rip', STORE = 'rip';
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function save() {
    if (!state.bundle) return;
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          park: state.park, bundle: state.bundle, segments: state.segments,
          cols: state.cols, custom: state.custom,
        }, 'active');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { console.warn('[RIP] save failed', e); }
  }
  async function restore() {
    try {
      const db = await idb();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const rq = tx.objectStore(STORE).get('active');
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
      if (rec && rec.bundle) {
        hydrate(rec.bundle, rec.segments || []);
        if (rec.cols) state.cols = rec.cols;
        if (Array.isArray(rec.custom)) state.custom = rec.custom;
      }
    } catch (e) { /* nothing stored yet */ }
  }

  function hydrate(bundle, segments) {
    state.park = bundle.park;
    state.bundle = { park: bundle.park, cycle: bundle.cycle, states: bundle.states, bbox: bundle.bbox, counts: bundle.counts };
    state.segments = segments;
    state.segsByRoute = new Map();
    for (const s of segments) {
      const k = s.ROUTE_IDENT; let a = state.segsByRoute.get(k);
      if (!a) state.segsByRoute.set(k, a = []); a.push(s);
    }
    for (const a of state.segsByRoute.values()) a.sort((x, y) => (x.BEG_MP || 0) - (y.BEG_MP || 0));
  }
  function attach(bundle) { hydrate(bundle, bundle.segments || []); state.limit = PAGE; save(); }

  // ---- data views -------------------------------------------------------
  const ripOf = (s) => (s && s.rip) || {};
  const ripSections = () => sections().filter((s) => s.rip);

  function passesFacets(a, kindOk) {
    if (!kindOk) return false;
    for (const k in state.facets) {
      const want = state.facets[k];
      if (want == null || want === '') continue;
      if (String(a[k] == null ? '' : a[k]) !== want) return false;
    }
    return true;
  }
  function inRange(v) {
    const lo = state.range.min === '' ? null : Number(state.range.min);
    const hi = state.range.max === '' ? null : Number(state.range.max);
    if (lo == null && hi == null) return true;
    if (v == null || isNaN(v)) return false;
    if (lo != null && v < lo) return false;
    if (hi != null && v > hi) return false;
    return true;
  }
  function matchQ(sec, a) {
    if (!state.q) return true;
    const q = state.q.toUpperCase();
    return String(sec.route_id || '').toUpperCase().includes(q)
      || String(sec.name || '').toUpperCase().includes(q)
      || String(a.FMSS_NO || '').toUpperCase().includes(q);
  }

  function filteredAssets() {
    return ripSections().filter((sec) => {
      const a = ripOf(sec), isLot = sec.type === 'area';
      const kindOk = state.kind === 'all' || (state.kind === 'lot') === isLot;
      if (!passesFacets(a, kindOk)) return false;
      if (state.scope === 'in' && !sec.in_scope) return false;
      if (state.scope === 'out' && sec.in_scope) return false;
      if (!matchQ(sec, a)) return false;
      if (!inRange(a[state.metric])) return false;
      return true;
    });
  }
  // Segments for the currently-selected condition cycle. Cycle 7 comes from the
  // live FeatureServer (RW2RIPCycle), mapped to the same metric keys as Cycle 6.
  function c7Ready() {
    return state.cycle === 'c7' && window.RW2RIPCycle && window.RW2RIPCycle.hasData()
      && window.RW2RIPCycle.park() === state.park;
  }
  function activeSegments() { return c7Ready() ? window.RW2RIPCycle.get().all : state.segments; }
  function activeByRoute(routeId) {
    return c7Ready() ? window.RW2RIPCycle.segmentsFor(routeId) : (state.segsByRoute.get(routeId) || []);
  }
  function filteredConditions() {
    const parents = new Map();
    for (const s of ripSections()) if (s.route_id) parents.set(s.route_id, s);
    const out = [];
    for (const seg of activeSegments()) {
      const sec = parents.get(seg.ROUTE_IDENT); if (!sec) continue;
      const a = ripOf(sec);
      const kindOk = state.kind === 'all' || state.kind === 'road';
      if (!passesFacets(a, kindOk)) continue;
      if (state.scope === 'in' && !sec.in_scope) continue;
      if (state.scope === 'out' && sec.in_scope) continue;
      if (!matchQ(sec, a)) continue;
      if (!inRange(seg[state.metric])) continue;
      out.push({ seg, sec });
    }
    return out;
  }
  function availableMetrics() {
    const lotsOnly = state.kind === 'lot';
    return Object.keys(METRICS).filter((k) =>
      state.tab === 'conditions' ? k !== 'FCI' : (!lotsOnly || LOT_METRICS.includes(k)));
  }

  // value getters honour synthetic + custom columns
  function assetVal(sec, key) {
    if (key === 'kind') return sec.type === 'area' ? 'Lot' : 'Road';
    if (key === 'size') return sec.type === 'area' ? (ripOf(sec).SQ_FEET || null) : (ripOf(sec).RTE_LENGTH || null);
    if (key.slice(0, 5) === 'cust:') return (sec.rip_custom || {})[key.slice(5)];
    return ripOf(sec)[key];
  }
  function condVal(row, key) {
    const { seg, sec } = row;
    if (key === 'ROUTE_IDENT') return seg.ROUTE_IDENT;
    if (key === 'RTE_NAME') return sec.name;
    if (key === 'station') return seg.BEG_MP;
    const v = seg[key];
    return v != null ? v : ripOf(sec)[key];      // inherit route attr if absent
  }

  function sortRows(rows, get) {
    const { key, dir } = state.sort;
    return rows.slice().sort((r1, r2) => {
      let a = get(r1, key), b = get(r2, key);
      const an = a == null || a === '', bn = b == null || b === '';
      if (an && bn) return 0; if (an) return 1; if (bn) return -1;
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }

  // ---- geometry facts ---------------------------------------------------
  function haversineFt(a, b) {
    const R = 20925524.9;   // earth radius, feet
    const dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
    const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function geomFacts(sec) {
    const al = sec.alignment || [], holes = sec.holes || [];
    let vtx = al.length + holes.reduce((n, h) => n + h.length, 0);
    let box = [90, 180, -90, -180];
    const scan = (r) => r.forEach((p) => { if (p[0] < box[0]) box[0] = p[0]; if (p[1] < box[1]) box[1] = p[1]; if (p[0] > box[2]) box[2] = p[0]; if (p[1] > box[3]) box[3] = p[1]; });
    scan(al); holes.forEach(scan);
    let lengthFt = null, areaSf = null;
    if (sec.type === 'linear') { lengthFt = 0; for (let i = 1; i < al.length; i++) lengthFt += haversineFt(al[i - 1], al[i]); }
    else areaSf = ripOf(sec).SQ_FEET || sec.area_sqft || null;
    return { vtx, holes: holes.length, box: (box[0] <= box[2] ? box : null), lengthFt, areaSf };
  }

  // ---- bulk scope -------------------------------------------------------
  function setFilteredScope(on) {
    const rows = filteredAssets();
    if (!rows.length) return;
    if (!confirm('Set ' + rows.length + ' filtered route' + (rows.length === 1 ? '' : 's') + (on ? ' in scope?' : ' out of scope?'))) return;
    rows.forEach((s) => { s.in_scope = !!on; });
    if (RW().persistSections) RW().persistSections();
    if (RW().rerender) RW().rerender();
    render();
  }

  // ---- CSV export -------------------------------------------------------
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function exportCSV() {
    const park = state.park || 'park';
    let cols, header, rows;
    if (state.tab === 'assets') {
      cols = displayCols('assets');
      header = ['In scope', ...cols.map((k) => colLabel(k))];
      rows = filteredAssets().map((s) => [s.in_scope ? 'YES' : '', ...cols.map((k) => assetVal(s, k))]);
    } else if (state.tab === 'conditions') {
      cols = displayCols('conditions');
      header = cols.map((k) => meta(k).l);
      rows = filteredConditions().map((r) => cols.map((k) => condVal(r, k)));
    } else if (state.tab === 'geometry') {
      header = ['Route ID', 'Name', 'Kind', 'Vertices', 'Holes', 'Length (ft)', 'Area (sf)', 'Begin MP', 'End MP', 'S', 'W', 'N', 'E'];
      rows = filteredAssets().map((s) => { const g = geomFacts(s), a = ripOf(s);
        return [s.route_id, s.name, s.type === 'area' ? 'Lot' : 'Road', g.vtx, g.holes,
          g.lengthFt != null ? g.lengthFt.toFixed(1) : '', g.areaSf || '',
          a.BEG_MP_DCV, a.END_MP_DCV, ...(g.box || ['', '', '', ''])]; });
    } else if (state.tab === 'analysis') {
      const m = state.analMetric;
      header = ['Route ID', 'Name', 'Begin MP', 'End MP', 'C6 ' + meta(m).l, 'C7 ' + meta(m).l, 'Delta', 'Resolution'];
      const unitLbl = state.analRes === 'route' ? 'whole route' : state.analRes + ' mi';
      rows = analysisRows().map((r) => [r.sec.route_id, r.sec.name, r.begMp.toFixed(3), r.endMp.toFixed(3), r.c6, r.c7, r.d, unitLbl]);
    } else { return; }
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    download('RIP_' + park + '_' + state.tab + '.csv', csv);
  }

  // ---- shared rendering helpers -----------------------------------------
  function displayCols(tab) {
    const base = state.cols[tab] || DEFAULT_COLS[tab].slice();
    if (tab === 'assets') return base.concat(state.custom.map((c) => 'cust:' + c.key));
    return base;
  }
  function fmtVal(key, v) {
    if (v == null || v === '') return null;
    const m = meta(key);
    if (typeof v === 'number' && (m.u || m.d != null)) {
      const s = numFmt(v, m.d);
      return m.u === 'sf' ? Number(v).toLocaleString() + ' sf' : m.u ? s + ' ' + m.u : s;
    }
    return v;
  }
  function cell(key, v, opts) {
    opts = opts || {};
    const disp = key === 'size'
      ? (v == null ? null : (opts.isLot ? Number(v).toLocaleString() + ' sf' : Number(v).toFixed(3) + ' mi'))
      : fmtVal(key, v);
    const align = (meta(key).u || meta(key).num || typeof v === 'number') ? 'right' : 'left';
    if (disp == null) return '<td style="padding:5px 9px;color:#c3cad2;text-align:' + align + '">—</td>';
    const bc = cellColor(key, v);
    if (bc) {
      return '<td style="padding:5px 9px;text-align:right;font-variant-numeric:tabular-nums"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'
        + bc + ';margin-right:6px;vertical-align:middle"></span>' + esc(disp) + '</td>';
    }
    const mono = key === 'ROUTE_IDENT';
    return '<td style="padding:5px 9px;text-align:' + align + (key === 'RTE_NAME' ? ';max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' : '')
      + (mono ? ";font:700 12px 'IBM Plex Mono',monospace;color:#0B3D66;white-space:nowrap" : ';color:#3a4653') + '">' + esc(disp) + '</td>';
  }
  function th(key, label) {
    const on = state.sort.key === key;
    const align = (meta(key).u || meta(key).num || METRICS[key] || SCORE_FIELDS.has(key) || key === 'station' || key === 'size') ? 'right' : 'left';
    return '<th data-sort="' + key + '" style="position:sticky;top:0;background:#f7f9fb;z-index:1;text-align:' + align
      + ';padding:7px 9px;border-bottom:1px solid #e3e8ee;cursor:pointer;font:700 11.5px system-ui;color:#12233b;white-space:nowrap">'
      + esc(label) + (on ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  }

  // ---- tables -----------------------------------------------------------
  function assetsTable() {
    const cols = displayCols('assets');
    const rows = sortRows(filteredAssets(), (s, k) => k === 'ROUTE_IDENT' ? s.route_id : k === 'RTE_NAME' ? s.name : assetVal(s, k));
    const shown = rows.slice(0, state.limit);
    const body = shown.map((s) => {
      const isLot = s.type === 'area';
      return '<tr data-detail="' + esc(s.id) + '" style="border-bottom:1px solid #f2f5f8;cursor:pointer">'
        + '<td style="padding:5px 9px" data-nodetail="1"><input type="checkbox" data-scope="' + esc(s.id) + '"' + (s.in_scope ? ' checked' : '') + '></td>'
        + cols.map((k) => k === 'ROUTE_IDENT' ? cell(k, s.route_id) : k === 'RTE_NAME' ? cell(k, s.name) : cell(k, assetVal(s, k), { isLot })).join('')
        + '<td style="padding:5px 9px" data-nodetail="1"><button data-goto="' + esc(s.id) + '" title="Show on map" style="border:0;background:transparent;cursor:pointer;font-size:14px">🗺</button></td></tr>';
    }).join('');
    return { total: rows.length, shown: shown.length, html:
      '<table style="width:100%;border-collapse:collapse;font:13px system-ui"><thead><tr>'
      + '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;width:26px"></th>'
      + cols.map((k) => th(k, colLabel(k))).join('')
      + '<th style="position:sticky;top:0;background:#f7f9fb;border-bottom:1px solid #e3e8ee;width:30px"></th>'
      + '</tr></thead><tbody>' + body + '</tbody></table>' };
  }
  // A stacked bar showing what fraction of a route's length sits in each PCR
  // band — a quick condition fingerprint on the collapsed route row.
  function conditionBar(segs) {
    const buckets = { excellent: 0, good: 0, fair: 0, poor: 0, none: 0 };
    let tot = 0;
    for (const s of segs) {
      const len = s.INT_LENGTH || 105.6; tot += len;
      const v = s.PCR;
      const k = v == null ? 'none' : v >= 95 ? 'excellent' : v >= 85 ? 'good' : v >= 61 ? 'fair' : 'poor';
      buckets[k] += len;
    }
    if (!tot) return '';
    const order = [['excellent', BAND.excellent], ['good', BAND.good], ['fair', BAND.fair], ['poor', BAND.poor], ['none', BAND.none]];
    return '<span title="PCR distribution by length" style="display:inline-flex;width:94px;height:10px;border-radius:3px;overflow:hidden;border:1px solid #dfe4ea;flex:0 0 auto">'
      + order.map(([k, c]) => buckets[k] ? '<span style="width:' + (100 * buckets[k] / tot).toFixed(2) + '%;background:' + c + '"></span>' : '').join('') + '</span>';
  }
  function pcrDot(v) {
    const c = scoreColor(v);
    if (c == null) return '<span style="color:#c3cad2;font-variant-numeric:tabular-nums;min-width:34px;text-align:right;display:inline-block">—</span>';
    return '<span style="font-variant-numeric:tabular-nums;min-width:34px;text-align:right;display:inline-block"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'
      + c + ';margin-right:5px;vertical-align:middle"></span>' + esc(v) + '</span>';
  }
  function mpRange(segs, sec) {
    const a = ripOf(sec);
    if (a.BEG_MP_DCV != null && a.END_MP_DCV != null) return a.BEG_MP_DCV.toFixed(2) + '–' + a.END_MP_DCV.toFixed(2);
    if (!segs.length) return '—';
    let lo = Infinity, hi = -Infinity;
    for (const s of segs) { if (s.BEG_MP < lo) lo = s.BEG_MP; if (s.END_MP > hi) hi = s.END_MP; }
    return lo.toFixed(2) + '–' + hi.toFixed(2);
  }

  // Conditions tab: routes are the primary rows (collapsed by default); the
  // 0.02 mi segments live under each route and reveal on expand. Route ID /
  // name are shown once on the route banner, so segment sub-rows drop them.
  function conditionsTable() {
    const cols = displayCols('conditions').filter((k) => k !== 'ROUTE_IDENT' && k !== 'RTE_NAME');
    // group filtered segments by their parent route
    const groups = new Map();
    for (const r of filteredConditions()) {
      let g = groups.get(r.sec.id);
      if (!g) groups.set(r.sec.id, g = { sec: r.sec, segs: [] });
      g.segs.push(r.seg);
    }
    for (const g of groups.values()) g.segs.sort((a, b) => (a.BEG_MP || 0) - (b.BEG_MP || 0));

    // sort the routes themselves by the active sort key
    const arr = [...groups.values()];
    const sk = state.sort.key, dir = state.sort.dir;
    const routeKey = (g) => sk === 'RTE_NAME' ? g.sec.name : sk === 'station' ? (g.segs[0] ? g.segs[0].BEG_MP : 0)
      : sk === 'ROUTE_IDENT' ? g.sec.route_id : (ripOf(g.sec)[sk] != null ? ripOf(g.sec)[sk] : (g.segs[0] ? g.segs[0][sk] : null));
    arr.sort((a, b) => {
      let x = routeKey(a), y = routeKey(b); const xn = x == null, yn = y == null;
      if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });

    const ncols = 1 + cols.length;   // indent + segment columns
    // page by rendered rows (banner = 1, expanded route adds its segments), so
    // expanding a 250-segment route can't blow up the DOM
    const budget = state.limit;
    let used = 0, shownRoutes = 0, body = '';
    for (const g of arr) {
      const exp = state.expanded.has(g.sec.id);
      const cost = 1 + (exp ? g.segs.length : 0);
      if (shownRoutes > 0 && used + cost > budget) break;
      body += bannerRow(g, exp, ncols);
      if (exp) for (const seg of g.segs) body += segRow(seg, g.sec, cols);
      used += cost; shownRoutes++;
    }

    return { total: arr.length, shown: shownRoutes, unit: 'routes', grouped: true, html:
      '<table style="width:100%;border-collapse:collapse;font:13px system-ui"><thead><tr>'
      + '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;border-bottom:1px solid #e3e8ee;width:22px"></th>'
      + cols.map((k) => th(k, meta(k).l)).join('')
      + '</tr></thead><tbody>' + body + '</tbody></table>' };
  }
  function bannerRow(g, exp, ncols) {
    const sec = g.sec;
    const totalSegs = activeByRoute(sec.route_id).length;
    const note = g.segs.length === totalSegs ? (g.segs.length + ' seg') : (g.segs.length + ' of ' + totalSegs);
    return '<tr data-exp="' + esc(sec.id) + '" style="cursor:pointer;background:#f5f8fb;border-top:2px solid #e6ecf2">'
      + '<td colspan="' + ncols + '" style="padding:6px 9px">'
      + '<div style="display:flex;align-items:center;gap:10px">'
      + '<span style="color:#5b6673;width:12px;flex:0 0 auto">' + (exp ? '▾' : '▸') + '</span>'
      + '<span style="font:700 12px \'IBM Plex Mono\',monospace;color:#0B3D66;flex:0 0 auto">' + esc(sec.route_id || '—') + '</span>'
      + '<span style="flex:1 1 auto;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#12233b;font-weight:600">' + esc(sec.name) + '</span>'
      + '<span style="font:12px \'IBM Plex Mono\',monospace;color:#5b6673;flex:0 0 auto">' + mpRange(g.segs, sec) + ' mi</span>'
      + pcrDot(ripOf(sec).PCR)
      + conditionBar(g.segs)
      + '<span style="font-size:11.5px;color:#8a949f;flex:0 0 auto;min-width:52px;text-align:right">' + note + '</span>'
      + (window.RW2Pathweb ? '<button data-pw="' + esc(sec.id) + '" data-nodetail="1" title="Open this route in NPS PathWeb" style="border:1px solid #cdd6df;background:#fff;color:#0B3D66;border-radius:6px;padding:1px 6px;cursor:pointer;font:700 10px system-ui;flex:0 0 auto">PW ↗</button>' : '')
      + '<button data-goto="' + esc(sec.id) + '" data-nodetail="1" title="Show on map" style="border:0;background:transparent;cursor:pointer;font-size:14px;flex:0 0 auto">🗺</button>'
      + '</div></td></tr>';
  }
  function segRow(seg, sec, cols) {
    return '<tr data-detail="' + esc(sec.id) + '" data-seg="' + (seg.BEG_MP != null ? seg.BEG_MP : '') + '" style="border-bottom:1px solid #f4f6f8;cursor:pointer">'
      + '<td style="width:22px"></td>'
      + cols.map((k) => {
        if (k === 'station') return '<td style="padding:5px 9px;font:12px \'IBM Plex Mono\',monospace;color:#5b6673;white-space:nowrap;text-align:right">'
          + (seg.BEG_MP != null ? seg.BEG_MP.toFixed(2) : '?') + '–' + (seg.END_MP != null ? seg.END_MP.toFixed(2) : '?') + '</td>';
        return cell(k, condVal({ seg, sec }, k));
      }).join('')
      + '</tr>';
  }
  function geometryTable() {
    const rows = sortRows(filteredAssets(), (s, k) => k === 'ROUTE_IDENT' ? s.route_id : k === 'RTE_NAME' ? s.name : assetVal(s, k));
    const shown = rows.slice(0, state.limit);
    const body = shown.map((s) => {
      const g = geomFacts(s), a = ripOf(s), isLot = s.type === 'area';
      return '<tr data-detail="' + esc(s.id) + '" style="border-bottom:1px solid #f2f5f8;cursor:pointer">'
        + '<td style="padding:5px 9px;font:700 12px \'IBM Plex Mono\',monospace;color:#0B3D66;white-space:nowrap">' + esc(s.route_id || '—') + '</td>'
        + '<td style="padding:5px 9px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.name) + '</td>'
        + '<td style="padding:5px 9px;color:#5b6673">' + (isLot ? 'Lot' : 'Road') + '</td>'
        + '<td style="padding:5px 9px;text-align:right;font-variant-numeric:tabular-nums">' + g.vtx + '</td>'
        + '<td style="padding:5px 9px;text-align:right">' + (g.holes || '—') + '</td>'
        + '<td style="padding:5px 9px;text-align:right;color:#3a4653">' + (g.lengthFt != null ? g.lengthFt.toFixed(0) + ' ft' : '—') + '</td>'
        + '<td style="padding:5px 9px;text-align:right;color:#3a4653">' + (g.areaSf ? Number(g.areaSf).toLocaleString() + ' sf' : '—') + '</td>'
        + '<td style="padding:5px 9px;text-align:right;font:12px \'IBM Plex Mono\',monospace;color:#5b6673;white-space:nowrap">'
          + (a.BEG_MP_DCV != null ? a.BEG_MP_DCV.toFixed(2) + '–' + (a.END_MP_DCV != null ? a.END_MP_DCV.toFixed(2) : '?') : '—') + '</td>'
        + '<td style="padding:5px 9px" data-nodetail="1"><button data-goto="' + esc(s.id) + '" title="Show on map" style="border:0;background:transparent;cursor:pointer;font-size:14px">🗺</button></td></tr>';
    }).join('');
    const H = (l, r) => '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;text-align:' + (r ? 'right' : 'left') + ';font:700 11.5px system-ui;color:#12233b;white-space:nowrap">' + l + '</th>';
    return { total: rows.length, shown: shown.length, html:
      '<table style="width:100%;border-collapse:collapse;font:13px system-ui"><thead><tr>'
      + H('Route ID') + H('Name') + H('Kind') + H('Vertices', 1) + H('Holes', 1) + H('Length', 1) + H('Area', 1) + H('MP range', 1)
      + '<th style="position:sticky;top:0;background:#f7f9fb;border-bottom:1px solid #e3e8ee;width:30px"></th>'
      + '</tr></thead><tbody>' + body + '</tbody></table>' };
  }
  function customTable() {
    if (!state.custom.length) {
      return { total: 0, shown: 0, html:
        '<div style="padding:30px 22px;text-align:center;color:#5b6673">'
        + '<div style="font-size:15px;font-weight:700;color:#12233b;margin-bottom:6px">No custom fields yet</div>'
        + 'Add a column (e.g. “Field notes”, “Recommended treatment”) and it becomes editable per asset here, '
        + 'travels in the saved project, and is included in the CSV export.<br><br>'
        + '<button id="rip-cust-add" style="border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:9px 16px;cursor:pointer;font-weight:700">+ Add custom field</button></div>' };
    }
    const rows = sortRows(filteredAssets(), (s, k) => k === 'ROUTE_IDENT' ? s.route_id : k === 'RTE_NAME' ? s.name : assetVal(s, k));
    const shown = rows.slice(0, state.limit);
    const body = shown.map((s) => {
      const cv = s.rip_custom || {};
      return '<tr style="border-bottom:1px solid #f2f5f8">'
        + '<td style="padding:5px 9px;font:700 12px \'IBM Plex Mono\',monospace;color:#0B3D66;white-space:nowrap">' + esc(s.route_id || '—') + '</td>'
        + '<td style="padding:5px 9px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.name) + '</td>'
        + state.custom.map((c) => '<td style="padding:3px 6px"><input data-cust-val="' + esc(s.id) + '|' + esc(c.key)
          + '" value="' + esc(cv[c.key] == null ? '' : cv[c.key]) + '" style="width:100%;min-width:120px;border:1px solid #e3e8ee;border-radius:6px;padding:5px 7px;font:12.5px inherit"></td>').join('')
        + '</tr>';
    }).join('');
    return { total: rows.length, shown: shown.length, custom: true, html:
      '<table style="width:100%;border-collapse:collapse;font:13px system-ui"><thead><tr>'
      + '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;text-align:left;font:700 11.5px system-ui">Route ID</th>'
      + '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;text-align:left;font:700 11.5px system-ui">Name</th>'
      + state.custom.map((c) => '<th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;text-align:left;font:700 11.5px system-ui;white-space:nowrap">'
        + esc(c.label) + ' <button data-cust-del="' + esc(c.key) + '" title="Remove field" style="border:0;background:transparent;cursor:pointer;color:#c0392b;font-size:12px">✕</button></th>').join('')
      + '</tr></thead><tbody>' + body + '</tbody></table>' };
  }

  // ---- detail drawer (every field, grouped) -----------------------------
  function openDetail(sec, segMp) {
    const old = $('rip-drawer'); if (old) old.remove();
    const a = ripOf(sec), isLot = sec.type === 'area';
    let seg = null;
    if (segMp !== undefined && segMp !== '' && segMp != null) {
      seg = (state.segsByRoute.get(sec.route_id) || []).find((x) => x.BEG_MP === Number(segMp));
    }
    // collect fields into groups
    const buckets = {}; GROUPS.forEach((g) => buckets[g] = []);
    const push = (k, v) => { if (v == null || v === '' || meta(k).syn) return; buckets[meta(k).g].push([meta(k).l, fmtVal(k, v)]); };
    Object.keys(a).forEach((k) => push(k, a[k]));
    if (sec.rip_custom) for (const c of state.custom) if (sec.rip_custom[c.key] != null && sec.rip_custom[c.key] !== '') buckets.Custom.push([c.label, sec.rip_custom[c.key]]);
    const g = geomFacts(sec);
    buckets.Location.push(['Vertices', g.vtx]);
    if (g.lengthFt != null) buckets.Location.push(['Computed length', g.lengthFt.toFixed(0) + ' ft']);
    if (g.holes) buckets.Location.push(['Holes', g.holes]);

    const groupHtml = GROUPS.filter((gr) => buckets[gr].length).map((gr) =>
      '<div style="margin-bottom:14px"><div style="font:700 11px system-ui;text-transform:uppercase;letter-spacing:.5px;color:#0B3D66;margin-bottom:5px">' + gr + '</div>'
      + '<table style="width:100%;border-collapse:collapse;font:12.5px system-ui">'
      + buckets[gr].map(([l, v]) => '<tr><td style="padding:3px 8px 3px 0;color:#8a949f;white-space:nowrap;vertical-align:top">' + esc(l)
        + '</td><td style="padding:3px 0;color:#12233b;text-align:right;font-variant-numeric:tabular-nums">' + esc(v) + '</td></tr>').join('')
      + '</table></div>').join('');

    let segHtml = '';
    if (seg) {
      const segFields = ['BEG_MP', 'END_MP', 'INT_LENGTH', 'CONDITION_RATING', 'QR', 'PCR', 'SCR', 'RCI', 'IRI_AVG', 'RUT_AVG',
        'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX', 'SURF_TYPE', 'NO_LANES', 'LANE_WIDTH', 'SPEED', 'IMAGE_NAME', 'VIDEO'];
      segHtml = '<div style="margin-bottom:14px;padding:10px 11px;background:#f4f8fc;border:1px solid #dbe6f2;border-radius:9px">'
        + '<div style="font:700 11px system-ui;text-transform:uppercase;letter-spacing:.5px;color:#0B3D66;margin-bottom:5px">This 0.02 mi segment</div>'
        + '<table style="width:100%;border-collapse:collapse;font:12.5px system-ui">'
        + segFields.filter((k) => seg[k] != null).map((k) => '<tr><td style="padding:3px 8px 3px 0;color:#8a949f">' + esc(meta(k).l)
          + '</td><td style="padding:3px 0;text-align:right">' + esc(fmtVal(k, seg[k])) + '</td></tr>').join('')
        + '</table></div>';
    }

    const d = document.createElement('div');
    d.id = 'rip-drawer';
    d.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:min(400px,92vw);z-index:99997;background:#fff;'
      + 'box-shadow:-8px 0 28px rgba(10,20,40,.22);display:flex;flex-direction:column;font-family:system-ui';
    d.innerHTML =
      '<div style="padding:14px 16px;border-bottom:1px solid #eef1f4;display:flex;justify-content:space-between;align-items:flex-start;gap:10px">'
      + '<div><div style="font:700 13px \'IBM Plex Mono\',monospace;color:#0B3D66">' + esc(sec.route_id || '—') + '</div>'
      + '<div style="font-size:15px;font-weight:800;color:#12233b;line-height:1.2">' + esc(sec.name) + '</div>'
      + '<div style="font-size:12px;color:#8a949f;margin-top:2px">' + (isLot ? 'Parking lot' : 'Road') + ' · ' + esc(state.park) + (sec.in_scope ? ' · <b style="color:#0e7c66">in scope</b>' : ' · out of scope') + '</div></div>'
      + '<button id="rip-drawer-x" style="border:0;background:#eef1f4;border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:15px">✕</button></div>'
      + '<div style="overflow:auto;padding:14px 16px;flex:1">' + segHtml + groupHtml + '</div>'
      + '<div style="padding:11px 16px;border-top:1px solid #eef1f4;display:flex;gap:8px;flex-wrap:wrap">'
      + (sec.type === 'linear' && window.RW2Pathweb ? '<button id="rip-drawer-pw" title="Open this spot in NPS PathWeb imagery" style="border:0;background:#0B3D66;color:#fff;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700">PathWeb ↗</button>' : '')
      + '<button id="rip-drawer-map" style="flex:1;border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:9px;cursor:pointer;font-weight:700">🗺 Show on map</button>'
      + '<button id="rip-drawer-scope" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:9px 13px;cursor:pointer;font-weight:600;color:#12233b">' + (sec.in_scope ? 'Remove scope' : 'Set in scope') + '</button></div>';
    document.body.appendChild(d);
    $('rip-drawer-x').onclick = () => d.remove();
    const pw = $('rip-drawer-pw'); if (pw) pw.onclick = () => {
      if (seg) window.RW2Pathweb.openSegment(seg, sec);
      else window.RW2Pathweb.openRoute(sec, state.segsByRoute.get(sec.route_id) || []);
    };
    $('rip-drawer-map').onclick = () => { if (RW().showView) RW().showView('field', sec.id); if (window.showModule) window.showModule('map'); d.remove(); };
    $('rip-drawer-scope').onclick = () => {
      sec.in_scope = !sec.in_scope;
      if (RW().persistSections) RW().persistSections();
      if (RW().rerender) RW().rerender();
      d.remove(); render();
    };
  }

  // ---- column chooser ---------------------------------------------------
  function colChooser(anchor) {
    const old = $('rip-colmenu'); if (old) { old.remove(); return; }
    const tab = state.tab, chosen = new Set(state.cols[tab] || []);
    const menu = COL_MENU[tab] || [];
    const byGroup = {}; GROUPS.forEach((g) => byGroup[g] = []);
    menu.forEach((k) => byGroup[meta(k).g].push(k));
    const r = anchor.getBoundingClientRect();
    const m = document.createElement('div');
    m.id = 'rip-colmenu';
    m.style.cssText = 'position:fixed;top:' + (r.bottom + 5) + 'px;left:' + Math.max(8, r.right - 260) + 'px;z-index:99999;'
      + 'background:#fff;border:1px solid #d3dae1;border-radius:10px;box-shadow:0 8px 26px rgba(20,35,60,.22);'
      + 'width:260px;max-height:60vh;overflow:auto;padding:8px 0;font:13px system-ui';
    m.innerHTML = GROUPS.filter((g) => byGroup[g].length).map((g) =>
      '<div style="padding:5px 12px 2px;font:700 10.5px system-ui;text-transform:uppercase;letter-spacing:.5px;color:#8a949f">' + g + '</div>'
      + byGroup[g].map((k) => '<label style="display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer">'
        + '<input type="checkbox" data-col="' + k + '"' + (chosen.has(k) ? ' checked' : '') + '>' + esc(meta(k).l) + '</label>').join('')).join('');
    document.body.appendChild(m);
    m.querySelectorAll('[data-col]').forEach((cb) => cb.onchange = () => {
      const k = cb.dataset.col, cur = state.cols[tab].filter((x) => x !== k);
      if (cb.checked) {
        // keep menu order so columns land in a sensible place
        state.cols[tab] = menu.filter((mk) => mk === k || cur.includes(mk));
      } else state.cols[tab] = cur;
      save(); render();
      // reopen so the user can keep toggling
      const btn = $('rip-cols-btn'); if (btn) colChooser(btn);
    });
    setTimeout(() => document.addEventListener('click', function c(ev) {
      if (!m.contains(ev.target) && ev.target.id !== 'rip-cols-btn') { m.remove(); document.removeEventListener('click', c); }
    }), 0);
  }

  // ---- render -----------------------------------------------------------
  const chip = (label, active, attrs) =>
    '<button ' + attrs + ' style="border:1px solid ' + (active ? '#0B3D66' : '#d3dae1') + ';background:' + (active ? '#0B3D66' : '#fff')
    + ';color:' + (active ? '#fff' : '#12233b') + ';border-radius:999px;padding:5px 12px;cursor:pointer;font:600 12.5px system-ui">' + esc(label) + '</button>';

  function facetOptions() {
    const secs = ripSections(), html = [];
    for (const [field, label] of FACETS) {
      const vals = new Set();
      for (const s of secs) { const v = ripOf(s)[field]; if (v != null && v !== '') vals.add(String(v)); }
      if (vals.size < 2) continue;
      const sel = state.facets[field] || '';
      html.push('<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#5b6673">' + esc(label)
        + '<select data-facet="' + field + '" style="border:1px solid #d3dae1;border-radius:8px;padding:4px 7px;font:12.5px system-ui;background:#fff;max-width:135px">'
        + '<option value=""' + (sel === '' ? ' selected' : '') + '>All</option>'
        + [...vals].sort().map((v) => '<option value="' + esc(v) + '"' + (sel === v ? ' selected' : '') + '>' + esc(v) + '</option>').join('')
        + '</select></label>');
    }
    return html.join('');
  }

  const TABS = [['assets', 'Assets'], ['conditions', 'Conditions'], ['geometry', 'Geometry'], ['analysis', 'Δ Cycle 6→7'], ['custom', 'Custom']];

  // Kick off a Cycle 7 fetch for the current park when it's needed (Cycle 7
  // view or the Analysis tab). Cache-first; re-renders when it lands.
  function ensureC7() {
    const C = window.RW2RIPCycle; if (!C) return;
    const st = C.get();
    if (st.park === state.park && (st.all.length || st.loading)) return;
    C.loadPark(state.park, { onchange: () => render() });
  }

  // ---- cycle-over-cycle analysis ---------------------------------------
  // Break a route's segments into comparison units at the chosen resolution:
  // 0.02 mi = one per segment; 0.1 mi = length-weighted mean of ~5 segments.
  // `key` is the shared bin index so Cycle 6 and Cycle 7 units line up.
  function unitsFor(segs, res, metric) {
    // 'route' = the highest level: one length-weighted figure for the whole route.
    if (res === 'route') {
      let sum = 0, w = 0, lo = Infinity, hi = -Infinity;
      for (const s of segs) {
        if (s.BEG_MP != null) lo = Math.min(lo, s.BEG_MP);
        if (s.END_MP != null) hi = Math.max(hi, s.END_MP);
        if (s[metric] != null) { const len = s.INT_LENGTH || 105.6; sum += s[metric] * len; w += len; }
      }
      if (!isFinite(lo)) return [];
      return [{ begMp: lo, endMp: isFinite(hi) ? hi : lo, v: w ? sum / w : null, key: 0 }];
    }
    if (res === 0.1) {
      const bins = new Map();
      for (const s of segs) {
        const b = Math.floor((s.BEG_MP || 0) / 0.1 + 1e-6);
        let g = bins.get(b); if (!g) bins.set(b, g = { begMp: b * 0.1, endMp: b * 0.1 + 0.1, sum: 0, w: 0 });
        if (s[metric] != null) { const len = s.INT_LENGTH || 105.6; g.sum += s[metric] * len; g.w += len; }
      }
      return [...bins.values()].sort((a, b) => a.begMp - b.begMp)
        .map((g) => ({ begMp: g.begMp, endMp: g.endMp, v: g.w ? g.sum / g.w : null, key: Math.round(g.begMp / 0.1) }));
    }
    return segs.map((s) => ({ begMp: s.BEG_MP, endMp: s.END_MP, v: s[metric], key: Math.round((s.BEG_MP || 0) / 0.02) }));
  }
  function analysisRows() {
    const metric = state.analMetric, res = state.analRes;
    const C = window.RW2RIPCycle;
    const roads = filteredAssets().filter((s) => s.type !== 'area');
    const rows = [];
    for (const sec of roads) {
      const c6u = unitsFor(state.segsByRoute.get(sec.route_id) || [], res, metric);
      if (!c6u.length) continue;
      const c7segs = C.segmentsFor(sec.route_id);
      const c7map = new Map(unitsFor(c7segs, res, metric).map((u) => [u.key, u]));
      const hasC7 = c7segs.length > 0;
      for (const u of c6u) {
        const c7u = c7map.get(u.key);
        const c6 = u.v, c7 = c7u ? c7u.v : null;
        rows.push({ sec, begMp: u.begMp, endMp: u.endMp, c6, c7,
          d: (c6 != null && c7 != null) ? (c7 - c6) : null, hasC7 });
      }
    }
    return rows;
  }
  // Δ colour: all comparison metrics are 0-100 higher-is-better, so a positive
  // delta (improved) is green, negative (declined) red, intensity by magnitude.
  function deltaColor(d) {
    if (d == null) return '#c3cad2';
    if (d > 0) return d >= 15 ? '#1a9850' : d >= 5 ? '#66bd63' : '#c7e9b4';
    if (d < 0) return d <= -15 ? '#d73027' : d <= -5 ? '#f46d43' : '#fddbc7';
    return '#e6ebf0';
  }
  function analysisTable() {
    const C = window.RW2RIPCycle;
    const st = C && C.get();
    const ready = C && C.hasData() && C.park() === state.park;
    if (!ready) {
      const loading = st && st.loading && st.park === state.park;
      const err = st && st.error && st.park === state.park;
      return { total: 0, shown: 0, html:
        '<div style="padding:36px 22px;text-align:center;color:#5b6673;font:14px system-ui">'
        + (err ? '<div style="color:#c0392b;margin-bottom:10px">Cycle 7 load failed: ' + esc(st.error) + '</div><button id="rip-anal-load" style="border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:9px 16px;cursor:pointer;font-weight:700">Retry</button>'
          : loading ? '<div style="font-size:15px;font-weight:700;color:#12233b;margin-bottom:6px">Loading Cycle 7…</div>Fetching the live EFLHD-RIP data for ' + esc(state.park) + '.'
          : '<div style="font-size:15px;font-weight:700;color:#12233b;margin-bottom:6px">Cycle-over-cycle analysis</div>Compare Cycle 6 vs the live Cycle 7 collection.<br><br><button id="rip-anal-load" style="border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:9px 16px;cursor:pointer;font-weight:700">Load Cycle 7 for ' + esc(state.park) + '</button>')
        + '</div>' };
    }

    const metric = state.analMetric, res = state.analRes;
    let rows = analysisRows();
    // sort: default biggest change first (|Δ| desc), else by chosen column
    const sk = state.sort.key, dir = state.sort.dir;
    rows.sort((a, b) => {
      const get = (r) => sk === 'route' ? r.sec.route_id : sk === 'mp' ? r.begMp
        : sk === 'c6' ? r.c6 : sk === 'c7' ? r.c7 : r.d;
      if (state.sort.key === 'ROUTE_IDENT') { // default → biggest movers first
        const am = a.d == null ? -1 : Math.abs(a.d), bm = b.d == null ? -1 : Math.abs(b.d);
        return bm - am || a.sec.route_id.localeCompare(b.sec.route_id) || a.begMp - b.begMp;
      }
      let x = get(a), y = get(b); const xn = x == null, yn = y == null;
      if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
      return typeof x === 'number' ? (x - y) * dir : String(x).localeCompare(String(y)) * dir;
    });

    // summary over units that have both cycles
    const both = rows.filter((r) => r.d != null);
    const imp = both.filter((r) => r.d > 0).length, dec = both.filter((r) => r.d < 0).length, same = both.filter((r) => r.d === 0).length;
    const meanD = both.length ? both.reduce((s, r) => s + r.d, 0) / both.length : null;
    const routeIds = [...new Set(rows.map((r) => r.sec.route_id))];
    const cov = C.coverage(routeIds);
    const noC7 = rows.filter((r) => !r.hasC7).length;

    const stat = (label, val, color) => '<div style="flex:1;min-width:96px;background:#f7f9fb;border:1px solid #eef1f4;border-radius:9px;padding:9px 11px">'
      + '<div style="font-size:11px;color:#8a949f;text-transform:uppercase;letter-spacing:.4px">' + label + '</div>'
      + '<div style="font-size:18px;font-weight:800;color:' + (color || '#12233b') + '">' + val + '</div></div>';
    const summary = '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px">'
      + stat('Mean Δ ' + meta(metric).l, meanD == null ? '—' : (meanD > 0 ? '+' : '') + meanD.toFixed(1), meanD == null ? '#8a949f' : meanD >= 0 ? '#0e7c66' : '#c0392b')
      + stat('Improved', imp, '#0e7c66') + stat('Declined', dec, '#c0392b') + stat('Unchanged', same)
      + stat('Compared', both.length + ' / ' + rows.length)
      + stat('Routes w/ C7', cov.routesWithC7 + ' / ' + cov.totalRoutes, cov.routesWithC7 < cov.totalRoutes ? '#b26a00' : '#0e7c66')
      + '</div>';

    const shown = rows.slice(0, state.limit);
    const dcell = (v, isDelta) => {
      if (v == null) return '<td style="padding:5px 9px;text-align:right;color:#c3cad2">—</td>';
      const bg = isDelta ? deltaColor(v) : cellColor(metric, v);
      // 0.02 mi is a raw segment value (integer); route and 0.1 mi are means.
      const dec = res !== 0.02;
      const txt = isDelta ? ((v > 0 ? '+' : '') + v.toFixed(dec ? 1 : 0)) : (dec ? Number(v).toFixed(1) : v);
      if (isDelta) return '<td style="padding:5px 9px;text-align:right;font-variant-numeric:tabular-nums"><span style="display:inline-block;min-width:34px;text-align:center;background:' + bg + ';color:#12233b;border-radius:5px;padding:1px 6px;font-weight:700">' + txt + '</span></td>';
      return '<td style="padding:5px 9px;text-align:right;font-variant-numeric:tabular-nums"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + (bg || '#c3cad2') + ';margin-right:6px;vertical-align:middle"></span>' + esc(txt) + '</td>';
    };
    const body = shown.map((r) => '<tr data-detail="' + esc(r.sec.id) + '" data-seg="' + (r.begMp != null && res === 0.02 ? r.begMp : '') + '" style="border-bottom:1px solid #f2f5f8;cursor:pointer">'
      + '<td style="padding:5px 9px;font:700 12px \'IBM Plex Mono\',monospace;color:#0B3D66;white-space:nowrap">' + esc(r.sec.route_id) + '</td>'
      + '<td style="padding:5px 9px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.sec.name) + '</td>'
      + '<td style="padding:5px 9px;text-align:right;font:12px \'IBM Plex Mono\',monospace;color:#5b6673;white-space:nowrap">' + r.begMp.toFixed(2) + '–' + r.endMp.toFixed(2) + '</td>'
      + dcell(r.c6, false) + dcell(r.c7, false) + dcell(r.d, true)
      + '<td style="padding:5px 9px" data-nodetail="1"><button data-pw-seg="' + esc(r.sec.id) + '|' + (r.begMp != null ? r.begMp : '') + '" title="PathWeb" style="border:0;background:transparent;cursor:pointer;font-size:13px">📷</button></td>'
      + '</tr>').join('');
    const aTh = (k, l, r) => '<th data-asort="' + k + '" style="position:sticky;top:0;background:#f7f9fb;z-index:1;text-align:' + (r ? 'right' : 'left') + ';padding:7px 9px;border-bottom:1px solid #e3e8ee;cursor:pointer;font:700 11.5px system-ui;color:#12233b;white-space:nowrap">' + l + (state.sort.key === k ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
    const table = '<table style="width:100%;border-collapse:collapse;font:13px system-ui"><thead><tr>'
      + aTh('route', 'Route ID') + aTh('name', 'Name') + aTh('mp', 'MP', 1)
      + aTh('c6', 'C6 ' + meta(metric).l, 1) + aTh('c7', 'C7 ' + meta(metric).l, 1) + aTh('d', 'Δ', 1)
      + '<th style="position:sticky;top:0;background:#f7f9fb;border-bottom:1px solid #e3e8ee;width:30px"></th>'
      + '</tr></thead><tbody>' + body + '</tbody></table>';
    return { total: rows.length, shown: shown.length, html: summary + table,
      note: noC7 ? (noC7.toLocaleString() + ' unit' + (noC7 === 1 ? '' : 's') + ' on routes not yet collected in Cycle 7') : '' };
  }

  function render() {
    const host = $('mod-rip'); if (!host) return;
    if (!state.bundle) {
      host.innerHTML = '<div style="max-width:640px;margin:0 auto;padding:60px 20px;text-align:center;font-family:system-ui">'
        + '<div style="font-size:42px">🛣</div><div style="font-size:19px;font-weight:800;color:#12233b;margin-top:8px">No RIP park loaded</div>'
        + '<div style="color:#5b6673;margin:8px 0 18px;font-size:13.5px">Import an NPS RIP Cycle 6 park to review its inventory and 0.02 mi condition data.</div>'
        + '<button id="rip-import-btn" style="border:0;background:#1a73e8;color:#fff;border-radius:10px;padding:11px 20px;cursor:pointer;font-weight:700;font-size:14px">Import a park…</button></div>';
      const b = $('rip-import-btn'); if (b) b.onclick = () => window.RW2RIPImport && window.RW2RIPImport.show();
      return;
    }

    if (state.cycle === 'c7' || state.tab === 'analysis') ensureC7();

    const secs = ripSections();
    const inScope = secs.filter((s) => s.in_scope).length;
    const metrics = availableMetrics();
    if (!metrics.includes(state.metric)) state.metric = metrics[0] || 'PCR';

    let tbl;
    if (state.tab === 'conditions') tbl = conditionsTable();
    else if (state.tab === 'geometry') tbl = geometryTable();
    else if (state.tab === 'analysis') tbl = analysisTable();
    else if (state.tab === 'custom') tbl = customTable();
    else tbl = assetsTable();

    const showFilters = state.tab !== 'custom' && state.tab !== 'analysis';
    const unit = state.tab === 'conditions' ? 'segments' : 'routes';

    // Cycle selector state (drives the Conditions tab data source).
    const C = window.RW2RIPCycle, cst = C && C.get();
    const c7loaded = C && C.hasData() && C.park() === state.park;
    const c7loading = cst && cst.loading && cst.park === state.park;
    const c7err = cst && cst.error && cst.park === state.park;
    const cov = c7loaded ? C.coverage([...state.segsByRoute.keys()]) : null;
    const cycBtn = (c, l) => '<button data-cycle="' + c + '" style="border:1px solid ' + (state.cycle === c ? '#0B3D66' : '#cfd6dd')
      + ';background:' + (state.cycle === c ? '#0B3D66' : '#fff') + ';color:' + (state.cycle === c ? '#fff' : '#33414f')
      + ';padding:4px 12px;border-radius:7px;cursor:pointer;font:600 12px system-ui">' + l + '</button>';
    const cycleRow = '<div style="display:flex;gap:7px;align-items:center;margin-top:9px;flex-wrap:wrap">'
      + '<span style="font-size:12px;color:#8a949f">Condition data</span>' + cycBtn('c6', 'Cycle 6') + cycBtn('c7', 'Cycle 7')
      + (state.cycle === 'c7' ? (
        c7loading ? '<span style="font-size:12px;color:#b26a00">Loading Cycle 7…</span>'
          : c7err ? '<span style="font-size:12px;color:#c0392b">Cycle 7 error</span> <button data-cycle-refresh="1" style="border:1px solid #d3dae1;background:#fff;border-radius:7px;padding:2px 9px;cursor:pointer;font:600 11px system-ui;color:#5b6673">Retry</button>'
            : c7loaded ? '<span style="font-size:12px;color:' + (cov.routesWithC7 < cov.totalRoutes ? '#b26a00' : '#0e7c66') + '">' + cov.routesWithC7 + ' of ' + cov.totalRoutes + ' routes collected</span> <button data-cycle-refresh="1" style="border:1px solid #d3dae1;background:#fff;border-radius:7px;padding:2px 9px;cursor:pointer;font:600 11px system-ui;color:#5b6673">↻ Refresh</button>'
              : '') : '')
      + '</div>';

    host.innerHTML =
      '<div style="max-width:1240px;margin:0 auto;padding:16px 16px 40px;font-family:system-ui">'

      + '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px">'
      + '<div><div style="font-size:12px;color:#8a949f;text-transform:uppercase;letter-spacing:.6px">RIP Cycle ' + esc(state.bundle.cycle) + '</div>'
      + '<div style="font-size:24px;font-weight:800;color:#12233b;line-height:1.1">' + esc(state.park)
      + ' <span style="font-size:14px;font-weight:600;color:#8a949f">' + esc((state.bundle.states || []).join(', ')) + '</span></div>'
      + '<div style="font-size:13px;color:#5b6673;margin-top:3px">' + secs.length + ' routes &amp; lots · '
      + state.segments.length.toLocaleString() + ' segments at 0.02 mi · <b style="color:#0e7c66">' + inScope + '</b> in scope</div>'
      + cycleRow + '</div>'
      + '<div style="display:flex;gap:8px">'
      + '<button id="rip-btn-import" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font-weight:600;color:#12233b">Import park…</button>'
      + '<button id="rip-btn-map" style="border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font-weight:600">🗺 Map</button></div></div>'

      + (showFilters ?
        '<div style="background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:11px 13px;margin-bottom:12px">'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
        + '<input id="rip-q" value="' + esc(state.q) + '" placeholder="Search route ID, name, FMSS…" style="flex:1;min-width:180px;border:1px solid #d3dae1;border-radius:8px;padding:6px 10px;font:13px system-ui">'
        + chip('All', state.kind === 'all', 'data-kind="all"') + chip('Roads', state.kind === 'road', 'data-kind="road"') + chip('Lots', state.kind === 'lot', 'data-kind="lot"')
        + '<span style="width:1px;height:20px;background:#e3e8ee"></span>'
        + chip('Any scope', state.scope === 'all', 'data-scope-f="all"') + chip('In scope', state.scope === 'in', 'data-scope-f="in"') + chip('Out', state.scope === 'out', 'data-scope-f="out"')
        + '</div>'
        + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:9px">'
        + facetOptions()
        + '<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#5b6673">Metric<select id="rip-metric" style="border:1px solid #d3dae1;border-radius:8px;padding:4px 7px;font:12.5px system-ui;background:#fff">'
        + metrics.map((k) => '<option value="' + k + '"' + (k === state.metric ? ' selected' : '') + '>' + esc(meta(k).l) + '</option>').join('') + '</select></label>'
        + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#5b6673">between <input id="rip-min" value="' + esc(state.range.min) + '" placeholder="min" style="width:56px;border:1px solid #d3dae1;border-radius:7px;padding:4px 6px;font:12.5px system-ui"> and <input id="rip-max" value="' + esc(state.range.max) + '" placeholder="max" style="width:56px;border:1px solid #d3dae1;border-radius:7px;padding:4px 6px;font:12.5px system-ui"></label>'
        + '<button id="rip-clear" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12.5px system-ui;color:#5b6673">Clear</button></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px;padding-top:9px;border-top:1px solid #f2f5f8">'
        + '<span style="font-size:12px;color:#5b6673">Filtered <b>' + tbl.total.toLocaleString() + '</b> ' + unit + ' —</span>'
        + '<button id="rip-scope-in" style="border:0;background:#0e7c66;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12.5px system-ui">Set in scope</button>'
        + '<button id="rip-scope-out" style="border:1px solid #d3dae1;background:#fff;color:#12233b;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12.5px system-ui">Set out of scope</button>'
        + (state.tab === 'conditions' ? '<span style="font-size:11.5px;color:#8a949f">(applies to the routes behind these segments)</span>' : '')
        + '</div></div>'
        : '')

      + '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px">'
      + '<div style="display:flex;gap:6px">' + TABS.map(([t, l]) =>
        '<button data-tab="' + t + '" style="border:1px solid #e3e8ee;border-bottom:1px solid ' + (state.tab === t ? '#fff' : '#e3e8ee') + ';background:'
        + (state.tab === t ? '#fff' : '#eef1f4') + ';color:#12233b;border-radius:10px 10px 0 0;padding:8px 15px;cursor:pointer;font:700 13px system-ui;position:relative;top:1px">' + l + '</button>').join('') + '</div>'
      + '<div style="display:flex;gap:6px;padding-bottom:5px;align-items:center">'
      + (state.tab === 'analysis' ? '<span style="font-size:12px;color:#8a949f">Metric</span>'
          + '<select id="rip-anal-metric" style="border:1px solid #d3dae1;border-radius:8px;padding:4px 7px;font:12.5px system-ui;background:#fff">'
          + CYCLE_METRICS.map((k) => '<option value="' + k + '"' + (k === state.analMetric ? ' selected' : '') + '>' + esc(meta(k).l) + '</option>').join('') + '</select>'
          + '<span style="font-size:12px;color:#8a949f;margin-left:4px">By</span>'
          + ['route', 0.1, 0.02].map((r) => {
            const on = state.analRes === r;
            return '<button data-anal-res="' + r + '" style="border:1px solid ' + (on ? '#0B3D66' : '#cfd6dd')
              + ';background:' + (on ? '#0B3D66' : '#fff') + ';color:' + (on ? '#fff' : '#33414f')
              + ';padding:4px 9px;border-radius:7px;cursor:pointer;font:600 11.5px system-ui">'
              + (r === 'route' ? 'Route' : r + ' mi') + '</button>';
          }).join('') : '')
      + (state.tab === 'conditions' ? '<button id="rip-expand-all" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12px system-ui;color:#12233b">Expand all</button>'
          + '<button id="rip-collapse-all" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12px system-ui;color:#12233b">Collapse all</button>' : '')
      + (state.tab === 'custom' ? '<button id="rip-cust-add" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12px system-ui;color:#12233b">+ Field</button>' : '')
      + ((state.tab === 'assets' || state.tab === 'conditions') ? '<button id="rip-cols-btn" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12px system-ui;color:#12233b">Columns ▾</button>' : '')
      + (state.tab !== 'custom' ? '<button id="rip-csv" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12px system-ui;color:#12233b">⬇ CSV</button>' : '')
      + '</div></div>'

      + '<div style="background:#fff;border:1px solid #e3e8ee;border-radius:0 12px 12px 12px;overflow:hidden">'
      + '<div style="max-height:60vh;overflow:auto">' + tbl.html + '</div>'
      + (tbl.total !== undefined ?
        '<div style="padding:9px 13px;border-top:1px solid #eef1f4;display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#5b6673">'
        + '<span>Showing <b>' + tbl.shown.toLocaleString() + '</b> of <b>' + tbl.total.toLocaleString() + '</b>' + (tbl.unit ? ' ' + tbl.unit : '') + (tbl.note ? ' · <span style="color:#b26a00">' + esc(tbl.note) + '</span>' : '') + '</span>'
        + (tbl.shown < tbl.total ? '<button id="rip-more" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 13px;cursor:pointer;font:600 12.5px system-ui;color:#12233b">Show more</button>' : '<span style="color:#b8c0c8">end of list</span>')
        + '</div>' : '')
      + '</div></div>';

    wire(host);
  }

  // ---- wiring -----------------------------------------------------------
  function wire(host) {
    const set = (fn) => { fn(); state.limit = PAGE; render(); };
    const q = $('rip-q');
    if (q) q.oninput = (e) => { state.q = e.target.value; state.limit = PAGE; const at = e.target.selectionStart; render(); const n = $('rip-q'); if (n) { n.focus(); n.setSelectionRange(at, at); } };
    host.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => set(() => { state.kind = b.dataset.kind; }));
    host.querySelectorAll('[data-scope-f]').forEach((b) => b.onclick = () => set(() => { state.scope = b.dataset.scopeF; }));
    host.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => set(() => { state.tab = b.dataset.tab; }));
    host.querySelectorAll('[data-facet]').forEach((s) => s.onchange = () => set(() => { state.facets[s.dataset.facet] = s.value; }));
    host.querySelectorAll('[data-sort]').forEach((h) => h.onclick = () => set(() => {
      const k = h.dataset.sort; if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: 1 };
    }));
    const met = $('rip-metric'); if (met) met.onchange = () => set(() => { state.metric = met.value; });
    const mn = $('rip-min'); if (mn) mn.onchange = () => set(() => { state.range.min = mn.value.trim(); });
    const mx = $('rip-max'); if (mx) mx.onchange = () => set(() => { state.range.max = mx.value.trim(); });
    const clr = $('rip-clear'); if (clr) clr.onclick = () => set(() => { state.q = ''; state.kind = 'all'; state.scope = 'all'; state.facets = {}; state.range = { min: '', max: '' }; });
    const more = $('rip-more'); if (more) more.onclick = () => { state.limit += PAGE; render(); };
    const si = $('rip-scope-in'); if (si) si.onclick = () => setFilteredScope(true);
    const so = $('rip-scope-out'); if (so) so.onclick = () => setFilteredScope(false);
    const imp = $('rip-btn-import'); if (imp) imp.onclick = () => window.RW2RIPImport && window.RW2RIPImport.show();
    const mp = $('rip-btn-map'); if (mp) mp.onclick = () => { if (RW().openMap) RW().openMap(); else if (window.showModule) window.showModule('map'); };
    const cols = $('rip-cols-btn'); if (cols) cols.onclick = () => colChooser(cols);
    const csv = $('rip-csv'); if (csv) csv.onclick = exportCSV;
    const add = $('rip-cust-add'); if (add) add.onclick = addCustomField;
    const exAll = $('rip-expand-all'); if (exAll) exAll.onclick = () => {
      const g = new Map();
      for (const r of filteredConditions()) g.set(r.sec.id, 1);
      state.expanded = new Set(g.keys()); state.limit = PAGE; render();
    };
    const colAll = $('rip-collapse-all'); if (colAll) colAll.onclick = () => { state.expanded.clear(); state.limit = PAGE; render(); };

    // cycle selector + Cycle-7 refresh
    host.querySelectorAll('[data-cycle]').forEach((b) => b.onclick = () => set(() => { state.cycle = b.dataset.cycle; }));
    const cyR = host.querySelector('[data-cycle-refresh]');
    if (cyR) cyR.onclick = () => { if (window.RW2RIPCycle) window.RW2RIPCycle.loadPark(state.park, { refresh: true, onchange: () => render() }); render(); };
    // analysis controls
    const am = $('rip-anal-metric'); if (am) am.onchange = () => set(() => { state.analMetric = am.value; });
    host.querySelectorAll('[data-anal-res]').forEach((b) => b.onclick = () => set(() => {
      const r = b.dataset.analRes;
      state.analRes = r === 'route' ? 'route' : Number(r);
    }));
    host.querySelectorAll('[data-asort]').forEach((h) => h.onclick = () => set(() => {
      const k = h.dataset.asort; if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: 1 };
    }));
    const aLoad = $('rip-anal-load'); if (aLoad) aLoad.onclick = () => { if (window.RW2RIPCycle) window.RW2RIPCycle.loadPark(state.park, { refresh: true, onchange: () => render() }); render(); };
    host.querySelectorAll('[data-pw-seg]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const [id, mp] = b.dataset.pwSeg.split('|');
      const sec = sections().find((s) => s.id === id); if (!sec || !window.RW2Pathweb) return;
      const seg = (state.segsByRoute.get(sec.route_id) || []).find((x) => x.BEG_MP === Number(mp));
      if (seg) window.RW2Pathweb.openSegment(seg, sec); else window.RW2Pathweb.openRoute(sec, state.segsByRoute.get(sec.route_id) || []);
    });

    host.querySelectorAll('[data-exp]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('[data-nodetail]')) return;
      const id = tr.dataset.exp;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      render();
    });

    host.querySelectorAll('[data-scope]').forEach((cb) => cb.onchange = (e) => {
      e.stopPropagation();
      const sec = sections().find((s) => s.id === cb.dataset.scope); if (!sec) return;
      sec.in_scope = cb.checked;
      if (RW().persistSections) RW().persistSections();
      if (RW().rerender) RW().rerender();
      render();
    });
    host.querySelectorAll('[data-goto]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      if (RW().showView) RW().showView('field', b.dataset.goto);
      if (window.showModule) window.showModule('map');
    });
    host.querySelectorAll('[data-pw]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const sec = sections().find((s) => s.id === b.dataset.pw); if (!sec || !window.RW2Pathweb) return;
      window.RW2Pathweb.openRoute(sec, state.segsByRoute.get(sec.route_id) || []);
    });
    host.querySelectorAll('[data-detail]').forEach((tr) => tr.onclick = (e) => {
      if (e.target.closest('[data-nodetail]') || e.target.tagName === 'INPUT') return;
      const sec = sections().find((s) => s.id === tr.dataset.detail);
      if (sec) openDetail(sec, tr.dataset.seg);
    });
    // custom-field editing
    host.querySelectorAll('[data-cust-val]').forEach((inp) => inp.onchange = () => {
      const [id, key] = inp.dataset.custVal.split('|');
      const sec = sections().find((s) => s.id === id); if (!sec) return;
      if (!sec.rip_custom) sec.rip_custom = {};
      if (inp.value.trim() === '') delete sec.rip_custom[key]; else sec.rip_custom[key] = inp.value;
      if (RW().persistSections) RW().persistSections();
    });
    host.querySelectorAll('[data-cust-del]').forEach((b) => b.onclick = () => {
      const key = b.dataset.custDel;
      if (!confirm('Remove custom field “' + (state.custom.find((c) => c.key === key) || {}).label + '”? Values already entered are cleared.')) return;
      state.custom = state.custom.filter((c) => c.key !== key);
      sections().forEach((s) => { if (s.rip_custom) delete s.rip_custom[key]; });
      save(); if (RW().persistSections) RW().persistSections(); render();
    });
  }

  function addCustomField() {
    const label = prompt('New custom field name (becomes a column + CSV header):', '');
    if (label === null) return;
    const clean = label.trim(); if (!clean) return;
    const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || ('f' + state.custom.length);
    if (state.custom.some((c) => c.key === key)) { alert('A field with that name already exists.'); return; }
    state.custom.push({ key, label: clean });
    save(); render();
  }

  // ---- boot -------------------------------------------------------------
  document.getElementById('app-tabs')?.addEventListener('click', (e) => {
    if (e.target.closest('.app-tab[data-module="rip"]')) setTimeout(render, 0);
  });
  restore().then(render);

  window.RW2RIP = {
    state, attach, render, save,
    show: () => { if (window.showModule) window.showModule('rip'); render(); },
    segmentsFor: (rid) => state.segsByRoute.get(rid) || [],
    METRICS, LOT_METRICS, BAND,
    // RIP condition band colours (shared with the map bands)
    scoreColor, iriColor,
    bandColor: (metric, v) => (metric === 'IRI' ? iriColor(v) : scoreColor(v)),
    legend: (metric) => (metric === 'IRI' ? IRI_LEGEND : SCORE_LEGEND),
    metric: () => state.metric, hasPark: () => !!state.bundle,
  };
})();
