// =============================================================================
// MyTube — D1 index maintenance (retention/revalidation) tests
// -----------------------------------------------------------------------------
// Exercises the Scheduled Event handler against fakes for the two things it
// cannot have in a unit test: the YouTube Data API and the D1 binding. No
// production secrets, no network, no remote database.
//
// What is proven here:
//   * rows are selected oldest-first and only inside the refresh window
//   * a 29-day row is a candidate and is refreshed, not deleted
//   * a 22-day row is not a candidate at all
//   * refreshing updates metadata_fetched_at_ms but preserves first_seen_at_ms
//   * a definitive absence from a successful videos.list deletes the row
//   * 429 / 5xx / network failures NEVER delete
//   * a partial response only deletes the ids that are actually missing
//   * at most 20 videos and exactly one upstream request per run
//   * live rows are never selected
//   * the 6-minute /api/video serving TTL is a separate window from 30-day
//     retention
//
// Run: node --test tests/testMaintenance.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import worker, {
  scheduled,
  runIndexMaintenance,
  MAINTENANCE_RETENTION_MS,
  MAINTENANCE_REFRESH_WINDOW_MS,
  MAINTENANCE_MAX_VIDEOS_PER_RUN,
  MAINTENANCE_MAX_YT_REQUESTS_PER_RUN
} from "../worker.js";
import { VIDEO_COLUMNS, toVideoRow } from "../shared/index-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Fakes
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
      thumbnails: { high: { url: "https://i.ytimg.com/vi/x/hq.jpg" } },
      channelTitle: "A Channel",
      tags: ["music"],
      categoryId: "10",
      liveBroadcastContent: "none"
    },
    contentDetails: { duration: "PT4M13S", definition: "hd", caption: "true" },
    statistics: { viewCount: "1234567", likeCount: "4321", commentCount: "0" },
    status: { embeddable: true, madeForKids: false, privacyStatus: "public" }
  };

  return { ...item, ...overrides };
}

// A persisted row keyed by source_id. `fetchedAt` drives metadata_fetched_at_ms,
// which is the only clock the maintenance pass reads.
function rowFor(videoId, fetchedAt, extra = {}) {
  const row = toVideoRow(videoItem(videoId), { now: fetchedAt, fetchedAtMs: fetchedAt });

  return { ...row, ...extra };
}

function createMaintenanceDb(rows = []) {
  const state = new Map();

  for (const row of rows) {
    state.set(row.source_id, { ...row });
  }

  const preparedSql = [];
  const deleted = [];
  let batchCalls = 0;

  const makeStatement = sql => {
    const statement = {
      sql,
      args: null,
      bind(...args) {
        statement.args = args;
        return statement;
      },
      async all() {
        if (/FROM videos/i.test(sql) && /ORDER BY metadata_fetched_at_ms/i.test(sql)) {
          const limit = Number(statement.args?.[1] ?? MAINTENANCE_MAX_VIDEOS_PER_RUN);
          const matching = [...state.values()]
            .filter(row => row.type === statement.args?.[0] && Number(row.is_live) !== 1)
            .sort((a, b) => Number(a.metadata_fetched_at_ms) - Number(b.metadata_fetched_at_ms))
            .slice(0, limit);

          return { success: true, results: matching };
        }

        return { success: true, results: [] };
      },
      async first() {
        return null;
      },
      async run() {
        if (/^DELETE FROM videos/i.test(sql.trim())) {
          const sourceId = statement.args?.[0];

          if (state.has(sourceId)) {
            state.delete(sourceId);
            deleted.push(sourceId);
          }
        }

        return { success: true };
      }
    };

    return statement;
  };

  const db = {
    state,
    deleted,
    preparedSql,
    get batchCalls() {
      return batchCalls;
    },
    prepare(sql) {
      preparedSql.push(sql);
      return makeStatement(sql);
    },
    async batch(statements) {
      batchCalls += 1;

      for (const statement of statements) {
        const row = {};
        VIDEO_COLUMNS.forEach((column, index) => {
          row[column] = statement.args[index];
        });

        const existing = state.get(row.source_id);

        if (existing) {
          row.first_seen_at_ms = existing.first_seen_at_ms;
        }

        state.set(row.source_id, row);
      }

      return statements.map(() => ({ success: true }));
    }
  };

  return db;
}

// `responder(url)` returns `{ status?, body? }` for the single upstream call.
async function withYouTube(responder, run) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);

    const result = (await responder(parsed)) || {};
    const status = result.status || 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return result.body ?? {};
      }
    };
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function videosResponse(items) {
  return { items };
}

function envWith(db, key = "test-key") {
  return { mytube_index: db, YOUTUBE_API_KEY: key };
}

