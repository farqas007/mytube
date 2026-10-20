// =============================================================================
// MyTube — desktop thumbnail hover preview tests (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// public/shared/hoverPreview.js is a browser-only ES module: it touches window,
// document, matchMedia and the YouTube IFrame Player API, none of which exist in
// Node. Importing it directly would throw at the top-level lifecycle hook.
//
// These tests therefore evaluate the REAL shipped function bodies in a sandbox
// with a tiny hand-built DOM/window, the same approach tests/testSubscriptionsPage.js
// uses for subscriptions.js. That way the tests pin the shipped behaviour rather
// than a drifting copy.
//
// What is pinned:
//   * desktop-pointer + reduced-motion gating, decided per interaction;
//   * the ~350 ms intent delay and its cancellation on mouseleave;
//   * muted-only playback (playerVars.mute, and mute() around every play);
//   * one shared player, moved between cards, never one iframe per card;
//   * cleanup on mouseleave and when switching cards;
//   * graceful fallback when YT.Player is missing or throws;
//   * the card surfaces keep their thumbnail, badge, title and navigation.
//
// Everything here reads shipped files. Nothing is written.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

const HOVER_JS = readFileSync(
  path.join(REPO_ROOT, "public", "shared", "hoverPreview.js"),
  "utf8"
);
const INDEX_HTML = readFileSync(
  path.join(REPO_ROOT, "public", "index.html"),
  "utf8"
);
const SUBS_JS = readFileSync(
  path.join(REPO_ROOT, "public", "subscriptions.js"),
  "utf8"
);
const CHANNEL_JS = readFileSync(
  path.join(REPO_ROOT, "public", "channel.js"),
  "utf8"
);
const STYLE_CSS = readFileSync(
  path.join(REPO_ROOT, "public", "style.css"),
  "utf8"
);

// -----------------------------------------------------------------------------
// Source extraction
// -----------------------------------------------------------------------------

// Pull a top-level `function name(...) { ... }` (with a leading `async ` kept)
// out of a source string by brace matching.
function extractFunction(source, name) {
  const signature = `function ${name}(`;
  let start = source.indexOf(signature);

  assert.notEqual(start, -1, `hoverPreview.js must define ${name}()`);

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

// -----------------------------------------------------------------------------
// Minimal DOM + window harness
// -----------------------------------------------------------------------------

function makeElement(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    isConnected: true,
    className: "",
    attributes: {},
    listeners: {},
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
        el.className = [...this._set].join(" ");
      },
      contains(c) {
        return this._set.has(c);
      }
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    appendChild(child) {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) {
        this.children.splice(i, 1);
      }
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    // Fire every listener for `type`. Returns how many were called.
    fire(type, event) {
      const list = this.listeners[type] || [];
      list.slice().forEach(fn => fn(event || {}));
      return list.length;
    }
  };
  return el;
}

// A controllable fake of the YouTube IFrame Player API. `mode` drives behaviour:
//  - "ok":      player is created and reports ready immediately
//  - "no-api":  YT is never defined, and the injected script errors
//  - "throw":   `new YT.Player` throws
//  - "error":   the player fires onError instead of onReady
function makeHarness({ mode = "ok", matchMedia } = {}) {
  const created = [];
  const events = { visibility: [] };

  const document = {
    hidden: false,
    head: makeElement("head"),
    createElement: tag => makeElement(tag),
    addEventListener(type, fn) {
      (events[type] || (events[type] = [])).push(fn);
    },
    body: makeElement("body")
  };

  const timers = [];
  const setTimeoutFn = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  const clearTimeoutFn = handle => {
    if (handle) handle.cleared = true;
  };

  const window = {
    matchMedia:
      matchMedia ||
      (query => ({
        matches:
          query === "(pointer: fine)" ? true : false
      })),
    onYouTubeIframeAPIReady: null
  };

  function Player(target, config) {
    if (mode === "throw") {
      throw new Error("player init failed");
    }
    const api = {
      target,
      config,
      muted: false,
      stopped: false,
      paused: false,
      playing: false,
      loadedIds: [],
      mute() {
        this.muted = true;
        return this;
      },
      stopVideo() {
        this.stopped = true;
        this.playing = false;
        return this;
      },
      pauseVideo() {
        this.paused = true;
        this.playing = false;
        return this;
      },
      playVideo() {
        this.playing = true;
        return this;
      },
      loadVideoById(id) {
        this.loadedIds.push(id);
        return this;
      }
    };
    created.push(api);

    // Defer the ready/error callback a microtask, like the real API would defer
    // it across a network boundary, so the tests exercise the async guard.
    Promise.resolve().then(() => {
      if (mode === "error") {
        if (config.events && config.events.onError) config.events.onError({ data: 150 });
      } else if (config.events && config.events.onReady) {
        config.events.onReady({ target: api });
      }
    });

    return api;
  }

  const YT = { Player, PlayerState: { ENDED: 0 } };

  return {
    created,
    document,
    window,
    timers,
    YT,
    mode,
    setTimeoutFn,
    clearTimeoutFn,
    fireVisibility(hidden) {
      document.hidden = hidden;
      (events.visibility || []).slice().forEach(fn => fn());
    },
    // Run every timer that is due and not cleared.
    runTimers(maxMs = Infinity) {
      timers
        .filter(t => !t.cleared && t.ms <= maxMs)
        .forEach(t => {
          t.cleared = true;
          t.fn();
        });
    }
  };
}

