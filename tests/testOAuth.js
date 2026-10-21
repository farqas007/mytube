// =============================================================================
// MyTube — Google OAuth foundation tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These exercise the real shipped code:
//   * shared/oauth.js        — PKCE, state, AES-GCM envelope, JWT verification
//   * worker.js              — /api/oauth/{start,callback,status,disconnect}
//   * migrations/0004_oauth.sql via the real-SQLite D1 double
//
// Nothing here touches the network, D1 remote, or any secret. The Google token
// endpoint and the Firebase JWKS endpoint are stubbed through globalThis.fetch,
// exactly like tests/testWorkerIndex.js stubs the YouTube API.
//
// What is pinned:
//   * the real browser flow: fetch-an-authenticated-start, then a header-less
//     Google callback whose stored single-use state is the authentication;
//   * state validation: missing, expired, consumed (replay), redirect mismatch;
//   * callback UX: a fixed, non-sensitive 302 landing with a closed status set;
//   * Firebase token validation: signature, alg, kid, issuer, audience, expiry;
//   * token encryption/decryption round-trips and wrong-key failure;
//   * single-use semantics under a simulated double-redeem;
//   * disconnect: always deletes locally, and truthfully reports whether
//     Google's revocation actually succeeded (2xx vs HTTP error vs network);
//   * fail-closed behaviour when OAuth env is absent.
//
// Run: node --test tests/testOAuth.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.js";
import {
  FIREBASE_JWT_ALG,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  base64UrlEncode,
  buildAuthorizationUrl,
  constantTimeEqual,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  decryptToken,
  deriveAesKey,
  encryptToken,
  redirectUriMatches,
  verifyFirebaseIdToken,
  verifyPkce
} from "../shared/oauth.js";
import { createFakeD1 } from "./helpers/fake-d1.js";

// -----------------------------------------------------------------------------
// Constants used throughout
// -----------------------------------------------------------------------------

const PROJECT_ID = "mytube-827d2";
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://mytube.farqas007.workers.dev/api/oauth/callback";

// The fixed landing destination the callback redirects to. Mirrors the Worker's
// OAUTH_LANDING_PATH / OAUTH_STATUS_PARAM constants.
const LANDING_PATH = "/profile.html";
const STATUS_PARAM = "youtube";

// Assert a response is the fixed landing redirect carrying `status`, and return
// the parsed Location so tests can also prove no token/secret leaked into it.
function assertLanding(response, status) {
  assert.equal(response.status, 302, "the callback must redirect");
  const location = response.headers.get("Location");
  assert.ok(location, "a Location header must be present");
  const url = new URL(location, "https://mytube.farqas007.workers.dev");
  assert.equal(url.pathname, LANDING_PATH, "landing path is fixed");
  assert.equal(url.searchParams.get(STATUS_PARAM), status);
  return url;
}

// A base64url secret that decodes to exactly 32 bytes (AES-256).
const ENC_KEY_SECRET = base64UrlEncode(
  Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);

// -----------------------------------------------------------------------------
// RSA keypair + JWKS so we can mint genuinely signed Firebase ID tokens
// -----------------------------------------------------------------------------

// Generate one RSA-2048 signing keypair and its matching JWK set. RSASSA-PKCS1
// with SHA-256 is what Firebase uses, so a real signature is verified here — not
// a stub.
//
// Each call gets a UNIQUE kid. The Worker's JWKS cache is module-level, so two
// tests that both used "kid-1" with different keys would collide through the
// cache (a test-isolation artifact, not a production condition). Unique kids
// keep every test's key genuinely distinct, exactly like Firebase's real set.
let kidCounter = 0;

async function makeSigningKey(kid) {
  kidCounter += 1;
  const resolvedKid = kid || `kid-${kidCounter}`;

  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  return {
    kid: resolvedKid,
    privateKey: pair.privateKey,
    jwk: { ...publicJwk, kid: resolvedKid, alg: FIREBASE_JWT_ALG, use: "sig" }
  };
}

