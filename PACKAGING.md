# Jekyll content packaging

Jekyll repos in this org keep their posts as the source of truth. A
shared reusable workflow packages those posts into a versioned,
reviewable content tree that the engine consumes. This document is the
contract for that package: its format, the handoff, the normalization
rules, and what callers must do.

## The shape of it

```
Jekyll repo (source of truth)          Engine repo (consumer)
_posts/, builders/                     content/packaged/<site_id>/
        │                                        ▲
        │  package-jekyll-posts.yml              │  sync PR
        ▼                                        │  (reviewable diff,
content-package branch ──────────────────────────┘  pinned tree)
  manifest.json + posts/ + builders/
```

Each Jekyll repo runs the reusable workflow on pushes to its main
branch. The workflow builds a package tree and force-pushes it as an
orphan commit to that repo's `content-package` branch. The engine
consumes a package by copying a pinned `content-package` tree into
`content/packaged/<site_id>/` via a reviewable sync PR. Updates arrive
as new sync PRs; nothing about a Jekyll repo is fetched at engine
build time.

## The reusable workflow

Ref callers use:

```
many-blogs/.github/.github/workflows/package-jekyll-posts.yml@main
```

Inputs:

| Input | Required | Default | Meaning |
|---|---|---|---|
| `site_id` | yes | — | Site identifier recorded in the manifest (e.g. `lanark`). |
| `posts_dir` | no | `_posts` | Posts directory, relative to the caller repo root. |
| `builders_dir` | no | `builders` | Builder files directory. Empty string skips builders. |
| `package_branch` | no | `content-package` | Branch the package tree is pushed to. |
| `packager_ref` | no | `main` | Ref of `many-blogs/.github` to fetch the packager from. Override only to test unmerged packager changes. |

The workflow runs in the caller repo, using the caller's
`GITHUB_TOKEN`, and:

