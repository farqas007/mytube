-- MyTube Independence Roadmap — Phase 2: local-search FTS tokenizer + ranking
--
-- Why this migration exists
-- -------------------------
-- 0001_init.sql created `video_fts` with the default tokenizer and no prefix
-- index, which is enough to retrieve rows but not to rank or match the way a
-- search box needs:
--
--   * No prefix matching. A user typing "lof" or "web dev" gets nothing, because
--     FTS5 only matches whole tokens by default.
--   * Default `remove_diacritics 1` does not fold diacritics out of ASCII words
--     reliably, so "cafe" and "café" can diverge.
--   * `topic` is a real column on `videos` but was never indexed.
--
-- This migration rebuilds `video_fts` from scratch. It does NOT edit
-- 0001_init.sql or 0002 (both are already applied and must stay immutable), and
-- it does not touch the `videos` table itself.
--
-- What changes
-- ------------
--   1. Indexed columns are now: title, channel_title, description, tags_json,
--      topic. The first four keep their existing names, so external-content
--      mapping by name continues to work. `topic` is a real, nullable column of
--      `videos`, so existing rows map cleanly (NULL indexes as empty).
--   2. tokenize='unicode61 remove_diacritics 2' — fold diacritics for ASCII as
--      well as non-ASCII, so "cafe"/"café"/"CAFÉ" all normalise together.
--   3. prefix='2 3' — maintain prefix indexes of length 2 and 3, so the common
--      short prefixes a search box produces are fast. Longer prefixes still
--      work; they just fall back to a scan of the term index.
--   4. The three synchronisation triggers from 0001 are dropped and recreated
--      with the new column list. They remain the canonical external-content
--      set: AFTER INSERT / DELETE / UPDATE, all unconditional, so the index
--      cannot drift when only a non-searchable column changes.
--   5. Existing rows are re-indexed with the FTS5 'rebuild' command.
--
-- Safety / ordering
-- -----------------
--   * Triggers are dropped before the table so nothing points at a missing
--     table, even mid-migration.
--   * `DROP TABLE IF EXISTS` also removes the FTS5 shadow tables
--     (video_fts_data/_idx/_docsize/_config) before they are recreated.
--   * The rebuild reads from `videos`, so it is safe to run on a populated
--     table and is idempotent with respect to the content rows.
--   * No column, row or constraint on `videos` is modified.
--
-- Ranking weights are NOT set here; they live with the query in
-- shared/index-store.js (bm25() takes its weights at query time). The column
-- order below is the contract those weights depend on:
--   1 title, 2 channel_title, 3 description, 4 tags_json, 5 topic.
--
-- Apply with:
--   npx wrangler d1 migrations apply mytube-index --remote

DROP TRIGGER IF EXISTS videos_fts_ai;
DROP TRIGGER IF EXISTS videos_fts_ad;
DROP TRIGGER IF EXISTS videos_fts_au;

DROP TABLE IF EXISTS video_fts;

-- External-content FTS5 over `videos`. content_rowid='rowid' keeps
-- video_fts.rowid == videos.rowid, as in 0001, so every hit resolves to exactly
-- one source_id through the join documented in 0001_init.sql.
CREATE VIRTUAL TABLE video_fts USING fts5 (
  title,
  channel_title,
  description,
  tags_json,
  topic,
  content='videos',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);

-- INSERT -> index the new row.
CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos BEGIN
  INSERT INTO video_fts (rowid, title, channel_title, description, tags_json, topic)
  VALUES (new.rowid, new.title, new.channel_title, new.description, new.tags_json, new.topic);
END;

-- DELETE -> hand the old values to the 'delete' command, since the content row
-- is already gone by the time this fires.
CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos BEGIN
  INSERT INTO video_fts (video_fts, rowid, title, channel_title, description, tags_json, topic)
  VALUES ('delete', old.rowid, old.title, old.channel_title, old.description, old.tags_json, old.topic);
END;

-- UPDATE -> delete then re-insert. Unconditional, matching 0001: re-indexing on
-- every update costs a little work but cannot drift when only, say, view_count
-- changes.
CREATE TRIGGER videos_fts_au AFTER UPDATE ON videos BEGIN
  INSERT INTO video_fts (video_fts, rowid, title, channel_title, description, tags_json, topic)
  VALUES ('delete', old.rowid, old.title, old.channel_title, old.description, old.tags_json, old.topic);
  INSERT INTO video_fts (rowid, title, channel_title, description, tags_json, topic)
  VALUES (new.rowid, new.title, new.channel_title, new.description, new.tags_json, new.topic);
END;

-- Re-index every existing `videos` row under the new tokenizer.
INSERT INTO video_fts (video_fts) VALUES ('rebuild');
