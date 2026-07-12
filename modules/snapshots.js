/* =========================================================================
 * snapshots.js — versioned project backups you can roll back to.
 * Every few minutes (and on demand) a snapshot of the whole project (bundle
 * rebuilt from the live routes) is stored in IndexedDB; the last MAX are kept.
 * Restore replaces the current working state with that snapshot.
 * ========================================================================= */
(function () {
  'use strict';
  const DB = 'roadwalk2_snapshots', STORE = 'snaps', MAX = 20, INTERVAL_MS = 180000; // 3 min
  const RW = () => window._RW || {};
  const sections = () => RW().SECTIONS || [];
  let _lastSig = '';

  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = (e) => res(e.target.result); r.onerror = (e) => rej(e.target.error);
    });
  }
  async function put(rec) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = (e) => rej(e.target.error); }); }
  async function all() { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(); r.onsuccess = (e) => res(e.target.result || []); r.onerror = (e) => rej(e.target.error); }); }
  async function del(id) { const db = await idb(); return new Promise((res) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(id); t.oncomplete = res; t.onerror = res; }); }

  // A cheap signature to detect whether anything meaningful changed.
  function sig() {
    const S = sections();
    const name = RW().getProjectName ? RW().getProjectName() : '';
    return name + '|' + S.length + '|' + S.reduce((n, s) =>
      n + (s.alignment || []).length + (s.holes || []).reduce((a, h) => a + h.length, 0) + (s.pins || []).length + (s.route_id ? 3 : 0) + (s.in_scope ? 1 : 0), 0);
  }

  async function snap(manual) {
    const name = RW().getProjectName ? RW().getProjectName() : '';
    const S = sections();
    if ((!name && !S.length) || !RW().bundleFromSections) { if (manual) toast('Nothing to snapshot yet', true); return; }
    await put({ id: 'snap_' + Date.now() + '_' + Math.floor(performance.now()), ts: new Date().toISOString(), name, routes: S.length, manual: !!manual, bundle: RW().bundleFromSections() });
    const list = (await all()).sort((a, b) => b.ts.localeCompare(a.ts));
    for (const old of list.slice(MAX)) await del(old.id);
    _lastSig = sig();
    if (manual) toast('Snapshot saved');
    renderPanel();
  }
  async function maybeSnap() { if (!sections().length) return; const s = sig(); if (s !== _lastSig) await snap(false); }

  async function restore(id) {
    const rec = (await all()).find((r) => r.id === id); if (!rec) return;
    if (!confirm('Restore the snapshot from ' + new Date(rec.ts).toLocaleString() + '?\nThe current working project will be replaced.')) return;
    // stash the pre-restore state first so a wrong restore is itself undoable
    try { await snap(false); } catch (_) {}
    if (RW().loadBundle) { try { await RW().loadBundle(rec.bundle, { freshImport: true }); } catch (e) { toast('Restore failed: ' + e.message, true); return; } }
    if (RW().persistSections) RW().persistSections();
    _lastSig = sig();
    toast('Restored ' + rec.routes + ' route' + (rec.routes === 1 ? '' : 's'));
    if (window.RW2FileHub) window.RW2FileHub.render();
    renderPanel();
  }

  // ---- panel -------------------------------------------------------------
  function ensurePanel() {
    let ov = document.getElementById('rw2-snaps');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'rw2-snaps';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(10,20,35,.45);display:none;align-items:center;justify-content:center;font-family:"IBM Plex Sans",system-ui,sans-serif';
    ov.innerHTML =
      `<div style="background:#fff;border-radius:12px;max-width:520px;width:94%;max-height:84vh;display:flex;flex-direction:column;box-shadow:0 12px 44px rgba(0,0,0,.3)">
         <div style="background:#12233b;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center"><b>Snapshots — project history</b><span id="rw2-snaps-x" style="cursor:pointer;font-size:20px">×</span></div>
         <div id="rw2-snaps-body" style="padding:12px 14px;overflow:auto"></div>
         <div style="padding:10px 14px;border-top:1px solid #e3e8ee"><button id="rw2-snaps-now" style="width:100%;padding:10px;border:0;border-radius:9px;cursor:pointer;font-weight:600;background:#0e7c66;color:#fff">📸 Snapshot now</button></div>
       </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) hide(); });
    ov.querySelector('#rw2-snaps-x').onclick = hide;
    ov.querySelector('#rw2-snaps-now').onclick = () => snap(true);
    return ov;
  }
  function hide() { const ov = document.getElementById('rw2-snaps'); if (ov) ov.style.display = 'none'; }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function renderPanel() {
    const ov = document.getElementById('rw2-snaps'); if (!ov || ov.style.display === 'none') return;
    const body = ov.querySelector('#rw2-snaps-body');
    const list = (await all()).sort((a, b) => b.ts.localeCompare(a.ts));
    if (!list.length) { body.innerHTML = '<div style="color:#5b6673;font-size:14px;padding:6px 2px">No snapshots yet. One is taken automatically every few minutes while you work, or tap “Snapshot now”.</div>'; return; }
    body.innerHTML = list.map((r) => `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid #eef1f4">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:#12233b;font-weight:600">${esc(r.name || '(untitled)')}</div>
          <div style="font-size:11.5px;color:#8a949f">${new Date(r.ts).toLocaleString()} · ${r.routes} route${r.routes === 1 ? '' : 's'}${r.manual ? ' · manual' : ''}</div>
        </div>
        <button data-restore="${r.id}" style="border:0;background:#1a73e8;color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;font-weight:600;font-size:12.5px">Restore</button>
        <button data-del="${r.id}" title="Delete" style="border:0;background:transparent;cursor:pointer;opacity:.5;font-size:15px">🗑</button>
      </div>`).join('');
    body.querySelectorAll('[data-restore]').forEach((b) => b.onclick = () => restore(b.getAttribute('data-restore')));
    body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await del(b.getAttribute('data-del')); renderPanel(); });
  }
  function show() { ensurePanel(); document.getElementById('rw2-snaps').style.display = 'flex'; renderPanel(); }

  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }

  setInterval(maybeSnap, INTERVAL_MS);
  window.RW2Snapshots = { snap, restore, show, list: all };
})();
