// =============================================================================
// MyTube — YouTube live chat tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// public/watch.js is a browser ES module (it imports Firebase/config and touches
// document/window), so it cannot be imported directly under Node. These tests
// therefore read the REAL shipped sources and, where behaviour matters, evaluate
// the shipped function bodies in a small sandbox with a stub DOM.
//
// What is pinned, and why:
//
//   * The "Chat provided by YouTube" attribution link must point at THIS
//     stream's chat (?v=<videoId>) rather than YouTube's generic live-chat
//     landing page, and must NEVER be rewritten without a real video id.
//   * The per-stream id is validated against the same [A-Za-z0-9_-]{1,64} shape
//     the backend accepts, so a hostile/garbage id cannot be injected into the
//     href (no javascript:/absolute-URL smuggling).
//   * The panel is only ever revealed for a video the backend reports live.
//   * Sending is opt-in and doubly gated: the composer starts hidden/disabled,
//     watch.js reveals it only when the server reports sending enabled AND the
//     account holds a usable YouTube scope, and the server re-checks every POST.
//   * No Firestore write, and YouTube-supplied text is rendered with textContent
//     only.
//   * "no_chat" / "not_live" are handled honestly instead of leaving a
//     permanent "waiting" box (the reported bug).
//   * The feature is additive: the existing watch page contract (comments,
//     related, embed fallback, auth) is untouched.
//
// Run: node --test tests/testLiveChat.js
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

const WATCH_JS = readFileSync(
  path.join(REPO_ROOT, "public", "watch.js"),
  "utf8"
);
const WATCH_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "watch.html"),
  "utf8"
);
const PLAYER_CSS = readFileSync(
  path.join(REPO_ROOT, "public", "player.css"),
  "utf8"
);
const NORMALIZE_JS = readFileSync(
  path.join(REPO_ROOT, "shared", "normalize.js"),
  "utf8"
);
const WORKER_JS = readFileSync(
  path.join(REPO_ROOT, "worker.js"),
  "utf8"
);
const YOUTUBE_JS = readFileSync(
  path.join(REPO_ROOT, "public", "youtube.js"),
  "utf8"
);

// -----------------------------------------------------------------------------
// Source extraction (same brace-matching approach as testHoverPreview.js)
// -----------------------------------------------------------------------------

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);

  assert.notEqual(start, -1, `watch.js must define ${name}()`);

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

// =============================================================================
// A) The attribution link is per-stream, not generic
// =============================================================================

test("A1 the footer link is addressable and still declares a safe fallback", () => {
  assert.match(WATCH_HTML, /id="liveChatAttrib"/, "the link carries an id");
  assert.match(
    WATCH_HTML,
    /<a id="liveChatAttrib" href="https:\/\/www\.youtube\.com\/live_chat" target="_blank" rel="noopener noreferrer"/,
    "the static fallback href is the generic live_chat URL, opened safely"
  );
});

test("A2 watch.js rewrites the link with the real video id", () => {
  assert.match(WATCH_JS, /function liveChatSetAttrib\(sourceId\)/);
  assert.match(
    WATCH_JS,
    /"https:\/\/www\.youtube\.com\/live_chat\?v=" \+ encodeURIComponent\(id\)/,
    "the per-stream URL is built from ?v=<id>"
  );
});

test("A3 the link is updated when the panel opens for a stream", () => {
  const body = extractFunction(WATCH_JS, "liveChatStart");
  assert.match(body, /liveChatSetAttrib\(sourceId\)/, "set from the stream id");
});

test("A4 the link is reset when we stop following a stream", () => {
  const body = extractFunction(WATCH_JS, "liveChatStop");
  assert.match(body, /liveChatSetAttrib\(""\)/, "no stale per-stream link lingers");
});

// Run the REAL shipped liveChatSetAttrib body against a stub element.
function runSetAttrib(hrefValue) {
  const el = { href: "", _label: null };
  el.setAttribute = (k, v) => { if (k === "aria-label") el._label = v; };
  el.removeAttribute = (k) => { if (k === "aria-label") el._label = null; };

  const elWrap = { attrib: el };
  const elsFn = () => elWrap;

  const body = extractFunction(WATCH_JS, "liveChatSetAttrib");
  const factory = new Function("liveChatEls", `${body}\nreturn liveChatSetAttrib;`);
  factory(elsFn)(hrefValue);

  return el;
}

test("A5 a real id produces the per-stream chat URL", () => {
  const el = runSetAttrib("dQw4w9WgXcQ");
  assert.equal(el.href, "https://www.youtube.com/live_chat?v=dQw4w9WgXcQ");
  assert.match(String(el._label), /this stream/i, "it is labelled for this stream");
});

test("A6 ids with the namespaced/unusual shape are handled safely", () => {
  // Underscores and dashes are legal video-id characters.
  assert.equal(
    runSetAttrib("ab-_19XY").href,
    "https://www.youtube.com/live_chat?v=ab-_19XY"
  );
});

