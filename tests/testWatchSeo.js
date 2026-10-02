// =============================================================================
// MyTube — watch-page SSR tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// /watch is the one page whose SEO head has to be right in the initial bytes.
// These tests drive worker.js's real `fetch()` handler with a fake ASSETS
// binding that serves the actual public/watch.html, plus the real SQLite D1
// double and a fake YouTube, and assert on the HTML that leaves the Worker.
//
// What is proven here:
//   * a valid /watch?id=yt:... answers 200 with the video-specific canonical,
//     og:url, title, description and og:image in the FIRST response
//   * that canonical is byte-identical to the sitemap entry and to what watch.js
//     computes client-side
//   * an unknown id is answered noindex with no fabricated metadata
//   * a transient lookup failure is NOT treated as proof of absence
//   * D1 supplies the metadata with zero upstream YouTube calls
//   * /watch.html?id=... 301s onto /watch?id=... without looping
//   * the application shell is otherwise untouched, and /api/* is unaffected
//
// Run: node --test tests/testWatchSeo.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { normalizeWatchId, setVideoCanonical } from "../worker.js";
import { watchUrl } from "../scripts/generate-sitemap.mjs";
import { upsertVideos } from "../shared/index-store.js";
import { normalizeVideoItem } from "../shared/normalize.js";
import { createFakeD1 } from "./helpers/fake-d1.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const ORIGIN = "https://mytube.farqas007.workers.dev";

// The real shell. Every assertion is about this exact file, so the tests cannot
// pass against a fixture that drifted from what is deployed.
const SHELL = readFileSync(path.join(REPO_ROOT, "public", "watch.html"), "utf8");

const TITLE = "Building a Cloudflare Worker from scratch";
const DESCRIPTION = "A full walkthrough of building, testing and shipping a Cloudflare Worker with D1 and the Workers Assets binding.";

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let ipCounter = 0;
let idSeq = 0;

// A fresh client IP per call keeps the module-level rate limiters out of the way,
// and the IP rotates through subnets so no bucket can be exhausted.
function nextIp() {
  ipCounter += 1;

  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.1`;
}

// Every test gets its own 11-character source id. worker.js caches YouTube
// responses by request URL, so two tests sharing an id would be served the first
// test's payload out of that cache and the second assertion would prove nothing.
function nextSourceId() {
  idSeq += 1;

  return ("v" + String(idSeq).padStart(4, "0") + "abcdefghij").slice(0, 11);
}

// The static binding, reduced to what the Worker actually asks it for. It serves
// the real watch.html so the head-rewriting is exercised against shipped markup.
function createFakeAssets(options = {}) {
  const requested = [];
  const shell = options.html ?? SHELL;

  return {
    requested,
    async fetch(request) {
      const url = new URL(request.url);

      requested.push(url.pathname);

      if (url.pathname !== "/watch.html" && url.pathname !== "/watch") {
        return new Response("not found", { status: 404 });
      }

      return new Response(shell, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ETag: '"shell-etag"',
          "Content-Length": String(shell.length)
        }
      });
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

// `responder(url)` returns the JSON body for one upstream YouTube call.
async function withYouTube(responder, run) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    calls.push(parsed);

    return new Response(JSON.stringify((await responder(parsed)) ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// A YouTube Data API `videos.list` item, shaped like the real payload.
function videoItem(videoId, overrides = {}) {
  const base = {
    id: videoId,
    snippet: {
      title: TITLE,
      description: DESCRIPTION,
      channelId: "UC1234567890",
      channelTitle: "MyTube Dev",
      publishedAt: "2026-01-15T10:00:00Z",
      tags: ["cloudflare", "workers"],
      thumbnails: {
        medium: { url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` }
      }
    },
    contentDetails: { duration: "PT10M2S" },
    statistics: { viewCount: "123456", likeCount: "4321", commentCount: "12" },
    status: { embeddable: true, madeForKids: false, privacyStatus: "public" }
  };

  return { ...base, ...overrides, snippet: { ...base.snippet, ...(overrides.snippet || {}) } };
}

// An empty `videos.list` response is how YouTube answers a removed or
// never-existing id — a 200 with no items, not an error.
function videosResponse(items) {
  return {
    items,
    pageInfo: { totalResults: items.length, resultsPerPage: items.length }
  };
}

function videoResponder(videoId, item) {
  return parsed => {
    if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("id") === videoId) {
      return videosResponse([item]);
    }

    return {};
  };
}

function countVideoLookups(calls, videoId) {
  return calls.filter(
    parsed => parsed.pathname.endsWith("/videos") && parsed.searchParams.get("id") === videoId
  ).length;
}

function envWith(db, assets) {
  const env = { YOUTUBE_API_KEY: "test-key", ASSETS: assets };

  if (db !== undefined) {
    env.mytube_index = db;
  }

  return env;
}

async function callWorker(pathname, env, ctx, init = {}) {
  const request = new Request(`${ORIGIN}${pathname}`, {
    method: init.method || "GET",
    headers: { "CF-Connecting-IP": init.ip || nextIp(), Origin: ORIGIN }
  });

  const response = await worker.fetch(request, env, ctx);

  return { response, html: await response.text() };
}

// Read one meta tag's content out of an HTML string.
function metaContent(html, selector) {
  const attr = selector.startsWith("meta[property") ? "property" : "name";
  const value = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"'));
  const pattern = new RegExp(`<meta\\b[^>]*\\b${attr}="${value}"[^>]*\\bcontent="([^"]*)"`, "i");
  const match = html.match(pattern);

  return match ? match[1] : null;
}

function canonicalHref(html) {
  const match = html.match(/<link\b[^>]*\bid="pageCanonical"[^>]*\bhref="([^"]*)"/i);

  return match ? match[1] : null;
}

