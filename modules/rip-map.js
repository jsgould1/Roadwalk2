/* =========================================================================
 * rip-map.js — condition colour bands on the map for an imported RIP park.
 *
 * Draws the 0.02 mi (or aggregated 0.1 mi) condition segments as coloured
 * bands along the route centerlines, toggled between PCR (PCI-style 0-100)
 * and IRI (measured roughness). A floating control on the map switches
 * metric and resolution.
 *
 * Performance: a big park has 26k segments, so bands are
 *   - zoom-gated (nothing below a per-resolution minimum zoom),
 *   - viewport-culled (only segments whose bbox meets the padded view), and
 *   - hard-capped, with the control saying when the cap bit.
 * The 0.1 mi view is AGGREGATED from the 0.02 mi data (5 sub-segments,
 * length-weighted mean) — it is a display simplification, not NPS's own
 * 0.1 mi values, which were dropped as redundant to the 0.02 mi layer.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const getMap = () => (RW().getMap ? RW().getMap() : null);
  const RIP = () => window.RW2RIP;

  const MINZOOM = { 0.1: 12, 0.02: 14 };
  const MAXPATHS = 8000;   // cap on Leaflet polylines drawn per render, so a
                           // 0.1 mi band's ~5 parts count individually
  const PANE = 'ripBands';

  const state = { metric: null, res: 0.1, capped: false, cache: {}, cachePark: null };

  // ---- colour scales ----------------------------------------------------
  // PCI-style 7-band scale for PCR (0-100, higher is better).
  function pcrColor(v) {
    if (v == null || isNaN(v)) return null;
    return v >= 86 ? '#1a9850' : v >= 71 ? '#91cf60' : v >= 56 ? '#d9ef8b'
      : v >= 41 ? '#fee08b' : v >= 26 ? '#fdae61' : v >= 11 ? '#f46d43' : '#d73027';
  }
  // IRI in in/mi (lower is better); thresholds around FHWA good/acceptable/poor.
  function iriColor(v) {
    if (v == null || isNaN(v)) return null;
    return v < 60 ? '#1a9850' : v < 95 ? '#91cf60' : v < 135 ? '#d9ef8b'
      : v < 170 ? '#fee08b' : v < 220 ? '#fdae61' : '#d73027';
  }
  const LEGEND = {
    PCR: [['86–100', '#1a9850'], ['71–85', '#91cf60'], ['56–70', '#d9ef8b'],
          ['41–55', '#fee08b'], ['26–40', '#fdae61'], ['11–25', '#f46d43'], ['0–10', '#d73027']],
    IRI: [['<60', '#1a9850'], ['60–95', '#91cf60'], ['95–135', '#d9ef8b'],
          ['135–170', '#fee08b'], ['170–220', '#fdae61'], ['>220', '#d73027']],
  };
  const colorFor = (metric, v) => (metric === 'IRI' ? iriColor(v) : pcrColor(v));
  const metricVal = (band, metric) => (metric === 'IRI' ? band.iri : band.pcr);

  // ---- band cache -------------------------------------------------------
  // Convert a segment's flat [lng,lat,...] parts to [[lat,lng],...] parts and
  // capture a bbox for culling.
  function toBand(parts, pcr, iri) {
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
    return out.length ? { parts: out, box, pcr, iri } : null;
  }

  function build02() {
    const bands = [];
    for (const s of RIP().state.segments) {
      if (!s._g) continue;
      const b = toBand(s._g, s.PCR != null ? s.PCR : null, s.IRI_AVG != null ? s.IRI_AVG : null);
      if (b) bands.push(b);
    }
    return bands;
  }

  // Aggregate 0.02 mi segments into 0.1 mi bins per route: gather the flat
  // [lng,lat,...] geometry parts of the sub-segments (toBand converts + boxes
  // them, exactly as for 0.02 mi) and take a length-weighted mean of each
  // metric over the sub-segments that have a value.
  function build10() {
    const byRoute = RIP().state.segsByRoute;   // rid -> segments sorted by BEG_MP
    const bands = [];
    byRoute.forEach((segs) => {
      let bin = null, key = null;
      const flush = () => {
        if (!bin || !bin.flat.length) { bin = null; return; }
        const b = toBand(bin.flat, bin.wl ? bin.pcrSum / bin.wl : null, bin.wi ? bin.iriSum / bin.wi : null);
        if (b) bands.push(b);
        bin = null;
      };
      for (const s of segs) {
        if (!s._g) continue;
        const k = Math.floor((s.BEG_MP || 0) / 0.1 + 1e-6);
        if (k !== key) { flush(); key = k; bin = { flat: [], pcrSum: 0, wl: 0, iriSum: 0, wi: 0 }; }
        for (const flat of s._g) bin.flat.push(flat);   // keep raw [lng,lat,...] parts
        const len = s.INT_LENGTH || 105.6;
        if (s.PCR != null) { bin.pcrSum += s.PCR * len; bin.wl += len; }
        if (s.IRI_AVG != null) { bin.iriSum += s.IRI_AVG * len; bin.wi += len; }
      }
      flush();
    });
    return bands;
  }

  function bandsFor(res) {
    if (state.cachePark !== RIP().state.park) { state.cache = {}; state.cachePark = RIP().state.park; }
    if (!state.cache[res]) state.cache[res] = res === 0.02 ? build02() : build10();
    return state.cache[res];
  }

  // ---- draw -------------------------------------------------------------
  let layer = null;
  function clear() { const m = getMap(); if (layer && m) { try { m.removeLayer(layer); } catch (_) {} } layer = null; }

  function draw() {
    const m = getMap();
    const R = RIP();
    if (!m || !R || !R.hasPark()) { clear(); updateControl(); return; }
    if (!m.getPane(PANE)) { m.createPane(PANE); m.getPane(PANE).style.zIndex = 350; }

    clear();
    state.capped = false;
    if (!state.metric) { updateControl(); return; }

    const zoom = m.getZoom();
    if (zoom < MINZOOM[state.res]) { updateControl(); return; }   // too far out — draw nothing

    const bounds = m.getBounds().pad(0.25);
    const bs = bounds.getSouth(), bw = bounds.getWest(), bn = bounds.getNorth(), be = bounds.getEast();
    const all = bandsFor(state.res);
    layer = L.layerGroup([], { pane: PANE });

    let n = 0;
    for (const band of all) {
      const b = band.box;
      if (b[0] > bn || b[2] < bs || b[1] > be || b[3] < bw) continue;   // outside view
      const col = colorFor(state.metric, metricVal(band, state.metric));
      if (!col) continue;                                               // no value → skip
      for (const pts of band.parts) {
        L.polyline(pts, { pane: PANE, color: col, weight: 5, opacity: 0.9, lineCap: 'butt', interactive: false }).addTo(layer);
        if (++n >= MAXPATHS) { state.capped = true; break; }
      }
      if (state.capped) break;
    }
    layer.addTo(m);
    updateControl();
  }

  // redraw on pan/zoom, wiring each map instance once
  function ensureWired() {
    const m = getMap();
    if (!m || m._ripWired) return;
    m._ripWired = true;
    m.on('moveend zoomend', () => { if (state.metric) draw(); });
  }

  // ---- control ----------------------------------------------------------
  function seg(btnLabel, active, attr) {
    return '<button ' + attr + ' style="border:1px solid ' + (active ? '#0B3D66' : '#cfd6dd') + ';background:'
      + (active ? '#0B3D66' : '#fff') + ';color:' + (active ? '#fff' : '#33414f')
      + ';padding:4px 9px;border-radius:7px;cursor:pointer;font:600 11.5px system-ui">' + btnLabel + '</button>';
  }
  function mount() {
    const host = document.getElementById('view-field');
    if (!host) return null;
    let el = document.getElementById('rip-band-ctrl');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rip-band-ctrl';
      el.style.cssText = 'position:absolute;left:12px;bottom:16px;z-index:640;background:rgba(255,255,255,.96);'
        + 'border:1px solid #d3dae1;border-radius:11px;box-shadow:0 3px 14px rgba(20,35,60,.22);'
        + 'padding:9px 11px;font-family:system-ui;max-width:210px';
      host.appendChild(el);
    }
    return el;
  }
  function updateControl() {
    const R = RIP();
    const el = document.getElementById('rip-band-ctrl');
    if (!el) return;
    if (!R || !R.hasPark()) { el.style.display = 'none'; return; }
    el.style.display = '';
    const m = getMap();
    const zoom = m ? m.getZoom() : 0;
    const gated = state.metric && zoom < MINZOOM[state.res];
    const legend = state.metric ? LEGEND[state.metric] : null;

    el.innerHTML =
      '<div style="font:700 11px system-ui;text-transform:uppercase;letter-spacing:.5px;color:#0B3D66;margin-bottom:6px">Condition bands</div>'
      + '<div style="display:flex;gap:4px;margin-bottom:6px">'
      + seg('Off', !state.metric, 'data-m="off"') + seg('PCR', state.metric === 'PCR', 'data-m="PCR"') + seg('IRI', state.metric === 'IRI', 'data-m="IRI"')
      + '</div>'
      + '<div style="display:flex;gap:4px;align-items:center;' + (state.metric ? '' : 'opacity:.45;pointer-events:none') + '">'
      + '<span style="font:600 11px system-ui;color:#8a949f;margin-right:2px">Every</span>'
      + seg('0.1 mi', state.res === 0.1, 'data-r="0.1"') + seg('0.02 mi', state.res === 0.02, 'data-r="0.02"')
      + '</div>'
      + (gated ? '<div style="margin-top:7px;font:12px system-ui;color:#b26a00">Zoom in to show ' + state.res + ' mi bands</div>' : '')
      + (state.capped ? '<div style="margin-top:7px;font:11.5px system-ui;color:#b26a00">Too many to draw here — zoom in to see the rest</div>' : '')
      + (legend && !gated ? '<div style="margin-top:8px;border-top:1px solid #eef1f4;padding-top:7px">'
          + '<div style="font:600 10.5px system-ui;color:#8a949f;margin-bottom:4px">' + (state.metric === 'IRI' ? 'IRI (in/mi)' : 'PCR') + '</div>'
          + legend.map(([lab, c]) => '<div style="display:flex;align-items:center;gap:6px;font:11px system-ui;color:#3a4653;line-height:1.5">'
              + '<span style="display:inline-block;width:14px;height:9px;border-radius:2px;background:' + c + '"></span>' + lab + '</div>').join('')
          + '</div>' : '');

    el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
      state.metric = b.dataset.m === 'off' ? null : b.dataset.m; draw();
    });
    el.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => {
      state.res = Number(b.dataset.r); draw();
    });
  }

  // ---- boot -------------------------------------------------------------
  // Keep the control mounted + the map wired whenever a park is present and the
  // field view exists. Cheap poll, same pattern as the AECOM/CLIENT toggle.
  setInterval(() => {
    const R = RIP();
    if (!R || !R.hasPark()) { const el = document.getElementById('rip-band-ctrl'); if (el) el.style.display = 'none'; return; }
    if (mount()) { ensureWired(); if (!document.getElementById('rip-band-ctrl').dataset.init) { document.getElementById('rip-band-ctrl').dataset.init = '1'; updateControl(); } }
    // first draw once the map exists and a metric is chosen but nothing drawn yet
    if (state.metric && getMap() && !layer) draw();
  }, 1000);

  window.RW2RIPMap = {
    draw, setMetric: (m) => { state.metric = m; draw(); }, setRes: (r) => { state.res = Number(r); draw(); },
    state, pcrColor, iriColor,
    _build: { build02, build10, bandsFor },
  };
})();
