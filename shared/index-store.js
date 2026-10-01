// =============================================================================
// MyTube — Cloudflare D1 index storage layer (Phase 1)
// -----------------------------------------------------------------------------
// The canonical API contract (`normalizeVideoItem()` in shared/normalize.js)
// deliberately throws most absolute metadata away: it returns what the frontend
// renders — a formatted "2y ago" date, a formatted "4:13" duration, "1.2M views",
// a thumbnail URL — which is presentation, not record.
//
// This module is the other half: it maps the SAME raw `videos.list` item onto the
// `videos` row from migrations/0001_init.sql, keeping the absolute facts the
// canonical DTO cannot carry:
//
//     published_at_ms        absolute publication instant (never "2y ago")
//     duration_seconds       parsed integer seconds (never "4:13")
//     view/like/comment counts  integers (never "1.2M")
//     live_start/end_ms      absolute broadcast instants
//     tags_json              the real tag array, indexed by video_fts
//     first/last_seen + fetched bookkeeping  reaper windows
//
// The two layers never fight: shared/normalize.js is untouched and still owns the
// API response shape, while this module writes a richer, queryable record beside
// it. Nothing here reads or writes user data, chat messages or credentials.
//
// Design constraints this module holds itself to:
//   * Dependency-free ESM, safe to import from the Workers runtime and from Node.
//   * Every value reaches SQLite as a BOUND PARAMETER. The only string-built part
//     of any statement is the module-local VIDEO_COLUMNS list below, which is a
//     frozen constant — never caller input.
//   * No query framework, no cache, no queue, no retry policy. One mapper, one
//     upsert, three reads.
//   * Database errors are never swallowed. If D1 rejects, these functions reject,
//     so worker.js can own logging/reporting via ctx.waitUntil(). Silently
//     reporting "indexed: 50" for 50 failed writes is the one failure mode this
//     file exists to make impossible.
// =============================================================================

import { pickThumbnail, readLiveState } from "./normalize.js";
import { topicFromTags } from "./feed.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// `source_id` is the provider-independent primary key (see 0001_init.sql). Every
// YouTube row therefore gets the same namespaced id the canonical DTO exposes as
// `id`, so the two layers can be joined on one string.
const VIDEO_SOURCE_PREFIX = "yt:";
const VIDEO_TYPE_YOUTUBE = "youtube";

// matches `videos.origin NOT NULL DEFAULT 'unknown'`. Used when the caller does
// not say where a row came from, so the value stays a fact rather than a guess.
const VIDEO_ORIGIN_UNKNOWN = "unknown";

// Where a raw item records the instant its payload was actually received from the
// upstream API, as opposed to the instant this module happened to map it.
//
// This exists because `metadata_fetched_at_ms` is a FRESHNESS FACT, not a write
// timestamp. worker.js keeps a 10-minute in-memory response cache, so an item can
// be re-written to D1 long after it was fetched. Stamping the row with the write
// time would tell the reaper "I just spoke to YouTube" when nothing was asked —
// which silently extends the row's usable lifetime every time a cache hit is
// re-indexed. The two are not interchangeable, so the true fetch instant has to
// travel with the payload.
//
// A Symbol (not a string key) so the marker can never reach a client: JSON.stringify()
// ignores symbol keys, and a `fetchedAtMs`-style string property WOULD be copied into
// any JSON response built from the same object. A spread does still carry a symbol
// across, but harmlessly — it stays invisible to Object.keys and to serialization,
// and it cannot collide with real YouTube API fields the way a string key could.
// Symbol.for() is used so a duplicated module instance still agrees on the identity.
const VIDEO_FETCHED_AT = Symbol.for("mytube.videoFetchedAt");

// The `videos` column list, in one place, used for BOTH the INSERT projection and
// the bind order. Deriving the SQL and the parameters from the same array is what
// guarantees a row can never be written with a shifted column: if a column is
// added here, both the statement and its bindings change together.
//
// Order is meaningful only for the placeholder list; the SQL names every column.
const VIDEO_COLUMNS = Object.freeze([
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
  "like_count",
  "comment_count",
  "embeddable",
  "made_for_kids",
  "definition",
  "has_caption",
  "is_live",
  "live_start_ms",
  "live_end_ms",
  "origin",
  "first_seen_at_ms",
  "last_seen_at_ms",
  "metadata_fetched_at_ms",
  "search_rank",
  "refresh_priority"
]);

