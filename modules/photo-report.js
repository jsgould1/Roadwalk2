/* ============================================================================
   RoadWalk 2 — PHOTO REPORT  (heart a selection → printable PDF)  [port win #3]
   ----------------------------------------------------------------------------
   Opens a report builder: field photos grouped by SECTION (the RIP route a
   photo is tagged to via photo-autotag), each with a heart toggle and an
   editable caption. "Generate PDF" opens a print-ready window laid out 6
   photos per portrait page with these fill rules, then the browser's Save-as-
   PDF produces the file (no external library — works offline):

     1 → full-width · 2 → stacked top/bottom · 3 → 2 top + 1 full bottom
     4 → 2 + 2 · 5 → 2 + 2 + 1 full · 6 → 2 + 2 + 2 · 7+ → next page

   Each page header shows "Park — Section" top-left. Hearted photos whose image
   set is offloaded are pulled back from the blob store just for printing.

   Persists p.hearted (bool) and p.description (the caption) on each geophoto.
   ========================================================================== */
(function () {
  'use strict';

  function geo() { return (window._RW && window._RW.geophotos) || null; }
  function psets() { return window.RW2PhotoSets || null; }
  function rip() { return window.RW2RIP || null; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var UNASSIGNED = '__unassigned__';
  var _parkName = '';

  // ---- data ------------------------------------------------------------------
  function sectionKey(p) { return p.rip_route || UNASSIGNED; }
  function sectionTitle(p) {
    if (!p.rip_route) return 'Unassigned (no route tag)';
    return p.rip_route + (p.rip_route_name ? ' — ' + p.rip_route_name : '');
  }
  // → [{key,title,photos:[...]}], sorted by route ident, Unassigned last
  function grouped(heartedOnly) {
    var g = geo(); if (!g) return [];
    var m = {}, order = [];
    g.list().forEach(function (p) {
      if (heartedOnly && !p.hearted) return;
      var k = sectionKey(p);
      if (!m[k]) { m[k] = { key: k, title: sectionTitle(p), photos: [] }; order.push(k); }
      m[k].photos.push(p);
    });
    order.sort(function (a, b) {
      if (a === UNASSIGNED) return 1; if (b === UNASSIGNED) return -1; return a < b ? -1 : 1;
    });
    // chronological within a section
    order.forEach(function (k) { m[k].photos.sort(function (x, y) { return String(x.ts || '') < String(y.ts || '') ? -1 : 1; }); });
    return order.map(function (k) { return m[k]; });
  }

  function imageFor(id) {
    var ps = psets();
    if (ps && ps.imageFor) return ps.imageFor(id);
    var p = geo() && geo().get(id);
    return Promise.resolve(p && p.dataUrl || null);
  }

  // ---- layout rule -----------------------------------------------------------
  // For n photos on a page (1..6): visual rows + which cell indices span both cols.
  function layoutFor(n) {
    switch (n) {
      case 1: return { rows: 1, fulls: { 0: 1 } };
      case 2: return { rows: 2, fulls: { 0: 1, 1: 1 } };     // stacked top/bottom
      case 3: return { rows: 2, fulls: { 2: 1 } };           // 2 top, 1 full bottom
      case 4: return { rows: 2, fulls: {} };                 // 2 + 2
      case 5: return { rows: 3, fulls: { 4: 1 } };           // 2 + 2 + 1 full
      default: return { rows: 3, fulls: {} };                // 6 → 2 + 2 + 2
    }
  }
  function chunk6(arr) { var out = []; for (var i = 0; i < arr.length; i += 6) out.push(arr.slice(i, i + 6)); return out; }

  // ---- PDF (print window) ----------------------------------------------------
  function generate() {
    var secs = grouped(true);
    var total = 0; secs.forEach(function (s) { total += s.photos.length; });
    if (!total) { status('Heart at least one photo first.'); return; }
    status('Preparing ' + total + ' photo(s)…');

    // Fill STA/MP for photos tagged before station support (route geometry is
    // already cached after tagging; station() returns null if not yet built).
    if (window.RW2PhotoTag && window.RW2PhotoTag.station) {
      secs.forEach(function (s) { s.photos.forEach(function (p) {
        if (p.rip_route && (p.rip_route_mp == null || p.rip_route_sta == null) && isFinite(Number(p.lat)) && isFinite(Number(p.lng))) {
          try { var st = window.RW2PhotoTag.station(Number(p.lat), Number(p.lng), p.rip_route); if (st) { p.rip_route_sta = st.sta; p.rip_route_mp = st.mp; } } catch (e) {}
        }
      }); });
    }

    // resolve every image (incl. offloaded) up front
    var ids = []; secs.forEach(function (s) { s.photos.forEach(function (p) { ids.push(p.id); }); });
    Promise.all(ids.map(function (id) { return imageFor(id).then(function (d) { return { id: id, d: d }; }); }))
      .then(function (res) {
        var img = {}; var missing = 0;
        res.forEach(function (r) { if (r.d) img[r.id] = r.d; else missing++; });
        var park = ($('pr-park') && $('pr-park').value) || _parkName || (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
        var wmOn = !$('pr-wm') || $('pr-wm').checked;
        var pagesHtml = '';
        secs.forEach(function (s) {
          var usable = s.photos.filter(function (p) { return img[p.id]; });
          chunk6(usable).forEach(function (pagePhotos) {
            pagesHtml += pageHtml(park, s.title, pagePhotos, img, wmOn);
          });
        });
        if (!pagesHtml) { status('No printable images (all offloaded with no stored copy?).'); return; }
        openPrint(pagesHtml);
        status('Opened print view' + (missing ? ' · ' + missing + ' photo(s) had no image' : '') + '. Use "Save as PDF".');
      });
  }

  // Survey station from along-route feet: 1234 ft → "12+34".
  function fmtSta(ft) { var s = Math.max(0, Math.round(ft)); return Math.floor(s / 100) + '+' + String(s % 100).padStart(2, '0'); }

  // Watermark content as ordered lines (top row = route + FMSS, then STA/MP,
  // then GPS + bearing, then capture date/time).
  function watermarkLines(p) {
    var lines = [];
    if (p.rip_route) {
      lines.push(p.rip_route + (p.rip_route_name ? '  ·  ' + p.rip_route_name : ''));
      var sm = [];
      if (p.rip_route_fmss) sm.push('FMSS ' + p.rip_route_fmss);
      if (p.rip_route_sta != null) sm.push('STA ' + fmtSta(p.rip_route_sta));
      if (p.rip_route_mp != null) sm.push('MP ' + Number(p.rip_route_mp).toFixed(2));
      if (sm.length) lines.push(sm.join('  ·  '));
    } else if (p.rip_lot) {
      lines.push(p.rip_lot + (p.rip_lot_name ? '  ·  ' + p.rip_lot_name : ''));
      if (p.rip_lot_fmss) lines.push('FMSS ' + p.rip_lot_fmss + ' · parking lot');
      else lines.push('parking lot');
    }
    var g = [];
    if (isFinite(Number(p.lat)) && isFinite(Number(p.lng))) g.push(Number(p.lat).toFixed(6) + ', ' + Number(p.lng).toFixed(6));
    if (p.bearing != null && isFinite(Number(p.bearing))) g.push(Math.round(p.bearing) + '°');
    if (g.length) lines.push(g.join('  ·  '));
    if (p.ts) { var d = new Date(p.ts); if (!isNaN(d.getTime())) lines.push(d.toLocaleString()); }
    return lines;
  }

  function pageHtml(park, secTitle, photos, img, wmOn) {
    var lay = layoutFor(photos.length);
    var cells = photos.map(function (p, i) {
      var full = lay.fulls[i] ? ' full' : '';
      var cap = (p.description || '').trim();
      var wmLines = wmOn ? watermarkLines(p) : [];
      var wmHtml = wmLines.length ? '<div class="wm">' + wmLines.map(function (l, li) {
        return '<div' + (li === 0 ? ' class="wm0"' : '') + '>' + esc(l) + '</div>';
      }).join('') + '</div>' : '';
      return '<div class="cell' + full + '">' +
        '<div class="imgbox"><img src="' + img[p.id] + '">' + wmHtml + '</div>' +
        '<div class="cap">' + esc(cap) + '</div></div>';
    }).join('');
    return '<section class="page" style="--rows:' + lay.rows + '">' +
      '<div class="phdr"><span class="pk">' + esc(park) + '</span>' +
      '<span class="sc">' + esc(secTitle) + '</span></div>' +
      '<div class="grid">' + cells + '</div></section>';
  }

  function openPrint(pagesHtml) {
    var w = window.open('', '_blank');
    if (!w) { status('Pop-up blocked — allow pop-ups to print the report.'); return; }
    var css =
      '@page{size:letter portrait;margin:0.5in}' +
      '*{box-sizing:border-box}' +
      'html,body{margin:0;padding:0;font-family:"IBM Plex Sans",system-ui,sans-serif;color:#1A1D22}' +
      '.page{height:10in;display:flex;flex-direction:column;page-break-after:always;overflow:hidden}' +
      '.page:last-child{page-break-after:auto}' +
      '.phdr{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid #0B3D66;padding-bottom:5px;margin-bottom:10px;flex:0 0 auto}' +
      '.phdr .pk{font-weight:700;font-size:15px;color:#0B3D66}' +
      '.phdr .sc{font-weight:600;font-size:12.5px;color:#555}' +
      '.grid{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(var(--rows),1fr);gap:0.22in;min-height:0}' +
      '.cell{display:flex;flex-direction:column;min-height:0;min-width:0}' +
      '.cell.full{grid-column:1 / -1}' +
      '.imgbox{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;background:#F4F1E8;border:1px solid #DDD7C8}' +
      '.imgbox img{max-width:100%;max-height:100%;object-fit:contain}' +
      '.wm{position:absolute;left:0;bottom:0;max-width:100%;background:rgba(17,17,17,0.64);color:#fff;font:600 8px "IBM Plex Mono",monospace;letter-spacing:.2px;padding:3px 7px;border-radius:0 6px 0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.wm div{line-height:1.4;white-space:nowrap}' +
      '.wm .wm0{font-weight:700;font-size:9px}' +
      '.cap{flex:0 0 auto;font-size:10.5px;line-height:1.3;color:#1A1D22;padding:4px 2px 0;min-height:14px}';
    w.document.open();
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>RoadWalk Photo Report</title><style>' + css + '</style></head><body>' + pagesHtml + '</body></html>');
    w.document.close();
    // give the data-URL images a tick to paint, then invoke print
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 400);
  }

  // ---- builder overlay -------------------------------------------------------
  function status(msg) { var el = $('pr-status'); if (el) el.textContent = msg || ''; }

  var _capTimer = null;
  function saveCaption(p, val) {
    p.description = val;
    clearTimeout(_capTimer);
    _capTimer = setTimeout(function () { try { geo().save(p); } catch (e) {} }, 400);
  }
  function toggleHeart(p, on) {
    p.hearted = !!on;
    try { geo().save(p); } catch (e) {}
  }

  function renderBuilder() {
    var host = $('pr-body'); if (!host) return;
    var heartedOnly = $('pr-hearted') && $('pr-hearted').checked;
    var secs = grouped(heartedOnly);
    var counts = 0; grouped(true).forEach(function (s) { counts += s.photos.length; });
    if ($('pr-count')) $('pr-count').textContent = counts + ' hearted';
    if (!secs.length) { host.innerHTML = '<div class="pr-empty">No photos' + (heartedOnly ? ' hearted yet' : ' yet') + '.</div>'; return; }

    host.innerHTML = secs.map(function (s) {
      var cards = s.photos.map(function (p) {
        return '<div class="pr-card" data-id="' + esc(p.id) + '">' +
          '<button class="pr-heart' + (p.hearted ? ' on' : '') + '" title="Include in report">' + (p.hearted ? '♥' : '♡') + '</button>' +
          '<div class="pr-thumb" data-img="' + esc(p.id) + '"></div>' +
          '<textarea class="pr-cap" rows="2" placeholder="Caption / description…">' + esc(p.description || '') + '</textarea>' +
          '</div>';
      }).join('');
      return '<div class="pr-sec"><div class="pr-sec-h">' + esc(s.title) +
        ' <span class="pr-sec-n">' + s.photos.length + '</span></div>' +
        '<div class="pr-grid">' + cards + '</div></div>';
    }).join('');

    // wire cards + lazy-load thumbnails (works for offloaded sets too)
    Array.prototype.forEach.call(host.querySelectorAll('.pr-card'), function (card) {
      var id = card.getAttribute('data-id');
      var p = geo().get(id);
      var heart = card.querySelector('.pr-heart');
      heart.addEventListener('click', function () {
        var on = !p.hearted; toggleHeart(p, on);
        heart.classList.toggle('on', on); heart.textContent = on ? '♥' : '♡';
        if ($('pr-count')) { var c = 0; grouped(true).forEach(function (x) { c += x.photos.length; }); $('pr-count').textContent = c + ' hearted'; }
        if (heartedOnly && !on) renderBuilder();
      });
      var cap = card.querySelector('.pr-cap');
      cap.addEventListener('input', function () { saveCaption(p, cap.value); });
      var thumb = card.querySelector('.pr-thumb');
      imageFor(id).then(function (d) { if (d) thumb.style.backgroundImage = 'url(' + d + ')'; else thumb.classList.add('pr-off'); });
    });
  }

  function ensureStyles() {
    if ($('pr-style')) return;
    var st = document.createElement('style'); st.id = 'pr-style';
    st.textContent =
      '#pr-overlay{position:fixed;inset:0;z-index:4000;background:rgba(20,22,28,.55);display:none}' +
      '#pr-overlay.on{display:flex}' +
      '#pr-card{margin:auto;width:min(960px,94vw);height:min(88vh,900px);background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}' +
      '#pr-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff}' +
      '#pr-top .t{font-weight:700;color:var(--blue,#0B3D66);font-size:15px}' +
      '#pr-top .sp{flex:1 1 auto}' +
      '#pr-park{font:600 13px system-ui;padding:5px 8px;border:1px solid var(--rule,#DDD7C8);border-radius:6px;min-width:200px}' +
      '#pr-body{flex:1 1 auto;overflow:auto;padding:12px 16px}' +
      '.pr-empty{color:var(--mute,#9BA0A8);padding:30px;text-align:center}' +
      '.pr-sec{margin-bottom:16px}' +
      '.pr-sec-h{font:700 12.5px "IBM Plex Mono",monospace;color:var(--ink,#1A1D22);padding:6px 0;border-bottom:1px solid var(--rule,#DDD7C8);margin-bottom:8px}' +
      '.pr-sec-n{color:var(--mute,#9BA0A8);font-weight:500}' +
      '.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}' +
      '.pr-card{position:relative;background:#fff;border:1px solid var(--rule,#DDD7C8);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:6px}' +
      '.pr-thumb{height:110px;border-radius:5px;background:#ECE8DC center/cover no-repeat}' +
      '.pr-thumb.pr-off{background:#ECE8DC}' +
      '.pr-heart{position:absolute;top:9px;right:9px;z-index:2;width:28px;height:28px;border-radius:50%;border:none;background:rgba(255,255,255,.9);color:#C85A2B;font-size:16px;cursor:pointer;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.2)}' +
      '.pr-heart.on{background:#C85A2B;color:#fff}' +
      '.pr-cap{font:500 11.5px system-ui;border:1px solid var(--rule,#DDD7C8);border-radius:5px;padding:4px 6px;resize:vertical;width:100%}' +
      '.pr-btn{font:600 12.5px system-ui;padding:6px 12px;border-radius:7px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}' +
      '.pr-btn.go{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}';
    document.head.appendChild(st);
  }

  function openOverlay() {
    ensureStyles();
    var ov = $('pr-overlay');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pr-overlay';
      ov.innerHTML =
        '<div id="pr-card">' +
          '<div id="pr-top">' +
            '<span class="t">🖨 Photo report</span>' +
            '<label style="font:600 12px system-ui;color:#555">Park&nbsp;<input id="pr-park" placeholder="Park name"></label>' +
            '<label style="font:600 12px system-ui;color:#555;display:flex;align-items:center;gap:4px"><input type="checkbox" id="pr-hearted" checked> hearted only</label>' +
            '<label style="font:600 12px system-ui;color:#555;display:flex;align-items:center;gap:4px" title="Overlay GPS + date/time on each photo in the PDF"><input type="checkbox" id="pr-wm" checked> watermark</label>' +
            '<span id="pr-count" style="font:600 12px \'IBM Plex Mono\',monospace;color:var(--mute,#9BA0A8)">0 hearted</span>' +
            '<span class="sp"></span>' +
            '<span id="pr-status" style="font:500 11.5px system-ui;color:var(--mute,#9BA0A8)"></span>' +
            '<button class="pr-btn go" id="pr-go">Generate PDF</button>' +
            '<button class="pr-btn" id="pr-close">Close</button>' +
          '</div>' +
          '<div id="pr-body"></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
      $('pr-close').addEventListener('click', closeOverlay);
      $('pr-go').addEventListener('click', generate);
      $('pr-hearted').addEventListener('change', renderBuilder);
      // prefill park name from the loaded bundle, upgrade to full name if indexed
      var code = (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
      $('pr-park').value = _parkName || code;
      if (code) tryParkName(code).then(function (nm) { if (nm && !$('pr-park').value) $('pr-park').value = nm; else if (nm && $('pr-park').value === code) $('pr-park').value = nm; _parkName = $('pr-park').value; });
    }
    ov.classList.add('on');
    // Warm the route geometry so STA/MP are ready when Generate is clicked.
    if (window.RW2PhotoTag && window.RW2PhotoTag.ensureGeo) { try { window.RW2PhotoTag.ensureGeo(); } catch (e) {} }
    // Auto-fill the Park field from the loaded park each time it opens (if empty).
    var code = (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
    var pf = $('pr-park'); if (pf && !pf.value && code) pf.value = code;
    renderBuilder();
  }
  function closeOverlay() { var ov = $('pr-overlay'); if (ov) ov.classList.remove('on'); }

  function tryParkName(code) {
    return fetch('data/rip/parks_index.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) {
        if (!idx) return null;
        var list = Array.isArray(idx) ? idx : (idx.parks || []);
        var hit = list.find(function (e) { return (e.code || e.park) === code; });
        return hit ? (hit.name || hit.park_name || hit.full_name || null) : null;
      }).catch(function () { return null; });
  }

  // ---- launcher button (triage tools row) ------------------------------------
  function addLauncher() {
    var tools = document.getElementById('tg-tools');
    if (!tools || $('pr-open')) return;
    var b = document.createElement('button');
    b.id = 'pr-open'; b.className = 'tg-suggest-btn'; b.type = 'button';
    b.title = 'Heart a selection of photos per section and print them to a PDF';
    b.style.marginTop = '6px';
    b.innerHTML = '🖨 Photo report (PDF)';
    b.addEventListener('click', openOverlay);
    tools.appendChild(b);
  }
  function whenReady() {
    if (document.getElementById('tg-tools')) { addLauncher(); return; }
    var tries = 0, iv = setInterval(function () {
      if (document.getElementById('tg-tools') || ++tries > 40) { clearInterval(iv); addLauncher(); }
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenReady);
  else whenReady();

  window.RW2PhotoReport = { open: openOverlay, generate: generate, grouped: grouped, layoutFor: layoutFor };
})();