// Evaluate the shipped hoverPreview functions against a harness. We build the
// module's mutable state fresh each time by including the `let` declarations the
// functions close over.
function loadHoverModule(harness, extraNames = []) {
  const stateNames = [
    "previewPlayer",
    "previewOverlay",
    "previewApiLoading",
    "previewReady",
    "activeThumb",
    "activeSourceId",
    "pendingStartTimer",
    "pendingStopTimer",
    "sawPointerEvent"
  ];

  const fnNames = [
    "hoverPreviewEnabled",
    "hoverPreviewSourceId",
    "ensurePreviewApi",
    "ensureOverlay",
    "clearPendingStart",
    "clearPendingStop",
    "clearOverlay",
    "stopHoverPreview",
    "attachHoverPreview",
    "scheduleHoverPreview",
    "startHoverPreview",
    "playActiveSource",
    "armAutoStop",
    ...extraNames
  ];

  const consts =
    "const HOVER_PREVIEW_DELAY_MS = 350;\nconst HOVER_PREVIEW_MAX_MS = 5000;\n";

  const state = stateNames.map(n => `let ${n} = null;`).join("\n");

  const bodies = fnNames
    .map(n => extractFunction(HOVER_JS, n))
    .join("\n");

  // `YT` is a browser global the real module reads via `typeof YT`. Node has no
  // such global, so it is declared here (`var YT`) and flipped by setYT() to
  // simulate the API being present, missing, or failing. `ensurePreviewApi`
  // caches its pending promise on an own property, so that is initialised too.
  const factory = new Function(
    "window",
    "document",
    "Promise",
    "Array",
    "String",
    "Error",
    "setTimeout",
    "clearTimeout",
    `${consts}${state}\nvar YT = undefined;\nensurePreviewApi._pending = null;\n${bodies}\n` +
      `return { ${fnNames.join(", ")}, ` +
      `getYT: () => YT, setYT: (v) => { YT = v; }, ` +
      `getState: () => ({ previewPlayer, previewOverlay, previewReady, activeThumb, activeSourceId, pendingStartTimer, pendingStopTimer }) };\n`
  );

  const mod = factory(
    harness.window,
    harness.document,
    Promise,
    Array,
    String,
    Error,
    harness.setTimeoutFn,
    harness.clearTimeoutFn
  );

  // The API is present unless a test opts out ("no-api").
  mod.setYT(harness.mode === "no-api" ? undefined : harness.YT);

  return mod;
}

// =============================================================================
// A) Capability gating
// =============================================================================

test("A1 a fine pointer with no motion preference enables previews", () => {
  const h = makeHarness({
    matchMedia: q => ({ matches: q === "(pointer: fine)" })
  });
  const mod = loadHoverModule(h);

  assert.equal(mod.hoverPreviewEnabled(), true);
});

test("A2 a coarse pointer (touch) disables previews", () => {
  const h = makeHarness({ matchMedia: () => ({ matches: false }) });
  const mod = loadHoverModule(h);

  assert.equal(mod.hoverPreviewEnabled(), false);
});

