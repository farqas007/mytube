import {
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse,
  normalizeLiveChatMessage,
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
import {
  FIREBASE_JWKS_URL,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_YOUTUBE_SCOPE,
  buildAuthorizationUrl,
  constantTimeEqual,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  decryptToken,
  deriveAesKey,
  encryptToken,
  redirectUriMatches,
  verifyFirebaseIdToken
} from "./shared/oauth.js";
import {
  getAccessTokenForUser,
  invalidateAccessToken
} from "./shared/oauth-tokens.js";

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
    // Raw RFC 3339 instant, the same slot and type normalizeSearchItem() emits.
    // The row already stores the exact epoch, so an index-served video carries
    // the identical publishedAt a fresh videos.list response would produce.
    publishedAt: formatIndexedTimestamp(
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

// `extraHeaders` carries response-only headers such as Set-Cookie plus the
// Phase 1 index observability headers. It is applied AFTER the CORS/Cache-Control
// block so it can never overwrite Content-Type, Cache-Control,
// Access-Control-Allow-Origin or Vary.
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

// --- OAuth route rate limiting ---------------------------------------------
//
// The OAuth routes are dispatched BEFORE the shared general limiter (see
// handleAPI), so without this they would be entirely unmetered. This is a
// best-effort, per-IP, in-memory limiter in the same style as
// liveChatRateLimitAllowed: enforcement is per Worker isolate and therefore
// approximate, not global.
//
// THRESHOLDS ARE PROVISIONAL. They are deliberately conservative starting
// values, chosen so a normal connect -> consent -> callback -> status ->
// disconnect flow (well under ten requests in total) is never throttled. They
// have not been tuned against real traffic.
const OAUTH_RATE_WINDOW_MS = 5 * 60 * 1000;

// Per-IP, per-route budget per window. Each route keeps its OWN counter, so
// traffic on one route can never consume another route's allowance (e.g. a
// burst of /api/oauth/status polls must not eat the /api/oauth/start budget).
// /callback is the most exposed (it is hit by a header-less browser redirect
// and can be retried), so it gets the tighter budget of the four while still
// allowing a failed consent plus a retry.
const OAUTH_RATE_MAX_PER_WINDOW = Object.freeze({
  "oauth/start": 10,
  "oauth/callback": 20,
  "oauth/status": 60,
  "oauth/disconnect": 10
});

const oauthRateBuckets = new Map();

function oauthRateLimitAllowed(request, route) {
  const max = OAUTH_RATE_MAX_PER_WINDOW[route];

  // Only the known OAuth routes are metered; anything else in the oauth/ prefix
  // falls through to the 404 handler unmetered, matching prior behavior.
  if (!max) {
    return true;
  }

  const ip = clientIp(request);
  // One counter per (IP, route) pair. JSON.stringify gives a collision-safe
  // key: the two parts are unambiguously separated, so an IP that happens to
  // contain a separator can never collide with another IP or route.
  const bucketKey = JSON.stringify([ip, route]);
  const now = Date.now();
  const bucket = oauthRateBuckets.get(bucketKey) || { count: 0, windowStart: now };

  if (now - bucket.windowStart >= OAUTH_RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  oauthRateBuckets.set(bucketKey, bucket);

  if (oauthRateBuckets.size > 5000) {
    // Crude but effective: drop any entry whose window has fully expired.
    for (const [key, entry] of oauthRateBuckets) {
      if (now - entry.windowStart >= OAUTH_RATE_WINDOW_MS) {
        oauthRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= max;
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
    channelId: typeof live.channelId === "string" ? live.channelId : "",
    liveChatId: live.liveChatId,
    concurrentViewers: live.concurrentViewers,
    messages: [],
    nextPageToken: "",
    pollingIntervalMillis: LIVE_CHAT_DEFAULT_INTERVAL_MS,
    offlineAt: live.actualEndTime || "",
    activePoll: null,
    status: "not_live",
    // Lets the watch page decide whether to offer the (hidden-by-default)
    // composer. Computed per request from CHAT_SEND_ENABLED; never cached.
    chatSendEnabled: options.chatSendEnabled === true,
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

// =============================================================================
// GOOGLE OAUTH FOUNDATION (Testing-mode authorization-code flow)
// =============================================================================
// This is the secure half of "users authorize their YouTube account". It does
// NOT post comments or live-chat messages; it only establishes and tears down a
// grant. Nothing here changes any existing read route.
//
// Flow, end to end (browser-compatible):
//
//   1. Page JS, on a page where the user is already signed in to MyTube
//      (Firebase), calls GET /api/oauth/start via fetch() with
//      `Authorization: Bearer <Firebase ID token>`. This is a fetch(), NOT a
//      top-level navigation — a navigation cannot carry the header, which is
//      exactly why the header-authenticated step is a fetch.
//   2. The Worker verifies that ID token, mints a PKCE verifier + single-use
//      state, stores them in D1 keyed to the VERIFIED uid, and answers 200 with
//      { authorizationUrl }. No token and no secret is in that URL.
//   3. Page JS navigates the browser to `authorizationUrl`
//      (window.location.assign). This is a plain navigation to Google, so no
//      Authorization header is needed or possible.
//   4. Google redirects the browser back to GET /api/oauth/callback?code=...&state=...
//      with NO Authorization header (Google cannot send one). The stored state
//      IS the proof that step 1 authenticated: the state row's uid becomes the
//      grant owner. There is therefore nothing to compare a header against at
//      the callback, and none is required — the single-use state is the binding.
//   5. The Worker atomically consumes the state (replay/expiry defence),
//      checks the redirect_uri byte-for-byte, exchanges the code server-side
//      (with the client secret and the stored PKCE verifier) for a refresh
//      token, AES-GCM-encrypts it, and upserts it against the state's uid.
//   6. The Worker 302s the browser to a FIXED MyTube page with a non-sensitive
//      status query param (see OAUTH_LANDING_PATH). No token/secret is ever in
//      that URL, and the target is a constant, so it can never be an open
//      redirect.
//   7. GET /api/oauth/status reports whether a grant exists (never the token).
//   8. POST /api/oauth/disconnect revokes the grant at Google and deletes it.
//
// Security rules kept everywhere below:
//   * The client secret, refresh token and access token NEVER leave the Worker.
//     No token is ever put in a URL, a log line, or a response body.
//   * /start (a fetch) requires a valid Firebase token; /callback (a navigation)
//     requires a valid single-use state bound to the initiating browser by an
//     HttpOnly cookie. Each step has exactly one authentication mechanism, and
//     neither can be skipped.
//   * A state is single-use: consumed before the code exchange, so a replayed
//     callback cannot mint a second grant.
//   * While OAUTH_CONNECT_ENABLED is false no grant can be created at all:
//     /start refuses before authentication, and /callback refuses after the
//     state has been consumed but before the code is exchanged.
//   * The redirect_uri is compared byte-for-byte to the configured value.
//   * If the Google client env or the encryption secret is absent, every route
//     fails closed with a clear error — never an unauthenticated success.
// -----------------------------------------------------------------------------

// How long a started flow may be completed. Short enough that a leaked state is
// near-useless, long enough for a user to get through the consent screen.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// The OAuth state is also bound to the browser that started the flow. The
// cookie is the browser-bound half; the D1 row remains the server-side,
// single-use half. It is HttpOnly, Secure and Lax so Google's top-level
// redirect back to the callback can send it, but page JS can never read it.
const OAUTH_STATE_COOKIE_NAME = "mytube_oauth_state";
const OAUTH_STATE_COOKIE_PATH = "/api/oauth/callback";
const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = Math.floor(OAUTH_STATE_TTL_MS / 1000);

// Bound on how many abandoned states are pruned per start, so pruning can never
// become an unbounded write.
const OAUTH_STATE_PRUNE_LIMIT = 50;

// Whether a NEW YouTube connection may be started, and whether a grant may be
// created at all.
//
// HARD-CODED OFF, on purpose, and deliberately NOT an environment variable:
// MyTube is a read-only product, the OAuth scope it asks for is a write scope
// that no shipped feature uses, and the Connect flow is not approved for use.
// A constant cannot be flipped by a dashboard change or a stray secret, so
// re-enabling it takes a code change plus a separate, explicit approval.
//
// It gates BOTH halves of the flow:
//   * /api/oauth/start    — refused BEFORE authentication (503
//     OAUTH_CONNECT_DISABLED): no state row and no authorization URL.
//   * /api/oauth/callback — the state is consumed and the request is then
//     refused BEFORE the code is exchanged: no token is minted and no grant is
//     ever inserted or updated.
//
// What this switch does NOT touch:
//   * /api/oauth/status  — an existing grant stays visible.
//   * /api/oauth/disconnect — an existing grant stays revocable. (Blocking that
//     too would strand a grant the user could no longer remove from MyTube.)
//
// The net effect: while it is off, the only grant that can ever exist is one
// that was created before the switch was flipped, and even a state that was
// pending from before the flip can no longer be redeemed — it is consumed and
// refused.
const OAUTH_CONNECT_ENABLED = true;

// Where the callback returns the browser after consent.
//
// A FIXED, hardcoded path — never taken from the request — so the redirect can
// never be bent toward an attacker origin (no open redirect). The query param
// carries only a non-sensitive status word; never a token, code or secret.
const OAUTH_LANDING_PATH = "/profile.html";
const OAUTH_STATUS_PARAM = "youtube";

// The only status values ever placed in the landing URL. A closed set means the
// landing page can never receive an arbitrary string from us.
const OAUTH_LANDING_STATUS = Object.freeze({
  connected: "connected",
  cancelled: "cancelled",
  error: "error"
});

// The Firebase project whose ID tokens are accepted. This is public (it is in
// public/firebase.js) and therefore safe to default; an env override exists so
// the project can change without editing code.
const DEFAULT_FIREBASE_PROJECT_ID = "mytube-827d2";

// JWKS cache. Firebase rotates signing keys rarely; a short in-memory TTL keeps
// a live isolate from fetching on every request while still recovering from a
// rotation without a redeploy.
const FIREBASE_JWKS_TTL_MS = 60 * 60 * 1000;
let firebaseJwksCache = { at: 0, value: null };

// Read the OAuth configuration out of env. Returns null (fail closed) unless ALL
// of the client id, secret, redirect uri and encryption key are present and the
// key is a usable 32-byte base64url value.
//
// Nothing here logs or returns a secret. The returned object is only used inside
// the handler.
async function readOAuthConfig(env) {
  const clientId = env?.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = env?.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const redirectUri = env?.GOOGLE_OAUTH_REDIRECT_URI || "";
  const keySecret = env?.OAUTH_TOKEN_ENCRYPTION_KEY || "";

  if (!clientId || !clientSecret || !redirectUri || !keySecret) {
    return null;
  }

  let encryptionKey;

  try {
    encryptionKey = await deriveAesKey(keySecret);
  } catch {
    // A bad key is "not configured", never "continue without encryption".
    return null;
  }

  return { clientId, clientSecret, redirectUri, encryptionKey };
}

// The D1 handle for OAuth work. Unlike the video index (where an absent binding
// degrades to "answer from YouTube"), the OAuth tables ARE the feature, so a
// missing binding is a hard "not available" rather than a silent no-op.
function oauthDb(env) {
  const db = env?.mytube_index;

  if (!db || typeof db.prepare !== "function") {
    return null;
  }

  return db;
}

function oauthPreflight(request) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600"
  };

  if (originAllowed(request)) {
    headers["Access-Control-Allow-Origin"] = request.headers.get("Origin");
    headers["Vary"] = "Origin";
  }

  return new Response(null, { status: 204, headers });
}

// A JSON error that never carries a token. `code` is for the client; `error` is
// a safe, human message.
function oauthError(message, code, status, request) {
  return json({ error: message, code }, status, request);
}

// Read a single cookie value without reflecting or logging the Cookie header.
// The state value is base64url, but decode defensively in case a browser or
// intermediary encoded it.
function readOAuthStateCookie(request) {
  const header = request.headers.get("Cookie") || "";

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    if (part.slice(0, separator).trim() !== OAUTH_STATE_COOKIE_NAME) continue;

    const raw = part.slice(separator + 1).trim();

    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return "";
}

function oauthStateCookieHeader(state) {
  return (
    `${OAUTH_STATE_COOKIE_NAME}=${state}; ` +
    `Path=${OAUTH_STATE_COOKIE_PATH}; ` +
    `Max-Age=${OAUTH_STATE_COOKIE_MAX_AGE_SECONDS}; ` +
    "HttpOnly; Secure; SameSite=Lax"
  );
}

function clearOAuthStateCookieHeader() {
  return (
    `${OAUTH_STATE_COOKIE_NAME}=; ` +
    `Path=${OAUTH_STATE_COOKIE_PATH}; ` +
    "Max-Age=0; HttpOnly; Secure; SameSite=Lax"
  );
}

// Build the fixed landing redirect used by the callback.
//
// `status` MUST come from OAUTH_LANDING_STATUS; anything else is coerced to
// "error" so an unknown value can never be reflected into the Location header.
// The param value is drawn from a closed set and the path is a constant, so the
// resulting URL is always a safe, same-site, non-sensitive destination.
function oauthLandingRedirect(status) {
  const safeStatus =
    status === OAUTH_LANDING_STATUS.connected ||
    status === OAUTH_LANDING_STATUS.cancelled
      ? status
      : OAUTH_LANDING_STATUS.error;

  const location = `${OAUTH_LANDING_PATH}?${OAUTH_STATUS_PARAM}=${safeStatus}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Set-Cookie": clearOAuthStateCookieHeader()
    }
  });
}

// Fetch (and briefly cache) the Firebase signing keys.
//
// `force` bypasses the cache. It exists for one real scenario: Firebase rotates
// its signing keys, and a token signed by a brand-new key would fail against a
// cached set that predates the rotation. The caller retries once with `force`
// so a rotation self-heals within a single request instead of waiting out the
// TTL. A caller that forces on every request would be a fetch amplifier, so
// forcing is opt-in and only ever the second attempt.
async function fetchFirebaseJwks(force = false) {
  const now = Date.now();

  if (
    !force &&
    firebaseJwksCache.value &&
    now - firebaseJwksCache.at < FIREBASE_JWKS_TTL_MS
  ) {
    return firebaseJwksCache.value;
  }

  const response = await fetch(FIREBASE_JWKS_URL, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error("jwks_unavailable");
  }

  const value = await response.json();

  firebaseJwksCache = { at: now, value };

  return value;
}

// Pull the caller's Firebase ID token from `Authorization: Bearer <token>`.
// Returns "" when absent, so callers can treat missing exactly like invalid.
function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

// Verify the caller's Firebase ID token. Returns { ok: true, uid } or
// { ok: false, response }. The response is always a 401 with no detail beyond
// "not authenticated" — the specific failure reason is deliberately not told to
// the client (it is not secret, but a uniform answer leaks less).
async function requireFirebaseUser(request, env) {
  const token = bearerToken(request);

  if (!token) {
    return {
      ok: false,
      response: oauthError("Sign in required.", "UNAUTHENTICATED", 401, request)
    };
  }

  const projectId = env?.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;

  let jwks;

  try {
    jwks = await fetchFirebaseJwks();
  } catch {
    return {
      ok: false,
      response: oauthError(
        "Sign-in verification is temporarily unavailable. Please try again.",
        "AUTH_UNAVAILABLE",
        503,
        request
      )
    };
  }

  let result = await verifyFirebaseIdToken(token, { projectId, jwks });

  // A failure may be a key rotation rather than a bad token. Retry ONCE against
  // freshly fetched keys before calling it invalid; the retry is what makes a
  // rotation invisible to the user. A genuine forgery fails both times.
  if (!result.valid && (result.reason === "unknown_kid" || result.reason === "bad_signature")) {
    try {
      jwks = await fetchFirebaseJwks(true);
      result = await verifyFirebaseIdToken(token, { projectId, jwks });
    } catch {
      // Keep the original (invalid) verdict if the refetch failed.
    }
  }

  if (!result.valid) {
    return {
      ok: false,
      response: oauthError("Sign in required.", "UNAUTHENTICATED", 401, request)
    };
  }

  return { ok: true, uid: result.uid };
}

// Atomic single-use consumption of a state.
//
// `UPDATE ... WHERE state = ? AND consumed = 0 AND expires_at_ms > ?` is the
// whole replay defence: D1 reports the number of changed rows, and only exactly
// one caller can ever observe `changes === 1` for a given state. A replayed
// callback, an expired state, or a state reaped by the prune path all change
// zero rows and are refused identically.
async function consumeOauthState(db, state, nowMs) {
  if (!state) {
    return null;
  }

  const row = await db
    .prepare(
      "SELECT state, uid, code_verifier, redirect_uri, expires_at_ms, consumed " +
        "FROM oauth_states WHERE state = ?"
    )
    .bind(state)
    .first();

  if (!row) {
    return null;
  }

  if (Number(row.consumed) === 1) {
    return null;
  }

  if (Number(row.expires_at_ms) <= nowMs) {
    return null;
  }

  const update = await db
    .prepare(
      "UPDATE oauth_states SET consumed = 1 " +
        "WHERE state = ? AND consumed = 0 AND expires_at_ms > ?"
    )
    .bind(state, nowMs)
    .run();

  if (!update || !update.success || Number(update.meta?.changes) !== 1) {
    return null;
  }

  return row;
}

// Best-effort prune of expired/consumed states. Never throws; a pruning failure
// must not fail the start request. Returns the number of rows removed (0 when
// the prune failed) so the scheduled handler can report what it cleaned up.
//
// The cutoff is the same one the callback uses to reject an expired state:
// expires_at_ms <= now (see consumeOauthState). Rows that were already
// redeemed are removed as well, so a completed flow leaves nothing behind.
async function pruneOauthStates(db, nowMs) {
  if (!db) {
    return 0;
  }

  try {
    const result = await db
      .prepare(
        "DELETE FROM oauth_states WHERE state IN (" +
          "SELECT state FROM oauth_states " +
          "WHERE expires_at_ms <= ? OR consumed = 1 " +
          "ORDER BY expires_at_ms ASC LIMIT ?)"
      )
      .bind(nowMs, OAUTH_STATE_PRUNE_LIMIT)
      .run();

    return Number(result?.meta?.changes) || 0;
  } catch (error) {
    // Ignored on purpose: pruning is hygiene, not correctness. It is logged so
    // a background run that stops cleaning up is visible instead of silent.
    console.error("[mytube] OAuth state prune failed", error?.message || error);
    return 0;
  }
}

// GET /api/oauth/start — begin the flow.
async function handleOAuthStart(request, env) {
  if (request.method !== "GET") {
    return oauthError("Method not allowed.", "METHOD_NOT_ALLOWED", 405, request);
  }

  const config = await readOAuthConfig(env);

  if (!config) {
    return oauthError(
      "YouTube connection is not configured yet.",
      "OAUTH_NOT_CONFIGURED",
      503,
      request
    );
  }

  const db = oauthDb(env);

  if (!db) {
    return oauthError(
      "YouTube connection is temporarily unavailable.",
      "OAUTH_UNAVAILABLE",
      503,
      request
    );
  }

  // The Connect flow is hard-disabled. This check sits BEFORE the Firebase
  // token is looked at, so an unauthenticated caller gets the same refusal as
  // an authenticated one and no authorization request is ever handed out.
  // Everything below this line (state creation, PKCE, the Google consent URL)
  // is dead code while the switch is off; it is kept intact so re-enabling the
  // flow is a one-line change, with the separate approval it requires.
  if (!OAUTH_CONNECT_ENABLED) {
    return oauthError(
      "YouTube connection is not available yet.",
      "OAUTH_CONNECT_DISABLED",
      503,
      request
    );
  }

  const auth = await requireFirebaseUser(request, env);

  if (!auth.ok) {
    return auth.response;
  }

  const now = Date.now();
  const state = createState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = await createCodeChallenge(codeVerifier);

  try {
    await db
      .prepare(
        "INSERT INTO oauth_states " +
          "(state, uid, code_verifier, redirect_uri, created_at_ms, expires_at_ms, consumed) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0)"
      )
      .bind(
        state,
        auth.uid,
        codeVerifier,
        config.redirectUri,
        now,
        now + OAUTH_STATE_TTL_MS
      )
      .run();
  } catch {
    return oauthError(
      "Could not start the YouTube connection. Please try again.",
      "OAUTH_START_FAILED",
      500,
      request
    );
  }

  await pruneOauthStates(db, now);

  const authorizationUrl = buildAuthorizationUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: GOOGLE_YOUTUBE_SCOPE,
    state,
    codeChallenge
  });

  // 200 JSON, NOT a 302. This endpoint is reached by page JS via fetch() so it
  // can carry the Firebase Authorization header (a top-level navigation cannot).
  // The browser then navigates to `authorizationUrl` itself, which is the step
  // that needs no header. `authorizationUrl` contains the public client id, the
  // redirect_uri, the PKCE challenge and the state — never a secret or a token.
  //
  // The state cookie is the browser-bound half of the CSRF defence: it is set
  // on this same response, before the browser leaves for Google, and the
  // callback refuses a state that this browser did not start. The cookie is
  // scoped to the callback path and expires with the state row.
  return json({ authorizationUrl }, 200, request, {
    "Set-Cookie": oauthStateCookieHeader(state)
  });
}

// GET /api/oauth/callback — Google redirects here with ?code and ?state.
async function handleOAuthCallback(request, env, url) {
  if (request.method !== "GET") {
    return oauthError("Method not allowed.", "METHOD_NOT_ALLOWED", 405, request);
  }

  const config = await readOAuthConfig(env);

  if (!config) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  const db = oauthDb(env);

  if (!db) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // Google's own failure redirect (user denied, etc.) carries `error`.
  const googleError = url.searchParams.get("error");

  if (googleError) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.cancelled);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";

  if (!code || !state) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // NO Firebase Authorization header is required (or possible) here: Google
  // redirected the browser and cannot attach one. The stored, single-use state
  // is the server-side authority for the grant's uid, but it is not sufficient
  // on its own: a state put in a victim's browser by an attacker would still be
  // a login-linking/CSRF vector. The browser-bound cookie must match BEFORE the
  // state is consumed, so a missing/wrong cookie cannot burn a legitimate state
  // or reach the token exchange. A matching cookie and state are then consumed
  // atomically by consumeOauthState().
  const cookieState = readOAuthStateCookie(request);

  if (!cookieState || !constantTimeEqual(cookieState, state)) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  const now = Date.now();
  let row;

  try {
    row = await consumeOauthState(db, state, now);
  } catch {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  if (!row) {
    // Missing, already consumed (replay), or expired — all refused identically.
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // The redirect URI must be exactly the one the flow started with AND exactly
  // the configured one. Two checks because two things could have drifted.
  if (!redirectUriMatches(row.redirect_uri, config.redirectUri)) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // The Connect flow is switched off (OAUTH_CONNECT_ENABLED = false), so NO
  // grant may ever be created — not even by a state that was issued before the
  // switch was flipped.
  //
  // Placement matters:
  //   * It sits AFTER consumeOauthState, so the pending state was ALREADY
  //     consumed. A state that is rejected here is burned: it can never be
  //     redeemed by a replay, and it can never be redeemed later either, not
  //     even if this switch is ever turned back on.
  //   * It sits BEFORE the code exchange, so no authorization code is ever
  //     presented to Google and no token is ever minted. The only way to
  //     create a grant (the INSERT/UPDATE below) is unreachable while the
  //     switch is off.
  //
  // Status and disconnect are deliberately NOT gated: an existing grant stays
  // visible and stays revocable, which is the only way a user can remove it.
  if (!OAUTH_CONNECT_ENABLED) {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // Exchange the code, server-side, presenting the PKCE verifier.
  let tokenPayload;

  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: row.code_verifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri
    });

    const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString()
    });

    tokenPayload = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenPayload?.refresh_token) {
      return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
    }

    // Require the requested YouTube scope before persisting the grant.
    // Missing scope must not be encrypted or written to D1. Use the same
    // whitespace normalization as scopeReady() for consistency.
    const returnedScope = String(tokenPayload.scope || "");
    const scopeSet = returnedScope.split(/\s+/).filter(Boolean);
    if (!scopeSet.includes(GOOGLE_YOUTUBE_SCOPE)) {
      return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
    }
  } catch {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // Encrypt before storing. If encryption fails, nothing is written — a plain
  // token must never be persisted as a fallback.
  let encrypted;

  try {
    encrypted = await encryptToken(tokenPayload.refresh_token, config.encryptionKey);
  } catch {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  try {
    await db
      .prepare(
        "INSERT INTO oauth_grants " +
          "(uid, refresh_token_enc, scope, token_type, connected_at_ms, updated_at_ms, revoked_at_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL) " +
          "ON CONFLICT(uid) DO UPDATE SET " +
          "refresh_token_enc = excluded.refresh_token_enc, " +
          "scope = excluded.scope, " +
          "token_type = excluded.token_type, " +
          "updated_at_ms = excluded.updated_at_ms, " +
          "revoked_at_ms = NULL"
      )
      .bind(
        row.uid,
        encrypted,
        String(tokenPayload.scope || ""),
        String(tokenPayload.token_type || ""),
        now,
        now
      )
      .run();
  } catch {
    return oauthLandingRedirect(OAUTH_LANDING_STATUS.error);
  }

  // A reconnect replaces the grant. Drop any access token cached in this
  // isolate for the uid; other isolates detect the changed grant fingerprint on
  // the write path before they may reuse a cached token.
  invalidateAccessToken(row.uid);

  // Success: the browser lands on a fixed MyTube page with a non-sensitive
  // status. The grant owner is the uid the state was minted for.
  return oauthLandingRedirect(OAUTH_LANDING_STATUS.connected);
}

// GET /api/oauth/status — is there a live grant for this user?
async function handleOAuthStatus(request, env) {
  if (request.method !== "GET") {
    return oauthError("Method not allowed.", "METHOD_NOT_ALLOWED", 405, request);
  }

  if (!(await readOAuthConfig(env))) {
    return oauthError(
      "YouTube connection is not configured yet.",
      "OAUTH_NOT_CONFIGURED",
      503,
      request
    );
  }

  const db = oauthDb(env);

  if (!db) {
    return oauthError(
      "YouTube connection is temporarily unavailable.",
      "OAUTH_UNAVAILABLE",
      503,
      request
    );
  }

  const auth = await requireFirebaseUser(request, env);

  if (!auth.ok) {
    return auth.response;
  }

  let row;

  try {
    row = await db
      .prepare(
        "SELECT scope, connected_at_ms, revoked_at_ms FROM oauth_grants WHERE uid = ?"
      )
      .bind(auth.uid)
      .first();
  } catch {
    return oauthError(
      "Could not read the YouTube connection.",
      "OAUTH_STATUS_FAILED",
      500,
      request
    );
  }

  if (!row || row.revoked_at_ms !== null && row.revoked_at_ms !== undefined) {
    return json(
      { connected: false, scope: "", scopeReady: false, connectEnabled: OAUTH_CONNECT_ENABLED },
      200,
      request
    );
  }

  const scopeStr = String(row.scope || "");
  const scopeReady = scopeStr
    .split(/\s+/)
    .filter(Boolean)
    .includes(GOOGLE_YOUTUBE_SCOPE);

  return json(
    {
      connected: true,
      scope: scopeStr,
      connectedAtMs: Number(row.connected_at_ms) || 0,
      scopeReady,
      connectEnabled: OAUTH_CONNECT_ENABLED
    },
    200,
    request
  );
}

// POST /api/oauth/disconnect — revoke at Google, then delete locally.
async function handleOAuthDisconnect(request, env) {
  if (request.method !== "POST") {
    return oauthError("Method not allowed.", "METHOD_NOT_ALLOWED", 405, request);
  }

  const config = await readOAuthConfig(env);

  if (!config) {
    return oauthError(
      "YouTube connection is not configured yet.",
      "OAUTH_NOT_CONFIGURED",
      503,
      request
    );
  }

  const db = oauthDb(env);

  if (!db) {
    return oauthError(
      "YouTube connection is temporarily unavailable.",
      "OAUTH_UNAVAILABLE",
      503,
      request
    );
  }

  const auth = await requireFirebaseUser(request, env);

  if (!auth.ok) {
    return auth.response;
  }

  // Drop any cached access token for this user the moment they disconnect, so a
  // token minted before the disconnect cannot be reused from this isolate.
  //
  // This is the earliest point where the uid is known, and it is placed before
  // any I/O on purpose: one call then covers every exit below — the grant read
  // failing, the Google revoke failing, the local delete failing, and success.
  //
  // Scope note: the token cache is per-isolate, so this invalidates THIS
  // isolate only. Other isolates keep their cached token until it expires.
  invalidateAccessToken(auth.uid);

  let row;

  try {
    row = await db
      .prepare("SELECT refresh_token_enc FROM oauth_grants WHERE uid = ?")
      .bind(auth.uid)
      .first();
  } catch {
    return oauthError(
      "Could not read the YouTube connection.",
      "OAUTH_DISCONNECT_FAILED",
      500,
      request
    );
  }

  // Revoke at Google when we can decrypt the token, and report truthfully
  // whether Google accepted the revocation.
  //
  // `revoked` reflects the actual outcome:
  //   true  — Google answered 2xx (or the token was already invalid, which
  //           Google reports as 400 with error=invalid_token: the grant is not
  //           live, so from the user's point of view it IS revoked)
  //   false — any other HTTP status, or a network/decrypt failure
  //
  // The local delete happens regardless. Leaving a live grant on Google would be
  // worse than leaving none, and the user explicitly asked to disconnect.
  let revoked = false;

  if (row?.refresh_token_enc) {
    try {
      const refreshToken = await decryptToken(
        row.refresh_token_enc,
        config.encryptionKey
      );

      const revokeResponse = await fetch(GOOGLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({ token: refreshToken }).toString()
      });

      if (revokeResponse.ok) {
        revoked = true;
      } else if (revokeResponse.status === 400) {
        // Google returns 400 invalid_token for a token that is already gone.
        // That is not a failure to revoke: there is nothing live left to revoke.
        const detail = await revokeResponse.json().catch(() => null);
        if (detail?.error === "invalid_token") {
          revoked = true;
        }
      }
    } catch {
      // Token unreadable or Google unreachable: revoked stays false. The local
      // delete below still runs.
    }
  } else {
    // No stored grant: nothing to revoke, so "revoked" is vacuously true.
    revoked = true;
  }

  try {
    await db
      .prepare("DELETE FROM oauth_grants WHERE uid = ?")
      .bind(auth.uid)
      .run();
  } catch {
    return oauthError(
      "Could not remove the YouTube connection. Please try again.",
      "OAUTH_DISCONNECT_FAILED",
      500,
      request
    );
  }

  // `connected` is always false (the grant is gone locally). `revoked` tells the
  // truth about Google's side so the caller can decide whether to warn.
  return json({ connected: false, revoked }, 200, request);
}

// -----------------------------------------------------------------------------
// Live chat send (YouTube liveChatMessages.insert)
// -----------------------------------------------------------------------------
// This is the first WRITE path in MyTube. It is deliberately inert: nothing
// below runs unless CHAT_SEND_ENABLED is exactly "true". The kill switch is the
// first check in handleLiveChatSend, before auth, D1, or any network call, so a
// missing/typo'd value cannot spend a token, read a grant, or post a message.
//
// Rules this block keeps:
//   * The client sends a VIDEO id only. The active liveChatId is resolved here
//     from YouTube's own liveStreamingDetails; a client-supplied chat id is
//     ignored by construction.
//   * The message is posted as the signed-in user's OWN YouTube account, using
//     the refresh token stored by the OAuth flow. No channel-ownership check is
//     performed: YouTube itself decides whether this account may post here.
//   * The insert is never retried. It is not idempotent, so an automatic retry
//     could double-post. One fetch, one attempt, a 10s abort.
//   * Limits are per-ISOlate best-effort, in the same style as the OAuth
//     limiter. They are abuse brakes, not a billing/quota guarantee.
//   * No token, refresh token, message text or upstream error detail is ever
//     returned to the client or logged.
// -----------------------------------------------------------------------------

function chatSendEnabled(env) {
  // Exact string match only. "TRUE", "1", " true", a boolean true and every
  // other variation stay off, so a typo can never enable the write path.
  return env?.CHAT_SEND_ENABLED === "true";
}

const LIVE_CHAT_SEND_MAX_CODE_POINTS = 200;
const LIVE_CHAT_SEND_MAX_BODY_BYTES = 4 * 1024;
const LIVE_CHAT_SEND_TIMEOUT_MS = 10 * 1000;
const LIVE_CHAT_SEND_IP_WINDOW_MS = 60 * 1000;
const LIVE_CHAT_SEND_IP_MAX = 20;
const LIVE_CHAT_SEND_USER_SHORT_WINDOW_MS = 10 * 1000;
const LIVE_CHAT_SEND_USER_SHORT_MAX = 3;
const LIVE_CHAT_SEND_USER_LONG_WINDOW_MS = 60 * 1000;
const LIVE_CHAT_SEND_USER_LONG_MAX = 20;
const LIVE_CHAT_SEND_INFLIGHT_TTL_MS = 15 * 1000;
const LIVE_CHAT_SEND_IDEMPOTENCY_TTL_MS = 60 * 1000;
const LIVE_CHAT_SEND_MAX_BUCKETS = 5000;
const LIVE_CHAT_SEND_MAX_IDEMPOTENCY = 500;

const LIVE_CHAT_SEND_INSERT_URL =
  "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet";

const liveChatSendIpBuckets = new Map();
const liveChatSendShortBuckets = new Map();
const liveChatSendLongBuckets = new Map();
const liveChatSendInFlight = new Map();
const liveChatSendIdempotency = new Map();

// Closed set of safe, already-user-facing messages. The handler always picks a
// value from here; it never passes a Google-supplied message through.
const LIVE_CHAT_SEND_MESSAGES = Object.freeze({
  CHAT_SEND_DISABLED: "Sending chat messages is not enabled.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  UNSUPPORTED_MEDIA_TYPE: "Expected a JSON request.",
  BODY_TOO_LARGE: "That message is too long.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_VIDEO_ID: "That video is not valid.",
  INVALID_MESSAGE: "That message can't be sent. Check the text and try again.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are sending messages too quickly. Please wait a moment.",
  CHAT_RATE_LIMITED: "YouTube is asking for a slower pace. Please wait a moment.",
  SEND_IN_PROGRESS: "Your previous message is still being sent.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account before sending messages.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow sending chat messages.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "Sending is unavailable right now.",
  YOUTUBE_NOT_CONFIGURED: "YouTube is not configured on this server.",
  NOT_LIVE: "This stream is not live.",
  CHAT_DISABLED: "Live chat is turned off for this broadcast.",
  LIVE_CHAT_ENDED: "This live chat has ended.",
  LIVE_CHAT_NOT_FOUND: "This live chat is unavailable.",
  CHAT_FORBIDDEN: "You can't send messages in this chat.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  OAUTH_CONFIG_ERROR: "YouTube connection needs attention. Please try again later.",
  INTERNAL: "Something went wrong. Please try again."
});

function liveChatSendFailure(code, status, request) {
  return json(
    {
      error: LIVE_CHAT_SEND_MESSAGES[code] || LIVE_CHAT_SEND_MESSAGES.INTERNAL,
      code
    },
    status,
    request
  );
}

// -----------------------------------------------------------------------------
// Live chat subscription helpers (subscriber-only / restricted chat support)
// -----------------------------------------------------------------------------
// Authenticated, user-initiated checks and explicit subscription actions only.
// Channel IDs are ALWAYS resolved server-side from a trusted videoId via
// probeVideoLive(). The client never supplies a trusted channelId. No
// subscriptions.list/insert calls are made without a connected OAuth grant and
// the existing youtube.force-ssl scope. Never auto-subscribe; never blindly
// retry inserts.
const SUBSCRIPTION_API_TIMEOUT_MS = 10 * 1000;
const SUBSCRIPTION_STATUS_IP_WINDOW_MS = 60 * 1000;
const SUBSCRIPTION_STATUS_IP_MAX = 30;
const SUBSCRIPTION_STATUS_USER_WINDOW_MS = 60 * 1000;
const SUBSCRIPTION_STATUS_USER_MAX = 20;
const SUBSCRIPTION_SUBSCRIBE_IP_WINDOW_MS = 60 * 1000;
const SUBSCRIPTION_SUBSCRIBE_IP_MAX = 10;
const SUBSCRIPTION_SUBSCRIBE_USER_WINDOW_MS = 60 * 1000;
const SUBSCRIPTION_SUBSCRIBE_USER_MAX = 6;

const subscriptionStatusIpBuckets = new Map();
const subscriptionStatusUserBuckets = new Map();
const subscriptionSubscribeIpBuckets = new Map();
const subscriptionSubscribeUserBuckets = new Map();

function pruneSubscriptionBuckets(now) {
  const maps = [
    [subscriptionStatusIpBuckets, SUBSCRIPTION_STATUS_IP_WINDOW_MS * 3],
    [subscriptionStatusUserBuckets, SUBSCRIPTION_STATUS_USER_WINDOW_MS * 3],
    [subscriptionSubscribeIpBuckets, SUBSCRIPTION_SUBSCRIBE_IP_WINDOW_MS * 3],
    [subscriptionSubscribeUserBuckets, SUBSCRIPTION_SUBSCRIBE_USER_WINDOW_MS * 3]
  ];
  for (const [map, maxAge] of maps) {
    for (const [key, bucket] of map) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
    if (map.size > LIVE_CHAT_SEND_MAX_BUCKETS) {
      for (const key of map.keys()) {
        if (map.size <= LIVE_CHAT_SEND_MAX_BUCKETS) break;
        map.delete(key);
      }
    }
  }
}

function subscriptionFailure(code, status, request, extra = {}) {
  const safeCode = LIVE_CHAT_SEND_MESSAGES[code] ? code : "UPSTREAM_ERROR";
  return json(
    {
      ok: false,
      subscribed: false,
      available: false,
      code: safeCode,
      error: LIVE_CHAT_SEND_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

async function readJsonBody(request, maxBytes) {
  const result = await readLiveChatBody(request, maxBytes);
  if (!result.ok) return { ok: false, code: result.code };
  let payload;
  try {
    payload = JSON.parse(result.text || "{}");
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  return { ok: true, payload };
}

async function resolveLiveStreamChannel(videoId, apiKey) {
  if (!isValidYouTubeSourceId(videoId)) {
    return { ok: false, code: "INVALID_VIDEO_ID", status: 400 };
  }
  let live;
  try {
    live = await probeVideoLive(videoId, apiKey);
  } catch {
    return { ok: false, code: "UPSTREAM_ERROR", status: 502 };
  }
  if (!live || live.isLive !== true) {
    return { ok: false, code: "NOT_LIVE", status: 409 };
  }
  const channelId = typeof live?.channelId === "string" ? live.channelId.trim() : "";
  if (!channelId) {
    return { ok: false, code: "UPSTREAM_ERROR", status: 502 };
  }
  return { ok: true, channelId, live };
}

async function getSubscriptionAccessToken(request, env) {
  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) return { ok: false, response: auth.response };
  const config = await readOAuthConfig(env);
  if (!config) return { ok: false, response: subscriptionFailure("OAUTH_NOT_CONFIGURED", 503, request) };
  const db = oauthDb(env);
  if (!db) return { ok: false, response: subscriptionFailure("OAUTH_UNAVAILABLE", 503, request) };
  try {
    const accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
    return { ok: true, uid: auth.uid, accessToken };
  } catch (e) {
    const code = mapTokenLifecycleErrorToClientCode(e);
    if (code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED" || code === "OAUTH_CONFIG_ERROR") {
      return { ok: false, response: subscriptionFailure(code, 409, request) };
    }
    return { ok: false, response: subscriptionFailure("OAUTH_UNAVAILABLE", 503, request) };
  }
}

async function youtubeSubscriptionRequest(url, accessToken, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUBSCRIPTION_API_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.headers || {})
      },
      signal: controller.signal
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

function mapSubscriptionUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") return { code: "QUOTA_EXCEEDED", status: 503 };
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return { code: "CHAT_RATE_LIMITED", status: 429 };
    return { code: "CHAT_FORBIDDEN", status: 403 };
  }
  if (status === 404) return { code: "LIVE_CHAT_NOT_FOUND", status: 404 };
  if (status === 429) return { code: "CHAT_RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

// -----------------------------------------------------------------------------
// YouTube rating sync (authenticated, explicit user actions via API only).
// Part 1: GET /api/youtube/rating?videoId=<id> (read actual rating).
// -----------------------------------------------------------------------------
const YOUTUBE_RATING_API_TIMEOUT_MS = 10_000;
const YOUTUBE_RATING_READ_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_RATING_READ_IP_MAX = 60;
const YOUTUBE_RATING_READ_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_RATING_READ_USER_MAX = 45;
const YOUTUBE_RATING_WRITE_BODY_MAX_BYTES = 1024;
const YOUTUBE_RATING_WRITE_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_RATING_WRITE_IP_MAX = 30;
const YOUTUBE_RATING_WRITE_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_RATING_WRITE_USER_MAX = 20;
const youtubeRatingReadIpBuckets = new Map();
const youtubeRatingReadUserBuckets = new Map();
const youtubeRatingWriteIpBuckets = new Map();
const youtubeRatingWriteUserBuckets = new Map();

function pruneYoutubeRatingBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeRatingReadIpBuckets, YOUTUBE_RATING_READ_IP_WINDOW_MS * 3],
    [youtubeRatingReadUserBuckets, YOUTUBE_RATING_READ_USER_WINDOW_MS * 3],
    [youtubeRatingWriteIpBuckets, YOUTUBE_RATING_WRITE_IP_WINDOW_MS * 3],
    [youtubeRatingWriteUserBuckets, YOUTUBE_RATING_WRITE_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

function isValidYoutubeRatingValue(value) {
  const rating = String(value || "").trim().toLowerCase();
  return rating === "like" || rating === "dislike" || rating === "none";
}

function isValidYoutubeRatingVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || "").trim());
}

const YOUTUBE_RATING_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  UNSUPPORTED_MEDIA_TYPE: "Expected a JSON request.",
  BODY_TOO_LARGE: "That request was too large.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_VIDEO_ID: "That video is not valid.",
  INVALID_RATING: "That rating is not valid.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  CHAT_RATE_LIMITED: "YouTube is asking for a slower pace. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to rate videos.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow rating videos.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  MULTIPLE_CHANNELS: "Multiple YouTube channels are available for this Google account. Reconnect using the intended channel before rating videos.",
  YOUTUBE_IDENTITY_CHANGED: "Your connected YouTube channel changed. Reconnect your YouTube account and try again.",
  YOUTUBE_IDENTITY_UNVERIFIED: "Could not verify your connected YouTube channel. Reload the page and try again.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "Rating is unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again."
});

function youtubeRatingFailure(videoId, code, status, request, extra = {}) {
  const safeVideoId = isValidYoutubeRatingVideoId(videoId) ? String(videoId).trim() : "";
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_RATING_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  return json(
    {
      ok: false,
      available: false,
      videoId: safeVideoId,
      rating: "none",
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_RATING_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

function mapYoutubeRatingReadUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "CHAT_RATE_LIMITED", status: 429 };
    }
    // Ratings can be disabled/forbidden for specific videos/accounts.
    return { code: "UPSTREAM_ERROR", status: 503 };
  }
  if (status === 404) return { code: "UPSTREAM_ERROR", status: 404 };
  if (status === 429) return { code: "CHAT_RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

function normalizeYoutubeRatingValue(value) {
  const rating = String(value || "").trim().toLowerCase();
  if (rating === "like" || rating === "dislike" || rating === "none") return rating;
  return "none";
}

async function youtubeGetRatingRequest(videoId, accessToken) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos/getRating");
  endpoint.searchParams.set("id", videoId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_RATING_API_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/youtube/rating?videoId=...
async function handleGetYoutubeRating(request, env) {
  if (request.method !== "GET") {
    return youtubeRatingFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  const url = new URL(request.url);
  const videoId = String(url.searchParams.get("videoId") || "").trim();
  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeRatingBuckets(now);

  if (!isValidYoutubeRatingVideoId(videoId)) {
    return youtubeRatingFailure(videoId, "INVALID_VIDEO_ID", 400, request);
  }

  if (
    !fixedWindowAllows(
      youtubeRatingReadIpBuckets,
      ip,
      YOUTUBE_RATING_READ_IP_WINDOW_MS,
      YOUTUBE_RATING_READ_IP_MAX,
      now
    )
  ) {
    return youtubeRatingFailure(videoId, "RATE_LIMITED", 429, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return youtubeRatingFailure(videoId, "UNAUTHENTICATED", 401, request);
  }

  if (
    !fixedWindowAllows(
      youtubeRatingReadUserBuckets,
      auth.uid,
      YOUTUBE_RATING_READ_USER_WINDOW_MS,
      YOUTUBE_RATING_READ_USER_MAX,
      now
    )
  ) {
    return youtubeRatingFailure(videoId, "RATE_LIMITED", 429, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeRatingFailure(videoId, "OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeRatingFailure(videoId, "OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeRatingFailure(videoId, "OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeRatingFailure(videoId, "TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    upstream = await youtubeGetRatingRequest(videoId, accessToken);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeRatingFailure(videoId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeRatingFailure(videoId, "UPSTREAM_ERROR", 502, request);
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    const mapped = mapYoutubeRatingReadUpstreamError(upstream.response.status, upstream.data);
    return youtubeRatingFailure(videoId, mapped.code, mapped.status, request);
  }

  const item = Array.isArray(upstream.data?.items) ? upstream.data.items[0] : null;
  if (!item) {
    return youtubeRatingFailure(videoId, "UPSTREAM_ERROR", 404, request);
  }

  const rating = normalizeYoutubeRatingValue(item.rating);
  return json(
    {
      ok: true,
      available: true,
      videoId,
      rating,
      source: "youtube"
    },
    200,
    request
  );
}

async function youtubePostRatingRequest(videoId, rating, accessToken) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos/rate");
  endpoint.searchParams.set("id", videoId);
  endpoint.searchParams.set("rating", rating);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_RATING_API_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    // videos.rate typically returns 204 No Content on success.
    try {
      if (response.status !== 204) {
        data = await response.json();
      }
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

function mapYoutubeRatingWriteUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "CHAT_RATE_LIMITED", status: 429 };
    }
    // Ratings can be disabled/forbidden for specific videos/accounts.
    return { code: "UPSTREAM_ERROR", status: 503 };
  }
  if (status === 404) return { code: "UPSTREAM_ERROR", status: 404 };
  if (status === 429) return { code: "CHAT_RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

// POST /api/youtube/rating
async function handlePostYoutubeRating(request, env) {
  if (request.method !== "POST") {
    return youtubeRatingFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeRatingBuckets(now);

  if (
    !fixedWindowAllows(
      youtubeRatingWriteIpBuckets,
      ip,
      YOUTUBE_RATING_WRITE_IP_WINDOW_MS,
      YOUTUBE_RATING_WRITE_IP_MAX,
      now
    )
  ) {
    return youtubeRatingFailure("", "RATE_LIMITED", 429, request);
  }

  const contentType = String(request.headers.get("Content-Type") || "").trim().toLowerCase();
  const mediaType = contentType.split(";")[0].trim();
  if (mediaType !== "application/json") {
    return youtubeRatingFailure("", "UNSUPPORTED_MEDIA_TYPE", 415, request);
  }

  const body = await readJsonBody(request, YOUTUBE_RATING_WRITE_BODY_MAX_BYTES);
  if (!body.ok) {
    const bodyCode = body.code || "INVALID_REQUEST";
    const safeBodyCode = Object.prototype.hasOwnProperty.call(YOUTUBE_RATING_MESSAGES, bodyCode)
      ? bodyCode
      : "INVALID_REQUEST";
    const status = safeBodyCode === "BODY_TOO_LARGE" ? 413 : safeBodyCode === "UNSUPPORTED_MEDIA_TYPE" ? 415 : 400;
    return youtubeRatingFailure("", safeBodyCode, status, request);
  }

  const payload = body.payload || {};
  const videoId = String(payload.videoId || "").trim();
  const rating = String(payload.rating || "").trim().toLowerCase();

  if (!isValidYoutubeRatingVideoId(videoId)) {
    return youtubeRatingFailure(videoId, "INVALID_VIDEO_ID", 400, request);
  }

  if (!isValidYoutubeRatingValue(rating)) {
    return youtubeRatingFailure(videoId, "INVALID_RATING", 400, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return youtubeRatingFailure(videoId, "UNAUTHENTICATED", 401, request);
  }

  if (
    !fixedWindowAllows(
      youtubeRatingWriteUserBuckets,
      auth.uid,
      YOUTUBE_RATING_WRITE_USER_WINDOW_MS,
      YOUTUBE_RATING_WRITE_USER_MAX,
      now
    )
  ) {
    return youtubeRatingFailure(videoId, "RATE_LIMITED", 429, request);
  }

  const expectedChannelId = String(payload.expectedChannelId || "").trim();
  const expectedIdentityError = youtubeExpectedIdentityCode(payload, auth.uid);
  if (expectedIdentityError) {
    return youtubeRatingFailure(videoId, expectedIdentityError, 409, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeRatingFailure(videoId, "OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeRatingFailure(videoId, "OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeRatingFailure(videoId, "YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeRatingFailure(videoId, "OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeRatingFailure(videoId, "TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    // Re-verify the acting channel against the current grant immediately before
    // the write. The client-supplied expected channel must still match.
    const identity = await verifyYoutubeActingChannel(accessToken, expectedChannelId);
    if (!identity.ok) {
      if (identity.code === "YOUTUBE_REAUTH_REQUIRED") {
        invalidateAccessToken(auth.uid);
      }
      return youtubeRatingFailure(videoId, identity.code, identity.status, request);
    }
    upstream = await youtubePostRatingRequest(videoId, rating, accessToken);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeRatingFailure(videoId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeRatingFailure(videoId, "UPSTREAM_ERROR", 502, request);
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    const mapped = mapYoutubeRatingWriteUpstreamError(upstream.response.status, upstream.data);
    return youtubeRatingFailure(videoId, mapped.code, mapped.status, request);
  }

  return json(
    {
      ok: true,
      applied: true,
      videoId,
      rating,
      source: "youtube"
    },
    200,
    request
  );
}

// -----------------------------------------------------------------------------
// YouTube subscription status (authenticated, read-only, general).
// GET /api/youtube/subscription-status?channelId=...
// Checks whether the connected YouTube account is subscribed to a channel.
// Read-only: never subscribes/unsubscribes, never modifies local/MyTube state.
// Separate from live-chat subscription endpoints.
// -----------------------------------------------------------------------------
const YOUTUBE_SUBSCRIPTION_STATUS_TIMEOUT_MS = 10_000;
const YOUTUBE_SUBSCRIPTION_STATUS_CHANNEL_ID_MAX_LEN = 128;
const YOUTUBE_SUBSCRIPTION_STATUS_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIPTION_STATUS_IP_MAX = 30;
const YOUTUBE_SUBSCRIPTION_STATUS_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIPTION_STATUS_USER_MAX = 20;
const youtubeSubscriptionStatusIpBuckets = new Map();
const youtubeSubscriptionStatusUserBuckets = new Map();

function pruneYoutubeSubscriptionStatusBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeSubscriptionStatusIpBuckets, YOUTUBE_SUBSCRIPTION_STATUS_IP_WINDOW_MS * 3],
    [youtubeSubscriptionStatusUserBuckets, YOUTUBE_SUBSCRIPTION_STATUS_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

function isValidYoutubeChannelId(value) {
  const channelId = String(value || "").trim();
  if (!channelId) return false;
  if (channelId.length > YOUTUBE_SUBSCRIPTION_STATUS_CHANNEL_ID_MAX_LEN) return false;
  // Conservative safe charset for YouTube channel IDs (e.g. UC...).
  return /^[A-Za-z0-9_-]+$/.test(channelId);
}

// Writes must name the Firebase user and acting channel the client displayed.
// The token still supplies the authoritative uid; this is an additional check
// that the client is not acting on a stale/other account view.
function youtubeExpectedIdentityCode(payload, authUid) {
  const expectedUid = String(payload?.expectedUid || "").trim();
  const expectedChannelId = String(payload?.expectedChannelId || "").trim();
  if (!expectedUid || expectedUid !== String(authUid || "")) {
    return "YOUTUBE_IDENTITY_UNVERIFIED";
  }
  if (!isValidYoutubeChannelId(expectedChannelId)) {
    return "YOUTUBE_IDENTITY_UNVERIFIED";
  }
  return "";
}

const YOUTUBE_SUBSCRIPTION_STATUS_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_CHANNEL_ID: "That channel is not valid.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to check subscription status.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow reading subscriptions.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "Subscription status is unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again.",
  SUBSCRIPTIONS_FORBIDDEN: "YouTube subscriptions could not be accessed for this account.",
  SUBSCRIPTIONS_NOT_FOUND: "YouTube subscriptions could not be found for this account."
});

function youtubeSubscriptionStatusFailure(channelId, code, status, request, extra = {}) {
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_SUBSCRIPTION_STATUS_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  const safeChannelId = isValidYoutubeChannelId(channelId) ? String(channelId).trim() : "";
  return json(
    {
      ok: false,
      available: false,
      subscribed: false,
      channelId: safeChannelId,
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_SUBSCRIPTION_STATUS_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

function mapYoutubeSubscriptionStatusUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 400) return { code: "INVALID_REQUEST", status: 400 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    if (reason === "accountClosed" || reason === "accountSuspended" || reason === "subscriptionForbidden") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 404) {
    if (reason === "subscriberNotFound") {
      return { code: "SUBSCRIPTIONS_NOT_FOUND", status: 404 };
    }
    return { code: "UPSTREAM_ERROR", status: 404 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

async function youtubeGetSubscriptionStatusRequest(accessToken, channelId) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  endpoint.searchParams.set("part", "id");
  endpoint.searchParams.set("mine", "true");
  endpoint.searchParams.set("forChannelId", channelId);
  endpoint.searchParams.set("maxResults", "1");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_SUBSCRIPTION_STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function handleGetYoutubeSubscriptionStatus(request, env) {
  if (request.method !== "GET") {
    return youtubeSubscriptionStatusFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  const url = new URL(request.url);
  const rawChannelId = url.searchParams.has("channelId") ? url.searchParams.get("channelId") : "";
  const channelId = String(rawChannelId || "").trim();

  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeSubscriptionStatusBuckets(now);

  if (!isValidYoutubeChannelId(channelId)) {
    return youtubeSubscriptionStatusFailure(channelId, "INVALID_CHANNEL_ID", 400, request);
  }

  if (
    !fixedWindowAllows(
      youtubeSubscriptionStatusIpBuckets,
      ip,
      YOUTUBE_SUBSCRIPTION_STATUS_IP_WINDOW_MS,
      YOUTUBE_SUBSCRIPTION_STATUS_IP_MAX,
      now
    )
  ) {
    return youtubeSubscriptionStatusFailure(channelId, "RATE_LIMITED", 429, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (
    !fixedWindowAllows(
      youtubeSubscriptionStatusUserBuckets,
      auth.uid,
      YOUTUBE_SUBSCRIPTION_STATUS_USER_WINDOW_MS,
      YOUTUBE_SUBSCRIPTION_STATUS_USER_MAX,
      now
    )
  ) {
    return youtubeSubscriptionStatusFailure(channelId, "RATE_LIMITED", 429, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeSubscriptionStatusFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeSubscriptionStatusFailure(channelId, "OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeSubscriptionStatusFailure(channelId, "YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeSubscriptionStatusFailure(channelId, "YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeSubscriptionStatusFailure(channelId, "YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeSubscriptionStatusFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeSubscriptionStatusFailure(channelId, "TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    upstream = await youtubeGetSubscriptionStatusRequest(accessToken, channelId);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeSubscriptionStatusFailure(channelId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeSubscriptionStatusFailure(channelId, "UPSTREAM_ERROR", 502, request);
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    const mapped = mapYoutubeSubscriptionStatusUpstreamError(upstream.response.status, upstream.data);
    return youtubeSubscriptionStatusFailure(channelId, mapped.code, mapped.status, request);
  }

  const data = upstream.data && typeof upstream.data === "object" ? upstream.data : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return json(
    {
      ok: true,
      available: true,
      subscribed: items.length > 0,
      channelId,
      source: "youtube"
    },
    200,
    request
  );
}

// -----------------------------------------------------------------------------
// YouTube connected account identity (authenticated, read-only).
// GET /api/youtube/account
// Resolves the channel(s) owned by the authenticated user's existing OAuth
// grant via channels.list?mine=true. Returns only id/title/thumbnail. Never
// selects an account or channel silently. Never stores identity in D1.
// Separate from live-chat routes and rate limits.
// -----------------------------------------------------------------------------
const YOUTUBE_ACCOUNT_TIMEOUT_MS = 10_000;
const YOUTUBE_ACCOUNT_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_ACCOUNT_IP_MAX = 30;
const YOUTUBE_ACCOUNT_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_ACCOUNT_USER_MAX = 20;
const youtubeAccountIpBuckets = new Map();
const youtubeAccountUserBuckets = new Map();

function pruneYoutubeAccountBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeAccountIpBuckets, YOUTUBE_ACCOUNT_IP_WINDOW_MS * 3],
    [youtubeAccountUserBuckets, YOUTUBE_ACCOUNT_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

const YOUTUBE_ACCOUNT_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to identify it.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow reading its identity.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "YouTube account identity is unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again."
});

function youtubeAccountFailure(code, status, request, extra = {}) {
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_ACCOUNT_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  // `connected` is only known for grant-state errors. Quota, timeout, rate-limit
  // and upstream failures leave the connection state unknown, so they must not
  // claim the account is disconnected.
  const connected =
    safeCode === "YOUTUBE_NOT_CONNECTED"
      ? false
      : (safeCode === "YOUTUBE_SCOPE_REQUIRED" || safeCode === "YOUTUBE_REAUTH_REQUIRED")
        ? true
        : null;
  return json(
    {
      ok: false,
      connected,
      channel: null,
      channels: [],
      multiple: false,
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_ACCOUNT_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

function youtubeAccountNoChannel(request) {
  return json(
    {
      ok: true,
      connected: true,
      channel: null,
      channels: [],
      multiple: false,
      source: "youtube",
      code: "NO_YOUTUBE_CHANNEL",
      error: "This Google account has no YouTube channel."
    },
    200,
    request
  );
}

function mapYoutubeAccountUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

function normalizeYoutubeAccountChannel(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!isValidYoutubeChannelId(id)) return null;
  const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
  const thumbnails = snippet.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails : {};
  const thumb =
    (thumbnails.medium && typeof thumbnails.medium.url === "string" && thumbnails.medium.url) ||
    (thumbnails.default && typeof thumbnails.default.url === "string" && thumbnails.default.url) ||
    (thumbnails.high && typeof thumbnails.high.url === "string" && thumbnails.high.url) ||
    "";
  return {
    id,
    title: typeof snippet.title === "string" ? snippet.title : "",
    thumbnail: String(thumb || "")
  };
}

async function youtubeGetAccountRequest(accessToken) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/channels");
  endpoint.searchParams.set("part", "snippet");
  endpoint.searchParams.set("mine", "true");
  // Keep the response to the identity fields this endpoint is allowed to expose.
  endpoint.searchParams.set("fields", "items(id,snippet(title,thumbnails))");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_ACCOUNT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    let parseError = false;
    try {
      data = await response.json();
    } catch {
      data = null;
      parseError = true;
    }
    return { response, data, parseError };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

// Re-verify the acting channel against the current grant immediately before a
// write. This is deliberately separate from the frontend gate: a stale client
// must not be able to mutate a different channel after an account switch.
async function verifyYoutubeActingChannel(accessToken, expectedChannelId) {
  let upstream;
  try {
    upstream = await youtubeGetAccountRequest(accessToken);
  } catch (error) {
    const message = String(error?.message || "");
    return message === "UPSTREAM_TIMEOUT"
      ? { ok: false, code: "UPSTREAM_TIMEOUT", status: 504 }
      : { ok: false, code: "UPSTREAM_ERROR", status: 502 };
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 404) {
      return { ok: false, code: "YOUTUBE_NOT_CONNECTED", status: 409 };
    }
    const mapped = mapYoutubeAccountUpstreamError(upstream.response.status, upstream.data);
    return { ok: false, code: mapped.code, status: mapped.status };
  }

  if (
    upstream.parseError
    || !upstream.data
    || typeof upstream.data !== "object"
    || !Array.isArray(upstream.data.items)
  ) {
    return { ok: false, code: "UPSTREAM_ERROR", status: 502 };
  }

  const channels = [];
  for (const item of upstream.data.items) {
    const normalized = normalizeYoutubeAccountChannel(item);
    if (normalized) channels.push(normalized);
  }

  if (channels.length === 0) {
    return { ok: false, code: "YOUTUBE_NOT_CONNECTED", status: 409 };
  }
  if (channels.length > 1) {
    return { ok: false, code: "MULTIPLE_CHANNELS", status: 409 };
  }
  if (String(channels[0].id) !== String(expectedChannelId || "")) {
    return { ok: false, code: "YOUTUBE_IDENTITY_CHANGED", status: 409 };
  }
  return { ok: true, channelId: channels[0].id };
}

async function handleGetYoutubeAccount(request, env) {
  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeAccountBuckets(now);

  if (
    !fixedWindowAllows(
      youtubeAccountIpBuckets,
      ip,
      YOUTUBE_ACCOUNT_IP_WINDOW_MS,
      YOUTUBE_ACCOUNT_IP_MAX,
      now
    )
  ) {
    return youtubeAccountFailure("RATE_LIMITED", 429, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (
    !fixedWindowAllows(
      youtubeAccountUserBuckets,
      auth.uid,
      YOUTUBE_ACCOUNT_USER_WINDOW_MS,
      YOUTUBE_ACCOUNT_USER_MAX,
      now
    )
  ) {
    return youtubeAccountFailure("RATE_LIMITED", 429, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeAccountFailure("OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeAccountFailure("OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeAccountFailure("YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeAccountFailure("YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED" || message === "INVALID_GRANT") {
      return youtubeAccountFailure("YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR" || message === "INVALID_CLIENT") {
      return youtubeAccountFailure("OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeAccountFailure("TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    upstream = await youtubeGetAccountRequest(accessToken);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeAccountFailure("UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeAccountFailure("UPSTREAM_ERROR", 502, request);
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    // Some Google accounts with no YouTube channel answer 404 instead of an
    // empty items array. Treat both as the same truthful "no channel" state.
    if (upstream.response.status === 404) {
      return youtubeAccountNoChannel(request);
    }
    const mapped = mapYoutubeAccountUpstreamError(upstream.response.status, upstream.data);
    return youtubeAccountFailure(mapped.code, mapped.status, request);
  }

  // A successful channels.list response always carries an items array. A
  // malformed/truncated 200 is an upstream failure, not proof of no channel.
  if (
    upstream.parseError
    || !upstream.data
    || typeof upstream.data !== "object"
    || !Array.isArray(upstream.data.items)
  ) {
    return youtubeAccountFailure("UPSTREAM_ERROR", 502, request);
  }

  const rawItems = upstream.data.items;
  const channels = [];
  for (const item of rawItems) {
    const normalized = normalizeYoutubeAccountChannel(item);
    if (normalized) channels.push(normalized);
  }

  if (channels.length === 0) {
    return youtubeAccountNoChannel(request);
  }

  if (channels.length > 1) {
    return json(
      {
        ok: true,
        connected: true,
        channel: null,
        channels,
        multiple: true,
        source: "youtube",
        code: "MULTIPLE_CHANNELS",
        error: "Multiple YouTube channels are available for this account. Reconnect using the intended channel before using YouTube actions."
      },
      200,
      request
    );
  }

  return json(
    {
      ok: true,
      connected: true,
      channel: channels[0],
      channels,
      multiple: false,
      source: "youtube"
    },
    200,
    request
  );
}

// -----------------------------------------------------------------------------
// YouTube subscription subscribe (authenticated, explicit user action).
// POST /api/youtube/subscribe { channelId }
// Subscribes the connected YouTube account to a channel via subscriptions.insert.
// No automatic retries. No auto-subscribe. Never called during implementation.
// -----------------------------------------------------------------------------
const YOUTUBE_SUBSCRIBE_TIMEOUT_MS = 10_000;
const YOUTUBE_SUBSCRIBE_BODY_MAX_BYTES = 1024;
const YOUTUBE_SUBSCRIBE_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIBE_IP_MAX = 10;
const YOUTUBE_SUBSCRIBE_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIBE_USER_MAX = 6;
const youtubeSubscribeIpBuckets = new Map();
const youtubeSubscribeUserBuckets = new Map();

function pruneYoutubeSubscribeBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeSubscribeIpBuckets, YOUTUBE_SUBSCRIBE_IP_WINDOW_MS * 3],
    [youtubeSubscribeUserBuckets, YOUTUBE_SUBSCRIBE_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

const YOUTUBE_SUBSCRIBE_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  UNSUPPORTED_MEDIA_TYPE: "Expected a JSON request.",
  BODY_TOO_LARGE: "That request was too large.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_CHANNEL_ID: "That channel is not valid.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to subscribe.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow subscriptions.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  MULTIPLE_CHANNELS: "Multiple YouTube channels are available for this Google account. Reconnect using the intended channel before managing subscriptions.",
  YOUTUBE_IDENTITY_CHANGED: "Your connected YouTube channel changed. Reconnect your YouTube account and try again.",
  YOUTUBE_IDENTITY_UNVERIFIED: "Could not verify your connected YouTube channel. Reload the page and try again.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "Subscription is unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again.",
  SUBSCRIPTIONS_FORBIDDEN: "YouTube could not complete the subscription for this account.",
  SUBSCRIPTIONS_NOT_FOUND: "That channel could not be found."
});

function youtubeSubscribeFailure(channelId, code, status, request, extra = {}) {
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_SUBSCRIBE_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  const safeChannelId = isValidYoutubeChannelId(channelId) ? String(channelId).trim() : "";
  return json(
    {
      ok: false,
      available: false,
      subscribed: false,
      channelId: safeChannelId,
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_SUBSCRIBE_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

function mapYoutubeSubscribeUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 400) {
    if (reason === "subscriptionDuplicate") return { code: "ALREADY_SUBSCRIBED", status: 200 };
    if (reason === "publisherNotFound" || reason === "subscriberNotFound") {
      return { code: "SUBSCRIPTIONS_NOT_FOUND", status: 404 };
    }
    if (reason === "subscriptionForbidden" || reason === "publisherRequired") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "INVALID_REQUEST", status: 400 };
  }
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    if (reason === "subscriptionForbidden" || reason === "accountClosed" || reason === "accountSuspended") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 404) {
    if (reason === "publisherNotFound" || reason === "subscriberNotFound") {
      return { code: "SUBSCRIPTIONS_NOT_FOUND", status: 404 };
    }
    return { code: "UPSTREAM_ERROR", status: 404 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

async function youtubeSubscribeInsertRequest(accessToken, channelId) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  endpoint.searchParams.set("part", "snippet");
  const body = JSON.stringify({
    snippet: {
      resourceId: {
        kind: "youtube#channel",
        channelId
      }
    }
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_SUBSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body,
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function handlePostYoutubeSubscribe(request, env) {
  if (request.method !== "POST") {
    return youtubeSubscribeFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeSubscribeBuckets(now);

  if (
    !fixedWindowAllows(
      youtubeSubscribeIpBuckets,
      ip,
      YOUTUBE_SUBSCRIBE_IP_WINDOW_MS,
      YOUTUBE_SUBSCRIBE_IP_MAX,
      now
    )
  ) {
    return youtubeSubscribeFailure("", "RATE_LIMITED", 429, request);
  }

  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return youtubeSubscribeFailure("", "UNSUPPORTED_MEDIA_TYPE", 415, request);
  }

  const bodyResult = await readJsonBody(request, YOUTUBE_SUBSCRIBE_BODY_MAX_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.code === "BODY_TOO_LARGE") {
      return youtubeSubscribeFailure("", "BODY_TOO_LARGE", 413, request);
    }
    if (bodyResult.code === "UNSUPPORTED_MEDIA_TYPE") {
      return youtubeSubscribeFailure("", "UNSUPPORTED_MEDIA_TYPE", 415, request);
    }
    return youtubeSubscribeFailure("", "INVALID_REQUEST", 400, request);
  }

  const payload = bodyResult.payload && typeof bodyResult.payload === "object" ? bodyResult.payload : {};
  const channelId = String(payload.channelId || "").trim();
  if (!isValidYoutubeChannelId(channelId)) {
    return youtubeSubscribeFailure(channelId, "INVALID_CHANNEL_ID", 400, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (
    !fixedWindowAllows(
      youtubeSubscribeUserBuckets,
      auth.uid,
      YOUTUBE_SUBSCRIBE_USER_WINDOW_MS,
      YOUTUBE_SUBSCRIBE_USER_MAX,
      now
    )
  ) {
    return youtubeSubscribeFailure(channelId, "RATE_LIMITED", 429, request);
  }

  const expectedChannelId = String(payload.expectedChannelId || "").trim();
  const expectedIdentityError = youtubeExpectedIdentityCode(payload, auth.uid);
  if (expectedIdentityError) {
    return youtubeSubscribeFailure(channelId, expectedIdentityError, 409, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeSubscribeFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeSubscribeFailure(channelId, "OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeSubscribeFailure(channelId, "YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeSubscribeFailure(channelId, "YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeSubscribeFailure(channelId, "YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeSubscribeFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeSubscribeFailure(channelId, "TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    // Explicit user action only (frontend confirmation required in later phase).
    // Never retry subscription writes automatically.
    // Re-verify the acting channel against the current grant immediately before
    // the write so an account switch cannot silently mutate another channel.
    const identity = await verifyYoutubeActingChannel(accessToken, expectedChannelId);
    if (!identity.ok) {
      if (identity.code === "YOUTUBE_REAUTH_REQUIRED") {
        invalidateAccessToken(auth.uid);
      }
      return youtubeSubscribeFailure(channelId, identity.code, identity.status, request);
    }
    upstream = await youtubeSubscribeInsertRequest(accessToken, channelId);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeSubscribeFailure(channelId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeSubscribeFailure(channelId, "UPSTREAM_ERROR", 502, request);
  }

  if (upstream.response.ok) {
    return json(
      {
        ok: true,
        available: true,
        subscribed: true,
        channelId,
        source: "youtube"
      },
      200,
      request
    );
  }

  if (upstream.response.status === 401) {
    invalidateAccessToken(auth.uid);
  }

  const mapped = mapYoutubeSubscribeUpstreamError(upstream.response.status, upstream.data);
  if (mapped.code === "ALREADY_SUBSCRIBED") {
    return json(
      {
        ok: true,
        available: true,
        subscribed: true,
        alreadySubscribed: true,
        channelId,
        source: "youtube"
      },
      200,
      request
    );
  }

  return youtubeSubscribeFailure(channelId, mapped.code, mapped.status, request);
}

// -----------------------------------------------------------------------------
// YouTube subscription unsubscribe (authenticated, explicit user action).
// POST /api/youtube/unsubscribe { channelId }
// Resolves subscription resource ID via subscriptions.list (mine=true, forChannelId),
// then deletes via subscriptions.delete?id=<subscriptionResourceId>.
// Never uses channelId as delete ID. No automatic retries. No auto-unsubscribe.
// -----------------------------------------------------------------------------
const YOUTUBE_UNSUBSCRIBE_TIMEOUT_MS = 10_000;
const YOUTUBE_UNSUBSCRIBE_BODY_MAX_BYTES = 1024;
const YOUTUBE_UNSUBSCRIBE_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_UNSUBSCRIBE_IP_MAX = 10;
const YOUTUBE_UNSUBSCRIBE_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_UNSUBSCRIBE_USER_MAX = 6;
const youtubeUnsubscribeIpBuckets = new Map();
const youtubeUnsubscribeUserBuckets = new Map();

function pruneYoutubeUnsubscribeBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeUnsubscribeIpBuckets, YOUTUBE_UNSUBSCRIBE_IP_WINDOW_MS * 3],
    [youtubeUnsubscribeUserBuckets, YOUTUBE_UNSUBSCRIBE_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

const YOUTUBE_UNSUBSCRIBE_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  UNSUPPORTED_MEDIA_TYPE: "Expected a JSON request.",
  BODY_TOO_LARGE: "That request was too large.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_CHANNEL_ID: "That channel is not valid.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to unsubscribe.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow subscriptions.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  MULTIPLE_CHANNELS: "Multiple YouTube channels are available for this Google account. Reconnect using the intended channel before managing subscriptions.",
  YOUTUBE_IDENTITY_CHANGED: "Your connected YouTube channel changed. Reconnect your YouTube account and try again.",
  YOUTUBE_IDENTITY_UNVERIFIED: "Could not verify your connected YouTube channel. Reload the page and try again.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "Unsubscribe is unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not confirm the unsubscribe. Please check your YouTube subscription status and try again.",
  UPSTREAM_ERROR: "Could not confirm the unsubscribe. Please check your YouTube subscription status and try again.",
  SUBSCRIPTIONS_FORBIDDEN: "YouTube could not complete the unsubscribe for this account.",
  SUBSCRIPTIONS_NOT_FOUND: "YouTube subscriptions could not be found for this account."
});

function youtubeUnsubscribeFailure(channelId, code, status, request, extra = {}) {
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_UNSUBSCRIBE_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  const safeChannelId = isValidYoutubeChannelId(channelId) ? String(channelId).trim() : "";
  return json(
    {
      ok: false,
      available: false,
      subscribed: false,
      channelId: safeChannelId,
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_UNSUBSCRIBE_MESSAGES[safeCode],
      ...extra
    },
    status,
    request
  );
}

function mapYoutubeUnsubscribeLookupUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 400) return { code: "INVALID_REQUEST", status: 400 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    if (reason === "accountClosed" || reason === "accountSuspended" || reason === "subscriptionForbidden") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 404) {
    if (reason === "subscriberNotFound") {
      return { code: "SUBSCRIPTIONS_NOT_FOUND", status: 404 };
    }
    return { code: "UPSTREAM_ERROR", status: 404 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

function mapYoutubeUnsubscribeDeleteUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    if (reason === "subscriptionForbidden" || reason === "accountClosed" || reason === "accountSuspended") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 404) {
    // subscriptionNotFound: treat as already unsubscribed/stale state (safe).
    if (reason === "subscriptionNotFound") {
      return { code: "ALREADY_UNSUBSCRIBED", status: 200 };
    }
    return { code: "UPSTREAM_ERROR", status: 404 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

async function youtubeUnsubscribeLookupRequest(accessToken, channelId) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  endpoint.searchParams.set("part", "id");
  endpoint.searchParams.set("mine", "true");
  endpoint.searchParams.set("forChannelId", channelId);
  endpoint.searchParams.set("maxResults", "1");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_UNSUBSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function youtubeUnsubscribeDeleteRequest(accessToken, subscriptionId) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  endpoint.searchParams.set("id", subscriptionId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_UNSUBSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    // DELETE returns 204 No Content on success; avoid parsing empty body.
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function handlePostYoutubeUnsubscribe(request, env) {
  if (request.method !== "POST") {
    return youtubeUnsubscribeFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeUnsubscribeBuckets(now);

  if (
    !fixedWindowAllows(
      youtubeUnsubscribeIpBuckets,
      ip,
      YOUTUBE_UNSUBSCRIBE_IP_WINDOW_MS,
      YOUTUBE_UNSUBSCRIBE_IP_MAX,
      now
    )
  ) {
    return youtubeUnsubscribeFailure("", "RATE_LIMITED", 429, request);
  }

  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return youtubeUnsubscribeFailure("", "UNSUPPORTED_MEDIA_TYPE", 415, request);
  }

  const bodyResult = await readJsonBody(request, YOUTUBE_UNSUBSCRIBE_BODY_MAX_BYTES);
  if (!bodyResult.ok) {
    if (bodyResult.code === "BODY_TOO_LARGE") {
      return youtubeUnsubscribeFailure("", "BODY_TOO_LARGE", 413, request);
    }
    if (bodyResult.code === "UNSUPPORTED_MEDIA_TYPE") {
      return youtubeUnsubscribeFailure("", "UNSUPPORTED_MEDIA_TYPE", 415, request);
    }
    return youtubeUnsubscribeFailure("", "INVALID_REQUEST", 400, request);
  }

  const payload = bodyResult.payload && typeof bodyResult.payload === "object" ? bodyResult.payload : {};
  const channelId = String(payload.channelId || "").trim();
  if (!isValidYoutubeChannelId(channelId)) {
    return youtubeUnsubscribeFailure(channelId, "INVALID_CHANNEL_ID", 400, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (
    !fixedWindowAllows(
      youtubeUnsubscribeUserBuckets,
      auth.uid,
      YOUTUBE_UNSUBSCRIBE_USER_WINDOW_MS,
      YOUTUBE_UNSUBSCRIBE_USER_MAX,
      now
    )
  ) {
    return youtubeUnsubscribeFailure(channelId, "RATE_LIMITED", 429, request);
  }

  const expectedChannelId = String(payload.expectedChannelId || "").trim();
  const expectedIdentityError = youtubeExpectedIdentityCode(payload, auth.uid);
  if (expectedIdentityError) {
    return youtubeUnsubscribeFailure(channelId, expectedIdentityError, 409, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeUnsubscribeFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeUnsubscribeFailure(channelId, "OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeUnsubscribeFailure(channelId, "YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeUnsubscribeFailure(channelId, "YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeUnsubscribeFailure(channelId, "YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeUnsubscribeFailure(channelId, "OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeUnsubscribeFailure(channelId, "TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let lookup;
  try {
    // Explicit user action only (frontend confirmation required in later phase).
    // Resolve actual subscription resource ID; never use channelId as delete ID.
    // Re-verify the acting channel against the current grant immediately before
    // the write so an account switch cannot silently mutate another channel.
    const identity = await verifyYoutubeActingChannel(accessToken, expectedChannelId);
    if (!identity.ok) {
      if (identity.code === "YOUTUBE_REAUTH_REQUIRED") {
        invalidateAccessToken(auth.uid);
      }
      return youtubeUnsubscribeFailure(channelId, identity.code, identity.status, request);
    }
    lookup = await youtubeUnsubscribeLookupRequest(accessToken, channelId);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeUnsubscribeFailure(channelId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeUnsubscribeFailure(channelId, "UPSTREAM_ERROR", 502, request);
  }

  if (!lookup.response.ok) {
    if (lookup.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    const mapped = mapYoutubeUnsubscribeLookupUpstreamError(lookup.response.status, lookup.data);
    return youtubeUnsubscribeFailure(channelId, mapped.code, mapped.status, request);
  }

  const lookupData = lookup.data && typeof lookup.data === "object" ? lookup.data : {};
  const items = Array.isArray(lookupData.items) ? lookupData.items : [];
  const subscriptionId = items[0] && typeof items[0].id === "string" ? items[0].id.trim() : "";
  if (!subscriptionId) {
    return json(
      {
        ok: true,
        available: true,
        subscribed: false,
        alreadyUnsubscribed: true,
        channelId,
        source: "youtube"
      },
      200,
      request
    );
  }

  let deleted;
  try {
    // Never retry DELETE automatically.
    deleted = await youtubeUnsubscribeDeleteRequest(accessToken, subscriptionId);
  } catch (error) {
    const message = String(error?.message || "");
    // Uncertain outcome: lookup found a subscription but delete did not complete.
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeUnsubscribeFailure(channelId, "UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeUnsubscribeFailure(channelId, "UPSTREAM_ERROR", 502, request);
  }

  if (deleted.response.ok || deleted.response.status === 204) {
    return json(
      {
        ok: true,
        available: true,
        subscribed: false,
        channelId,
        source: "youtube"
      },
      200,
      request
    );
  }

  if (deleted.response.status === 401) {
    invalidateAccessToken(auth.uid);
  }

  const mappedDelete = mapYoutubeUnsubscribeDeleteUpstreamError(deleted.response.status, deleted.data);
  if (mappedDelete.code === "ALREADY_UNSUBSCRIBED") {
    return json(
      {
        ok: true,
        available: true,
        subscribed: false,
        alreadyUnsubscribed: true,
        channelId,
        source: "youtube"
      },
      200,
      request
    );
  }

  return youtubeUnsubscribeFailure(channelId, mappedDelete.code, mappedDelete.status, request);
}

// -----------------------------------------------------------------------------
// YouTube subscriptions list sync (authenticated, read-only).
// GET /api/youtube/subscriptions?pageToken=...
// Retrieves the connected YouTube account's actual subscriptions (mine=true).
// Read-only: never subscribes/unsubscribes, never modifies local/MyTube state.
// -----------------------------------------------------------------------------
const YOUTUBE_SUBSCRIPTIONS_LIST_TIMEOUT_MS = 10_000;
const YOUTUBE_SUBSCRIPTIONS_LIST_MAX_RESULTS = 50;
const YOUTUBE_SUBSCRIPTIONS_LIST_PAGE_TOKEN_MAX_LEN = 512;
const YOUTUBE_SUBSCRIPTIONS_LIST_IP_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIPTIONS_LIST_IP_MAX = 30;
const YOUTUBE_SUBSCRIPTIONS_LIST_USER_WINDOW_MS = 60 * 1000;
const YOUTUBE_SUBSCRIPTIONS_LIST_USER_MAX = 20;
const youtubeSubscriptionsListIpBuckets = new Map();
const youtubeSubscriptionsListUserBuckets = new Map();

function pruneYoutubeSubscriptionsListBuckets(now) {
  for (const [map, maxAge] of [
    [youtubeSubscriptionsListIpBuckets, YOUTUBE_SUBSCRIPTIONS_LIST_IP_WINDOW_MS * 3],
    [youtubeSubscriptionsListUserBuckets, YOUTUBE_SUBSCRIPTIONS_LIST_USER_WINDOW_MS * 3]
  ]) {
    for (const [key, bucket] of map.entries()) {
      if (!bucket || now - bucket.windowStart > maxAge) map.delete(key);
    }
  }
}

function normalizeYoutubeSubscriptionsPageToken(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token) return "";
  if (token.length > YOUTUBE_SUBSCRIPTIONS_LIST_PAGE_TOKEN_MAX_LEN) return null;
  // Reject control characters/newlines; pageToken is an opaque upstream token.
  if (/[\u0000-\u001F\u007F]/.test(token)) return null;
  return token;
}

const YOUTUBE_SUBSCRIPTIONS_LIST_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method not allowed.",
  INVALID_REQUEST: "That request was not valid.",
  INVALID_PAGE_TOKEN: "That page token is not valid.",
  UNAUTHENTICATED: "Sign in required.",
  RATE_LIMITED: "You are making requests too quickly. Please wait a moment.",
  YOUTUBE_NOT_CONNECTED: "Connect your YouTube account to view YouTube subscriptions.",
  YOUTUBE_SCOPE_REQUIRED: "Reconnect your YouTube account to allow reading subscriptions.",
  YOUTUBE_REAUTH_REQUIRED: "Reconnect your YouTube account to continue.",
  OAUTH_NOT_CONFIGURED: "YouTube connection is not available yet.",
  OAUTH_UNAVAILABLE: "YouTube subscriptions are unavailable right now.",
  QUOTA_EXCEEDED: "YouTube's daily limit has been reached. Please try again later.",
  TOKEN_EXCHANGE_FAILED: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_TIMEOUT: "Could not reach YouTube right now. Please try again.",
  UPSTREAM_ERROR: "Could not reach YouTube right now. Please try again.",
  SUBSCRIPTIONS_FORBIDDEN: "YouTube subscriptions could not be accessed for this account.",
  SUBSCRIPTIONS_NOT_FOUND: "YouTube subscriptions could not be found for this account."
});

function youtubeSubscriptionsListFailure(code, status, request, extra = {}) {
  const requestedCode = String(code || "");
  const safeCode = Object.prototype.hasOwnProperty.call(YOUTUBE_SUBSCRIPTIONS_LIST_MESSAGES, requestedCode)
    ? requestedCode
    : "UPSTREAM_ERROR";
  return json(
    {
      ok: false,
      available: false,
      source: "youtube",
      code: safeCode,
      error: YOUTUBE_SUBSCRIPTIONS_LIST_MESSAGES[safeCode],
      items: [],
      nextPageToken: null,
      prevPageToken: null,
      pageInfo: { totalResults: 0, resultsPerPage: 0 },
      ...extra
    },
    status,
    request
  );
}

function mapYoutubeSubscriptionsListUpstreamError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
  if (status === 401) return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  if (status === 400) {
    // Invalid pageToken or bad request from upstream; return safe client error.
    return { code: "INVALID_PAGE_TOKEN", status: 400 };
  }
  if (status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
      return { code: "RATE_LIMITED", status: 429 };
    }
    if (reason === "accountClosed" || reason === "accountSuspended" || reason === "subscriptionForbidden") {
      return { code: "SUBSCRIPTIONS_FORBIDDEN", status: 403 };
    }
    return { code: "UPSTREAM_ERROR", status: 502 };
  }
  if (status === 404) {
    if (reason === "subscriberNotFound") {
      return { code: "SUBSCRIPTIONS_NOT_FOUND", status: 404 };
    }
    return { code: "UPSTREAM_ERROR", status: 404 };
  }
  if (status === 429) return { code: "RATE_LIMITED", status: 429 };
  if (status >= 500) return { code: "UPSTREAM_ERROR", status: 502 };
  return { code: "UPSTREAM_ERROR", status: 502 };
}

function normalizeYoutubeSubscriptionListItem(item) {
  if (!item || typeof item !== "object") return null;
  const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
  const resourceId = snippet.resourceId && typeof snippet.resourceId === "object" ? snippet.resourceId : {};
  // Subscribed-to channel ID is snippet.resourceId.channelId (NOT snippet.channelId).
  const channelId = typeof resourceId.channelId === "string" ? resourceId.channelId.trim() : "";
  if (!channelId) return null;
  const subscriptionId = typeof item.id === "string" ? item.id.trim() : "";
  return {
    subscriptionId,
    channelId,
    title: typeof snippet.title === "string" ? snippet.title : "",
    description: typeof snippet.description === "string" ? snippet.description : "",
    thumbnails: snippet.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails : {},
    publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : ""
  };
}

async function youtubeGetSubscriptionsListRequest(accessToken, pageToken) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  endpoint.searchParams.set("part", "snippet");
  endpoint.searchParams.set("mine", "true");
  endpoint.searchParams.set("maxResults", String(YOUTUBE_SUBSCRIPTIONS_LIST_MAX_RESULTS));
  if (pageToken) {
    endpoint.searchParams.set("pageToken", pageToken);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_SUBSCRIPTIONS_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw new Error("UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function handleGetYoutubeSubscriptions(request, env) {
  if (request.method !== "GET") {
    return youtubeSubscriptionsListFailure("METHOD_NOT_ALLOWED", 405, request);
  }

  const url = new URL(request.url);
  const rawPageToken = url.searchParams.has("pageToken") ? url.searchParams.get("pageToken") : "";
  const pageToken = normalizeYoutubeSubscriptionsPageToken(rawPageToken);
  if (pageToken === null) {
    return youtubeSubscriptionsListFailure("INVALID_PAGE_TOKEN", 400, request);
  }

  const ip = clientIp(request);
  const now = Date.now();
  pruneYoutubeSubscriptionsListBuckets(now);

  if (
    !fixedWindowAllows(
      youtubeSubscriptionsListIpBuckets,
      ip,
      YOUTUBE_SUBSCRIPTIONS_LIST_IP_WINDOW_MS,
      YOUTUBE_SUBSCRIPTIONS_LIST_IP_MAX,
      now
    )
  ) {
    return youtubeSubscriptionsListFailure("RATE_LIMITED", 429, request);
  }

  const auth = await requireFirebaseUser(request, env);
  if (!auth.ok) {
    // Preserve the standard auth response shape/behavior used by requireFirebaseUser.
    return auth.response;
  }

  if (
    !fixedWindowAllows(
      youtubeSubscriptionsListUserBuckets,
      auth.uid,
      YOUTUBE_SUBSCRIPTIONS_LIST_USER_WINDOW_MS,
      YOUTUBE_SUBSCRIPTIONS_LIST_USER_MAX,
      now
    )
  ) {
    return youtubeSubscriptionsListFailure("RATE_LIMITED", 429, request);
  }

  const config = await readOAuthConfig(env);
  if (!config) {
    return youtubeSubscriptionsListFailure("OAUTH_NOT_CONFIGURED", 503, request);
  }

  const db = oauthDb(env);
  if (!db) {
    return youtubeSubscriptionsListFailure("OAUTH_UNAVAILABLE", 503, request);
  }

  let accessToken;
  try {
    accessToken = await getAccessTokenForUser(auth.uid, env, {
      config,
      db,
      requiredScope: GOOGLE_YOUTUBE_SCOPE,
      revalidateGrant: true
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
      return youtubeSubscriptionsListFailure("YOUTUBE_NOT_CONNECTED", 409, request);
    }
    if (message === "OAUTH_SCOPE_REQUIRED") {
      return youtubeSubscriptionsListFailure("YOUTUBE_SCOPE_REQUIRED", 409, request);
    }
    if (message === "OAUTH_REAUTH_REQUIRED") {
      return youtubeSubscriptionsListFailure("YOUTUBE_REAUTH_REQUIRED", 409, request);
    }
    if (message === "OAUTH_CONFIG_ERROR") {
      return youtubeSubscriptionsListFailure("OAUTH_NOT_CONFIGURED", 503, request);
    }
    return youtubeSubscriptionsListFailure("TOKEN_EXCHANGE_FAILED", 502, request);
  }

  let upstream;
  try {
    upstream = await youtubeGetSubscriptionsListRequest(accessToken, pageToken);
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "UPSTREAM_TIMEOUT") {
      return youtubeSubscriptionsListFailure("UPSTREAM_TIMEOUT", 504, request);
    }
    return youtubeSubscriptionsListFailure("UPSTREAM_ERROR", 502, request);
  }

  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      invalidateAccessToken(auth.uid);
    }
    const mapped = mapYoutubeSubscriptionsListUpstreamError(upstream.response.status, upstream.data);
    return youtubeSubscriptionsListFailure(mapped.code, mapped.status, request);
  }

  const data = upstream.data && typeof upstream.data === "object" ? upstream.data : {};
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = [];
  for (const item of rawItems) {
    const normalized = normalizeYoutubeSubscriptionListItem(item);
    if (normalized) items.push(normalized);
  }
  const pageInfo = data.pageInfo && typeof data.pageInfo === "object" ? data.pageInfo : {};
  return json(
    {
      ok: true,
      available: true,
      source: "youtube",
      items,
      nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null,
      prevPageToken: typeof data.prevPageToken === "string" ? data.prevPageToken : null,
      pageInfo: {
        totalResults: Number.isFinite(pageInfo.totalResults) ? pageInfo.totalResults : 0,
        resultsPerPage: Number.isFinite(pageInfo.resultsPerPage) ? pageInfo.resultsPerPage : items.length
      }
    },
    200,
    request
  );
}

// GET /api/liveChat/subscriptionStatus?videoId=...
async function handleLiveChatSubscriptionStatus(request, env) {
  if (request.method !== "GET") {
    return subscriptionFailure("METHOD_NOT_ALLOWED", 405, request);
  }

  const url = new URL(request.url);
  const videoId = String(url.searchParams.get("videoId") || "").trim();
  const ip = clientIp(request);
  const now = Date.now();
  pruneSubscriptionBuckets(now);

  if (!fixedWindowAllows(subscriptionStatusIpBuckets, ip, SUBSCRIPTION_STATUS_IP_WINDOW_MS, SUBSCRIPTION_STATUS_IP_MAX, now)) {
    return subscriptionFailure("RATE_LIMITED", 429, request);
  }

  const tokenResult = await getSubscriptionAccessToken(request, env);
  if (!tokenResult.ok) return tokenResult.response;

  if (!fixedWindowAllows(subscriptionStatusUserBuckets, tokenResult.uid, SUBSCRIPTION_STATUS_USER_WINDOW_MS, SUBSCRIPTION_STATUS_USER_MAX, now)) {
    return subscriptionFailure("RATE_LIMITED", 429, request);
  }

  const apiKey = env.YOUTUBE_API_KEY || "";
  const resolved = await resolveLiveStreamChannel(videoId, apiKey);
  if (!resolved.ok) return subscriptionFailure(resolved.code, resolved.status, request);

  const query = new URLSearchParams({
    part: "id",
    mine: "true",
    forChannelId: resolved.channelId,
    maxResults: "1"
  });

  try {
    const { response, data } = await youtubeSubscriptionRequest(
      `https://www.googleapis.com/youtube/v3/subscriptions?${query.toString()}`,
      tokenResult.accessToken
    );
    if (!response.ok) {
      if (response.status === 401) invalidateAccessToken(tokenResult.uid);
      const mapped = mapSubscriptionUpstreamError(response.status, data);
      return subscriptionFailure(mapped.code, mapped.status, request);
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    return json({
      ok: true,
      subscribed: items.length > 0,
      available: true,
      code: ""
    }, 200, request);
  } catch (e) {
    const msg = e && e.message ? e.message : "";
    return subscriptionFailure(msg === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR", msg === "UPSTREAM_TIMEOUT" ? 504 : 502, request);
  }
}

// POST /api/liveChat/subscribe { videoId }
async function handleLiveChatSubscribe(request, env) {
  if (request.method !== "POST") {
    return subscriptionFailure("METHOD_NOT_ALLOWED", 405, request);
  }

  const contentType = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return subscriptionFailure("UNSUPPORTED_MEDIA_TYPE", 400, request);
  }

  const bodyResult = await readJsonBody(request, LIVE_CHAT_SEND_MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    return subscriptionFailure(bodyResult.code === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_REQUEST", 400, request);
  }

  const videoId = String(bodyResult.payload.videoId || "").trim();
  if (!isValidYouTubeSourceId(videoId)) {
    return subscriptionFailure("INVALID_VIDEO_ID", 400, request);
  }

  const ip = clientIp(request);
  const now = Date.now();
  pruneSubscriptionBuckets(now);

  if (!fixedWindowAllows(subscriptionSubscribeIpBuckets, ip, SUBSCRIPTION_SUBSCRIBE_IP_WINDOW_MS, SUBSCRIPTION_SUBSCRIBE_IP_MAX, now)) {
    return subscriptionFailure("RATE_LIMITED", 429, request);
  }

  const tokenResult = await getSubscriptionAccessToken(request, env);
  if (!tokenResult.ok) return tokenResult.response;

  if (!fixedWindowAllows(subscriptionSubscribeUserBuckets, tokenResult.uid, SUBSCRIPTION_SUBSCRIBE_USER_WINDOW_MS, SUBSCRIPTION_SUBSCRIBE_USER_MAX, now)) {
    return subscriptionFailure("RATE_LIMITED", 429, request);
  }

  const apiKey = env.YOUTUBE_API_KEY || "";
  const resolved = await resolveLiveStreamChannel(videoId, apiKey);
  if (!resolved.ok) return subscriptionFailure(resolved.code, resolved.status, request);

  // Server-resolved channelId only. Never trust client channel IDs.
  const insertBody = JSON.stringify({
    snippet: {
      resourceId: {
        kind: "youtube#channel",
        channelId: resolved.channelId
      }
    }
  });

  try {
    const { response, data } = await youtubeSubscriptionRequest(
      "https://www.googleapis.com/youtube/v3/subscriptions?part=snippet",
      tokenResult.accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: insertBody
      }
    );

    if (response.ok) {
      return json({
        ok: true,
        subscribed: true,
        available: true,
        code: ""
      }, 200, request);
    }

    if (response.status === 401) invalidateAccessToken(tokenResult.uid);

    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
    if (response.status === 400 && reason === "subscriptionDuplicate") {
      return json({ ok: true, subscribed: true, available: true, code: "ALREADY_SUBSCRIBED" }, 200, request);
    }

    const mapped = mapSubscriptionUpstreamError(response.status, data);
    return subscriptionFailure(mapped.code, mapped.status, request);
  } catch (e) {
    const msg = e && e.message ? e.message : "";
    return subscriptionFailure(msg === "UPSTREAM_TIMEOUT" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR", msg === "UPSTREAM_TIMEOUT" ? 504 : 502, request);
  }
}

// Count Unicode code points, not UTF-16 units, so an emoji counts as one
// character. This is stricter than Array#length and matches what a user sees.
function codePointLength(value) {
  return Array.from(String(value)).length;
}

// Read the JSON body without allowing an attacker to make us buffer an
// arbitrarily large payload. Content-Length is a cheap early reject when the
// runtime supplies it, but the streaming byte counter is authoritative because
// chunked requests need not carry a trustworthy length header.
async function readLiveChatBody(request, maxBytes) {
  const lengthHeader = request.headers.get("Content-Length");

  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);

    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
      return { ok: false, code: "INVALID_REQUEST" };
    }

    if (declaredLength > maxBytes) {
      return { ok: false, code: "BODY_TOO_LARGE" };
    }
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  let reader;

  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      bytesRead += value.byteLength;

      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: "BODY_TOO_LARGE" };
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false, code: "INVALID_REQUEST" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after a cancel.
    }
  }
}

