// =============================================================================
// MyTube — local FTS5 search integration tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These run against tests/helpers/fake-d1.js, which executes every statement in
// real SQLite, so the migration, the triggers, the tokenizer, weighted bm25 and
// the query builder are all exercised for real rather than mocked.
//
// Coverage required by Phase 2 / Phase 1:
//   * migration 0003 applies and re-indexes pre-existing rows
//   * prefix queries, multi-word queries and the OR fallback
//   * title matches outrank description-only matches, and the declared field
//     weights rank title > channel > tags > topic > description
//   * deterministic bm25 ordering, and the rowid tiebreak that declares it
//   * INSERT / UPDATE / DELETE triggers keep the index in sync
//   * duplicate tokens, the token cap, hostile input and empty input
//   * results come from the data (not hardcoded)
//
// Run: node --test tests/testSearchFts.js
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createFakeD1 } from "./helpers/fake-d1.js";
import {
  upsertVideos,
  searchVideoIds,
  buildFtsMatchQuery,
  buildFtsMatchQueryAny,
  FTS_MATCH_MAX_TOKENS,
  FTS_BM25_WEIGHTS,
  VIDEO_SEARCH_LIMIT_MAX,
  VIDEO_SEARCH_SQL
} from "../shared/index-store.js";

const migrationSql = name =>
  readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");

// A minimal but complete `videos.list` item. `topic` is set through upsert
// options (see topicItem below), matching how the real caller works.
function videoItem(videoId, title, options = {}) {
  const {
    description = "",
    channel = "Test Channel",
    tags = [],
    viewCount = "10"
  } = options;

  return {
    kind: "youtube#video",
    id: videoId,
    snippet: {
      title,
      description,
      tags,
      publishedAt: "2024-01-02T03:04:05Z",
      channelId: "UC_" + videoId,
      channelTitle: channel,
      thumbnails: { medium: { url: "https://i.ytimg.com/vi/" + videoId + "/hq.jpg" } }
    },
    contentDetails: { duration: "PT3M33S" },
    statistics: { viewCount },
    status: { embeddable: true, madeForKids: false, license: "standard" },
    topicDetails: { topicId: "10" }
  };
}

const seed = (db, items, options) => upsertVideos(db, items, options);
const ids = rows => rows.map(row => row.video_id);

// Shared main fixture. Scores are not asserted directly except in the dedicated
// ranking test; most tests only care which rows are returned and in what order.
async function mainFixture() {
  const db = createFakeD1();

  await seed(db, [
    videoItem("aaaaaaaaaaa", "lofi beats to relax", {
      description: "chill music for studying",
      channel: "ChillLoops",
      tags: ["lofi", "chill"]
    }),
    videoItem("bbbbbbbbbbb", "lofi girl live stream", {
      description: "always on radio",
      channel: "ChillLoops",
      tags: ["lofi"]
    }),
    videoItem("ccccccccccc", "web development tutorial", {
      description: "learn html css and javascript",
      channel: "DevAcademy",
      tags: ["web", "dev"]
    }),
    videoItem("ddddddddddd", "guitar solo lesson", {
      description: "advanced guitar techniques",
      channel: "GuitarPro",
      tags: ["guitar"]
    }),
    videoItem("eeeeeeeeeee", "random clip", {
      description: "lofi beats lofi beats lofi beats",
      channel: "Other",
      tags: []
    })
  ]);

  return db;
}

// A raw `videos` row. The mapper in shared/index-store.js always derives a topic
// from tags, so a NULL topic is only reachable by writing the column directly —
// which is exactly the case migration 0003 has to survive, since 0001 declares
// `topic TEXT` with no NOT NULL.
const VIDEO_INSERT_COLUMNS = [
  "source_id",
  "type",
  "video_id",
  "title",
  "title_lower",
  "description",
  "channel_id",
  "channel_title",
  "thumb_url",
  "published_at_ms",
  "duration_seconds",
  "category_id",
  "tags_json",
  "topic",
  "view_count",
  "embeddable",
  "is_live",
  "origin",
  "first_seen_at_ms",
  "last_seen_at_ms",
  "metadata_fetched_at_ms"
];

// Insert one row where `overrides` names the columns that differ from a neutral
// filler, so a token can be placed in exactly one field and its field weight
// measured in isolation.
async function rawInsert(db, videoId, overrides = {}) {
  const row = {
    source_id: "yt:" + videoId,
    type: "youtube",
    video_id: videoId,
    title: "filler",
    title_lower: "filler",
    description: "filler",
    channel_id: "",
    channel_title: "filler",
    thumb_url: "",
    published_at_ms: 1,
    duration_seconds: 1,
    category_id: "1",
    tags_json: "[]",
    topic: null,
    view_count: 1,
    embeddable: 1,
    is_live: 0,
    origin: "test",
    first_seen_at_ms: 1,
    last_seen_at_ms: 1,
    metadata_fetched_at_ms: 1,
    ...overrides
  };

  const placeholders = VIDEO_INSERT_COLUMNS.map(() => "?").join(", ");

  await db
    .prepare(
      "INSERT INTO videos (" + VIDEO_INSERT_COLUMNS.join(", ") + ") VALUES (" + placeholders + ")"
    )
    .bind(...VIDEO_INSERT_COLUMNS.map(column => row[column]))
    .run();

  return videoId;
}