function jsonSegment(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

// Mint an ID token with real claims and a real signature.
async function mintIdToken(signingKey, claims, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: FIREBASE_JWT_ALG,
    kid: signingKey.kid,
    typ: "JWT",
    ...headerOverrides
  };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: "firebase-uid-1",
    iat: now - 10,
    exp: now + 3600,
    ...claims
  };
  const signingInput = `${jsonSegment(header)}.${jsonSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    signingKey.privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// -----------------------------------------------------------------------------
// Worker harness
// -----------------------------------------------------------------------------

let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `10.9.0.${ipCounter}`;
}

function oauthEnv(db) {
  const env = {
    YOUTUBE_API_KEY: "test-key",
    ASSETS: { fetch: async () => new Response("asset") },
    FIREBASE_PROJECT_ID: PROJECT_ID,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    OAUTH_TOKEN_ENCRYPTION_KEY: ENC_KEY_SECRET
  };

  if (db !== undefined) {
    env.mytube_index = db;
  }

  return env;
}

function callWorker(path, env, options = {}) {
  const headers = {
    "CF-Connecting-IP": nextIp(),
    Origin: "https://mytube.farqas007.workers.dev",
    ...(options.headers || {})
  };

  const request = new Request(`https://mytube.farqas007.workers.dev${path}`, {
    method: options.method || "GET",
    headers
  });

  return worker.fetch(request, env, { waitUntil() {} });
}

// Stub global fetch for the Google token/revoke endpoints and the Firebase JWKS
// endpoint. Returns the recorded calls so a test can assert what was requested.
async function withStubbedFetch(handlers, run) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });

    const handler = handlers(parsed, init);

    if (!handler) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const body = await handler;

    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// =============================================================================
// A) PKCE + state primitives
// =============================================================================

test("A1 the code verifier is a valid 43-128 char base64url value", () => {
  const verifier = createCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test("A2 the S256 challenge matches the verifier and only S256 is accepted", async () => {
  const verifier = createCodeVerifier();
  const challenge = await createCodeChallenge(verifier);

  assert.equal(await verifyPkce(verifier, challenge, "S256"), true);
  assert.equal(await verifyPkce(verifier, challenge, "plain"), false);
  assert.equal(await verifyPkce("wrong", challenge, "S256"), false);
  assert.equal(await verifyPkce(verifier, "wrong", "S256"), false);
});

test("A3 state values are high-entropy and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = createState();
    assert.match(s, /^[A-Za-z0-9_-]{40,}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 200, "200 states must all differ");
});

test("A4 constant-time compare is correct on equal/unequal/length", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("A5 redirect URIs are matched exactly", () => {
  assert.equal(redirectUriMatches(REDIRECT_URI, REDIRECT_URI), true);
  assert.equal(redirectUriMatches(REDIRECT_URI + "/", REDIRECT_URI), false);
  assert.equal(redirectUriMatches(REDIRECT_URI + "?x=1", REDIRECT_URI), false);
  assert.equal(redirectUriMatches("", REDIRECT_URI), false);
});

test("A6 the authorization URL carries PKCE S256, state and offline consent", () => {
  const url = new URL(
    buildAuthorizationUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "https://www.googleapis.com/auth/youtube.force-ssl",
      state: "STATE",
      codeChallenge: "CHALLENGE"
    })
  );

  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(url.searchParams.get("state"), "STATE");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
});

// =============================================================================
// B) AES-GCM token envelope
// =============================================================================

test("B1 a token round-trips through encrypt/decrypt", async () => {
  const key = await deriveAesKey(ENC_KEY_SECRET);
  const token = "1//0g-super-secret-refresh-token";
  const envelope = await encryptToken(token, key);

  assert.notEqual(envelope, token);
  assert.ok(!envelope.includes(token), "ciphertext must not contain the token");
  assert.match(envelope, /^v1\./);
  assert.equal(await decryptToken(envelope, key), token);
});

test("B2 the same token encrypts differently each time (fresh IV)", async () => {
  const key = await deriveAesKey(ENC_KEY_SECRET);
  const a = await encryptToken("same-token", key);
  const b = await encryptToken("same-token", key);
  assert.notEqual(a, b, "a fixed IV would leak token equality");
});