// first_seen_at_ms is deliberately NOT in this list. It is written by the INSERT
// and then never touched again, which is exactly "the moment this row entered the
// index" from the migration's retention comment. Re-indexing a year-old video
// must not make it look new to the 7-day/30-day reaper work lists.
const VIDEO_UPDATE_COLUMNS = Object.freeze(
  VIDEO_COLUMNS.filter(column => column !== "first_seen_at_ms")
);

// Cached scheduling value that only a caller who actually knows something may
// supply. `null` here means "not supplied this time" and must not erase what is
// already stored, so the upsert coalesces it against the existing row.
//
// `refresh_priority` is deliberately NOT in this list. That column is
// NOT NULL DEFAULT 0, and a column DEFAULT only applies when the column is
// omitted from the INSERT — binding an explicit NULL violates the constraint. The
// schema already defines "no priority" as 0, so that is what the mapper writes
// (see toVideoRow) and the column stays a plain write-through value: a pass that
// computes a priority owns it, a pass that does not puts the row back in the
// backlog. Preserving it instead would need a sentinel, and a sentinel would make
// it impossible to ever reset a row to 0 on purpose.
const VIDEO_PRESERVED_ON_UPDATE = Object.freeze([
  "search_rank"
]);

// Rows per db.batch() call. Each row is one statement of VIDEO_COLUMNS.length
// bound parameters, which stays far below D1's documented "maximum bound
// parameters per query: 100" — a multi-row VALUES insert would blow straight
// through it (30 columns x 50 rows = 1,500 parameters), so batching is per row,
// not per multi-row statement.
//
// It is also the documented D1 subrequest budget on the Workers Free plan (50
// queries per invocation), so a 50-row batch is the largest safe unit. Larger
// input arrays are split into chunks of this size and each chunk is its own
// atomic transaction.
const VIDEO_UPSERT_CHUNK_SIZE = 50;

// searchVideoIds() bounds. MyTube pages search at 50 results (see
// shared/search.js), and this reads D1 rather than YouTube, so it never needs a
// bigger page than the UI can render.
const VIDEO_SEARCH_LIMIT_DEFAULT = 20;
const VIDEO_SEARCH_LIMIT_MAX = 50;

// -----------------------------------------------------------------------------
// Statement construction (frozen at module load, values are never interpolated)
// -----------------------------------------------------------------------------

function buildPlaceholderList(count){
  return new Array(count).fill("?").join(", ");
}

function buildUpdateAssignment(column){
  if(VIDEO_PRESERVED_ON_UPDATE.includes(column)){
    return `${column} = COALESCE(excluded.${column}, videos.${column})`;
  }

  return `${column} = excluded.${column}`;
}

// SQLite upsert. `excluded` is the row that *would* have been inserted, so every
// metadata column is refreshed atomically from the same snapshot — there is no
// read-modify-write window in which a row can be half updated.
//
// Requires SQLite 3.24+ (ON CONFLICT DO UPDATE); D1 ships well past that.
const VIDEO_UPSERT_SQL = [
  `INSERT INTO videos (${VIDEO_COLUMNS.join(", ")})`,
  `VALUES (${buildPlaceholderList(VIDEO_COLUMNS.length)})`,
  "ON CONFLICT(source_id) DO UPDATE SET",
  VIDEO_UPDATE_COLUMNS.map(buildUpdateAssignment).join(", ")
].join(" ");

