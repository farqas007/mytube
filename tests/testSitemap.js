// =============================================================================
// MyTube — sitemap generator tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// The generator writes the file the site actually serves, so a few things have
// to stay true forever:
//
//   * it writes public/sitemap.xml, because public/ is the static asset
//     directory Cloudflare serves (wrangler.jsonc `assets.directory`) and it is
//     also what robots.txt advertises. A sitemap at the repository root is
//     neither served nor deployed.
//   * a /watch?id=... URL is byte-identical to the canonical the watch page
//     renders for itself (worker.js setVideoCanonical, watch.js
//     setVideoPageMeta). If the two encodings drift, the sitemap points at a URL
//     that is not the page's own canonical and the fix is undone.
//   * regeneration is a MERGE, not a replace: existing watch URLs keep their own
//     <lastmod>, newly collected URLs get today's date, and the file is only
//     ever overwritten when the pagination walk succeeds AND the existing file
//     parses cleanly. Any failure leaves the served file untouched.
//
// Importing the generator must not touch the network or the working tree, which
// is why the module only runs main() when invoked directly.
//
// Run: node --test tests/testSitemap.js  (or `npm test`)
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORIGIN,
  buildSitemap,
  collectTrendingUrls,
  DEFAULT_MAX_SITEMAP_URLS,
  generateSitemap,
  MAX_PAGINATION_PAGES,
  mergeSitemapEntries,
  parseSitemap,
  resolveMaxSitemapUrls,
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

function url(id) {
  return `${ORIGIN}/watch?id=${encodeURIComponent(id)}`;
}

function home(lastmod) {
  return { loc: `${ORIGIN}/`, lastmod };
}

function entry(id, lastmod) {
  return { loc: url(id), lastmod };
}

// A throwaway fetch double. It records every URL it was asked to fetch and lets
// the responder produce the payload for each successive request.
function fakeFetch(responder) {
  const calls = [];
  const impl = async requested => {
    calls.push(String(requested));
    const outcome = await responder(String(requested), calls.length);

    if (outcome && outcome.ok === false) {
      return {
        ok: false,
        status: outcome.status || 500,
        statusText: outcome.statusText || "Error"
      };
    }

    return { ok: true, status: 200, json: async () => outcome };
  };
  impl.calls = calls;
  return impl;
}

// A scratch directory that always gets cleaned up, even when the body throws.
async function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mytube-sitemap-test-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
  const result = watchUrl(VIDEO_ID);

  assert.ok(result.includes("%3A"), "the `yt:` colon must be percent-encoded");
  assert.ok(!result.includes("yt:"), "the raw colon must never appear in a sitemap URL");
  assert.equal(result, `${ORIGIN}/watch?id=${encodeURIComponent(VIDEO_ID)}`);
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
  const result = watchUrl("yt:a b&c");

  assert.equal(result, `${ORIGIN}/watch?id=${encodeURIComponent("yt:a b&c")}`);
  assert.ok(!result.includes("&"), "a raw & would split the query string");
});

// ---------------------------------------------------------------------------
// C) Generated document
// ---------------------------------------------------------------------------

const ENTRIES = [
  home("2026-10-02"),
  entry("Pd1yGW_g2T8", "2026-10-02"),
  { loc: url("aaaaaaaaaaa"), lastmod: "2026-10-02" },
  { loc: url("a b&c"), lastmod: "2026-10-02" }
];
const URLS = ENTRIES.slice(1).map(e => e.loc);

test("C1 the document contains the homepage", () => {
  const xml = buildSitemap(ENTRIES);

  assert.ok(xml.includes(`<loc>${ORIGIN}/</loc>`));
  assert.match(xml, /<loc>https:\/\/mytube\.farqas007\.workers\.dev\/<\/loc>/);
});

test("C2 every watch URL is present, unescaped-safe and lastmod-stamped", () => {
  const xml = buildSitemap(ENTRIES);
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);

  assert.equal(locs.length, ENTRIES.length, "homepage + every watch URL");
  assert.deepEqual(locs.slice(1), URLS);
  assert.equal((xml.match(/<lastmod>2026-10-02<\/lastmod>/g) || []).length, ENTRIES.length);
});

