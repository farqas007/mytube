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
//   * the Connect flow is ENABLED (the approved contract): an unauthenticated
//     start is refused, while an authenticated start writes exactly one state
//     row and returns a PKCE authorization URL as JSON (never a redirect);
//   * the callback exchanges the code server-side, verifies the returned scope,
//     stores only an encrypted refresh token, and redirects to a fixed landing;
//   * the browser-bound state cookie is enforced BEFORE the code exchange, so a
//     missing/mismatched cookie neither exchanges the code nor writes a grant;
//   * a state that passes browser binding but is refused is burned: it can
//     never be redeemed by a replay;
//   * an EXISTING grant survives a refused callback untouched, stays visible
//     on /api/oauth/status, and stays revocable through /api/oauth/disconnect;
//   * the status body reports the flow as enabled in both the connected and
//     the disconnected case;
//   * the scheduled handler prunes expired/redeemed flow state, and never a
//     stored grant;
//   * state validation: missing, expired, consumed (replay), redirect mismatch,
//     and a missing or mismatched browser-bound state cookie;
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

import worker, { scheduled } from "../worker.js";
import {
  FIREBASE_JWT_ALG,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_YOUTUBE_SCOPE,
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
import {
  _resetTokenState,
  _testInternals,
  getAccessTokenForUser
} from "../shared/oauth-tokens.js";
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

test("D3 an unauthenticated start is refused before any state is written", async () => {
  const db = createFakeD1();

  const response = await callWorker(
    "/api/oauth/start",
    oauthEnv(db)
  );

  // Connect is enabled, so the flow reaches the Firebase gate. Without a token
  // it stops there: no authorization URL is handed out and no state row exists
  // for an anonymous caller to redeem.
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, "UNAUTHENTICATED");
  assert.ok(!body.authorizationUrl, "no authorization URL for an anonymous caller");
  assert.ok(!/ya29|1\/\//.test(JSON.stringify(body)), "no token in the error");

  const states = db._sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states").get().n;
  assert.equal(states, 0, "an unauthenticated start writes no state row");
});

test("D3b the routes that stay open still require a Firebase token", async () => {
  const db = createFakeD1();

  // The start route now enforces the same gate as the rest of the OAuth API:
  // without a token it is a 401. Status keeps the identical gate.
  const response = await callWorker("/api/oauth/status", oauthEnv(db));

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "UNAUTHENTICATED");
});

// =============================================================================
// E) Worker: start — the Connect flow is enabled
// =============================================================================

test("E1 an authenticated start writes one state row and returns an authorization URL", async () => {
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

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(typeof body.authorizationUrl, "string");

      const url = new URL(body.authorizationUrl);
      assert.equal(url.origin, "https://accounts.google.com");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
      assert.ok(url.searchParams.get("state"), "a state is carried");
      assert.ok(url.searchParams.get("code_challenge"), "a PKCE challenge is carried");
      assert.ok(
        !/client_secret|refresh_token/i.test(JSON.stringify(body)),
        "the start body must never carry a secret or token"
      );

      // Exactly one state row, owned by the authenticated uid, with the exact
      // redirect URI the authorization URL was built with.
      const states = db._sqlite.prepare("SELECT * FROM oauth_states").all();
      assert.equal(states.length, 1, "exactly one state row may be created");
      assert.equal(states[0].uid, "uid-start");
      assert.equal(states[0].redirect_uri, REDIRECT_URI);
      assert.equal(states[0].consumed, 0);
      assert.equal(states[0].state, url.searchParams.get("state"));

      // The browser-bound cookie is set on the same response, before the
      // browser leaves for Google.
      const cookie = response.headers.get("Set-Cookie") || "";
      assert.match(cookie, /mytube_oauth_state=/);
      assert.match(cookie, new RegExp(states[0].state));
      assert.match(cookie, /HttpOnly/i);
    }
  );
});

test("E2 an authenticated start returns JSON, never a redirect", async () => {
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
      const body = await response.json();
      assert.equal(typeof body.authorizationUrl, "string");
    }
  );
});

// =============================================================================
// F) Worker: callback — the success path, the browser-binding guard and every
//    error branch
// -----------------------------------------------------------------------------
// /start is covered by section E. This section covers /callback: the browser-
// bound state cookie is checked BEFORE the single-use state is consumed and
// before the authorization code is exchanged. A valid callback exchanges the
// code server-side, verifies the returned YouTube scope, stores only an
// encrypted refresh token, and redirects to the fixed landing. Status and
// disconnect stay open, so an existing grant remains visible and revocable.
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

