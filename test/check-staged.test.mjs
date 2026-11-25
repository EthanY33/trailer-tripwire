// Integration tests for src/check-staged.mjs against real git repositories
// and the bundled ffmpeg.
//
// Every repository lives under one mkdtemp root that is removed when the file
// finishes. Git is cut off from the developer's own setup the same way
// test/install-hooks.test.mjs does it. Two fixtures are synthesized once:
// a black-gap slideshow that audit() rates CRITICAL (fade-to-black), and the
// same slides with hard cuts, which has no CRITICAL finding.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkStaged } from "../src/check-staged.mjs";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tt-check-")));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));
fs.writeFileSync(path.join(ROOT, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CEILING_DIRECTORIES = ROOT;

const FFMPEG = (await import("ffmpeg-static")).default;
const IDENTITY = ["-c", "user.name=tt", "-c", "user.email=tt@example.invalid"];

// One audit pass can take ~30s with ffmpeg-static on a cold runner.
const TIMEOUT = 120_000;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

let counter = 0;
function makeDir(prefix) {
  const dir = path.join(ROOT, `${prefix}-${++counter}`);
  fs.mkdirSync(dir);
  return dir;
}

function makeRepo() {
  const dir = makeDir("repo");
  git(dir, "init", "-q");
  assert.equal(fs.realpathSync.native(git(dir, "rev-parse", "--show-toplevel")), dir);
  return dir;
}

// Six solid-color slides. With gaps, every cut lands in a black window.
function synthesize(name, { blackGaps }) {
  const out = path.join(ROOT, name);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  let n = 0;
  for (const c of ["white", "red", "green", "yellow", "cyan", "magenta"]) {
    args.push("-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=25:d=1.6`);
    n++;
    if (blackGaps) {
      args.push("-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=0.6");
      n++;
    }
  }
  const inputs = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
  args.push("-filter_complex", `${inputs}concat=n=${n}:v=1:a=0[v]`, "-map", "[v]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out);
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  assert.equal(r.status, 0, `ffmpeg failed to synthesize ${name}: ${r.stderr}`);
  return out;
}

const SLIDESHOW = synthesize("slideshow.mp4", { blackGaps: true });
const CLEAN = synthesize("clean.mp4", { blackGaps: false });
const GARBAGE = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) % 251));

// Put a file into a repository's working tree: a Buffer is written as is, a
// string is the path of a fixture to copy.
function put(repo, rel, content) {
  const abs = path.join(repo, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (typeof content === "string") fs.copyFileSync(content, abs);
  else fs.writeFileSync(abs, content);
  return abs;
}

function stage(repo, rel, content) {
  put(repo, rel, content);
  git(repo, "add", "--", rel);
}

// Run checkStaged with console output captured, so messages can be asserted
// and the test log stays quiet.
function check(opts) {
  const out = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  console.warn = (...a) => out.push(a.join(" "));
  try {
    const result = checkStaged(opts);
    return { ...result, out: out.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

test("a staged video whose name git would C-quote is audited, not skipped", { timeout: TIMEOUT }, () => {
  const repo = makeRepo();
  // "e" with an acute accent, built from its code point so this file stays ASCII.
  const name = `brand/trailers/trailer-${String.fromCodePoint(0xe9)}.mp4`;
  stage(repo, name, SLIDESHOW);
  // Without -z git prints this name quoted, with octal escapes.
  assert.match(git(repo, "diff", "--cached", "--name-only"), /^"brand\/trailers\/trailer-\\303\\251\.mp4"$/);

  const r = check({ cwd: repo });
  assert.equal(r.exitCode, 1, r.out);
  assert.equal(r.blocked, 1, r.out);
  assert.ok(r.out.includes(name), r.out);
  assert.match(r.out, /fade-to-black/);
});

test("a video moved into the --dir scope with git mv is audited", { timeout: TIMEOUT }, () => {
  const repo = makeRepo();
  stage(repo, "wip/draft.mp4", SLIDESHOW);
  git(repo, ...IDENTITY, "commit", "-q", "-m", "draft");
  fs.mkdirSync(path.join(repo, "brand", "trailers"), { recursive: true });
  git(repo, "mv", "wip/draft.mp4", "brand/trailers/launch.mp4");
  // Git reports the move as a rename, which an added/modified filter drops.
  assert.match(git(repo, "diff", "--cached", "--name-status"), /^R\d*\twip\/draft\.mp4\tbrand\/trailers\/launch\.mp4$/);

  const r = check({ cwd: repo, dir: "brand/trailers/" });
  assert.equal(r.exitCode, 1, r.out);
  assert.equal(r.blocked, 1, r.out);
  assert.match(r.out, /brand\/trailers\/launch\.mp4/);
});