test("C3 per-URL lastmods survive into the document", () => {
  const xml = buildSitemap([
    home("2026-09-01"),
    entry("aaaaaaaaaaa", "2026-09-01"),
    entry("bbbbbbbbbbb", "2026-10-02")
  ]);

  assert.equal((xml.match(/<lastmod>2026-09-01<\/lastmod>/g) || []).length, 2);
  assert.equal((xml.match(/<lastmod>2026-10-02<\/lastmod>/g) || []).length, 1);
});

test("C4 XML special characters in a URL are escaped, not emitted raw", () => {
  const xml = buildSitemap(ENTRIES);

  // encodeURIComponent already turns `&` into %26, so the escaping is a second
  // line of defence. Prove it by handing buildSitemap a URL that was NOT encoded
  // and checking the document stays parseable.
  const malformed = `${ORIGIN}/watch?id=yt%3Aa&b<c>d"e'f`;
  const escaped = buildSitemap([home("2026-10-02"), { loc: malformed, lastmod: "2026-10-02" }]);

  assert.ok(!escaped.includes("&b<c>"), "raw & and <> must not survive into <loc>");
  assert.ok(escaped.includes("&amp;b&lt;c&gt;d&quot;e&apos;f"));

  // And in the real document no <loc> carries an unescaped bare ampersand.
  for (const loc of [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1])) {
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(loc), "unescaped & in " + loc);
  }
});

