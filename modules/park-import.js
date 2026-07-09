/* =========================================================================
 * park-import.js — Roadwalk2 park importer (Phase 1)
 *
 * Loaded as a classic <script> so it shares global scope with the donor app
 * and the vendored parsers. Reaches the app ONLY through window._RW.loadBundle
 * (the hook added in index.html) — it never touches the app's closure.
 *
 * Pipeline:  dropped shapefile set(s)  →  JSZip  →  shp() [reprojects to WGS84
 *            using the .prj]  →  GeoJSON  →  RoadWalk bundle:
 *              roads (LineString)  → LINEAR sections (auto-station + SLD)
 *              parking (Polygon)   → AREA sections
 *            →  window._RW.loadBundle(bundle)
 *
 * On-device only: nothing leaves the machine (AECOM data restriction).
 * ========================================================================= */
(function () {
  'use strict';

  // ---- attribute helpers -------------------------------------------------
  // NPS parking exports carry authoritative attributes: UNITCODE ("ABLI"),
  // UNITNAME, and MAPLABEL (the lot name). Prefer these over the filename.
  function cleanVal(v) {
    if (v == null) return '';
    const s = String(v).trim();
    return (s === '' || /^<?null>?$/i.test(s)) ? '' : s;   // '', 'NULL', '<Null>' → empty
  }
  // Park identity from a filename: strip the layer/SHP suffix but KEEP any
  // sub-unit qualifier so BLRI_NC and BLRI_VA stay distinct sections.
  //   "BLRI_NC_PARKING" → "BLRI_NC"   "ABLI_PARKING" → "ABLI"   "CAHA_SHP" → "CAHA"
  function unitKeyFromName(name) {
    const stripped = (name || '').replace(/[_\-\s]*(PARKING|PARK|LOTS?|PKG|ROADS?|RDS|CENTERLINES?|CL|SHP)$/i, '');
    return (stripped || name || '').toUpperCase();
  }
  function detectUnit(features, fallback) {
    for (const f of features) {
      const u = cleanVal(f.properties && (f.properties.UNITCODE || f.properties.unitcode || f.properties.UnitCode));
      if (u) return u.toUpperCase();
    }
    return (fallback || 'PARK').toUpperCase();
  }
  function detectUnitName(features) {
    for (const f of features) {
      const n = cleanVal(f.properties && (f.properties.UNITNAME || f.properties.unitname || f.properties.UnitName));
      if (n) return n;
    }
    return 'NPS Park';
  }

  // ---- geometry helpers (coords stay [lng,lat] — bundle convention) ------
  function lineStringsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    if (geom.type === 'Polygon') return [geom.coordinates[0]];          // ring as line, fallback
    return [];
  }
  function polygonRingsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates[0]];
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(p => p[0]);
    return [];
  }
  function nameOf(feature, fallback, i) {
    const p = (feature && feature.properties) || {};
    return cleanVal(p.MAPLABEL) || cleanVal(p.NAME) || cleanVal(p.Name) || cleanVal(p.name) ||
           cleanVal(p.LABEL) || cleanVal(p.LOT_NAME) || cleanVal(p.ROAD_NAME) || `${fallback} ${i}`;
  }
  function pad(n) { return String(n).padStart(3, '0'); }
  // stable-ish unique id per route (persisted in the library bundle)
  function newUid() {
    return (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  // ROUTE_ID (NPS RIP) if the source already carries it, else '' to be assigned
  const routeIdOf = (f) => cleanVal(f && f.properties && (f.properties.ROUTE_ID || f.properties.RouteID || f.properties.route_id));
  // NPS Facility Location ID — shared across segments of the same asset; a
  // precise merge/join key and the likely link to the RIP report.
  const faclocidOf = (f) => cleanVal(f && f.properties && (f.properties.FACLOCID || f.properties.FacLocID || f.properties.faclocid));

  // RIP lookup: { UNITCODE: { FACLOCID(FMSS): {route_id, name, desc_from, ...} } }
  // Parsed from the NPS RIP RouteID PDFs by tools/build_routeids.py. Loaded once;
  // used to auto-assign ROUTE_ID + attach the full RIP record to each route.
  let RIP = {};           // { UNIT: { route_id: record } }  (keyed by ROUTE_ID)
  let RIP_FMSS = {};      // { UNIT: { fmss: [records] } }   (reverse index, real FMSS only)
  function buildFmssIndex() {
    RIP_FMSS = {};
    for (const u in RIP) {
      const idx = RIP_FMSS[u] = {};
      for (const rid in RIP[u]) {
        const rec = RIP[u][rid];
        const f = (rec.fmss || '').trim();
        if (!f || f === '2') continue;                 // skip dummy/blank FMSS (sub-routes)
        (idx[f] = idx[f] || []).push(rec);
      }
    }
  }
  (async () => { try { const r = await fetch('data/_rip/route_ids.json'); if (r.ok) { RIP = await r.json(); buildFmssIndex(); } } catch (_) { /* optional */ } })();
  // Enrich by FACLOCID ONLY when it maps to exactly one route (simple parks like
  // ABLI). Ambiguous/dummy FMSS (sub-route parks like CAHA) return null — those
  // get their specific ROUTE_ID later from the scope spreadsheet's coordinates.
  function ripFor(unit, faclocid) {
    if (!faclocid) return null;
    const idx = RIP_FMSS[unit] || RIP_FMSS[(unit || '').split('_')[0]];   // BLRI_NC → BLRI report
    const hits = idx && idx[faclocid];
    return (hits && hits.length === 1) ? hits[0] : null;
  }

  // ---- scope assignment (in-scope routes from the AECOM scope sheet) ------
  let SCOPE = {};   // { UNIT: { route_id: {section_name, route_name, type, start:[lat,lng], end} } }
  (async () => { try { const r = await fetch('data/_rip/scope.json'); if (r.ok) SCOPE = await r.json(); } catch (_) {} })();
  const ABBR = { ST: 'STREET', RD: 'ROAD', DR: 'DRIVE', AVE: 'AVENUE', AV: 'AVENUE', HWY: 'HIGHWAY', LN: 'LANE', CT: 'COURT', BLVD: 'BOULEVARD', PKWY: 'PARKWAY' };
  function normName(s) {
    s = (s || '').toUpperCase().replace(/^[A-Z]{2}\s+RD\s+/, '');   // strip island prefix "BI RD "
    return s.replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => ABBR[w] || w).join(' ');
  }
  function centroid(ring) {
    let x = 0, y = 0; ring.forEach((c) => { x += c[0]; y += c[1]; });
    return [x / ring.length, y / ring.length];
  }
  // Auto-assign each route to an in-scope route by fuzzy name + coordinate
  // proximity; flag uncertain matches. Enriches route_id + in_scope + rip.
  function applyScope(sections, unit) {
    const sc = SCOPE[unit] || SCOPE[(unit || '').split('_')[0]];
    if (!sc) return;
    const ripU = RIP[unit] || RIP[(unit || '').split('_')[0]] || {};
    const cands = Object.keys(sc).map((rid) => ({ rid, r: sc[rid], nn: normName(sc[rid].route_name) }));
    sections.forEach((sec) => {
      const isRoad = sec.type === 'linear';
      const pool = cands.filter((x) => (x.r.type === 'road') === isRoad);
      if (!pool.length) return;
      const gpts = isRoad ? [sec.alignment[0], sec.alignment[sec.alignment.length - 1]] : [centroid(sec.alignment)];
      const coordDist = (x) => {
        if (!x.r.start) return Infinity;
        const pts = [[x.r.start[1], x.r.start[0]]];
        if (x.r.end) pts.push([x.r.end[1], x.r.end[0]]);
        let best = Infinity;
        for (const g of gpts) for (const p of pts) best = Math.min(best, distFt(g, p));
        return best;
      };
      // Confident matches only: require a normalized NAME match. Coordinates
      // just disambiguate when several in-scope routes share the same name
      // (sub-routes). No coord-only fallback — that over-matched on dense parks;
      // unmatched routes are left for the manual confirm step instead.
      const nn = normName(sec.name);
      const nameHits = nn ? pool.filter((x) => x.nn === nn) : [];
      let chosen = null, flagged = false;
      if (nameHits.length === 1) { chosen = nameHits[0]; }
      else if (nameHits.length > 1) { chosen = nameHits.slice().sort((a, b) => coordDist(a) - coordDist(b))[0]; flagged = coordDist(chosen) > 500; }
      if (chosen) {
        sec.route_id = chosen.rid;
        sec.in_scope = true;
        sec.scope_name = chosen.r.route_name;
        sec.scope_section = chosen.r.section_name;
        sec.scope_flag = flagged;
        if (ripU[chosen.rid]) sec.rip = ripU[chosen.rid];
      }
    });
  }

  // geodesic polygon area (WGS84 ring [lng,lat]) → square feet
  function ringAreaSqFt(ring) {
    const R = 6378137; let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [lng1, lat1] = ring[i], [lng2, lat2] = ring[(i + 1) % ring.length];
      a += (lng2 - lng1) * Math.PI / 180 * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
    }
    return Math.abs(a * R * R / 2) * 10.76391; // m² → ft²
  }

  // rough length in miles (equirectangular; fine at park scale) for mp_end display
  function lengthMiles(coords) {
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lng1, lat1] = coords[i - 1], [lng2, lat2] = coords[i];
      const latMid = (lat1 + lat2) / 2 * Math.PI / 180;
      const dx = (lng2 - lng1) * Math.cos(latMid) * 69.172;
      const dy = (lat2 - lat1) * 69.172;
      m += Math.sqrt(dx * dx + dy * dy);
    }
    return m;
  }

  // ---- route merge engine (chain connected road segments) ---------------
  const MERGE_TOL_FT = 40;   // endpoint snap tolerance for "connected"
  function distFt(a, b) {
    const latm = (a[1] + b[1]) / 2 * Math.PI / 180;
    const dx = (b[0] - a[0]) * Math.cos(latm) * 364567;
    const dy = (b[1] - a[1]) * 364567;
    return Math.hypot(dx, dy);
  }
  // greedily chain segments that share endpoints (within tolerance), flipping
  // as needed so they join head-to-tail. Returns [{coords, members:[seg]}].
  function chainSegments(segs) {
    const used = new Set(), chains = [];
    for (const seed of segs) {
      if (used.has(seed.uid)) continue;
      used.add(seed.uid);
      let coords = seed.alignment.slice();
      const members = [seed];
      let extended = true;
      while (extended) {
        extended = false;
        const head = coords[0], tail = coords[coords.length - 1];
        for (const s of segs) {
          if (used.has(s.uid)) continue;
          const a = s.alignment[0], b = s.alignment[s.alignment.length - 1];
          if (distFt(tail, a) <= MERGE_TOL_FT)      { coords = coords.concat(s.alignment.slice(1)); }
          else if (distFt(tail, b) <= MERGE_TOL_FT) { coords = coords.concat(s.alignment.slice().reverse().slice(1)); }
          else if (distFt(head, b) <= MERGE_TOL_FT) { coords = s.alignment.slice().concat(coords.slice(1)); }
          else if (distFt(head, a) <= MERGE_TOL_FT) { coords = s.alignment.slice().reverse().concat(coords.slice(1)); }
          else continue;
          used.add(s.uid); members.push(s); extended = true; break;
        }
      }
      chains.push({ coords, members });
    }
    return chains;
  }
  // Merge a park's raw road segments into routes.
  // Group key: ROUTE_ID if present (authoritative), else road name. Within a
  // group, only endpoint-connected segments chain together; same-name but
  // disconnected pieces become separate routes and are flagged.
  function mergeRoads(linearSecs) {
    const unit = linearSecs.length ? linearSecs[0].project_code : 'X';
    const groups = {};
    for (const s of linearSecs) {
      const key = (s.route_id && s.route_id.trim()) ? 'RID:' + s.route_id.trim()
                : (s.faclocid && s.faclocid.trim()) ? 'FLID:' + s.faclocid.trim()
                : 'NM:' + (s.src_name || s.name || s.id);
      (groups[key] = groups[key] || []).push(s);
    }
    const routes = [], flags = [];
    let idx = 0;
    Object.keys(groups).forEach((key) => {
      const chains = chainSegments(groups[key]);
      chains.forEach((ch) => {
        idx++;
        const name = ch.members[0].src_name || ch.members[0].name;
        routes.push({
          id: `${unit}-RD-${pad(idx)}`,
          uid: ch.members[0].uid,
          route_id: ch.members[0].route_id || '',
          faclocid: ch.members[0].faclocid || '',
          rip: ch.members[0].rip || null,
          in_scope: !!ch.members[0].in_scope,
          scope_name: ch.members[0].scope_name || '',
          scope_section: ch.members[0].scope_section || '',
          scope_flag: !!ch.members[0].scope_flag,
          src_name: name, name,
          type: 'linear', alignment: ch.coords, project_code: unit,
          mp_start: 0, mp_end: lengthMiles(ch.coords),
          pathweb_refs: [], sub_alignments: [], pins: [],
          merged_from: ch.members.map((m) => m.uid),
        });
      });
      if (chains.length > 1 && !key.startsWith('RID:')) flags.push({ name: (groups[key][0].src_name || key.slice(key.indexOf(':') + 1)), pieces: chains.length });
    });
    return { routes, flags };
  }
  // Return a copy of the bundle with road segments merged into routes (+flags).
  function mergeBundleRoads(bundle) {
    const linear = bundle.sections.filter((s) => s.type === 'linear');
    const area = bundle.sections.filter((s) => s.type !== 'linear');
    if (linear.length < 2) return { bundle, flags: [], before: linear.length, after: linear.length };
    const { routes, flags } = mergeRoads(linear);
    return {
      bundle: Object.assign({}, bundle, { sections: area.concat(routes) }),
      flags, before: linear.length, after: routes.length,
    };
  }

  // ---- shapefile set → GeoJSON (WGS84) -----------------------------------
  async function parseShapefileSet(files) {
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, await f.arrayBuffer());
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const gj = await shp(buf);                 // shpjs reprojects via .prj → WGS84
    const fcs = Array.isArray(gj) ? gj : [gj];
    // flatten into one FeatureCollection
    return { type: 'FeatureCollection', features: fcs.flatMap(fc => (fc && fc.features) || []) };
  }

  // ---- bundle assembly ---------------------------------------------------
  function buildBundle(unit, roadsFC, parkingFC, unitName) {
    const sections = [];
    let ri = 0, pi = 0;
    ((roadsFC && roadsFC.features) || []).forEach((f) => {
      lineStringsOf(f.geometry).forEach((coords) => {
        if (!coords || coords.length < 2) return;
        ri++;
        const rdFlid = faclocidOf(f);
        const rdRip = ripFor(unit, rdFlid);      // full RIP record via FACLOCID join
        sections.push({
          id: `${unit}-RD-${pad(ri)}`,
          uid: newUid(),
          route_id: rdRip ? rdRip.route_id : routeIdOf(f),   // auto-assigned from RIP
          faclocid: rdFlid,                     // NPS asset id — merge/join key
          rip: rdRip || null,                   // full RIP attributes (name, From/To, FLTP, class…)
          src_name: nameOf(f, 'Road', ri),      // road name, used to group segments into routes
          name: nameOf(f, 'Road', ri),
          type: 'linear',
          alignment: coords,                    // [lng,lat]
          project_code: unit,
          mp_start: 0,
          mp_end: lengthMiles(coords),
          pathweb_refs: [],
          sub_alignments: [],
          pins: [],
        });
      });
    });
    ((parkingFC && parkingFC.features) || []).forEach((f) => {
      polygonRingsOf(f.geometry).forEach((ring) => {
        if (!ring || ring.length < 3) return;
        pi++;
        const pkFlid = faclocidOf(f);
        const pkRip = ripFor(unit, pkFlid);
        sections.push({
          id: `${unit}-PK-${pad(pi)}`,
          uid: newUid(),
          route_id: pkRip ? pkRip.route_id : routeIdOf(f),
          faclocid: pkFlid,
          rip: pkRip || null,
          src_name: nameOf(f, 'Lot', pi),
          name: nameOf(f, 'Lot', pi),
          type: 'area',
          alignment: ring,                      // closed [lng,lat] ring
          project_code: unit,
          mp_start: 0,
          mp_end: 0,
          area_sqft: Math.round(ringAreaSqFt(ring)),
          pathweb_refs: [],
          sub_alignments: [],
          pins: [],
        });
      });
    });
    return {
      id: `park_${unit}`,
      name: `${unit} — ${unitName || 'NPS Park'}`,
      client: 'National Park Service',
      short_name: unit,
      sections,
      _rw2_park: { unit, unit_name: unitName || '', imported_at: new Date().toISOString() },
    };
  }

  // ---- import flow -------------------------------------------------------
  // Parse whatever was dropped into a flat WGS84 feature list. Handles a .zip
  // shapefile bundle (shpjs reads it directly) and loose shapefile sets
  // grouped by base name.
  // Returns one entry per source file-set: { unit, features }. Keeping sources
  // separate (rather than one flat feature list grouped by UNITCODE) is what
  // keeps BLRI_NC and BLRI_VA — which share UNITCODE "BLRI" — as two sections.
  async function parseSources(files) {
    const out = [];
    const zips  = files.filter(f => /\.zip$/i.test(f.name));
    const loose = files.filter(f => !/\.zip$/i.test(f.name));
    for (const z of zips) {
      const gj = await shp(await z.arrayBuffer());
      const base = z.name.replace(/\.zip$/i, '');
      (Array.isArray(gj) ? gj : [gj]).forEach(fc => {
        const feats = (fc && fc.features) || [];
        if (feats.length) out.push({ unit: unitKeyFromName(base), features: feats });
      });
    }
    const groups = {};
    for (const f of loose) {
      const base = f.name.replace(/\.[^.]+$/, '');
      (groups[base] = groups[base] || []).push(f);
    }
    for (const base in groups) {
      const grp = groups[base];
      if (!grp.some(f => /\.shp$/i.test(f.name))) continue;   // ignore stray non-shapefile files
      const fc = await parseShapefileSet(grp);
      const feats = fc.features || [];
      if (feats.length) out.push({ unit: unitKeyFromName(base), features: feats });
    }
    return out;
  }

  function bundleFromFeatures(unit, feats) {
    const parkingFC = { type: 'FeatureCollection', features: feats.filter(f => f.geometry && /Polygon/.test(f.geometry.type)) };
    const roadsFC   = { type: 'FeatureCollection', features: feats.filter(f => f.geometry && /LineString/.test(f.geometry.type)) };
    const bundle = buildBundle(unit, roadsFC, parkingFC, detectUnitName(feats));
    applyScope(bundle.sections, unit);   // in-scope ROUTE_ID assignment (scoped parks)
    return bundle;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    toast(`Parsing ${files.length} file${files.length === 1 ? '' : 's'}…`);
    let sources = [];
    try {
      sources = await parseSources(files);
    } catch (err) {
      console.error('[Roadwalk2] parse failed', err);
      toast(`Parse failed: ${err.message}`, true);
      return;
    }
    if (!sources.length) {
      toast('No geometry found. Drop a shapefile set (.shp .shx .dbf .prj) or a .zip.', true);
      return;
    }

    // Merge sources that resolve to the same unit (a park's parking + roads
    // file-sets). Distinct filenames (BLRI_NC vs BLRI_VA) stay separate even
    // though they share UNITCODE "BLRI".
    const byUnit = {};
    for (const s of sources) { (byUnit[s.unit] = byUnit[s.unit] || []).push(...s.features); }
    const bundles = Object.keys(byUnit)
      .map(u => bundleFromFeatures(u, byUnit[u]))
      .filter(b => b.sections.length);
    if (!bundles.length) { toast('Parsed, but no road or parking geometry found.', true); return; }

    if (bundles.length === 1) {
      const b = bundles[0];
      confirmLoad(b._rw2_park.unit,
        b.sections.filter(s => s.type === 'linear').length,
        b.sections.filter(s => s.type === 'area').length, b);
    } else {
      confirmBatch(bundles);
    }
  }

  // ---- batch confirm (many sections at once) -----------------------------
  function confirmBatch(bundles) {
    closeModal();
    bundles.sort((a, b) => a._rw2_park.unit.localeCompare(b._rw2_park.unit));
    const rows = bundles.map((b) => {
      const lots = b.sections.filter(s => s.type === 'area').length;
      const roads = b.sections.filter(s => s.type === 'linear').length;
      return `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #eef1f4">
        <b style="color:#12233b">${b._rw2_park.unit}</b>
        <span style="color:#5b6673;font-size:12px;white-space:nowrap">${lots} lot${lots === 1 ? '' : 's'}${roads ? ` · ${roads} road${roads === 1 ? '' : 's'}` : ''}</span></div>`;
    }).join('');
    const ov = document.createElement('div');
    ov.id = 'rw2-import-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,20,35,.45);display:flex;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:380px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.3);overflow:hidden">
         <div style="background:#12233b;color:#fff;padding:12px 16px;font-weight:600">Import ${bundles.length} sections</div>
         <div style="padding:14px 16px">
           <div style="max-height:44vh;overflow:auto">${rows}</div>
           <div style="color:#5b6673;font-size:12px;margin-top:10px">Reprojected to WGS84 · on-device</div>
           <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
             <button id="rw2-cancel" style="padding:8px 14px;border:1px solid #d3dae1;background:#fff;border-radius:8px;cursor:pointer">Cancel</button>
             <button id="rw2-load" style="padding:8px 14px;border:0;background:#1a73e8;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">Import all</button>
           </div>
         </div>
       </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#rw2-cancel').onclick = closeModal;
    ov.querySelector('#rw2-load').onclick = async () => {
      closeModal();
      try {
        let n = 0, flagged = 0;
        for (const b of bundles) {
          const m = mergeBundleRoads(b);        // merge connected segments into routes
          flagged += m.flags.length;
          if (window.RW2Library && window.RW2Library.save) await window.RW2Library.save(m.bundle, { fresh: true });
          toast(`Importing… ${++n}/${bundles.length}`);
        }
        if (window.RW2Library && window.RW2Library.open) await window.RW2Library.open(bundles[0]._rw2_park.unit);
        if (window.RW2Library && window.RW2Library.showPanel) await window.RW2Library.showPanel();
        toast(`Imported ${bundles.length} sections${flagged ? ` · ${flagged} route(s) flagged` : ''}.`);
      } catch (err) {
        console.error('[Roadwalk2] batch import failed', err);
        toast(`Import failed: ${err.message}`, true);
      }
    };
  }

  // ---- minimal preview / confirm UI --------------------------------------
  function confirmLoad(unit, nRoads, nPark, bundle) {
    closeModal();
    const ov = document.createElement('div');
    ov.id = 'rw2-import-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,20,35,.45);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:360px;width:88%;box-shadow:0 10px 40px rgba(0,0,0,.3);font-family:'IBM Plex Sans',system-ui,sans-serif;overflow:hidden">
         <div style="background:#12233b;color:#fff;padding:12px 16px;font-weight:600">Import section · ${unit}</div>
         <div style="padding:16px">
           <div style="font-size:14px;color:#1a2330;line-height:1.6">
             <b>${nRoads}</b> road${nRoads === 1 ? '' : 's'} → linear sections (stationed + SLD)<br>
             <b>${nPark}</b> parking area${nPark === 1 ? '' : 's'} → area sections<br>
             <span style="color:#5b6673;font-size:12px">Reprojected to WGS84 · on-device</span>
           </div>
           <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
             <button id="rw2-cancel" style="padding:8px 14px;border:1px solid #d3dae1;background:#fff;border-radius:8px;cursor:pointer">Cancel</button>
             <button id="rw2-load" style="padding:8px 14px;border:0;background:#1a73e8;color:#fff;border-radius:8px;cursor:pointer;font-weight:600">Load park</button>
           </div>
         </div>
       </div>`;
    document.body.appendChild(ov);
    // Inject the merge toggle + disconnected-segment flags (segments → routes).
    const mm = mergeBundleRoads(bundle);
    if (nRoads >= 2) {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:13px;color:#1a2330;margin-top:10px';
      info.innerHTML =
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="rw2-merge" checked> Merge connected segments into routes (' + nRoads + ' → ' + mm.after + ')</label>' +
        (mm.flags.length ? '<div style="margin-top:6px;color:#b26a00;font-size:12px">⚑ ' + mm.flags.length + ' road name(s) split across disconnected segments — kept separate: ' + mm.flags.slice(0, 3).map(function (f) { return f.name; }).join(', ') + (mm.flags.length > 3 ? '…' : '') + '</div>' : '');
      const btnRow = ov.querySelector('#rw2-cancel').parentElement;
      btnRow.parentElement.insertBefore(info, btnRow);
    }
    ov.querySelector('#rw2-cancel').onclick = closeModal;
    ov.querySelector('#rw2-load').onclick = async () => {
      const chk = ov.querySelector('#rw2-merge');
      const final = (chk ? chk.checked : true) ? mm.bundle : bundle;
      closeModal();
      try {
        if (window.RW2Library && window.RW2Library.saveAndOpen) await window.RW2Library.saveAndOpen(final);
        else await window._RW.loadBundle(final, { freshImport: true });
        toast(`Loaded ${unit}.`);
      } catch (err) {
        console.error('[Roadwalk2] loadBundle failed', err);
        toast(`Load failed: ${err.message}`, true);
      }
    };
  }
  function closeModal() { const m = document.getElementById('rw2-import-modal'); if (m) m.remove(); }

  // ---- toast -------------------------------------------------------------
  let toastT = null;
  function toast(msg, isErr) {
    let t = document.getElementById('rw2-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'rw2-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;font:13px/1.4 "IBM Plex Sans",system-ui,sans-serif;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.28);max-width:90%';
      document.body.appendChild(t);
    }
    t.style.background = isErr ? '#c5372c' : '#12233b';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, isErr ? 6000 : 3500);
  }

  // ---- button mount (self-installing, fidelity: clones donor button style)
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.shp,.shx,.dbf,.prj,.cpg,.qmd,.zip';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  // Folder picker — pulls every file in the chosen directory AND its subfolders,
  // so a whole tree of per-park folders imports in one pick (parseSources groups
  // by filename, so nested paths don't matter).
  const folderInput = document.createElement('input');
  folderInput.type = 'file';
  folderInput.multiple = true;
  folderInput.webkitdirectory = true;
  folderInput.style.display = 'none';
  folderInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  function appendInputs() { document.body.appendChild(fileInput); document.body.appendChild(folderInput); }
  document.addEventListener('DOMContentLoaded', appendInputs);
  if (document.body) appendInputs();

  // Small chooser so IMPORT SECTION offers files OR a folder.
  function closeChooser() { const m = document.getElementById('rw2-import-chooser'); if (m) m.remove(); }
  function showChooser(anchor) {
    closeChooser();
    const r = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'rw2-import-chooser';
    menu.style.cssText = `position:fixed;top:${r.bottom + 4}px;left:${r.left}px;z-index:99999;background:#fff;border:1px solid #d3dae1;border-radius:10px;box-shadow:0 6px 24px rgba(20,35,60,.22);overflow:hidden;font:13px 'IBM Plex Sans',system-ui;min-width:190px`;
    menu.innerHTML =
      `<button data-k="files"  style="display:block;width:100%;text-align:left;padding:10px 16px;border:0;background:#fff;cursor:pointer;color:#12233b">📄 Select files…</button>
       <button data-k="folder" style="display:block;width:100%;text-align:left;padding:10px 16px;border:0;border-top:1px solid #eef1f4;background:#fff;cursor:pointer;color:#12233b">📁 Select a folder…</button>`;
    menu.querySelector('[data-k="files"]').onclick = (e) => { e.stopPropagation(); closeChooser(); fileInput.click(); };
    menu.querySelector('[data-k="folder"]').onclick = (e) => { e.stopPropagation(); closeChooser(); folderInput.click(); };
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeChooser, { once: true }), 0);
  }
  window.RW2ImportChooser = showChooser;   // library panel reuses this

  function mount() {
    if (document.getElementById('rw2-import-park')) return;
    const anchor = Array.from(document.querySelectorAll('button'))
      .find(b => /IMPORT PROJECT/i.test((b.textContent || '').trim()));
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-import-park';
    btn.className = anchor.className;      // identical styling to the donor buttons
    btn.textContent = 'IMPORT SECTION';
    btn.addEventListener('click', () => showChooser(btn));
    anchor.insertAdjacentElement('afterend', btn);
    console.log('[Roadwalk2] park importer mounted');
  }
  // poll/remount — the donor re-renders the action bar on view changes
  setInterval(mount, 1200);
  setTimeout(mount, 400);

  window.RW2Import = { handleFiles, buildBundle, bundleFromFeatures, parseShapefileSet, parseSources, unitKeyFromName, detectUnit, detectUnitName };  // for testing
})();
