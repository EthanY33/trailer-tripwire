// Tests that git, ffprobe and yt-dlp are started from PATH and never from
// the current directory.
//
// A bare program name leaves the lookup to the OS. Windows tries the current
// directory first, and a "." entry in PATH does the same anywhere else, so a
// repository could ship its own git.exe and have the pre-commit hook run it.
// Each integration test plants a stand-in program in the current directory,
// runs the real code in a child process whose environment searches that
// directory first, and checks that the stand-in did not run.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveBin } from "../src/resolve-bin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "bin", "cli.mjs");
const SRC = path.resolve(HERE, "..", "src");
const WINDOWS = process.platform === "win32";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tt-bin-")));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));
fs.writeFileSync(path.join(ROOT, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CEILING_DIRECTORIES = ROOT;

let counter = 0;
function makeDir(prefix) {
  const dir = path.join(ROOT, `${prefix}-${++counter}`);
  fs.mkdirSync(dir);
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const dir = makeDir("repo");
  git(dir, "init", "-q");
  return dir;
}

// A file resolveBin accepts as the program `name`: any .exe on Windows, an
// executable file elsewhere.
function fakeProgram(dir, name) {
  const file = path.join(dir, WINDOWS ? `${name}.exe` : name);
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o755);
  return file;
}

// A stand-in that must never run. It answers a version query (-v, --version)
// with exit 0 and fails on anything else. On Windows that is exactly what a
// copy of node.exe does, and it is the one program every runner has.
let nodeCopy = null;
function plant(dir, name) {
  if (WINDOWS) {
    if (!nodeCopy) {
      nodeCopy = path.join(ROOT, "stand-in.exe");
      fs.copyFileSync(process.execPath, nodeCopy);
    }
    fs.linkSync(nodeCopy, path.join(dir, `${name}.exe`));
    return;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    "#!/bin/sh",
    'case "$1" in -v|--version) echo planted; exit 0;; esac',
    "exit 9",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}

// An environment in which the current directory is searched for programs
// first: "." leads PATH, and the Windows switch that turns the implicit
// current-directory lookup off is not set.
function cwdFirstEnv(searchPath = process.env.PATH, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (key !== "PATH" && key !== "NODEFAULTCURRENTDIRECTORYINEXEPATH") env[k] = v;
  }
  return { ...env, ...extra, PATH: `.${path.delimiter}${searchPath}` };
}

function node(cwd, args, env) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// A module script for a child process, written next to the repositories.
function script(name, lines) {
  const file = path.join(ROOT, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function srcUrl(file) {
  return JSON.stringify(pathToFileURL(path.join(SRC, file)).href);
}

test("resolveBin searches only absolute PATH entries other than the current directory", () => {
  const here = makeDir("cwd");
  const bin = makeDir("bin");
  fs.mkdirSync(path.join(here, "rel"));
  fakeProgram(here, "tool");
  fakeProgram(path.join(here, "rel"), "tool");
  const wanted = fakeProgram(bin, "tool");

  const unusable = ["", ".", "rel", here, here + path.sep];
  assert.equal(resolveBin("tool", { cwd: here, pathVar: [...unusable, bin].join(path.delimiter) }), wanted);
  assert.equal(resolveBin("tool", { cwd: here, pathVar: unusable.join(path.delimiter) }), null);
  assert.equal(resolveBin("tool", { cwd: here, pathVar: "" }), null);
  assert.equal(resolveBin("no-such-tool", { cwd: here, pathVar: bin }), null);

  // The process's own current directory is skipped as well as the cwd passed in.
  const own = [process.cwd(), bin].join(path.delimiter);
  assert.equal(resolveBin("tool", { cwd: here, pathVar: own }), wanted);
});

test("resolveBin accepts only a file it could start", () => {
  const here = makeDir("cwd");
  const first = makeDir("bin");
  const second = makeDir("bin");
  // A directory with the program's name is not the program.
  fs.mkdirSync(path.join(first, WINDOWS ? "tool.exe" : "tool"));
  const wanted = fakeProgram(second, "tool");
  const pathVar = [first, second].join(path.delimiter);
  assert.equal(resolveBin("tool", { cwd: here, pathVar }), wanted);

  if (!WINDOWS) {
    const third = makeDir("bin");
    fs.writeFileSync(path.join(third, "tool"), "");
    fs.chmodSync(path.join(third, "tool"), 0o644);
    assert.equal(resolveBin("tool", { cwd: here, pathVar: [third, second].join(path.delimiter) }), wanted);
  }
});

test("check runs the git on PATH, not one planted in the repository", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "clip.mp4"), Buffer.alloc(4096, 7));
  git(repo, "add", "--", "clip.mp4");
  plant(repo, "git");

  const r = node(repo, [CLI, "check"], cwdFirstEnv());
  // Real git listed the staged file, and its garbage content could not be audited.
  assert.match(r.out, /clip\.mp4: could not be audited/, r.out);
  assert.equal(r.status, 2, r.out);
});

