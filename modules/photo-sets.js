/* ============================================================================
   RoadWalk 2 — PHOTO SETS  (folder upload + RAM load/unload)  [port win #2]
   ----------------------------------------------------------------------------
   Lets you import field photos as named *sets* (by folder) and turn each set's
   images on/off to control RAM. When a set is OFF its image pixels are moved
   out of the geophoto record into a side "blobs" store; the metadata record
   stays in memory, so the map marker, the route/lot tags and every other field
   persist — only the picture is gone until you switch the set back on.

   Upload actions:
     • Upload folder  → one set  (whole folder incl. subfolders = one set;
                                   e.g. a "signs" folder with subfolders)
     • Upload all     → split by subfolder (point at the park photo root; each
                                   top-level subfolder becomes its own set)
     • Upload files   → plain multi-file pick into a typed set name

   Depends on window._RW.geophotos: list / get / save / saveMany / refresh /
   importFiles(files,setName) / remove(id).
   ========================================================================== */
(function () {
  'use strict';

  function geo() { return (window._RW && window._RW.geophotos) || null; }
  function $(id) { return document.getElementById(id); }
  var UNSORTED = '(unsorted)';

  // ---- side store for offloaded image pixels --------------------------------
  var BDB = 'RoadWalk2PhotoBlobs_v1', BSTORE = 'blobs';
  function openBlob() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(BDB, 1);
      rq.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(BSTORE)) db.createObjectStore(BSTORE, { keyPath: 'id' });
      };
      rq.onsuccess = function (e) { res(e.target.result); };
      rq.onerror = function (e) { rej(e.target.error); };
    });
  }
  function blobPut(id, dataUrl) {
    return openBlob().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(BSTORE, 'readwrite');
        tx.objectStore(BSTORE).put({ id: id, dataUrl: dataUrl });
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function blobGet(id) {
    return openBlob().then(function (db) {
      return new Promise(function (res, rej) {
        var rq = db.transaction(BSTORE, 'readonly').objectStore(BSTORE).get(id);
        rq.onsuccess = function () { res(rq.result || null); }; rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function blobDel(id) {
    return openBlob().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(BSTORE, 'readwrite');
        tx.objectStore(BSTORE).delete(id);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); };
      });
    });
  }

  // ---- set enumeration -------------------------------------------------------
  function setOf(p) { return p._set || UNSORTED; }
  function fmtBytes(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function sets() {
    var g = geo(); if (!g) return [];
    var m = {};
    g.list().forEach(function (p) {
      var s = setOf(p);
      if (!m[s]) m[s] = { name: s, total: 0, loaded: 0, bytes: 0 };
      m[s].total++;
      if (p.dataUrl) { m[s].loaded++; m[s].bytes += p.dataUrl.length; }
    });
    return Object.keys(m).sort(function (a, b) {
      if (a === UNSORTED) return 1; if (b === UNSORTED) return -1; return a < b ? -1 : 1;
    }).map(function (k) { return m[k]; });
  }

  // ---- offload / restore -----------------------------------------------------
  function photosInSet(name) {
    return geo().list().filter(function (p) { return setOf(p) === name; });
  }
  function offloadSet(name) {
    var g = geo(); if (!g) return Promise.resolve(0);
    var ps = photosInSet(name).filter(function (p) { return p.dataUrl; });
    if (!ps.length) return Promise.resolve(0);
    var chain = Promise.resolve();
    ps.forEach(function (p) {
      chain = chain.then(function () {
        return blobPut(p.id, p.dataUrl).then(function () { delete p.dataUrl; });
      });
    });
    return chain.then(function () { return g.saveMany(ps); })
                .then(function () { try { g.refresh(); } catch (e) {} return ps.length; });
  }
  function restoreSet(name) {
    var g = geo(); if (!g) return Promise.resolve({ restored: 0, missing: 0 });
    var ps = photosInSet(name).filter(function (p) { return !p.dataUrl; });
    if (!ps.length) return Promise.resolve({ restored: 0, missing: 0 });
    var restored = 0, missing = 0, chain = Promise.resolve(), changed = [];
    ps.forEach(function (p) {
      chain = chain.then(function () {
        return blobGet(p.id).then(function (b) {
          if (b && b.dataUrl) { p.dataUrl = b.dataUrl; changed.push(p); restored++; }
          else missing++;
        });
      });
    });
    return chain.then(function () { return g.saveMany(changed); })
                .then(function () { try { g.refresh(); } catch (e) {} return { restored: restored, missing: missing }; });
  }
  function offloadAll() {
    var names = sets().filter(function (s) { return s.loaded > 0; }).map(function (s) { return s.name; });
    return names.reduce(function (pr, n) { return pr.then(function (t) { return offloadSet(n).then(function (c) { return t + c; }); }); }, Promise.resolve(0));
  }
  function loadAll() {
    var names = sets().filter(function (s) { return s.loaded < s.total; }).map(function (s) { return s.name; });
    return names.reduce(function (pr, n) { return pr.then(function (acc) { return restoreSet(n).then(function (r) { return { restored: acc.restored + r.restored, missing: acc.missing + r.missing }; }); }); }, Promise.resolve({ restored: 0, missing: 0 }));
  }

  // Permanently remove a set: delete its photos (RAM + IDB) and offloaded blobs.
  function deleteSet(name, onProgress) {
    var g = geo(); if (!g) return Promise.resolve(0);
    var ps = photosInSet(name);
    var ids = ps.map(function (p) { return p.id; });
    var done = 0, total = ids.length;
    return ids.reduce(function (pr, id) {
      return pr.then(function () {
        return blobDel(id).then(function () {
          return g.remove(id).then(function () { done++; if (onProgress && (done % 50 === 0 || done === total)) onProgress(done, total); });
        });
      });
    }, Promise.resolve()).then(function () { try { g.refresh(); } catch (e) {} return total; });
  }

  // ---- folder grouping -------------------------------------------------------
  // Whole pick → one set (folder name). Subfolders included.
  function oneSetName(files) {
    var rel = files[0] && (files[0].webkitRelativePath || files[0].name) || 'photos';
    var parts = rel.split('/');
    return parts.length >= 2 ? parts[0] : 'photos';
  }
  // Split a parent pick into one set per top-level subfolder ("upload all").
  function splitBySubfolder(files) {
    var groups = {};
    Array.prototype.forEach.call(files, function (f) {
      var rel = f.webkitRelativePath || f.name;
      var parts = rel.split('/');
      var key = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : UNSORTED);
      (groups[key] = groups[key] || []).push(f);
    });
    return groups;
  }

  // ---- UI --------------------------------------------------------------------
  function status(msg) { var el = $('ps-status'); if (el) el.textContent = msg || ''; }

  function renderSets() {
    var host = $('ps-list'); if (!host) return;
    var rows = sets();
    if (!rows.length) { host.innerHTML = '<div style="color:var(--mute,#9BA0A8);font:500 11.5px system-ui;padding:4px 0">No photo sets yet — upload a folder.</div>'; return; }
    host.innerHTML = rows.map(function (s) {
      var on = s.loaded > 0;
      var sub = s.loaded + '/' + s.total + ' in RAM · ' + fmtBytes(s.bytes);
      return '<div class="ps-row" data-set="' + encodeURIComponent(s.name) + '" ' +
        'style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--rule,#DDD7C8)">' +
        '<label class="ps-sw" title="Turn this set\'s images on/off in RAM" style="position:relative;display:inline-block;width:34px;height:18px;flex:0 0 auto">' +
          '<input type="checkbox" class="ps-toggle"' + (on ? ' checked' : '') + ' style="opacity:0;width:0;height:0">' +
          '<span class="ps-sl" style="position:absolute;inset:0;border-radius:18px;background:' + (on ? 'var(--orange,#C85A2B)' : '#C7C2B4') + ';transition:.15s"></span>' +
          '<span class="ps-kn" style="position:absolute;top:2px;left:' + (on ? '18px' : '2px') + ';width:14px;height:14px;border-radius:50%;background:#fff;transition:.15s"></span>' +
        '</label>' +
        '<div style="flex:1 1 auto;min-width:0">' +
          '<div style="font:600 12.5px system-ui;color:var(--ink,#1A1D22);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(s.name) + '</div>' +
          '<div style="font:500 10.5px \'IBM Plex Mono\',monospace;color:var(--mute,#9BA0A8)">' + sub + '</div>' +
        '</div>' +
        '<button class="ps-del" title="Delete this set permanently" style="flex:0 0 auto;border:0;background:transparent;cursor:pointer;color:#b23a1f;font-size:14px;padding:2px 4px">🗑</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.ps-row'), function (row) {
      var name = decodeURIComponent(row.getAttribute('data-set'));
      var cb = row.querySelector('.ps-toggle');
      cb.addEventListener('change', function () {
        cb.disabled = true;
        status((cb.checked ? 'Loading' : 'Offloading') + ' "' + name + '"…');
        var job = cb.checked ? restoreSet(name) : offloadSet(name);
        job.then(function (r) {
          cb.disabled = false;
          if (cb.checked && r && r.missing) status('Loaded "' + name + '" — ' + r.missing + ' image(s) had no stored copy.');
          else status(cb.checked ? 'Loaded "' + name + '".' : 'Offloaded "' + name + '" (RAM freed).');
          renderSets();
        }, function (e) { cb.disabled = false; status('Failed: ' + (e && e.message ? e.message : e)); });
      });
      // Delete → inline two-step confirm (no native dialog; permanent).
      var del = row.querySelector('.ps-del');
      del.addEventListener('click', function () {
        var info = sets().filter(function (x) { return x.name === name; })[0];
        var n = info ? info.total : 0;
        row.innerHTML = '<div style="flex:1;font:600 11.5px system-ui;color:#b23a1f">Delete "' + esc(name) + '" — ' + n + ' photo' + (n === 1 ? '' : 's') + ' permanently?</div>' +
          '<button class="ps-del-yes" style="border:0;background:#b23a1f;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font:700 11.5px system-ui">Delete</button>' +
          '<button class="ps-del-no" style="border:1px solid var(--rule,#DDD7C8);background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font:600 11.5px system-ui">Keep</button>';
        row.querySelector('.ps-del-no').addEventListener('click', renderSets);
        row.querySelector('.ps-del-yes').addEventListener('click', function () {
          status('Deleting "' + name + '"…');
          deleteSet(name, function (d, t) { status('Deleting "' + name + '"… ' + d + '/' + t); }).then(function (count) {
            status('Deleted ' + count + ' photo(s) from "' + name + '".');
            renderSets();
            if (window.RW2RouteView && window.RW2RouteView.refresh) { try { window.RW2RouteView.refresh(); } catch (e) {} }
          });
        });
      });
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function importGroups(groups) {
    var g = geo(); if (!g) return;
    var names = Object.keys(groups);
    var totalSets = names.length, i = 0, added = 0;
    status('Importing ' + names.length + ' set(s)…');
    names.reduce(function (pr, name) {
      return pr.then(function () {
        i++; status('Importing set ' + i + '/' + totalSets + ': "' + name + '" (' + groups[name].length + ' files)…');
        return g.importFiles(groups[name], name).then(function (n) { added += (n || 0); });
      });
    }, Promise.resolve()).then(function () {
      status('Imported ' + added + ' photo(s) in ' + names.length + ' set(s).');
      renderSets();
      // Walk the user straight into auto-tagging what they just imported.
      if (added && window.RW2PhotoTag && window.RW2PhotoTag.wizard) {
        try { window.RW2PhotoTag.wizard({ added: added }); } catch (e) {}
      }
    });
  }

  function makeDirInput() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*';
    inp.setAttribute('webkitdirectory', ''); inp.setAttribute('directory', '');
    inp.style.display = 'none'; document.body.appendChild(inp);
    return inp;
  }

  // Prefer the Photos dashboard host; fall back to the map's Field Photos panel.
  function setsHost() { return document.getElementById('pd-sets-host') || document.querySelector('#photos-panel .pp-body'); }
  function buildUI() {
    var body = setsHost();
    if (!body || $('ps-block')) return;

    var block = document.createElement('div');
    block.id = 'ps-block';
    block.style.cssText = 'margin-top:10px;padding-top:8px;border-top:2px solid var(--rule,#DDD7C8)';
    block.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
        '<button class="pp-btn" id="ps-load-all" type="button" title="Bring every set\'s images back into RAM">⤓ Load all</button>' +
        '<button class="pp-btn" id="ps-offload-all" type="button" title="Free RAM: offload every set\'s images (tags + markers stay)">☁ Offload all</button>' +
      '</div>' +
      '<div id="ps-list" style="margin-top:8px"></div>' +
      '<div id="ps-status" style="margin-top:6px;font:500 11px system-ui;color:var(--mute,#9BA0A8)"></div>';
    body.appendChild(block);

    $('ps-offload-all').addEventListener('click', function () {
      status('Offloading all sets…');
      offloadAll().then(function (n) { status('Offloaded ' + n + ' image(s) — RAM freed.'); renderSets(); });
    });
    $('ps-load-all').addEventListener('click', function () {
      status('Loading all sets…');
      loadAll().then(function (r) { status('Loaded ' + r.restored + ' image(s)' + (r.missing ? ', ' + r.missing + ' missing' : '') + '.'); renderSets(); });
    });

    renderSets();
    // keep the list fresh when photos change elsewhere (uploads via the old button)
    var reRender = function () { if ($('ps-list')) renderSets(); };
    document.addEventListener('visibilitychange', reRender);
  }

  function whenReady() {
    // Prefer the Photos dashboard host; wait for it, then fall back to the map
    // panel only if the dashboard never appears.
    var tries = 0, iv = setInterval(function () {
      if (document.getElementById('pd-sets-host')) { clearInterval(iv); buildUI(); return; }
      if (++tries > 24) { clearInterval(iv); if (setsHost()) buildUI(); }
    }, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenReady);
  else whenReady();

  // Resolve a photo's image data URL even if its set is offloaded (reads the
  // live record first, then the side blob store). Returns Promise<dataUrl|null>.
  function imageFor(id) {
    var g = geo(); if (!g) return Promise.resolve(null);
    var p = g.get(id);
    if (p && p.dataUrl) return Promise.resolve(p.dataUrl);
    return blobGet(id).then(function (b) { return (b && b.dataUrl) || null; });
  }

  // ---- public API ------------------------------------------------------------
  window.RW2PhotoSets = {
    sets: sets, offloadSet: offloadSet, restoreSet: restoreSet,
    offloadAll: offloadAll, loadAll: loadAll, deleteSet: deleteSet, renderSets: renderSets,
    imageFor: imageFor,
  };
})();
