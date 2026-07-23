/* =========================================================================
 * rip-pathweb.js — deep-link a RIP route/segment into NPS PathWeb by COORDINATE.
 *
 * The official EFLHD-RIP dashboard links to PathWeb with a spatial search:
 *   https://pathweb.pathwayservices.com/rip/search
 *     ?sectionFilter=[cycle=latest]
 *     &spatialfilter=[x=<lng>,y=<lat>,radiusmeters=100.0]
 * (discovered in that dashboard's ROAD_CONDITIONS layer, field
 * PATHWEB_CYCLE_7_URL). This needs no PathWeb section id — just a lat/lng —
 * so it works for every route and segment we have geometry for, across all
 * 342 parks. `cycle=latest` opens the newest collection (Cycle 7); `cycle=6`
 * targets Cycle 6.
 * ========================================================================= */
(function () {
  'use strict';

  const SEARCH = 'https://pathweb.pathwayservices.com/rip/search';
  const RADIUS = 100.0;

  function spatialUrl(lat, lng, cycle) {
    const sf = encodeURIComponent('[cycle=' + (cycle || 'latest') + ']');
    const spf = encodeURIComponent('[x=' + lng.toFixed(6) + ',y=' + lat.toFixed(6) + ',radiusmeters=' + RADIUS.toFixed(1) + ']');
    return SEARCH + '?sectionFilter=' + sf + '&spatialfilter=' + spf;
  }

  // A 0.02 mi segment's midpoint [lat,lng], from its flat [lng,lat,...] parts.
  function coordOfSeg(seg) {
    const parts = seg && seg._g; if (!parts || !parts.length) return null;
    let best = parts[0]; for (const p of parts) if (p.length > best.length) best = p;
    const n = best.length / 2, m = Math.floor(n / 2);
    return [best[m * 2 + 1], best[m * 2]];
  }
  // A section/route's representative point [lat,lng] (alignment midpoint / centre).
  function coordOfSec(sec) {
    if (sec && sec.center && sec.center.length === 2) return [sec.center[0], sec.center[1]];
    const al = sec && sec.alignment;
    if (Array.isArray(al) && al.length) return al[Math.floor(al.length / 2)];
    return null;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function openAt(lat, lng, cycle) {
    if (lat == null || lng == null) return;
    window.open(spatialUrl(lat, lng, cycle), '_blank', 'noopener');
  }

  // Small popup (Street-View style) offering the two cycles + the point info.
  // `label` describes what we're opening (route + mile, or route start).
  function chooser(lat, lng, label) {
    const old = document.getElementById('rip-pw-modal'); if (old) old.remove();
    if (lat == null || lng == null) return;
    const wrap = document.createElement('div');
    wrap.id = 'rip-pw-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(12,22,38,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:13px;max-width:390px;width:100%;box-shadow:0 18px 50px rgba(10,20,40,.35);overflow:hidden">'
      + '<div style="padding:15px 17px 11px;border-bottom:1px solid #eef1f4">'
      + '<div style="font-size:16px;font-weight:800;color:#12233b">Open in PathWeb</div>'
      + '<div style="font-size:12.5px;color:#5b6673;margin-top:3px">' + esc(label) + '</div>'
      + '<div style="font-size:11.5px;color:#8a949f;margin-top:2px">' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</div></div>'
      + '<div style="padding:14px 17px;display:flex;gap:9px">'
      + '<button data-cy="latest" style="flex:1;border:0;background:#0B3D66;color:#fff;border-radius:9px;padding:11px;cursor:pointer;font-weight:700">Cycle 7 (latest) ↗</button>'
      + '<button data-cy="6" style="flex:1;border:1px solid #0B3D66;background:#fff;color:#0B3D66;border-radius:9px;padding:11px;cursor:pointer;font-weight:700">Cycle 6 ↗</button></div>'
      + '<div style="padding:0 17px 13px;font-size:11px;color:#8a949f">Opens PathWeb in a new tab, centred on this spot (100 m). PathWeb blocks in-app embedding.</div>'
      + '<div style="padding:10px 17px;border-top:1px solid #eef1f4;text-align:right">'
      + '<button id="rip-pw-close" style="border:0;background:#eef1f4;border-radius:8px;padding:7px 15px;cursor:pointer;font-weight:600;color:#12233b">Close</button></div>'
      + '</div>';
    document.body.appendChild(wrap);
    wrap.querySelectorAll('[data-cy]').forEach((b) => b.onclick = () => { openAt(lat, lng, b.dataset.cy); wrap.remove(); });
    document.getElementById('rip-pw-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  }

  // Open for a specific segment (uses the segment midpoint).
  function openSegment(seg, sec, cycle) {
    const c = coordOfSeg(seg) || coordOfSec(sec); if (!c) return;
    const mp = (seg && seg.BEG_MP != null) ? (' · MP ' + ((seg.BEG_MP + seg.END_MP) / 2).toFixed(2)) : '';
    if (cycle) return openAt(c[0], c[1], cycle);
    chooser(c[0], c[1], (sec && sec.route_id ? sec.route_id : '') + mp);
  }
  // Open for a route (uses a mid-route point / first segment).
  function openRoute(sec, segs, cycle) {
    let c = null;
    if (segs && segs.length) c = coordOfSeg(segs[Math.floor(segs.length / 2)]);
    if (!c) c = coordOfSec(sec);
    if (!c) return;
    if (cycle) return openAt(c[0], c[1], cycle);
    chooser(c[0], c[1], (sec && sec.route_id ? sec.route_id : '') + (sec && sec.name ? ' · ' + sec.name : ''));
  }

  window.RW2Pathweb = { spatialUrl, openAt, openSegment, openRoute, chooser, coordOfSeg, coordOfSec };
})();
