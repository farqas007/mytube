// =============================================================================
// MyTube — real-SQLite D1 double tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These tests exist to prove the double is trustworthy. A fake that hardcodes
// results would make the upcoming local-search work green while testing nothing,
// so each case below is written to FAIL if the fake ever stops being real:
//
//   * FTS5 MATCH finds rows that were really written, and misses rows that were
//     really deleted.
//   * bm25() returns usable, differentiated ranking numbers.
//   * The PRODUCTION VIDEO_SEARCH_SQL is executed here, so weighted bm25 and the
//     `match_score, v.rowid` tiebreak are covered by the same fake rather than by
//     a locally rebuilt approximation that could drift from it.
//   * What this SQLite build actually guarantees about tie order is recorded, so
//     the suite never claims a behavioural proof it does not have.
//   * A deliberately wrong assertion actually fails.
//   * batch()/run() report real change counts and roll back atomically.
//
// Run: node --test tests/testFakeD1.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeD1, applyMigrations } from "./helpers/fake-d1.js";
import {
  upsertVideos,
  getVideoBySourceId,
  searchVideoIds,
  buildFtsMatchQuery,
  VIDEO_SEARCH_SQL
} from "../shared/index-store.js";

// The production statement itself, not a rebuild of it. Exercising the real
// weighted-bm25 + rowid-tiebreak SQL here is the only way this fake can prove
// anything about the ordering the worker will eventually use; a hand-copied
// variant would keep passing if the two ever diverged.
const SEARCH_SQL = VIDEO_SEARCH_SQL;

function youtubeItem(videoId, title, extra = {}) {
  return {
    kind: "youtube#video",
    id: videoId,
    snippet: {
      title,
      description: extra.description ?? "",
      tags: extra.tags ?? [],
      publishedAt: extra.publishedAt ?? "2024-01-02T03:04:05Z",
      channelId: extra.channelId ?? "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      channelTitle: extra.channelTitle ?? "Test Channel",
      thumbnails: { medium: { url: "https://i.ytimg.com/vi/" + videoId + "/hq.jpg" } }
    },
    contentDetails: { duration: extra.duration ?? "PT3M33S" },
    statistics: { viewCount: extra.viewCount ?? "10" },
    status: { embeddable: true, madeForKids: false, license: "standard" },
    topicDetails: { topicId: "10" }
  };
}

async function seed(db, specs) {
  const items = specs.map(([videoId, title, extra]) => youtubeItem(videoId, title, extra));

  return upsertVideos(db, items);
}

const idsOf = rows => rows.map(row => row.video_id);

// ---------------------------------------------------------------------------
// 1. FTS5 MATCH is real
// ---------------------------------------------------------------------------

test("fake-d1 applies the real migrations and creates working FTS5 tables", async () => {
  const db = createFakeD1();
  const tables = (await db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
  ).all()).results.map(row => row.name);

  assert.ok(tables.includes("video_fts"), "video_fts virtual table must exist");
  assert.ok(tables.includes("videos"), "videos content table must exist");
  db.close();
});

test("fake-d1 loads the same migrations the deployed D1 has", async () => {
  // migrations:false gives a bare SQLite handle so applyMigrations() is exercised
  // once, rather than being run a second time on an already-migrated database.
  const db = createFakeD1({ migrations: false });
  const files = applyMigrations(db._sqlite);

  assert.deepEqual(files, [
    "0001_init.sql",
    "0002_video_id_lookup_index.sql",
    "0003_fts_tokenizer.sql"
  ]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM videos").first()).c, 0);
  db.close();
});

test("FTS5 MATCH finds rows inserted through the real write path", async () => {
  const db = createFakeD1();

  await seed(db, [
    ["aaaaaaaaaaa", "lofi beats to relax"],
    ["bbbbbbbbbbb", "web development tutorial"],
    ["ccccccccccc", "cooking pasta at home"]
  ]);

  const match = buildFtsMatchQuery("lofi");
  const hits = (await db.prepare(SEARCH_SQL).bind(match, 20).all()).results;

  assert.deepEqual(idsOf(hits), ["aaaaaaaaaaa"]);
  db.close();
});

test("FTS5 MATCH respects the AND semantics the index actually uses", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "lofi beats"], ["bbbbbbbbbbb", "beats from nowhere"]]);

  // buildFtsMatchQuery joins tokens with AND, so both words must be present.
  const both = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("lofi beats"), 20).all()).results;
  const mixed = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("lofi pasta"), 20).all()).results;

  assert.deepEqual(idsOf(both), ["aaaaaaaaaaa"]);
  assert.deepEqual(idsOf(mixed), [], "one missing token must exclude the row");
  db.close();
});

