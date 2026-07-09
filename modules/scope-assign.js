/* =========================================================================
 * scope-assign.js — SCOPE review + manual assignment ("confirm" half).
 *
 * Auto-assign (park-import) handles confident name matches. This panel covers
 * the rest: for the open section (park), it lists in-scope routes NOT yet
 * matched, ranks geometry candidates (name + coordinate proximity), flies the
 * map to the scope route's coords, and assigns the Route ID on click.
 * ========================================================================= */
(function () {
  'use strict';

  let SCOPE = {}, RIP = {};
  (async () => {
    try {
      const [s, r] = await Promise.all([fetch('data/_rip/scope.json'), fetch('data/_rip/route_ids.json')]);
      if (s.ok) SCOPE = await s.json();
      if (r.ok) RIP = await r.json();
    } catch (_) {}
  })();

  const ABBR = { ST: 'STREET', RD: 'ROAD', DR: 'DRIVE', AVE: 'AVENUE', AV: 'AVENUE', HWY: 'HIGHWAY', LN: 'LANE', CT: 'COURT', BLVD: 'BOULEVARD', PKWY: 'PARKWAY' };
  function normName(s) {
    s = (s || '').toUpperCase().replace(/^[A-Z]{2}\s+RD\s+/, '');
    return s.replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => ABBR[w] || w).join(' ');
  }
  // NOTE: window._RW.SECTIONS alignments are [lat,lng] (post-applyBundle), and
  // scope.json coords are [lat,lng] — so all math here is in [lat,lng].
  const distFt = (a, b) => { const m = (a[0] + b[0]) / 2 * Math.PI / 180; return Math.hypot((b[1] - a[1]) * Math.cos(m) * 364567, (b[0] - a[0]) * 364567); };
  const centroid = (r) => { let x = 0, y = 0; r.forEach((c) => { x += c[0]; y += c[1]; }); return [x / r.length, y / r.length]; };

  const activeUnit = () => {
    const a = (window.RW2Library && window.RW2Library.getActive) ? window.RW2Library.getActive() : null;
    if (a) return a;
    // Fallback: derive the park from the loaded sections' id prefix (e.g. "CALO-PK-001" → "CALO")
    // so SCOPE works for any loaded bundle, not only library-opened parks.
    const S = sections();
    for (const s of S) { const m = /^([A-Za-z]+)/.exec(s.id || ''); if (m) return m[1].toUpperCase(); }
    return null;
  };
  const scopeFor = (u) => SCOPE[u] || SCOPE[(u || '').split('_')[0]] || null;
  const ripFor = (u) => RIP[u] || RIP[(u || '').split('_')[0]] || {};
  const sections = () => (window._RW && window._RW.SECTIONS) || [];

  function candidatesFor(scRec) {
    const isRoad = scRec.type === 'road';
    const scPt = scRec.start || null;   // [lat,lng] — same convention as SECTIONS
    const nn = normName(scRec.route_name);
    return sections()
      .filter((s) => (s.type === 'linear') === isRoad && !s.in_scope)
      .map((s) => {
        const g = s.type === 'linear' ? s.alignment[0] : centroid(s.alignment);
        const d = scPt ? distFt(g, scPt) : Infinity;
        const nameMatch = normName(s.name) === nn;
        return { s, d, nameMatch, score: (nameMatch ? 0 : 1e7) + d };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, 4);
  }

  function assign(sec, unit, rid, scRec) {
    sec.route_id = rid; sec.in_scope = true; sec.scope_name = scRec.route_name;
    sec.scope_section = scRec.section_name; sec.scope_flag = false;
    const rec = ripFor(unit)[rid]; if (rec) sec.rip = rec;
    if (window._RW && window._RW.persistSections) window._RW.persistSections();
    if (window._RW && window._RW.rerender) window._RW.rerender();
    render();
  }
  function unassign(sec) {
    sec.route_id = ''; sec.in_scope = false; sec.scope_name = ''; sec.scope_section = ''; sec.rip = null;
    if (window._RW && window._RW.persistSections) window._RW.persistSections();
    if (window._RW && window._RW.rerender) window._RW.rerender();
    render();
  }
  function flyTo(scRec) {
    const m = window._RW && window._RW.getMap && window._RW.getMap();
    if (m && scRec.start) m.setView([scRec.start[0], scRec.start[1]], 18);
  }

  // ---- tap-to-assign mode -----------------------------------------------
  // "Tap on map" for a scope route → next section tapped on the map gets that
  // Route ID (the donor section click handler calls assignSection when active).
  let _mode = { active: false, unit: null, routeId: null, scRec: null };
  function enterAssign(unit, routeId, scRec) {
    _mode = { active: true, unit, routeId, scRec };
    hide();                                             // close the panel
    const mapTab = document.querySelector('[data-module="map"]');
    if (mapTab) mapTab.click();                         // go to the map
    if (scRec.start) { const m = window._RW.getMap && window._RW.getMap(); if (m) m.setView([scRec.start[0], scRec.start[1]], 18); }
    showBanner();
  }
  function cancelAssign() { _mode = { active: false, unit: null, routeId: null, scRec: null }; hideBanner(); }
  function assignSection(section) {
    if (!_mode.active || !section) return;
    assign(section, _mode.unit, _mode.routeId, _mode.scRec);
    toast(`Assigned ${_mode.routeId} → ${section.name || section.id}`);
    cancelAssign();
    setTimeout(show, 350);                              // re-open panel to continue
  }
  function showBanner() {
    hideBanner();
    const b = document.createElement('div');
    b.id = 'rw2-assign-banner';
    b.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99997;background:#e8710a;color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;max-width:92%';
    b.innerHTML = `📍 Tap the road/lot for <b style="margin:0 2px">${_mode.routeId}</b> ${(_mode.scRec.route_name || '')} <button id="rw2-assign-cancel" style="border:0;background:rgba(255,255,255,.25);color:#fff;border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit">Cancel</button>`;
    document.body.appendChild(b);
    b.querySelector('#rw2-assign-cancel').onclick = cancelAssign;
  }
  function hideBanner() { const b = document.getElementById('rw2-assign-banner'); if (b) b.remove(); }
  function toast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:#12233b;color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _mode.active) cancelAssign(); });
  window.RW2ScopeAssignMode = { get active() { return _mode.active; }, assignSection };

  // ---- panel -------------------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-scope');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-scope';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:560px;width:94%;max-height:84vh;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
           <b id="rw2-scope-title">Scope</b><span id="rw2-scope-x" style="cursor:pointer;font-size:20px">×</span>
         </div>
         <div id="rw2-scope-body" style="padding:12px 14px;overflow:auto"></div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
    ov.querySelector('#rw2-scope-x').onclick = hide;
    return ov;
  }
  function hide() { const ov = document.getElementById('rw2-scope'); if (ov) ov.style.display = 'none'; }
  function show() { ensurePanel(); render(); document.getElementById('rw2-scope').style.display = 'flex'; }

  function render() {
    const ov = document.getElementById('rw2-scope'); if (!ov) return;
    const unit = activeUnit();
    const sc = scopeFor(unit);
    const body = ov.querySelector('#rw2-scope-body');
    ov.querySelector('#rw2-scope-title').textContent = `Scope — ${unit || '(no section open)'}`;
    if (!unit || !sc) {
      body.innerHTML = `<div style="color:#5b6673;font-size:14px">No scope list for this section${unit ? ` (${unit} is RIP-only)` : ''}.</div>`;
      return;
    }
    const assignedIds = new Set(sections().filter((s) => s.in_scope && s.route_id).map((s) => s.route_id));
    const ids = Object.keys(sc);
    const unassigned = ids.filter((rid) => !assignedIds.has(rid));
    let html = `<div style="font-size:13px;color:#12233b;margin-bottom:10px"><b>${ids.length - unassigned.length}</b> of <b>${ids.length}</b> in-scope routes assigned${unassigned.length ? ` · <b style="color:#b26a00">${unassigned.length}</b> need a match` : ' ✓'}</div>`;
    for (const rid of unassigned) {
      const rec = sc[rid];
      const cands = candidatesFor(rec);
      html += `<div style="border:1px solid #e3e8ee;border-radius:9px;padding:9px 11px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <div><b style="font-family:ui-monospace,monospace;color:#12233b">${rid}</b> <span style="color:#1a2330">${rec.route_name || ''}</span>
            <span style="font-size:11px;color:#8a949f">· ${rec.type}</span></div>
          <span style="white-space:nowrap">
            <button data-fly="${rid}" style="border:1px solid #d3dae1;background:#f6f8fa;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:12px">📍 Fly to</button>
            <button data-tap="${rid}" style="border:1px solid #e8710a;background:#fff5ec;color:#b45309;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:12px;margin-left:4px">🎯 Tap-assign</button>
          </span>
        </div>
        <div style="margin-top:7px;display:flex;flex-direction:column;gap:4px">
          ${cands.length ? cands.map((c, i) => `<button data-assign="${rid}" data-uid="${c.s.uid}" style="text-align:left;border:1px solid ${c.nameMatch ? '#b7cdec' : '#e3e8ee'};background:${c.nameMatch ? '#eef4fd' : '#fff'};border-radius:7px;padding:6px 9px;cursor:pointer;font-size:12.5px">
             ${c.nameMatch ? '✓ ' : ''}${c.s.name || c.s.id} <span style="color:#8a949f">· ${isFinite(c.d) ? Math.round(c.d) + ' ft' : '—'}</span></button>`).join('')
             : '<span style="color:#8a949f;font-size:12px">no unassigned candidates of this type</span>'}
        </div></div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-fly]').forEach((b) => b.onclick = () => flyTo(sc[b.getAttribute('data-fly')]));
    body.querySelectorAll('[data-tap]').forEach((b) => b.onclick = () => { const r = b.getAttribute('data-tap'); enterAssign(unit, r, sc[r]); });
    body.querySelectorAll('[data-assign]').forEach((b) => b.onclick = () => {
      const rid = b.getAttribute('data-assign'), uid = b.getAttribute('data-uid');
      const sec = sections().find((s) => s.uid === uid);
      if (sec) assign(sec, unit, rid, sc[rid]);
    });
  }

  // ---- SCOPE button (self-mounting next to SECTIONS) ---------------------
  function mount() {
    if (document.getElementById('rw2-scope-btn')) return;
    const anchor = document.getElementById('rw2-sections-btn') || document.getElementById('rw2-import-park');
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-scope-btn';
    btn.className = anchor.className;
    btn.textContent = 'SCOPE';
    btn.addEventListener('click', show);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200);
  setTimeout(mount, 600);

  window.RW2Scope = { show, render };
})();