test("A3 prefers-reduced-motion disables previews even on a mouse", () => {
  const h = makeHarness({
    matchMedia: q => ({ matches: q === "(pointer: fine)" || q === "(prefers-reduced-motion: reduce)" })
  });
  const mod = loadHoverModule(h);

  assert.equal(mod.hoverPreviewEnabled(), false, "reduced motion must win over pointer:fine");
});

test("A4 a missing matchMedia is treated as unsupported, never a crash", () => {
  const h = makeHarness();
  h.window.matchMedia = undefined;
  const mod = loadHoverModule(h);

  assert.equal(mod.hoverPreviewEnabled(), false);
});

test("A5 only namespaced yt: ids are previewable", () => {
  const h = makeHarness();
  const mod = loadHoverModule(h);

  assert.equal(mod.hoverPreviewSourceId("yt:dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(mod.hoverPreviewSourceId("local:123"), "");
  assert.equal(mod.hoverPreviewSourceId(""), "");
  assert.equal(mod.hoverPreviewSourceId(null), "");
});

// =============================================================================
// B) Hover delay + cancellation
// =============================================================================

function attach(h, videoId = "yt:abc12345678") {
  const mod = loadHoverModule(h);
  const thumb = makeElement("div");
  thumb.isConnected = true;
  mod.attachHoverPreview(thumb, videoId);
  return { mod, thumb };
}

// Drain the microtask queue so the promise chains inside startHoverPreview
// (ensurePreviewApi -> build player -> onReady) have all run.
function flush(times = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => Promise.resolve());
  }
  return p;
}

test("B1 the preview waits for the intent delay before starting", async () => {
  const h = makeHarness();
  const { mod, thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });

  assert.equal(h.created.length, 0, "no player is built on mouseenter alone");

  // Nothing shorter than the delay should start it.
  h.runTimers(349);
  await flush();
  assert.equal(h.created.length, 0, "still nothing before 350ms");

  h.runTimers(350);
  await flush();
  assert.equal(h.created.length, 1, "the player is created once the delay elapses");
  void mod;
});

test("B2 leaving before the delay cancels the pending preview", async () => {
  const h = makeHarness();
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  thumb.fire("mouseleave");

  h.runTimers();
  await flush();

  assert.equal(h.created.length, 0, "a quick pass-through never builds a player");
});

test("B3 a touch-originated enter is ignored", async () => {
  const h = makeHarness();
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "touch" });
  h.runTimers();
  await flush();

  assert.equal(h.created.length, 0, "touch events must not start a preview");
});

// =============================================================================
// C) Muted playback
// =============================================================================

test("C1 the player is constructed muted and never autoplays with sound", async () => {
  const h = makeHarness();
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  assert.equal(h.created.length, 1);
  const cfg = h.created[0].config;
  assert.equal(cfg.playerVars.mute, 1, "playerVars.mute must be 1");
  assert.equal(cfg.playerVars.autoplay, 0, "autoplay must stay off");
  assert.equal(h.created[0].muted, true, "mute() is called before playing");
  assert.equal(h.created[0].playing, true);
});

test("C2 reuse also mutes before every play", async () => {
  const h = makeHarness();
  const { thumb } = attach(h, "yt:first11111");

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  const player = h.created[0];
  assert.ok(player, "the player was built");
  player.muted = false; // simulate the API having unmuted between uses
  player.playing = false;

  thumb.fire("mouseenter", { pointerType: "mouse" });
  thumb.fire("mouseleave");
  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  assert.equal(h.created.length, 1, "the same player is reused, not recreated");
  assert.equal(player.muted, true, "reuse re-mutes before playing");
});

// =============================================================================
// D) One active preview + cleanup
// =============================================================================

test("D1 only one player exists no matter how many cards are built", async () => {
  const h = makeHarness();
  const mod = loadHoverModule(h);

  const cards = [];
  for (let i = 0; i < 5; i++) {
    const thumb = makeElement("div");
    thumb.isConnected = true;
    mod.attachHoverPreview(thumb, `yt:video${String(i).padStart(6, "0")}`);
    cards.push(thumb);
  }

  // Hover each in turn; each is a fresh card, so each schedules then leaves.
  for (const thumb of cards) {
    thumb.fire("mouseenter", { pointerType: "mouse" });
    h.runTimers();
    await flush();
    thumb.fire("mouseleave");
  }

  assert.equal(h.created.length, 1, "the shared player must never multiply");
});

