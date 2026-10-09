/* ============================================================================
   RoadWalk 2 — VIEW PHOTOS BY ROUTE
   ----------------------------------------------------------------------------
   After photos are auto-tagged (photo-autotag.js writes p.rip_route), this adds
   a "View by route" dropdown to the Field Photos panel. Picking a route filters
   the map's photo layer to that route's photos and zooms to them; picking "All
   routes" restores everything. Works by wrapping the shared
   window._RW.photoFilter.apply gate that the map render already consults, so no
   core render code changes.
   ========================================================================== */
(function () {
  'use strict';

  function geo() { return (window._RW && window._RW.geophotos) || null; }
  function map() { return (window._RW && window._RW.state && window._RW.state.map) || null; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var ALL = '__all__', UNTAGGED = '__untagged__';
  var routeFilter = ALL;

  function matches(p) {
    if (routeFilter === ALL) return true;
    if (routeFilter === UNTAGGED) return !p.rip_route;
    return p.rip_route === routeFilter;
  }

  // Wrap the shared photo filter so the map render hides non-matching photos.
  function installWrap() {
    if (!(window._RW && window._RW.photoFilter) || window._RW.photoFilter._routeWrapped) return false;
    var orig = window._RW.photoFilter.apply;
    window._RW.photoFilter.apply = function (p) {
      if (orig && !orig.call(this, p)) return false;
      return matches(p);
    };
    window._RW.photoFilter._routeWrapped = true;
    return true;
  }

  function refreshLayer() {
    if (window._RW && window._RW.geophotos && window._RW.geophotos.refresh) window._RW.geophotos.refresh();
    if (window._RW && typeof window._RW.rerender === 'function') { try { window._RW.rerender(); } catch (e) {} }
  }

  function zoomToFilter() {
    var m = map(), g = geo(); if (!m || !g) return;
    var pts = g.list().filter(function (p) { return matches(p) && isFinite(p.lat) && isFinite(p.lng); })
                      .map(function (p) { return [p.lat, p.lng]; });
    if (!pts.length) return;
    if (pts.length === 1) { m.setView(pts[0], Math.max(m.getZoom(), 17)); return; }
    try { m.fitBounds(pts, { padding: [40, 40], maxZoom: 18 }); } catch (e) {}
  }

  // Build the <option> list from the photos' current route tags.
  function rebuildOptions() {
    var sel = $('prv-select'); if (!sel) return;
    var g = geo(); var counts = {}, untagged = 0;
    (g ? g.list() : []).forEach(function (p) {
      if (p.rip_route) counts[p.rip_route] = (counts[p.rip_route] || 0) + 1; else untagged++;
    });
    var idents = Object.keys(counts).sort();
    var nameOf = {};
    (g ? g.list() : []).forEach(function (p) { if (p.rip_route && !nameOf[p.rip_route]) nameOf[p.rip_route] = p.rip_route_name || ''; });
    var total = idents.reduce(function (a, k) { return a + counts[k]; }, 0);
    var html = '<option value="' + ALL + '">All routes (' + total + ')</option>';
    idents.forEach(function (k) {
      html += '<option value="' + esc(k) + '">' + esc(k) + (nameOf[k] ? ' · ' + esc(nameOf[k]) : '') + ' (' + counts[k] + ')</option>';
    });
    if (untagged) html += '<option value="' + UNTAGGED + '">— untagged (' + untagged + ') —</option>';
    var keep = sel.value;
    sel.innerHTML = html;
    sel.value = [ALL, UNTAGGED].indexOf(keep) !== -1 || counts[keep] ? keep : ALL;
    routeFilter = sel.value;
  }

  function buildUI() {
    var body = document.querySelector('#photos-panel .pp-body');
    if (!body || $('prv-block')) return;
    var block = document.createElement('div');
    block.id = 'prv-block';
    block.style.cssText = 'margin-top:10px;padding-top:8px;border-top:2px solid var(--rule,#DDD7C8)';
    block.innerHTML =
      '<div style="font:700 11px \'IBM Plex Mono\',monospace;letter-spacing:.06em;color:var(--blue,#0B3D66);margin-bottom:6px">VIEW BY ROUTE</div>' +
      '<select id="prv-select" title="Show only photos tagged to this route" ' +
        'style="width:100%;font:600 12px system-ui;padding:5px 7px;border:1px solid var(--rule,#DDD7C8);border-radius:6px;background:var(--paper,#FBFAF6);color:var(--ink,#1A1D22)">' +
        '<option value="' + ALL + '">All routes</option></select>' +
      '<div id="prv-hint" style="margin-top:4px;font:500 10.5px system-ui;color:var(--mute,#9BA0A8)">Tag photos first, then filter the map by route.</div>';
    body.appendChild(block);

    var sel = $('prv-select');
    sel.addEventListener('mousedown', rebuildOptions);  // freshen just before opening
    sel.addEventListener('focus', rebuildOptions);
    sel.addEventListener('change', function () {
      routeFilter = sel.value;
      installWrap();
      refreshLayer();
      zoomToFilter();
      var hint = $('prv-hint');
      if (hint) hint.textContent = routeFilter === ALL ? 'Showing all photos.' :
        (routeFilter === UNTAGGED ? 'Showing untagged photos.' : 'Showing photos on ' + routeFilter + '.');
    });
    installWrap();
    rebuildOptions();
  }

  function whenReady() {
    if (document.querySelector('#photos-panel .pp-body')) { buildUI(); return; }
    var tries = 0, iv = setInterval(function () {
      if (document.querySelector('#photos-panel .pp-body') || ++tries > 40) { clearInterval(iv); buildUI(); }
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenReady);
  else whenReady();

  window.RW2RouteView = {
    refresh: rebuildOptions,
    set: function (ident) { var sel = $('prv-select'); if (sel) { rebuildOptions(); sel.value = ident; routeFilter = ident; installWrap(); refreshLayer(); zoomToFilter(); } },
    current: function () { return routeFilter; },
  };
})();
