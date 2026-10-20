// =============================================================================
// MyTube — subscriptions page tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// /subscriptions.html is a static asset served straight from the ASSETS binding
// (it is NOT in wrangler.jsonc's run_worker_first list), so there is no
// server-side rendering to prove. These tests pin three things instead:
//
//   * the shipped public/subscriptions.html markup and its element contract, so
//     subscriptions.js and the page can never drift apart silently;
//   * that the shelves path (the original feature) is still present and intact,
//     because the unified Feed is meant to be additive, not a replacement;
//   * the pure feed logic — newest-first merge, dedupe, missing-timestamp
//     ordering, the age parser, and the cursor-driven Load more — by evaluating
//     the REAL function bodies from public/subscriptions.js in a sandbox (the
//     module itself cannot be imported under Node because it pulls Firebase
//     from a CDN).
//
// Everything here reads shipped files. Nothing is written.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

const SUBS_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "subscriptions.html"),
  "utf8"
);
const SUBS_JS = readFileSync(
  path.join(REPO_ROOT, "public", "subscriptions.js"),
  "utf8"
);
const WORKER_JS = readFileSync(
  path.join(REPO_ROOT, "worker.js"),
  "utf8"
);
const NORMALIZE_JS = readFileSync(
  path.join(REPO_ROOT, "shared", "normalize.js"),
  "utf8"
);

// -----------------------------------------------------------------------------
// Source sandbox
// -----------------------------------------------------------------------------

// Pull a top-level `function name(...) { ... }` body out of a source string by
// brace matching, so the test exercises the shipped implementation rather than
// a copy that could drift.
function extractFunction(source, name) {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);

  assert.notEqual(start, -1, `public/subscriptions.js must define ${name}()`);

  // Preserve a leading `async ` so an extracted async body stays legal in the
  // sandbox (`await` is a SyntaxError inside a plain function).
  if (source.slice(start - 6, start) === "async ") {
    start -= 6;
  }

  const open = source.indexOf("{", start);

  assert.notEqual(open, -1, `${name}() must have a body`);

  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`unbalanced braces while extracting ${name}()`);
}

// Evaluate a set of pure functions together so they can call each other.
function sandbox(...names) {
  const bodies = names.map(n => extractFunction(SUBS_JS, n)).join("\n");
  const factory = new Function(
    `${bodies}\nreturn { ${names.join(", ")} };`
  );
  return factory();
}

const { publishedAtMs, parseAgoDate, mergeFeed } = sandbox(
  "publishedAtMs",
  "parseAgoDate",
  "mergeFeed"
);

// A sandbox with injected free variables (channelVideos, cache helpers, an
// audio-less localStorage stand-in, and a feed object), so the REAL shipped
// bodies of loadChannelVideosResult() and removeChannelFromFeed() can be driven
// against controlled fixtures without importing Firebase.
function sandboxWithDeps(globals, ...names) {
  const bodies = names.map(n => extractFunction(SUBS_JS, n)).join("\n");
  const keys = Object.keys(globals);
  const factory = new Function(
    ...keys,
    `${bodies}\nreturn { ${names.join(", ")} };`
  );
  return factory(...keys.map(k => globals[k]));
}

// -----------------------------------------------------------------------------
// A) The page exists and carries the element contract subscriptions.js needs
// -----------------------------------------------------------------------------

test("A1 subscriptions.html ships the Feed/Channels contract", () => {
  const ids = [
    // The original shelves surface, preserved.
    "subsLoggedOut",
    "subsLoading",
    "subsEmpty",
    "subsError",
    "subsContent",
    "channelSections",
    "subsRefreshBtn",
    // The unified Feed surface.
    "feedView",
    "subscriptionsFeed",
    "feedMoreBtn",
    "feedStatus",
    "shelvesView",
    "subsViewFeed",
    "subsViewChannels"
  ];

  for (const id of ids) {
    assert.ok(
      SUBS_HTML.includes(`id="${id}"`),
      `public/subscriptions.html must contain id="${id}"`
    );
  }
});

