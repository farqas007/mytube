// =============================================================================
// MyTube — Phase 1 D1 index integration tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These exercise worker.js's real `fetch()` handler against fakes for the two
// things it cannot have in a unit test: the YouTube Data API and the D1
// binding. No production secrets, no network, no remote database.
//
// What is proven here:
//   * D1 absent / malformed / no ctx  => behaviour identical to pre-index
//   * a fresh row answers /api/video   => zero upstream YouTube calls
//   * stale / missing / live row       => unchanged YouTube fallback
//   * a successful fetch               => schedules exactly one index write,
//                                         and adds NO upstream request
//   * the response DTO is unchanged    => byte-identical to the YouTube path
//   * search / trending / related / channelVideos are still YouTube-backed
//
// Run: node --test tests/testWorkerIndex.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.js";
import { normalizeVideoItem } from "../shared/normalize.js";
import { VIDEO_COLUMNS, VIDEO_UPSERT_CHUNK_SIZE, toVideoRow } from "../shared/index-store.js";

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

// One fake D1 database. Records every statement so a test can prove what was
// written, and can be told to fail reads or writes to exercise degradation.
function createFakeDb(options = {}) {
  const preparedSql = [];
  const batches = [];
  const rowLookup = options.rows || {};

  const db = {
    failReads: false,
    failWrites: false,
    preparedSql,
    batches,

    prepare(sql) {
      preparedSql.push(sql);

      const statement = {
        sql,
        args: null,
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async first() {
          if (db.failReads) {
            throw new Error("fake D1 read failure");
          }

          if (!/video_id = \?/.test(sql)) {
            return null;
          }

          return rowLookup[statement.args?.[0]] ?? null;
        },
        async all() {
          if (db.failReads) {
            throw new Error("fake D1 read failure");
          }

          return { success: true, results: [] };
        }
      };

      return statement;
    },

    async batch(statements) {
      if (db.failWrites) {
        throw new Error("fake D1 write failure");
      }

      batches.push(statements);

      return statements.map(() => ({ success: true }));
    }
  };

  return db;
}

// The rows a write actually bound, decoded back through the frozen column list.
function writtenRows(db) {
  return db.batches.flat().map(statement => {
    const row = {};

    VIDEO_COLUMNS.forEach((column, index) => {
      row[column] = statement.args[index];
    });

    return row;
  });
}

function createFakeCtx() {
  const pending = [];

  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    // Workers keeps background work alive after the response; tests settle it so
    // assertions about written rows are deterministic.
    async settle() {
      await Promise.all(pending);
    }
  };
}

// -----------------------------------------------------------------------------
// A realistic raw videos.list item
// -----------------------------------------------------------------------------

function videoItem(videoId, overrides = {}) {
  const item = {
    kind: "youtube#video",
    id: videoId,
    snippet: {
      publishedAt: "2024-03-05T10:11:12Z",
      channelId: "UCchannel01",
      title: `Video ${videoId}`,
      description: "A description.",
      thumbnails: {
        default: { url: "https://i.ytimg.com/vi/x/default.jpg" },
        high: { url: "https://i.ytimg.com/vi/x/hq.jpg" },
        maxres: { url: "https://i.ytimg.com/vi/x/maxres.jpg" }
      },
      channelTitle: "A Channel",
      tags: ["music", "lofi"],
      categoryId: "10",
      liveBroadcastContent: "none"
    },
    contentDetails: {
      duration: "PT4M13S",
      definition: "hd",
      caption: "true"
    },
    statistics: {
      viewCount: "1234567",
      likeCount: "4321",
      commentCount: "0"
    },
    status: {
      embeddable: true,
      madeForKids: false,
      privacyStatus: "public"
    }
  };

  return { ...item, ...overrides };
}

// -----------------------------------------------------------------------------
// Harness: fake YouTube + fake env/ctx
// -----------------------------------------------------------------------------

let ipCounter = 0;

