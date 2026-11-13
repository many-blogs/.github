#!/usr/bin/env node
/**
 * package.mjs — package a Jekyll repo's posts (plus optional builder
 * review files) into a versioned, reviewable content tree.
 *
 * Input: a Jekyll source repo. Output: a directory holding manifest.json
 * plus the packaged posts/builders as .mdx files. The reusable workflow
 * in ../.github/workflows/package-jekyll-posts.yml commits that tree to
 * an orphan branch; the engine consumes it via a reviewable sync PR.
 *
 * Rules (see PACKAGING.md for the full contract):
 * - Posts: every *.md/*.markdown under --posts-dir, recursively, that
 *   has front matter and is not `published: false`. _drafts/ is NEVER
 *   read — only counted, for the manifest's excluded.drafts figure.
 * - Front matter is parsed with `yaml` for validation, but emitted
 *   files preserve the original front-matter text verbatim whenever no
 *   normalization is needed. When normalization IS needed, lines are
 *   surgically appended before the closing `---`; the block is never
 *   re-serialized and body bytes pass through untouched.
 * - Builders: every *.md/*.markdown under --builders-dir (empty string
 *   skips builders). Each must carry a `builder` slug and an integer
 *   `rating` 1..5, else the run fails.
 *
 * Usage:
 *   node package.mjs --site-id <id> --source-dir <repo root> \
 *     --out-dir <dir> [--posts-dir _posts] [--builders-dir builders] \
 *     [--repo owner/repo] [--ref branch] [--sha <full sha>] \
 *     [--run-url <workflow run URL>]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const MARKDOWN_RE = /\.(md|markdown)$/i;
const BUILDER_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message) {
  throw new Error(message);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Recursively list regular files under `dir`, as posix paths relative to `dir`, sorted. */
function walkFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Resolve symlinks: include them when they point at a file.
        if (fs.statSync(childAbs).isFile()) out.push(childRel);
      }
    }
  };
  walk(dir, "");
  out.sort();
  return out;
}

/**
 * Split a document into front matter and body.
 * Returns null when the file has no front matter (does not start with
 * `---`). Throws when front matter opens but never closes.
 */
function splitFrontMatter(text, sourcePath) {
  const open = /^\uFEFF?---[ \t]*(\r\n|\n)/.exec(text);
  if (!open) return null;
  const afterOpen = open[0].length;
  const lineEnding = open[1];
  const closeRe = /\r\n---[ \t]*(\r\n|\n|$)|\n---[ \t]*(\r\n|\n|$)/g;
  closeRe.lastIndex = afterOpen;
  const match = closeRe.exec(text);
  if (!match) fail(`${sourcePath}: front matter opened but never closed`);
  const closingLineStart = match.index + (text[match.index] === "\r" ? 2 : 1);
  return {
    fmText: text.slice(afterOpen, closingLineStart),
    body: text.slice(match.index + match[0].length),
    insertAt: closingLineStart,
    lineEnding,
  };
}