// FTS5's own consistency check. This is what catches an index that has drifted
// from the content table in a way a MATCH query would quietly hide — the command
// itself throws when the index is inconsistent.
async function checkFtsIntegrity(db) {
  await db.prepare("INSERT INTO video_fts (video_fts) VALUES ('integrity-check')").run();
}

// ---------------------------------------------------------------------------
// Migration 0003
// ---------------------------------------------------------------------------

test("migration 0003 creates the FTS table, indexes and triggers", async () => {
  const db = createFakeD1();

  const names = (await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' OR type = 'trigger'"
  ).all()).results.map(row => row.name);

  assert.ok(names.includes("video_fts"));
  assert.ok(names.includes("videos_fts_ai"));
  assert.ok(names.includes("videos_fts_ad"));
  assert.ok(names.includes("videos_fts_au"));

  // The FTS definition carries the new tokenizer and prefix option.
  const ddl = (await db.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'video_fts'"
  ).first()).sql;

  assert.match(ddl, /unicode61 remove_diacritics 2/);
  assert.match(ddl, /prefix='2 3'/);
  assert.match(ddl, /topic/);
  db.close();
});

test("migration 0003 rebuilds the index over rows that already existed", async () => {
  // Apply 0001+0002 only, populate, then apply 0003 to prove the rebuild picks
  // up pre-existing rows (the migration path that matters in production).
  const db = createFakeD1({ migrations: false });
  db.exec(migrationSql("0001_init.sql"));
  db.exec(migrationSql("0002_video_id_lookup_index.sql"));

  await seed(db, [
    videoItem("aaaaaaaaaaa", "prehistoric lofi recording", { description: "ancient tape" }),
    videoItem("bbbbbbbbbbb", "ambient rainforest", { description: "field recording" })
  ]);

  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM videos").first()).c, 2);

  db.exec(migrationSql("0003_fts_tokenizer.sql"));

  // Rebuild indexed every surviving row exactly once.
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM video_fts").first()).c, 2);

  // Old rows are searchable, now with prefix matching.
  assert.deepEqual(ids(await searchVideoIds(db, "prehist", 10)), ["aaaaaaaaaaa"]);
  assert.deepEqual(ids(await searchVideoIds(db, "rain", 10)), ["bbbbbbbbbbb"]);

  // The rebuilt index agrees with the content table, token for token.
  await checkFtsIntegrity(db);
  db.close();
});

test("migration 0003 leaves no row from the old index behind", async () => {
  // The rebuild must be a REPLACE, not an append: a term that used to be
  // indexed and has since been renamed must not survive into the new index.
  const db = createFakeD1({ migrations: false });
  db.exec(migrationSql("0001_init.sql"));
  db.exec(migrationSql("0002_video_id_lookup_index.sql"));

  await rawInsert(db, "aaaaaaaaaaa", { title: "obsolete keyword", tags_json: "[]" });

  // Same row, renamed directly in the content table while only the 0001 triggers
  // are installed, then migrated.
  await db.prepare("UPDATE videos SET title = ? WHERE video_id = ?")
    .bind("fresh keyword", "aaaaaaaaaaa")
    .run();

  db.exec(migrationSql("0003_fts_tokenizer.sql"));

  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM video_fts").first()).c, 1);
  assert.deepEqual(ids(await searchVideoIds(db, "obsolete", 10)), []);
  assert.deepEqual(ids(await searchVideoIds(db, "fresh", 10)), ["aaaaaaaaaaa"]);
  await checkFtsIntegrity(db);
  db.close();
});

test("migration 0003 is safe to re-apply", async () => {
  const db = createFakeD1({ migrations: false });
  db.exec(migrationSql("0001_init.sql"));
  db.exec(migrationSql("0002_video_id_lookup_index.sql"));
  await seed(db, [videoItem("aaaaaaaaaaa", "repeatable migration")]);

  const sql = migrationSql("0003_fts_tokenizer.sql");
  db.exec(sql);
  db.exec(sql);

  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM video_fts").first()).c, 1);
  assert.deepEqual(ids(await searchVideoIds(db, "repeatable", 10)), ["aaaaaaaaaaa"]);

  // The triggers must still exist exactly once after the drop/recreate cycle.
  const triggers = (await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'videos_fts%' ORDER BY name"
  ).all()).results.map(row => row.name);

  assert.deepEqual(triggers, ["videos_fts_ad", "videos_fts_ai", "videos_fts_au"]);
  await checkFtsIntegrity(db);
  db.close();
});