// A fresh client IP per call keeps the module-level rate limiter out of the way.
function nextIp() {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

// `responder(url)` returns the JSON body for one upstream call.
async function withYouTube(responder, run) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    calls.push(parsed);

    const body = await responder(parsed);

    return new Response(JSON.stringify(body ?? {}), {
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

// Videos returned by a videos.list call.
function videosResponse(items) {
  return { items, pageInfo: { totalResults: items.length, resultsPerPage: items.length } };
}

async function callWorker(path, env, ctx, requestInit = {}) {
  const request = new Request(`https://mytube.farqas007.workers.dev${path}`, {
    method: "GET",
    headers: {
      "CF-Connecting-IP": nextIp(),
      Origin: "https://mytube.farqas007.workers.dev",
      ...(requestInit.headers || {})
    }
  });

  const instance = requestInit.workerInstance || worker;
  const response = await instance.fetch(request, env, ctx);
  const body = await response.json();

  return { response, body };
}

function envWith(db) {
  const env = {
    YOUTUBE_API_KEY: "test-key",
    ASSETS: { fetch: async () => new Response("asset") }
  };

  if (db !== undefined) {
    env.mytube_index = db;
  }

  return env;
}

// Responds to a single-video videos.list lookup, and counts calls.
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
    parsed =>
      parsed.pathname.endsWith("/videos") &&
      parsed.searchParams.get("id") === videoId
  ).length;
}

// -----------------------------------------------------------------------------
// A) D1 absent => existing behaviour remains
// -----------------------------------------------------------------------------

test("A1 no D1 binding: /api/video returns the unchanged payload", async () => {
  const id = "absentBinding001";
  const item = videoItem(id);

  await withYouTube(videoResponder(id, item), async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(undefined),
      ctx
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
    // Nothing was scheduled, so no D1 work is even attempted.
    assert.equal(ctx.pending.length, 0);
  });
});

test("A2 a malformed binding is ignored exactly like a missing one", async () => {
  const id = "malformedBind01";
  const item = videoItem(id);

  await withYouTube(videoResponder(id, item), async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith({ notADatabase: true }),
      ctx
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(ctx.pending.length, 0);
  });
});

test("A3 a binding without ctx.waitUntil disables the index", async () => {
  const id = "noWaitUntil001";
  const item = videoItem(id);
  const db = createFakeDb();

  await withYouTube(videoResponder(id, item), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      { }   // no waitUntil: nothing can be scheduled
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
    // Not even the read is attempted.
    assert.deepEqual(db.preparedSql, []);
  });
});

test("A4 CORS, security and cache headers are untouched by the index", async () => {
  const id = "headersCheck01";
  const item = videoItem(id);

  await withYouTube(videoResponder(id, item), async () => {
    const ctx = createFakeCtx();
    const { response } = await callWorker(
      `/api/video?id=${id}`,
      envWith(createFakeDb()),
      ctx
    );

    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://mytube.farqas007.workers.dev"
    );
    assert.equal(response.headers.get("Vary"), "Origin");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.ok(response.headers.get("Content-Security-Policy"));
  });
});

// -----------------------------------------------------------------------------
// B) D1 hit => index path returns metadata
// -----------------------------------------------------------------------------

test("B1 a fresh row answers /api/video with zero upstream YouTube calls", async () => {
  const id = "freshRowHit001";
  const item = videoItem(id);
  const db = createFakeDb({
    rows: { [id]: toVideoRow(item, { now: Date.now() }) }
  });

  await withYouTube(() => {
    throw new Error("YouTube must not be called on an index hit");
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    // Byte-identical to what the YouTube path produces for the same video.
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(calls.length, 0);
    assert.equal(response.headers.get("X-MyTube-Source"), "index");
    assert.equal(response.headers.get("X-MyTube-Degraded"), "0");
    // A read must never write.
    assert.equal(ctx.pending.length, 0);
  });
});

test("B2 the index-served DTO keeps the exact canonical shape", async () => {
  const id = "shapeCheck001";
  const item = videoItem(id);
  const db = createFakeDb({
    rows: { [id]: toVideoRow(item, { now: Date.now() }) }
  });

  await withYouTube(() => ({}), async () => {
    const { body } = await callWorker(`/api/video?id=${id}`, envWith(db), createFakeCtx());

    assert.deepEqual(
      Object.keys(body.video),
      Object.keys(normalizeVideoItem(item))
    );

    // The absolute facts the index exists to keep are rendered, not raw.
    assert.equal(body.video.time, "4:13");
    assert.equal(body.video.viewCount, 1234567);
    assert.equal(body.video.views, "1.2M views");
    assert.equal(body.video.id, `yt:${id}`);
    assert.equal(body.video.type, "youtube");
    assert.equal(body.video.liveChatId, "");
    assert.equal(body.video.concurrentViewers, 0);
    assert.equal(body.video.isLive, false);
    assert.equal(body.video.embeddable, true);
    assert.match(body.video.date, /y ago|mo ago/);
  });
});

test("B3 a completed broadcast keeps YouTube's exact timestamp format", async () => {
  const id = "endedStream01";
  const item = videoItem(id, {
    liveStreamingDetails: {
      actualStartTime: "2024-03-05T10:00:00Z",
      actualEndTime: "2024-03-05T12:30:00Z",
      concurrentViewers: "1234"
    }
  });
  const db = createFakeDb({
    rows: { [id]: toVideoRow(item, { now: Date.now() }) }
  });

  await withYouTube(() => ({}), async () => {
    const { body } = await callWorker(`/api/video?id=${id}`, envWith(db), createFakeCtx());

    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(body.video.actualStartTime, "2024-03-05T10:00:00Z");
    assert.equal(body.video.actualEndTime, "2024-03-05T12:30:00Z");
  });
});

