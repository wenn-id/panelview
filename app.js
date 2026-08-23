/* PanelView — client-side comic reader. MIT. */
"use strict";

/* ---------------- utilities ---------------- */

const IMG_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/* ---------------- minimal ZIP reader ----------------
   Supports stored (0) and deflate (8) via DecompressionStream. */

async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65558);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory)");
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  const nameDecoder = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = nameDecoder.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    if (!name.endsWith("/")) entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  async function extract(entry) {
    const lh = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("Bad local header: " + entry.name);
    const dataStart = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const comp = blob.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      return await new Response(comp.stream().pipeThrough(ds)).blob();
    }
    throw new Error("Unsupported compression method " + entry.method + " for " + entry.name);
  }
  return { entries, extract };
}

/* ---------------- Comic Sol layout geometry ----------------
   Port of comic_sol.layout_rects, version-1.0 fixed layouts. */

function layoutRects(name, pageWidth = 1600, pageHeight = 2400, margin = 64, gutter = 32) {
  const iw = pageWidth - 2 * margin;
  const ih = pageHeight - 2 * margin;
  const halfW = Math.floor((iw - gutter) / 2);
  const halfH = Math.floor((ih - gutter) / 2);
  const thirdH = Math.floor((ih - 2 * gutter) / 3);
  const heroH = Math.round(pageHeight * 0.49);
  const supportH = ih - gutter - heroH;
  const L = {
    "full-page": [{ x: margin, y: margin, width: iw, height: ih }],
    "two-horizontal": [
      { x: margin, y: margin, width: iw, height: halfH },
      { x: margin, y: margin + halfH + gutter, width: iw, height: halfH },
    ],
    "three-horizontal": [0, 1, 2].map((i) => ({
      x: margin, y: margin + i * (thirdH + gutter), width: iw, height: thirdH,
    })),
    "hero-top-two-bottom": [
      { x: margin, y: margin, width: iw, height: heroH },
      { x: margin, y: margin + heroH + gutter, width: halfW, height: supportH },
      { x: margin + halfW + gutter, y: margin + heroH + gutter, width: halfW, height: supportH },
    ],
    "two-top-hero-bottom": [
      { x: margin, y: margin, width: halfW, height: supportH },
      { x: margin + halfW + gutter, y: margin, width: halfW, height: supportH },
      { x: margin, y: margin + supportH + gutter, width: iw, height: heroH },
    ],
  };
  const rects = L[name];
  if (!rects) return null;
  return rects.map((r) => ({ ...r }));
}

/* ---------------- automatic panel detection ----------------
   Best-effort gutter detection on a downscaled canvas.
   Returns rects in natural-image coordinates, reading order. */

function detectPanels(img) {
  const scale = Math.min(1, 640 / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; }
  catch { return null; } /* tainted canvas */

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const isGutterLine = (idx, len, stride) => {
    let sum = 0, sumSq = 0;
    for (let j = 0; j < len; j++) { const v = lum[idx + j * stride]; sum += v; sumSq += v * v; }
    const mean = sum / len;
    const variance = sumSq / len - mean * mean;
    return variance < 220 && (mean > 216 || mean < 40);
  };
  /* horizontal bands */
  const rowGutter = new Uint8Array(h);
  for (let y = 0; y < h; y++) rowGutter[y] = isGutterLine(y * w, w, 1) ? 1 : 0;
  const bands = runsOf(rowGutter, 0, h, Math.round(h * 0.04));
  if (!bands.length) return null;
  const rects = [];
  for (const [y0, y1] of bands) {
    /* vertical split inside band */
    const colGutter = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let g = 1;
      /* column is gutter only if gutter-ish across the whole band */
      let sum = 0, sumSq = 0; const len = y1 - y0;
      for (let y = y0; y < y1; y++) { const v = lum[y * w + x]; sum += v; sumSq += v * v; }
      const mean = sum / len, variance = sumSq / len - mean * mean;
      g = variance < 220 && (mean > 216 || mean < 40) ? 1 : 0;
      colGutter[x] = g;
    }
    const cols = runsOf(colGutter, 0, w, Math.round(w * 0.06));
    for (const [x0, x1] of cols) {
      rects.push({
        x: x0 / scale, y: y0 / scale,
        width: (x1 - x0) / scale, height: (y1 - y0) / scale,
      });
    }
  }
  /* sanity: reject silly results */
  if (!rects.length || rects.length > 12) return null;
  const pageArea = img.naturalWidth * img.naturalHeight;
  const covered = rects.reduce((s, r) => s + r.width * r.height, 0);
  if (covered < pageArea * 0.35) return null;
  return rects;
}