// The callback requires the browser-bound cookie that /start would have set.
function stateCookieHeaders(state) {
  return { Cookie: `mytube_oauth_state=${state}` };
}

test("F1 a valid header-less callback exchanges the code and stores an encrypted grant", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  // NOTE: no Authorization header. Google redirects the browser and cannot send
  // one; the stored state and its browser-bound cookie authenticate this step.
  await withStubbedFetch(
    parsed => {
      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return {
          refresh_token: "1//refresh-abc",
          access_token: "ya29.access",
          scope: GOOGLE_YOUTUBE_SCOPE,
          token_type: "Bearer"
        };
      }
      return null;
    },
    async calls => {
      const response = await callWorker(
        `/api/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
        oauthEnv(db),
        { headers: stateCookieHeaders(state) }
      );

      const location = assertLanding(response, "connected");
      // The landing URL must carry no token, code or secret.
      assert.ok(!/1\/\/|ya29|refresh|code=/i.test(location.href), "no secret in URL");

      // The authorization code is exchanged exactly once, server-side.
      const tokenCalls = calls.filter(call =>
        call.url.href.startsWith(GOOGLE_TOKEN_ENDPOINT)
      );
      assert.equal(tokenCalls.length, 1, "the code is exchanged once");

      // The stored grant belongs to the state's uid, carries the verified
      // scope, and holds only the encrypted refresh token — never plaintext.
      const row = db._sqlite
        .prepare("SELECT * FROM oauth_grants WHERE uid = ?")
        .get("uid-1");
      assert.ok(row, "a grant is stored for the state's uid");
      assert.equal(row.scope, GOOGLE_YOUTUBE_SCOPE);
      assert.equal(row.token_type, "Bearer");
      assert.equal(row.revoked_at_ms, null);
      assert.notEqual(row.refresh_token_enc, "1//refresh-abc");
      const encKey = await deriveAesKey(ENC_KEY_SECRET);
      assert.equal(await decryptToken(row.refresh_token_enc, encKey), "1//refresh-abc");

      // The single-use state is burned.
      const stateRow = db._sqlite
        .prepare("SELECT consumed FROM oauth_states WHERE state = ?")
        .get(state);
      assert.equal(stateRow.consumed, 1);
    }
  );
});

test("F2 a refused state is burned: it cannot be redeemed twice", async () => {
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
      oauthEnv(db),
      { headers: stateCookieHeaders(state) }
    );
    assertLanding(first, "error");

    // The state was CONSUMED before the refusal, so it is dead. A second
    // attempt finds consumed = 1 and is refused the same way — and it could
    // never be redeemed later either, not even if the switch were turned back
    // on, because the single-use latch is already closed.
    const row = db._sqlite
      .prepare("SELECT consumed FROM oauth_states WHERE state = ?")
      .get(state);
    assert.equal(row.consumed, 1, "a refused state must be burned");

    const second = await callWorker(
      `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
      oauthEnv(db),
      { headers: stateCookieHeaders(state) }
    );
    // A replayed state lands on the fixed error status, not a second grant.
    assertLanding(second, "error");

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants")
      .get().n;
    assert.equal(count, 0, "a replay must not mint a second grant");
  });
});

test("F3 an expired state is refused", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1", expiresAtMs: Date.now() - 1 });

  const response = await callWorker(
    `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    oauthEnv(db),
    { headers: stateCookieHeaders(state) }
  );

  assertLanding(response, "error");
});

test("F4 an unbound callback (state never stored) is refused", async () => {
  const db = createFakeD1();

  const response = await callWorker(
    "/api/oauth/callback?code=C&state=never-stored",
    oauthEnv(db),
    { headers: stateCookieHeaders("never-stored") }
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
    oauthEnv(db),
    { headers: stateCookieHeaders(state) }
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

  // NOTE: while OAUTH_CONNECT_ENABLED is false the exchange is never reached
  // at all (see F1/F11). This test stays as the regression for the branch
  // that runs if the switch is ever turned back on: a failed exchange must
  // land on the fixed error status and must not store anything.
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
      oauthEnv(db),
      { headers: stateCookieHeaders(state) }
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

  // With a valid stored state, its browser-bound cookie and NO Authorization
  // header, the callback must still answer with the fixed landing redirect —
  // never a 401 and never a 500. No Firebase session is involved, and none is
  // needed.
  await withStubbedFetch(
    parsed =>
      parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)
        ? { refresh_token: "1//ok", scope: "s", token_type: "Bearer" }
        : null,
    async () => {
      const response = await callWorker(
        `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
        oauthEnv(db),
        { headers: stateCookieHeaders(state) }
      );

      assert.equal(response.status, 302, "the callback answers with a redirect");
      assertLanding(response, "error");
    }
  );
});

