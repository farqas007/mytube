// =============================================================================
// MyTube — app-page robots meta tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// The signed-in-only app pages (library, subscriptions, profile) and the two
// auth pages (login, signup) are static assets: they always answer HTTP 200,
// and before this they carried no robots directive at all. That made every one
// of them an indexable URL whose entire body is a "you must log in" panel —
// thin, duplicate-ish pages with nothing to rank, all reachable from the
// homepage's own sidebar.
//
// They are still linked from the navigation on purpose; `noindex, follow` keeps
// the crawl path open while taking the pages out of the index. This suite pins
// that tag against the real files on disk AND against the bytes that leave the
// Worker through the ASSETS binding, so it cannot pass against a fixture that
// drifted from what is deployed.
//
// It also pins the two pages that must NOT be caught by this change: the
// homepage and the watch shell both stay indexable.
//
// Run: node --test tests/testAppPageRobots.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../worker.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const ORIGIN = "https://mytube.farqas007.workers.dev";

const NOINDEX = "noindex, follow";

// The pages this change is allowed to touch, mapped to the asset that serves
// them. Cloudflare's `html_handling` collapses /library.html onto /library, so
// the file is what both URL forms render.
const APP_PAGES = [
  { url: "/library", file: "library.html" },
  { url: "/library?tab=history", file: "library.html" },
  { url: "/library?tab=saved", file: "library.html" },
  { url: "/library?tab=liked", file: "library.html" },
  { url: "/subscriptions", file: "subscriptions.html" },
  { url: "/profile", file: "profile.html" },
  { url: "/login", file: "login.html" },
  { url: "/signup", file: "signup.html" }
];

// The two pages that must stay indexable. If either ever picks up the tag, this
// suite fails here rather than in Search Console.
const MUST_STAY_INDEXABLE = [
  { file: "index.html", expected: "index, follow" },
  {
    file: "watch.html",
    expected: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
  }
];

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

function readPage(file) {
  return readFileSync(path.join(REPO_ROOT, "public", file), "utf8");
}

// Read one meta tag's content out of an HTML string.
function metaContent(html, selector) {
  const attr = selector.startsWith("meta[property") ? "property" : "name";
  const value = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"'));
  const pattern = new RegExp(`<meta\\b[^>]*\\b${attr}="${value}"[^>]*\\bcontent="([^"]*)"`, "i");
  const match = html.match(pattern);

  return match ? match[1] : null;
}

// Every robots meta in the document, in order. Used to prove the tag was added
// once rather than appended on top of an existing one.
function allRobotsValues(html) {
  const pattern = /<meta\b[^>]*\bname="robots"[^>]*\bcontent="([^"]*)"[^>]*>/gi;

  return [...html.matchAll(pattern)].map(match => match[1]);
}

// The static binding, reduced to what the Worker actually asks it for: it serves
// the real public/ files, so the assertions run against shipped markup.
//
// It also models the one routing rule these URLs depend on. Cloudflare's
// `html_handling` serves an extensionless path from the matching .html asset
// (`/library` -> library.html) and redirects the `.html` name onto the clean
// path, so `/library` is a real, indexable 200 URL and not a 404. Without this,
// `/library` would look like a missing asset and the tests would pass for the
// wrong reason.
function createFakeAssets() {
  const requested = [];

  return {
    requested,
    async fetch(request) {
      const url = new URL(request.url);
      const name = path.posix.basename(url.pathname);
      const candidates = name.endsWith(".html") ? [name] : [name + ".html"];

      requested.push(url.pathname);

      for (const candidate of candidates) {
        try {
          const html = readPage(candidate);

          return new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ETag: `"${candidate}"`,
              "Content-Length": String(html.length)
            }
          });
        } catch {
          // Try the next candidate.
        }
      }

      return new Response("not found", { status: 404 });
    }
  };
}

function createFakeCtx() {
  return {
    pending: [],
    waitUntil(promise) {
      this.pending.push(promise);
    }
  };
}

let ipCounter = 0;

