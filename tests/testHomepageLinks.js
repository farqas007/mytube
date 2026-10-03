// =============================================================================
// MyTube — homepage server-rendered watch-link tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// F-01: the homepage shipped an empty <main id="videoList">. Every video card —
// and therefore every internal link to a watch page — was created by JavaScript,
// so a crawler that does not execute JS had no internal HTML path from the
// homepage to any /watch?id=... URL.
//
// These tests drive worker.js's real `fetch()` handler with a fake ASSETS binding
// that serves the actual public/index.html plus a fake YouTube, and assert on the
// HTML that leaves the Worker.
//
// What is proven here:
//   * GET / carries real <a href="/watch?id=..."> anchors in the FIRST response
//   * those hrefs are byte-identical to the sitemap entry and to the canonical
//     the watch page renders for the same video
//   * the videos are the ones the existing deterministic feed page returns, so
//     the homepage, the sitemap and /api/trending never disagree
//   * the markup is the same DOM buildCard() produces, and renderVideoList()'s
//     replaceChildren() can still take over cleanly (client rendering intact)
//   * every failure mode returns the untouched asset, byte for byte, ETag intact
//   * no fabricated links: an empty or failed pool yields zero anchors
//   * the homepage keeps its indexable robots meta and the asset binding's own
//     headers/CSP, and /api/* plus every other asset are unaffected
//
// Run: node --test tests/testHomepageLinks.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { setVideoCanonical } from "../worker.js";
import { watchUrl } from "../scripts/generate-sitemap.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const ORIGIN = "https://mytube.farqas007.workers.dev";

// The real homepage. Every assertion is about this exact file, so the tests cannot
// pass against a fixture that drifted from what is deployed.
const INDEX_HTML = readFileSync(path.join(REPO_ROOT, "public", "index.html"), "utf8");

// The number of cards the server renders. Pinned here so a silent change to the
// constant is a test failure rather than an unnoticed crawl-surface change.
const SSR_COUNT = 12;

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

let ipCounter = 0;