test("B3 a wrong key fails to decrypt rather than returning garbage", async () => {
  const key = await deriveAesKey(ENC_KEY_SECRET);
  const otherKey = await deriveAesKey(
    base64UrlEncode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i))
  );
  const envelope = await encryptToken("token", key);

  await assert.rejects(() => decryptToken(envelope, otherKey));
});

test("B4 a malformed envelope is rejected", async () => {
  const key = await deriveAesKey(ENC_KEY_SECRET);
  await assert.rejects(() => decryptToken("not-an-envelope", key));
  await assert.rejects(() => decryptToken("v2.a.b", key));
});

test("B5 a key that is not 32 bytes is refused, never downgraded", async () => {
  const shortKey = base64UrlEncode(new Uint8Array(16));
  await assert.rejects(() => deriveAesKey(shortKey));
});

// =============================================================================
// C) Firebase ID token verification
// =============================================================================

test("C1 a correctly signed token for this project is accepted", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-abc" });
  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, true);
  assert.equal(result.uid, "uid-abc");
});

test("C2 a token signed by an unknown key is rejected", async () => {
  const signer = await makeSigningKey("kid-real");
  const other = await makeSigningKey("kid-other");
  const token = await mintIdToken(other, {});

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [signer.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "unknown_kid");
});

test("C3 a tampered signature is rejected", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, {});
  const parts = token.split(".");
  const badSig = base64UrlEncode(new Uint8Array(256));
  const tampered = `${parts[0]}.${parts[1]}.${badSig}`;

  const result = await verifyFirebaseIdToken(tampered, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_signature");
});

test("C4 an alg other than RS256 is refused even if signed", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, {}, { alg: "none" });

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_alg");
});

test("C5 a wrong issuer is rejected", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, {
    iss: "https://securetoken.google.com/other-project"
  });

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_issuer");
});

test("C6 a wrong audience is rejected", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { aud: "some-other-project" });

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_audience");
});

test("C7 an expired token is rejected", async () => {
  const key = await makeSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const token = await mintIdToken(key, { iat: now - 7200, exp: now - 3600 });

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "expired");
});

test("C8 a token missing a subject is rejected", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "" });

  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [key.jwk] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_subject");
});

test("C9 malformed tokens never throw", async () => {
  for (const bad of ["", "a", "a.b", "a.b.c", "...."]) {
    const result = await verifyFirebaseIdToken(bad, {
      projectId: PROJECT_ID,
      jwks: { keys: [] }
    });
    assert.equal(result.valid, false, `${JSON.stringify(bad)} must be invalid`);
  }
});

test("C10 an empty key set fails rather than skipping signature checks", async () => {
  const key = await makeSigningKey();
  const token = await mintIdToken(key, {});
  const result = await verifyFirebaseIdToken(token, {
    projectId: PROJECT_ID,
    jwks: { keys: [] }
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "no_jwks_keys");
});

// =============================================================================
// D) Worker: fail-closed when unconfigured
// =============================================================================

test("D1 with no OAuth env start/status report 'not configured'", async () => {
  for (const route of ["start", "status"]) {
    const response = await callWorker(
      `/api/oauth/${route}`,
      { YOUTUBE_API_KEY: "k", ASSETS: { fetch: async () => new Response("a") } }
    );
    assert.equal(response.status, 503, `/api/oauth/${route}`);
    const body = await response.json();
    assert.equal(body.code, "OAUTH_NOT_CONFIGURED");
  }
});

test("D1b with no OAuth env the callback redirects safely, not 503 JSON", async () => {
  const response = await callWorker(
    "/api/oauth/callback?code=C&state=S",
    { YOUTUBE_API_KEY: "k", ASSETS: { fetch: async () => new Response("a") } }
  );

  assertLanding(response, "error");
});

test("D2 an unconfigured disconnect POST is refused too", async () => {
  const response = await callWorker("/api/oauth/disconnect", {
    YOUTUBE_API_KEY: "k",
    ASSETS: { fetch: async () => new Response("a") }
  }, { method: "POST" });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "OAUTH_NOT_CONFIGURED");
});

