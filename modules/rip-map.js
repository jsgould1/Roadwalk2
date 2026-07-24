/* =========================================================================
 * rip-map.js — condition colouring on the map for an imported RIP park.
 *
 * Collapsed to a single icon button on the map's left stack (a quartered
 * circle in the official condition colours) so it never covers the imagery;
 * clicking it opens the panel.
 *
 * Shows either a VALUE (Cycle 6 or Cycle 7) or the CHANGE between cycles:
 *   - roads    0.02 mi segments, or an 0.1 mi length-weighted rollup, drawn
 *              along the centerline
 *   - parking  lot polygons (PCR only — Cycle 6 lots carry no per-index data)
 * Cycle 7 has no geometry of its own; it is matched onto Cycle 6 geometry by
 * ROUTE_IDENT + BEG_MP, which is valid because both use the same 0.02 mi grid.
 *
 * Hovering any band or lot shows a Cycle 6 / Cycle 7 / Change comparison.
 *
 * Performance for a park like BLRI (26k segments): zoom-gated, viewport-culled
 * by per-band bbox, and capped at a fixed number of drawn paths.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const getMap = () => (RW().getMap ? RW().getMap() : null);
  const RIP = () => window.RW2RIP;
  const CYC = () => window.RW2RIPCycle;

  const MINZOOM = { 0.1: 12, 0.02: 14 };
  const MAXPATHS = 6000;
  const PANE = 'ripBands';
  // Bands render ABOVE overlayPane (400) so the black section outlines don't
  // sit on top of and dull the colour, but below markerPane (600) so route
  // labels stay readable over them.
  const PANE_Z = 450;
  const NO_DATA_FILL = '#c3c8cd';   // lots with no rating for the chosen cycle

  // Metrics offered. `k` is the Cycle 6 field name; Cycle 7 is mapped to the
  // same keys by rip-cycle.js. Parking only has PCR.
  const METRICS = [
    { k: 'PCR', l: 'PCR', kind: 'score', parking: true },
    { k: 'SC_INDEX', l: 'Surface', kind: 'score' },
    { k: 'AC_INDEX', l: 'Alligator', kind: 'score' },
    { k: 'LC_INDEX', l: 'Longitudinal', kind: 'score' },
    { k: 'TC_INDEX', l: 'Transverse', kind: 'score' },
    { k: 'PATCH_INDEX', l: 'Patching', kind: 'score' },
    { k: 'RUT_INDEX', l: 'Rutting', kind: 'score' },
    { k: 'RCI', l: 'Roughness (RCI)', kind: 'score' },
    { k: 'IRI_AVG', l: 'IRI (C6 only)', kind: 'iri' },
  ];
  const metricDef = (k) => METRICS.find((m) => m.k === k) || METRICS[0];
  // Metrics shown in the hover comparison table.
  const HOVER_METRICS = ['PCR', 'SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX', 'RUT_INDEX', 'RCI'];

  const state = {
    open: false, mode: 'off',            // off | value | change
    cycle: 'c6', metric: 'PCR', res: 0.1,
    roads: true, parking: true,
    opacity: 0.85,                       // user-adjustable in the panel
    capped: false, cache: {}, cachePark: null, scaleMax: 20,
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- colours ----------------------------------------------------------
  const FALLBACK = { excellent: '#0072b2', good: '#1b9e77', fair: '#e69f00', poor: '#c51b7d' };
  function scoreColor(v) {
    if (RIP() && RIP().scoreColor) return RIP().scoreColor(v);
    if (v == null || isNaN(v)) return null;
    return v >= 95 ? FALLBACK.excellent : v >= 85 ? FALLBACK.good : v >= 61 ? FALLBACK.fair : FALLBACK.poor;
  }
  function iriColor(v) {
    if (RIP() && RIP().iriColor) return RIP().iriColor(v);
    if (v == null || isNaN(v)) return null;
    return v < 60 ? FALLBACK.excellent : v < 95 ? FALLBACK.good : v < 135 ? FALLBACK.fair : FALLBACK.poor;
  }
  function valueColor(v) { return metricDef(state.metric).kind === 'iri' ? iriColor(v) : scoreColor(v); }
  // Diverging green↔red for change, scaled to the data actually on screen.
  function changeColor(d, max) {
    if (d == null || isNaN(d)) return null;
    const m = Math.max(5, max || state.scaleMax);
    const t = Math.max(-1, Math.min(1, d / m));
    const mix = (a, b, f) => a.map((x, i) => Math.round(x + (b[i] - x) * f));
    const base = [242, 244, 246];
    const rgb = t >= 0 ? mix(base, [12, 120, 60], t) : mix(base, [200, 30, 30], -t);
    return 'rgb(' + rgb.join(',') + ')';
  }

  // ---- values -----------------------------------------------------------
  const c7Ready = () => CYC() && CYC().hasData() && CYC().park() === (RIP() && RIP().state.park);

  // Both cycles are keyed by route + 0.02 mi milepost bin, so a value can be
  // looked up per cycle regardless of which cycle's geometry drew the band.
  const mpKey = (rid, mp) => rid + '|' + Math.round((mp || 0) * 50);
  let _c6Key = null, _c6KeyPark = null;
  function c6Index() {
    const park = RIP().state.park;
    if (_c6Key && _c6KeyPark === park) return _c6Key;
    _c6Key = new Map(); _c6KeyPark = park;
    for (const s of RIP().state.segments) _c6Key.set(mpKey(s.ROUTE_IDENT, s.BEG_MP), s);
    return _c6Key;
  }
  const c6Seg = (rid, mp) => c6Index().get(mpKey(rid, mp)) || null;
  const c7Seg = (rid, mp) => (c7Ready() ? CYC().matchSeg(rid, mp) : null);

  function segValues(routeIdent, begMp, _ignored, metricKey) {
    const k = metricKey || state.metric;
    const a = c6Seg(routeIdent, begMp), b = c7Seg(routeIdent, begMp);
    const c6 = a ? a[k] : null, c7 = b ? b[k] : null;
    return { c6: c6 == null ? null : c6, c7: c7 == null ? null : c7,
      d: (c6 != null && c7 != null) ? (c7 - c6) : null };
  }
  function lotValues(sec, metricKey) {
    const k = metricKey || state.metric;
    const c6 = (sec.rip || {})[k];
    let c7 = null;
    if (c7Ready() && k === 'PCR') { const m = CYC().matchLot(sec.route_id); c7 = m ? m.PCR : null; }
    return { c6: c6 == null ? null : c6, c7, d: (c6 != null && c7 != null) ? (c7 - c6) : null };
  }
  // Which number drives the colour, given the current mode/cycle.
  function shown(v) {
    if (state.mode === 'change') return v.d;
    return state.cycle === 'c7' ? v.c7 : v.c6;
  }
  function colorOf(v, max) {
    const n = shown(v);
    return state.mode === 'change' ? changeColor(n, max) : valueColor(n);
  }

  // ---- band geometry cache ---------------------------------------------
  function toBand(parts, meta) {
    const out = [], box = [90, 180, -90, -180];
    for (const flat of parts) {
      const pts = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const lat = flat[i + 1], lng = flat[i];
        pts.push([lat, lng]);
        if (lat < box[0]) box[0] = lat; if (lng < box[1]) box[1] = lng;
        if (lat > box[2]) box[2] = lat; if (lng > box[3]) box[3] = lng;
      }
      if (pts.length >= 2) out.push(pts);
    }
    return out.length ? Object.assign({ parts: out, box }, meta) : null;
  }
  // Which cycle's linework to draw. Cycle 7 is the most recent survey, so it
  // wins whenever it has been fetched with geometry; Cycle 6 (the geodatabase)
  // is the fallback and covers routes Cycle 7 hasn't collected yet.
  function geomSource() {
    return (c7Ready() && CYC().hasGeometry()) ? 'c7' : 'c6';
  }
  function sourceSegments(src) {
    if (src === 'c7') return (CYC().get().all || []).filter((s) => s._g);
    return RIP().state.segments;
  }
  function build02(src) {
    const bands = [];
    for (const s of sourceSegments(src)) {
      if (!s._g) continue;
      const b = toBand(s._g, { rid: s.ROUTE_IDENT, begMp: s.BEG_MP, endMp: s.END_MP, src });
      if (b) bands.push(b);
    }
    return bands;
  }
  function build10(src) {
    const byRoute = new Map();
    for (const s of sourceSegments(src)) {
      if (!s._g) continue;
      let a = byRoute.get(s.ROUTE_IDENT);
      if (!a) byRoute.set(s.ROUTE_IDENT, a = []);
      a.push(s);
    }
    const bands = [];
    byRoute.forEach((segs, rid) => {
      segs.sort((x, y) => (x.BEG_MP || 0) - (y.BEG_MP || 0));
      let bin = null, key = null;
      const flush = () => {
        if (!bin || !bin.flat.length) { bin = null; return; }
        // mpList (not the segment objects) so each cycle's value can be looked
        // up independently of whose geometry built the band.
        const b = toBand(bin.flat, { rid, begMp: bin.begMp, endMp: bin.endMp, mpList: bin.mpList, src });
        if (b) bands.push(b);
        bin = null;
      };
      for (const s of segs) {
        const k = Math.floor((s.BEG_MP || 0) / 0.1 + 1e-6);
        if (k !== key) { flush(); key = k; bin = { flat: [], mpList: [], begMp: k * 0.1, endMp: k * 0.1 + 0.1 }; }
        for (const flat of s._g) bin.flat.push(flat);
        bin.mpList.push(s.BEG_MP);
      }
      flush();
    });
    return bands;
  }
  function bandsFor(res, src) {
    const park = RIP().state.park;
    src = src || geomSource();
    if (state.cachePark !== park) { state.cache = {}; state.cachePark = park; _c6Key = null; }
    const ck = res + '|' + src;
    if (!state.cache[ck]) state.cache[ck] = res === 0.02 ? build02(src) : build10(src);
    return state.cache[ck];
  }
  // Length-weighted mean of a metric across a 0.1 mi band, per cycle.
  function meanOf(rid, mpList, key, side) {
    let sum = 0, w = 0;
    for (const mp of mpList) {
      const s = side === 'c7' ? c7Seg(rid, mp) : c6Seg(rid, mp);
      if (!s) continue;
      const v = s[key];
      if (v != null) { const len = s.INT_LENGTH || 105.6; sum += v * len; w += len; }
    }
    return w ? sum / w : null;
  }
  function bandValues(band, metricKey) {
    const k = metricKey || state.metric;
    if (band.mpList) {
      const c6 = meanOf(band.rid, band.mpList, k, 'c6');
      const c7 = meanOf(band.rid, band.mpList, k, 'c7');
      return { c6, c7, d: (c6 != null && c7 != null) ? (c7 - c6) : null };
    }
    return segValues(band.rid, band.begMp, null, k);
  }

  // ---- hover comparison -------------------------------------------------
  let hoverEl = null;
  function hoverBox() {
    if (hoverEl) return hoverEl;
    hoverEl = document.createElement('div');
    hoverEl.id = 'rip-hover';
    hoverEl.style.cssText = 'position:fixed;z-index:99997;pointer-events:none;display:none;'
      + 'background:rgba(255,255,255,.98);border:1px solid #cfd6dd;border-radius:10px;'
      + 'box-shadow:0 6px 22px rgba(15,25,45,.25);padding:9px 11px;font-family:system-ui;min-width:210px';
    document.body.appendChild(hoverEl);
    return hoverEl;
  }
  function cmpTable(title, sub, rows) {
    const dTxt = (d) => d == null ? '—' : (d > 0 ? '+' : '') + (Math.abs(d) < 10 ? d.toFixed(1) : d.toFixed(0));
    return '<div style="font:700 12px \'IBM Plex Mono\',monospace;color:#0B3D66">' + esc(title) + '</div>'
      + (sub ? '<div style="font-size:11.5px;color:#8a949f;margin-bottom:6px">' + esc(sub) + '</div>' : '')
      + '<table style="width:100%;border-collapse:collapse;font:12px system-ui">'
      + '<tr><th style="text-align:left;padding:2px 6px 3px 0;color:#8a949f;font-weight:600"></th>'
      + '<th style="text-align:right;padding:2px 6px 3px;color:#8a949f;font-weight:700">C6</th>'
      + '<th style="text-align:right;padding:2px 6px 3px;color:#8a949f;font-weight:700">C7</th>'
      + '<th style="text-align:right;padding:2px 0 3px 6px;color:#8a949f;font-weight:700">Δ</th></tr>'
      + rows.map(([label, v]) => {
        const dc = v.d == null ? '#c3cad2' : v.d > 0 ? '#0e7c66' : v.d < 0 ? '#c0392b' : '#5b6673';
        const dot = (x, kind) => x == null ? '<span style="color:#c3cad2">—</span>'
          : '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'
            + ((kind === 'iri' ? iriColor(x) : scoreColor(x)) || '#c3cad2') + ';margin-right:5px;vertical-align:middle"></span>'
            + (Math.abs(x) < 10 ? Number(x).toFixed(1) : Math.round(x));
        return '<tr><td style="padding:2px 6px 2px 0;color:#3a4653;white-space:nowrap">' + esc(label) + '</td>'
          + '<td style="text-align:right;padding:2px 6px;font-variant-numeric:tabular-nums">' + dot(v.c6) + '</td>'
          + '<td style="text-align:right;padding:2px 6px;font-variant-numeric:tabular-nums">' + dot(v.c7) + '</td>'
          + '<td style="text-align:right;padding:2px 0 2px 6px;font-weight:700;color:' + dc + ';font-variant-numeric:tabular-nums">' + dTxt(v.d) + '</td></tr>';
      }).join('') + '</table>';
  }
  function placeHover(ev) {
    const el = hoverEl; if (!el || el.style.display === 'none') return;
    const oe = ev && ev.originalEvent;
    const x = oe ? oe.clientX : 40, y = oe ? oe.clientY : 40;
    const w = el.offsetWidth || 230, h = el.offsetHeight || 140;
    el.style.left = Math.min(window.innerWidth - w - 10, x + 16) + 'px';
    el.style.top = Math.max(8, Math.min(window.innerHeight - h - 10, y - h / 2)) + 'px';
  }
  // Building the comparison table is expensive (every metric, both cycles), so
  // it happens once on mouseover; mousemove only repositions the box. Doing the
  // rebuild per mousemove locked the page on dense parks.
  function showHover(html, ev) {
    const el = hoverBox();
    el.innerHTML = html;
    el.style.display = 'block';
    placeHover(ev);
  }
  const hideHover = () => { if (hoverEl) hoverEl.style.display = 'none'; };

  // Cached per band, invalidated whenever a redraw changes what's shown.
  function bandHover(band) {
    if (band._hov && band._hov.v === state.hoverVer) return band._hov.html;
    const rows = HOVER_METRICS.map((k) => [metricDef(k).l, bandValues(band, k)]);
    const iri = bandValues(band, 'IRI_AVG');
    if (iri.c6 != null || iri.c7 != null) rows.push(['IRI', iri]);
    const html = cmpTable(band.rid, band.begMp.toFixed(2) + '–' + band.endMp.toFixed(2) + ' mi'
      + (band.mpList ? '  (0.1 mi mean of ' + band.mpList.length + ')' : '')
      + '  · ' + (band.src === 'c7' ? 'C7 geometry' : 'C6 geometry'), rows);
    band._hov = { v: state.hoverVer, html };
    return html;
  }
  function lotHover(sec) {
    return cmpTable(sec.route_id || sec.name, (sec.name || '') + ' · parking',
      [['PCR', lotValues(sec, 'PCR')]]);
  }

  // ---- draw -------------------------------------------------------------
  let layer = null;
  function clear() { const m = getMap(); if (layer && m) { try { m.removeLayer(layer); } catch (_) {} } layer = null; hideHover(); }

  function draw() {
    const m = getMap(), R = RIP();
    if (!m || !R || !R.hasPark()) { clear(); paint(); return; }
    if (!m.getPane(PANE)) { m.createPane(PANE); }
    m.getPane(PANE).style.zIndex = PANE_Z;
    clear();
    state.capped = false;
    state.gated = false;
    state.hoverVer = (state.hoverVer || 0) + 1;   // invalidate cached hover tables
    if (state.mode === 'off') { paint(); return; }
    // Cycle 7 / change need the live data. Guard against re-entry: loadPark's
    // onchange calls draw() again, so only kick one off when nothing is in
    // flight for this park.
    if ((state.cycle === 'c7' || state.mode === 'change') && CYC() && !c7Ready()) {
      const cst = CYC().get();
      if (!(cst && cst.loading && cst.park === R.state.park)) {
        CYC().loadPark(R.state.park, { onchange: () => { draw(); } });
      }
    }

    const zoom = m.getZoom();
    // Zoom-gated: mark it so the keep-alive interval doesn't retry every second.
    if (state.roads && zoom < MINZOOM[state.res]) { state.gated = true; paint(); return; }
    const b = m.getBounds().pad(0.25);
    const bs = b.getSouth(), bw = b.getWest(), bn = b.getNorth(), be = b.getEast();
    layer = L.layerGroup([], { pane: PANE });
    let n = 0;

    // --- roads
    if (state.roads && zoom >= MINZOOM[state.res]) {
      const all = bandsFor(state.res);
      const vis = [];
      for (const band of all) {
        const x = band.box;
        if (x[0] > bn || x[2] < bs || x[1] > be || x[3] < bw) continue;
        vis.push(band);
      }
      // Change mode: scale the diverging ramp to what's on screen. Use the 90th
      // percentile of |Δ|, not the max — a single reconstruction (e.g. +97) would
      // otherwise compress every ordinary change into a near-colourless tint.
      // Outliers simply saturate at the ends. Clamped to a sane 10–50 window.
      let max = 20;
      if (state.mode === 'change') {
        const ds = [];
        for (const band of vis) { const d = bandValues(band).d; if (d != null) ds.push(Math.abs(d)); }
        ds.sort((a, b) => a - b);
        const p90 = ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))] : 0;
        max = Math.max(10, Math.min(50, Math.ceil(p90 / 5) * 5)); state.scaleMax = max;
      }
      for (const band of vis) {
        const v = bandValues(band);
        const col = colorOf(v, max);
        if (!col) continue;
        for (const pts of band.parts) {
          const pl = L.polyline(pts, { pane: PANE, color: col, weight: 6, opacity: state.opacity,
            lineCap: 'butt', interactive: true, bubblingMouseEvents: false });
          pl.on('mouseover', (e) => showHover(bandHover(band), e));
          pl.on('mousemove', placeHover);
          pl.on('mouseout', hideHover);
          pl.addTo(layer);
          if (++n >= MAXPATHS) { state.capped = true; break; }
        }
        if (state.capped) break;
      }
    }

    // --- parking (PCR only; lots carry no per-index data in Cycle 6)
    if (state.parking && !state.capped) {
      const lots = (RW().SECTIONS || []).filter((s) => s.rip && s.type === 'area' && Array.isArray(s.alignment) && s.alignment.length > 2);
      for (const sec of lots) {
        const v = lotValues(sec, 'PCR');
        const num = state.mode === 'change' ? v.d : (state.cycle === 'c7' ? v.c7 : v.c6);
        // A lot with no rating for the chosen cycle still gets drawn, in light
        // grey — "not rated" is information, and an unfilled lot just looks
        // like a lot we forgot. (Common in Cycle 7, which is still collecting.)
        const col = (state.mode === 'change' ? changeColor(num, state.scaleMax) : scoreColor(num)) || NO_DATA_FILL;
        const rings = (sec.holes && sec.holes.length) ? [sec.alignment].concat(sec.holes) : sec.alignment;
        const pg = L.polygon(rings, { pane: PANE, color: col, weight: 2, fillColor: col,
          fillOpacity: state.opacity * 0.8, opacity: Math.min(1, state.opacity + 0.15),
          interactive: true, bubblingMouseEvents: false });
        pg.on('mouseover', (e) => showHover(lotHover(sec), e));
        pg.on('mousemove', placeHover);
        pg.on('mouseout', hideHover);
        pg.addTo(layer);
        if (++n >= MAXPATHS) { state.capped = true; break; }
      }
    }

    layer.addTo(m);
    paint();
  }

  function ensureWired() {
    const m = getMap();
    if (!m || m._ripWired) return;
    m._ripWired = true;
    m.on('moveend zoomend', () => { if (state.mode !== 'off') draw(); });
    m.on('mouseout', hideHover);
  }

  // ---- control ----------------------------------------------------------
  // Quartered circle in the official condition colours.
  const ICON = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">'
    + '<path d="M12 12 L12 2 A10 10 0 0 1 22 12 Z" fill="#0072b2"/>'
    + '<path d="M12 12 L22 12 A10 10 0 0 1 12 22 Z" fill="#1b9e77"/>'
    + '<path d="M12 12 L12 22 A10 10 0 0 1 2 12 Z" fill="#e69f00"/>'
    + '<path d="M12 12 L2 12 A10 10 0 0 1 12 2 Z" fill="#c51b7d"/>'
    + '<circle cx="12" cy="12" r="10" fill="none" stroke="#fff" stroke-width="1.5"/></svg>';

  const seg = (label, active, attr) =>
    '<button ' + attr + ' style="border:1px solid ' + (active ? '#0B3D66' : '#cfd6dd') + ';background:'
    + (active ? '#0B3D66' : '#fff') + ';color:' + (active ? '#fff' : '#33414f')
    + ';padding:4px 9px;border-radius:7px;cursor:pointer;font:600 11.5px system-ui">' + label + '</button>';

  // Live inside the map's own left button stack, directly below Layers, using
  // its .map-ctl-btn styling. (Floating over the stack meant the stack's own
  // container swallowed the clicks.) The panel opens beside it exactly like
  // .layers-panel does.
  function mount() {
    const stack = document.getElementById('fp-left-stack');
    const layersBtn = document.getElementById('layers-toggle-btn');
    if (!stack || !layersBtn) return null;
    let btn = document.getElementById('rip-band-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'rip-band-btn';
      btn.className = 'map-ctl-btn';
      btn.type = 'button';
      btn.title = 'Condition colours';
      btn.innerHTML = ICON;
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.open = !state.open; paint();
      });
      layersBtn.insertAdjacentElement('afterend', btn);
    }
    let panel = document.getElementById('rip-band-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'rip-band-panel';
      // Clear of the 48px "+ Add Feature" button (which is wider than the 34px
      // stack and protrudes), so the panel doesn't sit under it.
      panel.style.cssText = 'position:absolute;left:60px;z-index:640;'
        + 'background:var(--paper,#fff);border:1px solid var(--rule,#cfd6dd);border-radius:10px;'
        + 'box-shadow:0 2px 10px rgba(0,0,0,.18);padding:10px 12px;font-family:system-ui;'
        + 'width:232px;display:none;pointer-events:auto';
      stack.appendChild(panel);
    }
    return btn;
  }

  // Render the button badge + panel contents.
  function paint() {
    const R = RIP();
    const btn = document.getElementById('rip-band-btn');
    const panel = document.getElementById('rip-band-panel');
    if (!btn || !panel) return;
    const havePark = R && R.hasPark();
    btn.style.display = havePark ? 'flex' : 'none';
    if (!havePark) { panel.style.display = 'none'; return; }
    // active-state ring on the button
    btn.style.borderColor = state.mode === 'off' ? '#cfd6dd' : '#0B3D66';
    btn.style.boxShadow = state.mode === 'off' ? '0 2px 8px rgba(20,35,60,.22)' : '0 0 0 2px #0B3D66, 0 2px 8px rgba(20,35,60,.22)';
    panel.style.display = state.open ? 'block' : 'none';
    if (!state.open) return;

    const m = getMap(), zoom = m ? m.getZoom() : 0;
    const gated = state.mode !== 'off' && state.roads && zoom < MINZOOM[state.res];
    const c7 = c7Ready();
    // The keep-alive interval calls paint() every second; rebuilding the panel
    // that often fights any control the user is mid-interaction with (the
    // opacity slider especially), so only rebuild when something actually changed.
    const sig = [state.mode, state.cycle, state.metric, state.res, state.roads, state.parking,
      state.opacity, state.capped, gated, c7, state.scaleMax, zoom].join('|');
    if (sig === state._sig) return;
    state._sig = sig;

    const badge = state.mode === 'off' ? ['Off', '#8a949f', '#eef1f4']
      : state.mode === 'change' ? ['Change C6 → C7', '#fff', '#6a3d9a']
        : state.cycle === 'c7' ? ['Cycle 7 data', '#fff', '#0B3D66'] : ['Cycle 6 data', '#fff', '#0e7c66'];

    let legend = '';
    if (state.mode === 'value') {
      const L2 = (RIP().legend ? RIP().legend(metricDef(state.metric).kind === 'iri' ? 'IRI' : 'PCR') : []);
      legend = '<div style="font:600 10.5px system-ui;color:#8a949f;margin:8px 0 4px">' + esc(metricDef(state.metric).l) + '</div>'
        + L2.map(([lab, c]) => '<div style="display:flex;align-items:center;gap:6px;font:11px system-ui;color:#3a4653;line-height:1.5">'
          + '<span style="display:inline-block;width:14px;height:9px;border-radius:2px;background:' + c + '"></span>' + lab + '</div>').join('')
        + (state.parking ? '<div style="display:flex;align-items:center;gap:6px;font:11px system-ui;color:#3a4653;line-height:1.5">'
          + '<span style="display:inline-block;width:14px;height:9px;border-radius:2px;background:' + NO_DATA_FILL + '"></span>not rated</div>' : '');
    } else if (state.mode === 'change') {
      const mx = state.scaleMax;
      const stops = [-mx, -mx / 2, 0, mx / 2, mx];
      legend = '<div style="font:600 10.5px system-ui;color:#8a949f;margin:8px 0 4px">Δ ' + esc(metricDef(state.metric).l) + ' (C7 − C6)</div>'
        + '<div style="display:flex;height:11px;border-radius:3px;overflow:hidden;border:1px solid #e3e8ee">'
        + stops.map((s) => '<span style="flex:1;background:' + changeColor(s, mx) + '"></span>').join('') + '</div>'
        + '<div style="display:flex;justify-content:space-between;font:10.5px system-ui;color:#5b6673;margin-top:2px">'
        + '<span>−' + mx + '</span><span>0</span><span>+' + mx + '</span></div>'
        + '<div style="font:10.5px system-ui;color:#8a949f;margin-top:3px">red = declined · green = improved</div>';
    }

    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">'
      + '<span style="font:700 11px system-ui;text-transform:uppercase;letter-spacing:.5px;color:#0B3D66">Condition</span>'
      + '<button id="rip-band-close" style="border:0;background:#eef1f4;border-radius:6px;width:20px;height:20px;cursor:pointer;font-size:12px;line-height:1;color:#5b6673">✕</button></div>'
      + '<div style="display:inline-block;background:' + badge[2] + ';color:' + badge[1] + ';border-radius:6px;padding:2px 8px;font:700 10.5px system-ui;margin-bottom:8px">' + badge[0] + '</div>'
      + '<div style="display:flex;gap:4px;margin-bottom:6px">'
      + seg('Off', state.mode === 'off', 'data-mode="off"') + seg('Value', state.mode === 'value', 'data-mode="value"') + seg('Change', state.mode === 'change', 'data-mode="change"')
      + '</div>'
      + (state.mode === 'value' ? '<div style="display:flex;gap:4px;margin-bottom:6px">'
          + seg('Cycle 6', state.cycle === 'c6', 'data-cyc="c6"') + seg('Cycle 7', state.cycle === 'c7', 'data-cyc="c7"') + '</div>' : '')
      + (state.mode !== 'off' ?
        '<select id="rip-band-metric" style="width:100%;border:1px solid #d3dae1;border-radius:8px;padding:5px 7px;font:12px system-ui;background:#fff;margin-bottom:6px">'
        + METRICS.filter((mm) => state.mode !== 'change' || mm.kind !== 'iri')
          .map((mm) => '<option value="' + mm.k + '"' + (mm.k === state.metric ? ' selected' : '') + '>' + esc(mm.l) + '</option>').join('')
        + '</select>'
        + '<div style="display:flex;gap:4px;align-items:center;margin-bottom:6px"><span style="font:11px system-ui;color:#8a949f">Every</span>'
        + seg('0.1 mi', state.res === 0.1, 'data-res="0.1"') + seg('0.02 mi', state.res === 0.02, 'data-res="0.02"') + '</div>'
        + '<div style="display:flex;gap:10px;font:11.5px system-ui;color:#3a4653;margin-bottom:4px">'
        + '<label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" id="rip-band-roads"' + (state.roads ? ' checked' : '') + '>Roads</label>'
        + '<label style="display:flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" id="rip-band-parking"' + (state.parking ? ' checked' : '') + '>Parking</label></div>'
        + '<div style="display:flex;gap:6px;align-items:center">'
        + '<span style="font:11px system-ui;color:#8a949f">Opacity</span>'
        + '<input type="range" id="rip-band-opacity" min="15" max="100" step="5" value="' + Math.round(state.opacity * 100) + '" style="flex:1;min-width:0">'
        + '<span id="rip-band-op-val" style="font:11px system-ui;color:#5b6673;width:30px;text-align:right">' + Math.round(state.opacity * 100) + '%</span></div>'
        : '')
      + ((state.mode !== 'off' && (state.cycle === 'c7' || state.mode === 'change') && !c7) ? '<div style="font:11px system-ui;color:#b26a00;margin-top:5px">Loading Cycle 7…</div>' : '')
      + (gated ? '<div style="font:11px system-ui;color:#b26a00;margin-top:5px">Zoom in to show ' + state.res + ' mi bands</div>' : '')
      + (state.capped ? '<div style="font:11px system-ui;color:#b26a00;margin-top:5px">Too many to draw — zoom in</div>' : '')
      + legend
      + (state.mode !== 'off' && state.parking && state.metric !== 'PCR' ? '<div style="font:10.5px system-ui;color:#8a949f;margin-top:6px">Parking has PCR only</div>' : '')
      + '<div style="font:10.5px system-ui;color:#8a949f;margin-top:6px">Hover a band or lot for C6 / C7 / Δ</div>';

    const $ = (id) => document.getElementById(id);
    $('rip-band-close').onclick = () => { state.open = false; paint(); };
    panel.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { state.mode = b.dataset.mode; draw(); });
    panel.querySelectorAll('[data-cyc]').forEach((b) => b.onclick = () => { state.cycle = b.dataset.cyc; draw(); });
    panel.querySelectorAll('[data-res]').forEach((b) => b.onclick = () => { state.res = Number(b.dataset.res); draw(); });
    const ms = $('rip-band-metric'); if (ms) ms.onchange = () => { state.metric = ms.value; draw(); };
    const rd = $('rip-band-roads'); if (rd) rd.onchange = () => { state.roads = rd.checked; draw(); };
    const pk = $('rip-band-parking'); if (pk) pk.onchange = () => { state.parking = pk.checked; draw(); };
    const op = $('rip-band-opacity');
    if (op) {
      // Live % readout while dragging; redraw on release so a long drag over a
      // dense park doesn't rebuild thousands of paths per pixel.
      op.oninput = () => { const v = $('rip-band-op-val'); if (v) v.textContent = op.value + '%'; };
      op.onchange = () => { state.opacity = Number(op.value) / 100; draw(); };
    }
  }

  // ---- boot -------------------------------------------------------------
  setInterval(() => {
    const R = RIP();
    if (!R || !R.hasPark()) {
      const b = document.getElementById('rip-band-btn'); if (b) b.style.display = 'none';
      const p = document.getElementById('rip-band-panel'); if (p) p.style.display = 'none';
      return;
    }
    if (mount()) { ensureWired(); paint(); }
    if (state.mode !== 'off' && getMap() && !layer && !state.gated) draw();
  }, 1000);

  window.RW2RIPMap = {
    draw, paint, state,
    setMode: (m) => { state.mode = m; draw(); },
    setMetric: (k) => { state.metric = k; draw(); },
    setCycle: (c) => { state.cycle = c; draw(); },
    setRes: (r) => { state.res = Number(r); draw(); },
    scoreColor, iriColor, changeColor, valueColor,
    _build: { build02, build10, bandsFor, bandValues, segValues, lotValues, bandHover, lotHover, cmpTable },
  };
})();