test("C5 the document is well-formed XML with a single urlset", () => {
  const xml = buildSitemap(ENTRIES);

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.equal((xml.match(/<urlset\b/g) || []).length, 1);
  assert.equal((xml.match(/<\/urlset>/g) || []).length, 1);
  assert.equal((xml.match(/<url>/g) || []).length, ENTRIES.length);
  assert.equal((xml.match(/<\/url>/g) || []).length, ENTRIES.length);
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

test("C6 the homepage outranks every watch URL", () => {
  const xml = buildSitemap(ENTRIES);
  const priorities = [...xml.matchAll(/<priority>([^<]*)<\/priority>/g)].map(m => m[1]);

  assert.equal(priorities[0], "1.0");
  assert.deepEqual(priorities.slice(1), URLS.map(() => "0.7"));
});

// ---------------------------------------------------------------------------
// D) The committed sitemap is the fixed point of the generator
// ---------------------------------------------------------------------------

test("D1 public/sitemap.xml parses, contains the homepage and stays encoded", () => {
  assert.equal(
    existsSync(PUBLIC_SITEMAP),
    true,
    "public/sitemap.xml is the served sitemap and must exist"
  );

  const committed = readFileSync(PUBLIC_SITEMAP, "utf8");
  const entries = parseSitemap(committed);
  const locs = entries.map(e => e.loc);

  assert.ok(locs.includes(`${ORIGIN}/`), "the served sitemap must contain the homepage");
  assert.equal(locs[0], `${ORIGIN}/`, "the homepage must stay first");

  const watchLocs = locs.filter(loc => loc.includes("/watch?id="));

  assert.ok(watchLocs.length > 0, "the served sitemap must contain watch URLs");

  for (const loc of watchLocs) {
    assert.ok(loc.startsWith(`${ORIGIN}/watch?id=yt%3A`), "watch URLs stay encoded: " + loc);
  }

  // Every entry carries a lastmod so a merge never has to invent one.
  for (const entry of entries) {
    assert.ok(entry.lastmod, "every entry has a lastmod: " + entry.loc);
  }
});

test("D2 the committed sitemap is byte-identical to parse -> rebuild", () => {
  // Regenerating from the file's own entries must reproduce it byte for byte.
  // parseSitemap preserves each <loc>/<lastmod> pair and buildSitemap re-emits
  // them with the same priority and escaping, so the checked-in file can never
  // drift from the generator's formatting.
  const committed = readFileSync(PUBLIC_SITEMAP, "utf8");

  assert.equal(buildSitemap(parseSitemap(committed)), committed);
});

test("D3 merge-of-committed plus new URLs reproduces the served file shape", () => {
  const committed = readFileSync(PUBLIC_SITEMAP, "utf8");
  const existing = parseSitemap(committed);
  const watchLocs = existing.map(e => e.loc).filter(loc => loc.includes("/watch?id="));

  // A fresh video not in the current file must append after everything present.
  const merged = mergeSitemapEntries(existing, [url("zzzzzzzzzzz")], {
    maxUrls: 50000,
    today: "2026-10-02"
  });
  const mergedLocs = merged.map(e => e.loc);

  assert.equal(mergedLocs[0], `${ORIGIN}/`);
  assert.deepEqual(
    mergedLocs.slice(1, mergedLocs.length - 1),
    watchLocs,
    "existing watch URLs keep their relative order"
  );
  assert.equal(mergedLocs[mergedLocs.length - 1], url("zzzzzzzzzzz"));

  // lastmod of a preserved entry is untouched by the merge.
  const firstExisting = existing.find(e => e.loc.includes("/watch?id="));
  const mergedSame = mergeSitemapEntries(existing, [firstExisting.loc], {
    maxUrls: 50000,
    today: "2099-01-01"
  });
  assert.equal(mergedSame.find(e => e.loc === firstExisting.loc).lastmod, firstExisting.lastmod);
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

// ---------------------------------------------------------------------------
// F) parseSitemap
// ---------------------------------------------------------------------------

test("F1 parses loc and lastmod pairs back in file order", () => {
  const xml = buildSitemap([
    home("2026-09-01"),
    entry("aaaaaaaaaaa", "2026-09-15"),
    { loc: url("a b&c"), lastmod: "2026-10-02" }
  ]);

  assert.deepEqual(parseSitemap(xml), [
    home("2026-09-01"),
    entry("aaaaaaaaaaa", "2026-09-15"),
    { loc: url("a b&c"), lastmod: "2026-10-02" }
  ]);
});

test("F2 an empty or whitespace-only document yields no entries", () => {
  assert.deepEqual(parseSitemap(""), []);
  assert.deepEqual(parseSitemap("   \n\t  "), []);
});

test("F3 a document that is not a sitemap throws", () => {
  assert.throws(() => parseSitemap("<html>not a sitemap</html>"), /not a sitemap document/);
  assert.throws(() => parseSitemap("hello world"), /not a sitemap document/);
});

test("F4 a url block without a loc throws", () => {
  assert.throws(
    () => parseSitemap('<?xml version="1.0"?>\n<urlset><url><lastmod>2026-01-01</lastmod></url></urlset>'),
    /without <loc>/
  );
});

test("F5 a urlset with no url blocks throws", () => {
  assert.throws(
    () => parseSitemap('<?xml version="1.0"?>\n<urlset xmlns="x"></urlset>'),
    /no <url> entries/
  );
});

test("F6 XML-escaped characters in loc are unescaped on parse", () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="x">\n  <url>\n    <loc>' +
    `${ORIGIN}/watch?id=yt%3Aa&amp;b</loc>\n    <lastmod>2026-01-01</lastmod>\n  </url>\n</urlset>\n`;

  assert.deepEqual(parseSitemap(xml), [{ loc: `${ORIGIN}/watch?id=yt%3Aa&b`, lastmod: "2026-01-01" }]);
});

test("F7 a document with a missing </urlset> closing tag is rejected", () => {
  // Complete <url> blocks inside a truncated document must not smuggle past the
  // parser, or the intact entries would be accepted and the broken file
  // overwritten instead of aborted.
  const truncated = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="x">\n' +
    '  <url>\n    <loc>https://mytube.farqas007.workers.dev/</loc>\n    <lastmod>2026-01-01</lastmod>\n  </url>\n';
  assert.throws(() => parseSitemap(truncated), /incomplete/);

  const noUrlsetTag = '<?xml version="1.0" encoding="UTF-8"?>\n<url>\n  <loc>https://mytube.farqas007.workers.dev/</loc>\n</url>\n</urlset>';
  assert.throws(() => parseSitemap(noUrlsetTag), /incomplete/);
});

test("F8 a <url> block that is never closed is rejected", () => {
  // A dangling <url> opener with the </urlset> still present (a file edited or
  // cut mid-<url> body) must be caught by the tag-balance check: its partial
  // entry must not be dropped silently.
  const dangling = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="x">\n' +
    '  <url>\n    <loc>https://mytube.farqas007.workers.dev/</loc>\n    <lastmod>2026-01-01</lastmod>\n</urlset>\n';
  assert.throws(() => parseSitemap(dangling), /unclosed <url>/);
});

test("F9 content after the closing </urlset> is rejected", () => {
  // Markup after the document terminator belongs to no urlset; matching the
  // whole text scooped it up and would have merged it into the new file.
  const trailing = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="x">\n' +
    '  <url>\n    <loc>https://mytube.farqas007.workers.dev/</loc>\n    <lastmod>2026-01-01</lastmod>\n  </url>\n' +
    '</urlset>\n  <extra>stray markup</extra>\n';
  assert.throws(() => parseSitemap(trailing), /trailing content after <\/urlset>/);
});

test("F10 a <url> block straddling the </urlset> boundary is rejected", () => {
  // The opener sits inside the urlset and its closer lands after </urlset>, so
  // the document balances when counted globally. Only scoping the balance to
  // the span inside the urlset catches it: the closer lives in the tail and
  // never balances the body.
  const straddling = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="x">\n' +
    '  <url>\n    <loc>https://mytube.farqas007.workers.dev/</loc>\n    <lastmod>2026-01-01</lastmod>\n' +
    '</urlset>\n  </url>\n';
  assert.throws(() => parseSitemap(straddling), /unclosed <url>/);
});

// ---------------------------------------------------------------------------
// G) collectTrendingUrls (cursor pagination)
// ---------------------------------------------------------------------------

test("G1 collects unique URLs across pages and stops when the feed ends", async () => {
  const fetchImpl = fakeFetch((requested, n) => {
    if (n === 1) {
      return {
        videos: [{ id: "yt:aaaaaaaaaaa" }, { id: "yt:aaaaaaaaaaa" }, { id: "yt:bbbbbbbbbbb" }],
        nextPageToken: "TOKEN"
      };
    }
    return {
      videos: [{ id: "yt:ccccccccccc" }, { id: "yt:bbbbbbbbbbb" }],
      nextPageToken: ""
    };
  });

  const urls = await collectTrendingUrls({ fetchImpl, maxUrls: 5000 });

  assert.deepEqual(urls, [url("yt:aaaaaaaaaaa"), url("yt:bbbbbbbbbbb"), url("yt:ccccccccccc")]);
  assert.equal(fetchImpl.calls.length, 2);

  // Page 1 carries no cursor; page 2 echoes the opaque continuation token.
  assert.ok(!fetchImpl.calls[0].includes("pageToken="), "first page has no cursor");
  assert.ok(fetchImpl.calls[1].includes("pageToken=TOKEN"), "second page carries the cursor");
});

test("G2 a non-OK API response throws instead of returning a partial set", async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 500, statusText: "Boom" }));

  await assert.rejects(
    () => collectTrendingUrls({ fetchImpl }),
    /API responded 500/i
  );
});

