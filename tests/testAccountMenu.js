// =============================================================================
// MyTube — account menu + cached notifications tests (dev-only, zero deps)
// -----------------------------------------------------------------------------
// public/shared/accountMenu.js is a browser-only ES module: it imports Firebase
// from a CDN and touches document/window/localStorage, none of which exist in
// Node. Importing it directly would throw at the top-level lifecycle hook.
//
// These tests therefore evaluate the REAL shipped pure helpers in a sandbox, the
// same approach tests/testHoverPreview.js and tests/testSubscriptionsPage.js use.
// Everything here reads shipped files. Nothing is written.
//
// What is pinned:
//   * initials/display-name derivation (never an email address as a name);
//   * notifications are derived ONLY from the existing cache (no fetch);
//   * unread counting against a per-uid seen marker, and the first-visit rule;
//   * a cold cache is reported as "unavailable", never as "no new videos";
//   * the seen marker is uid-scoped and stores nothing sensitive;
//   * the module declares no API/network calls of its own;
//   * the header integration is present on all six pages and additive;
//   * no Create/Upload surface is introduced.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

const MENU_JS = readFileSync(
  path.join(REPO_ROOT, "public", "shared", "accountMenu.js"),
  "utf8"
);
const SUBS_JS = readFileSync(
  path.join(REPO_ROOT, "public", "subscriptions.js"),
  "utf8"
);
const STYLE_CSS = readFileSync(
  path.join(REPO_ROOT, "public", "style.css"),
  "utf8"
);
const MENU_CSS = readFileSync(
  path.join(REPO_ROOT, "public", "shared", "accountMenu.css"),
  "utf8"
);

const PAGES = [
  "public/index.html",
  "public/watch.html",
  "public/subscriptions.html",
  "public/channel.html",
  "public/library.html",
  "public/profile.html"
];

const PAGE_SOURCES = Object.fromEntries(
  PAGES.map(p => [p, readFileSync(path.join(REPO_ROOT, p), "utf8")])
);

// -----------------------------------------------------------------------------
// Source sandbox
// -----------------------------------------------------------------------------

// Pull a top-level `function name(...) { ... }` (keeping a leading `async `) by
// brace matching, so the tests exercise the shipped implementation.
function extractFunction(source, name) {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);

  assert.notEqual(start, -1, `accountMenu.js must define ${name}()`);

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

// Evaluate a set of functions together with injected free variables.
function sandbox(names, scope) {
  const bodies = names.map(n => extractFunction(MENU_JS, n)).join("\n");
  const keys = Object.keys(scope || {});
  const factory = new Function(
    ...keys,
    `${bodies}\nreturn { ${names.join(", ")} };`
  );
  return factory(...keys.map(k => scope[k]));
}

const pure = sandbox(
  [
    "initialsFrom",
    "displayNameFrom",
    "publishedAtMs",
    "parseAgoDate",
    "readVideosCache",
    "readSeenStore",
    "computeNotifications",
    "notificationsSeenFor",
    "advanceNotificationsSeen",
    "validateAvatarFile",
    "fitAvatarDimensions",
    "isAvatarWithinBudget",
    "isSafeAvatarDataUrl"
  ],
  {
    SUBS_CACHE_KEY: "mytube_subs_videos_cache_v1",
    NOTIF_SEEN_KEY: "mytube_notifications_seen_v1",
    NOTIF_MAX: 20,
    NOTIF_CHANNEL_CAP: 12,
    AVATAR_MAX_DIM: 256,
    AVATAR_MAX_FILE_BYTES: 10 * 1024 * 1024,
    AVATAR_MAX_STORED_BYTES: 340 * 1024,
    AVATAR_MIME_ALLOW: Object.freeze([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/bmp"
    ]),
    AVATAR_MSG: Object.freeze({
      unsupported: "That file type isn\u2019t supported. Choose a JPEG, PNG or WebP image.",
      corrupt: "That image couldn\u2019t be read. It may be corrupt \u2014 try another file.",
      tooLarge: "That image is too large. Please choose one under 10 MB.",
      empty: "That file is empty. Please choose a different image.",
      noUid: "Sign in to set a profile picture.",
      encode: "That image couldn\u2019t be processed. Please try a different one.",
      store: "Couldn\u2019t save your picture on this device. It will work this time only."
    })
  }
);

