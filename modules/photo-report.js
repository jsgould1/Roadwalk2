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
    // arranged order within a section (explicit drag order, else chronological)
    order.forEach(function (k) { m[k].photos.sort(cmpOrder); });
    return order.map(function (k) { return m[k]; });
  }

  // Park (unit) code for a section key. Route/lot idents carry the park prefix,
  // e.g. "WRBR-0010AZ" -> "WRBR", "lot:ABLI-P01" -> "ABLI". Falls back to the
  // first 4 chars; UNASSIGNED has no park.
  function parkCodeOf(key) {
    if (!key || key === UNASSIGNED) return '';
    var s = (key.indexOf('lot:') === 0) ? key.slice(4) : key;
    var dash = s.indexOf('-');
    return (dash > 0 ? s.slice(0, dash) : s.slice(0, 4)).toUpperCase();
  }
  function loadedParkCode() {
    return (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
  }

  // Selection of which section keys get printed (hierarchical by park in the UI).
  // null = not initialised yet; defaults to the loaded park's sections on open.
  var _sel = null, _selParkCtx = null;
  function selectedSections(secs) {
    return secs.filter(function (s) { return !_sel || _sel[s.key]; });
  }

  // Build the "Routes to print" tree (park → its routes/lots) in #pr-tree.
  function renderTree() {
    var host = $('pr-tree'); if (!host) return;
    var secs = grouped(true);                 // only hearted sections can print
    var loaded = loadedParkCode();
    if (_sel === null) _sel = {};
    var parks = {}, porder = [];
    secs.forEach(function (s) {
      var code = parkCodeOf(s.key) || '(untagged)';
      if (!parks[code]) { parks[code] = { code: code, secs: [] }; porder.push(code); }
      parks[code].secs.push(s);
      // Default a newly-seen section to on only if it belongs to the loaded park
      // (or, if nothing is loaded, select everything).
      if (!(s.key in _sel)) _sel[s.key] = loaded ? (code === loaded) : true;
    });
    porder.sort(function (a, b) { if (a === '(untagged)') return 1; if (b === '(untagged)') return -1; return a < b ? -1 : 1; });
    if (!porder.length) { host.innerHTML = '<div class="prt-h">Routes to print</div><div class="prt-empty">No hearted photos yet.</div>'; return; }
    var html = '<div class="prt-h">Routes to print</div>';
    porder.forEach(function (code) {
      var pk = parks[code];
      var selN = pk.secs.filter(function (s) { return _sel[s.key]; }).length;
      var pname = (code === '(untagged)') ? 'Untagged' : (code + ' — ' + parkFullName(code));
      html += '<div class="prt-park"><label><input type="checkbox" class="prt-pk" data-pk="' + esc(code) + '"' + (selN === pk.secs.length ? ' checked' : '') + '>' +
        '<span>' + esc(pname) + '</span></label><div class="prt-routes">';
      pk.secs.forEach(function (s) {
        html += '<label><input type="checkbox" class="prt-rt" data-key="' + esc(s.key) + '"' + (_sel[s.key] ? ' checked' : '') + '>' +
          '<span>' + esc(s.title) + ' <span class="prt-cnt">(' + s.photos.length + ')</span></span></label>';
      });
      html += '</div></div>';
    });
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll('.prt-pk'), function (cb) {
      var pk = parks[cb.getAttribute('data-pk')];
      var selN = pk.secs.filter(function (s) { return _sel[s.key]; }).length;
      cb.indeterminate = selN > 0 && selN < pk.secs.length;
      cb.addEventListener('change', function () { pk.secs.forEach(function (s) { _sel[s.key] = cb.checked; }); prRefresh(); });
    });
    Array.prototype.forEach.call(host.querySelectorAll('.prt-rt'), function (cb) {
      cb.addEventListener('change', function () { _sel[cb.getAttribute('data-key')] = cb.checked; prRefresh(); });
    });
  }
  function updateSelCount() {
    if (!$('pr-count')) return;
    var secs = grouped(true), sel = 0, total = 0;
    secs.forEach(function (s) { total += s.photos.length; if (_sel && _sel[s.key]) sel += s.photos.length; });
    $('pr-count').textContent = sel + ' of ' + total + ' hearted selected';
  }
  function prRefresh() { renderTree(); renderBuilder(); updateSelCount(); }

  // ---- descriptions CSV round-trip ------------------------------------------
  // Export one row per photo in the current PDF selection, including a rebuilt
  // on-disk file_path so descriptions can be authored externally; import a CSV
  // to apply descriptions back to the matching photos, then re-generate.
  function csvCell(v) {
    v = (v == null) ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function photoRelPath(p) {
    if (p._relpath) return p._relpath;
    return (p._set ? p._set + '/' : '') + (p._name || '');
  }

  // Editable description rubric (house style). Shipped at the top of every
  // exported CSV as "# " comment lines so whoever authors the captions uses the
  // team's current guidance. Edited in-app; stored per machine in localStorage.
  var RUBRIC_DEFAULT = [
    'Pavement photo caption style (edit to update for the team):',
    '- Short: ~1-2 sentences or a tight phrase list. Technical pavement-engineer voice; vary the wording; do not use the word "centroid".',
    '- Surface types: dense mix asphalt (HMA), Portland cement concrete (PCC), gravel, pervious pavers, chip seal (coarse/fine), microsurfacing, crackseal. Do not infer age from color.',
    '- Distresses (name only what is visible, with low/med/high severity): edge drop-off, edge cracking, L&T (longitudinal & transverse) cracking, block cracking, alligator cracking, depressions, rutting, weathering, raveling. Flag existing and needed patching.',
    '- Markings (use sparingly, only when notable/deficient): DYCL, SYCL, SWEL, SYEL.',
    '- Features: traffic loops, gates, wheel stops, curbs/gutters, shoulders, speed bumps (good/fair/poor), sidewalks (note cracking), historic stone swales & monuments (flag when they need protection).',
    '- Curbs: note type (stone/PCC/granite) and reveal - flag low reveal (<2"); ~5-6" is normal.',
    '- Material caution: junction/pull boxes, wheel stops, and curbs may be various materials - do not state the material unless certain ("material unconfirmed").',
    '- Signs: mention only if deficient (mildew buildup, bullet holes, bent/leaning, not meeting MUTCD).'
  ].join('\n');
  function getRubric() {
    try { var v = localStorage.getItem('rw_report_rubric'); if (v != null) return v; } catch (e) {}
    return RUBRIC_DEFAULT;
  }
  function setRubric(v) { try { localStorage.setItem('rw_report_rubric', v); } catch (e) {} }
  // ── Rubric few-shot EXAMPLES ──────────────────────────────────────────────
  // Approved captions promoted from the import review live in an EXAMPLES block
  // appended to the rubric text, so they ride along in every exported CSV (the
  // next captioning pass sees how the team actually phrases things) and stay
  // visible/prunable in the ✎ Rubric editor. Human-curated, deduped, capped.
  var RUBRIC_EX_MARK = 'EXAMPLES — approved captions (edit or delete freely):';
  var RUBRIC_EX_MAX = 12;
  function splitRubric(txt) {
    txt = txt || '';
    var idx = txt.indexOf(RUBRIC_EX_MARK);
    if (idx < 0) return { rules: txt.replace(/\s+$/, ''), examples: [] };
    var ex = txt.slice(idx + RUBRIC_EX_MARK.length).split(/\r?\n/)
      .map(function (l) { return l.replace(/^\s*[•\-]\s?/, '').trim(); })
      .filter(function (l) { return l; });
    return { rules: txt.slice(0, idx).replace(/\s+$/, ''), examples: ex };
  }
  function composeRubric(rules, examples) {
    var out = (rules || '').replace(/\s+$/, '');
    if (examples && examples.length) {
      out += '\n\n' + RUBRIC_EX_MARK + '\n' + examples.map(function (e) { return '• ' + e; }).join('\n');
    }
    return out;
  }
  function rubricExamples() { return splitRubric(getRubric()).examples; }
  function addRubricExample(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'empty' };
    var s = splitRubric(getRubric());
    if (s.examples.some(function (e) { return e.toLowerCase() === text.toLowerCase(); })) {
      return { ok: false, reason: 'dup', count: s.examples.length };
    }
    s.examples.push(text);
    while (s.examples.length > RUBRIC_EX_MAX) s.examples.shift();  // drop oldest past the cap
    setRubric(composeRubric(s.rules, s.examples));
    return { ok: true, count: s.examples.length };
  }
  function openRubricEditor() {
    ensureStyles();
    var ov = $('pr-rubric');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pr-rubric';
      ov.style.cssText = 'position:fixed;inset:0;z-index:4300;background:rgba(20,22,28,.55);display:none;align-items:center;justify-content:center';
      ov.innerHTML =
        '<div style="width:min(840px,94vw);max-height:90vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45)">' +
          '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff">' +
            '<span style="font-weight:800;color:#16315E;font-size:15px">✎ Description rubric</span>' +
            '<span style="font:500 11.5px system-ui;color:#8a949f">Rides atop every exported CSV · approved captions you ★ in import land in the EXAMPLES section below (edit/prune freely)</span>' +
            '<span style="flex:1"></span><button class="pr-btn" id="pr-rub-reset">Reset to default</button></div>' +
          '<textarea id="pr-rub-text" spellcheck="false" style="flex:1 1 auto;min-height:360px;margin:12px 16px;padding:10px 12px;border:1px solid var(--rule,#DDD7C8);border-radius:8px;font:500 12.5px/1.5 ui-monospace,Consolas,monospace;color:#1A1D22;resize:vertical"></textarea>' +
          '<div style="display:flex;gap:10px;align-items:center;padding:11px 16px;border-top:1px solid var(--rule,#DDD7C8);background:#fff">' +
            '<span id="pr-rub-status" style="font:500 11.5px system-ui;color:#0e7c66"></span><span style="flex:1"></span>' +
            '<button class="pr-btn go" id="pr-rub-save">Save</button><button class="pr-btn" id="pr-rub-close">Close</button></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
      $('pr-rub-close').addEventListener('click', function () { ov.style.display = 'none'; });
      $('pr-rub-reset').addEventListener('click', function () { $('pr-rub-text').value = RUBRIC_DEFAULT; });
      $('pr-rub-save').addEventListener('click', function () {
        setRubric($('pr-rub-text').value);
        var s = $('pr-rub-status'); if (s) { s.textContent = 'Saved — rides along in the next exported CSV.'; setTimeout(function () { s.textContent = ''; }, 2600); }
      });
    }
    $('pr-rub-text').value = getRubric();
    ov.style.display = 'flex';
  }
  // hearted = TRUE/FALSE flag; original_description preserves the current text so
  // a new/expanded caption can be built in the editable `description` column.
  var CSV_HEADER = ['photo_id', 'filename', 'set', 'park', 'route', 'sta', 'mp', 'lat', 'lng', 'file_path', 'hearted', 'original_description', 'description'];
  function csvRowFor(p, base) {
    var route = p.rip_route || (p.rip_lot ? 'lot:' + p.rip_lot : '');
    var code = (p.rip_park || parkCodeOf(route) || '').toUpperCase();
    var rel = photoRelPath(p);
    var full = base ? (base + '\\' + rel.replace(/\//g, '\\')) : rel;
    var desc = p.description || '';
    return [
      p.id, p._name || '', p._set || '', code, route,
      (p.rip_route_sta != null ? fmtSta(p.rip_route_sta) : ''),
      (p.rip_route_mp != null ? p.rip_route_mp : ''),
      (isFinite(Number(p.lat)) ? Number(p.lat).toFixed(6) : ''),
      (isFinite(Number(p.lng)) ? Number(p.lng).toFixed(6) : ''),
      full, (p.hearted ? 'TRUE' : 'FALSE'), desc, desc
    ].map(csvCell).join(',');
  }
  // Build the CSV for ANY list of photos (used by the report selection and by
  // the RIP Photos tab). base = the on-disk folder for the file_path column.
  function buildCsvForPhotos(photos, base) {
    base = (base || '').trim().replace(/[\\/]+$/, '');
    var lines = [];
    // Ship the rubric as leading "# " comment lines (skipped on import; read by
    // the captioner tool so it uses the team's current style).
    getRubric().split(/\r?\n/).forEach(function (l) { lines.push('# ' + l); });
    lines.push(CSV_HEADER.map(csvCell).join(','));
    (photos || []).forEach(function (p) { lines.push(csvRowFor(p, base)); });
    return lines.join('\r\n');
  }
  function reportBaseFolder() {
    var v = ($('pr-photobase') && $('pr-photobase').value) || '';
    if (!v) { try { v = localStorage.getItem('rw_report_photo_base') || ''; } catch (e) {} }
    return v;
  }
  function downloadText(name, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 0);
    } catch (e) { status('Download failed: ' + e); }
  }
  function downloadCsvForPhotos(photos, base) {
    downloadText('photo-descriptions-' + new Date().toISOString().slice(0, 10) + '.csv', buildCsvForPhotos(photos, base));
  }
  function exportDescriptionsCsv() {
    var secs = selectedSections(grouped(true));
    var photos = []; secs.forEach(function (s) { photos = photos.concat(s.photos); });
    if (!photos.length) { status('Nothing selected — heart photos and pick routes first.'); return; }
    downloadCsvForPhotos(photos, reportBaseFolder());
    status('Exported ' + photos.length + ' row(s). Fill the "description" column, then Import CSV.');
  }
  // minimal RFC4180-ish parser → array of row arrays
  function parseCsv(text) {
    var rows = [], row = [], cell = '', i = 0, inQ = false, c;
    text = String(text).replace(/^﻿/, '');
    // Strip leading "#" comment lines (the embedded rubric) before parsing.
    text = text.replace(/^(?:#[^\r\n]*\r?\n)+/, '');
    while (i < text.length) {
      c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
      i++;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function importDescriptionsCsv(text, onDone) {
    onDone = onDone || function () {};
    var rows = parseCsv(text);
    if (!rows.length) { status('CSV is empty.'); return; }
    var head = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    var iId = head.indexOf('photo_id'), iName = head.indexOf('filename'), iSet = head.indexOf('set'), iRoute = head.indexOf('route'), iDesc = head.indexOf('description');
    if (iDesc < 0) { status('CSV needs a "description" column.'); return; }
    var g = geo(); if (!g) { status('Field photos module not available.'); return; }
    var all = g.list(), byId = {}; all.forEach(function (p) { byId[p.id] = p; });
    var autoSaves = [], autoApplied = 0, conflicts = [], unmatched = 0, unchanged = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r]; if (!row || !row.length) continue;
      var desc = ((iDesc < row.length ? row[iDesc] : '') || '').trim();
      if (!desc) continue;                       // blank cell = leave existing alone
      var p = null;
      if (iId >= 0 && row[iId]) p = byId[row[iId].trim()];
      if (!p && iName >= 0 && row[iName]) {       // fallback: filename (+ set)
        var fn = row[iName].trim(), st = (iSet >= 0 && row[iSet]) ? row[iSet].trim() : null;
        p = all.filter(function (x) { return x._name === fn && (st == null || (x._set || '') === st); })[0]
          || all.filter(function (x) { return x._name === fn; })[0];
      }
      if (!p) { unmatched++; continue; }
      var old = (p.description || '').trim();
      if (old === desc) { unchanged++; continue; }
      if (!old) { p.description = desc; autoSaves.push(p); autoApplied++; }   // blank -> fill, no prompt
      else { conflicts.push({ id: p.id, name: p._name || '', route: (iRoute >= 0 && row[iRoute]) ? row[iRoute] : (p.rip_route || p.rip_lot || ''), old: old, neu: desc }); }
    }
    Promise.all(autoSaves.map(function (p) { try { return geo().save(p); } catch (e) { return null; } })).then(function () {
      if (conflicts.length) {
        openCsvReview(conflicts, { autoApplied: autoApplied, unmatched: unmatched, unchanged: unchanged }, onDone);
      } else {
        renderBuilder();
        status('Applied ' + autoApplied + ' description(s)' + (unchanged ? ' · ' + unchanged + ' unchanged' : '') + (unmatched ? ' · ' + unmatched + ' unmatched' : '') + '.');
        onDone();
      }
    });
  }

  // Review panel: only for CONFLICTS (photo already has a different description).
  // Each row shows Current vs New with an approve checkbox; blanks were filled
  // automatically and are reported in the footer.
  function openCsvReview(conflicts, info, onDone) {
    onDone = onDone || function () {};
    ensureStyles();   // dialog may open from the RIP/File tab with the builder closed
    var ov = $('pr-csvreview');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pr-csvreview';
      ov.innerHTML =
        '<div class="pr-cr-card">' +
          '<div class="pr-cr-head"><span class="pr-cr-t">Review description changes</span>' +
            '<span class="pr-cr-sub" id="pr-cr-sub"></span><span class="sp"></span>' +
            '<label class="pr-cr-alllbl"><input type="checkbox" id="pr-cr-all" checked> approve all</label></div>' +
          '<div class="pr-cr-body" id="pr-cr-body"></div>' +
          '<div class="pr-cr-ftr"><span id="pr-cr-status"></span><span class="sp"></span>' +
            '<button class="pr-btn go" id="pr-cr-apply">Apply approved</button>' +
            '<button class="pr-btn" id="pr-cr-cancel">Cancel</button></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
    }
    var body = $('pr-cr-body');
    body.innerHTML = conflicts.map(function (c, i) {
      return '<div class="pr-cr-row" data-id="' + esc(c.id) + '">' +
        '<input type="checkbox" class="pr-cr-ck" checked>' +
        '<div class="pr-cr-thumb" data-img="' + esc(c.id) + '"></div>' +
        '<div class="pr-cr-txt">' +
          '<div class="pr-cr-meta">' + esc(c.name || c.id) + (c.route ? ' · ' + esc(c.route) : '') + '</div>' +
          '<div class="pr-cr-old"><span class="lbl">Current</span>' + esc(c.old) + '</div>' +
          '<div class="pr-cr-new"><span class="lbl">New</span>' + esc(c.neu) +
            '<button class="pr-cr-ex" title="Save this caption to the rubric examples — teaches future captioning">★ example</button></div>' +
        '</div></div>';
    }).join('');
    // Promote an approved caption into the rubric's few-shot EXAMPLES block.
    Array.prototype.forEach.call(body.querySelectorAll('.pr-cr-ex'), function (btn) {
      btn.onclick = function () {
        var row = btn.closest('.pr-cr-row'), id = row && row.getAttribute('data-id');
        var c = conflicts.filter(function (x) { return x.id === id; })[0];
        if (!c) return;
        var r = addRubricExample(c.neu);
        btn.disabled = true;
        if (r.ok) { btn.textContent = '★ added (' + r.count + ')'; btn.classList.add('on'); }
        else if (r.reason === 'dup') { btn.textContent = '✓ already an example'; btn.classList.add('on'); }
        else { btn.disabled = false; }
      };
    });
    // lazy thumbnails
    Array.prototype.forEach.call(body.querySelectorAll('.pr-cr-thumb'), function (t) {
      imageFor(t.getAttribute('data-img')).then(function (d) { if (d) t.style.backgroundImage = 'url(' + d + ')'; });
    });
    var sub = $('pr-cr-sub');
    sub.textContent = conflicts.length + ' conflict' + (conflicts.length === 1 ? '' : 's') +
      (info.autoApplied ? ' · ' + info.autoApplied + ' blank filled' : '') +
      (info.unchanged ? ' · ' + info.unchanged + ' unchanged' : '') +
      (info.unmatched ? ' · ' + info.unmatched + ' unmatched' : '');
    $('pr-cr-all').checked = true;
    $('pr-cr-all').onchange = function () {
      var on = $('pr-cr-all').checked;
      Array.prototype.forEach.call(body.querySelectorAll('.pr-cr-ck'), function (ck) { ck.checked = on; });
    };
    $('pr-cr-cancel').onclick = function () {
      ov.classList.remove('on');
      renderBuilder();
      status('Filled ' + info.autoApplied + ' blank(s); ' + conflicts.length + ' conflict(s) left unchanged.');
      onDone();
    };
    $('pr-cr-apply').onclick = function () {
      var byId = {}; (geo() ? geo().list() : []).forEach(function (p) { byId[p.id] = p; });
      var saves = [], applied = 0;
      Array.prototype.forEach.call(body.querySelectorAll('.pr-cr-row'), function (rowEl) {
        var ck = rowEl.querySelector('.pr-cr-ck'); if (!ck.checked) return;
        var c = conflicts.filter(function (x) { return x.id === rowEl.getAttribute('data-id'); })[0];
        var p = c && byId[c.id]; if (!p) return;
        p.description = c.neu; saves.push(p); applied++;
      });
      Promise.all(saves.map(function (p) { try { return geo().save(p); } catch (e) { return null; } })).then(function () {
        ov.classList.remove('on');
        renderBuilder();
        status('Applied ' + (info.autoApplied + applied) + ' description(s) (' + applied + ' overwritten' +
          (info.autoApplied ? ', ' + info.autoApplied + ' blank filled' : '') + ')' +
          (info.unmatched ? ' · ' + info.unmatched + ' unmatched' : '') + '.');
        onDone();
      });
    };
    ov.classList.add('on');
  }

  // ── Caption spell-check (offline, suggested fixes) ────────────────────────
  // Uses RW2Spell (modules/spellcheck.js): lazy dictionary + pavement allowlist
  // seeded from the rubric. Checks the captions of the photos currently selected
  // for the report and opens a fix panel. Manual ("Check" button) — never gates
  // the PDF.
  function caseLike(src, repl) {
    if (/^[A-Z][a-z’'-]*$/.test(src)) return repl.charAt(0).toUpperCase() + repl.slice(1);
    if (/^[A-Z]+$/.test(src)) return repl.toUpperCase();
    return repl;
  }
  function runSpellCheck() {
    if (!window.RW2Spell) { status('Spell-check unavailable (module not loaded).'); return; }
    var secs = selectedSections(grouped(true));
    var photos = []; secs.forEach(function (s) { photos = photos.concat(s.photos); });
    var items = photos.filter(function (p) { return (p.description || '').trim(); })
                      .map(function (p) { return { id: p.id, text: p.description }; });
    if (!items.length) { status('No captions to check — add descriptions first.'); return; }
    var btn = $('pr-spell-btn'); if (btn) { btn.disabled = true; btn.textContent = '🔤 Checking…'; }
    status('Loading dictionary…');
    window.RW2Spell.checkItems(items).then(function (results) {
      if (btn) { btn.disabled = false; btn.textContent = '🔤 Check'; }
      if (!results.length) { status('No spelling issues found in ' + items.length + ' caption(s). ✓'); return; }
      var nIssues = results.reduce(function (a, r) { return a + r.flags.length; }, 0);
      status(nIssues + ' possible issue(s) across ' + results.length + ' caption(s).');
      openSpellReview(results);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🔤 Check'; }
      status('Spell-check failed: ' + (e && e.message || e));
    });
  }
  function openSpellReview(results) {
    ensureStyles();
    var ov = $('pr-spellrev');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'pr-spellrev';
      ov.innerHTML =
        '<div class="pr-cr-card">' +
          '<div class="pr-cr-head"><span class="pr-cr-t">🔤 Spell check</span>' +
            '<span class="pr-cr-sub" id="pr-sp-sub"></span><span class="sp"></span></div>' +
          '<div class="pr-cr-body" id="pr-sp-body"></div>' +
          '<div class="pr-cr-ftr"><span id="pr-sp-status" style="font:500 11.5px system-ui;color:#8a949f"></span><span class="sp"></span>' +
            '<button class="pr-btn go" id="pr-sp-apply">Apply fixes</button>' +
            '<button class="pr-btn" id="pr-sp-close">Close</button></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
      $('pr-sp-close').addEventListener('click', function () { ov.classList.remove('on'); });
    }
    var body = $('pr-sp-body');
    body.innerHTML = results.map(function (r) {
      var chips = r.flags.map(function (f) {
        var sugg = (f.suggestions || []).slice(0, 3).map(function (s) {
          return '<button class="pr-sp-sugg" data-w="' + esc(f.word) + '" data-s="' + esc(s) + '">' + esc(caseLike(f.word, s)) + '</button>';
        }).join('');
        return '<span class="pr-sp-flag"><b>' + esc(f.word) + '</b>' + (sugg ? ' → ' + sugg : ' <i>no suggestion</i>') +
          '<button class="pr-sp-ok" data-w="' + esc(f.word) + '" title="Keep this word (add to allowed for this session)">keep</button></span>';
      }).join('');
      return '<div class="pr-cr-row" data-id="' + esc(r.id) + '">' +
        '<div class="pr-cr-thumb" data-img="' + esc(r.id) + '"></div>' +
        '<div class="pr-cr-txt">' +
          '<textarea class="pr-sp-ta" data-id="' + esc(r.id) + '">' + esc(r.text) + '</textarea>' +
          '<div class="pr-sp-flags">' + chips + '</div>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(body.querySelectorAll('.pr-cr-thumb'), function (t) {
      imageFor(t.getAttribute('data-img')).then(function (d) { if (d) t.style.backgroundImage = 'url(' + d + ')'; });
    });
    var grow = function (el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; };
    Array.prototype.forEach.call(body.querySelectorAll('.pr-sp-ta'), function (ta) { grow(ta); ta.addEventListener('input', function () { grow(ta); }); });
    body.onclick = function (e) {
      var btn = e.target.closest ? e.target.closest('.pr-sp-sugg, .pr-sp-ok') : null;
      if (!btn) return;
      var row = btn.closest('.pr-cr-row'), ta = row && row.querySelector('.pr-sp-ta'); if (!ta) return;
      if (btn.classList.contains('pr-sp-sugg')) {
        var w = btn.getAttribute('data-w'), s = btn.getAttribute('data-s');
        var re = new RegExp('(^|[^A-Za-z])(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z])');
        ta.value = ta.value.replace(re, function (m, pre) { return pre + caseLike(w, s); });
        grow(ta);
      } else if (window.RW2Spell) {
        window.RW2Spell.addAllowed(btn.getAttribute('data-w').toLowerCase());
      }
      var flag = btn.closest('.pr-sp-flag'); if (flag) flag.classList.add('done');
    };
    $('pr-sp-sub').textContent = results.length + ' caption(s) with possible issues';
    $('pr-sp-apply').onclick = function () {
      var saves = [], n = 0, byId = {}; (geo() ? geo().list() : []).forEach(function (p) { byId[p.id] = p; });
      Array.prototype.forEach.call(body.querySelectorAll('.pr-sp-ta'), function (ta) {
        var p = byId[ta.getAttribute('data-id')]; if (!p) return;
        var v = ta.value.trim();
        if (v && v !== (p.description || '')) { p.description = v; saves.push(p); n++; }
      });
      Promise.all(saves.map(function (p) { try { return geo().save(p); } catch (e) { return null; } })).then(function () {
        ov.classList.remove('on'); renderBuilder();
        status(n ? ('Applied ' + n + ' caption fix(es).') : 'No changes to apply.');
      });
    };
    ov.classList.add('on');
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

  // Within-section print order: explicit drag order (rip_rpt_order) first, then
  // chronological for anything not yet arranged.
  function cmpOrder(x, y) {
    var ox = (x.rip_rpt_order == null) ? Infinity : x.rip_rpt_order;
    var oy = (y.rip_rpt_order == null) ? Infinity : y.rip_rpt_order;
    if (ox !== oy) return ox - oy;
    return String(x.ts || '') < String(y.ts || '') ? -1 : 1;
  }
  // Each photo prints full-width (its own row) or half-width (paired). Default
  // half. Pack an ordered list into rows accordingly; a trailing lone half keeps
  // half width (left-aligned).
  // Default is FULL-WIDTH (stacked: full top / full bottom). Half is opt-in to
  // place two photos side by side in one row.
  function spanOf(p) { return (p.rip_rpt_span === 'full') ? 'full' : 'half'; }  // default half; only explicit 'full' is full-width
  function packRows(photos) {
    var rows = [], pending = null;
    photos.forEach(function (p) {
      if (spanOf(p) === 'full') {
        if (pending) { rows.push({ photos: [pending], lone: true }); pending = null; }
        rows.push({ photos: [p], full: true });
      } else if (pending) {
        rows.push({ photos: [pending, p] }); pending = null;
      } else { pending = p; }
    });
    if (pending) rows.push({ photos: [pending], lone: true });
    return rows;
  }
  function chunkArr(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
  // A full-width photo spans TWO row units (taller, shown uncropped); a half
  // pair / lone half spans one. Pack rows into pages of up to CAP row units.
  function rowWeight(row) { return row.full ? 2 : 1; }
  function paginateRows(rows, cap) {
    var pages = [], cur = [], w = 0;
    rows.forEach(function (row) {
      var rw = rowWeight(row);
      if (w + rw > cap && cur.length) { pages.push(cur); cur = []; w = 0; }
      cur.push(row); w += rw;
    });
    if (cur.length) pages.push(cur);
    return pages;
  }

  // ---- PDF (print window) ----------------------------------------------------
  function generate() {
    var secs = selectedSections(grouped(true));
    var total = 0; secs.forEach(function (s) { total += s.photos.length; });
    if (!total) {
      status(grouped(true).length ? 'Select at least one route to print (left panel).' : 'Heart at least one photo first.');
      return;
    }
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
        var wmOn = !$('pr-wm') || $('pr-wm').checked;
        var pageNums = !$('pr-pagenums') || $('pr-pagenums').checked;
        // Each page's header park is derived from that section's own route/lot
        // prefix, so a multi-park print labels every page correctly. The manual
        // Park field only overrides when a single park is being printed.
        var fieldVal = (($('pr-park') && $('pr-park').value) || '').trim();
        var parkCodes = {}; secs.forEach(function (s) { parkCodes[parkCodeOf(s.key)] = 1; });
        var singlePark = Object.keys(parkCodes).length === 1;
        // Prefer the official black AECOM logo; fall back to the app reverse logo, darkened.
        var aecomLogo = blackLogo || (document.querySelector('.aecom-logo') || {}).src || '';
        var aecomBlack = !!blackLogo;
        var pagesHtml = '';
        secs.forEach(function (s) {
          var usable = s.photos.filter(function (p) { return img[p.id]; });
          // pack into span-aware rows (full = 1 row, half = paired), 3 rows/page
          var pages = paginateRows(packRows(usable), 3);
          var routeId = (s.key === UNASSIGNED) ? 'Unassigned' : (s.key.indexOf('lot:') === 0 ? s.key.slice(4) : s.key);
          var code2 = parkCodeOf(s.key);
          var park = (singlePark && fieldVal) ? fieldVal : (parkFullName(code2) || fieldVal || _parkName || code2 || 'Field Photos');
          pages.forEach(function (pageRows, pi) {
            pagesHtml += pageHtml({ park: park, aecomLogo: aecomLogo, aecomBlack: aecomBlack, npsLogo: npsLogo,
              secTitle: s.title, routeId: routeId, pageIdx: pi + 1, pageCount: pages.length, rows: pageRows, img: img, wmOn: wmOn, pageNums: pageNums });
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
    function imgboxHtml(p) {
      var wmLines = o.wmOn ? watermarkLines(p) : [];
      var metaHtml = wmLines.map(function (l, li) {
        return '<div' + (li === 0 ? ' class="wm0"' : '') + '>' + esc(l) + '</div>';
      }).join('');
      // info bar carries ONLY the metadata; the typed description sits centered
      // below the image so it never overlaps the route/STA/GPS lines.
      var wmHtml = metaHtml ? '<div class="wm">' + metaHtml + '</div>' : '';
      return '<div class="imgbox"><img src="' + o.img[p.id] + '">' + wmHtml + '</div>';
    }
    // Each row owns an image band (both photos share one height, so a caption on
    // one photo shrinks BOTH equally) and, only when any photo in the row has a
    // description, a caption band below with one centered cell per photo. Rows
    // are pre-packed by span: full (1 photo spanning), half-pair (2), or a lone
    // half (1 photo kept at half width).
    var cells = (o.rows || []).map(function (row) {
      var imgs = row.photos.map(imgboxHtml).join('');
      var anyCap = row.photos.some(function (p) { return (p.description || '').trim(); });
      var caps = anyCap ? '<div class="prow-caps">' + row.photos.map(function (p) {
        var cap = (p.description || '').trim();
        return '<div class="cap">' + (cap ? esc(cap) : '') + '</div>';
      }).join('') + '</div>' : '';
      var cls = 'prow' + (row.full ? ' full' : '') + (row.lone ? ' lone' : '');
      return '<div class="' + cls + '"><div class="prow-imgs">' + imgs + '</div>' + caps + '</div>';
    }).join('');
    var npsHtml = o.npsLogo ? '<img class="nps-logo" src="' + o.npsLogo + '" alt="NPS">' : '';
    var aecomHtml = o.aecomLogo ? '<img class="ftr-logo' + (o.aecomBlack ? ' blk' : '') + '" src="' + o.aecomLogo + '" alt="AECOM">' : '<span class="ftr-aecom">AECOM</span>';
    var parkHtml = esc(o.park).replace(/ National\b/, '<br>National');
    // section title: route/lot ID on row 1, the route name on row 2 (wraps)
    var sci = o.secTitle.indexOf(' — ');
    var scHtml = (sci >= 0)
      ? '<span class="sc-id">' + esc(o.secTitle.slice(0, sci)) + '</span><span class="sc-nm">' + esc(o.secTitle.slice(sci + 3)) + '</span>'
      : '<span class="sc-nm">' + esc(o.secTitle) + '</span>';
    var pgHtml = (o.pageNums === false) ? '' : '<span class="pg">Page ' + o.pageIdx + ' of ' + o.pageCount + '</span>';
    return '<section class="page">' +
      '<div class="phdr">' + npsHtml +
      '<span class="pk">' + parkHtml + '</span>' +
      '<span class="sc">' + scHtml + '</span></div>' +
      '<div class="grid">' + cells + '</div>' +
      '<div class="pftr">' + aecomHtml +
      '<div class="pftr-r"><span class="rid">' + esc(o.routeId) + '</span>' + pgHtml + '</div>' +
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
      '.page{height:9.9in;padding-bottom:0.16in;display:flex;flex-direction:column;overflow:hidden;page-break-after:always;break-after:page;break-inside:avoid;page-break-inside:avoid}' +
      '.page:last-child{page-break-after:auto;break-after:auto}' +
      // header: NPS logo + full park name (navy) at top-left, section at right
      '.phdr{display:flex;align-items:center;gap:10px;border-bottom:2px solid #16315E;padding-bottom:6px;margin-bottom:9px;flex:0 0 auto}' +
      '.phdr .nps-logo{height:48px;width:auto;object-fit:contain;flex:0 0 auto}' +
      '.phdr .pk{font-weight:800;font-size:17px;color:#16315E;letter-spacing:.2px;line-height:1.12;white-space:normal}' +
      '.phdr .sc{flex:1 1 auto;text-align:right;align-self:flex-end;display:flex;flex-direction:column;align-items:flex-end;line-height:1.15}' +
      '.phdr .sc .sc-id{font-weight:700;font-size:14px;color:#5b6673;letter-spacing:.4px}' +
      '.phdr .sc .sc-nm{font-weight:700;font-size:14px;color:#5b6673;white-space:normal}' +
      // stack of equal-height rows; each row = an image band + optional caption band
      '.grid{flex:1 1 auto;display:flex;flex-direction:column;gap:0.16in;min-height:0}' +
      '.prow{flex:1 1 0;display:flex;flex-direction:column;min-height:0}' +
      '.prow.full{flex:2 1 0}' +   // full-width photo = two row units tall
      '.prow-imgs{flex:1 1 auto;display:flex;gap:0.16in;min-height:0}' +
      '.prow-imgs .imgbox{flex:1 1 0}' +
      // a lone half-width photo stays half width (left), not stretched full
      '.prow.lone .prow-imgs{justify-content:flex-start}' +
      '.prow.lone .prow-imgs .imgbox{flex:0 0 calc(50% - 0.08in)}' +
      '.prow.lone .prow-caps .cap{flex:0 0 calc(50% - 0.08in)}' +
      '.prow-caps{flex:0 0 auto;display:flex;gap:0.16in;padding-top:3px}' +
      '.prow-caps .cap{flex:1 1 0;min-width:0}' +
      // engineering look: white, thin border, photo fills the frame so the
      // watermark sits across the bottom of the actual image
      '.imgbox{position:relative;min-height:0;min-width:0;overflow:hidden;border:0.75pt solid #9aa3ad;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      // cover = fill the frame (minor crop ok); full-width photos get a 2-row-tall
      // frame so the crop needed to fill is small and the photo reads large.
      '.imgbox img{width:100%;height:100%;object-fit:cover;display:block}' +
      // solid info bar across the bottom of the image
      '.wm{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,0.68);color:#fff;font:600 8px "IBM Plex Mono",monospace;letter-spacing:.2px;padding:4px 8px 5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.wm div{line-height:1.45;white-space:pre}' +
      '.wm .wm0{font-weight:800;font-size:9.5px;letter-spacing:.4px}' +
      // typed description — centered under its image (never over the data)
      '.cap{text-align:center;font:600 9px "IBM Plex Sans",system-ui;color:#1A1D22;line-height:1.3;padding:0 6px;white-space:normal;overflow-wrap:anywhere}' +
      // footer: AECOM logo (bottom-left) + Route ID over Page N of X (bottom-right)
      '.pftr{flex:0 0 auto;display:flex;justify-content:space-between;align-items:flex-end;border-top:1pt solid #c7ccd2;margin-top:0.14in;padding-top:6px}' +
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
  function status(msg) {
    var el = $('pr-status'); if (el) { el.textContent = msg || ''; return; }
    // Builder overlay closed (e.g. import triggered from the RIP Photos or
    // File tab): fall back to a transient toast so feedback is never lost.
    if (!msg) return;
    try {
      ensureStyles();
      var t = $('pr-toast');
      if (!t) { t = document.createElement('div'); t.id = 'pr-toast'; document.body.appendChild(t); }
      t.textContent = msg; t.className = 'on';
      clearTimeout(status._t); status._t = setTimeout(function () { t.className = ''; }, 4200);
    } catch (e) {}
  }

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

  // ---- builder hover-to-upsize preview --------------------------------------
  // Hovering a card thumbnail pops up a large floating preview so the image and
  // its place in the order are easy to read while arranging. Shows above the
  // overlay; a token guards async (offloaded) image loads.
  var _prHvEl = null, _prHvImg = null, _prHvTok = 0, _prHvMouse = { x: 0, y: 0 };
  function _prHvEnsure() {
    if (_prHvEl) return _prHvEl;
    _prHvEl = document.createElement('div'); _prHvEl.id = 'pr-hover';
    _prHvEl.style.cssText = 'position:fixed;z-index:4100;pointer-events:none;display:none;background:#fff;border:1px solid #c7ccd2;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.42);padding:4px';
    _prHvImg = document.createElement('img');
    _prHvImg.style.cssText = 'display:block;max-width:46vw;max-height:70vh;object-fit:contain;border-radius:6px';
    _prHvImg.onload = function () { _prHvMove(_prHvMouse); };
    _prHvEl.appendChild(_prHvImg); document.body.appendChild(_prHvEl);
    return _prHvEl;
  }
  function _prHvShow(id, e) {
    if (e) { _prHvMouse = { x: e.clientX, y: e.clientY }; }
    _prHvEnsure();
    var tok = ++_prHvTok;
    imageFor(id).then(function (url) {
      if (url && tok === _prHvTok) { _prHvImg.src = url; _prHvEl.style.display = 'block'; _prHvMove(_prHvMouse); }
    }).catch(function () {});
  }
  function _prHvMove(e) {
    if (e) { _prHvMouse = { x: (e.clientX != null ? e.clientX : e.x), y: (e.clientY != null ? e.clientY : e.y) }; }
    if (!_prHvEl || _prHvEl.style.display === 'none') return;
    var pad = 18, vw = window.innerWidth, vh = window.innerHeight, w = _prHvEl.offsetWidth || 360, h = _prHvEl.offsetHeight || 270;
    var x = _prHvMouse.x + pad, y = _prHvMouse.y + pad;
    if (x + w > vw - 8) x = _prHvMouse.x - pad - w; if (x < 8) x = 8;
    if (y + h > vh - 8) y = vh - 8 - h; if (y < 8) y = 8;
    _prHvEl.style.left = x + 'px'; _prHvEl.style.top = y + 'px';
  }
  function _prHvHide() { _prHvTok++; if (_prHvEl) _prHvEl.style.display = 'none'; }

  function renderBuilder() {
    _prHvHide();
    var host = $('pr-body'); if (!host) return;
    var heartedOnly = $('pr-hearted') && $('pr-hearted').checked;
    var secs = grouped(heartedOnly);
    // In "hearted only" mode the list previews exactly what will print, so honour
    // the park/route selection. With it off (hearting mode) show every section.
    if (heartedOnly) secs = selectedSections(secs);
    updateSelCount();
    if (!secs.length) { host.innerHTML = '<div class="pr-empty">No photos' + (heartedOnly ? ' hearted/selected yet' : ' yet') + '.</div>'; return; }

    host.innerHTML = secs.map(function (s) {
      var cards = s.photos.map(function (p, i) {
        var isFull = spanOf(p) === 'full';
        return '<div class="pr-card" data-id="' + esc(p.id) + '">' +
          '<span class="pr-num" draggable="true" title="Print order #' + (i + 1) + ' — drag to reorder">' + (i + 1) + '</span>' +
          '<button class="pr-heart' + (p.hearted ? ' on' : '') + '" title="Include in report">' + (p.hearted ? '♥' : '♡') + '</button>' +
          '<div class="pr-thumb" data-img="' + esc(p.id) + '"></div>' +
          '<button class="pr-span' + (isFull ? ' full' : '') + '" title="Full-width or half-width in the report">' + (isFull ? '◼ Full' : '▭ Half') + '</button>' +
          '<button class="pr-assign" title="Assign this photo to a route / lot (override auto-tag)">🎯</button>' +
          (p.rip_manual ? '<span class="pr-manual" title="Manually assigned route/lot">📌</span>' : '') +
          '<textarea class="pr-cap" rows="2" placeholder="Caption / description…">' + esc(p.description || '') + '</textarea>' +
          '</div>';
      }).join('');
      return '<div class="pr-sec"><div class="pr-sec-h">' + esc(s.title) +
        ' <span class="pr-sec-n">' + s.photos.length + '</span>' +
        '<span class="pr-sec-hint">drag # to reorder · Full/Half sets print size</span></div>' +
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
        // Hearting may add a new route/park to the tree; keep it in sync.
        renderTree(); updateSelCount();
        if (heartedOnly && !on) renderBuilder();
      });
      var span = card.querySelector('.pr-span');
      span.addEventListener('click', function () {
        var next = (spanOf(p) === 'full') ? 'half' : 'full';
        p.rip_rpt_span = next; try { geo().save(p); } catch (e) {}
        span.classList.toggle('full', next === 'full');
        span.textContent = next === 'full' ? '◼ Full' : '▭ Half';
      });
      var asg = card.querySelector('.pr-assign');
      if (asg) asg.addEventListener('click', function () {
        if (window.RW2PhotoTag && window.RW2PhotoTag.assignUI) window.RW2PhotoTag.assignUI(id, function () { renderBuilder(); });
        else status('Assign unavailable (auto-tag module not loaded).');
      });
      var cap = card.querySelector('.pr-cap');
      var grow = function () { cap.style.height = 'auto'; cap.style.height = (cap.scrollHeight + 2) + 'px'; };
      cap.addEventListener('input', function () { saveCaption(p, cap.value); grow(); });
      grow();   // size to the full description on render
      var thumb = card.querySelector('.pr-thumb');
      imageFor(id).then(function (d) { if (d) thumb.style.backgroundImage = 'url(' + d + ')'; else thumb.classList.add('pr-off'); });
      // hover the thumbnail → large floating preview (easier to read while ordering)
      thumb.addEventListener('mouseenter', function (e) { _prHvShow(id, e); });
      thumb.addEventListener('mousemove', function (e) { _prHvMove(e); });
      thumb.addEventListener('mouseleave', function () { _prHvHide(); });
      // drag-to-reorder (handle = the number badge; reorder stays within section)
      var handle = card.querySelector('.pr-num');
      handle.addEventListener('dragstart', function (e) {
        _prHvHide();
        _dragGrid = card.parentNode; card.classList.add('pr-dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (_) {} try { e.dataTransfer.setDragImage(card, 20, 20); } catch (_) {} }
      });
      handle.addEventListener('dragend', function () {
        card.classList.remove('pr-dragging');
        var grid = _dragGrid; _dragGrid = null;
        if (grid) { persistCardOrder(grid); renderBuilder(); }
      });
      card.addEventListener('dragover', function (e) {
        if (!_dragGrid || card.parentNode !== _dragGrid) return;
        e.preventDefault();
        var dragging = _dragGrid.querySelector('.pr-dragging');
        if (!dragging || dragging === card) return;
        var r = card.getBoundingClientRect();
        var after = e.clientX > r.left + r.width / 2;
        _dragGrid.insertBefore(dragging, after ? card.nextSibling : card);
      });
    });
  }

  // Read the current DOM order of a section's cards and stamp rip_rpt_order so
  // the arrangement persists and drives both the builder and the PDF.
  var _dragGrid = null;
  function persistCardOrder(grid) {
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.pr-card'));
    cards.forEach(function (c, i) {
      var p = geo() && geo().get(c.getAttribute('data-id'));
      if (p && p.rip_rpt_order !== i) { p.rip_rpt_order = i; try { geo().save(p); } catch (e) {} }
    });
  }

  function ensureStyles() {
    if ($('pr-style')) return;
    var st = document.createElement('style'); st.id = 'pr-style';
    st.textContent =
      '#pr-overlay{position:fixed;inset:0;z-index:4000;background:rgba(20,22,28,.55);display:none}' +
      '#pr-overlay.on{display:flex}' +
      '#pr-card{margin:auto;width:min(1760px,98vw);height:min(95vh,1250px);background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}' +
      '#pr-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff}' +
      '#pr-top .t{font-weight:700;color:var(--blue,#0B3D66);font-size:15px}' +
      '#pr-top .sp{flex:1 1 auto}' +
      '#pr-park{font:600 13px system-ui;padding:5px 8px;border:1px solid var(--rule,#DDD7C8);border-radius:6px;min-width:200px}' +
      '#pr-main{flex:1 1 auto;display:flex;min-height:0}' +
      '#pr-tree{flex:0 0 250px;overflow:auto;padding:11px 12px;background:#fff}' +
      '#pr-split{flex:0 0 7px;cursor:col-resize;background:var(--rule,#DDD7C8);position:relative}' +
      '#pr-split::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2px;height:28px;border-radius:1px;background:#9aa3ad}' +
      '#pr-split:hover{background:var(--blue,#0B3D66)}' +
      '#pr-split:hover::after{background:#fff}' +
      '#pr-tree .prt-h{font:700 10.5px "IBM Plex Mono",monospace;color:#8a949f;letter-spacing:.07em;text-transform:uppercase;margin-bottom:9px}' +
      '#pr-tree .prt-empty{color:var(--mute,#9BA0A8);font:500 12px system-ui}' +
      '#pr-tree .prt-park{margin-bottom:7px}' +
      '#pr-tree .prt-park>label{display:flex;align-items:center;gap:6px;font:700 12.5px system-ui;color:#12233b;cursor:pointer;padding:2px 0}' +
      '#pr-tree .prt-routes{margin:1px 0 4px 21px;display:flex;flex-direction:column;gap:3px}' +
      '#pr-tree .prt-routes label{display:flex;align-items:flex-start;gap:6px;font:500 12px system-ui;color:#33414f;cursor:pointer;line-height:1.25}' +
      '#pr-tree input[type=checkbox]{margin:1px 0 0;flex:0 0 auto}' +
      '#pr-tree .prt-cnt{color:#9BA0A8;font-weight:500}' +
      '#pr-body{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 16px}' +
      '.pr-empty{color:var(--mute,#9BA0A8);padding:30px;text-align:center}' +
      '.pr-sec{margin-bottom:16px}' +
      '.pr-sec-h{font:700 12.5px "IBM Plex Mono",monospace;color:var(--ink,#1A1D22);padding:6px 0;border-bottom:1px solid var(--rule,#DDD7C8);margin-bottom:8px}' +
      '.pr-sec-n{color:var(--mute,#9BA0A8);font-weight:500}' +
      '.pr-sec-hint{float:right;font:500 10.5px system-ui;color:#9BA0A8;letter-spacing:0}' +
      '.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}' +
      '.pr-card{position:relative;background:#fff;border:1px solid var(--rule,#DDD7C8);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:6px}' +
      '.pr-card.pr-dragging{opacity:.4;outline:2px dashed var(--orange,#C85A2B)}' +
      '.pr-num{position:absolute;top:8px;left:8px;z-index:3;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#16315E;color:#fff;font:800 11px system-ui;line-height:20px;text-align:center;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.3);user-select:none}' +
      '.pr-num:active{cursor:grabbing}' +
      '.pr-thumb{height:300px;border-radius:5px;background:#ECE8DC center/cover no-repeat}' +
      '.pr-thumb.pr-off{background:#ECE8DC}' +
      '.pr-heart{position:absolute;top:9px;right:9px;z-index:2;width:28px;height:28px;border-radius:50%;border:none;background:rgba(255,255,255,.9);color:#C85A2B;font-size:16px;cursor:pointer;line-height:1;box-shadow:0 1px 4px rgba(0,0,0,.2)}' +
      '.pr-heart.on{background:#C85A2B;color:#fff}' +
      '.pr-span{align-self:flex-start;font:700 10.5px system-ui;padding:3px 8px;border-radius:6px;border:1px solid var(--rule,#DDD7C8);background:#fff;color:#5b6673;cursor:pointer}' +
      '.pr-span.full{background:#16315E;color:#fff;border-color:#16315E}' +
      '.pr-assign{align-self:flex-start;font:700 11px system-ui;padding:3px 7px;border-radius:6px;border:1px solid var(--rule,#DDD7C8);background:#fff;color:#0B3D66;cursor:pointer}' +
      '.pr-assign:hover{background:#eef2f6}' +
      '.pr-manual{position:absolute;top:8px;left:34px;z-index:3;font-size:13px;line-height:1;filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}' +
      '.pr-cap{font:500 12.5px system-ui;line-height:1.4;border:1px solid var(--rule,#DDD7C8);border-radius:5px;padding:7px 9px;resize:vertical;width:100%;min-height:42px;overflow:hidden;box-sizing:border-box}' +
      '.pr-btn{font:600 12.5px system-ui;padding:6px 12px;border-radius:7px;border:1px solid var(--rule,#DDD7C8);background:#fff;cursor:pointer}' +
      '.pr-btn.go{background:var(--orange,#C85A2B);color:#fff;border-color:var(--orange,#C85A2B)}' +
      // CSV import review (conflicts only)
      '#pr-csvreview{position:fixed;inset:0;z-index:4200;background:rgba(20,22,28,.55);display:none}' +
      '#pr-csvreview.on{display:flex}' +
      '.pr-cr-card{margin:auto;width:min(760px,94vw);max-height:88vh;background:var(--paper,#FBFAF6);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45)}' +
      '.pr-cr-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--rule,#DDD7C8);background:#fff}' +
      '.pr-cr-head .pr-cr-t{font-weight:800;color:#16315E;font-size:15px}' +
      '.pr-cr-sub{font:600 11.5px "IBM Plex Mono",monospace;color:#8a949f}' +
      '.pr-cr-head .sp{flex:1 1 auto}' +
      '.pr-cr-alllbl{font:600 12px system-ui;color:#555;display:flex;align-items:center;gap:5px;cursor:pointer}' +
      '.pr-cr-body{flex:1 1 auto;overflow:auto;padding:10px 14px}' +
      '.pr-cr-row{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #eef1f4}' +
      '.pr-cr-row>.pr-cr-ck{margin-top:3px;flex:0 0 auto;width:16px;height:16px;cursor:pointer}' +
      '.pr-cr-thumb{flex:0 0 auto;width:90px;height:68px;border-radius:6px;background:#ECE8DC center/cover no-repeat;border:1px solid #e3e8ee}' +
      '.pr-cr-txt{flex:1 1 auto;min-width:0}' +
      '.pr-cr-meta{font:700 11px "IBM Plex Mono",monospace;color:#12233b;margin-bottom:3px}' +
      '.pr-cr-old,.pr-cr-new{font:500 12px system-ui;line-height:1.3;padding:3px 7px;border-radius:5px;margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere}' +
      '.pr-cr-old{background:#f3ecea;color:#9a5b4a;text-decoration:line-through}' +
      '.pr-cr-new{background:#e7f1ea;color:#1b6b4a}' +
      '.pr-cr-ex{margin-left:8px;border:1px solid #cdb36b;background:#fdf6e3;color:#8a6d1d;border-radius:5px;font:700 10px system-ui;padding:2px 7px;cursor:pointer;vertical-align:middle;white-space:nowrap}' +
      '.pr-cr-ex:hover{background:#f7edc9}' +
      '.pr-cr-ex.on{background:#dfeee6;border-color:#9cc3ad;color:#1b6b4a;cursor:default}' +
      '.pr-cr-ex:disabled{opacity:.92}' +
      '.pr-cr-old .lbl,.pr-cr-new .lbl{display:inline-block;font:800 9px system-ui;letter-spacing:.06em;text-transform:uppercase;margin-right:6px;opacity:.75;text-decoration:none}' +
      '.pr-cr-ftr{display:flex;align-items:center;gap:10px;padding:11px 16px;border-top:1px solid var(--rule,#DDD7C8);background:#fff}' +
      '.pr-cr-ftr .sp{flex:1 1 auto}' +
      '.pr-cr-ftr #pr-cr-status{font:500 11.5px system-ui;color:#8a949f}' +
      // Spell-check fix panel (reuses .pr-cr-* card/head/body/ftr/thumb/row/txt).
      '#pr-spellrev{position:fixed;inset:0;z-index:4250;background:rgba(20,22,28,.55);display:none}' +
      '#pr-spellrev.on{display:flex}' +
      '.pr-sp-ta{width:100%;box-sizing:border-box;border:1px solid #e3e8ee;border-radius:6px;font:500 13px/1.4 system-ui;color:#1A1D22;padding:7px 9px;resize:none;overflow:hidden;min-height:38px}' +
      '.pr-sp-flags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
      '.pr-sp-flag{font:600 11.5px system-ui;color:#9a5b4a;background:#f7eeeb;border:1px solid #e7d3cc;border-radius:6px;padding:3px 7px;display:inline-flex;align-items:center;gap:5px}' +
      '.pr-sp-flag.done{color:#1b6b4a;background:#e7f1ea;border-color:#bcdccb;opacity:.75}' +
      '.pr-sp-flag.done b{text-decoration:line-through}' +
      '.pr-sp-flag b{font-weight:800}' +
      '.pr-sp-sugg{border:1px solid #9cc3ad;background:#eef6f1;color:#1b6b4a;border-radius:5px;font:700 11px system-ui;padding:2px 7px;cursor:pointer}' +
      '.pr-sp-sugg:hover{background:#dcefe4}' +
      '.pr-sp-ok{border:1px solid #d3dae1;background:#fff;color:#55606b;border-radius:5px;font:700 10px system-ui;padding:2px 6px;cursor:pointer;margin-left:2px}' +
      // Toast: feedback when the builder is closed (import from RIP/File tab).
      '#pr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);z-index:4400;max-width:min(560px,92vw);background:#16315E;color:#fff;font:600 12.5px/1.45 system-ui;padding:10px 16px;border-radius:9px;box-shadow:0 10px 34px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}' +
      '#pr-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}';
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
            '<label style="font:600 12px system-ui;color:#555;display:flex;align-items:center;gap:4px" title="Show \'Page N of X\' in the footer (AECOM logo + Route ID always print)"><input type="checkbox" id="pr-pagenums" checked> page numbers</label>' +
            '<span style="width:1px;height:18px;background:var(--rule,#DDD7C8)"></span>' +
            '<input id="pr-photobase" placeholder="Photos base folder (for CSV file paths)" title="Absolute folder the photos were imported from — used to build file_path in the descriptions CSV" style="font:600 11.5px system-ui;padding:5px 8px;border:1px solid var(--rule,#DDD7C8);border-radius:6px;min-width:190px">' +
            '<button class="pr-btn" id="pr-csv-out" title="Export a CSV of the selected photos (with file paths) so descriptions can be authored externally">⬇ Descr. CSV</button>' +
            '<label class="pr-btn" id="pr-csv-in-lbl" title="Import a CSV to apply descriptions to the matching photos" style="cursor:pointer;display:inline-flex;align-items:center">⬆ Import CSV<input type="file" id="pr-csv-in" accept=".csv,text/csv" style="display:none"></label>' +
            '<button class="pr-btn" id="pr-rubric-btn" title="Edit the description rubric (shipped with every exported CSV)">✎ Rubric</button>' +
            '<button class="pr-btn" id="pr-spell-btn" title="Spell-check the captions of the photos shown (offline; suggests fixes)">🔤 Check</button>' +
            '<span id="pr-count" style="font:600 12px \'IBM Plex Mono\',monospace;color:var(--mute,#9BA0A8)">0 hearted</span>' +
            '<span class="sp"></span>' +
            '<span id="pr-status" style="font:500 11.5px system-ui;color:var(--mute,#9BA0A8)"></span>' +
            '<button class="pr-btn go" id="pr-go">Generate PDF</button>' +
            '<button class="pr-btn" id="pr-close">Close</button>' +
          '</div>' +
          '<div id="pr-main"><div id="pr-tree"></div><div id="pr-split" title="Drag to resize"></div><div id="pr-body"></div></div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
      $('pr-close').addEventListener('click', closeOverlay);
      $('pr-go').addEventListener('click', generate);
      $('pr-hearted').addEventListener('change', renderBuilder);
      $('pr-wm').addEventListener('change', function () { try { localStorage.setItem('rw_export_watermark', $('pr-wm').checked ? '1' : '0'); } catch (e) {} });
      $('pr-pagenums').addEventListener('change', function () { try { localStorage.setItem('rw_report_pagenums', $('pr-pagenums').checked ? '1' : '0'); } catch (e) {} });
      $('pr-csv-out').addEventListener('click', exportDescriptionsCsv);
      $('pr-csv-in').addEventListener('change', function () {
        var f = this.files && this.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { importDescriptionsCsv(String(rd.result || '')); };
        rd.onerror = function () { status('Could not read the CSV file.'); };
        rd.readAsText(f); this.value = '';
      });
      var pb = $('pr-photobase');
      if (pb) pb.addEventListener('input', function () { try { localStorage.setItem('rw_report_photo_base', pb.value); } catch (e) {} });
      var rbtn = $('pr-rubric-btn'); if (rbtn) rbtn.addEventListener('click', openRubricEditor);
      var sbtn = $('pr-spell-btn'); if (sbtn) sbtn.addEventListener('click', runSpellCheck);
      // Draggable divider between the routes tree and the photo grid.
      (function () {
        var split = $('pr-split'), tree = $('pr-tree'), dragging = false, startX = 0, startW = 0;
        if (!split || !tree) return;
        split.addEventListener('mousedown', function (e) {
          dragging = true; startX = e.clientX; startW = tree.getBoundingClientRect().width;
          document.body.style.userSelect = 'none'; e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          var w = Math.max(150, Math.min(startW + (e.clientX - startX), 640));
          tree.style.flex = '0 0 ' + w + 'px';
        });
        document.addEventListener('mouseup', function () {
          if (!dragging) return; dragging = false; document.body.style.userSelect = '';
          try { localStorage.setItem('rw_report_tree_w', Math.round(tree.getBoundingClientRect().width)); } catch (e) {}
        });
      })();
    }
    ov.classList.add('on');
    // Reflect the global export-watermark setting (save/copy/print share it).
    var pw = $('pr-wm'); if (pw) { try { pw.checked = localStorage.getItem('rw_export_watermark') !== '0'; } catch (e) {} }
    var pn = $('pr-pagenums'); if (pn) { try { pn.checked = localStorage.getItem('rw_report_pagenums') !== '0'; } catch (e) {} }
    var pbx = $('pr-photobase'); if (pbx && !pbx.value) { try { pbx.value = localStorage.getItem('rw_report_photo_base') || ''; } catch (e) {} }
    var trw = $('pr-tree'); if (trw) { try { var w = parseInt(localStorage.getItem('rw_report_tree_w'), 10); if (w) trw.style.flex = '0 0 ' + w + 'px'; } catch (e) {} }
    // Warm the route geometry so STA/MP are ready when Generate is clicked.
    if (window.RW2PhotoTag && window.RW2PhotoTag.ensureGeo) { try { window.RW2PhotoTag.ensureGeo(); } catch (e) {} }
    // Auto-fill the Park field with the full park name for the loaded park.
    var code = (rip() && rip().state && rip().state.bundle && rip().state.bundle.park) || '';
    // If the loaded park changed since last open, re-default the route selection
    // to that park (so opening the report for WRBR pre-selects WRBR, not ABLI).
    if (_selParkCtx !== code) { _sel = null; _selParkCtx = code; }
    if (code) loadParkNames().then(function () {
      var pf = $('pr-park'); if (pf && (!pf.value || pf.value === code)) { pf.value = parkFullName(code); _parkName = pf.value; }
      renderTree(); updateSelCount();
    });
    renderTree();
    renderBuilder();
  }
  function closeOverlay() { _prHvHide(); var ov = $('pr-overlay'); if (ov) ov.classList.remove('on'); }

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

  window.RW2PhotoReport = {
    open: openOverlay, generate: generate, grouped: grouped, layoutFor: layoutFor,
    watermarkLines: watermarkLines, fmtSta: fmtSta,
    // Reusable description-CSV I/O for other tabs (e.g. RIP Photos):
    exportCsv: function (photos, base) { downloadCsvForPhotos(photos || [], (base != null ? base : reportBaseFolder())); },
    importCsv: function (text, onDone) { importDescriptionsCsv(text, onDone); },
    editRubric: openRubricEditor,
    addExample: addRubricExample, examples: rubricExamples,
  };
})();
