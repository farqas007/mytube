// =============================================================================
// MyTube — channel page tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// The channel page is a purely static surface: /channel.html is served straight
// from the ASSETS binding (it is NOT in wrangler.jsonc's run_worker_first list),
// and all of its data comes from the two channel endpoints the app already has
// (/api/channel and /api/channelVideos) via public/channel.js.
//
// Because there is no server-side rendering to prove, these tests pin:
//
//   * the shipped public/channel.html markup and its element contract, so
//     channel.js and the page can never drift apart silently;
//   * that channel.html is a real shipped asset, not a hallucinated route, and
//     that the Worker serves it unchanged (no rewrite, no worker-first cost);
//   * the load-bearing rules of public/channel.js: it reuses the existing
//     youtube.js + data.js clients, it never links to the duplicate watch.html
//     form (mirrors the site-wide E3 convention), it pages with pageToken, and
//     it offers only the sorts that are correct over a paged window;
//   * that the new page cannot leak into the index (noindex, follow), matching
//     every other signed-in-less app page;
//   * that the watch page gained an internal MyTube channel link WITHOUT losing
//     the external YouTube one.
//
// Run: node --test tests/testChannelPage.js
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

const CHANNEL_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "channel.html"),
  "utf8"
);
const CHANNEL_JS = readFileSync(
  path.join(REPO_ROOT, "public", "channel.js"),
  "utf8"
);
const WATCH_JS = readFileSync(
  path.join(REPO_ROOT, "public", "watch.js"),
  "utf8"
);
const WATCH_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "watch.html"),
  "utf8"
);

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

