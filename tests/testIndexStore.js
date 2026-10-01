// =============================================================================
// MyTube — D1 index storage layer unit tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// Pure/unit coverage only: the mapper, the duration parser, the generated
// statement and the FTS5 query builder. No D1 binding is required and none is
// faked — see the D1 write/read integration tests that are deliberately absent.
//
// Run: node --test tests/testIndexStore.js
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  VIDEO_COLUMNS,
  VIDEO_UPDATE_COLUMNS,
  VIDEO_UPSERT_SQL,
  VIDEO_ORIGIN_UNKNOWN,
  VIDEO_SOURCE_PREFIX,
  VIDEO_TYPE_YOUTUBE,
  parseIsoDuration,
  toVideoRow,
  planVideoUpserts,
  upsertVideos,
  getVideoBySourceId,
  getVideoByVideoId,
  searchVideoIds,
  buildFtsMatchQuery
} from "../shared/index-store.js";

// A trimmed but realistic `videos.list` item: snippet, statistics,
// contentDetails, status and liveStreamingDetails all present.
function fullItem(overrides = {}){
  const item = {
    kind: "youtube#video",
    id: "dQw4w9WgXcQ",
    snippet: {
      publishedAt: "2024-03-05T10:11:12Z",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "Café Lo-Fi Beats — LIVE 24/7",
      description: "Relaxing beats.\nAll rights reserved.",
      thumbnails: {
        default: { url: "https://i.ytimg.com/vi/x/default.jpg" },
        high: { url: "https://i.ytimg.com/vi/x/hq.jpg" },
        maxres: { url: "https://i.ytimg.com/vi/x/maxres.jpg" }
      },
      channelTitle: "Lo-Fi Radio",
      tags: ["lofi", "lofi", "gaming", "  ", "chill"],
      categoryId: "10",
      liveBroadcastContent: "none"
    },
    contentDetails: {
      duration: "PT4M13S",
      dimension: "2d",
      definition: "hd",
      caption: "true",
      licensedContent: true
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
// 3. ISO 8601 duration parser
// -----------------------------------------------------------------------------

test("parseIsoDuration handles the formats YouTube sends", () => {
  assert.equal(parseIsoDuration("PT4M13S"), 253);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("PT1M"), 60);
  assert.equal(parseIsoDuration("PT0S"), 0);
});

test("parseIsoDuration accepts case, day and week components", () => {
  assert.equal(parseIsoDuration("pt4m13s"), 253);
  assert.equal(parseIsoDuration(" pT1h "), 3600);
  assert.equal(parseIsoDuration("P1D"), 86400);
  assert.equal(parseIsoDuration("P1DT30M"), 88200);
  assert.equal(parseIsoDuration("P1W"), 604800);
});

test("parseIsoDuration rounds fractional seconds to an integer", () => {
  assert.equal(parseIsoDuration("PT1.4S"), 1);
  assert.equal(parseIsoDuration("PT1.5S"), 2);
});

test("parseIsoDuration returns null instead of throwing", () => {
  for(const value of [
    null,
    undefined,
    "",
    "   ",
    "P",
    "PT",
    "4:13",
    "PT4M13",           // missing unit on the last component
    "4M13S",            // missing the P designator
    "-PT4M13S",         // negative
    "PT4M13SX",         // trailing junk
    "T4M13S",
    "PT4H13M13S13MS",
    {},
    [],
    NaN,
    Infinity
  ]){
    assert.equal(parseIsoDuration(value), null, `expected null for ${String(value)}`);
  }
});

// -----------------------------------------------------------------------------
// 1. Raw item -> videos row
// -----------------------------------------------------------------------------

test("toVideoRow maps every column of the videos table", () => {
  const row = toVideoRow(fullItem(), { now: 1700000000000 });

  assert.deepEqual(Object.keys(row).sort(), [...VIDEO_COLUMNS].sort());

  assert.equal(row.source_id, "yt:dQw4w9WgXcQ");
  assert.equal(row.type, "youtube");
  assert.equal(row.video_id, "dQw4w9WgXcQ");
  assert.equal(row.title, "Café Lo-Fi Beats — LIVE 24/7");
  assert.equal(row.description, "Relaxing beats.\nAll rights reserved.");
  assert.equal(row.channel_id, "UCabcdefghijklmnopqrstuv");
  assert.equal(row.channel_title, "Lo-Fi Radio");
  assert.equal(row.thumb_url, "https://i.ytimg.com/vi/x/maxres.jpg");
  assert.equal(row.published_at_ms, Date.parse("2024-03-05T10:11:12Z"));
  assert.equal(row.duration_seconds, 253);
  assert.equal(row.category_id, "10");
  assert.equal(row.view_count, 1234567);
  assert.equal(row.like_count, 4321);
  assert.equal(row.comment_count, 0);
  assert.equal(row.embeddable, 1);
  assert.equal(row.made_for_kids, 0);
  assert.equal(row.definition, "hd");
  assert.equal(row.has_caption, 1);
  assert.equal(row.is_live, 0);
  assert.equal(row.live_start_ms, null);
  assert.equal(row.live_end_ms, null);
  assert.equal(row.origin, "unknown");
});

test("toVideoRow namespaced source id matches the canonical DTO id", () => {
  const row = toVideoRow(fullItem());

  assert.equal(row.source_id, `${VIDEO_SOURCE_PREFIX}${row.video_id}`);
  assert.equal(row.type, VIDEO_TYPE_YOUTUBE);
});

test("title_lower is a stored lowercase copy of title", () => {
  const row = toVideoRow(fullItem());

  assert.equal(row.title_lower, row.title.toLowerCase());
  assert.notEqual(row.title_lower, row.title);
  assert.equal(row.title_lower, "café lo-fi beats — live 24/7");
  assert.equal(toVideoRow({ id: "abc" }).title_lower, "");
});

test("thumbnail falls back through the same ladder as normalize.js", () => {
  const item = fullItem();

  delete item.snippet.thumbnails.maxres;
  assert.equal(toVideoRow(item).thumb_url, "https://i.ytimg.com/vi/x/hq.jpg");

  delete item.snippet.thumbnails.high;
  assert.equal(toVideoRow(item).thumb_url, "https://i.ytimg.com/vi/x/default.jpg");

  assert.equal(toVideoRow({ id: "abc" }).thumb_url, "");
});

test("topic is derived from the real tags", () => {
  const row = toVideoRow(fullItem());

  // shared/feed.js topicFromTags() maps the "gaming" tag to "Gaming"; the rows
  // the index stores therefore carry the same label the homepage chips show.
  assert.equal(row.topic, "Gaming");

  // No tag matches any keyword -> that function's documented fallback.
  assert.equal(toVideoRow({ id: "a", snippet: { tags: ["zzz"] } }).topic, "Popular");

  // An explicit caller-supplied topic wins over derivation.
  assert.equal(toVideoRow(fullItem(), { topic: "Music" }).topic, "Music");
});

// -----------------------------------------------------------------------------
// 2. Timestamps
// -----------------------------------------------------------------------------

test("published_at_ms comes from the absolute publishedAt value", () => {
  const row = toVideoRow(fullItem(), { now: 999 });

  assert.equal(row.published_at_ms, Date.parse("2024-03-05T10:11:12Z"));
  // Explicitly not a relative string: no "2y ago", no re-derivation from now.
  assert.notEqual(row.published_at_ms, 999);
});

test("an unparseable publishedAt is null, not a guess", () => {
  const row = toVideoRow(fullItem({ snippet: { publishedAt: "not-a-date" } }));

  assert.equal(row.published_at_ms, null);
  assert.equal(toVideoRow({ id: "a" }).published_at_ms, null);
});

test("epoch milliseconds are accepted as well as RFC 3339 strings", () => {
  const row = toVideoRow(fullItem({ snippet: { publishedAt: 1700000000000 } }));

  assert.equal(row.published_at_ms, 1700000000000);
});

test("last_seen and metadata_fetched update on every indexing pass", () => {
  assert.equal(toVideoRow(fullItem(), { now: 111 }).last_seen_at_ms, 111);
  assert.equal(toVideoRow(fullItem(), { now: 111 }).metadata_fetched_at_ms, 111);
  assert.equal(toVideoRow(fullItem(), { now: 222 }).last_seen_at_ms, 222);
  assert.equal(toVideoRow(fullItem(), { now: 222 }).metadata_fetched_at_ms, 222);
});

test("first_seen defaults to now but accepts an explicit value", () => {
  assert.equal(toVideoRow(fullItem(), { now: 500 }).first_seen_at_ms, 500);
  assert.equal(
    toVideoRow(fullItem(), { now: 500, firstSeenAtMs: 42 }).first_seen_at_ms,
    42
  );
  // Without options.now the row still gets a usable timestamp.
  assert.ok(toVideoRow(fullItem()).first_seen_at_ms > 0);
});

test("live start and end come from actualStartTime / actualEndTime", () => {
  const finished = toVideoRow(fullItem({
    snippet: { liveBroadcastContent: "none" },
    liveStreamingDetails: {
      actualStartTime: "2024-03-05T10:00:00Z",
      actualEndTime: "2024-03-05T12:30:00Z"
    }
  }));

  assert.equal(finished.live_start_ms, Date.parse("2024-03-05T10:00:00Z"));
  assert.equal(finished.live_end_ms, Date.parse("2024-03-05T12:30:00Z"));
  assert.equal(finished.is_live, 0);

  // A scheduled premiere is not a fact about what happened: scheduledTime alone
  // must not become live_start_ms.
  const scheduled = toVideoRow(fullItem({
    snippet: { liveBroadcastContent: "upcoming" },
    liveStreamingDetails: { scheduledStartTime: "2024-03-05T10:00:00Z" }
  }));

  assert.equal(scheduled.live_start_ms, null);
  assert.equal(scheduled.live_end_ms, null);
  assert.equal(scheduled.is_live, 0);
});

test("is_live follows the shared live-state rules", () => {
  const running = toVideoRow(fullItem({
    snippet: { liveBroadcastContent: "live" },
    liveStreamingDetails: { actualStartTime: "2024-03-05T10:00:00Z", concurrentViewers: "1234" }
  }));

  assert.equal(running.is_live, 1);
  assert.equal(running.live_start_ms, Date.parse("2024-03-05T10:00:00Z"));

  // liveChatId is used to detect an active broadcast but is NEVER persisted:
  // the schema has no column for it and live chat content is out of scope.
  const row = toVideoRow(fullItem({
    snippet: { liveBroadcastContent: "live" },
    liveStreamingDetails: { activeLiveChatId: "live_chat_abc" }
  }));

  assert.equal(row.is_live, 1);
  assert.equal("live_chat_id" in row, false);
  assert.equal("concurrent_viewers" in row, false);
  assert.equal("chat" in row, false);
});

// -----------------------------------------------------------------------------
// tags_json
// -----------------------------------------------------------------------------

test("tags_json is valid JSON holding the real tag array", () => {
  const row = toVideoRow(fullItem());
  const parsed = JSON.parse(row.tags_json);

  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed, ["lofi", "gaming", "chill"]);
  assert.equal(row.tags_json, JSON.stringify(parsed));
});

test("tags_json stays valid JSON when tags are missing or malformed", () => {
  assert.equal(toVideoRow({ id: "a" }).tags_json, "[]");
  assert.equal(toVideoRow({ id: "a", snippet: { tags: "nope" } }).tags_json, "[]");
  assert.equal(toVideoRow({ id: "a", snippet: { tags: null } }).tags_json, "[]");
  assert.equal(
    JSON.parse(toVideoRow({ id: "a", snippet: { tags: [1, null, {}, "ok"] } }).tags_json).join(","),
    "ok"
  );
});

// -----------------------------------------------------------------------------
// Boolean / number normalization
// -----------------------------------------------------------------------------

test("booleans become SQLite 0/1 or null when unknown", () => {
  const yes = toVideoRow(fullItem({ status: { embeddable: true, madeForKids: true } }));
  const no = toVideoRow(fullItem({ status: { embeddable: false, madeForKids: false } }));
  const unknown = toVideoRow(fullItem({ status: {} }));

  assert.equal(yes.made_for_kids, 1);
  assert.equal(no.made_for_kids, 0);
  assert.equal(unknown.made_for_kids, null);

  // caption arrives as a STRING on the wire.
  const captioned = toVideoRow(fullItem({ contentDetails: { duration: "PT45S", caption: "true" } }));
  const uncaptioned = toVideoRow(fullItem({ contentDetails: { duration: "PT45S", caption: "false" } }));
  const uncaptionedUnknown = toVideoRow(fullItem({ contentDetails: { duration: "PT45S" } }));

  assert.equal(captioned.has_caption, 1);
  assert.equal(uncaptioned.has_caption, 0);
  assert.equal(uncaptionedUnknown.has_caption, null);

  // embeddable is NOT NULL, so an absent status part keeps the canonical
  // "only an explicit false blocks embedding" behaviour.
  assert.equal(yes.embeddable, 1);
  assert.equal(no.embeddable, 0);
  assert.equal(unknown.embeddable, 1);
});

test("counts keep 'unknown' (null) distinct from a real zero", () => {
  const item = fullItem();
  delete item.statistics.viewCount;
  delete item.statistics.likeCount;

  const row = toVideoRow(item);

  assert.equal(row.view_count, null);
  assert.equal(row.like_count, null);
  assert.equal(row.comment_count, 0);
  assert.equal(toVideoRow({ id: "a" }).view_count, null);
  assert.equal(toVideoRow({ id: "a", statistics: { viewCount: "nope" } }).view_count, null);
});

test("origin, search_rank and refresh_priority come from the caller", () => {
  const bare = toVideoRow(fullItem());

  assert.equal(bare.origin, VIDEO_ORIGIN_UNKNOWN);
  assert.equal(bare.search_rank, null);
  // refresh_priority is NOT NULL in 0001_init.sql, so "not known" is the
  // schema's own default of 0 — never null.
  assert.equal(bare.refresh_priority, 0);

  const scoped = toVideoRow(fullItem(), {
    origin: "chart:PK",
    searchRank: 0.75,
    refreshPriority: 3
  });

  assert.equal(scoped.origin, "chart:PK");
  assert.equal(scoped.search_rank, 0.75);
  assert.equal(scoped.refresh_priority, 3);

  // Zero is a real scheduling value, not a missing one.
  assert.equal(toVideoRow(fullItem(), { searchRank: 0, refreshPriority: 0 }).refresh_priority, 0);
  assert.equal(toVideoRow(fullItem(), { refreshPriority: "8" }).refresh_priority, 8);
});

// -----------------------------------------------------------------------------
// Invalid item handling
// -----------------------------------------------------------------------------

test("items without a usable video id map to null", () => {
  for(const item of [
    null,
    undefined,
    {},
    { id: "" },
    { id: "   " },
    { id: 42 },
    { id: null },
    { snippet: { title: "no id" } },
    { kind: "youtube#channel", snippet: { title: "no id" } }
  ]){
    assert.equal(toVideoRow(item), null, `expected null for ${JSON.stringify(item)}`);
  }
});

test("an id-only item still produces a complete row", () => {
  const row = toVideoRow({ id: " abc123 " });

  assert.equal(row.source_id, "yt:abc123");
  assert.equal(row.video_id, "abc123");
  assert.equal(row.title, "");
  assert.equal(row.title_lower, "");
  assert.equal(row.description, "");
  assert.equal(row.channel_id, "");
  assert.equal(row.tags_json, "[]");
  assert.equal(row.duration_seconds, null);
  assert.equal(row.published_at_ms, null);
});

test("a search.list-shaped item (id.videoId, no contentDetails) is mappable", () => {
  const row = toVideoRow({
    id: { videoId: "xyz789" },
    snippet: { title: "Bare search item", publishedAt: "2024-01-02T03:04:05Z" }
  });

  assert.equal(row.source_id, "yt:xyz789");
  assert.equal(row.video_id, "xyz789");
  assert.equal(row.published_at_ms, Date.parse("2024-01-02T03:04:05Z"));
  assert.equal(row.duration_seconds, null);
  assert.equal(row.view_count, null);
});

// The `videos` NOT NULL set is read straight out of the applied migration rather
// than duplicated here, so this test cannot drift from the schema it guards.
//
// It matters because a SQLite column DEFAULT only applies when the column is
// OMITTED from the INSERT: binding an explicit NULL violates NOT NULL even when a
// default exists. That is exactly how refresh_priority first broke.
function readNotNullVideoColumns() {
  const migration = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
  const start = migration.indexOf("CREATE TABLE videos");
  const end = migration.indexOf("CREATE INDEX", start);
  const table = migration.slice(start, end);

  return [...table.matchAll(/^\s+(\w+)\s+\w+\s+NOT NULL/gm)].map(match => match[1]);
}

test("the mapper never produces null for a NOT NULL column", () => {
  const notNull = readNotNullVideoColumns();

  // source_id is `TEXT PRIMARY KEY` rather than NOT NULL (16 NOT NULL columns);
  // it is separately covered by the "no usable video id maps to null" test.
  assert.ok(notNull.length >= 16, `schema parse looks wrong: ${JSON.stringify(notNull)}`);
  for(const known of ["type", "video_id", "tags_json", "first_seen_at_ms", "refresh_priority"]) {
    assert.ok(notNull.includes(known), `expected ${known} to be NOT NULL`);
  }

  for(const item of [{ id: "abc123" }, fullItem(), fullItem({ liveStreamingDetails: { actualStartTime: "2024-01-01T00:00:00Z" } })]) {
    const row = toVideoRow(item, { now: 1234 });

    for(const column of notNull) {
      assert.notEqual(row[column], null, `${column} must not be null`);
      assert.notEqual(row[column], undefined, `${column} must not be undefined`);
    }
  }
});

// -----------------------------------------------------------------------------
// 4/5. Generated statement + error isolation (no D1 binding needed)
// -----------------------------------------------------------------------------

test("the upsert statement binds one parameter per column", () => {
  const placeholders = VIDEO_UPSERT_SQL.match(/\?/g) || [];

  assert.equal(placeholders.length, VIDEO_COLUMNS.length);
  assert.equal(VIDEO_COLUMNS.length, 30);
  assert.ok(VIDEO_COLUMNS.length < 100, "must stay under D1's 100 bound parameters per query");

  // Every column is named explicitly in the INSERT projection.
  assert.ok(
    VIDEO_UPSERT_SQL.startsWith(`INSERT INTO videos (${VIDEO_COLUMNS.join(", ")}) VALUES (`)
  );
});

test("the upsert never overwrites first_seen_at_ms on update", () => {
  const updateClause = VIDEO_UPSERT_SQL.slice(VIDEO_UPSERT_SQL.indexOf("DO UPDATE SET"));

  assert.equal(updateClause.includes("first_seen_at_ms"), false);
  assert.equal(VIDEO_UPDATE_COLUMNS.includes("first_seen_at_ms"), false);
  assert.equal(VIDEO_UPDATE_COLUMNS.length, VIDEO_COLUMNS.length - 1);
  // It is still written on insert.
  assert.ok(VIDEO_UPSERT_SQL.includes("first_seen_at_ms"));
});

test("metadata columns are updated from the excluded row", () => {
  const updateClause = VIDEO_UPSERT_SQL.slice(VIDEO_UPSERT_SQL.indexOf("DO UPDATE SET"));

  assert.ok(updateClause.includes("view_count = excluded.view_count"));
  assert.ok(updateClause.includes("title_lower = excluded.title_lower"));
  assert.ok(updateClause.includes("metadata_fetched_at_ms = excluded.metadata_fetched_at_ms"));
  // Values are never interpolated into SQL — only placeholders appear.
  assert.equal(/=\s*'[^']*'/.test(updateClause), false);
});

test("a caller-supplied search_rank is preserved, not nulled", () => {
  const updateClause = VIDEO_UPSERT_SQL.slice(VIDEO_UPSERT_SQL.indexOf("DO UPDATE SET"));

  assert.ok(updateClause.includes("search_rank = COALESCE(excluded.search_rank, videos.search_rank)"));
  // refresh_priority is NOT NULL, so it is a plain write-through value.
  assert.ok(updateClause.includes("refresh_priority = excluded.refresh_priority"));
  assert.equal(updateClause.includes("refresh_priority = COALESCE"), false);
});

// A missing binding is a caller bug and must throw rather than report success.
// No D1 stub is involved: requireDb() rejects before any statement is built.
test("a missing database binding is rejected loudly", async () => {
  for(const call of [
    () => upsertVideos(null, [fullItem()]),
    () => upsertVideos({}, [fullItem()]),
    () => getVideoBySourceId(null, "yt:abc"),
    () => getVideoByVideoId(undefined, "abc"),
    () => searchVideoIds(null, "query")
  ]){
    await assert.rejects(call, TypeError);
  }
});

// -----------------------------------------------------------------------------
// 4. Summary contract (the pure half of the upsert)
// -----------------------------------------------------------------------------

test("planVideoUpserts counts attempted, skipped and duplicates exactly once", () => {
  const items = [
    fullItem({ id: "aaa111" }),
    fullItem({ id: "aaa111" }),            // duplicate id -> one write
    null,                                   // unusable -> skipped
    { snippet: { title: "no id" } },        // unusable -> skipped
    fullItem({ id: "bbb222" })
  ];

  const plan = planVideoUpserts(items, { now: 10 });

  assert.equal(plan.attempted, 5);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.duplicates, 1);

  // The invariant the returned summary relies on.
  assert.equal(plan.attempted, plan.rows.length + plan.skipped + plan.duplicates);

  // Dedupe keeps one row per source_id, and the last occurrence wins.
  assert.deepEqual(plan.rows.map(row => row.source_id), ["yt:aaa111", "yt:bbb222"]);
});