function titleText(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);

  return match ? match[1] : null;
}

// The shell's own generic values. Asserting they are untouched is how "no
// fabricated metadata" is proven.
const SHELL_CANONICAL = `${ORIGIN}/watch`;
const SHELL_TITLE = "Watch - MyTube";
const SHELL_DESCRIPTION = "Watch videos on MyTube";
const SHELL_IMAGE = `${ORIGIN}/mytube-icon.png`;

const INDEXABLE = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
const NOINDEX = "noindex, follow";

// ---------------------------------------------------------------------------
// A) Id normalization matches the client
// ---------------------------------------------------------------------------

test("A1 the server canonicalizes ?id= the same way watch.js does", () => {
  const bare = nextSourceId();
  const namespaced = "yt:" + bare;

  // Already canonical: untouched.
  assert.equal(normalizeWatchId(namespaced), namespaced);
  // Bare-id shorthand, the same promotion watch.js performs.
  assert.equal(normalizeWatchId(bare), namespaced);
  assert.equal(normalizeWatchId("  " + bare + "  "), namespaced);
  // Nothing to work with.
  assert.equal(normalizeWatchId(null), "");
  assert.equal(normalizeWatchId(""), "");
  assert.equal(normalizeWatchId("   "), "");
  // Not a video id: left exactly as it arrived, and therefore never rendered
  // server-side.
  assert.equal(normalizeWatchId("vimeo:12345"), "vimeo:12345");
  assert.equal(normalizeWatchId("too-short"), "too-short");
  assert.equal(normalizeWatchId("has spaces in it"), "has spaces in it");
});

test("A2 the canonical is byte-identical to the sitemap URL", () => {
  const videoId = "yt:" + nextSourceId();

  assert.equal(setVideoCanonical(videoId), `${ORIGIN}/watch?id=${encodeURIComponent(videoId)}`);
  assert.equal(setVideoCanonical(videoId), watchUrl(videoId));
  assert.equal(
    setVideoCanonical(normalizeWatchId(videoId.slice(3))),
    watchUrl(videoId),
    "a bare ?id= must canonicalize to the same URL the sitemap lists"
  );
});

// ---------------------------------------------------------------------------
// B) A valid page: metadata is in the first response
// ---------------------------------------------------------------------------

test("B1 /watch?id=yt:... answers 200 with the video-specific canonical", async () => {
  const sourceId = nextSourceId();
  const videoId = `yt:${sourceId}`;

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(videoId)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(metaContent(html, 'meta[property="og:url"]'), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
  });
});

test("B2 the first response carries title, description and og:image", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(titleText(html), `${TITLE} - MyTube`);
    assert.equal(metaContent(html, 'meta[property="og:title"]'), `${TITLE} - MyTube`);
    assert.equal(metaContent(html, 'meta[property="og:description"]'), DESCRIPTION);
    assert.equal(metaContent(html, 'meta[name="description"]'), DESCRIPTION);
    assert.equal(
      metaContent(html, 'meta[property="og:image"]'),
      `https://i.ytimg.com/vi/${sourceId}/hq.jpg`
    );
    // The shell's "MyTube" alt would misdescribe a video thumbnail.
    assert.equal(metaContent(html, 'meta[property="og:image:alt"]'), TITLE);
    // A real video is indexable.
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
  });
});

test("B3 metadata comes from real data and nothing is invented", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    // Every SEO value must be either real data or a shell value, never a
    // placeholder, "undefined", "null" or a doubled template.
    for (const value of [
      titleText(html),
      canonicalHref(html),
      metaContent(html, 'meta[name="description"]'),
      metaContent(html, 'meta[property="og:title"]'),
      metaContent(html, 'meta[property="og:description"]'),
      metaContent(html, 'meta[property="og:image"]'),
      metaContent(html, 'meta[property="og:url"]')
    ]) {
      assert.ok(value, "every SEO tag must have a value");
      assert.ok(!/undefined|null|NaN|\[object/.test(value), "no placeholder leaked: " + value);
    }
  });
});

test("B4 exactly one canonical and one title survive the rewrite", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal((html.match(/<title>/gi) || []).length, 1);
    assert.equal((html.match(/<link\b[^>]*\brel="canonical"/gi) || []).length, 1);
    assert.equal((html.match(/<meta\b[^>]*name="robots"/gi) || []).length, 1);
    // No second canonical is appended the way a client-side rewrite could.
    assert.equal((html.match(/pageCanonical/g) || []).length, 1);
  });
});

test("B5 the application shell is otherwise served untouched", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    // Every script tag, stylesheet and element id the page needs is intact.
    for (const needle of [
      'src="watch.js"',
      'src="auth.js"',
      'src="voice-search.js"',
      'href="player.css?v=4"',
      'id="videoTitle"',
      'id="relatedList"'
    ]) {
      assert.ok(html.includes(needle), "the shell must keep " + needle);
    }

    // Only <head> values changed: the body is byte-identical to the file on disk.
    assert.equal(
      html.slice(html.indexOf("<body")),
      SHELL.slice(SHELL.indexOf("<body"))
    );
  });
});

test("B6 the shell is fetched by its real asset path, not /watch", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const assets = createFakeAssets();

    await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, assets),
      createFakeCtx()
    );

    assert.deepEqual(assets.requested, ["/watch.html"]);
  });
});

test("B7 a cold HEAD performs at most one upstream lookup", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async calls => {
    const { response } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx(),
      { method: "HEAD" }
    );

    assert.ok(response.status === 200 || response.status === 304);
    // HEAD is not special-cased: it resolves metadata exactly like a GET does, so
    // a cold HEAD costs one upstream lookup. The bound that matters is that it
    // cannot fan out into more than one, so a crawler revalidating headers
    // cannot drain the budget by retrying. (In production the CDN answers a
    // repeat HEAD for an already-cached URL, and the dedicated per-IP bucket
    // caps the cold ones.)
    assert.equal(
      calls.length,
      1,
      "a cold HEAD must resolve metadata exactly once, saw " + calls.length
    );
  });
});