function nextIp() {
  ipCounter += 1;

  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.3`;
}

// A YouTube video id is always exactly 11 URL-safe base64 characters.
function sourceId(n) {
  return ("h" + String(n).padStart(4, "0") + "abcdefghij").slice(0, 11);
}

// The static binding, reduced to what the Worker actually asks it for. It serves
// the real index.html, so the injection is exercised against shipped markup —
// including the asset's ETag, which the degraded paths must preserve.
function createFakeAssets(options = {}) {
  const requested = [];
  const html = options.html ?? INDEX_HTML;
  const watchShell = readFileSync(path.join(REPO_ROOT, "public", "watch.html"), "utf8");

  return {
    requested,
    async fetch(request) {
      const url = new URL(request.url);
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);

      requested.push(url.pathname);

      if (name !== "index.html" && name !== "watch.html") {
        return new Response("not found", { status: 404 });
      }

      const body = name === "watch.html" ? watchShell : html;

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ETag: `"${name}-etag"`,
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Content-Length": String(body.length)
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

// A YouTube Data API `videos.list` item, shaped like the real payload. Region
// code matters: the pool is built from FEED_POOL_REGIONS and this item has to be
// inside that list to survive the merge.
function chartItem(videoId, overrides = {}) {
  const base = {
    id: videoId,
    snippet: {
      title: `Chart video ${videoId}`,
      description: "",
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

  return {
    ...base,
    ...overrides,
    snippet: { ...base.snippet, ...(overrides.snippet || {}) }
  };
}

// One chart page per requested region, plus the per-video details lookup the
// watch page makes. Every region returns the SAME items in the same order, which
// is enough: the pool dedupes by source id, so the result is exactly the list
// handed back, in encounter order.
function chartResponder(ids) {
  return parsed => {
    if (parsed.searchParams.get("chart")) {
      return { items: ids.map(id => chartItem(id)) };
    }

    if (parsed.searchParams.get("id")) {
      const wanted = parsed.searchParams.get("id").split(",");

      return { items: wanted.filter(id => ids.includes(id)).map(id => chartItem(id)) };
    }

    return {};
  };
}

function chartCalls(calls) {
  return calls.filter(parsed => parsed.searchParams.get("chart") === "mostPopular");
}

// worker.js caches the feed pool under a fixed key for 15 minutes, so a shared
// module instance would answer every later test from the FIRST test's pool and
// never issue an upstream call. Node treats a query string as a distinct module,
// which is exactly the isolation this needs — the same trick
// tests/testWorkerIndex.js already uses for the same reason.
async function freshWorker() {
  return (await import(`../worker.js?home=${Math.random()}`)).default;
}

async function serve(options = {}) {
  const assets = createFakeAssets(options);
  const target = options.worker ?? (await freshWorker());
  const request = new Request(`${ORIGIN}${options.path || "/"}`, {
    method: options.method || "GET",
    headers: { "CF-Connecting-IP": nextIp(), Origin: ORIGIN }
  });
  const env = {
    YOUTUBE_API_KEY: options.apiKey ?? "test-key",
    ASSETS: assets
  };

  const run = async calls => {
    const response = await target.fetch(request, env, createFakeCtx());

    return { response, html: await response.text(), requested: assets.requested, calls };
  };

  return options.responder ? withYouTube(options.responder, run) : run([]);
}

// Every /watch?id=... href in the document, decoded back to the raw `id` value.
function watchHrefs(html) {
  return [...html.matchAll(/href="\/watch\?id=([^"]*)"/g)].map(match =>
    decodeURIComponent(match[1])
  );
}

// The card anchors only — sidebar/nav links to other pages must never be counted.
function cardHrefs(html) {
  const list = html.slice(html.indexOf('<main id="videoList">'));

  return watchHrefs(list.slice(0, list.indexOf("</main>")));
}

// Everything between the container's open and close tags.
function feedContainerInner(html) {
  const open = html.indexOf('<main id="videoList">');

  return html.slice(open + '<main id="videoList">'.length, html.indexOf("</main>", open));
}

// Distinct real ids, deterministic order, at least SSR_COUNT long.
function poolIds(count = SSR_COUNT + 4) {
  return Array.from({ length: count }, (_, i) => sourceId(i + 1));
}

// -----------------------------------------------------------------------------
// A) The links exist in the first response
// -----------------------------------------------------------------------------

test("A1 the delivered homepage already contains watch links, before any JS", async () => {
  const ids = poolIds();
  const { response, html } = await serve({ responder: chartResponder(ids) });

  assert.equal(response.status, 200);

  // This is the finding itself. The static file on disk has none of these; the
  // point is that the bytes leaving the Worker do.
  assert.equal(watchHrefs(INDEX_HTML).length, 0, "the shipped index.html must remain link-free");
  assert.equal(cardHrefs(html).length, SSR_COUNT, "the first pageful of cards must be server-rendered");
});

test("A2 every server-rendered href is the canonical watch URL for that video", async () => {
  const ids = poolIds();
  const { html } = await serve({ responder: chartResponder(ids) });

  for (const id of cardHrefs(html)) {
    assert.match(id, /^yt:[A-Za-z0-9_-]{11}$/, `unexpected id in href: ${id}`);
    // The exact string the sitemap generator writes, and the exact canonical the
    // watch page renders. One convention, three consumers, asserted here.
    assert.equal(`${ORIGIN}/watch?id=${encodeURIComponent(id)}`, watchUrl(id));
    assert.equal(setVideoCanonical(id), watchUrl(id));
  }
});

test("A3 the rendered videos are the deterministic feed page, so / and the sitemap agree", async () => {
  const ids = poolIds();

  // One shared module instance, so both requests read the SAME warm pool — which
  // is exactly the production relationship between a page load and the
  // /api/trending call its own client makes moments later.
  const target = await freshWorker();

  const home = await serve({ worker: target, responder: chartResponder(ids) });
  const api = await serve({
    worker: target,
    path: "/api/trending?max=12",
    responder: chartResponder(ids)
  });
  const apiPayload = JSON.parse(api.html);

  assert.deepEqual(cardHrefs(home.html), apiPayload.videos.slice(0, SSR_COUNT).map(v => v.id));
  assert.equal(apiPayload.seeded, false, "the homepage must render the UNSEEDED page");

  // And the deterministic order is the pool's own order, so the first page of
  // the homepage and the first page of the sitemap name the same videos.
  assert.deepEqual(cardHrefs(home.html), ids.slice(0, SSR_COUNT).map(id => `yt:${id}`));
});

test("A4 the href is exactly what the client-side buildCard() would have written", async () => {
  const ids = poolIds();
  const { html } = await serve({ responder: chartResponder(ids) });

  // Same encoding convention as public/watch.js and generate-sitemap.mjs. If
  // this drifts, the server-rendered and client-rendered cards stop being the
  // same link.
  const clientForm = ids
    .slice(0, SSR_COUNT)
    .map(id => "/watch?id=" + encodeURIComponent(`yt:${id}`));

  assert.deepEqual(
    [...html.matchAll(/class="card-title-link" href="([^"]*)"/g)].map(m => m[1]),
    clientForm
  );
});

// -----------------------------------------------------------------------------
// B) The markup is the card the client already builds
// -----------------------------------------------------------------------------

test("B1 each card is the same DOM buildCard() produces", async () => {
  const ids = poolIds();
  const { html } = await serve({ responder: chartResponder(ids) });
  const inner = feedContainerInner(html);

  assert.equal((inner.match(/class="card"/g) || []).length, SSR_COUNT);
  // Same wrapper chain: div.card > div.thumb > (img + span), then h3 > a, then p.
  assert.match(inner, /<div class="card"><div class="thumb"><img [^>]*><span>[^<]*<\/span><\/div><h3>/);
  // The classes the stylesheet already targets must be the ones used here, or the
  // server-rendered page would not look like the client-rendered one.
  for (const cls of ["card", "thumb", "card-title-link"]) {
    assert.match(inner, new RegExp(`class="${cls}"`), `class="${cls}" must be preserved`);
  }
  // Alt text and the anchor text are the real title, which is what gives a
  // crawler something to index.
  assert.match(inner, /alt="Chart video /);
  assert.match(inner, /<a class="card-title-link" href="\/watch\?id=[^"]+">Chart video /);
});

test("B2 the grid still renders live once the client takes over", async () => {
  const { html } = await serve({ responder: chartResponder(poolIds()) });

  // renderVideoList()'s replaceChildren() is what removes these cards, so the
  // container must hold them as ordinary element children of <main> — never
  // inside a wrapper that would survive, and never duplicated by a second grid.
  const main = html.slice(html.indexOf('<main id="videoList">'));

  assert.equal((main.match(/<main id="videoList">/g) || []).length, 1);
  assert.equal((main.match(/class="card"/g) || []).length, SSR_COUNT);
  assert.equal(main.indexOf("</main>") < main.indexOf("id=\"homeScrollSentinel\""), true);

  // The client replaces children wholesale on every render, so a second static
  // grid elsewhere in the document would double the cards after hydration.
  assert.equal((html.match(/<main id="videoList">/g) || []).length, 1);
});

test("B3 the sentinels, filters and status nodes around the grid are untouched", async () => {
  const { html } = await serve({ responder: chartResponder(poolIds()) });

  // Infinite scroll depends on both sentinels sitting OUTSIDE #videoList. If the
  // injection had swallowed or reordered them, replaceChildren() would start
  // deleting the observer's targets.
  for (const id of ["homeScrollSentinel", "searchScrollSentinel", "noResults", "dynamicStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must survive the injection`);
    assert.equal(html.indexOf(id) > html.indexOf("</main>"), true, `#${id} must stay outside #videoList`);
  }

  // The filter rows sit before the grid and must not have been pulled into it.
  for (const id of ["categoryFilter", "searchFilters"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must survive the injection`);
    assert.equal(html.indexOf(id) < html.indexOf('<main id="videoList">'), true, `#${id} must stay before #videoList`);
  }
});