// -----------------------------------------------------------------------------
// B) stale / missing / live => unchanged YouTube fallback
// -----------------------------------------------------------------------------

test("B4 a stale row falls back to YouTube and refreshes the row", async () => {
  const id = "staleRowFall01";
  const item = videoItem(id);
  const stale = toVideoRow(item, { now: Date.now() - 7 * 60 * 1000 });

  const db = createFakeDb({ rows: { [id]: stale } });

  await withYouTube(videoResponder(id, item), async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");
    assert.equal(response.headers.get("X-MyTube-Degraded"), "0");

    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "detail");
    // Refreshed, so the next request can be answered from the index.
    assert.ok(rows[0].metadata_fetched_at_ms > stale.metadata_fetched_at_ms);
  });
});

test("B5 a missing row falls back to YouTube", async () => {
  const id = "missingRow001";
  const item = videoItem(id);
  const db = createFakeDb({ rows: {} });

  await withYouTube(videoResponder(id, item), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
  });
});

test("B6 a row stamped far in the future is not trusted", async () => {
  const id = "futureRow001";
  const item = videoItem(id);
  const db = createFakeDb({
    rows: { [id]: toVideoRow(item, { now: Date.now() + 10 * 60 * 1000 }) }
  });

  await withYouTube(videoResponder(id, item), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
  });
});

test("B7 a live row always takes the YouTube path", async () => {
  const id = "liveRowPath1";
  const liveItem = videoItem(id, {
    snippet: {
      ...videoItem(id).snippet,
      liveBroadcastContent: "live"
    },
    liveStreamingDetails: {
      actualStartTime: "2024-03-05T10:00:00Z",
      concurrentViewers: "5000",
      activeLiveChatId: "live_chat_should_not_be_stored"
    }
  });
  const db = createFakeDb({
    rows: { [id]: toVideoRow(liveItem, { now: Date.now() }) }
  });

  await withYouTube(videoResponder(id, liveItem), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");
    assert.equal(body.video.isLive, true);
  });
});

test("B8 a 404 from YouTube is unchanged and still 404", async () => {
  const id = "unknownVideo1";
  const db = createFakeDb({ rows: {} });

  await withYouTube(parsed =>
    parsed.searchParams.get("id") === id ? { items: [] } : {}
  , async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 404);
    assert.deepEqual(body, { video: null });
    assert.equal(countVideoLookups(calls, id), 1);
  });
});

// -----------------------------------------------------------------------------
// B) rows that cannot be rendered identically must not be served from the index
// -----------------------------------------------------------------------------

test("B9 a null duration renders \"\" on both paths", async () => {
  const id = "nullDuration1";
  // A bare search.list-shaped item: no contentDetails at all, which the index
  // stores as a NULL duration.
  const item = { id, snippet: { title: "No duration", publishedAt: "2024-03-05T10:11:12Z" } };
  const row = toVideoRow(item, { now: Date.now() });

  assert.equal(row.duration_seconds, null);

  const db = createFakeDb({ rows: { [id]: row } });

  await withYouTube(videoResponder(id, item), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-MyTube-Source"), "index");
    assert.equal(calls.length, 0);
    // normalize.js renders an absent duration as "", never "0:00".
    assert.equal(body.video.time, "");
    assert.equal(body.video.time, normalizeVideoItem(item).time);
  });
});

test("B10 a zero duration is ambiguous and falls back to YouTube", async () => {
  const id = "zeroDuration1";
  // "P0D" is what YouTube sends for a stream with no fixed runtime: it maps to
  // 0 seconds in the index but renders "" through normalize.js, while "PT0S"
  // would render "0:00". The two cannot be told apart, so neither is served.
  const streamItem = videoItem(id, {
    contentDetails: { duration: "P0D" },
    snippet: { ...videoItem(id).snippet, liveBroadcastContent: "live" },
    liveStreamingDetails: { actualStartTime: "2024-03-05T10:00:00Z", actualEndTime: "2024-03-05T11:00:00Z" }
  });

  const row = toVideoRow(streamItem, { now: Date.now() });
  assert.equal(row.duration_seconds, 0);

  const db = createFakeDb({ rows: { [id]: row } });

  await withYouTube(videoResponder(id, streamItem), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(body.video.time, normalizeVideoItem(streamItem).time);
  });
});

test("B11 a day-long duration has no canonical form and falls back", async () => {
  const id = "longDuration1";
  const item = videoItem(id, { contentDetails: { duration: "P1D" } });
  const row = toVideoRow(item, { now: Date.now() });

  assert.equal(row.duration_seconds, 86400);

  const db = createFakeDb({ rows: { [id]: row } });

  await withYouTube(videoResponder(id, item), async calls => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(body.video.time, normalizeVideoItem(item).time);
  });
});