test("F9a a callback without the state cookie is refused without burning the state", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  const response = await callWorker(
    `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    oauthEnv(db)
  );

  assertLanding(response, "error");
  assert.match(
    response.headers.get("Set-Cookie") || "",
    /mytube_oauth_state=;/,
    "the callback clears the state cookie"
  );

  const row = db._sqlite
    .prepare("SELECT consumed FROM oauth_states WHERE state = ?")
    .get(state);
  assert.equal(row.consumed, 0, "a missing browser binding must not consume state");
});

test("F9b a callback with a mismatched state cookie is refused without burning the state", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  const response = await callWorker(
    `/api/oauth/callback?code=C&state=${encodeURIComponent(state)}`,
    oauthEnv(db),
    { headers: stateCookieHeaders("wrong-state") }
  );

  assertLanding(response, "error");

  const row = db._sqlite
    .prepare("SELECT consumed FROM oauth_states WHERE state = ?")
    .get(state);
  assert.equal(row.consumed, 0, "a mismatched browser binding must not consume state");
});

test("F10 an unconfigured callback still redirects safely, never 500s", async () => {
  const response = await callWorker("/api/oauth/callback?code=C&state=S", {
    YOUTUBE_API_KEY: "k",
    ASSETS: { fetch: async () => new Response("a") }
  });

  assertLanding(response, "error");
});

// -----------------------------------------------------------------------------
// The callback guard — the regression tests for the switch being off.
//
// The gap this closes: OAUTH_CONNECT_ENABLED = false used to block only
// /api/oauth/start. A state that was minted before the flip could still be
// redeemed by /api/oauth/callback, which would exchange the authorization code
// and INSERT a fresh oauth_grants row. These tests pin that no grant can be
// created any more, that a refused state is dead for good, and that an
// EXISTING grant is neither touched nor stranded.
// -----------------------------------------------------------------------------

test("F11 the callback guard blocks the code exchange and the grant write", async () => {
  const db = createFakeD1();
  const { state } = seedState(db, { uid: "uid-1" });

  await withStubbedFetch(
    parsed => {
      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return {
          refresh_token: "1//refresh-abc",
          access_token: "ya29.access",
          scope: GOOGLE_YOUTUBE_SCOPE,
          token_type: "Bearer"
        };
      }
      return null;
    },
    async calls => {
      // The state exists, but this browser did not start it: a mismatched
      // browser-bound cookie must be refused BEFORE anything is exchanged.
      const response = await callWorker(
        `/api/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
        oauthEnv(db),
        { headers: stateCookieHeaders("some-other-browser-state") }
      );

      assertLanding(response, "error");

      // 1. Google is never contacted: the code is not exchanged, so no token
      //    is minted and no Google-side grant is created for MyTube.
      const tokenCalls = calls.filter(call =>
        call.url.href.startsWith(GOOGLE_TOKEN_ENDPOINT)
      );
      assert.equal(tokenCalls.length, 0, "no token exchange may happen");

      // 2. No grant row exists afterwards — not for the state's uid, not for
      //    anybody else.
      const count = db._sqlite
        .prepare("SELECT COUNT(*) AS n FROM oauth_grants")
        .get().n;
      assert.equal(count, 0, "no grant may be created");

      // 3. The guard runs before consumeOauthState, so a mismatched cookie
      //    cannot burn the legitimate state: the real browser can still
      //    complete the flow.
      const row = db._sqlite
        .prepare("SELECT consumed FROM oauth_states WHERE state = ?")
        .get(state);
      assert.equal(row.consumed, 0, "a mismatched binding must not burn the state");
    }
  );
});