test("the new topic column does not disturb the other four indexed fields", async () => {
  // Adding a 5th column to an external-content FTS5 table remaps every column by
  // NAME against `videos`. If the new column had shifted one, the pre-existing
  // fields would stop being searchable — this is the schema-compatibility claim
  // migration 0003 makes, so it is asserted rather than assumed.
  const db = createFakeD1();

  await rawInsert(db, "11111111111", { title: "titledrow", channel_title: "chanrow", description: "descrow" });
  await rawInsert(db, "22222222222", { title: "plainrow", topic: "topicrow" });

  assert.deepEqual(ids(await searchVideoIds(db, "titledrow", 10)), ["11111111111"]);
  assert.deepEqual(ids(await searchVideoIds(db, "chanrow", 10)), ["11111111111"]);
  assert.deepEqual(ids(await searchVideoIds(db, "descrow", 10)), ["11111111111"]);
  assert.deepEqual(ids(await searchVideoIds(db, "topicrow", 10)), ["22222222222"]);

  // And the column filter targets the fields by name, not by position.
  const scoped = await db
    .prepare("SELECT v.video_id FROM video_fts f JOIN videos v ON v.rowid = f.rowid WHERE video_fts MATCH ?")
    .bind("title:chanrow")
    .all();

  assert.deepEqual(scoped.results.map(row => row.video_id), []);
  await checkFtsIntegrity(db);
  db.close();
});

// ---------------------------------------------------------------------------
// Tokenizer: diacritic folding, proved by behaviour
// ---------------------------------------------------------------------------

test("remove_diacritics 2 folds indexed text, not just the migration DDL", async () => {
  // Migration 0003's central claim is that diacritics fold, so this runs rows
  // through the real tokenizer and the real MATCH path. Asserting it only by
  // regex-matching sqlite_master proves the DDL says so; this proves the index
  // behaves that way.
  //
  // HONEST SCOPE, verified against SQLite 3.51.3: this test canNOT distinguish
  // `remove_diacritics 2` from 1 or from the 0001 default. Measured across
  // Latin, Greek, Cyrillic, Hebrew, Arabic, Devanagari and Thai, modes 0, 1 and
  // 2 produce identical MATCH results, and 0001's unconfigured tokenizer already
  // folded "café" to "cafe". So this is a regression guard on diacritic FOLDING,
  // not proof of the "2" setting — the DDL regex in the migration test above is
  // the only assertion that pins that value, which is why it is worth keeping.
  //
  // Both directions are asserted on purpose: an ASCII query must find the
  // accented document AND an accented query must find the same document. A
  // query-side-only fold would satisfy one and fail the other.
  const db = createFakeD1();

  // Literal characters, so the exact code points under test stay readable: e-acute
  // in "café résumé" and i-diaeresis in "naïve".
  const CAFE = "café résumé study session";
  const NAIVE = "naïve approach explained";

  await seed(db, [
    videoItem("ccccccccccc", CAFE, { description: "accents included" }),
    videoItem("nnnnnnnnnnn", NAIVE, { description: "accents included" })
  ]);

  // The index really does hold the accented form.
  const stored = (await db.prepare("SELECT title FROM videos WHERE video_id = ?")
    .bind("ccccccccccc")
    .first()).title;
  assert.equal(stored, CAFE);

  // Unaccented query -> accented document.
  assert.deepEqual(ids(await searchVideoIds(db, "cafe", 10)), ["ccccccccccc"]);
  assert.deepEqual(ids(await searchVideoIds(db, "resume", 10)), ["ccccccccccc"]);
  assert.deepEqual(ids(await searchVideoIds(db, "naive", 10)), ["nnnnnnnnnnn"]);

  // Accented query, both cases -> the same document.
  assert.deepEqual(ids(await searchVideoIds(db, "café", 10)), ["ccccccccccc"]);
  assert.deepEqual(ids(await searchVideoIds(db, "CAFÉ", 10)), ["ccccccccccc"]);
  assert.deepEqual(ids(await searchVideoIds(db, "CAFÉ", 10)), ids(await searchVideoIds(db, "cafe", 10)));
  assert.deepEqual(ids(await searchVideoIds(db, "naïve", 10)), ["nnnnnnnnnnn"]);

  // The folded query still resolves to the accented row, not an ASCII row.
  assert.equal((await searchVideoIds(db, "cafe", 10))[0].title, CAFE);

  // And it is the SAME token: an exact (non-prefix) match works too, which a
  // substring coincidence could not explain.
  assert.equal(buildFtsMatchQuery("cafe"), '"cafe"*');
  const exact = (await db
    .prepare("SELECT v.video_id FROM video_fts f JOIN videos v ON v.rowid = f.rowid WHERE video_fts MATCH ?")
    .bind('"cafe"')
    .all()).results.map(row => row.video_id);
  assert.deepEqual(exact, ["ccccccccccc"], "the ASCII token must match the accented document exactly");

  await checkFtsIntegrity(db);
  db.close();
});

// ---------------------------------------------------------------------------
// Prefix matching
// ---------------------------------------------------------------------------

test("prefix queries match incomplete words", async () => {
  const db = await mainFixture();

  // "lof" is not a whole token in any row; the builder emits a prefix query.
  assert.equal(buildFtsMatchQuery("lof"), '"lof"*');
  assert.deepEqual(
    new Set(ids(await searchVideoIds(db, "lof", 10))),
    new Set(["aaaaaaaaaaa", "bbbbbbbbbbb", "eeeeeeeeeee"])
  );

  assert.deepEqual(ids(await searchVideoIds(db, "guit", 10)), ["ddddddddddd"]);
  assert.deepEqual(ids(await searchVideoIds(db, "devel", 10)), ["ccccccccccc"]);
  db.close();
});