// The IndexedDB layer takes its factory/app-key explicitly, so it can be driven
// here with a small in-memory fake that mimics the real request/transaction
// lifecycle (onsuccess, oncomplete, onerror, onabort).
const avatarDb = sandbox(
  [
    "openAvatarDb",
    "avatarTx",
    "readAvatar",
    "writeAvatar",
    "isAvatarWithinBudget",
    "isSafeAvatarDataUrl"
  ],
  {
    AVATAR_DB_NAME: "mytube_avatars_v1",
    AVATAR_DB_VERSION: 1,
    AVATAR_STORE: "avatars",
    AVATAR_MAX_STORED_BYTES: 340 * 1024
  }
);

// A minimal IndexedDB stand-in: one object store keyed by "uid", with real
// transaction completion semantics and a configurable failure mode.
function makeFakeIdb(options) {
  const opts = options || {};
  const records = new Map(opts.initial || []);
  const api = {
    records,
    openCalls: 0,
    failOpen: !!opts.failOpen,
    failPut: !!opts.failPut,
    open() {
      this.openCalls++;
      const request = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const db = opts.failOpen ? null : makeFakeDb(records, api);
      setTimeout(() => {
        if (opts.failOpen) {
          if (request.onblocked) request.onblocked();
          else if (request.onerror) request.onerror();
          return;
        }
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    }
  };
  return api;
}

function makeFakeDb(records, api) {
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx = { oncomplete: null, onabort: null, onerror: null };
      const fail = !!api.failPut;
      const store = {
        get(uid) {
          const request = { result: undefined, onsuccess: null, onerror: null };
          setTimeout(() => {
            request.result = records.get(uid);
            if (request.onsuccess) request.onsuccess();
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
          return request;
        },
        put(record) {
          const request = { result: undefined, onsuccess: null, onerror: null };
          setTimeout(() => {
            if (fail) {
              if (tx.onerror) tx.onerror();
              if (tx.onabort) tx.onabort();
              return;
            }
            records.set(record.uid, record);
            request.result = record.uid;
            if (request.onsuccess) request.onsuccess();
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
          return request;
        },
        delete(uid) {
          const request = { result: undefined, onsuccess: null, onerror: null };
          setTimeout(() => {
            records.delete(uid);
            if (request.onsuccess) request.onsuccess();
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
          return request;
        }
      };
      return Object.assign(tx, { objectStore: () => store });
    }
  };
}

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// A tiny localStorage stand-in that also records whether it was written.
function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    writes: [],
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      this.writes.push(k);
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    }
  };
}

// =============================================================================
// A) Identity helpers
// =============================================================================

test("A1 initials come from a display name, never from an email", () => {
  assert.equal(pure.initialsFrom("Ada Lovelace", ""), "AL");
  assert.equal(pure.initialsFrom("", "ada@example.com"), "A");
  assert.equal(pure.initialsFrom("", ""), "?");
  assert.equal(pure.initialsFrom(null, undefined), "?");
});

test("A2 displayNameFrom never invents an email and never returns undefined", () => {
  assert.equal(pure.displayNameFrom({ displayName: "Ada", email: "ada@e.com" }), "Ada");
  assert.equal(pure.displayNameFrom({ email: "ada@e.com" }), "ada");
  assert.equal(pure.displayNameFrom({}), "User");
  assert.equal(pure.displayNameFrom(null), "");
});

// =============================================================================
// B) Date helpers stay in sync with subscriptions.js
// =============================================================================

test("B1 publishedAtMs prefers the raw instant", () => {
  const iso = "2026-01-02T03:04:05.000Z";
  assert.equal(pure.publishedAtMs({ publishedAt: iso, date: "5y ago" }), Date.parse(iso));
});

test("B2 publishedAtMs falls back to the human label", () => {
  const before = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const ms = pure.publishedAtMs({ date: "2d ago" });
  assert.ok(Math.abs(ms - before) < 5000, "a 2d-ago label resolves to ~2 days back");
});

test("B3 unknown ages are Infinity so they sort last", () => {
  assert.equal(pure.publishedAtMs({ date: "" }), Infinity);
  assert.equal(pure.publishedAtMs({}), Infinity);
});

test("B4 the parser matches the same shape subscriptions.js accepts", () => {
  // If the two copies of the parser ever drift, this catches the divergence.
  const subsParse = extractFunction(SUBS_JS, "parseAgoDate");
  assert.ok(
    subsParse.includes("(\\d+)\\s*(s|m|h|d|mo|y)\\s*ago"),
    "subscriptions.js still parses the same relative labels"
  );
  assert.equal(pure.parseAgoDate("3h ago") < Date.now(), true);
});

// =============================================================================
// C) Notification derivation — cache only, no fetch
// =============================================================================

function subsOf(...ids) {
  return ids.map((id, i) => ({ channelId: id, channelName: "Channel " + (i + 1) }));
}

test("C1 videos are read from the existing per-channel cache", () => {
  const cache = {
    c1: { at: Date.now(), videos: [
      { id: "yt:a", title: "A", channel: "Chan 1", date: "1h ago", publishedAt: new Date(Date.now() - 3600e3).toISOString() },
      { id: "yt:b", title: "B", channel: "Chan 1", date: "2d ago" }
    ] }
  };
  const r = pure.computeNotifications(subsOf("c1"), cache, 0);
  assert.equal(r.unavailable, false);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].key, "yt:a");
});

test("C2 first visit (seen=0) marks nothing as unread", () => {
  const cache = { c1: { at: Date.now(), videos: [{ id: "yt:a", date: "1h ago" }] } };
  const r = pure.computeNotifications(subsOf("c1"), cache, 0);
  assert.equal(r.unread, 0);
  assert.equal(r.items[0].unread, false);
});

test("C3 only videos published after the seen marker are unread", () => {
  const now = Date.now();
  const cache = { c1: { at: now, videos: [
    { id: "yt:new", publishedAt: new Date(now - 60e3).toISOString(), date: "1m ago" },
    { id: "yt:old", publishedAt: new Date(now - 3 * 24 * 3600e3).toISOString(), date: "3d ago" }
  ] } };
  const seen = now - 3600e3; // one hour ago
  const r = pure.computeNotifications(subsOf("c1"), cache, seen);
  assert.equal(r.unread, 1, "only the video newer than the marker counts");
  const byKey = Object.fromEntries(r.items.map(i => [i.key, i.unread]));
  assert.equal(byKey["yt:new"], true);
  assert.equal(byKey["yt:old"], false);
});

test("C4 a cold cache is 'unavailable', never 'no new videos'", () => {
  const r = pure.computeNotifications(subsOf("c1", "c2"), {}, 0);
  assert.equal(r.unavailable, true);
  assert.equal(r.items.length, 0);
});

test("C5 channels with cached-but-empty lists are a real empty answer", () => {
  const cache = { c1: { at: Date.now(), videos: [] } };
  const r = pure.computeNotifications(subsOf("c1"), cache, 0);
  assert.equal(r.unavailable, false, "a cached empty list is not 'unavailable'");
  assert.equal(r.items.length, 0);
});

test("C6 no subscriptions means nothing to show and nothing to fetch", () => {
  const r = pure.computeNotifications([], { c1: { at: 1, videos: [{ id: "yt:x" }] } }, 0);
  assert.equal(r.items.length, 0);
  assert.equal(r.unavailable, false);
});

test("C7 items are newest-first with unknown ages last", () => {
  const now = Date.now();
  const cache = { c1: { at: now, videos: [
    { id: "yt:old", publishedAt: new Date(now - 10 * 24 * 3600e3).toISOString() },
    { id: "yt:undated" },
    { id: "yt:new", publishedAt: new Date(now - 60e3).toISOString() }
  ] } };
  const r = pure.computeNotifications(subsOf("c1"), cache, 0);
  assert.deepEqual(r.items.map(i => i.key), ["yt:new", "yt:old", "yt:undated"]);
});

test("C8 duplicates across channels collapse by source identity", () => {
  const cache = {
    c1: { at: Date.now(), videos: [{ id: "yt:same" }] },
    c2: { at: Date.now(), videos: [{ id: "yt:same" }] }
  };
  const r = pure.computeNotifications(subsOf("c1", "c2"), cache, 0);
  assert.equal(r.items.length, 1);
});

test("C9 the channel cap matches the feed's cap", () => {
  assert.match(SUBS_JS, /FEED_CHANNEL_CAP\s*=\s*12/);
  assert.match(MENU_JS, /NOTIF_CHANNEL_CAP\s*=\s*12/);
});

// =============================================================================
// D) Seen marker — per uid, non-sensitive
// =============================================================================

test("D1 the seen marker is scoped to the authenticated uid", () => {
  const store = makeStore();
  pure.advanceNotificationsSeen(store, "uid-1", 111);
  pure.advanceNotificationsSeen(store, "uid-2", 222);
  assert.equal(pure.notificationsSeenFor(store, "uid-1"), 111);
  assert.equal(pure.notificationsSeenFor(store, "uid-2"), 222);
  assert.equal(pure.notificationsSeenFor(store, "uid-3"), 0);
});

test("D2 no uid means no marker and no write", () => {
  const store = makeStore();
  assert.equal(pure.notificationsSeenFor(store, ""), 0);
  assert.equal(pure.advanceNotificationsSeen(store, "", 5), false);
  assert.equal(store.writes.length, 0);
});

test("D3 the marker stores only a namespaced timestamp", () => {
  const store = makeStore();
  pure.advanceNotificationsSeen(store, "uid-1", 999);
  const raw = store.getItem("mytube_notifications_seen_v1");
  assert.equal(store.writes[0], "mytube_notifications_seen_v1");
  assert.deepEqual(JSON.parse(raw), { "uid-1": 999 });
});

test("D4 an unreadable store degrades to a first visit", () => {
  const store = makeStore({ mytube_notifications_seen_v1: "{not json" });
  assert.equal(pure.notificationsSeenFor(store, "uid-1"), 0);
});

test("D5 nothing sensitive is ever written to localStorage", () => {
  // Scan only executable text; the module's comments name these words on purpose.
  const code = MENU_JS.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/setItem\([^)]*(password|token|credential|idToken|refreshToken)/i.test(code),
    "no password/token/credential may be persisted"
  );
  assert.ok(
    !/localStorage/i.test(code) || !/password|idToken|refreshToken/i.test(code),
    "localStorage use is limited to the non-sensitive seen marker"
  );
});

