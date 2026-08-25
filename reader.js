/* PanelView — reader state, rendering, and navigation. MIT. */

import { IMG_RE, detectPanels } from "./detect.js";
import { resumeFingerprint, naturalCompare, layoutRects } from "./comicsol.js";

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
const thumbs = { open: false, rendered: false };
const thumbsEl = $("#thumbs");

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

function updateThumbActive() {
  if (!thumbsEl) return;
  thumbsEl.querySelectorAll("button[data-page]").forEach((button) => {
    button.classList.toggle("active", +button.dataset.page === state.page);
  });
}

async function jumpToPage(index) {
  if (!state.book) return;
  state.page = Math.max(0, Math.min(index, state.book.pages.length - 1));
  state.panel = 0;
  updateThumbActive();
  if (state.mode === "webtoon") {
    const target = stage.querySelector(`img[data-index="${state.page}"]`);
    if (target) stage.scrollTop = target.offsetTop;
    persist();
  } else {
    await render();
    if (thumbs.open) renderThumbs();
  }
}

async function renderThumbs() {
  if (!thumbsEl || !thumbs.open || !state.book) return;
  thumbsEl.innerHTML = "";
  updateThumbActive();
  state.book.pages.forEach((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.page = String(index);
    button.setAttribute("aria-label", `Jump to page ${index + 1}`);
    const canvas = document.createElement("canvas");
    canvas.width = 120; canvas.height = 160;
    canvas.setAttribute("aria-hidden", "true");
    button.appendChild(canvas);
    button.addEventListener("click", () => { jumpToPage(index); });
    thumbsEl.appendChild(button);
    pageURL(index).then((url) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      };
      image.src = url;
    }).catch(() => {});
  });
  updateThumbActive();
}

function toggleThumbs() {
  if (!thumbsEl) return;
  thumbs.open = !thumbs.open;
  thumbsEl.hidden = !thumbs.open;
  thumbs.rendered = thumbs.open;
  const button = $("#btn-thumbs");
  if (button) {
    button.setAttribute("aria-expanded", String(thumbs.open));
    button.title = thumbs.open ? "Hide thumbnails (t)" : "Show thumbnails (t)";
  }
  if (thumbs.open) renderThumbs();
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
  /* focus management: move into the reader, return to the dropzone on close */
  $("#btn-close").focus({ preventScroll: true });
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
  thumbs.open = false;
  thumbs.rendered = false;
  if (thumbsEl) { thumbsEl.hidden = true; thumbsEl.replaceChildren(); }
  const thumbsButton = $("#btn-thumbs");
  if (thumbsButton) thumbsButton.setAttribute("aria-expanded", "false");
  $("#reader").hidden = true;
  $("#landing").hidden = false;
  /* return focus to the launcher so keyboard users stay oriented */
  const launcher = $("#dropzone");
  if (launcher) launcher.focus({ preventScroll: true });
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
  if (thumbs.open) updateThumbActive();
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
  if (shouldPrefetchNextPanel(state.panel, g.rects.length)) prefetchGuidedNext(state.page);
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

/* ----- guided next-page prefetch -----
   Within the last two panels of a page, warm the next page's object URL,
   decoded image, and panel cache so crossing the page boundary does not hitch. */
function shouldPrefetchNextPanel(panel, panelCount) {
  return panelCount > 0 && panel >= panelCount - 2;
}

async function prefetchGuidedNext(currentPage) {
  if (!state.book) return;
  const next = currentPage + 1;
  if (next >= state.book.pages.length) return;
  const url = await pageURL(next);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch {}
  if (state.book && state.page === currentPage && state.panelCache[next]) return;
  if (!state.panelCache[next]) {
    await panelsFor(next, img);
  }
}

async function setMode(mode) {
  if (!state.book || state.mode === mode) return;
  if (!modeSupported(state.book, mode)) return;
  state.mode = mode;
  await render();
}

/* ---------------- wire up ---------------- */


export { $, stage, state, thumbs, thumbsEl, staleRender, bookKey, legacyBookKey, loadResume,
  modeSupported, pageURL, updateThumbActive, jumpToPage, renderThumbs, toggleThumbs, openBook,
  navigationHint, closeBook, persist, setProgress, showHint, render, renderPage, renderWebtoon,
  panelsFor, renderGuided, frameCurrentPanel, renderMotion, frameMotionPanel, fitMotionCanvas,
  navigationIntent, markSwipeHandled, consumeSwipeClick, isInteractiveTarget, stageClickIntent,
  swipeIntent, keyboardIntent, updateDirectionButton, toggleDirection, next, prev, updatePos,
  preload, shouldPrefetchNextPanel, prefetchGuidedNext, setMode };