test("B8 a title containing HTML is escaped, not injected", async () => {
  const sourceId = nextSourceId();
  const nasty = `</title><script>alert(1)</script> & "quotes"`;
  const item = videoItem(sourceId, {
    snippet: { title: nasty, description: `desc & <b>bold</b> "${nasty}"` }
  });

  await withYouTube(videoResponder(sourceId, item), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.ok(!html.includes("<script>alert(1)</script>"), "no injected script tag");
    // The shell's own scripts are of course still there; only the payload's
    // title must not have produced a tag.
    assert.equal((html.match(/<title>/gi) || []).length, 1);
    assert.equal((html.match(/<\/title>/gi) || []).length, 1);
    assert.equal(
      titleText(html),
      nasty
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;") + " - MyTube"
    );
    assert.ok(!metaContent(html, 'meta[property="og:description"]').includes("<b>"));
  });
});

test("B9 a $& in metadata is written literally, not as a backreference", async () => {
  const sourceId = nextSourceId();
  const item = videoItem(sourceId, {
    snippet: { title: "Costs $1 & $& per month" }
  });

  await withYouTube(videoResponder(sourceId, item), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(titleText(html), "Costs $1 &amp; $&amp; per month - MyTube");
  });
});

test("B10 a long description is capped at the same 160 chars watch.js uses", async () => {
  const sourceId = nextSourceId();
  const item = videoItem(sourceId, {
    snippet: { description: "x".repeat(400) }
  });

  await withYouTube(videoResponder(sourceId, item), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(metaContent(html, 'meta[property="og:description"]').length, 160);
    assert.equal(metaContent(html, 'meta[name="description"]').length, 160);
  });
});

test("B11 a video with no thumbnail keeps the shell's own og:image", async () => {
  const sourceId = nextSourceId();
  const item = videoItem(sourceId, { snippet: { thumbnails: {} } });

  await withYouTube(videoResponder(sourceId, item), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    // An empty og:image is worse than the site icon, so the shell value stands.
    assert.equal(metaContent(html, 'meta[property="og:image"]'), SHELL_IMAGE);
    // The rest of the head is still real.
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(titleText(html), `${TITLE} - MyTube`);
  });
});

test("B12 a non-http thumbnail is refused rather than written", async () => {
  const sourceId = nextSourceId();
  const item = videoItem(sourceId, {
    snippet: { thumbnails: { medium: { url: "javascript:alert(1)" } } }
  });

  await withYouTube(videoResponder(sourceId, item), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(metaContent(html, 'meta[property="og:image"]'), SHELL_IMAGE);
    assert.ok(!html.includes("javascript:alert(1)"));
  });
});

test("B13 two videos rendered through one worker never share metadata", async () => {
  // The single most important property of a per-video SSR head: video B's
  // response must contain nothing from video A. Both requests go through the
  // SAME worker module instance, the SAME env and the SAME ctx, and — so the
  // per-IP rate-limit bucket is shared too — the same client IP. Any state the
  // handler leaked between renders (a cached fragment, a reused string, a stale
  // variable) would surface as A's metadata appearing on B's page.
  const sourceA = nextSourceId();
  const sourceB = nextSourceId();
  const titleA = "AAA-marker-title-first-video";
  const titleB = "BBB-marker-title-second-video";
  const descA = "AAA-marker-description-first-video";
  const descB = "BBB-marker-description-second-video";
  const itemA = videoItem(sourceA, { snippet: { title: titleA, description: descA } });
  const itemB = videoItem(sourceB, { snippet: { title: titleB, description: descB } });

  await withYouTube(
    parsed => {
      const id = parsed.searchParams.get("id");

      if (id === sourceA) {
        return videosResponse([itemA]);
      }

      if (id === sourceB) {
        return videosResponse([itemB]);
      }

      return {};
    },
    async () => {
      const env = envWith(undefined, createFakeAssets());
      const ctx = createFakeCtx();
      const ip = "203.0.113.7";

      const first = await callWorker(
        `/watch?id=${encodeURIComponent(`yt:${sourceA}`)}`,
        env,
        ctx,
        { ip }
      );
      const second = await callWorker(
        `/watch?id=${encodeURIComponent(`yt:${sourceB}`)}`,
        env,
        ctx,
        { ip }
      );

      // A is correct in isolation.
      assert.equal(first.response.status, 200);
      assert.equal(canonicalHref(first.html), `${ORIGIN}/watch?id=yt%3A${sourceA}`);
      assert.equal(titleText(first.html), `${titleA} - MyTube`);
      assert.equal(metaContent(first.html, 'meta[property="og:description"]'), descA);
      assert.equal(
        metaContent(first.html, 'meta[property="og:image"]'),
        `https://i.ytimg.com/vi/${sourceA}/hq.jpg`
      );

      // B is correct in isolation...
      assert.equal(second.response.status, 200);
      assert.equal(canonicalHref(second.html), `${ORIGIN}/watch?id=yt%3A${sourceB}`);
      assert.equal(metaContent(second.html, 'meta[property="og:url"]'), `${ORIGIN}/watch?id=yt%3A${sourceB}`);
      assert.equal(titleText(second.html), `${titleB} - MyTube`);
      assert.equal(metaContent(second.html, 'meta[property="og:title"]'), `${titleB} - MyTube`);
      assert.equal(metaContent(second.html, 'meta[property="og:description"]'), descB);
      assert.equal(
        metaContent(second.html, 'meta[property="og:image"]'),
        `https://i.ytimg.com/vi/${sourceB}/hq.jpg`
      );

      // ...and carries no trace of A anywhere in the document.
      for (const marker of [titleA, descA, sourceA]) {
        assert.ok(
          !second.html.includes(marker),
          "video B's HTML leaked " + marker + " from video A"
        );
      }

      // The two documents really are distinct bytes, not one shared render.
      assert.notEqual(second.html, first.html);

      // And the canonical never points at the sibling video in either direction.
      assert.ok(!canonicalHref(first.html).includes(sourceB));
      assert.ok(!canonicalHref(second.html).includes(sourceA));
    }
  );
});