function parseFrontMatter(fmText, sourcePath) {
  let data;
  try {
    // Core schema: dates stay strings (as written), so the manifest
    // records the author's date text verbatim instead of a re-encoded
    // timestamp. Booleans and numbers still resolve normally.
    data = parseYaml(fmText, { schema: "core" });
  } catch (error) {
    fail(`${sourcePath}: invalid front matter YAML: ${error.message}`);
  }
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    fail(`${sourcePath}: front matter must be a YAML mapping`);
  }
  return data;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function toStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function scalarToString(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Derive a description from the first body paragraph: its first
 * sentence (verbatim), or its first 160 characters when it has no
 * sentence terminator. Returns "" when the body has no paragraph.
 */
function deriveDescription(body) {
  const lines = body.split(/\r\n|\n|\r/);
  const paragraph = [];
  for (const line of lines) {
    if (paragraph.length === 0 && line.trim() === "") continue;
    if (line.trim() === "") break;
    paragraph.push(line.trim());
  }
  const text = paragraph.join(" ").trim();
  if (!text) return "";
  const end = /[.!?](\s|$)/.exec(text);
  if (end) return text.slice(0, end.index + 1);
  return text.slice(0, 160);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs(argv) {
  const opts = {
    siteId: null,
    sourceDir: null,
    outDir: null,
    postsDir: "_posts",
    buildersDir: "builders",
    repo: process.env.GITHUB_REPOSITORY ?? "",
    ref: process.env.GITHUB_REF_NAME ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    runUrl: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) fail(`unknown argument: ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined) fail(`--${key} needs a value`);
      i += 1;
    }
    switch (key) {
      case "site-id":
        opts.siteId = value;
        break;
      case "source-dir":
        opts.sourceDir = value;
        break;
      case "out-dir":
        opts.outDir = value;
        break;
      case "posts-dir":
        opts.postsDir = value;
        break;
      case "builders-dir":
        opts.buildersDir = value;
        break;
      case "repo":
        opts.repo = value;
        break;
      case "ref":
        opts.ref = value;
        break;
      case "sha":
        opts.sha = value;
        break;
      case "run-url":
        opts.runUrl = value;
        break;
      default:
        fail(`unknown argument: --${key}`);
    }
  }
  if (!opts.siteId) fail("--site-id is required");
  if (!opts.sourceDir) fail("--source-dir is required");
  if (!opts.outDir) fail("--out-dir is required");
  return opts;
}

function packagePosts(opts, outDir) {
  const postsRoot = path.join(opts.sourceDir, opts.postsDir);
  if (!fs.existsSync(postsRoot) || !fs.statSync(postsRoot).isDirectory()) {
    fail(`posts directory not found: ${opts.postsDir} (under ${opts.sourceDir})`);
  }
  const posts = [];
  const seenOutputs = new Set();
  let unpublished = 0;
  let skippedNonMarkdown = 0;

  for (const rel of walkFiles(postsRoot)) {
    const sourcePath = toPosix(path.join(opts.postsDir, rel));
    if (!MARKDOWN_RE.test(rel)) {
      skippedNonMarkdown += 1;
      continue;
    }
    const absPath = path.join(postsRoot, rel);
    const sourceBytes = fs.readFileSync(absPath);
    const text = sourceBytes.toString("utf8");
    const split = splitFrontMatter(text, sourcePath);
    if (!split) {
      fail(
        `${sourcePath}: markdown file under ${opts.postsDir} has no front matter; ` +
          `add front matter or move it out of the posts directory`,
      );
    }
    const fm = parseFrontMatter(split.fmText, sourcePath);
    if (fm.published === false) {
      unpublished += 1;
      continue;
    }

    // Categories: front-matter `categories` wins when present and
    // non-empty; otherwise the folder path segments relative to the
    // posts directory. This matches the engine's existing rule.
    const dirRel = toPosix(path.dirname(rel));
    const folderSegments = dirRel === "." ? [] : dirRel.split("/");
    const categories = !isEmptyValue(fm.categories)
      ? toStringArray(fm.categories)
      : folderSegments;

    // Tags: default to the folder-path segments when missing/empty.
    const tagsMissing = isEmptyValue(fm.tags);
    const tags = tagsMissing ? folderSegments : toStringArray(fm.tags);
    const tagsDerived = tagsMissing;

    // Description: derive from the first body paragraph when
    // missing/empty.
    const descriptionMissing = isEmptyValue(fm.description);
    const descriptionDerived = descriptionMissing;
    const derivedDescription = descriptionMissing ? deriveDescription(split.body) : null;

    // Surgical normalization: append lines before the closing `---`.
    // No re-serialization, body bytes untouched.
    const appended = [];
    if (descriptionDerived) {
      appended.push(`description: ${JSON.stringify(derivedDescription)}`);
    }
    if (tagsDerived && folderSegments.length > 0) {
      appended.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
    }
    const normalized = appended.length > 0;
    let packagedBytes;
    if (!normalized) {
      packagedBytes = sourceBytes;
    } else {
      const insertion = appended.map((line) => line + split.lineEnding).join("");
      packagedBytes = Buffer.from(
        text.slice(0, split.insertAt) + insertion + text.slice(split.insertAt),
        "utf8",
      );
    }

    const outRel = rel.replace(MARKDOWN_RE, ".mdx");
    const outPath = `posts/${outRel}`;
    if (seenOutputs.has(outPath)) {
      fail(`${sourcePath}: duplicate packaged path ${outPath}`);
    }
    seenOutputs.add(outPath);
    const outAbs = path.join(outDir, "posts", outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, packagedBytes);

    posts.push({
      path: outPath,
      source_path: sourcePath,
      sha256: sha256Hex(packagedBytes),
      title: scalarToString(fm.title),
      date: scalarToString(fm.date),
      categories,
      tags,
      description_derived: descriptionDerived,
      tags_derived: tagsDerived,
      normalized,
    });
  }

  posts.sort((a, b) => (a.source_path < b.source_path ? -1 : 1));
  return { posts, unpublished, skippedNonMarkdown };
}

function packageBuilders(opts, outDir) {
  if (opts.buildersDir === "") return [];
  const buildersRoot = path.join(opts.sourceDir, opts.buildersDir);
  if (!fs.existsSync(buildersRoot) || !fs.statSync(buildersRoot).isDirectory()) {
    fail(
      `builders directory not found: ${opts.buildersDir} (under ${opts.sourceDir}); ` +
        `pass --builders-dir "" for a site with no builder files`,
    );
  }
  const builders = [];
  const seenSlugs = new Set();

  for (const rel of walkFiles(buildersRoot)) {
    if (!MARKDOWN_RE.test(rel)) continue;
    const sourcePath = toPosix(path.join(opts.buildersDir, rel));
    const absPath = path.join(buildersRoot, rel);
    const sourceBytes = fs.readFileSync(absPath);
    const text = sourceBytes.toString("utf8");
    const split = splitFrontMatter(text, sourcePath);
    if (!split) fail(`${sourcePath}: builder file has no front matter`);
    const fm = parseFrontMatter(split.fmText, sourcePath);

    const slug = fm.builder;
    if (typeof slug !== "string" || slug.trim() === "" || !BUILDER_SLUG_RE.test(slug)) {
      fail(`${sourcePath}: builder file must carry a valid \`builder\` slug`);
    }
    if (seenSlugs.has(slug)) {
      fail(`${sourcePath}: duplicate builder slug "${slug}"`);
    }
    seenSlugs.add(slug);
    const rating = fm.rating;
    if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      fail(`${sourcePath}: builder "${slug}" must carry an integer \`rating\` from 1 to 5`);
    }
    // Builder files need no normalization: emit verbatim, extension only.
    const outPath = `builders/${slug}.mdx`;
    const outAbs = path.join(outDir, "builders", `${slug}.mdx`);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, sourceBytes);

    builders.push({
      path: outPath,
      source_path: sourcePath,
      sha256: sha256Hex(sourceBytes),
      builder: slug,
      title: scalarToString(fm.title),
      rating,
      // Manifest note: pros/cons default to [] in consumers when absent
      // from the source file; the file itself is emitted verbatim.
      pros_cons_defaulted: fm.pros == null || fm.cons == null,
    });
  }

  builders.sort((a, b) => (a.builder < b.builder ? -1 : 1));
  return builders;
}