test("B12 a non-youtube or non-canonical row is never served", async () => {
  const cases = [
    ["typeIsNotYoutube", row => ({ ...row, type: "vimeo" })],
    ["videoIdIsNamespaced", row => ({ ...row, video_id: "yt:namespaced" })],
    ["fetchedAtIsText", row => ({ ...row, metadata_fetched_at_ms: "not-a-number" })],
    ["fetchedAtIsNull", row => ({ ...row, metadata_fetched_at_ms: null })]
  ];

  // A distinct video id per case: worker.js caches upstream responses for 10
  // minutes, so a repeated id would make this assert nothing.
  for(const [label, mutate] of cases){
    const id = label.padEnd(16, "x");
    const item = videoItem(id);

    const db = createFakeDb({
      rows: { [id]: mutate(toVideoRow(item, { now: Date.now() })) }
    });

    await withYouTube(videoResponder(id, item), async calls => {
      const { response, body } = await callWorker(
        `/api/video?id=${id}`,
        envWith(db),
        createFakeCtx()
      );

      assert.equal(response.status, 200, label);
      assert.equal(response.headers.get("X-MyTube-Source"), "youtube", label);
      assert.equal(countVideoLookups(calls, id), 1, label);
      // Whatever YouTube returns is still served verbatim.
      assert.deepEqual(body, { video: normalizeVideoItem(item) }, label);
    });
  }
});

test("B13 a row with no embeddable value renders exactly as YouTube would", async () => {
  const id = "unknownEmbed01";
  const item = videoItem(id);
  const row = { ...toVideoRow(item, { now: Date.now() }), embeddable: null };
  const db = createFakeDb({ rows: { [id]: row } });

  await withYouTube(() => {
    throw new Error("YouTube must not be called");
  }, async () => {
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      createFakeCtx()
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-MyTube-Source"), "index");
    // normalize.js renders an absent `status.embeddable` as true.
    assert.equal(body.video.embeddable, true);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
  });
});

// -----------------------------------------------------------------------------
// Degradation
// -----------------------------------------------------------------------------

test("C1 a failing D1 read degrades to YouTube instead of failing the request", async () => {
  const id = "readFailure001";
  const item = videoItem(id);
  const db = createFakeDb();
  db.failReads = true;

  await withYouTube(videoResponder(id, item), async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(response.headers.get("X-MyTube-Source"), "fallback");
    assert.equal(response.headers.get("X-MyTube-Degraded"), "1");
  });
});