// FTS5 search over the external-content `video_fts` table from 0001_init.sql.
//
// The join is mandatory, not stylistic: video_fts is external-content over
// `videos` and keyed by videos.rowid, so a bare FTS rowid must always be resolved
// back to the source_id (see the identifier-mapping note in 0001_init.sql). The
// MATCH target is written as `video_fts`, not as the table's alias `f`, because
// FTS5 requires the real table name on the left of MATCH.
//
// Only the two bound parameters are ever caller-influenced: the MATCH expression
// (built by buildFtsMatchQuery) and the result limit.
const VIDEO_SEARCH_SQL = [
  "SELECT",
  "  v.source_id,",
  "  v.type,",
  "  v.video_id,",
  "  v.title,",
  "  v.title_lower,",
  "  v.channel_id,",
  "  v.channel_title,",
  "  v.thumb_url,",
  "  v.published_at_ms,",
  "  v.duration_seconds,",
  "  v.view_count,",
  "  v.is_live,",
  // FTS5's `rank` is the relevance score (bm25, lower is better). It is exposed
  // as `match_score`, never as `search_rank`: that name is already a column on
  // `videos`, and reusing it here would make `ORDER BY` ambiguous.
  "  rank AS match_score",
  "FROM video_fts f",
  "JOIN videos v ON v.rowid = f.rowid",
  "WHERE video_fts MATCH ?",
  "ORDER BY match_score",
  "LIMIT ?"
].join(" ");

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

// ISO 8601 duration -> integer seconds.
//
// YouTube only ever emits the hour/minute/second form ("PT4M13S", "PT1H2M3S",
// "PT45S", and "P0D" for a stream that has no fixed runtime), but the day and
// week components are accepted because they are part of the same grammar and cost
// nothing to support.
//
// Returns null — never throws — for anything it does not understand. A missing
// duration is normal data, not an error: search.list items have no
// contentDetails part at all, and the column is nullable for that reason.
function parseIsoDuration(value){
  if(value === null || value === undefined){
    return null;
  }

  const text = String(value).trim().toUpperCase();

  if(!text){
    return null;
  }

  const match = text.match(
    /^P(?:(?<weeks>\d+)W|(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+(?:\.\d+)?)S)?)?)$/
  );

  if(!match){
    return null;
  }

  const { weeks, days, hours, minutes, seconds } = match.groups;

  // "P" and "PT" match the grammar but designate no component at all; that is a
  // malformed duration, not a zero-length one. ("P0D" below does return 0.)
  if(!weeks && !days && !hours && !minutes && !seconds){
    return null;
  }

  const total =
    Number(weeks || 0) * 604800 +
    Number(days || 0) * 86400 +
    Number(hours || 0) * 3600 +
    Number(minutes || 0) * 60 +
    Number(seconds || 0);

  if(!Number.isFinite(total)){
    return null;
  }

  return Math.round(total);
}

// YouTube sends statistics counts as STRINGS ("1234") and omits the key entirely
// when a count is private or unavailable. Those two states are different and the
// schema keeps them different: a number is a fact, null is "unknown". Collapsing
// them to 0 would make every private video look like a zero-view video.
function toCount(value){
  if(value === null || value === undefined || value === ""){
    return null;
  }

  const numeric = Number(value);

  if(!Number.isFinite(numeric) || numeric < 0){
    return null;
  }

  return Math.round(numeric);
}

// SQLite has no boolean type, so booleans are stored as 0/1. `unknown` maps to
// null on the nullable columns (made_for_kids, has_caption) and stays a separate
// concern on the NOT NULL ones (see embeddable below).
function toFlag(value){
  if(value === true || value === false){
    return value ? 1 : 0;
  }

  if(typeof value === "string"){
    const text = value.trim().toLowerCase();

    if(text === "true") return 1;
    if(text === "false") return 0;
  }

  if(typeof value === "number" && Number.isFinite(value)){
    if(value === 1) return 1;
    if(value === 0) return 0;
  }

  return null;
}