// ---------------------------------------------------------------------------
// C) D1 index supplies the metadata
// ---------------------------------------------------------------------------

test("C1 a fresh D1 row answers the head with zero upstream calls", async () => {
  const db = createFakeD1();
  const sourceId = nextSourceId();

  await upsertVideos(db, [videoItem(sourceId)]);

  await withYouTube(() => assert.fail("YouTube must not be called on an index hit"), async calls => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(db, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 0, "an index hit must spend no quota");
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(titleText(html), `${TITLE} - MyTube`);
    assert.equal(metaContent(html, 'meta[property="og:description"]'), DESCRIPTION);
    assert.equal(
      metaContent(html, 'meta[property="og:image"]'),
      `https://i.ytimg.com/vi/${sourceId}/hq.jpg`
    );
  });

  db.close();
});

test("C2 the SSR head is exactly what the API would have returned", async () => {
  const db = createFakeD1();
  const sourceId = nextSourceId();

  await upsertVideos(db, [videoItem(sourceId)]);

  await withYouTube(() => ({}), async () => {
    const assets = createFakeAssets();
    // /api/video takes the bare source id; /watch takes the `yt:`-prefixed form.
    const api = await callWorker(
      `/api/video?id=${sourceId}`,
      envWith(db, assets),
      createFakeCtx()
    );
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(db, assets),
      createFakeCtx()
    );

    const video = JSON.parse(api.html).video;

    assert.ok(video, "/api/video must answer from the same row");
    assert.equal(titleText(html), `${video.title} - MyTube`);
    assert.equal(metaContent(html, 'meta[property="og:image"]'), video.thumb);
    assert.equal(
      metaContent(html, 'meta[property="og:description"]'),
      video.description.slice(0, 160)
    );
  });

  db.close();
});

test("C3 an index miss falls back to YouTube and writes the row behind", async () => {
  const db = createFakeD1();
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async calls => {
    const ctx = createFakeCtx();
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(db, createFakeAssets()),
      ctx
    );

    assert.equal(countVideoLookups(calls, sourceId), 1);
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(titleText(html), `${TITLE} - MyTube`);

    // Write-behind, so the browser's own /api/video call afterwards is free.
    await Promise.all(ctx.pending);
  });

  await withYouTube(() => assert.fail("the SSR render must have warmed the index"), async calls => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(db, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(calls.length, 0);
    assert.equal(titleText(html), `${TITLE} - MyTube`);
  });

  db.close();
});

// ---------------------------------------------------------------------------
// D) Invalid, unknown and unavailable ids
// ---------------------------------------------------------------------------

test("D1 a missing id is answered noindex with no fabricated metadata", async () => {
  await withYouTube(() => assert.fail("no id means no lookup"), async calls => {
    const { response, html } = await callWorker(
      "/watch",
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
    assert.equal(metaContent(html, 'meta[name="robots"]'), NOINDEX);
    // Nothing invented: the shell's own values stand.
    assert.equal(titleText(html), SHELL_TITLE);
    assert.equal(canonicalHref(html), SHELL_CANONICAL);
    assert.equal(metaContent(html, 'meta[name="description"]'), SHELL_DESCRIPTION);
    assert.equal(metaContent(html, 'meta[property="og:image"]'), SHELL_IMAGE);
  });
});

test("D2 a malformed id is answered noindex without an upstream call", async () => {
  // None of these can be a YouTube video id, so the Worker must not spend a
  // request proving a string is junk.
  const malformed = ["vimeo:12345", "yt:", "yt:short", "yt:waytoolongtobevalid", "too-short", "has spaces in it", "yt:not a video"];

  for (const id of malformed) {
    await withYouTube(() => assert.fail("junk must not cost a lookup: " + id), async calls => {
      const { response, html } = await callWorker(
        `/watch?id=${encodeURIComponent(id)}`,
        envWith(undefined, createFakeAssets()),
        createFakeCtx()
      );

      assert.equal(response.status, 200);
      assert.equal(calls.length, 0, "no upstream call for " + id);
      assert.equal(metaContent(html, 'meta[name="robots"]'), NOINDEX, "for " + id);
      assert.equal(titleText(html), SHELL_TITLE, "for " + id);
      assert.equal(canonicalHref(html), SHELL_CANONICAL, "for " + id);
    });
  }
});

test("D3 a well-formed but unknown id is noindex, matching the client's verdict", async () => {
  const sourceId = nextSourceId();

  // An empty `items` list is YouTube's answer for a removed/nonexistent video —
  // the same condition /api/video reports as 404.
  await withYouTube(() => videosResponse([]), async () => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(metaContent(html, 'meta[name="robots"]'), NOINDEX);
    // Still nothing invented.
    assert.equal(titleText(html), SHELL_TITLE);
    assert.equal(canonicalHref(html), SHELL_CANONICAL);
    assert.equal(metaContent(html, 'meta[name="description"]'), SHELL_DESCRIPTION);
  });
});

