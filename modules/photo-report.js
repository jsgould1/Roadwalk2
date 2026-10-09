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
  function sectionKey(p) {
    if (p.rip_lot && p.rip_lot_inside) return 'lot:' + p.rip_lot;   // inside a lot wins
    if (p.rip_route) return p.rip_route;
    if (p.rip_lot) return 'lot:' + p.rip_lot;
    return UNASSIGNED;
  }
  function sectionTitle(p) {
    if (p.rip_lot && p.rip_lot_inside) return '🅿 ' + p.rip_lot + (p.rip_lot_name ? ' — ' + p.rip_lot_name : '');
    if (p.rip_route) return p.rip_route + (p.rip_route_name ? ' — ' + p.rip_route_name : '');
    if (p.rip_lot) return '🅿 ' + p.rip_lot + (p.rip_lot_name ? ' — ' + p.rip_lot_name : '');
    return 'Unassigned (no route/lot tag)';
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

  // Printed photo cells are small, so the stored ~1600px display image is far
  // bigger than the page needs. Re-encode each image to PRINT_MAX px on the
  // long edge (JPEG) just for the print window — cuts the inlined base64 by
  // ~50-70%, so the browser's Save-as-PDF rasterization is much faster. Images
  // already at/under the cap pass through untouched. Never throws: on any
  // failure the original data URL is returned.
  var PRINT_MAX = 1100, PRINT_Q = 0.8;
  function downscaleForPrint(dataUrl) {
    if (!dataUrl || dataUrl.indexOf('data:image') !== 0) return Promise.resolve(dataUrl);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var long = Math.max(img.naturalWidth, img.naturalHeight);
        if (!long || long <= PRINT_MAX) { resolve(dataUrl); return; }
        try {
          var s = PRINT_MAX / long;
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * s));
          c.height = Math.max(1, Math.round(img.naturalHeight * s));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', PRINT_Q));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
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

    // resolve every image (incl. offloaded) + the AECOM logo up front
    var ids = []; secs.forEach(function (s) { s.photos.forEach(function (p) { ids.push(p.id); }); });
    Promise.all([
      fetchLogoFile('aecom-logo-black.png'),
      fetchLogoFile('nps-logo.png'),
      loadParkNames(),
      Promise.all(ids.map(function (id) { return imageFor(id).then(downscaleForPrint).then(function (d) { return { id: id, d: d }; }); })),
    ]).then(function (all) {
        var blackLogo = all[0], npsLogo = all[1], res = all[3];
        var img = {}; var missing = 0;
        res.forEach(function (r) { if (r.d) img[r.id] = r.d; else missing++; });
        var code = (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
        var park = ($('pr-park') && $('pr-park').value) || _parkName || parkFullName(code) || code;
        var wmOn = !$('pr-wm') || $('pr-wm').checked;
        // Prefer the official black AECOM logo; fall back to the app reverse logo, darkened.
        var aecomLogo = blackLogo || (document.querySelector('.aecom-logo') || {}).src || '';
        var aecomBlack = !!blackLogo;
        var pagesHtml = '';
        secs.forEach(function (s) {
          var usable = s.photos.filter(function (p) { return img[p.id]; });
          var pages = chunk6(usable);
          var routeId = (s.key === UNASSIGNED) ? 'Unassigned' : (s.key.indexOf('lot:') === 0 ? s.key.slice(4) : s.key);
          pages.forEach(function (pagePhotos, pi) {
            pagesHtml += pageHtml({ park: park, aecomLogo: aecomLogo, aecomBlack: aecomBlack, npsLogo: npsLogo,
              secTitle: s.title, routeId: routeId, pageIdx: pi + 1, pageCount: pages.length, photos: pagePhotos, img: img, wmOn: wmOn });
          });
        });
        if (!pagesHtml) { status('No printable images (all offloaded with no stored copy?).'); return; }
        openPrint(pagesHtml);
        status('Opened print view' + (missing ? ' · ' + missing + ' photo(s) had no image' : '') + '. Use "Save as PDF".');
      });
  }

  // Survey station from along-route feet: 1234 ft → "12+34".
  function fmtSta(ft) { var s = Math.max(0, Math.round(ft)); return Math.floor(s / 100) + '+' + String(s % 100).padStart(2, '0'); }
  // 16-point compass heading: 110° → "ESE".
  var _CARD16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function cardinal(deg) { return _CARD16[Math.round((((+deg % 360) + 360) % 360) / 22.5) % 16]; }

  // NPS unit code -> full park name (from nps-park-names.json; cached).
  var _parkNames = null, _parkNamesP = null;
  function loadParkNames() {
    if (_parkNames) return Promise.resolve(_parkNames);
    if (_parkNamesP) return _parkNamesP;
    _parkNamesP = fetch('nps-park-names.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { _parkNames = j || {}; return _parkNames; })
      .catch(function () { _parkNames = {}; return _parkNames; });
    return _parkNamesP;
  }
  function parkFullName(code) {
    if (!code) return '';
    var n = _parkNames && _parkNames[code];
    return (n && typeof n === 'string' && n.charAt(0) !== '_') ? n : code;
  }
  window.RW2ParkNames = { load: loadParkNames, full: parkFullName };

  // Load a logo file from the app root as a data URI (cached once per name).
  var _logoCache = {};
  function fetchLogoFile(name) {
    if (name in _logoCache) return Promise.resolve(_logoCache[name]);
    return fetch(name, { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw 0; return r.blob(); })
      .then(function (b) { return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(b); }); })
      .then(function (d) { _logoCache[name] = d || null; return _logoCache[name]; })
      .catch(function () { _logoCache[name] = null; return null; });
  }

  // Watermark content as ordered lines (top row = route + FMSS, then STA/MP,
  // then GPS + bearing, then capture date/time).
  // Layout (space-separated columns, no dot separators):
  //   ROUTE-ID   ROUTE NAME                             (bold)
  //   FMSS 12345
  //   STA 12+34   MP 0.23   37.531053, -85.733772   110° (ESE)
  //   AECOM   9/28/2026, 3:53:13 PM
  function watermarkLines(p) {
    var lines = [];
    var gps = (isFinite(Number(p.lat)) && isFinite(Number(p.lng))) ? (Number(p.lat).toFixed(6) + ', ' + Number(p.lng).toFixed(6)) : '';
    var brg = (p.bearing != null && isFinite(Number(p.bearing))) ? (Math.round(p.bearing) + '° (' + cardinal(p.bearing) + ')') : '';
    var dt = '';
    if (p.ts) { var d = new Date(p.ts); if (!isNaN(d.getTime())) dt = d.toLocaleString(); }

    if (p.rip_route) {
      lines.push(p.rip_route + (p.rip_route_name ? '   ' + p.rip_route_name : ''));
      if (p.rip_route_fmss) lines.push('FMSS ' + p.rip_route_fmss);
      var l3 = [];
      if (p.rip_route_sta != null) l3.push('STA ' + fmtSta(p.rip_route_sta));
      if (p.rip_route_mp != null) l3.push('MP ' + Number(p.rip_route_mp).toFixed(2));
      if (gps) l3.push(gps);
      if (brg) l3.push(brg);
      if (l3.length) lines.push(l3.join('   '));
    } else {
      var head = p.rip_lot ? (p.rip_lot + (p.rip_lot_name ? '   ' + p.rip_lot_name : '')) : '';
      if (head) { lines.push(head); lines.push(p.rip_lot_fmss ? ('FMSS ' + p.rip_lot_fmss + '   parking lot') : 'parking lot'); }
      var lg = [];
      if (gps) lg.push(gps); if (brg) lg.push(brg);
      if (lg.length) lines.push(lg.join('   '));
    }
    var l4 = ['AECOM', dt].filter(Boolean).join('   ');
    if (l4) lines.push(l4);
    return lines;
  }

  function pageHtml(o) {
    var lay = layoutFor(o.photos.length);
    var cells = o.photos.map(function (p, i) {
      var full = lay.fulls[i] ? ' full' : '';
      var cap = (p.description || '').trim();
      var wmLines = o.wmOn ? watermarkLines(p) : [];
      var metaHtml = wmLines.map(function (l, li) {
        return '<div' + (li === 0 ? ' class="wm0"' : '') + '>' + esc(l) + '</div>';
      }).join('');
      // info bar: metadata left, typed description right (wraps)
      var wmHtml = (metaHtml || cap)
        ? '<div class="wm"><div class="wm-l">' + metaHtml + '</div>' +
          (cap ? '<div class="wm-r">' + esc(cap) + '</div>' : '') + '</div>'
        : '';
      return '<div class="cell' + full + '">' +
        '<div class="imgbox"><img src="' + o.img[p.id] + '">' + wmHtml + '</div></div>';
    }).join('');
    var npsHtml = o.npsLogo ? '<img class="nps-logo" src="' + o.npsLogo + '" alt="NPS">' : '';
    var aecomHtml = o.aecomLogo ? '<img class="ftr-logo' + (o.aecomBlack ? ' blk' : '') + '" src="' + o.aecomLogo + '" alt="AECOM">' : '<span class="ftr-aecom">AECOM</span>';
    var parkHtml = esc(o.park).replace(/ National\b/, '<br>National');
    // section title: route/lot ID on row 1, the route name on row 2 (wraps)
    var sci = o.secTitle.indexOf(' — ');
    var scHtml = (sci >= 0)
      ? '<span class="sc-id">' + esc(o.secTitle.slice(0, sci)) + '</span><span class="sc-nm">' + esc(o.secTitle.slice(sci + 3)) + '</span>'
      : '<span class="sc-nm">' + esc(o.secTitle) + '</span>';
    return '<section class="page" style="--rows:' + lay.rows + '">' +
      '<div class="phdr">' + npsHtml +
      '<span class="pk">' + parkHtml + '</span>' +
      '<span class="sc">' + scHtml + '</span></div>' +
      '<div class="grid">' + cells + '</div>' +
      '<div class="pftr">' + aecomHtml +
      '<div class="pftr-r"><span class="rid">' + esc(o.routeId) + '</span><span class="pg">Page ' + o.pageIdx + ' of ' + o.pageCount + '</span></div>' +
      '</div></section>';
  }

  function openPrint(pagesHtml) {
    var w = window.open('', '_blank');
    if (!w) { status('Pop-up blocked — allow pop-ups to print the report.'); return; }
    var css =
      '@page{size:letter portrait;margin:0.45in}' +
      '*{box-sizing:border-box}' +
      'html,body{margin:0;padding:0;font-family:"IBM Plex Sans",system-ui,sans-serif;color:#1A1D22}' +
      // Fixed page box, clipped so nothing can spill onto (and overlap) the next
      // printed page; small height buffer keeps a section to exactly one sheet.
      '.page{height:9.9in;display:flex;flex-direction:column;overflow:hidden;page-break-after:always;break-after:page;break-inside:avoid;page-break-inside:avoid}' +
      '.page:last-child{page-break-after:auto;break-after:auto}' +
      // header: NPS logo + full park name (navy) at top-left, section at right
      '.phdr{display:flex;align-items:center;gap:10px;border-bottom:2px solid #16315E;padding-bottom:6px;margin-bottom:9px;flex:0 0 auto}' +
      '.phdr .nps-logo{height:48px;width:auto;object-fit:contain;flex:0 0 auto}' +
      '.phdr .pk{font-weight:800;font-size:17px;color:#16315E;letter-spacing:.2px;line-height:1.12;white-space:normal}' +
      '.phdr .sc{flex:1 1 auto;text-align:right;align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15}' +
      '.phdr .sc .sc-id{font-weight:700;font-size:14px;color:#5b6673;letter-spacing:.4px}' +
      '.phdr .sc .sc-nm{font-weight:700;font-size:14px;color:#5b6673;white-space:normal}' +
      '.grid{flex:1 1 auto;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:repeat(var(--rows),1fr);gap:0.16in;min-height:0}' +
      '.cell{display:flex;flex-direction:column;min-height:0;min-width:0}' +
      '.cell.full{grid-column:1 / -1}' +
      // engineering look: white, thin border, photo fills the frame so the
      // watermark sits across the bottom of the actual image
      '.imgbox{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;border:0.75pt solid #9aa3ad;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.imgbox img{width:100%;height:100%;object-fit:cover;display:block}' +
      // solid info bar across the bottom of the image
      '.wm{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,0.68);color:#fff;font:600 8px "IBM Plex Mono",monospace;letter-spacing:.2px;padding:4px 8px 5px;display:flex;justify-content:space-between;align-items:flex-end;gap:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.wm-l{flex:1 1 auto;min-width:0}' +
      '.wm-l div{line-height:1.45;white-space:pre}' +
      '.wm-l .wm0{font-weight:800;font-size:9.5px;letter-spacing:.4px}' +
      '.wm-r{flex:0 1 auto;max-width:48%;text-align:right;align-self:flex-end;font:italic 600 8px "IBM Plex Sans",system-ui;letter-spacing:.1px;line-height:1.32;white-space:normal;overflow-wrap:anywhere}' +
      // footer: AECOM logo (bottom-left) + Route ID over Page N of X (bottom-right)
      '.pftr{flex:0 0 auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:1pt solid #c7ccd2;margin-top:8px;padding-top:6px}' +
      '.pftr .ftr-logo{height:16px;width:auto;object-fit:contain}' +
      '.pftr .ftr-logo:not(.blk){filter:brightness(0)}' +
      '.pftr .ftr-aecom{font:800 12px "IBM Plex Sans",system-ui;color:#16315E;letter-spacing:1px}' +
      '.pftr-r{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font:600 9px "IBM Plex Mono",monospace;color:#5b6673;letter-spacing:.3px}' +
      '.pftr-r .rid{font-weight:800;color:#16315E;font-size:10px}';
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
      $('pr-wm').addEventListener('change', function () { try { localStorage.setItem('rw_export_watermark', $('pr-wm').checked ? '1' : '0'); } catch (e) {} });
    }
    ov.classList.add('on');
    // Reflect the global export-watermark setting (save/copy/print share it).
    var pw = $('pr-wm'); if (pw) { try { pw.checked = localStorage.getItem('rw_export_watermark') !== '0'; } catch (e) {} }
    // Warm the route geometry so STA/MP are ready when Generate is clicked.
    if (window.RW2PhotoTag && window.RW2PhotoTag.ensureGeo) { try { window.RW2PhotoTag.ensureGeo(); } catch (e) {} }
    // Auto-fill the Park field with the full park name for the loaded park.
    var code = (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
    if (code) loadParkNames().then(function () {
      var pf = $('pr-park'); if (pf && (!pf.value || pf.value === code)) { pf.value = parkFullName(code); _parkName = pf.value; }
    });
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

  window.RW2PhotoReport = { open: openOverlay, generate: generate, grouped: grouped, layoutFor: layoutFor, watermarkLines: watermarkLines, fmtSta: fmtSta };
})();
