import {
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse,
  normalizeLiveChatResponse,
  formatCount,
  formatPublishedDate,
  readLiveState
} from "./shared/normalize.js";
import {
  FEED_POOL_TTL_MS,
  FEED_POOL_REGIONS,
  FEED_POOL_PAGE_SIZE,
  availableTopics,
  buildFeedPage,
  decodeFeedCursor,
  topicFromTags
} from "./shared/feed.js";
import {
  dedupeSearchResults,
  normalizeQuery,
  resolveSearchFilters,
  resolveSearchMax
} from "./shared/search.js";
import {
  VIDEO_SOURCE_PREFIX,
  VIDEO_TYPE_YOUTUBE,
  getVideoByVideoId,
  markFetchedAt,
  upsertVideos
} from "./shared/index-store.js";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

// The `videos.list` part string used everywhere a full video payload is needed.
// `liveStreamingDetails` is what exposes activeLiveChatId (only present while a
// broadcast is live). Requesting an extra part costs no extra quota units on
// videos.list, so it is safe to always ask for it.
const VIDEO_PARTS_FULL = "snippet,contentDetails,statistics,status,liveStreamingDetails";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5504",
  "http://127.0.0.1:5504",
  "https://mytube.farqas007.workers.dev"
]);

function originAllowed(request) {
  return ALLOWED_ORIGINS.has(request?.headers?.get("Origin") || "");
}

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com",
  "font-src 'self' data:",
  "connect-src 'self' https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "media-src 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "frame-ancestors 'self'"
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP_DIRECTIVES,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// True for the YouTube Live Streaming chat endpoints. Used to give live-chat
// errors their own handling (they mean very different things than generic 403s).
function isLiveChatPath(pathname) {
  return String(pathname || "").includes("liveChat/");
}

// -----------------------------------------------------------------------------
// D1 INDEX (Phase 1) — availability guard, read-first detail lookup, write-behind
// -----------------------------------------------------------------------------
// Every function in this block is OPTIONAL infrastructure wrapped around the
// existing YouTube paths. The rules it keeps:
//
//   * No binding, no ctx, or a binding that is not a usable D1 database => every
//     function here is a no-op and the Worker behaves exactly as it did before
//     the index existed. A missing or broken D1 can never turn into a 5xx.
//   * Nothing here ever ADDS an upstream YouTube request. A read is served from
//     the index only instead of from YouTube, and a write reuses metadata the
//     Worker had already paid for. Upstream quota usage is therefore identical,
//     and for /api/video an index hit actually spends less.
//   * Nothing here blocks a response. Writes run through ctx.waitUntil(), so the
//     client is answered from the payload already in hand.
//   * Nothing here stores user data. The only rows written are
//     `videos`-table metadata rows built by shared/index-store.js from a raw
//     videos.list item: no live chat ids, no chat messages, no comments, no
//     credentials, no email addresses.
//
// Origin labels written to `videos.origin` (see 0001_init.sql) — one per existing
// upstream path, so a row can always be traced back to how it was obtained.
const INDEX_ORIGIN_DETAIL = "detail";
const INDEX_ORIGIN_SEARCH = "search";
const INDEX_ORIGIN_RELATED = "related";
const INDEX_ORIGIN_CHANNEL = "channel";
const INDEX_ORIGIN_CHART_PREFIX = "chart:";

// How long an indexed row may answer /api/video.
//
// The 6-minute TTL is the WHOLE staleness budget, not a slice of a larger one.
// Rows are stamped with the instant their payload arrived from YouTube
// (VIDEO_FETCHED_AT), never with the moment the row was written, so re-indexing a
// cache hit does not renew the row's lease on life. A row therefore becomes
// unusable 6 minutes after the fetch it describes, even if it was re-written
// 50 times in between, and the index cannot make a client see older data than
// the pre-existing 10-minute response cache already permitted.
//
// It exists to cut YouTube calls, never to relax freshness.
const VIDEO_INDEX_TTL_MS = 6 * 60 * 1000;

// A row stamped slightly in the future is accepted (clock skew between the
// writing isolate and this one); anything further ahead than this is treated as
// untrustworthy and simply re-fetched, because a bad timestamp must not become a
// permanently "fresh" row.
const VIDEO_INDEX_CLOCK_SKEW_MS = 60 * 1000;

// Upper bound on a runtime that can be rebuilt into the canonical DTO at all.
// normalize.js's formatDuration() only understands the PT… form, so a day-or-longer
// runtime (a P1D/P1W duration) has no canonical rendering to reproduce.
// See the duration gate in indexRowIsFresh() for the full rule.
const VIDEO_INDEX_MAX_DURATION_SECONDS = 86400;

// Builds the per-request index handle, or null when indexing must be skipped.
//
// null is returned when the binding is absent/malformed OR when ctx cannot accept
// background work — which is the whole availability guard in one place.
function createIndexContext(ctx, env) {
  const db = env?.mytube_index;

  if (!db || typeof db.prepare !== "function") {
    return null;
  }

  if (typeof ctx?.waitUntil !== "function") {
    return null;
  }

  return { db, ctx };
}

// Schedule an index write. Returns immediately; the write never delays the
// response and a D1 failure is logged here rather than propagated, because the
// response has already been computed from the same payload.
function scheduleIndexWrite(index, items, options = {}) {
  const list = Array.isArray(items) ? items : [];

  if (!index || !list.length) {
    return;
  }

  const task = upsertVideos(index.db, list, options).catch(error => {
    console.error(
      "[mytube] D1 index write failed",
      error?.message || error
    );
  });

  index.ctx.waitUntil(task);
}

// True when a row may answer /api/video instead of a YouTube call.
function indexRowIsFresh(row, now) {
  if (!row || typeof row !== "object") {
    return false;
  }

  if (String(row.type || "") !== VIDEO_TYPE_YOUTUBE) {
    return false;
  }

  // Only a plain YouTube video id is looked up. Anything carrying the namespaced
  // form ("yt:…") is left to the existing path untouched, so no request that
  // behaves differently today can start behaving differently here.
  const videoId = String(row.video_id || "").trim();

  if (!videoId || !/^[A-Za-z0-9_-]{1,64}$/.test(videoId)) {
    return false;
  }

  const fetchedAt = Number(row.metadata_fetched_at_ms);

  if (!Number.isFinite(fetchedAt)) {
    return false;
  }

  const age = now - fetchedAt;

  if (age > VIDEO_INDEX_TTL_MS || age < -VIDEO_INDEX_CLOCK_SKEW_MS) {
    return false;
  }

  // Live state is time-critical: a row written as "not live" can become live at
  // any moment, and the watch page's live panel must keep polling YouTube. Such
  // rows always take the live YouTube path, so indexing can never delay a
  // broadcast going live.
  if (Number(row.is_live) === 1) {
    return false;
  }

  // Two duration states cannot be rendered identically to the YouTube path and
  // are therefore never served from the index:
  //
  //   0       ambiguous. "PT0S" renders "0:00" but "P0D" (a stream with no fixed
  //           runtime, which is most live content) renders "" — and both land in
  //           the same column, so the row cannot tell them apart.
  //   >= 1 day normalize.js's formatDuration() has no PT… form that yields this,
  //           so there is no canonical rendering to reproduce.
  //
  // A NULL duration is fine and renders "" on both paths.
  if (row.duration_seconds !== null && row.duration_seconds !== undefined && row.duration_seconds !== "") {
    const duration = Number(row.duration_seconds);

    if (!Number.isFinite(duration) || duration <= 0 || duration >= VIDEO_INDEX_MAX_DURATION_SECONDS) {
      return false;
    }
  }

  return true;
}

// Integer seconds -> the exact string normalize.js's formatDuration() produces
// for the equivalent PT… duration. Only reached for durations the canonical
// formatter can render (see the duration gate in indexRowIsFresh).
function formatIndexedDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") {
    return "";
  }

  const total = Number(seconds);

  if (!Number.isFinite(total) || total < 0) {
    return "";
  }

  const whole = Math.floor(total);

  if (whole >= VIDEO_INDEX_MAX_DURATION_SECONDS) {
    return "";
  }

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

// Rebuild a YouTube RFC 3339 timestamp from stored epoch milliseconds.
//
// YouTube emits publishedAt / actualStartTime / actualEndTime as
// "YYYY-MM-DDTHH:MM:SSZ" — whole seconds, UTC, no fractional part. Formatting
// through toISOString() and dropping the milliseconds only when the stored value
// is a whole second therefore reproduces the upstream string BYTE FOR BYTE,
// which is what lets an index-served /api/video be deep-equal to a
// YouTube-served one. (A non-whole-second value cannot come from these fields;
// it is rendered with full precision rather than silently rounded.)
function formatIndexedTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const ms = Number(value);

  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }

  const iso = new Date(ms).toISOString();

  return ms % 1000 === 0 ? iso.replace(/\.\d{3}Z$/, "Z") : iso;
}