function requestedIds(calls) {
  if (!calls.length) {
    return [];
  }

  return (calls[0].searchParams.get("id") || "").split(",").filter(Boolean);
}

// -----------------------------------------------------------------------------
// Selection / retention boundary
// -----------------------------------------------------------------------------

test("a 29-day-old row is a refresh candidate and is refreshed, not deleted", async () => {
  const now = Date.now();
  const videoId = "candidate29d";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.selected, 1);
    assert.equal(summary.refreshed, 1);
    assert.equal(summary.deleted, 0);
    assert.equal(calls.length, 1);

    const row = db.state.get(`yt:${videoId}`);
    assert.ok(row, "row must still exist");
    assert.ok(row.metadata_fetched_at_ms > now - DAY_MS, "metadata must be refreshed");
  });
});

test("a 22-day-old row is not even selected", async () => {
  const now = Date.now();
  const db = createMaintenanceDb([rowFor("tooFresh01", now - 22 * DAY_MS)]);

  await withYouTube(() => {
    throw new Error("YouTube must not be called when nothing is due");
  }, async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.selected, 0);
    assert.equal(calls.length, 0);
  });
});

test("the refresh window starts before the 30-day boundary", () => {
  assert.equal(MAINTENANCE_RETENTION_MS, 30 * DAY_MS);
  assert.ok(MAINTENANCE_REFRESH_WINDOW_MS > 0);
  assert.ok(MAINTENANCE_REFRESH_WINDOW_MS < MAINTENANCE_RETENTION_MS);
});

test("an expired row is refreshed when upstream still returns it", async () => {
  const now = Date.now();
  const videoId = "expired31d";
  const db = createMaintenanceDb([rowFor(videoId, now - 31 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.refreshed, 1);
    assert.equal(summary.deleted, 0);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

// -----------------------------------------------------------------------------
// first_seen_at_ms preservation
// -----------------------------------------------------------------------------

test("a refresh preserves first_seen_at_ms", async () => {
  const now = Date.now();
  const videoId = "preserveFs01";
  const firstSeen = now - 400 * DAY_MS;
  const db = createMaintenanceDb([
    rowFor(videoId, now - 29 * DAY_MS, { first_seen_at_ms: firstSeen })
  ]);

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async () => {
    await runIndexMaintenance({ db }, envWith(db), now);

    const row = db.state.get(`yt:${videoId}`);
    assert.equal(row.first_seen_at_ms, firstSeen);
    assert.ok(row.metadata_fetched_at_ms > now - DAY_MS);
  });
});

// -----------------------------------------------------------------------------
// Definitive vs transient unavailability
// -----------------------------------------------------------------------------

test("absence from a successful videos.list deletes the row", async () => {
  const now = Date.now();
  const videoId = "goneVideo01";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 1);
    assert.equal(summary.refreshed, 0);
    assert.equal(db.state.has(`yt:${videoId}`), false);
    assert.deepEqual(db.deleted, [`yt:${videoId}`]);
  });
});

test("a partial response only deletes the definitively missing id", async () => {
  const now = Date.now();
  const present = "partialKeep1";
  const missing = "partialGone1";
  const db = createMaintenanceDb([
    rowFor(present, now - 29 * DAY_MS),
    rowFor(missing, now - 29 * DAY_MS)
  ]);

  await withYouTube(() => ({ body: videosResponse([videoItem(present)]) }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.refreshed, 1);
    assert.equal(summary.deleted, 1);
    assert.ok(db.state.has(`yt:${present}`));
    assert.equal(db.state.has(`yt:${missing}`), false);
    assert.deepEqual(db.deleted, [`yt:${missing}`]);
  });
});

test("a 429 never deletes rows", async () => {
  const now = Date.now();
  const videoId = "rateLimited1";
  const db = createMaintenanceDb([rowFor(videoId, now - 31 * DAY_MS)]);

  await withYouTube(() => ({
    status: 429,
    body: { error: { message: "Rate limit exceeded", errors: [{ reason: "rateLimitExceeded" }] } }
  }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 0);
    assert.ok(summary.error, "the failure must be recorded");
    assert.ok(db.state.has(`yt:${videoId}`), "row must survive a 429");
  });
});

