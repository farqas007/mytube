// =============================================================================
// MyTube — shared/oauth-tokens.js module tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These exercise the token-lifecycle module directly through its dependency
// injection seam (db, fetch, encrypt/decrypt, config). No Worker route is
// involved, so this file never imports ../worker.js — which also keeps the
// module's own state (the access-token cache and the per-uid generation map)
// naturally isolated from the integration suite in tests/testOAuth.js.
//
// Nothing here touches the network, D1 remote, or any secret. The Google token
// endpoint is stubbed through globalThis.fetch, exactly like the rest of the
// suite.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GOOGLE_YOUTUBE_SCOPE,
  base64UrlEncode,
  decryptToken,
  deriveAesKey,
  encryptToken
} from "../shared/oauth.js";
import {
  exchangeRefreshToken,
  getAccessTokenForUser,
  persistRefreshedTokenWithKey,
  _resetTokenState,
  _testInternals
} from "../shared/oauth-tokens.js";
import { createFakeD1 } from "./helpers/fake-d1.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";

// A deterministic 32-byte AES key, encoded exactly the way the Worker's
// TOKEN_ENCRYPTION_KEY secret is encoded. It is a test-only value.
const ENC_KEY_SECRET = base64UrlEncode(
  Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);

// =============================================================================
// Token exchange: response validation and error mapping
// =============================================================================