function nextIp() {
  ipCounter += 1;

  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.7`;
}

async function serve(url) {
  const assets = createFakeAssets();
  const request = new Request(`${ORIGIN}${url}`, {
    method: "GET",
    headers: { "CF-Connecting-IP": nextIp(), Origin: ORIGIN }
  });

  const response = await worker.fetch(request, { YOUTUBE_API_KEY: "test-key", ASSETS: assets }, createFakeCtx());

  return { response, html: await response.text(), requested: assets.requested };
}

// -----------------------------------------------------------------------------
// A) The tag is on the real files
// -----------------------------------------------------------------------------

test("A1 every app page carries noindex, follow in the shipped HTML", () => {
  for (const { file } of APP_PAGES) {
    assert.deepEqual(
      allRobotsValues(readPage(file)),
      [NOINDEX],
      `public/${file} must carry exactly one robots meta, and it must be "${NOINDEX}"`
    );
  }
});

test("A2 the tag is inside <head>, not appended to the body", () => {
  for (const { file } of APP_PAGES) {
    const html = readPage(file);
    const head = html.slice(0, html.search(/<\/head>/i));

    assert.notEqual(head, "", `public/${file} has no <head>`);
    assert.equal(metaContent(head, 'meta[name="robots"]'), NOINDEX, `public/${file}`);
  }
});

test("A3 the homepage and the watch shell are still indexable", () => {
  // The regression guard for this change: neither page may pick up the tag.
  for (const { file, expected } of MUST_STAY_INDEXABLE) {
    assert.deepEqual(
      allRobotsValues(readPage(file)),
      [expected],
      `public/${file} must keep its indexable robots meta`
    );
  }
});

// -----------------------------------------------------------------------------
// B) The tag survives to the bytes that leave the Worker
// -----------------------------------------------------------------------------

test("B1 every app URL form answers 200 with noindex, follow", async () => {
  for (const { url, file } of APP_PAGES) {
    const { response, html } = await serve(url);

    assert.equal(response.status, 200, `${url} must still answer 200, not a redirect or a 404`);
    assert.equal(metaContent(html, 'meta[name="robots"]'), NOINDEX, `${url} (from public/${file})`);
  }
});

test("B2 the three library tab variants are all covered by the one file", async () => {
  // /library?tab=history|saved|liked are three crawlable URLs for the same page.
  // They are served by the same asset, so one tag covers all three; asserted
  // per-URL because a query string is exactly the kind of thing a rewrite rule
  // or a future refactor can silently strip.
  for (const tab of ["history", "saved", "liked"]) {
    const url = `/library?tab=${tab}`;
    const { response, html } = await serve(url);

    assert.equal(response.status, 200, url);
    assert.equal(metaContent(html, 'meta[name="robots"]'), NOINDEX, url);
    assert.equal(metaContent(html, 'meta[name="title"]'), null, `${url} must not gain a robots-shaped title`);
  }
});

test("B3 no app page gained a canonical, and none lost its title", () => {
  // This change adds one meta tag and nothing else. A canonical here would be a
  // separate decision (it would need to pick a winner among the tab variants),
  // so its absence is asserted rather than left to chance.
  for (const { file } of APP_PAGES) {
    const html = readPage(file);

    assert.equal(
      /<link\b[^>]*\brel="canonical"/i.test(html),
      false,
      `public/${file} must not gain a canonical from this change`
    );
    assert.match(html, /<title>[^<]+<\/title>/i, `public/${file} must keep its <title>`);
  }
});

test("B4 the pages stay reachable: noindex, follow keeps the crawl path open", async () => {
  // `noindex, follow` is the deliberate choice over `noindex, nofollow`: these
  // pages remain linked from the homepage sidebar, and follow is what lets a
  // crawler keep walking out of them instead of dead-ending.
  for (const { file } of APP_PAGES) {
    assert.equal(allRobotsValues(readPage(file))[0], NOINDEX, `public/${file}`);
  }

  assert.match(NOINDEX, /follow/, "follow must be present so links out of the page stay crawlable");
  assert.equal(/noindex,\s*follow/i.test(NOINDEX), true);
});