test("D3 a missing Firebase token is a 401 on start", async () => {
  const db = createFakeD1();

  const response = await callWorker(
    "/api/oauth/start",
    oauthEnv(db)
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHENTICATED");
});

// =============================================================================
// E) Worker: start
// =============================================================================

test("E1 start fetches a JSON authorization URL and stores a bound state", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-start" });

  await withStubbedFetch(
    parsed =>
      parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null,
    async () => {
      const response = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });

      // A fetch() caller gets JSON, not a 302 (the page navigates itself).
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.authorizationUrl, "the URL must be returned");

      const location = new URL(body.authorizationUrl);
      assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("redirect_uri"), REDIRECT_URI);
      // The returned URL must never carry a token or a secret.
      assert.ok(!/secret/i.test(body.authorizationUrl), "no client secret in URL");

      const state = location.searchParams.get("state");
      assert.ok(state && state.length > 20, "a real state must be present");

      const row = db._sqlite
        .prepare("SELECT * FROM oauth_states WHERE state = ?")
        .get(state);
      assert.ok(row, "the state must be persisted");
      assert.equal(row.uid, "uid-start");
      assert.equal(row.consumed, 0);
      assert.ok(row.expires_at_ms > Date.now());
    }
  );
});

test("E2 start returns JSON, never a redirect, so no header is lost", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-x" });

  await withStubbedFetch(
    parsed =>
      parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null,
    async () => {
      const response = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Location"), null, "no redirect");
    }
  );
});

// =============================================================================
// F) Worker: callback — happy path and every error branch
// =============================================================================

// Seed a state row directly, returning the verifier for reuse.
function seedState(db, overrides = {}) {
  const state = overrides.state || "state-" + Math.random().toString(36).slice(2);
  const verifier = overrides.codeVerifier || createCodeVerifier();
  const now = Date.now();

  db._sqlite
    .prepare(
      "INSERT INTO oauth_states " +
        "(state, uid, code_verifier, redirect_uri, created_at_ms, expires_at_ms, consumed) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      state,
      overrides.uid || "uid-1",
      verifier,
      overrides.redirectUri || REDIRECT_URI,
      now,
      overrides.expiresAtMs ?? now + 10 * 60 * 1000,
      overrides.consumed ?? 0
    );

  return { state, verifier };
}

test("F1 a valid header-less callback stores an encrypted grant and lands connected", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  // NOTE: no Authorization header. Google redirects the browser and cannot send
  // one; the stored state is the whole authentication for this step.
  await withStubbedFetch(
    parsed => {
      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return {
          refresh_token: "1//refresh-abc",
          access_token: "ya29.access",
          scope: "https://www.googleapis.com/auth/youtube.force-ssl",
          token_type: "Bearer"
        };
      }
      return null;
    },
    async () => {
      const response = await callWorker(
        `/api/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
        oauthEnv(db)
      );

      const location = assertLanding(response, "connected");
      // The landing URL must carry no token, code or secret.
      assert.ok(!/1\/\/|ya29|refresh|code=/i.test(location.href), "no secret in URL");

      // The grant is owned by the STATE's uid, not by any request header.
      const row = db._sqlite
        .prepare("SELECT * FROM oauth_grants WHERE uid = ?")
        .get("uid-1");
      assert.ok(row, "the grant must be stored against the state uid");
      assert.match(row.refresh_token_enc, /^v1\./);
      assert.ok(
        !row.refresh_token_enc.includes("1//refresh-abc"),
        "the raw refresh token must never be stored"
      );

      // And it decrypts back to the original token.
      const encKey = await deriveAesKey(ENC_KEY_SECRET);
      assert.equal(
        await decryptToken(row.refresh_token_enc, encKey),
        "1//refresh-abc"
      );
    }
  );
});

test("F2 the same state cannot be redeemed twice (replay)", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  const handlers = parsed => {
    if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      return { refresh_token: "1//r", scope: "s", token_type: "Bearer" };
    }
    return null;
  };

  await withStubbedFetch(handlers, async () => {
    const first = await callWorker(
      `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      oauthEnv(db)
    );
    assertLanding(first, "connected");

    const second = await callWorker(
      `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      oauthEnv(db)
    );
    // A replayed state lands on the fixed error status, not a second grant.
    assertLanding(second, "error");

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants")
      .get().n;
    assert.equal(count, 1, "a replay must not mint a second grant");
  });
});

test("F3 an expired state is refused", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1", expiresAtMs: Date.now() - 1 });

  const response = await callWorker(
    `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    oauthEnv(db)
  );

  assertLanding(response, "error");
});