test("D2 mouseleave stops playback and detaches the overlay", async () => {
  const h = makeHarness();
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  const player = h.created[0];
  assert.ok(player, "the player was built");
  assert.equal(player.playing, true);
  assert.ok(thumb.children.some(c => c.className === "thumb-preview"), "overlay is inside the card");

  thumb.fire("mouseleave");

  assert.equal(player.stopped, true, "playback is stopped on leave");
  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "the overlay is removed on leave, leaving no stray element"
  );
});

test("D3 switching cards moves the single overlay instead of stacking them", async () => {
  const h = makeHarness();
  const mod = loadHoverModule(h);

  const a = makeElement("div");
  a.isConnected = true;
  const b = makeElement("div");
  b.isConnected = true;
  mod.attachHoverPreview(a, "yt:videoAAAA1");
  mod.attachHoverPreview(b, "yt:videoBBBB2");

  a.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  // Move to the second card without an intervening mouseleave on `a` (this is
  // what happens when the pointer crosses straight from one card to the next).
  b.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  const overlays = [...a.children, ...b.children].filter(c => c.className === "thumb-preview");
  assert.equal(overlays.length, 1, "exactly one overlay exists across both cards");
  assert.equal(h.created.length, 1, "and exactly one player");
});

test("D4 an auto-stop timer parks the preview after the max duration", async () => {
  const h = makeHarness();
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  const player = h.created[0];
  assert.ok(player, "the player was built");
  assert.equal(player.playing, true);

  h.runTimers(5000);

  assert.equal(player.paused, true, "a forgotten hover is paused after 5s");
  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "and the overlay is taken away"
  );
});

test("D5 hiding the tab stops an active preview", async () => {
  const h = makeHarness();
  const { mod, thumb } = attach(h);
  void mod;

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  const player = h.created[0];
  assert.ok(player, "the player was built");
  assert.equal(player.playing, true);

  // The module registers its own visibilitychange hook at load time, which the
  // extracted-function sandbox does not run. Pin that hook in source, then drive
  // the same public cleanup path it invokes.
  assert.match(
    HOVER_JS,
    /addEventListener\("visibilitychange"/,
    "the module must react to tab visibility changes"
  );

  mod.stopHoverPreview();

  assert.equal(player.stopped, true, "a hidden document must not keep playing");
  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "and the overlay is removed"
  );
});

// =============================================================================
// E) Graceful fallback
// =============================================================================

test("E1 a missing YT API keeps the static thumbnail and never throws", async () => {
  const h = makeHarness({ mode: "no-api" });
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  // The injected API script reports failure, which rejects ensurePreviewApi().
  const script = h.document.head.children.find(c => c.tagName === "SCRIPT");
  assert.ok(script, "the iframe_api script is injected once");
  assert.equal(typeof script.onerror, "function");
  script.onerror();

  await flush();

  assert.equal(h.created.length, 0, "no player without the API");
  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "no overlay is left behind"
  );
});

test("E2 a throwing YT.Player is caught and the card is untouched", async () => {
  const h = makeHarness({ mode: "throw" });
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "a failed init cleans up rather than leaving a broken overlay"
  );
});

test("E3 a player onError (embed blocked / removed video) falls back quietly", async () => {
  const h = makeHarness({ mode: "error" });
  const { thumb } = attach(h);

  thumb.fire("mouseenter", { pointerType: "mouse" });
  h.runTimers();
  await flush();

  assert.equal(
    thumb.children.some(c => c.className === "thumb-preview"),
    false,
    "an unplayable video shows the static thumbnail again"
  );
});

test("E4 HTML5-video-free: nothing is downloaded or locally hosted", () => {
  // Strip comments first: the module's own documentation mentions <video> and
  // ".mp4" while explaining what it does NOT do. Only executable text counts.
  const code = HOVER_JS.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    !/<video[\s>]/i.test(code),
    "the preview must embed the player, never a <video> element"
  );
  assert.ok(
    !/\.mp4|\.webm|createObjectURL/i.test(code),
    "no local/hosted media source may be referenced"
  );
});

