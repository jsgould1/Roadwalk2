/* ============================================================================
   RoadWalk 2 — PHOTOS DASHBOARD  (top-nav "Photos" page)
   ----------------------------------------------------------------------------
   A management hub for field photos: import (folder / split / files), photo
   sets + RAM on/off/delete, auto-tag, and links to browse (RIP Photos tab) and
   print (photo report). The photo-sets UI renders into this page's #pd-sets-host
   (so it no longer clutters the map's Field Photos panel). The map panel keeps
   just quick upload + marker toggle + view-by-route (jump to section).
   ========================================================================== */
(function () {
  'use strict';
  function geo() { return window._RW && window._RW.geophotos; }
  function $(id) { return document.getElementById(id); }
  var _built = false;

  function card(title, body) {
    return '<div style="background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:14px 16px;margin-top:14px">'
      + (title ? '<div style="font:700 13px system-ui;color:#0B3D66;margin-bottom:10px;letter-spacing:.3px">' + title + '</div>' : '')
      + body + '</div>';
  }
  function btn(id, label) { return '<button id="' + id + '" style="border:1px solid #d3dae1;background:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font:600 13px system-ui;color:#12233b">' + label + '</button>'; }
  function btnGo(id, label) { return '<button id="' + id + '" style="border:0;background:#C85A2B;color:#fff;border-radius:9px;padding:8px 13px;cursor:pointer;font:700 13px system-ui">' + label + '</button>'; }

  function dashHtml() {
    return '<div style="max-width:1080px;margin:0 auto;padding:18px 18px 48px;font-family:system-ui">'
      + '<div style="font:800 24px system-ui;color:#12233b">Field Photos</div>'
      + '<div style="font-size:13px;color:#5b6673;margin-top:2px">Import, manage RAM, auto-tag, then browse or print.</div>'
      + '<div id="pd-stats" style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 2px"></div>'
      + '<div id="pd-status" style="font:600 12px system-ui;color:#0e7c66;min-height:16px;margin-top:4px"></div>'
      + card('Import',
          '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
          + btn('pd-up-folder', '📁 Upload folder') + btn('pd-up-all', '🗂 Upload all (split by sub-folder)') + btn('pd-up-files', '⬆ Upload files')
          + '<span style="width:1px;height:22px;background:#e3e8ee"></span>'
          + '<label style="font:600 12px system-ui;color:#5b6673">Display size <select id="pd-size" style="border:1px solid #d3dae1;border-radius:7px;padding:4px 7px;font:12.5px system-ui;background:#fff">'
          + '<option value="800">800 px</option><option value="1200">1200 px</option><option value="1600">1600 px</option><option value="2400">2400 px</option></select></label>'
          + '<div style="font:500 11px system-ui;color:#9BA0A8;flex:1 1 100%;margin-top:2px">Full-size originals are always kept for save / copy / print — this only sizes the fast in-RAM display copy.</div>'
          + '</div>'
          + '<div id="pd-drop" class="rw-dropzone" style="margin-top:10px"><span class="rw-dropzone-ico">⬇</span><span class="rw-dropzone-lbl">…or drag photos / folders here</span></div>')
      + card('', '<div style="font:700 13px system-ui;color:#0B3D66;margin-bottom:6px;letter-spacing:.3px">Photo sets · RAM</div><div id="pd-sets-host"></div>')
      + card('Tag &amp; report',
          '<div style="display:flex;flex-wrap:wrap;gap:8px">'
          + btnGo('pd-autotag', '📍 Auto-tag photos to routes') + btn('pd-browse', '🖼 Browse photos') + btnGo('pd-print', '🖨 Print Photo PDF')
          + '</div>')
      + '</div>';
  }

  function stats() {
    var g = geo(), host = $('pd-stats'); if (!g || !host) return;
    var list = g.list(), tagged = 0, untagged = 0, bytes = 0;
    list.forEach(function (p) { if (p.rip_route || p.rip_lot) tagged++; else untagged++; if (p.dataUrl) bytes += p.dataUrl.length; });
    var ram = bytes < 1048576 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(0) + ' MB';
    var tiles = [['Photos', list.length], ['Tagged', tagged], ['Untagged', untagged], ['In RAM', ram]];
    host.innerHTML = tiles.map(function (s) {
      return '<div style="background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:8px 14px;min-width:92px">'
        + '<div style="font:800 20px system-ui;color:#0B3D66">' + s[1] + '</div>'
        + '<div style="font:600 10.5px system-ui;color:#8a949f;text-transform:uppercase;letter-spacing:.5px">' + s[0] + '</div></div>';
    }).join('');
  }

  // ---- import pickers --------------------------------------------------------
  function dirInput() { var i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = 'image/*'; i.setAttribute('webkitdirectory', ''); i.setAttribute('directory', ''); i.style.display = 'none'; document.body.appendChild(i); return i; }
  function fileInput() { var i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = 'image/*'; i.style.display = 'none'; document.body.appendChild(i); return i; }
  function splitBySub(files) { var g = {}; Array.prototype.forEach.call(files, function (f) { var rel = f.webkitRelativePath || f.name, parts = rel.split('/'); var key = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : '(unsorted)'); (g[key] = g[key] || []).push(f); }); return g; }
  function oneSetName(files) { var rel = files[0] && (files[0].webkitRelativePath || files[0].name) || 'photos', parts = rel.split('/'); return parts.length >= 2 ? parts[0] : 'photos'; }
  function importGroups(groups) {
    var g = geo(); if (!g) return;
    var names = Object.keys(groups), added = 0, relinked = 0;
    names.reduce(function (pr, name) {
      return pr.then(function () {
        return g.importFiles(groups[name], name === '(unsorted)' ? null : name).then(function (r) {
          added += (r && r.added) || 0; relinked += (r && r.relinked) || 0;
        });
      });
    }, Promise.resolve()).then(function () {
      stats();
      if (window.RW2PhotoSets && window.RW2PhotoSets.renderSets) { try { window.RW2PhotoSets.renderSets(); } catch (e) {} }
      dstatus((added ? 'Imported ' + added + ' new photo(s). ' : '') + (relinked ? 'Re-linked ' + relinked + ' full-size original(s) to existing photos.' : ''));
      // Only offer tagging for genuinely new photos (re-linked ones are already tagged).
      if (added && window.RW2PhotoTag && window.RW2PhotoTag.wizard) { try { window.RW2PhotoTag.wizard({ added: added }); } catch (e) {} }
    });
  }
  function dstatus(msg) { var el = $('pd-status'); if (el) el.textContent = msg || ''; }

  // ---- drag & drop (files or folders, recursed) ------------------------------
  function readAllEntries(reader) {
    return new Promise(function (resolve) {
      var all = [];
      (function read() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch)); read();
        }, function () { resolve(all); });
      })();
    });
  }
  function walkEntry(entry, prefix) {
    return new Promise(function (resolve) {
      if (!entry) { resolve([]); return; }
      if (entry.isFile) { entry.file(function (f) { resolve([{ file: f, path: prefix + entry.name }]); }, function () { resolve([]); }); }
      else if (entry.isDirectory) {
        readAllEntries(entry.createReader()).then(function (ents) {
          Promise.all(ents.map(function (e) { return walkEntry(e, prefix + entry.name + '/'); }))
            .then(function (arrs) { resolve([].concat.apply([], arrs)); });
        });
      } else resolve([]);
    });
  }
  function filesFromDrop(dt) {
    var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return (it.kind === 'file' && it.webkitGetAsEntry) ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    if (entries.length) {
      return Promise.all(entries.map(function (e) { return walkEntry(e, ''); })).then(function (arrs) { return [].concat.apply([], arrs); });
    }
    return Promise.resolve(Array.prototype.slice.call((dt && dt.files) || []).map(function (f) { return { file: f, path: f.name }; }));
  }
  function groupDropped(items) {
    var g = {};
    items.forEach(function (it) {
      if (!/^image\//.test(it.file.type || '') && !/\.(jpe?g|png|gif|webp|heic)$/i.test(it.file.name || '')) return;
      var parts = it.path.split('/');
      var key = parts.length >= 2 ? parts[0] : '(unsorted)';
      (g[key] = g[key] || []).push(it.file);
    });
    return g;
  }

  function wire() {
    var di = dirInput(), ai = dirInput(), fi = fileInput();
    $('pd-up-folder').onclick = function () { di.value = ''; di.click(); };
    $('pd-up-all').onclick = function () { ai.value = ''; ai.click(); };
    $('pd-up-files').onclick = function () { fi.value = ''; fi.click(); };
    di.onchange = function () { if (!di.files.length) return; var g = {}; g[oneSetName(di.files)] = Array.prototype.slice.call(di.files); importGroups(g); };
    ai.onchange = function () { if (!ai.files.length) return; importGroups(splitBySub(ai.files)); };
    fi.onchange = function () { if (!fi.files.length) return; var g = {}; g['(unsorted)'] = Array.prototype.slice.call(fi.files); importGroups(g); };

    var sz = $('pd-size');
    try { var sv = localStorage.getItem('rw_photo_maxsize'); sz.value = sv || '1600'; } catch (e) { sz.value = '1600'; }
    sz.onchange = function () { try { localStorage.setItem('rw_photo_maxsize', sz.value); } catch (e) {} var pp = $('pp-size'); if (pp) pp.value = sz.value; };

    var dz = $('pd-drop');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('rw-drop-active'); }); });
      ['dragleave', 'dragend'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.remove('rw-drop-active'); }); });
      dz.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); dz.classList.remove('rw-drop-active');
        dstatus('Reading dropped items…');
        filesFromDrop(e.dataTransfer).then(function (items) {
          var groups = groupDropped(items);
          if (Object.keys(groups).length) importGroups(groups); else dstatus('No images found in the drop.');
        });
      });
    }

    $('pd-autotag').onclick = function () { if (window.RW2PhotoTag && window.RW2PhotoTag.wizard) window.RW2PhotoTag.wizard({}); };
    $('pd-browse').onclick = function () { if (window.showModule) window.showModule('rip'); if (window.RW2RIP) { window.RW2RIP.state.tab = 'photos'; try { window.RW2RIP.render(); } catch (e) {} } };
    $('pd-print').onclick = function () { if (window.RW2PhotoReport && window.RW2PhotoReport.open) window.RW2PhotoReport.open(); };
  }

  function buildModule() {
    if (_built) return;
    // nav tab after RIP
    var ripTab = document.querySelector('#app-tabs .app-tab[data-module="rip"]');
    if (ripTab && !document.querySelector('.app-tab[data-module="photos"]')) {
      var nav = document.createElement('button');
      nav.className = 'app-tab'; nav.setAttribute('data-module', 'photos'); nav.setAttribute('role', 'tab'); nav.setAttribute('aria-selected', 'false');
      nav.title = 'Field photos — import, sets, tagging, report';
      nav.innerHTML = '<span class="app-tab-icon">📷</span><span class="app-tab-label">Photos</span>';
      ripTab.insertAdjacentElement('afterend', nav);
      nav.addEventListener('click', function () { if (window.showModule) window.showModule('photos'); });
    }
    // module panel after #mod-rip
    var modRip = $('mod-rip');
    if (modRip && !$('mod-photos')) {
      var mod = document.createElement('div');
      mod.id = 'mod-photos'; mod.className = 'module-view'; mod.style.cssText = 'overflow:auto;background:var(--paper-2,#f4f6f9)';
      mod.innerHTML = dashHtml();
      modRip.insertAdjacentElement('afterend', mod);
      wire();
      _built = true;
    }
  }

  function render() { buildModule(); stats(); if (window.RW2PhotoSets && window.RW2PhotoSets.renderSets) { try { window.RW2PhotoSets.renderSets(); } catch (e) {} } }

  function whenReady() {
    if ($('mod-rip')) { buildModule(); return; }
    var t = 0, iv = setInterval(function () { if ($('mod-rip') || ++t > 60) { clearInterval(iv); buildModule(); } }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenReady);
  else whenReady();

  window.RW2PhotoDash = { render: render, build: buildModule };
})();