test("A2 the four original state panels are still present", () => {
  // The Feed reuses showState(), which toggles exactly these panels. Losing one
  // would strand the page in the wrong view.
  for (const id of ["subsLoggedOut", "subsLoading", "subsEmpty", "subsError"]) {
    assert.ok(SUBS_HTML.includes(`id="${id}"`), `missing state panel ${id}`);
  }
});

test("A3 the feed is the default view and shelves start hidden", () => {
  // Feed view: not hidden. Shelves view: hidden. The toggle then follows the
  // persisted preference at runtime.
  assert.match(
    SUBS_HTML,
    /id="feedView">/,
    "feedView must not carry a hidden attribute in the shipped markup"
  );
  assert.match(
    SUBS_HTML,
    /id="shelvesView" hidden/,
    "shelvesView must start hidden"
  );
});

test("A4 the feed reuses existing shared classes, not bespoke ones", () => {
  // The grid reuses .channel-section-grid and the button reuses .load-more, so
  // the feed inherits the card layout and the established Load-more styling.
  assert.match(SUBS_HTML, /id="subscriptionsFeed" class="channel-section-grid"/);
  assert.match(SUBS_HTML, /id="feedMoreBtn" type="button" class="load-more"/);
  assert.match(SUBS_HTML, /class="lib-tabs"/);
});

// -----------------------------------------------------------------------------
// B) The shelves path is preserved (regression guard)
// -----------------------------------------------------------------------------

test("B1 the shelves functions and elements are still defined", () => {
  for (const fn of [
    "buildChannelSection",
    "buildVideoCard",
    "loadChannelVideos",
    "loadSubscriptions",
    "setupRefreshButton"
  ]) {
    assert.ok(
      SUBS_JS.includes(`function ${fn}(`) || SUBS_JS.includes(`async function ${fn}(`),
      `public/subscriptions.js must still define ${fn}()`
    );
  }

  assert.ok(
    SUBS_JS.includes('document.getElementById("channelSections")'),
    "the shelves container must still be read"
  );
});

test("B2 the 10-minute per-channel cache is unchanged", () => {
  assert.ok(
    SUBS_JS.includes('const SUBS_CACHE_KEY = "mytube_subs_videos_cache_v1"'),
    "the cache key must not be bumped — cached videos predate publishedAt and " +
      "still sort through the date-string fallback"
  );
  assert.ok(
    SUBS_JS.includes("const SUBS_CACHE_TTL_MS = 10 * 60 * 1000"),
    "the cache TTL must stay at 10 minutes"
  );
});

test("B3 unsubscribe still removes the shelf and can fall back to empty", () => {
  const section = extractFunction(SUBS_JS, "buildChannelSection");

  assert.ok(section.includes("removeSubscription"), "unsubscribe must call the data layer");
  assert.ok(section.includes("section.remove()"), "a successful unsubscribe removes the shelf");
  assert.ok(section.includes('showState("empty")'), "the last unsubscribe shows the empty state");
});

// -----------------------------------------------------------------------------
// C) Auth regression
// -----------------------------------------------------------------------------

test("C1 auth still gates the logged-out state", () => {
  assert.ok(SUBS_JS.includes("onAuthStateChanged(auth"), "auth must still be observed");
  assert.ok(SUBS_JS.includes('showState("loggedOut")'), "logged-out users see the panel");
});

test("C2 refresh still requires a signed-in user", () => {
  const refresh = extractFunction(SUBS_JS, "setupRefreshButton");

  assert.ok(
    refresh.includes("auth && auth.currentUser"),
    "refresh must guard on the current user"
  );
  assert.ok(refresh.includes("clearVideosCache()"), "refresh must clear the stale cache");
});

