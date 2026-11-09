// =============================================================================
// MyTube — OAuth access-token lifecycle (isolated, DI-friendly)
// -----------------------------------------------------------------------------
// Isolated module for access-token exchange, caching, rotation, and safety
// guards. The live-chat send path imports it with `revalidateGrant: true`; all
// external dependencies are injected for testability.
// =============================================================================

import {
  GOOGLE_TOKEN_ENDPOINT,
  decryptToken,
  encryptToken
} from "./oauth.js";

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;
const ACCESS_TOKEN_MIN_TTL_SECONDS = 1;
const ACCESS_TOKEN_MAX_TTL_SECONDS = 12 * 60 * 60; // defensive bound
const REFRESH_EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_REFRESH_RETRIES = 1;

// Module-scoped state (per isolate). Generation map not capped by design.
const ACCESS_TOKEN_CACHE_MAX_ENTRIES = 5000;
const accessTokenCache = new Map();      // uid -> { accessToken, expiresAtMs, scope, updatedAtMs, grantFingerprint, gen }
const accessTokenInFlight = new Map();   // uid -> { promise, gen, startedAtMs }
const accessTokenGen = new Map();        // uid -> number

function evictCacheEntriesIfNeeded() {
  if (accessTokenCache.size <= ACCESS_TOKEN_CACHE_MAX_ENTRIES) return;
  // Evict only entries with no active in-flight; if none eligible, do nothing (correctness over forced eviction)
  const toEvict = [];
  for (const [uid, entry] of accessTokenCache) {
    const inflight = accessTokenInFlight.get(uid);
    if (inflight && inflight.gen === entry.gen) {
      continue;
    }
    toEvict.push(uid);
    if (accessTokenCache.size - toEvict.length <= ACCESS_TOKEN_CACHE_MAX_ENTRIES) break;
  }
  for (const uid of toEvict) {
    accessTokenCache.delete(uid);
  }
}

export function bumpAccessTokenGen(uid) {
  const g = (accessTokenGen.get(uid) || 0) + 1;
  accessTokenGen.set(uid, g);
  return g;
}

export function invalidateAccessToken(uid) {
  bumpAccessTokenGen(uid);
  accessTokenCache.delete(uid);
  accessTokenInFlight.delete(uid);
}

function isFinitePositiveInt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return false;
  if (n <= 0) return false;
  // integer-like
  if (Math.floor(n) !== n) return false;
  return true;
}

function isExpiresInValid(expiresIn) {
  if (!isFinitePositiveInt(expiresIn)) return false;
  if (expiresIn < ACCESS_TOKEN_MIN_TTL_SECONDS) return false;
  if (expiresIn > ACCESS_TOKEN_MAX_TTL_SECONDS) return false;
  return true;
}

// Exact, whitespace-delimited scope membership. Google returns scopes as a
// space-separated list (RFC 6749 §3.3), so `includes` over the token array is
// whole-token equality: youtube.readonly can never satisfy youtube.force-ssl,
// and no substring or prefix collision can match.
function scopeTokensInclude(scopeString, requiredScope) {
  if (!requiredScope) return true;
  return String(scopeString || "")
    .split(/\s+/)
    .filter(Boolean)
    .includes(requiredScope);
}

export async function readStoredRefreshToken(db, uid, config) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("GRANT_NOT_FOUND");
  }
  let row;
  try {
    row = await db
      .prepare(
        "SELECT refresh_token_enc, scope FROM oauth_grants " +
          "WHERE uid = ? AND revoked_at_ms IS NULL"
      )
      .bind(uid)
      .first();
  } catch {
    throw new Error("GRANT_NOT_FOUND");
  }
  if (!row || !row.refresh_token_enc) {
    throw new Error("GRANT_NOT_FOUND");
  }
  try {
    const token = await decryptToken(row.refresh_token_enc, config.encryptionKey);
    return {
      refreshToken: token,
      encrypted: row.refresh_token_enc,
      // What the user actually consented to. Callers that need a specific
      // grant compare against this BEFORE spending a token exchange.
      scope: String(row.scope || "")
    };
  } catch {
    throw new Error("DECRYPT_FAILED");
  }
}

