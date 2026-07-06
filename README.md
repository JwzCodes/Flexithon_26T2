# Word Lock — Dyslexia Reading Lens (prototype)

Magnifies the word under your cursor (plus the word before and after) and
dims the rest of the paragraph, reducing visual crowding on text-heavy
pages like Wikipedia.

## Controls

The buttons live in a collapsible stack (bottom right). It starts
collapsed as a single "☰" launcher — click to expand; it auto-collapses
shortly after the mouse leaves. While TTS is reading, the ◼ button and
the speed slider stay visible even when collapsed. Keyboard shortcuts
work regardless of collapse state.

- **On/off:** floating "Aa" button (bottom right), **Option+D** (Mac),
  **Alt+D** (Windows/Linux), or **Ctrl+D**. (Mac: Option, not Cmd —
  Cmd+D is the bookmark shortcut.)
- **Word focus:** the word under the cursor magnifies **in place** on a
  page-coloured backing — zero layout movement, ever. Word spacing is
  applied once at page load, so hovering never reflows the paragraph.
- **OpenDyslexic font:** "Dys" button (top of the stack) or
  **Option/Ctrl+F**. Off by default; applies to the whole content area.
  (Toggling reflows the page once — deliberate action, not a hover
  side effect.)
- **Reading ruler:** "▬" button or **Option/Ctrl+R**.
  Spotlights only the current text line and dims the entire rest of the
  page — the word magnifier and the paragraph fade both keep working
  inside the band. Follows the mouse or steps with the arrow keys.
- **Background tint:** "Tint" button or **Option/Ctrl+T**. Cycles pastel
  screen overlays (cream → mint → sky → rose → off) that recolour white
  backgrounds while text stays dark (multiply blend).
- **Read aloud (TTS):** "▶" button or **Option/Ctrl+S**. Speaks from the
  focused word onward, continuing into following paragraphs; the word
  highlight (and ruler band) follows the speech. A slider sets the
  speed in words per minute (80–400); changing it restarts from the
  current word. Uses the browser's built-in speech synthesis — no
  extra permissions.
- **Click to set position:** click any word to place the reading
  position there (sticky against hover). If TTS is playing, speech
  jumps to the clicked word — like seeking in an audio player. While
  playing, clicks on links seek instead of navigating.
- **Word finder ("W?" button or Option/Ctrl+K):** for the
  tip-of-the-tongue block — you know how to *describe* the word but
  can't recall it. Type the description ("fear of small spaces"),
  press Enter, and click a suggestion to copy it (it's also spoken
  aloud so you hear the pronunciation). Esc closes.
- **Bionic reading:** "Bio" button or **Option/Ctrl+B**.
  Bolds roughly the first half of every word page-wide, independent of
  the focus effect — the two can be A/B tested separately or combined.
- **Arrow keys:** Left/Right = previous/next word, Up/Down =
  previous/next visual line (keeping your horizontal reading position,
  like a text-editor caret). Focus follows automatically across paragraph
  boundaries and scrolls the page when needed. Small accidental trackpad
  nudges won't steal focus from keyboard navigation; a deliberate mouse
  movement (>15px) takes over again.

## Word finder engines & API keys

- **Default: Datamuse reverse dictionary** — free, no API key, so the
  demo can never fail because of a key. No setup needed.
- **Optional: Claude** — click the small link at the bottom of the
  finder panel and paste your own Anthropic API key. The key is stored
  in `chrome.storage.local` (or localStorage on the demo page) **on
  your machine only**.

⚠️ **NEVER hardcode an API key in this repo.** There are no keys in any
file here and it must stay that way — keys pasted at runtime live only
in browser storage, which is not committed to git. If a key ever lands
in a commit, revoke it immediately in the Anthropic console and rewrite
the history before pushing.

## Line-aware behaviour

- The word focus snaps to the nearest word: anywhere inside a paragraph
  — gaps between words, between lines, trailing margin — always focuses
  something, so the cursor doesn't have to trace the text precisely.

- Neighbour magnification never crosses a line break — the last word of
  a line won't drag the first word of the next line along.
- The line currently being read stays slightly brighter than the rest
  of the paragraph (helps line tracking).
- The focused word is set apart from its neighbours by size, full
  contrast, a faux-bold text-shadow, and a blue underline. (Real bold
  would change the word's width and shift the layout.)
- Mouse focus uses a switching dead zone: it keeps the current word
  until a new word is clearly closer, so focus doesn't flicker at word
  boundaries.

## Quick try (no install)

Open `demo.html` in any browser.

## Install in Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `focusread-extension` folder
4. Open any Wikipedia article and hover over a paragraph

## Install in Firefox (109+)

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json`
3. Open any Wikipedia article

Same codebase — no changes needed for a temporary load. For a *permanent*
Firefox install (signing / AMO) you must add an ID to `manifest.json`:

```json
"browser_specific_settings": {
  "gecko": { "id": "wordlock@yourteam.example" }
}
```

(Chrome may warn about this key, which is why it's not in the manifest by
default.)

## Run on more sites

Edit `matches` in `manifest.json`. For everything:

```json
"matches": ["<all_urls>"]
```

Then click the reload icon on the extension card.

## How it works

- `content.js` wraps each word of the content area in a `<span>` once,
  at page load — the extra word spacing and the OpenDyslexic font apply
  in that single pass, so nothing moves on hover. (Restricted to
  `main`/`article` so menus and sidebars are left alone.)
- Magnification is `transform: scale()`, **not** `font-size`, so the
  paragraph never reflows/jumps under the cursor.
- Dimming is `opacity`, so it stays readable and works on dark themes.
- `mousemove` is throttled with `requestAnimationFrame`.
- To change the word spacing or drop the font override, edit the
  `.fr-word` rule at the top of `content.css`.

## Known limitations (v0.1)

- Epub web readers usually render inside iframes (epub.js) — content
  scripts don't reach in. Roadmap: bundle a minimal epub.js reader page
  inside the extension instead.
- Words inside code blocks, math, and form fields are intentionally
  skipped.
- No settings UI yet — scale factors and dim level live in `content.css`
  (`1.45`, `1.15`, `0.45`).
