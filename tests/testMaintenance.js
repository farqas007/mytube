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
//   * a definitive absence from a real videos.list tombstones the row, and only
//     the SECOND consecutive absence deletes it
//   * a 200 that is not a usable videos.list (unreadable body, no list, wrong
//     kind, items that are not an array, an error alongside the list) never
//     deletes and never tombstones
//   * 429 / 5xx / network failures NEVER delete
//   * a partial response only strikes the ids that are actually missing
//   * a tombstone expires, is cleared by a video that comes back, and survives
//     a failed delete
//   * deletes are batched, not one statement per row
//   * rows that share a video id are handled together
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
  MAINTENANCE_MAX_YT_REQUESTS_PER_RUN,
  MAINTENANCE_MISS_STATE_KEY,
  MAINTENANCE_MISS_TOMBSTONE_MS,
  YT_VIDEO_LIST_KIND,
  prunePendingMisses
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
  const indexState = new Map();

  for (const row of rows) {
    state.set(row.source_id, { ...row });
  }

  const preparedSql = [];
  const deleted = [];
  const batches = [];
  let batchCalls = 0;
  let deleteRunCalls = 0;
  let failDeleteBatch = false;
  let failStateRead = false;

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
        if (/FROM index_state/i.test(sql)) {
          if (failStateRead) {
            throw new Error("D1 read failed (simulated)");
          }

          const stored = indexState.get(String(statement.args?.[0]));

          return stored ? { value: stored.value, updated_at_ms: stored.updated_at_ms } : null;
        }

        return null;
      },
      async run() {
        if (/^DELETE FROM videos/i.test(sql.trim())) {
          // Counted so a test can prove the handler stopped deleting one row per
          // statement.run() round trip.
          deleteRunCalls += 1;

          const sourceId = statement.args?.[0];
          const changes = state.delete(sourceId) ? 1 : 0;

          if (changes) {
            deleted.push(sourceId);
          }

          return { success: true, meta: { changes } };
        }

        if (/INSERT INTO index_state/i.test(sql)) {
          indexState.set(String(statement.args?.[0]), {
            value: statement.args?.[1],
            updated_at_ms: statement.args?.[2]
          });

          return { success: true, meta: { changes: 1 } };
        }

        return { success: true, meta: { changes: 0 } };
      }
    };

    return statement;
  };

  const db = {
    state,
    indexState,
    deleted,
    preparedSql,
    batches,
    get batchCalls() {
      return batchCalls;
    },
    get deleteRunCalls() {
      return deleteRunCalls;
    },
    // Simulates D1 rejecting the delete transaction. db.batch() is atomic, so
    // nothing must be counted as deleted when this fires.
    failNextDeleteBatch() {
      failDeleteBatch = true;
    },
    // Simulates the tombstone read failing, which must degrade to "no
    // tombstones" (two strikes required) rather than throwing.
    failTombstoneRead() {
      failStateRead = true;
    },
    seedState(key, value) {
      indexState.set(key, { value, updated_at_ms: 0 });
    },
    readState(key) {
      const stored = indexState.get(key);

      if (!stored) {
        return null;
      }

      try {
        return JSON.parse(stored.value);
      } catch {
        return null;
      }
    },
    prepare(sql) {
      preparedSql.push(sql);
      return makeStatement(sql);
    },
    async batch(statements) {
      batchCalls += 1;
      batches.push(statements.map(statement => ({ sql: statement.sql, args: statement.args })));

      if (
        failDeleteBatch &&
        statements.some(statement => /^DELETE FROM videos/i.test(statement.sql.trim()))
      ) {
        failDeleteBatch = false;
        throw new Error("D1 batch rejected (simulated)");
      }

      const results = [];

      for (const statement of statements) {
        const sql = statement.sql.trim();

        if (/^INSERT INTO videos/i.test(sql)) {
          const row = {};

          VIDEO_COLUMNS.forEach((column, index) => {
            row[column] = statement.args[index];
          });

          const existing = state.get(row.source_id);

          if (existing) {
            row.first_seen_at_ms = existing.first_seen_at_ms;
          }

          state.set(row.source_id, row);
          results.push({ success: true, meta: { changes: 1 } });
          continue;
        }

        if (/^DELETE FROM videos/i.test(sql)) {
          const sourceId = statement.args?.[0];
          const changes = state.delete(sourceId) ? 1 : 0;

          if (changes) {
            deleted.push(sourceId);
          }

          results.push({ success: true, meta: { changes } });
          continue;
        }

        if (/^UPDATE videos SET metadata_fetched_at_ms/i.test(sql)) {
          const [fetchedAt, lastSeenAt, sourceId] = statement.args || [];
          const row = state.get(sourceId);

          if (row) {
            row.metadata_fetched_at_ms = Number(fetchedAt);
            row.last_seen_at_ms = Number(lastSeenAt);
          }

          results.push({ success: true, meta: { changes: row ? 1 : 0 } });
          continue;
        }

        results.push({ success: true, meta: { changes: 0 } });
      }

      return results;
    }
  };

  return db;
}