// Read only the opaque envelope used to identify the current grant. This does
// NOT decrypt or return the refresh token. Every encryption uses a fresh IV, so
// a reconnect (or any replacement) produces a different fingerprint. The write
// path calls this before reusing a cached access token, which closes the
// cross-isolate gap that local invalidateAccessToken() cannot close.
export async function readStoredGrantFingerprint(db, uid) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("GRANT_NOT_FOUND");
  }

  let row;

  try {
    row = await db
      .prepare(
        "SELECT refresh_token_enc FROM oauth_grants " +
          "WHERE uid = ? AND revoked_at_ms IS NULL"
      )
      .bind(uid)
      .first();
  } catch {
    throw new Error("GRANT_NOT_FOUND");
  }

  if (!row || !row.refresh_token_enc) {
    throw new Error("GRANT_NOT_FOUND");
  }

  return row.refresh_token_enc;
}

// Removed: persistRefreshedToken always returned a conflict and required caller-side encryption
// without a usable DI path. Use persistRefreshedTokenWithKey with pre-encrypted values instead.

export async function persistRefreshedTokenWithKey(db, uid, oldEncryptedRefreshToken, newEncryptedRefreshToken, scope, tokenType, nowMs) {
  if (!db || typeof db.prepare !== "function") {
    return { ok: false, reason: "DB_WRITE_FAILED" };
  }
  if (!newEncryptedRefreshToken || typeof newEncryptedRefreshToken !== "string") {
    return { ok: false, reason: "ROTATION_PERSIST_CONFLICT" };
  }
  if (!oldEncryptedRefreshToken || typeof oldEncryptedRefreshToken !== "string") {
    return { ok: false, reason: "ROTATION_PERSIST_CONFLICT" };
  }
  try {
    const result = await db
      .prepare(
        "UPDATE oauth_grants SET refresh_token_enc = ?, scope = COALESCE(?, scope), token_type = COALESCE(?, token_type), updated_at_ms = ? " +
        "WHERE uid = ? AND refresh_token_enc = ? AND revoked_at_ms IS NULL"
      )
      .bind(newEncryptedRefreshToken, scope || null, tokenType || null, nowMs, uid, oldEncryptedRefreshToken)
      .run();
    if (!result || result.success !== true) {
      return { ok: false, reason: "DB_WRITE_FAILED" };
    }
    const changes = result.meta && typeof result.meta.changes === "number" ? result.meta.changes : (result.changes || 0);
    if (changes !== 1) {
      return { ok: false, reason: "ROTATION_PERSIST_CONFLICT" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "DB_WRITE_FAILED" };
  }
}

export async function exchangeRefreshToken(refreshToken, config, deps = {}) {
  const fetchFn = deps.fetch || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) {
    throw new Error("TRANSIENT_EXCHANGE_ERROR");
  }
  if (!refreshToken || typeof refreshToken !== "string") {
    throw new Error("TRANSIENT_EXCHANGE_ERROR");
  }
  if (!config || !config.clientId || !config.clientSecret) {
    throw new Error("TRANSIENT_EXCHANGE_ERROR");
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = null;
    if (controller) timeoutId = setTimeout(() => controller.abort(), REFRESH_EXCHANGE_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken
      });
      const res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: body.toString(),
        signal: controller ? controller.signal : undefined
      });
      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw new Error("MALFORMED_RESPONSE");
      }
      if (!res.ok) {
        const err = payload && typeof payload.error === "string" ? payload.error : "";
        if (err === "invalid_grant") throw new Error("INVALID_GRANT");
        if (err === "invalid_client") throw new Error("INVALID_CLIENT");
        // transient
        throw new Error("TRANSIENT_EXCHANGE_ERROR");
      }
      if (!payload || typeof payload !== "object") {
        throw new Error("MALFORMED_RESPONSE");
      }
      if (!payload.access_token || typeof payload.access_token !== "string") {
        throw new Error("MALFORMED_RESPONSE");
      }
      if (!isExpiresInValid(payload.expires_in)) {
        throw new Error("MALFORMED_RESPONSE");
      }
      return {
        access_token: payload.access_token,
        expires_in: payload.expires_in,
        refresh_token: payload.refresh_token && typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
        scope: payload.scope && typeof payload.scope === "string" ? payload.scope : undefined,
        token_type: payload.token_type && typeof payload.token_type === "string" ? payload.token_type : undefined
      };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "TRANSIENT_EXCHANGE_ERROR" : (e && e.message ? e.message : "TRANSIENT_EXCHANGE_ERROR");
      if (msg === "INVALID_GRANT" || msg === "INVALID_CLIENT" || msg === "MALFORMED_RESPONSE") {
        throw e;
      }
      lastErr = e;
      if (attempt < MAX_REFRESH_RETRIES) {
        continue;
      }
      throw lastErr;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw lastErr || new Error("TRANSIENT_EXCHANGE_ERROR");
}