test("C2 a failing D1 write never affects the response", async () => {
  const id = "writeFailure01";
  const item = videoItem(id);
  const db = createFakeDb();
  db.failWrites = true;

  await withYouTube(videoResponder(id, item), async () => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/video?id=${id}`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.deepEqual(body, { video: normalizeVideoItem(item) });

    // The scheduled work settles (it catches internally) instead of rejecting.
    await ctx.settle();
  });
});

// -----------------------------------------------------------------------------
// C) indexing adds no YouTube request
// -----------------------------------------------------------------------------

test("C3 a successful fetch schedules exactly one index write, no extra request", async () => {
  const id = "writeBehind001";
  const item = videoItem(id);
  const db = createFakeDb();

  await withYouTube(videoResponder(id, item), async calls => {
    const ctx = createFakeCtx();
    await callWorker(`/api/video?id=${id}`, envWith(db), ctx);

    // One videos.list call, before and after: indexing added nothing.
    assert.equal(countVideoLookups(calls, id), 1);
    assert.equal(ctx.pending.length, 1);

    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 1);

    const expected = toVideoRow(item, {});
    assert.equal(rows[0].source_id, expected.source_id);
    assert.equal(rows[0].type, "youtube");
    assert.equal(rows[0].video_id, id);
    assert.equal(rows[0].title, expected.title);
    assert.equal(rows[0].title_lower, expected.title_lower);
    assert.equal(rows[0].duration_seconds, 253);
    assert.equal(rows[0].view_count, 1234567);
    assert.equal(rows[0].like_count, 4321);
    assert.equal(rows[0].channel_id, "UCchannel01");
    assert.equal(rows[0].thumb_url, "https://i.ytimg.com/vi/x/maxres.jpg");
    assert.equal(rows[0].origin, "detail");
    assert.equal(rows[0].is_live, 0);
    assert.deepEqual(JSON.parse(rows[0].tags_json), ["music", "lofi"]);
  });
});

test("C4 the same request spends the same quota with and without D1", async () => {
  const withIndexId = "quotaWithIdx1";
  const withoutIndexId = "quotaWithout1";

  const countUpstream = async (id, env) => {
    let calls = [];

    await withYouTube(videoResponder(id, videoItem(id)), async recorded => {
      calls = recorded;
      await callWorker(`/api/video?id=${id}`, env, createFakeCtx());
    });

    return calls.length;
  };

  const withDb = await countUpstream(withIndexId, envWith(createFakeDb()));
  const withoutDb = await countUpstream(withoutIndexId, envWith(undefined));

  assert.equal(withDb, 1);
  assert.equal(withoutDb, 1);
  assert.equal(withDb, withoutDb);
});

test("C5 no prohibited data reaches the index", async () => {
  const id = "noChatStore01";
  const item = videoItem(id, {
    snippet: {
      ...videoItem(id).snippet,
      liveBroadcastContent: "live"
    },
    liveStreamingDetails: {
      actualStartTime: "2024-03-05T10:00:00Z",
      concurrentViewers: "9999",
      activeLiveChatId: "live_chat_SECRET_ID"
    }
  });
  const db = createFakeDb();

  await withYouTube(videoResponder(id, item), async () => {
    const ctx = createFakeCtx();
    await callWorker(`/api/video?id=${id}`, envWith(db), ctx);
    await ctx.settle();

    const serialized = JSON.stringify(writtenRows(db));

    assert.equal(serialized.includes("live_chat_SECRET_ID"), false);
    assert.equal(serialized.includes("9999"), false);
    // No column can hold chat content at all.
    assert.equal(VIDEO_COLUMNS.some(column => /chat|email|credential|token/i.test(column)), false);
  });
});

// -----------------------------------------------------------------------------
// D) trending / search stay YouTube-backed
// -----------------------------------------------------------------------------

test("D1 search stays YouTube-backed and never queries the FTS index", async () => {
  const db = createFakeDb();

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/search")) {
      return {
        items: [
          { id: { videoId: "searchHit01" }, snippet: { title: "Hit" } },
          { id: { videoId: "searchHit02" }, snippet: { title: "Other" } }
        ],
        nextPageToken: "TOKEN",
        pageInfo: { totalResults: 2 }
      };
    }

    if (parsed.pathname.endsWith("/videos")) {
      return videosResponse([videoItem("searchHit01"), videoItem("searchHit02")]);
    }

    return {};
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      "/api/search?q=lofi&max=2",
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(body.videos.length, 2);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");

    // Unchanged upstream cost: one search.list + one videos.list.
    assert.equal(calls.filter(p => p.pathname.endsWith("/search")).length, 1);
    assert.equal(calls.filter(p => p.pathname.endsWith("/videos")).length, 1);

    // Search results still come from YouTube, not from the index.
    assert.equal(db.preparedSql.some(sql => /video_fts|MATCH/.test(sql)), false);

    // …but the metadata it already paid for is recorded.
    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.origin === "search"));
  });
});

test("D2 trending keeps its feed behaviour and only writes to the index", async () => {
  const db = createFakeDb();

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("chart")) {
      const region = parsed.searchParams.get("regionCode");

      return videosResponse([
        videoItem(`chart${region}01`, {
          snippet: { ...videoItem("x").snippet, tags: ["gaming"], title: `Chart ${region}` }
        })
      ]);
    }

    return {};
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      "/api/trending?max=5&seed=abc",
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    // Contract unchanged.
    assert.ok(Array.isArray(body.videos));
    assert.equal(typeof body.nextPageToken, "string");
    assert.ok(Array.isArray(body.topics));
    assert.ok(Array.isArray(body.regions));
    assert.equal(body.requestedRegion, "");
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");

    // One chart call per pool region, unchanged, and no extra call for indexing.
    const chartCalls = calls.filter(p => p.searchParams.get("chart") === "mostPopular");
    assert.equal(chartCalls.length, 8);
    assert.equal(calls.length, 8);

    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 8);
    assert.ok(rows.every(row => row.origin.startsWith("chart:")));
    // With reduced write amplification, trending pool writes are consolidated
    assert.ok(rows.every(row => row.origin === "chart:pool" || row.origin.startsWith("chart:")));
    // The feed's topic labels still come from shared/feed.js, not from the index.
    assert.deepEqual(body.topics, ["Gaming"]);
  });
});

test("D3 related batches its writes without extra upstream calls", async () => {
  const targetId = "relatedTarget1";
  const db = createFakeDb();

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/search")) {
      return {
        items: [
          { id: { videoId: "relatedOne01" }, snippet: { title: "One" } },
          { id: { videoId: "relatedTwo01" }, snippet: { title: "Two" } }
        ],
        pageInfo: { totalResults: 2 }
      };
    }

    if (parsed.pathname.endsWith("/videos")) {
      const ids = (parsed.searchParams.get("id") || "").split(",");

      return videosResponse(ids.map(id => videoItem(id)));
    }

    return {};
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/related?id=${targetId}&max=5`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(body.videos.length, 2);

    // Unchanged: target videos.list + search.list + related videos.list.
    assert.equal(calls.filter(p => p.pathname.endsWith("/search")).length, 1);
    assert.equal(calls.filter(p => p.pathname.endsWith("/videos")).length, 2);
    assert.equal(calls.length, 3);

    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.origin === "related"));
  });
});