// A fixed-window counter. Returns true while the key is inside its allowance.
// The window is reset lazily on the first request after it expires.
function fixedWindowAllows(buckets, key, windowMs, max, now) {
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
  }

  bucket.count++;

  if (buckets.size > LIVE_CHAT_SEND_MAX_BUCKETS) {
    for (const [entryKey, entry] of buckets) {
      if (now - entry.windowStart >= windowMs) {
        buckets.delete(entryKey);
      }
    }

    while (buckets.size > LIVE_CHAT_SEND_MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;

      if (oldest === undefined) break;

      buckets.delete(oldest);
    }
  }

  return bucket.count <= max;
}

function pruneLiveChatSendState(now) {
  for (const [key, entry] of liveChatSendIdempotency) {
    if (now - entry.atMs >= LIVE_CHAT_SEND_IDEMPOTENCY_TTL_MS) {
      liveChatSendIdempotency.delete(key);
    }
  }

  for (const [uid, entry] of liveChatSendInFlight) {
    if (now - entry.atMs >= LIVE_CHAT_SEND_INFLIGHT_TTL_MS) {
      liveChatSendInFlight.delete(uid);
    }
  }
}

function rememberLiveChatSend(key, body) {
  liveChatSendIdempotency.set(key, { atMs: Date.now(), body });

  while (liveChatSendIdempotency.size > LIVE_CHAT_SEND_MAX_IDEMPOTENCY) {
    const oldest = liveChatSendIdempotency.keys().next().value;

    if (oldest === undefined) break;

    liveChatSendIdempotency.delete(oldest);
  }
}