/* consecutive runs of value 0 (content) in a 0/1 gutter array, min length filter */
function runsOf(flags, start, end, minLen) {
  const out = [];
  let runStart = -1;
  for (let i = start; i <= end; i++) {
    const isContent = i < end && flags[i] === 0;
    if (isContent && runStart < 0) runStart = i;
    if (!isContent && runStart >= 0) {
      if (i - runStart >= minLen) out.push([runStart, i]);
      runStart = -1;
    }
  }
  return out;
}

/* ---------------- book model ---------------- */
/* book = { title, pages: [{ blob|url, panels: rects|null, srcW, srcH }], comicSol: bool } */

async function bookFromFileMap(fileMap, fallbackTitle) {
  /* fileMap: Map<relativePath, {blob | getBlob()}> */
  const paths = [...fileMap.keys()];
  /* Comic Sol detection: a basename-exact project.json with plan/storyboard.json
     alongside it, shallowest match first — unrelated same-suffix files are ignored */
  const isProjectJson = (p) => p === "project.json" || p.endsWith("/project.json");
  const projectPath = paths
    .filter((p) => isProjectJson(p) && fileMap.has(p.slice(0, -"project.json".length) + "plan/storyboard.json"))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  if (projectPath) {
    const root = projectPath.slice(0, -"project.json".length);
    try {
      return await comicSolBook(fileMap, root, fallbackTitle);
    } catch (err) {
      console.warn("Comic Sol manifest found but unreadable, falling back:", err);
    }
  }
  const imagePaths = paths.filter((p) => IMG_RE.test(p) && !p.split("/").some((seg) => seg.startsWith("__MACOSX") || seg.startsWith(".")));
  imagePaths.sort(naturalCompare);
  if (!imagePaths.length) throw new Error("No images found.");
  return {
    title: fallbackTitle,
    comicSol: false,
    pages: imagePaths.map((p) => ({ get: fileMap.get(p), panels: null })),
  };
}

function validRect(r, pw, ph) {
  return (
    r && typeof r === "object" &&
    Number.isFinite(r.x) && Number.isFinite(r.y) &&
    Number.isFinite(r.width) && Number.isFinite(r.height) &&
    r.width > 0 && r.height > 0 &&
    r.x >= 0 && r.y >= 0 &&
    r.x + r.width <= pw && r.y + r.height <= ph
  );
}

/* Panel geometry for one storyboard page: exact rects from the manifest win;
   the layout-name registry is only a fallback for pages without usable rects. */
function panelsFromStoryboard(sb, pw, ph) {
  if (sb && Array.isArray(sb.panels) && sb.panels.length) {
    const all = sb.panels.map((p) => (p && p.rect && validRect(p.rect, pw, ph)
      ? { x: p.rect.x, y: p.rect.y, width: p.rect.width, height: p.rect.height }
      : null));
    if (all.every(Boolean)) return all;
  }
  if (sb && sb.layout) return layoutRects(sb.layout, pw, ph);
  return null;
}

async function comicSolBook(fileMap, root, fallbackTitle) {
  const readJson = async (rel) => {
    const f = fileMap.get(root + rel);
    if (!f) throw new Error("missing " + rel);
    return JSON.parse(await (await f()).text());
  };
  const project = await readJson("project.json");
  const storyboard = await readJson("plan/storyboard.json");
  const s = project.settings || {};
  const pw = s.page_width || 1600, ph = s.page_height || 2400;
  const pagePaths = [...fileMap.keys()].filter((p) => p.startsWith(root + "pages/") && IMG_RE.test(p)).sort(naturalCompare);
  if (!pagePaths.length) throw new Error("no pages/ images");
  const byNumber = storyboard.pages || [];
  const pages = pagePaths.map((p, i) => {
    const panels = panelsFromStoryboard(byNumber[i], pw, ph);
    return { get: fileMap.get(p), panels, srcW: pw, srcH: ph };
  });
  const title = project.title || project.project_id || fallbackTitle;
  return { title, comicSol: true, pages };
}