test("FTS5 index follows the trigger on update and delete", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "lofi beats"], ["bbbbbbbbbbb", "jazz guitar"]]);

  assert.equal(
    (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("lofi"), 20).all()).results.length,
    1
  );

  // Rename through the real mapper: the AFTER UPDATE trigger must reindex.
  await upsertVideos(db, [youtubeItem("aaaaaaaaaaa", "ambient rain sounds")]);

  assert.equal(
    (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("lofi"), 20).all()).results.length,
    0,
    "renamed row must leave the old term"
  );
  assert.equal(
    (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("ambient"), 20).all()).results.length,
    1,
    "renamed row must appear under the new term"
  );

  await db.prepare("DELETE FROM videos WHERE source_id = ?").bind("yt:bbbbbbbbbbb").run();
  await db.prepare("DELETE FROM videos WHERE source_id = ?").bind("yt:aaaaaaaaaaa").run();

  assert.equal(
    (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("jazz"), 20).all()).results.length,
    0,
    "deleted row must leave the index (AFTER DELETE trigger)"
  );
  db.close();
});

test("searchVideoIds runs the production search SQL against the fake", async () => {
  const db = createFakeD1();

  await seed(db, [
    ["aaaaaaaaaaa", "lofi beats", { description: "chill music", viewCount: "500" }],
    ["bbbbbbbbbbb", "lofi hip hop radio", { description: "radio", viewCount: "900" }]
  ]);

  const hits = await searchVideoIds(db, "lofi", 10);

  assert.equal(hits.length, 2);
  assert.ok(hits.every(row => typeof row.source_id === "string"));
  assert.ok(hits.every(row => typeof row.match_score === "number"));
  assert.deepEqual(await searchVideoIds(db, "nothinghere", 10), []);
  db.close();
});

// ---------------------------------------------------------------------------
// 2. bm25() ranking values
// ---------------------------------------------------------------------------

test("bm25() returns usable, differentiated ranking values", async () => {
  const db = createFakeD1();

  await seed(db, [
    ["aaaaaaaaaaa", "guitar lesson"],
    ["bbbbbbbbbbb", "guitar guitar guitar lesson lesson advanced"]
  ]);

  const rows = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("guitar"), 20).all()).results;

  assert.equal(rows.length, 2, "both rows must match 'guitar'");

  for (const row of rows) {
    assert.equal(typeof row.match_score, "number");
    assert.ok(Number.isFinite(row.match_score), "bm25 must be finite, got " + row.match_score);
    // bm25() returns a negative number where more negative means a better match.
    assert.ok(row.match_score < 0, "bm25 must be negative, got " + row.match_score);
  }

  // Denser term frequency must actually move the score.
  assert.notEqual(
    rows[0].match_score,
    rows[1].match_score,
    "bm25 must differentiate documents, not return a constant"
  );
  db.close();
});

test("a better match ranks before a worse match", async () => {
  const db = createFakeD1();

  // Same word count, different term frequency: bm25() normalises by document
  // length, so the fixture only isolates density if the lengths match.
  await seed(db, [
    ["aaaaaaaaaaa", "guitar guitar guitar lesson here"],
    ["bbbbbbbbbbb", "guitar piano drums lesson here"]
  ]);

  const rows = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("guitar"), 20).all()).results;

  assert.equal(rows.length, 2);
  assert.ok(
    rows[0].match_score < rows[1].match_score,
    "term-dense document should rank first: " + JSON.stringify(rows.map(r => r.match_score))
  );
  assert.equal(rows[0].video_id, "aaaaaaaaaaa");
  db.close();
});

// ---------------------------------------------------------------------------
// 3. Deterministic ordering
// ---------------------------------------------------------------------------

test("ORDER BY bm25(), rowid is deterministic when bm25 scores collide", async () => {
  const db = createFakeD1();

  // Identical content => identical bm25. Only rowid can break the tie, so any
  // non-determinism here would surface as a different order between runs.
  await seed(db, [
    ["aaaaaaaaaaa", "identical title text"],
    ["bbbbbbbbbbb", "identical title text"],
    ["ccccccccccc", "identical title text"]
  ]);

  const scores = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("identical"), 20).all())
    .results.map(row => row.match_score);

  assert.equal(new Set(scores).size, 1, "the fixture must actually collide on bm25");

  const orders = [];
  for (let run = 0; run < 5; run++) {
    orders.push(idsOf((await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("identical"), 20).all()).results));
  }

  for (const order of orders) {
    assert.deepEqual(order, ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
  }
  db.close();
});