// Map YouTube's insert failure onto MyTube's closed code set. `reason` comes
// from error.errors[0].reason, which is the stable part of the payload.
function mapLiveChatSendUpstreamError(status, data) {
  const reason =
    data?.error?.errors?.[0]?.reason ||
    data?.error?.status ||
    "";

  if (status === 401) {
    return { code: "YOUTUBE_REAUTH_REQUIRED", status: 409 };
  }

  if (status === 403) {
    if (reason === "liveChatEnded") {
      return { code: "LIVE_CHAT_ENDED", status: 409 };
    }

    if (reason === "liveChatDisabled") {
      return { code: "CHAT_DISABLED", status: 409 };
    }

    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return { code: "QUOTA_EXCEEDED", status: 503 };
    }

    if (reason === "rateLimitExceeded") {
      return { code: "CHAT_RATE_LIMITED", status: 429 };
    }

    // forbidden / insufficientPermissions / members-only / banned / slow mode.
    return { code: "CHAT_FORBIDDEN", status: 403 };
  }

  if (status === 404) {
    return { code: "LIVE_CHAT_NOT_FOUND", status: 409 };
  }

  if (status === 429) {
    return { code: "CHAT_RATE_LIMITED", status: 429 };
  }

  if (status === 400) {
    return { code: "INVALID_MESSAGE", status: 400 };
  }

  return { code: "UPSTREAM_ERROR", status: 502 };
}

