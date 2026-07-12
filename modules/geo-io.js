/* =========================================================================
 * geo-io.js — GeoJSON export / import of the OPEN park's sections as AECOM
 * features.
 *
 * Export: every section of the open park → one GeoJSON Feature. A parking lot
 * becomes a single Polygon whose rings are [outer, hole1, …] (center islands
 * are holes), a road becomes a LineString. Edited lots carry aecom_edited:true;
 * un-edited sections export too (their AECOM geometry == the NPS original).
 *
 * Import: a matching feature (by route_id, else id/name) REPLACES that
 * section's geometry (outer + holes, recomputed area); unmatched features are
 * added as new AECOM sections. Coordinates are GeoJSON [lng,lat]; sections are
 * [lat,lng], so both directions swap.
 * ========================================================================= */
(function () {
  'use strict';

  const FORMAT = 'roadwalk2-aecom-geojson-v1';
  const sections = () => (window._RW && window._RW.SECTIONS) || [];
  function activeUnit() {
    const a = window.RW2Library && window.RW2Library.getActive && window.RW2Library.getActive();
    if (a) return String(a).toUpperCase();
    for (const s of sections()) { const m = /^([A-Za-z]+)/.exec(s.id || ''); if (m) return m[1].toUpperCase(); }
    return null;
  }

  // ---- geometry helpers (rings are [lat,lng]) ---------------------------
  const sameLL = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const openRing = (r) => (r.length > 1 && sameLL(r[0], r[r.length - 1]) ? r.slice(0, -1) : r.slice());
  const closeRing = (r) => (r.length && !sameLL(r[0], r[r.length - 1]) ? r.concat([r[0]]) : r.slice());
  // signed area with x=lng,y=lat; >0 ⇒ CCW
  function signed(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[1] * b[0] - b[1] * a[0]; } return s / 2; }
  const orient = (r, wantCCW) => ((signed(r) > 0) === wantCCW ? r : r.slice().reverse());
  // area in sq ft (shoelace on equirectangular ft), ring [lat,lng]
  function ringAreaSqFt(r) {
    if (!r || r.length < 3) return 0;
    const cosLat = Math.cos((r[0][0]) * Math.PI / 180);
    let s = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += (a[1] * cosLat * 364000) * (b[0] * 364000) - (b[1] * cosLat * 364000) * (a[0] * 364000); }
    return Math.abs(s) / 2;
  }
  const areaOf = (outer, holes) => Math.max(0, Math.round(ringAreaSqFt(outer) - (holes || []).reduce((a, h) => a + ringAreaSqFt(h), 0)));
  const toLngLat = (r) => r.map((p) => [p[1], p[0]]);   // [lat,lng] → [lng,lat]
  const toLatLng = (r) => r.map((p) => [p[1], p[0]]);   // [lng,lat] → [lat,lng]

  // ---- export -----------------------------------------------------------
  function toFeature(sec) {
    const isArea = sec.type === 'area';
    const props = {
      id: sec.id, name: sec.name || sec.id, route_id: sec.route_id || '',
      faclocid: sec.faclocid || '', unit: activeUnit(), kind: isArea ? 'lot' : 'road',
      in_scope: !!sec.in_scope, area_sqft: sec.area_sqft || null,
      scope_name: sec.scope_name || '', source: 'AECOM',
      aecom_edited: !!(sec.aecom_edited || (sec.holes && sec.holes.length)),
    };
    let geometry;
    if (isArea && Array.isArray(sec.alignment) && sec.alignment.length >= 3) {
      const rings = [closeRing(orient(sec.alignment, true))]
        .concat((sec.holes || []).map((h) => closeRing(orient(h, false))));
      geometry = { type: 'Polygon', coordinates: rings.map(toLngLat) };
    } else {
      geometry = { type: 'LineString', coordinates: toLngLat(sec.alignment || []) };
    }
    return { type: 'Feature', id: sec.id, properties: props, geometry };
  }

  function exportGeoJSON() {
    const unit = activeUnit();
    const S = sections();
    if (!S.length) { toast('No park open to export', true); return; }
    const fc = {
      type: 'FeatureCollection', _format: FORMAT, unit,
      exported_at: new Date().toISOString(),
      features: S.map(toFeature),
    };
    const blob = new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${unit || 'park'}_sections_AECOM.geojson`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    const edited = S.filter((s) => s.aecom_edited || (s.holes && s.holes.length)).length;
    toast(`Exported ${S.length} features (${edited} edited)`);
  }

  // ---- import -----------------------------------------------------------
  function ringsFromGeom(g) {
    // → { area:bool, outer:[latlng], holes:[[latlng]], line:[latlng] }
    if (!g) return null;
    if (g.type === 'Polygon' && g.coordinates.length) {
      return { area: true, outer: openRing(toLatLng(g.coordinates[0])), holes: g.coordinates.slice(1).map((r) => openRing(toLatLng(r))) };
    }
    if (g.type === 'MultiPolygon' && g.coordinates.length) {
      const first = g.coordinates[0];
      return { area: true, outer: openRing(toLatLng(first[0])), holes: first.slice(1).map((r) => openRing(toLatLng(r))), multi: g.coordinates.length > 1 };
    }
    if (g.type === 'LineString') return { area: false, line: toLatLng(g.coordinates) };
    if (g.type === 'MultiLineString' && g.coordinates.length) return { area: false, line: toLatLng(g.coordinates[0]), multi: g.coordinates.length > 1 };
    return null;
  }

  function matchSection(props, featId) {
    const S = sections();
    const rid = props.route_id;
    if (rid) { const m = S.find((s) => s.route_id === rid); if (m) return m; }
    const id = props.id || featId;
    if (id) { const m = S.find((s) => s.id === id); if (m) return m; }
    const nm = props.name;
    if (nm) { const m = S.find((s) => (s.name || '') === nm); if (m) return m; }
    return null;
  }

  function importGeoJSON(fc) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('Not a GeoJSON FeatureCollection');
    const S = sections();
    const unit = activeUnit();
    const rep = { replaced: [], added: [], skipped: [], multiWarn: 0 };
    let seq = 1;
    for (const f of fc.features) {
      const props = f.properties || {};
      const rg = ringsFromGeom(f.geometry);
      if (!rg) { rep.skipped.push(props.name || props.id || '(no geometry)'); continue; }
      if (rg.multi) rep.multiWarn++;
      const target = matchSection(props, f.id);
      if (target) {
        if (rg.area) {
          target.type = 'area';
          target.alignment = rg.outer; target.holes = rg.holes;
          target.area_sqft = areaOf(rg.outer, rg.holes);
        } else {
          target.type = 'linear'; target.alignment = rg.line; target.holes = [];
        }
        if (props.route_id) target.route_id = props.route_id;
        if (typeof props.in_scope === 'boolean') target.in_scope = props.in_scope;
        target.aecom_edited = true;
        rep.replaced.push(target.id);
      } else {
        const id = props.id || `${unit || 'AECOM'}-AECOM-${String(seq++).padStart(3, '0')}`;
        const outer = rg.area ? rg.outer : rg.line;
        const mid = outer[Math.floor(outer.length / 2)] || null;
        const nu = {
          id, name: props.name || id, type: rg.area ? 'area' : 'linear', status: 'prog',
          alignment: rg.area ? rg.outer : rg.line, holes: rg.area ? rg.holes : [],
          area_sqft: rg.area ? areaOf(rg.outer, rg.holes) : null,
          center: mid, route_id: props.route_id || '', faclocid: props.faclocid || '',
          in_scope: !!props.in_scope, scope_name: props.scope_name || '',
          src_name: props.name || id, source: 'AECOM', _userAdded: true, aecom_edited: true,
          featureCount: 0, pins: [],
        };
        S.push(nu);
        rep.added.push(id);
      }
    }
    if (window._RW.persistSections) window._RW.persistSections();
    if (window._RW.rerender) window._RW.rerender();
    return rep;
  }

  // ---- panel ------------------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-geoio');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-geoio';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:480px;width:94%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
           <b>GeoJSON — AECOM shapes</b><span id="rw2-geoio-x" style="cursor:pointer;font-size:20px">×</span>
         </div>
         <div id="rw2-geoio-body" style="padding:14px;overflow:auto"></div>
         <div style="padding:10px 14px;border-top:1px solid #e3e8ee;display:flex;gap:8px">
           <button id="rw2-geoio-export" style="flex:1;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:600;background:#1a73e8;color:#fff">⭳ Export park</button>
           <button id="rw2-geoio-import" style="flex:1;padding:10px;border:1px solid #b7cdec;border-radius:9px;cursor:pointer;font-weight:600;background:#f6f8fa;color:#12233b">⭱ Import…</button>
         </div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
    ov.querySelector('#rw2-geoio-x').onclick = hide;
    ov.querySelector('#rw2-geoio-export').onclick = () => { exportGeoJSON(); };
    ov.querySelector('#rw2-geoio-import').onclick = () => fileInput.click();
    return ov;
  }
  function hide() { const ov = document.getElementById('rw2-geoio'); if (ov) ov.style.display = 'none'; }
  function show() { ensurePanel(); render(); document.getElementById('rw2-geoio').style.display = 'flex'; }
  function render(rep) {
    const b = document.getElementById('rw2-geoio-body'); if (!b) return;
    const unit = activeUnit(); const S = sections();
    const lots = S.filter((s) => s.type === 'area').length, roads = S.length - lots;
    const edited = S.filter((s) => s.aecom_edited || (s.holes && s.holes.length)).length;
    let html = unit
      ? `<div style="font-size:13px;color:#12233b"><b>${unit}</b> — ${S.length} features (${lots} lots · ${roads} roads · <b>${edited}</b> AECOM-edited)</div>
         <div style="font-size:12px;color:#5b6673;margin-top:6px">Export writes one GeoJSON <code>${unit}_sections_AECOM.geojson</code>; lots with cut islands export as a Polygon with holes.</div>`
      : `<div style="color:#b26a00;font-size:13px">Open a park first.</div>`;
    if (rep) {
      const row = (label, arr) => arr.length ? `<div style="font-size:12px;margin-top:3px"><b>${label}:</b> ${arr.length}${arr.length <= 12 ? ' · ' + arr.join(', ') : ''}</div>` : '';
      html += `<div style="margin-top:12px;border-top:1px solid #e3e8ee;padding-top:10px">
          ${row('Replaced', rep.replaced)}${row('Added new', rep.added)}${row('Skipped', rep.skipped)}
          ${rep.multiWarn ? `<div style="font-size:12px;color:#b26a00;margin-top:3px">${rep.multiWarn} multi-part feature(s) used first part only.</div>` : ''}</div>`;
    }
    b.innerHTML = html;
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.geojson,.json'; fileInput.style.display = 'none';
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const rep = importGeoJSON(JSON.parse(await f.text())); render(rep); toast(`Imported: ${rep.replaced.length} replaced, ${rep.added.length} added`); }
    catch (err) { toast('Import failed: ' + err.message, true); }
  });
  (document.body || document.documentElement).appendChild(fileInput);

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
  }
  function mount() {
    if (document.getElementById('rw2-geoio-btn')) return;
    const anchor = document.getElementById('rw2-spins-btn') || document.getElementById('rw2-scope-btn') || document.getElementById('rw2-import-park');
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-geoio-btn'; btn.className = anchor.className; btn.textContent = 'GEOJSON';
    btn.addEventListener('click', show);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200); setTimeout(mount, 700);

  window.RW2GeoIO = { exportGeoJSON, importGeoJSON, toFeature, show };
})();