// `responder(url)` returns `{ status?, body? }` for a single upstream call.
// `rawBody` models a 2xx whose body is not JSON at all (an HTML error page, a
// truncated payload, a WAF interception) — the one case where a successful
// status used to be indistinguishable from an empty result.
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
        if (result.rawBody !== undefined) {
          throw new SyntaxError("Unexpected token '<' in JSON at position 0");
        }

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

// A REAL videos.list reply. `kind` is not decoration: the maintenance pass
// refuses to read a deletion out of any other 2xx shape.
function videosResponse(items) {
  return {
    kind: "youtube#videoListResponse",
    items,
    pageInfo: { totalResults: items.length, resultsPerPage: items.length }
  };
}

function tombstonesOf(db) {
  return db.readState(MAINTENANCE_MISS_STATE_KEY) || {};
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

test("a first absence only tombstones the row; the second absence deletes it", async () => {
  const now = Date.now();
  const videoId = "goneVideo01";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const first = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(first.selected, 1);
    assert.equal(first.requested, 1);
    assert.equal(first.tombstoned, 1);
    assert.equal(first.deleted, 0, "one empty list is never a deletion");
    assert.equal(first.refreshed, 0);
    assert.ok(db.state.has(`yt:${videoId}`), "the row survives the first miss");
    assert.deepEqual(db.deleted, []);

    const tombstones = tombstonesOf(db);

    assert.ok(tombstones[videoId], "the miss must be remembered");
    assert.equal(tombstones[videoId].firstMissedAt, now);

    // Six hours later, the same authoritative answer.
    const second = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(second.tombstoned, 0);
    assert.equal(second.deleted, 1, "the second confirmed absence deletes");
    assert.equal(db.state.has(`yt:${videoId}`), false);
    assert.deepEqual(db.deleted, [`yt:${videoId}`]);
    assert.deepEqual(tombstonesOf(db), {}, "a consumed tombstone is cleared");
  });
});

