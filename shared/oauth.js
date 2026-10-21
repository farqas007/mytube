// =============================================================================
// MyTube — Google OAuth foundation helpers (shared, Web Crypto only)
// -----------------------------------------------------------------------------
// This module is the security-bearing half of MyTube's Google OAuth
// authorization-code flow. It is deliberately dependency-free: everything here
// runs on the runtime's built-in Web Crypto (globalThis.crypto) and the Fetch
// Response/Headers primitives, so it works unchanged inside a Cloudflare Worker
// and inside `node --test` (Node exposes the same Web Crypto globals).
//
// Nothing in this file reads env, D1, or the network. The Worker wires those in.
// Keeping it pure is what makes the crypto testable without a Worker runtime.
//
// WHAT LIVES HERE
//   * PKCE (RFC 7636) verifier/challenge — S256 only.
//   * A high-entropy, single-use `state` value.
//   * Exact redirect-URI matching.
//   * AES-GCM encryption/decryption of a Google refresh token under a key
//     derived from a dedicated Worker secret.
//   * A constant-time string comparison.
//   * Firebase ID-token (JWT) claim validation: shape, kid, alg pinning,
//     signature, issuer, audience and expiry.
//
// WHAT DOES NOT LIVE HERE
//   * Any secret value. Key material is passed in by the caller.
//   * Any logging. This module never logs, and never echoes a token.
//
// SECURITY NOTES THAT MATTER (read before changing anything):
//   * S256 is pinned. `plain` is refused outright: a challenge equal to the
//     verifier would make PKCE decorative.
//   * AES-GCM uses a 96-bit random IV per encryption and stores the IV next to
//     the ciphertext. The IV is not secret; the key is. A fresh IV per write is
//     what keeps repeated writes of the same token from leaking equality.
//   * The Firebase verifier pins `alg` to RS256 and selects the key by the
//     token header's `kid` only. It never honours an `alg` the token asks for,
//     which is the `alg: none` / algorithm-confusion class of bug.
//   * Every comparison of a secret-ish value uses constant-time compare.
// =============================================================================

// The only signing algorithm accepted for Firebase ID tokens. See the module
// header: the token never gets to choose.
export const FIREBASE_JWT_ALG = "RS256";

// The only PKCE method accepted.
export const PKCE_METHOD_S256 = "S256";

// Google's OAuth 2.0 endpoints. The authorization endpoint is browser-facing
// (a 302 redirect); the token/revoke endpoints are server-side only.
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// The Firebase ID-token signing keys. `securetoken@system.gserviceaccount.com` is
// the documented service account for Firebase Auth ID tokens; the `/jwk` path
// returns the very same keys in JWK form, which Web Crypto can import directly.
export const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// The narrowest scope that permits BOTH posting comments and sending live-chat
// messages (both are writes; youtube.readonly cannot do either). See
// developers.google.com/identity/protocols/oauth2/scopes#youtube.
export const GOOGLE_YOUTUBE_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

// base64url encode over a byte array or ArrayBuffer.
export function base64UrlEncode(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";

  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// base64url decode to bytes. Throws on characters outside the alphabet.
export function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// Constant-time string comparison. Returns false on length mismatch (which is
// itself not secret: lengths are fixed by construction) and otherwise compares
// every byte so timing cannot reveal how far a guess matched.
export function constantTimeEqual(a, b) {
  const left = String(a == null ? "" : a);
  const right = String(b == null ? "" : b);

  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }

  return diff === 0;
}

// -----------------------------------------------------------------------------
// PKCE (RFC 7636), S256 only
// -----------------------------------------------------------------------------

// A high-entropy code_verifier: 32 random bytes rendered base64url (43 chars),
// which is inside RFC 7636's required 43..128 character range.
export function createCodeVerifier() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

// code_challenge = BASE64URL(SHA256(ASCII(code_verifier))).
export async function createCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(verifier || ""))
  );

  return base64UrlEncode(digest);
}

