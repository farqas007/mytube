import {
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse,
  normalizeLiveChatResponse,
  readLiveState
} from "./shared/normalize.js";

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

const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const memoryCache = new Map();

function json(data, status = 200, request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  if (originAllowed(request)) {
    headers["Access-Control-Allow-Origin"] = request.headers.get("Origin");
    headers["Vary"] = "Origin";
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

async function searchYouTube(query, max, apiKey, pageToken) {
  const params = {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: Math.min(Math.max(Number(max) || 20, 1), 50)
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
  }

  const videos = [];

  for (const item of searchData?.items || []) {
    const id = item?.id?.videoId;

    if (!id) continue;

    const video = normalizeSearchItem(
      item,
      detailsById.get(id) || null
    );

    if (video) {
      videos.push(video);
    }
  }

  return {
    videos,
    nextPageToken: searchData?.nextPageToken || ""
  };
}

async function getTrending(max, region, apiKey, pageToken) {
  const result = await ytFetch(
    "videos",
    {
      part: VIDEO_PARTS_FULL,
      chart: "mostPopular",
      regionCode: region || "PK",
      maxResults: Math.min(Math.max(Number(max) || 12, 1), 50),
      ...(pageToken ? { pageToken } : {})
    },
    apiKey
  );

  return normalizeVideosResponse(result.data);
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

async function getRelated(videoId, max, apiKey) {
  const target = await getVideoDetails(videoId, apiKey);

  if (!target) {
    return {
      videos: []
    };
  }

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

async function getChannelVideos(channelId, max, apiKey, pageToken) {
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

async function handleAPI(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const apiKey = env.YOUTUBE_API_KEY || "";

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
      const q = url.searchParams.get("q")?.trim();

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

      const max = url.searchParams.get("max") || "20";
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await searchYouTube(
        q,
        max,
        apiKey,
        pageToken
      );

      return json(result, 200, request);
    }

    if (route === "trending") {
      const max = url.searchParams.get("max") || "12";
      const region = url.searchParams.get("region") || "PK";
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await getTrending(
        max,
        region,
        apiKey,
        pageToken
      );

      return json(result, 200, request);
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
          request
        );
      }

      return json(
        {
          video: normalizeVideoItem(item)
        },
        200,
        request
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
        apiKey
      );

      return json(result, 200, request);
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
        pageToken
      );

      return json(result, 200, request);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const response = url.pathname.startsWith("/api/")
      ? await handleAPI(request, env)
      : await env.ASSETS.fetch(request);

    return withSecurityHeaders(response);
  }
};
