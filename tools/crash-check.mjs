#!/usr/bin/env node
/* Regression check for the runner's own failure mode: if Chrome dies mid-run,
   run-tests.mjs must exit non-zero instead of awaiting a CDP reply forever.

   Usage: node tools/crash-check.mjs */

import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DEADLINE_MS = 30_000;

const runner = spawn(process.execPath, ["tools/run-tests.mjs", "test.html"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
runner.stdout.on("data", (c) => { out += c; });
runner.stderr.on("data", (c) => { out += c; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkill = (pattern) => new Promise((ok) => execFile("pkill", ["-f", pattern], () => ok()));

/* wait for the runner's own Chrome (unique --user-data-dir) to be up, then kill it */
let killed = false;
for (let i = 0; i < 100 && !killed; i++) {
  await sleep(200);
  killed = await new Promise((ok) =>
    execFile("pgrep", ["-f", "panelview-ci-"], (err, stdout) => ok(!err && stdout.trim().length > 0)));
}
if (!killed) { console.error("FAIL: runner never started Chrome"); runner.kill("SIGKILL"); process.exit(2); }
await pkill("panelview-ci-");

const exit = await Promise.race([
  new Promise((ok) => runner.on("exit", (code) => ok(code))),
  sleep(DEADLINE_MS).then(() => "timeout"),
]);

if (exit === "timeout") {
  runner.kill("SIGKILL");
  console.error(`FAIL: runner still running ${DEADLINE_MS}ms after Chrome was killed (hang)`);
  process.exit(1);
}
if (exit === 0) {
  console.error("FAIL: runner reported success even though Chrome died");
  process.exit(1);
}
console.log(`PASS: runner exited ${exit} after Chrome was killed`);