test("a one-character token does not prefix-match everything", async () => {
  const db = await mainFixture();

  // "z" is exact; no row contains the token "z", so there is no match. (A
  // prefix would have matched nothing here too, but the builder must not emit
  // "z"*; that is asserted directly below.)
  assert.equal(buildFtsMatchQuery("z"), '"z"');
  assert.deepEqual(await searchVideoIds(db, "z", 10), []);
  db.close();
});

// ---------------------------------------------------------------------------
// Multi-word queries and the OR fallback
// ---------------------------------------------------------------------------

test("multi-word search requires every token when that is possible", async () => {
  const db = await mainFixture();

  // "lofi beats" appears together in a's title and e's description, but not in
  // b (which has "lofi" but not "beats").
  const hits = ids(await searchVideoIds(db, "lofi beats", 10));

  assert.ok(hits.includes("aaaaaaaaaaa"));
  assert.ok(hits.includes("eeeeeeeeeee"));
  assert.ok(!hits.includes("bbbbbbbbbbb"), "AND must exclude the row missing a token");
  db.close();
});

test("a multi-word query with one absent token falls back to any-token recall", async () => {
  const db = await mainFixture();

  const before = db.stats.all;
  const hits = ids(await searchVideoIds(db, "lofi zzzznotthere", 10));

  assert.ok(hits.length > 0, "the OR fallback must prevent an empty page");
  assert.ok(hits.includes("aaaaaaaaaaa"));
  assert.equal(db.stats.all - before, 2, "AND then OR = exactly two reads");
  db.close();
});

test("a query whose AND form matches runs only one read", async () => {
  const db = await mainFixture();

  const before = db.stats.all;
  await searchVideoIds(db, "lofi beats", 10);

  assert.equal(db.stats.all - before, 1, "no fallback when AND already matches");
  db.close();
});

