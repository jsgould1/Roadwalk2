/* =========================================================================
 * route-tools.js — filter + sort bar for the route list.
 * Big sections (BLRI_NC has 212 routes) need search. Self-mounting; injects a
 * bar as a SIBLING before each route list so the donor's re-renders (which
 * clear the list's innerHTML) don't remove it. Re-applies on a light poll.
 * ========================================================================= */
(function () {
  'use strict';

  const LISTS = ['#section-list', '#dash-section-list'];

  function areaOf(row) {
    const m = (row.querySelector('.bottom-line')?.textContent || '').match(/([\d.]+)\s*ac/);
    return m ? parseFloat(m[1]) : -1;
  }
  function nameOf(row) { return (row.querySelector('.name')?.textContent || '').toLowerCase(); }

  function makeBar(list) {
    const bar = document.createElement('div');
    bar.className = 'rw2-routebar';
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 16px;border-bottom:1px solid #e3e8ee;background:#fff';
    bar.innerHTML =
      `<input type="search" placeholder="Filter routes…" class="rw2-rt-q"
         style="flex:1;min-width:0;padding:6px 10px;border:1px solid #d3dae1;border-radius:8px;font:13px 'IBM Plex Sans',system-ui;color:#1a2330">
       <label style="display:flex;align-items:center;gap:5px;font:12px 'IBM Plex Sans',system-ui;color:#1a2330;white-space:nowrap;cursor:pointer"><input type="checkbox" class="rw2-rt-scope"> In scope</label>
       <select class="rw2-rt-sort" style="padding:6px 8px;border:1px solid #d3dae1;border-radius:8px;font:12px 'IBM Plex Sans',system-ui;color:#1a2330">
         <option value="none">Default order</option>
         <option value="name">Name A–Z</option>
         <option value="area">Area (large→small)</option>
       </select>
       <span class="rw2-rt-count" style="font:11px 'IBM Plex Mono',monospace;color:#5b6673;white-space:nowrap"></span>`;
    const q = bar.querySelector('.rw2-rt-q');
    const sort = bar.querySelector('.rw2-rt-sort');
    const scopeChk = bar.querySelector('.rw2-rt-scope');
    const count = bar.querySelector('.rw2-rt-count');

    const rows = () => Array.from(list.querySelectorAll('.section-row'));
    const inScopeNames = () => new Set(((window._RW && window._RW.SECTIONS) || [])
      .filter((s) => s.in_scope).map((s) => (s.name || '').toLowerCase()));

    function apply() {
      const term = q.value.trim().toLowerCase();
      const scopeOnly = scopeChk.checked;
      const scopeSet = scopeOnly ? inScopeNames() : null;
      let shown = 0;
      const rs = rows();
      rs.forEach((r) => {
        const nm = nameOf(r);
        const match = (!term || nm.includes(term)) && (!scopeOnly || scopeSet.has(nm));
        r.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      count.textContent = rs.length ? `${shown}/${rs.length}` : '';
    }
    function applySort() {
      if (sort.value === 'none') return;
      const rs = rows();
      rs.sort((a, b) =>
        sort.value === 'name' ? nameOf(a).localeCompare(nameOf(b)) : areaOf(b) - areaOf(a));
      rs.forEach((r) => list.appendChild(r));   // reorder DOM in place
    }
    q.addEventListener('input', apply);
    scopeChk.addEventListener('change', apply);
    sort.addEventListener('change', () => { applySort(); apply(); });
    // expose so the poll can re-apply after a donor re-render
    list._rw2 = () => { applySort(); apply(); };
    return bar;
  }

  function mount() {
    LISTS.forEach((sel) => {
      const list = document.querySelector(sel);
      if (!list || !list.parentElement) return;
      const prev = list.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains('rw2-routebar')) {
        if (list._rw2) list._rw2();       // re-apply filter/sort after re-render
        return;
      }
      list.parentElement.insertBefore(makeBar(list), list);
    });
  }
  setInterval(mount, 1000);
  setTimeout(mount, 600);
})();