function countDrafts(sourceDir) {
  const draftsRoot = path.join(sourceDir, "_drafts");
  if (!fs.existsSync(draftsRoot) || !fs.statSync(draftsRoot).isDirectory()) return 0;
  // Count only — draft contents are never read.
  return walkFiles(draftsRoot).length;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.outDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { posts, unpublished, skippedNonMarkdown } = packagePosts(opts, outDir);
  const builders = packageBuilders(opts, outDir);
  const drafts = countDrafts(opts.sourceDir);

  const manifest = {
    package_version: 1,
    site_id: opts.siteId,
    source: {
      repo: opts.repo,
      ref: opts.ref,
      sha: opts.sha,
      packaged_at: new Date().toISOString(),
      workflow_run_url: opts.runUrl,
    },
    posts,
    builders,
    excluded: {
      drafts,
      unpublished_posts: unpublished,
      skipped_non_markdown: skippedNonMarkdown,
    },
    counts: {
      posts: posts.length,
      builders: builders.length,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Packaged site "${opts.siteId}": ${posts.length} posts, ${builders.length} builders ` +
      `(${posts.filter((p) => p.normalized).length} normalized). ` +
      `Excluded: ${drafts} drafts, ${unpublished} unpublished, ` +
      `${skippedNonMarkdown} non-markdown.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`package.mjs: ${error.message}`);
  process.exit(1);
}