// =============================================================================
// E) No new network surface, no upload surface
// =============================================================================

test("E1 the module makes no YouTube API / backend request of its own", () => {
  const code = MENU_JS.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\bfetch\s*\(/.test(code), "no fetch() call");
  assert.ok(!/youtube\.js|channelVideos|search\.list|googleapis\.com/.test(code),
    "no YouTube API client or endpoint");
  assert.ok(!new RegExp("https?://(?!www\\.gstatic\\.com|www\\.youtube\\.com)").test(code),
    "no unexpected remote origin");
});

test("E2 notifications read the SAME cache key subscriptions.js writes", () => {
  assert.match(MENU_JS, /SUBS_CACHE_KEY\s*=\s*"mytube_subs_videos_cache_v1"/);
  assert.match(SUBS_JS, /SUBS_CACHE_KEY\s*=\s*"mytube_subs_videos_cache_v1"/);
  // It reads, but must never overwrite the subscriptions page's cache.
  assert.ok(!/setItem\(\s*SUBS_CACHE_KEY/.test(MENU_JS),
    "the account menu must not write the shared video cache");
});

test("E3 no Create/Upload surface exists anywhere in the module", () => {
  const code = MENU_JS.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\b(upload|create\s+video|Create\b.*\bVideo)\b/i.test(code),
    "no upload/create-video affordance");
});