test("a partial response only strikes the definitively missing id", async () => {
  const now = Date.now();
  const present = "partialKeep1";
  const missing = "partialGone1";
  const db = createMaintenanceDb([
    rowFor(present, now - 29 * DAY_MS),
    rowFor(missing, now - 29 * DAY_MS)
  ]);

  await withYouTube(() => ({ body: videosResponse([videoItem(present)]) }), async () => {
    const first = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(first.refreshed, 1);
    assert.equal(first.tombstoned, 1);
    assert.equal(first.deleted, 0);
    assert.ok(db.state.has(`yt:${present}`));
    assert.ok(db.state.has(`yt:${missing}`), "one miss is not a deletion");
    assert.ok(tombstonesOf(db)[missing], "only the missing id is tombstoned");
    assert.equal(tombstonesOf(db)[present], undefined);

    const second = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(second.deleted, 1);
    assert.ok(db.state.has(`yt:${present}`), "the refreshed row is not a candidate again");
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
// A 2xx that is not a real videos.list answers nothing — and, crucially,
// answers nothing DESTRUCTIVELY.
//
// Every body below used to be read as "every selected video is gone" and deleted
// the entire selection in a single run: ytFetch() swallowed a parse failure into
// `data = null`, `items` defaulted to [], and an empty list for explicitly
// requested ids was treated as definitive.
// -----------------------------------------------------------------------------

const NON_AUTHORITATIVE_RESPONSES = [
  {
    label: "a body that is not JSON at all",
    response: { rawBody: "<html><body>Service unavailable</body></html>" },
    expectedError: "invalidResponse"
  },
  {
    label: "a JSON body that carries no list",
    response: { body: { pageInfo: { totalResults: 0 } } },
    expectedError: "non_authoritative_response"
  },
  {
    label: "a list from a different endpoint",
    response: { body: { kind: "youtube#searchListResponse", items: [] } },
    expectedError: "non_authoritative_response"
  },
  {
    label: "items that are not a list",
    response: { body: { kind: YT_VIDEO_LIST_KIND, items: null } },
    expectedError: "invalidResponse"
  },
  {
    label: "an error object shipped alongside the list",
    response: {
      body: { kind: YT_VIDEO_LIST_KIND, items: [], error: { code: 500, message: "backend error" } }
    },
    expectedError: "non_authoritative_response"
  }
];

for (const { label, response, expectedError } of NON_AUTHORITATIVE_RESPONSES) {
  test(`${label} never deletes and never tombstones`, async () => {
    const now = Date.now();
    const ids = ["ambiguous01", "ambiguous02", "ambiguous03"];
    const db = createMaintenanceDb(ids.map(id => rowFor(id, now - 29 * DAY_MS)));

    await withYouTube(() => response, async calls => {
      const first = await runIndexMaintenance({ db }, envWith(db), now);
      const second = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

      assert.equal(first.error, expectedError, "the reason must be recorded");
      assert.equal(first.selected, 3);
      assert.equal(first.refreshed, 0);
      assert.equal(first.tombstoned, 0);
      assert.equal(first.deleted, 0);
      assert.equal(second.deleted, 0, "no number of ambiguous responses may delete");
      assert.deepEqual(db.deleted, []);

      for (const id of ids) {
        assert.ok(db.state.has(`yt:${id}`), `${id} must survive`);
      }

      assert.deepEqual(tombstonesOf(db), {}, "a non-answer must not even strike");
      assert.equal(calls.length, 2, "one upstream call per run, and no retry");
    });
  });
}

// -----------------------------------------------------------------------------
// Tombstone lifecycle
// -----------------------------------------------------------------------------

test("the tombstone record survives both of the shapes a run hands it", () => {
  const now = Date.now();
  const entry = { firstMissedAt: now, sourceIds: ["yt:shapeCheck1"] };
  const asObject = { shapeCheck1: entry };
  const asMap = new Map([["shapeCheck1", entry]]);

  // A Map read as an object is [] rather than a throw, which would silently
  // discard every pending deletion. Both shapes must prune identically.
  assert.deepEqual(
    [...prunePendingMisses(asObject, now).entries()],
    [...prunePendingMisses(asMap, now).entries()]
  );
  assert.equal(prunePendingMisses(asMap, now).get("shapeCheck1").firstMissedAt, now);
  assert.equal(prunePendingMisses({ gone: { firstMissedAt: now - 30 * DAY_MS } }, now).size, 0);
  assert.equal(prunePendingMisses({ bad: { firstMissedAt: "never" } }, now).size, 0);
});

test("a video that comes back is refreshed and its tombstone is retired", async () => {
  const now = Date.now();
  const videoId = "cameBack001";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  // Run 1: gone. Run 2: back. Run 3: gone again — and that must be a FIRST
  // strike, proving the run-1 strike really was retired.
  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    await runIndexMaintenance({ db }, envWith(db), now);
    assert.ok(tombstonesOf(db)[videoId]);
  });

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async () => {
    const revived = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(revived.refreshed, 1);
    assert.equal(revived.deleted, 0);
    assert.deepEqual(tombstonesOf(db), {}, "a refreshed video is not a pending deletion");
  });

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const again = await runIndexMaintenance({ db }, envWith(db), now + 30 * DAY_MS);

    assert.equal(again.tombstoned, 1, "the retired strike must not come back");
    assert.equal(again.deleted, 0);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

test("an expired tombstone is treated as a first strike again", async () => {
  const now = Date.now();
  const videoId = "staleStrike1";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  db.seedState(
    MAINTENANCE_MISS_STATE_KEY,
    JSON.stringify({
      [videoId]: {
        firstMissedAt: now - MAINTENANCE_MISS_TOMBSTONE_MS - DAY_MS,
        sourceIds: [`yt:${videoId}`]
      }
    })
  );

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 0, "a strike older than the tombstone window never deletes");
    assert.equal(summary.tombstoned, 1);
    assert.ok(db.state.has(`yt:${videoId}`));
    assert.equal(
      tombstonesOf(db)[videoId].firstMissedAt,
      now,
      "the strike must be restamped from the observation time"
    );
  });
});