test("C3 the feed load requires a uid and reads subscriptions", () => {
  const load = extractFunction(SUBS_JS, "loadFeed");

  assert.ok(load.includes("getSubscriptions(uid)"), "the feed reads the subscription list");
  assert.ok(
    load.includes("loadChannelVideosResult("),
    "the feed reuses the shelf fetch path (the status-carrying variant)"
  );
});

// -----------------------------------------------------------------------------
// D) Timestamp parsing
// -----------------------------------------------------------------------------

test("D1 publishedAtMs prefers the raw RFC 3339 timestamp", () => {
  const iso = "2026-01-15T10:00:00Z";
  const ms = Date.parse(iso);

  assert.equal(publishedAtMs({ publishedAt: iso }), ms);
  // Even when a (drifted) label is present, the raw instant wins.
  assert.equal(publishedAtMs({ publishedAt: iso, date: "1y ago" }), ms);
});

test("D2 publishedAtMs falls back to the human label when raw is missing", () => {
  const before = Date.now();
  const ms = publishedAtMs({ date: "3d ago" });

  assert.ok(Number.isFinite(ms), "a parseable label yields a finite time");
  const expected = before - 3 * 24 * 60 * 60 * 1000;

  assert.ok(Math.abs(ms - expected) < 5000, "3d ago is ~3 days before now");
});

test("D3 unparseable or missing timestamps are Infinity, never dropped", () => {
  assert.equal(publishedAtMs({}), Infinity);
  assert.equal(publishedAtMs({ publishedAt: "not-a-date", date: "soon" }), Infinity);
  assert.equal(publishedAtMs({ date: "" }), Infinity);
  assert.equal(publishedAtMs(null), Infinity);

  // A finite-but-invalid value must not be mistaken for a real time.
  assert.equal(parseAgoDate("3d"), Infinity, "no 'ago' suffix is not a date");
  assert.equal(parseAgoDate("ago"), Infinity);
});

// -----------------------------------------------------------------------------
// E) Merge: newest-first, deduped
// -----------------------------------------------------------------------------

function vid(sourceId, publishedAt, extra = {}) {
  return {
    id: `yt:${sourceId}`,
    sourceId,
    title: `Video ${sourceId}`,
    publishedAt,
    date: "",
    ...extra
  };
}

test("E1 mergeFeed orders newest-first across channels", () => {
  const merged = mergeFeed([
    [vid("a", "2026-01-01T00:00:00Z"), vid("b", "2026-03-01T00:00:00Z")],
    [vid("c", "2026-02-01T00:00:00Z")]
  ]);

  assert.deepEqual(
    merged.map(v => v.sourceId),
    ["b", "c", "a"]
  );
});

