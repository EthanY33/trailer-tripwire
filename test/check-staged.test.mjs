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
import { fileURLToPath } from "node:url";

import { checkStaged, scopeOf } from "../src/check-staged.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tt-check-")));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));
fs.writeFileSync(path.join(ROOT, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CEILING_DIRECTORIES = ROOT;

// A private temp directory, so a test can tell that check cleaned up after
// itself. os.tmpdir() reads these variables on every call.
const TMP = path.join(ROOT, "tmp");
fs.mkdirSync(TMP);
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

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
// and the test log stays quiet. Every run must leave the temp directory empty.
function check(opts) {
  const out = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  console.warn = (...a) => out.push(a.join(" "));
  let result;
  try {
    result = checkStaged(opts);
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(fs.readdirSync(TMP), [], "check must delete its temp files");
  return { ...result, out: out.join("\n") };
}

test("a staged video whose name git would C-quote is audited, not skipped", { timeout: TIMEOUT }, () => {
  const repo = makeRepo();
  // "e" with an acute accent, built from its code point so this file stays ASCII.
  const name = `brand/trailers/trailer-${String.fromCodePoint(0xe9)}.mp4`;
  stage(repo, name, SLIDESHOW);
  // Without -z git prints this name quoted, with octal escapes.
  assert.match(git(repo, "diff", "--cached", "--name-only"), /^"brand\/trailers\/trailer-\\303\\251\.mp4"$/);

  // A second quoted name (two CJK characters and a space) with content that
  // cannot be audited: both are reported, and CRITICAL decides the exit code.
  const unreadable = `brand/trailers/${String.fromCodePoint(0x4e88, 0x544a)} v2.mp4`;
  stage(repo, unreadable, GARBAGE);

  const r = check({ cwd: repo });
  assert.equal(r.exitCode, 1, r.out);
  assert.equal(r.blocked, 1, r.out);
  assert.equal(r.errored, 1, r.out);
  assert.ok(r.out.includes(name), r.out);
  assert.ok(r.out.includes(unreadable), r.out);
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

test("check audits the staged blob, not a later working tree edit", { timeout: 2 * TIMEOUT }, () => {
  const repo = makeRepo();
  const rel = "brand/trailers/f.mp4";

  // Blocked version staged, then re-exported over the same path without git add.
  stage(repo, rel, SLIDESHOW);
  put(repo, rel, CLEAN);
  assert.equal(git(repo, "status", "--porcelain").slice(0, 2), "AM");
  const bad = check({ cwd: repo });
  assert.equal(bad.exitCode, 1, bad.out);
  assert.equal(bad.blocked, 1, bad.out);

  // The other way round: what is staged is fine, the working file is not.
  git(repo, "add", "--", rel);
  put(repo, rel, SLIDESHOW);
  const good = check({ cwd: repo });
  assert.equal(good.exitCode, 0, good.out);
  assert.equal(good.blocked, 0, good.out);
  assert.equal(good.errored, 0, good.out);
});

test("a staged video that was deleted from the working tree is still audited", { timeout: TIMEOUT }, () => {
  const repo = makeRepo();
  const abs = path.join(repo, "gone.mp4");
  stage(repo, "gone.mp4", SLIDESHOW);
  fs.rmSync(abs);

  const r = check({ cwd: repo });
  assert.equal(r.exitCode, 1, r.out);
  assert.equal(r.blocked, 1, r.out);
  assert.doesNotMatch(r.out, /skipping/);
  assert.ok(!fs.existsSync(abs), "check must not write into the working tree");
});

test("check run from a subdirectory audits the staged videos", { timeout: TIMEOUT }, () => {
  const repo = makeRepo();
  stage(repo, "brand/trailers/new.mp4", SLIDESHOW);

  const r = check({ cwd: path.join(repo, "brand") });
  assert.equal(r.exitCode, 1, r.out);
  assert.equal(r.blocked, 1, r.out);
  assert.match(r.out, /brand\/trailers\/new\.mp4/);
});

test("a corrupt or empty staged video blocks the commit instead of passing", () => {
  const repo = makeRepo();
  stage(repo, "corrupt.mp4", GARBAGE);
  stage(repo, "zero.mp4", Buffer.alloc(0));

  const r = check({ cwd: repo });
  assert.equal(r.exitCode, 2, r.out);
  assert.equal(r.errored, 2, r.out);
  assert.equal(r.blocked, 0, r.out);
  assert.match(r.out, /^ {2}! corrupt\.mp4: could not be audited: \S.*$/m);
  assert.match(r.out, /^ {2}! zero\.mp4: could not be audited: \S.*$/m);
  assert.match(r.out, /2 staged video file\(s\) could not be audited, commit blocked/);
  assert.doesNotMatch(r.out, /not blocking/);
  assert.ok(!r.out.includes(TMP), `the reason must name the staged path, not the temp file: ${r.out}`);
});

// Run the real CLI in a child process. NoDefaultCurrentDirectoryInExePath is
// left as the caller has it.
function cli(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("the CLI exits 2 when a staged video cannot be audited", () => {
  const repo = makeRepo();
  stage(repo, "brand/trailers/corrupt.mp4", GARBAGE);

  const r = cli(repo, ["check", "--dir", "brand/trailers/"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /corrupt\.mp4: could not be audited/);
  assert.deepEqual(fs.readdirSync(TMP), []);
});

test("a missing ffmpeg binary blocks a known-CRITICAL video with one clear reason", () => {
  const repo = makeRepo();
  stage(repo, "brand/trailers/slideshow.mp4", SLIDESHOW);

  // ffmpeg-static takes its binary path from FFMPEG_BIN. A path with nothing
  // behind it is what an install with scripts disabled leaves you with.
  const missing = path.join(ROOT, "no-such-ffmpeg");
  const r = cli(repo, ["check"], { FFMPEG_BIN: missing });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /ffmpeg binary is missing/);
  assert.ok(r.out.includes(missing), r.out);
  assert.match(r.out, /1 staged video file\(s\) could not be audited, commit blocked/);
  assert.doesNotMatch(r.out, /Cannot read properties/);
});

test("check blocks with a reason when it cannot create its temp directory", () => {
  const repo = makeRepo();
  stage(repo, "clip.mp4", GARBAGE);

  process.env.TMPDIR = process.env.TEMP = process.env.TMP = path.join(ROOT, "no-such-dir");
  try {
    const r = check({ cwd: repo });
    assert.equal(r.exitCode, 2, r.out);
    assert.equal(r.errored, 1, r.out);
    assert.match(r.out, /^trailer-tripwire: cannot create a temp directory: \S/m);
  } finally {
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
  }
});

test("check fails with a reason outside a git repository", () => {
  const dir = makeDir("plain");
  const r = check({ cwd: dir });
  assert.equal(r.exitCode, 2, r.out);
  assert.match(r.out, /^trailer-tripwire: cannot find the repository root: \S/);
  assert.equal(r.out.split("\n").length, 1, "the reason is one line");
});

// The staged paths a run tried to audit. The files in these tests hold
// garbage, so each one in scope shows up as "could not be audited".
function audited(opts) {
  const r = check(opts);
  return [...r.out.matchAll(/^ {2}! (.+?): could not be audited/gm)].map((m) => m[1]).sort();
}

test("every spelling of --dir becomes the same directory scope", () => {
  const repo = makeRepo();
  const abs = path.join(repo, "brand", "trailers");
  fs.mkdirSync(abs, { recursive: true });
  const BS = String.fromCharCode(92); // a backslash, as typed in cmd.exe or PowerShell

  for (const dir of [
    "brand/trailers/",
    "brand/trailers",
    "./brand/trailers/",
    "./brand/trailers",
    "brand//trailers/",
    "brand/./trailers",
    "other/../brand/trailers/",
    `brand${BS}trailers${BS}`,
    `.${BS}brand${BS}trailers`,
    abs,
    abs + path.sep,
    path.join(repo, "brand", "missing", "..", "trailers"),
  ]) {
    assert.equal(scopeOf(dir, repo), "brand/trailers/", `--dir ${dir}`);
  }

  // The repository root is no restriction at all.
  for (const dir of [".", "./", repo, repo + path.sep]) {
    assert.equal(scopeOf(dir, repo), "", `--dir ${dir}`);
  }

  // Outside the repository nothing can ever match.
  for (const dir of ["..", "../elsewhere/", "brand/../../elsewhere", ROOT, path.join(ROOT, "elsewhere")]) {
    assert.equal(scopeOf(dir, repo), null, `--dir ${dir}`);
  }
});

test("--dir limits the audit to that directory and not to its name as a prefix", () => {
  const repo = makeRepo();
  stage(repo, "brand/trailers/a.mp4", GARBAGE);
  stage(repo, "brand/trailers-raw/b.mp4", GARBAGE);
  stage(repo, "other/c.mp4", GARBAGE);

  // A leading "./" used to match nothing, so the gate passed without a word.
  assert.deepEqual(audited({ cwd: repo, dir: "./brand/trailers/" }), ["brand/trailers/a.mp4"]);

  // No trailing slash used to take in brand/trailers-raw/ as well. A relative
  // --dir is relative to the repository root, not to the current directory.
  assert.deepEqual(audited({ cwd: path.join(repo, "other"), dir: "brand/trailers" }), ["brand/trailers/a.mp4"]);

  assert.deepEqual(
    audited({ cwd: repo, dir: "." }),
    ["brand/trailers-raw/b.mp4", "brand/trailers/a.mp4", "other/c.mp4"],
  );
});

test("--dir outside the repository is an error, not a scope that never matches", () => {
  const repo = makeRepo();
  stage(repo, "brand/trailers/a.mp4", GARBAGE);

  for (const dir of [ROOT, "../elsewhere/"]) {
    const r = check({ cwd: repo, dir });
    assert.equal(r.exitCode, 2, `--dir ${dir}: ${r.out}`);
    assert.match(r.out, /^trailer-tripwire: --dir .* is outside the repository/, `--dir ${dir}`);
  }
});

test("a run with no staged video in scope prints one skipping line and exits 0", () => {
  const repo = makeRepo();
  assert.equal(check({ cwd: repo }).out, "trailer-tripwire: no staged video files - skipping");

  stage(repo, "README.md", Buffer.from("notes\n"));
  stage(repo, "gameplay/clip.mp4", GARBAGE);

  const scoped = check({ cwd: repo, dir: "./brand/trailers" });
  assert.equal(scoped.exitCode, 0, scoped.out);
  assert.equal(scoped.out, "trailer-tripwire: no staged video files under brand/trailers/ - skipping");

  const otherExt = check({ cwd: repo, ext: ["webm"] });
  assert.equal(otherExt.exitCode, 0, otherExt.out);
  assert.equal(otherExt.out, "trailer-tripwire: no staged video files - skipping");
});
