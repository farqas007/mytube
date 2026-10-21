// =============================================================================
// MyTube — profile YouTube connect UI tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// public/youtube-connect.js is a browser-only ES module: it imports Firebase
// from a CDN and touches document/window/history, none of which exist in Node.
// Importing it directly would throw. These tests therefore read the shipped
// files and evaluate the REAL pure helpers in a sandbox — the same approach
// tests/testSubscriptionsPage.js and tests/testAccountMenu.js use.
//
// What is pinned (all additive to the shipped OAuth backend):
//   * public/profile.html exposes the exact element contract the module binds to;
//   * the module calls only the three shipped endpoints, with the exact methods
//     the backend requires and the Firebase ID token in the Authorization header;
//   * the client secret / refresh token / encryption key NEVER appear in browser
//     code (only the public client id could, and it does not);
//   * the three fixed callback statuses are handled and unknown values ignored;
//   * the status query is stripped from the address bar via replaceState;
//   * the disconnect message stays honest about `revoked === false`;
//   * the module adds no YouTube write endpoint and no new dependency.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

const PROFILE_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "profile.html"),
  "utf8"
);
const CONNECT_JS = readFileSync(
  path.join(REPO_ROOT, "public", "youtube-connect.js"),
  "utf8"
);
const STYLE_CSS = readFileSync(
  path.join(REPO_ROOT, "public", "style.css"),
  "utf8"
);

// Pull a top-level `function name(...) { ... }` (or `async function`) body out
// of the shipped source by brace matching, so the test exercises real code.
function extractFunction(source, name) {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);

  assert.notEqual(start, -1, `public/youtube-connect.js must define ${name}()`);

  if (source.slice(start - 6, start) === "async ") {
    start -= 6;
  }

  const open = source.indexOf("{", start);

  assert.notEqual(open, -1, `${name}() must have a body`);

  let depth = 0;

  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`unbalanced braces while extracting ${name}()`);
}

// Evaluate the pure status-mapping helper with its constants mined from source.
function sandboxConsumeStatus() {
  const bodies = [
    extractFunction(CONNECT_JS, "consumeCallbackStatus")
  ].join("\n");

  // Mine the real constants so the sandbox cannot drift from the module.
  const statusParam = /const STATUS_PARAM = "([^"]+)";/.exec(CONNECT_JS);
  const statusesBlock = /const CALLBACK_STATUSES = \{[\s\S]*?\};/.exec(CONNECT_JS);

  assert.ok(statusParam, "STATUS_PARAM must be a simple string constant");
  assert.ok(statusesBlock, "CALLBACK_STATUSES must be a literal object");

  const factory = new Function(
    "window",
    `const STATUS_PARAM = ${JSON.stringify(statusParam[1])};
     ${statusesBlock[0]}
     ${bodies}
     return consumeCallbackStatus;`
  );

  return { factory, param: statusParam[1] };
}

// A minimal window/history/location double good enough for consumeCallbackStatus.
function makeWindow(href) {
  const url = new URL(href);
  return {
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash
    },
    history: {
      lastState: null,
      replaceState(_state, _title, nextUrl) {
        this.lastState = nextUrl;
      }
    }
  };
}

// =============================================================================
// A) HTML element contract
// =============================================================================

test("A1 profile.html exposes the elements the connect module binds to", () => {
  for (const id of [
    "ytConnectStatus",
    "ytConnectBtn",
    "ytDisconnectBtn",
    "ytConnectHelp"
  ]) {
    assert.match(
      PROFILE_HTML,
      new RegExp(`id="${id}"`),
      `profile.html must define #${id}`
    );
  }
});

test("A2 the connect module is loaded by the profile page", () => {
  assert.match(PROFILE_HTML, /src="youtube-connect\.js"/);
});

