-- MyTube Independence Roadmap — Phase 1 initial schema
-- Target: Cloudflare D1 (SQLite). No PostgreSQL syntax, no extensions beyond
-- the FTS5 module that D1 ships with.
--
-- Scope of this migration:
--   1. videos       — durable metadata index for legitimately obtained
--                     YouTube video metadata.
--   2. video_fts    — FTS5 full-text index over four of those columns.
--   3. index_state  — small key/value store for index bookkeeping.
--
-- Deliberately absent: user data, chat/live-chat messages, credentials,
-- R2/KV structures, and any reaper/job logic. Retention timestamps are
-- recorded here so the 7-day search-data and 30-day statistics revalidation
-- passes can be added later without an ALTER-heavy migration.

-- ---------------------------------------------------------------------------
-- 1. videos
-- ---------------------------------------------------------------------------
-- source_id is the stable, provider-independent primary key so the same row
-- can absorb metadata from more than one source over time (e.g. a YouTube
-- source_id today, another type later via the `type` column).
--
-- title_lower is a stored, pre-lowercased copy of title so case-insensitive
-- matching does not need a per-row lower() call, which would defeat indexes.
--
-- Retention bookkeeping:
--   first_seen_at_ms        — when this row entered the index (never changes)
--   last_seen_at_ms         — most recent time we observed this video again
--   metadata_fetched_at_ms  — last successful upstream metadata fetch; drives
--                             the 7-day search-data refresh pass
--   search_rank / refresh_priority — cached ranking + refresh ordering
--                             (refresh_priority is the 30-day statistics
--                             revalidation work list)
--   published_at_ms         — publication time, not observation time; kept
--                             separate from last_seen_at_ms so the two
--                             retention windows never get confused
CREATE TABLE videos (
  source_id              TEXT    PRIMARY KEY,
  type                   TEXT    NOT NULL DEFAULT 'youtube',
  video_id               TEXT    NOT NULL,
  title                  TEXT    NOT NULL DEFAULT '',
  title_lower            TEXT    NOT NULL DEFAULT '',
  description            TEXT    NOT NULL DEFAULT '',
  channel_id             TEXT    NOT NULL DEFAULT '',
  channel_title          TEXT    NOT NULL DEFAULT '',
  thumb_url              TEXT    NOT NULL DEFAULT '',
  published_at_ms        INTEGER,
  duration_seconds       INTEGER,
  category_id            TEXT,
  tags_json              TEXT    NOT NULL DEFAULT '[]',
  topic                  TEXT,
  view_count             INTEGER,
  like_count             INTEGER,
  comment_count          INTEGER,
  embeddable             INTEGER NOT NULL DEFAULT 0,
  made_for_kids          INTEGER,
  definition             TEXT,
  has_caption            INTEGER,
  is_live                INTEGER NOT NULL DEFAULT 0,
  live_start_ms          INTEGER,
  live_end_ms            INTEGER,
  origin                 TEXT    NOT NULL DEFAULT 'unknown',
  first_seen_at_ms       INTEGER NOT NULL,
  last_seen_at_ms        INTEGER NOT NULL,
  metadata_fetched_at_ms INTEGER NOT NULL,
  search_rank            REAL,
  refresh_priority       INTEGER NOT NULL DEFAULT 0
);

-- Channel page / channel filter.
CREATE INDEX idx_videos_channel_id ON videos (channel_id);

-- Chronological browse ("latest from this channel") and recency ordering.
CREATE INDEX idx_videos_published_at_ms ON videos (published_at_ms);

-- Popularity ordering and top-videos selection.
CREATE INDEX idx_videos_view_count ON videos (view_count);

-- Category browse pages.
CREATE INDEX idx_videos_category_id ON videos (category_id);

-- Reaper work list for the 7-day search-data refresh pass: find the rows whose
-- metadata is oldest relative to now.
CREATE INDEX idx_videos_metadata_fetched_at_ms ON videos (metadata_fetched_at_ms);

