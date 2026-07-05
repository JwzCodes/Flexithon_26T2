/*
 * FocusRead — content script
 *
 * Magnifies the word under the cursor (+ same-line neighbours) IN PLACE
 * over the dimmed paragraph. Zero layout movement while reading: word
 * wrapping (which applies the extra word spacing and the OpenDyslexic
 * font) happens ONCE at page load, never on hover.
 *
 * Features (each independently toggleable):
 *   - Word focus  (always on while enabled)
 *   - Reading ruler (Option/Ctrl+R): spotlights the current line, dims
 *     the whole page — the word magnifier keeps working inside the band.
 *   - Bionic reading (Option/Ctrl+B): bolds word prefixes page-wide.
 *
 * Navigation:
 *   - Mouse hover (snaps to the nearest word, with a switching dead
 *     zone so focus doesn't flicker), OR
 *   - Arrow keys: Left/Right = previous/next word,
 *                 Up/Down    = previous/next visual line (keeps column).
 *     Keyboard focus is sticky: small accidental trackpad movements
 *     won't steal it; deliberate mouse movement (>15px) takes over.
 *
 * On/off: floating "Aa" button, Option/Alt+D, or Ctrl+D.
 */
(() => {
  'use strict';

  const MOUSE_TAKEOVER_PX = 15;
  const RULER_PAD = 4;      // px of breathing room around the ruler line

  // Elements we treat as a "paragraph" (the dimming context).
  const BLOCK_SELECTOR = 'p, li, dd, dt, blockquote, caption, figcaption';

  // Never wrap words inside these.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'CODE', 'PRE', 'KBD', 'SAMP', 'MATH', 'SVG', 'BUTTON'
  ]);

  let enabled = true;
  let bionic = false;       // bold word-prefixes for faster fixation
  let dysFont = false;      // OpenDyslexic font on wrapped words
  let ruler = false;        // line-spotlight mode
  let rulerEls = null;      // { top, bottom, band } overlay divs
  let activeBlock = null;   // block currently dimmed / rulered
  let activeBg = '#fff';    // page background behind activeBlock
  let focusSpan = null;     // word span currently magnified
  let decorated = [];       // spans holding .fr-focus / .fr-near right now
  let keyboardNav = false;  // true while arrow keys own the focus
  let anchorX = 0;          // mouse pos when keyboard took over
  let anchorY = 0;
  let rafPending = false;
  let lastX = 0;
  let lastY = 0;

  const processed = new WeakSet(); // blocks already word-wrapped

  /* ---------------------------------------------------------- wrapping */

  // OpenDyslexic font, loaded from the extension bundle. Guarded so the
  // script still works outside the extension (demo.html, tests), where
  // chrome.runtime / FontFace aren't available.
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime &&
        chrome.runtime.getURL && typeof FontFace !== 'undefined') {
      const font = new FontFace(
        'OpenDyslexic',
        `url(${chrome.runtime.getURL('fonts/OpenDyslexic-Regular.otf')})`
      );
      font.load().then((loadedFont) => {
        document.fonts.add(loadedFont);
        console.log('OpenDyslexic loaded');
      }).catch((error) => {
        console.error('OpenDyslexic failed to load:', error);
      });
    }
  } catch (e) {
    console.warn('OpenDyslexic skipped (not running as an extension)');
  }

  // The area we operate in — keeps the effect (and the word spacing /
  // font change) out of navigation menus and sidebars.
  function contentRoot() {
    return document.querySelector(
      'main, article, [role="main"], #content, #main'
    ) || document.body;
  }

  function wrapWords(block) {
    if (processed.has(block)) return;
    processed.add(block);

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent ||
          SKIP_TAGS.has(parent.tagName) ||
          parent.closest('.fr-word') ||
          parent.closest(
            '.fr-toast, .fr-controls, .fr-tts-panel, .fr-finder'
          )) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const frag = document.createDocumentFragment();
      // Split on whitespace but keep it, so spacing is preserved exactly.
      for (const part of node.nodeValue.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.className = 'fr-word';
          span.textContent = part;
          frag.appendChild(span);
        }
      }
      node.parentNode.replaceChild(frag, node);
    }

    // Late-wrapped blocks (dynamic content) pick up bionic styling too.
    if (bionic) {
      block.querySelectorAll('.fr-word:not([data-fr-bio])')
        .forEach(applyBionic);
    }
  }

  // Wrap the whole content area ONCE, up front. The word spacing and
  // font apply in a single pass at load, so hovering a paragraph later
  // never reflows anything.
  function wrapAll() {
    for (const b of allBlocks()) {
      if (isUsable(b)) wrapWords(b);
    }
  }

  /* ----------------------------------------------------------- bionic */

  // Bold roughly the first half of the word — the eye fixates on the
  // bold prefix and infers the rest, which many readers find faster.
  function applyBionic(span) {
    if (span.hasAttribute('data-fr-bio')) return;
    span.setAttribute('data-fr-bio', '1');
    const text = span.textContent;
    // leading punctuation | letters/digits | the rest
    const m = text.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}]+)([\s\S]*)$/u);
    if (!m) return;
    const n = Math.ceil(m[2].length / 2);
    span.textContent = '';
    if (m[1]) span.appendChild(document.createTextNode(m[1]));
    const b = document.createElement('b');
    b.className = 'fr-bio';
    b.textContent = m[2].slice(0, n);
    span.appendChild(b);
    span.appendChild(document.createTextNode(m[2].slice(n) + m[3]));
  }

  function removeBionic(span) {
    span.textContent = span.textContent; // flatten — drops the <b>
    span.removeAttribute('data-fr-bio');
  }

  function setBionic(on) {
    bionic = on;
    if (on) {
      wrapAll();
      document.querySelectorAll('.fr-word:not([data-fr-bio])')
        .forEach(applyBionic);
    } else {
      document.querySelectorAll('.fr-word[data-fr-bio]')
        .forEach(removeBionic);
    }
    if (bioBtn) bioBtn.classList.toggle('fr-on', on);
    showToast(on ? 'Bionic reading: on' : 'Bionic reading: off');
  }

  /* ------------------------------------------------- OpenDyslexic font */

  function setDysFont(on) {
    dysFont = on;
    if (on) wrapAll(); // font applies via .fr-word spans
    document.body.classList.toggle('fr-font', on);
    if (fontBtn) fontBtn.classList.toggle('fr-on', on);
    showToast(on ? 'OpenDyslexic: on' : 'OpenDyslexic: off');
  }

  /* ------------------------------------------------------ focus logic */

  function wordsOf(block) {
    return Array.prototype.slice.call(block.querySelectorAll('.fr-word'));
  }

  // First non-transparent background colour behind an element.
  function pageBackground(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
      n = n.parentElement;
    }
    return '#fff';
  }

  // Magnify in place: no layout change ever. Paint the page background
  // behind the scaled word so dimmed text underneath doesn't show through.
  function decorate(span, cls) {
    span.style.backgroundColor = activeBg;
    span.style.boxShadow = '0 0 0 2px ' + activeBg;
    span.style.borderRadius = '3px';
    span.classList.add(cls);
    decorated.push(span);
  }

  function clearDecorations() {
    for (const s of decorated) {
      s.classList.remove('fr-focus', 'fr-near', 'fr-line');
      s.style.backgroundColor = '';
      s.style.boxShadow = '';
      s.style.borderRadius = '';
    }
    decorated = [];
  }

  function deactivateBlock() {
    if (activeBlock) activeBlock.classList.remove('fr-active');
    activeBlock = null;
    clearDecorations();
    focusSpan = null;
  }

  // Mouse candidate with a switching dead zone: only considers words on
  // the line under the cursor, and keeps the current word unless the new
  // one is clearly closer — so focus doesn't flicker at word boundaries.
  function getStableFocusedWord(block, mouseX, mouseY) {
    const words = wordsOf(block);
    if (!words.length) return null;

    let bestWord = null;
    let bestDistance = Infinity;

    for (const word of words) {
      const rect = word.getBoundingClientRect();

      // Ignore words that are not on the same line as the mouse.
      if (mouseY < rect.top - 4 || mouseY > rect.bottom + 4) {
        continue;
      }

      const centreX = rect.left + rect.width / 2;
      const distance = Math.abs(mouseX - centreX);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestWord = word;
      }
    }

    if (!bestWord) return focusSpan;

    const rect = bestWord.getBoundingClientRect();
    const switchThreshold = Math.max(8, rect.width * 0.15);

    if (focusSpan && bestWord !== focusSpan) {
      const currentRect = focusSpan.getBoundingClientRect();
      // The dead zone only applies while the mouse is still on the
      // current word's line — once it moves to another line, switch.
      const sameLine = mouseY >= currentRect.top - 4 &&
                       mouseY <= currentRect.bottom + 4;
      if (sameLine) {
        const currentCentreX = currentRect.left + currentRect.width / 2;
        const currentDistance = Math.abs(mouseX - currentCentreX);
        // Only switch if the new word is clearly closer.
        if (bestDistance + switchThreshold > currentDistance) {
          return focusSpan;
        }
      }
    }

    return bestWord;
  }

  // Nearest word to a point: line proximity dominates, then horizontal
  // distance. Fallback when the cursor isn't on any line of the block.
  function nearestWord(block, x, y) {
    let best = null;
    let bestScore = Infinity;
    for (const s of wordsOf(block)) {
      const r = s.getBoundingClientRect();
      const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
      const score = dy * 1000 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  function focusWord(block, span) {
    if (block !== activeBlock) {
      if (activeBlock) activeBlock.classList.remove('fr-active');
      activeBlock = block;
      activeBg = pageBackground(block);
      // Paragraph dim (with its fade-in) applies in ruler mode too, so
      // the focused word keeps the same visual hierarchy inside the band.
      block.classList.add('fr-active');
    }
    clearDecorations();
    const list = wordsOf(block);
    const i = list.indexOf(span);
    if (i === -1) return;

    // Find words on the same VISUAL LINE as the focused word (compare
    // vertical midpoints — all spans are undecorated right now, so the
    // measurements are clean). The current line is kept brighter, and
    // neighbours are only magnified if they share the line: the last
    // word of a line shouldn't drag the next line's first word along.
    const fr = span.getBoundingClientRect();
    const mid = fr.top + fr.height / 2;
    for (const s of list) {
      if (s === span) continue;
      const r = s.getBoundingClientRect();
      if (Math.abs(r.top + r.height / 2 - mid) < fr.height * 0.6) {
        s.classList.add('fr-line');
        decorated.push(s);
      }
    }
    const onLine = (s) => s.classList.contains('fr-line');

    if (i > 0 && onLine(list[i - 1])) {
      decorate(list[i - 1], 'fr-near');
    }
    if (i < list.length - 1 && onLine(list[i + 1])) {
      decorate(list[i + 1], 'fr-near');
    }
    decorate(span, 'fr-focus');
    focusSpan = span;

    if (ruler) syncRulerBand();
  }

  /* ------------------------------------------------------ ruler mode */

  function makeRuler() {
    const mk = (cls) => {
      const d = document.createElement('div');
      d.className = cls;
      document.body.appendChild(d);
      return d;
    };
    rulerEls = {
      top: mk('fr-ruler-mask fr-ruler-top'),
      bottom: mk('fr-ruler-mask fr-ruler-bottom'),
      band: mk('fr-ruler-band')
    };
  }

  function positionRuler(top, height) {
    if (!rulerEls) return;
    rulerEls.top.style.height = Math.max(0, top) + 'px';
    rulerEls.bottom.style.top = (top + height) + 'px';
    rulerEls.band.style.top = top + 'px';
    rulerEls.band.style.height = height + 'px';
  }

  // Group a block's words into visual lines: [{ top, bottom, span }] in
  // reading order, where span is the line's first word.
  function blockLines(block) {
    const lines = [];
    for (const s of wordsOf(block)) {
      const r = s.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      let ln = null;
      for (const L of lines) {
        if (Math.abs((L.top + L.bottom) / 2 - mid) < r.height * 0.6) {
          ln = L;
          break;
        }
      }
      if (ln) {
        ln.top = Math.min(ln.top, r.top);
        ln.bottom = Math.max(ln.bottom, r.bottom);
      } else {
        lines.push({ top: r.top, bottom: r.bottom, span: s });
      }
    }
    lines.sort((a, b) => a.top - b.top);
    return lines;
  }

  function lineOfSpan(block, span) {
    const r = span.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const lines = blockLines(block);
    for (const L of lines) {
      if (Math.abs((L.top + L.bottom) / 2 - mid) < r.height * 0.6) return L;
    }
    return { top: r.top, bottom: r.bottom, span };
  }

  // Glue the spotlight band to the focused word's line.
  function syncRulerBand() {
    if (!ruler || !focusSpan || !activeBlock) return;
    const L = lineOfSpan(activeBlock, focusSpan);
    positionRuler(L.top - RULER_PAD, (L.bottom - L.top) + RULER_PAD * 2);
  }

  // Mouse-driven ruler: word focus keeps working, band follows its line.
  function rulerUpdate() {
    let el = document.elementFromPoint(lastX, lastY);
    const root = contentRoot();
    let block = el ? el.closest(BLOCK_SELECTOR) : null;
    if (block && !root.contains(block)) block = null;

    if (block) {
      wrapWords(block);
      el = document.elementFromPoint(lastX, lastY);
      let word = el ? el.closest('.fr-word') : null;
      if (!word) word = getStableFocusedWord(block, lastX, lastY);
      if (word && !block.contains(word)) word = null;
      if (!word) word = nearestWord(block, lastX, lastY);
      if (word) {
        if (word !== focusSpan || block !== activeBlock) {
          focusWord(block, word);
        }
        syncRulerBand();
        return;
      }
    }
    // Not over text: free-floating band centred on the cursor.
    deactivateBlock();
    positionRuler(lastY - 16, 32);
  }

  function setRuler(on) {
    ruler = on;
    if (!rulerEls) makeRuler();
    if (on) {
      if (focusSpan) syncRulerBand();
      else rulerUpdate();
    }
    document.body.classList.toggle('fr-ruler-on', ruler && enabled);
    if (rulerBtn) rulerBtn.classList.toggle('fr-on', on);
    showToast(on ? 'Ruler: on' : 'Ruler: off');
  }

  /* ------------------------------------------------------ tint overlay */

  // Pastel screen tints (coloured-overlay style). mix-blend multiply
  // turns white backgrounds into the tint while text stays dark.
  const TINTS = [
    null,
    { name: 'Cream', color: '#fff3d6' },
    { name: 'Mint',  color: '#e3f3e6' },
    { name: 'Sky',   color: '#dfeefb' },
    { name: 'Rose',  color: '#fbe4ec' }
  ];
  let tintIndex = 0;
  let tintEl = null;

  function setTint(i) {
    tintIndex = ((i % TINTS.length) + TINTS.length) % TINTS.length;
    if (!tintEl) {
      tintEl = document.createElement('div');
      tintEl.className = 'fr-tint';
      document.body.appendChild(tintEl);
    }
    const t = TINTS[tintIndex];
    if (t) {
      tintEl.style.backgroundColor = t.color;
      tintEl.style.display = 'block';
    } else {
      tintEl.style.display = 'none';
    }
    if (tintBtn) tintBtn.classList.toggle('fr-on', !!t);
    showToast(t ? 'Tint: ' + t.name : 'Tint: off');
  }

  /* ------------------------------------------------------------- TTS */

  let ttsOn = false;
  let wpm = 180;            // words per minute (rate 1 ≈ 180 wpm)
  let ttsUtter = null;      // current utterance (identity check in onend)
  let ttsBlock = null;
  let ttsIndex = 0;         // word index currently being spoken — the
                            // source of truth for the TTS position,
                            // independent of the hover focus

  function ttsSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window &&
           typeof SpeechSynthesisUtterance !== 'undefined';
  }

  // Speak a block from the given word index; the focus highlight (and
  // the ruler band, if on) follows the spoken word via boundary events.
  function speakFrom(block, startIndex) {
    const list = wordsOf(block);
    if (!list.length) { ttsStop(); return; }
    if (startIndex < 0 || startIndex >= list.length) startIndex = 0;

    const words = list.map((s) => s.textContent);
    const offsets = [];
    let pos = 0;
    for (const w of words) {
      offsets.push(pos);
      pos += w.length + 1;
    }
    const base = offsets[startIndex];
    const u = new SpeechSynthesisUtterance(words.slice(startIndex).join(' '));
    u.rate = Math.min(4, Math.max(0.5, wpm / 180));

    u.onboundary = (ev) => {
      if (ev.name && ev.name !== 'word') return;
      const abs = base + ev.charIndex;
      let idx = startIndex;
      for (let k = startIndex; k < offsets.length; k++) {
        if (offsets[k] <= abs) idx = k;
        else break;
      }
      ttsIndex = idx;
      focusWord(block, list[idx]);
      follow();
    };

    u.onend = () => {
      if (!ttsOn || ttsUtter !== u) return; // cancelled / superseded
      const nb = adjacentBlock(block, 1);
      if (nb) speakFrom(nb, 0);             // read on into the next block
      else ttsStop();
    };

    ttsUtter = u;
    ttsBlock = block;
    ttsIndex = startIndex;
    window.speechSynthesis.speak(u);
  }

  function ttsStart() {
    if (!ttsSupported()) {
      showToast('TTS not supported in this browser');
      return;
    }
    let block = activeBlock;
    let start = 0;
    if (block && focusSpan) start = wordsOf(block).indexOf(focusSpan);
    if (!block) block = firstVisibleBlock();
    if (!block) return;

    ttsOn = true;
    engageKeyboard(); // the highlight follows speech, not the mouse
    if (ttsBtn) {
      ttsBtn.classList.add('fr-on');
      ttsBtn.textContent = '◼';
    }
    if (ttsPanel) ttsPanel.classList.add('fr-show');
    positionTtsPanel();
    window.speechSynthesis.cancel();
    speakFrom(block, Math.max(0, start));
  }

  function ttsStop() {
    ttsOn = false;
    ttsUtter = null;
    ttsBlock = null;
    if (ttsSupported()) window.speechSynthesis.cancel();
    if (ttsBtn) {
      ttsBtn.classList.remove('fr-on');
      ttsBtn.textContent = '▶';
    }
    if (ttsPanel) ttsPanel.classList.remove('fr-show');
  }

  // Rate can't change mid-utterance: restart from the CURRENT SPOKEN
  // word (ttsIndex) — never from the hover focus, which the slider drag
  // itself may have moved.
  function ttsSetWpm(value) {
    wpm = value;
    if (ttsLabel) ttsLabel.textContent = wpm + ' wpm';
    if (ttsOn && ttsBlock) {
      ttsUtter = null; // invalidate before cancel so onend doesn't chain
      window.speechSynthesis.cancel();
      speakFrom(ttsBlock, Math.max(0, ttsIndex));
    }
  }

  /* --------------------------------------------- word finder (hotkey) */
  //
  // Tip-of-the-tongue helper: describe the word you can't remember,
  // get candidate words back. Option/Ctrl+K.
  //
  // Engines:
  //  - Default: Datamuse reverse dictionary (free, NO API key needed —
  //    the demo can never fail because of a missing/blocked key).
  //  - Optional: Claude, if the user pastes their own API key at
  //    runtime. The key lives ONLY in chrome.storage.local (or
  //    localStorage in demo.html). IT IS NEVER WRITTEN INTO THIS REPO.

  let finderEl = null;
  let finderInput = null;
  let finderResults = null;
  let finderStatus = null;
  let finderKeyLink = null;
  let finderOpen = false;

  function getApiKey() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage &&
            chrome.storage.local) {
          chrome.storage.local.get(['anthropicKey'],
            (v) => resolve((v && v.anthropicKey) || ''));
          return;
        }
      } catch (e) { /* fall through */ }
      try {
        resolve(window.localStorage.getItem('fr-anthropic-key') || '');
      } catch (e) {
        resolve('');
      }
    });
  }

  function storeApiKey(key) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage &&
          chrome.storage.local) {
        if (key) chrome.storage.local.set({ anthropicKey: key });
        else chrome.storage.local.remove('anthropicKey');
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      if (key) window.localStorage.setItem('fr-anthropic-key', key);
      else window.localStorage.removeItem('fr-anthropic-key');
    } catch (e) { /* ignore */ }
  }

  async function datamuseWords(desc) {
    const r = await fetch(
      'https://api.datamuse.com/words?max=15&ml=' + encodeURIComponent(desc)
    );
    if (!r.ok) throw new Error('datamuse ' + r.status);
    const j = await r.json();
    // Suggesting back a word the user already typed is useless (e.g.
    // "pen" for "wooden pen") — drop query words and dedupe.
    const queryWords = new Set(
      desc.toLowerCase().split(/\s+/).filter(Boolean)
    );
    const seen = new Set();
    const out = [];
    for (const x of j) {
      const w = x.word.toLowerCase();
      if (queryWords.has(w) || seen.has(w)) continue;
      seen.add(w);
      out.push(x.word);
      if (out.length >= 8) break;
    }
    return out;
  }

  async function claudeWords(desc, key) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        system: 'Someone with dyslexia is trying to recall a word they ' +
          'can only describe. Reply with ONLY a comma-separated list of ' +
          '5-8 candidate words, most likely first. No other text.',
        messages: [{ role: 'user', content: desc }]
      })
    });
    if (!r.ok) throw new Error('claude ' + r.status);
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    return text.split(/[,\n]/)
      .map((s) => s.trim().replace(/^\d+[.)]\s*/, ''))
      .filter(Boolean)
      .slice(0, 8);
  }

  async function findWords(desc) {
    const key = await getApiKey();
    if (key) {
      try {
        return await claudeWords(desc, key);
      } catch (e) {
        // fall back silently — the demo must not die on a bad key
      }
    }
    return datamuseWords(desc);
  }

  function renderFinderResults(words) {
    finderResults.textContent = '';
    for (const w of words) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'fr-finder-chip';
      chip.textContent = w;
      chip.title = 'Click to copy (and hear) this word';
      chip.addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(w);
        } catch (e) { /* clipboard unavailable */ }
        if (ttsSupported() && !ttsOn) {
          const u = new SpeechSynthesisUtterance(w);
          u.rate = 0.9;
          window.speechSynthesis.speak(u);
        }
        showToast('Copied: ' + w);
      });
      finderResults.appendChild(chip);
    }
  }

  async function submitFinder() {
    const desc = finderInput.value.trim();
    if (!desc) return;
    finderStatus.textContent = 'Thinking…';
    finderResults.textContent = '';
    try {
      const words = await findWords(desc);
      const hasKey = !!(await getApiKey());
      if (!words.length) {
        finderStatus.textContent =
          'No matches — describe what it DOES or is FOR ' +
          '(e.g. "wooden tool you write with").';
      } else if (hasKey) {
        finderStatus.textContent = 'Click a word to copy it:';
      } else {
        finderStatus.textContent =
          'Click a word to copy it. Not there? Describe what it does ' +
          '— or add a Claude key (link below) for smarter matching.';
      }
      renderFinderResults(words);
    } catch (e) {
      finderStatus.textContent =
        'Could not reach the word service — check your connection.';
    }
  }

  async function updateFinderKeyLink() {
    if (!finderKeyLink) return;
    const key = await getApiKey();
    finderKeyLink.textContent = key
      ? 'Engine: Claude (your key) · remove key'
      : 'Engine: Datamuse (no key) · use Claude with your own API key…';
  }

  function makeFinder() {
    finderEl = document.createElement('div');
    finderEl.className = 'fr-finder';

    const title = document.createElement('div');
    title.className = 'fr-finder-title';
    title.textContent = 'Find the word on the tip of your tongue';
    finderEl.appendChild(title);

    finderInput = document.createElement('input');
    finderInput.type = 'text';
    finderInput.className = 'fr-finder-input';
    finderInput.placeholder =
      'What does it do? e.g. "wooden tool you write with"';
    finderInput.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.preventDefault();
        submitFinder();
      }
      e.stopPropagation(); // typing must not trigger reader shortcuts
    });
    finderEl.appendChild(finderInput);

    finderStatus = document.createElement('div');
    finderStatus.className = 'fr-finder-status';
    finderStatus.textContent = 'Press Enter to search. Esc closes.';
    finderEl.appendChild(finderStatus);

    finderResults = document.createElement('div');
    finderResults.className = 'fr-finder-results';
    finderEl.appendChild(finderResults);

    finderKeyLink = document.createElement('button');
    finderKeyLink.type = 'button';
    finderKeyLink.className = 'fr-finder-key';
    finderKeyLink.addEventListener('click', async () => {
      const existing = await getApiKey();
      if (existing) {
        storeApiKey('');
        showToast('Claude key removed');
      } else {
        const k = window.prompt(
          'Paste your Anthropic API key.\n' +
          'Stored only in your browser — never in the code or repo.'
        );
        if (k && k.trim()) {
          storeApiKey(k.trim());
          showToast('Claude key saved (browser storage only)');
        }
      }
      updateFinderKeyLink();
    });
    finderEl.appendChild(finderKeyLink);
    updateFinderKeyLink();

    document.body.appendChild(finderEl);
  }

  function openFinder() {
    if (!finderEl) makeFinder();
    finderOpen = true;
    finderEl.classList.add('fr-show');
    finderInput.value = '';
    finderResults.textContent = '';
    finderStatus.textContent = 'Press Enter to search. Esc closes.';
    finderInput.focus();
  }

  function closeFinder() {
    finderOpen = false;
    if (finderEl) finderEl.classList.remove('fr-show');
  }

  /* -------------------------------------------------- mouse navigation */

  function update() {
    rafPending = false;
    if (!enabled) return;

    // While reading aloud, the highlight belongs to the speech — the
    // mouse must not move or clear it (clicking still seeks).
    if (ttsOn) {
      if (ruler) syncRulerBand();
      return;
    }

    if (ruler) {
      // Keyboard owns the focus: just keep the band glued (e.g. after
      // scrolling); otherwise follow the mouse.
      if (keyboardNav && focusSpan) syncRulerBand();
      else rulerUpdate();
      return;
    }

    if (keyboardNav) return;

    let el = document.elementFromPoint(lastX, lastY);
    const root = contentRoot();
    let block = el ? el.closest(BLOCK_SELECTOR) : null;
    if (block && !root.contains(block)) block = null;

    if (!block) {
      deactivateBlock();
      return;
    }

    wrapWords(block);
    // Re-query: wrapping may have changed what's under the cursor.
    el = document.elementFromPoint(lastX, lastY);
    let word = el ? el.closest('.fr-word') : null;

    // Between words: stable pick with a dead zone (no flicker), then
    // nearest-word snapping as the final fallback.
    if (!word) word = getStableFocusedWord(block, lastX, lastY);
    if (word && !block.contains(word)) word = null;
    if (!word) word = nearestWord(block, lastX, lastY);

    if (word === focusSpan && block === activeBlock) return;

    if (!word) {
      // Block with no words at all: just dim it.
      if (block !== activeBlock) {
        deactivateBlock();
        activeBlock = block;
        activeBg = pageBackground(block);
        block.classList.add('fr-active');
      }
      return;
    }

    focusWord(block, word);
  }

  /* ----------------------------------------------- keyboard navigation */

  function allBlocks() {
    return Array.prototype.slice.call(
      contentRoot().querySelectorAll(BLOCK_SELECTOR)
    );
  }

  function isUsable(block) {
    if (!block.textContent.trim()) return false;
    const r = block.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Next/previous usable block in document order (wraps words as it goes).
  function adjacentBlock(block, dir) {
    const all = allBlocks();
    let i = all.indexOf(block);
    if (i === -1) return null;
    while (true) {
      i += dir;
      if (i < 0 || i >= all.length) return null;
      const b = all[i];
      if (!isUsable(b)) continue;
      wrapWords(b);
      if (b.querySelector('.fr-word')) return b;
    }
  }

  function firstVisibleBlock() {
    for (const b of allBlocks()) {
      if (!isUsable(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) {
        wrapWords(b);
        if (b.querySelector('.fr-word')) return b;
      }
    }
    return null;
  }

  // Begin keyboard focus: block under the mouse, else first on screen.
  function startFocus() {
    const el = document.elementFromPoint(lastX, lastY);
    let block = el ? el.closest(BLOCK_SELECTOR) : null;
    if (block && !contentRoot().contains(block)) block = null;
    if (block) {
      wrapWords(block);
      if (!block.querySelector('.fr-word')) block = null;
    }
    if (!block) block = firstVisibleBlock();
    if (!block) return;
    focusWord(block, wordsOf(block)[0]);
    follow();
  }

  function step(delta) {
    if (!focusSpan || !activeBlock) {
      startFocus();
      return;
    }
    const list = wordsOf(activeBlock);
    const i = list.indexOf(focusSpan) + delta;
    if (i >= 0 && i < list.length) {
      focusWord(activeBlock, list[i]);
    } else {
      const nb = adjacentBlock(activeBlock, delta > 0 ? 1 : -1);
      if (!nb) return;
      const nl = wordsOf(nb);
      focusWord(nb, delta > 0 ? nl[0] : nl[nl.length - 1]);
    }
    follow();
  }

  // Word on a given line whose centre is horizontally nearest to x.
  function nearestWordOnLine(block, line, x) {
    const lineMid = (line.top + line.bottom) / 2;
    const half = (line.bottom - line.top) * 0.6;
    let best = null;
    let bestDist = Infinity;
    for (const s of wordsOf(block)) {
      const r = s.getBoundingClientRect();
      if (Math.abs(r.top + r.height / 2 - lineMid) >= half) continue;
      const d = Math.abs(r.left + r.width / 2 - x);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  // Move focus one VISUAL LINE up/down, keeping the horizontal reading
  // position (like a text editor caret). Crosses paragraph boundaries.
  function stepFocusLine(dir) {
    if (!focusSpan || !activeBlock) {
      startFocus();
      return;
    }
    const fr = focusSpan.getBoundingClientRect();
    const fx = fr.left + fr.width / 2;
    const mid = fr.top + fr.height / 2;

    const lines = blockLines(activeBlock);
    let i = lines.findIndex(
      (L) => Math.abs((L.top + L.bottom) / 2 - mid) < (L.bottom - L.top) * 0.6
    );
    if (i === -1) i = dir > 0 ? -1 : lines.length;
    i += dir;

    let block = activeBlock;
    let line;
    if (i >= 0 && i < lines.length) {
      line = lines[i];
    } else {
      block = adjacentBlock(activeBlock, dir);
      if (!block) return;
      const nl = blockLines(block);
      if (!nl.length) return;
      line = dir > 0 ? nl[0] : nl[nl.length - 1];
    }

    const target = nearestWordOnLine(block, line, fx);
    if (!target) return;
    focusWord(block, target);
    follow();
  }

  // Keep the focused word on screen (only scrolls when needed), then
  // re-glue the ruler band since scrolling moves everything.
  function follow() {
    if (focusSpan) focusSpan.scrollIntoView({ block: 'nearest' });
    syncRulerBand();
  }

  function engageKeyboard() {
    keyboardNav = true;
    anchorX = lastX;
    anchorY = lastY;
  }

  /* ---------------------------------------------------------- controls */

  let toggleBtn = null;
  let bioBtn = null;
  let rulerBtn = null;
  let fontBtn = null;
  let tintBtn = null;
  let ttsBtn = null;
  let ttsPanel = null;
  let ttsLabel = null;
  let controlsEl = null;
  let launcherBtn = null;
  let controlsOpen = false;
  let collapseTimer = null;

  function setEnabled(on) {
    enabled = on;
    keyboardNav = false;
    if (!enabled) {
      deactivateBlock();
      ttsStop();
    }
    document.body.classList.toggle('fr-ruler-on', ruler && enabled);
    if (toggleBtn) toggleBtn.classList.toggle('fr-off', !enabled);
    showToast(enabled ? 'FocusRead: on' : 'FocusRead: off');
  }

  // Collapse/expand the stack. While TTS plays, its button (and the
  // speed panel) stay visible even when collapsed — see content.css.
  function setControlsOpen(open) {
    controlsOpen = open;
    if (controlsEl) controlsEl.classList.toggle('fr-open', open);
    if (launcherBtn) {
      launcherBtn.textContent = open ? '✕' : '☰';
      launcherBtn.title = open ? 'Collapse FocusRead controls'
                               : 'FocusRead controls';
    }
    positionTtsPanel();
  }

  function scheduleCollapse() {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => setControlsOpen(false), 1200);
  }

  // Keep the speed slider glued next to the TTS button, wherever the
  // button currently sits (top of the open stack, or alone above the
  // launcher when collapsed).
  function positionTtsPanel() {
    if (!ttsPanel || !ttsBtn) return;
    const r = ttsBtn.getBoundingClientRect();
    ttsPanel.style.bottom =
      Math.max(0, window.innerHeight - r.bottom) + 'px';
  }

  function makeControls() {
    controlsEl = document.createElement('div');
    controlsEl.className = 'fr-controls';
    controlsEl.addEventListener('mouseenter', () => {
      clearTimeout(collapseTimer);
    });
    controlsEl.addEventListener('mouseleave', () => {
      if (controlsOpen) scheduleCollapse();
    });
    document.body.appendChild(controlsEl);

    const mkBtn = (cls, text, title, aria, onClick) => {
      const b = document.createElement('button');
      b.className = cls;
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      controlsEl.appendChild(b); // column-reverse: first added = bottom
      return b;
    };

    launcherBtn = mkBtn('fr-launcher', '☰', 'FocusRead controls',
      'FocusRead controls', () => {
        clearTimeout(collapseTimer);
        setControlsOpen(!controlsOpen);
      });

    toggleBtn = mkBtn('fr-toggle', 'Aa',
      'Toggle FocusRead on/off (Option+D or Ctrl+D)',
      'Toggle FocusRead', () => setEnabled(!enabled));

    bioBtn = mkBtn('fr-bio-btn', 'Bio',
      'Toggle bionic reading (Option+B or Ctrl+B)',
      'Toggle bionic reading', () => setBionic(!bionic));

    rulerBtn = mkBtn('fr-ruler-btn', '▬',
      'Toggle reading ruler (Option+R or Ctrl+R)',
      'Toggle reading ruler', () => setRuler(!ruler));

    fontBtn = mkBtn('fr-font-btn', 'Dys',
      'Toggle OpenDyslexic font (Option+F or Ctrl+F)',
      'Toggle OpenDyslexic font', () => setDysFont(!dysFont));

    tintBtn = mkBtn('fr-tint-btn', 'Tint',
      'Cycle background tint (Option+T or Ctrl+T)',
      'Cycle background tint', () => setTint(tintIndex + 1));

    ttsBtn = mkBtn('fr-tts-btn', '▶',
      'Read aloud from the focused word (Option+S or Ctrl+S)',
      'Read aloud', () => (ttsOn ? ttsStop() : ttsStart()));

    mkBtn('fr-find-btn', 'W?',
      'Find a word you can only describe (Option+K or Ctrl+K)',
      'Find a word', () => (finderOpen ? closeFinder() : openFinder()));

    ttsPanel = document.createElement('div');
    ttsPanel.className = 'fr-tts-panel';
    ttsLabel = document.createElement('span');
    ttsLabel.className = 'fr-tts-label';
    ttsLabel.textContent = wpm + ' wpm';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '80';
    slider.max = '400';
    slider.step = '10';
    slider.value = String(wpm);
    slider.setAttribute('aria-label', 'Speech speed in words per minute');
    // Live label while dragging; restart speech only on release.
    slider.addEventListener('input', () => {
      ttsLabel.textContent = slider.value + ' wpm';
    });
    slider.addEventListener('change', () => ttsSetWpm(Number(slider.value)));
    ttsPanel.appendChild(slider);
    ttsPanel.appendChild(ttsLabel);
    document.body.appendChild(ttsPanel);
  }

  /* ----------------------------------------------------------- events */

  document.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (keyboardNav) {
      // Ignore accidental trackpad nudges; deliberate movement takes over.
      const moved = Math.hypot(lastX - anchorX, lastY - anchorY);
      if (moved < MOUSE_TAKEOVER_PX) return;
      keyboardNav = false;
    }
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (finderOpen && e.code === 'Escape') {
      e.preventDefault();
      closeFinder();
      return;
    }

    // Shortcuts. e.code is used because on macOS Option+key types a
    // special character (e.key would never match).
    if ((e.altKey || e.ctrlKey) && !e.metaKey) {
      if (e.code === 'KeyK') {
        e.preventDefault();
        finderOpen ? closeFinder() : openFinder();
        return;
      }
      if (e.code === 'KeyD') {
        e.preventDefault();
        setEnabled(!enabled);
        return;
      }
      if (e.code === 'KeyB') {
        e.preventDefault();
        setBionic(!bionic);
        return;
      }
      if (e.code === 'KeyR') {
        e.preventDefault();
        setRuler(!ruler);
        return;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        setDysFont(!dysFont);
        return;
      }
      if (e.code === 'KeyT') {
        e.preventDefault();
        setTint(tintIndex + 1);
        return;
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        ttsOn ? ttsStop() : ttsStart();
        return;
      }
    }

    // Arrow-key navigation (plain arrows only, and not while typing).
    if (!enabled || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }

    switch (e.code) {
      case 'ArrowRight':
        e.preventDefault();
        engageKeyboard();
        step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        engageKeyboard();
        step(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        engageKeyboard();
        stepFocusLine(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        engageKeyboard();
        stepFocusLine(-1);
        break;
    }
  });

  // Click a word to set the reading position. The selection is sticky
  // (hover won't steal it), and if TTS is playing, speech jumps there.
  document.addEventListener('click', (e) => {
    if (!enabled) return;
    if (finderOpen && !e.target.closest('.fr-finder')) closeFinder();
    if (e.target.closest(
      '.fr-controls, .fr-tts-panel, .fr-toast, .fr-finder'
    )) return;
    const word = e.target.closest('.fr-word');
    if (!word) return;
    const block = word.closest(BLOCK_SELECTOR);
    if (!block) return;

    engageKeyboard(); // sticky: small mouse drift won't move it
    focusWord(block, word);
    follow();

    if (ttsOn) {
      // Don't navigate if the clicked word is a link — the click is a
      // TTS seek while reading aloud, not a navigation.
      e.preventDefault();
      const start = wordsOf(block).indexOf(word);
      ttsUtter = null; // invalidate so the cancel doesn't chain onend
      window.speechSynthesis.cancel();
      speakFrom(block, Math.max(0, start));
    }
  }, true);

  // Keep the ruler glued to its line while the page scrolls.
  window.addEventListener('scroll', () => {
    if (!enabled || !ruler) return;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });

  /* ------------------------------------------------------------ toast */

  let toastTimer = null;

  function showToast(msg) {
    let toast = document.querySelector('.fr-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'fr-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('fr-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('fr-toast-visible');
    }, 1500);
  }

  /* ------------------------------------------------------------- init */

  function init() {
    makeControls();
    // One-time page pass: spacing + font apply now, so nothing ever
    // shifts on hover.
    wrapAll();
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
