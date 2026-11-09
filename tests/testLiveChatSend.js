// =============================================================================
// MyTube — live-chat sending tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// These exercise the REAL shipped code:
//   * worker.js                     — POST /api/liveChat/send + the kill switch
//   * shared/oauth-tokens.js        — the stored grant / refresh path
//   * migrations/0004_oauth.sql     — via the real-SQLite D1 double
//
// Nothing here touches the network, D1 remote, YouTube, or any real secret. The
// Firebase JWKS, the Google token endpoint and the YouTube Data API are stubbed
// through globalThis.fetch, exactly like tests/testOAuth.js and
// tests/testWorkerIndex.js do.
//
// What is pinned:
//   * CHAT_SEND_ENABLED must be exactly "true"; anything else refuses BEFORE
//     auth, D1 or any network call (zero-fetch assertions);
//   * Connect is enabled independently of the sending kill switch;
//   * the client sends a VIDEO id only — the chat id is always resolved
//     server-side and a body-supplied liveChatId is ignored;
//   * input validation (empty, whitespace, >200 code points, control chars,
//     oversized body, bad ids);
//   * missing/insufficient/revoked grants fail closed with the right code;
//   * the single insert attempt is never retried, and its request is exactly
//     one POST with the bearer token in a header (never a URL/response);
//   * every documented YouTube failure maps to a closed MyTube code;
//   * per-user limits, requestId replay, and the one-at-a-time lock;
//   * /api/liveChat reports chatSendEnabled for the read path.
//
// Run: node --test tests/testLiveChatSend.js
// =============================================================================

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import worker from "../worker.js";
import {
  FIREBASE_JWT_ALG,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_YOUTUBE_SCOPE,
  base64UrlEncode,
  deriveAesKey,
  encryptToken
} from "../shared/oauth.js";
import { _resetTokenState } from "../shared/oauth-tokens.js";
import { createFakeD1 } from "./helpers/fake-d1.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PROJECT_ID = "mytube-827d2";
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://mytube.farqas007.workers.dev/api/oauth/callback";

const FAKE_ACCESS_TOKEN = "ya29.test-access-token-not-a-real-secret";
const FAKE_REFRESH_TOKEN = "1//test-refresh-token-not-a-real-secret";

// A base64url secret that decodes to exactly 32 bytes (AES-256).
const ENC_KEY_SECRET = base64UrlEncode(
  Uint8Array.from({ length: 32 }, (_, i) => i + 1)
);

// Every test uses a unique 11-char video id so the Worker's 30s live-probe
// cache can never leak a result across tests.
function videoId(n) {
  return "vid" + String(n).padStart(8, "0");
}

// -----------------------------------------------------------------------------
// RSA keypair + JWKS so ID tokens are genuinely signed and verified
// -----------------------------------------------------------------------------

// One key for the whole file: the Worker caches JWKS at module scope, so a
// stable kid keeps every test verifying against the same real key.
let signingKeyPromise = null;

async function getSigningKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = (async () => {
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
      const kid = "kid-live-chat-send";

      return {
        kid,
        privateKey: pair.privateKey,
        jwk: { ...publicJwk, kid, alg: FIREBASE_JWT_ALG, use: "sig" }
      };
    })();
  }

  return signingKeyPromise;
}

