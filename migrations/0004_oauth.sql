-- MyTube — Google OAuth foundation (Testing-mode authorization-code flow)
--
-- Scope of this migration:
--   1. oauth_states  — short-lived, single-use CSRF/flow state.
--   2. oauth_grants  — the per-MyTube-user association with a Google grant,
--                      holding an AES-GCM-encrypted refresh token.
--
-- Deliberately absent: plaintext tokens of any kind, Google account email,
-- access tokens, and any comment/live-chat content. The refresh token is stored
-- only as a versioned AES-GCM envelope produced by shared/oauth.js; the key is a
-- Worker secret and never reaches this database.
--
-- The two tables are independent of the video index. Nothing in the existing
-- `videos` / `video_fts` / `index_state` schema is touched.

-- ---------------------------------------------------------------------------
-- 1. oauth_states
-- ---------------------------------------------------------------------------
-- One row per started authorization attempt. The row is the ONLY thing that
-- makes a callback acceptable: a callback whose `state` has no matching row, is
-- already consumed, or is expired is rejected outright. That is the replay and
-- forgery protection for the whole flow.
--
-- The PKCE code_verifier lives here (never in a URL, never in the browser) so it
-- can be presented at the token exchange and then deleted with the row.
--
-- uid          the Firebase uid the flow was started for. The callback verifies
--              the signed-in user still matches this before doing anything else,
--              so a state started by one account cannot be redeemed by another.
-- redirect_uri the exact redirect URI the flow was started with, re-checked at
--              the callback against the configured value.
-- consumed     single-use latch: set at redemption, so a second use of the same
--              state finds `consumed = 1` even before the row is pruned.
-- expires_at_ms hard expiry (see OAUTH_STATE_TTL_MS in worker.js).
CREATE TABLE oauth_states (
  state          TEXT    PRIMARY KEY,
  uid            TEXT    NOT NULL,
  code_verifier  TEXT    NOT NULL,
  redirect_uri   TEXT    NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  consumed       INTEGER NOT NULL DEFAULT 0
);

-- Pruning/lookup by age.
CREATE INDEX idx_oauth_states_expires_at_ms ON oauth_states (expires_at_ms);

-- ---------------------------------------------------------------------------
-- 2. oauth_grants
-- ---------------------------------------------------------------------------
-- One row per MyTube user who has connected a YouTube account. uid is the
-- primary key: reconnecting replaces the previous grant rather than accumulating
-- rows, so there is at most one usable refresh token per user at any time.
--
-- refresh_token_enc  the AES-GCM envelope ("v1.<iv>.<ciphertext>"). Never the
--                    raw token. A failed decrypt is treated as "no grant".
-- scope              space-separated scopes Google actually granted (recorded so
--                    a later feature can check youtube.force-ssl was granted
--                    rather than assume it).
-- token_type         Google's token_type, informational.
-- connected_at_ms    when the grant was stored.
-- updated_at_ms      last write (connect/reconnect).
-- revoked_at_ms      set when the user disconnects. A revoked row keeps its
--                    audit trail but is never treated as connected.
-- No secondary index: uid is the only access path.
CREATE TABLE oauth_grants (
  uid                TEXT    PRIMARY KEY,
  refresh_token_enc  TEXT    NOT NULL,
  scope              TEXT    NOT NULL DEFAULT '',
  token_type         TEXT    NOT NULL DEFAULT '',
  connected_at_ms    INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL,
  revoked_at_ms      INTEGER
);
