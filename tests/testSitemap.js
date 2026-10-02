// =============================================================================
// MyTube — sitemap generator tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// The generator writes the file the site actually serves, so two things have to
// stay true forever:
//
//   * it writes public/sitemap.xml, because public/ is the static asset
//     directory Cloudflare serves (wrangler.jsonc `assets.directory`) and it is
//     also what robots.txt advertises. A sitemap at the repository root is
//     neither served nor deployed.
//   * a /watch?id=... URL is byte-identical to the canonical the watch page
//     renders for itself (worker.js setVideoCanonical, watch.js
//     setVideoPageMeta). If the two encodings drift, the sitemap points at a URL
//     that is not the page's own canonical and the fix is undone.
//
// Importing the generator must not touch the network or the working tree, which
// is why the module only runs main() when invoked directly.
//
// Run: node --test tests/testSitemap.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORIGIN,
  buildSitemap,
  resolveSitemapPath,
  watchUrl
} from "../scripts/generate-sitemap.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const ROOT_SITEMAP = path.join(REPO_ROOT, "sitemap.xml");
const PUBLIC_SITEMAP = path.join(REPO_ROOT, "public", "sitemap.xml");

// One YouTube video id, in the `yt:` form the site stores.
const VIDEO_ID = "yt:Pd1yGW_g2T8";
// The exact string the sitemap, watch.js and worker.js must all produce.
const VIDEO_URL = `${ORIGIN}/watch?id=yt%3APd1yGW_g2T8`;

// ---------------------------------------------------------------------------
// A) Output path
// ---------------------------------------------------------------------------

test("A1 the generator resolves its output path to public/sitemap.xml", () => {
  assert.equal(resolveSitemapPath(), PUBLIC_SITEMAP);
});

test("A2 the output path is not the repository root", () => {
  assert.notEqual(resolveSitemapPath(), ROOT_SITEMAP);
  assert.equal(path.dirname(resolveSitemapPath()), path.join(REPO_ROOT, "public"));
});

test("A3 no unserved sitemap.xml sits at the repository root", () => {
  assert.equal(
    existsSync(ROOT_SITEMAP),
    false,
    "a root sitemap.xml is not served by Cloudflare and must not be generated"
  );
});

test("A4 robots.txt advertises the same sitemap the generator writes", () => {
  const robots = readFileSync(path.join(REPO_ROOT, "public", "robots.txt"), "utf8");
  const line = robots.split(/\r?\n/).find(l => /^Sitemap:/i.test(l.trim()));

  assert.ok(line, "robots.txt must advertise a sitemap");

  const advertised = line.trim().replace(/^Sitemap:\s*/i, "").trim();

  // Advertised as a bare path: the file the generator writes has to be the file
  // this resolves to on the deployed origin.
  assert.equal(advertised, `${ORIGIN}/sitemap.xml`);
  assert.equal(path.basename(PUBLIC_SITEMAP), "sitemap.xml");
});

// ---------------------------------------------------------------------------
// B) URL format and encoding
// ---------------------------------------------------------------------------

test("B1 a yt: id becomes an encoded /watch?id= URL", () => {
  assert.equal(watchUrl(VIDEO_ID), VIDEO_URL);
});

test("B2 encodeURIComponent is applied to the whole id, colon included", () => {
  const url = watchUrl(VIDEO_ID);

  assert.ok(url.includes("%3A"), "the `yt:` colon must be percent-encoded");
  assert.ok(!url.includes("yt:"), "the raw colon must never appear in a sitemap URL");
  assert.equal(url, `${ORIGIN}/watch?id=${encodeURIComponent(VIDEO_ID)}`);
});

test("B3 surrounding whitespace is trimmed before encoding", () => {
  assert.equal(watchUrl("  yt:Pd1yGW_g2T8  "), VIDEO_URL);
});

test("B4 non-yt: and malformed ids produce no URL at all", () => {
  // MyTube is YouTube-only. Anything that is not a namespaced `yt:` id has no
  // resolvable watch page, so it must not reach the sitemap.
  assert.equal(watchUrl("Pd1yGW_g2T8"), "");
  assert.equal(watchUrl("vimeo:12345"), "");
  assert.equal(watchUrl("yt:"), "");
  assert.equal(watchUrl(""), "");
  assert.equal(watchUrl(null), "");
  assert.equal(watchUrl(undefined), "");
  assert.equal(watchUrl(42), "");
});

test("B5 ids that need extra escaping are encoded, not concatenated raw", () => {
  const url = watchUrl("yt:a b&c");

  assert.equal(url, `${ORIGIN}/watch?id=${encodeURIComponent("yt:a b&c")}`);
  assert.ok(!url.includes("&"), "a raw & would split the query string");
});

// ---------------------------------------------------------------------------
// C) Generated document
// ---------------------------------------------------------------------------

const URLS = [
  VIDEO_URL,
  `${ORIGIN}/watch?id=yt%3Aaaaaaaaaaaa`,
  `${ORIGIN}/watch?id=${encodeURIComponent("yt:a b&c")}`
];

test("C1 the document contains the homepage", () => {
  const xml = buildSitemap(URLS, "2026-10-02");

  assert.ok(xml.includes(`<loc>${ORIGIN}/</loc>`));
  assert.match(xml, /<loc>https:\/\/mytube\.farqas007\.workers\.dev\/<\/loc>/);
});