test("A3 the disconnect button starts hidden", () => {
  const tag = /<button[^>]*id="ytDisconnectBtn"[^>]*>/.exec(PROFILE_HTML);
  assert.ok(tag, "the disconnect button must exist");
  assert.match(tag[0], /display:\s*none/, "it must not show until connected");
});

test("A4 the status region is announced politely (a11y)", () => {
  const tag = /<div[^>]*id="ytConnectStatus"[^>]*>/.exec(PROFILE_HTML);
  assert.ok(tag, "the status region must exist");
  assert.match(tag[0], /role="status"/);
  assert.match(tag[0], /aria-live="polite"/);
});

test("A5 the section reuses existing profile conventions", () => {
  // The new panel is a normal profile section, so existing styling applies.
  assert.match(PROFILE_HTML, /<section class="profile-section">[\s\S]*YouTube Account/);
  assert.match(PROFILE_HTML, /class="profile-empty" id="ytConnectHelp"/);
});

// =============================================================================
// B) Backend contract: endpoints, methods, auth header
// =============================================================================

test("B1 the module calls /api/oauth/start as an authenticated GET", () => {
  assert.match(CONNECT_JS, /fetch\("\/api\/oauth\/start"/);
  const at = CONNECT_JS.indexOf('fetch("/api/oauth/start"');
  assert.match(CONNECT_JS.slice(at, at + 200), /method:\s*"GET"/);
});

test("B2 it calls /api/oauth/status as an authenticated GET", () => {
  assert.match(CONNECT_JS, /fetch\("\/api\/oauth\/status"/);
  const at = CONNECT_JS.indexOf('fetch("/api/oauth/status"');
  assert.match(CONNECT_JS.slice(at, at + 200), /method:\s*"GET"/);
});

test("B3 it calls /api/oauth/disconnect as an authenticated POST", () => {
  assert.match(CONNECT_JS, /fetch\("\/api\/oauth\/disconnect"/);
  const at = CONNECT_JS.indexOf('fetch("/api/oauth/disconnect"');
  assert.match(CONNECT_JS.slice(at, at + 220), /method:\s*"POST"/);
});

test("B4 every backend call sends the Firebase ID token in Authorization", () => {
  // Every fetch in the module must be paired with a Bearer header.
  const fetchCount = (CONNECT_JS.match(/fetch\("/g) || []).length;
  assert.equal(fetchCount, 3, "exactly the three OAuth calls");

  const bearerCount = (CONNECT_JS.match(/Authorization:\s*"Bearer "\s*\+/g) || []).length;
  assert.equal(bearerCount, 3, "one Bearer header per call");
});

test("B5 the token comes from the existing Firebase user, freshly minted", () => {
  assert.match(CONNECT_JS, /user\.getIdToken\(\)/);
  assert.match(CONNECT_JS, /from "\.\/firebase\.js"/);
});

test("B6 it navigates to the returned authorizationUrl, not a guess", () => {
  assert.match(CONNECT_JS, /body\.authorizationUrl/);
  assert.match(CONNECT_JS, /window\.location\.assign\(authorizationUrl\)/);
});

// =============================================================================
// C) No secrets in browser code
// =============================================================================

test("C1 browser code never references the server-only secrets", () => {
  for (const forbidden of [
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    "client_secret",
    "refresh_token",
    "refreshToken"
  ]) {
    assert.ok(
      !CONNECT_JS.includes(forbidden),
      `browser code must not mention ${forbidden}`
    );
  }
});

test("C2 the module adds no new dependency", () => {
  const imports = CONNECT_JS.match(/^import[\s\S]*?from\s+"[^"]+";/gm) || [];
  for (const imp of imports) {
    const from = /from\s+"([^"]+)"/.exec(imp)[1];
    assert.ok(
      from === "./firebase.js" || from.includes("gstatic.com/firebasejs"),
      `unexpected dependency: ${from}`
    );
  }
});

test("C3 no YouTube write endpoint is introduced", () => {
  for (const forbidden of [
    "/api/comment",
    "/api/liveChat",
    "youtube/v3/comments",
    "liveChatMessages"
  ]) {
    assert.ok(
      !CONNECT_JS.includes(forbidden),
      `the UI must not post to ${forbidden} yet`
    );
  }
});

// =============================================================================
// D) Fixed callback statuses + address-bar hygiene
// =============================================================================

test("D1 the three fixed callback statuses are handled", () => {
  assert.match(CONNECT_JS, /connected:\s*\{\s*text:/);
  assert.match(CONNECT_JS, /cancelled:\s*\{\s*text:/);
  assert.match(CONNECT_JS, /error:\s*\{\s*text:/);
});

test("D2 the status param name matches the backend (youtube)", () => {
  assert.match(CONNECT_JS, /const STATUS_PARAM = "youtube";/);
});

test("D3 a known status is returned and stripped from the URL", () => {
  const { factory, param } = sandboxConsumeStatus();
  const win = makeWindow(`https://mytube.farqas007.workers.dev/profile.html?${param}=connected`);
  const result = factory(win)();

  assert.equal(result.text, "YouTube account connected.");
  assert.equal(win.history.lastState, "/profile.html");
});

test("D4 an unknown status value is ignored but still stripped", () => {
  const { factory, param } = sandboxConsumeStatus();
  const win = makeWindow(`https://mytube.farqas007.workers.dev/profile.html?${param}=evil`);
  const result = factory(win)();

  assert.equal(result, null, "an unknown value must not be reflected");
  assert.equal(win.history.lastState, "/profile.html", "but the param is removed");
});

test("D5 no status param leaves the URL untouched", () => {
  const { factory } = sandboxConsumeStatus();
  const win = makeWindow("https://mytube.farqas007.workers.dev/profile.html");
  const result = factory(win)();

  assert.equal(result, null);
  assert.equal(win.history.lastState, null, "replaceState must not run");
});

test("D6 unrelated query params are preserved when stripping", () => {
  const { factory, param } = sandboxConsumeStatus();
  const win = makeWindow(`https://mytube.farqas007.workers.dev/profile.html?tab=1&${param}=error`);
  const result = factory(win)();

  assert.equal(result.text, "Could not connect YouTube. Please try again.");
  assert.equal(win.history.lastState, "/profile.html?tab=1");
});

// =============================================================================
// E) Truthful states
// =============================================================================

test("E1 the disconnect message distinguishes revoked === false", () => {
  assert.match(CONNECT_JS, /revoked === false/);
  const block = CONNECT_JS.slice(CONNECT_JS.indexOf("revoked === false"));
  assert.match(block.slice(0, 400), /Disconnected locally/);
});

test("E2 not-configured (503) hides Connect instead of erroring", () => {
  assert.match(CONNECT_JS, /status === 503/);
  const block = CONNECT_JS.slice(CONNECT_JS.indexOf("status === 503"));
  assert.match(block.slice(0, 300), /not available yet/);
});

test("E3 unauthenticated (401) asks the user to sign in again", () => {
  assert.match(CONNECT_JS, /status === 401/);
  assert.match(CONNECT_JS, /sign in again/i);
});

test("E4 the module never surfaces a raw server error string", () => {
  // Only fixed, safe strings are shown — never a server-provided message/code.
  assert.ok(
    !/setStatus\(\s*(body|error)\s*[.,)]/.test(CONNECT_JS),
    "setStatus must not receive raw bodies or errors"
  );
  assert.ok(!/body\.error\b/.test(CONNECT_JS), "the server error text is unused");
});

// =============================================================================
// F) Styles are additive
// =============================================================================

test("F1 the status/button classes are styled", () => {
  for (const cls of [".yt-connect-status", ".yt-connect-actions", ".yt-disconnect-btn"]) {
    assert.ok(STYLE_CSS.includes(cls), `style.css must style ${cls}`);
  }
});
