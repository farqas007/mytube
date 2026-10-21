// =============================================================================
// MyTube — OAuth rate limiter tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// Targets the new in-memory per-IP limiter added to worker.js for /api/oauth/*
// routes. Uses the same harness as tests/testOAuth.js: real worker.fetch,
// in-memory D1 (fake-d1), stubbed Firebase JWKS, and fixed CF-Connecting-IP.
//
// Run (targeted only): node --test tests/testOAuthRateLimit.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../worker.js";
import { base64UrlEncode } from "../shared/oauth.js";
import { createFakeD1 } from "./helpers/fake-d1.js";

const PROJECT_ID = "mytube-827d2";
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://mytube.farqas007.workers.dev/api/oauth/callback";
const FIREBASE_JWT_ALG = "RS256";

const ENC_KEY_SECRET = base64UrlEncode(
  new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31
  ])
);

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

async function mintIdToken(signingKey, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: FIREBASE_JWT_ALG,
    kid: signingKey.kid,
    typ: "JWT"
  };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: claims.sub || "firebase-uid-1",
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
    Origin: "https://mytube.farqas007.workers.dev",
    ...(options.headers || {})
  };

  const request = new Request(`https://mytube.farqas007.workers.dev${path}`, {
    method: options.method || "GET",
    headers
  });

  return worker.fetch(request, env, { waitUntil() {} });
}

async function withStubbedFetch(handlers, run) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
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
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("RL1 the first 10 starts from one IP succeed and the 11th is rate limited", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey("rl1");
  const token = await mintIdToken(key, { sub: "uid-rl1" });
  const fixedIp = "10.99.1.1";

  const responses = [];

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      // 10 is the provisional budget for start; send 11 to exceed it
      for (let i = 0; i < 11; i += 1) {
        responses.push(
          await callWorker("/api/oauth/start", oauthEnv(db), {
            headers: {
              Authorization: `Bearer ${token}`,
              "CF-Connecting-IP": fixedIp
            }
          })
        );
      }
    }
  );

  // The first 10 must ALL succeed: the budget is not tighter than documented.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      responses[i].status,
      200,
      `start request ${i + 1} must not be rate limited`
    );

    const body = await responses[i].json();
    assert.ok(
      body.authorizationUrl,
      `start request ${i + 1} must return an authorizationUrl`
    );
  }

  // The 11th exceeds the budget.
  assert.equal(responses[10].status, 429);
  const body = await responses[10].json();
  assert.equal(typeof body.error, "string");
  assert.equal(body.code, "RATE_LIMITED");
});

test("RL2 an exhausted start budget blocks a normal GET but not the OPTIONS preflight", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey("rl2");
  const token = await mintIdToken(key, { sub: "uid-rl2" });
  const fixedIp = "10.99.2.1";

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      // Exhaust start budget for this IP
      for (let i = 0; i < 11; i += 1) {
        await callWorker("/api/oauth/start", oauthEnv(db), {
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": fixedIp
          }
        });
      }

      // A normal GET from the exhausted IP is still rate limited. This is the
      // control that proves the 204 below is caused by the preflight bypass
      // and not by the IP simply being allowed through.
      const blocked = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": fixedIp
        }
      });

      assert.equal(blocked.status, 429);
      assert.equal((await blocked.json()).code, "RATE_LIMITED");

      // OPTIONS must bypass limiter
      const preflight = await callWorker("/api/oauth/status", oauthEnv(db), {
        method: "OPTIONS",
        headers: {
          "CF-Connecting-IP": fixedIp
        }
      });

      assert.equal(preflight.status, 204);
    }
  );
});

test("RL3 IP A is rate limited while IP B has an independent bucket", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey("rl3");
  const token = await mintIdToken(key, { sub: "uid-rl3" });
  const ipA = "10.99.3.1";
  const ipB = "10.99.3.2";

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      // Exhaust ipA
      let lastA;
      for (let i = 0; i < 11; i += 1) {
        lastA = await callWorker("/api/oauth/start", oauthEnv(db), {
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": ipA
          }
        });
      }

      assert.equal(lastA.status, 429);
      assert.equal((await lastA.json()).code, "RATE_LIMITED");

      // ipB should still be able to make requests (bucket independent)
      const response = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ipB
        }
      });

      // ipB's FIRST request must be an explicit success, not merely "not 429".
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.authorizationUrl, "ipB must receive an authorizationUrl");
    }
  );
});

test("RL4 status traffic does not consume the start budget and vice versa", async () => {
  const db = createFakeD1();
  const key = await makeSigningKey("rl4");
  const token = await mintIdToken(key, { sub: "uid-rl4" });
  const ipStatusHeavy = "10.99.4.1";
  const ipStartHeavy = "10.99.4.2";

  await withStubbedFetch(
    parsed => (parsed.href.includes("securetoken") ? { keys: [key.jwk] } : null),
    async () => {
      // --- Direction A: status traffic must not starve the start budget ---
      // The start budget is 10, so issue MORE status calls than that.
      for (let i = 0; i < 12; i += 1) {
        const statusResponse = await callWorker("/api/oauth/status", oauthEnv(db), {
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": ipStatusHeavy
          }
        });

        assert.equal(
          statusResponse.status,
          200,
          `status request ${i + 1} must not be rate limited`
        );

        const body = await statusResponse.json();
        assert.equal(body.connected, false);
        assert.equal(body.scope, "");
      }

      // The start route still has its full, untouched budget.
      const start = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ipStatusHeavy
        }
      });

      assert.equal(
        start.status,
        200,
        "status traffic must not consume the start budget"
      );
      const startBody = await start.json();
      assert.ok(
        startBody.authorizationUrl,
        "the start request must return an authorizationUrl"
      );

      // --- Direction B: exhausting start must not block status ---
      for (let i = 0; i < 11; i += 1) {
        await callWorker("/api/oauth/start", oauthEnv(db), {
          headers: {
            Authorization: `Bearer ${token}`,
            "CF-Connecting-IP": ipStartHeavy
          }
        });
      }

      const blockedStart = await callWorker("/api/oauth/start", oauthEnv(db), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ipStartHeavy
        }
      });

      assert.equal(blockedStart.status, 429);
      assert.equal((await blockedStart.json()).code, "RATE_LIMITED");

      // The status route has its own counter and is unaffected.
      const statusResponse = await callWorker("/api/oauth/status", oauthEnv(db), {
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": ipStartHeavy
        }
      });

      assert.equal(
        statusResponse.status,
        200,
        "start traffic must not consume the status budget"
      );
      const body = await statusResponse.json();
      assert.equal(body.connected, false);
      assert.equal(body.scope, "");
    }
  );
});