test("G3 a payload without a videos array throws", async () => {
  const fetchImpl = fakeFetch(() => ({ topics: [], regions: [] }));

  await assert.rejects(
    () => collectTrendingUrls({ fetchImpl }),
    /missing `videos` array/
  );
});

test("G4 a page that advertises more but adds nothing new throws fail-safe", async () => {
  const fetchImpl = fakeFetch((requested, n) => {
    if (n === 1) {
      return { videos: [{ id: "yt:aaaaaaaaaaa" }], nextPageToken: "T1" };
    }
    // Page 2 claims more feed but every url is already collected.
    return { videos: [{ id: "yt:aaaaaaaaaaa" }], nextPageToken: "T2" };
  });

  await assert.rejects(
    () => collectTrendingUrls({ fetchImpl }),
    /stopped making progress/
  );
});

test("G5 collection stops at the budget minus the homepage's reserved slot", async () => {
  const fetchImpl = fakeFetch(() => ({
    videos: [
      { id: "yt:a1" },
      { id: "yt:b2" },
      { id: "yt:c3" },
      { id: "yt:d4" },
      { id: "yt:e5" }
    ],
    nextPageToken: ""
  }));

  const urls = await collectTrendingUrls({ fetchImpl, maxUrls: 4 });

  // The budget is TOTAL (homepage included), so only 3 of the 5 offered watch
  // URLs fit; the homepage keeps one slot.
  assert.equal(urls.length, 3);
  assert.deepEqual(urls, [url("yt:a1"), url("yt:b2"), url("yt:c3")]);
});