// Absolute timestamps -> integer epoch milliseconds. RFC 3339 strings are what
// YouTube sends; numbers (and numeric strings, which is what a JSON round trip
// produces) are already milliseconds. Everything else is unparseable and yields
// null, because a guessed publication date is worse than a missing one.
function toEpochMs(value){
  if(typeof value === "number"){
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  if(typeof value !== "string"){
    return null;
  }

  const text = value.trim();

  if(!text){
    return null;
  }

  const numeric = Number(text);

  if(Number.isFinite(numeric)){
    return Math.round(numeric);
  }

  const parsed = Date.parse(text);

  return Number.isFinite(parsed) ? parsed : null;
}

// snippet.tags is a plain array of strings, but it is untrusted input: keep only
// real strings, drop blanks, remove exact duplicates while preserving the order
// YouTube sent (order is meaningful for tag_precedence-style consumers).
function toTags(value){
  if(!Array.isArray(value)){
    return [];
  }

  const tags = [];
  const seen = new Set();

  for(const tag of value){
    if(typeof tag !== "string"){
      continue;
    }

    const text = tag.trim();

    if(!text || seen.has(text)){
      continue;
    }

    seen.add(text);
    tags.push(text);
  }

  return tags;
}

// Integer-or-null for the small scheduling columns, so 0 stays meaningful.
function toIntegerOrNull(value){
  if(value === null || value === undefined || value === ""){
    return null;
  }

  const numeric = Number(value);

  if(!Number.isFinite(numeric)){
    return null;
  }

  return Math.round(numeric);
}

function toFiniteNumberOrNull(value){
  if(value === null || value === undefined || value === ""){
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}

function toTrimmedString(value){
  if(typeof value !== "string"){
    return "";
  }

  return value.trim();
}

function toTrimmedStringOrNull(value){
  const text = toTrimmedString(value);

  return text ? text : null;
}

function readVideoId(item){
  // videos.list puts the id in `item.id` as a plain string. The `id.videoId`
  // shape is accepted too so a search.list item can be mapped without a second
  // code path; everything else (a playlist id, a channel item) yields no id and
  // is rejected by returning null.
  if(typeof item?.id === "string"){
    return item.id.trim();
  }

  if(typeof item?.id?.videoId === "string"){
    return item.id.videoId.trim();
  }

  return "";
}

// -----------------------------------------------------------------------------
// 1. Raw item -> videos row
// -----------------------------------------------------------------------------

// First candidate that is a finite number, rounded to a whole millisecond.
// Written as a helper because this file maps clocks in three places and the
// "Number.isFinite(Number(x))" dance is easy to get subtly wrong when written
// inline: `Number(null)` is 0, and 0 is finite, so a missing value would
// otherwise be able to masquerade as the epoch.
function firstFiniteMs(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);

    if (candidate !== null && candidate !== undefined && candidate !== ""
      && candidate !== false && Number.isFinite(value)) {
      return Math.round(value);
    }
  }

  return Date.now();
}

// Mark a raw payload as having arrived from the upstream API at `fetchedAtMs`.
//
// Called by worker.js exactly once per REAL fetch, before the response enters the
// in-memory cache. The marker therefore rides along with the cached object and
// keeps naming the original fetch, which is the whole point: a later cache hit
// that re-indexes the item must not claim to be fresher than it is.
function markFetchedAt(item, fetchedAtMs) {
  if (item && typeof item === "object") {
    item[VIDEO_FETCHED_AT] = fetchedAtMs;
  }

  return item;
}