test("a colliding-score page is already rowid-ordered on this SQLite build", async () => {
  const db = createFakeD1();

  // Both rows score identically. This test records what the engine ACTUALLY
  // does, which is the useful part: SQLite's FTS5 currently returns equal-scoring
  // rows in rowid order whether or not the ORDER BY names v.rowid. So a
  // behavioural test cannot prove the production tiebreak is present.
  //
  // It is asserted structurally in tests/testIndexStore.js instead. The clause
  // still belongs in the SQL — SQLite guarantees nothing about tie order, and the
  // tiebreak is what makes paginating an equal-scoring page safe.
  await seed(db, [["aaaaaaaaaaa", "same words here"], ["bbbbbbbbbbb", "same words here"]]);

  const cols = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("same"), 20).all())
    .results.map(row => row.match_score);

  assert.equal(new Set(cols).size, 1, "the fixture must actually collide on bm25");

  const orders = [];
  for (let run = 0; run < 5; run++) {
    orders.push(idsOf((await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("same"), 20).all()).results));
  }

  for (const order of orders) {
    assert.deepEqual(order, ["aaaaaaaaaaa", "bbbbbbbbbbb"], "the tied page must not shuffle");
  }
  db.close();
});

// ---------------------------------------------------------------------------
// 4. The fake cannot rubber-stamp a wrong assertion
// ---------------------------------------------------------------------------

test("a deliberately wrong FTS assertion fails against this fake", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "lofi beats"]]);

  const wrong = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("lofi"), 20).all()).results;

  // The row exists, so claiming the query returns nothing must throw. If this
  // assertion ever stops throwing, the fake has started inventing results.
  assert.throws(
    () => assert.equal(wrong.length, 0),
    assert.AssertionError,
    "an obviously wrong expectation must be rejected"
  );

  // And the positive control: the term genuinely absent returns nothing.
  const absent = (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("helicopter"), 20).all()).results;
  assert.deepEqual(absent, [], "a term that was never indexed must match nothing");
  db.close();
});

// ---------------------------------------------------------------------------
// 5. batch() / run() / first() / all() behaviour
// ---------------------------------------------------------------------------

test("batch() returns one positional result per statement with real change counts", async () => {
  const db = createFakeD1();

  const results = await db.batch([
    db.prepare("INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?)")
      .bind("alpha", "1", 10),
    db.prepare("INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?)")
      .bind("beta", "2", 20),
    db.prepare("UPDATE index_state SET value = ? WHERE key = ?").bind("3", "alpha")
  ]);

  assert.equal(results.length, 3);
  assert.deepEqual(results.map(result => result.meta.changes), [1, 1, 1]);
  assert.ok(results.every(result => result.success === true));

  assert.deepEqual(await db.batch([]), []);
  db.close();
});

test("batch() is atomic: one failing statement rolls the whole thing back", async () => {
  const db = createFakeD1();

  await assert.rejects(
    () => db.batch([
      db.prepare("INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?)")
        .bind("written-first", "1", 10),
      db.prepare("THIS IS NOT VALID SQL")
    ]),
    /syntax error/
  );

  const survived = (await db.prepare("SELECT value FROM index_state WHERE key = ?")
    .bind("written-first").first());

  assert.equal(survived, null, "a rolled-back batch must leave nothing behind");
  db.close();
});

test("batch() rejects a non-prepared value instead of silently skipping it", async () => {
  const db = createFakeD1();

  await assert.rejects(
    () => db.batch([{ sql: "SELECT 1" }]),
    /non-prepared/
  );
  db.close();
});

test("upsertVideos writes one batch per chunk and reports accurate indexing", async () => {
  const db = createFakeD1();
  const before = db.stats.batch;

  const summary = await seed(db, [
    ["aaaaaaaaaaa", "one"],
    ["bbbbbbbbbbb", "two"],
    ["ccccccccccc", "three"]
  ]);

  assert.deepEqual(
    { attempted: summary.attempted, indexed: summary.indexed, skipped: summary.skipped },
    { attempted: 3, indexed: 3, skipped: 0 }
  );
  assert.equal(db.stats.batch - before, 1, "three rows fit in a single batch");

  // Re-upserting the same ids updates in place instead of duplicating.
  await upsertVideos(db, [youtubeItem("aaaaaaaaaaa", "one renamed")]);

  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS c FROM videos").first()).c,
    3,
    "ON CONFLICT must update, not duplicate"
  );
  assert.equal(
    (await db.prepare(SEARCH_SQL).bind(buildFtsMatchQuery("renamed"), 20).all()).results.length,
    1
  );
  db.close();
});

