/* =========================================================================
 * library.js — Roadwalk2 Project → Sections library
 *
 * Terminology (generic, not park-specific):
 *   PROJECT  the job (implicit single project for now)
 *   SECTION  a facility (a park) — opened ONE AT A TIME (memory-safe)
 *   ROUTE    a road or parking lot inside a section (the donor's "section")
 *
 * Each imported SECTION's pristine geometry (the bundle = NPS original) is
 * stored here; its edits (AECOM working copy) live in the donor's 'safety'
 * store keyed rw_sections_<id>. Opening a section preserves those edits;
 * a fresh import starts clean. Only one section is live at a time.
 * ========================================================================= */
(function () {
  'use strict';

  const DB = 'roadwalk2_lib', STORE = 'sections';
  let activeUnit = null;

  // ---- IndexedDB (Roadwalk2's own library DB) ----------------------------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'unit' });
      };
      r.onsuccess = (e) => res(e.target.result);
      r.onerror = (e) => rej(e.target.error);
    });
  }
  async function _put(rec) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = (e) => rej(e.target.error); }); }
  async function _all() { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(); r.onsuccess = (e) => res(e.target.result || []); r.onerror = (e) => rej(e.target.error); }); }
  async function _get(u) { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(u); r.onsuccess = (e) => res(e.target.result || null); r.onerror = (e) => rej(e.target.error); }); }
  async function _del(u) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(u); t.oncomplete = res; t.onerror = (e) => rej(e.target.error); }); }

  const unitOf = (b) => (b._rw2_park && b._rw2_park.unit) || b.short_name || b.id;
  function counts(b) { const s = b.sections || []; return { routes: s.length, roads: s.filter(x => x.type === 'linear').length, lots: s.filter(x => x.type === 'area').length }; }

  // ---- library operations ------------------------------------------------
  async function save(bundle, opts) {
    opts = opts || {};
    const unit = unitOf(bundle);
    const existing = await _get(unit);
    let toStore = bundle;
    // MERGE into an existing section (union routes by id, new wins) so importing
    // a park's roads after its parking ADDS the roads instead of replacing them.
    // Ids don't collide across layers (parking = <U>-PK-###, roads = <U>-RD-###).
    if (existing && existing.bundle && Array.isArray(existing.bundle.sections)) {
      const byId = {};
      existing.bundle.sections.forEach((s) => { byId[s.id] = s; });
      (bundle.sections || []).forEach((s) => { byId[s.id] = s; });
      toStore = Object.assign({}, existing.bundle, bundle, { sections: Object.values(byId) });
    }
    await _put({ unit, name: toStore.name, bundle: toStore, counts: counts(toStore), savedAt: Date.now() });
    // Clear a stale working copy only on a park's FIRST import — not when merging
    // a new layer into an existing park (that would wipe its edits).
    if (opts.fresh && !existing && window.RWIdb) {
      try {
        const db = await window.RWIdb.openDB();
        if (db.objectStoreNames.contains('safety')) {
          const id = bundle.id || ('park_' + unitOf(bundle));
          await new Promise((res) => { const t = db.transaction('safety', 'readwrite'); t.objectStore('safety').delete('rw_sections_' + id); t.oncomplete = res; t.onerror = res; });
        }
      } catch (_) {}
    }
  }

  // called by the importer: persist + open fresh
  async function saveAndOpen(bundle) {
    await save(bundle);
    await window._RW.loadBundle(bundle, { freshImport: true });
    activeUnit = unitOf(bundle);
    renderPanel();
    goToList();
  }

  // open a saved section — preserves its AECOM edits (working copy)
  async function open(unit) {
    const rec = await _get(unit);
    if (!rec) { toast('Section not found', true); return; }
    await window._RW.loadBundle(rec.bundle, { /* preserve edits */ });
    activeUnit = unit;
    renderPanel();
    goToList();
    toast(`Opened ${rec.name || unit}`);
  }

  async function remove(unit) {
    const rec = await _get(unit);
    if (!confirm(`Remove section “${(rec && rec.name) || unit}” and its edits from this device?`)) return;
    await _del(unit);
    // also drop its working copy (AECOM edits)
    if (window.RWIdb) {
      try {
        const db = await window.RWIdb.openDB();
        if (db.objectStoreNames.contains('safety')) {
          const id = (rec && rec.bundle && rec.bundle.id) || ('park_' + unit);
          await new Promise((res) => { const t = db.transaction('safety', 'readwrite'); t.objectStore('safety').delete('rw_sections_' + id); t.oncomplete = res; t.onerror = res; });
        }
      } catch (_) {}
    }
    if (activeUnit === unit) activeUnit = null;
    renderPanel();
  }

  function goToList() {
    const tab = document.querySelector('[data-module="project"]') || document.querySelector('[data-module="dashboard"]');
    if (tab) tab.click();
  }

  // ---- panel UI ----------------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-lib');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-lib';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:460px;width:92%;max-height:80vh;overflow:auto;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between">
           <b style="font-weight:600;letter-spacing:.3px">Project — Sections</b>
           <span id="rw2-lib-x" style="cursor:pointer;font-size:20px;line-height:1">×</span>
         </div>
         <div id="rw2-lib-body" style="padding:12px 14px"></div>
         <div style="padding:10px 14px;border-top:1px solid #e3e8ee">
           <button id="rw2-lib-import" style="width:100%;padding:10px;border:1px dashed #b7cdec;background:#f6f8fa;border-radius:9px;cursor:pointer;color:#12233b;font-weight:600">+ Import a section (SHP / KMZ / zip)</button>
         </div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hidePanel(); });
    ov.querySelector('#rw2-lib-x').onclick = hidePanel;
    ov.querySelector('#rw2-lib-import').onclick = (e) => {
      hidePanel();
      const b = document.getElementById('rw2-lib-import');
      if (window.RW2ImportChooser) window.RW2ImportChooser(b);
      else { const p = document.getElementById('rw2-import-park'); if (p) p.click(); }
    };
    return ov;
  }
  function hidePanel() { const ov = document.getElementById('rw2-lib'); if (ov) ov.style.display = 'none'; }
  async function showPanel() { ensurePanel(); await renderPanel(); document.getElementById('rw2-lib').style.display = 'flex'; }

  async function renderPanel() {
    const ov = document.getElementById('rw2-lib'); if (!ov) return;
    const body = ov.querySelector('#rw2-lib-body');
    const items = (await _all()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!items.length) {
      body.innerHTML = '<div style="color:#5b6673;font-size:14px;padding:8px 2px">No sections yet. Import one to get started.</div>';
      return;
    }
    body.innerHTML = '';
    for (const it of items) {
      const active = it.unit === activeUnit;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #eef1f4';
      row.innerHTML =
        `<div style="flex:1;min-width:0">
           <div style="font-weight:600;color:#12233b">${it.unit}${active ? ' <span style="color:#1a73e8;font-size:11px;font-weight:600">● OPEN</span>' : ''}</div>
           <div style="font-size:12px;color:#5b6673;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.name || ''}</div>
           <div style="font-size:11px;color:#8a949f">${it.counts.roads} road${it.counts.roads === 1 ? '' : 's'} · ${it.counts.lots} lot${it.counts.lots === 1 ? '' : 's'}</div>
         </div>
         <button class="rw2-open" style="padding:7px 12px;border:0;border-radius:8px;cursor:pointer;font-weight:600;${active ? 'background:#e3e8ee;color:#5b6673' : 'background:#1a73e8;color:#fff'}">${active ? 'Open' : 'Open'}</button>
         <button class="rw2-del" title="Remove" style="border:0;background:transparent;cursor:pointer;opacity:.5;font-size:15px">🗑</button>`;
      row.querySelector('.rw2-open').onclick = async () => { hidePanel(); await open(it.unit); };
      row.querySelector('.rw2-del').onclick = () => remove(it.unit);
      body.appendChild(row);
    }
  }

  // ---- toast (local) -----------------------------------------------------
  let tT = null;
  function toast(msg, isErr) {
    let t = document.getElementById('rw2-toast');
    if (!t) { t = document.createElement('div'); t.id = 'rw2-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;font:13px/1.4 "IBM Plex Sans",system-ui,sans-serif;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.28)'; document.body.appendChild(t); }
    t.style.background = isErr ? '#c5372c' : '#12233b'; t.textContent = msg; t.style.opacity = '1';
    clearTimeout(tT); tT = setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 3200);
  }

  // ---- SECTIONS button (self-mounting next to IMPORT PARK) ---------------
  function mount() {
    if (document.getElementById('rw2-sections-btn')) return;
    const anchor = document.getElementById('rw2-import-park') ||
      Array.from(document.querySelectorAll('button')).find(b => /IMPORT PROJECT/i.test((b.textContent || '').trim()));
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.id = 'rw2-sections-btn';
    btn.className = anchor.className;
    btn.textContent = 'SECTIONS';
    btn.addEventListener('click', showPanel);
    anchor.insertAdjacentElement('afterend', btn);
  }
  setInterval(mount, 1200);
  setTimeout(mount, 500);

  window.RW2Library = { save, saveAndOpen, open, remove, all: _all, get: _get, getActive: () => activeUnit, showPanel };
})();
