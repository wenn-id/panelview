# PanelView 🎬

**A cinematic comic reader that runs entirely in your browser.**

Drop in a `.cbz`, an image folder, or a [Comic Sol](https://github.com/wenn-id/comic-sol) project — and read it in three modes, including a Marvel-style **Guided View** where the camera glides from panel to panel.

**▶ [Live demo](https://wenn-id.github.io/panelview/)** — click *Try the demo comic*, then press `3`.

![PanelView guided mode](docs/screenshot.png)

## Why

Most web comic readers show you pages. PanelView shows you *panels* — with cinematic zoom-and-pan transitions, the way motion comics and official reader apps do it.

- **Comic Sol projects**: panel geometry is read straight from the project manifest, so guided framing is **pixel-exact** — no guessing.
- **Any CBZ / image folder**: automatic panel detection (gutter analysis on a canvas) with graceful fallback to full-page framing.

## Features

- 📖 **Page mode** — classic single page, keyboard / swipe / click zones
- 📜 **Webtoon mode** — smooth vertical scroll
- 🎬 **Guided mode** — panel-by-panel cinematic camera with dimmed surroundings
- 🔒 **100% client-side** — no upload, no server, no tracking. Your files never leave your machine
- 📦 **Zero dependencies, zero build** — one HTML + one JS + one CSS; the ZIP reader is ~60 lines using the native `DecompressionStream`
- 💾 Resume where you left off (localStorage)
- 📱 Works on mobile (swipe, responsive UI)

## Usage

Open the [live demo](https://wenn-id.github.io/panelview/) or serve the folder locally:

```bash
git clone https://github.com/wenn-id/panelview
cd panelview
python3 -m http.server 8080   # any static server works
```

Then drop in:

| Input | What happens |
|---|---|
| `.cbz` / `.zip` | Unzipped in-browser (stored + deflate), pages natural-sorted |
| Image folder | Natural-sorted pages |
| Comic Sol project folder | `project.json` + `plan/storyboard.json` detected → exact panel rects |

**Keys:** `←`/`→`/`space` navigate · `1`/`2`/`3` switch mode · `f` fullscreen · `Esc` close

## Comic Sol integration

[Comic Sol](https://github.com/wenn-id/comic-sol) is an agent skill that turns a story prompt into a finished comic. Its projects carry deterministic panel geometry (fixed layout grammar, 1600×2400 pages). PanelView ports that layout math (`layout_rects`) to JS, so any Comic Sol output folder becomes a cinematic guided-view experience with zero configuration.

## Tests

Open `test.html` in a browser (or via the static server). Assert-based checks for the ZIP parser, layout geometry parity, natural sort, and book detection — no framework.

## Roadmap

- CBR (RAR) support
- PDF input
- Panel-order editor for correcting auto-detection
- Reading-direction (RTL / manga) toggle

## License

MIT
