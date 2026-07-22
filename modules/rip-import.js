/* =========================================================================
 * rip-import.js — bring an NPS RIP Cycle 6 park into the app as a project.
 *
 * Reads the per-park bundles produced by tools/nps_rip_slice.py: routes and
 * lots become ordinary sections (so the map, popup, Route Data and export all
 * work on them unchanged), while the 0.02 mi condition segments are held
 * separately by RW2RIP because there are far too many to be sections --
 * BLRI alone has 26,098.
 *
 * Two ways in, because the full slice of 309 parks is ~200 MB and does not
 * belong in the repo:
 *   - parks bundled under data/rip/ are listed from data/rip/parks_index.json
 *   - any other park is loaded from a file the user slices locally
 *
 * Everything imports OUT of scope by design; scope is built deliberately in
 * the RIP module using the filters + bulk actions.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const INDEX_URL = 'data/rip/parks_index.json';
  const BUNDLE_DIR = 'data/rip/';

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:'
      + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;'
      + 'font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- geometry ---------------------------------------------------------
  // Bundles store flat [lng,lat,...] rings; live sections use [lat,lng] pairs.
  function ring(flat) {
    const out = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i + 1], flat[i]]);
    return out;
  }
  // A route can arrive as several parts (MultiLineString). Sections hold one
  // alignment, so parts are concatenated in stored order, dropping a repeated
  // joint vertex where one part ends exactly where the next begins.
  function joinParts(parts) {
    const out = [];
    for (const p of parts) {
      const pts = ring(p);
      if (!pts.length) continue;
      if (out.length) {
        const a = out[out.length - 1], b = pts[0];
        if (a[0] === b[0] && a[1] === b[1]) pts.shift();
      }
      out.push(...pts);
    }
    return out;
  }

  function sectionFrom(rec, kind, park) {
    const parts = rec._g || [];
    if (!parts.length) return null;
    const isArea = kind === 'area';
    const alignment = isArea ? ring(parts[0]) : joinParts(parts);
    if (alignment.length < 2) return null;
    const holes = isArea ? parts.slice(1).map(ring).filter((h) => h.length >= 3) : [];

    const ident = rec.ROUTE_IDENT || '';
    const center = isArea && rec.CENT_LAT != null && rec.CENT_LONG != null
      ? [rec.CENT_LAT, rec.CENT_LONG]
      : alignment[Math.floor(alignment.length / 2)];

    // Keep the attribute record on the section (minus geometry) so the table,
    // filters and colour ramp all read from one place.
    const attrs = {};
    for (const k in rec) if (k !== '_g') attrs[k] = rec[k];

    const sec = {
      // ROUTE_IDENT is already park-prefixed (MORR-0017), so don't repeat it.
      id: 'RIP-' + (ident || park + '-' + Math.random().toString(36).slice(2, 8)),
      name: rec.RTE_NAME || ident || '(unnamed)',
      type: isArea ? 'area' : 'linear',
      status: 'prog',
      alignment, holes,
      center,
      route_id: ident,
      faclocid: rec.FMSS_NO || '',
      in_scope: false,
      scope_name: '',
      src_name: rec.RTE_NAME || ident,
      source: 'NPS-RIP-C6',
      featureCount: 0,
      pins: [],
      area_sqft: isArea ? (rec.SQ_FEET || null) : null,
      rip: attrs,
    };
    if (!isArea) {
      if (typeof rec.BEG_MP_DCV === 'number') sec.mpStart = rec.BEG_MP_DCV;
      if (typeof rec.END_MP_DCV === 'number') sec.mpEnd = rec.END_MP_DCV;
    }
    return sec;
  }

  // ---- import -----------------------------------------------------------
  function applyBundleToProject(bundle) {
    if (!bundle || bundle.format !== 'rw2-rip/1') throw new Error('Not a RIP park bundle');
    const park = bundle.park || 'PARK';
    const name = park + ' — RIP Cycle ' + (bundle.cycle || 6);

    if (RW().newProject) RW().newProject(name);
    const S = RW().SECTIONS || [];

    let skipped = 0;
    for (const rec of (bundle.routes || [])) {
      const s = sectionFrom(rec, 'linear', park);
      if (s) S.push(s); else skipped++;
    }
    for (const rec of (bundle.lots || [])) {
      const s = sectionFrom(rec, 'area', park);
      if (s) S.push(s); else skipped++;
    }

    if (window.RW2RIP && window.RW2RIP.attach) window.RW2RIP.attach(bundle);

    if (RW().persistSections) RW().persistSections();
    if (RW().rerender) RW().rerender();

    const segs = (bundle.segments || []).length;
    toast(park + ': ' + S.length + ' routes & lots, ' + segs.toLocaleString() + ' condition segments'
      + (skipped ? ' (' + skipped + ' without geometry skipped)' : ''));
    if (window.showModule) window.showModule('rip');
    if (window.RW2RIP && window.RW2RIP.render) window.RW2RIP.render();
    return { sections: S.length, segments: segs, skipped };
  }

  // Bundles ship gzipped (49 MB vs 277 MB). Browsers decompress gzip natively
  // via DecompressionStream, so fetch the .gz and inflate; fall back to a plain
  // .json for a locally-sliced park that wasn't gzipped.
  async function fetchBundle(file) {
    if (typeof DecompressionStream === 'function') {
      const gz = await fetch(BUNDLE_DIR + file + '.gz', { cache: 'no-cache' });
      if (gz.ok) {
        const stream = gz.body.pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
      }
    }
    const res = await fetch(BUNDLE_DIR + file, { cache: 'no-cache' });
    if (!res.ok) throw new Error('could not fetch ' + file + ' (' + res.status + ')');
    return res.json();
  }

  async function importPark(entry) {
    toast('Loading ' + entry.park + '…');
    return applyBundleToProject(await fetchBundle(entry.file));
  }

  // ---- park picker ------------------------------------------------------
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      applyBundleToProject(JSON.parse(await f.text()));
    } catch (err) { toast('Load failed: ' + err.message, true); }
  });
  (document.body || document.documentElement).appendChild(fileInput);

  let _index = null;
  async function loadIndex() {
    if (_index) return _index;
    try {
      const res = await fetch(INDEX_URL, { cache: 'no-cache' });
      if (!res.ok) return (_index = { parks: [] });
      _index = await res.json();
    } catch (_) { _index = { parks: [] }; }
    return _index;
  }

  async function show() {
    const old = document.getElementById('rip-picker'); if (old) old.remove();
    const idx = await loadIndex();
    const parks = (idx.parks || []).slice().sort((a, b) => a.park.localeCompare(b.park));

    const wrap = document.createElement('div');
    wrap.id = 'rip-picker';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(12,22,38,.45);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px';
    wrap.innerHTML =
      `<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;max-height:82vh;
                   display:flex;flex-direction:column;overflow:hidden;font:14px 'IBM Plex Sans',system-ui;
                   box-shadow:0 18px 50px rgba(10,20,40,.35)">
         <div style="padding:16px 18px 12px;border-bottom:1px solid #eef1f4">
           <div style="font-size:17px;font-weight:800;color:#12233b">Import a park — RIP Cycle 6</div>
           <div style="font-size:12.5px;color:#5b6673;margin-top:3px">
             Routes and lots come in <b>out of scope</b>. Condition data is at 0.02 mi (105.6 ft).</div>
           <input id="rip-pick-q" placeholder="Filter parks…" style="margin-top:10px;width:100%;
             padding:8px 11px;border:1px solid #d3dae1;border-radius:9px;font:14px inherit">
         </div>
         <div id="rip-pick-list" style="overflow:auto;padding:6px 0;flex:1"></div>
         <div style="padding:11px 16px;border-top:1px solid #eef1f4;display:flex;gap:8px;justify-content:space-between;align-items:center">
           <button id="rip-pick-file" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;
             padding:8px 13px;cursor:pointer;font-weight:600;color:#12233b">📂 Load a park file…</button>
           <button id="rip-pick-close" style="border:0;background:#eef1f4;border-radius:9px;
             padding:8px 15px;cursor:pointer;font-weight:600;color:#12233b">Close</button>
         </div>
       </div>`;
    document.body.appendChild(wrap);

    const list = wrap.querySelector('#rip-pick-list');
    function paint(filter) {
      const q = (filter || '').trim().toUpperCase();
      const rows = parks.filter((p) => !q || p.park.includes(q)
        || (p.states || []).join(' ').includes(q));
      if (!rows.length) {
        list.innerHTML = `<div style="padding:22px 18px;color:#8a949f;text-align:center">
          ${parks.length ? 'No park matches “' + esc(filter) + '”.'
            : 'No bundled parks found.<br><span style="font-size:12.5px">Slice one with '
              + '<code>tools/nps_rip_slice.py</code>, then use <b>Load a park file…</b></span>'}</div>`;
        return;
      }
      list.innerHTML = rows.map((p) => {
        const c = p.counts || {};
        const dl = p.gz_bytes || p.bytes;
        const mb = dl ? (dl / 1048576).toFixed(dl < 1048576 ? 2 : 1) + ' MB' : '';
        return `<button class="rip-pick-row" data-park="${esc(p.park)}"
            style="display:flex;width:100%;gap:12px;align-items:center;text-align:left;border:0;
                   background:#fff;padding:11px 18px;cursor:pointer;border-bottom:1px solid #f2f5f8">
            <span style="font:800 14px 'IBM Plex Mono',monospace;color:#0B3D66;min-width:56px">${esc(p.park)}</span>
            <span style="flex:1;min-width:0;color:#5b6673;font-size:12.5px">
              ${esc((p.states || []).join(', '))} · ${c.routes || 0} roads · ${c.lots || 0} lots ·
              ${(c.segments || 0).toLocaleString()} segs</span>
            <span style="color:#8a949f;font-size:11.5px">${mb}</span>
          </button>`;
      }).join('');
      list.querySelectorAll('.rip-pick-row').forEach((b) => {
        b.onmouseenter = () => { b.style.background = '#f6f9fc'; };
        b.onmouseleave = () => { b.style.background = '#fff'; };
        b.onclick = async () => {
          const entry = parks.find((p) => p.park === b.getAttribute('data-park'));
          if (!entry) return;
          if ((RW().SECTIONS || []).length
              && !confirm('Import ' + entry.park + '?\nThis replaces the current working project.')) return;
          wrap.remove();
          try { await importPark(entry); }
          catch (err) { toast('Import failed: ' + err.message, true); }
        };
      });
    }
    paint('');
    wrap.querySelector('#rip-pick-q').addEventListener('input', (e) => paint(e.target.value));
    wrap.querySelector('#rip-pick-file').onclick = () => { wrap.remove(); fileInput.click(); };
    wrap.querySelector('#rip-pick-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  }

  window.RW2RIPImport = { show, importPark, applyBundleToProject, sectionFrom };
})();
