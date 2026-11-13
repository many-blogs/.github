import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGER = path.join(HERE, "package.mjs");
const FIXTURES = path.join(HERE, "fixtures");

function runPackager(sourceDir, extraArgs = []) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "package-test-"));
  const result = spawnSync(
    process.execPath,
    [
      PACKAGER,
      "--site-id",
      "fixture",
      "--source-dir",
      sourceDir,
      "--out-dir",
      outDir,
      "--repo",
      "many-blogs/fixture",
      "--ref",
      "main",
      "--sha",
      "0123456789abcdef0123456789abcdef01234567",
      "--run-url",
      "https://example.invalid/run/1",
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
  return { result, outDir };
}

function readManifest(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
}

function walkFiles(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out.sort();
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("packages fixtures: selection, counts, and manifest shape", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);

  assert.equal(manifest.package_version, 1);
  assert.equal(manifest.site_id, "fixture");
  assert.deepEqual(manifest.source, {
    repo: "many-blogs/fixture",
    ref: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
    packaged_at: manifest.source.packaged_at,
    workflow_run_url: "https://example.invalid/run/1",
  });
  assert.ok(!Number.isNaN(Date.parse(manifest.source.packaged_at)));
  assert.deepEqual(manifest.counts, { posts: 3, builders: 2 });
  assert.deepEqual(manifest.excluded, {
    drafts: 1,
    unpublished_posts: 1,
    skipped_non_markdown: 2, // .gitkeep + notes.txt
  });

  // Output tree: manifest + posts (folders preserved) + builders by slug.
  // The unpublished post is absent.
  assert.deepEqual(walkFiles(outDir), [
    "builders/gadget-builders.mdx",
    "builders/widget-makers.mdx",
    "manifest.json",
    "posts/2025-01-01-complete.mdx",
    "posts/guides/2025-01-02-missing-description.mdx",
    "posts/guides/deep/2025-01-03-missing-both.mdx",
  ]);

  // Every manifest sha256 matches the file on disk, recomputed here.
  for (const entry of [...manifest.posts, ...manifest.builders]) {
    const bytes = fs.readFileSync(path.join(outDir, entry.path));
    assert.equal(entry.sha256, sha256Hex(bytes), entry.path);
  }

  // No draft content anywhere in the output.
  for (const file of walkFiles(outDir)) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(outDir, file), "utf8"),
      /DRAFT-SECRET-MARKER/,
      file,
    );
  }
});

test("categories rule: front matter wins, otherwise folder segments", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const bySource = Object.fromEntries(
    readManifest(outDir).posts.map((p) => [p.source_path, p]),
  );
  assert.deepEqual(
    bySource["_posts/2025-01-01-complete.md"].categories,
    ["custom-cat"],
  );
  assert.deepEqual(
    bySource["_posts/guides/2025-01-02-missing-description.md"].categories,
    ["guides"],
  );
  assert.deepEqual(
    bySource["_posts/guides/deep/2025-01-03-missing-both.md"].categories,
    ["guides", "deep"],
  );
  // Date text is preserved verbatim from front matter.
  assert.equal(
    bySource["_posts/2025-01-01-complete.md"].date,
    "2025-01-01 12:00:00 -0700",
  );
});

test("complete post is byte-identical to its source", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);
  const entry = manifest.posts.find((p) => p.source_path === "_posts/2025-01-01-complete.md");
  assert.equal(entry.normalized, false);
  assert.equal(entry.description_derived, false);
  assert.equal(entry.tags_derived, false);
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, entry.path)),
    fs.readFileSync(path.join(FIXTURES, "source", "_posts/2025-01-01-complete.md")),
  );
});

test("missing description is derived from the first sentence, nothing else changes", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);
  const entry = manifest.posts.find(
    (p) => p.source_path === "_posts/guides/2025-01-02-missing-description.md",
  );
  assert.equal(entry.description_derived, true);
  assert.equal(entry.tags_derived, false);
  assert.equal(entry.normalized, true);
  const packaged = fs.readFileSync(path.join(outDir, entry.path), "utf8");
  const source = fs.readFileSync(
    path.join(FIXTURES, "source", "_posts/guides/2025-01-02-missing-description.md"),
    "utf8",
  );
  const inserted = 'description: "This opening sentence becomes the description."\n';
  assert.ok(packaged.includes(inserted), packaged);
  assert.equal(packaged.replace(inserted, ""), source);
  assert.ok(packaged.indexOf(inserted) < packaged.lastIndexOf("---"));
});

test("missing description and tags derive from body and folder path", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);
  const entry = manifest.posts.find(
    (p) => p.source_path === "_posts/guides/deep/2025-01-03-missing-both.md",
  );
  assert.equal(entry.description_derived, true);
  assert.equal(entry.tags_derived, true);
  assert.equal(entry.normalized, true);
  assert.deepEqual(entry.tags, ["guides", "deep"]);
  const packaged = fs.readFileSync(path.join(outDir, entry.path), "utf8");
  const source = fs.readFileSync(
    path.join(FIXTURES, "source", "_posts/guides/deep/2025-01-03-missing-both.md"),
    "utf8",
  );
  const paragraph =
    "This paragraph has no sentence terminator at all and it keeps going well past one hundred and sixty characters so the derivation rule falls back to a plain character truncation of the paragraph text";
  assert.ok(paragraph.length > 160);
  const inserted =
    `description: ${JSON.stringify(paragraph.slice(0, 160))}\n` +
    'tags: ["guides", "deep"]\n';
  assert.ok(packaged.includes(inserted), packaged);
  assert.equal(packaged.replace(inserted, ""), source);
});

test("builders: verbatim bytes, slug filenames, ratings, pros/cons note", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);
  assert.deepEqual(
    manifest.builders.map((b) => [b.builder, b.rating, b.path, b.pros_cons_defaulted]),
    [
      ["gadget-builders", 5, "builders/gadget-builders.mdx", false],
      ["widget-makers", 3, "builders/widget-makers.mdx", true],
    ],
  );
  // .markdown source becomes .mdx; bytes identical.
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, "builders/gadget-builders.mdx")),
    fs.readFileSync(path.join(FIXTURES, "source/builders/gadget-builders.markdown")),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, "builders/widget-makers.mdx")),
    fs.readFileSync(path.join(FIXTURES, "source/builders/widget-makers.md")),
  );
});

test("builder rating outside 1..5 fails the run", () => {
  const { result } = runPackager(path.join(FIXTURES, "bad-rating"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rating/);
});

test("builder file without a slug fails the run", () => {
  const { result } = runPackager(path.join(FIXTURES, "missing-slug"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /builder/);
});

test("empty builders dir skips builders", () => {
  const { result, outDir } = runPackager(path.join(FIXTURES, "source"), [
    "--builders-dir",
    "",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(outDir);
  assert.deepEqual(manifest.builders, []);
  assert.equal(manifest.counts.builders, 0);
  assert.equal(fs.existsSync(path.join(outDir, "builders")), false);
});