export async function getAccessTokenForUser(uid, env, deps = {}) {
  if (!uid) throw new Error("GRANT_NOT_FOUND");
  const db = deps.db || (env && env.mytube_index) || null;
  const config = deps.config || null;
  const fetchFn = deps.fetch;
  const encryptFn = deps.encryptToken || encryptToken;
  const requiredScope = deps.requiredScope ? String(deps.requiredScope) : "";
  const revalidateGrant = deps.revalidateGrant === true;

  const currentGen = accessTokenGen.get(uid) || 0;
  // check cache
  const cached = accessTokenCache.get(uid);
  if (cached && cached.gen === currentGen) {
    if (
      cached.expiresAtMs - Date.now() > ACCESS_TOKEN_REFRESH_BUFFER_MS &&
      scopeTokensInclude(cached.scope, requiredScope)
    ) {
      if (!revalidateGrant) {
        return cached.accessToken;
      }

      let currentFingerprint;

      try {
        currentFingerprint = await readStoredGrantFingerprint(db, uid);
      } catch {
        invalidateAccessToken(uid);
        throw new Error("GRANT_NOT_FOUND");
      }

      if (currentFingerprint === cached.grantFingerprint) {
        return cached.accessToken;
      }

      // The grant was deleted, revoked or replaced since this token was
      // cached. Fail this attempt instead of returning a token minted from the
      // old grant; a retry loads the current grant.
      invalidateAccessToken(uid);
      throw new Error("INVALIDATED");
    }
  }

  // check in-flight
  const inflight = accessTokenInFlight.get(uid);
  if (inflight && inflight.gen === currentGen) {
    try {
      const result = await inflight.promise;
      // recheck gen after await
      if ((accessTokenGen.get(uid) || 0) !== inflight.gen) {
        throw new Error("INVALIDATED");
      }
      if (result && result.accessToken) {
        const c2 = accessTokenCache.get(uid);
        if (c2 && c2.gen === inflight.gen) {
          if (!scopeTokensInclude(c2.scope, requiredScope)) {
            throw new Error("OAUTH_SCOPE_REQUIRED");
          }

          if (revalidateGrant) {
            let currentFingerprint;

            try {
              currentFingerprint = await readStoredGrantFingerprint(db, uid);
            } catch {
              invalidateAccessToken(uid);
              throw new Error("GRANT_NOT_FOUND");
            }

            if (currentFingerprint !== c2.grantFingerprint) {
              invalidateAccessToken(uid);
              throw new Error("INVALIDATED");
            }
          }

          return result.accessToken;
        }
      }
      throw new Error("INVALIDATED");
    } catch (e) {
      if (e && e.message === "INVALIDATED") throw new Error("INVALIDATED");
      throw e;
    }
  }

  const p = (async () => {
    const genAtStart = accessTokenGen.get(uid) || 0;
    // read grant
    let stored;
    try {
      stored = await readStoredRefreshToken(db, uid, config);
    } catch (e) {
      const msg = e && e.message ? e.message : "GRANT_NOT_FOUND";
      if (msg === "DECRYPT_FAILED") throw new Error("GRANT_NOT_FOUND");
      throw e;
    }
    // Scope is checked against the stored grant, before any exchange, so an
    // insufficient grant never spends a refresh round-trip.
    if (!scopeTokensInclude(stored.scope, requiredScope)) {
      throw new Error("OAUTH_SCOPE_REQUIRED");
    }

    const oldEncrypted = stored.encrypted;
    let expectedFingerprint = oldEncrypted;
    let exchanged;
    try {
      exchanged = await exchangeRefreshToken(stored.refreshToken, config, { fetch: fetchFn });
    } catch (e) {
      const msg = e && e.message ? e.message : "";
      if (msg === "INVALID_GRANT") {
        invalidateAccessToken(uid);
        throw new Error("OAUTH_REAUTH_REQUIRED");
      }
      if (msg === "INVALID_CLIENT") {
        invalidateAccessToken(uid);
        throw new Error("OAUTH_CONFIG_ERROR");
      }
      if (msg === "MALFORMED_RESPONSE") {
        invalidateAccessToken(uid);
        throw new Error("MALFORMED_RESPONSE");
      }
      throw e;
    }

    // check gen before rotation persistence
    if ((accessTokenGen.get(uid) || 0) !== genAtStart) {
      throw new Error("INVALIDATED");
    }

    // handle rotation
    if (exchanged.refresh_token) {
      let newEncrypted;
      try {
        newEncrypted = await encryptFn(exchanged.refresh_token, config.encryptionKey);
      } catch {
        invalidateAccessToken(uid);
        throw new Error("OAUTH_ROTATION_PERSIST_FAILED");
      }
      const pres = await persistRefreshedTokenWithKey(
        db,
        uid,
        oldEncrypted,
        newEncrypted,
        exchanged.scope,
        exchanged.token_type,
        Date.now()
      );
      if (!pres.ok) {
        invalidateAccessToken(uid);
        throw new Error("OAUTH_ROTATION_PERSIST_FAILED");
      }
      expectedFingerprint = newEncrypted;
      // recheck gen after persistence
      if ((accessTokenGen.get(uid) || 0) !== genAtStart) {
        throw new Error("INVALIDATED");
      }
    }

    // The write path must never return a token minted from a grant that was
    // replaced while the exchange was in flight. Re-read the opaque envelope
    // after persistence and fail closed if it no longer matches.
    if (revalidateGrant) {
      let currentFingerprint;

      try {
        currentFingerprint = await readStoredGrantFingerprint(db, uid);
      } catch {
        invalidateAccessToken(uid);
        throw new Error("GRANT_NOT_FOUND");
      }

      if (currentFingerprint !== expectedFingerprint) {
        invalidateAccessToken(uid);
        throw new Error("INVALIDATED");
      }
    }

    // final gen check before caching
    if ((accessTokenGen.get(uid) || 0) !== genAtStart) {
      throw new Error("INVALIDATED");
    }

    const expiresAtMs = Date.now() + (exchanged.expires_in * 1000);
    const entry = {
      accessToken: exchanged.access_token,
      expiresAtMs,
      scope: exchanged.scope || stored.scope || undefined,
      updatedAtMs: Date.now(),
      grantFingerprint: expectedFingerprint,
      gen: genAtStart
    };
    // ensure gen still matches
    if ((accessTokenGen.get(uid) || 0) !== genAtStart) {
      throw new Error("INVALIDATED");
    }
    accessTokenCache.set(uid, entry);
    evictCacheEntriesIfNeeded();
    return { accessToken: exchanged.access_token };
  })();

  accessTokenInFlight.set(uid, { promise: p, gen: currentGen, startedAtMs: Date.now() });
  try {
    const res = await p;
    // only cache if gen still matches
    if ((accessTokenGen.get(uid) || 0) !== currentGen) {
      accessTokenCache.delete(uid);
      throw new Error("INVALIDATED");
    }
    return res.accessToken;
  } finally {
    const inf = accessTokenInFlight.get(uid);
    if (inf && inf.promise === p) {
      accessTokenInFlight.delete(uid);
    }
  }
}

export function _resetTokenState() {
  accessTokenCache.clear();
  accessTokenInFlight.clear();
  accessTokenGen.clear();
}

export function _testInternals() {
  return {
    accessTokenCache,
    accessTokenInFlight,
    accessTokenGen,
    bumpAccessTokenGen,
    invalidateAccessToken,
    readStoredRefreshToken,
    readStoredGrantFingerprint,
    persistRefreshedTokenWithKey,
    exchangeRefreshToken,
    getAccessTokenForUser,
    ACCESS_TOKEN_CACHE_MAX_ENTRIES,
    _resetTokenState
  };
}