test("F4 an unbound callback (state never stored) is refused", async () => {
  const db = createFakeD1();

  const response = await callWorker(
    "/api/oauth/callback?code=C&state=never-stored",
    oauthEnv(db)
  );

  assertLanding(response, "error");
});

test("F5 a denied consent (error param) lands cancelled", async () => {
  const db = createFakeD1();

  const response = await callWorker(
    "/api/oauth/callback?error=access_denied&state=x",
    oauthEnv(db)
  );

  assertLanding(response, "cancelled");
});

test("F6 a callback missing code or state lands on error", async () => {
  const db = createFakeD1();

  const noCode = await callWorker("/api/oauth/callback?state=x", oauthEnv(db));
  assertLanding(noCode, "error");

  const noState = await callWorker("/api/oauth/callback?code=x", oauthEnv(db));
  assertLanding(noState, "error");
});

test("F7 a redirect_uri mismatch is refused", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, {
    uid: "uid-1",
    redirectUri: "https://evil.example/api/oauth/callback"
  });

  const response = await callWorker(
    `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    oauthEnv(db)
  );

  assertLanding(response, "error");

  const count = db._sqlite
    .prepare("SELECT COUNT(*) AS n FROM oauth_grants")
    .get().n;
  assert.equal(count, 0, "a mismatched redirect must store nothing");
});

test("F8 a failed token exchange lands on error and stores nothing", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    // Token endpoint answers with an error body and a 400.
    return new Response(
      parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)
        ? JSON.stringify({ error: "invalid_grant" })
        : JSON.stringify({}),
      { status: parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT) ? 400 : 200 }
    );
  };

  try {
    const response = await callWorker(
      `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      oauthEnv(db)
    );

    assertLanding(response, "error");

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants")
      .get().n;
    assert.equal(count, 0, "no grant may be stored on a failed exchange");
  } finally {
    globalThis.fetch = original;
  }
});

