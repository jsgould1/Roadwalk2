/* =========================================================================
 * file-hub.js — the FILE module: a visual New / Open / Save hub plus
 * component import/export, so the app reads like a traditional program.
 * Renders into #mod-file and wires each card to functions that already
 * exist (donor hooks + the Roadwalk2 module panels).
 * ========================================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const RW = () => window._RW || {};
  const sections = () => (RW().SECTIONS) || [];
  let _landed = false;

  function click(id) { const el = $(id); if (el) el.click(); }
  function toast(msg, isErr) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;background:' + (isErr ? '#c0392b' : '#12233b') + ';color:#fff;padding:9px 16px;border-radius:999px;font:600 13px "IBM Plex Sans",system-ui;box-shadow:0 3px 14px rgba(0,0,0,.3);max-width:92%';
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
  }

  // ---- Open: a saved file (GeoJSON or project) OR the saved-parks library --
  const openFileInput = document.createElement('input');
  openFileInput.type = 'file'; openFileInput.accept = '.geojson,.json'; openFileInput.style.display = 'none';
  openFileInput.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await handleOpenFile(f); } catch (err) { toast('Open failed: ' + err.message, true); } } });
  (document.body || document.documentElement).appendChild(openFileInput);

  async function handleOpenFile(file) {
    let data; try { data = JSON.parse(await file.text()); } catch (_) { toast('Not a valid GeoJSON / project file', true); return; }
    const base = file.name.replace(/\.[^.]+$/, '');
    // GeoJSON export → open as a fresh project
    if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      if (sections().length && !confirm('Open “' + file.name + '”?\nThis replaces the current working project.')) return;
      if (RW().newProject) RW().newProject(base);
      let rep = null;
      if (window.RW2GeoIO && window.RW2GeoIO.importGeoJSON) rep = window.RW2GeoIO.importGeoJSON(data);
      toast('Opened ' + (rep ? (rep.added.length + rep.replaced.length) : data.features.length) + ' routes');
      render(); return;
    }
    // Project bundle or full export → restore
    const bundle = (data && data.bundle) || (data && Array.isArray(data.sections) ? data : null);
    if (bundle && Array.isArray(bundle.sections)) {
      if (sections().length && !confirm('Open “' + file.name + '”?\nThis replaces the current project.')) return;
      if (RW().loadBundle) { await RW().loadBundle(bundle, { freshImport: true }); toast('Project opened · ' + bundle.sections.length + ' routes'); }
      render(); return;
    }
    toast('Unrecognized file — expected a GeoJSON or a project export', true);
  }

  function openChooser(anchor) {
    const old = $('rw2-open-chooser'); if (old) old.remove();
    const r = anchor ? anchor.getBoundingClientRect() : { bottom: 120, left: 40 };
    const m = document.createElement('div');
    m.id = 'rw2-open-chooser';
    m.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${r.left}px;z-index:99999;background:#fff;border:1px solid #d3dae1;border-radius:10px;box-shadow:0 6px 24px rgba(20,35,60,.22);overflow:hidden;font:13px 'IBM Plex Sans',system-ui;min-width:230px`;
    m.innerHTML =
      `<button data-k="file" style="display:block;width:100%;text-align:left;padding:11px 15px;border:0;background:#fff;cursor:pointer;color:#12233b">📄 Open a file… <span style="color:#8a949f">(GeoJSON / project)</span></button>
       <button data-k="lib" style="display:block;width:100%;text-align:left;padding:11px 15px;border:0;border-top:1px solid #eef1f4;background:#fff;cursor:pointer;color:#12233b">🗂 Saved parks…</button>`;
    m.querySelector('[data-k="file"]').onclick = () => { m.remove(); openFileInput.click(); };
    m.querySelector('[data-k="lib"]').onclick = () => { m.remove(); if (window.RW2Library && window.RW2Library.showPanel) window.RW2Library.showPanel(); else if (window.showProjectPicker) window.showProjectPicker('', true); };
    document.body.appendChild(m);
    setTimeout(() => document.addEventListener('click', function _c(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', _c); } }), 0);
  }

  // ---- actions (each maps to an existing capability) --------------------
  const ACTIONS = {
    new() {
      if (sections().length && !confirm('Start a NEW project? This clears the current working routes (saved library parks are kept).')) return;
      const name = prompt('New project name:', 'Untitled Project');
      if (name === null) return;
      if (RW().newProject) RW().newProject(name.trim() || 'Untitled Project');
      render(); toast('New project started');
    },
    open() { openChooser($('fh-tile-open')); },
    save() { click('dash-export-btn'); },
    saveas() {
      const cur = RW().getProjectName ? RW().getProjectName() : 'Project';
      const name = prompt('Save project as:', cur);
      if (name === null) return;
      if (RW().setProjectName) RW().setProjectName(name.trim() || cur);
      render(); click('dash-export-btn');
    },
    importPark() {
      const anchor = $('fh-tile-importPark');
      if (window.RW2ImportChooser && anchor) window.RW2ImportChooser(anchor);
      else click('rw2-import-park');
    },
    newRoute() { click('dash-new-section-btn'); },
    scopePins() { if (window.RW2ScopePins) window.RW2ScopePins.show(); else toast('Scope Pins module not ready', true); },
    scopeData() { if (window.RW2RouteData) window.RW2RouteData.showPanel(); else toast('Scope Data module not ready', true); },
    geojson() { if (window.RW2GeoIO) window.RW2GeoIO.show(); else toast('GeoJSON module not ready', true); },
    table() { if (window.RW2SectionsTable) window.RW2SectionsTable.show(); else toast('Table module not ready', true); },
    photos() { click('dash-photo-export-btn'); },
    history() { if (window.RW2Snapshots) window.RW2Snapshots.show(); else toast('Snapshots not ready', true); },
    gotoRoutes() { if (window.showModule) window.showModule('dashboard'); },
    gotoMap() { if (window.showModule) window.showModule('map'); },
    rename() {
      const cur = RW().getProjectName ? RW().getProjectName() : 'Project';
      const name = prompt('Project name:', cur);
      if (name === null) return;
      if (RW().setProjectName) RW().setProjectName(name.trim() || cur);
      render();
    },
  };

  // ---- render -----------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function tile(act, ico, title, sub, accent) {
    return `<button class="fh-tile" id="fh-tile-${act}" data-act="${act}"
      style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;background:#fff;border:1px solid #e3e8ee;border-radius:14px;padding:14px 15px;min-height:96px;cursor:pointer;transition:box-shadow .12s,transform .05s;box-shadow:0 1px 2px rgba(16,35,60,.05)">
      <span style="font-size:26px;line-height:1;margin-bottom:4px">${ico}</span>
      <span style="font-size:15px;font-weight:700;color:#12233b">${esc(title)}</span>
      <span style="font-size:12px;color:#5b6673;line-height:1.25">${esc(sub)}</span>
      ${accent ? `<span style="position:absolute"></span>` : ''}
    </button>`;
  }
  function group(title, tilesHtml, cols) {
    return `<div style="margin-bottom:22px">
      <div style="font-size:12px;font-weight:700;color:#0B3D66;text-transform:uppercase;letter-spacing:.6px;margin:0 2px 9px">${esc(title)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(${cols || 150}px,1fr));gap:12px">${tilesHtml}</div>
    </div>`;
  }

  function render() {
    const host = $('mod-file'); if (!host) return;
    const name = (RW().getProjectName && RW().getProjectName()) || '';
    const S = sections();
    const lots = S.filter((s) => s.type === 'area').length, roads = S.length - lots;
    const inScope = S.filter((s) => s.in_scope).length;

    host.innerHTML =
      `<div style="max-width:940px;margin:0 auto;padding:22px 18px 48px;font-family:'IBM Plex Sans',system-ui,sans-serif">
         <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:22px;flex-wrap:wrap">
           <div style="min-width:0">
             <div style="font-size:12px;color:#8a949f;text-transform:uppercase;letter-spacing:.6px">Project</div>
             <div style="display:flex;align-items:center;gap:8px">
               <div id="fh-name" style="font-size:26px;font-weight:800;color:${name ? '#12233b' : '#9aa4af'};line-height:1.1;overflow:hidden;text-overflow:ellipsis">${name ? esc(name) : 'No project open'}</div>
               ${name ? '<button data-act="rename" title="Rename" style="border:0;background:transparent;cursor:pointer;font-size:16px;opacity:.55">✏️</button>' : ''}
             </div>
             <div style="font-size:13px;color:#5b6673;margin-top:3px">${name ? `${S.length} route${S.length === 1 ? '' : 's'} · ${roads} road${roads === 1 ? '' : 's'} · ${lots} lot${lots === 1 ? '' : 's'} · <b style="color:#0e7c66">${inScope}</b> in scope` : 'Start with <b>New</b> or <b>Open</b> below.'}</div>
           </div>
           <div style="display:flex;gap:8px">
             <button data-act="gotoRoutes" style="border:1px solid #d3dae1;background:#fff;border-radius:10px;padding:9px 14px;cursor:pointer;font-weight:600;color:#12233b">📊 Routes →</button>
             <button data-act="gotoMap" style="border:0;background:#1a73e8;color:#fff;border-radius:10px;padding:9px 14px;cursor:pointer;font-weight:600">🗺 Map →</button>
           </div>
         </div>

         ${group('File', [
        tile('new', '🆕', 'New', 'Blank project from scratch'),
        tile('open', '📂', 'Open', 'GeoJSON / project / saved parks'),
        tile('save', '💾', 'Save / Export', 'Download this project'),
        tile('saveas', '🏷️', 'Save As', 'Rename, then export'),
        tile('history', '🕘', 'History', 'Auto-saved snapshots · restore'),
      ].join(''))}

         ${group('Build project', [
        tile('importPark', '🗺️', 'Import Shapes', 'Shapefiles / KMZ → routes & lots'),
        tile('newRoute', '✏️', 'New Route', 'Draw a road or lot on the map'),
        tile('scopePins', '📍', 'Scope Pins', 'KMZ pins → Route IDs + in-scope'),
      ].join(''))}

         ${group('Data & components', [
        tile('scopeData', '📋', 'Scope Data', 'Field Survey XLSX in / out'),
        tile('geojson', '🌐', 'GeoJSON', 'Shapes in / out (AECOM)'),
        tile('table', '📑', 'Route Table', 'All routes · in-scope toggle'),
        tile('photos', '📷', 'Photos', 'Export field photos'),
      ].join(''))}

         <div style="font-size:11.5px;color:#8a949f;margin-top:8px">New / Open / Save behave like a desktop program. Build a project from scratch: <b>New</b> → <b>Import Shapes</b> or <b>New Route</b> → add data on the map → <b>Save</b>.</div>
       </div>`;

    host.querySelectorAll('[data-act]').forEach((b) => {
      const fn = ACTIONS[b.getAttribute('data-act')];
      if (fn) b.onclick = fn;
      if (b.classList.contains('fh-tile')) {
        b.style.position = 'relative';
        b.onmouseenter = () => { b.style.boxShadow = '0 4px 16px rgba(16,35,60,.14)'; b.style.borderColor = '#b7cdec'; };
        b.onmouseleave = () => { b.style.boxShadow = '0 1px 2px rgba(16,35,60,.05)'; b.style.borderColor = '#e3e8ee'; };
      }
    });
  }

  // Re-render whenever the File tab is opened; land on File once at startup.
  document.getElementById('app-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.app-tab[data-module="file"]');
    if (tab) setTimeout(render, 0);
  });
  function boot() {
    render();
    if (!_landed) { _landed = true; if (window.showModule) window.showModule('file'); }
  }
  setTimeout(boot, 700);

  window.RW2FileHub = { render, show: () => { if (window.showModule) window.showModule('file'); render(); } };
})();