/* ---------------- input handling ---------------- */

function fileMapFromFiles(files) {
  /* FileList with webkitRelativePath (dir) or plain names */
  const map = new Map();
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
    /* strip the top-level folder name when present */
    const key = f.webkitRelativePath ? rel : f.name;
    map.set(key, async () => f);
  }
  return map;
}

async function fileMapFromZip(blob) {
  const zip = await readZip(blob);
  /* strip common top-level dir if every entry shares one */
  const names = zip.entries.map((e) => e.name);
  let prefix = "";
  const firstSlash = names[0] ? names[0].indexOf("/") : -1;
  if (firstSlash > 0) {
    const candidate = names[0].slice(0, firstSlash + 1);
    if (names.every((n) => n.startsWith(candidate))) prefix = candidate;
  }
  const map = new Map();
  for (const e of zip.entries) {
    map.set(e.name.slice(prefix.length), async () => zip.extract(e));
  }
  return map;
}

async function openInput(files) {
  try {
    let book;
    if (files.length === 1 && /\.(cbz|zip)$/i.test(files[0].name)) {
      const map = await fileMapFromZip(files[0]);
      book = await bookFromFileMap(map, files[0].name.replace(/\.(cbz|zip)$/i, ""));
    } else if (files.length === 1 && IMG_RE.test(files[0].name)) {
      book = { title: files[0].name, comicSol: false, pages: [{ get: async () => files[0], panels: null }] };
    } else {
      const map = fileMapFromFiles(files);
      const title = files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "Comic";
      book = await bookFromFileMap(map, title);
    }
    await openBook(book);
  } catch (err) {
    alert("Could not open comic: " + err.message);
    console.error(err);
  }
}

/* ---------------- demo ---------------- */

async function openDemo() {
  try {
    const meta = await (await fetch("demo/demo.json")).json();
    const pages = meta.pages.map((p) => ({
      get: async () => await (await fetch("demo/" + p.image)).blob(),
      panels: layoutRects(p.layout, 1600, 2400),
      srcW: 1600, srcH: 2400,
    }));
    await openBook({ title: meta.title + " · demo", comicSol: true, pages });
  } catch (err) {
    alert("Demo failed to load: " + err.message);
  }
}

/* ---------------- reader ---------------- */

const $ = (sel) => document.querySelector(sel);
const stage = $("#stage");
const state = {
  book: null,
  mode: "page",
  page: 0,
  panel: 0,
  urls: [],       /* object URLs per page */
  panelCache: [], /* resolved panel rects per page (image coords) */
  guided: null,
};

function bookKey(book) {
  return "panelview:" + book.title + ":" + book.pages.length;
}

async function pageURL(i) {
  if (!state.urls[i]) {
    const blob = await state.book.pages[i].get();
    state.urls[i] = URL.createObjectURL(blob);
  }
  return state.urls[i];
}

async function openBook(book) {
  closeBook();
  state.book = book;
  state.urls = new Array(book.pages.length);
  state.panelCache = new Array(book.pages.length);
  $("#book-title").textContent = book.title;
  $("#landing").hidden = true;
  $("#reader").hidden = false;
  /* resume */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(bookKey(book)) || "null"); } catch {}
  state.mode = saved?.mode || (book.comicSol ? "guided" : "page");
  state.page = Math.min(saved?.page || 0, book.pages.length - 1);
  state.panel = saved?.panel || 0;
  await render();
  showHint(state.mode === "guided" ? "→ / space / click: next panel · 1 2 3: switch mode" : "→ / click: next · 1 2 3: switch mode");
}

function closeBook() {
  for (const u of state.urls || []) if (u) URL.revokeObjectURL(u);
  state.book = null; state.urls = []; state.guided = null;
  $("#reader").hidden = true;
  $("#landing").hidden = false;
}