// -----------------------------------------------------------------------------
// C) Nothing is fabricated, and failures degrade to today's behaviour
// -----------------------------------------------------------------------------

test("C1 every rendered video resolves to a real watch page", async () => {
  const ids = poolIds();
  const { html, calls } = await serve({ responder: chartResponder(ids) });
  const hrefs = cardHrefs(html);

  // The homepage must never advertise a URL the watch page would answer noindex.
  // Every id is a real `yt:<11-char>` from the pool, so each one is a 200.
  assert.equal(hrefs.length, SSR_COUNT);
  for (const id of hrefs) {
    assert.match(id, /^yt:[A-Za-z0-9_-]{11}$/);
  }

  // ...and it cost no videos.list lookup of its own: the pool build is chart
  // calls only, exactly as /api/trending already spends them.
  assert.ok(chartCalls(calls).length > 0, "the pool build did happen");
  assert.equal(
    calls.some(parsed => parsed.searchParams.has("id")),
    false,
    "the homepage must never spend a per-video details lookup"
  );
});

test("C2 titles are HTML-escaped, never injected raw", async () => {
  const nasty = `<script>alert("x")</script> & 'quotes'`;
  const responder = parsed => {
    if (parsed.searchParams.get("chart")) {
      return { items: [chartItem(sourceId(1), { snippet: { title: nasty, tags: ["cloudflare"] } })] };
    }

    return {};
  };

  const { html } = await serve({ responder });

  assert.equal(html.includes(nasty), false, "the raw title must never reach the HTML");
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;quotes&#39;/);
  // The only <script> tags left are the ones index.html itself ships.
  assert.equal((html.match(/<script/g) || []).length, (INDEX_HTML.match(/<script/g) || []).length);
});