test("E4 the module reuses the existing logout entry point", () => {
  assert.match(MENU_JS, /window\.logoutUser/,
    "log out must call the existing window.logoutUser");
});

// =============================================================================
// F) Header integration across all six pages (additive)
// =============================================================================

test("F1 every header page loads the shared account menu module and styles", () => {
  for (const p of PAGES) {
    assert.match(
      PAGE_SOURCES[p],
      /<script type="module" src="shared\/accountMenu\.js"><\/script>/,
      `${p} must load shared/accountMenu.js`
    );
    assert.match(
      PAGE_SOURCES[p],
      /<link rel="stylesheet" href="shared\/accountMenu\.css">/,
      `${p} must load shared/accountMenu.css`
    );
  }
});

test("F1b the Watch page gets the styles despite not loading style.css", () => {
  // watch.html loads player.css only; the account menu styles therefore MUST
  // ship in their own stylesheet that every page links.
  assert.ok(
    !/href="style\.css"/.test(PAGE_SOURCES["public/watch.html"]),
    "watch.html is expected not to load style.css"
  );
  assert.match(PAGE_SOURCES["public/watch.html"], /href="shared\/accountMenu\.css"/);
  // And the block must have moved OUT of style.css so there is one source.
  assert.ok(
    !STYLE_CSS.includes("ACCOUNT MENU + NOTIFICATIONS"),
    "style.css must no longer carry the account menu block"
  );
});