test("D4 a transient upstream failure is NOT treated as proof of absence", async () => {
  const sourceId = nextSourceId();
  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    assert.ok(new URL(url).pathname.endsWith("/videos"));

    // A 200 whose body is not JSON: an HTML error page or a WAF interception.
    return new Response("<html><body>upstream is down</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
  };

  try {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    // A dead upstream says nothing about whether the video exists, so the page
    // must not be marked noindex — the client re-decides once it can reach /api.
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    assert.equal(titleText(html), SHELL_TITLE);
    assert.equal(canonicalHref(html), SHELL_CANONICAL);
  } finally {
    globalThis.fetch = original;
  }
});

test("D5 a dead D1 degrades to YouTube instead of failing the page", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async calls => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith({ notADatabase: true }, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(countVideoLookups(calls, sourceId), 1);
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(titleText(html), `${TITLE} - MyTube`);
  });
});

test("D6 no D1 binding and no API key still serves the shell", async () => {
  const sourceId = nextSourceId();

  await withYouTube(() => assert.fail("an empty key must not reach YouTube"), async calls => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      { YOUTUBE_API_KEY: "", ASSETS: createFakeAssets() },
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    assert.equal(titleText(html), SHELL_TITLE);
  });
});

test("D7 the API key never reaches the rendered HTML", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      { YOUTUBE_API_KEY: "super-secret-key", ASSETS: createFakeAssets() },
      createFakeCtx()
    );

    assert.ok(!html.includes("super-secret-key"));
    assert.ok(!html.includes("youtubeapis.com"));
    assert.ok(!html.includes("key="));
  });
});

// ---------------------------------------------------------------------------
// E) The /watch.html duplicate
// ---------------------------------------------------------------------------

test("E1 /watch.html?id=... 301s onto the canonical /watch URL", async () => {
  const videoId = `yt:${nextSourceId()}`;

  const { response } = await callWorker(
    `/watch.html?id=${encodeURIComponent(videoId)}`,
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  assert.equal(response.status, 301);
  assert.equal(
    new URL(response.headers.get("Location"), ORIGIN).href,
    `${ORIGIN}/watch?id=${encodeURIComponent(videoId)}`
  );
});

test("E2 the redirect re-serializes the id in the canonical encoding", async () => {
  const sourceId = nextSourceId();

  // A raw colon in the request must come back percent-encoded, so the redirect
  // target is the canonical string and not merely an equivalent URL.
  const { response } = await callWorker(
    `/watch.html?id=yt:${sourceId}`,
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  const location = new URL(response.headers.get("Location"), ORIGIN);

  assert.equal(location.pathname, "/watch");
  assert.equal(location.search, `?id=yt%3A${sourceId}`);
  // The redirect target is the canonical string, not merely an equivalent URL.
  assert.ok(!response.headers.get("Location").includes("yt:"));
});

test("E3 a bare id in the redirect is promoted to the yt: form", async () => {
  const sourceId = nextSourceId();

  const { response } = await callWorker(
    `/watch.html?id=${sourceId}`,
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  assert.equal(
    new URL(response.headers.get("Location"), ORIGIN).href,
    `${ORIGIN}/watch?id=yt%3A${sourceId}`
  );
});

test("E4 other query parameters survive the redirect", async () => {
  const sourceId = nextSourceId();

  const { response } = await callWorker(
    `/watch.html?id=yt%3A${sourceId}&t=30&list=abc`,
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  const location = new URL(response.headers.get("Location"), ORIGIN);

  assert.equal(location.pathname, "/watch");
  assert.equal(location.searchParams.get("id"), `yt:${sourceId}`);
  assert.equal(location.searchParams.get("t"), "30");
  assert.equal(location.searchParams.get("list"), "abc");
});

test("E5 /watch.html with no id still redirects onto /watch", async () => {
  const { response } = await callWorker(
    "/watch.html",
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get("Location"), "/watch");
});

test("E6 the redirect cannot loop: /watch only ever answers 200", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    // /watch is never a redirect, so following Location from /watch.html always
    // terminates.
    assert.equal(response.status, 200);
  });
});

test("E7 following the redirect lands on the exact canonical in the sitemap", async () => {
  const videoId = `yt:${nextSourceId()}`;

  const { response } = await callWorker(
    `/watch.html?id=${encodeURIComponent(videoId)}`,
    envWith(undefined, createFakeAssets()),
    createFakeCtx()
  );

  assert.equal(
    new URL(response.headers.get("Location"), ORIGIN).href,
    watchUrl(videoId)
  );
});

// ---------------------------------------------------------------------------
// F) Nothing else moved
// ---------------------------------------------------------------------------

test("F1 a non-watch asset still goes straight to the binding", async () => {
  const assets = createFakeAssets();
  const { response } = await callWorker("/style.css", envWith(undefined, assets), createFakeCtx());

  assert.deepEqual(assets.requested, ["/style.css"]);
  assert.equal(response.status, 404);
});

test("F2 /api/* keeps its response contract", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response, html } = await callWorker(
      `/api/video?id=${sourceId}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );
    const body = JSON.parse(html);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ["video"]);
    assert.deepEqual(body, { video: normalizeVideoItem(videoItem(sourceId)) });
  });
});

test("F3 the watch response advertises a revalidating edge cache", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.match(response.headers.get("Cache-Control") || "", /s-maxage=\d+/);
    // The bytes no longer match the asset that was read, so its validators must
    // not be forwarded.
    assert.equal(response.headers.get("ETag"), null);
    assert.equal(response.headers.get("Content-Length"), null);
  });
});

test("F4 a missing shell asset is passed through untouched", async () => {
  const sourceId = nextSourceId();
  const assets = createFakeAssets();
  const original = assets.fetch;

  assets.fetch = async request => {
    if (new URL(request.url).pathname === "/watch.html") {
      return new Response("gone", { status: 404 });
    }

    return original(request);
  };

  const { response } = await callWorker(
    `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
    envWith(undefined, assets),
    createFakeCtx()
  );

  assert.equal(response.status, 404);
});