test("install-hooks runs the git on PATH, not one planted in the repository", () => {
  const repo = makeRepo();
  plant(repo, "git");

  const r = node(repo, [CLI, "install-hooks"], cwdFirstEnv());
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), r.out);
});

test("probe never runs an ffprobe planted in the current directory", async () => {
  const FFMPEG = (await import("ffmpeg-static")).default;
  const clip = path.join(ROOT, "clip.mp4");
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);

  const dir = makeDir("cwd");
  plant(dir, "ffprobe");
  const child = script("probe-child.mjs", [
    `import { probe } from ${srcUrl("video-analysis.mjs")};`,
    "console.log(JSON.stringify(probe(process.argv[2])));",
  ]);

  // The stand-in exits 0 on "-v" with output that is not JSON, so probe()
  // would throw if it ran.
  const r = node(dir, [child, clip], cwdFirstEnv());
  assert.equal(r.status, 0, r.out);
  const meta = JSON.parse(r.out);
  assert.equal(meta.width, 160);
  assert.ok(Math.abs(meta.durationSec - 1) < 0.2, r.out);
});

test("ingest never runs a yt-dlp planted in the current directory", () => {
  const dir = makeDir("cwd");
  plant(dir, "yt-dlp");
  const emptyBin = makeDir("bin");
  const emptyTmp = makeDir("tmp");
  const child = script("yt-child.mjs", [
    `import { downloadVideo } from ${srcUrl("yt-download.mjs")};`,
    "try {",
    '  downloadVideo("https://example.invalid/watch?v=abcdefgh", process.argv[2]);',
    '  console.log("RAN");',
    "} catch (e) {",
    '  console.log("ERR " + String(e.message).split("\\n")[0]);',
    "}",
  ]);

  // No yt-dlp can be reached except the planted one: PATH holds an empty
  // directory and the temp directory (the other place it is looked for) is
  // empty too. Nothing here touches the network.
  const env = cwdFirstEnv(emptyBin, { TMPDIR: emptyTmp, TEMP: emptyTmp, TMP: emptyTmp });
  const r = node(dir, [child, path.join(dir, "out")], env);
  assert.match(r.out, /^ERR yt-dlp not found/, r.out);
});

test("check with FFMPEG_BIN as a program name never runs an ffprobe or ffmpeg planted in the repository", async () => {
  const FFMPEG = (await import("ffmpeg-static")).default;
  const clip = path.join(ROOT, "short-clip.mp4");
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);

  const repo = makeRepo();
  fs.copyFileSync(clip, path.join(repo, "clip.mp4"));
  git(repo, "add", "--", "clip.mp4");
  plant(repo, "ffprobe");
  plant(repo, "ffmpeg");

  // The real ffmpeg is reachable only through PATH, after the leading ".".
  const env = cwdFirstEnv(path.dirname(FFMPEG) + path.delimiter + process.env.PATH, { FFMPEG_BIN: "ffmpeg" });
  const r = node(repo, [CLI, "check"], env);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no CRITICAL findings/, r.out);
});
