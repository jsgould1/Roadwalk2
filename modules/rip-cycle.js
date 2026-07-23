/* =========================================================================
 * rip-cycle.js — Cycle 7 condition data + cycle-over-cycle matching.
 *
 * Cycle 6 ships offline in the park bundles. Cycle 7 is an ONGOING collection
 * held in the public EFLHD-RIP dashboard FeatureServer (layer 3,
 * ROAD_CONDITION_EVENTS) — same 0.02 mi grid as Cycle 6, keyed by
 * ROUTE_IDENT + BEG_MP. It is fetched live per park (CORS-open, public NPS
 * data) and cached in IndexedDB; because it is still being collected, some
 * routes have no Cycle 7 data yet, which the UI reports rather than hides.
 *
 * Cycle 7 field names differ from Cycle 6 and arrive as strings with
 * "NOT APPLICABLE" for missing, so they are parsed and renamed to the SAME
 * metric keys as Cycle 6 (PCR, SC_INDEX, AC_INDEX, …) — the tables and colour
 * bands then work on either cycle unchanged.
 * ========================================================================= */
(function () {
  'use strict';

  const FS = 'https://services3.arcgis.com/9Ij3DUv1U3250Rno/arcgis/rest/services/'
    + 'NPS_Presentation_Dashboard_April_2024_WFL1/FeatureServer/3/query';
  const OUT = ['ROUTE_IDENT', 'BEG_MP', 'END_MP', 'PAVED_RATING', 'DCV_SCR', 'DCV_RCI',
    'DCV_SC_INDEX', 'ALIGATOR_CRACKING', 'LONGITUDINAL_CRACKING', 'TRANSVERSE_CRACKING',
    'PATCHING', 'RUTTING', 'DCV_MACROTEXTURE', 'RATING', 'SURF_TYPE', 'LANE_WIDTH',
    'NUM_LANES', 'CYCLE'].join(',');
  const PAGE = 2000;

  function num(v) {
    if (v == null) return null;
    const s = String(v).trim().toUpperCase();
    if (!s || s === 'NOT APPLICABLE' || s === 'NOT RATED' || s === 'NA' || s === 'N/A') return null;
    const n = Number(v); return isNaN(n) ? null : n;
  }
  // Cycle 7 attributes → Cycle 6 metric names (feet for INT_LENGTH, like C6).
  function mapC7(a) {
    return {
      ROUTE_IDENT: a.ROUTE_IDENT, BEG_MP: a.BEG_MP, END_MP: a.END_MP,
      INT_LENGTH: (a.END_MP != null && a.BEG_MP != null) ? (a.END_MP - a.BEG_MP) * 5280 : 105.6,
      PCR: num(a.PAVED_RATING), SCR: num(a.DCV_SCR), RCI: num(a.DCV_RCI),
      SC_INDEX: num(a.DCV_SC_INDEX), AC_INDEX: num(a.ALIGATOR_CRACKING),
      LC_INDEX: num(a.LONGITUDINAL_CRACKING), TC_INDEX: num(a.TRANSVERSE_CRACKING),
      PATCH_INDEX: num(a.PATCHING), RUT_INDEX: num(a.RUTTING), MACROTEX: num(a.DCV_MACROTEXTURE),
      RATING: a.RATING, SURF_TYPE: a.SURF_TYPE, LANE_WIDTH: num(a.LANE_WIDTH),
      NO_LANES: num(a.NUM_LANES), CYCLE: a.CYCLE,
    };
  }

  // Cycle 7 parking conditions (layer 7) — one row per lot, keyed by
  // ROUTE_IDENT. Cycle 6 lots only carry PCR, so parking compares on PCR.
  const FS_PARK = 'https://services3.arcgis.com/9Ij3DUv1U3250Rno/arcgis/rest/services/'
    + 'NPS_Presentation_Dashboard_April_2024_WFL1/FeatureServer/7/query';

  const state = { park: null, all: [], byRoute: new Map(), byKey: new Map(), parking: new Map(), fetchedAt: null, loading: false, error: null };
  // Both cycles share the same 0.02 mi grid, so a segment can be keyed by
  // route + milepost bin. matchSeg is called thousands of times per hover, so
  // it must be an O(1) map lookup, never a scan.
  const mpKey = (rid, mp) => rid + '|' + Math.round((mp || 0) * 50);
  function index() {
    state.byRoute = new Map();
    state.byKey = new Map();
    for (const s of state.all) {
      let a = state.byRoute.get(s.ROUTE_IDENT);
      if (!a) state.byRoute.set(s.ROUTE_IDENT, a = []);
      a.push(s);
      state.byKey.set(mpKey(s.ROUTE_IDENT, s.BEG_MP), s);
    }
    for (const a of state.byRoute.values()) a.sort((x, y) => (x.BEG_MP || 0) - (y.BEG_MP || 0));
  }

  // ---- cache ------------------------------------------------------------
  const DB = 'roadwalk2_rip_c7', STORE = 'c7';
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function readCache(park) {
    try {
      const db = await idb();
      return await new Promise((res, rej) => {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(park);
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
    } catch (_) { return null; }
  }
  async function writeCache(park, segs, fetchedAt, parking) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ park, segs, fetchedAt, parking: [...(parking || new Map())] }, park);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (_) {}
  }

  // ---- fetch ------------------------------------------------------------
  async function fetchAll(park) {
    const all = [];
    for (let off = 0; off < 300000;) {
      const p = new URLSearchParams({
        where: "UNIT_ID='" + park + "'", outFields: OUT, orderByFields: 'ROUTE_IDENT,BEG_MP',
        resultRecordCount: String(PAGE), resultOffset: String(off), returnGeometry: 'false', f: 'json',
      });
      const j = await (await fetch(FS + '?' + p)).json();
      if (j.error) throw new Error(j.error.message || 'query failed');
      const fs = (j.features || []).map((f) => mapC7(f.attributes));
      all.push(...fs);
      if (fs.length < PAGE && !j.exceededTransferLimit) break;
      if (!fs.length) break;
      off += fs.length;
    }
    return all;
  }

  // Cycle 7 parking: one PCR per lot. Sparse — many parks aren't collected yet.
  async function fetchParking(park) {
    const m = new Map();
    try {
      const p = new URLSearchParams({
        where: "UNIT_ID='" + park + "'", outFields: 'ROUTE_IDENT,PAVED_RATING,RATING,CYCLE',
        returnGeometry: 'false', f: 'json',
      });
      const j = await (await fetch(FS_PARK + '?' + p)).json();
      for (const f of (j.features || [])) {
        const a = f.attributes;
        if (a && a.ROUTE_IDENT) m.set(a.ROUTE_IDENT, { PCR: num(a.PAVED_RATING), RATING: a.RATING, CYCLE: a.CYCLE });
      }
    } catch (_) { /* parking is optional; roads still work */ }
    return m;
  }

  // Load Cycle 7 for a park: cache-first, then network. `refresh` forces network
  // (Cycle 7 is ongoing). Returns the state; callers read .all / .byRoute / .error.
  async function loadPark(park, opts) {
    opts = opts || {};
    if (!park) return state;
    if (state.park === park && state.all.length && !opts.refresh) return state;
    // Already fetching this park: callers re-enter through their onchange
    // handler, so without this a draw()->loadPark->onchange->draw() cycle
    // recurses forever and hangs the tab.
    if (state.park === park && state.loading) return state;
    state.loading = true; state.error = null; state.park = park;
    if (typeof opts.onchange === 'function') opts.onchange();
    try {
      if (!opts.refresh) {
        const c = await readCache(park);
        if (c && c.segs && c.segs.length) {
          state.all = c.segs; state.fetchedAt = c.fetchedAt;
          state.parking = new Map(c.parking || []); index(); state.loading = false;
          if (typeof opts.onchange === 'function') opts.onchange();
          return state;
        }
      }
      const [segs, parking] = await Promise.all([fetchAll(park), fetchParking(park)]);
      state.all = segs; state.parking = parking; state.fetchedAt = Date.now(); index();
      writeCache(park, segs, state.fetchedAt, parking);
    } catch (e) {
      state.error = e.message; state.all = []; state.byRoute = new Map(); state.parking = new Map();
    }
    state.loading = false;
    if (typeof opts.onchange === 'function') opts.onchange();
    return state;
  }

  function matchSeg(routeIdent, begMp) {
    return (state.byKey && state.byKey.get(mpKey(routeIdent, begMp))) || null;
  }
  // Coverage vs a set of Cycle 6 route idents.
  function coverage(routeIdents) {
    let withC7 = 0;
    for (const r of routeIdents) if ((state.byRoute.get(r) || []).length) withC7++;
    return { routesWithC7: withC7, totalRoutes: routeIdents.length, segsC7: state.all.length };
  }

  window.RW2RIPCycle = {
    loadPark, get: () => state, segmentsFor: (r) => state.byRoute.get(r) || [],
    matchSeg, coverage, hasData: () => state.all.length > 0,
    matchLot: (r) => state.parking.get(r) || null,
    parkingCount: () => state.parking.size,
    park: () => state.park, fetchedAt: () => state.fetchedAt,
  };
})();
