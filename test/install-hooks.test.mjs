// Integration tests for src/install-hooks.mjs against real git repositories.
//
// Every repository is created under one mkdtemp root that is removed when
// the file finishes. Git is cut off from the developer's own setup first:
// inherited GIT_* variables are dropped (a test run started from a hook
// would otherwise point git at the outer repository), global and system
// config are ignored, and repository discovery stops at the temp root.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installHooks } from "../src/install-hooks.mjs";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tt-hooks-")));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }));
fs.writeFileSync(path.join(ROOT, "gitconfig"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CEILING_DIRECTORIES = ROOT;

const HEADER = [
  "#!/bin/sh",
  "# Pre-commit hook. Each tripwire gate below is a managed block:",
  "# its installer rewrites only the lines between its own markers.",
  "# Bypass once: git commit --no-verify (say why in the commit message).",
  "set -e",
  "",
  "",
].join("\n");

const IDENTITY = ["-c", "user.name=tt", "-c", "user.email=tt@example.invalid"];

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
  // The new repository, not some parent, must be what git resolves from here.
  assert.equal(fs.realpathSync.native(git(dir, "rev-parse", "--show-toplevel")), dir);
  return dir;
}

// Run installHooks with console output captured, so messages can be asserted
// and the test log stays quiet.
function install(opts) {
  const out = [];
  const err = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  console.warn = (...a) => err.push(a.join(" "));
  try {
    const result = installHooks(opts);
    return { ...result, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

function hookPath(repo) {
  return path.join(repo, ".git", "hooks", "pre-commit");
}

function writeHook(repo, text) {
  fs.mkdirSync(path.dirname(hookPath(repo)), { recursive: true });
  fs.writeFileSync(hookPath(repo), text);
}

function readHook(repo) {
  return fs.readFileSync(hookPath(repo), "utf8");
}

test("fresh install writes the shared header and one managed block, LF only", () => {
  const repo = makeRepo();
  const result = install({ cwd: repo, dir: "brand/trailers/" });

  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(result.target, hookPath(repo));
  assert.equal(
    readHook(repo),
    HEADER +
      "# trailer-tripwire:v1\n" +
      "npx --no -- trailer-tripwire check --dir 'brand/trailers/' || exit $?\n" +
      "# trailer-tripwire:v1 end\n",
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(hookPath(repo)).mode & 0o111, 0o111, "hook must be executable");
  }
});

test("the generated command cannot fall back to the npm registry", () => {
  const repo = makeRepo();
  install({ cwd: repo });
  const body = readHook(repo);

  // --no makes npx fail when the package is not installed, instead of
  // downloading whatever the registry serves under the name.
  assert.match(body, /^npx --no -- trailer-tripwire check \|\| exit \$\?$/m);
  assert.doesNotMatch(body, /npx\s+trailer-tripwire/, "no bare npx call may remain");
  assert.doesNotMatch(body, /^\s*exec\s/m, "exec would stop later gates from running");
});

test("installing twice leaves a byte-identical file", () => {
  const repo = makeRepo();
  install({ cwd: repo, dir: "brand/trailers/" });
  const first = readHook(repo);
  const second = install({ cwd: repo, dir: "brand/trailers/" });

  assert.equal(second.ok, true);
  assert.equal(second.action, "unchanged");
  assert.equal(readHook(repo), first);
});

test("re-install over a hand-merged hook keeps every foreign line", () => {
  const repo = makeRepo();
  // What a user ends up with after merging the old hook body into their own
  // hook by hand, as the old refusal message told them to.
  writeHook(repo, [
    "#!/usr/bin/env bash",
    "# trailer-tripwire:v1",
    "npm run lint",
    "npx lint-staged || exit 1",
    "# copy-tripwire:v1",
    "npx copy-tripwire check",
    "npx trailer-tripwire check",
    "",
  ].join("\n"));

  const result = install({ cwd: repo, dir: "x/" });
  assert.equal(result.ok, true);

  const lines = readHook(repo).split("\n");
  for (const kept of [
    "#!/usr/bin/env bash",
    "npm run lint",
    "npx lint-staged || exit 1",
    "# copy-tripwire:v1",
    "npx copy-tripwire check",
  ]) {
    assert.ok(lines.includes(kept), `line was deleted: ${kept}`);
  }
  assert.ok(
    lines.includes("npx --no -- trailer-tripwire check --dir 'x/' || exit $?"),
    "the trailer gate must carry the new --dir",
  );
  assert.equal(result.action, "appended");
  assert.ok(!lines.includes("npx trailer-tripwire check"), "the old bare command must be gone");

  // Changing --dir again touches the command line of the block and nothing else.
  const before = readHook(repo);
  const again = install({ cwd: repo, dir: "y/" });
  assert.equal(again.action, "updated");
  assert.equal(readHook(repo), before.replace("--dir 'x/'", "--dir 'y/'"));
});

test("an unrelated hook is refused untouched, and the printed block then installs cleanly", () => {
  const repo = makeRepo();
  const original = "#!/bin/sh\nnpm run lint\nnpm test\n";
  writeHook(repo, original);

  const refused = install({ cwd: repo, dir: "brand/trailers/" });
  assert.equal(refused.ok, false);
  assert.equal(readHook(repo), original, "a refused hook must not be modified");
  const block =
    "# trailer-tripwire:v1\n" +
    "npx --no -- trailer-tripwire check --dir 'brand/trailers/' || exit $?\n" +
    "# trailer-tripwire:v1 end";
  for (const line of block.split("\n")) {
    assert.ok(refused.stderr.includes(line), `refusal must print the block line: ${line}`);
  }
  assert.doesNotMatch(refused.stderr, /re-run/, "must not tell the user to merge and re-run");

  // The user follows the message and pastes the block in by hand.
  writeHook(repo, original + "\n" + block + "\n");
  const merged = readHook(repo);
  const rerun = install({ cwd: repo, dir: "brand/trailers/" });
  assert.equal(rerun.ok, true);
  assert.equal(rerun.action, "unchanged");
  assert.equal(readHook(repo), merged);

  const rescoped = install({ cwd: repo, dir: "other/" });
  assert.equal(rescoped.ok, true);
  assert.equal(readHook(repo), merged.replace("'brand/trailers/'", "'other/'"));
});

test("a v1.0.0 solo hook is migrated to the block format with the new --dir", () => {
  const repo = makeRepo();
  writeHook(repo, [
    "#!/usr/bin/env bash",
    "# trailer-tripwire:v1",
    "# Auto-installed by: trailer-tripwire install-hooks",
    "# Audits any staged video files for AI-default patterns.",
    "# Bypass with: git commit --no-verify",
    "",
    "npx trailer-tripwire check --dir 'old/'",
    "",
  ].join("\n"));

  const result = install({ cwd: repo, dir: "new/" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "migrated");
  assert.equal(
    readHook(repo),
    HEADER +
      "# trailer-tripwire:v1\n" +
      "npx --no -- trailer-tripwire check --dir 'new/' || exit $?\n" +
      "# trailer-tripwire:v1 end\n",
  );
});

test("a hook composed by the old copy-tripwire installer keeps all three gates", () => {
  const repo = makeRepo();
  writeHook(repo, [
    "#!/bin/sh",
    "# copy-tripwire:v1",
    "# trailer-tripwire:v1",
    "# screenshot-tripwire:v1",
    "# Composed pre-commit hook.",
    "set -e",
    "npx screenshot-tripwire check",
    "npx trailer-tripwire check",
    "exec npx copy-tripwire check",
    "",
  ].join("\n"));

  const result = install({ cwd: repo, dir: "brand/trailers/" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "migrated");
  assert.equal(
    readHook(repo),
    HEADER +
      "# screenshot-tripwire:v1\n" +
      "npx --no -- screenshot-tripwire check || exit $?\n" +
      "# screenshot-tripwire:v1 end\n" +
      "\n" +
      "# trailer-tripwire:v1\n" +
      "npx --no -- trailer-tripwire check --dir 'brand/trailers/' || exit $?\n" +
      "# trailer-tripwire:v1 end\n" +
      "\n" +
      "# copy-tripwire:v1\n" +
      "npx --no -- copy-tripwire check || exit $?\n" +
      "# copy-tripwire:v1 end\n",
  );
});

test("a block appended below an exec line comes with a warning", () => {
  const repo = makeRepo();
  writeHook(repo, "#!/bin/sh\n# copy-tripwire:v1\nexec npx copy-tripwire check --strict || true\n");

  const result = install({ cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.action, "appended");
  assert.match(result.stderr, /exec/);
  assert.match(result.stderr, /never run/);
});

test("a block appended below an unconditional exit comes with a warning", () => {
  const repo = makeRepo();
  writeHook(repo, "#!/bin/sh\n# copy-tripwire:v1\nnpm run lint || exit 1\nnpx copy-tripwire check || exit 1\nexit 0\n");

  const result = install({ cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(result.action, "appended");
  assert.match(result.stderr, /unconditional "exit"/);
  assert.match(result.stderr, /never run/);
});

test("a relative core.hooksPath is honoured, also from a subdirectory", () => {
  const repo = makeRepo();
  git(repo, "config", "core.hooksPath", ".githooks");
  const expected = path.join(repo, ".githooks", "pre-commit");

  const fromRoot = install({ cwd: repo });
  assert.equal(fromRoot.ok, true);
  assert.equal(fromRoot.target, expected);
  assert.ok(fs.existsSync(expected), "the hooks directory is created when missing");
  assert.ok(!fs.existsSync(hookPath(repo)), ".git/hooks must stay untouched");

  const sub = path.join(repo, "brand", "trailers");
  fs.mkdirSync(sub, { recursive: true });
  const fromSub = install({ cwd: sub, dir: "brand/trailers/" });
  assert.equal(fromSub.ok, true);
  assert.equal(fromSub.action, "updated");
  assert.equal(fromSub.target, expected);
  assert.ok(!fs.existsSync(path.join(sub, ".githooks")), "no stray hooks directory under the subdirectory");
});

test("an absolute core.hooksPath is honoured", () => {
  const repo = makeRepo();
  const hooks = path.join(makeDir("abs-hooks"), "nested");
  git(repo, "config", "core.hooksPath", hooks);

  const result = install({ cwd: repo });
  assert.equal(result.ok, true);
  assert.equal(path.resolve(result.target), path.join(hooks, "pre-commit"));
  assert.match(fs.readFileSync(path.join(hooks, "pre-commit"), "utf8"), /^# trailer-tripwire:v1$/m);
  assert.ok(!fs.existsSync(hookPath(repo)), ".git/hooks must stay untouched");
});

test("a linked worktree installs into the hooks directory git actually uses", () => {
  const repo = makeRepo();
  git(repo, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(ROOT, `worktree-${++counter}`);
  git(repo, "worktree", "add", "-q", "-b", "side", wt);

  const result = install({ cwd: wt });
  assert.equal(result.ok, true);
  assert.equal(
    fs.realpathSync.native(path.dirname(result.target)),
    fs.realpathSync.native(path.join(repo, ".git", "hooks")),
  );
  assert.match(readHook(repo), /^# trailer-tripwire:v1$/m);
  assert.ok(!fs.existsSync(path.join(wt, ".git", "hooks")), "a worktree's .git is a file, not a directory");
});

test("an install from a linked worktree keeps the sibling gates of the shared hook, also from a subdirectory", () => {
  const repo = makeRepo();
  git(repo, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(ROOT, `worktree-${++counter}`);
  git(repo, "worktree", "add", "-q", "-b", "side", wt);
  // What the two sibling installers leave in the hook every worktree shares.
  const shot =
    "# screenshot-tripwire:v1\n" +
    "npx --no -- screenshot-tripwire check || exit $?\n" +
    "# screenshot-tripwire:v1 end\n";
  const copy =
    "# copy-tripwire:v1\n" +
    "npx --no -- copy-tripwire check || exit $?\n" +
    "# copy-tripwire:v1 end\n";
  writeHook(repo, HEADER + copy + "\n" + shot);

  const sub = path.join(wt, "brand", "trailers");
  fs.mkdirSync(sub, { recursive: true });
  const fromSub = install({ cwd: sub, dir: "brand/trailers/" });
  assert.equal(fromSub.ok, true);
  assert.equal(fromSub.action, "migrated");
  assert.equal(fs.realpathSync.native(fromSub.target), fs.realpathSync.native(hookPath(repo)));
  assert.equal(
    readHook(repo),
    HEADER +
      shot +
      "\n" +
      "# trailer-tripwire:v1\n" +
      "npx --no -- trailer-tripwire check --dir 'brand/trailers/' || exit $?\n" +
      "# trailer-tripwire:v1 end\n" +
      "\n" +
      copy,
  );
  assert.deepEqual(fs.readdirSync(sub), [], "nothing may be written under the subdirectory");
  assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "the worktree's .git must stay a file");

  // The main worktree reads the same file and has nothing to change.
  const settled = readHook(repo);
  const fromMain = install({ cwd: repo, dir: "brand/trailers/" });
  assert.equal(fromMain.action, "unchanged");
  assert.equal(fromMain.target, hookPath(repo));
  assert.equal(readHook(repo), settled);
});

test("a relative core.hooksPath in a linked worktree resolves inside that worktree, where git runs it", () => {
  const repo = makeRepo();
  git(repo, "config", "core.hooksPath", ".githooks");
  git(repo, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "init");
  const wt = path.join(ROOT, `worktree-${++counter}`);
  git(repo, "worktree", "add", "-q", "-b", "side", wt);

  const result = install({ cwd: wt, dir: "brand/trailers/" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "created");
  assert.equal(result.target, path.join(wt, ".githooks", "pre-commit"));
  assert.ok(!fs.existsSync(path.join(repo, ".githooks")), "the main worktree must not get the hook of the linked one");
  assert.ok(!fs.existsSync(hookPath(repo)), ".git/hooks must stay untouched");

  // A stand-in npx that records its arguments where it runs, then fails.
  const bin = makeDir("stub-bin");
  fs.writeFileSync(
    path.join(bin, "npx"),
    '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > npx-args.txt\nexit 7\n',
  );
  fs.chmodSync(path.join(bin, "npx"), 0o755);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== "PATH") env[k] = v;
  }
  env.PATH = bin + path.delimiter + process.env.PATH;
  const commit = (cwd) =>
    spawnSync("git", [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "probe"], { cwd, encoding: "utf8", env });

  const blocked = commit(wt);
  assert.notEqual(blocked.status, 0, "a commit in the linked worktree must run the installed gate");
  assert.deepEqual(
    fs.readFileSync(path.join(wt, "npx-args.txt"), "utf8").split("\n").filter(Boolean),
    ["--no", "--", "trailer-tripwire", "check", "--dir", "brand/trailers/"],
  );

  // A relative hooks path is per worktree: the main one has no hook file yet.
  const main = commit(repo);
  assert.equal(main.status, 0, `no gate is installed for the main worktree: ${main.stderr}`);
  assert.ok(!fs.existsSync(path.join(repo, "npx-args.txt")), "no gate may run for the main worktree");
});

test("outside a git repository it reports that and writes nothing", () => {
  const dir = makeDir("plain");
  const result = install({ cwd: dir });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /^trailer-tripwire: not inside a git repository$/m);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("--dir with a newline or NUL is rejected before anything is written", () => {
  const repo = makeRepo();
  assert.throws(() => install({ cwd: repo, dir: "a\nrm -rf /" }), /newlines or null bytes/);
  assert.throws(() => install({ cwd: repo, dir: "a\0b" }), /newlines or null bytes/);
  assert.ok(!fs.existsSync(hookPath(repo)));
});

test("git runs the block: a failing gate blocks the commit without set -e, a passing one lets later lines run", () => {
  const repo = makeRepo();
  // A hand-written hook with no `set -e`. The legacy marker makes the
  // installer treat it as a hand-merged hook and append its block.
  writeHook(repo, "#!/bin/sh\n# trailer-tripwire:v1\necho before >> hook.log\n");
  const result = install({ cwd: repo, dir: "it's here/" });
  assert.equal(result.ok, true);
  fs.appendFileSync(hookPath(repo), "echo after >> hook.log\n");
  assert.doesNotMatch(readHook(repo), /^set -e$/m);

  // A stand-in npx: records its arguments, exits with the code it is told to.
  const bin = makeDir("stub-bin");
  fs.writeFileSync(
    path.join(bin, "npx"),
    '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > npx-args.txt\nexit "${TT_NPX_EXIT:-0}"\n',
  );
  fs.chmodSync(path.join(bin, "npx"), 0o755);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== "PATH") env[k] = v;
  }
  env.PATH = bin + path.delimiter + process.env.PATH;
  const commit = (code) =>
    spawnSync("git", [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "probe"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, TT_NPX_EXIT: String(code) },
    });
  const log = () => fs.readFileSync(path.join(repo, "hook.log"), "utf8").split("\n").filter(Boolean);

  const blocked = commit(7);
  assert.notEqual(blocked.status, 0, "a failing gate must block the commit");
  assert.deepEqual(log(), ["before"], "nothing after the failed gate may run");
  assert.deepEqual(
    fs.readFileSync(path.join(repo, "npx-args.txt"), "utf8").split("\n").filter(Boolean),
    ["--no", "--", "trailer-tripwire", "check", "--dir", "it's here/"],
  );

  const passed = commit(0);
  assert.equal(passed.status, 0, `a passing gate must not block: ${passed.stderr}`);
  assert.deepEqual(log(), ["before", "before", "after"], "lines after the block must still run");
});