test("G6 a run that never reaches the feed end is bounded by the page guard", async () => {
  let n = 0;
  const fetchImpl = fakeFetch(() => {
    n++;
    return { videos: [{ id: `yt:g${n}aaaaaaaaa` }], nextPageToken: "MORE" };
  });

  await assert.rejects(
    () => collectTrendingUrls({ fetchImpl, maxUrls: 5000, maxPages: 2 }),
    /exceeded 2 pages/
  );
});

test("G7 the default page guard is exported", () => {
  assert.equal(MAX_PAGINATION_PAGES, 100);
});

test("G8 a budget of one reserves everything for the homepage", async () => {
  const fetchImpl = fakeFetch(() => ({
    videos: [{ id: "yt:a1" }, { id: "yt:b2" }],
    nextPageToken: ""
  }));

  const urls = await collectTrendingUrls({ fetchImpl, maxUrls: 1 });

  assert.deepEqual(urls, [], "no watch URL fits when the homepage owns the only slot");
});

// ---------------------------------------------------------------------------
// H) mergeSitemapEntries
// ---------------------------------------------------------------------------

test("H1 merge unions existing and fresh URLs, dedup, homepage first", () => {
  const existing = [
    home("2026-09-01"),
    entry("yt:aaaaaaaaaaa", "2026-09-01"),
    entry("yt:bbbbbbbbbbb", "2026-09-01")
  ];
  const merged = mergeSitemapEntries(existing, [url("yt:ccccccccccc"), url("yt:bbbbbbbbbbb")], {
    maxUrls: 5000,
    today: "2026-10-02"
  });

  assert.deepEqual(merged.map(e => e.loc), [
    `${ORIGIN}/`,
    url("yt:aaaaaaaaaaa"),
    url("yt:bbbbbbbbbbb"),
    url("yt:ccccccccccc")
  ]);
});

