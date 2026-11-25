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

import { audit, checklist } from "../src/audit.mjs";
import { ingest } from "../src/ingest.mjs";
import { detectShots, detectFades, extractPalette, analyzeAudio } from "../src/video-analysis.mjs";

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

// The other fixtures are synthesized by the test that needs them. `args` are
// the ffmpeg inputs and codec options; the output path is appended.
const FIXTURE_DIR = await mkdtemp(path.join(tmpdir(), "tt-fixture-"));
after(() => rm(FIXTURE_DIR, { recursive: true, force: true }));

async function synthesize(name, args) {
  const FFMPEG = (await import("ffmpeg-static")).default;
  const out = path.join(FIXTURE_DIR, name);
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], { encoding: "utf8" });
  assert.equal(r.status, 0, `ffmpeg failed to synthesize ${name}: ${r.stderr}`);
  return out;
}

const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];

// What checklist() takes, read back from a reference profile.
function recordedNumbers(profile) {
  return {
    meta: profile.meta,
    stats: profile.shots.stats,
    fadeRatio: profile.shots.fadeVsCut,
    fades: profile.shots.fades,
    audioData: profile.audio,
    palette: profile.palette,
  };
}

function criticals(findings) {
  return findings.filter(([level]) => level === "CRITICAL");
}

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

// The shipped reference is a human-made launch film, and its recorded fade
// share is exactly 0.4: four of ten cuts in black windows. A gate that blocks
// it blocks the look the thresholds were calibrated on.
test("the shipped Google Canvas reference raises no CRITICAL on its own recorded numbers", async () => {
  const profile = JSON.parse(await readFile(REF_PROFILE, "utf8"));
  assert.equal(profile.shots.fadeVsCut.fadeFraction, 0.4, "the reference sits on the 40% line");
  const { findings } = checklist(recordedNumbers(profile));
  assert.deepEqual(criticals(findings), []);
  assert.equal(severitiesByTag(findings).get("fade-to-black"), "WARN");
});

test("a fade share above 40% of cuts is still CRITICAL", async () => {
  const numbers = recordedNumbers(JSON.parse(await readFile(REF_PROFILE, "utf8")));
  // Five of twelve cuts in black windows instead of four of ten.
  numbers.fadeRatio = { fadeCuts: 5, hardCuts: 7, fadeFraction: 0.417 };
  numbers.stats = { ...numbers.stats, count: 13 };
  assert.equal(severitiesByTag(checklist(numbers).findings).get("fade-to-black"), "CRITICAL");
});

test(
  "a film with exactly 40% of its cuts in black windows gets a WARN, not a CRITICAL",
  { timeout: TIMEOUT },
  async () => {
    // The shape of the reference: nine slides, six hard cuts and two fades to
    // black, each of which is a cut into the black window and a cut out of it.
    // Neighbouring slides differ in brightness, which is what ffmpeg's scene
    // score reads (so lime, not green: green is as dark as red).
    const segments = [
      "white", "red", "yellow", "black", "lime", "red", "cyan", "black", "magenta", "white", "red",
    ];
    const args = [];
    for (const c of segments) {
      args.push("-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=25:d=${c === "black" ? 0.6 : 1}`);
    }
    const inputs = segments.map((_, i) => `[${i}:v]`).join("");
    args.push("-filter_complex", `${inputs}concat=n=${segments.length}:v=1:a=0[v]`, "-map", "[v]", ...X264);
    const film = await synthesize("four-fades-in-ten-cuts.mp4", args);

    const result = audit({ videoPath: film, verbose: false });
    assert.match(
      result.report,
      /Fade-based transitions:\*\* 4\/11 \(40\.0%\)/,
      `the fixture must sit on the 40% line:\n${result.report}`,
    );
    assert.equal(severitiesByTag(result.findings).get("fade-to-black"), "WARN");
    assert.equal(result.hasCritical, false);
  },
);

// A flat drone is the tell the audio-flat CRITICAL exists for. One bucket of
// near-silence (the few samples left after the last full bucket, an encoder's
// tail, a closing fade) used to lift the spread past 6 dB: "expressive".
test(
  "a constant drone is CRITICAL audio-flat whatever its last samples are",
  { timeout: TIMEOUT },
  async () => {
    const drone = await synthesize("drone.mp4", [
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=20",
      "-f", "lavfi", "-i", "sine=frequency=110:duration=20",
      ...X264, "-c:a", "aac", "-shortest",
    ]);

    const audioData = analyzeAudio(drone, { buckets: 30 });
    assert.equal(audioData.rmsPerBucket.length, 30, "leftover samples are not a bucket of their own");
    assert.equal(audioData.silentRatio, 0);

    // A reference as older versions ingested it, leftover bucket included.
    const profile = JSON.parse(await readFile(REF_PROFILE, "utf8"));
    profile.audio.rmsPerBucket.push(-78.1);
    const refPath = path.join(FIXTURE_DIR, "ref-with-leftover-bucket.profile.json");
    await writeFile(refPath, JSON.stringify(profile));

    const result = audit({ videoPath: drone, refPath, verbose: false });
    assert.equal(
      severitiesByTag(result.findings).get("audio-flat"),
      "CRITICAL",
      `expected audio-flat=CRITICAL:\n${result.report}`,
    );
    assert.equal(result.hasCritical, true);
    assert.match(
      result.report,
      /less than half the reference's 3\.1 dB/,
      "the reference's spread must not count its leftover bucket either",
    );
  },
);

test("buckets under the -50 dBFS silence line do not count as audio dynamics", async () => {
  const numbers = recordedNumbers(JSON.parse(await readFile(REF_PROFILE, "utf8")));
  const flat = Array.from({ length: 27 }, () => -21);
  for (const tail of [[-65], [-55, -70, -90], [-120, -120]]) {
    const rmsPerBucket = [...flat, ...tail];
    const silentRatio = tail.length / rmsPerBucket.length;
    const { findings } = checklist({ ...numbers, audioData: { ...numbers.audioData, rmsPerBucket, silentRatio } });
    assert.equal(
      severitiesByTag(findings).get("audio-flat"),
      "CRITICAL",
      `a drone that ends in ${JSON.stringify(tail)} is still a drone`,
    );
  }
});

test("with fewer than three audible buckets the spread is measured as before", async () => {
  const numbers = recordedNumbers(JSON.parse(await readFile(REF_PROFILE, "utf8")));
  const judge = (rmsPerBucket) => severitiesByTag(checklist({
    ...numbers,
    audioData: { ...numbers.audioData, rmsPerBucket, silentRatio: 1 },
  }).findings).get("audio-flat");

  // Digital silence throughout: nothing to measure, flat.
  assert.equal(judge(Array.from({ length: 30 }, () => -120)), "CRITICAL");
  // A hiss at -70 dBFS with two audible stings: over every bucket, as before.
  assert.equal(judge([...Array.from({ length: 28 }, () => -70), -20, -30]), undefined);
});

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