-- Reaper work list for the 30-day statistics revalidation pass.
CREATE INDEX idx_videos_refresh_priority ON videos (refresh_priority);

-- Composite covering the common feed query:
-- WHERE type = ? ORDER BY published_at_ms DESC
CREATE INDEX idx_videos_type_published_at_ms ON videos (type, published_at_ms);

-- ---------------------------------------------------------------------------
-- 2. video_fts
-- ---------------------------------------------------------------------------
-- External-content FTS5 table: FTS5 stores only the inverted index and reads
-- the display text back out of `videos`, so title/description/tags are not
-- duplicated on disk.
--
-- External-content FTS5 maps columns BY NAME against the content table, so
-- the searchable tag column is named `tags_json` (the actual column in
-- `videos`) rather than `tags`. Searches target it as `tags_json:<term>`;
-- it holds the JSON array of tags, which is what we want indexed.
--
-- Identifier mapping (important): FTS5 rowids must be integers, and
-- `videos.source_id` is a TEXT primary key, so it cannot itself be the FTS
-- rowid. The table therefore uses `content_rowid='rowid'`, making
-- video_fts.rowid == videos.rowid. `videos` keeps its implicit rowid, which
-- is a stable 1:1 alias for source_id for the life of the row, so every FTS
-- hit still resolves to exactly one source_id. Always join and project
-- source_id rather than trusting a bare FTS rowid:
--
--   SELECT v.source_id
--   FROM video_fts f JOIN videos v ON v.rowid = f.rowid
--   WHERE video_fts MATCH ?;
--
-- Kept as the schema's only virtual table, and the only extension D1 needs.
CREATE VIRTUAL TABLE video_fts USING fts5 (
  title,
  channel_title,
  description,
  tags_json,
  content='videos',
  content_rowid='rowid'
);

-- Synchronisation triggers.
--
-- These are the canonical three from the SQLite FTS5 external-content
-- documentation — the minimum required set, nothing custom. Without them an
-- upsert into `videos` would leave the index permanently stale.
--
-- NOTE: the INSERT/UPDATE forms must enumerate every indexed column by name.
-- If a searchable column is added later, it must be added to all three
-- triggers and the FTS column list at the same time, or
-- `INSERT INTO video_fts(video_fts) VALUES('rebuild')` is required.

-- INSERT -> add the new row to the index.
CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos BEGIN
  INSERT INTO video_fts (rowid, title, channel_title, description, tags_json)
  VALUES (new.rowid, new.title, new.channel_title, new.description, new.tags_json);
END;

-- DELETE -> remove the old row's tokens using the 'delete' command, which is
-- what external-content FTS5 expects (it must be handed the values, since the
-- content row no longer exists).
CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos BEGIN
  INSERT INTO video_fts (video_fts, rowid, title, channel_title, description, tags_json)
  VALUES ('delete', old.rowid, old.title, old.channel_title, old.description, old.tags_json);
END;

-- UPDATE -> delete then re-insert. Deliberately unconditional: it re-indexes
-- even when only view_count changed, which costs a little work but cannot
-- drift out of sync.
CREATE TRIGGER videos_fts_au AFTER UPDATE ON videos BEGIN
  INSERT INTO video_fts (video_fts, rowid, title, channel_title, description, tags_json)
  VALUES ('delete', old.rowid, old.title, old.channel_title, old.description, old.tags_json);
  INSERT INTO video_fts (rowid, title, channel_title, description, tags_json)
  VALUES (new.rowid, new.title, new.channel_title, new.description, new.tags_json);
END;

-- ---------------------------------------------------------------------------
-- 3. index_state
-- ---------------------------------------------------------------------------
-- Minimal key/value store for index-level bookkeeping: last successful
-- metadata sync per source, schema/index version markers, reaper high-water
-- marks. Values are stored as TEXT so the shape can change without a
-- migration; updated_at_ms lets a reaper skip entries it just wrote.
-- No secondary indexes: the primary key is the only access path needed.
CREATE TABLE index_state (
  key            TEXT    PRIMARY KEY,
  value          TEXT    NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);