test("F5 a non-GET/HEAD /watch is handed to the binding", async () => {
  const sourceId = nextSourceId();
  const assets = createFakeAssets();
  const request = new Request(`${ORIGIN}/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": nextIp() }
  });

  const response = await worker.fetch(request, envWith(undefined, assets), createFakeCtx());

  assert.deepEqual(assets.requested, ["/watch"]);
  assert.equal(response.status, 200);
});

test("F6 the watch HTML deliberately keeps the asset header surface", async () => {
  // The watch page is served by the ASSETS binding and has never gone through
  // withSecurityHeaders(), so it carries none of that header set. That is
  // intentional and must stay pinned: putting a CSP on /watch for the first
  // time would newly restrict the Firebase module graph the page loads
  // (watch.js -> firebase.js), which is a security-posture change, not a
  // rendering one.
  //
  // tests/testWorkerIndex.js asserts the opposite for /api/*, so the two suites
  // together pin which endpoints get the hardening and which deliberately do
  // not. This test documents the exemption so a future refactor that routes
  // /watch through withSecurityHeaders() fails here instead of silently
  // breaking the module graph in production.
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Security-Policy"), null);
    assert.equal(response.headers.get("X-Frame-Options"), null);
  });
});

test("F7 a degraded watch render is no-store but stays indexable", async () => {
  // A degraded render is uncacheable: letting the CDN store the generic shell
  // would pin every watch URL to one generic page for the whole s-maxage window,
  // long after the upstream recovered.
  //
  // `noindex` is deliberately NOT the remedy: a transient failure is not evidence
  // that the video is gone, and the client reaches the correct verdict on
  // hydration. So both halves are asserted together -- uncacheable, yet still
  // indexable. D4 pins the same robots outcome for the no-API-key variant; this
  // pins the cacheability that the degraded branch used to get wrong.
  //
  // The two halves end at DIFFERENT canonicals, and that difference is the
  // point. (a) could not find out anything about the video, so it keeps the
  // shell's generic `/watch` canonical. (b) knows exactly which video the URL
  // is, so it canonicalizes to that video. Both stay indexable. See R2.
  const transientId = nextSourceId();

  // (a) the lookup could not complete at all.
  await withYouTube(() => {
    throw new Error("simulated upstream outage");
  }, async () => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${transientId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    // Still the shell, with no metadata fabricated for the video.
    assert.equal(canonicalHref(html), SHELL_CANONICAL);
    assert.equal(titleText(html), SHELL_TITLE);
  });

  // (b) the per-IP budget is exhausted. Upstream is healthy throughout here, so
  // the FIRST response is an ordinary edge-cacheable render -- that is what
  // proves the later `no-store` came from the rate limiter rather than from a
  // failing lookup, and keeps this half from passing vacuously.
  const rateId = nextSourceId();
  const budget = 60; // WATCH_SEO_RATE_MAX_PER_WINDOW in worker.js

  await withYouTube(videoResponder(rateId, videoItem(rateId)), async () => {
    const env = envWith(undefined, createFakeAssets());
    const ctx = createFakeCtx();
    const ip = nextIp();
    let first;
    let last;

    for (let i = 0; i < budget + 5; i += 1) {
      const result = await callWorker(
        `/watch?id=${encodeURIComponent(`yt:${rateId}`)}`,
        env,
        ctx,
        { ip }
      );

      if (i === 0) {
        first = result;
      }

      last = result;
    }

    // Control: under the budget the success path is unchanged and cacheable.
    assert.match(
      first.response.headers.get("Cache-Control") || "",
      /s-maxage=\d+/,
      "the first request must still be an edge-cacheable render"
    );

    // Over the budget the shell is served uncacheable, and still indexable.
    // The canonical is now this video's OWN url rather than the generic
    // `/watch`: the `?id=` has already proved a real video exists, so pointing
    // at the noindex `/watch` (which half (a), having learned nothing, still
    // correctly does) would hand a crawler an indexable url canonicalized to an
    // unindexable one. The title stays generic either way. See R2 and R5.
    assert.equal(last.response.status, 200);
    assert.equal(last.response.headers.get("Cache-Control"), "no-store");
    assert.equal(metaContent(last.html, 'meta[name="robots"]'), INDEXABLE);
    assert.equal(canonicalHref(last.html), `${ORIGIN}/watch?id=yt%3A${rateId}`);
    assert.equal(titleText(last.html), SHELL_TITLE);
  });
});

// ---------------------------------------------------------------------------
// R) A rate-limited render is still the right page for that video
// ---------------------------------------------------------------------------
// The over-budget branch used to hand back the generic shell untouched. That
// shell is indexable, and its canonical carries no `?id=` at all -- so every
// valid watch URL fetched past the budget was served as "an indexable page,
// canonical = /watch", while `/watch` itself answers `noindex, follow`. A
// crawler walking the 50-URL sitemap faster than the budget therefore received a
// self-contradictory head for every video past request 60 of each 5-minute
// window: told to index the URL, then told the URL it should index is not
// indexable.
//
// The fix corrects the URL identity and nothing else. These tests pin that it
// corrects exactly that: robots stays indexable, the generic metadata stays
// generic, every noindex verdict stays noindex, the healthy path is untouched,
// the `unavailable` path is untouched, and two rate-limited videos can never
// borrow each other's id.
// ---------------------------------------------------------------------------

const WATCH_SEO_RATE_MAX_PER_WINDOW = 60; // WATCH_SEO_RATE_MAX_PER_WINDOW in worker.js

// Drive one video past the per-IP SSR budget and return the last response.
//
// Every request comes from one IP, exactly as one crawler would, and the
// upstream responder stays healthy for the whole loop -- so the final response
// can only have been degraded by the budget, never by a failing lookup. The
// extra requests past the budget guarantee the bucket is spent regardless of how
// many the healthy path consumed.
async function overBudgetWatchResponse(videoId, options = {}) {
  const ip = options.ip ?? nextIp();
  const env = options.env ?? envWith(undefined, createFakeAssets());
  const ctx = options.ctx ?? createFakeCtx();
  let result;

  for (let i = 0; i < WATCH_SEO_RATE_MAX_PER_WINDOW + 5; i += 1) {
    result = await callWorker(`/watch?id=${encodeURIComponent(videoId)}`, env, ctx, { ip });
  }

  return { ...result, ip, env, ctx };
}

test("R1 a rate-limited valid video stays indexable", async () => {
  // The one outcome that must never regress: a valid video must not be noindexed
  // because the site ran out of its own render budget. That would be a
  // self-inflicted deindexing of a perfectly good page.
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response, html } = await overBudgetWatchResponse(`yt:${sourceId}`);

    assert.equal(response.status, 200);
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    assert.notEqual(metaContent(html, 'meta[name="robots"]'), NOINDEX);
  });
});

test("R2 a rate-limited valid video canonicalizes to its own exact URL", async () => {
  const sourceId = nextSourceId();
  const videoId = `yt:${sourceId}`;
  const expected = `${ORIGIN}/watch?id=yt%3A${sourceId}`;

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await overBudgetWatchResponse(videoId);

    assert.equal(canonicalHref(html), expected);
    assert.notEqual(
      canonicalHref(html),
      SHELL_CANONICAL,
      "the generic /watch canonical is noindex; a video url must never point at it"
    );
    // The one canonical form of a watch url, built the same way as everywhere else.
    assert.equal(canonicalHref(html), setVideoCanonical(videoId));
    assert.equal(canonicalHref(html), watchUrl(videoId));
  });
});

test("R3 a rate-limited valid video reports the same URL as og:url", async () => {
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await overBudgetWatchResponse(`yt:${sourceId}`);

    assert.equal(metaContent(html, 'meta[property="og:url"]'), canonicalHref(html));
  });
});

test("R4 a rate-limited render is still uncacheable", async () => {
  // The body is now rewritten (canonical + og:url), so the asset's ETag and
  // Content-Length no longer describe it -- which is also why the branch must
  // stay no-store rather than inheriting the revalidating SSR cache policy.
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response } = await overBudgetWatchResponse(`yt:${sourceId}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("ETag"), null);
    assert.equal(response.headers.get("Content-Length"), null);
  });
});