test("F2 the existing login/logout buttons are preserved on every page", () => {
  for (const p of PAGES) {
    assert.match(PAGE_SOURCES[p], /id="loginBtn"/, `${p} keeps #loginBtn`);
    assert.match(PAGE_SOURCES[p], /id="logoutBtn"/, `${p} keeps #logoutBtn`);
  }
});

test("F3 the header markup is not rewritten (no new inline header buttons)", () => {
  // The injected cluster is built by JS, so no page HTML may contain the new
  // classes — that guarantees the change is purely additive.
  for (const p of PAGES) {
    assert.ok(
      !PAGE_SOURCES[p].includes("mytube-account-area"),
      `${p} must not contain injected markup in its HTML`
    );
  }
});

test("F4 the module injects its cluster into the existing <header>", () => {
  assert.match(MENU_JS, /document\.querySelector\("header"\)/);
  assert.match(MENU_JS, /header\.appendChild\(root\)/);
});

test("F5 the menus are keyboard/escape/outside-click closable", () => {
  assert.match(MENU_JS, /e\.key === "Escape"/, "Escape closes the menus");
  assert.match(MENU_JS, /document\.addEventListener\("click"/, "outside clicks close the menus");
  assert.match(MENU_JS, /aria-expanded/, "aria-expanded reflects open state");
  assert.match(MENU_JS, /aria-haspopup/, "the triggers advertise a popup");
});

test("F6 account menu links point at real MyTube pages", () => {
  assert.match(MENU_JS, /"profile\.html"/);
  assert.match(MENU_JS, /"subscriptions\.html"/);
  assert.match(MENU_JS, /"library\.html"/);
  assert.match(MENU_JS, /"login\.html"/);
  assert.match(MENU_JS, /"signup\.html"/);
  // Switch account hands off to the login flow rather than storing a session.
  assert.match(MENU_JS, /Switch account/);
});

// =============================================================================
// G) Scoped styles
// =============================================================================

test("G1 the new styles are namespaced and do not target bare elements", () => {
  const start = MENU_CSS.indexOf("ACCOUNT MENU + NOTIFICATIONS");
  assert.notEqual(start, -1, "accountMenu.css must contain the account menu block");
  const block = MENU_CSS.slice(start);
  // The block may only style `mytube-` classes (plus its own media queries).
  const selectors = block
    .split("}")
    .map(chunk => chunk.split("{")[0].trim())
    .filter(s => s && !s.startsWith("@") && !s.startsWith("/*"));
  for (const sel of selectors) {
    assert.match(sel, /\.mytube-/, `selector "${sel}" must be mytube-namespaced`);
  }
});

test("G2 the hidden attribute actually hides the panels", () => {
  assert.match(MENU_CSS, /\.mytube-panel\[hidden\]\{[^}]*display:none/);
});

test("G3 reduced-motion is respected for the menu chrome", () => {
  assert.match(MENU_CSS, /prefers-reduced-motion: reduce/);
});

test("G4 the narrow-screen panel is anchored inside the viewport", () => {
  // A fixed negative right offset could overflow once the header wraps; the
  // panel must be clamped to the viewport width and anchored at right:0.
  assert.match(MENU_CSS, /@media \(max-width:520px\)/);
  // Strip CSS comments so prose that names the old value is not counted as code.
  const css = MENU_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const narrow = css.slice(css.indexOf("@media (max-width:520px)"));
  assert.match(narrow, /calc\(100vw - 20px\)/, "the width is viewport-clamped");
  assert.ok(!/right:\s*-/.test(narrow), "no negative right offset may remain");
});

// =============================================================================
// H) Sign-out / switch-account hand-off
// =============================================================================

test("H1 both Log out and Switch account go through one safe leave helper", () => {
  assert.match(MENU_JS, /function leaveToLogin\(/, "a single leave helper exists");
  const switchIdx = MENU_JS.indexOf("Switch account");
  const logoutIdx = MENU_JS.indexOf('"Log out"');
  assert.ok(switchIdx !== -1 && logoutIdx !== -1);
  // Both menu items call leaveToLogin rather than duplicating sign-out logic.
  const tail = MENU_JS.slice(switchIdx);
  assert.match(tail, /leaveToLogin\(\)/);
});

test("H2 the helper reuses window.logoutUser and always reaches login", () => {
  assert.match(MENU_JS, /window\.logoutUser/, "reuses the existing entry point");
  // The helper must navigate even when logoutUser resolves without navigating.
  assert.match(MENU_JS, /window\.location\.href\s*=\s*target/, "navigates to the login flow");
  assert.match(MENU_JS, /const target = "login\.html"/, "targets the existing login page");
});

test("H3 the helper falls back to a direct sign-out if logoutUser is absent or fails", () => {
  // Extract the real helper body and prove it navigates synchronously when no
  // logoutUser exists and when logoutUser rejects.
  const navigateCalls = [];
  const fakeWindow = {
    location: { set href(v) { navigateCalls.push(v); }, get href() { return ""; } }
  };
  const fakeAuth = {};
  const body = extractFunction(MENU_JS, "leaveToLogin");
  const factory = new Function("window", "auth", "signOut", `${body}\nreturn leaveToLogin();`);

  // (a) no window.logoutUser -> immediate navigation
  factory(fakeWindow, fakeAuth, () => {});
  assert.deepEqual(navigateCalls, ["login.html"]);

  // (b) logoutUser rejects -> navigation still happens via the catch
  navigateCalls.length = 0;
  fakeWindow.logoutUser = () => Promise.reject(new Error("network"));
  factory(fakeWindow, fakeAuth, () => {});
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
    assert.deepEqual(navigateCalls, ["login.html"], "a failed sign-out still reaches login");
  });
});

