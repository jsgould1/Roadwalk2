/* =========================================================================
 * scope-pins.js — import a KMZ/KML of in-scope route pins and use them to
 * stamp Route IDs + IN-SCOPE onto the existing section geometry.
 *
 * Each pin is named "<UNIT>-<ROUTEID>" (a parking lot: one pin inside the
 * polygon) or "<UNIT>-<ROUTEID> Start" / " End" (a road: two pins at the
 * polyline ends). The file usually holds several parks; we parse + store all
 * of them, then MATCH ONLY THE PARK THAT'S OPEN:
 *   • parking pin → point-in-polygon into an area section
 *   • road pins   → the linear section whose ends are nearest, oriented so
 *                   0+00 sits at the Start pin
 * Matched sections get route_id + in_scope. A later spreadsheet import will
 * join on the same UNIT+ROUTEID to add route names / quantities / RIP.
 * ========================================================================= */
(function () {
  'use strict';

  const DB = 'roadwalk2_scopepins', STORE = 'pins';
  const TOL_ROAD = 500;   // ft — summed gap of both road endpoints to the pins
  const TOL_NEAR = 300;   // ft — single pin to nearest road vertex / lot centroid

  const sections = () => (window._RW && window._RW.SECTIONS) || [];
  const havFt = (a, b) => { const m = (a[0] + b[0]) / 2 * Math.PI / 180; return Math.hypot((b[1] - a[1]) * Math.cos(m) * 364567, (b[0] - a[0]) * 364567); };
  const centroid = (r) => { let x = 0, y = 0; r.forEach((c) => { x += c[0]; y += c[1]; }); return [x / r.length, y / r.length]; };
  function inPoly(lat, lng, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) hit = !hit;
    }
    return hit;
  }
  function activeUnit() {
    const a = window.RW2Library && window.RW2Library.getActive && window.RW2Library.getActive();
    if (a) return String(a).toUpperCase();
    for (const s of sections()) { const m = /^([A-Za-z]+)/.exec(s.id || ''); if (m) return m[1].toUpperCase(); }
    return null;
  }

  // ---- IndexedDB (persist pins per unit so any park can be matched later) --
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'unit' }); };
      r.onsuccess = (e) => res(e.target.result);
      r.onerror = (e) => rej(e.target.error);
    });
  }
  async function putUnit(rec) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = (e) => rej(e.target.error); }); }
  async function allUnits() { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(); r.onsuccess = (e) => res(e.target.result || []); r.onerror = (e) => rej(e.target.error); }); }
  async function getUnit(u) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(u); r.onsuccess = (e) => res(e.target.result || null); r.onerror = (e) => rej(e.target.error); }); }

  // ---- parse KMZ / KML ---------------------------------------------------
  async function parseFile(file) {
    let kml;
    if (/\.kmz$/i.test(file.name)) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entry = zip.file(/\.kml$/i)[0];
      if (!entry) throw new Error('No .kml inside the KMZ');
      kml = await entry.async('string');
    } else {
      kml = await file.text();
    }
    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    const pins = [];
    for (const pm of doc.getElementsByTagName('Placemark')) {
      const nameEl = pm.getElementsByTagName('name')[0];
      const coordEl = pm.getElementsByTagName('coordinates')[0];
      if (!nameEl || !coordEl) continue;
      const raw = (nameEl.textContent || '').trim();
      const nums = (coordEl.textContent || '').trim().split(/[,\s]+/).map(Number);
      if (nums.length < 2 || !isFinite(nums[0]) || !isFinite(nums[1])) continue;
      const m = /^([A-Za-z]{2,5})-(.+?)(?:\s+(Start|End))?$/i.exec(raw);
      if (!m || !/\d/.test(m[2])) continue;           // skip folder headers / non-route names
      pins.push({ unit: m[1].toUpperCase(), route: m[2].trim(), role: (m[3] || 'point').toLowerCase(), lat: nums[1], lng: nums[0] });
    }
    return pins;
  }

  async function importFile(file) {
    const pins = await parseFile(file);
    if (!pins.length) { toast('No route pins found in that file', true); return; }
    const byUnit = {};
    pins.forEach((p) => { (byUnit[p.unit] = byUnit[p.unit] || []).push(p); });
    for (const unit of Object.keys(byUnit)) {
      await putUnit({ unit, pins: byUnit[unit], source: file.name, savedAt: Date.now() });
    }
    toast(`Loaded ${pins.length} pins · ${Object.keys(byUnit).length} parks`);
    renderPanel();
  }

  // ---- match the active park --------------------------------------------
  async function matchActive() {
    const unit = activeUnit();
    if (!unit) { toast('Open a park first', true); return null; }
    const rec = await getUnit(unit);
    if (!rec || !rec.pins.length) { toast(`No scope pins loaded for ${unit}`, true); return null; }
    const S = sections();
    const areas = S.filter((s) => s.type === 'area');
    const roads = S.filter((s) => s.type === 'linear');

    // group this unit's pins by route id
    const groups = {};
    rec.pins.forEach((p) => { (groups[p.route] = groups[p.route] || []).push(p); });

    const report = { unit, assigned: [], conflicts: [], unmatched: [], oriented: 0 };
    const claimed = new Set();

    const assign = (sec, route, kind, oriented) => {
      if (sec.route_id && sec.route_id !== route) report.conflicts.push({ secId: sec.id, was: sec.route_id, now: route });
      sec.route_id = route; sec.in_scope = true; sec.scope_source = 'kmz';
      claimed.add(sec.id);
      report.assigned.push({ route, secId: sec.id, secName: sec.name || sec.id, kind, oriented: !!oriented });
    };

    for (const route of Object.keys(groups)) {
      const g = groups[route];
      const sp = g.find((p) => p.role === 'start'), ep = g.find((p) => p.role === 'end');
      if (sp && ep) {
        // ROAD (start + end pins): the linear section whose ends best match.
        let best = null, bd = Infinity;
        for (const r of roads) {
          if (claimed.has(r.id) || r.alignment.length < 2) continue;
          const a0 = r.alignment[0], a1 = r.alignment[r.alignment.length - 1];
          const d = Math.min(
            havFt(a0, [sp.lat, sp.lng]) + havFt(a1, [ep.lat, ep.lng]),
            havFt(a1, [sp.lat, sp.lng]) + havFt(a0, [ep.lat, ep.lng]));
          if (d < bd) { bd = d; best = r; }
        }
        if (best && bd < TOL_ROAD) {
          let flipped = false;
          if (window._RW.setSectionStartNear) flipped = window._RW.setSectionStartNear(best.id, sp.lat, sp.lng, true);
          if (flipped) report.oriented++;
          assign(best, route, 'road', flipped);
        } else report.unmatched.push({ route, kind: 'road' });
        continue;
      }
      // SINGLE pin: parking (point-in-polygon) → else nearest road → else nearest lot
      const p = g[0];
      const lot = areas.find((a) => !claimed.has(a.id) && inPoly(p.lat, p.lng, a.alignment));
      if (lot) { assign(lot, route, 'lot', false); continue; }
      let bestRd = null, brd = Infinity;
      for (const r of roads) { if (claimed.has(r.id)) continue; for (const v of r.alignment) { const d = havFt(v, [p.lat, p.lng]); if (d < brd) { brd = d; bestRd = r; } } }
      if (bestRd && brd < TOL_NEAR) {
        let flipped = false;
        if (window._RW.setSectionStartNear) flipped = window._RW.setSectionStartNear(bestRd.id, p.lat, p.lng, true);
        if (flipped) report.oriented++;
        assign(bestRd, route, 'road', flipped);
        continue;
      }
      let bestA = null, bad = Infinity;
      for (const a of areas) { if (claimed.has(a.id)) continue; const d = havFt(centroid(a.alignment), [p.lat, p.lng]); if (d < bad) { bad = d; bestA = a; } }
      if (bestA && bad < TOL_NEAR) { assign(bestA, route, 'lot', false); continue; }
      report.unmatched.push({ route, kind: 'point' });
    }

    if (report.assigned.length) {
      if (window._RW.persistSections) window._RW.persistSections();
      if (window._RW.rerender) window._RW.rerender();
    }
    return report;
  }

  // ---- panel -------------------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-spins');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-spins';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:560px;width:94%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
           <b>Scope pins</b><span id="rw2-spins-x" style="cursor:pointer;font-size:20px">×</span>
         </div>
         <div id="rw2-spins-body" style="padding:12px 14px;overflow:auto"></div>
         <div style="padding:10px 14px;border-top:1px solid #e3e8ee">
           <button id="rw2-spins-load" style="width:100%;padding:10px;border:1px dashed #b7cdec;background:#f6f8fa;border-radius:9px;cursor:pointer;color:#12233b;font-weight:600">+ Load KMZ / KML of scope pins</button>
         </div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
    ov.querySelector('#rw2-spins-x').onclick = hide;
    ov.querySelector('#rw2-spins-load').onclick = () => fileInput.click();
    return ov;
  }
  function hide() { const ov = document.getElementById('rw2-spins'); if (ov) ov.style.display = 'none'; }
  async function show() { ensurePanel(); await renderPanel(); document.getElementById('rw2-spins').style.display = 'flex'; }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function renderPanel(report) {
    const ov = document.getElementById('rw2-spins'); if (!ov) return;
    const body = ov.querySelector('#rw2-spins-body');
    const unit = activeUnit();
    const units = await allUnits();
    let html = '';
    if (!units.length) {
      html += `<div style="color:#5b6673;font-size:14px;padding:4px 2px">No scope pins loaded yet. Load a KMZ/KML whose pins are named <code>UNIT-ROUTEID</code> (roads add <code>Start</code>/<code>End</code>).</div>`;
    } else {
      html += `<div style="font-size:12.5px;color:#12233b;margin-bottom:8px">Loaded pins by park:</div>`;
      html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
      units.sort((a, b) => a.unit.localeCompare(b.unit)).forEach((u) => {
        const on = u.unit === unit;
        html += `<span style="border:1px solid ${on ? '#1a73e8' : '#e3e8ee'};background:${on ? '#eef4fd' : '#fff'};border-radius:999px;padding:3px 10px;font-size:12px"><b>${esc(u.unit)}</b> · ${u.pins.length}${on ? ' ● open' : ''}</span>`;
      });
      html += '</div>';
      const openRec = units.find((u) => u.unit === unit);
      html += unit
        ? `<button id="rw2-spins-match" style="width:100%;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:600;background:${openRec ? '#1a73e8' : '#c3ccd4'};color:#fff" ${openRec ? '' : 'disabled'}>Match ${esc(unit)} pins → sections</button>`
        : `<div style="color:#b26a00;font-size:13px">Open a park to match its pins.</div>`;
    }
    if (report) html += renderReport(report);
    body.innerHTML = html;
    const mb = body.querySelector('#rw2-spins-match');
    if (mb) mb.onclick = async () => { mb.disabled = true; mb.textContent = 'Matching…'; const r = await matchActive(); await renderPanel(r || undefined); };
  }

  function renderReport(r) {
    const line = (label, color, items, fmt) => items.length
      ? `<div style="margin-top:10px"><b style="color:${color};font-size:12.5px">${label} (${items.length})</b>
           <div style="margin-top:4px;display:flex;flex-direction:column;gap:3px">${items.map(fmt).join('')}</div></div>` : '';
    return `<div style="margin-top:14px;border-top:1px solid #e3e8ee;padding-top:10px">
        <div style="font-size:13px;color:#12233b"><b>${r.assigned.length}</b> sections stamped in <b>${esc(r.unit)}</b>${r.oriented ? ` · ${r.oriented} road${r.oriented === 1 ? '' : 's'} oriented Start→End` : ''}</div>
        ${line('Assigned', '#0e7c66', r.assigned, (a) => `<div style="font-size:12px"><span style="font-family:ui-monospace,monospace;font-weight:700">${esc(a.route)}</span> → ${esc(a.secName)} <span style="color:#8a949f">· ${a.kind}${a.oriented ? ' · ↕' : ''}</span></div>`)}
        ${line('Route ID changed', '#b26a00', r.conflicts, (c) => `<div style="font-size:12px">${esc(c.secId)}: <s style="color:#8a949f">${esc(c.was)}</s> → <b>${esc(c.now)}</b></div>`)}
        ${line('No matching geometry', '#c0392b', r.unmatched, (u) => `<div style="font-size:12px"><span style="font-family:ui-monospace,monospace">${esc(u.route)}</span> <span style="color:#8a949f">· ${u.kind}</span></div>`)}
      </div>`;
  }

  // hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.kmz,.kml';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await importFile(f); } catch (err) { toast('Import failed: ' + err.message, true); } } });
  (document.body ? document.body : document.documentElement).appendChild(fileInput);

  // ---- toast + button mount ---------------------------------------------
  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
  }
  function mount() {
    if (document.getElementById('rw2-spins-btn')) return;
    const anchor = document.getElementById('rw2-scope-btn') || document.getElementById('rw2-table-btn') || document.getElementById('rw2-import-park');
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-spins-btn';
    btn.className = anchor.className;
    btn.textContent = 'SCOPE PINS';
    btn.addEventListener('click', show);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200);
  setTimeout(mount, 650);

  window.RW2ScopePins = { importFile, parseFile, matchActive, show };
})();
