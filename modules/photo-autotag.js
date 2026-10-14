/* ============================================================================
   RoadWalk 2 — PHOTO → ROUTE/LOT AUTO-TAG  (ported from RoadWalk 3's win #1)
   ----------------------------------------------------------------------------
   Tags every GPS field-photo with the NPS/RIP road(s) it sits on or near and
   the parking lot(s) it sits in or near, within a chosen distance
   (10/20/30/50/100 ft). Pure add-on — nothing in the existing app is changed.

   Geometry source: the loaded park's bundle JSON (data/rip/NPS_C<cyc>_<park>.
   json[.gz]) — the SAME file rip-import loads — which carries full route
   centerlines + parking-lot polygons with RTE_NAME and FMSS_NO. (The in-memory
   segsByRoute keeps geometry but drops names/FMSS and only covers surveyed
   routes, so we re-read the bundle for complete, labelled linework. If the
   bundle can't be fetched, we fall back to segsByRoute geometry, unnamed.)

   Photos are read/written through window._RW.geophotos. Written onto each:
     p.rip_routes      [{ident,name,fmss,ft}]  every road within maxFt
     p.rip_route       nearest road ident ('' if none)
     p.rip_route_name  / p.rip_route_fmss / p.rip_route_ft
     p.rip_route_ambig true when 2+ roads are within maxFt (needs review)
     p.rip_lots        [{ident,name,fmss,inside,ft}]  lots inside/within maxFt
     p.rip_lot         nearest/containing lot ident ('' if none)
     p.rip_lot_name    / p.rip_lot_fmss / p.rip_lot_inside (bool)
     p.rip_tag_ft      the threshold used for this run
   ========================================================================== */