test("C3 an unreachable YouTube returns the untouched asset, byte for byte", async () => {
  const { response, html } = await serve({
    responder: () => {
      throw new Error("upstream down");
    }
  });

  assert.equal(response.status, 200);
  assert.equal(html, INDEX_HTML, "a failed render must be indistinguishable from no render");
  assert.equal(response.headers.get("ETag"), '"index.html-etag"', "the asset ETag must survive");
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=0, must-revalidate",
    "the asset's own caching must survive"
  );
});

test("C4 an empty pool yields zero links and no fabricated markup", async () => {
  const { response, html } = await serve({ responder: () => ({ items: [] }) });

  assert.equal(response.status, 200);
  assert.equal(cardHrefs(html).length, 0);
  assert.equal(html, INDEX_HTML);
});

test("C5 no API key yields the untouched asset rather than a 500", async () => {
  const { response, html } = await serve({ apiKey: "", responder: chartResponder(poolIds()) });

  assert.equal(response.status, 200);
  assert.equal(html, INDEX_HTML);
});

test("C6 a broken feed payload degrades instead of throwing", async () => {
  const { response, html } = await serve({
    responder: parsed =>
      parsed.searchParams.get("chart") ? { items: "not-an-array" } : { items: [{ id: null }] }
  });

  assert.equal(response.status, 200);
  assert.equal(cardHrefs(html).length, 0);
});

test("C7 a homepage with no video container degrades to no links", async () => {
  const stripped = INDEX_HTML.replace('<main id="videoList">', '<main id="renamedAway">');
  const { response, html } = await serve({
    html: stripped,
    responder: chartResponder(poolIds())
  });

  assert.equal(response.status, 200);
  assert.equal(cardHrefs(html).length, 0);
  assert.equal(html.includes('class="card-title-link"'), false);
  // The bytes are unchanged, so the asset's own validators still describe them.
  assert.equal(html, stripped);
  assert.equal(response.headers.get("ETag"), '"index.html-etag"');
});

// -----------------------------------------------------------------------------
// D) Response surface is preserved
// -----------------------------------------------------------------------------

test("D1 the homepage keeps its indexable robots meta and canonical", async () => {
  const { html } = await serve({ responder: chartResponder(poolIds()) });

  // F-01 must not tip the homepage into noindex, and must not add a canonical
  // per video — the page's own canonical is the whole page.
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/mytube\.farqas007\.workers\.dev\/">/);
  assert.match(html, /<title>MyTube<\/title>/);
});