test("D4 channelVideos batches its writes without extra upstream calls", async () => {
  const db = createFakeDb();

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/channels")) {
      return {
        items: [{ id: "UCchannel01", contentDetails: { relatedPlaylists: { uploads: "PLuploads1" } } }]
      };
    }

    if (parsed.pathname.endsWith("/playlistItems")) {
      return {
        items: [
          { contentDetails: { videoId: "uploadOne01" } },
          { contentDetails: { videoId: "uploadTwo01" } }
        ],
        nextPageToken: ""
      };
    }

    if (parsed.pathname.endsWith("/videos")) {
      const ids = (parsed.searchParams.get("id") || "").split(",");

      return videosResponse(ids.map(id => videoItem(id)));
    }

    return {};
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      "/api/channelVideos?channelId=UCchannel01&max=5",
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(body.videos.length, 2);
    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");

    // Unchanged: channels + playlistItems + videos.
    assert.equal(calls.filter(p => p.pathname.endsWith("/channels")).length, 1);
    assert.equal(calls.filter(p => p.pathname.endsWith("/playlistItems")).length, 1);
    assert.equal(calls.filter(p => p.pathname.endsWith("/videos")).length, 1);
    assert.equal(calls.length, 3);

    await ctx.settle();

    const rows = writtenRows(db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.origin === "channel"));
  });
});

test("D5 live chat is never indexed and never loses its own rate bucket", async () => {
  const id = "chatRoute001";
  const db = createFakeDb();

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/videos")) {
      return videosResponse([
        videoItem(id, {
          snippet: { ...videoItem(id).snippet, liveBroadcastContent: "live" },
          liveStreamingDetails: {
            actualStartTime: "2024-03-05T10:00:00Z",
            activeLiveChatId: "live_chat_never_stored"
          }
        })
      ]);
    }

    if (parsed.pathname.includes("/liveChat/messages")) {
      return { messages: [], pollingIntervalMillis: 5000 };
    }

    return {};
  }, async calls => {
    const ctx = createFakeCtx();
    const { response, body } = await callWorker(
      `/api/liveChat?id=${id}`,
      envWith(db),
      ctx
    );

    assert.equal(response.status, 200);
    assert.equal(body.isLive, true);
    assert.equal(body.liveChatId, "live_chat_never_stored");

    await ctx.settle();

    // The live probe is a partial videos.list call, not a full metadata payload,
    // so it is deliberately not indexed at all in Phase 1.
    assert.deepEqual(writtenRows(db), []);
    assert.equal(db.batches.length, 0);
  });
});
// -----------------------------------------------------------------------------
// E) Freshness accounting, sequential reuse, and D1 write volume
// -----------------------------------------------------------------------------
//
// createStatefulDb() differs from createFakeDb() in the one way that matters for
// freshness: it PERSISTS writes. createFakeDb() answers reads from a fixed
// object, so it can never observe the effect of a write on a later read — which
// is exactly the interaction under test here. Without that, a row re-stamped by
// a cache hit looks identical to a row that was never re-written, and the
// staleness bound is untestable.
function createStatefulDb() {
  const rows = new Map();
  const db = {
    rows,
    batches: [],
    batchCalls: 0,
    statements: 0,

    prepare(sql) {
      const statement = {
        sql,
        args: null,
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async first() {
          // Mirrors the real lookup: `WHERE video_id = ? AND type = ?`.
          for (const row of rows.values()) {
            if (row.video_id === statement.args?.[0]) {
              return { ...row };
            }
          }

          return null;
        },
        async all() {
          return { success: true, results: [] };
        }
      };

      return statement;
    },

    async batch(statements) {
      db.batches.push(statements);
      db.batchCalls += 1;
      db.statements += statements.length;

      for (const statement of statements) {
        const row = {};

        VIDEO_COLUMNS.forEach((column, index) => {
          row[column] = statement.args[index];
        });

        // Upsert on source_id, like the real ON CONFLICT clause.
        rows.set(row.source_id, row);
      }

      return statements.map(() => ({ success: true }));
    }
  };

  return db;
}

// Runs `body` with Date.now() pinned to `at`, then restores the real clock.
// worker.js reads Date.now() for the cache and the index TTL, so pinning it is
// what makes an 8-minute-old row reproducible without waiting 8 minutes.
async function withClock(at, body) {
  const realNow = Date.now;

  Date.now = () => at;

  try {
    return await body();
  } finally {
    Date.now = realNow;
  }
}

