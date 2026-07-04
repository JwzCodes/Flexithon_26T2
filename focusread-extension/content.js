/*
 * FocusRead — content script
 * Magnifies the word under the cursor (+ neighbours), dims the rest of
 * the paragraph. Toggle: floating button, Option/Alt+D, or Ctrl+D.
 *
 * Design notes:
 * - Words are wrapped in spans LAZILY, per paragraph, on first hover.
 * - Magnification uses transform:scale(), and we add matching horizontal
 *   margins so neighbouring words shift away instead of being overlapped.
 * - Dimming uses opacity, so it works on both light and dark themes.
 */
(() => {
  'use strict';

  const SCALE_FOCUS = 1.2;   // keep in sync with content.css
  const SCALE_NEAR = 1.05;

  // Elements we treat as a "paragraph" (the dimming context).
  const BLOCK_SELECTOR = 'p, li, dd, dt, blockquote, caption, figcaption';

  // Never wrap words inside these.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'CODE', 'PRE', 'KBD', 'SAMP', 'MATH', 'SVG', 'BUTTON'
  ]);

  let enabled = true;
  let activeBlock = null;   // block currently dimmed
  let focusSpan = null;     // word span currently magnified
  let decorated = [];       // spans holding .fr-focus / .fr-near right now
  let rafPending = false;
  let lastX = 0;
  let lastY = 0;

  const processed = new WeakSet(); // blocks already word-wrapped

  /* ---------------------------------------------------------- wrapping */

  const font = new FontFace(
    "OpenDyslexic",
    `url(${chrome.runtime.getURL("fonts/OpenDyslexic-Regular.otf")})`
  );

  font.load().then((loadedFont) => {
    document.fonts.add(loadedFont);
    console.log("OpenDyslexic loaded");
  }).catch((error) => {
    console.error("OpenDyslexic failed to load:", error);
  });

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
            parent.classList.contains('fr-word') ||
            parent.closest('.fr-toast, .fr-toggle')) {
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
  }

  /* ------------------------------------------------------ focus logic */

  // Add scale class + horizontal margins that reserve exactly the extra
  // width the scaled word needs, so neighbours slide away (no overlap).
  function decorate(span, cls, scale) {
    const w = span.getBoundingClientRect().width;

    const extra = ((scale - 1) * w) / 2 + 1;

    span.style.marginLeft = extra + 'px';
    span.style.marginRight = extra + 'px';

    span.classList.add(cls);
    decorated.push(span);
  }

  function clearDecorations() {
    for (const s of decorated) {
      s.classList.remove('fr-focus', 'fr-near');
      s.style.marginLeft = '';
      s.style.marginRight = '';
    }
    decorated = [];
  }

  function deactivateBlock() {
    if (activeBlock) activeBlock.classList.remove('fr-active');
    activeBlock = null;
    clearDecorations();
    focusSpan = null;
  }

  function getStableFocusedWord(block, mouseX, mouseY) {
    const words = Array.from(block.querySelectorAll('.fr-word'));
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
    const centreX = rect.left + rect.width / 2;

    // Dead zone: if the mouse is too far from the centre of the candidate word,
    // keep the current focused word instead of switching.
    const switchThreshold = Math.max(8, rect.width * 0.15);

    if (focusSpan && bestWord !== focusSpan) {
      const currentRect = focusSpan.getBoundingClientRect();
      const currentCentreX = currentRect.left + currentRect.width / 2;
      const currentDistance = Math.abs(mouseX - currentCentreX);

      // Only switch if the new word is clearly closer than the current word.
      if (bestDistance + switchThreshold > currentDistance) {
        return focusSpan;
      }
    }

    return bestWord;
  }

  function update() {
    rafPending = false;
    if (!enabled) return;

    const el = document.elementFromPoint(lastX, lastY);
    const block = el ? el.closest(BLOCK_SELECTOR) : null;

    if (!block) {
      deactivateBlock();
      return;
    }

    if (block !== activeBlock) {
      deactivateBlock();
      wrapWords(block);
      activeBlock = block;
      block.classList.add('fr-active');
    }

    // const word = el.closest('.fr-word');
    const word = getStableFocusedWord(activeBlock, lastX, lastY);
    if (word === focusSpan) return; // nothing changed

    clearDecorations();
    if (!word || !block.contains(word)) {
      focusSpan = null;
      return;
    }

    focusSpan = word;
    const list = Array.prototype.slice.call(
      block.querySelectorAll('.fr-word')
    );
    const i = list.indexOf(word);

    if (i > 0) decorate(list[i - 1], 'fr-near', SCALE_NEAR);
    if (i > -1 && i < list.length - 1) {
      decorate(list[i + 1], 'fr-near', SCALE_NEAR);
    }
    decorate(word, 'fr-focus', SCALE_FOCUS);
  }

  /* ---------------------------------------------------------- toggle */

  let toggleBtn = null;

  function setEnabled(on) {
    enabled = on;
    if (!enabled) deactivateBlock();
    if (toggleBtn) toggleBtn.classList.toggle('fr-off', !enabled);
    showToast(enabled ? 'FocusRead: on' : 'FocusRead: off');
  }

  function makeToggleButton() {
    toggleBtn = document.createElement('button');
    toggleBtn.className = 'fr-toggle';
    toggleBtn.type = 'button';
    toggleBtn.textContent = 'Aa';
    toggleBtn.title = 'Toggle FocusRead (Option+D or Ctrl+D)';
    toggleBtn.setAttribute('aria-label', 'Toggle FocusRead');
    toggleBtn.addEventListener('click', () => setEnabled(!enabled));
    document.body.appendChild(toggleBtn);
  }

  /* ----------------------------------------------------------- events */

  document.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });

  // Option/Alt+D or Ctrl+D. e.code is used because on macOS Option+D
  // types "∂" (e.key would never equal "d").
  document.addEventListener('keydown', (e) => {
    if ((e.altKey || e.ctrlKey) && !e.metaKey && e.code === 'KeyD') {
      e.preventDefault();
      setEnabled(!enabled);
    }
  });

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

  if (document.body) {
    makeToggleButton();
  } else {
    document.addEventListener('DOMContentLoaded', makeToggleButton);
  }
})();