test("a strike that loses the window is carried forward, not silently dropped", async () => {
  const now = Date.now();
  const buried = "buriedStrike1";

  // Enough equally-old rows ahead of it to fill the whole scan window, so the
  // tombstoned row is never selected and can never be confirmed in this run.
  const older = Array.from({ length: 80 }, (_, index) =>
    rowFor(`olderRow${String(index).padStart(3, "0")}`, now - (31 + index) * DAY_MS)
  );
  const db = createMaintenanceDb([...older, rowFor(buried, now - 29 * DAY_MS)]);

  db.seedState(
    MAINTENANCE_MISS_STATE_KEY,
    JSON.stringify({ [buried]: { firstMissedAt: now, sourceIds: [`yt:${buried}`] } })
  );

  await withYouTube(() => ({ body: videosResponse([]) }), async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.requested, MAINTENANCE_MAX_VIDEOS_PER_RUN);
    assert.equal(
      requestedIds(calls).includes(buried),
      false,
      "the tombstoned row lost the window to older backlog"
    );
    assert.equal(summary.deleted, 0);
    assert.ok(db.state.has(`yt:${buried}`), "an unselected row is never touched");
    assert.ok(
      tombstonesOf(db)[buried],
      "a strike must survive until a run can actually confirm it"
    );
  });
});

test("a failed delete keeps the tombstone so the next run can confirm it", async () => {
  const now = Date.now();
  const videoId = "deleteRetry1";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    await runIndexMaintenance({ db }, envWith(db), now);

    db.failNextDeleteBatch();

    const failed = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(failed.deleted, 0);
    assert.ok(failed.error, "a rejected batch must be recorded");
    assert.ok(db.state.has(`yt:${videoId}`), "db.batch() is atomic, so nothing went away");
    assert.ok(
      tombstonesOf(db)[videoId],
      "the strike must survive a failed write, never be consumed by it"
    );

    const retried = await runIndexMaintenance({ db }, envWith(db), now + 12 * 60 * 60 * 1000);

    assert.equal(retried.deleted, 1);
    assert.equal(db.state.has(`yt:${videoId}`), false);
  });
});

test("a tombstone read failure degrades to two strikes, never one", async () => {
  const now = Date.now();
  const videoId = "stateReadErr";
  const db = createMaintenanceDb([rowFor(videoId, now - 29 * DAY_MS)]);

  db.seedState(
    MAINTENANCE_MISS_STATE_KEY,
    JSON.stringify({ [videoId]: { firstMissedAt: now, sourceIds: [`yt:${videoId}`] } })
  );
  db.failTombstoneRead();

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.deleted, 0, "an unreadable strike state must fail safe");
    assert.equal(summary.tombstoned, 1);
    assert.ok(db.state.has(`yt:${videoId}`));
  });
});

// -----------------------------------------------------------------------------
// One transaction, not one round trip per row
// -----------------------------------------------------------------------------