test("run() reports the true number of affected rows", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "one"], ["bbbbbbbbbbb", "two"]]);

  const renamed = await db.prepare("UPDATE videos SET title = ? WHERE source_id = ?")
    .bind("updated", "yt:aaaaaaaaaaa").run();

  assert.equal(renamed.meta.changes, 1);
  assert.equal(renamed.success, true);

  const noMatch = await db.prepare("UPDATE videos SET title = ? WHERE source_id = ?")
    .bind("updated", "yt:does-not-exist").run();

  assert.equal(noMatch.meta.changes, 0, "an UPDATE matching nothing must report 0 changes");
  db.close();
});

test("first() returns a row or null, all() returns a result set", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "one"]]);

  const row = await db.prepare("SELECT video_id, title FROM videos WHERE source_id = ?")
    .bind("yt:aaaaaaaaaaa").first();

  assert.equal(row.video_id, "aaaaaaaaaaa");
  assert.equal(row.title, "one");

  assert.equal(
    await db.prepare("SELECT video_id FROM videos WHERE source_id = ?").bind("yt:nope").first(),
    null,
    "first() must be null on a miss, not undefined"
  );

  const empty = await db.prepare("SELECT video_id FROM videos WHERE source_id = ?").bind("yt:nope").all();

  assert.equal(empty.success, true);
  assert.deepEqual(empty.results, []);
  db.close();
});

test("bind() returns a fresh statement so bindings never leak between rows", async () => {
  const db = createFakeD1();
  const template = db.prepare("SELECT ? AS bound");

  const first = await template.bind("alpha").first();
  const second = await template.bind("beta").first();
  const third = await template.bind("gamma").first();

  assert.deepEqual(
    [first.bound, second.bound, third.bound],
    ["alpha", "beta", "gamma"]
  );
  db.close();
});

test("getVideoBySourceId reads back exactly what the write path stored", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "lofi beats", { viewCount: "4242" }]]);

  const row = await getVideoBySourceId(db, "yt:aaaaaaaaaaa");

  assert.equal(row.title, "lofi beats");
  assert.equal(row.view_count, 4242);
  assert.equal(await getVideoBySourceId(db, "yt:missing"), null);
  db.close();
});

// ---------------------------------------------------------------------------
// 6. D1 parity guards
// ---------------------------------------------------------------------------

test("undefined is rejected like D1 rejects it", () => {
  const db = createFakeD1();

  // bind() is synchronous, so D1's rejection surfaces as a synchronous throw.
  assert.throws(
    () => db.prepare("SELECT ? AS x").bind(undefined),
    /undefined cannot be bound/
  );
  assert.throws(
    () => db.prepare("INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?)")
      .bind("key", undefined, 1),
    /undefined cannot be bound/,
    "a mapper that yields undefined must fail before the write"
  );
  db.close();
});

test("booleans bind as SQLite integers", async () => {
  const db = createFakeD1();

  await seed(db, [["aaaaaaaaaaa", "one"]]);
  await db.prepare("UPDATE videos SET embeddable = ? WHERE source_id = ?").bind(true, "yt:aaaaaaaaaaa").run();

  assert.equal((await db.prepare("SELECT embeddable FROM videos WHERE source_id = ?").bind("yt:aaaaaaaaaaa").first()).embeddable, 1);
  db.close();
});

test("a real SQL error rejects instead of returning an empty result set", async () => {
  const db = createFakeD1();

  await assert.rejects(
    () => db.prepare("SELECT * FROM table_that_does_not_exist").all(),
    /no such table/
  );
  db.close();
});

test("each createFakeD1() call gets an isolated database", async () => {
  const first = createFakeD1();
  const second = createFakeD1();

  await seed(first, [["aaaaaaaaaaa", "only here"]]);

  assert.equal((await first.prepare("SELECT COUNT(*) AS c FROM videos").first()).c, 1);
  assert.equal((await second.prepare("SELECT COUNT(*) AS c FROM videos").first()).c, 0);

  first.close();
  second.close();
});
