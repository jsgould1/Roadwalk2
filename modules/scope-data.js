/* =========================================================================
 * scope-data.js — XLSX scope/attribute association + the Route Data sheet.
 *
 * Imports the "Field Survey Data Templates" workbook (parsed in-browser via
 * JSZip — no SheetJS), keyed by Park + Route ID, and stores it per unit. The
 * Route Data sheet (opened from the map popup) shows a route's attributes in
 * clean, labelled GROUPS (identity, measurements, markings, signs, drainage,
 * …). Values come from the workbook by default; edits are saved onto the
 * section (sec.scope_data) so they override and travel with the park.
 * ========================================================================= */
(function () {
  'use strict';

  const DB = 'roadwalk2_scopedata', STORE = 'units';
  let _cache = {};   // { UNIT: { canonRouteId: {field:value} } }

  const sections = () => (window._RW && window._RW.SECTIONS) || [];
  function activeUnit() {
    const a = window.RW2Library && window.RW2Library.getActive && window.RW2Library.getActive();
    if (a) return String(a).toUpperCase();
    for (const s of sections()) { const m = /^([A-Za-z]+)/.exec(s.id || ''); if (m) return m[1].toUpperCase(); }
    return null;
  }
  // "400"/400 → "0400", "0400AZ" → "0400AZ", "0010AZ" → "0010AZ"
  function canon(rid) {
    const s = String(rid == null ? '' : rid).trim().toUpperCase();
    const m = /^0*(\d+)\s*([A-Z]*)$/.exec(s);
    return m ? m[1].padStart(4, '0') + m[2] : s;
  }

  // ---- IndexedDB --------------------------------------------------------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'unit' }); };
      r.onsuccess = (e) => res(e.target.result); r.onerror = (e) => rej(e.target.error);
    });
  }
  async function putUnit(rec) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = (e) => rej(e.target.error); }); }
  async function loadCache() {
    try {
      const db = await idb();
      const all = await new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(); r.onsuccess = (e) => res(e.target.result || []); r.onerror = (e) => rej(e.target.error); });
      _cache = {}; all.forEach((u) => { _cache[u.unit] = u.routes; });
    } catch (_) {}
  }

  // ---- minimal XLSX reader (JSZip + DOMParser) --------------------------
  const colIdx = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  async function parseXlsx(file) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const px = async (p) => { const f = zip.file(p); return f ? f.async('string') : ''; };
    const DP = new DOMParser();
    // shared strings
    const shared = [];
    const ss = DP.parseFromString(await px('xl/sharedStrings.xml') || '<x/>', 'application/xml');
    for (const si of ss.getElementsByTagName('si')) { let t = ''; for (const tn of si.getElementsByTagName('t')) t += tn.textContent; shared.push(t); }
    // workbook sheets → file map
    const wb = DP.parseFromString(await px('xl/workbook.xml'), 'application/xml');
    const rels = DP.parseFromString(await px('xl/_rels/workbook.xml.rels') || '<x/>', 'application/xml');
    const relMap = {}; for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
    const sheets = [];
    for (const s of wb.getElementsByTagName('sheet')) {
      const name = s.getAttribute('name');
      let rid = s.getAttribute('r:id'); if (!rid) { for (const a of s.attributes) if (/:id$/.test(a.name)) rid = a.value; }
      let tgt = relMap[rid] || '';
      if (tgt && !/^xl\//.test(tgt)) tgt = 'xl/' + tgt.replace(/^\/+/, '');
      if (tgt) sheets.push({ name, tgt });
    }
    const out = [];
    for (const sh of sheets) {
      const sx = await px(sh.tgt); if (!sx) continue;
      const sd = DP.parseFromString(sx, 'application/xml');
      const rows = [];
      for (const row of sd.getElementsByTagName('row')) {
        const cells = [];
        for (const c of row.getElementsByTagName('c')) {
          const ref = c.getAttribute('r') || ''; const ci = colIdx(ref.replace(/[0-9]/g, '') || 'A');
          const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0];
          let val = null;
          if (t === 's') val = shared[parseInt((v && v.textContent) || '0', 10)];
          else if (t === 'inlineStr') { const is = c.getElementsByTagName('t')[0]; val = is ? is.textContent : ''; }
          else if (v != null) { const n = +v.textContent; val = isNaN(n) ? v.textContent : n; }
          if (val != null && val !== '') cells[ci] = val;
        }
        rows.push(cells);
      }
      out.push({ name: sh.name, rows });
    }
    return out;
  }

  // rows (arrays keyed by col index) → { UNIT: { canonRoute: {header:value} } }
  function rowsToRecords(sheetsArr) {
    const byUnit = {};
    for (const sheet of sheetsArr) {
      const rows = sheet.rows;
      let h = -1;
      for (let i = 0; i < rows.length; i++) { if (rows[i].filter((x) => x != null && x !== '').length > 3) { h = i; break; } }
      if (h < 0) continue;
      const hdr = rows[h].map((x) => (x == null ? '' : String(x).trim()));
      const parkCol = hdr.findIndex((x) => /^park$/i.test(x));
      const ridCol = hdr.findIndex((x) => /^route\s*id$/i.test(x));
      if (parkCol < 0 || ridCol < 0) continue;
      for (let i = h + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r || r.filter((x) => x != null && x !== '').length <= 3) continue;
        const unit = String(r[parkCol] || '').trim().toUpperCase(); const rid = r[ridCol];
        if (!unit || rid == null || rid === '') continue;
        const rec = {};
        hdr.forEach((name, ci) => { if (name && r[ci] != null && r[ci] !== '' && !/^park$|^route\s*id$/i.test(name)) rec[name] = r[ci]; });
        (byUnit[unit] = byUnit[unit] || {})[canon(rid)] = rec;
      }
    }
    return byUnit;
  }

  async function importXlsx(file) {
    const sheetsArr = await parseXlsx(file);
    const byUnit = rowsToRecords(sheetsArr);
    const units = Object.keys(byUnit);
    if (!units.length) { toast('No Park/Route ID rows found', true); return; }
    for (const u of units) { await putUnit({ unit: u, routes: byUnit[u], savedAt: Date.now() }); _cache[u] = byUnit[u]; }
    const unit = activeUnit();
    const here = unit && _cache[unit] ? Object.keys(_cache[unit]).length : 0;
    const matched = unit ? sections().filter((s) => s.route_id && _cache[unit] && _cache[unit][canon(s.route_id)]).length : 0;
    toast(`Loaded ${units.length} parks · ${unit || '—'}: ${matched} routes matched`);
    renderPanel();
  }

  const recordFor = (sec) => {
    const u = activeUnit(); const base = (u && _cache[u] && _cache[u][canon(sec.route_id)]) || {};
    return Object.assign({}, base, sec.scope_data || {});
  };

  // ---- Route Data sheet -------------------------------------------------
  const GROUPS = [
    { t: 'Identity', f: ['Section Name', 'Route Name', 'Shape File Description', 'Road/Parking'] },
    { t: 'Pavement Markings', f: ['4" Line', '6" Line', '12" Line', '24" Line', 'Traffic Arrow', 'Small Traffic Arrow', 'Handicap Parking Striping', 'Cross walks Striping', 'Bike  Striping', 'One way Striping', 'Speed Limit Striping'] },
    { t: 'Signs', f: ['Speed Limit Sign', 'Stop Sign', 'Yield Sign', 'Do Not Enter Sign', 'One Way Sign', 'Lane Control Sign', 'Trail X-ing Sign', 'Ahead Sign', 'Handicap Sign', 'Sign Posts', 'Misc Sign'] },
    { t: 'Traffic Calming & Curbing', f: ['Speed Bumps', 'Curb Stoppers', 'Curb Type', 'Gutter Type'] },
    { t: 'Drainage', f: ['Catch Basins', 'Traffic Loops', 'Swales', 'Culverts'] },
    { t: 'Site Features', f: ['Monuments', 'Gate', 'Utility', 'Fence', 'Guardrail'] },
    { t: 'Treatments', f: ['Agg Seed', 'Patch'] },
    { t: 'Notes', f: ['Notes'] },
  ];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ensureSheet() {
    let ov = document.getElementById('rw2-rdata');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-rdata';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.5);display:none;align-items:stretch;justify-content:flex-end;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#f4f6f9;width:min(460px,96%);height:100%;display:flex;flex-direction:column;box-shadow:-8px 0 34px rgba(0,0,0,.28)">
         <div id="rw2-rdata-head" style="background:#12233b;color:#fff;padding:12px 16px"></div>
         <div id="rw2-rdata-body" style="padding:12px;overflow:auto;flex:1"></div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hideSheet(); });
    return ov;
  }
  function hideSheet() { const ov = document.getElementById('rw2-rdata'); if (ov) ov.style.display = 'none'; }

  function openRouteData(sec) {
    if (!sec) return;
    const ov = ensureSheet();
    const rec = recordFor(sec);
    const rid = (sec.route_id && String(sec.route_id).trim()) || 'NULL';
    const typ = sec.type === 'area' ? 'Parking lot' : 'Road';
    ov.querySelector('#rw2-rdata-head').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
         <div style="min-width:0">
           <div style="font:700 20px 'IBM Plex Mono',monospace;line-height:1.1">${esc(rid)}</div>
           <div style="font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sec.name || sec.id)} · ${esc(activeUnit() || '')}</div>
         </div>
         <span style="cursor:pointer;font-size:22px;line-height:1" id="rw2-rdata-x">×</span>
       </div>
       <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
         <span style="background:${sec.in_scope ? '#0e7c66' : 'rgba(255,255,255,.2)'};padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600">${sec.in_scope ? '✓ In scope' : 'Not in scope'}</span>
         <span style="background:rgba(255,255,255,.2);padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600">${typ}</span>
         ${rec['RIP Data'] != null ? `<span style="background:rgba(255,255,255,.2);padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600">RIP ${esc(rec['RIP Data'])}</span>` : ''}
       </div>`;
    ov.querySelector('#rw2-rdata-x').onclick = hideSheet;

    // measurement tiles (read-only): area from live geometry, rest from workbook
    const areaSf = sec.area_sqft || rec['Area (SF)'];
    const tiles = [
      ['Length', rec['Length (mi)'] != null ? rec['Length (mi)'] + ' mi' : '—'],
      ['Width', rec['Rd Width'] != null ? rec['Rd Width'] + ' ft' : '—'],
      ['Area', areaSf ? Math.round(areaSf).toLocaleString() + ' sf' : '—'],
      ['RIP', rec['RIP Data'] != null ? rec['RIP Data'] : '—'],
    ];
    let html = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
      ${tiles.map(([l, v]) => `<div style="background:#fff;border:1px solid #e3e8ee;border-radius:9px;padding:8px 6px;text-align:center">
         <div style="font-size:10px;color:#8a949f;text-transform:uppercase;letter-spacing:.4px">${l}</div>
         <div style="font-size:14px;font-weight:700;color:#12233b;margin-top:2px">${esc(v)}</div></div>`).join('')}
    </div>`;

    for (const g of GROUPS) {
      const rows = g.f.map((f) => {
        const val = rec[f];
        const isIdentity = g.t === 'Identity';
        const filled = val != null && val !== '';
        // Identity fields are read-only text; everything else is an editable input.
        if (isIdentity) {
          if (!filled) return '';
          return `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid #eef1f4">
             <span style="font-size:12px;color:#5b6673">${esc(f.replace(' Striping', ''))}</span>
             <span style="font-size:12.5px;color:#12233b;font-weight:600;text-align:right">${esc(val)}</span></div>`;
        }
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid #eef1f4">
           <span style="font-size:12px;color:#5b6673">${esc(f.replace(' Striping', '').replace(' Sign', ''))}</span>
           <input data-f="${esc(f)}" value="${esc(filled ? val : '')}" placeholder="—"
             style="width:96px;text-align:right;border:1px solid ${filled ? '#c9d6e5' : '#e3e8ee'};border-radius:6px;padding:3px 7px;font-size:12.5px;color:#12233b;background:${filled ? '#fbfdff' : '#fff'}"></div>`;
      }).join('');
      if (!rows) continue;
      html += `<div style="background:#fff;border:1px solid #e3e8ee;border-radius:11px;padding:9px 12px;margin-bottom:10px">
         <div style="font-size:12px;font-weight:700;color:#0B3D66;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">${g.t}</div>
         ${rows}</div>`;
    }
    if (!Object.keys(rec).length) html += `<div style="color:#8a949f;font-size:12.5px;padding:8px 2px">No workbook data for ${esc(rid)} yet — import the Field Survey Data XLSX via the <b>SCOPE DATA</b> button, or type values below to start.</div>`;

    const body = ov.querySelector('#rw2-rdata-body');
    body.innerHTML = html;
    body.querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.getAttribute('data-f'); const v = inp.value.trim();
        sec.scope_data = sec.scope_data || {};
        if (v === '') delete sec.scope_data[f]; else sec.scope_data[f] = /^-?\d+(\.\d+)?$/.test(v) ? +v : v;
        if (window._RW.persistSections) window._RW.persistSections();
        inp.style.background = v === '' ? '#fff' : '#fbfdff';
        inp.style.borderColor = v === '' ? '#e3e8ee' : '#c9d6e5';
      };
    });
    ov.style.display = 'flex';
  }

  // ---- import panel -----------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-sdata');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-sdata';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:480px;width:94%;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center"><b>Scope data (XLSX)</b><span id="rw2-sdata-x" style="cursor:pointer;font-size:20px">×</span></div>
         <div id="rw2-sdata-body" style="padding:14px"></div>
         <div style="padding:10px 14px;border-top:1px solid #e3e8ee"><button id="rw2-sdata-load" style="width:100%;padding:10px;border:1px dashed #b7cdec;background:#f6f8fa;border-radius:9px;cursor:pointer;color:#12233b;font-weight:600">+ Load Field Survey Data (.xlsx)</button></div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
    ov.querySelector('#rw2-sdata-x').onclick = () => { ov.style.display = 'none'; };
    ov.querySelector('#rw2-sdata-load').onclick = () => fileInput.click();
    return ov;
  }
  function renderPanel() {
    const ov = document.getElementById('rw2-sdata'); if (!ov) return;
    const unit = activeUnit();
    const parks = Object.keys(_cache).sort();
    let html = parks.length
      ? `<div style="font-size:12.5px;color:#12233b;margin-bottom:8px">Loaded workbook data:</div><div style="display:flex;flex-wrap:wrap;gap:6px">${parks.map((u) => `<span style="border:1px solid ${u === unit ? '#1a73e8' : '#e3e8ee'};background:${u === unit ? '#eef4fd' : '#fff'};border-radius:999px;padding:3px 10px;font-size:12px"><b>${u}</b> · ${Object.keys(_cache[u]).length}${u === unit ? ' ● open' : ''}</span>`).join('')}</div>`
      : `<div style="color:#5b6673;font-size:13px">No workbook loaded. Import the Field Survey Data Templates .xlsx — it joins to routes by Park + Route ID and fills each route's data sheet.</div>`;
    if (unit && _cache[unit]) {
      const matched = sections().filter((s) => s.route_id && _cache[unit][canon(s.route_id)]).length;
      html += `<div style="font-size:12.5px;color:#5b6673;margin-top:10px"><b>${unit}</b>: ${matched} of ${sections().length} sections matched. Open a route on the map → <b>Route Data</b>.</div>`;
    }
    ov.querySelector('#rw2-sdata-body').innerHTML = html;
  }
  function showPanel() { ensurePanel(); renderPanel(); document.getElementById('rw2-sdata').style.display = 'flex'; }

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.xlsx'; fileInput.style.display = 'none';
  fileInput.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await importXlsx(f); } catch (err) { toast('Import failed: ' + err.message, true); } } });
  (document.body || document.documentElement).appendChild(fileInput);

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }
  function mount() {
    if (document.getElementById('rw2-sdata-btn')) return;
    const anchor = document.getElementById('rw2-geoio-btn') || document.getElementById('rw2-spins-btn') || document.getElementById('rw2-import-park');
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-sdata-btn'; btn.className = anchor.className; btn.textContent = 'SCOPE DATA';
    btn.addEventListener('click', showPanel);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200); setTimeout(mount, 750);
  loadCache();

  window.RW2RouteData = { open: openRouteData, importXlsx, showPanel, recordFor };
})();