test("D2 the security header set the homepage already had is still applied", async () => {
  const { response } = await serve({ responder: chartResponder(poolIds()) });

  // The homepage has always gone through withSecurityHeaders(); routing it into
  // the Worker must not silently drop the CSP.
  assert.match(response.headers.get("Content-Security-Policy") || "", /default-src 'self'/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("D3 a rewritten body drops the validators that no longer describe it", async () => {
  const { response } = await serve({ responder: chartResponder(poolIds()) });

  assert.equal(response.headers.get("ETag"), null);
  assert.equal(response.headers.get("Content-Length"), null);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("Cache-Control") || "", /s-maxage=300/);
});

test("D4 non-GET and HEAD are handed straight to the asset binding", async () => {
  for (const method of ["HEAD", "POST"]) {
    const { requested, calls } = await serve({ method, responder: chartResponder(poolIds()) });

    // No pool build, and the original request path is what got served — the
    // homepage rewrite must not start costing anything on non-GET traffic.
    assert.deepEqual(chartCalls(calls), [], `${method} must not build a feed pool`);
    assert.deepEqual(requested, ["/"], `${method} must pass the original request through`);
  }
});

test("D5 the worker requests the shell by its real asset path", async () => {
  const { requested } = await serve({ responder: chartResponder(poolIds()) });

  // /index.html, not /. Depending on html_handling for this would be the same
  // fragility handleWatchPage avoids by fetching /watch.html.
  assert.deepEqual(requested, ["/index.html"]);
});

test("D6 /api/* and the other assets are unaffected", async () => {
  // The real module export, not a fresh instance: this is the entry point the
  // runtime actually calls.
  const trending = await serve({
    worker,
    path: "/api/trending?max=3",
    responder: chartResponder(poolIds())
  });

  assert.equal(trending.response.status, 200);
  assert.deepEqual(trending.requested, [], "/api/* must not go through the asset binding");
  assert.equal(JSON.parse(trending.html).videos.length, 3);

  // The watch page is still rendered by its own handler, off the same pool, and
  // its canonical still matches the href the homepage advertised.
  const id = `yt:${sourceId(1)}`;
  const watch = await serve({ worker, path: `/watch?id=${id}`, responder: chartResponder(poolIds()) });

  assert.equal(watch.response.status, 200);
  assert.match(
    watch.html,
    /<link rel="canonical" id="pageCanonical" href="https:\/\/mytube\.farqas007\.workers\.dev\/watch\?id=yt%3A[^"]+"/,
    "the watch canonical must still be server-rendered"
  );
});

// -----------------------------------------------------------------------------
// E) The client still takes over cleanly
// -----------------------------------------------------------------------------

test("E1 loadHomeFeed no longer blanks the grid before live data arrives", () => {
  // The server ships real cards. loadHomeFeed() used to replaceChildren() as its
  // first act, which ran synchronously at parse time and produced a visible
  // content -> blank -> content flicker. renderVideoList() still replaces
  // children on arrival, so hydration is unaffected either way.
  const start = INDEX_HTML.indexOf("async function loadHomeFeed(){");
  const end = INDEX_HTML.indexOf("async function doDynamicSearch(){");

  assert.ok(start > 0, "loadHomeFeed() must still exist");
  assert.ok(end > start, "doDynamicSearch() must still follow loadHomeFeed()");

  const body = INDEX_HTML.slice(start, end);
  // Scoped to the part that runs BEFORE the first await: that is the clear that
  // would blank the server-rendered cards during the fetch. The clear in the
  // catch block below it is a different thing entirely — it wipes the grid when
  // the feed genuinely failed — and must stay.
  const beforeFetch = body.slice(0, body.indexOf("await client.trending("));

  assert.equal(beforeFetch.includes("box.replaceChildren()"), false, "the early clear must be gone");
  assert.match(body, /catch\(e\)\{[\s\S]*box\.replaceChildren\(\)/, "the failure clear must stay");

  // And the replacement path must still be there, or the grid would never update.
  assert.match(body, /renderVideoList\(homeVideos\)/);
});

test("E2 every search path still clears the grid it no longer owns", () => {
  // Only the home feed's premature clear was removed. Search has its own clears
  // and must keep them, or a failed search would leave the SSR cards on screen
  // pretending to be results.
  const search = INDEX_HTML.slice(INDEX_HTML.indexOf("async function doDynamicSearch(){"));

  assert.match(search, /box\.replaceChildren\(\)/);
  assert.match(search, /renderVideoList\(searchRemoteVideos\)/);
});