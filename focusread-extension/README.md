# FocusRead — Dyslexia Reading Lens (prototype)

Magnifies the word under your cursor (plus the word before and after) and
dims the rest of the paragraph, reducing visual crowding on text-heavy
pages like Wikipedia.

**Toggle:** floating "Aa" button (bottom right), **Option+D** (Mac),
**Alt+D** (Windows/Linux), or **Ctrl+D**. A small toast confirms on/off.
Note for Mac: it's Option, not Cmd — Cmd+D is the browser's bookmark
shortcut.

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
  "gecko": { "id": "focusread@yourteam.example" }
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

- `content.js` lazily wraps each word of a paragraph in a `<span>` the
  first time you hover it (wrapping a whole Wikipedia page upfront is slow).
- Magnification is `transform: scale()`, **not** `font-size`, so the
  paragraph never reflows/jumps under the cursor.
- Dimming is `opacity`, so it stays readable and works on dark themes.
- `mousemove` is throttled with `requestAnimationFrame`.

## Known limitations (v0.1)

- Epub web readers usually render inside iframes (epub.js) — content
  scripts don't reach in. Roadmap: bundle a minimal epub.js reader page
  inside the extension instead.
- Words inside code blocks, math, and form fields are intentionally
  skipped.
- No settings UI yet — scale factors and dim level live in `content.css`
  (`1.45`, `1.15`, `0.45`).