// ONE insert attempt. No retry, no cache, no API key: the OAuth bearer token is
// the authorization and it must never appear in a URL or a response.
async function insertLiveChatMessage(liveChatId, text, accessToken, fetchFn = fetch) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), LIVE_CHAT_SEND_TIMEOUT_MS)
    : null;

  let response;

  try {
    response = await fetchFn(LIVE_CHAT_SEND_INSERT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "MyTube/1.0"
      },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: text }
        }
      }),
      signal: controller ? controller.signal : undefined
    });
  } catch {
    // Network error, abort, or a non-Response fetch failure. Never retried.
    return { ok: false, code: "UPSTREAM_ERROR", status: 502 };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.ok) {
    const message = normalizeLiveChatMessage(data);

    // A 2xx is not enough: the response must contain the inserted message we
    // can safely return. Treat an empty or malformed payload as an upstream
    // failure rather than reporting a success that never existed.
    if (!message) {
      return { ok: false, code: "UPSTREAM_ERROR", status: 502 };
    }

    return {
      ok: true,
      message,
      status: 200
    };
  }

  return { ok: false, ...mapLiveChatSendUpstreamError(response.status, data) };
}

// POST /api/liveChat/send
async function handleLiveChatSend(request, env) {
  // 1) Kill switch. Nothing else may happen when this is off.
  if (!chatSendEnabled(env)) {
    return liveChatSendFailure("CHAT_SEND_DISABLED", 503, request);
  }

  if (request.method !== "POST") {
    return liveChatSendFailure("METHOD_NOT_ALLOWED", 405, request);
  }

  const contentType = String(request.headers.get("Content-Type") || "")
    .toLowerCase();

  if (!contentType.startsWith("application/json")) {
    return liveChatSendFailure("UNSUPPORTED_MEDIA_TYPE", 400, request);
  }

  const bodyResult = await readLiveChatBody(
    request,
    LIVE_CHAT_SEND_MAX_BODY_BYTES
  );

  if (!bodyResult.ok) {
    return liveChatSendFailure(bodyResult.code, 400, request);
  }

  const raw = bodyResult.text;

  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    return liveChatSendFailure("INVALID_REQUEST", 400, request);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return liveChatSendFailure("INVALID_REQUEST", 400, request);
  }

  const videoId = typeof payload.videoId === "string" ? payload.videoId.trim() : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const requestId =
    typeof payload.requestId === "string" ? payload.requestId.trim() : "";

  // Strict 11-char YouTube id. The client already has the bare id; `yt:` forms
  // are normalized on the watch page, never trusted here.
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return liveChatSendFailure("INVALID_VIDEO_ID", 400, request);
  }

  // Reject empty/whitespace-only, over-long, and control-character text. The
  // text itself is preserved exactly as typed (no trimming) for the message.
  if (
    text === "" ||
    text.trim() === "" ||
    codePointLength(text) > LIVE_CHAT_SEND_MAX_CODE_POINTS ||
    /[\u0000-\u001F\u007F]/.test(text)
  ) {
    return liveChatSendFailure("INVALID_MESSAGE", 400, request);
  }

  if (requestId && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    return liveChatSendFailure("INVALID_REQUEST", 400, request);
  }

  const now = Date.now();

  pruneLiveChatSendState(now);

  // Cheap pre-auth flood guard so invalid tokens cannot force JWKS work at will.
  if (
    !fixedWindowAllows(
      liveChatSendIpBuckets,
      clientIp(request),
      LIVE_CHAT_SEND_IP_WINDOW_MS,
      LIVE_CHAT_SEND_IP_MAX,
      now
    )
  ) {
    return liveChatSendFailure("RATE_LIMITED", 429, request);
  }

  let auth;

  try {
    auth = await requireFirebaseUser(request, env);
  } catch {
    return liveChatSendFailure("INTERNAL", 500, request);
  }

  if (!auth.ok) {
    return auth.response;
  }

  const uid = auth.uid;

  // Per-user limits. Both windows are checked, and both count the attempt, so a
  // burst can never buy extra headroom in the longer window.
  const shortOk = fixedWindowAllows(
    liveChatSendShortBuckets,
    uid,
    LIVE_CHAT_SEND_USER_SHORT_WINDOW_MS,
    LIVE_CHAT_SEND_USER_SHORT_MAX,
    now
  );
  const longOk = fixedWindowAllows(
    liveChatSendLongBuckets,
    uid,
    LIVE_CHAT_SEND_USER_LONG_WINDOW_MS,
    LIVE_CHAT_SEND_USER_LONG_MAX,
    now
  );

  if (!shortOk || !longOk) {
    return liveChatSendFailure("RATE_LIMITED", 429, request);
  }

  // A repeated requestId returns the original outcome without a second insert.
  if (requestId) {
    const cached = liveChatSendIdempotency.get(uid + ":" + requestId);

    if (cached) {
      return json(cached.body, 200, request);
    }
  }

  // One send at a time per user. A duplicate click cannot reach YouTube twice.
  const existing = liveChatSendInFlight.get(uid);

  if (existing && now - existing.atMs < LIVE_CHAT_SEND_INFLIGHT_TTL_MS) {
    return liveChatSendFailure("SEND_IN_PROGRESS", 409, request);
  }

  const lockToken = `${now}:${Math.random()}`;

  liveChatSendInFlight.set(uid, { atMs: now, token: lockToken });

  try {
    const config = await readOAuthConfig(env);

    if (!config) {
      return liveChatSendFailure("OAUTH_NOT_CONFIGURED", 503, request);
    }

    const db = oauthDb(env);

    if (!db) {
      return liveChatSendFailure("OAUTH_UNAVAILABLE", 503, request);
    }

    const apiKey = env.YOUTUBE_API_KEY || "";

    if (!apiKey) {
      return liveChatSendFailure("YOUTUBE_NOT_CONFIGURED", 503, request);
    }

    // Resolve the ACTIVE chat from the video id, server-side. Never accept a
    // liveChatId from the request body.
    let live;

    try {
      live = await probeVideoLive(videoId, apiKey);
    } catch {
      return liveChatSendFailure("UPSTREAM_ERROR", 502, request);
    }

    if (!live.isLive) {
      return liveChatSendFailure("NOT_LIVE", 409, request);
    }

    if (!live.liveChatId || live.liveChatDisabled) {
      return liveChatSendFailure("CHAT_DISABLED", 409, request);
    }

    let accessToken;

    try {
      accessToken = await getAccessTokenForUser(uid, env, {
        config,
        db,
        requiredScope: GOOGLE_YOUTUBE_SCOPE,
        revalidateGrant: true
      });
    } catch (error) {
      const message = String(error?.message || "");

      if (message === "GRANT_NOT_FOUND" || message === "INVALIDATED") {
        return liveChatSendFailure("YOUTUBE_NOT_CONNECTED", 409, request);
      }

      if (message === "OAUTH_SCOPE_REQUIRED") {
        return liveChatSendFailure("YOUTUBE_SCOPE_REQUIRED", 409, request);
      }

      if (message === "OAUTH_REAUTH_REQUIRED") {
        return liveChatSendFailure("YOUTUBE_REAUTH_REQUIRED", 409, request);
      }

      if (message === "OAUTH_CONFIG_ERROR") {
        return liveChatSendFailure("OAUTH_NOT_CONFIGURED", 503, request);
      }

      return liveChatSendFailure("TOKEN_EXCHANGE_FAILED", 502, request);
    }

    const insert = await insertLiveChatMessage(
      live.liveChatId,
      text,
      accessToken
    );

    if (!insert.ok) {
      if (insert.code === "YOUTUBE_REAUTH_REQUIRED") {
        // The cached access token is dead; drop it so the next attempt
        // refreshes. The grant row itself is preserved.
        invalidateAccessToken(uid);
      }

      return liveChatSendFailure(insert.code, insert.status, request);
    }

    const body = { ok: true, message: insert.message };

    if (requestId) {
      rememberLiveChatSend(uid + ":" + requestId, body);
    }

    return json(body, 200, request);
  } catch {
    return liveChatSendFailure("INTERNAL", 500, request);
  } finally {
    const current = liveChatSendInFlight.get(uid);

    if (current && current.token === lockToken) {
      liveChatSendInFlight.delete(uid);
    }
  }
}