test("a 503 never deletes rows", async () => {
  const now = Date.now();
  const videoId = "server503err";
  const db = createMaintenanceDb([rowFor(videoId, now - 31 * DAY_MS)]);

  await withYouTube(() => ({ status: 503, body: { error: { message: "Backend error" } } }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 0);
    assert.ok(summary.error);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

test("a network failure never deletes rows", async () => {
  const now = Date.now();
  const videoId = "networkFail1";
  const db = createMaintenanceDb([rowFor(videoId, now - 31 * DAY_MS)]);

  await withYouTube(() => {
    throw new Error("socket hang up");
  }, async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 0);
    assert.ok(summary.error);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

test("a missing API key never deletes rows", async () => {
  const now = Date.now();
  const videoId = "noApiKey001";
  const db = createMaintenanceDb([rowFor(videoId, now - 31 * DAY_MS)]);

  await withYouTube(() => {
    throw new Error("YouTube must not be called without a key");
  }, async () => {
    const summary = await runIndexMaintenance({ db }, { mytube_index: db }, now);

    assert.equal(summary.deleted, 0);
    assert.ok(summary.error);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

test("at most 20 videos are requested in one run", async () => {
  const now = Date.now();
  const rows = Array.from({ length: 30 }, (_, index) =>
    rowFor(`manyRow${String(index).padStart(3, "0")}`, now - (29 + index) * DAY_MS)
  );
  const db = createMaintenanceDb(rows);

  await withYouTube(() => ({ body: videosResponse([]) }), async calls => {
    await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(requestedIds(calls).length, MAINTENANCE_MAX_VIDEOS_PER_RUN);
  });
});

test("exactly one upstream request is made per run", async () => {
  const now = Date.now();
  const rows = Array.from({ length: MAINTENANCE_MAX_VIDEOS_PER_RUN }, (_, index) =>
    rowFor(`oneReq${String(index).padStart(3, "0")}`, now - 29 * DAY_MS - index * 1000)
  );
  const db = createMaintenanceDb(rows);

  await withYouTube(() => ({ body: videosResponse([]) }), async calls => {
    await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(calls.length, MAINTENANCE_MAX_YT_REQUESTS_PER_RUN);
    assert.equal(calls.length, 1);
  });
});

// -----------------------------------------------------------------------------
// Live rows
// -----------------------------------------------------------------------------

test("live rows are not selected and never deleted", async () => {
  const now = Date.now();
  const liveId = "liveRowOld01";
  const db = createMaintenanceDb([
    rowFor(liveId, now - 60 * DAY_MS, { is_live: 1 })
  ]);

  await withYouTube(() => {
    throw new Error("YouTube must not be called for live rows");
  }, async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.selected, 0);
    assert.equal(summary.deleted, 0);
    assert.equal(calls.length, 0);
    assert.ok(db.state.has(`yt:${liveId}`));
  });
});

// -----------------------------------------------------------------------------
// scheduled() wrapper
// -----------------------------------------------------------------------------

test("scheduled() is a no-op without a usable D1 binding", async () => {
  await withYouTube(() => {
    throw new Error("YouTube must not be called without D1");
  }, async calls => {
    await scheduled({}, {}, {});
    await scheduled({}, { mytube_index: { notADatabase: true } }, {});
    assert.equal(calls.length, 0);
  });
});

test("scheduled() runs and records its summary in index_state", async () => {
  const now = Date.now();
  const videoId = "scheduled001";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async () => {
    await scheduled({}, envWith(db), {});

    assert.ok(
      db.preparedSql.some(sql => /INSERT INTO index_state/i.test(sql)),
      "a run summary must be recorded"
    );
  });
});

// -----------------------------------------------------------------------------
// The two windows stay separate
// -----------------------------------------------------------------------------

test("maintenance's 30-day window does not change the 6-minute /api/video TTL", async () => {
  const id = "twoWindows01";
  const item = videoItem(id);
  // 29 days old: a maintenance candidate, but far older than the 6-minute
  // serving TTL, so /api/video must still fall back to YouTube.
  const db = createMaintenanceDb([rowFor(id, Date.now() - 29 * DAY_MS)]);

  await withYouTube(parsed => {
    if (parsed.pathname.endsWith("/videos") && parsed.searchParams.get("id") === id) {
      return { status: 200, body: videosResponse([item]) };
    }

    return { status: 200, body: {} };
  }, async calls => {
    const request = new Request(
      `https://mytube.farqas007.workers.dev/api/video?id=${id}`,
      { headers: { "CF-Connecting-IP": "10.9.9.9", Origin: "https://mytube.farqas007.workers.dev" } }
    );
    const ctx = { waitUntil() {} };
    const response = await worker.fetch(request, {
      YOUTUBE_API_KEY: "test-key",
      mytube_index: db,
      ASSETS: { fetch: async () => new Response("asset") }
    }, ctx);

    assert.equal(response.headers.get("X-MyTube-Source"), "youtube");
    assert.ok(calls.some(parsed => parsed.searchParams.get("id") === id));
  });
});