test("H2 existing lastmod is preserved and new URLs get today's date", () => {
  const existing = [home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-15")];
  const merged = mergeSitemapEntries(existing, [url("yt:aaaaaaaaaaa"), url("yt:bbbbbbbbbbb")], {
    maxUrls: 5000,
    today: "2026-10-02"
  });

  assert.equal(merged.find(e => e.loc === url("yt:aaaaaaaaaaa")).lastmod, "2026-09-15");
  assert.equal(merged.find(e => e.loc === url("yt:bbbbbbbbbbb")).lastmod, "2026-10-02");
  assert.equal(merged[0].lastmod, "2026-09-01", "homepage keeps its existing lastmod");
});

test("H3 the homepage is always present, even with no existing entries", () => {
  const merged = mergeSitemapEntries([], [url("yt:aaaaaaaaaaa")], {
    maxUrls: 5000,
    today: "2026-10-02"
  });

  assert.deepEqual(merged[0], home("2026-10-02"));
});

test("H4 non-MyTube locs are dropped, never carried into the served file", () => {
  const existing = [
    home("2026-09-01"),
    { loc: "https://example.com/not-a-mytube-url", lastmod: "2026-09-01" },
    { loc: `${ORIGIN}/somewhere/else`, lastmod: "2026-09-01" },
    entry("yt:aaaaaaaaaaa", "2026-09-01")
  ];
  const merged = mergeSitemapEntries(existing, [], { maxUrls: 5000, today: "2026-10-02" });

  assert.deepEqual(merged.map(e => e.loc), [`${ORIGIN}/`, url("yt:aaaaaaaaaaa")]);
});

test("H5 the cap counts the homepage, so the total never exceeds maxUrls", () => {
  const existing = [
    home("2026-09-01"),
    entry("yt:aaaaaaaaaaa", "2026-09-01"),
    entry("yt:bbbbbbbbbbb", "2026-09-01"),
    entry("yt:ccccccccccc", "2026-09-01"),
    entry("yt:ddddddddddd", "2026-09-01")
  ];
  const merged = mergeSitemapEntries(existing, [url("yt:eeeeeeeeeee"), url("yt:fffffffffff")], {
    maxUrls: 4,
    today: "2026-10-02"
  });

  // Budget 4 = homepage + 3 watch URLs. The OLDEST watch URLs are trimmed so
  // the newest survive; the homepage never eats into the watch budget twice.
  assert.deepEqual(merged.map(e => e.loc), [
    `${ORIGIN}/`,
    url("yt:ddddddddddd"),
    url("yt:eeeeeeeeeee"),
    url("yt:fffffffffff")
  ]);
  assert.equal(merged.length, 4, "total equals the budget exactly");
});

test("H6 a cap of zero falls back to the default, never empties the sitemap", () => {
  const merged = mergeSitemapEntries(
    [home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")],
    [],
    { maxUrls: 0, today: "2026-10-02" }
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].loc, `${ORIGIN}/`);
  assert.equal(merged[1].loc, url("yt:aaaaaaaaaaa"));
});

test("H7 at the protocol ceiling the merged document is exactly 50,000 URLs", () => {
  const existing = [home("2026-09-01")];
  for (let i = 0; i < 50000; i++) {
    existing.push(entry(`yt:watch${String(i).padStart(5, "0")}`, "2026-09-01"));
  }

  const merged = mergeSitemapEntries(existing, [url("yt:brandnew0001")], {
    maxUrls: 50000,
    today: "2026-10-02"
  });

  // 50,000 watch URLs offered + homepage + 1 fresh URL must still land on the
  // ceiling: homepage first, then 49,999 watch URLs (the fresh one plus every
  // existing watch except the two oldest, which the FIFO trim drops).
  assert.equal(merged.length, 50000, "total never exceeds 50,000 URLs");
  assert.equal(merged[0].loc, `${ORIGIN}/`);
  assert.equal(merged.filter(e => e.loc.startsWith(`${ORIGIN}/watch?id=`)).length, 49999);
  assert.equal(merged[1].loc, url("yt:watch00002"), "the two oldest watch URLs are trimmed");
  assert.equal(merged[merged.length - 1].loc, url("yt:brandnew0001"), "the newest URL survives");
});

test("H8 a budget of one yields the homepage alone", () => {
  const merged = mergeSitemapEntries(
    [home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")],
    [url("yt:bbbbbbbbbbb")],
    { maxUrls: 1, today: "2026-10-02" }
  );

  assert.deepEqual(merged, [home("2026-09-01")]);
});

// ---------------------------------------------------------------------------
// I) resolveMaxSitemapUrls
// ---------------------------------------------------------------------------

test("I1 absent or invalid values fall back to the default", () => {
  assert.equal(resolveMaxSitemapUrls(undefined), DEFAULT_MAX_SITEMAP_URLS);
  assert.equal(resolveMaxSitemapUrls(null), DEFAULT_MAX_SITEMAP_URLS);
  assert.equal(resolveMaxSitemapUrls(""), DEFAULT_MAX_SITEMAP_URLS);
  assert.equal(resolveMaxSitemapUrls("0"), DEFAULT_MAX_SITEMAP_URLS);
  assert.equal(resolveMaxSitemapUrls("-5"), DEFAULT_MAX_SITEMAP_URLS);
  assert.equal(resolveMaxSitemapUrls("abc"), DEFAULT_MAX_SITEMAP_URLS);
});

test("I2 numeric values are honored and clamped to the protocol ceiling", () => {
  assert.equal(resolveMaxSitemapUrls("2000"), 2000);
  assert.equal(resolveMaxSitemapUrls(2000), 2000);
  assert.equal(resolveMaxSitemapUrls("90000"), 50000, "clamped to 50,000 URLs");
});

test("I3 the protocol ceiling is reachable but never exceeded", () => {
  assert.equal(resolveMaxSitemapUrls("50000"), 50000, "the ceiling itself is honored");
  assert.equal(resolveMaxSitemapUrls(50000), 50000);
  assert.equal(resolveMaxSitemapUrls(50001), 50000, "one over the ceiling clamps down");
  assert.equal(resolveMaxSitemapUrls("1000000000"), 50000, "any huge value clamps down");
  assert.equal(resolveMaxSitemapUrls(Infinity), DEFAULT_MAX_SITEMAP_URLS, "non-finite falls back to the default");
});

// ---------------------------------------------------------------------------
// J) generateSitemap end-to-end (temp dir, injected fetch)
// ---------------------------------------------------------------------------

test("J1 a fresh run with no existing file writes homepage + today-stamped URLs", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const fetchImpl = fakeFetch(() => ({
      videos: [{ id: "yt:aaaaaaaaaaa" }, { id: "yt:bbbbbbbbbbb" }],
      nextPageToken: ""
    }));

    await generateSitemap({ outputPath: out, fetchImpl, today: "2026-10-02", maxUrls: 5000 });

    assert.equal(
      readFileSync(out, "utf8"),
      buildSitemap([home("2026-10-02"), entry("yt:aaaaaaaaaaa", "2026-10-02"), entry("yt:bbbbbbbbbbb", "2026-10-02")])
    );
    assert.equal(existsSync(out + ".tmp"), false, "no temp file may survive a success");
  });
});