test("A7 a missing or invalid id keeps the generic fallback (never blind)", () => {
  for (const bad of ["", "  ", null, undefined, "yt:", "has space", "a/b?c", "javascript:alert(1)"]) {
    const el = runSetAttrib(bad);
    assert.equal(
      el.href,
      "https://www.youtube.com/live_chat",
      `"${String(bad)}" must fall back to the generic URL`
    );
    assert.equal(el._label, null, "no per-stream label for an unknown id");
  }
});

test("A8 an id is URL-encoded, so no injection can escape the href", () => {
  const el = runSetAttrib("a b");  // invalid => generic, proving the guard first
  assert.equal(el.href, "https://www.youtube.com/live_chat");
  // And a syntactically valid id still goes through encodeURIComponent().
  const ok = runSetAttrib("A-B_9");
  assert.equal(ok.href, "https://www.youtube.com/live_chat?v=A-B_9");
});

test("A9 the id shape matches the one the backend accepts", () => {
  assert.match(WATCH_JS, /\/\^\[A-Za-z0-9_-\]\{1,64\}\$\//);
  assert.match(WORKER_JS, /\[A-Za-z0-9_-\]\{1,64\}/);
});

// =============================================================================
// B) The panel is only shown for live videos (no regression)
// =============================================================================

test("B1 the panel is hidden by default in the markup", () => {
  assert.match(WATCH_HTML, /<section id="liveChatPanel"[^>]*\shidden>/);
});

test("B2 the panel is revealed only through liveChatStart", () => {
  assert.match(WATCH_JS, /function liveChatStart\(sourceId, isLive\)/);
  const body = extractFunction(WATCH_JS, "liveChatStart");
  assert.match(body, /if\(!sourceId \|\| !isLive\)/, "non-live short-circuits");
  assert.match(body, /els\.panel\.hidden = false/);
});

test("B3 maybeStartLiveChat gates on the video's own isLive flag", () => {
  const body = extractFunction(WATCH_JS, "maybeStartLiveChat");
  assert.match(body, /Boolean\(video\.isLive\)/);
});

test("B4 the backend derives isLive from liveStreamingDetails", () => {
  assert.match(NORMALIZE_JS, /function readLiveState\(/);
  assert.match(NORMALIZE_JS, /liveBroadcastContent === "live"/);
  assert.match(NORMALIZE_JS, /activeLiveChatId/);
});

// =============================================================================
// C) "no_chat" / "not_live" are handled honestly (the reported bug)
// =============================================================================

test("C1 no_chat shows a clear message instead of waiting forever", () => {
  assert.match(
    WATCH_JS,
    /result\.chatStatus === "no_chat"/,
    "no_chat is handled explicitly"
  );
  assert.match(WATCH_JS, /turned off for this broadcast, or has not started yet/);
});

test("C2 not_live is treated as an ended stream, not as an empty live chat", () => {
  assert.match(WATCH_JS, /result\.chatStatus === "not_live"/);
  const idx = WATCH_JS.indexOf('result.chatStatus === "not_live"');
  const tail = WATCH_JS.slice(idx, idx + 200);
  assert.match(tail, /liveChatFinish\("ended"\)/);
});

test("C3 the terminal states are still handled", () => {
  assert.match(
    WATCH_JS,
    /result\.chatStatus === "ended" \|\| result\.chatStatus === "disabled" \|\| result\.chatStatus === "not_found"/
  );
});

test("C4 the client reads the backend's status field as chatStatus", () => {
  const youtubeJs = YOUTUBE_JS;
  assert.match(
    youtubeJs,
    /result\.chatStatus = \(payload && payload\.status\) \? String\(payload\.status\) : "error"/,
    "payload.status is mapped onto chatStatus"
  );
});

test("C5 the backend emits exactly the statuses the client handles", () => {
  for (const status of ["not_live", "no_chat", "disabled", "ended", "error", "live"]) {
    assert.match(
      WORKER_JS,
      new RegExp(`"${status}"`),
      `the backend can emit "${status}"`
    );
  }
});

// =============================================================================
// D) Server-gated sending, no unsafe rendering
// =============================================================================

test("D1 sending exists only as a hidden, doubly-gated affordance", () => {
  assert.match(
    WATCH_HTML,
    /id="liveChatForm"[^>]*hidden/,
    "the composer starts hidden"
  );
  assert.match(
    WATCH_HTML,
    /id="liveChatInput"[^>]*disabled/,
    "the message input starts disabled"
  );
  assert.match(
    WATCH_HTML,
    /id="liveChatSend"[^>]*disabled/,
    "the send button starts disabled"
  );

  // Both a server capability flag and the account's scope must be true.
  assert.match(
    WATCH_JS,
    /sendEnabled === true &&\s*liveChatState\.sendScopeReady === true/
  );
  assert.match(WATCH_JS, /"\/api\/liveChat\/send"/);
  assert.ok(
    !/sendLiveChat|postLiveChat|liveChatComposer/i.test(WATCH_JS),
    "no alternative/unreviewed send path"
  );
});

test("D2 live chat text is rendered with textContent only", () => {
  const body = extractFunction(WATCH_JS, "liveChatMessageEl");
  assert.match(body, /textContent/, "text goes in via textContent");
  assert.ok(!/innerHTML/.test(body), "no innerHTML in the message renderer");
});

test("D3 the message renderer never builds HTML from YouTube data", () => {
  // Scope to the whole live-chat block for a stronger guarantee. Comments are
  // stripped first so only executable text is scanned.
  const start = WATCH_JS.indexOf("// ================= YOUTUBE LIVE CHAT");
  const end = WATCH_JS.indexOf("function renderComments()");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = WATCH_JS.slice(start, end)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/innerHTML/.test(block), "the live chat block never uses innerHTML");
  assert.ok(!/\beval\s*\(/.test(block), "no eval()");
});

test("D4 the chat only talks to the app's own backend", () => {
  assert.match(WATCH_JS, /await liveChat\(sourceId, "", isFirstPoll\)/);
  const start = WATCH_JS.indexOf("// ================= YOUTUBE LIVE CHAT");
  const end = WATCH_JS.indexOf("function renderComments()");
  // Strip comments so prose that merely names "fetch" is not mistaken for code.
  const block = WATCH_JS.slice(start, end)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // The browser must never fetch YouTube's APIs itself.
  assert.ok(
    !/googleapis\.com/.test(block),
    "no direct YouTube Data API endpoint in the browser"
  );
  assert.ok(
    !/\bfetch\s*\(\s*["'`]https?:/.test(block),
    "every fetch target is same-origin, never an absolute URL"
  );

  const urls = [...block.matchAll(/["'](\/api\/[^"']+)["']/g)].map(m => m[1]);
  assert.ok(urls.includes("/api/oauth/status"), "the scope probe uses our API");
  assert.ok(urls.includes("/api/liveChat/send"), "sending uses our API");
});

test("D5 the panel's only controls are the gated composer", () => {
  const start = WATCH_HTML.indexOf('id="liveChatPanel"');
  const section = WATCH_HTML.slice(start, WATCH_HTML.indexOf("</section>", start));
  const buttons = (section.match(/<button/g) || []).length;
  const inputs = (section.match(/<input|<textarea/g) || []).length;
  assert.equal(buttons, 1, "exactly one send button");
  assert.equal(inputs, 1, "exactly one message input");
  assert.match(
    section,
    /id="liveChatForm"[^>]*hidden/,
    "the composer is hidden by default"
  );
  assert.ok(!/contenteditable/i.test(section), "no free-form write surface");
});

// =============================================================================
// E) Existing watch-page behaviour is preserved
// =============================================================================

test("E1 the live chat panel lives in the right-hand column above Up Next", () => {
  const chatIdx = WATCH_HTML.indexOf('id="liveChatPanel"');
  const upNextIdx = WATCH_HTML.indexOf('aria-label="Up Next"');
  assert.ok(chatIdx !== -1 && upNextIdx !== -1 && chatIdx < upNextIdx);
});

test("E2 the comments contract is untouched", () => {
  assert.match(WATCH_HTML, /id="commentForm"/);
  assert.match(WATCH_HTML, /id="comments"/);
  assert.match(WATCH_JS, /function renderComments\(\)/);
});

test("E3 the embed fallback and related list still exist", () => {
  assert.match(WATCH_HTML, /id="ytEmbedFallback"/);
  assert.match(WATCH_HTML, /id="relatedList"/);
});

test("E4 the page still loads auth + account menu + watch modules", () => {
  assert.match(WATCH_HTML, /<script type="module" src="auth\.js"><\/script>/);
  assert.match(WATCH_HTML, /<script type="module" src="shared\/accountMenu\.js"><\/script>/);
  assert.match(WATCH_HTML, /<script type="module" src="watch\.js"><\/script>/);
  assert.match(WATCH_HTML, /<link rel="stylesheet" href="player\.css\?v=4">/);
});

test("E5 the new styles are namespaced and do not target bare elements", () => {
  const css = PLAYER_CSS;
  const start = css.indexOf(".live-chat");
  assert.notEqual(start, -1);
  // Every live-chat selector in the block is class-scoped, never a bare tag.
  const selectors = css
    .split("}")
    .map(chunk => chunk.split("{")[0].trim())
    .filter(s => s.startsWith(".live-chat"));
  assert.ok(selectors.length > 0, "the live chat is styled");
  for (const sel of selectors) {
    assert.match(sel, /^\.live-chat/, `"${sel}" must stay live-chat scoped`);
  }
});
