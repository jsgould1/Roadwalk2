/* =========================================================================
 * scope-inscope.js — set IN SCOPE from an uploaded in-scope list (XLSX).
 *
 * The list looks like:  Park | Route ID | Section Name
 * where the 3rd column (Section Name) holds the full route ident that matches
 * a section's route_id (e.g. ABLI-0011). Uploading it marks every matching
 * route in the CURRENT park in scope. The list typically spans many parks, so
 * only rows for the loaded park match — the rest are reported, not applied.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const sections = () => (RW().SECTIONS) || [];
  const norm = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:'
      + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;'
      + 'font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3600);
  }

  // Minimal XLSX read → first sheet as an array of row arrays (col-indexed).
  const colIdx = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  async function parseFirstSheet(file) {
    if (typeof JSZip === 'undefined') throw new Error('XLSX reader not loaded');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const px = async (p) => { const f = zip.file(p); return f ? f.async('string') : ''; };
    const DP = new DOMParser();
    const shared = [];
    const ss = DP.parseFromString(await px('xl/sharedStrings.xml') || '<x/>', 'application/xml');
    for (const si of ss.getElementsByTagName('si')) { let t = ''; for (const tn of si.getElementsByTagName('t')) t += tn.textContent; shared.push(t); }
    // first worksheet by the workbook's first <sheet> relationship
    const wb = DP.parseFromString(await px('xl/workbook.xml'), 'application/xml');
    const rels = DP.parseFromString(await px('xl/_rels/workbook.xml.rels') || '<x/>', 'application/xml');
    const relMap = {}; for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
    const s0 = wb.getElementsByTagName('sheet')[0];
    let rid = s0 && s0.getAttribute('r:id');
    if (s0 && !rid) { for (const a of s0.attributes) if (/:id$/.test(a.name)) rid = a.value; }
    let tgt = (relMap[rid] || 'worksheets/sheet1.xml');
    if (!/^xl\//.test(tgt)) tgt = 'xl/' + tgt.replace(/^\/+/, '');
    const sd = DP.parseFromString(await px(tgt) || '<x/>', 'application/xml');
    const rows = [];
    for (const row of sd.getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const ref = (c.getAttribute('r') || '').replace(/[0-9]/g, '') || 'A';
        const ci = colIdx(ref);
        const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0];
        let val = null;
        if (t === 's') val = shared[parseInt((v && v.textContent) || '0', 10)];
        else if (t === 'inlineStr') { const is = c.getElementsByTagName('t')[0]; val = is ? is.textContent : ''; }
        else if (v != null) val = v.textContent;
        if (val != null && val !== '') cells[ci] = val;
      }
      rows.push(cells);
    }
    return rows;
  }

  // Pull the route-ident set from the list. Prefer a "Section Name"/route-ident
  // column; fall back to the 3rd column (the user's stated layout); and accept
  // any hyphenated PARK-#### value found on a row as a safety net.
  function extractRouteIds(rows) {
    if (!rows.length) return new Set();
    // find header row + a route-ident column
    let hdrRow = -1, identCol = -1;
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const r = rows[i] || [];
      const idx = r.findIndex((x) => /section\s*name|route\s*ident|route\s*id/i.test(String(x || '')));
      if (idx >= 0 && r.filter((x) => x != null && x !== '').length >= 2) { hdrRow = i; identCol = idx; break; }
    }
    const ident = /^[A-Za-z]{2,6}-?\w+/;   // e.g. ABLI-0011
    const looksIdent = (v) => typeof v === 'string' && v.includes('-') && ident.test(v.trim());
    const out = new Set();
    const start = hdrRow >= 0 ? hdrRow + 1 : 0;
    // if the found ident column mostly holds hyphenated IDs, use it; else col 3
    let col = identCol;
    if (col < 0) col = 2;
    else {
      let hit = 0, tot = 0;
      for (let i = start; i < rows.length; i++) { const v = (rows[i] || [])[col]; if (v != null && v !== '') { tot++; if (looksIdent(v)) hit++; } }
      if (tot && hit / tot < 0.5) col = 2;
    }
    for (let i = start; i < rows.length; i++) {
      const r = rows[i] || [];
      let v = r[col];
      if (!looksIdent(v)) v = r.find((x) => looksIdent(x));   // safety net: any hyphenated id on the row
      if (looksIdent(v)) out.add(norm(v));
    }
    return out;
  }

  // ---- apply + confirm dialog ------------------------------------------
  function applyScope(listIds, alsoClear) {
    const secs = sections().filter((s) => s.route_id);
    let setIn = 0, setOut = 0;
    for (const s of secs) {
      if (listIds.has(norm(s.route_id))) { if (!s.in_scope) setIn++; s.in_scope = true; }
      else if (alsoClear && s.in_scope) { setOut++; s.in_scope = false; }
    }
    if (RW().persistSections) RW().persistSections();
    if (RW().rerender) RW().rerender();
    toast(setIn + ' set in scope' + (alsoClear ? (' · ' + setOut + ' cleared') : ''));
  }

  function confirmDialog(listIds) {
    const secs = sections().filter((s) => s.route_id);
    if (!secs.length) { toast('Open a project first, then upload the in-scope list.', true); return; }
    const inList = secs.filter((s) => listIds.has(norm(s.route_id)));
    const notInList = secs.filter((s) => !listIds.has(norm(s.route_id)));
    const park = (RW().getProjectName && RW().getProjectName()) || 'this project';
    const matchedIds = new Set(inList.map((s) => norm(s.route_id)));
    const listOnly = [...listIds].filter((x) => !matchedIds.has(x)).length;   // list rows for other parks

    const old = document.getElementById('rw2-inscope-modal'); if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'rw2-inscope-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(12,22,38,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:13px;max-width:440px;width:100%;box-shadow:0 18px 50px rgba(10,20,40,.35);overflow:hidden">'
      + '<div style="padding:16px 18px 12px;border-bottom:1px solid #eef1f4">'
      + '<div style="font-size:17px;font-weight:800;color:#12233b">Set In Scope from list</div>'
      + '<div style="font-size:12.5px;color:#5b6673;margin-top:3px">' + listIds.size + ' route IDs in the file.</div></div>'
      + '<div style="padding:15px 18px">'
      + '<div style="font-size:14px;color:#12233b"><b style="font-size:22px;color:#0e7c66">' + inList.length + '</b> of this project\'s '
      + secs.length + ' routes match the list and will be set <b>in scope</b>.</div>'
      + (listOnly ? '<div style="font-size:12px;color:#8a949f;margin-top:6px">' + listOnly + ' list entries are for other parks and are ignored.</div>' : '')
      + (notInList.length ? '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;cursor:pointer;font-size:13px;color:#3a4653">'
          + '<input type="checkbox" id="rw2-inscope-clear" checked style="margin-top:2px">'
          + '<span>Set the other <b>' + notInList.length + '</b> route' + (notInList.length === 1 ? '' : 's') + ' in this project <b>out of scope</b><br>'
          + '<span style="color:#8a949f;font-size:11.5px">(the list defines the complete scope)</span></span></label>'
        : '')
      + '</div>'
      + '<div style="padding:12px 18px;border-top:1px solid #eef1f4;display:flex;gap:8px;justify-content:flex-end">'
      + '<button id="rw2-inscope-cancel" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:9px 15px;cursor:pointer;font-weight:600;color:#12233b">Cancel</button>'
      + '<button id="rw2-inscope-apply" style="border:0;background:#0e7c66;color:#fff;border-radius:9px;padding:9px 17px;cursor:pointer;font-weight:700"' + (inList.length ? '' : ' disabled') + '>Apply</button>'
      + '</div></div>';
    document.body.appendChild(wrap);
    document.getElementById('rw2-inscope-cancel').onclick = () => wrap.remove();
    document.getElementById('rw2-inscope-apply').onclick = () => {
      const clear = !!(document.getElementById('rw2-inscope-clear') || {}).checked;
      wrap.remove(); applyScope(listIds, clear);
    };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  }

  // ---- entry ------------------------------------------------------------
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.xlsx'; fileInput.style.display = 'none';
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const rows = await parseFirstSheet(f);
      const ids = extractRouteIds(rows);
      if (!ids.size) { toast('No route IDs found — expected them in column C (Section Name).', true); return; }
      confirmDialog(ids);
    } catch (err) { toast('Could not read the list: ' + err.message, true); }
  });
  (document.body || document.documentElement).appendChild(fileInput);

  window.RW2InScopeList = { show: () => fileInput.click() };
})();
