/* =========================================================================
 * sections-table.js — Dashboard "Sections table" (all sections by PARK).
 *
 * A cross-park roll-up of every imported route (road / parking lot), grouped
 * by PARK, with a toggle to show ALL sections or only IN-SCOPE ones. Reads the
 * MOST CURRENT state per park:
 *   • the open park            → window._RW.SECTIONS (live edits, incl. tap-assign)
 *   • every other saved park   → its 'safety' working copy (rw_sections_<id>)
 *                                falling back to the library's pristine bundle.
 * Rows are clickable — open that park and jump to the section. CSV export too.
 * ========================================================================= */
(function () {
  'use strict';

  const q = (id) => document.getElementById(id);
  let _inScopeOnly = false;

  // ---- gather rows from every saved park --------------------------------
  function sectionsForBundle(sections) {
    return (sections || []).map((s) => ({
      id: s.id,
      route_id: s.route_id || '',
      name: s.name || s.src_name || s.id,
      type: s.type === 'linear' ? 'road' : 'lot',
      in_scope: !!s.in_scope,
      area_sqft: s.area_sqft || null,
      faclocid: s.faclocid || (s.rip && s.rip.faclocid) || '',
    }));
  }

  async function workingCopy(bundleId) {
    if (!bundleId || !window.RWIdb || !window.RWIdb.get) return null;
    try {
      const rec = await window.RWIdb.get('safety', 'rw_sections_' + bundleId);
      if (rec && Array.isArray(rec.sections) && rec.sections.length) return rec.sections;
    } catch (_) {}
    return null;
  }

  async function buildParks() {
    if (!window.RW2Library || !window.RW2Library.all) return [];
    const items = (await window.RW2Library.all())
      .sort((a, b) => (a.unit || '').localeCompare(b.unit || ''));
    const active = window.RW2Library.getActive ? window.RW2Library.getActive() : null;
    const parks = [];
    for (const it of items) {
      let secs;
      if (it.unit === active && window._RW && Array.isArray(window._RW.SECTIONS)) {
        secs = window._RW.SECTIONS;                        // live (most current)
      } else {
        secs = (await workingCopy(it.bundle && it.bundle.id))  // saved edits
             || (it.bundle && it.bundle.sections);              // pristine fallback
      }
      parks.push({ unit: it.unit, name: it.name || it.unit, active: it.unit === active,
                   rows: sectionsForBundle(secs) });
    }
    return parks;
  }

  // ---- panel -------------------------------------------------------------
  function ensurePanel() {
    let ov = q('rw2-tbl');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-tbl';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:820px;width:96%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
           <b id="rw2-tbl-title">Sections</b>
           <span style="display:flex;align-items:center;gap:10px">
             <span id="rw2-tbl-csv" title="Download CSV" style="cursor:pointer;font-size:13px;font-weight:600;opacity:.9">⭳ CSV</span>
             <span id="rw2-tbl-x" style="cursor:pointer;font-size:20px;line-height:1">×</span>
           </span>
         </div>
         <div style="padding:10px 14px;border-bottom:1px solid #e3e8ee;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
           <div id="rw2-tbl-toggle" style="display:inline-flex;border:1px solid #d3dae1;border-radius:8px;overflow:hidden;font-size:13px;font-weight:600">
             <button data-scope="all"  style="border:0;padding:6px 14px;cursor:pointer">All sections</button>
             <button data-scope="in"   style="border:0;padding:6px 14px;cursor:pointer">In scope</button>
           </div>
           <span id="rw2-tbl-summary" style="font-size:12.5px;color:#5b6673"></span>
         </div>
         <div id="rw2-tbl-body" style="padding:6px 8px 12px;overflow:auto"></div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
    q('rw2-tbl-x').onclick = hide;
    q('rw2-tbl-csv').onclick = exportCsv;
    ov.querySelectorAll('#rw2-tbl-toggle button').forEach((b) => {
      b.onclick = () => { _inScopeOnly = b.getAttribute('data-scope') === 'in'; render(); };
    });
    return ov;
  }
  function hide() { const ov = q('rw2-tbl'); if (ov) ov.style.display = 'none'; }
  async function show() { ensurePanel(); await render(); q('rw2-tbl').style.display = 'flex'; }

  function paintToggle() {
    document.querySelectorAll('#rw2-tbl-toggle button').forEach((b) => {
      const on = (b.getAttribute('data-scope') === 'in') === _inScopeOnly;
      b.style.background = on ? '#1a73e8' : '#fff';
      b.style.color = on ? '#fff' : '#12233b';
    });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmtArea = (a) => (a ? Math.round(a).toLocaleString() + ' sf' : '');

  async function render() {
    const ov = q('rw2-tbl'); if (!ov) return;
    paintToggle();
    const parks = await buildParks();
    let total = 0, totalScope = 0;
    let html = '';
    for (const p of parks) {
      const rows = _inScopeOnly ? p.rows.filter((r) => r.in_scope) : p.rows;
      const nScope = p.rows.filter((r) => r.in_scope).length;
      total += p.rows.length; totalScope += nScope;
      if (!rows.length) continue;
      html += `<div style="margin:10px 6px 4px;display:flex;align-items:baseline;gap:8px">
          <b style="font-size:14px;color:#12233b">${esc(p.unit)}</b>
          ${p.active ? '<span style="color:#1a73e8;font-size:11px;font-weight:600">● OPEN</span>' : ''}
          <span style="font-size:11.5px;color:#8a949f">${p.rows.length} route${p.rows.length === 1 ? '' : 's'} · ${nScope} in scope</span>
        </div>`;
      html += `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="color:#8a949f;text-align:left">
            <th style="padding:3px 8px;font-weight:600">Route ID</th>
            <th style="padding:3px 8px;font-weight:600">Name</th>
            <th style="padding:3px 8px;font-weight:600">Type</th>
            <th style="padding:3px 8px;font-weight:600">Scope</th>
            <th style="padding:3px 8px;font-weight:600;text-align:right">Area</th>
          </tr></thead><tbody>`;
      for (const r of rows.slice().sort(sortRows)) {
        html += `<tr class="rw2-tbl-row" data-unit="${esc(p.unit)}" data-id="${esc(r.id)}" data-active="${p.active ? 1 : 0}"
              style="cursor:pointer;border-top:1px solid #eef1f4">
            <td style="padding:5px 8px;font-family:ui-monospace,monospace;color:#12233b">${esc(r.route_id) || '<span style="color:#c3ccd4">—</span>'}</td>
            <td style="padding:5px 8px;color:#1a2330">${esc(r.name)}</td>
            <td style="padding:5px 8px;color:#5b6673">${r.type === 'road' ? '🛣 Road' : '🅿 Lot'}</td>
            <td style="padding:5px 8px">${r.in_scope ? '<span style="color:#0e7c66;font-weight:600">✓ In scope</span>' : '<span style="color:#c3ccd4">—</span>'}</td>
            <td style="padding:5px 8px;text-align:right;color:#5b6673">${esc(fmtArea(r.area_sqft))}</td>
          </tr>`;
      }
      html += '</tbody></table>';
    }
    if (!html) html = `<div style="color:#5b6673;font-size:14px;padding:16px 8px">No ${_inScopeOnly ? 'in-scope ' : ''}sections${window.RW2Library ? '' : ''}. Import a park to get started.</div>`;
    ov.querySelector('#rw2-tbl-body').innerHTML = html;
    q('rw2-tbl-title').textContent = _inScopeOnly ? 'Sections — In scope' : 'Sections — All';
    q('rw2-tbl-summary').textContent = `${parks.length} park${parks.length === 1 ? '' : 's'} · ${total} routes · ${totalScope} in scope`;
    ov.querySelectorAll('.rw2-tbl-row').forEach((tr) => {
      tr.onclick = () => goTo(tr.getAttribute('data-unit'), tr.getAttribute('data-id'), tr.getAttribute('data-active') === '1');
    });
  }

  // in-scope first, then road/lot, then route id
  function sortRows(a, b) {
    if (a.in_scope !== b.in_scope) return a.in_scope ? -1 : 1;
    if (a.type !== b.type) return a.type === 'road' ? -1 : 1;
    return (a.route_id || '~').localeCompare(b.route_id || '~');
  }

  async function goTo(unit, id, isActive) {
    hide();
    if (isActive) { if (typeof showView === 'function') showView('field', id); return; }
    if (window.RW2Library && window.RW2Library.open) {
      await window.RW2Library.open(unit);
      setTimeout(() => { if (typeof showView === 'function') showView('field', id); }, 450);
    }
  }

  // ---- CSV ---------------------------------------------------------------
  async function exportCsv() {
    const parks = await buildParks();
    const rows = [['Park', 'Route ID', 'Name', 'Type', 'In Scope', 'FMSS', 'Area (sf)']];
    for (const p of parks) {
      for (const r of (_inScopeOnly ? p.rows.filter((x) => x.in_scope) : p.rows).slice().sort(sortRows)) {
        rows.push([p.unit, r.route_id, r.name, r.type === 'road' ? 'Road' : 'Lot',
                   r.in_scope ? 'Yes' : 'No', r.faclocid, r.area_sqft ? Math.round(r.area_sqft) : '']);
      }
    }
    const csv = rows.map((r) => r.map((c) => {
      c = String(c == null ? '' : c);
      return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
    }).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'roadwalk2-sections' + (_inScopeOnly ? '-inscope' : '') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---- self-mounting button (next to SCOPE / SECTIONS in the dashboard) --
  function mount() {
    if (q('rw2-table-btn')) return;
    const anchor = q('rw2-scope-btn') || q('rw2-sections-btn') || q('rw2-import-park');
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-table-btn';
    btn.className = anchor.className;
    btn.textContent = 'TABLE';
    btn.addEventListener('click', show);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200);
  setTimeout(mount, 600);

  window.RW2SectionsTable = { show };
})();
