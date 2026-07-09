/* =========================================================================
 * flip-sta.js — "Flip STA" control for linear routes.
 * Reverses the active route's alignment so 0+00 moves to the other end
 * (via window._RW.flipActiveStationing). Only shown on the field map when a
 * LINEAR route is active (parking areas have no stationing).
 * ========================================================================= */
(function () {
  'use strict';

  function activeIsLinear() {
    const vf = document.getElementById('view-field');
    if (!vf || !vf.classList.contains('active')) return false;
    const k = (document.getElementById('header-kicker') || {}).textContent || '';
    return /LINEAR/i.test(k);
  }

  function ensureBtn() {
    let b = document.getElementById('rw2-flip-sta');
    if (b) return b;
    const vf = document.getElementById('view-field');
    if (!vf) return null;
    b = document.createElement('button');
    b.id = 'rw2-flip-sta';
    b.textContent = '⇄ Flip STA';
    b.title = 'Flip stationing — move 0+00 to the other end of this route';
    b.style.cssText = 'position:absolute;top:12px;left:12px;z-index:650;padding:7px 12px;border-radius:8px;border:1px solid #d3dae1;background:#fff;color:#12233b;font:600 12px "IBM Plex Sans",system-ui;cursor:pointer;box-shadow:0 1px 4px rgba(20,35,60,.25)';
    b.addEventListener('click', () => {
      if (window._RW && window._RW.flipActiveStationing) {
        b.disabled = true;
        window._RW.flipActiveStationing();
        setTimeout(() => { b.disabled = false; }, 600);
      }
    });
    vf.appendChild(b);
    return b;
  }

  function tick() {
    const b = ensureBtn();
    if (b) b.style.display = activeIsLinear() ? '' : 'none';
  }
  setInterval(tick, 700);
  setTimeout(tick, 500);
})();