// A high-entropy, single-use `state`. 32 random bytes, base64url.
//
// The randomness is what matters: `state` is the CSRF token for the whole flow,
// so it must be unguessable and never reused. Storage and single-use enforcement
// happen in the Worker (D1), not here.
export function createState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

// Validate a PKCE verifier/challenge pair using constant-time compare.
// `method` must be S256; anything else is refused.
export async function verifyPkce(verifier, challenge, method) {
  if (String(method || "") !== PKCE_METHOD_S256) {
    return false;
  }

  if (!verifier || !challenge) {
    return false;
  }

  const computed = await createCodeChallenge(verifier);

  return constantTimeEqual(computed, challenge);
}

// -----------------------------------------------------------------------------
// AES-GCM secret-token envelope
// -----------------------------------------------------------------------------
// A Google refresh token must never be stored in plaintext. The Worker keeps a
// dedicated secret (a 32-byte key, base64url) and this module turns a token into
// an opaque envelope:
//
//     v1.<iv-b64url>.<ciphertext-b64url>
//
// The version prefix lets the format evolve without ambiguity. The IV travels
// with the ciphertext because it is not secret; a fresh IV is generated on every
// encryption, so two encryptions of the same token never produce equal output.

export const TOKEN_ENVELOPE_VERSION = "v1";

// Derive an AES-GCM key from a base64url-encoded secret string.
//
// The secret is required to decode to exactly 32 bytes: AES-256 is the intent,
// and silently accepting a short key would weaken the envelope. Anything else
// throws, and the Worker treats a throw as "not configured" rather than
// continuing with a weak key.
export async function deriveAesKey(secretBase64Url) {
  const raw = base64UrlDecode(secretBase64Url);

  if (raw.length !== 32) {
    throw new Error("OAuth encryption key must decode to 32 bytes");
  }

  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypt a UTF-8 token string into the versioned envelope above.
export async function encryptToken(plaintext, key) {
  if (!key) {
    throw new Error("Missing encryption key");
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(plaintext == null ? "" : plaintext))
  );

  return [
    TOKEN_ENVELOPE_VERSION,
    base64UrlEncode(iv),
    base64UrlEncode(ciphertext)
  ].join(".");
}

// Decrypt an envelope produced by encryptToken(). Throws on a malformed envelope
// or a wrong key (AES-GCM authentication failure) — the caller decides what a
// failure means, but it must never treat it as "empty token = fine".
export async function decryptToken(envelope, key) {
  if (!key) {
    throw new Error("Missing encryption key");
  }

  const parts = String(envelope || "").split(".");

  if (parts.length !== 3 || parts[0] !== TOKEN_ENVELOPE_VERSION) {
    throw new Error("Malformed token envelope");
  }

  const iv = base64UrlDecode(parts[1]);
  const ciphertext = base64UrlDecode(parts[2]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

// -----------------------------------------------------------------------------
// Exact redirect-URI matching
// -----------------------------------------------------------------------------
// The redirect_uri sent to Google must be byte-identical to the one registered
// on the OAuth client, and the callback must only continue for that exact value.
// Comparing the full string (rather than just origin/path) is what stops a
// registered URI from being bent into a different endpoint via a query string or
// a trailing slash.
export function redirectUriMatches(candidate, expected) {
  if (!candidate || !expected) {
    return false;
  }

  return constantTimeEqual(String(candidate), String(expected));
}

// -----------------------------------------------------------------------------
// Firebase ID token (JWT) validation
// -----------------------------------------------------------------------------
// Steps, in order, all mandatory:
//   1. shape      — three base64url segments; header/payload parse as JSON
//   2. alg        — header.alg is exactly RS256 (never trust the token's ask)
//   3. kid        — header.kid selects a key from the JWKS; unknown kid fails
//   4. signature  — RSASSA-PKCS1-v1_5/SHA-256 over "header.payload"
//   5. iss        — https://securetoken.google.com/<projectId>
//   6. aud        — exactly the Firebase project id
//   7. claims     — sub is a non-empty string; exp/iat are numbers
//   8. time       — now within [iat - skew, exp]; expired tokens are refused
//
// Any failure returns { valid: false, reason } and never throws, so a caller can
// treat an invalid token exactly like a missing one.

// Claim validation with an explicit clock skew allowance.
const FIREBASE_CLOCK_SKEW_SECONDS = 60;

function decodeJwtSegment(segment) {
  const bytes = base64UrlDecode(segment);
  const text = new TextDecoder().decode(bytes);

  return JSON.parse(text);
}

// Import every JWK in the set as a verification key, keyed by kid. Import
// failures on an individual key are skipped rather than aborting the set, but a
// set that yields no usable key fails the whole verification.
async function importJwks(jwks) {
  const keys = new Map();
  const list = Array.isArray(jwks?.keys) ? jwks.keys : [];

  for (const jwk of list) {
    if (!jwk?.kid || jwk.kty !== "RSA" || jwk.use === "enc") {
      continue;
    }

    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: FIREBASE_JWT_ALG, ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );

      keys.set(jwk.kid, key);
    } catch {
      // A key we cannot import simply is not a candidate.
    }
  }

  return keys;
}