// Map one raw YouTube `videos.list` item onto the `videos` row.
//
// PURE: no clock, no network, no database. `options.now` supplies the
// observation timestamp so a caller (or a test) can pin time exactly.
//
//   now               observation instant in ms; defaults to Date.now()
//   firstSeenAtMs     only for a genuinely new row; defaults to `now`
//   fetchedAtMs       instant the payload came back from the upstream API;
//                     defaults to the item's VIDEO_FETCHED_AT marker, then to
//                     `now` for an item that never passed through a cache
//   origin            how this metadata was obtained ("chart:PK", "detail", …)
//   searchRank        cached ranking score, or null when not known
//   refreshPriority   30-day revalidation priority; 0 (the schema default) when
//                     not known
//   topic             overrides the tag-derived topic when the caller knows it
//   type              provider tag; defaults to "youtube"
//
// Returns null when the item has no usable video id, which is how invalid items
// are handled everywhere in this file: skipped, never thrown, never half-written.
function toVideoRow(item, options = {}){
  const videoId = readVideoId(item);

  if(!videoId){
    return null;
  }

  const settings = options || {};
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const contentDetails = item.contentDetails || {};
  const status = item.status || {};
  const live = item.liveStreamingDetails || {};

  const now = Number.isFinite(Number(settings.now)) ? Math.round(Number(settings.now)) : Date.now();

  // The two clocks are deliberately separate. `now` is when this mapping ran and
  // drives first_seen/last_seen, which are write facts and are correct here.
  // `fetchedAt` is when the bytes came back from YouTube and is the ONLY value
  // that may go into metadata_fetched_at_ms, because that column is what every
  // freshness decision and reaper window is computed from. An explicit
  // fetchedAtMs wins; then the marker ytFetch left on the item; then `now` for
  // any item that never passed through the response cache.
  const fetchedAt = firstFiniteMs(
    settings.fetchedAtMs,
    item[VIDEO_FETCHED_AT],
    now
  );

  const tags = toTags(snippet.tags);
  const title = typeof snippet.title === "string" ? snippet.title : "";

  // `is_live` comes from shared/normalize.js's readLiveState() rather than a
  // second, subtly different set of live heuristics here, so a row can never say
  // "live" while the canonical DTO for the same item says otherwise.
  const liveState = readLiveState(item);

  return {
    source_id: `${VIDEO_SOURCE_PREFIX}${videoId}`,
    type: toTrimmedString(settings.type) || VIDEO_TYPE_YOUTUBE,
    video_id: videoId,

    // title_lower is a stored lowercase copy of title (per 0001_init.sql) so
    // case-insensitive SQL matching never has to call lower() per row and lose
    // the index. It is exactly `title.toLowerCase()` — same text, same
    // whitespace, no normalisation — so it stays comparable to title forever.
    title,
    title_lower: title.toLowerCase(),
    description: typeof snippet.description === "string" ? snippet.description : "",
    channel_id: toTrimmedString(snippet.channelId),
    channel_title: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
    thumb_url: pickThumbnail(snippet.thumbnails),

    published_at_ms: toEpochMs(snippet.publishedAt),
    duration_seconds: parseIsoDuration(contentDetails.duration),
    category_id: toTrimmedStringOrNull(snippet.categoryId),

    // The FTS5 table indexes the `tags_json` column by name, so the column holds
    // the JSON array itself (not a joined string): it stays valid JSON for
    // structured reads and is tokenised correctly for search.list-style matching.
    tags_json: JSON.stringify(tags),

    // The same derivation the homepage chips use, so the indexed label and the
    // label a visitor sees cannot drift apart. See shared/feed.js topicFromTags.
    topic: toTrimmedString(settings.topic) || topicFromTags(tags),

    view_count: toCount(statistics.viewCount),
    like_count: toCount(statistics.likeCount),
    comment_count: toCount(statistics.commentCount),

    // embeddable is NOT NULL, so "unknown" has no representation. This mirrors
    // normalizeVideoItem() exactly (`status.embeddable !== false`), which keeps
    // the record and the canonical DTO in agreement: MyTube only ever refuses a
    // video YouTube explicitly said it cannot embed.
    embeddable: status.embeddable === false ? 0 : 1,
    made_for_kids: toFlag(status.madeForKids),
    definition: toTrimmedStringOrNull(contentDetails.definition),
    has_caption: toFlag(contentDetails.caption),
    is_live: liveState.isLive ? 1 : 0,

    // Actual broadcast instants, never scheduled ones: a scheduled premiere is
    // not yet live, and its planned start is not a fact about what happened.
    live_start_ms: toEpochMs(live.actualStartTime),
    live_end_ms: toEpochMs(live.actualEndTime),

    origin: toTrimmedString(settings.origin) || VIDEO_ORIGIN_UNKNOWN,
    first_seen_at_ms: Number.isFinite(Number(settings.firstSeenAtMs))
      ? Math.round(Number(settings.firstSeenAtMs))
      : now,
    last_seen_at_ms: now,

    // `fetchedAt`, NOT `now`. This is the single most consequential line in the
    // mapper: every freshness gate in worker.js and every reaper window in
    // 0001_init.sql reads this column, so stamping it with the write time would
    // let a cache hit renew a row's lease on life without ever re-asking YouTube.
    metadata_fetched_at_ms: fetchedAt,
    search_rank: toFiniteNumberOrNull(settings.searchRank),
    // 0, not null: refresh_priority is NOT NULL, and 0 is the schema's own
    // definition of "no priority". Every other field above is either a fact or
    // nullable; this one is the single deliberately lossy value in the row.
    refresh_priority: toIntegerOrNull(settings.refreshPriority) ?? 0
  };
}