test("F9 the callback never requires a Firebase header", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  // With a valid stored state and a working exchange, a request with NO
  // Authorization header must still succeed. This is the core browser-flow fix.
  await withStubbedFetch(
    parsed =>
      parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)
        ? { refresh_token: "1//ok", scope: "s", token_type: "Bearer" }
        : null,
    async () => {
      const response = await callWorker(
        `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
        oauthEnv(db)
      );

      assertLanding(response, "connected");
    }
  );
});

test("F10 an unconfigured callback still redirects safely, never 500s", async () => {
  const response = await callWorker("/api/oauth/callback?code=C&state=S", {
    YOUTUBE_API_KEY: "k",
    ASSETS: { fetch: async () => new Response("a") }
  });

  assertLanding(response, "error");
});

// =============================================================================
// G) Worker: status
// =============================================================================

test("G1 status reports disconnected with no grant", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await withStubbedFetch(
    parsed =>
      parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null,
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { connected: false, scope: "" });
    }
  );
});

test("G2 status reports connected after a grant, never the token", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", "v1.iv.ct", "https://www.googleapis.com/auth/youtube.force-ssl", "Bearer", 1, 1);

  await withStubbedFetch(
    parsed =>
      parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null,
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      assert.equal(body.connected, true);
      assert.equal(body.scope, "https://www.googleapis.com/auth/youtube.force-ssl");
      assert.ok(!JSON.stringify(body).includes("v1.iv.ct"), "no envelope leaks");
    }
  );
});

// =============================================================================
// H) Worker: disconnect
// =============================================================================

test("H1 disconnect revokes at Google (2xx) and reports revoked:true", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const envelope = await encryptToken("1//revoke-me", encKey);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", envelope, "s", "Bearer", 1, 1);

  await withStubbedFetch(
    parsed => {
      if (parsed.href.includes("securetoken")) return { keys: [key.jwk] };
      if (parsed.href.startsWith(GOOGLE_REVOKE_ENDPOINT)) return {};
      return null;
    },
    async calls => {
      const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { connected: false, revoked: true });

      // The revoke call carried the real token (server-side only).
      const revoke = calls.find(c => c.url.href.startsWith(GOOGLE_REVOKE_ENDPOINT));
      assert.ok(revoke, "Google revoke must be called");
      assert.match(String(revoke.init.body), /token=1%2F%2Frevoke-me/);

      const count = db._sqlite
        .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
        .get("uid-1").n;
      assert.equal(count, 0, "the local grant must be deleted");
    }
  );
});

test("H2 disconnect reports revoked:false on a Google HTTP error, still deletes", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", await encryptToken("1//x", encKey), "s", "Bearer", 1, 1);

  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.href.includes("securetoken")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }

    // Google answers a real 500: revocation did NOT succeed.
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  };

  try {
    const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: false, revoked: false });

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
      .get("uid-1").n;
    assert.equal(count, 0, "an HTTP error must still delete locally");
  } finally {
    globalThis.fetch = original;
  }
});

test("H3 disconnect treats Google's invalid_token 400 as already revoked", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", await encryptToken("1//gone", encKey), "s", "Bearer", 1, 1);

  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.href.includes("securetoken")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }

    // Google reports an already-revoked token as 400 invalid_token.
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 });
  };

  try {
    const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      { connected: false, revoked: true },
      "an already-gone token counts as revoked"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("H4 disconnect reports revoked:false on a network failure, still deletes", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", await encryptToken("1//x", encKey), "s", "Bearer", 1, 1);

  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.href.includes("securetoken")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }

    throw new Error("network down");
  };

  try {
    const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: false, revoked: false });

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
      .get("uid-1").n;
    assert.equal(count, 0, "a network failure must not keep a live grant locally");
  } finally {
    globalThis.fetch = original;
  }
});

test("H5 disconnect with no grant succeeds and reports revoked:true", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await withStubbedFetch(
    parsed =>
      parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null,
    async () => {
      const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { connected: false, revoked: true });
    }
  );
});

test("H6 disconnect never returns the refresh token", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const envelope = await encryptToken("1//top-secret", encKey);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", envelope, "s", "Bearer", 1, 1);

  await withStubbedFetch(
    parsed => {
      if (parsed.href.includes("securetoken")) return { keys: [key.jwk] };
      if (parsed.href.startsWith(GOOGLE_REVOKE_ENDPOINT)) return {};
      return null;
    },
    async () => {
      const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const text = await response.text();
      assert.ok(!text.includes("1//top-secret"), "no raw token in the response");
      assert.ok(!text.includes(envelope), "no envelope in the response");
    }
  );
});

test("H7 disconnect rejects an unauthenticated caller", async () => {
  const db = createFakeD1();

  const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
    method: "POST"
  });

  assert.equal(response.status, 401);
});

// =============================================================================
// I) Integration: pre-existing behaviour is untouched
// =============================================================================

test("I1 CORS preflight now advertises POST + Authorization", async () => {
  const response = await callWorker("/api/ping", oauthEnv(createFakeD1()), {
    method: "OPTIONS"
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("I2 an existing GET route still works with no OAuth env", async () => {
  await withStubbedFetch(
    () => null,
    async () => {
      const response = await callWorker("/api/ping", {
        YOUTUBE_API_KEY: "k",
        ASSETS: { fetch: async () => new Response("a") }
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
    }
  );
});

test("I3 an unknown oauth route is a 404, not a crash", async () => {
  const response = await callWorker("/api/oauth/nope", oauthEnv(createFakeD1()));
  assert.equal(response.status, 404);
});

test("I4 the migration created both OAuth tables", () => {
  const db = createFakeD1();
  const tables = db._sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(row => row.name);

  assert.ok(tables.includes("oauth_states"), "oauth_states must exist");
  assert.ok(tables.includes("oauth_grants"), "oauth_grants must exist");
});