test("F12 a refused callback leaves an existing grant intact and still revocable", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const encKey = await deriveAesKey(ENC_KEY_SECRET);
  const envelope = await encryptToken("1//existing-grant", encKey);
  const { state } = seedState(db, { uid: "uid-1" });

  // A grant that already exists from an earlier connection.
  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", envelope, GOOGLE_YOUTUBE_SCOPE, "Bearer", 111, 111);

  await withStubbedFetch(
    parsed => {
      if (parsed.href.includes("securetoken")) return { keys: [key.jwk] };
      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return {
          refresh_token: "1//refresh-abc",
          scope: GOOGLE_YOUTUBE_SCOPE,
          token_type: "Bearer"
        };
      }
      if (parsed.href.startsWith(GOOGLE_REVOKE_ENDPOINT)) return {};
      return null;
    },
    async () => {
      // A pending state for the same uid is refused because this browser did
      // not start it (mismatched binding cookie) ...
      const response = await callWorker(
        `/api/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
        oauthEnv(db),
        { headers: stateCookieHeaders("some-other-browser-state") }
      );
      assertLanding(response, "error");

      // ... and the existing grant is untouched: not overwritten, not revoked,
      // not deleted.
      const row = db._sqlite
        .prepare("SELECT * FROM oauth_grants WHERE uid = ?")
        .get("uid-1");
      assert.ok(row, "the existing grant must survive a refused callback");
      assert.equal(row.refresh_token_enc, envelope, "the stored grant must not change");
      assert.equal(row.connected_at_ms, 111);
      assert.equal(row.updated_at_ms, 111);
      assert.equal(row.revoked_at_ms, null);

      // The user can still remove it.
      const disconnect = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });

      assert.equal(disconnect.status, 200);
      assert.deepEqual(await disconnect.json(), { connected: false, revoked: true });

      const after = db._sqlite
        .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
        .get("uid-1").n;
      assert.equal(after, 0, "disconnect must still delete the grant");
    }
  );
});

test("F13 status still reports the existing grant after a refused callback", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });
  const { state } = seedState(db, { uid: "uid-1" });

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", "v1.iv.ct", GOOGLE_YOUTUBE_SCOPE, "Bearer", 1, 1);

  await withStubbedFetch(
    parsed => {
      if (parsed.href.includes("securetoken")) return { keys: [key.jwk] };
      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return {
          refresh_token: "1//refresh-abc",
          scope: GOOGLE_YOUTUBE_SCOPE,
          token_type: "Bearer"
        };
      }
      return null;
    },
    async () => {
      // Refused because this browser did not start the state (mismatched
      // binding cookie), not because the flow is unavailable.
      const refused = await callWorker(
        `/api/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`,
        oauthEnv(db),
        { headers: stateCookieHeaders("some-other-browser-state") }
      );
      assertLanding(refused, "error");

      // The connection the user already made is still reported, so they can
      // see it and revoke it.
      const status = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });

      assert.equal(status.status, 200);
      const body = await status.json();
      assert.equal(body.connected, true);
      assert.equal(body.scopeReady, true);
      assert.equal(body.connectEnabled, true);
      assert.ok(!JSON.stringify(body).includes("v1.iv.ct"), "no envelope leaks");
    }
  );
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
      assert.deepEqual(await response.json(), {
        connected: false,
        scope: "",
        scopeReady: false,
        connectEnabled: true
      });
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
      assert.equal(body.scopeReady, true);
      // The approved contract reports Connect as enabled even when a grant
      // already exists. The grant itself stays visible and revocable.
      assert.equal(body.connectEnabled, true);
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

// -----------------------------------------------------------------------------
// H) Disconnect drops the cached access token
// -----------------------------------------------------------------------------
//
// The access-token cache is per-isolate. A disconnect that leaves a cached
// token behind would let a token minted BEFORE the disconnect keep working in
// that isolate. The handler invalidates the uid's cache entry as soon as the
// caller is authenticated, before any grant read or revocation I/O.
//
// These tests import the SAME module instance the Worker imports (both resolve
// to shared/oauth-tokens.js), so they observe the Worker's real cache.

test("H8 disconnect clears the cached access token for the user", async () => {
  _resetTokenState();
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
    .run("uid-1", await encryptToken("1//cached", encKey), "s", "Bearer", 1, 1);

  const internals = _testInternals();
  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      return new Response(JSON.stringify({ access_token: "ya29.cached", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.href.startsWith(GOOGLE_REVOKE_ENDPOINT)) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.href.includes("securetoken")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };

    // Seed the cache for this uid through the real module code path.
    const cached = await getAccessTokenForUser("uid-1", oauthEnv(db), {
      db,
      config,
      fetch: globalThis.fetch,
      encryptToken,
      decryptToken
    });

    assert.equal(cached, "ya29.cached");
    assert.equal(
      internals.accessTokenCache.has("uid-1"),
      true,
      "the access token must be cached before the disconnect"
    );

    const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: false, revoked: true });

    assert.equal(
      internals.accessTokenCache.has("uid-1"),
      false,
      "the disconnect must drop the cached access token"
    );

    const count = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
      .get("uid-1").n;
    assert.equal(count, 0, "the local grant must be deleted");
  } finally {
    globalThis.fetch = original;
    _resetTokenState();
  }
});

test("H9 disconnect invalidates an in-flight refresh", async () => {
  _resetTokenState();
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
    .run("uid-1", await encryptToken("1//inflight", encKey), "s", "Bearer", 1, 1);

  const internals = _testInternals();
  const original = globalThis.fetch;

  // Park the token exchange so the refresh is provably still in flight while
  // the disconnect runs.
  let releaseTokenExchange;
  const tokenExchangeGate = new Promise(resolve => {
    releaseTokenExchange = resolve;
  });

  globalThis.fetch = async url => {
    const parsed = new URL(url);

    if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      await tokenExchangeGate;
      return new Response(JSON.stringify({ access_token: "ya29.late", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.href.startsWith(GOOGLE_REVOKE_ENDPOINT)) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (parsed.href.includes("securetoken")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, encryptionKey: encKey };

    // Settle into an object instead of a bare promise so a rejection can never
    // be reported as unhandled.
    const refresh = getAccessTokenForUser("uid-1", oauthEnv(db), {
      db,
      config,
      fetch: globalThis.fetch,
      encryptToken,
      decryptToken
    }).then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error })
    );

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(
      internals.accessTokenInFlight.has("uid-1"),
      true,
      "the refresh must be in flight before the disconnect"
    );

    const response = await callWorker("/api/oauth/disconnect", oauthEnv(db), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connected: false, revoked: true });

    // Let the parked exchange finish: its result must be discarded.
    releaseTokenExchange();

    const outcome = await refresh;
    assert.equal(outcome.ok, false, "the in-flight refresh must not succeed after a disconnect");
    assert.equal(
      outcome.error && outcome.error.message,
      "INVALIDATED",
      "the in-flight refresh must be invalidated, not returned"
    );
    assert.equal(
      internals.accessTokenCache.has("uid-1"),
      false,
      "no access token may be cached after the disconnect"
    );
  } finally {
    releaseTokenExchange();
    globalThis.fetch = original;
    _resetTokenState();
  }
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

// -----------------------------------------------------------------------------
// OAuth status handler: scopeReady
// -----------------------------------------------------------------------------
//
// The status endpoint reports whether the caller has a live grant and whether
// that grant carries the scope MyTube needs to act on the user's behalf.
// `scopeReady` is a pure boolean derived from the STORED scope string; it
// never exposes a token, an envelope, or any credential.

test("S1 status reports disconnected with no grant and scopeReady false", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        connected: false,
        scope: "",
        scopeReady: false,
        connectEnabled: true
      });
    }
  );
});

test("S2 status reports connected and scopeReady true with the required scope", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await db
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .bind("uid-1", "v1.iv.ct", GOOGLE_YOUTUBE_SCOPE, "Bearer", 1, 1)
    .run();

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.connected, true);
      assert.equal(body.scope, GOOGLE_YOUTUBE_SCOPE);
      assert.equal(body.scopeReady, true);
      assert.equal(body.connectedAtMs, 1);
      assert.ok(
        !JSON.stringify(body).includes("v1.iv.ct"),
        "the stored envelope must never leak"
      );
    }
  );
});

test("S3 status scopeReady is true when the required scope is one of several", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  const scope = [
    "https://www.googleapis.com/auth/youtube.readonly",
    GOOGLE_YOUTUBE_SCOPE,
    "https://www.googleapis.com/auth/userinfo.email"
  ].join(" ");

  await db
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .bind("uid-1", "v1.iv.ct", scope, "Bearer", 1, 1)
    .run();

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      assert.equal(body.connected, true);
      assert.equal(body.scope, scope);
      assert.equal(body.scopeReady, true);
    }
  );
});

test("S4 status reports connected but scopeReady false for an insufficient scope", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await db
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .bind(
      "uid-1",
      "v1.iv.ct",
      "https://www.googleapis.com/auth/youtube.readonly",
      "Bearer",
      1,
      1
    )
    .run();

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      assert.equal(body.connected, true);
      assert.equal(body.scope, "https://www.googleapis.com/auth/youtube.readonly");
      assert.equal(body.scopeReady, false);
    }
  );
});

test("S5 status reports connected but scopeReady false for an empty scope", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await db
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .bind("uid-1", "v1.iv.ct", "", "Bearer", 1, 1)
    .run();

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      assert.equal(body.connected, true);
      assert.equal(body.scope, "");
      assert.equal(body.scopeReady, false);
    }
  );
});

test("S6 status treats a revoked grant as disconnected with scopeReady false", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey();
  const token = await mintIdToken(key, { sub: "uid-1" });

  await db
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind("uid-1", "v1.iv.ct", GOOGLE_YOUTUBE_SCOPE, "Bearer", 1, 1, 2)
    .run();

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      const response = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        connected: false,
        scope: "",
        scopeReady: false,
        connectEnabled: true
      });
    }
  );
});

// =============================================================================
// K) Scheduled cleanup of expired OAuth state rows
// -----------------------------------------------------------------------------
// The start route prunes opportunistically when a flow begins, but the
// scheduled handler is the authoritative cleanup and must work without any
// request. The cutoff it uses is the one the callback already applies to reject
// an expired state: expires_at_ms <= now.
// =============================================================================

// Insert one flow-state row directly, the way a started flow would.
function insertStateRow(db, state, expiresAtMs, consumed, now) {
  db._sqlite
    .prepare(
      "INSERT INTO oauth_states " +
        "(state, uid, code_verifier, redirect_uri, created_at_ms, expires_at_ms, consumed) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(state, "uid-1", "verifier", REDIRECT_URI, now - 60_000, expiresAtMs, consumed);
}

test("K1 the scheduled handler prunes expired and redeemed state rows", async () => {
  const db = createFakeD1();
  const now = Date.now();
  const live = now + 10 * 60 * 1000;

  insertStateRow(db, "state-expired", now - 1000, 0, now);
  insertStateRow(db, "state-redeemed", live, 1, now);
  insertStateRow(db, "state-live", live, 0, now);

  // A grant must survive the cleanup untouched: pruning flow state may never
  // touch a stored grant.
  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run("uid-1", "v1.iv.ct", GOOGLE_YOUTUBE_SCOPE, "Bearer", 1, 1);

  await withStubbedFetch(
    parsed => {
      throw new Error("the scheduled prune must not call out: " + parsed.href);
    },
    async calls => {
      await scheduled({}, oauthEnv(db), {});
      assert.equal(calls.length, 0, "the scheduled run must not make any request");
    }
  );

  const remaining = db._sqlite
    .prepare("SELECT state FROM oauth_states ORDER BY state")
    .all()
    .map(row => row.state);

  assert.deepEqual(remaining, ["state-live"], "only the live state may survive");

  const grants = db._sqlite.prepare("SELECT uid FROM oauth_grants").all();
  assert.equal(grants.length, 1, "a stored grant must never be pruned");
});

test("K2 the scheduled prune is repeatable and leaves a live state alone", async () => {
  const db = createFakeD1();
  const now = Date.now();

  insertStateRow(db, "state-live", now + 10 * 60 * 1000, 0, now);

  await withStubbedFetch(
    parsed => {
      throw new Error("the scheduled prune must not call out: " + parsed.href);
    },
    async () => {
      await scheduled({}, oauthEnv(db), {});
      await scheduled({}, oauthEnv(db), {});
    }
  );

  const remaining = db._sqlite
    .prepare("SELECT state FROM oauth_states ORDER BY state")
    .all()
    .map(row => row.state);

  assert.deepEqual(remaining, ["state-live"], "a live state survives every run");
});