(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Park (unit) code from a route/lot ident: "WRBR-0010AZ" -> "WRBR".
  function parkCodeOf(ident) {
    if (!ident) return '';
    var dash = String(ident).indexOf('-');
    return (dash > 0 ? ident.slice(0, dash) : String(ident).slice(0, 4)).toUpperCase();
  }

  // ---- geo helpers (lifted from RoadWalk 3 js/geo.js, proven correct) -------
  var FT_PER_DEG_LAT = 364320;
  function ftPerDegLng(lat) { return FT_PER_DEG_LAT * Math.cos(lat * Math.PI / 180); }

  function distFt(aLat, aLng, bLat, bLng) {
    var mLat = (aLat + bLat) / 2;
    var dx = (aLng - bLng) * ftPerDegLng(mLat);
    var dy = (aLat - bLat) * FT_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function pointSegFt(pLat, pLng, aLat, aLng, bLat, bLng) {
    var kx = ftPerDegLng((pLat + aLat + bLat) / 3), ky = FT_PER_DEG_LAT;
    var px = pLng * kx, py = pLat * ky;
    var ax = aLng * kx, ay = aLat * ky, bx = bLng * kx, by = bLat * ky;
    var vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var cx = ax + t * vx, cy = ay + t * vy, dx = px - cx, dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function pointPathFt(pLat, pLng, path) {
    if (path.length === 1) return distFt(pLat, pLng, path[0][0], path[0][1]);
    var best = Infinity;
    for (var i = 0; i + 1 < path.length; i++) {
      var d = pointSegFt(pLat, pLng, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
      if (d < best) best = d;
    }
    return best;
  }
  // ray-casting point-in-ring; ring = [[lat,lng],...]
  function pointInRing(pLat, pLng, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      var hit = ((yi > pLat) !== (yj > pLat)) &&
                (pLng < (xj - xi) * (pLat - yi) / ((yj - yi) || 1e-12) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  function bbox(path) {
    var s = 90, w = 180, n = -90, e = -180;
    for (var i = 0; i < path.length; i++) {
      var la = path[i][0], lo = path[i][1];
      if (la < s) s = la; if (la > n) n = la;
      if (lo < w) w = lo; if (lo > e) e = lo;
    }
    return [s, w, n, e];
  }
  function nearBbox(pLat, pLng, bb, padFt) {
    if (!bb) return false;
    var dLat = padFt / FT_PER_DEG_LAT, dLng = padFt / ftPerDegLng(pLat);
    return pLat >= bb[0] - dLat && pLat <= bb[2] + dLat &&
           pLng >= bb[1] - dLng && pLng <= bb[3] + dLng;
  }
  function unionBbox(paths) {
    var bb = null;
    for (var p = 0; p < paths.length; p++) {
      var b = bbox(paths[p]);
      if (!bb) bb = b.slice();
      else { bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
    }
    return bb;
  }
  // _g is [flat,...]; each flat = [lng,lat,lng,lat,...]  →  [[lat,lng]...]
  function decodePaths(_g) {
    if (!Array.isArray(_g)) return [];
    var out = [];
    for (var j = 0; j < _g.length; j++) {
      var flat = _g[j], pts = [];
      for (var i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i + 1], flat[i]]);
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }

  // ---- RIP state + park geometry --------------------------------------------
  var ROUTES = [];       // [{ident,name,fmss,paths,bb}]
  var LOTS = [];         // [{ident,name,fmss,rings,bb}]
  var _builtFor = null;  // park code the cache holds
  var _loading = null;   // in-flight Promise

  function rip() { return window.RW2RIP || null; }
  function parkCode() {
    var R = rip();
    return (R && R.state && R.state.bundle && R.state.bundle.park) || null;
  }
  function parkCycle() {
    var R = rip();
    return (R && R.state && R.state.bundle && R.state.bundle.cycle) || 6;
  }

  async function fetchBundle(code, cyc) {
    var file = 'NPS_C' + cyc + '_' + code + '.json';
    var base = 'data/rip/' + file;
    if (typeof DecompressionStream === 'function') {
      try {
        var gz = await fetch(base + '.gz', { cache: 'no-cache' });
        if (gz.ok) {
          var stream = gz.body.pipeThrough(new DecompressionStream('gzip'));
          return JSON.parse(await new Response(stream).text());
        }
      } catch (e) { /* fall through to plain json */ }
    }
    var res = await fetch(base, { cache: 'no-cache' });
    if (!res.ok) throw new Error('bundle fetch ' + res.status);
    return res.json();
  }

  function buildFromBundle(data) {
    ROUTES = []; LOTS = [];
    (data.routes || []).forEach(function (r) {
      var paths = decodePaths(r._g).filter(function (p) { return p.length >= 2; });
      if (!paths.length) return;
      ROUTES.push({ ident: r.ROUTE_IDENT, name: r.RTE_NAME || '', fmss: String(r.FMSS_NO || ''), paths: paths, bb: unionBbox(paths),
                    begMp: (r.BEG_MP_DCV != null ? Number(r.BEG_MP_DCV) : null), endMp: (r.END_MP_DCV != null ? Number(r.END_MP_DCV) : null) });
    });
    (data.lots || []).forEach(function (l) {
      var rings = decodePaths(l._g).filter(function (p) { return p.length >= 3; });
      if (!rings.length) return;
      LOTS.push({ ident: l.ROUTE_IDENT, name: l.RTE_NAME || l.FROM_DESC || '', fmss: String(l.FMSS_NO || ''), rings: rings, bb: unionBbox(rings) });
    });
  }

  // Fallback: geometry only, from the in-memory condition segments (no names).
  function buildFromSegments() {
    ROUTES = []; LOTS = [];
    var R = rip();
    if (!R || !R.state || !R.state.segsByRoute) return;
    R.state.segsByRoute.forEach(function (segs, ident) {
      var paths = [];
      for (var i = 0; i < segs.length; i++) {
        var dp = decodePaths(segs[i]._g);
        for (var k = 0; k < dp.length; k++) paths.push(dp[k]);
      }
      if (paths.length) ROUTES.push({ ident: ident, name: '', fmss: '', paths: paths, bb: unionBbox(paths) });
    });
  }

  // Ensure ROUTES/LOTS are built for the current park. Returns Promise.
  function ensureGeo(force) {
    var code = parkCode();
    if (!code) return Promise.resolve(false);
    if (!force && _builtFor === code && (ROUTES.length || LOTS.length)) return Promise.resolve(true);
    if (_loading) return _loading;
    _loading = fetchBundle(code, parkCycle())
      .then(function (data) { buildFromBundle(data); _builtFor = code; _loading = null; return true; })
      .catch(function () { buildFromSegments(); _builtFor = code; _loading = null; return ROUTES.length > 0; });
    return _loading;
  }

  // ---- spatial queries -------------------------------------------------------
  function nearbyRoutes(lat, lng, maxFt) {
    var out = [];
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (!nearBbox(lat, lng, r.bb, maxFt)) continue;
      var d = Infinity;
      for (var k = 0; k < r.paths.length; k++) { var dd = pointPathFt(lat, lng, r.paths[k]); if (dd < d) d = dd; }
      if (d <= maxFt) out.push({ ident: r.ident, name: r.name, fmss: r.fmss, ft: Math.round(d * 10) / 10 });
    }
    out.sort(function (a, b) { return a.ft - b.ft; });
    return out;
  }
  function nearbyLots(lat, lng, maxFt) {
    var out = [];
    for (var i = 0; i < LOTS.length; i++) {
      var l = LOTS[i];
      if (!nearBbox(lat, lng, l.bb, maxFt)) continue;
      var inside = false, d = Infinity, k;
      for (k = 0; k < l.rings.length; k++) { if (pointInRing(lat, lng, l.rings[k])) { inside = true; break; } }
      if (inside) d = 0;
      else for (k = 0; k < l.rings.length; k++) { var dd = pointPathFt(lat, lng, l.rings[k]); if (dd < d) d = dd; }
      if (inside || d <= maxFt) out.push({ ident: l.ident, name: l.name, fmss: l.fmss, inside: inside, ft: Math.round(d * 10) / 10 });
    }
    out.sort(function (a, b) { return (a.inside === b.inside) ? a.ft - b.ft : (a.inside ? -1 : 1); });
    return out;
  }

  // ---- station / milepost along a route --------------------------------------
  // Closest point on segment A-B to P → {d: dist ft, t: 0..1 along the segment}.
  function closestOnSeg(pLat, pLng, aLat, aLng, bLat, bLng) {
    var kx = ftPerDegLng((pLat + aLat + bLat) / 3), ky = FT_PER_DEG_LAT;
    var px = pLng * kx, py = pLat * ky, ax = aLng * kx, ay = aLat * ky, bx = bLng * kx, by = bLat * ky;
    var vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 ? (wx * vx + wy * vy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    var cx = ax + t * vx, cy = ay + t * vy, dx = px - cx, dy = py - cy;
    return { d: Math.sqrt(dx * dx + dy * dy), t: t };
  }
  // Project P onto a route's centerline → {ft: offset, sta: along-route feet, total: route length ft}.
  function projectStation(lat, lng, route) {
    var best = Infinity, bestSta = 0, cum = 0;
    for (var pi = 0; pi < route.paths.length; pi++) {
      var path = route.paths[pi];
      for (var i = 0; i + 1 < path.length; i++) {
        var a = path[i], b = path[i + 1];
        var segLen = distFt(a[0], a[1], b[0], b[1]);
        var c = closestOnSeg(lat, lng, a[0], a[1], b[0], b[1]);
        if (c.d < best) { best = c.d; bestSta = cum + c.t * segLen; }
        cum += segLen;
      }
    }
    return { ft: best, sta: bestSta, total: cum };
  }
  function mpFor(route, sta, total) {
    // Prefer the route's real milepost range; otherwise fall back to miles from
    // the route start so an MP value is always available (short access roads and
    // lots often have no BEG/END_MP_DCV).
    if (route.begMp != null && route.endMp != null && total) return route.begMp + (sta / total) * (route.endMp - route.begMp);
    return sta / 5280;
  }
  function routeByIdent(id) { for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].ident === id) return ROUTES[i]; return null; }
  // Public: station + milepost of a point on a given route ('' if unknown).
  function station(lat, lng, ident) {
    var rg = routeByIdent(ident); if (!rg) return null;
    var pr = projectStation(lat, lng, rg); var mp = mpFor(rg, pr.sta, pr.total);
    return { sta: Math.round(pr.sta), mp: (mp != null ? Math.round(mp * 100) / 100 : null) };
  }

  // ---- tag the photos --------------------------------------------------------
  function geo() { return (window._RW && window._RW.geophotos) || null; }

  function tagPhotos(maxFt, ids) {
    var g = geo();
    if (!g) return Promise.resolve({ ok: false, reason: 'Field photos module not available.' });
    if (!rip() || !rip().hasPark || !rip().hasPark()) {
      return Promise.resolve({ ok: false, reason: 'Open an NPS park first (RIP reference) so there are routes to tag against.' });
    }
    return ensureGeo(true).then(function () {
      if (!ROUTES.length && !LOTS.length) return { ok: false, reason: 'The loaded park has no route/lot geometry.' };

      var all = g.list();
      var base = (ids && ids.length) ? all.filter(function (p) { return ids.indexOf(p.id) !== -1; }) : all;
      // Only ever tag LOADED sets. An offloaded photo has had its display image
      // dropped (delete p.dataUrl) to free RAM — its metadata still lives in the
      // list, but re-tagging it against the currently-loaded park could wrongly
      // reassign or clear tags it was given under a different park. Load a set to
      // re-tag it. (p.dataUrl present == loaded.)
      var offloadedSkipped = 0, manualSkipped = 0;
      var pick = base.filter(function (p) {
        if (p.rip_manual) { manualSkipped++; return false; }   // manual assignment is locked — never auto-overwrite
        if (p.dataUrl) return true;
        offloadedSkipped++; return false;
      });
      var scanned = 0, taggedRt = 0, taggedLot = 0, ambig = 0, noGps = 0, cleared = 0;
      var byRoute = {}, changed = [];

      for (var i = 0; i < pick.length; i++) {
        var p = pick[i];
        var lat = Number(p.lat), lng = Number(p.lng);
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) { noGps++; continue; }
        scanned++;
        var near = nearbyRoutes(lat, lng, maxFt);
        var lots = nearbyLots(lat, lng, maxFt);
        var had = p.rip_route || (p.rip_routes && p.rip_routes.length) || p.rip_lot;

        p.rip_routes = near;
        if (near.length) {
          p.rip_route = near[0].ident; p.rip_route_name = near[0].name;
          p.rip_route_fmss = near[0].fmss; p.rip_route_ft = near[0].ft;
          p.rip_route_ambig = near.length > 1;
          var rg = routeByIdent(near[0].ident);
          if (rg) { var pr = projectStation(lat, lng, rg); p.rip_route_sta = Math.round(pr.sta); var mp = mpFor(rg, pr.sta, pr.total); p.rip_route_mp = (mp != null ? Math.round(mp * 100) / 100 : null); }
          else { p.rip_route_sta = null; p.rip_route_mp = null; }
          taggedRt++; if (near.length > 1) ambig++;
          byRoute[near[0].ident] = (byRoute[near[0].ident] || 0) + 1;
        } else {
          p.rip_route = ''; p.rip_route_name = ''; p.rip_route_fmss = ''; p.rip_route_ft = null; p.rip_route_ambig = false;
          p.rip_route_sta = null; p.rip_route_mp = null;
        }

        p.rip_lots = lots;
        if (lots.length) {
          p.rip_lot = lots[0].ident; p.rip_lot_name = lots[0].name;
          p.rip_lot_fmss = lots[0].fmss; p.rip_lot_inside = !!lots[0].inside; taggedLot++;
        } else {
          p.rip_lot = ''; p.rip_lot_name = ''; p.rip_lot_fmss = ''; p.rip_lot_inside = false;
        }

        // Refine the photo's park (unit code) from whatever it tagged to — the
        // route/lot ident carries the prefix (WRBR-0010AZ -> WRBR). If it tagged
        // to nothing, keep any park already stamped at import.
        var parkFromTag = parkCodeOf(near.length ? near[0].ident : (lots.length ? lots[0].ident : ''));
        if (parkFromTag) p.rip_park = parkFromTag;

        p.rip_tag_ft = maxFt;
        if (near.length || lots.length || had) changed.push(p);
        if (!near.length && !lots.length && had) cleared++;
      }

      return Promise.resolve(g.saveMany(changed)).then(function () {
        try { g.refresh(); } catch (e) {}
        return { ok: true, scanned: scanned, taggedRt: taggedRt, taggedLot: taggedLot, ambig: ambig,
                 noGps: noGps, cleared: cleared, offloadedSkipped: offloadedSkipped, manualSkipped: manualSkipped,
                 routes: ROUTES.length, lots: LOTS.length, byRoute: byRoute, maxFt: maxFt };
      });
    });
  }

  // ---- UI (self-wired into the Photo Triage tools row) -----------------------
  function status(msg) {
    var el = document.getElementById('pat-status');
    if (el) el.textContent = msg; else console.log('[photo-autotag] ' + msg);
  }

  function buildControl() {
    var tools = document.getElementById('tg-tools');
    if (!tools || document.getElementById('pat-tag-btn')) return;
    var box = document.createElement('div');
    box.className = 'pat-box';
    box.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--rule,#DDD7C8)';
    box.innerHTML =
      '<span style="font:600 11px \'IBM Plex Mono\',monospace;color:var(--mute,#9BA0A8);letter-spacing:.04em">TAG → ROUTE / LOT</span>' +
      '<select id="pat-ft" title="Max distance from a road centerline or lot edge" ' +
        'style="font:600 12px system-ui;padding:3px 6px;border:1px solid var(--rule,#DDD7C8);border-radius:6px;background:var(--paper,#FBFAF6);color:var(--ink,#1A1D22)">' +
        '<option value="10">10 ft</option><option value="20">20 ft</option>' +
        '<option value="30" selected>30 ft</option><option value="50">50 ft</option>' +
        '<option value="100">100 ft</option></select>' +
      '<button class="tg-suggest-btn" id="pat-tag-btn" type="button" ' +
        'title="Tag GPS photos in loaded sets with the RIP road they sit on/near and the parking lot they sit in/near. Offloaded sets keep their existing tags — load a set to re-tag it.">📍 Tag photos to routes</button>' +
      '<button class="tg-suggest-btn" id="pat-retag-btn" type="button" ' +
        'title="Run only on photos that are still untagged — pick a wider distance above first">↻ Re-tag untagged only</button>' +
      '<span id="pat-status" style="flex:1 1 100%;font:500 11.5px system-ui;color:var(--mute,#9BA0A8)"></span>';
    tools.appendChild(box);

    document.getElementById('pat-retag-btn').addEventListener('click', function () {
      var ft = +document.getElementById('pat-ft').value || 30;
      var g = geo();
      if (!g) { status('Field photos not available.'); return; }
      var ids = g.list().filter(function (p) {
        var lat = Number(p.lat), lng = Number(p.lng);
        return p.dataUrl && !p.rip_route && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      }).map(function (p) { return p.id; });
      if (!ids.length) { status('No untagged GPS photos in loaded sets to re-tag.'); return; }
      var btn = document.getElementById('pat-retag-btn');
      btn.disabled = true; status('Re-tagging ' + ids.length + ' untagged photo(s) within ' + ft + ' ft…');
      tagPhotos(ft, ids).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { status(r.reason); return; }
        status('Re-tagged ' + r.taggedRt + ' of ' + ids.length + ' untagged · ' + r.taggedLot + ' to lots · ' + r.ambig + ' near 2+ roads.');
        if (window.RW2RouteView && window.RW2RouteView.refresh) { try { window.RW2RouteView.refresh(); } catch (e) {} }
      }, function (e) { btn.disabled = false; status('Re-tag failed: ' + (e && e.message ? e.message : e)); });
    });

    document.getElementById('pat-tag-btn').addEventListener('click', function () {
      var ft = +document.getElementById('pat-ft').value || 30;
      var btn = document.getElementById('pat-tag-btn');
      btn.disabled = true; status('Tagging photos within ' + ft + ' ft…');
      tagPhotos(ft, null).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { status(r.reason); return; }
        var top = Object.keys(r.byRoute).sort(function (a, b) { return r.byRoute[b] - r.byRoute[a]; }).slice(0, 3)
                    .map(function (k) { return k + ' (' + r.byRoute[k] + ')'; }).join(', ');
        status('Tagged ' + r.taggedRt + ' to roads, ' + r.taggedLot + ' to lots, of ' + r.scanned +
               ' loaded GPS photos · ' + r.ambig + ' near 2+ roads' + (r.cleared ? ' · ' + r.cleared + ' cleared' : '') +
               (r.manualSkipped ? ' · ' + r.manualSkipped + ' manually locked' : '') +
               (r.offloadedSkipped ? ' · ' + r.offloadedSkipped + ' offloaded skipped' : '') +
               (top ? ' · top: ' + top : ''));
        // refresh the "View by route" dropdown so the new routes appear
        if (window.RW2RouteView && window.RW2RouteView.refresh) { try { window.RW2RouteView.refresh(); } catch (e) {} }
      }, function (e) { btn.disabled = false; status('Tagging failed: ' + (e && e.message ? e.message : e)); });
    });
  }

  function whenReady() {
    if (document.getElementById('tg-tools')) { buildControl(); return; }
    var tries = 0, iv = setInterval(function () {
      if (document.getElementById('tg-tools') || ++tries > 40) { clearInterval(iv); buildControl(); }
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenReady);
  else whenReady();

  // ---- post-upload tagging wizard -------------------------------------------
  // Counts are scoped to LOADED photos only — offloaded sets are never tagged,
  // so they don't belong in the "untagged remaining" math.
  function counts() {
    var g = geo(); var gps = 0, tagged = 0, untagged = 0, offloaded = 0;
    if (g) g.list().forEach(function (p) {
      var lat = Number(p.lat), lng = Number(p.lng);
      if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
      if (!p.dataUrl) { offloaded++; return; }
      gps++; if (p.rip_route) tagged++; else untagged++;
    });
    return { gps: gps, tagged: tagged, untagged: untagged, offloaded: offloaded };
  }

  function wstatus(msg) { var el = document.getElementById('patw-status'); if (el) el.textContent = msg || ''; }

  function updateWizCounts(added) {
    var c = counts();
    var sub = document.getElementById('patw-sub');
    if (sub) sub.textContent = (added ? 'Imported ' + added + ' photo' + (added === 1 ? '' : 's') + '. ' : '') +
      c.gps + ' loaded GPS photos · ' + c.tagged + ' tagged · ' + c.untagged + ' untagged' +
      (c.offloaded ? ' · ' + c.offloaded + ' offloaded (not tagged)' : '') + '.';
    var parked = !!(rip() && rip().hasPark && rip().hasPark());
    var warn = document.getElementById('patw-warn');
    if (warn) warn.style.display = parked ? 'none' : 'block';
    ['patw-all', 'patw-un'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = !parked; });
  }

  function ensureWizard() {
    if (document.getElementById('patw-ov')) return;
    var st = document.createElement('style');
    st.textContent =
      '#patw-ov{position:fixed;inset:0;z-index:4200;background:rgba(20,22,28,.5);display:none;align-items:center;justify-content:center}' +
      '#patw-ov.on{display:flex}' +
      '#patw-card{width:min(440px,92vw);background:var(--paper,#FBFAF6);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden;font-family:system-ui}' +
      '#patw-card .hd{background:#fff;border-bottom:1px solid var(--rule,#DDD7C8);padding:13px 16px;font-weight:700;color:var(--blue,#0B3D66);font-size:15px}' +
      '#patw-card .bd{padding:14px 16px}' +
      '#patw-card .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}' +
      '#patw-card select{font:600 13px system-ui;padding:6px 8px;border:1px solid var(--rule,#DDD7C8);border-radius:7px;background:#fff}' +
      '#patw-card button{font:600 13px system-ui;padding:8px 12px;border-radius:8px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}' +
      '#patw-card button.go{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}' +
      '#patw-card button:disabled{opacity:.5;cursor:not-allowed}';
    document.head.appendChild(st);
    var ov = document.createElement('div');
    ov.id = 'patw-ov';
    ov.innerHTML =
      '<div id="patw-card">' +
        '<div class="hd">📍 Tag photos to routes</div>' +
        '<div class="bd">' +
          '<div id="patw-sub" style="font:500 12.5px system-ui;color:#5b6673"></div>' +
          '<div id="patw-warn" style="display:none;margin-top:8px;font:600 12px system-ui;color:#C85A2B">Open an NPS park first (RIP) so there are routes to tag against.</div>' +
          '<div class="row"><span style="font:600 12px system-ui;color:#5b6673">Distance from road / lot</span>' +
            '<select id="patw-ft"><option value="10">10 ft</option><option value="20">20 ft</option>' +
            '<option value="30" selected>30 ft</option><option value="50">50 ft</option><option value="100">100 ft</option></select></div>' +
          '<div class="row">' +
            '<button class="go" id="patw-all" title="Tags GPS photos in loaded sets only — offloaded sets keep their existing tags">Tag loaded photos</button>' +
            '<button id="patw-un" title="Only loaded photos that are still untagged">Re-tag untagged only</button>' +
            '<span style="flex:1"></span><button id="patw-done">Done</button></div>' +
          '<div id="patw-status" style="margin-top:10px;font:500 12px system-ui;color:#0e7c66;min-height:16px"></div>' +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
    document.getElementById('patw-done').addEventListener('click', function () { ov.classList.remove('on'); });

    function run(untaggedOnly) {
      var ft = +document.getElementById('patw-ft').value || 30;
      var ids = null;
      if (untaggedOnly) {
        var g = geo(); if (!g) return;
        ids = g.list().filter(function (p) {
          var lat = Number(p.lat), lng = Number(p.lng);
          return p.dataUrl && !p.rip_route && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
        }).map(function (p) { return p.id; });
        if (!ids.length) { wstatus('No untagged GPS photos remain in loaded sets.'); return; }
      }
      document.getElementById('patw-all').disabled = true; document.getElementById('patw-un').disabled = true;
      wstatus('Tagging within ' + ft + ' ft…');
      tagPhotos(ft, ids).then(function (r) {
        updateWizCounts();
        if (!r.ok) { wstatus(r.reason); return; }
        wstatus('Tagged ' + r.taggedRt + ' to roads, ' + r.taggedLot + ' to lots' +
          (r.ambig ? ' · ' + r.ambig + ' near 2+ roads' : '') +
          (r.offloadedSkipped ? ' · ' + r.offloadedSkipped + ' offloaded skipped' : '') + '. ' +
          counts().untagged + ' still untagged' + (counts().untagged ? ' — try a wider distance.' : '.'));
        if (window.RW2RouteView && window.RW2RouteView.refresh) { try { window.RW2RouteView.refresh(); } catch (e) {} }
      }, function (e) {
        updateWizCounts(); wstatus('Failed: ' + (e && e.message ? e.message : e));
      });
    }
    document.getElementById('patw-all').addEventListener('click', function () { run(false); });
    document.getElementById('patw-un').addEventListener('click', function () { run(true); });
  }

  function wizard(opts) {
    opts = opts || {};
    ensureWizard();
    wstatus('');
    updateWizCounts(opts.added);
    document.getElementById('patw-ov').classList.add('on');
  }

  // ---- manual assignment (override the auto-tag) -----------------------------
  function lotByIdent(id) { for (var i = 0; i < LOTS.length; i++) if (LOTS[i].ident === id) return LOTS[i]; return null; }
  function byIdent(a, b) { return a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0; }

  // Assign a photo to a route OR lot explicitly and LOCK it (rip_manual) so a
  // future auto-tag run won't overwrite it. Clears the other dimension so the
  // Photos-tab grouping (inside-lot > route > lot) moves the photo as intended.
  function assignTarget(id, ident, kind) {
    var g = geo(); if (!g || !g.get) return Promise.resolve(false);
    var p = g.get(id); if (!p) return Promise.resolve(false);
    return ensureGeo(false).then(function () {
      var lat = Number(p.lat), lng = Number(p.lng), hasGps = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      if (kind === 'lot') {
        var lg = lotByIdent(ident);
        p.rip_lot = ident; p.rip_lot_name = lg ? lg.name : ''; p.rip_lot_fmss = lg ? lg.fmss : '';
        p.rip_lot_inside = true;
        p.rip_lots = [{ ident: ident, name: p.rip_lot_name, fmss: p.rip_lot_fmss, inside: true, ft: 0 }];
        p.rip_route = ''; p.rip_route_name = ''; p.rip_route_fmss = ''; p.rip_route_ft = null;
        p.rip_route_ambig = false; p.rip_route_sta = null; p.rip_route_mp = null; p.rip_routes = [];
      } else {
        var rg = routeByIdent(ident);
        p.rip_route = ident; p.rip_route_name = rg ? rg.name : ''; p.rip_route_fmss = rg ? rg.fmss : '';
        p.rip_route_ambig = false; p.rip_route_ft = null;
        if (rg && hasGps) {
          var pr = projectStation(lat, lng, rg);
          p.rip_route_sta = Math.round(pr.sta);
          var mp = mpFor(rg, pr.sta, pr.total); p.rip_route_mp = (mp != null ? Math.round(mp * 100) / 100 : null);
          p.rip_route_ft = Math.round(pr.ft * 10) / 10;
        } else { p.rip_route_sta = null; p.rip_route_mp = null; }
        p.rip_routes = [{ ident: ident, name: p.rip_route_name, fmss: p.rip_route_fmss, ft: p.rip_route_ft }];
        p.rip_lot = ''; p.rip_lot_name = ''; p.rip_lot_fmss = ''; p.rip_lot_inside = false; p.rip_lots = [];
      }
      p.rip_park = parkCodeOf(ident) || p.rip_park;
      p.rip_manual = true;
      return Promise.resolve(g.save(p)).then(function () { try { g.refresh(); } catch (e) {} return true; });
    });
  }

  // Remove the manual lock and re-derive the tag from GPS (reverts to auto).
  function clearManual(id) {
    var g = geo(); if (!g || !g.get) return Promise.resolve(false);
    var p = g.get(id); if (!p) return Promise.resolve(false);
    delete p.rip_manual;
    return Promise.resolve(g.save(p)).then(function () { return tagPhotos(p.rip_tag_ft || 30, [id]); });
  }

  // Routes + lots of the loaded park, for the assignment picker.
  function targetsList() {
    return ensureGeo(false).then(function () {
      return {
        routes: ROUTES.map(function (r) { return { ident: r.ident, name: r.name }; }).sort(byIdent),
        lots: LOTS.map(function (l) { return { ident: l.ident, name: l.name }; }).sort(byIdent)
      };
    });
  }

  function ensureAssignStyles() {
    if (document.getElementById('pat-asg-style')) return;
    var st = document.createElement('style'); st.id = 'pat-asg-style';
    st.textContent =
      '#pat-asg{position:fixed;inset:0;z-index:4360;background:rgba(20,22,28,.55);display:none;align-items:center;justify-content:center}' +
      '#pat-asg.on{display:flex}' +
      '#pat-asg .card{width:min(460px,94vw);max-height:84vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45);font-family:system-ui}' +
      '#pat-asg .hd{padding:12px 15px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff;font-weight:800;color:#16315E;font-size:14.5px}' +
      '#pat-asg .srch{margin:10px 14px 0;padding:7px 10px;border:1px solid var(--rule,#DDD7C8);border-radius:8px;font:500 13px system-ui}' +
      '#pat-asg .list{flex:1 1 auto;overflow:auto;padding:4px 10px 12px;margin-top:8px}' +
      '#pat-asg .sec{font:800 10px system-ui;letter-spacing:.07em;text-transform:uppercase;color:#9BA0A8;margin:8px 6px 4px}' +
      '#pat-asg .opt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer}' +
      '#pat-asg .opt:hover{background:#eef2f6}' +
      '#pat-asg .opt.cur{background:#e7f1ea}' +
      '#pat-asg .opt .id{font:700 12px "IBM Plex Mono",monospace;color:#0B3D66;white-space:nowrap}' +
      '#pat-asg .opt.cur .id{color:#1b6b4a}' +
      '#pat-asg .opt .nm{font:500 12px system-ui;color:#5b6673;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#pat-asg .revert{margin:4px 6px 2px;border:1px dashed #c6a15a;background:#fdf6e3;color:#8a6d1d;border-radius:7px;padding:7px 9px;cursor:pointer;font:700 12px system-ui;width:calc(100% - 12px);text-align:left}' +
      '#pat-asg .ftr{padding:10px 14px;border-top:1px solid var(--rule,#DDD7C8);background:#fff;display:flex;gap:8px;align-items:center}' +
      '#pat-asg .ftr .sp{flex:1}' +
      '#pat-asg .ftr button{font:700 12.5px system-ui;padding:7px 12px;border-radius:8px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}' +
      '#pat-asg .warn{padding:14px;color:#C85A2B;font:600 12.5px system-ui}';
    document.head.appendChild(st);
  }

  // Shared picker — used by the lightbox, the Photos-tab card, and the report
  // builder. onDone() runs after an assign/revert so the caller can refresh.
  function assignUI(id, onDone) {
    ensureAssignStyles();
    var g = geo(); var p = g && g.get ? g.get(id) : null; if (!p) return;
    onDone = onDone || function () {};
    var ov = document.getElementById('pat-asg');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pat-asg';
      ov.innerHTML = '<div class="card">' +
        '<div class="hd">Assign photo → route / lot</div>' +
        '<input class="srch" id="pat-asg-srch" placeholder="Filter by ID or name…" spellcheck="false">' +
        '<div class="list" id="pat-asg-list"></div>' +
        '<div class="ftr"><span id="pat-asg-cur" style="font:600 11.5px system-ui;color:#8a949f"></span><span class="sp"></span>' +
        '<button id="pat-asg-close">Close</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
      document.getElementById('pat-asg-close').onclick = function () { ov.classList.remove('on'); };
    }
    var curIdent = (p.rip_lot && p.rip_lot_inside) ? p.rip_lot : (p.rip_route || p.rip_lot || '');
    document.getElementById('pat-asg-cur').textContent = (p.rip_manual ? 'Manual: ' : 'Auto: ') + (curIdent || 'unassigned');
    var list = document.getElementById('pat-asg-list');
    var srch = document.getElementById('pat-asg-srch'); srch.value = '';
    list.innerHTML = '<div class="warn" style="color:#8a949f">Loading routes…</div>';
    ov.classList.add('on');
    targetsList().then(function (t) {
      if (!t.routes.length && !t.lots.length) { list.innerHTML = '<div class="warn">No park loaded — open an NPS park in RIP so there are routes/lots to assign.</div>'; return; }
      function draw(filter) {
        filter = (filter || '').toLowerCase();
        function match(o) { return !filter || o.ident.toLowerCase().indexOf(filter) !== -1 || (o.name || '').toLowerCase().indexOf(filter) !== -1; }
        var rs = t.routes.filter(match), ls = t.lots.filter(match), html = '';
        html += '<button class="revert" id="pat-asg-revert">↺ Revert to auto-tag (clear manual lock)</button>';
        if (rs.length) html += '<div class="sec">Routes</div>' + rs.map(function (o) {
          return '<div class="opt' + (o.ident === curIdent ? ' cur' : '') + '" data-ident="' + esc(o.ident) + '" data-kind="route"><span class="id">' + esc(o.ident) + '</span><span class="nm">' + esc(o.name || '') + '</span></div>';
        }).join('');
        if (ls.length) html += '<div class="sec">Parking lots</div>' + ls.map(function (o) {
          return '<div class="opt' + (o.ident === curIdent ? ' cur' : '') + '" data-ident="' + esc(o.ident) + '" data-kind="lot"><span class="id">🅿 ' + esc(o.ident) + '</span><span class="nm">' + esc(o.name || '') + '</span></div>';
        }).join('');
        if (!rs.length && !ls.length) html += '<div class="warn">No matching route or lot.</div>';
        list.innerHTML = html;
      }
      draw('');
      srch.oninput = function () { draw(srch.value); };
      list.onclick = function (e) {
        var rev = e.target.closest ? e.target.closest('#pat-asg-revert') : null;
        if (rev) { rev.disabled = true; clearManual(id).then(function () { ov.classList.remove('on'); onDone(); }); return; }
        var opt = e.target.closest ? e.target.closest('.opt') : null; if (!opt) return;
        assignTarget(id, opt.getAttribute('data-ident'), opt.getAttribute('data-kind')).then(function () { ov.classList.remove('on'); onDone(); });
      };
    });
  }

  // ---- public API ------------------------------------------------------------
  window.RW2PhotoTag = {
    tagPhotos: tagPhotos,
    wizard: wizard,
    ensureGeo: ensureGeo,
    station: station,
    assignTarget: assignTarget, clearManual: clearManual, targetsList: targetsList, assignUI: assignUI,
    nearbyRoutes: nearbyRoutes,
    nearbyLots: nearbyLots,
    counts: function () { return { routes: ROUTES.length, lots: LOTS.length, builtFor: _builtFor }; },
    report: function () {
      var g = geo(); if (!g) return [];
      var by = {};
      g.list().forEach(function (p) {
        if (!p.rip_route) return;
        var k = p.rip_route;
        if (!by[k]) by[k] = { ident: k, name: p.rip_route_name || '', fmss: p.rip_route_fmss || '', count: 0, ambig: 0 };
        by[k].count++; if (p.rip_route_ambig) by[k].ambig++;
      });
      return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.count - a.count; });
    },
    _geo: { distFt: distFt, pointPathFt: pointPathFt, pointInRing: pointInRing, decodePaths: decodePaths, nearBbox: nearBbox, bbox: bbox },
  };
})();
