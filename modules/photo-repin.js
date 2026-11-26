/* ============================================================================
   RoadWalk 2 — BATCH RE-PIN + BEARING AUTO-FIX
   ----------------------------------------------------------------------------
   Lives in the "View by route / lot" block (photo-route-view.js). Two tools:

   • ✨ Auto-fix off-road → lots — runs RW2PhotoTag.autoRepinByBearing(): any
     road-tagged photo whose EXIF camera bearing is ~perpendicular to the road
     AND looks into a parking-lot polygon is re-pinned to that lot (locked
     rip_manual). Shows what moved, with one-click Undo.

   • ▦ Re-pin grid — a thumbnail grid of the photos in the current route/lot
     filter, each with a checkbox (suspects pre-flagged). Select many → assign
     them all to one route or lot at once. Reuses RW2PhotoTag.assignTarget.

   Pure add-on; no core render code is touched.
   ========================================================================== */
(function () {
  'use strict';

  function geo() { return (window._RW && window._RW.geophotos) || null; }
  function tag() { return window.RW2PhotoTag || null; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function cardinal(b) { if (b == null || !isFinite(b)) return ''; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b % 360) + 360) % 360 / 45) % 8]; }

  var ALL = '__all__', UNTAGGED = '__untagged__';
  function curFilter() { return (window.RW2RouteView && window.RW2RouteView.current && window.RW2RouteView.current()) || ALL; }
  function photoMatches(p, f) {
    if (f === ALL) return true;
    if (f === UNTAGGED) return !p.rip_route && !p.rip_lot;
    if (f.indexOf('lot:') === 0) return p.rip_lot === f.slice(4);
    return p.rip_route === f;
  }
  function curTagLabel(p) {
    if (p.rip_lot && (p.rip_lot_inside || !p.rip_route)) return { kind: 'lot', ident: p.rip_lot, name: p.rip_lot_name || '' };
    if (p.rip_route) return { kind: 'route', ident: p.rip_route, name: p.rip_route_name || '' };
    return { kind: '', ident: '', name: '' };
  }

  function toast(msg, undoFn) {
    var t = document.createElement('div');
    t.className = 'rpn-toast';
    t.innerHTML = '<span>' + esc(msg) + '</span>';
    if (undoFn) {
      var u = document.createElement('button'); u.textContent = 'Undo';
      u.onclick = function () { t.remove(); undoFn(); };
      t.appendChild(u);
    }
    document.body.appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (e) {} }, undoFn ? 9000 : 3500);
  }

  // ---- styles ----------------------------------------------------------------
  function ensureStyles() {
    if ($('rpn-style')) return;
    var st = document.createElement('style'); st.id = 'rpn-style';
    st.textContent =
      '#rpn-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}' +
      '#rpn-bar button{font:600 11.5px system-ui;padding:5px 9px;border-radius:7px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer;color:var(--ink,#1A1D22)}' +
      '#rpn-bar button:disabled{opacity:.5;cursor:not-allowed}' +
      '#rpn-bar button.go{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}' +
      '.rpn-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:5200;background:#12233b;color:#fff;padding:9px 14px;border-radius:999px;font:600 12.5px system-ui;box-shadow:0 4px 18px rgba(0,0,0,.35);display:flex;align-items:center;gap:12px;max-width:92vw}' +
      '.rpn-toast button{background:#f2b705;color:#1a1d22;border:0;border-radius:6px;padding:4px 10px;font:700 12px system-ui;cursor:pointer}' +
      '#rpn-ov{position:fixed;inset:0;z-index:5000;background:rgba(16,20,28,.55);display:none;align-items:center;justify-content:center}' +
      '#rpn-ov.on{display:flex}' +
      '#rpn-card{width:min(940px,96vw);max-height:90vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45);font-family:system-ui}' +
      '#rpn-card .hd{padding:11px 15px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff;display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '#rpn-card .hd b{color:#16315E;font-size:14.5px}' +
      '#rpn-card .hd .sp{flex:1}' +
      '#rpn-card .hd button{font:600 12px system-ui;padding:6px 10px;border-radius:7px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}' +
      '#rpn-card .hd button.go{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}' +
      '#rpn-card .hd button:disabled{opacity:.5;cursor:not-allowed}' +
      '#rpn-grid{overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}' +
      '.rpn-cell{position:relative;border:2px solid transparent;border-radius:9px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12);cursor:pointer}' +
      '.rpn-cell.sel{border-color:var(--orange,#C85A2B)}' +
      '.rpn-cell.suspect{box-shadow:0 0 0 2px #f2b705 inset}' +
      '.rpn-cell img{display:block;width:100%;height:92px;object-fit:cover;background:#e7e2d6}' +
      '.rpn-cell .cap{padding:4px 6px 6px;font:600 10px system-ui;color:#5b6673;line-height:1.3}' +
      '.rpn-cell .cap .id{color:#0B3D66;font-weight:700;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.rpn-cell .chip{display:inline-block;margin-top:2px;padding:1px 5px;border-radius:5px;background:#eef2f6;color:#5b6673;font:700 9.5px system-ui}' +
      '.rpn-cell .chip.lot{background:#e7f1ea;color:#1b6b4a}' +
      '.rpn-cell .sus{display:block;margin-top:2px;color:#9a7400;font:700 9.5px system-ui}' +
      '.rpn-cell .ck{position:absolute;top:5px;left:5px;width:20px;height:20px;border-radius:5px;background:rgba(255,255,255,.92);border:1.5px solid #9BA0A8;display:flex;align-items:center;justify-content:center;font:800 13px system-ui;color:#C85A2B}' +
      '.rpn-cell.sel .ck{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}' +
      '.rpn-cell .brg{position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;background:rgba(18,35,59,.78)}' +
      '.rpn-cell .brg svg{display:block}' +
      '.rpn-cell:hover{box-shadow:0 2px 10px rgba(0,0,0,.28)}' +
      // floating hover preview (full, uncropped image shown large beside the grid)
      '#rpn-prev{position:fixed;z-index:5300;pointer-events:none;display:none;border-radius:10px;overflow:hidden;background:#000;border:2px solid #fff;box-shadow:0 12px 44px rgba(0,0,0,.5)}' +
      '#rpn-prev img{display:block;max-width:46vw;max-height:76vh;width:auto;height:auto}' +
      '#rpn-prev .pcap{position:absolute;left:0;right:0;bottom:0;padding:5px 9px;font:700 11px system-ui;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.72));text-shadow:0 1px 2px #000}' +
      '#rpn-empty{padding:30px;text-align:center;color:#8a949f;font:600 13px system-ui}' +
      // batch target picker
      '#rpn-pick{position:fixed;inset:0;z-index:5100;background:rgba(16,20,28,.5);display:none;align-items:center;justify-content:center}' +
      '#rpn-pick.on{display:flex}' +
      '#rpn-pick .card{width:min(440px,94vw);max-height:80vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45)}' +
      '#rpn-pick .hd{padding:11px 14px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff;font:800 13.5px system-ui;color:#16315E}' +
      '#rpn-pick input{margin:10px 14px 0;padding:7px 10px;border:1px solid var(--rule,#DDD7C8);border-radius:8px;font:500 13px system-ui}' +
      '#rpn-pick .list{flex:1;overflow:auto;padding:6px 10px 12px;margin-top:8px}' +
      '#rpn-pick .sec{font:800 10px system-ui;letter-spacing:.07em;text-transform:uppercase;color:#9BA0A8;margin:8px 6px 4px}' +
      '#rpn-pick .opt{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer}' +
      '#rpn-pick .opt:hover{background:#eef2f6}' +
      '#rpn-pick .opt .id{font:700 12px "IBM Plex Mono",monospace;color:#0B3D66;white-space:nowrap}' +
      '#rpn-pick .opt .nm{font:500 12px system-ui;color:#5b6673;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#rpn-pick .ftr{padding:9px 14px;border-top:1px solid var(--rule,#DDD7C8);background:#fff;text-align:right}' +
      '#rpn-pick .ftr button{font:700 12.5px system-ui;padding:7px 12px;border-radius:8px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}';
    document.head.appendChild(st);
  }

  // bearing arrow svg (points toward camera heading; 0°=up=N, CW)
  function brgSvg(b) {
    if (b == null || !isFinite(b)) return '';
    return '<svg width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(' + (Math.round(b)) + 'deg)">' +
      '<path d="M11 3 L15 15 L11 12 L7 15 Z" fill="#fff"/></svg>';
  }

  // ---- the grid --------------------------------------------------------------
  var selected = {};   // id -> true

  function eligiblePhotos() {
    var g = geo(); if (!g) return { shown: [], offloaded: 0 };
    var f = curFilter(), shown = [], offloaded = 0;
    g.list().forEach(function (p) {
      if (!photoMatches(p, f)) return;
      if (!p.dataUrl) { offloaded++; return; }
      shown.push(p);
    });
    return { shown: shown, offloaded: offloaded };
  }

  // ---- hover preview ---------------------------------------------------------
  var prevEl = null;
  function hidePrev() { if (prevEl) prevEl.style.display = 'none'; }
  function positionPrev(cell) {
    if (!prevEl) return;
    var r = cell.getBoundingClientRect(), pr = prevEl.getBoundingClientRect(), gap = 14;
    var left = r.right + gap;
    if (left + pr.width > window.innerWidth - 8) left = r.left - gap - pr.width; // flip to the left
    if (left < 8) left = Math.max(8, (window.innerWidth - pr.width) / 2);        // last resort: center
    var top = r.top + r.height / 2 - pr.height / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));
    prevEl.style.left = Math.round(left) + 'px';
    prevEl.style.top = Math.round(top) + 'px';
  }
  function showPrev(cell) {
    var img = cell.querySelector('img'); if (!img || !img.getAttribute('src')) return;
    if (!prevEl) {
      prevEl = document.createElement('div'); prevEl.id = 'rpn-prev';
      prevEl.innerHTML = '<img alt=""><div class="pcap"></div>';
      document.body.appendChild(prevEl);
      prevEl.querySelector('img').addEventListener('load', function () {
        if (prevEl._cell && prevEl.style.display !== 'none') positionPrev(prevEl._cell);
      });
    }
    var pimg = prevEl.querySelector('img'), src = img.getAttribute('src');
    if (pimg.getAttribute('src') !== src) pimg.setAttribute('src', src);
    var idEl = cell.querySelector('.cap .id');
    prevEl.querySelector('.pcap').textContent = idEl ? idEl.textContent : '';
    prevEl._cell = cell;
    prevEl.style.display = 'block';
    positionPrev(cell);                              // place now (cached image)
    requestAnimationFrame(function () { if (prevEl.style.display !== 'none') positionPrev(cell); });
  }

  function renderGrid() {
    var grid = $('rpn-grid'); if (!grid) return;
    hidePrev();
    var res = eligiblePhotos(), T = tag();
    var f = curFilter();
    var label = f === ALL ? 'all routes & lots' : f === UNTAGGED ? 'untagged' : f.indexOf('lot:') === 0 ? 'lot ' + f.slice(4) : f;
    $('rpn-scope').textContent = label + ' · ' + res.shown.length + ' photo' + (res.shown.length === 1 ? '' : 's') +
      (res.offloaded ? ' (' + res.offloaded + ' offloaded, load to edit)' : '');
    if (!res.shown.length) { grid.innerHTML = '<div id="rpn-empty">No loaded photos in this view.</div>'; updateCount(); return; }
    var html = '';
    res.shown.forEach(function (p) {
      var ct = curTagLabel(p);
      var info = (T && T.offRoadInfo) ? T.offRoadInfo(p) : { suspect: false };
      var sel = !!selected[p.id];
      html += '<div class="rpn-cell' + (sel ? ' sel' : '') + (info.suspect ? ' suspect' : '') + '" data-id="' + esc(p.id) + '">' +
        '<div class="ck">' + (sel ? '✓' : '') + '</div>' +
        (p.bearing != null && isFinite(p.bearing) ? '<div class="brg" title="camera ' + Math.round(p.bearing) + '° ' + cardinal(p.bearing) + '">' + brgSvg(p.bearing) + '</div>' : '') +
        '<img loading="lazy" src="' + (p.dataUrl || '') + '" alt="">' +
        '<div class="cap"><span class="id">' + esc(p.name || p.id) + '</span>' +
        (ct.ident ? '<span class="chip' + (ct.kind === 'lot' ? ' lot' : '') + '">' + (ct.kind === 'lot' ? '🅿 ' : '') + esc(ct.ident) + '</span>' : '<span class="chip">untagged</span>') +
        (info.suspect ? '<span class="sus">📸 faces 🅿 ' + esc(info.lot.ident) + ' (' + info.offAxis + '°)</span>' : '') +
        '</div></div>';
    });
    grid.innerHTML = html;
    updateCount();
  }

  function updateCount() {
    var n = Object.keys(selected).length;
    var b = $('rpn-assign'); if (b) { b.disabled = !n; b.textContent = 'Assign selected' + (n ? ' (' + n + ') →' : ' →'); }
    var c = $('rpn-count'); if (c) c.textContent = n ? n + ' selected' : '';
  }

  function openGrid() {
    ensureStyles();
    var ov = $('rpn-ov');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'rpn-ov';
      ov.innerHTML =
        '<div id="rpn-card">' +
          '<div class="hd"><b>Re-pin photos</b><span id="rpn-scope" style="font:600 11.5px system-ui;color:#8a949f"></span>' +
            '<span class="sp"></span><span id="rpn-count" style="font:700 11.5px system-ui;color:#C85A2B"></span>' +
            '<button id="rpn-selsus" title="Select every photo flagged as facing a lot">Select suspects</button>' +
            '<button id="rpn-selall">Select all</button>' +
            '<button id="rpn-selnone">Clear</button>' +
            '<button class="go" id="rpn-assign" disabled>Assign selected →</button>' +
            '<button id="rpn-close">Close</button></div>' +
          '<div id="rpn-grid"></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
      $('rpn-close').onclick = function () { ov.classList.remove('on'); };
      $('rpn-selall').onclick = function () { eligiblePhotos().shown.forEach(function (p) { selected[p.id] = true; }); renderGrid(); };
      $('rpn-selnone').onclick = function () { selected = {}; renderGrid(); };
      $('rpn-selsus').onclick = function () {
        var T = tag(); selected = {};
        eligiblePhotos().shown.forEach(function (p) { if (T && T.offRoadInfo && T.offRoadInfo(p).suspect) selected[p.id] = true; });
        renderGrid();
      };
      $('rpn-assign').onclick = openPicker;
      var grid = $('rpn-grid');
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest ? e.target.closest('.rpn-cell') : null; if (!cell) return;
        var id = cell.getAttribute('data-id');
        if (selected[id]) delete selected[id]; else selected[id] = true;
        cell.classList.toggle('sel'); cell.querySelector('.ck').textContent = selected[id] ? '✓' : '';
        updateCount();
      });
      // hover preview: enlarge the hovered thumbnail beside the grid
      grid.addEventListener('mouseover', function (e) {
        var cell = e.target.closest ? e.target.closest('.rpn-cell') : null; if (cell) showPrev(cell);
      });
      grid.addEventListener('mouseleave', hidePrev);
      grid.addEventListener('scroll', hidePrev);
      ov.addEventListener('click', hidePrev, true);   // hide while clicking/closing
    }
    selected = {};
    ov.classList.add('on');
    renderGrid();
  }

  // ---- batch target picker ---------------------------------------------------
  function openPicker() {
    var T = tag(); if (!T || !T.targetsList) return;
    var ids = Object.keys(selected); if (!ids.length) return;
    ensureStyles();
    var pk = $('rpn-pick');
    if (!pk) {
      pk = document.createElement('div'); pk.id = 'rpn-pick';
      pk.innerHTML = '<div class="card"><div class="hd" id="rpn-pick-hd">Assign selected →</div>' +
        '<input id="rpn-pick-srch" placeholder="Filter by ID or name…" spellcheck="false">' +
        '<div class="list" id="rpn-pick-list"></div>' +
        '<div class="ftr"><button id="rpn-pick-x">Cancel</button></div></div>';
      document.body.appendChild(pk);
      pk.addEventListener('click', function (e) { if (e.target === pk) pk.classList.remove('on'); });
      $('rpn-pick-x').onclick = function () { pk.classList.remove('on'); };
    }
    $('rpn-pick-hd').textContent = 'Assign ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + ' →';
    var list = $('rpn-pick-list'), srch = $('rpn-pick-srch'); srch.value = '';
    list.innerHTML = '<div class="sec">Loading…</div>';
    pk.classList.add('on');
    T.targetsList().then(function (t) {
      function draw(filter) {
        filter = (filter || '').toLowerCase();
        function m(o) { return !filter || o.ident.toLowerCase().indexOf(filter) !== -1 || (o.name || '').toLowerCase().indexOf(filter) !== -1; }
        var rs = t.routes.filter(m), ls = t.lots.filter(m), html = '';
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
        var ident = opt.getAttribute('data-ident'), kind = opt.getAttribute('data-kind');
        applyBatch(ids, ident, kind);
        pk.classList.remove('on');
      };
    });
  }

  function applyBatch(ids, ident, kind) {
    var T = tag(); if (!T || !T.assignTarget) return;
    var chain = Promise.resolve(), n = 0;
    ids.forEach(function (id) { chain = chain.then(function () { return T.assignTarget(id, ident, kind).then(function () { n++; }); }); });
    chain.then(function () {
      selected = {};
      renderGrid();
      if (window.RW2RouteView && window.RW2RouteView.refresh) try { window.RW2RouteView.refresh(); } catch (e) {}
      var g = geo(); if (g) try { g.refresh(); } catch (e) {}
      toast('Re-pinned ' + n + ' photo' + (n === 1 ? '' : 's') + ' → ' + (kind === 'lot' ? '🅿 ' : '') + ident);
    });
  }

  // ---- auto-fix --------------------------------------------------------------
  function autoFix(btn) {
    var T = tag();
    if (!T || !T.autoRepinByBearing) { toast('Auto-fix not available.'); return; }
    if (btn) btn.disabled = true;
    T.autoRepinByBearing().then(function (r) {
      if (btn) btn.disabled = false;
      if (!r.ok) { toast(r.reason || 'Auto-fix could not run.'); return; }
      if (window.RW2RouteView && window.RW2RouteView.refresh) try { window.RW2RouteView.refresh(); } catch (e) {}
      if ($('rpn-ov') && $('rpn-ov').classList.contains('on')) renderGrid();
      if (!r.moved) { toast(r.note ? 'No off-road shots found (' + r.note + ').' : 'No off-road shots found — nothing moved.'); return; }
      toast('Moved ' + r.moved + ' photo' + (r.moved === 1 ? '' : 's') + ' to the lot they face.', function () {
        T.undoAutoRepin().then(function (k) {
          if (window.RW2RouteView && window.RW2RouteView.refresh) try { window.RW2RouteView.refresh(); } catch (e) {}
          if ($('rpn-ov') && $('rpn-ov').classList.contains('on')) renderGrid();
          toast('Undid ' + k + ' move' + (k === 1 ? '' : 's') + '.');
        });
      });
    }, function (e) { if (btn) btn.disabled = false; toast('Auto-fix failed: ' + (e && e.message ? e.message : e)); });
  }

  // ---- mount into the "View by route" block ----------------------------------
  function mount() {
    var block = $('prv-block'); if (!block || $('rpn-bar')) return;
    ensureStyles();
    var bar = document.createElement('div'); bar.id = 'rpn-bar';
    bar.innerHTML =
      '<button class="go" id="rpn-auto" title="Re-pin road photos whose camera bearing faces into a parking lot">✨ Auto-fix off-road → lots</button>' +
      '<button id="rpn-open" title="Thumbnail grid: select several photos and re-pin them to a route or lot at once">▦ Re-pin grid</button>';
    block.appendChild(bar);
    $('rpn-auto').onclick = function () { autoFix($('rpn-auto')); };
    $('rpn-open').onclick = openGrid;
  }
  setInterval(mount, 1000);
  setTimeout(mount, 700);

  window.RW2Repin = { openGrid: openGrid, autoFix: function () { autoFix(null); } };
})();
