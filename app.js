/* PanelView — client-side comic reader. MIT. */
"use strict";

/* ---------------- utilities ---------------- */

const IMG_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const TESTED_COMIC_SOL_SCHEMA_VERSIONS = new Set(["1.0"]);

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/* Cheap synchronous identity for resume storage; two 32-bit lanes keep the
   key compact while making same-title/page-count collisions unlikely. */
function resumeFingerprint(parts) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const part of parts) {
    const text = String(part) + "\u001f";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a ^= code; a = Math.imul(a, 0x01000193);
      b ^= code + i; b = Math.imul(b, 0x85ebca6b);
    }
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/* ---------------- minimal ZIP reader ----------------
   Supports stored (0) and deflate (8) via DecompressionStream.
   Inflation of any single entry is capped (default 512 MiB) so a small
   malicious .cbz cannot balloon into gigabytes of memory, and ZIP64
   archives are rejected loudly instead of being mis-parsed. */

const MAX_INFLATED_ENTRY_BYTES = 512 * 1024 * 1024;
const ZIP64_UNSUPPORTED = "ZIP64 archives are not supported yet";

async function readZip(blob, maxInflatedBytes = MAX_INFLATED_ENTRY_BYTES) {
  const tailSize = Math.min(blob.size, 65558);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory)");
  /* ZIP64 EOCD locator sits immediately before the EOCD record */
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) throw new Error(ZIP64_UNSUPPORTED);
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error(ZIP64_UNSUPPORTED);
  }
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  const nameDecoder = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const uncompSize = cd.getUint32(p + 24, true);
    const crc = cd.getUint32(p + 16, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(ZIP64_UNSUPPORTED);
    }
    const name = nameDecoder.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    if (!name.endsWith("/")) entries.push({ name, method, compSize, uncompSize, crc, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  async function extract(entry) {
    const lh = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("Bad local header: " + entry.name);
    if (lh.getUint32(18, true) === 0xffffffff || lh.getUint32(22, true) === 0xffffffff) {
      throw new Error(ZIP64_UNSUPPORTED);
    }
    const overLimit = "ZIP entry exceeds the " + maxInflatedBytes + "-byte inflation limit: " + entry.name;
    if (entry.uncompSize > maxInflatedBytes || lh.getUint32(22, true) > maxInflatedBytes) throw new Error(overLimit);
    const dataStart = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const comp = blob.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return comp;
    if (entry.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      /* count inflated bytes so a lying size header still cannot exceed the cap */
      let inflated = 0;
      let limitError = null;
      const limiter = new TransformStream({
        transform(chunk, controller) {
          inflated += chunk.byteLength;
          if (inflated > maxInflatedBytes) {
            limitError = new Error(overLimit);
            throw limitError;
          }
          controller.enqueue(chunk);
        },
      });
      try {
        return await new Response(comp.stream().pipeThrough(ds).pipeThrough(limiter)).blob();
      } catch (error) {
        if (limitError) throw limitError;
        throw error;
      }
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
    "four-grid": [
      { x: margin, y: margin, width: halfW, height: halfH },
      { x: margin + halfW + gutter, y: margin, width: halfW, height: halfH },
      { x: margin, y: margin + halfH + gutter, width: halfW, height: halfH },
      { x: margin + halfW + gutter, y: margin + halfH + gutter, width: halfW, height: halfH },
    ],
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
  const pages = imagePaths.map((p) => ({
    get: fileMap.get(p),
    panels: null,
    resumeSource: fileMap.get(p)?.resumeSource || [p],
  }));
  return {
    title: fallbackTitle,
    comicSol: false,
    pages,
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

/* "sunlight-courier" → "Sunlight Courier": slugs are lowercase per Comic Sol
   ID rules, so capitalizing each word's first letter is lossless enough. */
function prettifySlug(slug) {
  return String(slug).replace(/[-_]+/g, " ").trim().replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));
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

/* Stable per-page identity from the storyboard entry: number, layout, and
   panel ids — regenerated books with new content hash differently. */
function sbSignature(sb) {
  const panels = Array.isArray(sb?.panels) ? sb.panels : [];
  return [sb?.number ?? "", sb?.layout ?? "", panels.map((p) => p?.id || "").join(",")];
}

async function comicSolBook(fileMap, root, fallbackTitle) {
  const readJson = async (rel) => {
    const f = fileMap.get(root + rel);
    if (!f) throw new Error("missing " + rel);
    return JSON.parse(await (await f()).text());
  };
  const project = await readJson("project.json");
  const storyboard = await readJson("plan/storyboard.json");
  let logline = "";
  try {
    const storyPlan = await readJson("plan/story-plan.json");
    if (storyPlan && typeof storyPlan.logline === "string") logline = storyPlan.logline.trim();
  } catch {}
  const schemaVersion = project.schema_version;
  let schemaNote;
  if (schemaVersion == null) {
    schemaNote = "legacy";
    console.info("Comic Sol project has no schema_version; treating it as a legacy manifest.");
  } else if (!TESTED_COMIC_SOL_SCHEMA_VERSIONS.has(schemaVersion)) {
    schemaNote = `Project schema ${schemaVersion} has not been tested with this reader; rendering may be off.`;
    console.warn(schemaNote);
  }
  const s = project.settings || {};
  const pw = s.page_width || 1600, ph = s.page_height || 2400;
  const readingDirection = s.reading_direction === "rtl" ? "rtl" : "ltr";
  const pagePaths = [...fileMap.keys()].filter((p) => p.startsWith(root + "pages/") && IMG_RE.test(p)).sort(naturalCompare);
  if (!pagePaths.length) throw new Error("no pages/ images");

  /* Match pages to storyboard entries by explicit page number, not array index.
     Storyboard pages carry a `number` field and files are named page-%03d.<ext>. */
  const storyboardPages = storyboard.pages || [];
  const sbPages = storyboardPages.slice().sort((a, b) => {
    const an = (a && typeof a.number === "number") ? a.number : Infinity;
    const bn = (b && typeof b.number === "number") ? b.number : Infinity;
    return an - bn;
  });
  const basename = (p) => p.slice(p.lastIndexOf("/") + 1).replace(IMG_RE, "");
  const numberedPages = sbPages.filter((sb) => sb && typeof sb.number === "number");
  const pageNumbers = new Set(numberedPages.map((sb) => sb.number));
  const hasDuplicateNumbers = pageNumbers.size !== numberedPages.length;
  const byName = new Map();
  if (!hasDuplicateNumbers) {
    for (const sb of numberedPages) {
      byName.set(`page-${String(sb.number).padStart(3, "0")}`, sb);
    }
  }
  const matched = pagePaths.map((p) => byName.get(basename(p)));
  const allMatched = !hasDuplicateNumbers && matched.every((m) => m != null);
  if (!allMatched) {
    console.warn("Comic Sol: could not match every page image to a storyboard page by number; falling back to index order.");
  }
  const byNumber = allMatched ? matched : storyboardPages;

  const pages = pagePaths.map((p, i) => {
    const sb = byNumber[i];
    let panels = null;
    if (sb && sb.layout === "custom") {
      console.warn(`Comic Sol page ${i + 1} uses a custom layout; using automatic panel detection.`);
    } else {
      panels = panelsFromStoryboard(sb, pw, ph);
    }
    /* motion-comic sources: unlettered panel art plus its storyboard text */
    const motionPanels = Array.isArray(sb?.panels) ? sb.panels.map((panel) => {
      const id = typeof panel?.id === "string" ? panel.id : "";
      const cleanPath = id ? `${root}panels/${id}/clean.png` : "";
      return {
        id,
        rect: panel?.rect,
        text: Array.isArray(panel?.text) ? panel.text : [],
        clean: cleanPath && fileMap.has(cleanPath) ? fileMap.get(cleanPath) : null,
      };
    }) : [];
    const source = fileMap.get(p)?.resumeSource || [p];
    const cleanSources = Array.isArray(sb?.panels) ? sb.panels.flatMap((panel) => {
      const id = typeof panel?.id === "string" ? panel.id : "";
      if (!id) return [];
      const cleanPath = `${root}panels/${id}/clean.png`;
      return fileMap.get(cleanPath)?.resumeSource || [cleanPath];
    }) : [];
    return { get: fileMap.get(p), panels, motionPanels, srcW: pw, srcH: ph,
      resumeSource: [...source, ...sbSignature(sb), ...cleanSources] };
  });
  /* motion-comic mode needs every panel: clean art + a rect to place it in */
  const motionComic = pages.every((page) => page.motionPanels.length > 0
    && page.motionPanels.every((panel) => panel.id && panel.clean && validRect(panel.rect, pw, ph)));
  const title = project.title || (project.project_id ? prettifySlug(project.project_id) : "") || fallbackTitle;
  return {
    title,
    /* Keep resume storage compatible with the title used before project IDs
       became presentation-friendly. */
    resumeId: project.title || project.project_id || fallbackTitle,
    comicSol: true,
    motionComic,
    readingDirection,
    pages,
    ...(logline ? { subtitle: logline } : {}),
    ...(schemaNote ? { schemaNote } : {}),
  };
}

/* ---------------- input handling ---------------- */

function fileMapFromFiles(files) {
  /* FileList with webkitRelativePath (dir) or plain names */
  const map = new Map();
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
    /* strip the top-level folder name when present */
    const key = f.webkitRelativePath ? rel : f.name;
    const getter = async () => f;
    getter.resumeSource = [key, f.size, f.lastModified];
    map.set(key, getter);
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
    const key = e.name.slice(prefix.length);
    const getter = async () => zip.extract(e);
    getter.resumeSource = [key, e.compSize, e.uncompSize, e.crc];
    map.set(key, getter);
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
      book = { title: files[0].name, comicSol: false, pages: [{ get: async () => files[0], panels: null, path: files[0].name, size: files[0].size, lastModified: files[0].lastModified }] };
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
      srcW: 1600, srcH: 2400, path: p.image,
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
  readingDirection: "ltr",
  page: 0,
  panel: 0,
  urls: [],       /* object URL or in-flight promise per page */
  panelCache: [], /* resolved panel rects per page (image coords) */
  guided: null,
  motion: null,
  motionUrls: [],
};

/* bumped by every render()/close so stale async continuations can bail out */
let renderGen = 0;
const staleRender = (gen) => gen !== renderGen || !state.book;

function bookKey(book) {
  const sources = (book.pages || []).flatMap((page) => page.resumeSource || [page.path || "", page.size ?? ""]);
  const prefix = "panelview:" + (book.resumeId || book.title) + ":" + book.pages.length;
  return prefix + ":" + resumeFingerprint(sources);
}

function legacyBookKey(book) {
  return "panelview:" + (book.resumeId || book.title) + ":" + book.pages.length;
}

function loadResume(book) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(bookKey(book)) || "null");
    /* Legacy records (pre-fingerprint keys) are intentionally not adopted or
       deleted: the old key is unscoped, so auto-migration could copy another
       same-title book's progress. Users keep at most one stale record. */
  } catch {}
  return saved;
}
/* motion-comic mode exists only when every panel ships unlettered clean art */
function modeSupported(book, mode) {
  if (!book || !Array.isArray(book.pages) || !book.pages.length) return false;
  if (mode !== "motion") return true;
  return !!book.motionComic;
}

async function pageURL(i) {
  /* store the promise so concurrent callers share one fetch + one object URL */
  if (!state.urls[i]) {
    const p = state.book.pages[i].get().then((blob) => {
      const url = URL.createObjectURL(blob);
      if (state.urls[i] === p) state.urls[i] = url;
      /* closed (or reopened) while in flight: nothing will revoke this slot later */
      else URL.revokeObjectURL(url);
      return url;
    });
    /* don't cache failures: clear the slot so the next call can retry */
    p.catch(() => { if (state.urls[i] === p) state.urls[i] = null; });
    state.urls[i] = p;
  }
  return state.urls[i];
}

async function openBook(book) {
  closeBook();
  state.book = book;
  state.urls = new Array(book.pages.length);
  state.panelCache = new Array(book.pages.length);
  $("#book-title").textContent = book.title;
  const subtitle = $("#book-subtitle");
  if (subtitle) {
    subtitle.textContent = book.subtitle || "";
    subtitle.hidden = !book.subtitle;
    $("#book-title").title = book.subtitle || "";
  }
  const schemaWarning = $("#schema-warning");
  if (schemaWarning) {
    schemaWarning.hidden = !book.schemaNote || book.schemaNote === "legacy";
    schemaWarning.textContent = book.schemaNote === "legacy" ? "" : book.schemaNote;
  }
  $("#landing").hidden = true;
  $("#reader").hidden = false;
  /* resume */
  const saved = loadResume(book);
  state.mode = saved?.mode || (book.comicSol ? "guided" : "page");
  state.readingDirection = saved?.direction || book.readingDirection || "ltr";
  updateDirectionButton();
  if (!modeSupported(book, state.mode)) state.mode = "guided";
  const motionButton = document.querySelector('#modes button[data-mode="motion"]');
  if (motionButton) motionButton.hidden = !modeSupported(book, "motion");
  state.page = Math.min(saved?.page || 0, book.pages.length - 1);
  state.panel = saved?.panel || 0;
  await render();
  showHint(navigationHint(state.readingDirection, state.mode === "guided"));
}

function navigationHint(direction = "ltr", guided = false) {
  const forward = direction === "rtl" ? "←" : "→";
  return guided ? `${forward} / space / click: next panel · 1 2 3: switch mode` : `${forward} / click: next · 1 2 3: switch mode`;
}

function closeBook() {
  ++renderGen; /* invalidate any in-flight render continuation */
  for (const u of state.urls || []) {
    /* state.urls may hold in-flight promises; only revoke settled object URLs */
    if (u && typeof u === "string") URL.revokeObjectURL(u);
  }
  for (const u of state.motionUrls || []) URL.revokeObjectURL(u);
  state.book = null; state.urls = []; state.motionUrls = []; state.guided = null; state.motion = null;
  $("#reader").hidden = true;
  $("#landing").hidden = false;
}

function persist() {
  if (!state.book) return;
  try {
    localStorage.setItem(bookKey(state.book), JSON.stringify({ mode: state.mode, page: state.page, panel: state.panel, direction: state.readingDirection }));
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
  ++renderGen;
  stage.className = "mode-" + state.mode;
  stage.innerHTML = "";
  for (const u of state.motionUrls || []) URL.revokeObjectURL(u);
  state.motionUrls = [];
  state.guided = null;
  state.motion = null;
  document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  if (state.mode === "page") await renderPage();
  else if (state.mode === "webtoon") await renderWebtoon();
  else if (state.mode === "motion") await renderMotion();
  else await renderGuided();
  persist();
}

async function renderPage() {
  const gen = renderGen;
  const img = new Image();
  img.src = await pageURL(state.page);
  if (staleRender(gen)) return;
  stage.appendChild(img);
  updatePos(`${state.page + 1} / ${state.book.pages.length}`);
  setProgress((state.page + 1) / state.book.pages.length);
  preload(state.page + 1);
}

async function renderWebtoon() {
  const gen = renderGen;
  const col = document.createElement("div");
  col.className = "col";
  stage.appendChild(col);
  for (let i = 0; i < state.book.pages.length; i++) {
    const img = new Image();
    img.loading = "lazy";
    img.src = await pageURL(i);
    if (staleRender(gen)) return;
    img.dataset.index = i;
    col.appendChild(img);
  }
  if (staleRender(gen)) return;
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
  const gen = renderGen;
  const viewport = document.createElement("div");
  viewport.className = "guided-viewport";
  const canvas = document.createElement("div");
  canvas.className = "guided-canvas";
  const img = new Image();
  img.src = await pageURL(state.page);
  if (staleRender(gen)) return;
  await img.decode();
  if (staleRender(gen)) return;
  canvas.appendChild(img);
  const dim = document.createElement("div");
  dim.className = "guided-dim";
  canvas.appendChild(dim);
  viewport.appendChild(canvas);
  stage.appendChild(viewport);
  const rects = await panelsFor(state.page, img);
  if (staleRender(gen)) return;
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

/* ----- motion-comic: clean art + text overlay per panel ----- */

async function renderMotion() {
  const gen = renderGen;
  const page = state.book.pages[state.page];
  if (!page?.motionPanels?.length) { await renderGuided(); return; }
  const viewport = document.createElement("div");
  viewport.className = "motion-viewport";
  const canvas = document.createElement("div");
  canvas.className = "motion-canvas";
  canvas.style.width = `${state.book.pages[state.page].srcW}px`;
  canvas.style.height = `${state.book.pages[state.page].srcH}px`;
  for (const mp of page.motionPanels) {
    const blob = await mp.clean();
    if (staleRender(gen)) { URL.revokeObjectURL(URL.createObjectURL(blob)); return; }
    const url = URL.createObjectURL(blob);
    state.motionUrls.push(url);
    const panel = document.createElement("div");
    panel.className = "motion-panel";
    Object.assign(panel.style, { left: `${mp.rect.x}px`, top: `${mp.rect.y}px`, width: `${mp.rect.width}px`, height: `${mp.rect.height}px` });
    const img = new Image();
    img.src = url;
    img.alt = mp.id;
    panel.appendChild(img);
    for (const item of mp.text) {
      const label = document.createElement("p");
      label.className = `motion-text motion-text-${item.anchor || "top-left"}`;
      label.textContent = item.content || "";
      if (item.speaker) label.dataset.speaker = item.speaker;
      panel.appendChild(label);
    }
    canvas.appendChild(panel);
  }
  viewport.appendChild(canvas);
  stage.appendChild(viewport);
  state.panel = Math.min(state.panel || 0, page.motionPanels.length - 1);
  state.motion = { viewport, canvas };
  frameMotionPanel(false);
}

function frameMotionPanel(animate = true) {
  const m = state.motion;
  if (!m) return;
  const panels = state.book.pages[state.page].motionPanels;
  state.panel = Math.min(state.panel || 0, panels.length - 1);
  const r = panels[state.panel].rect;
  const vw = m.viewport.clientWidth, vh = m.viewport.clientHeight;
  const pad = 0.045;
  const scale = Math.min(vw / (r.width * (1 + pad * 2)), vh / (r.height * (1 + pad * 2)));
  const tx = vw / 2 - (r.x + r.width / 2) * scale;
  const ty = vh / 2 - (r.y + r.height / 2) * scale;
  if (!animate) m.canvas.style.transition = "none";
  m.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  [...m.canvas.querySelectorAll(".motion-panel")].forEach((el, i) => el.classList.toggle("current", i === state.panel));
  if (!animate) requestAnimationFrame(() => { m.canvas.style.transition = ""; });
  updatePos(`p${state.page + 1} · panel ${state.panel + 1}/${panels.length}`);
  setProgress((state.page + state.panel / panels.length + 1 / panels.length) / state.book.pages.length);
  persist();
}

const fitMotionCanvas = (animate) => frameMotionPanel(animate);

/* Physical input → logical traversal. Keep next()/prev() direction-neutral so
   panel order and page order remain manifest-defined. */
function navigationIntent(input, direction = "ltr") {
  const rtl = direction === "rtl";
  if (input === "PageDown" || input === " ") return "next";
  if (input === "PageUp") return "prev";
  if (input === "ArrowRight") return rtl ? "prev" : "next";
  if (input === "ArrowLeft") return rtl ? "next" : "prev";
  if (input === "swipe-left") return rtl ? "prev" : "next";
  if (input === "swipe-right") return rtl ? "next" : "prev";
  if (input === "click-left") return rtl ? "next" : "prev";
  if (input === "click-right") return rtl ? "prev" : "next";
  return input;
}

/* A qualifying swipe must not also be handled as the browser's synthetic click. */
let swipeHandledZone = null;
let swipeHandledAt = 0;
function markSwipeHandled(zone, now = Date.now()) {
  swipeHandledZone = typeof zone === "number" ? (zone < 0.3 ? "click-left" : "click-right") : zone;
  swipeHandledAt = now;
}
function consumeSwipeClick(zone, now = Date.now()) {
  if (swipeHandledZone === zone && swipeHandledAt && now - swipeHandledAt < 700) {
    swipeHandledZone = null;
    swipeHandledAt = 0;
    return true;
  }
  return false;
}

/* Toolbar controls keep their native keyboard activation. */
function isInteractiveTarget(node) {
  return !!(node && node.closest && node.closest("button, a, input, select, textarea, [contenteditable='true']"));
}

function stageClickIntent(x, direction = "ltr", now = Date.now()) {
  const zone = x < 0.3 ? "click-left" : "click-right";
  if (consumeSwipeClick(zone, now)) return null;
  return navigationIntent(zone, direction);
}

/* Horizontal swipes follow the same mode rules as click navigation. */
function swipeIntent(mode, dx, direction = "ltr") {
  if (mode === "webtoon") return null;
  return navigationIntent(dx < 0 ? "swipe-left" : "swipe-right", direction);
}

function keyboardIntent(event, direction = "ltr") {
  if (isInteractiveTarget(event.target)) return null;
  return navigationIntent(event.key, direction);
}

function updateDirectionButton() {
  const button = $("#btn-direction");
  if (!button) return;
  button.textContent = state.readingDirection === "rtl" ? "RTL" : "LTR";
  button.title = `Reading direction: ${state.readingDirection.toUpperCase()} (click to toggle)`;
  button.setAttribute("aria-label", button.title);
}

function toggleDirection() {
  if (!state.book) return;
  state.readingDirection = state.readingDirection === "rtl" ? "ltr" : "rtl";
  updateDirectionButton();
  persist();
}

/* ---------------- navigation ---------------- */

async function next() {
  if (!state.book) return;
  if (state.mode === "motion" && state.motion) {
    if (state.panel < state.book.pages[state.page].motionPanels.length - 1) { state.panel++; frameMotionPanel(); return; }
    if (state.page < state.book.pages.length - 1) { state.page++; state.panel = 0; await render(); return; }
    showHint("The end — Esc to close");
    return;
  }
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
  if (state.mode === "motion" && state.motion) {
    if (state.panel > 0) { state.panel--; frameMotionPanel(); return; }
    if (state.page > 0) { state.page--; state.panel = 1e9; await render(); return; }
    return;
  }
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
  if (!modeSupported(state.book, mode)) return;
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
$("#btn-direction")?.addEventListener("click", toggleDirection);

stage.addEventListener("click", (e) => {
  if (state.mode === "webtoon") return;
  const intent = stageClickIntent(e.clientX / window.innerWidth, state.readingDirection);
  if (intent === "prev") prev(); else if (intent === "next") next();
});

document.addEventListener("keydown", (e) => {
  if (!state.book) return;
  const intent = keyboardIntent(e, state.readingDirection);
  if (!intent) return;
  switch (e.key) {
    case "ArrowRight": case " ": case "PageDown":
      e.preventDefault(); navigationIntent(e.key, state.readingDirection) === "prev" ? prev() : next(); break;
    case "ArrowLeft": case "PageUp":
      e.preventDefault(); navigationIntent(e.key, state.readingDirection) === "prev" ? prev() : next(); break;
    case "1": setMode("page"); break;
    case "2": setMode("webtoon"); break;
    case "3": setMode("guided"); break;
    case "4": setMode("motion"); break;
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
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    const zone = dx < 0 ? "click-left" : "click-right";
    markSwipeHandled(zone);
    const intent = swipeIntent(state.mode, dx, state.readingDirection);
    if (intent === "prev") prev();
    else if (intent === "next") next();
  }
  touchX = null;
}, { passive: true });

window.addEventListener("resize", () => {
  if (state.mode === "guided") frameCurrentPanel(false);
  else if (state.mode === "motion") frameMotionPanel(false);
});

/* expose internals for test.html */
window.__panelview = { readZip, layoutRects, naturalCompare, runsOf, fileMapFromZip, bookFromFileMap, bookKey, legacyBookKey, loadResume, navigationIntent, navigationHint, stageClickIntent, swipeIntent, markSwipeHandled, consumeSwipeClick, isInteractiveTarget, toggleDirection, state, setMode, next, prev };
