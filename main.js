/* PanelView — browser entry point (zero-build ES modules). MIT. */

import * as zipMod from "./zip.js";
import * as detectMod from "./detect.js";
import * as comicsolMod from "./comicsol.js";
import * as readerMod from "./reader.js";

const { IMG_RE, layoutRects, bookFromFileMap, fileMapFromFiles, fileMapFromZip } = comicsolMod;
const { $, stage, state, openBook, closeBook, next, prev, setMode, toggleDirection, toggleThumbs,
  stageClickIntent, keyboardIntent, navigationIntent, swipeIntent, markSwipeHandled, frameCurrentPanel,
  frameMotionPanel } = readerMod;

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
$("#btn-thumbs")?.addEventListener("click", toggleThumbs);

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
    case "t": toggleThumbs(); break;
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


/* Test/debug surface kept stable across the module split. */
window.__panelview = { ...zipMod, ...detectMod, ...comicsolMod, ...readerMod };
Object.assign(window, window.__panelview);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
