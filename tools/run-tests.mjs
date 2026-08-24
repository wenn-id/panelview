#!/usr/bin/env node
/* Headless test runner: serves the repo, opens each test page in Chrome, and
   exits non-zero unless every page sets document.title === "PASS".

   Usage: node tools/run-tests.mjs [page ...]      (default: test.html)
   Env:   CHROME=/path/to/chrome  PORT=8765  SHOT_DIR=failure-screenshot dir

   Zero dependencies on purpose — the repo itself is zero-build, and CI should
   only run the static files, never build them. */

import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import os from "node:os";

const root = resolve(import.meta.dirname, "..");
const pages = process.argv.slice(2);
if (!pages.length) pages.push("test.html");
/* 0 = let the OS pick a free port, so a stale server can't wedge the run */
const wantPort = Number(process.env.PORT || 0);
/* screenshots of failing pages land here (CI uploads it as an artifact) */
const shotDir = process.env.SHOT_DIR || join(root, "shots");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".yml": "text/yaml", ".yaml": "text/yaml", ".svg": "image/svg+xml",
};

const server = createHttpServer(async (req, res) => {
  /* strip query, decode, and refuse anything that escapes the repo root */
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const file = resolve(root, normalize(rel) || "index.html");
  if (!file.startsWith(root)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(wantPort, "127.0.0.1", r));
const port = server.address().port;

const chromePath = process.env.CHROME
  || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!chromePath) {
  console.error("No Chrome/Chromium found. Set CHROME=/path/to/chrome.");
  process.exit(2);
}

const userDataDir = mkdtempSync(join(os.tmpdir(), "panelview-ci-"));
/* --remote-debugging-port=0 lets Chrome pick a free port and write it to
   DevToolsActivePort, so parallel/stale runs can never collide. */
const chrome = spawn(chromePath, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  `--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", "about:blank",
], { stdio: "ignore" });

/* runs on normal exit AND on an uncaught throw, so a crashed Chrome can't leak
   a temp profile or hold the port */
process.on("exit", () => {
  chrome.kill("SIGKILL");
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  server.close();
});

const getJson = (url) => new Promise((ok, bad) => {
  const req = request(url, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { body += c; });
    res.on("end", () => { try { ok(JSON.parse(body)); } catch (e) { bad(e); } });
  });
  req.on("error", bad);
  req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cdpEndpoint = null;
for (let i = 0; i < 100 && !cdpEndpoint; i++) {
  try {
    const [portLine] = (await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")).split("\n");
    const version = await getJson(`http://127.0.0.1:${portLine}/json/version`);
    cdpEndpoint = version.webSocketDebuggerUrl;
  } catch { await sleep(100); }
}
if (!cdpEndpoint) { console.error("Chrome DevTools endpoint never came up"); process.exit(2); }

const ws = new WebSocket(cdpEndpoint);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let nextId = 0;
const pending = new Map();
let logs = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") logs.push("CONSOLE error " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
};
let cdpClosed = false;
/* a dead Chrome must never leave a request awaiting its reply forever */
ws.onclose = () => {
  cdpClosed = true;
  for (const resolve of pending.values()) resolve({ error: { message: "CDP connection closed" } });
  pending.clear();
};
const assertOk = (resp, what) => {
  if (resp.error || !resp.result) throw new Error(`CDP ${what} failed: ${resp.error?.message || "no result"}`);
};
const send = (method, params = {}, sessionId) => new Promise((ok) => {
  if (cdpClosed) { ok({ error: { message: "CDP connection closed" } }); return; }
  const id = ++nextId;
  pending.set(id, ok);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const targets = await send("Target.getTargets");
assertOk(targets, "Target.getTargets");
const target = targets.result.targetInfos.find((t) => t.type === "page");
if (!target) throw new Error("Chrome exposed no page target");
const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
assertOk(attached, "Target.attachToTarget");
const session = attached.result.sessionId;
await send("Runtime.enable", {}, session);
await send("Page.enable", {}, session);

let failures = 0;
for (const page of pages) {
  logs = [];
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/${page}` }, session);
  let report = "";
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (cdpClosed) throw new Error("Chrome exited before the page reported a result");
    const evaluated = await send("Runtime.evaluate", {
      expression: "document.title + '\\n' + (document.getElementById('out')?.textContent || '')",
      returnByValue: true,
    }, session);
    report = evaluated.result?.result?.value || "";
    if (/^(PASS|FAIL|ERROR)/.test(report)) break;
  }
  const ok = report.startsWith("PASS");
  if (!ok) {
    failures++;
    /* the report text is the primary evidence; the shot is for layout/CSS regressions */
    const shot = await send("Page.captureScreenshot", { captureBeyondViewport: true }, session);
    if (shot.result?.data) {
      await mkdir(shotDir, { recursive: true });
      const file = join(shotDir, page.replace(/[^\w.-]+/g, "_") + ".png");
      await writeFile(file, Buffer.from(shot.result.data, "base64"));
      console.log("screenshot: " + file);
    }
  }
  console.log(`\n=== ${page}: ${ok ? "PASS" : "FAIL"} ===`);
  console.log(report.split("\n").slice(1).join("\n").trim() || "(no report)");
  if (logs.length) console.log("--- page errors ---\n" + logs.join("\n"));
}

process.exit(failures ? 1 : 0);