test("H4 focus returns to the trigger when a panel closes via Escape", () => {
  assert.match(MENU_JS, /function closePanels\(restoreFocus\)/,
    "closePanels accepts an opt-in focus restore");
  assert.match(MENU_JS, /closePanels\(true\)/, "Escape restores focus");
  assert.match(MENU_JS, /if\(restoreFocus && target[\s\S]*?target\.focus\(\)/,
    "focus is restored to the recorded trigger only when asked");
});

// =============================================================================
// I) Avatar file validation (pure)
// =============================================================================

test("I1 a small JPEG/PNG/WebP is accepted", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    const r = pure.validateAvatarFile({ type, size: 1024 });
    assert.equal(r.ok, true, `${type} must be accepted`);
  }
});

test("I2 unsupported types are rejected with a friendly message", () => {
  const r = pure.validateAvatarFile({ type: "application/pdf", size: 1024 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unsupported");
  assert.match(r.message, /JPEG, PNG or WebP/);
});

test("I3 a script-like file is never accepted as an image", () => {
  for (const type of ["text/html", "text/javascript", "application/javascript", ""]) {
    assert.equal(pure.validateAvatarFile({ type, size: 100 }).ok, false, `${type} must be rejected`);
  }
});

test("I4 an excessively large file is rejected before decoding", () => {
  const r = pure.validateAvatarFile({ type: "image/png", size: 11 * 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "tooLarge");
});

test("I5 an empty or malformed file is rejected", () => {
  assert.equal(pure.validateAvatarFile({ type: "image/png", size: 0 }).reason, "empty");
  assert.equal(pure.validateAvatarFile(null).ok, false);
  assert.equal(pure.validateAvatarFile({ type: "image/png" }).reason, "empty");
});

test("I6 validation never throws on hostile input", () => {
  for (const bad of [undefined, 0, "x", [], { type: "image/png", size: "NaN" }]) {
    assert.doesNotThrow(() => pure.validateAvatarFile(bad));
  }
});

test("I7 the file size ceiling matches the shipped module", () => {
  assert.match(MENU_JS, /AVATAR_MAX_FILE_BYTES\s*=\s*10 \* 1024 \* 1024/);
});

// =============================================================================
// J) Avatar sizing + safe data-URL handling (pure)
// =============================================================================

test("J1 oversized images are downscaled to at most 256 on the long edge", () => {
  const box = pure.fitAvatarDimensions(1024, 512, 256);
  assert.equal(box.width, 256);
  assert.equal(box.height, 128);
});

test("J2 the aspect ratio is preserved for tall images too", () => {
  const box = pure.fitAvatarDimensions(400, 800, 256);
  assert.equal(box.height, 256);
  assert.equal(box.width, 128);
});

test("J3 small images are never upscaled", () => {
  assert.deepEqual(pure.fitAvatarDimensions(64, 64, 256), { width: 64, height: 64 });
});

test("J4 degenerate dimensions are refused rather than producing 0px", () => {
  assert.equal(pure.fitAvatarDimensions(0, 10, 256), null);
  assert.equal(pure.fitAvatarDimensions("x", 10, 256), null);
  assert.equal(pure.fitAvatarDimensions(10, -1, 256), null);
});

test("J5 the 256px cap is the shipped constant", () => {
  assert.match(MENU_JS, /AVATAR_MAX_DIM\s*=\s*256/);
});

test("J6 only base64 image data URLs are considered safe to render", () => {
  assert.equal(pure.isSafeAvatarDataUrl(PNG_1PX), true);
  assert.equal(pure.isSafeAvatarDataUrl("data:image/webp;base64,AAAA"), true);
  assert.equal(pure.isSafeAvatarDataUrl("javascript:alert(1)"), false);
  assert.equal(pure.isSafeAvatarDataUrl("http://evil.example/x.png"), false);
  assert.equal(pure.isSafeAvatarDataUrl("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(pure.isSafeAvatarDataUrl(""), false);
  assert.equal(pure.isSafeAvatarDataUrl(null), false);
});

test("J7 an over-budget encoded avatar is refused", () => {
  assert.equal(pure.isAvatarWithinBudget(PNG_1PX), true);
  assert.equal(pure.isAvatarWithinBudget("data:image/png;base64," + "A".repeat(400 * 1024)), false);
});

// =============================================================================
// K) Avatar storage — per-uid isolation, removal, failures (IndexedDB fake)
// =============================================================================

test("K1 a stored picture round-trips for its own uid", async () => {
  const idb = makeFakeIdb();
  assert.equal(await avatarDb.writeAvatar(idb, "uid-1", PNG_1PX), true);
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), PNG_1PX);
});

test("K2 a uid with no picture reads back as empty (initials fallback)", async () => {
  const idb = makeFakeIdb();
  assert.equal(await avatarDb.readAvatar(idb, "uid-missing"), "");
});

test("K3 two accounts never see each other's picture", async () => {
  const idb = makeFakeIdb();
  const other =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await avatarDb.writeAvatar(idb, "uid-1", PNG_1PX);
  await avatarDb.writeAvatar(idb, "uid-2", other);
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), PNG_1PX);
  assert.equal(await avatarDb.readAvatar(idb, "uid-2"), other);
  assert.equal(await avatarDb.readAvatar(idb, "uid-3"), "");
});

test("K4 removal returns the uid to the initials state and spares others", async () => {
  const idb = makeFakeIdb();
  await avatarDb.writeAvatar(idb, "uid-1", PNG_1PX);
  await avatarDb.writeAvatar(idb, "uid-2", PNG_1PX);
  assert.equal(await avatarDb.writeAvatar(idb, "uid-1", ""), true);
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), "");
  assert.equal(await avatarDb.readAvatar(idb, "uid-2"), PNG_1PX, "removal is uid-scoped");
});