// Verify a Firebase ID token against an already-fetched JWKS.
//
// `jwks` is passed in (rather than fetched here) so the Worker can cache it and
// so this function stays network-free and deterministic in tests.
export async function verifyFirebaseIdToken(token, options = {}) {
  const projectId = String(options.projectId || "");
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? options.nowSeconds
    : Math.floor(Date.now() / 1000);

  if (!projectId) {
    return { valid: false, reason: "missing_project_id" };
  }

  const parts = String(token || "").split(".");

  if (parts.length !== 3) {
    return { valid: false, reason: "malformed_token" };
  }

  let header;
  let payload;

  try {
    header = decodeJwtSegment(parts[0]);
    payload = decodeJwtSegment(parts[1]);
  } catch {
    return { valid: false, reason: "malformed_token" };
  }

  if (!header || typeof header !== "object") {
    return { valid: false, reason: "malformed_header" };
  }

  if (header.alg !== FIREBASE_JWT_ALG) {
    return { valid: false, reason: "bad_alg" };
  }

  if (!header.kid || typeof header.kid !== "string") {
    return { valid: false, reason: "missing_kid" };
  }

  const keys = await importJwks(options.jwks);

  if (keys.size === 0) {
    return { valid: false, reason: "no_jwks_keys" };
  }

  const key = keys.get(header.kid);

  if (!key) {
    return { valid: false, reason: "unknown_kid" };
  }

  let signatureOk = false;

  try {
    signatureOk = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return { valid: false, reason: "signature_error" };
  }

  if (!signatureOk) {
    return { valid: false, reason: "bad_signature" };
  }

  if (payload?.iss !== `https://securetoken.google.com/${projectId}`) {
    return { valid: false, reason: "bad_issuer" };
  }

  if (payload?.aud !== projectId) {
    return { valid: false, reason: "bad_audience" };
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { valid: false, reason: "missing_subject" };
  }

  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) {
    return { valid: false, reason: "missing_time_claims" };
  }

  if (nowSeconds > payload.exp) {
    return { valid: false, reason: "expired" };
  }

  if (nowSeconds < payload.iat - FIREBASE_CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "issued_in_future" };
  }

  return { valid: true, uid: payload.sub, claims: payload };
}

// -----------------------------------------------------------------------------
// Authorization URL construction
// -----------------------------------------------------------------------------
// Builds the Google consent URL. Every value is url-encoded by URLSearchParams,
// so a state/verifier can never break out into another parameter.
export function buildAuthorizationUrl(params) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);

  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", PKCE_METHOD_S256);
  // Access type offline + forced consent is what yields a refresh token the
  // Worker can use later for the (not-yet-built) write endpoints.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // Only the identity of the granting account matters; no incremental auth here.
  url.searchParams.set("include_granted_scopes", "true");

  return url.toString();
}
