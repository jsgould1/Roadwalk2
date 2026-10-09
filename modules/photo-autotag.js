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
      ROUTES.push({ ident: r.ROUTE_IDENT, name: r.RTE_NAME || '', fmss: String(r.FMSS_NO || ''), paths: paths, bb: unionBbox(paths) });
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
      var pick = (ids && ids.length) ? all.filter(function (p) { return ids.indexOf(p.id) !== -1; }) : all;
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
          taggedRt++; if (near.length > 1) ambig++;
          byRoute[near[0].ident] = (byRoute[near[0].ident] || 0) + 1;
        } else {
          p.rip_route = ''; p.rip_route_name = ''; p.rip_route_fmss = ''; p.rip_route_ft = null; p.rip_route_ambig = false;
        }

        p.rip_lots = lots;
        if (lots.length) {
          p.rip_lot = lots[0].ident; p.rip_lot_name = lots[0].name;
          p.rip_lot_fmss = lots[0].fmss; p.rip_lot_inside = !!lots[0].inside; taggedLot++;
        } else {
          p.rip_lot = ''; p.rip_lot_name = ''; p.rip_lot_fmss = ''; p.rip_lot_inside = false;
        }

        p.rip_tag_ft = maxFt;
        if (near.length || lots.length || had) changed.push(p);
        if (!near.length && !lots.length && had) cleared++;
      }

      return Promise.resolve(g.saveMany(changed)).then(function () {
        try { g.refresh(); } catch (e) {}
        return { ok: true, scanned: scanned, taggedRt: taggedRt, taggedLot: taggedLot, ambig: ambig,
                 noGps: noGps, cleared: cleared, routes: ROUTES.length, lots: LOTS.length, byRoute: byRoute, maxFt: maxFt };
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
        'title="Tag every GPS photo with the RIP road it sits on/near and the parking lot it sits in/near">📍 Tag photos to routes</button>' +
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
        return !p.rip_route && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
      }).map(function (p) { return p.id; });
      if (!ids.length) { status('No untagged GPS photos to re-tag.'); return; }
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
               ' GPS photos · ' + r.ambig + ' near 2+ roads' + (r.cleared ? ' · ' + r.cleared + ' cleared' : '') +
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

  // ---- public API ------------------------------------------------------------
  window.RW2PhotoTag = {
    tagPhotos: tagPhotos,
    ensureGeo: ensureGeo,
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