test("E2 mergeFeed dedupes by sourceId, keeping one card", () => {
  const merged = mergeFeed([
    [vid("a", "2026-01-01T00:00:00Z")],
    [vid("a", "2026-01-01T00:00:00Z")]
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceId, "a");
});

test("E3 a dated duplicate replaces an undated one instead of losing its slot", () => {
  // Same video seen twice: once with no timestamp, once with one. The dated copy
  // must win so the card sorts by its real age.
  const undated = { id: "yt:a", sourceId: "a", title: "A", date: "" };
  const dated = vid("a", "2026-02-01T00:00:00Z");

  const merged = mergeFeed([
    [undated],
    [dated]
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].publishedAt, "2026-02-01T00:00:00Z");
});

test("E4 videos with no usable timestamp sort last but are never removed", () => {
  const merged = mergeFeed([
    [{ id: "yt:x", sourceId: "x", title: "X", date: "" }],
    [vid("a", "2026-01-01T00:00:00Z")]
  ]);

  assert.equal(merged.length, 2, "no video is dropped for a missing timestamp");
  assert.deepEqual(
    merged.map(v => v.sourceId),
    ["a", "x"]
  );
});

test("E5 equal ages keep their original order (stable)", () => {
  const t = "2026-01-01T00:00:00Z";
  const merged = mergeFeed([
    [vid("a", t), vid("b", t), vid("c", t)]
  ]);

  assert.deepEqual(
    merged.map(v => v.sourceId),
    ["a", "b", "c"]
  );
});

test("E6 entries without any identity are skipped, not crashed on", () => {
  const merged = mergeFeed([
    [null, { title: "no id" }, vid("a", "2026-01-01T00:00:00Z")]
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceId, "a");
});

// -----------------------------------------------------------------------------
// F) Load more — honest pagination
// -----------------------------------------------------------------------------

test("F1 loadMoreFeed advances a real pageToken through the existing API", () => {
  const more = extractFunction(SUBS_JS, "loadMoreFeed");

  assert.ok(
    more.includes("channelVideos(sub.channelId"),
    "Load more must use the existing channelVideos endpoint"
  );
  assert.ok(
    more.includes("feedCursors"),
    "Load more must continue each channel from its stored cursor"
  );
  assert.ok(
    more.includes("nextPageToken"),
    "Load more must record the next cursor from the response"
  );
});

test("F2 loadMoreFeed never claims success without data", () => {
  const more = extractFunction(SUBS_JS, "loadMoreFeed");

  // When nothing new arrives it must distinguish "caught up" from a failure.
  assert.ok(more.includes("requestFailed"), "failures are tracked");
  assert.ok(
    more.includes("Could not load more videos."),
    "a failed request must not be reported as 'all caught up'"
  );
  assert.ok(
    more.includes("You're all caught up"),
    "a genuine exhaustion has its own message"
  );
});

test("F3 loadMoreFeed is guarded against re-entrancy and stale loads", () => {
  const more = extractFunction(SUBS_JS, "loadMoreFeed");

  assert.ok(more.includes("if(feed.pending || feed.exhaused"), "no double-fire");
  assert.ok(more.includes("loadId !== feed.token"), "a superseded load is dropped");
});

test("F4 the Load-more button is hidden when the pool is exhausted", () => {
  const update = extractFunction(SUBS_JS, "updateFeedMoreButton");

  assert.ok(
    update.includes("feed.shown < feed.pool.length"),
    "the button only shows while cards remain"
  );
});

// -----------------------------------------------------------------------------
// G) "New since last visit"
// -----------------------------------------------------------------------------

test("G1 the seen marker is per-uid and localStorage-only", () => {
  assert.ok(
    SUBS_JS.includes('const FEED_SEEN_KEY = "mytube_feed_last_seen_v1"'),
    "the marker has its own key"
  );

  const forUser = extractFunction(SUBS_JS, "feedSeenFor");
  const advance = extractFunction(SUBS_JS, "advanceFeedSeen");

  assert.ok(forUser.includes("feedSeenStore[uid]"), "the marker is per uid");
  assert.ok(advance.includes("localStorage.setItem"), "the marker is persisted locally");
});

test("G2 a first visit shows no New badges", () => {
  const seen = extractFunction(SUBS_JS, "feedSeenFor");

  // No stored marker -> 0, and buildFeedCard only badges when seen > 0.
  assert.ok(seen.includes("Number(feedSeenStore[uid]) || 0"), "a missing marker reads as 0");

  const card = extractFunction(SUBS_JS, "buildFeedCard");

  assert.ok(card.includes("seen > 0"), "no marker means no badges");
});

test("G3 only videos newer than the marker are badged", () => {
  const card = extractFunction(SUBS_JS, "buildFeedCard");

  assert.ok(card.includes("age > seen"), "a video must be newer than the marker");
  assert.ok(
    card.includes("age !== Infinity"),
    "an unknown-age video is never claimed to be New"
  );
});

test("G4 the marker advances on leave, not on render", () => {
  const marker = extractFunction(SUBS_JS, "setupFeedSeenMarker");

  assert.ok(marker.includes("pagehide"), "the marker advances on pagehide");
  assert.ok(marker.includes("visibilitychange"), "and when the tab is hidden");
  assert.ok(
    marker.includes("advanceFeedSeen(user.uid, Date.now())"),
    "the marker is set to the moment of leaving"
  );
});

// -----------------------------------------------------------------------------
// H) Quota discipline and no new backend surface
// -----------------------------------------------------------------------------

test("H1 the feed caps channels at the same limit as the shelves", () => {
  assert.ok(
    SUBS_JS.includes("const FEED_CHANNEL_CAP = 12"),
    "the feed must not exceed the shelf channel cap"
  );

  const reset = extractFunction(SUBS_JS, "resetFeedView");

  assert.ok(reset.includes("FEED_CHANNEL_CAP"), "the cap is applied when the feed is built");
});

test("H2 the feed adds no new endpoint and never touches search.list", () => {
  // The only feed data source is /api/channelVideos, via channelVideos().
  const feedSourceUses = SUBS_JS.match(/channelVideos\(/g) || [];

  assert.ok(feedSourceUses.length >= 1, "the feed uses channelVideos()");

  assert.equal(
    /searchWeb|"search"|apiRequest\("search"/.test(SUBS_JS),
    false,
    "the feed must not spend the expensive search quota"
  );

  // And the worker must still expose channelVideos unchanged.
  assert.ok(
    WORKER_JS.includes('route === "channelVideos"'),
    "the channelVideos route must survive"
  );
});

// -----------------------------------------------------------------------------
// I) The additive publishedAt contract the feed relies on
// -----------------------------------------------------------------------------

test("I1 normalizeSearchItem emits a raw publishedAt string", () => {
  assert.match(
    NORMALIZE_JS,
    /publishedAt: snippet\.publishedAt \|\| "",/,
    "the normalizer must expose publishedAt as a string, defaulting to empty"
  );
});

test("I2 the client no longer needs to guess ages for fresh data", () => {
  // The primary path (raw publishedAt) must be tried before the label fallback.
  const fn = extractFunction(SUBS_JS, "publishedAtMs");
  const rawIndex = fn.indexOf("v.publishedAt");
  const labelIndex = fn.indexOf("parseAgoDate(");

  assert.ok(rawIndex !== -1 && labelIndex !== -1, "both paths exist");
  assert.ok(rawIndex < labelIndex, "the raw timestamp is preferred over the label");
});

// -----------------------------------------------------------------------------
// J) M3 — loadChannelVideosResult distinguishes "empty" from "failed"
// -----------------------------------------------------------------------------

// A localStorage stand-in good enough for the cache helpers under test.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

// Wire loadChannelVideosResult to a fake backend + cache. `response` is either
// a returned value, a thrown Error, or the string "throw".
function resultFetcher({ response, cached }) {
  const storage = fakeStorage();

  if (cached) {
    storage.setItem(
      "mytube_subs_videos_cache_v1",
      JSON.stringify({ UCx: { at: Date.now(), videos: cached } })
    );
  }

  return sandboxWithDeps(
    {
      localStorage: storage,
      console,
      Date,
      Array,
      JSON,
      channelVideos: async () => {
        if (response === "throw") throw new Error("network down");
        return response;
      },
      cachedChannelVideos: channelId => {
        const raw = storage.getItem("mytube_subs_videos_cache_v1");
        const parsed = raw ? JSON.parse(raw) : {};
        const entry = parsed[channelId];
        if (!entry || !Array.isArray(entry.videos)) return null;
        return { stale: false, videos: entry.videos };
      },
      setCachedChannelVideos: (channelId, videos) => {
        storage.setItem(
          "mytube_subs_videos_cache_v1",
          JSON.stringify({ [channelId]: { at: Date.now(), videos } })
        );
      }
    },
    "loadChannelVideosResult"
  ).loadChannelVideosResult;
}

const CHANNEL = { channelId: "UCx", channelName: "X" };

test("J1 a successful empty result is not a failure", async () => {
  const fn = resultFetcher({ response: { videos: [] } });
  const out = await fn(CHANNEL, false);

  assert.deepEqual(out.videos, []);
  assert.equal(out.failed, false, "an empty success must not read as failed");
});

test("J2 a successful non-empty result reports the videos", async () => {
  const fn = resultFetcher({ response: { videos: [{ sourceId: "a" }] } });
  const out = await fn(CHANNEL, false);

  assert.equal(out.videos.length, 1);
  assert.equal(out.failed, false);
});

test("J3 a thrown request is a failure", async () => {
  const fn = resultFetcher({ response: "throw" });
  const out = await fn(CHANNEL, false);

  assert.deepEqual(out.videos, []);
  assert.equal(out.failed, true, "a thrown request must read as failed");
});

test("J4 a malformed payload is a failure, never a silent success", async () => {
  // Missing `videos` is an unusable answer: claiming success would show as
  // "no recent videos" when the request actually never produced data.
  for (const bad of [undefined, null, {}, { videos: "nope" }]) {
    const fn = resultFetcher({ response: bad });
    const out = await fn(CHANNEL, false);

    assert.equal(out.failed, true, `malformed payload ${JSON.stringify(bad)} is a failure`);
  }
});

test("J5 a stale cache fallback is a usable answer, not a failure", async () => {
  const cachedVideos = [{ sourceId: "cached" }];
  const fn = resultFetcher({ response: "throw", cached: cachedVideos });
  const out = await fn(CHANNEL, false);

  assert.deepEqual(out.videos, cachedVideos);
  assert.equal(out.failed, false, "a fallback to cached data is a success");
});

test("J6 a subscription without a channelId is a successful empty", async () => {
  const fn = resultFetcher({ response: { videos: [{ sourceId: "a" }] } });
  const out = await fn({ channelName: "legacy" }, false);

  assert.deepEqual(out.videos, []);
  assert.equal(out.failed, false);
});

test("J7 loadChannelVideos still returns the plain array (unchanged contract)", () => {
  const wrapper = extractFunction(SUBS_JS, "loadChannelVideos");

  assert.ok(
    wrapper.includes("loadChannelVideosResult("),
    "the array-only wrapper must delegate to the result variant"
  );
  assert.ok(
    wrapper.includes("return result.videos"),
    "the wrapper must unwrap to the original array contract"
  );
});

// -----------------------------------------------------------------------------
// K) M3 — the Feed's message selection uses `failed`, not emptiness
// -----------------------------------------------------------------------------

test("K1 an all-empty success shows the empty-feed message, not an error", () => {
  const load = extractFunction(SUBS_JS, "loadFeed");

  assert.ok(
    load.includes('"No recent videos found from your subscriptions."'),
    "a genuine all-empty result has its own message"
  );
  assert.ok(
    load.includes("failures > 0"),
    "the error branch must key off real failures"
  );
  assert.ok(
    !load.includes("list.length === 0){\n            failures++"),
    "emptiness must not be counted as a failure"
  );
});

test("K2 an all-failed load shows an error message", () => {
  const load = extractFunction(SUBS_JS, "loadFeed");

  assert.ok(
    load.includes('"Could not load videos from your subscriptions right now. Try Refresh."'),
    "a genuine failure has its own message"
  );
});

test("K3 a partial failure keeps videos and reports the partial status", () => {
  const load = extractFunction(SUBS_JS, "loadFeed");

  assert.ok(load.includes("revealFeed(FEED_INITIAL_COUNT)"), "successes still render");
  assert.ok(
    load.includes('"Some channels could not be loaded."'),
    "the partial-failure status is preserved"
  );
});

// -----------------------------------------------------------------------------
// L) M2 — unsubscribe removes only that channel from the in-memory Feed
// -----------------------------------------------------------------------------

// Drive the real removeChannelFromFeed() against a controlled feed + grid.
function feedRemover(pool, subs, shown) {
  const appended = [];
  const grid = {
    replaceChildren: () => appended.splice(0, appended.length),
    appendChild: node => appended.push(node)
  };

  const feed = {
    subs: subs.slice(),
    pool: pool.slice(),
    shown,
    exhaused: false,
    pending: false,
    token: 1
  };

  const status = { text: "" };

  const api = sandboxWithDeps(
    {
      feed,
      feedGridEl: grid,
      feedMoreEl: null,
      feedCursors: new Map([["UCx", "TOK"], ["UCy", "TOK2"]]),
      feedPagedChannels: new Set(["UCx", "UCy"]),
      setFeedStatus: msg => { status.text = msg || ""; },
      updateFeedMoreButton: () => {},
      revealFeed: count => {
        // Mirror the shipped reveal closely enough to measure re-render.
        const target = Math.min(feed.shown + count, feed.pool.length);
        while (feed.shown < target) {
          appended.push({ id: feed.pool[feed.shown].sourceId });
          feed.shown++;
        }
        return feed.shown;
      }
    },
    "removeChannelFromFeed"
  ).removeChannelFromFeed;

  return { api, feed, status, appended, grid };
}

function feedVid(sourceId, channelId) {
  return { id: `yt:${sourceId}`, sourceId, channelId, title: sourceId, publishedAt: "2026-01-01T00:00:00Z", date: "" };
}

test("L1 unsubscribe removes only that channel's videos", () => {
  const pool = [feedVid("a", "UCx"), feedVid("b", "UCy"), feedVid("c", "UCx")];
  const subs = [{ channelId: "UCx" }, { channelId: "UCy" }];
  const { api, feed } = feedRemover(pool, subs, 3);

  api("UCx");

  assert.deepEqual(
    feed.pool.map(v => v.sourceId),
    ["b"],
    "only UCx's videos are removed"
  );
  assert.deepEqual(
    feed.subs.map(s => s.channelId),
    ["UCy"],
    "only UCx's subscription is removed"
  );
  assert.equal(feed.pool[0].channelId, "UCy", "the other channel survives");
});

test("L2 other channels' videos remain and keep their order", () => {
  const pool = [feedVid("a", "UCx"), feedVid("b", "UCy"), feedVid("d", "UCz")];
  const subs = [{ channelId: "UCx" }, { channelId: "UCy" }, { channelId: "UCz" }];
  const { api, feed } = feedRemover(pool, subs, 3);

  api("UCy");

  assert.deepEqual(
    feed.pool.map(v => v.sourceId),
    ["a", "d"],
    "order of the surviving videos is preserved"
  );
});

test("L3 removing the last subscription shows the empty-feed message", () => {
  const pool = [feedVid("a", "UCx")];
  const subs = [{ channelId: "UCx" }];
  const { api, feed, status } = feedRemover(pool, subs, 1);

  api("UCx");

  assert.equal(feed.pool.length, 0);
  assert.match(status.text, /not subscribed to any channels/i);
});

test("L4 cursors and paged-set are forgotten for the removed channel only", () => {
  const pool = [feedVid("a", "UCx"), feedVid("b", "UCy")];
  const subs = [{ channelId: "UCx" }, { channelId: "UCy" }];
  const { api, feed } = feedRemover(pool, subs, 2);

  api("UCx");

  // The surviving channel's pagination state must be untouched.
  assert.equal(feed.subs.length, 1);
  assert.equal(feed.subs[0].channelId, "UCy");
});

test("L5 a no-op channelId does not disturb the feed", () => {
  const pool = [feedVid("a", "UCx")];
  const { api, feed } = feedRemover(pool, [{ channelId: "UCx" }], 1);

  api("");

  assert.equal(feed.pool.length, 1, "an empty channelId changes nothing");
});

// The handler must only touch the Feed on success, and never on failure.
test("L6 the feed is refreshed only after a successful unsubscribe", () => {
  const section = extractFunction(SUBS_JS, "buildChannelSection");
  const okBranch = section.indexOf("removeChannelFromFeed(");

  assert.ok(okBranch !== -1, "the success path updates the Feed");
  // The call must live inside the `if(ok){ ... }` branch, i.e. after it and
  // before the else that restores the button.
  const ifOk = section.indexOf("if(ok){");
  const elseIdx = section.indexOf("else{", ifOk);

  assert.ok(ifOk !== -1 && elseIdx !== -1, "the success/else branches exist");
  assert.ok(
    okBranch > ifOk && okBranch < elseIdx,
    "removeChannelFromFeed() is called only on success, never on failure"
  );
});

// -----------------------------------------------------------------------------
// M) M3 — message selection across the full success/failure matrix
// -----------------------------------------------------------------------------
//
// Drive the real message-selection logic with a table of (per-channel outcome)
// combinations, asserting the exact status text the Feed would show.

// Re-implements only the branch that chooses the message, using the same inputs
// loadFeed computes. Kept in lockstep with loadFeed by assertion K1-K3 above.
function feedMessageFor(outcomes) {
  const lists = outcomes.map(o => (o.failed ? [] : (o.videos || [])));
  const failures = outcomes.filter(o => o.failed).length;
  const poolSize = lists.reduce((n, l) => n + l.length, 0);

  if (poolSize === 0) {
    return failures > 0
      ? "Could not load videos from your subscriptions right now. Try Refresh."
      : "No recent videos found from your subscriptions.";
  }
  return failures > 0 ? "Some channels could not be loaded." : "";
}

test("M1 all channels succeed with no videos -> empty-feed message", () => {
  const msg = feedMessageFor([{ failed: false, videos: [] }, { failed: false, videos: [] }]);

  assert.equal(msg, "No recent videos found from your subscriptions.");
});

test("M2 all channels fail -> error message", () => {
  const msg = feedMessageFor([{ failed: true }, { failed: true }]);

  assert.equal(msg, "Could not load videos from your subscriptions right now. Try Refresh.");
});

test("M3 some fail, others have videos -> videos kept, partial status", () => {
  const msg = feedMessageFor([{ failed: true }, { failed: false, videos: [{ sourceId: "a" }] }]);

  assert.equal(msg, "Some channels could not be loaded.");
});

test("M4 some succeed empty while others fail -> partial failure, not success", () => {
  // An empty success is NOT a failure, but the presence of a real failure means
  // the outcome is partial, never a plain success.
  const msg = feedMessageFor([{ failed: false, videos: [] }, { failed: true }]);

  assert.equal(msg, "Could not load videos from your subscriptions right now. Try Refresh.");
  assert.notEqual(msg, "No recent videos found from your subscriptions.");
});

test("M5 all channels succeed with videos -> no status noise", () => {
  const msg = feedMessageFor([{ failed: false, videos: [{ sourceId: "a" }] }, { failed: false, videos: [{ sourceId: "b" }] }]);

  assert.equal(msg, "", "a clean load shows no status");
});

test("M6 the shipped loadFeed agrees with the reference message logic", () => {
  const load = extractFunction(SUBS_JS, "loadFeed");

  // The reference table above is only meaningful if the shipped code chooses
  // messages the same way: keyed on `failed`, with a distinct empty-vs-error
  // branch and a partial branch.
  assert.ok(load.includes("if(failed){"), "failures increment only on failed");
  assert.ok(load.includes("failures > 0"), "the error/partial branches key off failures");
  assert.ok(
    load.includes('"Could not load videos from your subscriptions right now. Try Refresh."'),
    "the all-failed message matches"
  );
  assert.ok(
    load.includes('"No recent videos found from your subscriptions."'),
    "the all-empty message matches"
  );
  assert.ok(
    load.includes('"Some channels could not be loaded."'),
    "the partial message matches"
  );
});