test("T1 exchangeRefreshToken validates expires_in bounds", async () => {
  _resetTokenState();
  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      // A 200 response body whose lifetime is below the accepted minimum. The
      // module must reject the payload rather than hand back a token it cannot
      // reason about.
      return new Response(
        JSON.stringify({ access_token: "ya29.test", expires_in: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config),
      e => e && e.message === "MALFORMED_RESPONSE"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("T2 exchangeRefreshToken rejects non-finite expires_in", async () => {
  _resetTokenState();
  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      // `1e999` is valid JSON number syntax that JSON.parse turns into
      // Infinity, so this genuinely exercises the non-finite branch instead of
      // serialising Infinity back to null the way JSON.stringify would.
      return new Response(
        '{"access_token":"ya29.test","expires_in":1e999}',
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config),
      e => e && e.message === "MALFORMED_RESPONSE"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("T3b exchangeRefreshToken maps invalid_grant with status", async () => {
  _resetTokenState();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config),
      (e) => e && e.message === "INVALID_GRANT"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("T4 exchangeRefreshToken maps invalid_client", async () => {
  _resetTokenState();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config),
      (e) => e && e.message === "INVALID_CLIENT"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("T5 persistRefreshedTokenWithKey requires exact changes==1", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const res = await persistRefreshedTokenWithKey(db, "uid1", "old", "new", "scope", "Bearer", Date.now());
  assert.equal(res.ok, false);
  assert.equal(res.reason, "ROTATION_PERSIST_CONFLICT");
});

test("T6 invalidateAccessToken bumps generation", () => {
  const internals = _testInternals();
  const before = internals.accessTokenGen.get("u1") || 0;
  internals.invalidateAccessToken("u1");
  const after = internals.accessTokenGen.get("u1");
  assert.equal(after, before + 1);
});

test("T7 getAccessTokenForUser invalid_grant preserves grant (no delete)", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();
  
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "OAUTH_REAUTH_REQUIRED"
    );
    const row = await db.prepare("SELECT * FROM oauth_grants WHERE uid = ?").bind("u1").first();
    assert.ok(row, "grant must be preserved");
  } finally {
    globalThis.fetch = original;
  }
});

test("T8 getAccessTokenForUser invalid_client preserves grant", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();
  
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "OAUTH_CONFIG_ERROR"
    );
    const row = await db.prepare("SELECT * FROM oauth_grants WHERE uid = ?").bind("u1").first();
    assert.ok(row, "grant must be preserved");
  } finally {
    globalThis.fetch = original;
  }
});

test("T9 rotation persistence failure does not cache token", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();
  
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.new", expires_in: 3600, refresh_token: "rt-new" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    // After read but before persist, delete the row
    const origPrepare = db.prepare.bind(db);
    db.prepare = function(sql) {
      const stmt = origPrepare(sql);
      const origBind = stmt.bind.bind(stmt);
      const origRun = stmt.run.bind(stmt);
      if (sql.includes('UPDATE oauth_grants SET refresh_token_enc')) {
        return {
          bind: function() {
            // Delete the row, then run update which will find nothing
            db.prepare("DELETE FROM oauth_grants WHERE uid = ?").bind("u1").run();
            return { run: function() { return origRun.apply(stmt, arguments); } };
          }
        };
      }
      stmt.bind = origBind;
      return stmt;
    };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "OAUTH_ROTATION_PERSIST_FAILED"
    );
    const internals = _testInternals();
    assert.equal(internals.accessTokenCache.has("u1"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("T10 successful rotation persistence updates grant and returns token", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.new", expires_in: 3600, refresh_token: "rt-new" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const token = await getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken });
    assert.equal(token, "ya29.new");
    const row = await db.prepare("SELECT refresh_token_enc FROM oauth_grants WHERE uid = ?").bind("u1").first();
    assert.ok(row && row.refresh_token_enc);
    const dec = await decryptToken(row.refresh_token_enc, encKey);
    assert.equal(dec, "rt-new");
    const internals = _testInternals();
    assert.equal(internals.accessTokenCache.has("u1"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("T11 response without rotated refresh token uses existing grant and caches access token", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.same", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const token = await getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken });
    assert.equal(token, "ya29.same");
    const row = await db.prepare("SELECT refresh_token_enc FROM oauth_grants WHERE uid = ?").bind("u1").first();
    const dec = await decryptToken(row.refresh_token_enc, encKey);
    assert.equal(dec, "refresh-old");
    const internals = _testInternals();
    assert.equal(internals.accessTokenCache.has("u1"), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("T12 cache hit returns cached token without refresh", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetchCount++;
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.first", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const t1 = await getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken });
    const t2 = await getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken });
    assert.equal(t1, "ya29.first");
    assert.equal(t2, "ya29.first");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("T12a revalidateGrant rejects a cached token after the grant is deleted", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, GOOGLE_YOUTUBE_SCOPE, "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    fetchCount += 1;
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.cached", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const first = await getAccessTokenForUser("u1", {}, {
      db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
      revalidateGrant: true
    });
    assert.equal(first, "ya29.cached");
    assert.equal(fetchCount, 1);

    // Simulate another isolate (or an admin/database deletion) removing the
    // grant. This isolate still has the access token in its cache.
    await db.prepare("DELETE FROM oauth_grants WHERE uid = ?").bind("u1").run();

    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, {
        db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
        revalidateGrant: true
      }),
      e => e && e.message === "GRANT_NOT_FOUND"
    );
    assert.equal(fetchCount, 1, "a revoked grant must not reach the token endpoint");
    assert.equal(_testInternals().accessTokenCache.has("u1"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("T12b revalidateGrant fails closed after the grant is replaced", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const oldEnc = await encryptToken("refresh-old", encKey);
  const newEnc = await encryptToken("refresh-new", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", oldEnc, GOOGLE_YOUTUBE_SCOPE, "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    fetchCount += 1;
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(
        JSON.stringify({
          access_token: fetchCount === 1 ? "ya29.old" : "ya29.new",
          expires_in: 3600,
          scope: GOOGLE_YOUTUBE_SCOPE
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const first = await getAccessTokenForUser("u1", {}, {
      db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
      revalidateGrant: true
    });
    assert.equal(first, "ya29.old");

    // A reconnect writes a fresh envelope. The old access token must not be
    // reused just because it is still unexpired in this isolate's cache.
    await db.prepare("UPDATE oauth_grants SET refresh_token_enc = ?, updated_at_ms = ? WHERE uid = ?")
      .bind(newEnc, Date.now(), "u1")
      .run();

    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, {
        db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
        revalidateGrant: true
      }),
      e => e && e.message === "INVALIDATED"
    );
    assert.equal(fetchCount, 1, "the changed grant is not used for this attempt");
    assert.equal(_testInternals().accessTokenCache.has("u1"), false);

    // A retry starts from the current grant rather than the stale cache.
    const retry = await getAccessTokenForUser("u1", {}, {
      db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
      revalidateGrant: true
    });
    assert.equal(retry, "ya29.new");
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("T13 concurrent refresh coalesced to single exchange", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetchCount++;
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      await new Promise(r => setTimeout(r, 10));
      return new Response(JSON.stringify({ access_token: "ya29.coalesced", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    const [t1, t2] = await Promise.all([
      getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken })
    ]);
    assert.equal(t1, "ya29.coalesced");
    assert.equal(t2, "ya29.coalesced");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("T14 generation invalidation during in-flight refresh discards result", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", Date.now(), Date.now()).run();

  const original = globalThis.fetch;
  const internals = _testInternals();
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      internals.invalidateAccessToken("u1");
      return new Response(JSON.stringify({ access_token: "ya29.stale", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "INVALIDATED"
    );
    assert.equal(internals.accessTokenCache.has("u1"), false);
  } finally {
    globalThis.fetch = original;
  }
});

// =============================================================================
// Phase 2C-2A: revocation, scope enforcement, retry policy, TTL bound
// =============================================================================

test("T15 a revoked grant is treated as absent and never exchanged", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  await db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,?)"
  ).bind("u1", rtEnc, GOOGLE_YOUTUBE_SCOPE, "Bearer", Date.now(), Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ error: "backend_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "GRANT_NOT_FOUND"
    );
    assert.equal(fetchCount, 0, "a revoked grant must never reach the token endpoint");
  } finally {
    globalThis.fetch = original;
  }
});

test("T16 requiredScope rejects an insufficient grant before any exchange", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const rtEnc = await encryptToken("refresh-old", encKey);
  const insert = db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  );
  await insert.bind("u1", rtEnc, "https://www.googleapis.com/auth/youtube.readonly", "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      fetchCount += 1;
      return new Response(JSON.stringify({ access_token: "ya29.allowed", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };
  try {
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, {
        db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
        requiredScope: GOOGLE_YOUTUBE_SCOPE
      }),
      (e) => e && e.message === "OAUTH_SCOPE_REQUIRED"
    );
    assert.equal(fetchCount, 0, "an insufficient grant must not spend a token exchange");

    // Positive control: a stored multi-token scope that DOES contain the
    // required token passes the same check and reaches the endpoint.
    await db.prepare("UPDATE oauth_grants SET scope = ? WHERE uid = ?")
      .bind("https://www.googleapis.com/auth/youtube.readonly " + GOOGLE_YOUTUBE_SCOPE, "u1")
      .run();
    const token = await getAccessTokenForUser("u1", {}, {
      db, config, fetch: globalThis.fetch, encryptToken, decryptToken,
      requiredScope: GOOGLE_YOUTUBE_SCOPE
    });
    assert.equal(token, "ya29.allowed");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("T17 a transient HTTP 500 is retried exactly once", async () => {
  _resetTokenState();
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: "backend_error" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config, { fetch: globalThis.fetch }),
      (e) => e && e.message === "TRANSIENT_EXCHANGE_ERROR"
    );
    assert.equal(fetchCount, 2, "one retry, no more");
  } finally {
    globalThis.fetch = original;
  }
});

test("T18 invalid_grant is never retried", async () => {
  _resetTokenState();
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config, { fetch: globalThis.fetch }),
      (e) => e && e.message === "INVALID_GRANT"
    );
    assert.equal(fetchCount, 1, "a terminal grant error must not be retried");
  } finally {
    globalThis.fetch = original;
  }
});

test("T19 expires_in above the 12-hour bound is rejected", async () => {
  _resetTokenState();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://oauth2.googleapis.com" && parsed.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 43201 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
    await assert.rejects(
      () => exchangeRefreshToken("rt", config, { fetch: globalThis.fetch }),
      (e) => e && e.message === "MALFORMED_RESPONSE"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("T20 getAccessTokenForUser decrypt failure treated as GRANT_NOT_FOUND", async () => {
  _resetTokenState();
  const db = createFakeD1();
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const wrongKeyBytes = Uint8Array.from({ length: 32 }, (_, i) => (i + 7) % 256);
  const wrongKeySecret = base64UrlEncode(wrongKeyBytes);
  const wrongKey = await deriveAesKey(wrongKeySecret);

  const rtEnc = await encryptToken("refresh-old", encKey);
  db.prepare(
    "INSERT INTO oauth_grants (uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) VALUES (?,?,?,?,?,?,NULL)"
  ).bind("u1", rtEnc, GOOGLE_YOUTUBE_SCOPE, "Bearer", Date.now(), Date.now()).run();

  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: wrongKey };
    await assert.rejects(
      () => getAccessTokenForUser("u1", {}, { db, config, fetch: globalThis.fetch, encryptToken, decryptToken }),
      (e) => e && e.message === "GRANT_NOT_FOUND"
    );
    assert.equal(fetchCount, 0, "decrypt failure must not reach the token endpoint");
    const row = await db.prepare("SELECT * FROM oauth_grants WHERE uid = ?").bind("u1").first();
    assert.ok(row, "grant row must be preserved");
    const internals = _testInternals();
    assert.equal(internals.accessTokenCache.has("u1"), false, "access token must not be cached");
  } finally {
    globalThis.fetch = original;
  }
});