test("R5 a rate-limited render keeps the generic metadata and fabricates nothing", async () => {
  // The upstream responder in this test is healthy and would happily hand over
  // the real title, description and thumbnail. Not one of them may be used: we
  // chose not to spend the lookup, so the head must stay generic rather than
  // half-invented. The client supplies the real metadata on hydration.
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { html } = await overBudgetWatchResponse(`yt:${sourceId}`);

    assert.equal(titleText(html), SHELL_TITLE);
    assert.equal(metaContent(html, 'meta[name="description"]'), SHELL_DESCRIPTION);
    assert.equal(metaContent(html, 'meta[property="og:title"]'), SHELL_TITLE);
    assert.equal(metaContent(html, 'meta[property="og:description"]'), SHELL_DESCRIPTION);
    assert.equal(metaContent(html, 'meta[property="og:image"]'), SHELL_IMAGE);

    // Explicitly: the real values the healthy upstream would have produced are absent.
    assert.notEqual(titleText(html), `${TITLE} - MyTube`);
    assert.equal(html.includes(TITLE), false);
    assert.equal(html.includes(DESCRIPTION), false);
  });
});

test("R6 /watch itself stays noindex, budget spent or not", async () => {
  // The bare URL has no id, so it returns before the rate limiter is ever
  // consulted. Asserted under a spent bucket as well as a fresh IP, because
  // "the bare page is noindex" and "a rate-limited video is indexable" have to
  // hold at the same time for the fix to mean anything.
  const sourceId = nextSourceId();

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const fresh = await callWorker("/watch", envWith(undefined, createFakeAssets()), createFakeCtx());

    assert.equal(fresh.response.status, 200);
    assert.equal(metaContent(fresh.html, 'meta[name="robots"]'), NOINDEX);
    assert.equal(canonicalHref(fresh.html), SHELL_CANONICAL);

    const { ip, env, ctx } = await overBudgetWatchResponse(`yt:${sourceId}`);

    // Same IP, bucket now definitely spent.
    const spent = await callWorker("/watch", env, ctx, { ip });

    assert.equal(spent.response.status, 200);
    assert.equal(metaContent(spent.html, 'meta[name="robots"]'), NOINDEX);
    assert.equal(canonicalHref(spent.html), SHELL_CANONICAL);
  });
});

test("R7 malformed and missing ids stay noindex even under a spent budget", async () => {
  // The rate-limited branch is only reachable for an id that already proved
  // itself a valid YouTube video. Nothing about a spent budget may promote a
  // junk URL into an indexable page.
  const sourceId = nextSourceId();
  const junk = ["", "   ", "garbage", "yt:short", "yt:has spaces", "vimeo:12345", "yt:way-too-long"];

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { ip, env, ctx } = await overBudgetWatchResponse(`yt:${sourceId}`);

    for (const raw of junk) {
      const { response, html } = await callWorker(
        `/watch?id=${encodeURIComponent(raw)}`,
        env,
        ctx,
        { ip }
      );

      assert.equal(response.status, 200, `?id=${raw} must still answer 200`);
      assert.equal(
        metaContent(html, 'meta[name="robots"]'),
        NOINDEX,
        `?id=${raw} must stay noindex once the SSR budget is spent`
      );
      assert.equal(canonicalHref(html), SHELL_CANONICAL, `?id=${raw} canonical`);
    }
  });
});