function persist() {
  if (!state.book) return;
  try {
    localStorage.setItem(bookKey(state.book), JSON.stringify({ mode: state.mode, page: state.page, panel: state.panel }));
  } catch {}
}

function setProgress(frac) {
  $("#progress-fill").style.width = (frac * 100).toFixed(1) + "%";
}

let hintTimer;
function showHint(text) {
  const el = $("#hint");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function render() {
  if (!state.book) return;
  stage.className = "mode-" + state.mode;
  stage.innerHTML = "";
  state.guided = null;
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  if (state.mode === "page") await renderPage();
  else if (state.mode === "webtoon") await renderWebtoon();
  else await renderGuided();
  persist();
}

async function renderPage() {
  const img = new Image();
  img.src = await pageURL(state.page);
  stage.appendChild(img);
  updatePos(`${state.page + 1} / ${state.book.pages.length}`);
  setProgress((state.page + 1) / state.book.pages.length);
  preload(state.page + 1);
}

async function renderWebtoon() {
  const col = document.createElement("div");
  col.className = "col";
  stage.appendChild(col);
  for (let i = 0; i < state.book.pages.length; i++) {
    const img = new Image();
    img.loading = "lazy";
    img.src = await pageURL(i);
    img.dataset.index = i;
    col.appendChild(img);
  }
  updatePos(`${state.book.pages.length} pages`);
  const imgs = [...col.children];
  stage.onscroll = () => {
    const mid = stage.scrollTop + stage.clientHeight / 2;
    let current = 0;
    for (const img of imgs) if (img.offsetTop <= mid) current = +img.dataset.index;
    state.page = current;
    setProgress((stage.scrollTop + stage.clientHeight) / stage.scrollHeight);
    persist();
  };
  /* restore scroll to saved page */
  requestAnimationFrame(() => {
    const target = imgs[state.page];
    if (target) stage.scrollTop = target.offsetTop;
  });
}

/* ----- guided ----- */

async function panelsFor(i, img) {
  if (state.panelCache[i]) return state.panelCache[i];
  const pageInfo = state.book.pages[i];
  let rects = null;
  if (pageInfo.panels) {
    const sx = img.naturalWidth / (pageInfo.srcW || img.naturalWidth);
    const sy = img.naturalHeight / (pageInfo.srcH || img.naturalHeight);
    rects = pageInfo.panels.map((r) => ({ x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy }));
  } else {
    rects = detectPanels(img);
  }
  if (!rects || !rects.length) {
    rects = [{ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight }];
  }
  state.panelCache[i] = rects;
  return rects;
}

async function renderGuided() {
  const viewport = document.createElement("div");
  viewport.className = "guided-viewport";
  const canvas = document.createElement("div");
  canvas.className = "guided-canvas";
  const img = new Image();
  img.src = await pageURL(state.page);
  await img.decode();
  canvas.appendChild(img);
  const dim = document.createElement("div");
  dim.className = "guided-dim";
  canvas.appendChild(dim);
  viewport.appendChild(canvas);
  stage.appendChild(viewport);
  const rects = await panelsFor(state.page, img);
  state.panel = Math.min(state.panel, rects.length - 1);
  state.guided = { viewport, canvas, dim, img, rects };
  frameCurrentPanel(false);
}

function frameCurrentPanel(animate = true) {
  const g = state.guided;
  if (!g) return;
  const r = g.rects[state.panel];
  const vw = g.viewport.clientWidth, vh = g.viewport.clientHeight;
  const pad = 0.045;
  const scale = Math.min(vw / (r.width * (1 + pad * 2)), vh / (r.height * (1 + pad * 2)));
  const tx = vw / 2 - (r.x + r.width / 2) * scale;
  const ty = vh / 2 - (r.y + r.height / 2) * scale;
  if (!animate) g.canvas.style.transition = "none";
  g.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  g.dim.style.clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${r.x}px ${r.y}px, ${r.x}px ${r.y + r.height}px, ${r.x + r.width}px ${r.y + r.height}px, ${r.x + r.width}px ${r.y}px, ${r.x}px ${r.y}px)`;
  if (!animate) requestAnimationFrame(() => { g.canvas.style.transition = ""; });
  const total = state.book.pages.length;
  updatePos(`p${state.page + 1} · panel ${state.panel + 1}/${g.rects.length}`);
  setProgress((state.page + state.panel / g.rects.length + 1 / g.rects.length) / total);
  persist();
}

/* ---------------- navigation ---------------- */

async function next() {
  if (!state.book) return;
  if (state.mode === "guided" && state.guided) {
    if (state.panel < state.guided.rects.length - 1) { state.panel++; frameCurrentPanel(); return; }
    if (state.page < state.book.pages.length - 1) { state.page++; state.panel = 0; await render(); return; }
    showHint("The end — Esc to close");
    return;
  }
  if (state.mode === "webtoon") { stage.scrollBy({ top: stage.clientHeight * 0.85, behavior: "smooth" }); return; }
  if (state.page < state.book.pages.length - 1) { state.page++; await render(); }
}

async function prev() {
  if (!state.book) return;
  if (state.mode === "guided" && state.guided) {
    if (state.panel > 0) { state.panel--; frameCurrentPanel(); return; }
    if (state.page > 0) {
      state.page--;
      state.panel = 1e9; /* clamped to last panel in renderGuided */
      await render();
      return;
    }
    return;
  }
  if (state.mode === "webtoon") { stage.scrollBy({ top: -stage.clientHeight * 0.85, behavior: "smooth" }); return; }
  if (state.page > 0) { state.page--; await render(); }
}

function updatePos(text) { $("#pos").textContent = text; }

async function preload(i) {
  if (state.book && i < state.book.pages.length) pageURL(i).then((u) => { const im = new Image(); im.src = u; });
}

async function setMode(mode) {
  if (!state.book || state.mode === mode) return;
  state.mode = mode;
  await render();
}

/* ---------------- wire up ---------------- */

const dropzone = $("#dropzone");
const fileInput = $("#file-input");
const dirInput = $("#dir-input");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
fileInput.addEventListener("change", () => { if (fileInput.files.length) openInput([...fileInput.files]); fileInput.value = ""; });
dirInput.addEventListener("change", () => { if (dirInput.files.length) openInput([...dirInput.files]); dirInput.value = ""; });

["dragover", "dragenter"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === "dragleave" && e.relatedTarget) return; dropzone.classList.remove("drag"); }));
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const items = [...(e.dataTransfer?.items || [])];
  const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (entries.some((en) => en.isDirectory)) {
    const files = [];
    for (const en of entries) await collectEntry(en, "", files);
    openInput(files);
  } else {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) openInput(files);
  }
});

async function collectEntry(entry, path, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    Object.defineProperty(f, "webkitRelativePath", { value: path + entry.name });
    out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await collectEntry(child, path + entry.name + "/", out);
    } while (batch.length);
  }
}

$("#btn-demo").addEventListener("click", openDemo);
$("#btn-close").addEventListener("click", closeBook);
$("#btn-fs").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#reader").requestFullscreen?.();
});
document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

stage.addEventListener("click", (e) => {
  if (state.mode === "webtoon") return;
  const x = e.clientX / window.innerWidth;
  x < 0.3 ? prev() : next();
});

document.addEventListener("keydown", (e) => {
  if (!state.book) return;
  switch (e.key) {
    case "ArrowRight": case " ": case "PageDown": e.preventDefault(); next(); break;
    case "ArrowLeft": case "PageUp": e.preventDefault(); prev(); break;
    case "1": setMode("page"); break;
    case "2": setMode("webtoon"); break;
    case "3": setMode("guided"); break;
    case "f": $("#btn-fs").click(); break;
    case "Escape": if (!document.fullscreenElement) closeBook(); break;
  }
});

/* touch swipe */
let touchX = null, touchY = null;
stage.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
stage.addEventListener("touchend", (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) dx < 0 ? next() : prev();
  touchX = null;
}, { passive: true });

window.addEventListener("resize", () => { if (state.mode === "guided") frameCurrentPanel(false); });

/* expose internals for test.html */
window.__panelview = { readZip, layoutRects, naturalCompare, runsOf, fileMapFromZip, bookFromFileMap };
