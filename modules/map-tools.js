/* =========================================================================
 * map-tools.js — map-first workflow + top-of-map layout.
 *  • The Map tab always opens the map stage (window._RW.openMap).
 *  • A search bar sits TOP-CENTRE of the map and recentres on an address or
 *    "lat, lng".
 *  • The search bar and both Leaflet control stacks are offset to sit UNDER
 *    the SLD (alignment strip) — moving down when it opens, up when it closes,
 *    so all three start at the same height.
 *  • "Add Route" lives at the top of the "+ Add Feature" tray (first + most
 *    prominent), not as a separate button.
 * ========================================================================= */
(function () {
  'use strict';
  const RW = () => window._RW || {};
  const map = () => (RW().getMap ? RW().getMap() : null);

  // Controls read a single CSS variable for their top offset; layoutControls()
  // keeps it in sync with the SLD. The AECOM/CLIENT toggle tucks just under the
  // search bar so it doesn't fight the centred search.
  const style = document.createElement('style');
  style.textContent =
    '#view-field .leaflet-top.leaflet-left,#view-field .leaflet-top.leaflet-right{margin-top:var(--rw-ctl-top,12px)!important;transition:margin-top .15s ease}'
    + '#rw2-mapbar{top:var(--rw-ctl-top,12px)!important;left:50%!important;right:auto!important;transform:translateX(-50%)!important;transition:top .15s ease}'
    + '#rw2-nps-toggle{top:calc(var(--rw-ctl-top,12px) + 46px)!important;transition:top .15s ease}'
    + '#rw2-tray-addroute .rw2-rt-opt:hover{background:#f1f7f5}';
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

  // ---- the centred search bar -------------------------------------------
  function ensureBar() {
    const host = document.getElementById('view-field');
    if (!host) return;
    if (document.getElementById('rw2-mapbar')) return;
    const bar = document.createElement('div');
    bar.id = 'rw2-mapbar';
    bar.style.cssText = 'position:absolute;z-index:1200;font-family:"IBM Plex Sans",system-ui;width:min(360px,66vw)';
    bar.innerHTML =
      `<form id="rw2-search-form" style="display:flex;background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.28);overflow:hidden">
         <input id="rw2-search-input" placeholder="Search address or lat, lng" autocomplete="off"
                style="flex:1;min-width:0;border:0;padding:10px 12px;font-size:14px;outline:none;color:#12233b">
         <button type="submit" title="Search" style="border:0;background:#1a73e8;color:#fff;padding:0 15px;cursor:pointer;font-size:15px">🔍</button>
       </form>`;
    host.appendChild(bar);
    bar.querySelector('#rw2-search-form').onsubmit = onSearch;
  }

  // ---- Add Route inside the "+ Add Feature" tray ------------------------
  function ensureTrayAddRoute() {
    const picker = document.getElementById('feature-picker');
    const list = document.getElementById('fp-list');
    if (!picker || !list || document.getElementById('rw2-tray-addroute')) return;
    const block = document.createElement('div');
    block.id = 'rw2-tray-addroute';
    block.style.cssText = 'padding:10px 12px 4px;border-bottom:1px solid #eef1f4';
    block.innerHTML =
      '<div style="font:700 10px \'IBM Plex Mono\',monospace;letter-spacing:.5px;color:#0e7c66;margin:0 2px 7px">ADD ROUTE</div>'
      + '<div style="display:flex;flex-direction:column;gap:6px">'
      + rtBtn('linear', '🛣', 'Road', 'linear centerline')
      + rtBtn('area', '🅿', 'Parking lot', 'polygon')
      + rtBtn('area-cut', '✂', 'Lot with cut-outs', 'polygon + islands')
      + '</div>';
    // Above the feature list, so a list rebuild never wipes it.
    picker.insertBefore(block, list);
    block.querySelectorAll('.rw2-rt-opt').forEach((b) => {
      b.onclick = () => { closeTray(); startRoute(b.getAttribute('data-rt')); };
    });
  }
  function rtBtn(kind, ico, title, sub) {
    return '<button class="rw2-rt-opt" data-rt="' + kind + '" style="display:flex;align-items:center;gap:10px;width:100%;'
      + 'text-align:left;border:1px solid #cfe8df;background:#f4fbf8;border-radius:9px;padding:9px 11px;cursor:pointer">'
      + '<span style="font-size:18px">' + ico + '</span>'
      + '<span style="display:flex;flex-direction:column"><span style="font:700 13px system-ui;color:#12233b">' + title + '</span>'
      + '<span style="font:11px system-ui;color:#5b6673">' + sub + '</span></span></button>';
  }
  function closeTray() {
    const close = document.getElementById('fp-sheet-close');
    if (close) { close.click(); return; }
    const picker = document.getElementById('feature-picker');
    if (picker) picker.classList.remove('open');
  }

  // ---- keep the controls under the SLD ----------------------------------
  function layoutControls() {
    const field = document.getElementById('view-field');
    if (!field) return;
    const strip = document.getElementById('alignment-strip');
    let top = 12;
    if (strip && strip.classList.contains('open')) {
      const fr = field.getBoundingClientRect(), sr = strip.getBoundingClientRect();
      // Only the top-docked strip pushes the controls down; a side/bottom dock
      // leaves the top band clear.
      if (sr.height > 4 && (sr.top - fr.top) < 90 && sr.bottom > fr.top + 8) {
        top = Math.round(sr.bottom - fr.top) + 10;
      }
    }
    field.style.setProperty('--rw-ctl-top', top + 'px');
  }
  // React immediately to the strip opening/closing (class + inline size changes).
  let _stripObserved = null;
  function observeStrip() {
    const strip = document.getElementById('alignment-strip');
    if (!strip || _stripObserved === strip) return;
    _stripObserved = strip;
    try {
      new MutationObserver(layoutControls).observe(strip, { attributes: true, attributeFilter: ['class', 'style'] });
    } catch (_) {}
  }

  function tick() {
    if (!document.getElementById('view-field')?.classList.contains('active')) return;
    ensureBar(); ensureTrayAddRoute(); observeStrip(); layoutControls();
  }

  document.getElementById('app-tabs')?.addEventListener('click', (e) => {
    if (e.target.closest('.app-tab[data-module="map"]')) {
      setTimeout(() => { if (RW().openMap) RW().openMap(); tick(); }, 30);
    }
  });
  setInterval(tick, 1000);

  window.RW2MapTools = { ensureBar, startRoute, layoutControls,
    openMap: () => { if (RW().openMap) RW().openMap(); tick(); } };
})();