// Rebuild the canonical DTO from an indexed row.
//
// The returned object has the SAME keys, in the same order, with the same value
// types as normalizeVideoItem() for the same video — that is the contract /api/video
// has always had, so a row served from the index is indistinguishable from one
// built from a fresh videos.list response.
function videoFromIndexRow(row) {
  if (!row) {
    return null;
  }

  const videoId = String(row.video_id || "").trim();

  if (!videoId) {
    return null;
  }

  // `embeddable` is NOT NULL in the schema, but "unknown" is still rendered the
  // way normalize.js renders it (an absent status part means embeddable).
  const embeddable = row.embeddable === null || row.embeddable === undefined
    ? true
    : Number(row.embeddable) !== 0;

  const publishedAtMs =
    row.published_at_ms === null || row.published_at_ms === undefined || row.published_at_ms === ""
      ? null
      : Number(row.published_at_ms);

  // The index never stores live chat content, so these are always empty/zero on a
  // row this function is allowed to serve (live rows are rejected above).
  return {
    id: `yt:${videoId}`,
    sourceId: videoId,
    type: VIDEO_TYPE_YOUTUBE,
    title: String(row.title || ""),
    channel: String(row.channel_title || ""),
    channelId: String(row.channel_id || ""),
    thumb: String(row.thumb_url || ""),
    time: formatIndexedDuration(row.duration_seconds),
    views: `${formatCount(Number(row.view_count) || 0)} views`,
    viewCount: Number(row.view_count) || 0,
    likeCount: Number(row.like_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    // Recomputed from the absolute publication instant at response time, which is
    // exactly what the YouTube path does — "2y ago" is never stored.
    date: formatPublishedDate(
      Number.isFinite(publishedAtMs) ? publishedAtMs : null
    ),
    description: String(row.description || ""),
    embeddable,
    isLive: Number(row.is_live) === 1,
    liveChatId: "",
    concurrentViewers: 0,
    liveChatDisabled: false,
    actualStartTime: formatIndexedTimestamp(row.live_start_ms),
    actualEndTime: formatIndexedTimestamp(row.live_end_ms)
  };
}

// Index-first lookup for /api/video.
//
//   { video, degraded }  video === null means "use the existing YouTube path".
//                       degraded === true means the index itself failed, which is
//                       reported as X-MyTube-Degraded: 1 without ever surfacing
//                       as an error.
async function readIndexedVideo(index, videoId) {
  if (!index) {
    return { video: null, degraded: false };
  }

  try {
    const row = await getVideoByVideoId(index.db, videoId);

    if (!indexRowIsFresh(row, Date.now())) {
      return { video: null, degraded: false };
    }

    return { video: videoFromIndexRow(row), degraded: false };
  } catch (error) {
    console.error(
      "[mytube] D1 index read failed",
      error?.message || error
    );

    return { video: null, degraded: true };
  }
}

// Observability headers for every route the index touches.
//
//   source     index    answered from a fresh D1 row
//              youtube  answered from YouTube, as before
//              fallback answered from YouTube AFTER the index failed
//   degraded   1 when the index path errored and the request was degraded, else 0
function indexHeaders(source, degraded = false) {
  return {
    "X-MyTube-Source": source,
    "X-MyTube-Degraded": degraded ? "1" : "0"
  };
}

// -----------------------------------------------------------------------------
// Simple per-IP sliding-window rate limit. Uses the Cloudflare-provided client
// IP when available. In-memory per-isolate, so it is best-effort (not durable),
// but it stops casual abuse from exhausting the shared YouTube quota.
// -----------------------------------------------------------------------------

const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 120;
const rateBuckets = new Map();

function clientIp(request) {
  return (
    request?.headers?.get("CF-Connecting-IP") ||
    request?.headers?.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function rateLimitAllowed(request) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || {
    count: 0,
    windowStart: now
  };

  if (now - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  rateBuckets.set(ip, bucket);

  if (rateBuckets.size > 5000) {
    // Crude but effective: drop any entry whose window has fully expired.
    for (const [key, entry] of rateBuckets) {
      if (now - entry.windowStart >= RATE_WINDOW_MS) {
        rateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= RATE_MAX_PER_WINDOW;
}

// -----------------------------------------------------------------------------
// Dedicated budget for `search.list`.
//
// search.list costs a FLAT 100 quota units per call regardless of maxResults,
// versus 1 unit for videos.list. The general limiter (120 requests / 5 min)
// therefore allowed a single caller to spend 12,000 units in five minutes —
// more than YouTube's entire default daily quota. Search therefore gets its own,
// much tighter bucket so an accidental loop or a scraper cannot starve the rest
// of the site (home feed, comments, related videos) of quota.
// -----------------------------------------------------------------------------

const SEARCH_RATE_WINDOW_MS = 5 * 60 * 1000;
const SEARCH_RATE_MAX_PER_WINDOW = 40;
const searchRateBuckets = new Map();

function searchRateLimitAllowed(request) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = searchRateBuckets.get(ip) || { count: 0, windowStart: now };

  if (now - bucket.windowStart >= SEARCH_RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  searchRateBuckets.set(ip, bucket);

  if (searchRateBuckets.size > 5000) {
    for (const [key, entry] of searchRateBuckets) {
      if (now - entry.windowStart >= SEARCH_RATE_WINDOW_MS) {
        searchRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= SEARCH_RATE_MAX_PER_WINDOW;
}

const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const memoryCache = new Map();

// `extraHeaders` carries the Phase 1 index observability headers only. It is
// applied AFTER the CORS/Cache-Control block so it can never overwrite
// Content-Type, Cache-Control, Access-Control-Allow-Origin or Vary.
function json(data, status = 200, request, extraHeaders = null) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (originAllowed(request)) {
    headers["Access-Control-Allow-Origin"] = request.headers.get("Origin");
    headers["Vary"] = "Origin";
  }

  for (const [name, value] of Object.entries(extraHeaders || {})) {
    headers[name] = String(value);
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function normalizeError(error, status = 500) {
  if (error?.type === "quota") {
    return {
      error: "YouTube API quota exceeded. Please try again later.",
      code: "QUOTA_EXCEEDED"
    };
  }

  if (error?.type === "invalidKey") {
    return {
      error: "YouTube API key is invalid or has been disabled.",
      code: "INVALID_API_KEY"
    };
  }

  if (error?.type === "accessNotConfigured") {
    return {
      error: "YouTube Data API v3 is not enabled for this API key.",
      code: "API_NOT_ENABLED"
    };
  }

  if (error?.type === "network") {
    return {
      error: "Unable to reach YouTube right now. Please try again.",
      code: "NETWORK_ERROR"
    };
  }

  // A 2xx whose body was not a usable YouTube payload. This is deliberately a
  // 502 and never a 404: the video's existence is exactly what we could not
  // determine, and the watch page reads a 404 as "video unavailable".
  if (error?.type === "invalidResponse") {
    return {
      error: "YouTube returned an unexpected response. Please try again.",
      code: "UPSTREAM_INVALID_RESPONSE"
    };
  }

  // --- YouTube Live Chat states -------------------------------------------
  // These are NOT failures: they are the normal terminal states of a live chat.
  // The caller (and ultimately the frontend) treats them as a friendly,
  // permanent panel state rather than an error to retry.
  if (error?.type === "liveChatEnded") {
    return {
      error: "This live chat has ended.",
      code: "LIVE_CHAT_ENDED"
    };
  }

  if (error?.type === "liveChatDisabled") {
    return {
      error: "Live chat is turned off for this broadcast.",
      code: "LIVE_CHAT_DISABLED"
    };
  }

  if (error?.type === "liveChatNotFound") {
    return {
      error: "This live chat is unavailable.",
      code: "LIVE_CHAT_NOT_FOUND"
    };
  }

  if (error?.type === "rateLimitExceeded") {
    return {
      error: "Live chat is updating too quickly. Please try again shortly.",
      code: "LIVE_CHAT_RATE_LIMITED"
    };
  }

  if (status === 400) {
    return {
      error: "Invalid YouTube API request.",
      code: "BAD_REQUEST"
    };
  }

  if (status === 401) {
    return {
      error: "YouTube API authentication failed.",
      code: "UNAUTHORIZED"
    };
  }

  if (status === 403) {
    return {
      error: "YouTube API access was denied.",
      code: "FORBIDDEN"
    };
  }

  if (status === 404) {
    return {
      error: "Requested YouTube resource was not found.",
      code: "NOT_FOUND"
    };
  }

  // Catch-all: never echo the upstream/API error.message back to the client.
  // Return a safe, generic message. (Server can still log error?.message
  // server-side if desired; it is never sent to the client.)
  return {
    error: "Something went wrong while contacting the video service. Please try again later.",
    code: "API_ERROR"
  };
}

function cacheGet(key) {
  const entry = memoryCache.get(key);

  if (!entry) return null;

  if (Date.now() - entry.time > CACHE_TTL) {
    memoryCache.delete(key);
    return null;
  }

  return entry.value;
}

function cacheSet(key, value) {
  if (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = memoryCache.keys().next().value;

    if (firstKey) {
      memoryCache.delete(firstKey);
    }
  }

  memoryCache.set(key, {
    time: Date.now(),
    value
  });
}

// A YouTube Data API v3 response is always a JSON *object*.
//
// `response.json()` throws on an HTML error page, an empty body, a truncated
// payload or a WAF/captive-portal interception, and the old code swallowed that
// into `data = null`. Every caller then read `null` as "the request succeeded and
// there is nothing in it": /api/video answered a clean 404 for a video that
// exists, the feed rendered empty, and the maintenance pass treated every
// selected video as definitively deleted.
//
// A 200 with an unreadable body is a TRANSIENT upstream failure, so it is raised
// as one and handled exactly like a 5xx — it is never allowed to look like an
// empty-but-authoritative result. Called before the result is cached, so a
// broken body can never poison the 10-minute response cache either.
function assertUsableYouTubePayload(data, pathname) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw {
      type: "invalidResponse",
      status: 502,
      message: `YouTube returned an unreadable body for ${pathname}.`
    };
  }

  // `items` is the only list-shaped field any caller in this file reads, and
  // every one of them reads it as an array. Present-but-not-an-array is a broken
  // payload, not an empty result, and `items: null` is exactly the shape a
  // half-parsed or proxied response tends to arrive in.
  if (data.items !== undefined && !Array.isArray(data.items)) {
    throw {
      type: "invalidResponse",
      status: 502,
      message: `YouTube returned a malformed item list for ${pathname}.`
    };
  }

  return data;
}

// Fetch a YouTube Data API resource.
//
// `options.skipCache` bypasses the generic 10-minute response cache entirely.
// Live chat must NEVER use that cache (a 10-minute-old chat payload would be
// useless and would starve the fan-out cache of fresh data), and the short-TTL
// live probe below must not be polluted by a 10-minute-old "not live" verdict.
async function ytFetch(pathname, params, apiKey, options = {}) {
  if (!apiKey) {
    throw {
      type: "invalidKey",
      message: "YOUTUBE_API_KEY is not configured."
    };
  }

  const url = new URL(`${YT_API_BASE}/${pathname}`);

  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  url.searchParams.set("key", apiKey);

  const cacheKey = url.toString().replace(
    /([?&])key=[^&]+/,
    "$1key=REDACTED"
  );

  if (!options.skipCache) {
    const cached = cacheGet(cacheKey);

    if (cached) {
      return cached;
    }
  }

  let response;

  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "MyTube/1.0",
        "Accept": "application/json"
      }
    });
  } catch (error) {
    throw {
      type: "network",
      message: error?.message || "Network error."
    };
  }

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const reason =
      data?.error?.errors?.[0]?.reason ||
      data?.error?.status ||
      "";

    // --- YouTube Live Chat specific reasons -------------------------------
    // Checked BEFORE the generic quota mapping because for the live chat
    // endpoint "rateLimitExceeded" means "you polled faster than YouTube's
    // refresh rate", not "you ran out of daily quota".
    if (isLiveChatPath(pathname)) {
      if (reason === "liveChatEnded") {
        throw {
          type: "liveChatEnded",
          message: "This live chat has ended."
        };
      }

      if (reason === "liveChatDisabled") {
        throw {
          type: "liveChatDisabled",
          message: "Live chat is disabled for this broadcast."
        };
      }

      if (
        response.status === 404 ||
        reason === "liveChatNotFound"
      ) {
        throw {
          type: "liveChatNotFound",
          message: "This live chat could not be found."
        };
      }

      if (reason === "rateLimitExceeded") {
        throw {
          type: "rateLimitExceeded",
          message: "Live chat was polled too quickly."
        };
      }
    }

    if (
      response.status === 403 &&
      (
        reason === "quotaExceeded" ||
        reason === "dailyLimitExceeded" ||
        reason === "rateLimitExceeded"
      )
    ) {
      throw {
        type: "quota",
        message: "YouTube quota exceeded."
      };
    }

    if (
      response.status === 400 &&
      reason === "keyInvalid"
    ) {
      throw {
        type: "invalidKey",
        message: "YouTube API key is invalid."
      };
    }

    if (
      response.status === 403 &&
      reason === "accessNotConfigured"
    ) {
      throw {
        type: "accessNotConfigured",
        message: "YouTube Data API v3 is not enabled."
      };
    }

    const error = new Error(
      data?.error?.message || `YouTube API returned ${response.status}.`
    );

    error.status = response.status;

    throw error;
  }

  const result = {
    status: response.status,
    data
  };

  // The body was 2xx, so it is about to be treated as real data. Prove it is
  // readable before anything downstream — a caller, or the response cache — can
  // see it.
  assertUsableYouTubePayload(data, pathname);

  // Stamp the moment the bytes actually arrived, BEFORE the response enters the
  // in-memory cache. The marker rides inside the cached object, so a later cache
  // hit keeps reporting the original fetch time and re-indexing it cannot renew a
  // row's freshness lease (see VIDEO_FETCHED_AT in shared/index-store.js).
  //
  // Only `items` are stamped: those are the raw videos.list/search.list objects
  // that reach the index. Non-item payloads (channels, playlistItems, liveChat)
  // are never indexed, so there is nothing to mark.
  if (Array.isArray(data?.items)) {
    const fetchedAt = Date.now();

    for (const item of data.items) {
      markFetchedAt(item, fetchedAt);
    }
  }

  if (!options.skipCache) {
    cacheSet(cacheKey, result);
  }

  return result;
}

async function getVideoDetails(videoId, apiKey) {
  const result = await ytFetch(
    "videos",
    {
      part: VIDEO_PARTS_FULL,
      id: videoId
    },
    apiKey
  );

  return result.data?.items?.[0] || null;
}

async function searchYouTube(query, max, apiKey, pageToken, options = {}) {
  const filters = options.filters || {};
  const maxResults = resolveSearchMax(max);

  const params = {
    part: "snippet",
    type: "video",
    q: query,
    maxResults,
    ...filters
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  const searchResult = await ytFetch(
    "search",
    params,
    apiKey
  );

  const searchData = searchResult.data;

  const ids = (searchData?.items || [])
    .map(item => item?.id?.videoId)
    .filter(Boolean);

  let detailsById = new Map();

  if (ids.length) {
    const detailsResult = await ytFetch(
      "videos",
      {
        part: VIDEO_PARTS_FULL,
        id: ids.join(",")
      },
      apiKey
    );

    for (const item of detailsResult.data?.items || []) {
      if (item?.id) {
        detailsById.set(item.id, item);
      }
    }

    // Index what this search ALREADY paid for. Same videos.list response, no
    // extra request, and /api/search keeps answering from YouTube: this only
    // records metadata beside the response. Search itself is never answered from
    // the index in Phase 1.
    scheduleIndexWrite(options.index, [...detailsById.values()], {
      origin: INDEX_ORIGIN_SEARCH
    });
  }

  const normalized = [];

  for (const item of searchData?.items || []) {
    const id = item?.id?.videoId;

    if (!id) continue;

    const video = normalizeSearchItem(
      item,
      detailsById.get(id) || null
    );

    if (video) {
      normalized.push(video);
    }
  }

  // Real-data hygiene only: drop ids YouTube repeats across pages, and drop
  // videos that report `status.embeddable === false` because MyTube plays them in
  // an iframe and they could never start. No result is re-ordered here, so the
  // relevance YouTube returned is preserved exactly.
  const { videos, duplicatesRemoved, filteredCount } =
    dedupeSearchResults(normalized);

  return {
    videos,
    nextPageToken: searchData?.nextPageToken || "",
    // Additive metadata. Existing consumers ignore unknown fields.
    query,
    appliedFilters: filters,
    totalResultsEstimate: Number(searchData?.pageInfo?.totalResults || 0),
    duplicatesRemoved,
    filteredCount
  };
}

// =============================================================================
// HOMEPAGE FEED POOL
// =============================================================================
// The stock `videos.list?chart=mostPopular` is one static, region-scoped list of
// roughly 200 videos whose first page never changes — which is why refreshing
// MyTube used to show the same screenful every time. YouTube's chart API has no
// ordering, shuffle or seed parameter, so the variety has to come from MyTube.
//
// The pool below collects the same official chart for SEVERAL regions
// (1 quota unit each, verified disjoint in production) and the feed engine in
// shared/feed.js orders that pool with a per-refresh seed. Consequences:
//   * one pool build serves every visitor for FEED_POOL_TTL_MS,
//   * every refresh reshuffles real videos at zero extra quota,
//   * cursors walk a fixed permutation, so pages cannot overlap.
const FEED_POOL_CACHE_KEY = "mytube:feed:pool";
let feedPoolEntry = null;
let feedPoolInflight = null;

function pruneFeedPool() {
  const now = Date.now();

  for (const [key, value] of memoryCache) {
    if (key !== FEED_POOL_CACHE_KEY && now - value.time > CACHE_TTL) {
      memoryCache.delete(key);
    }
  }
}

function getCachedFeedPool() {
  const entry = feedPoolEntry;

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.at > FEED_POOL_TTL_MS) {
    feedPoolEntry = null;
    return null;
  }

  return entry.value;
}

// Fetch one region's chart page and normalize it, keeping the raw tags so a real
// topic label can be derived for each video (free — already in the response).
// The raw videos.list items are returned alongside (keyed by video id) purely so
// the pool build can index them without a second upstream call.
async function fetchFeedRegion(apiKey, region) {
  const result = await ytFetch(
    "videos",
    {
      part: VIDEO_PARTS_FULL,
      chart: "mostPopular",
      regionCode: region,
      maxResults: FEED_POOL_PAGE_SIZE
    },
    apiKey
  );

  const videos = [];
  const ids = new Set();
  const rawById = new Map();

  for (const item of result.data?.items || []) {
    const video = normalizeVideoItem(item);

    if (!video || ids.has(video.sourceId)) {
      continue;
    }

    ids.add(video.sourceId);
    rawById.set(video.sourceId, item);
    videos.push({
      ...video,
      topic: topicFromTags(item?.snippet?.tags)
    });
  }

  return { region, videos, ids, rawById };
}

async function buildFeedPool(apiKey, index) {
  const regions = await Promise.all(
    FEED_POOL_REGIONS.map(region =>
      fetchFeedRegion(apiKey, region).catch(() => ({
        region,
        videos: [],
        ids: new Set(),
        rawById: new Map()
      }))
    )
  );

  const items = [];
  const seen = new Set();
  const regionIds = {};

  // Metadata to index, grouped by the chart that contributed each video so a row
  // records the region it was actually observed in ("chart:PK", …).
  const rawById = new Map();
  const contributed = [];

  for (const entry of regions) {
    regionIds[entry.region] = entry.ids;

    const freshIds = [];

    for (const video of entry.videos) {
      if (seen.has(video.sourceId)) {
        continue;
      }

      seen.add(video.sourceId);
      items.push(video);

      const raw = entry.rawById?.get(video.sourceId);

      if (raw) {
        rawById.set(video.sourceId, raw);
        freshIds.push(video.sourceId);
      }
    }

    if (freshIds.length) {
      contributed.push({ region: entry.region, ids: freshIds });
    }
  }

  // Never hand back an empty feed: fall back to the primary region alone if every
  // multi-region build somehow failed.
  if (!items.length) {
    const fallbackRegion = FEED_POOL_REGIONS[0] || "US";
    const fallback = await fetchFeedRegion(
      apiKey,
      fallbackRegion
    ).catch(() => ({ videos: [], ids: new Set(), rawById: new Map() }));

    regionIds[fallbackRegion] = fallback.ids;
    items.push(...fallback.videos);

    const fallbackIds = [];

    for (const video of fallback.videos) {
      const raw = fallback.rawById?.get(video.sourceId);

      if (raw) {
        rawById.set(video.sourceId, raw);
        fallbackIds.push(video.sourceId);
      }
    }

    if (fallbackIds.length) {
      contributed.push({ region: fallbackRegion, ids: fallbackIds });
    }
  }

  // Index-only: the same chart payloads the pool was just built from. The feed
  // itself is still built by shared/feed.js from the same pool as before, so
  // refresh diversity, channel diversification and cursor pagination are
  // untouched — nothing about /api/trending's answers changes.
  //
  // Reduce write amplification: index a capped subset of unique videos from the
  // pool (e.g. first 200 unique videos encountered) rather than every video
  // from every region. This preserves diversified feed behavior while avoiding
  // 8 D1 batch calls for large pools.
  const MAX_TRENDING_INDEX = 200;
  const toIndex = [];
  // Build a deterministic order of unique videos to index (preserve encounter order)
  for (const group of contributed) {
    for (const id of group.ids) {
      if (toIndex.length >= MAX_TRENDING_INDEX) {
        break;
      }
      if (toIndex.some(x => x.id === id)) {
        continue;
      }
      const raw = rawById.get(id);
      if (raw) {
        toIndex.push({ id, raw, region: group.region });
      }
    }
    if (toIndex.length >= MAX_TRENDING_INDEX) {
      break;
    }
  }
  if (toIndex.length > 0) {
    scheduleIndexWrite(
      index,
      toIndex.map(x => x.raw),
      { origin: `${INDEX_ORIGIN_CHART_PREFIX}pool` }
    );
  }

  return {
    items,
    regionIds,
    topics: availableTopics(items)
  };
}

// One shared build for all concurrent callers: without this, a burst of page
// loads would each spend 8 quota units.
async function getFeedPool(apiKey, index) {
  const cached = getCachedFeedPool();

  if (cached) {
    return cached;
  }

  if (!feedPoolInflight) {
    feedPoolInflight = buildFeedPool(apiKey, index)
      .then(pool => {
        feedPoolEntry = { at: Date.now(), value: pool };
        pruneFeedPool();
        return pool;
      })
      .finally(() => {
        feedPoolInflight = null;
      });
  }

  return feedPoolInflight;
}

// GET /api/trending  (?max&seed&topic&region&pageToken)
//
// Contract is unchanged: `{ videos, nextPageToken }`. `pageToken` stays an opaque
// continuation string; it now carries the seed, offset, topic and pool version.
//
//   seed=""    deterministic pool order (what the sitemap generator and any
//              pre-existing caller sees — unchanged behaviour)
//   seed="..." seeded permutation, i.e. a different real feed per refresh
//
// `_t` is accepted as an alias for `seed`: MyTube's existing cache-buster. It
// never reached YouTube before (the upstream cache key is built from the YouTube
// URL), so the "bust the cache" button silently did nothing. It now genuinely
// changes the feed, and costs nothing.
async function getTrending(max, region, apiKey, pageToken, options = {}) {
  const pool = await getFeedPool(apiKey, options.index);

  let items = pool.items;
  const cursor = decodeFeedCursor(pageToken);

  // `region` keeps its original meaning — restrict the feed to one region's
  // chart, exactly like the previous single-chart implementation. It is optional:
  // with no region the feed spans the whole pool, which is the point of the pool.
  let requestedRegion = String(region || "").toUpperCase();

  if (requestedRegion && !pool.regionIds[requestedRegion]) {
    requestedRegion = "";
  }

  if (requestedRegion && !cursor) {
    const ids = pool.regionIds[requestedRegion] || new Set();
    items = items.filter(video => ids.has(video.sourceId));
  }

  const seed = options.seed !== undefined && options.seed !== null
    ? String(options.seed)
    : (cursor ? cursor.seed : "");

  const topic = options.topic !== undefined && options.topic !== null
    ? String(options.topic)
    : (cursor ? cursor.topic : "");

  const offset = cursor
    ? cursor.offset
    : Math.max(0, Number(options.offset) || 0);

  const page = buildFeedPage(items, {
    seed,
    topic,
    offset,
    size: Math.min(Math.max(Number(max) || 12, 1), 50)
  });

  return {
    ...page,
    // The topics actually present in this pool, most common first, so the
    // category bar shows real data instead of a hard-coded list.
    topics: pool.topics,
    regions: pool.regionIds
      ? Object.keys(pool.regionIds).filter(code => pool.regionIds[code]?.size)
      : [],
    requestedRegion: requestedRegion || ""
  };
}

async function getChannel(channelId, apiKey) {
  const result = await ytFetch(
    "channels",
    {
      part: "snippet,statistics",
      id: channelId
    },
    apiKey
  );

  return normalizeChannelResponse(result.data);
}

async function getComments(videoId, max, apiKey, pageToken) {
  const params = {
    part: "snippet",
    videoId,
    maxResults: Math.min(Math.max(Number(max) || 20, 1), 100),
    order: "relevance",
    textFormat: "plainText"
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  return normalizeCommentsResponse(
    (await ytFetch("commentThreads", params, apiKey)).data
  );
}

async function getRelated(videoId, max, apiKey, options = {}) {
  const target = await getVideoDetails(videoId, apiKey);

  if (!target) {
    return {
      videos: []
    };
  }

  // The target's full payload was just fetched for the channel lookup above.
  scheduleIndexWrite(options.index, [target], { origin: INDEX_ORIGIN_RELATED });

  const targetSnippet = target.snippet || {};
  const channelId = targetSnippet.channelId || "";

  const results = [];
  const seen = new Set([videoId]);

  if (channelId) {
    const sameChannel = await ytFetch(
      "search",
      {
        part: "snippet",
        type: "video",
        channelId,
        order: "date",
        maxResults: Math.min(
          Math.max(Number(max) || 12, 1),
          25
        )
      },
      apiKey
    );

    for (const item of sameChannel.data?.items || []) {
      const id = item?.id?.videoId;

      if (!id || seen.has(id)) continue;

      seen.add(id);

      results.push(
        normalizeSearchItem(item)
      );
    }
  }

  const ids = results
    .map(video => video?.sourceId)
    .filter(Boolean)
    .slice(0, 50);

  if (ids.length) {
    const details = await ytFetch(
      "videos",
      {
        part: VIDEO_PARTS_FULL,
        id: ids.join(",")
      },
      apiKey
    );

    const detailMap = new Map();

    for (const item of details.data?.items || []) {
      if (item?.id) {
        detailMap.set(item.id, item);
      }
    }

    // One batched write for the whole related set, from the videos.list response
    // this function already made.
    scheduleIndexWrite(options.index, [...detailMap.values()], {
      origin: INDEX_ORIGIN_RELATED
    });

    for (let i = 0; i < results.length; i++) {
      const detail = detailMap.get(results[i].sourceId);

      if (detail) {
        results[i] = normalizeVideoItem(detail);
      }
    }
  }

  return {
    videos: results.slice(0, Math.min(Number(max) || 12, 50))
  };
}

async function getChannelVideos(channelId, max, apiKey, pageToken, options = {}) {
  const maxResults = Math.min(
    Math.max(Number(max) || 8, 1),
    25
  );

  // Get the channel's uploads playlist.
  // This avoids the expensive YouTube Search API.
  const channelResult = await ytFetch(
    "channels",
    {
      part: "contentDetails",
      id: channelId
    },
    apiKey
  );

  const channelItem = channelResult.data?.items?.[0];
  const uploadsPlaylistId =
    channelItem?.contentDetails?.relatedPlaylists?.uploads || "";

  if (!uploadsPlaylistId) {
    return {
      videos: [],
      nextPageToken: ""
    };
  }

  // Get the latest videos from the uploads playlist.
  const playlistResult = await ytFetch(
    "playlistItems",
    {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults
    ,
      ...(pageToken ? { pageToken } : {})
    },
    apiKey
  );

  const playlistData = playlistResult.data;
  const ids = (playlistData?.items || [])
    .map(item => item?.contentDetails?.videoId)
    .filter(Boolean);

  if (!ids.length) {
    return {
      videos: [],
      nextPageToken: playlistData?.nextPageToken || ""
    };
  }

  // Fetch full video details so duration, views, likes, etc.
  // remain identical to the existing MyTube video shape.
  const detailsResult = await ytFetch(
    "videos",
    {
      part: VIDEO_PARTS_FULL,
      id: ids.join(",")
    },
    apiKey
  );

  const detailsById = new Map();

  for (const item of detailsResult.data?.items || []) {
    if (item?.id) {
      detailsById.set(item.id, item);
    }
  }

  // Batched write from the videos.list response this function already made.
  scheduleIndexWrite(options.index, [...detailsById.values()], {
    origin: INDEX_ORIGIN_CHANNEL
  });

  const videos = [];

  for (const item of playlistData?.items || []) {
    const id = item?.contentDetails?.videoId;

    if (!id) continue;

    const detail = detailsById.get(id);

    if (detail) {
      const video = normalizeVideoItem(detail);

      if (video) {
        videos.push(video);
      }
    } else {
      // Fallback to playlist snippet if the detailed video response
      // does not contain this item.
      const video = normalizeSearchItem({
        id: {
          videoId: id
        },
        snippet: item?.snippet || {}
      });

      if (video) {
        videos.push(video);
      }
    }
  }

  return {
    videos,
    nextPageToken: playlistData?.nextPageToken || ""
  };
}

// =============================================================================
// YOU TUBE LIVE CHAT (Phase 1 — read only)
// =============================================================================
// This is the REAL YouTube Live Chat for a currently-live broadcast. It is
// deliberately NOT a MyTube-owned chat: nothing here is stored in Firestore and
// no separate MyTube chat exists or is created.
//
// Design notes
// ------------
// 1. The client never sends a liveChatId. It sends a video id and we resolve the
//    activeLiveChatId server-side through the normal YouTube API integration, so
//    a caller cannot point this endpoint at somebody else's chat.
// 2. The generic 10-minute response cache is completely bypassed. Instead each
//    liveChatId gets ONE short-lived fan-out entry: many MyTube viewers watching
//    the same stream share a single upstream YouTube request. YouTube is polled
//    at most once every `pollingIntervalMillis` (YouTube's own instruction)
//    regardless of how many viewers are connected.
// 3. Polling errors back off exponentially so a broken stream or an API problem
//    cannot turn into a tight request loop.
// 4. Live chat polling gets its own rate-limit bucket. Periodic chat polling must
//    NOT consume the shared general API budget, or simply watching a live stream
//    would start returning 429 for search / trending / comments.
// =============================================================================

const LIVE_CHAT_POLL_FLOOR_MS = 3 * 1000;
const LIVE_CHAT_POLL_CEIL_MS = 10 * 1000;
const LIVE_CHAT_DEFAULT_INTERVAL_MS = 5000;
const LIVE_CHAT_BACKOFF_MIN_MS = 5 * 1000;
const LIVE_CHAT_BACKOFF_MAX_MS = 60 * 1000;
const LIVE_CHAT_MAX_ENTRIES = 24;
const LIVE_CHAT_HISTORY_LIMIT = 200;

// liveChatId -> fan-out entry
const liveChatEntries = new Map();

// Dedicated, generous rate limiter for live chat. Polling is periodic by nature
// (one request every few seconds per viewer), so this is sized for that instead
// of borrowing the 120-request/5-minute general budget. Abuse protection only:
// upstream cost is already bounded by the fan-out cache.
const LIVE_CHAT_RATE_WINDOW_MS = 60 * 1000;
const LIVE_CHAT_RATE_MAX_PER_WINDOW = 120;
const liveChatRateBuckets = new Map();

// Short-TTL cache of "is this video live right now". The generic 10-minute cache
// is far too slow here: a stream that has just started would otherwise stay
// hidden for up to ten minutes.
const LIVE_PROBE_TTL_MS = 30 * 1000;
const LIVE_PROBE_MAX_ENTRIES = 60;
const liveProbeCache = new Map();

function liveChatRateLimitAllowed(request) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = liveChatRateBuckets.get(ip) || { count: 0, windowStart: now };

  if (now - bucket.windowStart >= LIVE_CHAT_RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  liveChatRateBuckets.set(ip, bucket);

  if (liveChatRateBuckets.size > 5000) {
    for (const [key, entry] of liveChatRateBuckets) {
      if (now - entry.windowStart >= LIVE_CHAT_RATE_WINDOW_MS) {
        liveChatRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= LIVE_CHAT_RATE_MAX_PER_WINDOW;
}

function clampPollingInterval(value) {
  const interval = Number(value);

  if (!Number.isFinite(interval) || interval <= 0) {
    return LIVE_CHAT_DEFAULT_INTERVAL_MS;
  }

  return Math.min(
    Math.max(Math.round(interval), LIVE_CHAT_POLL_FLOOR_MS),
    LIVE_CHAT_POLL_CEIL_MS
  );
}

// Drop expired probe entries so a long-running isolate cannot grow without bound.
function pruneLiveProbeCache() {
  const now = Date.now();

  for (const [key, entry] of liveProbeCache) {
    if (now - entry.at >= LIVE_PROBE_TTL_MS) {
      liveProbeCache.delete(key);
    }
  }
}

// Resolve the CURRENT live state of a video through the official YouTube API.
// Cached for only LIVE_PROBE_TTL_MS so live/not-live transitions are picked up
// quickly. Falls back to the last known value if a transient error occurs, so a
// blip never hides a live panel that is working.
async function probeVideoLive(videoId, apiKey) {
  const now = Date.now();
  const cached = liveProbeCache.get(videoId);

  if (cached && now - cached.at < LIVE_PROBE_TTL_MS) {
    return cached.value;
  }

  let item = null;

  try {
    const result = await ytFetch(
      "videos",
      {
        part: "snippet,liveStreamingDetails",
        id: videoId
      },
      apiKey,
      { skipCache: true }
    );

    item = result.data?.items?.[0] || null;
  } catch (error) {
    if (cached) {
      return cached.value;
    }

    throw error;
  }

  const value = readLiveState(item);

  if (liveProbeCache.size >= LIVE_PROBE_MAX_ENTRIES) {
    pruneLiveProbeCache();
  }

  if (liveProbeCache.size >= LIVE_PROBE_MAX_ENTRIES) {
    const firstKey = liveProbeCache.keys().next().value;

    if (firstKey) {
      liveProbeCache.delete(firstKey);
    }
  }

  liveProbeCache.set(videoId, { at: now, value });

  return value;
}

// Fetch one upstream batch of live chat messages. Never touches the generic
// response cache. `pageToken` resumes the stream from where we left off, which is
// what keeps the returned batches disjoint (and therefore duplicate-free).
async function fetchLiveChatBatch(liveChatId, pageToken, apiKey) {
  const params = {
    part: "snippet,authorDetails",
    liveChatId,
    // YouTube's minimum for this endpoint is 200.
    maxResults: 200,
    profileImageSize: 88
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  const result = await ytFetch("liveChat/messages", params, apiKey, {
    skipCache: true
  });

  return normalizeLiveChatResponse(result.data);
}

function getLiveChatEntry(liveChatId) {
  let entry = liveChatEntries.get(liveChatId);

  if (entry) {
    return entry;
  }

  entry = {
    liveChatId,
    // Cursor owned by the SERVER so every viewer of a stream shares one chain of
    // upstream requests.
    nextPageToken: "",
    pollingIntervalMillis: LIVE_CHAT_DEFAULT_INTERVAL_MS,
    offlineAt: "",
    // Messages produced by the most recent upstream fetch (the delta).
    delta: [],
    // Bounded ring of the most recent messages, handed to a client's first call.
    history: [],
    activePoll: null,
    totalResults: 0,
    fetchCount: 0,
    failures: 0,
    backoffMs: 0,
    nextAllowedAt: 0,
    inflight: null,
    // True when the most recent poll was skipped because nextAllowedAt had not
    // been reached, i.e. no new upstream batch was retrieved for that caller.
    skippedLast: false,
    terminated: false,
    terminalStatus: "",
    lastError: ""
  };

  if (liveChatEntries.size >= LIVE_CHAT_MAX_ENTRIES) {
    for (const [key, value] of liveChatEntries) {
      if (!value.inflight && value !== entry) {
        liveChatEntries.delete(key);
        break;
      }
    }
  }

  liveChatEntries.set(liveChatId, entry);

  return entry;
}

// Run at most one upstream fetch per entry per pollingIntervalMillis. Concurrent
// callers share the same in-flight promise, so N simultaneous viewers => 1 call.
function refreshLiveChatEntry(entry, startPageToken, apiKey) {
  if (entry.inflight) {
    return entry.inflight;
  }

  const now = Date.now();

  if (now < entry.nextAllowedAt) {
    // Too soon to poll YouTube again. No new upstream batch was retrieved, so
    // the previous delta must NOT be handed back as if it were newly fetched.
    // The bounded history ring is deliberately left intact so a viewer joining
    // mid-stream can still be caught up (see getLiveChat).
    entry.skippedLast = true;
    return Promise.resolve();
  }

  entry.skippedLast = false;

  entry.inflight = (async () => {
    try {
      const normalized = await fetchLiveChatBatch(
        entry.liveChatId,
        startPageToken,
        apiKey
      );

      entry.failures = 0;
      entry.backoffMs = 0;
      entry.lastError = "";

      // The cursor advances server-side, so this batch is exactly the messages
      // that were not in the previous batch.
      entry.delta = normalized.messages;
      entry.history = entry.history.concat(normalized.messages);

      if (entry.history.length > LIVE_CHAT_HISTORY_LIMIT) {
        entry.history = entry.history.slice(-LIVE_CHAT_HISTORY_LIMIT);
      }

      entry.nextPageToken = normalized.nextPageToken;
      entry.pollingIntervalMillis = normalized.pollingIntervalMillis;
      entry.offlineAt = normalized.offlineAt;
      entry.activePoll = normalized.activePoll;
      entry.totalResults = normalized.totalResults;
      entry.fetchCount++;

      entry.nextAllowedAt =
        Date.now() + clampPollingInterval(normalized.pollingIntervalMillis);

      // `offlineAt` is YouTube's authoritative "the stream is over" signal.
      if (normalized.offlineAt) {
        entry.terminated = true;
        entry.terminalStatus = "ended";
      }
    } catch (error) {
      const type = error?.type || "";

      entry.delta = [];
      entry.lastError = String(error?.message || type || "unknown");

      if (type === "liveChatEnded") {
        entry.terminated = true;
        entry.terminalStatus = "ended";
      } else if (type === "liveChatDisabled") {
        entry.terminated = true;
        entry.terminalStatus = "disabled";
      } else if (type === "liveChatNotFound") {
        entry.terminated = true;
        entry.terminalStatus = "not_found";
      }

      // A terminal state is a normal end-of-life, not a failure to report.
      if (entry.terminated) {
        entry.lastError = "";
        entry.backoffMs = 0;
        entry.nextAllowedAt = Infinity;

        return;
      }

      // Exponential backoff, never tighter than YouTube's own polling interval.
      entry.failures++;

      const doubled = entry.backoffMs > 0 ? entry.backoffMs * 2 : 0;

      entry.backoffMs = Math.min(
        Math.max(doubled, LIVE_CHAT_BACKOFF_MIN_MS),
        LIVE_CHAT_BACKOFF_MAX_MS
      );

      entry.nextAllowedAt =
        Date.now() +
        Math.max(
          clampPollingInterval(entry.pollingIntervalMillis),
          entry.backoffMs
        );
    } finally {
      entry.inflight = null;
    }
  })();

  return entry.inflight;
}

// GET /api/liveChat?id=<videoId>[&pageToken=<token>][&initial=1]
//
// Returns the real YouTube Live Chat for a live broadcast. `initial=1` asks for
// the recent-message history instead of just the newest delta.
async function getLiveChat(videoId, apiKey, options = {}) {
  const live = await probeVideoLive(videoId, apiKey);

  // Shared (non-chat) response shape so the frontend can rely on one contract.
  const base = {
    isLive: live.isLive,
    liveChatId: live.liveChatId,
    concurrentViewers: live.concurrentViewers,
    messages: [],
    nextPageToken: "",
    pollingIntervalMillis: LIVE_CHAT_DEFAULT_INTERVAL_MS,
    offlineAt: live.actualEndTime || "",
    activePoll: null,
    status: "not_live",
    code: "",
    error: ""
  };

  if (!live.isLive) {
    return base;
  }

  // Live, but no active chat id: the broadcaster has chat turned off, or the
  // broadcast has not produced a chat yet.
  if (!live.liveChatId) {
    return {
      ...base,
      status: live.liveChatDisabled ? "disabled" : "no_chat"
    };
  }

  const entry = getLiveChatEntry(live.liveChatId);

  // Terminal states are sticky: once YouTube says the chat ended/disabled we
  // stop polling it entirely instead of re-hitting the API every interval.
  if (entry.terminated) {
    return {
      ...base,
      status: entry.terminalStatus || "ended",
      messages: entry.history.slice(),
      nextPageToken: entry.nextPageToken,
      pollingIntervalMillis: clampPollingInterval(entry.pollingIntervalMillis),
      offlineAt: entry.offlineAt,
      activePoll: entry.activePoll
    };
  }

  const hadState = entry.fetchCount > 0;

  await refreshLiveChatEntry(
    entry,
    // The SERVER-owned cursor drives every call after the first, so the upstream
    // batches are strictly disjoint and no message can be skipped. A client
    // token is honoured on that very first call only, to let a viewer resume a
    // chat the Worker happened to restart mid-stream. Once server state exists
    // the client value is ignored entirely and cannot corrupt the cursor.
    hadState ? entry.nextPageToken : (options.pageToken || ""),
    apiKey
  );

  // A skipped poll (still inside YouTube's pollingIntervalMillis) retrieved
  // nothing new, so report an empty delta rather than re-serving the previous
  // batch. A viewer joining a stream that is already being followed asks for
  // `initial`, and still gets the recent history so its panel is never empty.
  const fresh = !entry.skippedLast;
  const wantsHistory = !hadState || options.initial === true;

  const messages = wantsHistory
    ? entry.history.slice()
    : (fresh ? entry.delta.slice() : []);

  // Terminal states win over transient errors: once YouTube says the chat ended,
  // disabled or vanished we report that permanent state, never "error".
  const status = entry.terminated
    ? (entry.terminalStatus || "ended")
    : entry.lastError
      ? "error"
      : entry.offlineAt
        ? "ended"
        : "live";

  return {
    ...base,
    status,
    messages,
    nextPageToken: entry.nextPageToken,
    pollingIntervalMillis: clampPollingInterval(entry.pollingIntervalMillis),
    offlineAt: entry.offlineAt,
    activePoll: entry.activePoll,
    code: entry.lastError ? "LIVE_CHAT_UNAVAILABLE" : "",
    error: entry.lastError
      ? "Live chat is temporarily unavailable."
      : ""
  };
}

async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const apiKey = env.YOUTUBE_API_KEY || "";

  // Phase 1 index handle for this request, or null when the D1 binding is
  // absent/malformed. Null disables every read and write below; nothing else
  // changes.
  const index = createIndexContext(ctx, env);

  if (request.method === "OPTIONS") {
    const headers = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    };

    if (originAllowed(request)) {
      headers["Access-Control-Allow-Origin"] = request.headers.get("Origin");
      headers["Vary"] = "Origin";
    }

    return new Response(null, {
      status: 204,
      headers
    });
  }

  if (request.method !== "GET") {
    return json(
      {
        error: "Method not allowed."
      },
      405,
      request
    );
  }

  // Live chat polling is periodic by design, so it is metered by its own
  // dedicated limiter (see liveChatRateLimitAllowed) and must NOT spend the
  // shared general budget — otherwise simply watching a live stream would start
  // returning 429 for search / trending / comments.
  if (route !== "liveChat" && !rateLimitAllowed(request)) {
    return json(
      {
        error: "Too many requests. Please slow down and try again shortly.",
        code: "RATE_LIMITED"
      },
      429,
      request
    );
  }

  try {
    if (route === "ping") {
      return json(
        {
          ok: true,
          service: "mytube-youtube-api",
          configured: Boolean(apiKey)
        },
        200,
        request
      );
    }

    if (route === "search") {
      const rawQuery = url.searchParams.get("q");
      // Normalize once, server-side: collapse whitespace/strip invisible marks and
      // cap the length. Casing is preserved — that is what YouTube should receive.
      // The normalized form is also the cache key, so trivial variations of the
      // same query reuse one cached response instead of spending 100 units twice.
      const q = normalizeQuery(rawQuery);

      if (!q) {
        return json(
          {
            videos: [],
            error: "Search query is required."
          },
          400,
          request
        );
      }

      const max = url.searchParams.get("max") || "50";
      const pageToken = url.searchParams.get("pageToken") || "";

      // search.list is 100 units per call, so it is metered separately from the
      // general limiter (see searchRateLimitAllowed).
      if (!searchRateLimitAllowed(request)) {
        return json(
          {
            videos: [],
            code: "SEARCH_RATE_LIMITED",
            error: "Too many searches. Please wait a moment and try again."
          },
          429,
          request
        );
      }

      // Optional real YouTube filters (sort / duration / upload date / category /
      // region / language / safeSearch / embeddable). Unsupported values are
      // dropped rather than forwarded, since YouTube answers HTTP 400 for those.
      const { searchParams, applied } = resolveSearchFilters(url.searchParams);

      const result = await searchYouTube(
        q,
        max,
        apiKey,
        pageToken,
        { filters: searchParams, index }
      );

      // Still YouTube-backed: the index records this search's metadata but never
      // answers one. No local search parity is claimed in Phase 1.
      return json({ ...result, appliedFilters: applied }, 200, request, indexHeaders("youtube"));
    }

    if (route === "trending") {
      const max = url.searchParams.get("max") || "12";
      // Optional: only set when a caller explicitly wants one region's chart.
      const region = url.searchParams.get("region") || "";
      const pageToken = url.searchParams.get("pageToken") || "";
      // `seed` (or the legacy `_t` alias) picks one ordering of the pool. A fresh
      // seed per page load is what makes consecutive refreshes show different
      // real videos; omitting it keeps the previous deterministic behaviour.
      const rawSeed = url.searchParams.get("seed") || url.searchParams.get("_t");
      const topic = url.searchParams.get("topic") || "";

      const result = await getTrending(
        max,
        region,
        apiKey,
        pageToken,
        { seed: rawSeed, topic, index }
      );

      // Feed construction is unchanged and stays YouTube-backed; the pool build
      // only writes to the index.
      return json(result, 200, request, indexHeaders("youtube"));
    }

    if (route === "video") {
      const id = url.searchParams.get("id")?.trim();

      if (!id) {
        return json(
          {
            video: null,
            error: "Video id is required."
          },
          400,
          request
        );
      }

      // Index first, YouTube second. A miss, a stale row, a live row or a failed
      // D1 read all fall through to exactly the path this route used before, and
      // an index hit spends NO upstream quota at all.
      const indexed = await readIndexedVideo(index, id);

      if (indexed.video) {
        return json(
          {
            video: indexed.video
          },
          200,
          request,
          indexHeaders("index", indexed.degraded)
        );
      }

      const item = await getVideoDetails(
        id,
        apiKey
      );

      // YouTube returns an empty list (not an error) for a video id that has
      // been removed or never existed. Translate that into a clean 404 — the
      // watch page treats HTTP 404 as the "video unavailable" state.
      if (!item) {
        return json(
          {
            video: null
          },
          404,
          request,
          indexHeaders(indexed.degraded ? "fallback" : "youtube", indexed.degraded)
        );
      }

      // Write-behind: the response is built from the payload already in hand, so
      // indexing never delays it and never adds a YouTube request.
      scheduleIndexWrite(index, [item], { origin: INDEX_ORIGIN_DETAIL });

      return json(
        {
          video: normalizeVideoItem(item)
        },
        200,
        request,
        indexHeaders(indexed.degraded ? "fallback" : "youtube", indexed.degraded)
      );
    }

    if (route === "channel") {
      const id = url.searchParams.get("id")?.trim();

      if (!id) {
        return json(
          {
            channel: null,
            error: "Channel id is required."
          },
          400,
          request
        );
      }

      const result = await getChannel(
        id,
        apiKey
      );

      return json(result, 200, request);
    }

    if (route === "comments") {
      const id = url.searchParams.get("id")?.trim();

      if (!id) {
        return json(
          {
            comments: [],
            error: "Video id is required."
          },
          400,
          request
        );
      }

      const max = url.searchParams.get("max") || "20";
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await getComments(
        id,
        max,
        apiKey,
        pageToken
      );

      return json(result, 200, request);
    }

    if (route === "liveChat") {
      const id = url.searchParams.get("id")?.trim();

      if (!id) {
        return json(
          {
            messages: [],
            status: "not_live",
            error: "Video id is required."
          },
          400,
          request
        );
      }

      // Live chat uses its own limiter: periodic chat polling must never eat the
      // shared general API budget used by search / trending / comments.
      if (!liveChatRateLimitAllowed(request)) {
        return json(
          {
            messages: [],
            status: "error",
            code: "RATE_LIMITED",
            error: "Too many live chat requests. Please slow down."
          },
          429,
          request
        );
      }

      const result = await getLiveChat(id, apiKey, {
        pageToken: url.searchParams.get("pageToken") || "",
        initial: url.searchParams.get("initial") === "1"
      });

      return json(result, 200, request);
    }

    if (route === "related") {
      const id = url.searchParams.get("id")?.trim();

      if (!id) {
        return json(
          {
            videos: [],
            error: "Video id is required."
          },
          400,
          request
        );
      }

      const max = url.searchParams.get("max") || "12";

      const result = await getRelated(
        id,
        max,
        apiKey,
        { index }
      );

      return json(result, 200, request, indexHeaders("youtube"));
    }

    if (route === "channelVideos") {
      const channelId = url.searchParams.get("channelId")?.trim();

      if (!channelId) {
        return json(
          {
            videos: [],
            error: "Channel ID is required."
          },
          400,
          request
        );
      }

      const max = url.searchParams.get("max") || "8";
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await getChannelVideos(
        channelId,
        max,
        apiKey,
        pageToken,
        { index }
      );

      return json(result, 200, request, indexHeaders("youtube"));
    }

    return json(
      {
        error: "API route not found."
      },
      404,
      request
    );
  } catch (error) {
    const status = Number(error?.status) || 500;

    return json(
      normalizeError(error, status),
      status,
      request
    );
  }
}

// -----------------------------------------------------------------------------
// WATCH PAGE SEO — server-rendered metadata for /watch (and /watch.html alias)
// -----------------------------------------------------------------------------
// Before this section, worker.js sent every non-/api/ request straight to the
// static ASSETS binding, so public/watch.html was delivered byte-for-byte. That
// made EVERY /watch?id=... URL ship the same generic head: title "Watch -
// MyTube", description "Watch videos on MyTube", and a canonical of
// https://mytube.farqas007.workers.dev/watch — a canonical with no `?id=` at
// all, which points every watch URL in the sitemap at one single page. The real
// per-video metadata only ever appeared when watch.js rewrote the head after the
// browser had already fetched /api/video.
//
// This section moves that rewrite to the server. It changes NOTHING about the
// page itself: public/watch.html is still the application shell that is served,
// with the same markup, the same element ids and the same script tags. Only the
// values inside <head> are filled in, and only from real video metadata.
//
// Rules this block keeps:
//
//   * No fabricated metadata. A title, description or thumbnail is only ever
//     written when it came out of the index or out of YouTube. Anything missing
//     keeps whatever the shell already said.
//   * Never marks an unknown page indexable. An id that is absent, malformed, or
//     authoritatively gone from YouTube gets `noindex, follow` — which is the
//     same verdict watch.js's renderErrorState() reaches a moment later, applied
//     earlier. A *transient* failure (D1 down, network, quota) is NOT treated as
//     proof of absence: the shell is served untouched and the client decides.
//   * Adds no upstream cost beyond the index-first lookup /api/video already
//     performs, and is metered by its own bucket so a crawler can never spend
//     the general budget the browser's own /api/video call needs.
//   * No API key ever reaches the HTML: only the normalized video DTO is used.
// -----------------------------------------------------------------------------

// The absolute origin every canonical/og:url is built from.
//
// This is intentionally the same literal the rest of the repository already
// hardcodes (public/watch.js WATCH_ORIGIN, scripts/generate-sitemap.mjs ORIGIN,
// the homepage canonical and public/robots.txt). Sitemap URL and canonical URL
// have to be byte-identical strings, so they must be derived the same way.
const WATCH_ORIGIN = "https://mytube.farqas007.workers.dev";

// The one canonical form of a watch URL, in one place.
//
// `encodeURIComponent("yt:<sourceId>")` is the encoding convention shared with
// public/watch.js (setVideoPageMeta) and scripts/generate-sitemap.mjs (watchUrl).
// Keep all three identical or the sitemap and the page disagree again.
function setVideoCanonical(videoId) {
  return `${WATCH_ORIGIN}/watch?id=${encodeURIComponent(videoId)}`;
}

// A YouTube video id is always exactly 11 URL-safe base64 characters.
// Mirrors YT_VIDEO_ID_RE in public/watch.js.
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Canonicalize a raw `?id=` value the same way public/watch.js does, so the
// server and the client can never disagree about which video a URL is for.
//
//   ""                     -> ""                       (no video)
//   "yt:<id>"              -> unchanged                (already canonical)
//   "<11-char video id>"   -> "yt:<id>"                (bare-id shorthand)
//   anything else          -> unchanged                (invalid; stays invalid)
function normalizeWatchId(raw) {
  const value = String(raw === null || raw === undefined ? "" : raw).trim();

  if (!value || value.startsWith(VIDEO_SOURCE_PREFIX)) {
    return value;
  }

  return YT_VIDEO_ID_RE.test(value) ? VIDEO_SOURCE_PREFIX + value : value;
}

// A watch URL is only rendered server-side when it actually identifies a YouTube
// video. An id that is absent, un-namespaced-but-invalid, or a `yt:` prefix with
// something that is not a video id is left for the client to report as not
// found — the Worker never spends an upstream request proving a string is junk.
function watchSourceId(videoId) {
  if (!videoId || !videoId.startsWith(VIDEO_SOURCE_PREFIX)) {
    return "";
  }

  const sourceId = videoId.slice(VIDEO_SOURCE_PREFIX.length).trim();

  return YT_VIDEO_ID_RE.test(sourceId) ? sourceId : "";
}

// Dedicated budget for the server-rendered watch head.
//
// The lookup is index-first, so it normally costs nothing, but an index miss
// falls through to the same videos.list call /api/video makes. It therefore gets
// its own bucket — exactly like search.list and live chat — so a crawler walking
// the sitemap can never exhaust the 120-request/5-minute general budget that the
// browser's own /api/video request spends. Being refused here is not an error:
// the plain shell is served unchanged and the client hydrates it as before.
const WATCH_SEO_RATE_WINDOW_MS = 5 * 60 * 1000;
const WATCH_SEO_RATE_MAX_PER_WINDOW = 60;
const watchSeoRateBuckets = new Map();

function watchSeoRateLimitAllowed(request) {
  const ip = clientIp(request);
  const now = Date.now();
  const bucket = watchSeoRateBuckets.get(ip) || { count: 0, windowStart: now };

  if (now - bucket.windowStart >= WATCH_SEO_RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  watchSeoRateBuckets.set(ip, bucket);

  if (watchSeoRateBuckets.size > 5000) {
    for (const [key, entry] of watchSeoRateBuckets) {
      if (now - entry.windowStart >= WATCH_SEO_RATE_WINDOW_MS) {
        watchSeoRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= WATCH_SEO_RATE_MAX_PER_WINDOW;
}

// Resolve the metadata for one watch URL.
//
//   ok          real metadata; `video` is the same DTO /api/video returns
//   missing     YouTube authoritatively has no such video (empty items list).
//               The same condition /api/video reports as HTTP 404.
//   unavailable we could not find out right now (no D1 + no API key, network
//               error, quota, unreadable upstream body). Says nothing about the
//               video's existence, so it must never be treated as `missing`.
//
// Index-first, then YouTube — the identical order and the identical write-behind
// call /api/video uses, so a watch page render warms the index for free and the
// browser's own /api/video call afterwards normally costs no quota at all.
async function resolveWatchVideo(index, sourceId, apiKey) {
  const indexed = await readIndexedVideo(index, sourceId);

  if (indexed.video) {
    return { status: "ok", video: indexed.video };
  }

  let item;

  try {
    item = await getVideoDetails(sourceId, apiKey);
  } catch (error) {
    console.error(
      "[mytube] watch metadata lookup failed",
      error?.message || error
    );

    return { status: "unavailable", video: null };
  }

  // YouTube answers a removed/never-existing id with an empty list rather than
  // an error (see the identical branch in the /api/video route).
  if (!item) {
    return { status: "missing", video: null };
  }

  scheduleIndexWrite(index, [item], { origin: INDEX_ORIGIN_DETAIL });

  return { status: "ok", video: normalizeVideoItem(item) };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rewrite the content="..." of the <meta> tag carrying `attrName="attrValue"`.
//
// `watch.html` writes `name=`/`property=` before `content=` on every SEO tag, so
// that ordering is what the pattern anchors on. The value is passed through a
// replacer function rather than a `$1`-style template so a title containing `$&`
// or `$1` can never be interpreted as a backreference.
//
// Returns the html untouched when the tag is absent, so a future edit to
// watch.html degrades to "no server-side metadata" instead of a broken page.
function setMetaContent(html, attrName, attrValue, content) {
  const pattern = new RegExp(
    `(<meta\\b[^>]*\\b${escapeRegExp(attrName)}="${escapeRegExp(attrValue)}"[^>]*\\bcontent=")[^"]*(")`,
    "i"
  );

  if (!pattern.test(html)) {
    return html;
  }

  return html.replace(
    pattern,
    (match, open, close) => `${open}${content}${close}`
  );
}

// Same idea for <link ... id="pageCanonical" href="...">, the single canonical
// element watch.js also reuses (it never adds a second one).
function setCanonicalHref(html, href) {
  const pattern = /(<link\b[^>]*\bid="pageCanonical"[^>]*\bhref=")[^"]*(")/i;

  if (!pattern.test(html)) {
    return html;
  }

  return html.replace(
    pattern,
    (match, open, close) => `${open}${href}${close}`
  );
}

// Replace the <title> element's text.
//
// The replacement is passed as a replacer FUNCTION, never as a string: a title
// containing `$&` (or `$1`) would otherwise be expanded as a replacement
// pattern and splice the matched shell title back into the middle of it,
// corrupting the element. Real video titles do contain `$`.
function setTitleText(html, title) {
  const pattern = /<title>[\s\S]*?<\/title>/i;

  if (!pattern.test(html)) {
    return html;
  }

  return html.replace(pattern, () => `<title>${title}</title>`);
}

// Description cap. Matches the 160 characters public/watch.js
// (setPageMetaDescription) already applies, so the server-rendered head and the
// client-updated head stay byte-identical instead of oscillating.
const WATCH_META_DESCRIPTION_MAX = 160;

function watchDescription(video) {
  const description = String(video?.description || "").trim();

  return description ? description.slice(0, WATCH_META_DESCRIPTION_MAX) : "";
}

// Only a real absolute http(s) URL is ever written into og:image. YouTube's
// thumbnail picker always yields one, but an index row written before the column
// existed could be empty, and an empty og:image is worse than the shell's own
// site icon.
function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value));

    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// Rewrite <head> for a video that is known to exist.
//
// Every value written here is either the shell's existing value or real metadata
// from the index/YouTube. The title suffix, the description cap and the
// canonical format all match public/watch.js, so when watch.js re-applies the
// same values after hydration it is writing back exactly what is already there.
function renderWatchSeoHtml(html, video, videoId) {
  const title = String(video.title || "").trim();
  const description = watchDescription(video);
  const canonical = setVideoCanonical(videoId);

  let out = setCanonicalHref(html, canonical);
  out = setMetaContent(out, "property", "og:url", canonical);

  if (title) {
    const fullTitle = `${title} - MyTube`;

    out = setTitleText(out, escapeHtml(fullTitle));
    out = setMetaContent(out, "property", "og:title", escapeHtml(fullTitle));
    out = setMetaContent(out, "name", "twitter:title", escapeHtml(fullTitle));
  }

  if (description) {
    const escaped = escapeHtml(description);

    out = setMetaContent(out, "name", "description", escaped);
    out = setMetaContent(out, "property", "og:description", escaped);
    out = setMetaContent(out, "name", "twitter:description", escaped);
  }

  if (isHttpUrl(video.thumb)) {
    const thumb = escapeHtml(video.thumb);

    out = setMetaContent(out, "property", "og:image", thumb);
    // The shell ships `og:image:alt` = "MyTube", which would misdescribe a
    // video thumbnail once one is set.
    out = setMetaContent(
      out,
      "property",
      "og:image:alt",
      title ? escapeHtml(title) : "MyTube"
    );
  }

  return out;
}

// Keep a page that is definitionally not a video out of the index.
//
// Only the robots tag changes: no title, description, canonical or og value is
// invented, and the client-side error panel renders exactly as it does today.
function renderWatchNoIndexHtml(html) {
  return setMetaContent(html, "name", "robots", "noindex, follow");
}

// The SSR head is a point-in-time snapshot, so it gets the same 5-minute edge
// lifetime as the D1 index TTL (VIDEO_INDEX_TTL_MS) and may be served stale while
// it revalidates.
const WATCH_HTML_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

// A DEGRADED render — an exhausted rate budget, or a lookup that could not
// complete (quota, dead D1, upstream timeout) — answers with the untouched
// generic shell. That shell is not a valid head for a video URL: its canonical
// is `.../watch` with no `?id=` at all, so storing it would pin every watch URL
// to one generic page for the whole s-maxage window even after the upstream
// recovers. `no-store` keeps a bad minute from becoming five minutes of lost
// per-video metadata.
//
// Note what is deliberately NOT changed here. `noindex` is still not applied:
// a transient failure is not evidence that the video is gone, and the client
// reaches the correct verdict on hydration. An authoritative "video unavailable"
// is a different branch (renderWatchNoIndexHtml) and keeps its own caching.
//
// The body is the shell byte for byte, so its ETag still describes it and is
// deliberately left in place; only cacheability changes.
const WATCH_DEGRADED_CACHE_CONTROL = "no-store";

function watchDegradedShellResponse(shell) {
  const headers = new Headers(shell.headers);

  headers.set("Cache-Control", WATCH_DEGRADED_CACHE_CONTROL);

  return new Response(shell.body, {
    status: shell.status,
    statusText: shell.statusText,
    headers
  });
}

// Rebuild the asset response around a modified body.
//
// The shell's own headers are kept so the page's header surface stays exactly
// what the static binding produced. Content-Encoding/Content-Length/ETag are
// dropped because the bytes no longer match the asset that was read. Note this
// response deliberately does NOT pass through withSecurityHeaders(): the watch
// page is currently served by the ASSETS binding and never receives that header
// set, and applying CSP to it for the first time would newly restrict the
// Firebase module graph the page loads (watch.js -> firebase.js). Changing the
// page's security posture is not this change's job.
function watchHtmlResponse(shell, html) {
  const headers = new Headers(shell.headers);

  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", WATCH_HTML_CACHE_CONTROL);

  return new Response(html, {
    status: shell.status,
    statusText: shell.statusText,
    headers
  });
}

// GET /watch (the URL the sitemap, the homepage and watch.js itself all use).
async function handleWatchPage(request, env, ctx, url) {
  // Non-GET/HEAD is not ours to interpret — hand it to the asset binding.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return env.ASSETS.fetch(request);
  }

  const videoId = normalizeWatchId(url.searchParams.get("id"));
  const sourceId = watchSourceId(videoId);

  // The shell is always requested by its real asset path rather than by `/watch`.
  // That keeps this handler independent of the static binding's html_handling
  // setting, and it is fetched with a clean header set so a conditional request
  // can never come back as a bodiless 304.
  const shell = await env.ASSETS.fetch(
    new Request(`${url.origin}/watch.html`, { method: "GET" })
  );

  if (!shell.ok) {
    return shell;
  }

  // Nothing renderable to work with (no id, or an id that is not a YouTube
  // video). Say noindex and stop: this is the bare-`/watch` soft-404 case.
  if (!sourceId) {
    return watchHtmlResponse(shell, renderWatchNoIndexHtml(await shell.text()));
  }

  // Over budget: answer from the shell, unchanged and still indexable, exactly
  // as if this section did not exist. The client hydrates it as before. It is a
  // degraded render, so it must not be stored at the CDN.
  if (!watchSeoRateLimitAllowed(request)) {
    return watchDegradedShellResponse(shell);
  }

  const index = createIndexContext(ctx, env);
  const resolved = await resolveWatchVideo(index, sourceId, env.YOUTUBE_API_KEY || "");

  // We could not find out. Serve the shell exactly as it is — no metadata, and
  // crucially no `noindex`, because a quota error or a dead D1 is not evidence
  // that the video is gone. Not stored at the CDN, so the next request retries
  // instead of replaying the generic head.
  //
  // Checked BEFORE the body is read, because this branch hands back the shell's
  // own unread body rather than a rewritten copy.
  if (resolved.status === "unavailable") {
    return watchDegradedShellResponse(shell);
  }

  const html = await shell.text();

  // Authoritatively gone from YouTube: the same verdict the client reaches, and
  // the same one /api/video reports as 404. Still no fabricated metadata.
  if (resolved.status === "missing") {
    return watchHtmlResponse(shell, renderWatchNoIndexHtml(html));
  }

  return watchHtmlResponse(shell, renderWatchSeoHtml(html, resolved.video, videoId));
}

// GET /watch.html?id=... -> 301 GET /watch?id=...
//
// watch.html is the file on disk, so the static binding serves it as a second,
// fully indexable URL for the exact same video. That is the duplicate-URL half
// of the watch canonical problem, so it is collapsed here rather than left to a
// client-side canonical that may never be executed.
//
// Only the path changes, so this can never loop: `/watch` is rendered by
// handleWatchPage and always answers 200/304, never a redirect. The `id` value is
// re-serialized through URLSearchParams, which percent-encodes the `yt:` colon
// exactly as watch.js and the sitemap generator do, so the redirect target is the
// canonical URL string and not merely an equivalent one.
function handleWatchHtml(url) {
  const target = new URL(`${url.origin}/watch`);

  for (const [key, value] of url.searchParams) {
    if (key === "id") {
      continue;
    }

    target.searchParams.append(key, value);
  }

  const videoId = normalizeWatchId(url.searchParams.get("id"));

  if (videoId) {
    target.searchParams.set("id", videoId);
  }

  return new Response(null, {
    status: 301,
    headers: {
      Location: `${target.pathname}${target.search}`,
      "Cache-Control": "public, max-age=3600"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The two watch routes answer for themselves and return early: the watch
    // HTML deliberately keeps the header surface the static ASSETS binding gives
    // it, so it must not be run through withSecurityHeaders() (see the section
    // comment above). Anything else — /api/* and every other asset — is
    // completely unchanged.
    if (url.pathname === "/watch") {
      return handleWatchPage(request, env, ctx, url);
    }

    if (url.pathname === "/watch.html") {
      return handleWatchHtml(url);
    }

    const response = url.pathname.startsWith("/api/")
      ? await handleAPI(request, env, ctx)
      : await env.ASSETS.fetch(request);

    return withSecurityHeaders(response);
  },

  // Cloudflare dispatches the cron trigger to the module's `scheduled`
  // handler. It is a no-op when the D1 binding is absent or malformed, so a
  // missing index can never turn a cron tick into an error loop.
  scheduled
};

// -----------------------------------------------------------------------------
// D1 INDEX MAINTENANCE (Scheduled Event) — retention/revalidation
// -----------------------------------------------------------------------------
// Cloudflare Worker Scheduled Event handler, wired to the cron `0 */6 * * *`
// (every 6 hours). It enforces the official YouTube 30-calendar-day retention
// rule for Non-Authorized API Data: rows whose metadata is approaching the
// limit are refreshed against the current YouTube data, and rows that YouTube
// definitively reports as unavailable are deleted.
//
// Boundaries this handler deliberately keeps:
//   * fetch() behavior, read-through /api/video TTL (VIDEO_INDEX_TTL_MS = 6
//     minutes) and the feed/search architecture are untouched. 6 minutes is a
//     serving freshness rule; 30 days is a retention rule. They never share
//     state.
//   * It reuses ONLY existing columns (metadata_fetched_at_ms,
//     last_seen_at_ms, refresh_priority) and existing indexes
//     (idx_videos_metadata_fetched_at_ms). No migration is required.
//   * index_state stores one lightweight run summary plus the pending-deletion
//     tombstones described below. No queue, no schema change.
//   * At most MAINTENANCE_MAX_VIDEOS_PER_RUN (20) videos are requested per run
//     and at most MAINTENANCE_MAX_YT_REQUESTS_PER_RUN (1) upstream request is
//     made. Both go through helpers that enforce the cap in code, so the bound
//     is a property of the handler rather than a comment about it. A run never
//     storms.
//   * A missing/malformed binding makes the handler a no-op.
//   * A transient upstream failure NEVER deletes a row; the next run retries
//     it because candidates are always selected oldest-first.
//   * A row is deleted only after TWO separate authoritative runs report its
//     video as gone — the first miss writes a tombstone to index_state, the
//     second consumes it — and only out of a response that is provably a real
//     videos.list. A single ambiguous 200 (an HTML page, a truncated body, a
//     200 with no list in it at all) can no longer empty the table.
const MAINTENANCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAINTENANCE_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_MAX_VIDEOS_PER_RUN = 20;
const MAINTENANCE_MAX_YT_REQUESTS_PER_RUN = 1;
const MAINTENANCE_STATE_KEY = "maintenance:last_run";

// Rows scanned per run before candidates are collapsed to distinct video ids.
// One id can back more than one row (video_id is deliberately NOT unique — see
// 0002_video_id_lookup_index.sql), so scanning only
// MAINTENANCE_MAX_VIDEOS_PER_RUN rows would let duplicates shrink a run below
// its request budget. The scan is a single indexed query and only the first
// MAINTENANCE_MAX_VIDEOS_PER_RUN ids are ever sent upstream.
const MAINTENANCE_CANDIDATE_SCAN_MULTIPLIER = 4;

// Pending deletions live in index_state until a second run confirms them or they
// expire. The expiry is what stops a strike that is never re-checked (its id
// fell out of the oldest-first window behind newer backlog) from being applied
// to some row weeks later.
const MAINTENANCE_MISS_STATE_KEY = "maintenance:pending_misses";
const MAINTENANCE_MISS_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_MISS_TOMBSTONE_MAX = 200;

// D1's documented budget is 50 subrequests per invocation and 20 rows cannot
// need more than one chunk. The chunking is explicit anyway, so raising either
// constant later cannot quietly turn one run into 20 sequential round trips.
const MAINTENANCE_DELETE_CHUNK_SIZE = 50;

// The exact `kind` of the one list response this handler will read "this video
// no longer exists" out of. Every other 2xx shape — an HTML error page, a
// truncated body, a search.list reply, a 200 carrying no list at all — is a
// non-answer, and a non-answer never deletes.
const YT_VIDEO_LIST_KIND = "youtube#videoListResponse";

const MAINTENANCE_DELETE_SQL = "DELETE FROM videos WHERE source_id = ?";

// A duplicated id's non-canonical rows are not touched by the upsert (it keys
// on source_id), so they are renewed explicitly. Without this they would keep
// their old metadata_fetched_at_ms and stay pinned to the head of the
// oldest-first window, which is how one duplicated id can starve every row
// behind it.
const MAINTENANCE_RENEW_SQL =
  "UPDATE videos SET metadata_fetched_at_ms = ?, last_seen_at_ms = ? WHERE source_id = ?";

// Read-only view of the maintenance policy, for tests/testMaintenance.js.
//
// These values used to be named exports, but a Worker module may only export
// functions and classes: workerd aborts at load time with "Incorrect type for map
// entry ... not of type function or ExportedHandler" if any named export is a
// plain value, which made `wrangler dev` fail to start on this file alone.
// Exposing them through a function keeps the exact values assertable — the tests
// still pin 30-day retention, the 20/1 per-run caps and the exact
// videos.listResponse kind — without a single non-function export.
//
// This is a getter. It is read by tests only; no handler calls it, so the
// maintenance behaviour is unchanged.
function maintenanceConfig() {
  return {
    retentionMs: MAINTENANCE_RETENTION_MS,
    refreshWindowMs: MAINTENANCE_REFRESH_WINDOW_MS,
    maxVideosPerRun: MAINTENANCE_MAX_VIDEOS_PER_RUN,
    maxYtRequestsPerRun: MAINTENANCE_MAX_YT_REQUESTS_PER_RUN,
    missStateKey: MAINTENANCE_MISS_STATE_KEY,
    missTombstoneMs: MAINTENANCE_MISS_TOMBSTONE_MS,
    missTombstoneMax: MAINTENANCE_MISS_TOMBSTONE_MAX,
    deleteSql: MAINTENANCE_DELETE_SQL,
    videoListKind: YT_VIDEO_LIST_KIND
  };
}

function createMaintenanceIndexContext(env) {
  const db = env?.mytube_index;

  if (!db || typeof db.prepare !== "function") {
    return null;
  }

  return { db };
}

async function recordMaintenanceRun(index, summary) {
  if (!index) {
    return;
  }

  try {
    await index.db
      .prepare(
        "INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms"
      )
      .bind(MAINTENANCE_STATE_KEY, JSON.stringify(summary), Date.now())
      .run();
  } catch (error) {
    console.error("[mytube] D1 maintenance bookkeeping failed", error?.message || error);
  }
}

// Oldest rows first, live rows and non-YouTube rows excluded, then keep only
// rows inside the refresh window of the 30-day limit. Oldest-first ordering is
// what makes a failed run resume safely: the next run re-selects from the same
// head of the list, so no state/cursor is needed.
async function selectMaintenanceCandidates(index, now) {
  const result = await index.db
    .prepare(
      "SELECT source_id, video_id, metadata_fetched_at_ms FROM videos " +
      "WHERE type = ? AND is_live != 1 " +
      "ORDER BY metadata_fetched_at_ms ASC LIMIT ?"
    )
    .bind(
      VIDEO_TYPE_YOUTUBE,
      MAINTENANCE_MAX_VIDEOS_PER_RUN * MAINTENANCE_CANDIDATE_SCAN_MULTIPLIER
    )
    .all();

  if (!result || !Array.isArray(result.results)) {
    throw new Error("maintenance: candidate selection received no result set");
  }

  const threshold = now - (MAINTENANCE_RETENTION_MS - MAINTENANCE_REFRESH_WINDOW_MS);
  const due = [];

  for (const row of result.results) {
    const fetchedAt = Number(row.metadata_fetched_at_ms);

    if (!Number.isFinite(fetchedAt)) {
      continue;
    }

    if (fetchedAt <= threshold) {
      due.push(row);
    }
  }

  return due;
}

// The only response shape from which "this video no longer exists" may be read.
//
// Three separate things have to hold, and each one rules out a real failure mode
// this handler used to be vulnerable to:
//   * `kind` is exactly the videos.list kind — a reply from a different list
//     endpoint is not an answer about these ids.
//   * `items` is present and is an array — an empty list is a real answer, a
//     missing list is no answer at all. `assertUsableYouTubePayload()` in
//     ytFetch() already rejected a non-object body and a non-array `items`;
//     this re-checks it at the point where the consequence is destructive, so
//     the guarantee does not depend on a caller's cache or error path.
//   * there is no `error` object — a body that carries both is a partial
//     failure dressed as a success.
function isAuthoritativeVideoList(result) {
  const data = result?.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  if (data.kind !== YT_VIDEO_LIST_KIND) {
    return false;
  }

  if (!Array.isArray(data.items)) {
    return false;
  }

  if (data.error !== undefined && data.error !== null) {
    return false;
  }

  return true;
}

// Read the pending-deletion tombstones. A read that fails is treated as "no
// tombstones", which is the SAFE direction: every miss then needs two runs
// before anything is deleted instead of one.
async function readPendingMisses(index) {
  try {
    const row = await index.db
      .prepare("SELECT value FROM index_state WHERE key = ? LIMIT 1")
      .bind(MAINTENANCE_MISS_STATE_KEY)
      .first();

    if (!row || typeof row.value !== "string") {
      return {};
    }

    const parsed = JSON.parse(row.value);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch (error) {
    console.error("[mytube] D1 maintenance tombstone read failed", error?.message || error);

    return {};
  }
}

// Persist the tombstones. Best effort by design: a failed write only costs a
// strike, never a deletion, because the next run simply re-observes the miss.
async function writePendingMisses(index, pending) {
  try {
    await index.db
      .prepare(
        "INSERT INTO index_state (key, value, updated_at_ms) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms"
      )
      .bind(MAINTENANCE_MISS_STATE_KEY, JSON.stringify(pending), Date.now())
      .run();
  } catch (error) {
    console.error("[mytube] D1 maintenance tombstone write failed", error?.message || error);
  }
}

// The tombstone record is a Map while a run is deciding and a plain object once
// it has been through JSON. Both are accepted so no call site can quietly read
// an empty record: Object.entries() on a Map is [], not a crash, which is the
// worst possible failure mode for a safety record.
function toPendingEntries(pending) {
  if (pending instanceof Map) {
    return [...pending.entries()];
  }

  return Object.entries(pending || {});
}

// Drop tombstones that can no longer be acted on, and cap the record so a long
// backlog cannot grow one unbounded JSON blob in index_state.
//
// A tombstone expires on age alone. It is never applied to a row that was not
// re-selected in the run that consumes it, so an expired strike cannot reach a
// row that has since been refreshed by any other path.
function prunePendingMisses(pending, now) {
  const live = new Map();

  for (const [videoId, tombstone] of toPendingEntries(pending)) {
    const firstMissedAt = Number(tombstone?.firstMissedAt);

    if (!videoId || !Number.isFinite(firstMissedAt)) {
      continue;
    }

    if (now - firstMissedAt > MAINTENANCE_MISS_TOMBSTONE_MS) {
      continue;
    }

    live.set(videoId, tombstone);
  }

  if (live.size <= MAINTENANCE_MISS_TOMBSTONE_MAX) {
    return live;
  }

  // Oldest strikes first: the newest ones are the ones most likely to be
  // confirmed by an imminent run.
  return new Map(
    [...live.entries()].sort(
      (a, b) => Number(a[1].firstMissedAt) - Number(b[1].firstMissedAt)
    ).slice(-MAINTENANCE_MISS_TOMBSTONE_MAX)
  );
}

// One batched DELETE per chunk instead of one statement per row: 20 sequential
// round trips is 20 of the invocation's 50 subrequests, spent on bookkeeping.
//
// db.batch() is atomic per chunk and rejects if any statement fails, so a
// failure deletes nothing and is raised rather than counted.
async function deleteVideoRows(index, sourceIds) {
  const deleted = [];

  for (let offset = 0; offset < sourceIds.length; offset += MAINTENANCE_DELETE_CHUNK_SIZE) {
    const chunk = sourceIds.slice(offset, offset + MAINTENANCE_DELETE_CHUNK_SIZE);
    const statements = chunk.map(sourceId =>
      index.db.prepare(MAINTENANCE_DELETE_SQL).bind(sourceId)
    );
    const results = await index.db.batch(statements);

    if (!Array.isArray(results)) {
      throw new Error("maintenance: db.batch() did not return a result array");
    }

    results.forEach((result, position) => {
      if (!result || result.success === false) {
        throw new Error(
          `maintenance: delete failed for statement ${position + 1} of the batch`
        );
      }

      // D1 reports the affected row count; count what actually went away rather
      // than what was asked for. A missing count (older binding, fake) is
      // treated as one, which is the only case where a row was deleted anyway.
      const changes = Number(result.meta?.changes);

      if (!Number.isFinite(changes) || changes > 0) {
        deleted.push(chunk[position]);
      }
    });
  }

  return deleted;
}

// Renew the freshness clock of duplicated rows the upsert cannot reach. Batched
// for the same subrequest reason as the deletes above.
async function renewVideoRows(index, sourceIds, at) {
  if (sourceIds.length === 0) {
    return;
  }

  const statements = sourceIds.map(sourceId =>
    index.db.prepare(MAINTENANCE_RENEW_SQL).bind(at, at, sourceId)
  );

  const results = await index.db.batch(statements);

  if (!Array.isArray(results)) {
    throw new Error("maintenance: db.batch() did not return a result array");
  }

  for (let index = 0; index < results.length; index++) {
    if (!results[index] || results[index].success === false) {
      throw new Error(
        `maintenance: renew failed for statement ${index + 1} of the batch`
      );
    }
  }
}

// One maintenance pass. Returns a summary; never throws for an upstream
// failure (that is recorded and retried next run).
async function runIndexMaintenance(index, env, now = Date.now()) {
  const summary = {
    lastRun: now,
    selected: 0,
    requested: 0,
    refreshed: 0,
    deleted: 0,
    tombstoned: 0
  };

  const due = await selectMaintenanceCandidates(index, now);
  summary.selected = due.length;

  if (due.length === 0) {
    return summary;
  }

  // Group the candidates by video id. Every row that shares an id shares its
  // retention fate, so they are refreshed and deleted together; handling only
  // the first row of a duplicated id used to leave its siblings stuck at the
  // head of the oldest-first window, permanently.
  const rowsByVideoId = new Map();

  for (const row of due) {
    const videoId = String(row.video_id || "").trim();

    if (!videoId || !/^[A-Za-z0-9_-]{1,64}$/.test(videoId)) {
      continue;
    }

    const sourceId = String(row.source_id || "").trim();
    const group = rowsByVideoId.get(videoId);

    if (group) {
      if (sourceId && !group.sourceIds.includes(sourceId)) {
        group.sourceIds.push(sourceId);
      }

      continue;
    }

    rowsByVideoId.set(videoId, { sourceIds: sourceId ? [sourceId] : [] });
  }

  const ids = [...rowsByVideoId.keys()].slice(0, MAINTENANCE_MAX_VIDEOS_PER_RUN);
  summary.requested = ids.length;

  if (ids.length === 0) {
    return summary;
  }

  // One helper owns the only upstream call in this handler, and it counts. The
  // cap is therefore enforced rather than documented: a future second call
  // cannot slip past it, it trips the budget check instead.
  let requestsUsed = 0;

  const fetchVideoList = async params => {
    if (requestsUsed >= MAINTENANCE_MAX_YT_REQUESTS_PER_RUN) {
      throw {
        type: "budget_exhausted",
        message:
          `maintenance: upstream request budget ` +
          `(${MAINTENANCE_MAX_YT_REQUESTS_PER_RUN}) is exhausted.`
      };
    }

    requestsUsed += 1;

    // Exactly one upstream request per run. ytFetch stamps each returned item
    // with the real arrival time (markFetchedAt), which is the timestamp that
    // reaches metadata_fetched_at_ms. skipCache keeps this maintenance read out
    // of the request-path response cache.
    return ytFetch("videos", params, env?.YOUTUBE_API_KEY, { skipCache: true });
  };

  let result;

  try {
    result = await fetchVideoList({ part: VIDEO_PARTS_FULL, id: ids.join(",") });
  } catch (error) {
    // Network, quota, rate limit, 5xx, ambiguous 403, missing/invalid key, a
    // body that was not readable JSON, or an exhausted request budget: every
    // one of these is transient for retention purposes. Delete nothing, write
    // no tombstone; the same rows are re-selected next run.
    summary.error = error?.type || error?.message || "upstream_error";
    return summary;
  }

  // A 2xx that is not a real videos.list tells us nothing about whether these
  // videos exist. Refreshing from it would write junk, and deleting from it
  // would empty the table on a single bad response, so the run stops here with
  // the candidates untouched and the reason recorded.
  if (!isAuthoritativeVideoList(result)) {
    summary.error = "non_authoritative_response";
    return summary;
  }

  const returned = new Map();

  for (const item of result.data.items) {
    const videoId = typeof item?.id === "string" ? item.id.trim() : "";

    if (videoId) {
      returned.set(videoId, item);
    }
  }

  const pendingMisses = prunePendingMisses(await readPendingMisses(index), now);
  const nextPendingMisses = new Map();
  // Every id this run reached a verdict on: refreshed, freshly tombstoned, or
  // deleted. A verdict retires the old tombstone, so none of these may be
  // carried forward.
  const decided = new Set();
  const toUpsert = [];
  const toRenew = [];
  const toDelete = [];

  for (const videoId of ids) {
    const group = rowsByVideoId.get(videoId);
    const sourceIds = group?.sourceIds || [];
    const item = returned.get(videoId);

    decided.add(videoId);

    if (item) {
      // Still available: refreshing renews the 30-day window and resets
      // refresh_priority to the schema default (0) through the existing upsert.
      // A video that came back is not a pending deletion any more, so its
      // tombstone is simply not carried forward.
      toUpsert.push(item);

      // Any row of this id that the upsert will not touch (its source_id is not
      // the canonical yt:<videoId> the mapper derives) still needs its clock
      // renewed, or it stays at the head of the window forever.
      for (const sourceId of sourceIds) {
        if (sourceId !== `${VIDEO_SOURCE_PREFIX}${videoId}`) {
          toRenew.push(sourceId);
        }
      }

      continue;
    }

    const tombstone = pendingMisses.get(videoId);
    const firstMissedAt = Number(tombstone?.firstMissedAt);
    const confirmed =
      tombstone &&
      Number.isFinite(firstMissedAt) &&
      now - firstMissedAt < MAINTENANCE_MISS_TOMBSTONE_MS;

    if (confirmed) {
      // Second authoritative run in a row reporting this video as gone. Absent
      // from a real videos.list, for an id that was explicitly requested, in
      // two runs at least MAINTENANCE_MISS_TOMBSTONE_MS apart is a deletion, not
      // a guess.
      toDelete.push(...sourceIds);
      continue;
    }

    // First strike (or a tombstone that had expired in prunePendingMisses):
    // remember the miss and let a later run decide. `now` is the observation
    // time, never a wall clock read, so a run can be replayed deterministically.
    nextPendingMisses.set(videoId, {
      firstMissedAt: now,
      sourceIds
    });
    summary.tombstoned += 1;
  }

  // Carry forward strikes for ids this run did not reach a verdict on (their
  // rows lost the window to newer backlog). A row can only ever be deleted in a
  // run that re-selected it and re-observed the miss, so carrying a strike
  // forward can never delete anything that was not confirmed twice.
  for (const [videoId, tombstone] of pendingMisses) {
    if (!decided.has(videoId)) {
      nextPendingMisses.set(videoId, tombstone);
    }
  }

  try {
    if (toUpsert.length > 0) {
      await upsertVideos(index.db, toUpsert);
      summary.refreshed = toUpsert.length;
    }

    await renewVideoRows(index, toRenew, now);
  } catch (error) {
    // A D1 write failure must not consume the strikes: the tombstone state is
    // left exactly as it was read, so the next run re-observes these misses.
    summary.error = error?.message || "index_write_failed";
    return summary;
  }

  if (toDelete.length > 0) {
    try {
      const deleted = await deleteVideoRows(index, toDelete);

      summary.deleted = deleted.length;
    } catch (error) {
      // db.batch() is atomic, so nothing was deleted. The strikes stay pending
      // and the next run tries again.
      summary.error = error?.message || "index_delete_failed";
      return summary;
    }
  }

  // Written last, and only once the deletes are committed: a crash before this
  // leaves the tombstones intact, which costs a repeated confirmation, never a
  // lost one. Pruned once more on the way out so the record has a hard size and
  // age bound rather than "however many rows this run happened to strike".
  await writePendingMisses(
    index,
    Object.fromEntries(prunePendingMisses(nextPendingMisses, now))
  );

  return summary;
}

export async function scheduled(event, env, ctx) {
  const index = createMaintenanceIndexContext(env);

  if (!index) {
    return;
  }

  let summary;

  try {
    summary = await runIndexMaintenance(index, env);
  } catch (error) {
    summary = { lastRun: Date.now(), error: error?.message || "maintenance_failed" };
    console.error("[mytube] D1 maintenance failed", error?.message || error);
  }

  await recordMaintenanceRun(index, summary);
}

// Named exports of a Worker module must all be functions: workerd rejects the
// whole module at load time if a named export is a plain value (see
// maintenanceConfig() above). WATCH_ORIGIN and the maintenance constants are
// therefore read through functions instead of re-exported directly.
export {
  setVideoCanonical,
  normalizeWatchId,
  renderWatchSeoHtml,
  renderWatchNoIndexHtml,
  maintenanceConfig,
  isAuthoritativeVideoList,
  prunePendingMisses,
  runIndexMaintenance
};