test("K5 no uid means no read, no write, no throw", async () => {
  const idb = makeFakeIdb();
  assert.equal(await avatarDb.readAvatar(idb, ""), "");
  assert.equal(await avatarDb.writeAvatar(idb, "", PNG_1PX), false);
  assert.equal(idb.openCalls, 0, "an unauthenticated action never opens the db");
});

test("K6 a refused data URL is never persisted", async () => {
  const idb = makeFakeIdb();
  assert.equal(await avatarDb.writeAvatar(idb, "uid-1", "javascript:alert(1)"), false);
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), "");
});

test("K7 a missing/blocked IndexedDB degrades gracefully", async () => {
  assert.equal(await avatarDb.readAvatar(null, "uid-1"), "");
  assert.equal(await avatarDb.writeAvatar(null, "uid-1", PNG_1PX), false);
  const blocked = makeFakeIdb({ failOpen: true });
  assert.equal(await avatarDb.readAvatar(blocked, "uid-1"), "");
  assert.equal(await avatarDb.writeAvatar(blocked, "uid-1", PNG_1PX), false);
});

test("K8 a failing write reports false and leaves nothing behind", async () => {
  const idb = makeFakeIdb({ failPut: true });
  assert.equal(await avatarDb.writeAvatar(idb, "uid-1", PNG_1PX), false);
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), "");
});