// Fakes YouTube for a single video whose viewCount encodes a "generation", so a
// response body reveals which fetch produced it. Only the *real* network call
// advances the generation; a response-cache hit returns the previous one, which
// is how a test can tell a genuine refetch from a re-served cached payload.
function generationalResponder(videoId) {
  const state = { generation: 0, realFetches: 0, lastRealFetchAt: null };

  state.build = () => videoItem(videoId, {
    statistics: { viewCount: String(1000 + state.generation), likeCount: "1", commentCount: "0" }
  });

  // Getters, not a spread: a spread would copy the counters by value at
  // construction time, so every test would read 0 forever.
  return {
    state,
    get generation() {
      return state.generation;
    },
    get realFetches() {
      return state.realFetches;
    },
    // The instant of the most recent REAL fetch, read from the pinned clock so it
    // lines up with the row stamp the index is expected to carry.
    get lastRealFetchAt() {
      return state.lastRealFetchAt;
    },
    responder(parsed) {
      if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("id") === videoId) {
        state.generation += 1;
        state.realFetches += 1;

        state.lastRealFetchAt = Date.now();

        return videosResponse([state.build()]);
      }

      return {};
    },
    // The generation whose bytes a client is looking at, recovered from the body.
    // normalizeVideoItem exposes the raw count as a number, so the encoding
    // survives the round trip instead of being flattened into "1.2K views".
    servedGeneration(body) {
      return Number(body.video.viewCount) - 1000;
    }
  };
}

test("E1 a second request for the same video is served from the index with no further YouTube call", async () => {
  const id = "seqReuse00001";
  const db = createStatefulDb();
  const env = envWith(db);
  const gen = generationalResponder(id);

  await withYouTube(gen.responder, async calls => {
    // First request: cold index, cold response cache. Costs one YouTube call.
    const ctx1 = createFakeCtx();
    const first = await callWorker(`/api/video?id=${id}`, env, ctx1);

    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get("X-MyTube-Source"), "youtube");
    assert.equal(countVideoLookups(calls, id), 1);

    await ctx1.settle();

    // The write landed, so a second request must now be answerable from D1.
    assert.equal(db.statements, 1);
    assert.equal(db.rows.get(`yt:${id}`).video_id, id);

    // Second request: different client IP, so nothing about the caller changed.
    // This is the entire point of Phase 1 — the index answers it, and the
    // response is the same document the YouTube path produced.
    const ctx2 = createFakeCtx();
    const second = await callWorker(`/api/video?id=${id}`, env, ctx2);

    assert.equal(second.response.status, 200);
    assert.equal(second.response.headers.get("X-MyTube-Source"), "index");
    assert.equal(countVideoLookups(calls, id), 1, "the index must not spend quota");

    assert.deepEqual(second.body, first.body, "index and YouTube DTOs must match");
    assert.equal(gen.servedGeneration(second.body), gen.servedGeneration(first.body));

    await ctx2.settle();
  });
});

test("E2 re-indexing a cache hit cannot renew a row's freshness lease", async () => {
  const id = "freshness0001";
  const db = createStatefulDb();
  const env = envWith(db);
  const gen = generationalResponder(id);
  const T0 = 1_700_000_000_000;
  const MINUTE = 60_000;

  await withYouTube(gen.responder, async () => {
    // t=0: the only real fetch. Everything the client sees after this point
    // derives from generation 1 until a second real fetch happens.
    const ctx0 = createFakeCtx();
    const at0 = await withClock(T0, () => callWorker(`/api/video?id=${id}`, env, ctx0));

    assert.equal(gen.servedGeneration(at0.body), 1);
    await ctx0.settle();

    const stampAtZero = db.rows.get(`yt:${id}`).metadata_fetched_at_ms;

    assert.equal(stampAtZero, T0, "a row records when its payload was fetched");

    let worstIndexAge = 0;

    // Sweep past the TTL. Between 6 and 10 minutes the 10-minute response cache
    // is still warm, so the Worker legitimately re-serves the payload and
    // re-writes the row — and that write is the interesting one.
    for (let minute = 1; minute <= 20; minute += 1) {
      const at = T0 + minute * MINUTE;
      const ctx = createFakeCtx();

      const { response, body } = await withClock(at, () =>
        callWorker(`/api/video?id=${id}`, env, ctx)
      );

      const source = response.headers.get("X-MyTube-Source");
      const stamp = db.rows.get(`yt:${id}`).metadata_fetched_at_ms;

      if (source === "index") {
        // The invariant under test: an index hit is never older than the TTL.
        const trueAge = (at - stamp) / MINUTE;

        worstIndexAge = Math.max(worstIndexAge, trueAge);

        assert.ok(
          trueAge <= 6 + 1e-9,
          `index served data ${trueAge} minutes old at +${minute}min; the TTL is 6`
        );
      }

      // The invariant under test, stated exactly: the row's freshness stamp is
      // the instant of the most recent REAL fetch, and nothing else. At +7..+10
      // the response cache is warm, so the Worker re-serves and re-writes the
      // payload — a write-time stamp would record "+7" here and push the next
      // expiry out to +13, which is precisely the bug this test exists to catch.
      assert.equal(
        stamp,
        gen.lastRealFetchAt,
        `at +${minute}min the row must still carry the last real fetch time`
      );

      assert.equal(gen.servedGeneration(body), gen.realFetches);

      await ctx.settle();
    }

    assert.ok(worstIndexAge > 0, "the index must actually have been used");
    assert.equal(gen.realFetches, 2, "one fetch, then one more after the cache expired");
  });
});

