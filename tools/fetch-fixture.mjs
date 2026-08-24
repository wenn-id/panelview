#!/usr/bin/env node
/* Refresh (or verify) the Comic Sol parity fixture from wenn-id/comicsol at a
   pinned commit. The fixture is committed to the repo so the parity test runs
   offline and deterministically; this tool is how it gets updated, and
   `--check` proves the committed copy still matches the pinned ref.

   Usage: node tools/fetch-fixture.mjs [--check]
   Env:   GITHUB_TOKEN (optional, raises the anonymous API rate limit) */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/* pinned so a change upstream can never silently move this repo's expectations */
const REPO = "wenn-id/comicsol";
const REF = "678cfabfdfcc5cd21850cfe76136381f4915948c";
const SAMPLE = "samples/sunlight-courier";
const MANIFESTS = ["project.json", "plan/storyboard.json", "plan/story-plan.json"];

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "tests/fixtures/sunlight-courier");
const check = process.argv.includes("--check");

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "panelview-parity-fixture",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
async function getText(path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${SAMPLE}/${path}`;
  const res = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const tree = await getJson(`https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`);
if (tree.truncated) throw new Error("git tree response was truncated; fixture would be incomplete");
/* the parity net covers manifest parsing, so the fixture carries real manifest
   bytes plus the exact asset path list — not 20 MB of PNGs */
const files = tree.tree
  .filter((entry) => entry.type === "blob" && entry.path.startsWith(SAMPLE + "/"))
  .map((entry) => entry.path.slice(SAMPLE.length + 1))
  .sort();
if (!files.length) throw new Error(`no files found under ${SAMPLE} at ${REF}`);

const wanted = new Map([["files.json", JSON.stringify({ repo: REPO, ref: REF, sample: SAMPLE, files }, null, 2) + "\n"]]);
for (const path of MANIFESTS) {
  if (!files.includes(path)) throw new Error(`pinned ref is missing ${path}`);
  wanted.set(path, await getText(path));
}

let drift = 0;
for (const [path, content] of wanted) {
  const target = resolve(outDir, path);
  if (check) {
    let current = null;
    try { current = await readFile(target, "utf8"); } catch {}
    if (current !== content) { drift++; console.error(`DRIFT ${path}`); }
    continue;
  }
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, content);
  console.log(`wrote tests/fixtures/sunlight-courier/${path}`);
}

if (check) {
  if (drift) {
    console.error(`\n${drift} fixture file(s) differ from ${REPO}@${REF}. Run: node tools/fetch-fixture.mjs`);
    process.exit(1);
  }
  console.log(`fixture matches ${REPO}@${REF} (${files.length} sample files)`);
}