function jsonSegment(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function mintIdToken(signingKey, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: FIREBASE_JWT_ALG, kid: signingKey.kid, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
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
  return `10.47.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function makeEnv(db, extra = {}) {
  return {
    YOUTUBE_API_KEY: "test-key",
    ASSETS: { fetch: async () => new Response("asset") },
    FIREBASE_PROJECT_ID: PROJECT_ID,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    OAUTH_TOKEN_ENCRYPTION_KEY: ENC_KEY_SECRET,
    mytube_index: db,
    ...extra
  };
}

async function seedGrant(db, uid, options = {}) {
  const key = await deriveAesKey(ENC_KEY_SECRET);
  const envelope = await encryptToken(FAKE_REFRESH_TOKEN, key);

  db._sqlite
    .prepare(
      "INSERT INTO oauth_grants " +
        "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      uid,
      envelope,
      options.scope || GOOGLE_YOUTUBE_SCOPE,
      "Bearer",
      111,
      111,
      options.revoked ? 222 : null
    );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function liveVideoItem(liveChatId = "chat-1") {
  return {
    id: "v",
    snippet: { liveBroadcastContent: "live" },
    liveStreamingDetails: {
      actualStartTime: "2026-10-22T00:00:00Z",
      activeLiveChatId: liveChatId
    }
  };
}

function offlineVideoItem() {
  return {
    id: "v",
    snippet: { liveBroadcastContent: "none" },
    liveStreamingDetails: { actualEndTime: "2026-10-21T00:00:00Z" }
  };
}

function insertMessageBody(text = "hello") {
  return {
    kind: "youtube#liveChatMessage",
    id: "msg-1",
    snippet: {
      type: "textMessageEvent",
      liveChatId: "chat-1",
      publishedAt: "2026-10-22T00:00:00.000Z",
      textMessageDetails: { messageText: text }
    },
    authorDetails: {
      displayName: "Test User",
      channelId: "UCtest",
      isChatOwner: false,
      isChatModerator: false,
      isChatSponsor: false
    }
  };
}

// A default stub for every upstream endpoint the send path can touch.
// `insert` may be a function returning a Response (sync or async); when absent
// the insert succeeds and echoes the submitted text.
function stubFor({
  key,
  live = true,
  liveChatId = "chat-1",
  insert = null
} = {}) {
  return (parsed, init = {}) => {
    if (parsed.href.includes("securetoken")) {
      return jsonResponse({ keys: [key.jwk] });
    }

    if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      return jsonResponse({
        access_token: FAKE_ACCESS_TOKEN,
        expires_in: 3600,
        scope: GOOGLE_YOUTUBE_SCOPE,
        token_type: "Bearer"
      });
    }

    if (parsed.pathname.endsWith("/youtube/v3/videos")) {
      return jsonResponse({
        items: live ? [liveVideoItem(liveChatId)] : [offlineVideoItem()]
      });
    }

    if (parsed.pathname.endsWith("/youtube/v3/liveChat/messages")) {
      if (init.method === "POST") {
        if (insert) {
          return insert(parsed, init);
        }

        let sent = null;

        try {
          sent = JSON.parse(init.body || "{}");
        } catch {
          sent = null;
        }

        return jsonResponse(
          insertMessageBody(sent?.snippet?.textMessageDetails?.messageText || "")
        );
      }

      return jsonResponse({ items: [], pollingIntervalMillis: 5000 });
    }

    throw new Error(`unexpected fetch: ${parsed.href}`);
  };
}

async function withFetchStub(handler, run) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    return handler(parsed, init, calls);
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function insertCalls(calls) {
  return calls.filter(
    call =>
      call.url.pathname.endsWith("/youtube/v3/liveChat/messages") &&
      call.init.method === "POST"
  );
}

function tokenCalls(calls) {
  return calls.filter(call => call.url.href.startsWith(GOOGLE_TOKEN_ENDPOINT));
}

async function postSend(env, payload, options = {}) {
  const headers = {
    "CF-Connecting-IP": options.ip || nextIp(),
    Origin: "https://mytube.farqas007.workers.dev"
  };

  if (options.contentType !== null) {
    headers["Content-Type"] = options.contentType || "application/json";
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const method = options.method || "POST";
  const init = { method, headers };

  if (method !== "GET" && method !== "HEAD") {
    init.body =
      options.rawBody !== undefined
        ? options.rawBody
        : JSON.stringify(payload ?? {});
  }

  const response = await worker.fetch(
    new Request(
      "https://mytube.farqas007.workers.dev/api/liveChat/send",
      init
    ),
    env,
    { waitUntil() {} }
  );

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { response, body };
}

// One fully-prepared happy path: signed-in uid, stored grant, kill switch on.
// `insert` customises the YouTube reply. Returns the response plus the recorded
// upstream calls and the fake DB.
async function runSend({
  uid,
  video,
  text = "hello",
  requestId,
  payloadExtra = {},
  insert = null,
  envExtra = {},
  options = {}
}) {
  const key = await getSigningKey();
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true", ...envExtra });

  return withFetchStub(stubFor({ key, insert }), async calls => {
    const result = await postSend(
      env,
      {
        videoId: video,
        text,
        ...(requestId ? { requestId } : {}),
        ...payloadExtra
      },
      { token, ...options }
    );

    return { ...result, db, calls, token };
  });
}

beforeEach(() => {
  // Access-token caches are module-scoped; every test starts from a clean slate.
  _resetTokenState();
});

// =============================================================================
// K) Kill switch, Connect state, authentication
// =============================================================================

test("K1 disabled refuses before auth, D1 or any network call", async () => {
  const env = makeEnv(createFakeD1());

  await withFetchStub(
    () => {
      throw new Error("no fetch may happen while sending is disabled");
    },
    async calls => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(1), text: "hello" },
        { token: "not-even-a-real-token" }
      );

      assert.equal(response.status, 503);
      assert.equal(body.code, "CHAT_SEND_DISABLED");
      assert.equal(calls.length, 0, "the kill switch runs before any network work");
    }
  );
});

test("K2 only the exact string \"true\" enables sending", async () => {
  for (const value of ["TRUE", "True", "1", "yes", "true ", " true", "", null]) {
    const extra = value === null ? {} : { CHAT_SEND_ENABLED: value };
    const { response, body } = await postSend(
      makeEnv(createFakeD1(), extra),
      { videoId: videoId(2), text: "hello" }
    );

    assert.equal(response.status, 503, `value ${JSON.stringify(value)} must stay off`);
    assert.equal(body.code, "CHAT_SEND_DISABLED");
  }
});

test("K3 an enabled endpoint still requires a Firebase sign-in", async () => {
  const key = await getSigningKey();
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async () => {
    const { response, body } = await postSend(env, {
      videoId: videoId(3),
      text: "hello"
    });

    assert.equal(response.status, 401);
    assert.equal(body.code, "UNAUTHENTICATED");
  });
});

test("K4 a non-POST request is refused before auth or validation", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("no fetch for a GET");
    },
    async calls => {
      const { response, body } = await postSend(env, null, { method: "GET" });

      assert.equal(response.status, 405);
      assert.equal(body.code, "METHOD_NOT_ALLOWED");
      assert.equal(calls.length, 0);
    }
  );
});

test("K5 OAuth Connect is enabled independently of sending", async () => {
  const key = await getSigningKey();
  const token = await mintIdToken(key, { sub: "uid-k5" });
  const db = createFakeD1();
  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async () => {
    const response = await worker.fetch(
      new Request(
        "https://mytube.farqas007.workers.dev/api/oauth/start",
        {
          headers: {
            "CF-Connecting-IP": nextIp(),
            Authorization: `Bearer ${token}`
          }
        }
      ),
      env,
      { waitUntil() {} }
    );

    // The approved contract: Connect is enabled. An authenticated start hands
    // out a PKCE authorization URL and records exactly one state row, while
    // the independent CHAT_SEND_ENABLED kill switch stays untouched.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.authorizationUrl, "string");
    assert.match(
      body.authorizationUrl,
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/
    );
    assert.ok(
      !/client_secret|refresh_token/i.test(JSON.stringify(body)),
      "the start body must never carry a secret or token"
    );

    const states = db._sqlite
      .prepare("SELECT COUNT(*) AS n FROM oauth_states")
      .get().n;
    assert.equal(states, 1, "an enabled start writes exactly one state row");
  });
});

// =============================================================================
// V) Input validation (all before auth/network)
// =============================================================================

test("V1 empty, whitespace-only and non-string text are refused", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("validation must not touch the network");
    },
    async calls => {
      for (const text of ["", "   ", "\t\n", 123, null, undefined]) {
        const { response, body } = await postSend(
          env,
          { videoId: videoId(4), text },
          { token: "not-checked" }
        );

        assert.equal(response.status, 400, `text ${JSON.stringify(text)}`);
        assert.equal(body.code, "INVALID_MESSAGE");
      }

      assert.equal(calls.length, 0);
    }
  );
});

test("V2 more than 200 Unicode code points is refused", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("no network");
    },
    async () => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(5), text: "a".repeat(201) },
        { token: "not-checked" }
      );

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_MESSAGE");
    }
  );
});

test("V3 exactly 200 code points is accepted", async () => {
  const text = "a".repeat(200);
  const { response, body, calls } = await runSend({
    uid: "uid-v3",
    video: videoId(6),
    text,
    requestId: "req-v3-0001"
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(insertCalls(calls).length, 1);
});

test("V4 200 emoji count as 200 characters, not 400", async () => {
  // A 200-code-point emoji string is 400 UTF-16 units. The server must count
  // code points, so this is allowed.
  const text = "😀".repeat(200);
  const { response, body } = await runSend({
    uid: "uid-v4",
    video: videoId(7),
    text,
    requestId: "req-v4-0001"
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test("V5 a control character in the text is refused", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("no network");
    },
    async () => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(8), text: "hello\u0000world" },
        { token: "not-checked" }
      );

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_MESSAGE");
    }
  );
});

test("V6 an oversized request body is refused", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });
  const rawBody = JSON.stringify({
    videoId: videoId(9),
    text: "a".repeat(5000)
  });

  await withFetchStub(
    () => {
      throw new Error("no network");
    },
    async () => {
      const { response, body } = await postSend(env, null, {
        rawBody,
        token: "not-checked"
      });

      assert.equal(response.status, 400);
      assert.equal(body.code, "BODY_TOO_LARGE");
    }
  );
});

test("V7 malformed JSON, wrong content type and bad video ids are refused", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("no network");
    },
    async () => {
      const badJson = await postSend(env, null, {
        rawBody: "{not-json",
        token: "not-checked"
      });
      assert.equal(badJson.response.status, 400);
      assert.equal(badJson.body.code, "INVALID_REQUEST");

      const badType = await postSend(
        env,
        { videoId: videoId(10), text: "hello" },
        { contentType: "text/plain", token: "not-checked" }
      );
      assert.equal(badType.response.status, 400);
      assert.equal(badType.body.code, "UNSUPPORTED_MEDIA_TYPE");

      for (const id of ["short", "way-too-long-video-id", "has space!!", ""]) {
        const badId = await postSend(
          env,
          { videoId: id, text: "hello" },
          { token: "not-checked" }
        );
        assert.equal(badId.response.status, 400, `id ${JSON.stringify(id)}`);
        assert.equal(badId.body.code, "INVALID_VIDEO_ID");
      }
    }
  );
});

test("V8 an invalid requestId shape is refused before auth", async () => {
  const env = makeEnv(createFakeD1(), { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    () => {
      throw new Error("no network");
    },
    async () => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(11), text: "hello", requestId: "bad id" },
        { token: "not-checked" }
      );

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_REQUEST");
    }
  );
});

// =============================================================================
// A) The stored grant / token path
// =============================================================================

test("A1 no stored grant fails closed as YOUTUBE_NOT_CONNECTED", async () => {
  const key = await getSigningKey();
  const token = await mintIdToken(key, { sub: "uid-a1" });
  const db = createFakeD1();
  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async calls => {
    const { response, body } = await postSend(
      env,
      { videoId: videoId(12), text: "hello" },
      { token }
    );

    assert.equal(response.status, 409);
    assert.equal(body.code, "YOUTUBE_NOT_CONNECTED");
    assert.equal(insertCalls(calls).length, 0);
  });
});

test("A2 a grant without force-ssl is refused before the token exchange", async () => {
  const key = await getSigningKey();
  const uid = "uid-a2";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid, {
    scope: "https://www.googleapis.com/auth/youtube.readonly"
  });

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async calls => {
    const { response, body } = await postSend(
      env,
      { videoId: videoId(13), text: "hello" },
      { token }
    );

    assert.equal(response.status, 409);
    assert.equal(body.code, "YOUTUBE_SCOPE_REQUIRED");
    assert.equal(tokenCalls(calls).length, 0, "no refresh round-trip is spent");
    assert.equal(insertCalls(calls).length, 0);
  });
});

test("A3 a revoked grant is treated as not connected", async () => {
  const key = await getSigningKey();
  const uid = "uid-a3";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid, { revoked: true });

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async calls => {
    const { response, body } = await postSend(
      env,
      { videoId: videoId(14), text: "hello" },
      { token }
    );

    assert.equal(response.status, 409);
    assert.equal(body.code, "YOUTUBE_NOT_CONNECTED");
    assert.equal(insertCalls(calls).length, 0);
  });
});

test("A4 an invalid refresh token asks the user to reconnect", async () => {
  const key = await getSigningKey();
  const uid = "uid-a4";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    (parsed, init) => {
      if (parsed.href.includes("securetoken")) {
        return jsonResponse({ keys: [key.jwk] });
      }

      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }

      if (parsed.pathname.endsWith("/youtube/v3/videos")) {
        return jsonResponse({ items: [liveVideoItem()] });
      }

      throw new Error(`unexpected fetch: ${parsed.href}`);
    },
    async calls => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(15), text: "hello" },
        { token }
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, "YOUTUBE_REAUTH_REQUIRED");
      assert.equal(insertCalls(calls).length, 0);
    }
  );
});

test("A5 a transient token-endpoint failure is a safe upstream error", async () => {
  const key = await getSigningKey();
  const uid = "uid-a5";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    (parsed) => {
      if (parsed.href.includes("securetoken")) {
        return jsonResponse({ keys: [key.jwk] });
      }

      if (parsed.href.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
        return jsonResponse({ error: "temporarily_unavailable" }, 500);
      }

      if (parsed.pathname.endsWith("/youtube/v3/videos")) {
        return jsonResponse({ items: [liveVideoItem()] });
      }

      throw new Error(`unexpected fetch: ${parsed.href}`);
    },
    async calls => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(16), text: "hello" },
        { token }
      );

      assert.equal(response.status, 502);
      assert.equal(body.code, "TOKEN_EXCHANGE_FAILED");
      assert.equal(insertCalls(calls).length, 0);
      assert.ok(!JSON.stringify(body).includes(FAKE_REFRESH_TOKEN));
    }
  );
});

test("A6 a cached access token is not reused after the grant is deleted", async () => {
  const key = await getSigningKey();
  const uid = "uid-a6";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key }), async calls => {
    const first = await postSend(
      env,
      { videoId: videoId(30), text: "hello", requestId: "req-a6-0001" },
      { token }
    );
    assert.equal(first.response.status, 200);

    // Another isolate or a direct database change removes the grant while this
    // isolate still has an unexpired access token cached.
    db._sqlite.prepare("DELETE FROM oauth_grants WHERE uid = ?").run(uid);

    const second = await postSend(
      env,
      { videoId: videoId(30), text: "hello again", requestId: "req-a6-0002" },
      { token }
    );

    assert.equal(second.response.status, 409);
    assert.equal(second.body.code, "YOUTUBE_NOT_CONNECTED");
    assert.equal(insertCalls(calls).length, 1, "the deleted grant blocks the second send");
  });
});

// =============================================================================
// L) Live-state resolution
// =============================================================================

test("L1 a non-live video is refused without touching the grant", async () => {
  const key = await getSigningKey();
  const uid = "uid-l1";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(stubFor({ key, live: false }), async calls => {
    const { response, body } = await postSend(
      env,
      { videoId: videoId(17), text: "hello" },
      { token }
    );

    assert.equal(response.status, 409);
    assert.equal(body.code, "NOT_LIVE");
    assert.equal(tokenCalls(calls).length, 0);
    assert.equal(insertCalls(calls).length, 0);
  });
});

test("L2 a live video with chat disabled is refused", async () => {
  const key = await getSigningKey();
  const uid = "uid-l2";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await withFetchStub(
    (parsed) => {
      if (parsed.href.includes("securetoken")) {
        return jsonResponse({ keys: [key.jwk] });
      }

      if (parsed.pathname.endsWith("/youtube/v3/videos")) {
        const item = liveVideoItem("");
        item.snippet.liveBroadcastContent = "live";
        item.liveStreamingDetails.activeLiveChatId = "";
        item.liveStreamingDetails.liveChatDisabled = true;
        return jsonResponse({ items: [item] });
      }

      throw new Error(`unexpected fetch: ${parsed.href}`);
    },
    async calls => {
      const { response, body } = await postSend(
        env,
        { videoId: videoId(18), text: "hello" },
        { token }
      );

      assert.equal(response.status, 409);
      assert.equal(body.code, "CHAT_DISABLED");
      assert.equal(insertCalls(calls).length, 0);
    }
  );
});

// =============================================================================
// S) The single insert attempt and its error mapping
// =============================================================================

test("S1 the insert is one POST, uses the bearer header, and leaks no token", async () => {
  const text = "Hello, live chat! 👋";
  const { response, body, calls } = await runSend({
    uid: "uid-s1",
    video: videoId(19),
    text,
    requestId: "req-s1-0001"
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.message.id, "msg-1");
  assert.equal(body.message.text, text);

  const inserts = insertCalls(calls);
  assert.equal(inserts.length, 1, "exactly one insert attempt");

  const [insert] = inserts;
  assert.equal(insert.url.pathname, "/youtube/v3/liveChat/messages");
  assert.equal(insert.url.searchParams.get("part"), "snippet");
  assert.equal(insert.init.method, "POST");
  assert.equal(insert.init.headers.Authorization, `Bearer ${FAKE_ACCESS_TOKEN}`);
  assert.ok(!insert.url.href.includes(FAKE_ACCESS_TOKEN), "token never in a URL");

  const sent = JSON.parse(insert.init.body);
  assert.deepEqual(sent, {
    snippet: {
      liveChatId: "chat-1",
      type: "textMessageEvent",
      textMessageDetails: { messageText: text }
    }
  });

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(FAKE_ACCESS_TOKEN), "access token never in the body");
  assert.ok(!raw.includes(FAKE_REFRESH_TOKEN), "refresh token never in the body");
});

test("S2 a client-supplied chat id is ignored; the server resolves it", async () => {
  const { response, calls } = await runSend({
    uid: "uid-s2",
    video: videoId(20),
    text: "hello",
    requestId: "req-s2-0001",
    payloadExtra: { liveChatId: "evil-chat", chatId: "evil-chat" }
  });

  assert.equal(response.status, 200);

  const sent = JSON.parse(insertCalls(calls)[0].init.body);
  assert.equal(sent.snippet.liveChatId, "chat-1");
});

test("S3 the text is preserved exactly, including surrounding spaces", async () => {
  const text = "  spaced message  ";
  const { response, body, calls } = await runSend({
    uid: "uid-s3",
    video: videoId(21),
    text,
    requestId: "req-s3-0001"
  });

  assert.equal(response.status, 200);
  assert.equal(body.message.text, text);
  assert.equal(
    JSON.parse(insertCalls(calls)[0].init.body).snippet.textMessageDetails.messageText,
    text
  );
});

function upstreamErrorTest(name, { uid, video, status, reason, expectStatus, expectCode }) {
  test(name, async () => {
    const { response, body, calls } = await runSend({
      uid,
      video,
      text: "hello",
      requestId: `req-${uid}-0001`,
      insert: () =>
        jsonResponse(
          { error: { code: status, errors: [{ reason }] } },
          status
        )
    });

    assert.equal(response.status, expectStatus);
    assert.equal(body.code, expectCode);
    assert.equal(insertCalls(calls).length, 1, "the insert is never retried");
  });
}

upstreamErrorTest("S4 400 messageTextInvalid maps to INVALID_MESSAGE", {
  uid: "uid-s4",
  video: videoId(22),
  status: 400,
  reason: "messageTextInvalid",
  expectStatus: 400,
  expectCode: "INVALID_MESSAGE"
});

upstreamErrorTest("S5 403 forbidden maps to CHAT_FORBIDDEN", {
  uid: "uid-s5",
  video: videoId(23),
  status: 403,
  reason: "forbidden",
  expectStatus: 403,
  expectCode: "CHAT_FORBIDDEN"
});

upstreamErrorTest("S6 403 liveChatEnded maps to LIVE_CHAT_ENDED", {
  uid: "uid-s6",
  video: videoId(24),
  status: 403,
  reason: "liveChatEnded",
  expectStatus: 409,
  expectCode: "LIVE_CHAT_ENDED"
});

upstreamErrorTest("S7 403 quotaExceeded maps to QUOTA_EXCEEDED", {
  uid: "uid-s7",
  video: videoId(25),
  status: 403,
  reason: "quotaExceeded",
  expectStatus: 503,
  expectCode: "QUOTA_EXCEEDED"
});

upstreamErrorTest("S8 403 rateLimitExceeded maps to CHAT_RATE_LIMITED", {
  uid: "uid-s8",
  video: videoId(26),
  status: 403,
  reason: "rateLimitExceeded",
  expectStatus: 429,
  expectCode: "CHAT_RATE_LIMITED"
});

upstreamErrorTest("S9 429 maps to CHAT_RATE_LIMITED", {
  uid: "uid-s9",
  video: videoId(27),
  status: 429,
  reason: "rateLimitExceeded",
  expectStatus: 429,
  expectCode: "CHAT_RATE_LIMITED"
});

upstreamErrorTest("S10 404 maps to LIVE_CHAT_NOT_FOUND", {
  uid: "uid-s10",
  video: videoId(28),
  status: 404,
  reason: "liveChatNotFound",
  expectStatus: 409,
  expectCode: "LIVE_CHAT_NOT_FOUND"
});

upstreamErrorTest("S11 500 maps to a safe UPSTREAM_ERROR", {
  uid: "uid-s11",
  video: videoId(29),
  status: 500,
  reason: "backendError",
  expectStatus: 502,
  expectCode: "UPSTREAM_ERROR"
});

test("S12 a network failure on the insert is not retried", async () => {
  const { response, body, calls } = await runSend({
    uid: "uid-s12",
    video: videoId(30),
    text: "hello",
    requestId: "req-s12-0001",
    insert: () => {
      throw new Error("simulated network failure");
    }
  });

  assert.equal(response.status, 502);
  assert.equal(body.code, "UPSTREAM_ERROR");
  assert.equal(insertCalls(calls).length, 1);
});

test("S13 a 401 from YouTube asks for reconnect and keeps the grant", async () => {
  const { response, body, db, calls } = await runSend({
    uid: "uid-s13",
    video: videoId(31),
    text: "hello",
    requestId: "req-s13-0001",
    insert: () => jsonResponse({ error: { code: 401 } }, 401)
  });

  assert.equal(response.status, 409);
  assert.equal(body.code, "YOUTUBE_REAUTH_REQUIRED");
  assert.equal(insertCalls(calls).length, 1);

  const grants = db._sqlite
    .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE uid = ?")
    .get("uid-s13").n;
  assert.equal(grants, 1, "the grant row is preserved");

  assert.ok(!JSON.stringify(body).includes(FAKE_ACCESS_TOKEN));
});

test("S14 a 200 insert response without a normalized message is an error", async () => {
  const { response, body, calls } = await runSend({
    uid: "uid-s14",
    video: videoId(31),
    text: "hello",
    requestId: "req-s14-0001",
    insert: () => jsonResponse({})
  });

  assert.equal(response.status, 502);
  assert.equal(body.code, "UPSTREAM_ERROR");
  assert.equal(insertCalls(calls).length, 1, "the insert is not retried");
});

// =============================================================================
// R) Limits, replay and concurrency
// =============================================================================

test("R1 the 4th send inside 10 seconds is refused with no extra insert", async () => {
  const key = await getSigningKey();
  const uid = "uid-r1";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });
  const ip = nextIp();

  await withFetchStub(stubFor({ key }), async calls => {
    const statuses = [];

    for (let i = 0; i < 4; i++) {
      const { response, body } = await postSend(
        env,
        {
          videoId: videoId(32),
          text: "hello",
          requestId: `req-r1-000${i}`
        },
        { token, ip }
      );

      statuses.push(response.status);

      if (i === 3) {
        assert.equal(body.code, "RATE_LIMITED");
      }
    }

    assert.deepEqual(statuses, [200, 200, 200, 429]);
    assert.equal(insertCalls(calls).length, 3);
  });
});

test("R2 a repeated requestId returns the original result without a second insert", async () => {
  const key = await getSigningKey();
  const uid = "uid-r2";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });
  const payload = {
    videoId: videoId(33),
    text: "hello",
    requestId: "req-r2-0001"
  };

  await withFetchStub(stubFor({ key }), async calls => {
    const first = await postSend(env, payload, { token });
    const second = await postSend(env, payload, { token });

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(insertCalls(calls).length, 1);
  });
});

test("R3 a concurrent second send is refused while the first is in flight", async () => {
  const key = await getSigningKey();
  const uid = "uid-r3";
  const token = await mintIdToken(key, { sub: uid });
  const db = createFakeD1();

  await seedGrant(db, uid);

  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });
  const ip = nextIp();

  let releaseInsert;
  let insertStarted = false;
  const gate = new Promise(resolve => {
    releaseInsert = resolve;
  });

  await withFetchStub(
    stubFor({
      key,
      insert: async () => {
        insertStarted = true;
        await gate;
        return jsonResponse(insertMessageBody("first"));
      }
    }),
    async calls => {
      const firstPromise = postSend(
        env,
        { videoId: videoId(34), text: "first", requestId: "req-r3-0001" },
        { token, ip }
      );

      // Wait until the first request has passed auth and reached the insert.
      for (let i = 0; i < 200 && !insertStarted; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      assert.equal(insertStarted, true, "the first send reached YouTube");

      const second = await postSend(
        env,
        { videoId: videoId(34), text: "second", requestId: "req-r3-0002" },
        { token, ip }
      );

      assert.equal(second.response.status, 409);
      assert.equal(second.body.code, "SEND_IN_PROGRESS");

      releaseInsert();
      const first = await firstPromise;

      assert.equal(first.response.status, 200);
      assert.equal(insertCalls(calls).length, 1, "only one insert happened");
    }
  );
});

test("R4 two different users can send to the same chat independently", async () => {
  const key = await getSigningKey();
  const db = createFakeD1();
  const env = makeEnv(db, { CHAT_SEND_ENABLED: "true" });

  await seedGrant(db, "uid-r4a");
  await seedGrant(db, "uid-r4b");

  const tokenA = await mintIdToken(key, { sub: "uid-r4a" });
  const tokenB = await mintIdToken(key, { sub: "uid-r4b" });

  await withFetchStub(stubFor({ key }), async calls => {
    const a = await postSend(
      env,
      { videoId: videoId(35), text: "from a", requestId: "req-r4-0001" },
      { token: tokenA, ip: nextIp() }
    );
    const b = await postSend(
      env,
      { videoId: videoId(35), text: "from b", requestId: "req-r4-0002" },
      { token: tokenB, ip: nextIp() }
    );

    assert.equal(a.response.status, 200);
    assert.equal(b.response.status, 200);
    assert.equal(insertCalls(calls).length, 2);
  });
});

// =============================================================================
// C) Capability signal on the read route
// =============================================================================

test("C1 /api/liveChat reports chatSendEnabled per request", async () => {
  const key = await getSigningKey();
  const db = createFakeD1();
  const video = videoId(36);

  for (const [flag, expected] of [
    [undefined, false],
    ["true", true],
    ["TRUE", false],
    ["true ", false]
  ]) {
    const env = makeEnv(
      db,
      flag === undefined ? {} : { CHAT_SEND_ENABLED: flag }
    );

    await withFetchStub(
      (parsed, init) => {
        if (parsed.href.includes("securetoken")) {
          return jsonResponse({ keys: [key.jwk] });
        }

        if (parsed.pathname.endsWith("/youtube/v3/videos")) {
          return jsonResponse({ items: [liveVideoItem("chat-c1")] });
        }

        if (parsed.pathname.endsWith("/youtube/v3/liveChat/messages")) {
          assert.notEqual(init.method, "POST", "the read route never inserts");
          return jsonResponse({ items: [], pollingIntervalMillis: 5000 });
        }

        throw new Error(`unexpected fetch: ${parsed.href}`);
      },
      async calls => {
        const response = await worker.fetch(
          new Request(
            `https://mytube.farqas007.workers.dev/api/liveChat?id=${video}`,
            { headers: { "CF-Connecting-IP": nextIp() } }
          ),
          env,
          { waitUntil() {} }
        );

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(
          body.chatSendEnabled,
          expected,
          `flag ${JSON.stringify(flag)}`
        );
        assert.equal(insertCalls(calls).length, 0);
      }
    );
  }
});
