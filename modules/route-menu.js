/* =========================================================================
 * route-menu.js — Route (section) action popup.
 *
 * Tapping the ACTIVE route on the map opens a context popup mirroring the
 * feature popup, with: Edit Data, Edit Shape, Move, Flip STA (roads), Assign
 * ID, Merge (roads), Delete. Move + Merge are two-step "tap on the map" modes;
 * everything else is wired to donor hooks on window._RW.
 *
 * Reuses the donor's .feature-popup / .fp-* CSS so it matches the feature popup.
 * ========================================================================= */
(function () {
  'use strict';

  const RW = () => window._RW || {};
  let _sec = null;                 // section the popup currently targets
  let _mode = null;                // null | 'move' | 'merge'
  let _target = null;              // section a mode is operating on

  const isRoad = (s) => s && s.type === 'linear';
  const map = () => (RW().getMap ? RW().getMap() : null);

  // ---- build the popup element (once) -----------------------------------
  function ensure() {
    let p = document.getElementById('rw2-route-popup');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'rw2-route-popup';
    p.className = 'feature-popup';            // inherit the feature-popup look
    p.innerHTML =
      `<div class="fp-head">
         <span class="fp-chip" id="rrp-chip">RT</span>
         <span class="fp-name" id="rrp-name">Route</span>
         <button id="rrp-close" type="button" title="Close">✕</button>
       </div>
       <div class="fp-actions" id="rrp-actions">
         <button class="fp-btn" data-act="data"><span class="fp-ico">✎</span><span class="fp-lbl">Edit Data</span></button>
         <button class="fp-btn" data-act="shape"><span class="fp-ico">⬡</span><span class="fp-lbl">Edit Shape</span></button>
         <button class="fp-btn" data-act="assign"><span class="fp-ico">🎯</span><span class="fp-lbl">Assign ID</span></button>
         <button class="fp-btn" data-act="flip" id="rrp-flip"><span class="fp-ico">⇄</span><span class="fp-lbl">Flip STA</span></button>
         <button class="fp-btn" data-act="move"><span class="fp-ico">⊹</span><span class="fp-lbl">Move</span></button>
         <button class="fp-btn" data-act="merge" id="rrp-merge"><span class="fp-ico">⛓</span><span class="fp-lbl">Merge</span></button>
         <button class="fp-btn fp-danger fp-span" data-act="del"><span class="fp-ico">✕</span><span class="fp-lbl">Delete</span></button>
       </div>
       <div class="fp-actions" id="rrp-assign" style="display:none;max-height:46vh;overflow:auto;grid-template-columns:1fr"></div>
       <div class="fp-confirm" id="rrp-confirm">
         <div class="fp-confirm-msg" id="rrp-confirm-msg">Delete this route?</div>
         <div class="fp-confirm-btns">
           <button id="rrp-yes" type="button">Delete</button>
           <button id="rrp-no" type="button">Cancel</button>
         </div>
       </div>`;
    document.body.appendChild(p);

    p.querySelector('#rrp-close').onclick = close;
    p.querySelectorAll('#rrp-actions [data-act]').forEach((b) => {
      b.onclick = () => onAction(b.getAttribute('data-act'));
    });
    p.querySelector('#rrp-no').onclick = () => p.querySelector('#rrp-confirm').classList.remove('fp-conf-visible');
    p.querySelector('#rrp-yes').onclick = doDelete;

    // Click outside → dismiss (mirrors the feature popup).
    document.addEventListener('pointerdown', (e) => {
      if (p.classList.contains('fp-visible') && !p.contains(e.target)) close();
    }, true);
    return p;
  }

  // ---- open / close ------------------------------------------------------
  function open(sec, e) {
    if (!sec) return;
    _sec = sec;
    const p = ensure();
    const road = isRoad(sec);
    p.querySelector('#rrp-chip').textContent = road ? 'RD' : 'PK';
    p.querySelector('#rrp-chip').style.background = road ? '#C85A2B' : '#0B3D66';
    const rid = sec.route_id ? ' · ' + sec.route_id : '';
    p.querySelector('#rrp-name').textContent = (sec.name || sec.id) + rid;
    // Flip STA + Merge are road-only.
    p.querySelector('#rrp-flip').style.display = road ? '' : 'none';
    p.querySelector('#rrp-merge').style.display = road ? '' : 'none';
    p.querySelector('#rrp-confirm').classList.remove('fp-conf-visible');
    p.querySelector('#rrp-assign').style.display = 'none';
    p.querySelector('#rrp-actions').style.display = '';
    p.classList.add('fp-visible');
    position(p, e);
  }

  function position(p, e) {
    const raw = e && (e.originalEvent || e);
    const px = raw && raw.clientX != null ? raw.clientX : window.innerWidth / 2;
    const py = raw && raw.clientY != null ? raw.clientY : window.innerHeight / 2;
    p.style.left = Math.max(8, px + 4) + 'px';
    p.style.top = Math.max(8, py + 4) + 'px';
    const place = () => {
      const r = p.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = r.width || 244, ph = Math.min(r.height || 240, vh - 16);
      p.style.left = Math.max(8, Math.min(px + 4, vw - pw - 8)) + 'px';
      p.style.top = Math.max(8, Math.min(py + 4, vh - ph - 8)) + 'px';
    };
    place();
    requestAnimationFrame(place);
  }

  function close() {
    const p = document.getElementById('rw2-route-popup');
    if (p) p.classList.remove('fp-visible');
    _sec = null;
  }

  // ---- actions -----------------------------------------------------------
  function onAction(act) {
    const sec = _sec;
    if (!sec) return;
    if (act === 'data')   { close(); if (RW().editSectionData) RW().editSectionData(sec.id); return; }
    if (act === 'shape')  { close(); if (RW().startSectionShapeEdit) RW().startSectionShapeEdit(sec.id); return; }
    if (act === 'flip')   { close(); if (RW().flipActiveStationing) { RW().flipActiveStationing(); toast('Stationing flipped'); } return; }
    if (act === 'assign') { showAssign(sec); return; }
    if (act === 'move')   { startMove(sec); return; }
    if (act === 'merge')  { startMerge(sec); return; }
    if (act === 'del')    { document.getElementById('rrp-confirm').classList.add('fp-conf-visible'); return; }
  }

  function doDelete() {
    const sec = _sec; close();
    if (sec && RW().deleteSection) { RW().deleteSection(sec.id); toast('Route deleted'); }
  }

  // ---- Assign ID (sub-picker) -------------------------------------------
  function showAssign(sec) {
    const S = window.RW2Scope;
    const box = document.getElementById('rrp-assign');
    const acts = document.getElementById('rrp-actions');
    const unit = S && S.activeUnit ? S.activeUnit() : null;
    const list = (S && S.scopeList && unit) ? S.scopeList(unit) : [];
    let html = '';
    if (!list.length) {
      html = `<div style="font-size:11px;color:var(--ink-3,#888);padding:4px 2px">No in-scope route list for this park (RIP-only).</div>`;
    } else {
      html = list.map((r) => `
        <button class="fp-btn" data-rid="${r.rid}" style="flex-direction:row;justify-content:flex-start;gap:8px;min-height:34px;${r.assigned ? 'opacity:.5' : ''}">
          <span style="font-family:'IBM Plex Mono',monospace;font-weight:700">${r.rid}</span>
          <span style="font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.route_name || ''}</span>
          ${r.assigned ? '<span style="margin-left:auto;font-size:9px">assigned</span>' : ''}
        </button>`).join('');
    }
    html += `<div style="display:flex;gap:6px;margin-top:4px">
        <button class="fp-btn" id="rrp-assign-clear" style="min-height:32px;flex:1">Clear ID</button>
        <button class="fp-btn" id="rrp-assign-back" style="min-height:32px;flex:1">← Back</button>
      </div>`;
    box.innerHTML = html;
    box.querySelectorAll('[data-rid]').forEach((b) => {
      b.onclick = () => {
        if (window.RW2Scope && window.RW2Scope.assignId) window.RW2Scope.assignId(sec, b.getAttribute('data-rid'));
        close(); toast('Assigned ' + b.getAttribute('data-rid'));
      };
    });
    box.querySelector('#rrp-assign-clear').onclick = () => {
      if (window.RW2Scope && window.RW2Scope.clearId) window.RW2Scope.clearId(sec);
      close(); toast('Route ID cleared');
    };
    box.querySelector('#rrp-assign-back').onclick = () => { box.style.display = 'none'; acts.style.display = ''; };
    acts.style.display = 'none';
    box.style.display = 'grid';
  }

  // ---- Move mode (tap a destination) ------------------------------------
  function centroid(a) { let x = 0, y = 0; a.forEach((p) => { x += p[0]; y += p[1]; }); return [x / a.length, y / a.length]; }

  function startMove(sec) {
    close();
    _mode = 'move'; _target = sec;
    banner(`Tap where “${sec.name || sec.id}” should move to`, 'move');
    const m = map();
    if (m) m.once('click', onMapDest);
  }
  function onMapDest(e) { if (_mode === 'move' && e && e.latlng) finishMove(e.latlng); }
  function finishMove(latlng) {
    const sec = _target; endMode();
    if (!sec || !Array.isArray(sec.alignment)) return;
    const c = centroid(sec.alignment);
    if (RW().moveSection) RW().moveSection(sec.id, latlng.lat - c[0], latlng.lng - c[1]);
    toast('Route moved');
  }

  // ---- Merge mode (tap the partner segment) -----------------------------
  function startMerge(sec) {
    close();
    _mode = 'merge'; _target = sec;
    banner(`Tap the road segment to merge into “${sec.name || sec.id}”`, 'merge');
  }
  function finishMerge(partner) {
    const keep = _target;
    if (!partner || !keep || partner.id === keep.id) return;      // stay in mode
    if (!isRoad(partner)) { toast('Merge joins roads only', true); return; }
    endMode();
    const r = RW().chainSections ? RW().chainSections(keep.id, partner.id) : { ok: false };
    toast(r && r.ok ? 'Routes merged' : 'Merge failed', !(r && r.ok));
  }

  // handleSectionTap: called by the donor's section click handlers. Returns
  // true when a move/merge mode consumes the tap (so it doesn't switch/open).
  function handleSectionTap(sec, e) {
    if (_mode === 'merge') { finishMerge(sec); return true; }
    if (_mode === 'move')  { if (e && e.latlng) finishMove(e.latlng); return true; }
    return false;
  }
  function modeActive() { return !!_mode; }

  function endMode() {
    _mode = null; _target = null;
    hideBanner();
    const m = map(); if (m) m.off('click', onMapDest);
  }

  // ---- banner + toast ----------------------------------------------------
  function banner(text, kind) {
    hideBanner();
    const b = document.createElement('div');
    b.id = 'rw2-route-banner';
    b.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99997;background:' + (kind === 'merge' ? '#7B3F9E' : '#0B3D66') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;max-width:92%';
    b.innerHTML = `📍 ${text} <button id="rw2-route-cancel" style="border:0;background:rgba(255,255,255,.25);color:#fff;border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit">Cancel</button>`;
    document.body.appendChild(b);
    b.querySelector('#rw2-route-cancel').onclick = endMode;
  }
  function hideBanner() { const b = document.getElementById('rw2-route-banner'); if (b) b.remove(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (_mode) endMode(); else close(); } });

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  window.RW2RouteMenu = { open, close, handleSectionTap, modeActive };
})();