// -----------------------------------------------------------------------------
// 4. Upsert
// -----------------------------------------------------------------------------

// A missing/incorrect binding is a programming error and must surface loudly.
// (D1 failures are surfaced too — see upsertVideos().)
function requireDb(db){
  if(!db || typeof db.prepare !== "function"){
    throw new TypeError("index-store: a D1 database binding is required");
  }

  return db;
}

// Decide what a batch WOULD write, without touching a database.
//
// Pure, and therefore the part of the upsert contract that can be unit tested at
// all: the summary upsertVideos() returns is a projection of this plan.
//
//   attempted === rows.length + skipped + duplicates   (always)
//
// Duplicates collapse to one write (last occurrence wins) because videos.list can
// repeat a video within one response and upserting the same source_id twice buys
// nothing but query budget.
function planVideoUpserts(rawItems, options = {}){
  const items = Array.isArray(rawItems) ? rawItems : [];

  const rowsBySourceId = new Map();
  let skipped = 0;

  for(const item of items){
    const row = toVideoRow(item, options);

    if(!row){
      skipped++;
      continue;
    }

    // Re-setting an existing key keeps the original insertion position and the
    // LAST value, which is the intended "last occurrence wins".
    rowsBySourceId.set(row.source_id, row);
  }

  const rows = [...rowsBySourceId.values()];

  return {
    rows,
    attempted: items.length,
    skipped,
    duplicates: items.length - skipped - rows.length
  };
}

// Write a batch of raw items.
//
// Guarantees, in the order they matter:
//   1. Invalid items are skipped, not fatal: { attempted } counts what you
//      passed, { skipped } counts what could not be mapped.
//   2. Every value is a bound parameter.
//   3. first_seen_at_ms is preserved: it is absent from the DO UPDATE set.
//   4. Each chunk is ONE db.batch() = ONE atomic D1 transaction, so a row is
//      never left half-updated. Input larger than one chunk is split, which means
//      chunk boundaries are commit boundaries — that is the documented cost of
//      not exceeding the subrequest budget.
//   5. Duplicate video ids inside one batch collapse to a single write.
//   6. D1 failures reject. Nothing here catches them, and a statement that comes
//      back as not-successful is raised rather than counted as indexed.
async function upsertVideos(db, rawItems, options = {}){
  requireDb(db);

  const plan = planVideoUpserts(rawItems, options);
  const rows = plan.rows;

  if(rows.length){
    for(let offset = 0; offset < rows.length; offset += VIDEO_UPSERT_CHUNK_SIZE){
      const chunk = rows.slice(offset, offset + VIDEO_UPSERT_CHUNK_SIZE);

      // One prepared statement per row. Multi-row VALUES was rejected on purpose:
      // 30 columns x N rows would exceed D1's 100 bound parameters per query.
      const statements = chunk.map(row => {
        const values = VIDEO_COLUMNS.map(column => row[column]);

        return db.prepare(VIDEO_UPSERT_SQL).bind(...values);
      });

      const results = await db.batch(statements);

      // db.batch() rejects when a statement fails, so a falsey `success` here is
      // not expected — but "indexed" must never be reported for a write that did
      // not happen, so anything unexpected is raised rather than counted.
      if(!Array.isArray(results)){
        throw new Error("index-store: db.batch() did not return a result array");
      }

      for(let index = 0; index < results.length; index++){
        if(!results[index] || results[index].success === false){
          throw new Error(`index-store: upsert failed for statement ${index + 1} of the batch`);
        }
      }
    }
  }

  return {
    attempted: plan.attempted,
    indexed: rows.length,
    skipped: plan.skipped,
    duplicates: plan.duplicates
  };
}

// -----------------------------------------------------------------------------
// 5. Read helpers
// -----------------------------------------------------------------------------

// Fetch one row by its provider-independent id ("yt:<videoId>").
// Returns the raw row (snake_case columns) or null when there is no such row.
async function getVideoBySourceId(db, sourceId){
  requireDb(db);

  const value = toTrimmedStringOrNull(sourceId);

  if(!value){
    return null;
  }

  return db
    .prepare("SELECT * FROM videos WHERE source_id = ? LIMIT 1")
    .bind(value)
    .first();
}

