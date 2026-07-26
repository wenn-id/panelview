# PanelView — Design Spec (2026-07-26)

## Goal
Client-side comic reader, single page app, GitHub Pages. Zero backend, zero build, zero deps.

## Inputs
1. CBZ/ZIP — own minimal ZIP parser (central directory; stored = slice, deflate = `DecompressionStream('deflate-raw')`).
2. Image folder (drag-drop directory or picker) — natural sort.
3. Comic Sol project (folder containing `project.json` + `plan/storyboard.json` + `pages/*.png`) — exact panel geometry derived from layout names (port of `layout_rects`: 1600×2400, margin 64, gutter 32; scaled to actual image size via `project.json` settings).

## Modes
- Page: fit single page, arrows/keys/swipe.
- Webtoon: vertical scroll.
- Guided: cinematic zoom/pan panel-per-panel via CSS transform. Panel sources: Comic Sol = exact rects; CBZ/folder = canvas gutter detection (luminance threshold, row/column bands), fallback full page.

## UI
Dark cinematic. Landing = big dropzone + "Try demo comic" (bundled 3-page Comic Sol sample). Toolbar: title, mode switch, fullscreen. Progress bar. Resume position via localStorage.

## Structure
`index.html`, `app.js`, `style.css`, `test.html`, `demo/`, README, MIT LICENSE.

## Testing
`test.html`: assert-based — ZIP roundtrip (build ZIP in-browser with CompressionStream), natural sort, layout rects bounds/no-overlap. Headless screenshot QA before ship.

## Out of scope v1
CBR/RAR, PDF, cloud sync, editing. Noted in README roadmap.