test("deletes go out as a single batched transaction", async () => {
  const now = Date.now();
  const ids = ["batchGone01", "batchGone02", "batchGone03"];
  const db = createMaintenanceDb(ids.map(id => rowFor(id, now - 29 * DAY_MS)));

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    await runIndexMaintenance({ db }, envWith(db), now);

    const batchesBefore = db.batchCalls;
    const summary = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(summary.deleted, 3);
    assert.equal(db.batchCalls - batchesBefore, 1, "one db.batch() for the whole run");
    assert.equal(db.deleteRunCalls, 0, "no per-row statement.run()");

    const deleteBatches = db.batches.filter(batch =>
      batch.some(statement => /^DELETE FROM videos/i.test(statement.sql.trim()))
    );

    assert.equal(deleteBatches.length, 1);
    assert.equal(deleteBatches[0].length, 3, "one statement per deleted row, in one call");
  });
});

// -----------------------------------------------------------------------------
// Rows that share a video id
// -----------------------------------------------------------------------------

test("rows sharing a video id are refreshed together, not one at a time", async () => {
  const now = Date.now();
  const videoId = "dupeId00001";
  const db = createMaintenanceDb([
    rowFor(videoId, now - 29 * DAY_MS),
    rowFor(videoId, now - 29 * DAY_MS, { source_id: `alt:${videoId}` })
  ]);

  await withYouTube(() => ({ body: videosResponse([videoItem(videoId)]) }), async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(summary.selected, 2, "both rows are candidates");
    assert.equal(summary.requested, 1, "one video id costs one request slot");
    assert.equal(requestedIds(calls).length, 1);

    // The upsert can only write the canonical yt:<id> row, so the duplicate has
    // to be renewed explicitly or it would stay pinned to the head of the
    // oldest-first window forever.
    for (const sourceId of [`yt:${videoId}`, `alt:${videoId}`]) {
      assert.ok(
        db.state.get(sourceId).metadata_fetched_at_ms > now - DAY_MS,
        `${sourceId} must have been renewed`
      );
    }
  });
});

test("rows sharing a video id are deleted together on the second strike", async () => {
  const now = Date.now();
  const videoId = "dupeGone01";
  const db = createMaintenanceDb([
    rowFor(videoId, now - 29 * DAY_MS),
    rowFor(videoId, now - 29 * DAY_MS, { source_id: `alt:${videoId}` })
  ]);

  await withYouTube(() => ({ body: videosResponse([]) }), async () => {
    const first = await runIndexMaintenance({ db }, envWith(db), now);

    assert.equal(first.tombstoned, 1, "one strike per video id, not per row");
    assert.equal(first.deleted, 0);

    const second = await runIndexMaintenance({ db }, envWith(db), now + 6 * 60 * 60 * 1000);

    assert.equal(second.deleted, 2, "no duplicate row may be orphaned");
    assert.deepEqual(db.deleted.sort(), [`alt:${videoId}`, `yt:${videoId}`].sort());
    assert.equal(db.state.size, 0);
  });
});

test("a window full of duplicated ids still fills the request budget", async () => {
  const now = Date.now();
  const rows = [];

  // 20 ids x 4 rows each = the full scan window, every row equally due.
  for (let index = 0; index < MAINTENANCE_MAX_VIDEOS_PER_RUN; index += 1) {
    const videoId = `dupeCrowd${String(index).padStart(2, "0")}`;

    for (let copy = 0; copy < 4; copy += 1) {
      rows.push(rowFor(videoId, now - 29 * DAY_MS - copy, { source_id: `alt:${videoId}:${copy}` }));
    }
  }

  const db = createMaintenanceDb(rows);

  await withYouTube(() => ({ body: videosResponse([]) }), async calls => {
    const summary = await runIndexMaintenance({ db }, envWith(db), now);
    const requested = requestedIds(calls);

    assert.equal(requested.length, MAINTENANCE_MAX_VIDEOS_PER_RUN, "duplicates must not starve the run");
    assert.equal(new Set(requested).size, MAINTENANCE_MAX_VIDEOS_PER_RUN, "all ids are distinct");
    assert.equal(summary.tombstoned, MAINTENANCE_MAX_VIDEOS_PER_RUN);
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