test("K9 a corrupt stored record is ignored, not rendered", async () => {
  const idb = makeFakeIdb({
    initial: [["uid-1", { uid: "uid-1", dataUrl: "not-a-data-url" }]]
  });
  assert.equal(await avatarDb.readAvatar(idb, "uid-1"), "");
});

test("K10 neither helper ever rejects", async () => {
  const idb = makeFakeIdb({ failOpen: true });
  await assert.doesNotReject(() => avatarDb.readAvatar(idb, "uid-1"));
  await assert.doesNotReject(() => avatarDb.writeAvatar(idb, "uid-1", "bad"));
  await assert.doesNotReject(() => avatarDb.openAvatarDb(undefined));
});

// =============================================================================
// L) Avatar feature integration + no-regression guards
// =============================================================================

test("L1 the picker is a native image file input", () => {
  assert.match(MENU_JS, /type\s*=\s*"file"/);
  assert.match(MENU_JS, /accept\s*=\s*"image\/\*"/);
});

test("L2 the menu offers Change/Add and Remove picture entries", () => {
  assert.match(MENU_JS, /Add profile picture/);
  assert.match(MENU_JS, /Change profile picture/);
  assert.match(MENU_JS, /Remove profile picture/);
});

test("L3 images are stored in IndexedDB, never in localStorage", () => {
  const code = MENU_JS.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(code, /indexedDB/);
  // No data URL / image bytes may be handed to localStorage.setItem.
  assert.ok(
    !/setItem\([^)]*(dataUrl|data:image|avatar)/i.test(code),
    "localStorage must never receive image data"
  );
  assert.ok(
    !/localStorage[^;]*(dataUrl|data:image)/i.test(code),
    "no image data may reach localStorage"
  );
});

test("L4 the avatar is loaded per authenticated uid", () => {
  assert.match(MENU_JS, /readAvatar\(avatarIdbFactory\(\), uid\)/);
  assert.match(MENU_JS, /writeAvatar\(avatarIdbFactory\(\), uid,/);
});

test("L5 account change clears the previous picture before repainting", () => {
  // applyUser must reset the avatar synchronously on (re)authentication so a
  // previous account's picture can never linger.
  const body = extractFunction(MENU_JS, "applyUser");
  assert.match(body, /renderAvatar\("",/, "the avatar is reset on every account change");
  assert.match(body, /applyAvatar\(user\)/, "the stored picture is then loaded");
});

test("L6 the avatar element only ever receives a validated data URL", () => {
  const body = extractFunction(MENU_JS, "renderAvatar");
  assert.match(body, /isSafeAvatarDataUrl\(url\)/);
  // Removing the src (not setting a wrong one) is the fallback path.
  assert.match(body, /removeAttribute\("src"\)/);
});

test("L7 selected files are decoded, never executed", () => {
  const code = MENU_JS.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/\beval\s*\(/.test(code), "no eval()");
  assert.ok(!/new Function\s*\(/.test(code), "no dynamic Function construction");
  assert.ok(!/\.textContent\s*=\s*(file|dataUrl)/.test(code), "file data is not injected as text");
});

test("L8 the new avatar styles are namespaced", () => {
  for (const sel of [".mytube-avatar-img", ".mytube-visually-hidden", ".mytube-avatar-feedback"]) {
    assert.ok(MENU_CSS.includes(sel), `${sel} must exist`);
  }
  assert.match(MENU_CSS, /\.mytube-avatar-btn\.mytube-has-avatar/);
});

test("L9 the feature is additive: no header markup or auth hooks touched", () => {
  // The existing escape/outside-click/logout behaviour is unchanged from H/F.
  assert.match(MENU_JS, /window\.logoutUser/);
  assert.match(MENU_JS, /e\.key === "Escape"/);
  for (const p of PAGES) {
    assert.ok(
      !PAGE_SOURCES[p].includes("mytube-avatar"),
      `${p} must not contain injected avatar markup`
    );
  }
});
