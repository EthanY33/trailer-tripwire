// Integration tests for audit(). Fixtures:
//   demo/bad-trailer.mp4              — known-bad AI-slop sizzle reel (gitignored)
//   demo/google-canvas.profile.json   — human-made reference profile
//
// These are slow (multiple ffmpeg passes per audit) — each test gets a
// generous timeout. The bad-trailer is the README's canonical example;
// these tests pin its documented behavior so regressions surface here
// before they reach the demo SVG or production audits.
//
// bad-trailer.mp4 is not committed, so where it is missing (CI, fresh
// clones) the tests synthesize a stand-in with the bundled ffmpeg: six
// solid-color slides separated by black gaps, a slideshow every cut of
// which lands in a black window.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { audit } from "../src/audit.mjs";
import { ingest } from "../src/ingest.mjs";
import { detectShots, detectFades, extractPalette } from "../src/video-analysis.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "bin", "cli.mjs");
const BAD_TRAILER = path.join(REPO, "demo", "bad-trailer.mp4");
const REF_PROFILE = path.join(REPO, "demo", "google-canvas.profile.json");

const HAS_FIXTURE = await stat(BAD_TRAILER).then(() => true).catch(() => false);

async function synthesizeSlideshow() {
  const FFMPEG = (await import("ffmpeg-static")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "tt-fixture-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, "slideshow.mp4");
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const colors = ["white", "red", "green", "yellow", "cyan", "magenta"];
  for (const c of colors) {
    args.push("-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=25:d=1.6`);
    args.push("-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=0.6");
  }
  const n = colors.length * 2;
  const inputs = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
  args.push("-filter_complex", `${inputs}concat=n=${n}:v=1:a=0[v]`, "-map", "[v]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out);
  const r = spawnSync(FFMPEG, args, { encoding: "utf8" });
  assert.equal(r.status, 0, `ffmpeg failed to synthesize the fixture: ${r.stderr}`);
  return out;
}

const FIXTURE = HAS_FIXTURE ? BAD_TRAILER : await synthesizeSlideshow();
// The small synthesized clip, for the tests that run more than an audit on it.
const SLIDESHOW = HAS_FIXTURE ? await synthesizeSlideshow() : FIXTURE;

// One audit pass can take ~30s with ffmpeg-static on a cold runner.
const TIMEOUT = 120_000;

function severitiesByTag(findings) {
  const map = new Map();
  for (const [level, tag] of findings) map.set(tag, level);
  return map;
}

test(
  "audit(bad-trailer) flags fade-to-black as CRITICAL and exits with hasCritical=true",
  { timeout: TIMEOUT },
  () => {
    const result = audit({ videoPath: FIXTURE, verbose: false });

    assert.equal(typeof result.report, "string");
    assert.ok(result.report.length > 0, "report should be non-empty");
    assert.equal(typeof result.hasCritical, "boolean");

    const sev = severitiesByTag(result.findings);
    assert.equal(
      sev.get("fade-to-black"),
      "CRITICAL",
      `expected fade-to-black=CRITICAL, got findings=${JSON.stringify(result.findings)}`,
    );

    assert.equal(
      result.hasCritical,
      true,
      "bad-trailer.mp4 must trip at least one CRITICAL — this is the README's canonical claim",
    );
    assert.ok(
      result.counts.critical >= 1,
      `expected counts.critical >= 1, got ${JSON.stringify(result.counts)}`,
    );
  },
);

test(
  "audit(bad-trailer, --ref google-canvas) reports reference metadata in the markdown",
  { timeout: TIMEOUT },
  () => {
    const result = audit({
      videoPath: FIXTURE,
      refPath: REF_PROFILE,
      verbose: false,
    });

    assert.match(
      result.report,
      /Reference:\*\*\s+google-canvas/,
      "report should include the reference profile slug",
    );
    assert.equal(result.hasCritical, true);
  },
);

test(
  "audit() writes the markdown report to outPath when given",
  { timeout: TIMEOUT },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    try {
      const outPath = path.join(dir, "report.md");
      const result = audit({ videoPath: FIXTURE, outPath, verbose: false });
      const onDisk = await readFile(outPath, "utf8");
      assert.equal(onDisk, result.report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("audit() throws on missing video", () => {
  assert.throws(
    () => audit({ videoPath: path.join(REPO, "does-not-exist.mp4"), verbose: false }),
    /not found/,
  );
});

test("audit() throws when called with no videoPath", () => {
  assert.throws(() => audit({ verbose: false }), /usage:/);
});

test(
  "audit() rejects a reference profile with the wrong schema",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    try {
      const fakeRef = path.join(dir, "fake.profile.json");
      const fs = await import("node:fs/promises");
      await fs.writeFile(fakeRef, JSON.stringify({ schema: "wrong/v0" }));
      assert.throws(
        () => audit({ videoPath: FIXTURE, refPath: fakeRef, verbose: false }),
        /invalid profile schema/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// A scene threshold is written into ffmpeg's filtergraph. This value closes
// the select expression and appends a metadata filter that makes ffmpeg write
// a file (relative, so into the current directory).
const INJECTED_FILE = "tt-injected-by-threshold.txt";
const INJECTION =
  `0)',metadata=mode=add:key=x:value=INJECTED,metadata=mode=print:file=${INJECTED_FILE},select='gt(scene,0`;

test(
  "audit() rejects a reference profile whose scene threshold is not a number between 0 and 1",
  { timeout: TIMEOUT },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    const injected = path.join(process.cwd(), INJECTED_FILE);
    try {
      const profile = JSON.parse(await readFile(REF_PROFILE, "utf8"));
      const evil = path.join(dir, "evil.profile.json");
      for (const bad of [INJECTION, "0.15", null, 0, 1, -0.15]) {
        profile.shots.sceneThreshold = bad;
        await writeFile(evil, JSON.stringify(profile));
        assert.throws(
          () => audit({ videoPath: FIXTURE, refPath: evil, verbose: false }),
          /invalid profile: shots\.sceneThreshold/,
          `sceneThreshold ${JSON.stringify(bad)} must be refused`,
        );
      }
      await writeFile(evil, JSON.stringify({ schema: "reference-profile/v1" }));
      assert.throws(
        () => audit({ videoPath: FIXTURE, refPath: evil, verbose: false }),
        /invalid profile: shots\.sceneThreshold/,
        "a profile without a shots object must be refused, not crash",
      );
      await assert.rejects(stat(injected), "ffmpeg must never be handed the injected filter");
    } finally {
      await rm(injected, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "detectShots() refuses a threshold that is not a number between 0 and 1",
  { timeout: TIMEOUT },
  async () => {
    const injected = path.join(process.cwd(), INJECTED_FILE);
    try {
      for (const bad of [INJECTION, "0.15", NaN, null, 0, 1]) {
        assert.throws(
          () => detectShots(FIXTURE, bad),
          /scene threshold must be a number between 0 and 1/,
          `threshold ${String(bad)} must be refused`,
        );
      }
      await assert.rejects(stat(injected), "ffmpeg must never be handed the injected filter");
    } finally {
      await rm(injected, { force: true });
    }
  },
);

test("detectFades() and extractPalette() refuse filter options that are not numbers", () => {
  assert.throws(
    () => detectFades(FIXTURE, { minDurSec: "0.2:pic_th=0" }),
    /minDurSec must be a finite number/,
  );
  assert.throws(() => detectFades(FIXTURE, { picTh: NaN }), /picTh must be a finite number/);
  assert.throws(
    () => extractPalette(FIXTURE, { maxColors: "5:stats_mode=diff" }),
    /maxColors must be a finite number/,
  );
});

test("detectShots() and detectFades() throw when ffmpeg fails instead of finding nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
  try {
    const notVideo = path.join(dir, "not-a-video.mp4");
    await writeFile(notVideo, "this is not a video");
    assert.throws(() => detectShots(notVideo), /shot detection: ffmpeg exited with status/);
    assert.throws(() => detectFades(notVideo), /fade detection: ffmpeg exited with status/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `ingest --threshold abc` parses to NaN. ffmpeg accepts gt(scene,NaN) and
// selects nothing, and JSON writes NaN as null, so the profile used to come
// out with no cuts and a null sceneThreshold, exit 0.
test(
  "ingest() refuses a threshold that is not a number between 0 and 1 and writes nothing",
  { timeout: TIMEOUT },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    try {
      const out = path.join(dir, "refs");
      for (const bad of [NaN, 0, 1, -0.15, "0.15", null]) {
        await assert.rejects(
          ingest({ input: FIXTURE, name: "r", outDir: out, threshold: bad }),
          /--threshold must be a number between 0 and 1/,
          `threshold ${String(bad)} must be refused`,
        );
      }
      await assert.rejects(stat(out), "a refused threshold must not leave an output directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the CLI fails `ingest --threshold abc` without writing a profile",
  { timeout: TIMEOUT },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    try {
      const out = path.join(dir, "refs");
      const r = spawnSync(
        process.execPath,
        [CLI, "ingest", FIXTURE, "--name", "r", "--out", out, "--threshold", "abc"],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--threshold must be a number between 0 and 1 \(got NaN\)/);
      await assert.rejects(stat(path.join(out, "r.profile.json")), "no profile may be written");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the CLI ingests with an in-range --threshold and audit() accepts the profile it wrote",
  { timeout: TIMEOUT },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tt-test-"));
    try {
      const out = path.join(dir, "refs");
      const r = spawnSync(
        process.execPath,
        [CLI, "ingest", SLIDESHOW, "--name", "r", "--out", out, "--threshold", "0.3"],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, `ingest failed: ${r.stdout}${r.stderr}`);
      const refPath = path.join(out, "r.profile.json");
      const profile = JSON.parse(await readFile(refPath, "utf8"));
      assert.equal(profile.shots.sceneThreshold, 0.3);
      assert.ok(profile.shots.cuts.length > 0, "the slideshow's cuts must be in the profile");
      const result = audit({ videoPath: SLIDESHOW, refPath, verbose: false });
      assert.match(result.report, /scene threshold 0\.3/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