// =============================================================================
// F) Wiring into the card surfaces
// =============================================================================

test("F1 the homepage card wires the preview onto its thumbnail", () => {
  assert.match(
    INDEX_HTML,
    /attachHoverPreviewHere\(thumb,\s*v\.id\)/,
    "index.html buildCard must attach the preview"
  );
  assert.match(
    INDEX_HTML,
    /import \{ attachHoverPreview \} from "\.\/shared\/hoverPreview\.js"/,
    "index.html must import the shared helper"
  );
});

test("F2 the subscriptions card wires the preview", () => {
  assert.match(SUBS_JS, /attachHoverPreview\(thumb,\s*v\.id\)/);
  assert.match(SUBS_JS, /import \{ attachHoverPreview \} from "\.\/shared\/hoverPreview\.js"/);
});

test("F3 the channel page card wires the preview", () => {
  assert.match(CHANNEL_JS, /attachHoverPreview\(thumb,\s*v\.id\)/);
  assert.match(CHANNEL_JS, /import \{ attachHoverPreview \} from "\.\/shared\/hoverPreview\.js"/);
});

test("F4 attaching preserves the thumbnail, badge and click-to-watch behaviour", () => {
  // The attachment must happen AFTER the img/badge are appended and must not
  // replace the card's click handler.
  const subsCard = extractFunction(SUBS_JS, "buildVideoCard");
  const attachIndex = subsCard.indexOf("attachHoverPreview(thumb, v.id)");
  const badgeIndex = subsCard.indexOf("thumb.appendChild(badge)");
  const clickIndex = subsCard.indexOf("openVideo(v.id)");

  assert.ok(attachIndex > badgeIndex, "the preview attaches after the badge is in place");
  assert.ok(clickIndex !== -1, "the card still opens the watch page on click");
  assert.ok(
    subsCard.indexOf("card.addEventListener(\"keydown\"") !== -1,
    "keyboard activation is untouched"
  );
});

test("F5 the preview overlay is contained and non-interactive", () => {
  assert.match(
    STYLE_CSS,
    /\.thumb-preview\{[^}]*position:absolute/,
    "the overlay is absolutely positioned inside the thumbnail"
  );
  assert.match(
    STYLE_CSS,
    /\.thumb-preview\{[^}]*inset:0/,
    "the overlay is pinned to the thumbnail bounds"
  );
  assert.match(
    STYLE_CSS,
    /\.thumb-preview\{[^}]*pointer-events:none/,
    "the overlay must not steal the card's click"
  );
});

test("F6 previews are gated on pointer:fine and reduced-motion in the source", () => {
  assert.match(HOVER_JS, /"\(pointer: fine\)"/);
  assert.match(HOVER_JS, /"\(prefers-reduced-motion: reduce\)"/);
  assert.match(HOVER_JS, /HOVER_PREVIEW_DELAY_MS\s*=\s*350/);
});

test("F7 no CSP-breaking host is introduced", () => {
  // The player is embedded from YouTube, which worker.js already allows in
  // frame-src. If a new origin ever crept in, this test would catch it.
  assert.ok(
    !/https?:\/\/(?!www\.youtube\.com\/iframe_api)/.test(HOVER_JS.replace(/https:\/\/www\.youtube\.com\/iframe_api/g, "")),
    "the helper must only reference the official iframe_api URL"
  );
});

test("F8 homepage re-attaches previews for cards rendered before the module", () => {
  // The homepage's card renderer is an inline parse-time script; the helper is a
  // deferred module. Cards built first must not be left without a preview, so
  // the page records the id and replays it when the module announces readiness.
  assert.match(
    INDEX_HTML,
    /thumb\.dataset\.hoverPreviewId\s*=\s*videoId/,
    "the card records its video id for later attachment"
  );
  assert.match(
    INDEX_HTML,
    /addEventListener\("mytube-hover-ready",\s*applyHoverPreviewsToRenderedCards/,
    "the page listens for the helper's arrival"
  );
  assert.match(
    INDEX_HTML,
    /window\.dispatchEvent\(new Event\("mytube-hover-ready"\)\)/,
    "the module announces that the helper exists"
  );
});
