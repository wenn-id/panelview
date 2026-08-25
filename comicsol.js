/* PanelView — Comic Sol model, layouts, and file maps. MIT. */

import { readZip } from "./zip.js";
import { IMG_RE, detectPanels } from "./detect.js";

export const TESTED_COMIC_SOL_SCHEMA_VERSIONS = new Set(["1.0"]);

export function naturalCompare(a, b) {
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


export { IMG_RE, readZip, resumeFingerprint, layoutRects, bookFromFileMap, comicSolBook,
  validRect, prettifySlug, panelsFromStoryboard, sbSignature, fileMapFromFiles, fileMapFromZip };
