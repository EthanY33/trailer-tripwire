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

function readHook(repo) {
  return fs.readFileSync(hookPath(repo), "utf8");
}

test("the generated command cannot fall back to the npm registry", () => {
  const repo = makeRepo();
  install({ cwd: repo });
  const body = readHook(repo);

  // --no makes npx fail when the package is not installed, instead of
  // downloading whatever the registry serves under the name.
  assert.match(body, /^npx --no -- trailer-tripwire check$/m);
  assert.doesNotMatch(body, /npx\s+trailer-tripwire/, "no bare npx call may remain");
});

test("git runs the hook: the arguments reach npx intact and a failing gate blocks the commit", () => {
  const repo = makeRepo();
  const result = install({ cwd: repo, dir: "it's here/" });
  assert.equal(result.ok, true);

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

  const blocked = commit(7);
  assert.notEqual(blocked.status, 0, "a failing gate must block the commit");
  assert.deepEqual(
    fs.readFileSync(path.join(repo, "npx-args.txt"), "utf8").split("\n").filter(Boolean),
    ["--no", "--", "trailer-tripwire", "check", "--dir", "it's here/"],
  );

  const passed = commit(0);
  assert.equal(passed.status, 0, `a passing gate must not block: ${passed.stderr}`);
});