// The static binding, reduced to what the Worker actually asks it for. It serves
// the real public/ files so assertions run against shipped markup.
function createFakeAssets() {
  const requested = [];

  return {
    requested,
    async fetch(request) {
      const url = new URL(request.url);
      const name = path.posix.basename(url.pathname);

      requested.push(url.pathname);

      try {
        const body = readFileSync(path.join(REPO_ROOT, "public", name), "utf8");

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": name.endsWith(".html")
              ? "text/html; charset=utf-8"
              : "text/javascript; charset=utf-8",
            ETag: `"${name}"`,
            "Content-Length": String(body.length)
          }
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
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

  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.9`;
}

async function serve(url) {
  const assets = createFakeAssets();
  const request = new Request(`${ORIGIN}${url}`, {
    method: "GET",
    headers: { "CF-Connecting-IP": nextIp(), Origin: ORIGIN }
  });

  const response = await worker.fetch(
    request,
    { YOUTUBE_API_KEY: "test-key", ASSETS: assets },
    createFakeCtx()
  );

  return { response, html: await response.text(), requested: assets.requested };
}

// An element id must appear in the shipped HTML exactly as channel.js reads it.
function assertHasId(html, id) {
  assert.ok(
    html.includes(`id="${id}"`),
    `public/channel.html must contain id="${id}"`
  );
}

// -----------------------------------------------------------------------------
// A) The page exists and carries the element contract channel.js depends on
// -----------------------------------------------------------------------------

test("A1 channel.html is a shipped asset with the expected ids", () => {
  const ids = [
    "channelInvalid",
    "channelLoading",
    "channelError",
    "channelEmpty",
    "channelContent",
    "channelPageAvatar",
    "channelPageName",
    "channelPageSubs",
    "channelPageStatus",
    "channelPageSubscribeBtn",
    "channelVideoGrid",
    "channelSort",
    "channelMoreBtn",
    "channelErrorText"
  ];

  for (const id of ids) {
    assertHasId(CHANNEL_HTML, id);
  }
});

test("A2 channel.js reads exactly the ids the page ships", () => {
  // Every getElementById in the module is backgrounded by markup that exists,
  // so a rename on one side cannot silently break the other.
  const read = [...CHANNEL_JS.matchAll(/getElementById\("([^"]+)"\)/g)].map(
    m => m[1]
  );

  assert.ok(read.length > 0, "channel.js must query the DOM");

  for (const id of read) {
    assertHasId(CHANNEL_HTML, id);
  }
});

test("A3 the page is a logged-out-safe app page: noindex, follow", () => {
  const robots = [
    ...CHANNEL_HTML.matchAll(
      /<meta\b[^>]*\bname="robots"[^>]*\bcontent="([^"]*)"[^>]*>/gi
    )
  ].map(m => m[1]);

  assert.deepEqual(robots, ["noindex, follow"]);
});

test("A4 the page loads auth.js and channel.js as modules", () => {
  assert.match(CHANNEL_HTML, /<script type="module" src="auth\.js"><\/script>/);
  assert.match(CHANNEL_HTML, /<script type="module" src="channel\.js"><\/script>/);
});

// -----------------------------------------------------------------------------
// B) The Worker serves the page unchanged (no rewrite, no worker-first)
// -----------------------------------------------------------------------------

test("B1 GET /channel.html is served byte-for-byte from the asset binding", async () => {
  const { response, html, requested } = await serve("/channel.html");

  assert.equal(response.status, 200);
  assert.equal(html, CHANNEL_HTML);
  assert.deepEqual(requested, ["/channel.html"]);
});

test("B2 the channel page is not a Worker-first route", async () => {
  // /channel.html is a plain asset. If it ever needed the Worker it would mean a
  // rewrite was added, which this change deliberately avoided.
  const wrangler = readFileSync(
    path.join(REPO_ROOT, "wrangler.jsonc"),
    "utf8"
  );

  assert.ok(
    !/run_worker_first[\s\S]*?"\/channel/.test(wrangler),
    "/channel must not be a run_worker_first route"
  );
});

test("B3 channel.js is served unchanged as a static module", async () => {
  const { response, html } = await serve("/channel.js");

  assert.equal(response.status, 200);
  assert.equal(html, CHANNEL_JS);
});

// -----------------------------------------------------------------------------
// C) channel.js reuses the existing clients and follows site conventions
// -----------------------------------------------------------------------------

test("C1 channel.js reuses the existing youtube.js channel APIs", () => {
  assert.match(CHANNEL_JS, /from "\.\/youtube\.js"/);
  assert.match(CHANNEL_JS, /\bchannel\b/);
  assert.match(CHANNEL_JS, /\bchannelVideos\b/);
});

test("C2 channel.js reuses auth and the Firestore subscription helpers", () => {
  assert.match(CHANNEL_JS, /from "\.\/firebase\.js"/);
  assert.match(CHANNEL_JS, /from "\.\/data\.js"/);
  assert.match(CHANNEL_JS, /\baddSubscription\b/);
  assert.match(CHANNEL_JS, /\bremoveSubscription\b/);
  assert.match(CHANNEL_JS, /\bisSubscribedByChannel\b/);
  assert.match(CHANNEL_JS, /onAuthStateChanged\(auth/);
});

test("C3 video links use the site-wide /watch?id= convention", () => {
  // Mirrors tests/testSitemap.js E3: never the duplicate watch.html form, always
  // encodeURIComponent around the id.
  assert.ok(
    !/watch\.html\?id=/.test(CHANNEL_JS),
    "channel.js must not link to the duplicate watch.html form"
  );
  assert.match(CHANNEL_JS, /\/watch\?id="\s*\+\s*encodeURIComponent\(/);
});

test("C4 the page is addressed by ?id= and reads it from the URL", () => {
  assert.match(CHANNEL_JS, /URLSearchParams\(window\.location\.search\)/);
  assert.match(CHANNEL_JS, /\.get\("id"\)/);
});

test("C5 pagination is wired through pageToken, not a re-fetch of page 1", () => {
  assert.match(CHANNEL_JS, /nextPageToken/);
  // The continuation token must actually be passed to the second call.
  assert.match(CHANNEL_JS, /channelVideos\(channelId,\s*PAGE_SIZE,\s*nextPageToken\)/);
});

// -----------------------------------------------------------------------------
// D) Sorting offers only what is correct over a paged window
// -----------------------------------------------------------------------------

test("D1 exactly Newest and Oldest are offered", () => {
  const options = [
    ...CHANNEL_HTML.matchAll(/<option value="([^"]+)"/g)
  ].map(m => m[1]);

  assert.deepEqual(options, ["newest", "oldest"]);
});

test("D2 no global Most Viewed claim without a full video set", () => {
  // A "most viewed" sort is only truthful once every video is loaded. The page
  // must not offer it until that is guaranteed. Comments are stripped first so
  // the assertion is about code and visible labels, not prose.
  const htmlWithoutComments = CHANNEL_HTML.replace(/<!--[\s\S]*?-->/g, "");
  const jsWithoutComments = CHANNEL_JS
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(
    !/most\s*viewed/i.test(htmlWithoutComments),
    "channel.html must not offer Most Viewed"
  );
  assert.ok(
    !/most\s*viewed/i.test(jsWithoutComments),
    "channel.js must not implement Most Viewed"
  );
});

test("D3 the oldest sort reverses the loaded set without refetching", () => {
  assert.match(CHANNEL_JS, /reverse\(\)/);
  // Sorting must not call the API.
  const sortedBody = CHANNEL_JS.slice(
    CHANNEL_JS.indexOf("function sortedVideos"),
    CHANNEL_JS.indexOf("function renderGrid")
  );

  assert.ok(
    !/channelVideos\(/.test(sortedBody),
    "sorting must not trigger a network request"
  );
});

// -----------------------------------------------------------------------------
// E) States and subscribe controls exist and are reachable
// -----------------------------------------------------------------------------

test("E1 all five page states are present", () => {
  for (const state of ["invalid", "loading", "error", "empty", "content"]) {
    assertHasId(CHANNEL_HTML, `channel${state[0].toUpperCase()}${state.slice(1)}`);
  }
});

test("E2 the empty state is reached when a channel has no videos", () => {
  // loadFirstPage must handle the zero-video response without crashing.
  assert.match(CHANNEL_JS, /allVideos\.length === 0/);
});

test("E3 subscribe requires login and reflects Firestore state", () => {
  assert.match(CHANNEL_JS, /auth && auth\.currentUser/);
  assert.match(CHANNEL_JS, /Please log in to subscribe/);
  // Tri-state: a failed read (null) must not flip the button off.
  assert.match(CHANNEL_JS, /result !== null/);
});

// -----------------------------------------------------------------------------
// F) The watch page gained the entry point without losing the external link
// -----------------------------------------------------------------------------

test("F1 the watch shell has both channel links", () => {
  assert.match(WATCH_HTML, /id="myTubeChannelLink"/);
  assert.match(WATCH_HTML, /id="ytChannelLink"/);
});

test("F2 the external YouTube link is preserved", () => {
  assert.match(WATCH_HTML, /id="ytChannelLink"[^>]*target="_blank"/);
  assert.match(WATCH_HTML, /id="ytChannelLink"[^>]*rel="noopener noreferrer"/);
  assert.match(
    WATCH_JS,
    /https:\/\/www\.youtube\.com\/channel\/" \+ encodeURIComponent\(channelId\)/
  );
});

test("F3 the internal link points at the new page and is revealable", () => {
  assert.match(
    WATCH_JS,
    /mytubeChannelLink\.href = "\/channel\.html\?id=" \+ encodeURIComponent\(channelId\)/
  );
  assert.match(WATCH_JS, /mytubeChannelLink\.style\.display = ""/);
});

// -----------------------------------------------------------------------------
// G) No accidental coupling: the change did not touch the Worker API surface
// -----------------------------------------------------------------------------

test("G1 channel.js adds no new /api route", () => {
  assert.ok(
    !/\/api\//.test(CHANNEL_JS),
    "channel.js must talk to the backend only through youtube.js"
  );
});

test("G2 the two existing channel endpoints are the ones used", () => {
  // worker.js already implements these; the new page must not invent a third.
  const workerSource = readFileSync(path.join(REPO_ROOT, "worker.js"), "utf8");

  assert.match(workerSource, /route === "channel"\)/);
  assert.match(workerSource, /route === "channelVideos"\)/);
});
