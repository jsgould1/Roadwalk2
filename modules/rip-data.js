/* =========================================================================
 * rip-data.js — the RIP module: filterable review of an imported NPS RIP
 * Cycle 6 park, over two tabs on one shared filter set.
 *
 *   Assets      one row per road / lot (the inventory), with the in-scope
 *               toggle -- this is where scope actually gets built
 *   Conditions  one row per 0.02 mi (105.6 ft) segment
 *
 * Scope is meant to be built by filtering and then applying in bulk ("set
 * filtered in scope"), not by tapping 250 routes one at a time.
 *
 * Two facts about this dataset drive the UI:
 *  - -1 means "not measured" and the slicer already nulled it, so a blank
 *    cell is genuinely blank and must never be coloured as a bad score.
 *  - lots carry NO distress data at all (RCI/SCR/IRI/RUT and the five
 *    distress indices are -1 on 100% of rows), so those columns and metrics
 *    are hidden whenever the view is lots-only.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  const sections = () => (RW().SECTIONS) || [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Rows rendered at once. A big park has 26,000 segments and building that
  // many <tr> locks the tab up, so the table pages -- and always says so,
  // because a silent cap reads as "this is everything".
  const PAGE = 300;

  // ---- metrics ----------------------------------------------------------
  // dir:'high' = bigger is better (0-100 scores); dir:'low' = smaller is
  // better (roughness, rutting, condition index).
  const METRICS = {
    PCR:              { label: 'PCR',    dir: 'high', max: 100, both: true },
    CONDITION_RATING: { label: 'Cond',   dir: 'high', max: 100, both: true },
    SCR:              { label: 'SCR',    dir: 'high', max: 100 },
    RCI:              { label: 'RCI',    dir: 'high', max: 100 },
    SC_INDEX:         { label: 'Surface',dir: 'high', max: 100 },
    AC_INDEX:         { label: 'Alligator', dir: 'high', max: 100 },
    LC_INDEX:         { label: 'Long.',  dir: 'high', max: 100 },
    TC_INDEX:         { label: 'Trans.', dir: 'high', max: 100 },
    PATCH_INDEX:      { label: 'Patch',  dir: 'high', max: 100 },
    RUT_INDEX:        { label: 'Rut idx',dir: 'high', max: 100 },
    IRI_AVG:          { label: 'IRI',    dir: 'low',  max: 400 },
    RUT_AVG:          { label: 'Rut',    dir: 'low',  max: 1 },
    FCI:              { label: 'FCI',    dir: 'low',  max: 1, both: true },
  };
  // Metrics that exist for parking lots. Everything else is -1 on every lot.
  const LOT_METRICS = ['PCR', 'CONDITION_RATING', 'FCI'];

  const RAMP = ['#d73027', '#fdae61', '#fee08b', '#a6d96a', '#1a9850'];
  const NO_DATA = '#b8c0c8';

  // 0 (worst) .. 1 (best) for a metric value, honouring direction.
  function norm(metric, v) {
    const m = METRICS[metric]; if (!m || v == null || isNaN(v)) return null;
    const t = Math.max(0, Math.min(1, Number(v) / m.max));
    return m.dir === 'low' ? 1 - t : t;
  }
  function colorFor(metric, v) {
    const n = norm(metric, v);
    if (n == null) return NO_DATA;
    return RAMP[Math.min(RAMP.length - 1, Math.floor(n * RAMP.length))];
  }

  // ---- state ------------------------------------------------------------
  const state = {
    park: null,
    bundle: null,          // { park, cycle, states, bbox, counts }
    segments: [],          // all 0.02 mi segments
    segsByRoute: new Map(),
    tab: 'assets',
    metric: 'PCR',
    limit: PAGE,
    sort: { key: 'ROUTE_IDENT', dir: 1 },
    q: '',
    kind: 'all',           // all | road | lot
    scope: 'all',          // all | in | out
    facets: {},            // field -> selected value ('' = any)
    range: { min: '', max: '' },
  };

  // Facets offered in the filter rail, in order. Only those with more than
  // one distinct value in the current park are rendered.
  const FACETS = [
    ['SURF_TYPE', 'Surface'], ['FACILITY_TYPE', 'Facility'], ['USER_ACCESS', 'Access'],
    ['UNPAVED', 'Unpaved'], ['FLTP', 'FLTP'], ['OWNER', 'Owner'],
    ['M_RATING', 'Rating'], ['RTE_SERIES', 'Series'], ['CURB', 'Curb'],
    ['PAVEMENT_TREATMENT', 'Treatment'], ['Status', 'Status'],
  ];

  // ---- persistence ------------------------------------------------------
  // The park payload is far too big for the project bundle, so it lives in
  // its own IndexedDB store and is re-attached on reload.
  const DB = 'roadwalk2_rip', STORE = 'rip';
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function save() {
    if (!state.bundle) return;
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({
          park: state.park, bundle: state.bundle, segments: state.segments,
        }, 'active');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { console.warn('[RIP] save failed', e); }
  }
  async function restore() {
    try {
      const db = await idb();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const rq = tx.objectStore(STORE).get('active');
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
      if (rec && rec.bundle) hydrate(rec.bundle, rec.segments || []);
    } catch (e) { /* nothing stored yet */ }
  }

  function hydrate(bundle, segments) {
    state.park = bundle.park;
    state.bundle = { park: bundle.park, cycle: bundle.cycle, states: bundle.states,
                     bbox: bundle.bbox, counts: bundle.counts };
    state.segments = segments;
    state.segsByRoute = new Map();
    for (const s of segments) {
      const k = s.ROUTE_IDENT;
      let a = state.segsByRoute.get(k);
      if (!a) state.segsByRoute.set(k, a = []);
      a.push(s);
    }
    for (const a of state.segsByRoute.values()) a.sort((x, y) => (x.BEG_MP || 0) - (y.BEG_MP || 0));
  }

  function attach(bundle) {
    hydrate(bundle, bundle.segments || []);
    state.limit = PAGE;
    save();
  }

  // ---- data views -------------------------------------------------------
  const ripOf = (sec) => (sec && sec.rip) || {};
  function ripSections() { return sections().filter((s) => s.rip); }

  function passesFacets(attrs, kindOk) {
    if (!kindOk) return false;
    for (const k in state.facets) {
      const want = state.facets[k];
      if (want === '' || want == null) continue;
      if (String(attrs[k] == null ? '' : attrs[k]) !== want) return false;
    }
    return true;
  }

  function inRange(v) {
    const lo = state.range.min === '' ? null : Number(state.range.min);
    const hi = state.range.max === '' ? null : Number(state.range.max);
    if (lo == null && hi == null) return true;
    if (v == null || isNaN(v)) return false;           // blank fails an explicit range
    if (lo != null && v < lo) return false;
    if (hi != null && v > hi) return false;
    return true;
  }

  function matchQ(sec, attrs) {
    if (!state.q) return true;
    const q = state.q.toUpperCase();
    return String(sec.route_id || '').toUpperCase().includes(q)
        || String(sec.name || '').toUpperCase().includes(q)
        || String(attrs.FMSS_NO || '').toUpperCase().includes(q);
  }

  function filteredAssets() {
    return ripSections().filter((sec) => {
      const a = ripOf(sec);
      const isLot = sec.type === 'area';
      const kindOk = state.kind === 'all' || (state.kind === 'lot') === isLot;
      if (!passesFacets(a, kindOk)) return false;
      if (state.scope === 'in' && !sec.in_scope) return false;
      if (state.scope === 'out' && sec.in_scope) return false;
      if (!matchQ(sec, a)) return false;
      if (!inRange(a[state.metric])) return false;
      return true;
    });
  }

  // Conditions inherit their parent route's attributes for filtering, so the
  // same rail drives both tabs, but the metric range applies to the segment.
  function filteredConditions() {
    const parents = new Map();
    for (const sec of ripSections()) if (sec.route_id) parents.set(sec.route_id, sec);
    const out = [];
    for (const seg of state.segments) {
      const sec = parents.get(seg.ROUTE_IDENT);
      if (!sec) continue;
      const a = ripOf(sec);
      const kindOk = state.kind === 'all' || state.kind === 'road';   // segments are roads
      if (!passesFacets(a, kindOk)) continue;
      if (state.scope === 'in' && !sec.in_scope) continue;
      if (state.scope === 'out' && sec.in_scope) continue;
      if (!matchQ(sec, a)) continue;
      if (!inRange(seg[state.metric])) continue;
      out.push({ seg, sec });
    }
    return out;
  }

  // Which metrics make sense right now -- lots have no distress data.
  function availableMetrics() {
    const lotsOnly = state.kind === 'lot';
    return Object.keys(METRICS).filter((k) =>
      state.tab === 'conditions' ? k !== 'FCI' : (!lotsOnly || LOT_METRICS.includes(k)));
  }

  function sortRows(rows, get) {
    const { key, dir } = state.sort;
    return rows.slice().sort((r1, r2) => {
      const a = get(r1, key), b = get(r2, key);
      const an = a == null || a === '', bn = b == null || b === '';
      if (an && bn) return 0;
      if (an) return 1;                 // blanks always sink
      if (bn) return -1;
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }

  // ---- bulk scope -------------------------------------------------------
  function setFilteredScope(on) {
    const rows = filteredAssets();
    if (!rows.length) return;
    const verb = on ? 'in scope' : 'out of scope';
    if (!confirm('Set ' + rows.length + ' filtered route' + (rows.length === 1 ? '' : 's') + ' ' + verb + '?')) return;
    rows.forEach((s) => { s.in_scope = !!on; });
    if (RW().persistSections) RW().persistSections();
    if (RW().rerender) RW().rerender();
    render();
  }

  // ---- render -----------------------------------------------------------
  function chip(label, active, attrs) {
    return `<button ${attrs} style="border:1px solid ${active ? '#0B3D66' : '#d3dae1'};
      background:${active ? '#0B3D66' : '#fff'};color:${active ? '#fff' : '#12233b'};
      border-radius:999px;padding:5px 12px;cursor:pointer;font:600 12.5px 'IBM Plex Sans',system-ui">${esc(label)}</button>`;
  }

  function facetOptions() {
    const secs = ripSections();
    const html = [];
    for (const [field, label] of FACETS) {
      const vals = new Set();
      for (const s of secs) {
        const v = ripOf(s)[field];
        if (v != null && v !== '') vals.add(String(v));
      }
      if (vals.size < 2) continue;                 // nothing to choose between
      const sel = state.facets[field] || '';
      html.push(`<label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#5b6673">
        ${esc(label)}
        <select data-facet="${field}" style="border:1px solid #d3dae1;border-radius:8px;padding:4px 7px;
          font:12.5px 'IBM Plex Sans',system-ui;background:#fff;max-width:135px">
          <option value=""${sel === '' ? ' selected' : ''}>All</option>
          ${[...vals].sort().map((v) =>
            `<option value="${esc(v)}"${sel === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select></label>`);
    }
    return html.join('');
  }

  function metricCell(metric, v) {
    if (v == null || v === '') return '<td style="color:#b8c0c8;text-align:right">—</td>';
    const c = colorFor(metric, v);
    return `<td style="text-align:right;font-variant-numeric:tabular-nums">
      <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:6px"></span>${esc(v)}</td>`;
  }

  function th(key, label, align) {
    const on = state.sort.key === key;
    return `<th data-sort="${key}" style="position:sticky;top:0;background:#f7f9fb;z-index:1;
      text-align:${align || 'left'};padding:7px 9px;border-bottom:1px solid #e3e8ee;cursor:pointer;
      font:700 11.5px 'IBM Plex Sans',system-ui;color:#12233b;white-space:nowrap">
      ${esc(label)}${on ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  }

  function assetsTable() {
    const rows = sortRows(filteredAssets(), (s, k) =>
      k === 'ROUTE_IDENT' ? s.route_id : k === 'name' ? s.name
      : k === 'kind' ? (s.type === 'area' ? 'Lot' : 'Road')
      : k === 'size' ? (s.type === 'area' ? (ripOf(s).SQ_FEET || 0) : (ripOf(s).RTE_LENGTH || 0))
      : ripOf(s)[k]);
    const shown = rows.slice(0, state.limit);
    const m = state.metric;
    const body = shown.map((s) => {
      const a = ripOf(s);
      const isLot = s.type === 'area';
      const size = isLot ? (a.SQ_FEET != null ? a.SQ_FEET.toLocaleString() + ' sf' : '—')
                         : (a.RTE_LENGTH != null ? a.RTE_LENGTH.toFixed(3) + ' mi' : '—');
      return `<tr data-id="${esc(s.id)}" style="border-bottom:1px solid #f2f5f8">
        <td style="padding:5px 9px"><input type="checkbox" data-scope="${esc(s.id)}"${s.in_scope ? ' checked' : ''}></td>
        <td style="padding:5px 9px;font:700 12px 'IBM Plex Mono',monospace;color:#0B3D66;white-space:nowrap">${esc(s.route_id || '—')}</td>
        <td style="padding:5px 9px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</td>
        <td style="padding:5px 9px;color:#5b6673">${isLot ? 'Lot' : 'Road'}</td>
        <td style="padding:5px 9px;color:#5b6673">${esc(a.SURF_TYPE || '—')}</td>
        <td style="padding:5px 9px;text-align:right;color:#5b6673;white-space:nowrap">${size}</td>
        ${metricCell(m, a[m])}
        <td style="padding:5px 9px;color:#5b6673">${esc(a.M_RATING || '—')}</td>
        <td style="padding:5px 9px"><button data-goto="${esc(s.id)}" title="Show on map"
          style="border:0;background:transparent;cursor:pointer;font-size:14px">🗺</button></td>
      </tr>`;
    }).join('');
    return { total: rows.length, shown: shown.length, html:
      `<table style="width:100%;border-collapse:collapse;font:13px 'IBM Plex Sans',system-ui">
        <thead><tr>
          <th style="position:sticky;top:0;background:#f7f9fb;z-index:1;padding:7px 9px;border-bottom:1px solid #e3e8ee;width:28px"></th>
          ${th('ROUTE_IDENT', 'Route ID')}${th('name', 'Name')}${th('kind', 'Kind')}
          ${th('SURF_TYPE', 'Surf')}${th('size', 'Size', 'right')}
          ${th(state.metric, METRICS[state.metric].label, 'right')}${th('M_RATING', 'Rating')}
          <th style="position:sticky;top:0;background:#f7f9fb;border-bottom:1px solid #e3e8ee;width:32px"></th>
        </tr></thead><tbody>${body}</tbody></table>` };
  }

  function conditionsTable() {
    const rows = sortRows(filteredConditions(), (r, k) =>
      k === 'ROUTE_IDENT' ? r.seg.ROUTE_IDENT : k === 'name' ? r.sec.name
      : k === 'station' ? (r.seg.BEG_MP || 0) : r.seg[k]);
    const shown = rows.slice(0, state.limit);
    const m = state.metric;
    const extra = ['SC_INDEX', 'AC_INDEX', 'LC_INDEX', 'TC_INDEX', 'PATCH_INDEX']
      .filter((k) => k !== m);
    const body = shown.map(({ seg, sec }) => `
      <tr data-id="${esc(sec.id)}" style="border-bottom:1px solid #f2f5f8">
        <td style="padding:5px 9px;font:700 12px 'IBM Plex Mono',monospace;color:#0B3D66;white-space:nowrap">${esc(seg.ROUTE_IDENT)}</td>
        <td style="padding:5px 9px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sec.name)}</td>
        <td style="padding:5px 9px;font:12px 'IBM Plex Mono',monospace;color:#5b6673;white-space:nowrap">
          ${(seg.BEG_MP != null ? seg.BEG_MP.toFixed(2) : '?')}–${(seg.END_MP != null ? seg.END_MP.toFixed(2) : '?')}</td>
        ${metricCell(m, seg[m])}
        ${extra.map((k) => `<td style="text-align:right;color:#5b6673;font-variant-numeric:tabular-nums">${seg[k] == null ? '—' : esc(seg[k])}</td>`).join('')}
        <td style="padding:5px 9px;color:#5b6673">${esc(seg.QR || '—')}</td>
        <td style="padding:5px 9px"><button data-goto="${esc(sec.id)}" title="Show on map"
          style="border:0;background:transparent;cursor:pointer;font-size:14px">🗺</button></td>
      </tr>`).join('');
    return { total: rows.length, shown: shown.length, html:
      `<table style="width:100%;border-collapse:collapse;font:13px 'IBM Plex Sans',system-ui">
        <thead><tr>
          ${th('ROUTE_IDENT', 'Route ID')}${th('name', 'Name')}${th('station', 'MP')}
          ${th(m, METRICS[m].label, 'right')}
          ${extra.map((k) => th(k, METRICS[k].label, 'right')).join('')}
          ${th('QR', 'QR')}
          <th style="position:sticky;top:0;background:#f7f9fb;border-bottom:1px solid #e3e8ee;width:32px"></th>
        </tr></thead><tbody>${body}</tbody></table>` };
  }

  function render() {
    const host = $('mod-rip'); if (!host) return;

    if (!state.bundle) {
      host.innerHTML = `<div style="max-width:640px;margin:0 auto;padding:60px 20px;text-align:center;
          font-family:'IBM Plex Sans',system-ui">
          <div style="font-size:42px">🛣</div>
          <div style="font-size:19px;font-weight:800;color:#12233b;margin-top:8px">No RIP park loaded</div>
          <div style="color:#5b6673;margin:8px 0 18px;font-size:13.5px">
            Import an NPS RIP Cycle 6 park to review its inventory and 0.02 mi condition data.</div>
          <button id="rip-import-btn" style="border:0;background:#1a73e8;color:#fff;border-radius:10px;
            padding:11px 20px;cursor:pointer;font-weight:700;font-size:14px">Import a park…</button>
        </div>`;
      const b = $('rip-import-btn');
      if (b) b.onclick = () => window.RW2RIPImport && window.RW2RIPImport.show();
      return;
    }

    const secs = ripSections();
    const inScope = secs.filter((s) => s.in_scope).length;
    const tbl = state.tab === 'assets' ? assetsTable() : conditionsTable();
    const metrics = availableMetrics();
    if (!metrics.includes(state.metric)) state.metric = metrics[0] || 'PCR';

    host.innerHTML =
      `<div style="max-width:1180px;margin:0 auto;padding:16px 16px 40px;font-family:'IBM Plex Sans',system-ui">

        <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div>
            <div style="font-size:12px;color:#8a949f;text-transform:uppercase;letter-spacing:.6px">RIP Cycle ${esc(state.bundle.cycle)}</div>
            <div style="font-size:24px;font-weight:800;color:#12233b;line-height:1.1">
              ${esc(state.park)} <span style="font-size:14px;font-weight:600;color:#8a949f">${esc((state.bundle.states || []).join(', '))}</span></div>
            <div style="font-size:13px;color:#5b6673;margin-top:3px">
              ${secs.length} routes &amp; lots · ${state.segments.length.toLocaleString()} segments at 0.02 mi ·
              <b style="color:#0e7c66">${inScope}</b> in scope</div>
          </div>
          <div style="display:flex;gap:8px">
            <button id="rip-btn-import" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font-weight:600;color:#12233b">Import park…</button>
            <button id="rip-btn-map" style="border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font-weight:600">🗺 Map</button>
          </div>
        </div>

        <div style="background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:11px 13px;margin-bottom:12px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input id="rip-q" value="${esc(state.q)}" placeholder="Search route ID, name, FMSS…"
              style="flex:1;min-width:180px;border:1px solid #d3dae1;border-radius:8px;padding:6px 10px;font:13px inherit">
            ${chip('All', state.kind === 'all', 'data-kind="all"')}
            ${chip('Roads', state.kind === 'road', 'data-kind="road"')}
            ${chip('Lots', state.kind === 'lot', 'data-kind="lot"')}
            <span style="width:1px;height:20px;background:#e3e8ee"></span>
            ${chip('Any scope', state.scope === 'all', 'data-scope-f="all"')}
            ${chip('In scope', state.scope === 'in', 'data-scope-f="in"')}
            ${chip('Out', state.scope === 'out', 'data-scope-f="out"')}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:9px">
            ${facetOptions()}
            <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#5b6673">
              Metric
              <select id="rip-metric" style="border:1px solid #d3dae1;border-radius:8px;padding:4px 7px;font:12.5px inherit;background:#fff">
                ${metrics.map((k) => `<option value="${k}"${k === state.metric ? ' selected' : ''}>${esc(METRICS[k].label)}</option>`).join('')}
              </select></label>
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#5b6673">
              between <input id="rip-min" value="${esc(state.range.min)}" placeholder="min" style="width:56px;border:1px solid #d3dae1;border-radius:7px;padding:4px 6px;font:12.5px inherit">
              and <input id="rip-max" value="${esc(state.range.max)}" placeholder="max" style="width:56px;border:1px solid #d3dae1;border-radius:7px;padding:4px 6px;font:12.5px inherit"></label>
            <button id="rip-clear" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12.5px inherit;color:#5b6673">Clear</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:9px;padding-top:9px;border-top:1px solid #f2f5f8">
            <span style="font-size:12px;color:#5b6673">Filtered <b>${tbl.total.toLocaleString()}</b> ${state.tab === 'assets' ? 'routes' : 'segments'} —</span>
            <button id="rip-scope-in" style="border:0;background:#0e7c66;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12.5px inherit">Set in scope</button>
            <button id="rip-scope-out" style="border:1px solid #d3dae1;background:#fff;color:#12233b;border-radius:8px;padding:6px 12px;cursor:pointer;font:600 12.5px inherit">Set out of scope</button>
            ${state.tab === 'conditions' ? '<span style="font-size:11.5px;color:#8a949f">(applies to the routes behind these segments)</span>' : ''}
          </div>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:0">
          ${['assets', 'conditions'].map((t) => `<button data-tab="${t}"
            style="border:1px solid #e3e8ee;border-bottom:${state.tab === t ? '1px solid #fff' : '1px solid #e3e8ee'};
            background:${state.tab === t ? '#fff' : '#eef1f4'};color:#12233b;border-radius:10px 10px 0 0;
            padding:8px 16px;cursor:pointer;font:700 13px inherit;position:relative;top:1px">
            ${t === 'assets' ? 'Assets' : 'Conditions'}</button>`).join('')}
        </div>

        <div style="background:#fff;border:1px solid #e3e8ee;border-radius:0 12px 12px 12px;overflow:hidden">
          <div style="max-height:60vh;overflow:auto">${tbl.html}</div>
          <div style="padding:9px 13px;border-top:1px solid #eef1f4;display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:#5b6673">
            <span>Showing <b>${tbl.shown.toLocaleString()}</b> of <b>${tbl.total.toLocaleString()}</b></span>
            ${tbl.shown < tbl.total ? '<button id="rip-more" style="border:1px solid #d3dae1;background:#fff;border-radius:8px;padding:5px 13px;cursor:pointer;font:600 12.5px inherit;color:#12233b">Show ' + Math.min(PAGE, tbl.total - tbl.shown) + ' more</button>' : '<span style="color:#b8c0c8">end of list</span>'}
          </div>
        </div>
      </div>`;

    wire(host);
  }

  function wire(host) {
    const rerender = () => render();
    const set = (fn) => { fn(); state.limit = PAGE; rerender(); };

    const q = $('rip-q');
    if (q) q.oninput = (e) => {
      state.q = e.target.value; state.limit = PAGE;
      const at = e.target.selectionStart; render();
      const nq = $('rip-q'); if (nq) { nq.focus(); nq.setSelectionRange(at, at); }
    };
    host.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => set(() => { state.kind = b.dataset.kind; }));
    host.querySelectorAll('[data-scope-f]').forEach((b) => b.onclick = () => set(() => { state.scope = b.dataset.scopeF; }));
    host.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => set(() => { state.tab = b.dataset.tab; }));
    host.querySelectorAll('[data-facet]').forEach((s) => s.onchange = () => set(() => { state.facets[s.dataset.facet] = s.value; }));
    host.querySelectorAll('[data-sort]').forEach((h) => h.onclick = () => set(() => {
      const k = h.dataset.sort;
      if (state.sort.key === k) state.sort.dir *= -1; else state.sort = { key: k, dir: 1 };
    }));

    const met = $('rip-metric'); if (met) met.onchange = () => set(() => { state.metric = met.value; });
    const mn = $('rip-min'); if (mn) mn.onchange = () => set(() => { state.range.min = mn.value.trim(); });
    const mx = $('rip-max'); if (mx) mx.onchange = () => set(() => { state.range.max = mx.value.trim(); });
    const clr = $('rip-clear'); if (clr) clr.onclick = () => set(() => {
      state.q = ''; state.kind = 'all'; state.scope = 'all';
      state.facets = {}; state.range = { min: '', max: '' };
    });
    const more = $('rip-more'); if (more) more.onclick = () => { state.limit += PAGE; render(); };

    const si = $('rip-scope-in'); if (si) si.onclick = () => setFilteredScope(true);
    const so = $('rip-scope-out'); if (so) so.onclick = () => setFilteredScope(false);
    const imp = $('rip-btn-import'); if (imp) imp.onclick = () => window.RW2RIPImport && window.RW2RIPImport.show();
    const mp = $('rip-btn-map'); if (mp) mp.onclick = () => { if (RW().openMap) RW().openMap(); else if (window.showModule) window.showModule('map'); };

    host.querySelectorAll('[data-scope]').forEach((cb) => cb.onchange = () => {
      const sec = sections().find((s) => s.id === cb.dataset.scope);
      if (!sec) return;
      sec.in_scope = cb.checked;
      if (RW().persistSections) RW().persistSections();
      if (RW().rerender) RW().rerender();
      render();
    });
    host.querySelectorAll('[data-goto]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.goto;
      if (RW().showView) RW().showView('field', id);
      if (window.showModule) window.showModule('map');
    });
  }

  // ---- boot -------------------------------------------------------------
  document.getElementById('app-tabs')?.addEventListener('click', (e) => {
    if (e.target.closest('.app-tab[data-module="rip"]')) setTimeout(render, 0);
  });
  restore().then(render);

  window.RW2RIP = {
    state, attach, render, save,
    show: () => { if (window.showModule) window.showModule('rip'); render(); },
    segmentsFor: (routeIdent) => state.segsByRoute.get(routeIdent) || [],
    colorFor, norm, METRICS, LOT_METRICS,
    metric: () => state.metric,
    hasPark: () => !!state.bundle,
  };
})();