test("R8 a healthy render is completely unchanged", async () => {
  // The control for every test above: under the budget the full SSR render still
  // happens, with the revalidating edge cache and the real per-video metadata.
  const sourceId = nextSourceId();
  const videoId = `yt:${sourceId}`;

  await withYouTube(videoResponder(sourceId, videoItem(sourceId)), async () => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(videoId)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(canonicalHref(html), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(metaContent(html, 'meta[property="og:url"]'), `${ORIGIN}/watch?id=yt%3A${sourceId}`);
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    assert.equal(titleText(html), `${TITLE} - MyTube`);
    assert.equal(metaContent(html, 'meta[property="og:image"]'), `https://i.ytimg.com/vi/${sourceId}/hq.jpg`);
    assert.match(response.headers.get("Cache-Control") || "", /s-maxage=\d+/);
    assert.equal(response.headers.get("ETag"), null);
  });
});

test("R9 an authoritative unavailable render is unchanged", async () => {
  // `unavailable` is NOT the rate-limited branch and must not be folded into it.
  // A lookup that could not complete says nothing about which video the URL is
  // for, so this branch keeps the shell's generic canonical exactly as before.
  // The rate-limited branch can self-canonicalize precisely because the id was
  // already proven valid; here it was not.
  const sourceId = nextSourceId();

  await withYouTube(() => {
    throw new Error("simulated upstream outage");
  }, async () => {
    const { response, html } = await callWorker(
      `/watch?id=${encodeURIComponent(`yt:${sourceId}`)}`,
      envWith(undefined, createFakeAssets()),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(metaContent(html, 'meta[name="robots"]'), INDEXABLE);
    assert.equal(canonicalHref(html), SHELL_CANONICAL, "unavailable keeps the generic canonical");
    assert.equal(metaContent(html, 'meta[property="og:url"]'), SHELL_CANONICAL);
    assert.equal(titleText(html), SHELL_TITLE);
    // Untouched body means the asset's own validators still describe it.
    assert.equal(response.headers.get("ETag"), '"shell-etag"');
  });
});

test("R10 two rate-limited videos never share or leak metadata", async () => {
  // Both ids are rate limited from one IP, so both renders take the same
  // degraded path. Neither may end up describing the other -- a shared buffer or
  // a stale rewrite would show up here as one id in the other's head.
  const firstId = nextSourceId();
  const secondId = nextSourceId();
  const ip = nextIp();
  const env = envWith(undefined, createFakeAssets());
  const ctx = createFakeCtx();

  await withYouTube(
    parsed => {
      if (parsed.pathname.endsWith("/videos")) {
        const id = parsed.searchParams.get("id");

        return videosResponse([videoItem(id)]);
      }

      return {};
    },
    async () => {
      // Spend the budget on the first video, then alternate.
      for (let i = 0; i < WATCH_SEO_RATE_MAX_PER_WINDOW + 5; i += 1) {
        await callWorker(`/watch?id=${encodeURIComponent(`yt:${firstId}`)}`, env, ctx, { ip });
      }

      const first = await callWorker(
        `/watch?id=${encodeURIComponent(`yt:${firstId}`)}`,
        env,
        ctx,
        { ip }
      );
      const second = await callWorker(
        `/watch?id=${encodeURIComponent(`yt:${secondId}`)}`,
        env,
        ctx,
        { ip }
      );

      assert.equal(canonicalHref(first.html), `${ORIGIN}/watch?id=yt%3A${firstId}`);
      assert.equal(canonicalHref(second.html), `${ORIGIN}/watch?id=yt%3A${secondId}`);
      assert.equal(metaContent(first.html, 'meta[property="og:url"]'), `${ORIGIN}/watch?id=yt%3A${firstId}`);
      assert.equal(metaContent(second.html, 'meta[property="og:url"]'), `${ORIGIN}/watch?id=yt%3A${secondId}`);

      // Neither head may mention the other video, in either direction.
      assert.equal(first.html.includes(secondId), false, "video A's head must not mention video B");
      assert.equal(second.html.includes(firstId), false, "video B's head must not mention video A");

      // Both stay indexable and uncacheable, and both stay generic.
      for (const [label, result] of [["first", first], ["second", second]]) {
        assert.equal(result.response.status, 200, label);
        assert.equal(metaContent(result.html, 'meta[name="robots"]'), INDEXABLE, label);
        assert.equal(result.response.headers.get("Cache-Control"), "no-store", label);
        assert.equal(titleText(result.html), SHELL_TITLE, label);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// G) Worker module export contract
// ---------------------------------------------------------------------------

test("G1 every named export of worker.js is a function", async () => {
  // workerd aborts at load time with "Incorrect type for map entry ... not of
  // type function or ExportedHandler" if a Worker module exports a plain value,
  // which makes `wrangler dev` fail to start before it serves anything. This
  // module once re-exported MAINTENANCE_DELETE_SQL and seven sibling constants
  // and did exactly that, so the rule is asserted rather than remembered.
  const module = await import("../worker.js");

  for (const [name, value] of Object.entries(module)) {
    if (name === "default") {
      // The default export is the handler object, and only its callables are
      // dispatched by the runtime.
      assert.equal(typeof value, "object");
      continue;
    }

    assert.equal(
      typeof value,
      "function",
      `named export "${name}" is a ${typeof value}; workerd cannot load a Worker module that exports a plain value`
    );
  }
});

test("G2 maintenanceConfig is a function returning the policy, not a constant", async () => {
  const { maintenanceConfig } = await import("../worker.js");

  assert.equal(typeof maintenanceConfig, "function");

  const config = maintenanceConfig();

  // A getter, so it reflects the module's constants rather than freezing a copy.
  assert.notEqual(config, maintenanceConfig());
  assert.deepEqual(config, maintenanceConfig());
});