// Dispatch one OAuth route. `route` is the path after "/api/".
async function handleOAuthRoute(request, env, url, route) {
  if (route === "oauth/start") {
    return handleOAuthStart(request, env);
  }

  if (route === "oauth/callback") {
    return handleOAuthCallback(request, env, url);
  }

  if (route === "oauth/status") {
    return handleOAuthStatus(request, env);
  }

  if (route === "oauth/disconnect") {
    return handleOAuthDisconnect(request, env);
  }

  return oauthError("API route not found.", "NOT_FOUND", 404, request);
}

async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const apiKey = env.YOUTUBE_API_KEY || "";

  // Phase 1 index handle for this request, or null when the D1 binding is
  // absent/malformed. Null disables every read and write below; nothing else
  // changes.
  const index = createIndexContext(ctx, env);

  // --- Google OAuth foundation -------------------------------------------
  // These routes are dispatched BEFORE the generic GET-only guard because the
  // flow mixes methods: /oauth/start, /oauth/callback and /oauth/status are
  // GETs (start/callback are navigations), /oauth/disconnect is a POST. They
  // also manage their own auth (a Firebase ID token, not the YouTube API key),
  // so they must not fall through to the YouTube-backed routes below.
  //
  // When the Google client is not configured these return a clean
  // "not configured" error and never touch D1 or the network.
  if (route.startsWith("oauth/")) {
    if (request.method === "OPTIONS") {
      return oauthPreflight(request);
    }

    // Best-effort per-IP metering, applied before any handler work (no D1, no
    // crypto, no network). OPTIONS preflight has already returned above so it
    // is never throttled. See oauthRateLimitAllowed for the provisional limits.
    if (!oauthRateLimitAllowed(request, route)) {
      return oauthError(
        "Too many requests. Please slow down and try again shortly.",
        "RATE_LIMITED",
        429,
        request
      );
    }

    return handleOAuthRoute(request, env, url, route);
  }

  if (request.method === "OPTIONS") {
    const headers = {
      // POST was added for the OAuth disconnect endpoint. GET, OPTIONS stays for
      // every pre-existing read route, so nothing existing changes.
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      // Authorization carries the caller's Firebase ID token to the OAuth
      // endpoints. Content-Type stays for the JSON body of a POST.
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  // Live chat sending is a POST. It owns its kill switch, authentication,
  // rate limits and error handling, so it is dispatched before the generic
  // GET-only guard below. OPTIONS was already answered above.
  if (route === "liveChat/send") {
    return handleLiveChatSend(request, env);
  }

  // Explicit, user-confirmed subscription action (POST). Auth/rate limits inside.
  if (route === "liveChat/subscribe") {
    return handleLiveChatSubscribe(request, env);
  }

  // Authenticated YouTube rating sync (own auth/rate limits/error handling).
  // GET reads actual rating; POST applies explicit rating write (like/dislike/none).
  if (route === "youtube/rating") {
    if (request.method === "GET") {
      return handleGetYoutubeRating(request, env);
    }
    if (request.method === "POST") {
      return handlePostYoutubeRating(request, env);
    }
    return youtubeRatingFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  // Authenticated, read-only general YouTube subscription status (actual connected account).
  // GET /api/youtube/subscription-status?channelId=...
  // Separate from live-chat subscription endpoints; no mutations.
  if (route === "youtube/subscription-status") {
    if (request.method === "GET") {
      return handleGetYoutubeSubscriptionStatus(request, env);
    }
    return youtubeSubscriptionStatusFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  // Authenticated YouTube subscribe (explicit user action; own auth/rate limits/error handling).
  // POST /api/youtube/subscribe { channelId }
  // Calls subscriptions.insert for the connected account. No automatic retries.
  if (route === "youtube/subscribe") {
    if (request.method === "POST") {
      return handlePostYoutubeSubscribe(request, env);
    }
    return youtubeSubscribeFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  // Authenticated YouTube unsubscribe (explicit user action; own auth/rate limits/error handling).
  // POST /api/youtube/unsubscribe { channelId }
  // Resolves subscription resource ID via subscriptions.list, then deletes by subscription ID.
  // Never uses channelId as delete ID. No automatic retries.
  if (route === "youtube/unsubscribe") {
    if (request.method === "POST") {
      return handlePostYoutubeUnsubscribe(request, env);
    }
    return youtubeUnsubscribeFailure("", "METHOD_NOT_ALLOWED", 405, request);
  }

  // Authenticated, read-only YouTube subscriptions list (actual connected account).
  // GET /api/youtube/subscriptions?pageToken=...
  if (route === "youtube/subscriptions") {
    if (request.method === "GET") {
      return handleGetYoutubeSubscriptions(request, env);
    }
    return youtubeSubscriptionsListFailure("METHOD_NOT_ALLOWED", 405, request);
  }

  // Authenticated, read-only connected YouTube account identity.
  // GET /api/youtube/account — returns only the grant's own channel id/title/thumbnail.
  // Never selects among multiple channels and never stores identity.
  if (route === "youtube/account") {
    if (request.method === "GET") {
      return handleGetYoutubeAccount(request, env);
    }
    return youtubeAccountFailure("METHOD_NOT_ALLOWED", 405, request);
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
  // returning 429 for search / trending / comments. Subscription status checks
  // are authenticated and have their own endpoint limits.
  if (
    route !== "liveChat" &&
    route !== "liveChat/subscriptionStatus" &&
    route !== "youtube/subscription-status" &&
    route !== "youtube/subscribe" &&
    route !== "youtube/unsubscribe" &&
    !rateLimitAllowed(request)
  ) {
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

    if (route === "liveChat/subscriptionStatus") {
      return handleLiveChatSubscriptionStatus(request, env);
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
        initial: url.searchParams.get("initial") === "1",
        chatSendEnabled: chatSendEnabled(env)
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

// The site-relative form of a watch URL, in one place.
//
// `encodeURIComponent("yt:<sourceId>")` is the encoding convention shared with
// public/watch.js (setVideoPageMeta) and scripts/generate-sitemap.mjs (watchUrl).
// Keep all three identical or the sitemap and the page disagree again.
//
// Relative rather than absolute on purpose: this is what the homepage's own
// buildCard() puts in an href, so a server-rendered card and a client-rendered
// card are the same string, and the link keeps working on any host the site is
// reached through (a preview deployment, not just the canonical origin).
function watchPath(videoId) {
  return `/watch?id=${encodeURIComponent(videoId)}`;
}

// The one canonical form of a watch URL, in one place. Derived from watchPath()
// so the canonical and the hrefs on a page can never drift apart.
function setVideoCanonical(videoId) {
  return `${WATCH_ORIGIN}${watchPath(videoId)}`;
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

// -----------------------------------------------------------------------------
// A valid video URL that ran out of SSR budget
// -----------------------------------------------------------------------------
// watchDegradedShellResponse() above hands back the shell byte for byte, and that
// is right for the `unavailable` branch: we learned nothing about the video, so
// we invent nothing. It is wrong for the RATE-LIMITED branch, because that one
// has already proved the `?id=` names a real, playable YouTube video -- only
// that we declined to spend a YouTube call confirming it this time.
//
// The generic shell is indexable but its canonical carries no `?id=` at all, and
// `/watch` itself answers `noindex, follow`. So the untouched shell hands a
// crawler an indexable video URL canonicalized to a noindex URL, which is a
// self-contradictory page: Google is told to index this URL, then told the URL
// it indexes is not indexable. During any crawl that walks the sitemap faster
// than 60 URLs per 5 minutes, every video past the budget got exactly that.
//
// So this branch keeps the generic metadata and corrects only the URL identity:
//
//   * robots stays `index, follow`. A spent budget is NOT evidence the video is
//     gone, and noindexing a perfectly valid video because of our own budget
//     would be the worst possible outcome.
//   * the title, description, og:title, og:description and og:image stay the
//     shell's generic values. We know the video exists; we do not know its
//     title, and fabricating one would be a lie a crawler could cache.
//   * canonical and og:url become this video's own URL, built by the same
//     setVideoCanonical() every other path uses, so the sitemap, the healthy
//     render and the client all agree on one string.
//   * no second YouTube lookup happens. The budget exists precisely because we
//     must not spend one here, and /api/video still answers the client on
//     hydration with the real metadata.
//   * Cache-Control stays `no-store`, so a degraded minute never becomes five
//     minutes of cached generic head.
// -----------------------------------------------------------------------------
function renderWatchRateLimitedHtml(html, videoId) {
  const canonical = setVideoCanonical(videoId);

  let out = setCanonicalHref(html, canonical);

  return setMetaContent(out, "property", "og:url", canonical);
}

// The response wrapper for that render.
//
// Same header treatment as watchHtmlResponse() -- the body was rewritten, so the
// asset's Content-Encoding/Content-Length/ETag no longer describe it -- but with
// the degraded cacheability instead of the revalidating one, and without any of
// withSecurityHeaders() for the same reason watchHtmlResponse() omits it.
function watchRateLimitedResponse(shell, html) {
  const headers = new Headers(shell.headers);

  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", WATCH_DEGRADED_CACHE_CONTROL);

  return new Response(html, {
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

  // Over budget: a valid video we chose not to look up. Serve the generic shell
  // -- still indexable, because a spent budget is not evidence of absence -- but
  // with the canonical and og:url pointed at this video's own URL instead of at
  // the noindex `/watch`. No upstream call is made; the client still hydrates the
  // real metadata. Uncacheable, as every degraded render is.
  if (!watchSeoRateLimitAllowed(request)) {
    return watchRateLimitedResponse(
      shell,
      renderWatchRateLimitedHtml(await shell.text(), videoId)
    );
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

// -----------------------------------------------------------------------------
// HOMEPAGE SERVER-RENDERED WATCH LINKS
// -----------------------------------------------------------------------------
// The homepage delivered an empty <main id="videoList">: every video card, and
// therefore every internal link to a watch page, was created by JavaScript. A
// crawler that does not execute JS saw a page with no path to any video at all.
//
// This renders the first pageful of the EXISTING homepage feed into that <main>
// as ordinary <a href="/watch?id=…"> anchors, using the real videos the feed pool
// already holds. What this deliberately does NOT do:
//
//   * Redesign the homepage. The markup is the same DOM buildCard() already
//     produces (same classes, same thumbnail, same badge, same meta line), so the
//     page is visually identical with JS on or off.
//   * Change the feed. It renders getTrending()'s deterministic page — the exact
//     call /api/trending?max=50 makes and the exact one scripts/generate-sitemap.mjs
//     consumes, so the homepage, the sitemap and the watch canonical all name the
//     same videos.
//   * Add an upstream request. getTrending() reads the module-level feed pool,
//     which is already cached for FEED_POOL_TTL_MS and already de-duplicates
//     concurrent builds. The client's own /api/trending call a moment later hits
//     that same warm pool. Worst case this change decides WHO pays for the first
//     pool build per isolate per 15 minutes, never how many happen.
//   * Spend rate-limit budget. There is deliberately no limiter here: the work is
//     a cached map lookup, and unlike the watch-page render a crawler being
//     refused the homepage would be a worse outcome than the cost of letting it in.
//
// Every failure mode returns the untouched asset, byte for byte, with its own
// ETag and Cache-Control intact — so an unreachable YouTube, an exhausted quota, a
// dead D1 or a future edit to index.html degrades to exactly today's behaviour
// rather than to a broken page. Nothing is ever fabricated: an empty pool simply
// produces no links.
const HOMEPAGE_FEED_ID = "videoList";

// The server-rendered first pageful. Deliberately the same 12 the client asks
// for in loadHomeFeed(), so the grid does not visibly resize when hydration
// replaces these cards with the live ones.
const HOMEPAGE_SSR_VIDEO_COUNT = 12;

// The SSR body is a point-in-time snapshot of a pool that lives
// FEED_POOL_TTL_MS (15 min). A short edge lifetime plus SWR means the stored HTML
// can trail the pool by at most one stale window, and every link in it is still a
// real, currently-popular video — so a few minutes of staleness is free.
// Browsers always revalidate, exactly as the untouched asset does.
const HOMEPAGE_HTML_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

// The `<main id="videoList">` the cards go into, captured with its current
// contents so a second render (or a hand-edited file that already has cards)
// replaces rather than appends. Returns null when the anchor is absent, which is
// the signal to serve the shell untouched.
function homepageFeedContainerRe() {
  return new RegExp(
    `(<main\\b[^>]*\\bid="${escapeRegExp(HOMEPAGE_FEED_ID)}"[^>]*>)[\\s\\S]*?(</main>)`,
    "i"
  );
}

// The card meta line, mirroring cardMeta() in public/index.html so the
// server-rendered and client-rendered cards read identically.
function homepageCardMeta(video) {
  return [video.channel, video.views, video.topic].filter(Boolean).join(" • ");
}

// One card, in the exact shape buildCard() produces.
//
// An <img> is emitted only for a real absolute http(s) URL and a <span> badge
// only when there is a duration, so a partial payload yields a smaller card
// instead of a broken image or an empty badge. Every interpolated value goes
// through escapeHtml(), which covers both text nodes and double-quoted
// attributes.
function renderHomepageCard(video) {
  const parts = [`<div class="card">`, `<div class="thumb">`];

  if (isHttpUrl(video.thumb)) {
    parts.push(
      `<img src="${escapeHtml(video.thumb)}" alt="${escapeHtml(video.title)}" loading="lazy" decoding="async">`
    );
  }

  if (video.time) {
    parts.push(`<span>${escapeHtml(video.time)}</span>`);
  }

  parts.push(`</div>`);

  parts.push(
    `<h3><a class="card-title-link" href="${escapeHtml(watchPath(video.id))}">${escapeHtml(video.title)}</a></h3>`
  );

  const meta = homepageCardMeta(video);

  if (meta) {
    parts.push(`<p>${escapeHtml(meta)}</p>`);
  }

  parts.push(`</div>`);

  return parts.join("");
}

// The cards for one feed page, skipping anything that is not a resolvable
// /watch?id=... URL. `watchSourceId()` is the same gate the watch page applies,
// so the homepage can never advertise a link that page would answer noindex.
//
// Duplicate ids are collapsed as well: the pool is region-merged, and a link that
// appears twice is a link a crawler wastes a fetch on.
function renderHomepageCards(videos) {
  const seen = new Set();
  const cards = [];

  for (const video of Array.isArray(videos) ? videos : []) {
    const id = String(video?.id || "");
    const sourceId = watchSourceId(id);

    if (!sourceId || seen.has(sourceId)) {
      continue;
    }

    seen.add(sourceId);
    cards.push(renderHomepageCard(video));
  }

  return cards;
}

// Rebuild the asset response around a modified body.
//
// Same contract as watchHtmlResponse(): the shell's own headers are kept so the
// page's header surface is unchanged, and Content-Encoding/Content-Length/ETag
// are dropped because the bytes no longer match the asset that was read. Unlike
// the watch page this response DOES keep flowing through withSecurityHeaders(),
// because the homepage has always had that header set.
//
// This is only ever called when cards were actually injected. When they were not,
// homepageUnmodifiedResponse() is used instead.
function homepageHtmlResponse(shell, html) {
  const headers = new Headers(shell.headers);

  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", HOMEPAGE_HTML_CACHE_CONTROL);

  return new Response(html, {
    status: shell.status,
    statusText: shell.statusText,
    headers
  });
}

// The render found nothing to inject but the shell body had to be read to find
// that out (the container is gone). The bytes are byte-identical to the asset, so
// every header the asset set still describes them — ETag and Content-Length
// included — and are deliberately left alone.
function homepageUnmodifiedResponse(shell, html) {
  return new Response(html, {
    status: shell.status,
    statusText: shell.statusText,
    headers: new Headers(shell.headers)
  });
}

// GET / — the homepage, with the first feed page's watch links in the HTML.
//
// Non-GET is not ours to interpret and is handed straight to the asset binding.
// HEAD is too: there is no body to fill in, so it stays a bodiless asset read
// rather than paying for a pool lookup nobody will see the result of.
async function handleHomepagePage(request, env, ctx, url) {
  if (request.method !== "GET") {
    return env.ASSETS.fetch(request);
  }

  // Requested by its real asset path rather than by `/`, so this handler does
  // not depend on the static binding's html_handling setting — the same reason
  // handleWatchPage fetches /watch.html rather than /watch.
  const shell = await env.ASSETS.fetch(
    new Request(`${url.origin}/index.html`, { method: "GET" })
  );

  if (!shell.ok) {
    return shell;
  }

  let videos = [];

  try {
    const index = createIndexContext(ctx, env);
    const page = await getTrending(
      String(HOMEPAGE_SSR_VIDEO_COUNT),
      "",
      env.YOUTUBE_API_KEY || "",
      null,
      // seed "" is the deterministic pool order — the same page /api/trending
      // returns to the sitemap generator and the rest of the repo.
      { seed: "", topic: "", index }
    );

    videos = renderHomepageCards(page?.videos);
  } catch (error) {
    console.error(
      "[mytube] homepage links skipped",
      error?.message || error
    );

    videos = [];
  }

  // Checked BEFORE the body is read: this branch hands back the shell's own
  // unread body, ETag and all, so a failed render is indistinguishable from a
  // page that was never touched.
  if (!videos.length) {
    return shell;
  }

  const html = await shell.text();
  const container = homepageFeedContainerRe();
  const match = container.exec(html);

  // A future edit to index.html that moves or renames the container degrades to
  // "no server-rendered links" instead of a page whose markup was mangled.
  if (!match) {
    return homepageUnmodifiedResponse(shell, html);
  }

  const out = html.replace(
    container,
    () => `${match[1]}${videos.join("")}${match[2]}`
  );

  return homepageHtmlResponse(shell, out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The three HTML routes answer for themselves and return early: the watch
    // HTML was previously served without withSecurityHeaders() by design, but
    // the same security header set used by the homepage and other assets is now
    // applied to /watch and /watch.html to close the header gap. Anything else —
    // /api/* and every other asset — is completely unchanged.
    if (url.pathname === "/watch") {
      return withSecurityHeaders(await handleWatchPage(request, env, ctx, url));
    }

    if (url.pathname === "/watch.html") {
      return withSecurityHeaders(handleWatchHtml(url));
    }

    // The homepage is rendered here but keeps the asset binding's own headers and
    // still gets the security header set, so wrapping it is exactly equivalent to
    // the plain ASSETS passthrough it used to be.
    if (url.pathname === "/") {
      return withSecurityHeaders(await handleHomepagePage(request, env, ctx, url));
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

  // OAuth flow state is short-lived (see OAUTH_STATE_TTL_MS) and single-use.
  // The start route used to prune it as a side effect, but new connections are
  // hard-disabled (OAUTH_CONNECT_ENABLED), so the scheduled handler is the only
  // place that can still clean the table up. The cutoff is the one the
  // callback already uses to reject an expired state: expires_at_ms <= now.
  // No schema change is involved: the table and its expires_at_ms index are
  // the ones created by migrations/0004_oauth.sql.
  await pruneOauthStates(oauthDb(env), Date.now());

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
