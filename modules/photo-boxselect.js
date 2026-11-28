/* ============================================================================
   RoadWalk 2 — BOX-SELECT RE-PIN (on the map)
   ----------------------------------------------------------------------------
   Adds a map control button (▢). Toggle it on, drag a rectangle over the map,
   and every LOADED photo marker whose position falls inside the box is selected.
   Then pick one route/lot and all selected photos are re-pinned at once
   (RW2PhotoTag.assignTarget), with a one-click Undo that restores the prior tags.

   Pure add-on: reuses the shared map (window._RW.state.map) and the tag API;
   no core render code is touched. Honors the current View-by-route filter and
   only selects photos that are in RAM (markers you can actually see).
   ========================================================================== */
(function () {
  'use strict';

  function geo() { return (window._RW && window._RW.geophotos) || null; }
  function map() { return (window._RW && window._RW.state && window._RW.state.map) || null; }
  function tag() { return window.RW2PhotoTag || null; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var ALL = '__all__', UNTAGGED = '__untagged__';
  function curFilter() { return (window.RW2RouteView && window.RW2RouteView.current && window.RW2RouteView.current()) || ALL; }
  function isLoaded(p) { return !!(p && p.dataUrl); }
  function matchesFilter(p) {
    var f = curFilter();
    if (f === ALL) return true;
    if (f === UNTAGGED) return !p.rip_route && !p.rip_lot;
    if (f.indexOf('lot:') === 0) return p.rip_lot === f.slice(4);
    return p.rip_route === f;
  }
  // photos whose markers are visible: finite GPS, loaded in RAM, pass the filter
  function candidates() {
    var g = geo(); if (!g) return [];
    return g.list().filter(function (p) {
      return isLoaded(p) && matchesFilter(p) && isFinite(p.lat) && isFinite(p.lng);
    });
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyles() {
    if ($('bxs-style')) return;
    var st = document.createElement('style'); st.id = 'bxs-style';
    st.textContent =
      '.bxs-ctrl a{font:700 16px/26px system-ui;text-align:center;cursor:pointer;color:#1A1D22}' +
      '.bxs-ctrl a.on{background:var(--orange,#C85A2B);color:#fff}' +
      '.bxs-rect{position:absolute;z-index:650;border:2px dashed var(--orange,#C85A2B);background:rgba(200,90,43,.14);pointer-events:none;border-radius:3px}' +
      '.bxs-crosshair .leaflet-container,.bxs-crosshair .leaflet-grab{cursor:crosshair !important}' +
      '.bxs-banner{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:680;background:#12233b;color:#fff;' +
        'font:700 12px system-ui;padding:7px 13px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}' +
      '.bxs-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5200;background:#12233b;color:#fff;padding:9px 14px;' +
        'border-radius:999px;font:600 12.5px system-ui;box-shadow:0 4px 18px rgba(0,0,0,.35);display:flex;align-items:center;gap:12px;max-width:92vw}' +
      '.bxs-toast button{background:#f2b705;color:#1a1d22;border:0;border-radius:6px;padding:4px 10px;font:700 12px system-ui;cursor:pointer}' +
      '#bxs-pick{position:fixed;inset:0;z-index:5100;background:rgba(16,20,28,.5);display:none;align-items:center;justify-content:center}' +
      '#bxs-pick.on{display:flex}' +
      '#bxs-pick .card{width:min(440px,94vw);max-height:80vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45);font-family:system-ui}' +
      '#bxs-pick .hd{padding:11px 14px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff;font:800 13.5px system-ui;color:#16315E}' +
      '#bxs-pick input{margin:10px 14px 0;padding:7px 10px;border:1px solid var(--rule,#DDD7C8);border-radius:8px;font:500 13px system-ui}' +
      '#bxs-pick .list{flex:1;overflow:auto;padding:6px 10px 12px;margin-top:8px}' +
      '#bxs-pick .sec{font:800 10px system-ui;letter-spacing:.07em;text-transform:uppercase;color:#9BA0A8;margin:8px 6px 4px}' +
      '#bxs-pick .opt{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer}' +
      '#bxs-pick .opt:hover{background:#eef2f6}' +
      '#bxs-pick .opt .id{font:700 12px "IBM Plex Mono",monospace;color:#0B3D66;white-space:nowrap}' +
      '#bxs-pick .opt .nm{font:500 12px system-ui;color:#5b6673;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#bxs-pick .opt.rev{color:#8a4b00}' +
      '#bxs-pick .ftr{padding:9px 14px;border-top:1px solid var(--rule,#DDD7C8);background:#fff;text-align:right}' +
      '#bxs-pick .ftr button{font:700 12.5px system-ui;padding:7px 12px;border-radius:8px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}';
    document.head.appendChild(st);
  }

  function toast(msg, undoFn) {
    var t = document.createElement('div'); t.className = 'bxs-toast';
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    if (undoFn) { var u = document.createElement('button'); u.textContent = 'Undo'; u.onclick = function () { t.remove(); undoFn(); }; t.appendChild(u); }
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, undoFn ? 9000 : 3500);
  }

  // ---- selection drag state --------------------------------------------------
  var active = false, ctrlEl = null, rectEl = null, banner = null;
  var dragging = false, x0 = 0, y0 = 0;

  function container() { var m = map(); return m ? m.getContainer() : null; }

  function setBanner(txt) {
    var c = container(); if (!c) return;
    if (!banner) { banner = document.createElement('div'); banner.className = 'bxs-banner'; c.appendChild(banner); }
    banner.textContent = txt;
  }
  function clearBanner() { if (banner) { try { banner.remove(); } catch (e) {} banner = null; } }

  function enter() {
    var m = map(), c = container(); if (!m || !c) return;
    active = true;
    if (ctrlEl) ctrlEl.classList.add('on');
    c.classList.add('bxs-crosshair');           // (also set on <html> below for the grab layer)
    document.documentElement.classList.add('bxs-crosshair');
    try { m.dragging && m.dragging.disable(); } catch (e) {}
    try { m.boxZoom && m.boxZoom.disable(); } catch (e) {}
    try { m.doubleClickZoom && m.doubleClickZoom.disable(); } catch (e) {}
    setBanner('Box re-pin — drag a box over the photos, then pick a route/lot  ·  Esc to cancel');
    c.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }
  function exit() {
    var m = map(), c = container();
    active = false; dragging = false;
    if (ctrlEl) ctrlEl.classList.remove('on');
    if (c) { c.classList.remove('bxs-crosshair'); c.removeEventListener('mousedown', onDown, true); }
    document.documentElement.classList.remove('bxs-crosshair');
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('keydown', onKey, true);
    removeRect(); clearBanner();
    if (m) { try { m.dragging && m.dragging.enable(); } catch (e) {} }
  }
  function toggle() { active ? exit() : enter(); }

  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); exit(); } }

  function removeRect() { if (rectEl) { try { rectEl.remove(); } catch (e) {} rectEl = null; } }

  function localXY(e) {
    var c = container(), r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (!active || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var p = localXY(e); x0 = p.x; y0 = p.y; dragging = true;
    removeRect();
    rectEl = document.createElement('div'); rectEl.className = 'bxs-rect';
    rectEl.style.left = x0 + 'px'; rectEl.style.top = y0 + 'px'; rectEl.style.width = '0px'; rectEl.style.height = '0px';
    container().appendChild(rectEl);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }
  function onMove(e) {
    if (!dragging) return;
    var p = localXY(e);
    var left = Math.min(x0, p.x), top = Math.min(y0, p.y), w = Math.abs(p.x - x0), h = Math.abs(p.y - y0);
    rectEl.style.left = left + 'px'; rectEl.style.top = top + 'px'; rectEl.style.width = w + 'px'; rectEl.style.height = h + 'px';
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    var p = localXY(e);
    var left = Math.min(x0, p.x), top = Math.min(y0, p.y), right = Math.max(x0, p.x), bottom = Math.max(y0, p.y);
    removeRect();
    if ((right - left) < 4 && (bottom - top) < 4) { return; }  // treat a click as no-op
    var m = map();
    var ids = candidates().filter(function (ph) {
      var cp = m.latLngToContainerPoint(L.latLng(ph.lat, ph.lng));
      return cp.x >= left && cp.x <= right && cp.y >= top && cp.y <= bottom;
    }).map(function (ph) { return ph.id; });
    if (!ids.length) { setBanner('No photos in the box — try again  ·  Esc to cancel'); return; }
    openPicker(ids);
  }

  // ---- target picker (routes + lots) ----------------------------------------
  function snapshot(ids) {
    var g = geo(), m = {};
    ids.forEach(function (id) {
      var p = g.get ? g.get(id) : null;
      if (!p) return;
      m[id] = { rip_route: p.rip_route, rip_lot: p.rip_lot, rip_lot_inside: p.rip_lot_inside, rip_manual: p.rip_manual };
    });
    return m;
  }
  function restore(snap) {
    var T = tag(); if (!T) return Promise.resolve(0);
    var ids = Object.keys(snap), chain = Promise.resolve(), n = 0;
    ids.forEach(function (id) {
      var s = snap[id];
      chain = chain.then(function () {
        if (!s.rip_manual) return T.clearManual(id).then(function () { n++; });      // was auto → re-derive
        if (s.rip_lot && (s.rip_lot_inside || !s.rip_route)) return T.assignTarget(id, s.rip_lot, 'lot').then(function () { n++; });
        if (s.rip_route) return T.assignTarget(id, s.rip_route, 'route').then(function () { n++; });
        return T.clearManual(id).then(function () { n++; });
      });
    });
    return chain.then(function () { return n; });
  }

  function refreshAll() {
    var g = geo(); if (g && g.refresh) { try { g.refresh(); } catch (e) {} }
    if (window._RW && typeof window._RW.rerender === 'function') { try { window._RW.rerender(); } catch (e) {} }
    if (window.RW2RouteView && window.RW2RouteView.refresh) { try { window.RW2RouteView.refresh(); } catch (e) {} }
  }

  function applyBatch(ids, ident, kind) {
    var T = tag(); if (!T) return;
    var snap = snapshot(ids);
    var chain = Promise.resolve(), n = 0;
    ids.forEach(function (id) {
      chain = chain.then(function () {
        var pr = (kind === 'revert') ? T.clearManual(id) : T.assignTarget(id, ident, kind);
        return pr.then(function () { n++; });
      });
    });
    chain.then(function () {
      refreshAll();
      exit();
      var where = kind === 'revert' ? 'auto-tag' : (kind === 'lot' ? '🅿 ' : '') + ident;
      toast('Re-pinned ' + n + ' photo' + (n === 1 ? '' : 's') + ' → ' + where, function () {
        restore(snap).then(function (k) { refreshAll(); toast('Undid ' + k + ' re-pin' + (k === 1 ? '' : 's') + '.'); });
      });
    });
  }

  function openPicker(ids) {
    var T = tag(); if (!T || !T.targetsList) { toast('Tagging module not available.'); return; }
    ensureStyles();
    var pk = $('bxs-pick');
    if (!pk) {
      pk = document.createElement('div'); pk.id = 'bxs-pick';
      pk.innerHTML = '<div class="card"><div class="hd" id="bxs-pick-hd">Assign selected →</div>' +
        '<input id="bxs-pick-srch" placeholder="Filter by ID or name…" spellcheck="false">' +
        '<div class="list" id="bxs-pick-list"></div>' +
        '<div class="ftr"><button id="bxs-pick-x">Cancel</button></div></div>';
      document.body.appendChild(pk);
      pk.addEventListener('click', function (e) { if (e.target === pk) pk.classList.remove('on'); });
      $('bxs-pick-x').onclick = function () { pk.classList.remove('on'); };
    }
    $('bxs-pick-hd').textContent = 'Re-pin ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + ' →';
    var list = $('bxs-pick-list'), srch = $('bxs-pick-srch'); srch.value = '';
    list.innerHTML = '<div class="sec">Loading…</div>';
    pk.classList.add('on');
    T.targetsList().then(function (t) {
      function draw(filter) {
        filter = (filter || '').toLowerCase();
        function mm(o) { return !filter || o.ident.toLowerCase().indexOf(filter) !== -1 || (o.name || '').toLowerCase().indexOf(filter) !== -1; }
        var rs = (t.routes || []).filter(mm), ls = (t.lots || []).filter(mm), html = '';
        html += '<div class="opt rev" data-kind="revert"><span class="id">↺ revert</span><span class="nm">clear manual pin — back to auto-tag</span></div>';
        if (rs.length) html += '<div class="sec">Routes</div>' + rs.map(function (o) {
          return '<div class="opt" data-ident="' + esc(o.ident) + '" data-kind="route"><span class="id">' + esc(o.ident) + '</span><span class="nm">' + esc(o.name || '') + '</span></div>';
        }).join('');
        if (ls.length) html += '<div class="sec">Parking lots</div>' + ls.map(function (o) {
          return '<div class="opt" data-ident="' + esc(o.ident) + '" data-kind="lot"><span class="id">🅿 ' + esc(o.ident) + '</span><span class="nm">' + esc(o.name || '') + '</span></div>';
        }).join('');
        if (!rs.length && !ls.length) html += '<div class="sec">No match</div>';
        list.innerHTML = html;
      }
      draw('');
      srch.oninput = function () { draw(srch.value); };
      list.onclick = function (e) {
        var opt = e.target.closest ? e.target.closest('.opt') : null; if (!opt) return;
        pk.classList.remove('on');
        applyBatch(ids, opt.getAttribute('data-ident'), opt.getAttribute('data-kind'));
      };
    }, function () { list.innerHTML = '<div class="sec">Could not load targets</div>'; });
  }

  // ---- mount the map control -------------------------------------------------
  var wired = false;
  function mount() {
    if (wired) return;
    var m = map(); if (!m || !window.L) return;
    ensureStyles();
    var Ctrl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'leaflet-bar bxs-ctrl');
        var a = L.DomUtil.create('a', '', c);
        a.href = '#'; a.title = 'Box re-pin — drag a box over photos to re-pin them to a route/lot';
        a.innerHTML = '▢';
        L.DomEvent.on(a, 'click', function (e) { L.DomEvent.stop(e); toggle(); });
        L.DomEvent.disableClickPropagation(c);
        ctrlEl = a;
        return c;
      }
    });
    try { new Ctrl().addTo(m); wired = true; } catch (e) {}
  }
  var iv = setInterval(function () { mount(); if (wired) clearInterval(iv); }, 800);
  setTimeout(mount, 600);

  window.RW2BoxSelect = { toggle: toggle, isActive: function () { return active; } };
})();