// Fetch one row by its provider id ("<videoId>" for YouTube).
//
// PERF: served by idx_videos_video_id_type, added in 0002_video_id_lookup_index.sql.
// 0001_init.sql left video_id unindexed on purpose, which made this a scan
// acceptable only for an occasional detail lookup. /api/video is not occasional —
// it now calls this on the request path — so the point index lives in its own
// additive migration rather than as an edit to a file that has already been
// applied.
async function getVideoByVideoId(db, videoId, type = VIDEO_TYPE_YOUTUBE){
  requireDb(db);

  const value = toTrimmedStringOrNull(videoId);

  if(!value){
    return null;
  }

  const rowType = toTrimmedStringOrNull(type) || VIDEO_TYPE_YOUTUBE;

  return db
    .prepare("SELECT * FROM videos WHERE video_id = ? AND type = ? LIMIT 1")
    .bind(value, rowType)
    .first();
}

// Convert free text into a safe FTS5 MATCH expression.
//
// FTS5 query syntax is not a search box: bare `-`, `"`, `*`, `:`, `(`, `)`,
// NEAR/AND/OR and column filters are operators, so forwarding user input
// verbatim makes a stray character a SQL error. Every token is therefore
// lowercased and wrapped in a quoted string literal (doubling any embedded
// quote, per FTS5 string escaping) and combined with AND, which turns every
// operator character back into ordinary text.
//
// Returns null when there is nothing searchable left — a blank or punctuation
// only query is answered with "no matches", never with a failing statement.
function buildFtsMatchQuery(query){
  if(query === null || query === undefined){
    return null;
  }

  const tokens = String(query).match(/[\p{L}\p{N}]+/gu) || [];

  if(!tokens.length){
    return null;
  }

  const terms = [];
  const seen = new Set();

  for(const token of tokens){
    const term = token.toLowerCase();

    if(seen.has(term)){
      continue;
    }

    seen.add(term);
    terms.push(`"${term.replace(/"/g, '""')}"`);
  }

  return terms.length ? terms.join(" AND ") : null;
}

function resolveSearchLimit(value){
  const numeric = Number(value);

  if(!Number.isFinite(numeric)){
    return VIDEO_SEARCH_LIMIT_DEFAULT;
  }

  return Math.min(Math.max(Math.round(numeric), 1), VIDEO_SEARCH_LIMIT_MAX);
}

// FTS5 search over the existing video_fts external-content table.
//
// This is storage-side retrieval only. It does NOT replace /api/search, which
// still answers from the live YouTube Data API; it exists so a later phase can
// answer from the index once it is proven equivalent.
//
// Returns an array of rows (empty when nothing matches), ordered by FTS5 relevance
// with that score exposed as `match_score`. A query with nothing searchable in it
// returns [] without touching the database — see buildFtsMatchQuery().
async function searchVideoIds(db, query, limit){
  requireDb(db);

  const match = buildFtsMatchQuery(query);

  if(!match){
    return [];
  }

  const maxResults = resolveSearchLimit(limit);

  const statement = db
    .prepare(VIDEO_SEARCH_SQL)
    .bind(match, maxResults);

  const results = await statement.all();

  // Same rule as the write path: a read that did not really happen must not be
  // reported as "no matches".
  if(!results || results.success === false || !Array.isArray(results.results)){
    throw new Error("index-store: searchVideoIds received no result set from D1");
  }

  return results.results;
}

export {
  VIDEO_SOURCE_PREFIX,
  VIDEO_TYPE_YOUTUBE,
  VIDEO_ORIGIN_UNKNOWN,
  VIDEO_FETCHED_AT,
  VIDEO_COLUMNS,
  VIDEO_UPDATE_COLUMNS,
  VIDEO_UPSERT_SQL,
  VIDEO_SEARCH_SQL,
  VIDEO_UPSERT_CHUNK_SIZE,
  VIDEO_SEARCH_LIMIT_DEFAULT,
  VIDEO_SEARCH_LIMIT_MAX,
  parseIsoDuration,
  toVideoRow,
  markFetchedAt,
  planVideoUpserts,
  upsertVideos,
  getVideoBySourceId,
  getVideoByVideoId,
  buildFtsMatchQuery,
  searchVideoIds
};