test("C2 every watch URL is present, unescaped-safe and lastmod-stamped", () => {
  const xml = buildSitemap(URLS, "2026-10-02");
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);

  assert.equal(locs.length, URLS.length + 1, "homepage + every watch URL");
  assert.deepEqual(locs.slice(1), URLS);
  assert.equal((xml.match(/<lastmod>2026-10-02<\/lastmod>/g) || []).length, URLS.length + 1);
});

test("C3 XML special characters in a URL are escaped, not emitted raw", () => {
  const xml = buildSitemap(URLS, "2026-10-02");

  // encodeURIComponent already turns `&` into %26, so the escaping is a second
  // line of defence. Prove it by handing buildSitemap a URL that was NOT encoded
  // and checking the document stays parseable.
  const malformed = `${ORIGIN}/watch?id=yt%3Aa&b<c>d"e'f`;
  const escaped = buildSitemap([malformed], "2026-10-02");

  assert.ok(!escaped.includes("&b<c>"), "raw & and <> must not survive into <loc>");
  assert.ok(escaped.includes("&amp;b&lt;c&gt;d&quot;e&apos;f"));

  // And in the real document no <loc> carries an unescaped bare ampersand.
  for (const loc of [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1])) {
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(loc), "unescaped & in " + loc);
  }
});

test("C4 the document is well-formed XML with a single urlset", () => {
  const xml = buildSitemap(URLS, "2026-10-02");

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal((xml.match(/<urlset\b/g) || []).length, 1);
  assert.equal((xml.match(/<\/urlset>/g) || []).length, 1);
  assert.equal((xml.match(/<url>/g) || []).length, URLS.length + 1);
  assert.equal((xml.match(/<\/url>/g) || []).length, URLS.length + 1);
  assert.ok(xml.trimEnd().endsWith("</urlset>"));

  // Balanced tags across the whole document.
  for (const tag of ["url", "loc", "lastmod", "changefreq", "priority"]) {
    assert.equal(
      (xml.match(new RegExp(`<${tag}>`, "g")) || []).length,
      (xml.match(new RegExp(`</${tag}>`, "g")) || []).length,
      `<${tag}> must be balanced`
    );
  }
});

test("C5 the homepage outranks every watch URL", () => {
  const xml = buildSitemap(URLS, "2026-10-02");
  const priorities = [...xml.matchAll(/<priority>([^<]*)<\/priority>/g)].map(m => m[1]);

  assert.equal(priorities[0], "1.0");
  assert.deepEqual(priorities.slice(1), URLS.map(() => "0.7"));
});

// ---------------------------------------------------------------------------
// D) The committed sitemap matches the current generator
// ---------------------------------------------------------------------------

test("D1 public/sitemap.xml on disk is what the current generator produces", () => {
  assert.equal(
    existsSync(PUBLIC_SITEMAP),
    true,
    "public/sitemap.xml is the served sitemap and must exist"
  );

  const committed = readFileSync(PUBLIC_SITEMAP, "utf8");
  const locs = [...committed.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);

  assert.ok(
    locs.includes(`${ORIGIN}/`),
    "the served sitemap must contain the homepage"
  );

  const watchLocs = locs.filter(loc => loc.includes("/watch?id="));

  assert.ok(watchLocs.length > 0, "the served sitemap must contain watch URLs");

  for (const loc of watchLocs) {
    assert.ok(loc.startsWith(`${ORIGIN}/watch?id=yt%3A`), "watch URLs stay encoded: " + loc);
  }

  // Regenerating from these very locs must reproduce the file byte for byte, so
  // the checked-in sitemap can never drift from the generator's formatting.
  const lastmod = committed.match(/<lastmod>([^<]*)<\/lastmod>/)[1];

  assert.equal(buildSitemap(watchLocs, lastmod), committed);
});

// ---------------------------------------------------------------------------
// E) The generated URL is the page's own canonical
// ---------------------------------------------------------------------------

test("E1 the sitemap URL matches the canonical worker.js renders", async () => {
  // Imported (not duplicated) so the assertion cannot drift from the real
  // implementation: if worker.js ever changes its encoding, this fails.
  const { setVideoCanonical } = await import("../worker.js");

  assert.equal(
    setVideoCanonical(VIDEO_ID),
    watchUrl(VIDEO_ID),
    "sitemap URL and page canonical must be the same string"
  );
  assert.equal(setVideoCanonical(VIDEO_ID), VIDEO_URL);
});

test("E2 the canonical origin is the one the shell ships", () => {
  // worker.js keeps WATCH_ORIGIN module-private (workerd forbids re-exporting a
  // non-function), so this reads it back off the page's own canonical element.
  const shell = readFileSync(path.join(REPO_ROOT, "public", "watch.html"), "utf8");
  const shellCanonical = shell.match(/id="pageCanonical"[^>]*href="([^"]*)"/)[1];
  const shellOrigin = shellCanonical.replace(/\/watch$/, "");

  assert.equal(shellOrigin, ORIGIN);
  assert.equal(watchUrl(VIDEO_ID), `${shellOrigin}/watch?id=yt%3APd1yGW_g2T8`);
});

test("E3 the internal-link convention in the frontend is /watch?id=", () => {
  const sources = [
    "public/index.html",
    "public/library.js",
    "public/profile.js",
    "public/subscriptions.js",
    "public/watch.js"
  ];

  for (const rel of sources) {
    const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");

    assert.ok(
      !/watch\.html\?id=/.test(text),
      `${rel} must not link to the duplicate watch.html form`
    );

    assert.ok(
      /\/watch\?id="\s*\+\s*encodeURIComponent\(/.test(text),
      `${rel} must build /watch?id= with encodeURIComponent`
    );
  }
});