test("single-token queries never trigger the fallback round-trip", async () => {
  const db = await mainFixture();

  const before = db.stats.all;
  await searchVideoIds(db, "lofi", 10);

  assert.equal(db.stats.all - before, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("title matches outrank description-only matches", async () => {
  const db = createFakeD1();

  await seed(db, [
    videoItem("ttttttttttt", "kryptonite discovery", { description: "science news" }),
    videoItem("ddddddddddd", "miscellaneous update", {
      description: "kryptonite kryptonite kryptonite kryptonite kryptonite"
    })
  ]);

  const hits = await searchVideoIds(db, "kryptonite", 10);

  assert.deepEqual(ids(hits), ["ttttttttttt", "ddddddddddd"]);
  assert.ok(hits[0].match_score < hits[1].match_score, "lower bm25 = better");
  db.close();
});

test("the field weights rank title > channel > tags > topic > description", async () => {
  // bm25() weights only mean something in isolation, so the token is placed in
  // EXACTLY one field per row and every other field is identical filler. The
  // expected order is the declared weight order in FTS_BM25_WEIGHTS, read
  // straight out of the module so the two cannot drift.
  const db = createFakeD1();

  await rawInsert(db, "55555555555", { description: "kryptonite" });
  await rawInsert(db, "44444444444", { topic: "kryptonite" });
  await rawInsert(db, "33333333333", { tags_json: "[\"kryptonite\"]" });
  await rawInsert(db, "22222222222", { channel_title: "kryptonite" });
  await rawInsert(db, "11111111111", { title: "kryptonite" });

  const hits = await searchVideoIds(db, "kryptonite", 10);

  assert.equal(hits.length, 5, "every row must be found");
  assert.deepEqual(ids(hits), [
    "11111111111", // title        weight 5
    "22222222222", // channel_title weight 3
    "33333333333", // tags_json    weight 2
    "44444444444", // topic        weight 1.5
    "55555555555"  // description  weight 1
  ]);

  // Monotonically worse scores down the list, and no two rows tie — otherwise
  // the rowid tiebreak would be doing the work instead of the weights.
  const scores = hits.map(row => row.match_score);
  assert.equal(new Set(scores).size, 5, "distinct weights must produce distinct scores");
  assert.deepEqual(scores, [...scores].sort((a, b) => a - b), "scores must ascend (lower is better)");

  // The declaration itself, so a weight edit cannot silently pass on stale order.
  assert.deepEqual(FTS_BM25_WEIGHTS, [5, 3, 1, 2, 1.5]);
  db.close();
});

test("description is weighted below title even when it repeats the term", async () => {
  // Repetition raises term frequency but cannot overcome a 5x title weight, so a
  // keyword-stuffed description still loses to a plain title hit.
  const db = createFakeD1();

  await rawInsert(db, "ddddddddddd", {
    title: "filler",
    description: "kryptonite kryptonite kryptonite kryptonite kryptonite"
  });
  await rawInsert(db, "ttttttttttt", { title: "kryptonite", description: "filler" });

  assert.deepEqual(ids(await searchVideoIds(db, "kryptonite", 10)), ["ttttttttttt", "ddddddddddd"]);
  db.close();
});

test("channel title is indexed and searchable", async () => {
  const db = await mainFixture();

  assert.deepEqual(ids(await searchVideoIds(db, "chillloops", 10)).sort(), [
    "aaaaaaaaaaa",
    "bbbbbbbbbbb"
  ]);
  db.close();
});

test("bm25 ranking is deterministic across repeated identical calls", async () => {
  const db = await mainFixture();

  const runs = [];
  for (let i = 0; i < 5; i++) {
    runs.push(ids(await searchVideoIds(db, "lofi", 10)));
  }

  for (const run of runs) {
    assert.deepEqual(run, runs[0]);
  }
  db.close();
});

test("a colliding-score page is ordered and stable across runs", async () => {
  const db = createFakeD1();

  await seed(db, [
    videoItem("ttttttttttt", "identical title text"),
    videoItem("uuuuuuuuuuu", "identical title text"),
    videoItem("vvvvvvvvvvv", "identical title text")
  ]);

  const hits = await searchVideoIds(db, "identical", 10);

  assert.equal(hits.length, 3);
  assert.equal(new Set(hits.map(row => row.match_score)).size, 1, "fixture must tie on bm25");
  assert.deepEqual(ids(hits), ["ttttttttttt", "uuuuuuuuuuu", "vvvvvvvvvvv"]);

  // Stable on a second run.
  assert.deepEqual(ids(await searchVideoIds(db, "identical", 10)), ids(hits));
  db.close();
});

test("the ORDER BY tiebreak is declared, and is not redundant to remove", async () => {
  // HONEST LIMITATION, stated rather than papered over: on this SQLite build an
  // FTS5 query ordered by bm25() alone ALREADY returns equal-scoring rows in
  // rowid order, so no behavioural test can observe the tiebreak doing (or not
  // doing) anything here — with the clause removed, these very assertions still
  // pass. It is asserted structurally instead, which is the only check that
  // actually fails when the clause is dropped.
  //
  // It stays in the SQL because that is a guarantee about SQLite's ORDER BY, not
  // about this build's current sorter: SQLite documents nothing about tie order,
  // and the tie-break is what makes repeated pages of an equal-scoring result set
  // safe to paginate. Verified empirically at 60 colliding rows across 30 runs:
  // zero divergences with and without the clause.
  assert.ok(
    VIDEO_SEARCH_SQL.includes("ORDER BY match_score, v.rowid"),
    "the deterministic tiebreak must be part of the statement"
  );
  assert.ok(
    !/ORDER BY\s+match_score\s+LIMIT/i.test(VIDEO_SEARCH_SQL),
    "a bare ORDER BY match_score would leave ties unordered"
  );
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

test("UPDATE keeps the FTS index synchronised", async () => {
  const db = await mainFixture();

  await upsertVideos(db, [
    videoItem("aaaaaaaaaaa", "renamed xylophone session", {
      description: "completely different",
      channel: "ChillLoops",
      tags: ["lofi", "chill"]
    })
  ]);

  assert.deepEqual(await searchVideoIds(db, "relax", 10).then(ids), [], "old term must be gone");
  assert.deepEqual(await searchVideoIds(db, "xylophone", 10).then(ids), ["aaaaaaaaaaa"]);
  db.close();
});

test("DELETE keeps the FTS index synchronised", async () => {
  const db = await mainFixture();

  await db.prepare("DELETE FROM videos WHERE source_id = ?").bind("yt:bbbbbbbbbbb").run();

  assert.deepEqual(await searchVideoIds(db, "girl", 10).then(ids), []);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM video_fts").first()).c, 4);
  db.close();
});

test("INSERT keeps the FTS index synchronised", async () => {
  const db = await mainFixture();

  await seed(db, [videoItem("nnnnnnnnnnn", "brand new harmonica jam", { tags: ["harmonica"] })]);

  assert.deepEqual(await searchVideoIds(db, "harmonica", 10).then(ids), ["nnnnnnnnnnn"]);
  db.close();
});

test("the triggers round-trip a NULL topic without corrupting the index", async () => {
  // 0001 declares `topic TEXT` with no NOT NULL, so a NULL topic is legal data.
  // The mapper happens to always derive one, but the FTS triggers hand NULL to
  // the index on every INSERT/UPDATE/DELETE, and a mismatch between the value
  // used to index and the value used to delete corrupts an external-content
  // index permanently. This is the case that must not be taken on trust.
  const db = createFakeD1();

  await rawInsert(db, "aaaaaaaaaaa", { title: "nulltopicrow", topic: null });
  assert.deepEqual(ids(await searchVideoIds(db, "nulltopic", 10)), ["aaaaaaaaaaa"]);

  // NULL -> value: the delete half must match what the insert half wrote.
  await db.prepare("UPDATE videos SET topic = ? WHERE video_id = ?")
    .bind("Aeronautics", "aaaaaaaaaaa")
    .run();
  assert.deepEqual(ids(await searchVideoIds(db, "aeronau", 10)), ["aaaaaaaaaaa"], "prefix on the new topic");
  await checkFtsIntegrity(db);

  // value -> NULL and back again, repeatedly.
  for (const value of [null, "again", null, "again"]) {
    await db.prepare("UPDATE videos SET topic = ? WHERE video_id = ?").bind(value, "aaaaaaaaaaa").run();
    await checkFtsIntegrity(db);
  }

  assert.deepEqual(ids(await searchVideoIds(db, "aeronau", 10)), [], "topic must be gone when NULL");
  assert.deepEqual(ids(await searchVideoIds(db, "again", 10)), ["aaaaaaaaaaa"]);

  // The row's own text is untouched by all of that.
  assert.deepEqual(ids(await searchVideoIds(db, "nulltopic", 10)), ["aaaaaaaaaaa"]);

  // Deleting a NULL-topic row must not leave a dangling posting either.
  await db.prepare("DELETE FROM videos WHERE source_id = ?").bind("yt:aaaaaaaaaaa").run();
  assert.deepEqual(ids(await searchVideoIds(db, "nulltopic", 10)), []);
  await checkFtsIntegrity(db);
  db.close();
});

test("an unsearchable query never reaches the database", async () => {
  // A blank query must not be turned into an empty MATCH string, which FTS5
  // rejects, and must not be turned into a match-everything query either.
  const db = await mainFixture();
  const before = db.stats.all;

  // Nothing in these carries a letter or a digit, so there is nothing to ask
  // the index about. ({}, notably, is NOT here: String({}) is "[object Object]".)
  for (const input of ["", "   ", "...", "*** ---", "- - -", null, undefined, [], () => {}]) {
    assert.deepEqual(await searchVideoIds(db, input, 10), [], "for input " + JSON.stringify(input));
  }

  assert.equal(db.stats.all - before, 0, "no MATCH statement may be issued");
  db.close();
});

test("non-string input is coerced to text rather than trusted or thrown on", async () => {
  // The builder takes a string, so anything else has to be coerced the same way
  // D1 would bind it. These DO become real queries (a number is legitimate
  // search text); what must hold is that they are tokenised safely and never
  // reach the database as a raw value or an FTS5 syntax error.
  const db = createFakeD1();
  await rawInsert(db, "11111111111", { title: "volume 42 explained" });
  await rawInsert(db, "22222222222", { title: "true crime documentary" });

  assert.deepEqual(ids(await searchVideoIds(db, 42, 10)), ["11111111111"]);
  assert.deepEqual(ids(await searchVideoIds(db, true, 10)), ["22222222222"]);
  assert.deepEqual(ids(await searchVideoIds(db, { toString: () => "explained" }, 10)), ["11111111111"]);

  // A hostile object cannot smuggle operators in: only its text survives.
  const hostile = { toString: () => '" OR 1=1 --' };

  assert.deepEqual(await searchVideoIds(db, hostile, 10), []);
  assert.match(
    buildFtsMatchQuery(hostile),
    /^"[^"]+"\*?(?: (?:AND|OR) "[^"]+"\*?)*$/,
    "an object with a hostile toString must still be quoted term by term"
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Query hygiene
// ---------------------------------------------------------------------------

test("duplicate tokens collapse to a single term", async () => {
  const db = await mainFixture();

  assert.equal(buildFtsMatchQuery("lofi lofi LOFI"), '"lofi"*');
  assert.deepEqual(
    ids(await searchVideoIds(db, "lofi lofi LOFI", 10)),
    ids(await searchVideoIds(db, "lofi", 10))
  );
  db.close();
});

test("the token cap bounds the MATCH expression and the query still runs", async () => {
  const db = await mainFixture();

  // The bound is PINNED here rather than read back from the module. Deriving
  // both the input and the expectation from FTS_MATCH_MAX_TOKENS makes the test
  // self-referential: it passes for ANY value of the constant, including one
  // large enough that the cap stops being a cap. These literals are what
  // actually fail when the cap is raised or removed.
  const PINNED_CAP = 12;

  assert.equal(FTS_MATCH_MAX_TOKENS, PINNED_CAP, "the cap is a deliberate, pinned limit");

  const huge = Array.from({ length: 2000 }, (_, i) => "token" + i).join(" ");
  const built = buildFtsMatchQuery(huge);

  assert.equal(built.split(" AND ").length, PINNED_CAP, "a 2000-word paste must not build 2000 terms");
  assert.ok(built.includes('"token' + (PINNED_CAP - 1) + '"*'), "the last kept token is the cap's edge");
  assert.ok(!built.includes('"token' + PINNED_CAP + '"*'), "nothing past the cap may survive");

  // No tokens match, so AND fails; OR fallback covers any real token ("lofi").
  const hits = ids(await searchVideoIds(db, "lofi " + huge, 10));
  assert.ok(hits.includes("aaaaaaaaaaa"));

  // The recall fallback is capped too, so a paste cannot become a 2000-term OR.
  assert.equal(buildFtsMatchQueryAny(huge).split(" OR ").length, PINNED_CAP);
  db.close();
});

test("hostile FTS syntax is contained by the query builder", async () => {
  const db = await mainFixture();
  const tableCount = (await db.prepare("SELECT COUNT(*) AS c FROM videos").first()).c;

  const hostile = [
    'a" OR "b',
    "a* OR b*",
    "NEAR(a b)",
    "title:secret",
    '); DROP TABLE videos; --',
    "1=1",
    '" OR "1"="1" OR "',
    "AND OR NOT",
    "{}[]()^$",
    "%%%%"
  ];

  for (const input of hostile) {
    const built = buildFtsMatchQuery(input);

    if (built !== null) {
      assert.match(
        built,
        /^"[^"]+"\*?(?: (?:AND|OR) "[^"]+"\*?)*$/,
        "unsafe expression for " + JSON.stringify(input)
      );
    }

    const result = await searchVideoIds(db, input, 10);
    assert.ok(Array.isArray(result), "must return an array for " + JSON.stringify(input));
  }

  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM videos").first()).c, tableCount);
  db.close();
});

test("empty and invalid input is handled safely", async () => {
  const db = await mainFixture();

  for (const input of ["", "   ", "...", "*** ---", null, undefined, "- - -"]) {
    assert.deepEqual(await searchVideoIds(db, input, 10), []);
    assert.equal(buildFtsMatchQuery(input), null);
    assert.equal(buildFtsMatchQueryAny(input), null);
  }
  db.close();
});

test("1000+ adversarial queries never throw and never leak a raw FTS operator", async () => {
  // Property-style safety net for the query builder. The hand-written hygiene
  // cases above are specific regressions; this one asserts the general
  // invariant that NO input can break out of a quoted phrase.
  //
  // The invariant, by construction of the tokenizer: only \p{L}\p{N} survive
  // tokenization, so every term is wrapped in double quotes and the only legal
  // structural characters are the AND/OR joiners and the trailing "*". Any raw
  // FTS operator surviving into the expression fails this regex.
  const db = await mainFixture();

  // Deterministic LCG. Math.random() would make a failure unreproducible.
  let seedState = 0x9e3779b9;
  const nextInt = bound => {
    seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0;
    return seedState % bound;
  };

  // One entry per hostile category the builder has to neutralise.
  const FRAGMENTS = [
    '"', "'", '""', '"""', "''",
    "*", "**", "*:*", "a*",
    "(", ")", "()", "((", ")", "( OR (",
    ":", "a:", ":b", "title:", "title:(a OR b)",
    "^", "a^b", "^a",
    "-", "a-b", "--", "a - b",
    "+", "a+b", "++", "c++",
    "\\", "\\\\", '\\"', "a\\b", "\\\\*",
    "AND", "OR", "NOT", "NEAR", "a AND b", "a OR b", "NOT a", "a NEAR b",
    "and", "or", "not", "near", "a and or not b",
    "\u0000", "\u0001", "\u0007", "\u0008", "\u000b", "\u001b", "\u001f", "\u007f",
    "\t", "\n", "\r", "\u2028", "\u2029", "\u00a0",
    "lofi", "guitar", "2024", "007", "42", "c", "x",
    "\u65e5\u672c\u8a9e", "\ud83c\udfac", "\u03a9", "\u00e9", "\u00fc", "\u00df", "\u0130",
    "caf\u00e9", "na\u00efve", "r\u00e9sum\u00e9", "\u00c5ngstr\u00f6m", "\u0141\u00f3d\u017a",
    "\ud800", "\udfff", "\ud83d", "\udc00",
    "\u200f", "\u202b", "\u202e", "\u2067", "\u2066",
    "\u05e2\u05d1\u05e8\u05d9\u05ea", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629",
    "\u200b", "\u200d", "\ufeff", "\u00ad", "\u2060",
    "'; DROP TABLE videos; --", '" OR "1"="1', "1 OR 1=1", "%", "_", "0x41", "../../etc/passwd"
  ];

  // \p{M} is legal inside a token: NFKC decomposes "İ" into "i" + COMBINING DOT
  // ABOVE and never recomposes it, so marks can survive tokenization. A quoted
  // mark is still inert, which is what these two patterns actually certify.
  const FTS_STRUCTURE = /^"[\p{L}\p{N}\p{M}]+"\*?(?: (?:AND|OR) "[\p{L}\p{N}\p{M}]+"\*?)*$/u;
  const WHITELIST = /^[\p{L}\p{N}\p{M}"* ]+$/u;

  let checked = 0;
  let nonNull = 0;

  for (let i = 0; i < 1000; i += 1) {
    let input = "";
    const parts = 1 + nextInt(4);

    for (let p = 0; p < parts; p += 1) input += FRAGMENTS[nextInt(FRAGMENTS.length)];

    // Builders must never throw, whatever the bytes are.
    const and = buildFtsMatchQuery(input);
    const any = buildFtsMatchQueryAny(input);

    if (and !== null) {
      nonNull += 1;
      assert.match(and, FTS_STRUCTURE, "malformed MATCH expression for " + JSON.stringify(input));
      assert.match(and, WHITELIST, "raw operator leaked into " + JSON.stringify(input));

      // The OR fallback is the same token set with a different joiner.
      assert.equal(any, and.replaceAll(" AND ", " OR "));

      const terms = and.split(" AND ").length;
      assert.ok(terms >= 1 && terms <= FTS_MATCH_MAX_TOKENS, "term count out of range: " + and);
      assert.equal(any.split(" OR ").length, terms);
    } else {
      assert.equal(any, null, "the OR builder must also be null");
    }

    // And the whole call path must survive, not just the builder.
    const hits = await searchVideoIds(db, input, 10);
    assert.ok(Array.isArray(hits), "not an array for " + JSON.stringify(input));

    checked += 1;
  }

  // The corpus must actually have exercised the interesting paths, or this
  // test could pass while only ever seeing empty strings.
  assert.equal(checked, 1000);
  assert.ok(nonNull >= 100, "expected real MATCH expressions, got " + nonNull);
  assert.ok(nonNull < checked, "expected some inputs to be rejected entirely");

  db.close();
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test("the result limit is respected and clamped", async () => {
  const db = await mainFixture();

  assert.ok((await searchVideoIds(db, "lofi", 1)).length === 1);
  assert.ok((await searchVideoIds(db, "lofi", 0)).length >= 1, "limit clamps up to 1");
  db.close();
});

test("an over-limit request is clamped down to VIDEO_SEARCH_LIMIT_MAX", async () => {
  // Pinned to a literal so a change to the constant cannot silently move both
  // sides of this assertion. The expected value must NOT come from the runtime
  // `limit` argument, or the assertion would be vacuous.
  assert.equal(VIDEO_SEARCH_LIMIT_MAX, 50);

  // 60 matching rows, so the clamp actually binds. With fewer rows than the
  // cap this test would pass even if the clamp were deleted.
  const db = createFakeD1();
  const many = Array.from({ length: 60 }, (_, i) =>
    videoItem("l" + String(i).padStart(10, "0"), "lofi hip hop mix number " + i)
  );
  await seed(db, many);

  // Every limit is clamped, so an over-cap request cannot be used to measure the
  // true match count. Count it with raw SQL instead, to prove the clamp binds.
  const matchable = (await db
    .prepare("SELECT COUNT(*) AS n FROM video_fts WHERE video_fts MATCH ?")
    .bind('"lofi"*')
    .first()).n;
  assert.ok(matchable > VIDEO_SEARCH_LIMIT_MAX,
    "fixture must contain more matches than the cap, got " + matchable);

  for (const requested of [100, 500]) {
    const hits = await searchVideoIds(db, "lofi", requested);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length <= VIDEO_SEARCH_LIMIT_MAX,
      "limit " + requested + " returned " + hits.length + " rows, above the cap");
    assert.equal(hits.length, VIDEO_SEARCH_LIMIT_MAX, "the clamp should bind for limit " + requested);
  }

  // Clamping is a row-count cut, not a filter change: the rows returned for an
  // over-limit request are exactly the top rows an at-cap request returns, and
  // every one of them genuinely matches.
  assert.deepEqual(ids(await searchVideoIds(db, "lofi", 500)), ids(await searchVideoIds(db, "lofi", 50)));

  const returned = ids(await searchVideoIds(db, "lofi", 500));
  const placeholders = returned.map(() => "?").join(",");
  const genuinelyMatching = (await db
    .prepare("SELECT COUNT(*) AS n FROM video_fts f JOIN videos v ON v.rowid = f.rowid"
      + " WHERE video_fts MATCH ? AND v.video_id IN (" + placeholders + ")")
    .bind('"lofi"*', ...returned)
    .first()).n;
  assert.equal(genuinelyMatching, returned.length);

  db.close();
});

// ---------------------------------------------------------------------------
// Results come from data, not hardcoding
// ---------------------------------------------------------------------------

test("search results change with the underlying data", async () => {
  const db = await mainFixture();

  assert.deepEqual(ids(await searchVideoIds(db, "guitar", 10)), ["ddddddddddd"]);

  await db.prepare("DELETE FROM videos WHERE source_id = ?").bind("yt:ddddddddddd").run();
  assert.deepEqual(await searchVideoIds(db, "guitar", 10), [], "deleting the row removes the hit");

  await seed(db, [videoItem("ggggggggggg", "guitar gear review", { tags: ["guitar"] })]);
  assert.deepEqual(ids(await searchVideoIds(db, "guitar", 10)), ["ggggggggggg"], "new data is searchable");
  db.close();
});

test("topic is indexed and searchable", async () => {
  const db = createFakeD1();

  // topic is a per-write option, so this row is seeded on its own.
  await seed(db, [videoItem("ppppppppppp", "clip with no title keywords", { description: "nothing here" })], {
    topic: "QuantumPhysics"
  });

  assert.deepEqual(ids(await searchVideoIds(db, "quantum", 10)), ["ppppppppppp"]);
  db.close();
});

test("a query matching nothing returns an empty array, not a throw", async () => {
  const db = await mainFixture();

  assert.deepEqual(await searchVideoIds(db, "zzzznonexistentzzzz", 10), []);
  db.close();
});
