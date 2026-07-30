/* Science Notes — read-aloud.
   Uses the browser's built-in speech synthesis. No audio files, no dependencies.
   Works from file:// and from GitHub Pages. */

(function () {
  'use strict';

  if (!('speechSynthesis' in window)) return;

  var synth = window.speechSynthesis;

  /* ---------------------------------------------------------------- state */

  var state = {
    units: [],        // Unit[] currently queued
    queue: [],        // {text, unitIndex}[] (TTS mode) or {src, unitIndex}[] (MP3 mode)
    qi: 0,            // index into queue
    playing: false,
    paused: false,
    scope: null,      // element whose LISTEN button is active, or null for whole page
    rate: 1,
    voice: null,
    readAnswers: true,
    mode: 'tts'        // 'tts' (speechSynthesis) or 'mp3' (pre-recorded, when available)
  };

  // Pre-recorded audio, one MP3 per extracted unit, keyed by page filename.
  // Falls back to the browser voice wherever a page has no manifest (e.g. right
  // after a note edit, before that page's MP3s have been regenerated).
  var mp3Manifest = null;    // { units: [{i, file}, ...] } | null | false (checked, absent)
  var audioEl = null;        // the single <audio> element used for MP3 playback

  function pageAudioDir() {
    return 'audio/' + location.pathname.replace(/^.*\//, '').replace(/\.html?$/, '') + '/';
  }

  function loadMp3Manifest() {
    return fetch(pageAudioDir() + 'manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { mp3Manifest = data || false; })
      .catch(function () { mp3Manifest = false; });
  }

  // Bumped on every stop/cancel. Callbacks from a previous generation are ignored,
  // otherwise cancel() fires onend on the in-flight utterance and playback revives.
  var gen = 0;

  var PREFS = {
    rate: 'whs-audio-rate',
    voice: 'whs-audio-voice',
    answers: 'whs-audio-answers'
  };

  function prefGet(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function prefSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }

  /* ----------------------------------------------------------- extraction */

  // Navigation, decoration and citations: present on the page, but not worth hearing.
  var SKIP_SEL = [
    '.onpage', '.backlink', '.chnav', '.alphabar', '.pm-items',
    '.src', '.gref', '.pages',
    'summary', 'svg', 'script', 'style', 'noscript',
    '.audio-ui'
  ].join(',');

  // Blocks that produce one utterance from their own children rather than being
  // walked into. Order matters: first match wins.
  var ATOMIC = [
    ['figure', readFigure],
    ['table', readTable],
    ['.q', readQuestion],
    ['.opts', readOpts],
    ['.recap li', readRecapItem],
    ['.stmts li', readStmtItem],
    ['dl', readDefList],
    ['.related', readRelated],
    ['.cgrid', readCgrid],
    ['.seealso', readSeeAlso],
    ['.pm-set > h3', readPmSetHeading]
  ];

  var LEAF_SEL = [
    'p', 'li', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4',
    'blockquote', 'figcaption',
    '.standfirst', '.eyebrow', '.fig-label', '.mistake-tag', '.examined-tag',
    '.beyond-tag', '.ans-badge', '.kl', '.lnk-title', '.lnk-desc', '.cg-ch',
    '.seealso', '.cpage-meta', '.footer-note', '.sec-num', '.unit-name',
    '.unit-count', '.ch-title', '.ch-desc', '.ch-num', '.pm-count', '.pm-total'
  ].join(',');

  /** @typedef {{el: Element, text: string, sentences: string[]}} Unit */

  function txt(node) {
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  // textContent turns <sup>3</sup> into a bare "3" ("cm3"). Read from a clone so
  // the live DOM is never touched.
  function deepText(el) {
    var clone = el.cloneNode(true);
    var sups = clone.querySelectorAll('sup');
    for (var i = 0; i < sups.length; i++) {
      var t = sups[i].textContent.trim();
      sups[i].replaceWith(document.createTextNode(t === '3' ? ' cubed' : (' ' + t)));
    }
    var drop = clone.querySelectorAll(SKIP_SEL);
    for (var j = 0; j < drop.length; j++) drop[j].remove();
    return txt(clone);
  }

  function normaliseText(s) {
    return s
      .replace(/\s*[→←]\s*$/, '')   // trailing arrow ("Open the practice app →") is pure decoration
      .replace(/·/g, ', ')          // · middot
      .replace(/[→←]/g, ' to ') // → ←  ("ice → water" = "ice to water")
      .replace(/×/g, ' times ')
      .replace(/÷/g, ' divided by ')
      .replace(/−/g, ' minus ')
      .replace(/³/g, ' cubed')
      .replace(/\bg\/cm cubed\b/gi, 'grams per cubic centimetre')
      .replace(/\bkg\/m cubed\b/gi, 'kilograms per cubic metre')
      .replace(/\bcm cubed\b/gi, 'cubic centimetres')
      .replace(/\bm cubed\b/gi, 'cubic metres')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Applied after sentence splitting: an em dash is a prosodic pause, but if it
  // were replaced before splitting the clauses would fragment.
  function softenDashes(s) {
    return s.replace(/\s*[–—]\s*/g, ', ').replace(/\s+/g, ' ').trim();
  }

  function makeUnit(el, raw) {
    var text = normaliseText(raw);
    if (!text || !/[a-z0-9]/i.test(text)) return null;
    return { el: el, text: text, sentences: splitSentences(text) };
  }

  /* --- atomic readers --- */

  function readFigure(fig) {
    var parts = [];
    var label = fig.querySelector('.fig-label');
    var svg = fig.querySelector('svg[aria-label]');
    var cap = fig.querySelector('figcaption');
    if (label) parts.push(txt(label) + '.');
    // The hand-written aria-labels are full spoken descriptions; the ~1400 <text>
    // nodes inside the SVG are positional fragments and would be gibberish.
    if (svg) parts.push(svg.getAttribute('aria-label').trim().replace(/\.?$/, '.'));
    if (cap) parts.push(deepText(cap));
    return makeUnit(fig, parts.join(' '));
  }

  function readTable(table) {
    var rows = Array.prototype.slice.call(table.rows);
    if (!rows.length) return null;
    var headers = [];
    var first = rows[0];
    var allTh = first.cells.length > 0;
    for (var c = 0; c < first.cells.length; c++) {
      if (first.cells[c].tagName !== 'TH') { allTh = false; break; }
    }
    if (allTh) {
      for (var h = 0; h < first.cells.length; h++) headers.push(txt(first.cells[h]));
      rows.shift();
    }
    var out = ['Table.'];
    rows.forEach(function (r) {
      var bits = [];
      for (var i = 0; i < r.cells.length; i++) {
        var val = deepText(r.cells[i]);
        if (!val) continue;
        var head = headers[i];
        // Comparison tables open with an empty <th></th>; that column is a row
        // label, so it is spoken bare.
        bits.push(head ? head + ', ' + val : val);
      }
      if (bits.length) out.push(bits.join('. ') + '.');
    });
    if (out.length === 1) return null;
    return makeUnit(table, out.join(' '));
  }

  function readQuestion(q) {
    var parts = [];
    var num = txt(q.querySelector('.q-num'));
    var body = q.querySelector('.q-text');
    // The number is kept here (unlike recap items) so the student can follow along.
    if (num) parts.push('Question ' + num + '.');
    if (body) parts.push(deepText(body));

    var stmts = q.querySelectorAll('.stmts li');
    for (var i = 0; i < stmts.length; i++) {
      var sn = txt(stmts[i].querySelector('.sn'));
      var st = stmtBody(stmts[i]);
      if (st) parts.push('Statement ' + (sn || (i + 1)) + ': ' + st);
    }

    var opts = q.querySelector('.opts');
    if (opts) parts.push(optsText(opts));

    if (state.readAnswers) {
      var ans = q.querySelector('.answer');
      if (ans) parts.push(deepText(ans));
    }
    return makeUnit(q, parts.join(' '));
  }

  function stmtBody(li) {
    var clone = li.cloneNode(true);
    var sn = clone.querySelector('.sn');
    if (sn) sn.remove();
    return txt(clone);
  }

  function readStmtItem(li) {
    var sn = txt(li.querySelector('.sn'));
    var body = stmtBody(li);
    if (!body) return null;
    return makeUnit(li, sn ? 'Statement ' + sn + ': ' + body : body);
  }

  // "A · 1,2,3" would otherwise be spoken as "A middot one comma two comma three".
  function optsText(opts) {
    var spans = opts.querySelectorAll('span');
    var out = [];
    for (var i = 0; i < spans.length; i++) {
      var s = txt(spans[i]);
      if (!s) continue;
      var m = s.split('·');
      if (m.length === 2) {
        var items = m[1].split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        var joined = items.length > 1
          ? items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
          : items.join('');
        out.push('Option ' + m[0].trim() + ': ' + joined + '.');
      } else {
        out.push(s + '.');
      }
    }
    return out.join(' ');
  }

  function readOpts(opts) {
    return makeUnit(opts, optsText(opts));
  }

  // The "01" counter before every recap question is noise when spoken.
  function readRecapItem(li) {
    var clone = li.cloneNode(true);
    var ck = clone.querySelector('.ck');
    if (ck) ck.remove();
    return makeUnit(li, txt(clone));
  }

  function readDefList(dl) {
    var parts = [];
    var kids = dl.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var t = deepText(el);
      if (!t) continue;
      parts.push(el.tagName === 'DT' ? t.replace(/[.:]?$/, '.') : t);
    }
    if (!parts.length) return null;
    return makeUnit(dl, parts.join(' '));
  }

  // Concept chips at the end of a chapter (bare <a> text, no leaf class of its
  // own) — without this reader the whole "go deeper" link list is silently
  // skipped, which would drop genuine written content.
  function readRelated(div) {
    var links = div.querySelectorAll('a');
    var names = [];
    for (var i = 0; i < links.length; i++) {
      var t = txt(links[i]);
      if (t) names.push(t);
    }
    if (!names.length) return null;
    var joined = names.length > 1
      ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
      : names[0];
    return makeUnit(div, 'Related ideas: ' + joined + '.');
  }

  // concepts.html index grid: "Force — Chapter 1", "Friction — Chapter 1", ...
  function readCgrid(div) {
    var links = div.querySelectorAll('a');
    var parts = [];
    for (var i = 0; i < links.length; i++) {
      var ch = links[i].querySelector('.cg-ch');
      var name = txt(links[i]).replace(ch ? txt(ch) : '', '').trim();
      if (!name) continue;
      parts.push(ch ? name + ', ' + txt(ch) + '.' : name + '.');
    }
    if (!parts.length) return null;
    return makeUnit(div, parts.join(' '));
  }

  // "See also: Chapter 14 — density comes from ... · open" — the trailing
  // "open" is a link label, not part of the sentence.
  function readSeeAlso(div) {
    var clone = div.cloneNode(true);
    var links = clone.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) links[i].remove();
    var t = txt(clone).replace(/·\s*$/, '');
    return makeUnit(div, t);
  }

  // practice-map.html: "Science 2026 2nd<span class=pm-count>12 questions</span>"
  // would otherwise run together as "Science 2026 2nd12 questions".
  function readPmSetHeading(h3) {
    var count = h3.querySelector('.pm-count');
    var name = txt(h3).replace(count ? txt(count) : '', '').trim();
    var parts = [name];
    if (count) parts.push(txt(count));
    return makeUnit(h3, parts.join(', '));
  }

  /* --- the walk --- */

  function isHidden(el) {
    if (!el.getClientRects || el.getClientRects().length) return false;
    var cs = window.getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function walk(node, out) {
    if (node.nodeType !== 1) return;
    var el = /** @type {Element} */ (node);

    if (el.matches(SKIP_SEL)) return;

    // A collapsed <details> is legitimate content, not decoration: it is read,
    // and speakUnit opens it so the highlight lands on something visible.
    var inClosedDetails = el.tagName === 'DETAILS' && !el.open;
    if (!inClosedDetails && isHidden(el)) return;

    if (el.tagName === 'DETAILS' && !state.readAnswers) return;

    for (var a = 0; a < ATOMIC.length; a++) {
      if (el.matches(ATOMIC[a][0])) {
        var u = ATOMIC[a][1](el);
        if (u) out.push(u);
        return; // children are covered by the synthesised text
      }
    }

    if (el.matches(LEAF_SEL)) {
      var leaf = makeUnit(el, deepText(el));
      if (leaf) out.push(leaf);
      return;
    }

    for (var i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i], out);
  }

  function extractUnits(root) {
    var out = [];
    walk(root, out);
    // A section heading and its .sec-num are adjacent leaves; merging avoids a
    // clipped "5.2" utterance of its own.
    return mergeShortNumbers(out);
  }

  // The MP3 manifest is generated once from a full-page extractUnits(contentRoot())
  // and its files are named by that array's position (000.mp3, 001.mp3, ...).
  // A section's own extractUnits(section) starts a fresh array at 0, which
  // would otherwise make every "LISTEN" button play from the page's first
  // MP3. Extracting the whole page up front and tagging every unit with its
  // page-wide position keeps that position available even after a unit list
  // is later filtered down to one section.
  var pageUnitsCache = null;

  function pageUnitsWithIndex() {
    if (!pageUnitsCache) {
      pageUnitsCache = extractUnits(contentRoot());
      pageUnitsCache.forEach(function (u, i) { u.pageIndex = i; });
    }
    return pageUnitsCache;
  }

  function sectionUnits(section) {
    return pageUnitsWithIndex().filter(function (u) { return section.contains(u.el); });
  }

  function mergeShortNumbers(units) {
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      // Anchored at both ends: this must match the WHOLE unit, not just its
      // start, or a unit already merged into ("Chapter 5. Floating...") would
      // match again and the merge would cascade through the entire page.
      var isNum = /^[0-9]+(\.[0-9]+)?$/.test(u.text) || /^(Chapter|Concepts)\s*[0-9]*$/i.test(u.text);
      // glossary.html repeats its single letter in both .sec-num and h2 ("A"
      // then "A") — drop the .sec-num copy rather than speak the letter twice.
      var isRepeatedLetter = /^[A-Z]$/.test(u.text) && units[i + 1] &&
        units[i + 1].text.toUpperCase() === u.text.toUpperCase();
      if (isRepeatedLetter) { continue; }
      if (isNum && units[i + 1]) {
        var next = units[i + 1];
        next.text = u.text.replace(/[.]?$/, '.') + ' ' + next.text;
        next.sentences = splitSentences(next.text);
        continue;
      }
      out.push(u);
    }
    return out;
  }

  // reading-diagrams.html carries a duplicated, truncated head and therefore two
  // .wrap elements; the first is an empty shell. Pick the one with real content.
  function contentRoot() {
    var wraps = document.querySelectorAll('.wrap');
    if (!wraps.length) return document.body;
    var best = wraps[0];
    for (var i = 1; i < wraps.length; i++) {
      if (wraps[i].textContent.trim().length > best.textContent.trim().length) best = wraps[i];
    }
    return best;
  }

  /* ------------------------------------------------- sentence splitting */

  // Hand-rolled rather than a lookbehind regex: lookbehind only reached Safari
  // 16.4, and a regex that fails to parse would kill the whole script silently.
  var ABBREV = ['e.g', 'i.e', 'etc', 'approx', 'vs', 'Dr', 'Mr', 'Mrs', 'Ms', 'St', 'Fig', 'No'];

  function splitSentences(text) {
    var out = [];
    var start = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;

      var next = text[i + 1];
      var prev = text[i - 1];

      // Decimals: "3.0 g/cm³", "1.5" are everywhere in these notes.
      if (ch === '.' && prev >= '0' && prev <= '9' && next >= '0' && next <= '9') continue;

      if (next && next !== ' ' && next !== '\n') continue;

      if (ch === '.') {
        var tail = text.slice(Math.max(0, i - 8), i);
        var word = tail.split(/[\s(]/).pop();
        if (ABBREV.indexOf(word) !== -1) continue;
        if (word.length === 1 && word >= 'A' && word <= 'Z') continue; // initials
      }

      var piece = text.slice(start, i + 1).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
    var rest = text.slice(start).trim();
    if (rest) out.push(rest);

    var chunked = [];
    out.forEach(function (s) {
      chunkLong(s).forEach(function (c) { chunked.push(c); });
    });
    return chunked.length ? chunked : [text];
  }

  // Chrome and some Android builds truncate utterances beyond a few hundred
  // characters, so nothing longer than MAX_CHARS is ever queued.
  var MAX_CHARS = 180;

  function chunkLong(s) {
    if (s.length <= MAX_CHARS) return [s];
    var out = [];
    var parts = s.split(/,\s+/);
    var buf = '';
    parts.forEach(function (p, idx) {
      var piece = idx < parts.length - 1 ? p + ',' : p;
      if ((buf + ' ' + piece).trim().length > MAX_CHARS && buf) {
        out.push(buf.trim());
        buf = piece;
      } else {
        buf = (buf ? buf + ' ' : '') + piece;
      }
    });
    if (buf.trim()) out.push(buf.trim());

    var final = [];
    out.forEach(function (p) {
      while (p.length > MAX_CHARS) {
        var cut = p.lastIndexOf(' ', MAX_CHARS);
        if (cut < 40) cut = MAX_CHARS;
        final.push(p.slice(0, cut).trim());
        p = p.slice(cut).trim();
      }
      if (p) final.push(p);
    });
    return final;
  }

  /* ------------------------------------------------------------- voices */

  var VOICE_PREFS = [
    'Karen',                                       // en-AU — chosen by ear over the
                                                   // en-GB options, which sounded
                                                   // flatter on this machine
    'Daniel', 'Serena', 'Kate',                    // en-GB, Apple
    'Google UK English Female', 'Google UK English Male',
    'Microsoft Libby Online (Natural) - English (United Kingdom)',
    'Microsoft Sonia Online (Natural) - English (United Kingdom)',
    'Samantha', 'Ava',                             // en-US Apple, good quality
    'Google US English'
  ];

  var allVoices = [];

  function pickVoice(voices, savedName) {
    if (!voices.length) return null;
    var byName = {};
    voices.forEach(function (v) { if (!byName[v.name]) byName[v.name] = v; });

    if (savedName && byName[savedName]) return byName[savedName];

    for (var i = 0; i < VOICE_PREFS.length; i++) {
      var want = VOICE_PREFS[i];
      if (byName[want]) return byName[want];
      for (var j = 0; j < voices.length; j++) {
        if (voices[j].name.indexOf(want) === 0) return voices[j];
      }
    }
    var langs = ['en-GB', 'en_GB', 'en-US', 'en'];
    for (var l = 0; l < langs.length; l++) {
      for (var k = 0; k < voices.length; k++) {
        if ((voices[k].lang || '').indexOf(langs[l]) === 0) return voices[k];
      }
    }
    return voices[0];
  }

  function loadVoices() {
    var done = false;
    function settle() {
      if (done) return;
      var v = synth.getVoices();
      if (!v.length) return;
      done = true;
      allVoices = v.filter(function (x) { return (x.lang || '').toLowerCase().indexOf('en') === 0; });
      if (!allVoices.length) allVoices = v;
      state.voice = pickVoice(allVoices, prefGet(PREFS.voice, null));
      buildVoiceMenu();
    }
    settle();
    if (!done) {
      synth.addEventListener('voiceschanged', settle);
      // Safari can populate voices without ever firing voiceschanged, so never
      // let the UI depend on that event alone.
      setTimeout(settle, 1500);
      setTimeout(settle, 4000);
    }
  }

  /* ---------------------------------------------------------- playback */

  var keepAlive = null;

  // Chrome stops speaking after roughly 15 seconds unless nudged.
  function startKeepAlive() {
    stopKeepAlive();
    keepAlive = setInterval(function () {
      if (!state.playing || state.paused) return;
      if (!synth.speaking) return;
      synth.pause();
      synth.resume();
    }, 10000);
  }
  function stopKeepAlive() {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }

  function buildTtsQueue(units) {
    var q = [];
    units.forEach(function (u, ui) {
      u.sentences.forEach(function (s) {
        var spoken = softenDashes(s);
        if (spoken) q.push({ text: spoken, unitIndex: ui });
      });
    });
    return q;
  }

  // One MP3 per unit — recorded units without an audio file (a page edited
  // since its last MP3 batch) are simply skipped in MP3 mode, not silently
  // dropped from the page: play() falls back to TTS whenever any are missing.
  function buildMp3Queue(units) {
    if (!mp3Manifest || !mp3Manifest.units) return null;
    var byIndex = {};
    mp3Manifest.units.forEach(function (m) { byIndex[m.i] = m.file; });
    var q = [];
    for (var ui = 0; ui < units.length; ui++) {
      // pageIndex (set by pageUnitsWithIndex()) is the position the MP3
      // filenames were generated from; a section's units keep that original
      // page-wide position even though they now sit at a different position
      // (ui) in this shorter, section-scoped array. Units built any other
      // way (e.g. future debug callers) fall back to their array position.
      var mi = units[ui].pageIndex !== undefined ? units[ui].pageIndex : ui;
      if (!(mi in byIndex)) return null; // incomplete manifest for this scope, don't mix modes
      q.push({ src: pageAudioDir() + byIndex[mi], unitIndex: ui });
    }
    return q;
  }

  function play(units, scopeEl) {
    stop();
    if (!units.length) return;
    state.units = units;

    var mp3Queue = buildMp3Queue(units);
    if (mp3Queue) {
      state.mode = 'mp3';
      state.queue = mp3Queue;
    } else {
      state.mode = 'tts';
      state.queue = buildTtsQueue(units);
    }

    state.qi = 0;
    state.scope = scopeEl || null;
    state.playing = true;
    state.paused = false;
    if (state.mode === 'tts') startKeepAlive();
    syncUI();
    playNext();
  }

  function playNext() {
    if (state.mode === 'mp3') playMp3Next(); else speakNext();
  }

  function ensureAudioEl() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.preload = 'auto';
    return audioEl;
  }

  function playMp3Next() {
    if (!state.playing) return;
    if (state.qi >= state.queue.length) { finish(); return; }

    var item = state.queue[state.qi];
    var unit = state.units[item.unitIndex];
    var myGen = gen;

    if (unit) highlightUnit(unit);

    var a = ensureAudioEl();
    a.onended = null; a.onerror = null;
    a.src = item.src;
    a.playbackRate = state.rate;

    a.onended = function () {
      if (myGen !== gen) return;
      state.qi++;
      playNext();
    };
    a.onerror = function () {
      if (myGen !== gen) return;
      state.qi++;
      playNext();
    };

    var p = a.play();
    if (p && p.catch) p.catch(function () { if (myGen === gen) { state.qi++; playNext(); } });
  }

  function speakNext() {
    if (!state.playing) return;
    if (state.qi >= state.queue.length) { finish(); return; }

    var item = state.queue[state.qi];
    var unit = state.units[item.unitIndex];
    var myGen = gen;

    if (unit) highlightUnit(unit);

    var u = new SpeechSynthesisUtterance(item.text);
    if (state.voice) u.voice = state.voice;
    // Some Android builds ignore .voice but honour .lang.
    u.lang = (state.voice && state.voice.lang) || 'en-GB';
    u.rate = state.rate;
    u.pitch = 1;

    u.onend = function () {
      if (myGen !== gen) return;
      state.qi++;
      speakNext();
    };
    u.onerror = function (e) {
      if (myGen !== gen) return;
      // 'interrupted'/'canceled' are the result of our own stop(); the generation
      // guard above already covers those.
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      state.qi++;
      speakNext();
    };

    try {
      synth.speak(u);
    } catch (err) {
      state.qi++;
      speakNext();
    }
  }

  function finish() {
    state.playing = false;
    state.paused = false;
    state.scope = null;
    stopKeepAlive();
    clearHighlight();
    syncUI();
  }

  function stop() {
    gen++;
    state.playing = false;
    state.paused = false;
    state.scope = null;
    state.queue = [];
    state.qi = 0;
    stopKeepAlive();
    try { synth.cancel(); } catch (e) {}
    if (audioEl) { try { audioEl.pause(); audioEl.onended = null; audioEl.onerror = null; } catch (e) {} }
    clearHighlight();
    syncUI();
  }

  function togglePause() {
    if (!state.playing) return;
    if (state.mode === 'mp3') {
      if (state.paused) { audioEl.play(); state.paused = false; }
      else { audioEl.pause(); state.paused = true; }
      syncUI();
      return;
    }
    if (state.paused) {
      synth.resume();
      state.paused = false;
      startKeepAlive();
    } else {
      synth.pause();
      state.paused = true;
      stopKeepAlive();
    }
    syncUI();
  }

  // Navigating between the 173 pages would otherwise leave the old page talking.
  function hardStop() {
    gen++;
    try { synth.cancel(); } catch (e) {}
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  }
  window.addEventListener('pagehide', hardStop);
  window.addEventListener('beforeunload', hardStop);

  /* -------------------------------------------------------- highlight */

  var currentEl = null;
  var userScrolling = false;
  var scrollTimer = null;

  ['wheel', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      userScrolling = true;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () { userScrolling = false; }, 3000);
    }, { passive: true });
  });

  function clearHighlight() {
    if (currentEl) currentEl.classList.remove('audio-current');
    currentEl = null;
  }

  function highlightUnit(unit) {
    if (currentEl === unit.el) return;
    clearHighlight();
    currentEl = unit.el;
    currentEl.classList.add('audio-current');

    // Reading an answer aloud while it is still folded would point the highlight
    // at nothing; opening it mirrors what the student's own click would do.
    var det = unit.el.closest && unit.el.closest('details');
    if (det && !det.open) det.open = true;

    if (userScrolling) return;
    var r = currentEl.getBoundingClientRect();
    var margin = 80;
    if (r.top < margin || r.bottom > window.innerHeight - margin) {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try {
        currentEl.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      } catch (e) {
        currentEl.scrollIntoView();
      }
    }
  }

  /* --------------------------------------------------------------- UI */

  var bar, btnPage, btnPause, btnStop, voiceSel, rateBtns = [];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeSectionButton(section, heading) {
    var b = el('button', 'audio-btn audio-ui');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Listen to section: ' + txt(heading));
    b.textContent = '▸ LISTEN';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (state.playing && state.scope === section) { stop(); return; }
      play(sectionUnits(section), section);
    });
    return b;
  }

  function mountSectionButtons() {
    var root = contentRoot();
    var heads = root.querySelectorAll('section > h2');
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var sec = h.parentElement;
      if (h.querySelector('.audio-btn')) continue;
      h.appendChild(makeSectionButton(sec, h));
    }
  }

  var settingsPanel, btnSettings;

  function mountBar() {
    bar = el('div', 'audio-bar audio-ui');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Read aloud controls');

    btnPage = el('button', 'audio-ctl audio-ctl-main');
    btnPage.type = 'button';
    btnPage.textContent = '▸ PLAY PAGE';
    btnPage.addEventListener('click', function () {
      if (state.playing && !state.scope) { stop(); return; }
      play(pageUnitsWithIndex(), null);
    });

    btnPause = el('button', 'audio-ctl');
    btnPause.type = 'button';
    btnPause.textContent = 'PAUSE';
    btnPause.addEventListener('click', togglePause);

    btnStop = el('button', 'audio-ctl');
    btnStop.type = 'button';
    btnStop.textContent = 'STOP';
    btnStop.addEventListener('click', stop);

    btnSettings = el('button', 'audio-ctl audio-gear');
    btnSettings.type = 'button';
    btnSettings.textContent = '⚙';
    btnSettings.setAttribute('aria-label', 'Voice and speed settings');
    btnSettings.setAttribute('aria-expanded', 'false');
    btnSettings.addEventListener('click', function () {
      var open = settingsPanel.classList.toggle('is-open');
      btnSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    bar.appendChild(btnPage);
    bar.appendChild(btnPause);
    bar.appendChild(btnStop);
    bar.appendChild(btnSettings);

    // Kept off the main row (voice name + speed + toggle would push the bar to
    // two lines on a phone-height viewport and cover the content behind it).
    settingsPanel = el('div', 'audio-settings');

    var rates = el('div', 'audio-rates');
    [0.75, 1, 1.25].forEach(function (r) {
      var rb = el('button', 'audio-ctl audio-rate');
      rb.type = 'button';
      rb.textContent = (r === 1 ? '1.0' : String(r)) + '×';
      rb.dataset.rate = String(r);
      rb.addEventListener('click', function () {
        state.rate = r;
        prefSet(PREFS.rate, String(r));
        syncUI();
        if (state.mode === 'mp3' && audioEl) {
          // <audio>.playbackRate applies immediately, no restart needed.
          audioEl.playbackRate = r;
        } else if (state.playing) {
          // speechSynthesis utterances can't change rate mid-flight; restart
          // from the current position so the change is audible right away.
          var units = state.units, scope = state.scope, at = state.qi;
          var savedQueue = state.queue.slice();
          gen++;
          try { synth.cancel(); } catch (e) {}
          state.units = units; state.queue = savedQueue; state.qi = at;
          state.scope = scope; state.playing = true; state.paused = false;
          startKeepAlive();
          speakNext();
        }
      });
      rateBtns.push(rb);
      rates.appendChild(rb);
    });

    voiceSel = el('select', 'audio-voice');
    voiceSel.setAttribute('aria-label', 'Voice');
    voiceSel.addEventListener('change', function () {
      var v = allVoices.filter(function (x) { return x.name === voiceSel.value; })[0];
      if (v) { state.voice = v; prefSet(PREFS.voice, v.name); }
    });

    var ansWrap = el('label', 'audio-toggle');
    var ansBox = el('input');
    ansBox.type = 'checkbox';
    ansBox.checked = state.readAnswers;
    ansBox.addEventListener('change', function () {
      state.readAnswers = ansBox.checked;
      prefSet(PREFS.answers, ansBox.checked ? '1' : '0');
    });
    ansWrap.appendChild(ansBox);
    ansWrap.appendChild(el('span', null, 'read answers'));

    settingsPanel.appendChild(rates);
    settingsPanel.appendChild(voiceSel);
    settingsPanel.appendChild(ansWrap);
    bar.appendChild(settingsPanel);

    document.addEventListener('click', function (e) {
      if (!settingsPanel.classList.contains('is-open')) return;
      if (bar.contains(e.target)) return;
      settingsPanel.classList.remove('is-open');
      btnSettings.setAttribute('aria-expanded', 'false');
    });

    document.body.appendChild(bar);
  }

  function buildVoiceMenu() {
    if (!voiceSel) return;
    voiceSel.innerHTML = '';
    allVoices.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name.replace(/\s*\(.*?\)\s*$/, '') + (v.lang ? ' · ' + v.lang : '');
      voiceSel.appendChild(o);
    });
    if (state.voice) voiceSel.value = state.voice.name;
  }

  function syncUI() {
    if (!bar) return;
    btnPage.textContent = (state.playing && !state.scope) ? '■ STOP PAGE' : '▸ PLAY PAGE';
    btnPause.textContent = state.paused ? 'RESUME' : 'PAUSE';
    btnPause.disabled = !state.playing;
    btnStop.disabled = !state.playing;
    bar.classList.toggle('is-playing', state.playing);

    rateBtns.forEach(function (rb) {
      rb.classList.toggle('is-on', parseFloat(rb.dataset.rate) === state.rate);
    });

    var btns = document.querySelectorAll('.audio-btn');
    for (var i = 0; i < btns.length; i++) {
      var sec = btns[i].closest('section');
      var on = state.playing && state.scope === sec;
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      btns[i].textContent = on ? '■ STOP' : '▸ LISTEN';
    }
  }

  /* ------------------------------------------------------------- init */

  function init() {
    state.rate = parseFloat(prefGet(PREFS.rate, '1')) || 1;
    state.readAnswers = prefGet(PREFS.answers, '1') !== '0';

    mountSectionButtons();
    mountBar();
    syncUI();
    // Deliberately after the UI: a slow or silent voice list must never leave
    // the buttons dead, and a slow/missing MP3 manifest must not either — play()
    // falls back to the browser voice if the manifest hasn't resolved yet.
    loadVoices();
    loadMp3Manifest();

    // Debug helper for verifying extraction against the page.
    window.__dumpUnits = function (sel) {
      var root = sel ? document.querySelector(sel) : contentRoot();
      var units = extractUnits(root);
      console.log(units.length + ' units');
      units.forEach(function (u, i) { console.log(i, u.el.tagName + '.' + u.el.className, u.text); });
      return units;
    };
    window.__audioDebugMode = function () { return state.mode; };
    window.__audioDebugState = function () {
      return { mode: state.mode, playing: state.playing, qi: state.qi, queueLen: state.queue.length,
        manifest: mp3Manifest, audioSrc: audioEl && audioEl.src, audioError: audioEl && audioEl.error };
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