1. Checks out the caller repo.
2. Checks out `many-blogs/.github` to `.packager` to get the packager script.
3. Sets up Node.js 24 and runs `npm ci` in the packager directory (the
   lockfile is committed; the packager's only dependency is `yaml`).
4. Runs the packager, passing the source SHA, ref, and workflow run URL.
5. Commits the package tree as an orphan commit on the package branch
   and force-pushes it — unless the new tree is identical to the branch
   head's tree, in which case the push is skipped to avoid churn.
   Commit messages include the source SHA and post/builder counts.
   Runs for one site are serialized with a concurrency group.

The packager itself is `packager/package.mjs` (Node 24, zero
dependencies besides `yaml` 2.9.1 exact). Its tests live in
`packager/package.test.mjs` and run on every PR via
`.github/workflows/test-packager.yml`.

## Caller requirements

A Jekyll repo opts in with one small workflow file, e.g.
`.github/workflows/package.yml`:

```yaml
name: Package posts

on:
  push:
    branches: [main]
    paths:
      - "_posts/**"
      - "builders/**"

jobs:
  package:
    uses: many-blogs/.github/.github/workflows/package-jekyll-posts.yml@main
    with:
      site_id: lanark
    permissions:
      contents: write
```

Notes:

- The caller **must** grant `permissions: contents: write`. Without
  it, the package-branch push fails. The reusable workflow also
  declares `contents: write`; the effective permission is the caller's.
- `site_id` must match the site's id in the engine's site registry.
- A repo with no builder files passes `builders_dir: ""`. Leaving the
  default when no `builders/` directory exists fails the run — loudly,
  so a misconfigured caller is noticed instead of silently packaging
  zero builders.
- Trigger on pushes to the default branch only. The package branch is
  written by the workflow itself and must never be edited by hand; the
  commit message says so.
- The workflow needs no secrets and no paid dependencies: the stock
  `GITHUB_TOKEN`, the public npm registry, and the org's own repos.

## Package format (v1)

The package branch root holds:

```
manifest.json
posts/<path relative to posts_dir, .md/.markdown -> .mdx, folders preserved>
builders/<builder slug>.mdx
```

### manifest.json

```json
{
  "package_version": 1,
  "site_id": "lanark",
  "source": {
    "repo": "many-blogs/lanark.house",
    "ref": "main",
    "sha": "<full source SHA the package was built from>",
    "packaged_at": "<ISO 8601 timestamp>",
    "workflow_run_url": "<URL of the packaging run>"
  },
  "posts": [
    {
      "path": "posts/house/douglas-homes/2024-11-10-a-tale-of-red-flags-and-transparency.mdx",
      "source_path": "_posts/house/douglas-homes/2024-11-10-a-tale-of-red-flags-and-transparency.md",
      "sha256": "<sha256 of the packaged file>",
      "title": "Douglas Homes Calgary Review: A Tale of Red Flags and Transparency",
      "date": "2024-11-10 12:00:00 -0700",
      "categories": ["house", "douglas-homes"],
      "tags": ["douglas-homes-calgary", "..."],
      "description_derived": false,
      "tags_derived": false,
      "normalized": false
    }
  ],
  "builders": [
    {
      "path": "builders/douglas-homes.mdx",
      "source_path": "builders/douglas-homes.md",
      "sha256": "<sha256 of the packaged file>",
      "builder": "douglas-homes",
      "title": "Douglas Homes Review",
      "rating": 1,
      "pros_cons_defaulted": false
    }
  ],
  "excluded": {
    "drafts": 48,
    "unpublished_posts": 0,
    "skipped_non_markdown": 1
  },
  "counts": { "posts": 13, "builders": 3 }
}
```

Field notes:

- `date` is the front-matter date text verbatim, as the author wrote
  it — never re-encoded.
- `sha256` covers the packaged file bytes, so a sync PR can verify a
  copied tree against the manifest without trusting anything else.
- `source.sha` pins the package to one source commit, so content drift
  between the Jekyll repo and the engine is visible: compare the
  manifest SHA with the Jekyll repo's head.
- `pros_cons_defaulted` is true when the builder source file omits
  `pros` or `cons`; consumers treat the missing list as `[]`. The
  builder file itself is still emitted verbatim.
- `package_version` starts at 1. Any incompatible change to this
  schema or to the output tree layout bumps it, and the engine's sync
  tooling must understand the version it consumes.

## Selection rules

Posts:

- Every `*.md` / `*.markdown` file under `posts_dir`, recursively,
  that has front matter and is not `published: false`.
- Non-markdown files under `posts_dir` (e.g. `.gitkeep`) are skipped
  and counted in `excluded.skipped_non_markdown`.
- `published: false` posts are excluded and counted in
  `excluded.unpublished_posts`.
- `_drafts/` is **never read**. Only its file count is recorded, in
  `excluded.drafts`, so the manifest proves drafts were considered and
  left out. No draft content can leak into a package: the packager
  lists the directory but never opens a file in it.
- A markdown file under `posts_dir` with no front matter fails the
  run. Silently dropping content is worse than a loud failure; add
  front matter or move the file out.

Builders (when `builders_dir` is non-empty):

- Every `*.md` / `*.markdown` file under `builders_dir`, recursively.
- Each file **must** carry a `builder` slug and an integer `rating`
  from 1 to 5, else the run fails. Ratings live only in builder files;
  posts never carry a rating.
- Duplicate slugs fail the run (they would collide on one output
  filename). Output filenames are `builders/<slug>.mdx` regardless of
  the source file's name or subfolder.
- `pros` / `cons` default to `[]` when absent, noted in the manifest
  (see above). Builder files need no other normalization and are
  emitted verbatim apart from the extension change.

## Normalization rules

The guiding rule: a packaged file differs from its source as little as
possible, and every difference is recorded in the manifest.

- **Verbatim by default.** Front matter is parsed with the `yaml`
  package for validation only. When no normalization is needed, the
  packaged file is byte-identical to the source — only the extension
  changes (`.md` → `.mdx`). The full front matter is preserved,
  including fields the engine does not use yet.
- **Surgical appends.** When normalization is needed, lines are
  appended immediately before the closing `---`. The front-matter
  block is never re-serialized, so field order, quoting, comments,
  and formatting survive untouched. Body bytes always pass through
  untouched.
- **Missing `description`.** If `description` is missing or empty, it
  is derived from the first sentence of the first body paragraph
  (verbatim text; if the paragraph has no sentence terminator, its
  first 160 characters) and appended as a JSON-style double-quoted
  YAML string. Recorded as `description_derived`. A derived
  description is a stopgap: the fix is a real description in the
  Jekyll source, which then flows through verbatim.
- **Missing `tags`.** If `tags` is missing or empty, it defaults to
  the folder-path segments and is appended as a flow-style tags line.
  Recorded as `tags_derived`.
- **`normalized`** is true when the packaged file differs from the
  source at all (i.e. when any line was appended).
- **Categories.** The manifest `categories` for a post are the folder
  path segments relative to `posts_dir` — unless the post's front
  matter carries `categories`, which wins (normalized to a string
  array). This matches the engine's existing rule, so packaged posts
  and hand-placed posts categorize identically. The `categories` field
  is manifest data only; the packager never rewrites it into a file.

## The handoff to the engine

The engine consumes a package by copying a pinned `content-package`
branch tree into `content/packaged/<site_id>/` via a reviewable sync
PR. Concretely, a sync:

1. Reads the `content-package` branch at a chosen commit (the branch
   head, or an older commit to hold a version back).
2. Copies `manifest.json`, `posts/`, and `builders/` into
   `content/packaged/<site_id>/`, replacing the previous copy.
3. Opens a PR whose diff is the content change itself — new posts,
   edited paragraphs, changed ratings — in plain text, reviewable line
   by line before anything ships.
4. The manifest travels with the content, so the engine (and any
   reviewer) can see exactly which source commit a site's content came
   from, verify file hashes, and tell derived descriptions from
   authored ones.

Because the package tree is plain files in git, the engine's existing
`prepare` / `validate` / e2e scripts work on synced content unchanged:
packaged posts are `.mdx` files with Jekyll front matter preserved,
plus a manifest the tooling can read or ignore.

## Why this shape

The criteria the design was held to, and how it meets them:

- **Reviewable diffs.** Both hops are git diffs of plain text: the
  package branch holds real files, and the engine sync is a PR whose
  diff is the content change. Nothing is a pointer, a blob, or a
  build-time fetch.
- **Pinned / versioned.** A package is one orphan commit on one
  branch, pinned to one source SHA recorded in the manifest. The
  engine can hold, advance, or roll back a site's content by syncing a
  different commit, and each sync PR is itself the durable record of
  what shipped.
- **Drafts excluded.** Drafts are never read, only counted. The
  manifest's `excluded.drafts` figure is the receipt.
- **Full front matter preserved.** Verbatim emission by default;
  surgical appends only. No field is dropped or re-serialized.
- **Works with the engine's scripts.** Packaged content is `.mdx`
  files with preserved front matter in a stable layout — the same
  shape the engine already validates and tests.
- **No paid dependencies.** Stock `GITHUB_TOKEN`, the public npm
  registry, one tiny dependency (`yaml`). Nothing to buy, no service
  to keep alive.
- **No babysitting.** The workflow triggers on pushes, skips pushes
  when the tree is unchanged, serializes runs per site, and fails
  loudly on invalid content instead of publishing something wrong.

## Rejected alternatives

- **Actions artifacts.** They expire, are unversioned, and produce no
  reviewable diff. A package nobody can diff or pin is not a handoff.
- **npm / GitHub Packages.** Content becomes an opaque tarball: no
  diffs, and versioning machinery built for code, not prose.
- **Git submodules.** The engine diff would be a pointer change only;
  reviewers would see a SHA move, not what changed in the content.
- **Build-time fetch.** The engine would fetch Jekyll content while
  building: no reviewable diff, no pinning, and a network dependency
  inside a static export.

## Failure modes

The packager fails the run (non-zero exit, message naming the file)
instead of publishing a wrong package when:

- the posts or builders directory does not exist;
- a markdown file under the posts directory has no front matter, or
  its front matter is not a valid YAML mapping;
- a builder file lacks a `builder` slug or an integer `rating` 1..5;
- two builder files share a slug, or two posts map to one output path.

Fix the source file and push again; the next run re-packages from
scratch. The package branch is rebuilt from the source on every run,
so a failed run leaves the previous good package in place.

## Local development

```sh
cd packager
npm ci            # installs yaml from the committed lockfile
npm test          # node:test suite against fixtures/ (no new dependencies)
node package.mjs --site-id lanark --source-dir /path/to/lanark.house \
  --out-dir /tmp/package --repo many-blogs/lanark.house \
  --ref main --sha <full sha>
```

Fixtures in `packager/fixtures/` cover: a complete post (byte-identical
output), a post missing a description, a post missing description and
tags, an unpublished post, skipped non-markdown files, a draft (content
must never appear in output), builders with and without `pros`/`cons`,
and the two builder validation failures.