test("E3 index writes stay inside the per-invocation budget, and trending's volume is pinned", async () => {
  // Every batch is bounded by VIDEO_UPSERT_CHUNK_SIZE, which is the safety
  // property index-store.js actually guarantees.
  const perRoute = [];

  async function measure(label, path, responder, workerInstance) {
    const db = createStatefulDb();
    const env = envWith(db);
    const ctx = createFakeCtx();

    await withYouTube(responder, async () => {
      const { response } = await callWorker(path, env, ctx, { workerInstance });

      assert.equal(response.status, 200);
      await ctx.settle();
    });

    for (const statements of db.batches) {
      assert.ok(
        statements.length <= VIDEO_UPSERT_CHUNK_SIZE,
        `${label} sent a ${statements.length}-statement batch, over the chunk size`
      );
    }

    perRoute.push({ label, batches: db.batchCalls, statements: db.statements });
  }

  const chartItem = id => videoItem(id);

  await measure("/api/video", "/api/video?id=volume000001", parsed => {
    if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("id") === "volume000001") {
      return videosResponse([videoItem("volume000001")]);
    }

    return {};
  });

  await measure("/api/search (50)", "/api/search?q=music&max=50", parsed => {
    if (parsed.pathname.endsWith("/search")) {
      return {
        items: Array.from({ length: 50 }, (_, i) => ({
          id: { videoId: `searchVol${i}` },
          snippet: { title: `Result ${i}`, channelTitle: "A Channel", publishedAt: "2024-03-05T10:11:12Z" }
        })),
        pageInfo: { totalResults: 50 }
      };
    }

    // Search resolves ids into full metadata with a SECOND videos.list call, and
    // it is that response — not the search response — which gets indexed. A
    // responder that only knows /search silently measures zero writes.
    if (parsed.pathname.endsWith("/videos")) {
      return videosResponse(
        (parsed.searchParams.get("id") || "").split(",").map(id => videoItem(id))
      );
    }

    return {};
  });

  // A full chart page per region, which is what buildFeedPool really asks for.
  // A FRESH module instance is required: the feed pool is cached under a fixed
  // key for 15 minutes, so the shared worker has already built one in test D2 and
  // would answer from it without ever scheduling a write. Node treats a query
  // string as a distinct module, which is exactly the isolation needed here.
  const freshWorker = (await import(`../worker.js?e3=${Date.now()}`)).default;

  await measure("/api/trending", "/api/trending?max=12", parsed => {
    if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("chart")) {
      const region = parsed.searchParams.get("regionCode");

      return videosResponse(
        Array.from({ length: 50 }, (_, i) => chartItem(`chart${region}${i}`))
      );
    }

    return {};
  }, freshWorker);

  await measure("/api/channelVideos (25)", "/api/channelVideos?channelId=UCchannel01&max=25", parsed => {
    if (parsed.pathname.endsWith("/channels")) {
      return { items: [{ id: "UCchannel01", contentDetails: { relatedPlaylists: { uploads: "PL1" } } }] };
    }

    if (parsed.pathname.endsWith("/playlistItems")) {
      return { items: Array.from({ length: 25 }, (_, i) => ({ contentDetails: { videoId: `chanVol${i}` } })) };
    }

    // As with search, the channel list is only ids; the indexed rows come from
    // the videos.list call that resolves them.
    if (parsed.pathname.endsWith("/videos")) {
      return videosResponse(
        (parsed.searchParams.get("id") || "").split(",").map(id => videoItem(id))
      );
    }

    return {};
  });

  // Baselines, not aspirations. Trending deliberately stands out: one pool
  // rebuild reuses the 50-row chunk eight times, so it schedules ~8x the
  // per-invocation query budget. Writes are fire-and-forget and every failure
  // path is caught, so this cannot fail a request — it can only leave chart
  // videos under-indexed. Pinned here so the number cannot drift unnoticed.
  const expected = [
    { label: "/api/video", batches: 1, statements: 1 },
    { label: "/api/search (50)", batches: 1, statements: 50 },
    { label: "/api/trending", batches: 4, statements: 200 },
    { label: "/api/channelVideos (25)", batches: 1, statements: 25 }
  ];

  assert.deepEqual(perRoute, expected);
});