test("planVideoUpserts tolerates empty and non-array input", () => {
  for(const input of [[], null, undefined, "nope", {}]) {
    const plan = planVideoUpserts(input);

    assert.deepEqual(plan.rows, []);
    assert.equal(plan.attempted, 0);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.duplicates, 0);
  }
});

test("planVideoUpserts applies one observation time to the whole batch", () => {
  const plan = planVideoUpserts(
    [fullItem({ id: "aaa111" }), fullItem({ id: "bbb222" })],
    { now: 4242 }
  );

  for(const row of plan.rows) {
    assert.equal(row.last_seen_at_ms, 4242);
    assert.equal(row.metadata_fetched_at_ms, 4242);
    assert.equal(row.first_seen_at_ms, 4242);
  }
});

// -----------------------------------------------------------------------------
// 5. FTS5 query building
// -----------------------------------------------------------------------------

test("buildFtsMatchQuery quotes every term and joins them with AND", () => {
  assert.equal(buildFtsMatchQuery("lofi beats"), '"lofi" AND "beats"');
  assert.equal(buildFtsMatchQuery("LoFi BEATS"), '"lofi" AND "beats"');
  assert.equal(buildFtsMatchQuery("  spaced   out  "), '"spaced" AND "out"');
});

test("buildFtsMatchQuery neutralises FTS5 operators from user text", () => {
  // Every one of these is raw FTS5 syntax; quoting turns them into search terms
  // instead of a "fts5: syntax error near ..." statement failure.
  assert.equal(buildFtsMatchQuery('"unbalanced'), '"unbalanced"');
  assert.equal(buildFtsMatchQuery("title:secret"), '"title" AND "secret"');
  assert.equal(buildFtsMatchQuery("a OR b"), '"a" AND "or" AND "b"');
  assert.equal(buildFtsMatchQuery("near(x)"), '"near" AND "x"');
  assert.equal(buildFtsMatchQuery("prefix*"), '"prefix"');
  assert.equal(buildFtsMatchQuery("minus - plus +"), '"minus" AND "plus"');
  assert.equal(
    buildFtsMatchQuery("lofi beats'; DROP TABLE videos; --"),
    '"lofi" AND "beats" AND "drop" AND "table" AND "videos"'
  );
  assert.equal(buildFtsMatchQuery("1=1"), '"1"');
});

test("buildFtsMatchQuery returns null when nothing is searchable", () => {
  assert.equal(buildFtsMatchQuery(""), null);
  assert.equal(buildFtsMatchQuery("   "), null);
  assert.equal(buildFtsMatchQuery("... *** ---"), null);
  assert.equal(buildFtsMatchQuery(null), null);
  assert.equal(buildFtsMatchQuery(undefined), null);
});

test("buildFtsMatchQuery drops repeated terms", () => {
  assert.equal(buildFtsMatchQuery("lofi lofi LOFI beats"), '"lofi" AND "beats"');
});