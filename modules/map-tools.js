/* =========================================================================
 * map-tools.js — map-first workflow.
 *  • The Map tab always opens the map stage (window._RW.openMap).
 *  • A search bar (top-left) recentres the map on an address or "lat, lng".
 *  • An "Add Route" button (above Add Feature) starts a road / lot / lot-with-
 *    cut-outs draw straight on the map — no "what are you inspecting?" page.
 * ========================================================================= */
(function () {
  'use strict';
  const RW = () => window._RW || {};
  const map = () => (RW().getMap ? RW().getMap() : null);

  // Push the map's top-left controls (Add Feature) below our bar.
  const style = document.createElement('style');
  style.textContent = '#view-field .leaflet-top.leaflet-left{margin-top:104px}';
  document.head.appendChild(style);

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
  }

  // ---- Add Route ---------------------------------------------------------
  function startRoute(kind) {
    if (!RW().startTrace) { toast('Draw tool not ready', true); return; }
    if (kind === 'linear') RW().startTrace('linear');
    else if (kind === 'area') RW().startTrace('area');
    else if (kind === 'area-cut') RW().startTrace('area', { cutIslands: true });
  }

  // ---- geocoding: Esri (no key, handles business names/POIs), then OSM ---
  async function geocodeEsri(q, m) {
    let bias = '';
    try { if (m && m.getCenter) { const c = m.getCenter(); bias = '&location=' + c.lng + ',' + c.lat; } } catch (_) {}
    try {
      const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&outFields=Match_addr' + bias + '&singleLine=' + encodeURIComponent(q);
      const r = await fetch(url); const j = await r.json();
      const c = (j.candidates || [])[0];
      if (c && c.location) return { lat: c.location.y, lng: c.location.x, label: c.address || q };
    } catch (_) {}
    return null;
  }
  async function geocodeOSM(q) {
    // retry once dropping a leading org acronym ("USPS Greensburg PA" → "Greensburg PA")
    const tries = [q]; const m = q.match(/^([A-Za-z]{2,5})\s+(.+)$/); if (m) tries.push(m[2]);
    for (const t of tries) {
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(t));
        const j = await r.json();
        if (j && j.length) return { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name };
      } catch (_) {}
    }
    return null;
  }

  async function onSearch(e) {
    e.preventDefault();
    const inp = document.getElementById('rw2-search-input');
    const q = (inp.value || '').trim(); if (!q) return;
    const m = map(); if (!m) { toast('Open the map first', true); return; }
    const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (ll) { m.setView([+ll[1], +ll[2]], 19); return; }
    inp.disabled = true;
    try {
      const hit = (await geocodeEsri(q, m)) || (await geocodeOSM(q));
      if (hit) { m.setView([hit.lat, hit.lng], 19); toast(String(hit.label).split(',').slice(0, 3).join(',')); }
      else toast('No match — try a full address, a place name, or paste "lat, lng"', true);
    } catch (_) { toast('Search failed — paste "lat, lng" instead', true); }
    inp.disabled = false;
  }

  // ---- the floating bar --------------------------------------------------
  function ensureBar() {
    const host = document.getElementById('view-field');
    if (!host) return;
    if (document.getElementById('rw2-mapbar')) return;
    const bar = document.createElement('div');
    bar.id = 'rw2-mapbar';
    bar.style.cssText = 'position:absolute;top:10px;left:10px;z-index:1200;display:flex;flex-direction:column;gap:8px;font-family:"IBM Plex Sans",system-ui;width:min(330px,72vw)';
    bar.innerHTML =
      `<form id="rw2-search-form" style="display:flex;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.28);overflow:hidden">
         <input id="rw2-search-input" placeholder="Search address or lat, lng" autocomplete="off"
                style="flex:1;min-width:0;border:0;padding:10px 12px;font-size:14px;outline:none;color:#12233b">
         <button type="submit" title="Search" style="border:0;background:#1a73e8;color:#fff;padding:0 15px;cursor:pointer;font-size:15px">🔍</button>
       </form>
       <div style="position:relative">
         <button id="rw2-addroute-btn" style="width:100%;border:0;background:#0e7c66;color:#fff;padding:11px;border-radius:10px;cursor:pointer;font-weight:700;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,.28)">+ Add Route ▾</button>
         <div id="rw2-addroute-menu" style="display:none;position:absolute;top:48px;left:0;right:0;background:#fff;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.3);overflow:hidden;z-index:5">
           <button class="rw2-rt-opt" data-rt="linear">🛣&nbsp; Road (linear)</button>
           <button class="rw2-rt-opt" data-rt="area">🅿&nbsp; Parking lot (polygon)</button>
           <button class="rw2-rt-opt" data-rt="area-cut">✂&nbsp; Lot with cut-outs</button>
         </div>
       </div>`;
    host.appendChild(bar);
    bar.querySelectorAll('.rw2-rt-opt').forEach((b) => {
      b.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-top:1px solid #eef1f4;background:#fff;padding:12px 14px;cursor:pointer;font-size:13.5px;color:#12233b';
      b.onmouseenter = () => { b.style.background = '#f1f7f5'; };
      b.onmouseleave = () => { b.style.background = '#fff'; };
      b.onclick = () => { document.getElementById('rw2-addroute-menu').style.display = 'none'; startRoute(b.getAttribute('data-rt')); };
    });
    bar.querySelector('#rw2-search-form').onsubmit = onSearch;
    const menu = bar.querySelector('#rw2-addroute-menu');
    bar.querySelector('#rw2-addroute-btn').onclick = (e) => { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; };
    document.addEventListener('click', (e) => { if (!bar.contains(e.target)) menu.style.display = 'none'; });
  }

  // Map tab always lands on the map, with the bar present.
  document.getElementById('app-tabs')?.addEventListener('click', (e) => {
    if (e.target.closest('.app-tab[data-module="map"]')) {
      setTimeout(() => { if (RW().openMap) RW().openMap(); ensureBar(); }, 30);
    }
  });
  // Ensure the bar exists whenever the map stage is showing (any entry path).
  setInterval(() => { if (document.getElementById('view-field')?.classList.contains('active')) ensureBar(); }, 1000);

  window.RW2MapTools = { ensureBar, openMap: () => { if (RW().openMap) RW().openMap(); ensureBar(); } };
})();
