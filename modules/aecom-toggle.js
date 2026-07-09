/* =========================================================================
 * aecom-toggle.js — NPS ⇄ AECOM geometry toggle (3-state).
 *
 * The donor map draws the CURRENT (AECOM-edited) geometry. This overlays the
 * frozen NPS-original geometry (from the library bundle) so you can compare:
 *   AECOM      — original overlay hidden (you see your edited geometry)
 *   NPS        — original drawn solid orange on top
 *   NPS+AECOM  — original drawn as a dashed ghost under your edits
 *
 * Until a route is actually edited, NPS == AECOM so the overlay coincides with
 * the base layer; the difference appears once vertices are moved.
 * ========================================================================= */
(function () {
  'use strict';

  const STATES = ['aecom', 'nps', 'both'];
  let mode = 'aecom';
  let layer = null;
  let lastUnit = null;

  const getMap = () => (window._RW && window._RW.getMap ? window._RW.getMap() : null);
  const activeUnit = () => (window.RW2Library && window.RW2Library.getActive ? window.RW2Library.getActive() : null);
  const label = () => (mode === 'nps' ? 'NPS' : mode === 'both' ? 'NPS + AECOM' : 'AECOM');

  async function drawOverlay() {
    const m = getMap();
    if (layer && m) { m.removeLayer(layer); layer = null; }
    if (!m || mode === 'aecom') return;
    const unit = activeUnit();
    if (!unit || !window.RW2Library.get) return;
    const rec = await window.RW2Library.get(unit);
    if (!rec || !rec.bundle) return;
    layer = L.layerGroup().addTo(m);
    const style = mode === 'both'
      ? { color: '#e8710a', weight: 1.5, fill: false, dashArray: '5,4', opacity: 0.9 }
      : { color: '#e8710a', weight: 2, fillColor: '#e8710a', fillOpacity: 0.05, opacity: 0.95 };
    (rec.bundle.sections || []).forEach((s) => {
      const coords = (s.alignment || []).map((c) => [c[1], c[0]]);   // [lng,lat] → [lat,lng]
      if (coords.length < 2) return;
      (s.type === 'area' ? L.polygon(coords, style) : L.polyline(coords, style)).addTo(layer);
    });
  }

  function updateBtn() {
    const b = document.getElementById('rw2-nps-toggle');
    if (!b) return;
    b.textContent = label();
    b.title = 'Geometry shown: ' + label() + ' — tap to cycle NPS / AECOM / both';
    b.style.background = mode === 'aecom' ? '#fff' : '#e8710a';
    b.style.color = mode === 'aecom' ? '#12233b' : '#fff';
    b.style.borderColor = mode === 'aecom' ? '#d3dae1' : '#e8710a';
  }
  async function cycle() { mode = STATES[(STATES.indexOf(mode) + 1) % STATES.length]; updateBtn(); await drawOverlay(); }

  function mount() {
    if (document.getElementById('rw2-nps-toggle')) return;
    const mv = document.getElementById('view-field');
    if (!mv) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-nps-toggle';
    btn.textContent = label();
    btn.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:650;padding:7px 14px;border-radius:999px;border:1px solid #d3dae1;background:#fff;color:#12233b;font:600 12px "IBM Plex Sans",system-ui;cursor:pointer;box-shadow:0 1px 4px rgba(20,35,60,.25)';
    btn.addEventListener('click', cycle);
    mv.appendChild(btn);
    updateBtn();
  }

  // mount + redraw overlay only when the open section actually changes
  setInterval(async () => {
    mount();
    const u = activeUnit();
    if (u !== lastUnit) { lastUnit = u; if (mode !== 'aecom') await drawOverlay(); }
  }, 1200);
  setTimeout(mount, 700);

  window.RW2Aecom = { cycle, drawOverlay, getState: () => mode };
})();