test("J2 a successful run merges with, and preserves lastmods from, the existing file", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    writeFileSync(out, buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]));

    const fetchImpl = fakeFetch((requested, n) => {
      if (n === 1) {
        return { videos: [{ id: "yt:aaaaaaaaaaa" }, { id: "yt:bbbbbbbbbbb" }], nextPageToken: "N1" };
      }
      return { videos: [{ id: "yt:ccccccccccc" }], nextPageToken: "" };
    });

    await generateSitemap({ outputPath: out, fetchImpl, today: "2026-10-03", maxUrls: 5000 });

    assert.equal(
      readFileSync(out, "utf8"),
      buildSitemap([
        home("2026-09-01"),
        entry("yt:aaaaaaaaaaa", "2026-09-01"),
        entry("yt:bbbbbbbbbbb", "2026-10-03"),
        entry("yt:ccccccccccc", "2026-10-03")
      ])
    );
  });
});

test("J3 an API failure leaves the existing sitemap byte-for-byte untouched", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const original = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    writeFileSync(out, original);

    const failingFetch = fakeFetch(() => ({ ok: false, status: 500, statusText: "Nope" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: failingFetch }),
      /API responded 500/i
    );
    assert.equal(readFileSync(out, "utf8"), original, "existing file must be unchanged");
    assert.equal(existsSync(out + ".tmp"), false, "no temp residue on failure");
  });
});

test("J4 no usable video ids leaves the existing sitemap untouched", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const original = buildSitemap([home("2026-09-01")]);
    writeFileSync(out, original);

    const fetchImpl = fakeFetch(() => ({ videos: [], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl }),
      /no usable "yt:" video ids/
    );
    assert.equal(readFileSync(out, "utf8"), original);
  });
});

test("J5 a malformed existing sitemap aborts without touching the file", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const original = "this is not a sitemap\n";
    writeFileSync(out, original);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:aaaaaaaaaaa" }], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: goodFetch }),
      /not a sitemap document/
    );
    assert.equal(readFileSync(out, "utf8"), original, "existing file must be unchanged");
  });
});

test("J6 a pagination stall aborts without touching the file", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const original = buildSitemap([home("2026-09-01")]);
    writeFileSync(out, original);

    const fetchImpl = fakeFetch((requested, n) => {
      if (n === 1) {
        return { videos: [{ id: "yt:aaaaaaaaaaa" }], nextPageToken: "T" };
      }
      return { videos: [], nextPageToken: "T" };
    });

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl }),
      /stopped making progress/
    );
    assert.equal(readFileSync(out, "utf8"), original);
  });
});

test("J7 an existing sitemap missing its closing </urlset> aborts byte-for-byte", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const complete = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    const truncated = complete.replace(/<\/urlset>\s*$/, "");
    writeFileSync(out, truncated);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:bbbbbbbbbbb" }], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: goodFetch }),
      /incomplete/
    );
    assert.equal(readFileSync(out, "utf8"), truncated, "truncated file must remain untouched");
    assert.equal(existsSync(out + ".tmp"), false, "no temp file may be left behind");
  });
});

