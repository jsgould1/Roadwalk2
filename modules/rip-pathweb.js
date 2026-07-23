/* =========================================================================
 * rip-pathweb.js — deep-link a RIP route + milepost into NPS PathWeb.
 *
 * PathWeb addresses imagery as:
 *     https://pathweb.pathwayservices.com/rip/sections/{SECTION_ID}/locations/{N}
 * where N is the frame index from the route start. For Cycle 6 the frames are
 * a clean 0.005 mi (26.4 ft) apart, so N = round(milepost * 200) — verified
 * against ABLI-0011 (loc 0 = mi 0.000, loc 35 = mi 0.175). Cycle 7 is a
 * separate collection with its own slightly different mileposting.
 *
 * The SECTION_ID is PathWeb-internal, differs per cycle, and is NOT in the RIP
 * geodatabase, so it can't be computed. Instead the app LEARNS it: seeded with
 * what we know, and every route remembers its id the first time you paste it
 * (from PathWeb's address bar), after which the jump is one click. Until then
 * the button hands you the exact Park / Route / Mile for Find Road Section.
 * ========================================================================= */
(function () {
  'use strict';

  const BASE = 'https://pathweb.pathwayservices.com/rip';
  const FRAMES_PER_MILE = { c6: 200, c7: 211 };   // c6 exact; c7 ~0.166mi/35
  const LS_KEY = 'rw2_pathweb_sections';

  // route ident -> { c6: sectionId, c7: sectionId }
  let SECTIONS = { 'ABLI-0011': { c6: 6621, c7: 14174 } };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    for (const k in saved) SECTIONS[k] = Object.assign({}, SECTIONS[k], saved[k]);
  } catch (_) {}
  // optional bulk map shipped with the app (route -> {c6,c7}); merged under
  // anything the user has taught locally so their edits always win.
  fetch('data/rip/pathweb_sections.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((bulk) => { if (bulk) for (const k in bulk) SECTIONS[k] = Object.assign({}, bulk[k], SECTIONS[k]); })
    .catch(() => {});

  function persist() {
    // only store what the user taught (diff from the seed is hard to track, so
    // store everything except the single hard-coded seed we can always re-add)
    const out = {};
    for (const k in SECTIONS) out[k] = SECTIONS[k];
    try { localStorage.setItem(LS_KEY, JSON.stringify(out)); } catch (_) {}
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- model ------------------------------------------------------------
  function ripOf(sec) { return (sec && sec.rip) || {}; }
  function info(sec, mile) {
    const rip = ripOf(sec);
    const routeId = sec.route_id || rip.ROUTE_IDENT || '';
    const park = routeId.includes('-') ? routeId.split('-')[0] : (rip.PARK_ALPHA || '');
    const routeNo = rip.RTE_NO || (routeId.includes('-') ? routeId.split('-')[1] : routeId);
    const routeBeg = rip.BEG_MP_DCV != null ? rip.BEG_MP_DCV : 0;
    return {
      routeId, park, routeNo, name: sec.name || rip.RTE_NAME || '',
      fmss: rip.FMSS_NO || sec.faclocid || '',
      mile: mile == null ? 0 : mile,
      routeBeg,
    };
  }
  function locationFor(mile, routeBeg, cycle) {
    const f = FRAMES_PER_MILE[cycle] || 200;
    return Math.max(0, Math.round(((mile || 0) - (routeBeg || 0)) * f));
  }
  function sectionId(routeId, cycle) { return (SECTIONS[routeId] || {})[cycle] || null; }
  function urlFor(routeId, mile, routeBeg, cycle) {
    const id = sectionId(routeId, cycle);
    if (!id) return null;
    return BASE + '/sections/' + id + '/locations/' + locationFor(mile, routeBeg, cycle);
  }
  function learn(routeId, cycle, id) {
    id = parseInt(id, 10);
    if (!routeId || !id) return false;
    SECTIONS[routeId] = Object.assign({}, SECTIONS[routeId]); SECTIONS[routeId][cycle] = id;
    persist(); return true;
  }
  // Pull "sections/6621/..." out of a pasted PathWeb URL.
  function idFromUrl(u) { const m = String(u).match(/sections\/(\d+)/); return m ? parseInt(m[1], 10) : null; }

  // ---- open -------------------------------------------------------------
  // If the route's section id is known → open the exact frame. Otherwise show
  // a helper: the Find-Road-Section values + a field to paste the id once.
  function open(sec, mile, cycle) {
    cycle = cycle || 'c6';
    const nfo = info(sec, mile);
    const url = urlFor(nfo.routeId, nfo.mile, nfo.routeBeg, cycle);
    if (url) { window.open(url, '_blank', 'noopener'); return; }
    helper(sec, nfo, cycle);
  }

  function helper(sec, nfo, cycle) {
    const old = document.getElementById('rip-pw-modal'); if (old) old.remove();
    const cycLabel = cycle === 'c7' ? 'Cycle 7' : 'Cycle 6';
    const loc = locationFor(nfo.mile, nfo.routeBeg, cycle);
    const wrap = document.createElement('div');
    wrap.id = 'rip-pw-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(12,22,38,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:13px;max-width:430px;width:100%;box-shadow:0 18px 50px rgba(10,20,40,.35);overflow:hidden">'
      + '<div style="padding:15px 17px 11px;border-bottom:1px solid #eef1f4">'
      + '<div style="font-size:16px;font-weight:800;color:#12233b">Open in PathWeb — ' + cycLabel + '</div>'
      + '<div style="font-size:12.5px;color:#8a949f;margin-top:2px">This route has no saved PathWeb id yet. Use Find Road Section with the values below, then paste the address once to make it one-click next time.</div></div>'
      + '<div style="padding:13px 17px">'
      + '<table style="width:100%;border-collapse:collapse;font:13px system-ui">'
      + [['Park', nfo.park], ['Route', esc(nfo.routeNo) + ' — ' + esc(nfo.name)], ['FMSS #', nfo.fmss],
         ['Mile', nfo.mile.toFixed(3)], ['Frame', String(loc) + ' (' + cycLabel + ')']]
        .map(([k, v]) => '<tr><td style="padding:3px 10px 3px 0;color:#8a949f;white-space:nowrap;vertical-align:top">' + k
          + '</td><td style="padding:3px 0;color:#12233b;font-weight:600">' + esc(v) + '</td></tr>').join('')
      + '</table>'
      + '<div style="display:flex;gap:8px;margin-top:13px">'
      + '<button id="rip-pw-open" style="flex:1;border:0;background:#1a73e8;color:#fff;border-radius:9px;padding:9px;cursor:pointer;font-weight:700">Open PathWeb ↗</button>'
      + '<button id="rip-pw-copy" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:9px 13px;cursor:pointer;font-weight:600;color:#12233b">Copy Route + Mile</button></div>'
      + '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #eef1f4">'
      + '<div style="font-size:12px;font-weight:700;color:#0B3D66;margin-bottom:5px">Teach this route its PathWeb id</div>'
      + '<div style="font-size:11.5px;color:#5b6673;margin-bottom:7px">After you land on this route in PathWeb, paste its address bar here — I read the section id from it.</div>'
      + '<div style="display:flex;gap:7px">'
      + '<input id="rip-pw-url" placeholder=".../sections/6621/locations/…  or just 6621" style="flex:1;border:1px solid #d3dae1;border-radius:8px;padding:7px 9px;font:12.5px system-ui">'
      + '<button id="rip-pw-save" style="border:0;background:#0e7c66;color:#fff;border-radius:8px;padding:7px 13px;cursor:pointer;font-weight:700">Save</button></div>'
      + '<div id="rip-pw-msg" style="font-size:11.5px;color:#8a949f;margin-top:6px"></div>'
      + '</div></div>'
      + '<div style="padding:10px 17px;border-top:1px solid #eef1f4;text-align:right">'
      + '<button id="rip-pw-close" style="border:0;background:#eef1f4;border-radius:8px;padding:7px 15px;cursor:pointer;font-weight:600;color:#12233b">Close</button></div>'
      + '</div>';
    document.body.appendChild(wrap);
    const $ = (id) => document.getElementById(id);
    $('rip-pw-open').onclick = () => window.open(BASE + '/', '_blank', 'noopener');
    $('rip-pw-copy').onclick = () => {
      const text = nfo.park + ' · Route ' + nfo.routeNo + ' · Mile ' + nfo.mile.toFixed(3);
      try { navigator.clipboard.writeText(text); $('rip-pw-msg').textContent = 'Copied: ' + text; } catch (_) {}
    };
    $('rip-pw-save').onclick = () => {
      const raw = $('rip-pw-url').value.trim();
      const id = idFromUrl(raw) || parseInt(raw, 10);
      if (!id) { $('rip-pw-msg').textContent = 'Could not read a section id from that.'; return; }
      learn(nfo.routeId, cycle, id);
      $('rip-pw-msg').style.color = '#0e7c66';
      $('rip-pw-msg').textContent = 'Saved id ' + id + ' for ' + nfo.routeId + ' (' + cycLabel + '). Opening…';
      setTimeout(() => { wrap.remove(); open(sec, nfo.mile, cycle); }, 700);
    };
    $('rip-pw-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  }

  // does this route have a saved id for the cycle? (drives button styling)
  function has(routeId, cycle) { return !!sectionId(routeId, cycle || 'c6'); }

  window.RW2Pathweb = { open, urlFor, info, locationFor, sectionId, learn, has, idFromUrl,
    sections: () => SECTIONS };
})();
