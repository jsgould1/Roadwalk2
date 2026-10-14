/* RoadWalk2 offline spell-check (RW2Spell)
   ----------------------------------------------------------------
   Pure logic: no UI. Lazy-loads a gzipped English word list the
   first time check()/ready() is called (zero startup cost), seeds a
   pavement-domain allowlist from the static list below PLUS the
   current report rubric (so house terms never flag), and returns
   flagged tokens with nearest-word suggestions (bounded edit
   distance). Fully on-device — no network beyond the local dict file.
   ---------------------------------------------------------------- */
(function () {
  'use strict';

  var DICT_URL = './lib/words.txt.gz';

  // Pavement / NPS domain terms + abbreviations that aren't in a general
  // dictionary. Lowercased. The rubric adds more at load time.
  var DOMAIN = ('hma pcc dycl sycl swel syel mutcd nps aecom vc row dot wrbr ' +
    'chipseal chipsealed chipseals microsurfacing crackseal cracksealing geocell ' +
    'geogrid geotextile raveling ravelling rutting alligator longitudinal transverse ' +
    'bollard bollards pavers pervious culvert culverts swale swales monument monuments ' +
    'striping centerline centerlines overlay overlays subgrade subbase aggregate ' +
    'shoulder shoulders driveway driveways curbing reveal reveals wheelstop wheelstops ' +
    'speedbump speedbumps sidewalk sidewalks gutter gutters bioswale bioswales ' +
    'induction inlet inlets manhole manholes apron fillet taper tapers cul sac ' +
    'oxidation weathering potholing potholes delamination delaminated spalling spalled ' +
    'faulting polyurethane bituminous emulsion sealcoat sealcoated fog slurry ' +
    'rejuvenator reclaimed millings tack prime striped restripe restriping thermoplastic ' +
    'rpms rumble stationing station sta mp milepost ada ramps bulbout curbline ' +
    'drainageway riprap gabion gabions vegetated vegetation encroachment unconfined ' +
    'standalone offloaded geojson shapefile shapefiles lat lng gps').split(/\s+/);

  var DICT = null;          // Set of known words
  var BUCKETS = null;       // Map "c:len" -> [words] for suggestion search
  var ALLOW = null;         // Set of extra allowed words (domain + rubric + session)
  var loadingP = null;

  function rubricWords() {
    var txt = '';
    try {
      if (window.RW2PhotoReport && window.RW2PhotoReport.examples) {
        // getRubric isn't public; read the stored rubric directly.
      }
      txt = localStorage.getItem('rw_report_rubric') || '';
    } catch (e) {}
    var out = [];
    (txt.toLowerCase().match(/[a-z][a-z'-]+/g) || []).forEach(function (w) {
      if (w.length >= 2) out.push(w.replace(/^[-']+|[-']+$/g, ''));
    });
    return out;
  }

  function buildAllow() {
    ALLOW = new Set();
    DOMAIN.forEach(function (w) { if (w) ALLOW.add(w); });
    rubricWords().forEach(function (w) { if (w) ALLOW.add(w); });
  }

  function indexBuckets(words) {
    BUCKETS = new Map();
    words.forEach(function (w) {
      var k = w[0] + ':' + w.length;
      var a = BUCKETS.get(k); if (!a) { a = []; BUCKETS.set(k, a); }
      a.push(w);
    });
  }

  function load() {
    if (loadingP) return loadingP;
    loadingP = (async function () {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot decompress the dictionary (no DecompressionStream).');
      }
      var res = await fetch(DICT_URL);
      if (!res || !res.ok) throw new Error('Could not load the dictionary file.');
      var stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      var text = await new Response(stream).text();
      var words = text.split('\n');
      DICT = new Set();
      for (var i = 0; i < words.length; i++) { if (words[i]) DICT.add(words[i]); }
      indexBuckets(words);
      buildAllow();
      return true;
    })();
    return loadingP;
  }

  function ready() { return load(); }
  function isLoaded() { return !!DICT; }
  function addAllowed(word) {
    if (!word) return;
    if (!ALLOW) ALLOW = new Set();
    ALLOW.add(String(word).toLowerCase());
  }

  // Bounded Levenshtein: returns distance, or max+1 once it is known to exceed max.
  function editDist(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i; var best = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;      // whole row already over budget
      var t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  function commonPrefix(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }
  function suggest(lower, limit) {
    if (!BUCKETS) return [];
    limit = limit || 3;
    var cands = [], len = lower.length, c = lower[0], d;
    for (d = -1; d <= 1; d++) {
      var arr = BUCKETS.get(c + ':' + (len + d));
      if (arr) cands = cands.concat(arr);
    }
    var scored = [];
    for (var i = 0; i < cands.length; i++) {
      var w = cands[i];
      var dist = editDist(lower, w, 2);
      if (dist <= 2) scored.push([w, dist, commonPrefix(w, lower)]);
    }
    // closest edit distance first, then longest shared prefix (typos rarely hit
    // the start of a word), then shorter, then alphabetical.
    scored.sort(function (x, y) {
      return x[1] - y[1] || y[2] - x[2] || x[0].length - y[0].length || (x[0] < y[0] ? -1 : 1);
    });
    var out = [];
    for (var k = 0; k < scored.length && out.length < limit; k++) out.push(scored[k][0]);
    return out;
  }

  function known(lower) {
    return (DICT && DICT.has(lower)) || (ALLOW && ALLOW.has(lower));
  }

  // Is this raw token something we never flag? (acronyms, measurements, numbers)
  function skipToken(raw) {
    if (/\d/.test(raw)) return true;                 // has a digit (6in, 2x, b3)
    if (/^[A-Z][A-Z]{1,5}$/.test(raw)) return true;  // all-caps acronym up to 6 (DYCL, MUTCD)
    if (raw.length < 2) return true;
    return false;
  }

  // Check a string. Returns [{word, lower, start, end, suggestions}] — one entry
  // per distinct misspelling (first occurrence), in order of appearance.
  function check(text) {
    if (!DICT) throw new Error('Dictionary not loaded — call ready() first.');
    text = String(text || '');
    var re = /[A-Za-z][A-Za-z'’-]*/g, m, seen = {}, out = [];
    while ((m = re.exec(text))) {
      var raw = m[0];
      if (skipToken(raw)) continue;
      // split hy/apostrophe compounds; a token is OK if every part is known.
      var parts = raw.toLowerCase().replace(/[’]/g, "'").split(/[-']+/).filter(Boolean);
      var bad = null;
      for (var p = 0; p < parts.length; p++) {
        if (!known(parts[p])) { bad = parts[p]; break; }
      }
      if (!bad) continue;
      if (seen[raw]) continue;
      seen[raw] = 1;
      out.push({ word: raw, lower: bad, start: m.index, end: m.index + raw.length, suggestions: suggest(bad) });
    }
    return out;
  }

  // Convenience: ensure loaded, then check many {id, text} items → only those with issues.
  async function checkItems(items) {
    await ready();
    var res = [];
    (items || []).forEach(function (it) {
      var flags = check(it.text || '');
      if (flags.length) res.push({ id: it.id, text: it.text, flags: flags });
    });
    return res;
  }

  window.RW2Spell = {
    ready: ready, isLoaded: isLoaded, check: check, checkItems: checkItems,
    suggest: suggest, addAllowed: addAllowed
  };
})();