test("J8 an existing sitemap with an unclosed <url> block aborts byte-for-byte", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const complete = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    // Drop only the last </url> closer so </urlset> survives: the file is
    // structurally incomplete even though the document terminator is present.
    const dangling = complete.replace("  </url>\n</urlset>", "</urlset>");
    writeFileSync(out, dangling);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:bbbbbbbbbbb" }], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: goodFetch }),
      /unclosed <url>/
    );
    assert.equal(readFileSync(out, "utf8"), dangling, "incomplete file must remain untouched");
    assert.equal(existsSync(out + ".tmp"), false, "no temp file may be left behind");
  });
});

test("J9 a full run caps the served document at the budget, homepage included", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const fetchImpl = fakeFetch(() => ({
      videos: [{ id: "yt:a1" }, { id: "yt:b2" }, { id: "yt:c3" }, { id: "yt:d4" }, { id: "yt:e5" }],
      nextPageToken: ""
    }));

    // Budget 3 = homepage + 2 watch URLs; the collector already stops at 2 and
    // the merge re-checks the same bound on the way out.
    await generateSitemap({ outputPath: out, fetchImpl, today: "2026-10-02", maxUrls: 3 });

    const xml = readFileSync(out, "utf8");
    assert.equal((xml.match(/<url>/g) || []).length, 3, "total never exceeds the budget");
    assert.equal((xml.match(/<url>/g) || []).length, (xml.match(/<\/url>/g) || []).length);
    assert.equal(
      xml,
      buildSitemap([home("2026-10-02"), entry("yt:a1", "2026-10-02"), entry("yt:b2", "2026-10-02")])
    );
  });
});

test("J10 trailing content after </urlset> aborts byte-for-byte", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const complete = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    const trailing = complete + "\n<extra>stray markup</extra>\n";
    writeFileSync(out, trailing);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:bbbbbbbbbbb" }], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: goodFetch }),
      /trailing content after <\/urlset>/
    );
    assert.equal(readFileSync(out, "utf8"), trailing, "file with a stray tail must remain untouched");
    assert.equal(existsSync(out + ".tmp"), false, "no temp file may be left behind");
  });
});

test("J11 a <url> block straddling </urlset> aborts byte-for-byte", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const complete = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    // Move the last closer past the document terminator so the block balances
    // globally but not inside the urlset span.
    const straddling = complete.replace("  </url>\n</urlset>", "</urlset>\n  </url>");
    writeFileSync(out, straddling);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:bbbbbbbbbbb" }], nextPageToken: "" }));

    await assert.rejects(
      () => generateSitemap({ outputPath: out, fetchImpl: goodFetch }),
      /unclosed <url>/
    );
    assert.equal(readFileSync(out, "utf8"), straddling, "straddling file must remain untouched");
    assert.equal(existsSync(out + ".tmp"), false, "no temp file may be left behind");
  });
});

test("J12 a failure during the final write leaves the served file intact", async () => {
  await withTempDir(async dir => {
    const out = path.join(dir, "sitemap.xml");
    const original = buildSitemap([home("2026-09-01"), entry("yt:aaaaaaaaaaa", "2026-09-01")]);
    writeFileSync(out, original);

    // Fail the atomic swap deterministically: the temp path is already a
    // directory, so the write fails with EISDIR for every user (root included)
    // and on every OS. No permission bits involved, so the test cannot flake
    // when the suite runs privileged.
    const tempPath = out + ".tmp";
    mkdirSync(tempPath);

    const goodFetch = fakeFetch(() => ({ videos: [{ id: "yt:bbbbbbbbbbb" }], nextPageToken: "" }));

    await assert.rejects(() => generateSitemap({ outputPath: out, fetchImpl: goodFetch }));
    assert.equal(
      readFileSync(out, "utf8"),
      original,
      "the served file must remain byte-for-byte unchanged after a failed write"
    );
    assert.equal(
      statSync(tempPath).isDirectory(),
      true,
      "the temp path must not hold a partial file after cleanup"
    );
  });
});
