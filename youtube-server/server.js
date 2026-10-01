// =============================================================================
// MyTube — Phase 7 YouTube API Proxy + Static Server
// -----------------------------------------------------------------------------
// A small, dependency-free Node.js server (only Node's built-in modules) that:
//
//   1. Serves the static MyTube frontend files from the project root, so the
//      whole site runs from a single origin (no CORS needed).
//   2. Proxies the official YouTube Data API and normalizes the responses so
//      the frontend never sees raw YouTube JSON or the API key.
//
// The YouTube Data API key is read from the YOUTUBE_API_KEY environment
// variable. It is NEVER exposed to the browser. Run with:
//
//     node --env-file=.env youtube-server/server.js
//
// Configurable via env:
//   YOUTUBE_API_KEY   : your YouTube Data API key (required for live results)
//   PORT              : port to listen on (default 3456)
//   YT_ROOT           : absolute path to the project root (defaults to the
//                       directory two levels above this file)
// =============================================================================

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import * as normalize from "../shared/normalize.js";
import {
  FEED_POOL_TTL_MS,
  FEED_POOL_REGIONS,
  FEED_POOL_PAGE_SIZE,
  availableTopics,
  buildFeedPage,
  decodeFeedCursor,
  topicFromTags
} from "../shared/feed.js";
import {
  dedupeSearchResults,
  normalizeQuery,
  resolveSearchFilters,
  resolveSearchMax
} from "../shared/search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3456", 10);
const API_KEY = process.env.YOUTUBE_API_KEY || "";

// Project root = parent of the youtube-server directory.
const YT_ROOT = process.env.YT_ROOT
  ? path.resolve(process.env.YT_ROOT)
  : path.resolve(__dirname, "..");

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

// `liveStreamingDetails` is what exposes activeLiveChatId, which YouTube only
// returns while a broadcast is live. It costs no extra quota units on videos.list.
const VIDEO_PARTS_FULL = "snippet,contentDetails,statistics,status,liveStreamingDetails";

// Small in-memory cache to avoid spamming the quota during a session.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Utilities
// =============================================================================

function cacheGet(key){
  const entry = cache.get(key);
  if(!entry){
    return null;
  }
  if(Date.now() - entry.at > CACHE_TTL_MS){
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value){
  // Keep the cache reasonably small.
  if(cache.size > 200){
    const first = cache.keys().next().value;
    if(first !== undefined){
      cache.delete(first);
    }
  }
  cache.set(key, { at: Date.now(), value });
}

// Local development origins allowed to call the API cross-origin. The frontend
// is typically served by Live Server on these origins while the backend runs on
// http://localhost:3456, so the browser requires the API to send CORS headers.
// We allow the two local dev origins explicitly instead of using "*".
const CORS_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5504",
  "http://localhost:5504",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "http://127.0.0.1:8081",
  "http://localhost:8081"
];

function isAllowedOrigin(origin){
  return origin && CORS_ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

// Resolve the Access-Control-Allow-Origin value for a request. Returns the exact
// origin when it is on the allow-list, or null when it is not allowed.
function resolveAllowOrigin(req){
  const origin = req.headers.origin;
  return isAllowedOrigin(origin) ? origin : null;
}

// Simple per-IP sliding-window rate limit for the API. Local dev convenience:
// prevents an accidental tight-loop or shared use of a dev box from exhausting
// the shared YouTube quota. Limiter is in-memory; resets on restart.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 120;
const rateBuckets = new Map();

function rateLimitAllowed(req){
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, windowStart: now };

  if(now - bucket.windowStart >= RATE_WINDOW_MS){
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  rateBuckets.set(ip, bucket);

  if(rateBuckets.size > 5000){
    for(const [key, entry] of rateBuckets){
      if(now - entry.windowStart >= RATE_WINDOW_MS){
        rateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= RATE_MAX_PER_WINDOW;
}

// Dedicated budget for search.list, which costs a flat 100 quota units per call
// (versus 1 unit for videos.list). Mirrors searchRateLimitAllowed in worker.js so
// both backends behave identically.
const SEARCH_RATE_WINDOW_MS = 5 * 60 * 1000;
const SEARCH_RATE_MAX_PER_WINDOW = 40;
const searchRateBuckets = new Map();

function searchRateLimitAllowed(req){
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = searchRateBuckets.get(ip) || { count: 0, windowStart: now };

  if(now - bucket.windowStart >= SEARCH_RATE_WINDOW_MS){
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  searchRateBuckets.set(ip, bucket);

  if(searchRateBuckets.size > 5000){
    for(const [key, entry] of searchRateBuckets){
      if(now - entry.windowStart >= SEARCH_RATE_WINDOW_MS){
        searchRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= SEARCH_RATE_MAX_PER_WINDOW;
}

function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": res.allowOrigin || "",
    "Vary": "Origin"
  });
  res.end(body);
}

function logYouTubeError(err){
  console.error("YT API fail:",
    "status=" + (err.status || "?"),
    "reason=" + (err.youtubeReason || ""),
    "ytStatus=" + (err.youtubeStatus || ""),
    "message=" + (err.youtubeMessage || err.message || ""));
}

function normalizeError(err, fallback){
  let message = fallback;
  if(!err){
    return message;
  }
  const reason = err.youtubeReason || "";
  const status = err.youtubeStatus || "";
  const msg = (err.message || "").toLowerCase();

  // Quota errors — check YouTube reason/status fields precisely
  if(reason === "quotaExceeded" || reason === "dailyLimitExceeded" ||
     reason === "rateLimitExceeded" || status === "quotaExceeded"){
    message = "YouTube API quota exceeded. Please try again later.";
  }
  // Invalid / missing API key
  else if(reason === "keyInvalid" || reason === "invalidAPIKey" ||
          /key\s*(is\s+)?not\s*valid/i.test(err.youtubeMessage || "")){
    message = "YouTube API key is missing or invalid.";
  }
  // API not enabled for this key's project
  else if(reason === "accessNotConfigured" ||
          /accessNotConfigured/i.test(reason)){
    message = "YouTube Data API v3 is not enabled for this API key's Google Cloud project.";
  }
  // Other 403 errors — show the safe YouTube reason/status, NOT "quota exceeded"
  else if(err.status === 403){
    const detail = reason || status || "forbidden";
    message = "YouTube access denied (" + detail + ").";
  }
  else if(err.status === 400){
    message = "YouTube API request is invalid.";
  }
  else if(err.status === 401){
    message = "YouTube API authentication failed.";
  }
  else if(err.status === 404){
    message = "YouTube API resource was not found.";
  }
  // Network / timeout (no status or message indicates connectivity failure)
  else if(!err.status || /fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)){
    message = "Could not connect to YouTube.";
  }
  return message;
}

// Fetch from the YouTube Data API with a key, honoring cache.
function httpsGetJSON(fullUrl, timeoutMs = 15000){
  return new Promise((resolve, reject) => {
    const req = https.get(fullUrl, {
      family: 4,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      headers: {
        "User-Agent": "MyTube/1.0",
        "Accept": "application/json"
      }
    }, (res) => {
      let body = "";

      res.setEncoding("utf8");

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {
        let data = null;

        try {
          data = body ? JSON.parse(body) : null;
        } catch {
          data = null;
        }

        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          data,
          body
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("YouTube API request timed out."), {
        code: "ETIMEDOUT"
      }));
    });

    req.on("error", reject);
  });
}

// Fetch from the YouTube Data API with a key, honoring cache.
//
// `options.skipCache` bypasses the generic 10-minute response cache. Live chat
// must never use it: a 10-minute-old chat payload is useless, and the short-TTL
// live probe below would otherwise keep reporting a stale "not live" verdict.
async function ytFetch(cacheKey, url, options = {}){
  if(!options.skipCache){
    const cached = cacheGet(cacheKey);
    if(cached){
      return cached;
    }
  }

  const fullUrl = url + "&key=" + encodeURIComponent(API_KEY);

  let res;

  try{
    res = await httpsGetJSON(fullUrl, 15000);
  }
  catch(e){
    // A low-level HTTPS failure is transient and worth one retry.
    // HTTP error responses are handled below and are not retried.
    res = await httpsGetJSON(fullUrl, 15000);
  }

  if(!res.ok){
    let detail = "YouTube API request failed with status " + res.status;
    let ytReason = "";
    let ytStatus = "";
    let ytMessage = "";

    const ytErr = res.data && res.data.error;

    if(ytErr){
      detail = ytErr.message || detail;

      const firstErr = Array.isArray(ytErr.errors) && ytErr.errors[0];

      if(firstErr){
        ytReason = firstErr.reason || "";
        ytStatus = firstErr.status || "";
        ytMessage = firstErr.message || "";
      }
    }

    const err = new Error(detail);
    err.status = res.status;
    err.youtubeReason = ytReason;
    err.youtubeStatus = ytStatus;
    err.youtubeMessage = ytMessage;

    throw err;
  }

  const data = res.data;

  if(!data){
    throw new Error("YouTube API returned an empty response.");
  }

  if(!options.skipCache){
    cacheSet(cacheKey, data);
  }

  return data;
}

// =============================================================================
// YOU TUBE LIVE CHAT (Phase 1 — read only)
// =============================================================================
// Local-dev mirror of the Worker implementation in worker.js, with identical
// semantics and an identical JSON response contract so the frontend works
// unchanged against either backend.
//
// This is the REAL YouTube Live Chat for a currently-live broadcast. Nothing is
// stored in Firestore and no separate MyTube chat is created or implied.
//
//   * The client never sends a liveChatId — it sends a video id and the active
//     chat is resolved server-side, so no caller can aim this at another stream.
//   * The generic 10-minute cache is bypassed. Each liveChatId gets ONE fan-out
//     entry shared by all viewers, polled at most once every
//     `pollingIntervalMillis` (YouTube's own instruction) no matter how many
//     browsers are watching.
//   * Errors back off exponentially so a broken stream cannot become a hot loop.
//   * Live chat has its own rate-limit bucket so periodic polling never spends
//     the shared general API budget.
// =============================================================================

const LIVE_CHAT_POLL_FLOOR_MS = 3 * 1000;
const LIVE_CHAT_POLL_CEIL_MS = 10 * 1000;
const LIVE_CHAT_DEFAULT_INTERVAL_MS = 5000;
const LIVE_CHAT_BACKOFF_MIN_MS = 5 * 1000;
const LIVE_CHAT_BACKOFF_MAX_MS = 60 * 1000;
const LIVE_CHAT_MAX_ENTRIES = 24;
const LIVE_CHAT_HISTORY_LIMIT = 200;

const liveChatEntries = new Map();

// Dedicated limiter for live chat polling. Sized for periodic traffic (one
// request every few seconds per viewer); upstream cost is already capped by the
// fan-out entry, so this is purely abuse protection.
const LIVE_CHAT_RATE_WINDOW_MS = 60 * 1000;
const LIVE_CHAT_RATE_MAX_PER_WINDOW = 120;
const liveChatRateBuckets = new Map();

// Short-TTL "is this video live right now" cache. The generic 10-minute cache is
// far too slow: a stream that just started would stay hidden for ten minutes.
const LIVE_PROBE_TTL_MS = 30 * 1000;
const LIVE_PROBE_MAX_ENTRIES = 60;
const liveProbeCache = new Map();

function liveChatRateLimitAllowed(req){
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local")
    .split(",")[0]
    .trim();
  const now = Date.now();
  const bucket = liveChatRateBuckets.get(ip) || { count: 0, windowStart: now };

  if(now - bucket.windowStart >= LIVE_CHAT_RATE_WINDOW_MS){
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count++;
  liveChatRateBuckets.set(ip, bucket);

  if(liveChatRateBuckets.size > 5000){
    for(const [key, entry] of liveChatRateBuckets){
      if(now - entry.windowStart >= LIVE_CHAT_RATE_WINDOW_MS){
        liveChatRateBuckets.delete(key);
      }
    }
  }

  return bucket.count <= LIVE_CHAT_RATE_MAX_PER_WINDOW;
}

function clampPollingInterval(value){
  const interval = Number(value);

  if(!Number.isFinite(interval) || interval <= 0){
    return LIVE_CHAT_DEFAULT_INTERVAL_MS;
  }

  return Math.min(
    Math.max(Math.round(interval), LIVE_CHAT_POLL_FLOOR_MS),
    LIVE_CHAT_POLL_CEIL_MS
  );
}

function pruneLiveProbeCache(){
  const now = Date.now();

  for(const [key, entry] of liveProbeCache){
    if(now - entry.at >= LIVE_PROBE_TTL_MS){
      liveProbeCache.delete(key);
    }
  }
}

// Resolve the CURRENT live state of a video through the official YouTube API,
// cached only for LIVE_PROBE_TTL_MS so live/not-live transitions are noticed
// quickly. On a transient failure the last known value is reused, so a blip never
// hides a working live panel.
async function probeVideoLive(videoId){
  const now = Date.now();
  const cached = liveProbeCache.get(videoId);

  if(cached && now - cached.at < LIVE_PROBE_TTL_MS){
    return cached.value;
  }

  let item = null;

  try{
    const url = YT_API_BASE + "/videos?part=snippet,liveStreamingDetails&id=" +
      encodeURIComponent(videoId);
    const data = await ytFetch("liveprobe:" + videoId, url, { skipCache: true });
    item = (data.items && data.items[0]) || null;
  }
  catch(err){
    if(cached){
      return cached.value;
    }

    throw err;
  }

  const value = normalize.readLiveState(item);

  if(liveProbeCache.size >= LIVE_PROBE_MAX_ENTRIES){
    pruneLiveProbeCache();
  }

  if(liveProbeCache.size >= LIVE_PROBE_MAX_ENTRIES){
    const firstKey = liveProbeCache.keys().next().value;

    if(firstKey){
      liveProbeCache.delete(firstKey);
    }
  }

  liveProbeCache.set(videoId, { at: now, value });

  return value;
}

// Map a YouTube live-chat failure onto a stable, user-safe state. These are NOT
// outages: they are the normal terminal states of any live chat.
function classifyLiveChatError(err){
  const reason = err?.youtubeReason || "";

  if(reason === "liveChatEnded"){
    return "ended";
  }
  if(reason === "liveChatDisabled"){
    return "disabled";
  }
  if(reason === "liveChatNotFound" || err?.status === 404){
    return "not_found";
  }

  return "";
}

async function fetchLiveChatBatch(liveChatId, pageToken){
  let url = YT_API_BASE + "/liveChat/messages?part=snippet,authorDetails" +
    "&liveChatId=" + encodeURIComponent(liveChatId) +
    // YouTube's documented minimum for this endpoint is 200.
    "&maxResults=200" +
    "&profileImageSize=88";

  if(pageToken){
    url += "&pageToken=" + encodeURIComponent(pageToken);
  }

  // skipCache: a 10-minute-old chat response would be actively wrong.
  const data = await ytFetch("livechat:" + liveChatId + ":" + (pageToken || ""), url, {
    skipCache: true
  });

  return normalize.normalizeLiveChatResponse(data);
}

function getLiveChatEntry(liveChatId){
  let entry = liveChatEntries.get(liveChatId);

  if(entry){
    return entry;
  }

  entry = {
    liveChatId,
    // Server-owned cursor: every viewer of a stream shares one upstream chain.
    nextPageToken: "",
    pollingIntervalMillis: LIVE_CHAT_DEFAULT_INTERVAL_MS,
    offlineAt: "",
    delta: [],
    history: [],
    activePoll: null,
    totalResults: 0,
    fetchCount: 0,
    failures: 0,
    backoffMs: 0,
    nextAllowedAt: 0,
    inflight: null,
    skippedLast: false,
    terminated: false,
    terminalStatus: "",
    lastError: ""
  };

  if(liveChatEntries.size >= LIVE_CHAT_MAX_ENTRIES){
    for(const [key, value] of liveChatEntries){
      if(!value.inflight && value !== entry){
        liveChatEntries.delete(key);
        break;
      }
    }
  }

  liveChatEntries.set(liveChatId, entry);

  return entry;
}

// At most one upstream fetch per entry per pollingIntervalMillis; concurrent
// callers share the same in-flight promise, so N viewers => 1 API call.
function refreshLiveChatEntry(entry, startPageToken){
  if(entry.inflight){
    return entry.inflight;
  }

  if(Date.now() < entry.nextAllowedAt){
    // Too soon to poll YouTube again: no new upstream batch was retrieved, so
    // the previous delta must not be handed back as newly fetched. The bounded
    // history ring is left intact for a viewer joining mid-stream.
    entry.skippedLast = true;
    return Promise.resolve();
  }

  entry.skippedLast = false;

  entry.inflight = (async () => {
    try{
      const normalized = await fetchLiveChatBatch(entry.liveChatId, startPageToken);

      entry.failures = 0;
      entry.backoffMs = 0;
      entry.lastError = "";

      // The cursor moved forward, so this batch is exactly the messages that
      // were not in the previous batch.
      entry.delta = normalized.messages;
      entry.history = entry.history.concat(normalized.messages);

      if(entry.history.length > LIVE_CHAT_HISTORY_LIMIT){
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
      if(normalized.offlineAt){
        entry.terminated = true;
        entry.terminalStatus = "ended";
      }
    }
    catch(err){
      const terminal = classifyLiveChatError(err);

      entry.delta = [];
      entry.lastError = String(err?.message || "unknown");

      if(terminal){
        entry.terminated = true;
        entry.terminalStatus = terminal;

        // A terminal state is a normal end-of-life, not a failure to report.
        entry.lastError = "";
        entry.backoffMs = 0;
        entry.nextAllowedAt = Infinity;

        return;
      }

      entry.failures++;

      const doubled = entry.backoffMs > 0 ? entry.backoffMs * 2 : 0;

      entry.backoffMs = Math.min(
        Math.max(doubled, LIVE_CHAT_BACKOFF_MIN_MS),
        LIVE_CHAT_BACKOFF_MAX_MS
      );

      entry.nextAllowedAt = Date.now() +
        Math.max(clampPollingInterval(entry.pollingIntervalMillis), entry.backoffMs);
    }
    finally{
      entry.inflight = null;
    }
  })();

  return entry.inflight;
}

// GET /api/liveChat?id=<videoId>[&pageToken=<token>][&initial=1]
// `initial=1` asks for the recent-message history (used by a viewer joining a
// stream that is already being followed) instead of just the newest delta.
async function handleLiveChat(req, res, params){
  const id = (params.get("id") || "").trim();

  if(!id){
    return sendJSON(res, 400, {
      messages: [],
      status: "not_live",
      error: "Missing id",
      code: "BAD_REQUEST"
    });
  }

  if(!API_KEY){
    return sendJSON(res, 503, {
      messages: [],
      status: "error",
      error: "YouTube API key not configured.",
      code: "API_KEY_MISSING"
    });
  }

  const live = await probeVideoLive(id);

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

  if(!live.isLive){
    return sendJSON(res, 200, base);
  }

  // Live but no active chat id: chat is turned off, or the broadcast has not
  // produced a chat yet.
  if(!live.liveChatId){
    return sendJSON(res, 200, {
      ...base,
      status: live.liveChatDisabled ? "disabled" : "no_chat"
    });
  }

  const entry = getLiveChatEntry(live.liveChatId);

  // Terminal states are sticky: once YouTube says the chat ended/disabled we stop
  // polling instead of re-hitting the API every interval.
  if(entry.terminated){
    return sendJSON(res, 200, {
      ...base,
      status: entry.terminalStatus || "ended",
      messages: entry.history.slice(),
      nextPageToken: entry.nextPageToken,
      pollingIntervalMillis: clampPollingInterval(entry.pollingIntervalMillis),
      offlineAt: entry.offlineAt,
      activePoll: entry.activePoll
    });
  }

  const hadState = entry.fetchCount > 0;

  await refreshLiveChatEntry(
    entry,
    // The SERVER-owned cursor drives every call after the first, so the upstream
    // batches are strictly disjoint and no message can be skipped. A client
    // token is honoured on that very first call only, to resume a chat the
    // process happened to restart mid-stream; once server state exists the
    // client value is ignored and cannot corrupt the cursor.
    hadState ? entry.nextPageToken : (params.get("pageToken") || "")
  );

  // A skipped poll retrieved nothing new: report an empty delta instead of
  // re-serving the previous batch. A viewer joining a stream that is already
  // being followed asks for `initial` and still gets the recent history, so its
  // panel is never empty.
  const fresh = !entry.skippedLast;
  const wantsHistory = !hadState || params.get("initial") === "1";

  const status = entry.terminated
    ? (entry.terminalStatus || "ended")
    : entry.lastError
      ? "error"
      : entry.offlineAt
        ? "ended"
        : "live";

  return sendJSON(res, 200, {
    ...base,
    status,
    messages: wantsHistory
      ? entry.history.slice()
      : (fresh ? entry.delta.slice() : []),
    nextPageToken: entry.nextPageToken,
    pollingIntervalMillis: clampPollingInterval(entry.pollingIntervalMillis),
    offlineAt: entry.offlineAt,
    activePoll: entry.activePoll,
    code: entry.lastError ? "LIVE_CHAT_UNAVAILABLE" : "",
    error: entry.lastError ? "Live chat is temporarily unavailable." : ""
  });
}

// =============================================================================
// API handlers
// =============================================================================

// GET /api/ping
// A lightweight health check. Returns the exact expected JSON so the frontend
// can reliably distinguish our API server from any other server (e.g. Live
// Server) that might respond with a plain 404 for /api/ping.
function handlePing(req, res){
  return sendJSON(res, 200, { ok: true, service: "mytube-youtube-api", configured: Boolean(API_KEY) });
}

// GET /api/trending?max=<n>&seed=<s>&topic=<t>&region=<code>&pageToken=<cursor>
//
// Contract is unchanged: `{ videos, nextPageToken }`.
//
// YouTube's `videos.list?chart=mostPopular` is one static, region-scoped list of
// roughly 200 videos whose first page never changes, and it accepts no ordering,
// shuffle or seed parameter. So the homepage pool below collects the same official
// chart for several regions (1 quota unit each, verified disjoint in production)
// and shared/feed.js orders that pool with a per-refresh seed. One pool build
// serves every visitor for FEED_POOL_TTL_MS, and each refresh reshuffles real
// videos at zero extra quota.
//
//   seed=""  -> deterministic pool order (sitemap generator / legacy callers)
//   seed="x" -> seeded permutation, i.e. a different real feed per refresh
//
// `_t` is accepted as a legacy alias for `seed`. It never reached YouTube before
// (the upstream cache key is built from the YouTube URL), so the old cache-buster
// did nothing; it now genuinely changes the feed and still costs nothing.
const FEED_POOL_CACHE_KEY = "mytube:feed:pool";
let feedPoolEntry = null;
let feedPoolInflight = null;

function getCachedFeedPool(){
  if(!feedPoolEntry){
    return null;
  }
  if(Date.now() - feedPoolEntry.at > FEED_POOL_TTL_MS){
    feedPoolEntry = null;
    return null;
  }
  return feedPoolEntry.value;
}

async function fetchFeedRegion(region){
  const url = YT_API_BASE + "/videos?part=" + VIDEO_PARTS_FULL +
    "&chart=mostPopular&regionCode=" + encodeURIComponent(region) +
    "&maxResults=" + FEED_POOL_PAGE_SIZE;
  const data = await ytFetch("feedregion:" + region, url);
  const videos = [];
  const ids = new Set();

  for(const item of (data.items || [])){
    const video = normalize.normalizeVideoItem(item);
    if(!video || ids.has(video.sourceId)){
      continue;
    }
    ids.add(video.sourceId);
    videos.push({
      ...video,
      topic: topicFromTags(item && item.snippet ? item.snippet.tags : null)
    });
  }

  return { region, videos, ids };
}

async function buildFeedPool(){
  const regions = await Promise.all(
    FEED_POOL_REGIONS.map(region =>
      fetchFeedRegion(region).catch(() => ({ region, videos: [], ids: new Set() }))
    )
  );

  const items = [];
  const seen = new Set();
  const regionIds = {};

  for(const entry of regions){
    regionIds[entry.region] = entry.ids;
    for(const video of entry.videos){
      if(seen.has(video.sourceId)){
        continue;
      }
      seen.add(video.sourceId);
      items.push(video);
    }
  }

  if(!items.length){
    const primary = FEED_POOL_REGIONS[0] || "US";
    const fallback = await fetchFeedRegion(primary).catch(() => ({ videos: [], ids: new Set() }));
    regionIds[primary] = fallback.ids;
    items.push(...fallback.videos);
  }

  return { items, regionIds, topics: availableTopics(items) };
}

// One shared build for all concurrent callers, so a burst of page loads cannot
// each spend FEED_POOL_REGIONS.length quota units.
async function getFeedPool(){
  const cached = getCachedFeedPool();
  if(cached){
    return cached;
  }

  if(!feedPoolInflight){
    feedPoolInflight = buildFeedPool()
      .then(pool => {
        feedPoolEntry = { at: Date.now(), value: pool };
        return pool;
      })
      .finally(() => {
        feedPoolInflight = null;
      });
  }

  return feedPoolInflight;
}

async function handleTrending(req, res, params){
  if(!API_KEY){
    return sendJSON(res, 503, {
      error: "YouTube API key not configured.",
      videos: []
    });
  }

  const maxResults = Math.min(Math.max(parseInt(params.get("max") || "12", 10) || 12, 1), 50);
  const region = (params.get("region") || "").toString().toUpperCase().slice(0, 2);
  const pageToken = (params.get("pageToken") || "").trim();
  const rawSeed = params.get("seed") || params.get("_t") || "";
  const topic = (params.get("topic") || "").trim();

  try{
    const pool = await getFeedPool();
    const cursor = decodeFeedCursor(pageToken);

    let items = pool.items;
    let requestedRegion = region;

    if(requestedRegion && !pool.regionIds[requestedRegion]){
      requestedRegion = "";
    }

    // `region` keeps its original meaning: restrict the feed to one region's
    // chart, exactly like the previous single-chart implementation. With no
    // region the feed spans the whole pool, which is the point of the pool.
    if(requestedRegion && !cursor){
      const ids = pool.regionIds[requestedRegion] || new Set();
      items = items.filter(video => ids.has(video.sourceId));
    }

    const seed = rawSeed ? String(rawSeed) : (cursor ? cursor.seed : "");
    const effectiveTopic = topic || (cursor ? cursor.topic : "");
    const offset = cursor ? cursor.offset : 0;

    const page = buildFeedPage(items, {
      seed,
      topic: effectiveTopic,
      offset,
      size: maxResults
    });

    return sendJSON(res, 200, {
      ...page,
      topics: pool.topics,
      regions: Object.keys(pool.regionIds).filter(code => pool.regionIds[code] && pool.regionIds[code].size),
      requestedRegion: requestedRegion || ""
    });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load trending videos."),
      videos: []
    });
  }
}

// GET /api/search?q=<query>&max=<n>[&order&duration&uploadDate&categoryId&region
//                     &relevanceLanguage&safeSearch&videoEmbeddable][&pageToken]
//
// Returns { videos, nextPageToken } plus additive metadata (query, appliedFilters,
// filteredCount, duplicatesRemoved, totalResultsEstimate).
async function handleSearch(req, res, params){
  // Normalize server-side: collapse whitespace, strip invisible marks, cap length.
  // Casing is preserved for YouTube; the normalized form is the cache key.
  const q = normalizeQuery(params.get("q"));
  if(!q){
    return sendJSON(res, 400, { error: "Missing query", videos: [] });
  }
  if(!API_KEY){
    return sendJSON(res, 503, {
      error: "YouTube API key not configured.",
      videos: []
    });
  }

  // search.list costs a flat 100 quota units per call regardless of maxResults,
  // so a full 50-result page is the cheapest way to return results.
  const maxResults = resolveSearchMax(params.get("max") || "50");
  const pageToken = (params.get("pageToken") || "").trim();
  const { searchParams, applied } = resolveSearchFilters(params);

  // Every filter that can change the result set must be part of the cache key,
  // or "Most viewed" could be served from a cached "Relevance" response.
  const cacheKey = "search:" + q.toLowerCase() + ":" + maxResults + ":" + pageToken +
    ":" + JSON.stringify(applied);

  try{
    let url = YT_API_BASE + "/search?part=snippet&type=video&maxResults=" + maxResults +
      "&q=" + encodeURIComponent(q);

    for(const [key, value] of Object.entries(searchParams)){
      url += "&" + key + "=" + encodeURIComponent(String(value));
    }

    if(pageToken){
      url += "&pageToken=" + encodeURIComponent(pageToken);
    }

    const data = await ytFetch(cacheKey, url);
    const videos = normalize.normalizeSearchResponse(data).videos;

    // Optionally enrich with durations & view counts from videos.list.
    try{
      await enrichWithStats(videos);
    }
    catch(e){
      // Non-fatal: we can still return results without stats/durations.
    }

    // Drop ids YouTube repeats across pages and videos reporting
    // `status.embeddable === false`, which MyTube can never play in an iframe.
    const cleaned = dedupeSearchResults(videos);

    return sendJSON(res, 200, {
      videos: cleaned.videos,
      nextPageToken: data.nextPageToken || "",
      query: q,
      appliedFilters: applied,
      totalResultsEstimate: Number(
        data && data.pageInfo ? Number(data.pageInfo.totalResults || 0) : 0
      ),
      duplicatesRemoved: cleaned.duplicatesRemoved,
      filteredCount: cleaned.filteredCount
    });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "YouTube search failed."),
      videos: []
    });
  }
}

// GET /api/video?id=<videoId>
// Returns a single normalized video object (or error).
async function handleVideo(req, res, params){
  const id = (params.get("id") || "").trim();
  if(!id){
    return sendJSON(res, 400, { error: "Missing id", video: null });
  }
  if(!API_KEY){
    return sendJSON(res, 503, { error: "YouTube API key not configured.", video: null });
  }

  // Use a dedicated cache key (distinct from the related handler's "video:" key,
  // which fetches a different subset of parts) so neither caller gets stale data.
  const cacheKey = "videofull:" + id;
  try{
    // "status" is requested so the normalized video exposes status.embeddable,
    // letting the watch page show an honest fallback for non-embeddable videos.
    const url = YT_API_BASE + "/videos?part=" + VIDEO_PARTS_FULL + "&id=" + encodeURIComponent(id);
    const data = await ytFetch(cacheKey, url);
    // normalizeVideosResponse returns { videos, nextPageToken } like its sibling
    // normalizers — read .videos instead of treating the result as an array.
    const videos = normalize.normalizeVideosResponse(data).videos;
    if(!videos.length){
      return sendJSON(res, 404, { error: "Video unavailable or removed.", video: null });
    }
    return sendJSON(res, 200, { video: videos[0] });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not fetch video."),
      video: null
    });
  }
}

// GET /api/channelVideos?channelId=<id>&max=<n>
// Returns recent videos from a specific YouTube channel via its uploads
// playlist, avoiding the expensive YouTube Search API.
async function handleChannelVideos(req, res, params){
  const channelId = (params.get("channelId") || "").trim();
  if(!channelId){
    return sendJSON(res, 400, { error: "Missing channelId", videos: [] });
  }
  if(!API_KEY){
    return sendJSON(res, 503, { error: "YouTube API key not configured.", videos: [] });
  }

  const maxResults = Math.min(
    Math.max(parseInt(params.get("max") || "8", 10) || 8, 1),
    25
  );
  const pageToken = (params.get("pageToken") || "").trim();

  try{
    // Get the channel's uploads playlist.
    const channelCacheKey = "channelUploads:" + channelId;
    const channelUrl =
      YT_API_BASE +
      "/channels?part=contentDetails&id=" +
      encodeURIComponent(channelId);

    const channelData = await ytFetch(channelCacheKey, channelUrl);

    const channelItem = channelData.items?.[0];
    const uploadsPlaylistId =
      channelItem?.contentDetails?.relatedPlaylists?.uploads || "";

    if(!uploadsPlaylistId){
      return sendJSON(res, 200, {
        videos: [],
        nextPageToken: ""
      });
    }

    // Get the latest videos from the uploads playlist.
    const cacheKey =
      "channelVideos:" +
      channelId +
      ":" +
      maxResults +
      ":" +
      pageToken;

    let playlistUrl =
      YT_API_BASE +
      "/playlistItems?part=snippet,contentDetails&playlistId=" +
      encodeURIComponent(uploadsPlaylistId) +
      "&maxResults=" +
      maxResults;

    if(pageToken){
      playlistUrl += "&pageToken=" + encodeURIComponent(pageToken);
    }

    const playlistData = await ytFetch(cacheKey, playlistUrl);

    const ids = (playlistData.items || [])
      .map(item => item?.contentDetails?.videoId)
      .filter(Boolean);

    if(!ids.length){
      return sendJSON(res, 200, {
        videos: [],
        nextPageToken: playlistData.nextPageToken || ""
      });
    }

    // Fetch full video details in one batch.
    const detailsCacheKey = "channelVideoDetails:" + ids.join(",");
    const detailsUrl =
      YT_API_BASE +
      "/videos?part=snippet,contentDetails,statistics,status&id=" +
      encodeURIComponent(ids.join(","));

    const detailsData = await ytFetch(detailsCacheKey, detailsUrl);

    const detailsById = new Map();

    for(const item of (detailsData.items || [])){
      if(item?.id){
        detailsById.set(item.id, item);
      }
    }

    const videos = [];

    for(const item of (playlistData.items || [])){
      const id = item?.contentDetails?.videoId;

      if(!id){
        continue;
      }

      const detail = detailsById.get(id);

      if(detail){
        const video = normalize.normalizeVideoItem(detail);

        if(video){
          videos.push(video);
        }
      }
      else{
        // Fallback to playlist metadata if a detailed video response is
        // unavailable for this item.
        const video = normalize.normalizeSearchItem({
          id: {
            videoId: id
          },
          snippet: item?.snippet || {}
        });

        if(video){
          videos.push(video);
        }
      }
    }

    return sendJSON(res, 200, {
      videos,
      nextPageToken: playlistData.nextPageToken || ""
    });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load channel videos."),
      videos: []
    });
  }
}

// GET /api/channel?id=<channelId>
// Returns real public channel info (title + subscriberCount when available) via
// the official channels.list endpoint. subscriberCount is null when hidden.
async function handleChannel(req, res, params){
  const id = (params.get("id") || "").trim();
  if(!id){
    return sendJSON(res, 400, { error: "Missing id", channel: null });
  }
  if(!API_KEY){
    return sendJSON(res, 503, { error: "YouTube API key not configured.", channel: null });
  }

  const cacheKey = "channel:" + id;
  try{
    const url = YT_API_BASE + "/channels?part=snippet,statistics&id=" + encodeURIComponent(id);
    const data = await ytFetch(cacheKey, url);
    const channel = normalize.normalizeChannelResponse(data);
    if(!channel){
      return sendJSON(res, 404, { error: "Channel not found.", channel: null });
    }
    return sendJSON(res, 200, { channel });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load channel."),
      channel: null
    });
  }
}

// GET /api/comments?id=<videoId>&max=<n>
// Returns real public top-level comments via the official commentThreads.list
// endpoint. Uses textOriginal (plain text) so the frontend can render safely.
async function handleComments(req, res, params){
  const id = (params.get("id") || "").trim();
  if(!id){
    return sendJSON(res, 400, { error: "Missing id", comments: [] });
  }
  if(!API_KEY){
    return sendJSON(res, 503, { error: "YouTube API key not configured.", comments: [] });
  }

  const maxResults = Math.min(Math.max(parseInt(params.get("max") || "20", 10) || 20, 1), 50);
  const pageToken = (params.get("pageToken") || "").trim();
  const cacheKey = "comments:" + id + ":" + maxResults + ":" + pageToken;

  try{
    let url = YT_API_BASE + "/commentThreads?part=snippet&videoId=" + encodeURIComponent(id) +
      "&maxResults=" + maxResults + "&order=relevance&textFormat=plainText";
    if(pageToken){
      url += "&pageToken=" + encodeURIComponent(pageToken);
    }
    const data = await ytFetch(cacheKey, url);
    const comments = normalize.normalizeCommentsResponse(data).comments;
    return sendJSON(res, 200, { comments, nextPageToken: data.nextPageToken || "" });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load comments."),
      comments: []
    });
  }
}

// GET /api/related?id=<videoId>&max=<n>
// Uses the official search endpoint to discover related videos for a YouTube
// video id. (The Data API v3 has no direct "related videos" endpoint, so we
// request videos from the same channel and by a related title keyword.)
async function handleRelated(req, res, params){
  const id = (params.get("id") || "").trim();
  if(!id){
    return sendJSON(res, 400, { error: "Missing id", videos: [] });
  }
  if(!API_KEY){
    return sendJSON(res, 503, { error: "YouTube API key not configured.", videos: [] });
  }

  const maxResults = Math.min(Math.max(parseInt(params.get("max") || "15", 10) || 15, 1), 30);

  try{
    // 1) Fetch the target video's channel + title so we can discover related content.
    const videoInfo = await ytFetch("video:" + id,
      YT_API_BASE + "/videos?part=snippet&id=" + encodeURIComponent(id));
    const vidItems = videoInfo.items || [];
    if(!vidItems.length){
      return sendJSON(res, 200, { videos: [], error: "Video unavailable." });
    }
    const snippet = vidItems[0].snippet || {};
    const channelId = snippet.channelId;

    // 2) Query for videos from the same channel. This is the official, allowed
    //    approach — and the cheaper one: a single search call plus one stats
    //    batch instead of two searches (saves ~100 quota units per request).
    const results = [];

    const channelCacheKey = "channel:" + channelId + ":" + maxResults;
    if(channelId){
      try{
        const chanUrl = YT_API_BASE + "/search?part=snippet&type=video&channelId=" +
          encodeURIComponent(channelId) + "&maxResults=" + maxResults;
        const chanData = await ytFetch(channelCacheKey, chanUrl);
        const chanVideos = normalize.normalizeSearchResponse(chanData).videos;
        results.push(...chanVideos);
      }
      catch(e){ /* ignore */ }
    }

    // Dedupe by sourceId; drop the current video if it appears; then slice.
    const seen = new Set();
    const deduped = [];
    for(const v of results){
      if(!v.sourceId || v.sourceId === id || seen.has(v.sourceId)){
        continue;
      }
      seen.add(v.sourceId);
      deduped.push(v);
      if(deduped.length >= maxResults){
        break;
      }
    }

    try{
      await enrichWithStats(deduped);
    }
    catch(e){ /* non-fatal */ }

    return sendJSON(res, 200, { videos: deduped, nextPageToken: "" });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load related videos."),
      videos: []
    });
  }
}

// Batch-enrich normalized videos with duration + view-count via one videos.list call.
async function enrichWithStats(videos){
  if(!videos.length){
    return;
  }
  const ids = videos.map(v => v.sourceId).filter(Boolean).join(",");
  if(!ids){
    return;
  }
  // "status" is fetched too (like the Worker) so embeddable is identical in both
  // backends and the non-embeddable filter below actually has something to read.
  const url = YT_API_BASE + "/videos?part=contentDetails,statistics,status&id=" + encodeURIComponent(ids) +
    "&maxResults=50";
  const data = await ytFetch("stats:" + ids, url);
  const byId = {};
  for(const item of (data.items || [])){
    if(item.id){
      byId[item.id] = item;
    }
  }
  for(const v of videos){
    const item = byId[v.sourceId];
    if(!item){
      continue;
    }
    const stats = item.statistics || {};
    const details = item.contentDetails || {};
    // Mirrors normalize.js: only an explicit false means "cannot be embedded".
    v.embeddable = (item.status || {}).embeddable !== false;
    const viewCountInt = parseInt(stats.viewCount, 10);
    if(Number.isFinite(viewCountInt)){
      v.viewCount = viewCountInt;
      v.views = viewCountInt ? `${normalize.formatCount(viewCountInt)} views` : "";
    }
    const dur = normalize.formatDuration(details.duration);
    if(dur){
      v.time = dur;
    }
  }
}

// =============================================================================
// Static file serving (single origin — keeps the API and site on one port)
// =============================================================================

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

const STATIC_EXTS = new Set(Object.keys(CONTENT_TYPES));

function serveStatic(req, res, urlPath){
  // Resolve within root and prevent path traversal.
  let filePath;
  try {
    filePath = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Bad Request");
  }

  // Never serve sensitive files (env, git metadata). The URL path always starts
  // with "/", so normalize away that leading slash before matching names.
  const rootRelative = filePath.replace(/^\/+/, "");
  const SENSITIVE = [".env", ".env.example", ".git", ".gitignore", "package-lock.json", "package.json"];
  for(const name of SENSITIVE){
    if(rootRelative === name || rootRelative.startsWith(name + "/")){
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
  }

  const safePath = path.normalize(filePath).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.resolve(YT_ROOT, safePath);

  if(fullPath !== YT_ROOT && !fullPath.startsWith(YT_ROOT + path.sep)){
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Forbidden");
  }

  fs.stat(fullPath, (err, stat) => {
    if(err || !stat.isFile()){
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }

    const ext = path.extname(fullPath).toLowerCase();
    const type = CONTENT_TYPES[ext] || "application/octet-stream";

    if(!STATIC_EXTS.has(ext)){
      res.writeHead(415, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Unsupported file type");
    }

    const isVideo = ext === ".mp4" || ext === ".webm";
    const commonHeaders = {
      "Content-Type": type,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    };

    // Browsers use HTTP Range requests for video seeking/buffering.
    if(isVideo){
      commonHeaders["Accept-Ranges"] = "bytes";
    }

    if(req.method === "HEAD"){
      commonHeaders["Content-Length"] = stat.size;
      res.writeHead(200, commonHeaders);
      return res.end();
    }

    if(isVideo && req.headers.range){
      const range = req.headers.range.trim();
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);

      if(!match){
        res.writeHead(416, {
          ...commonHeaders,
          "Content-Range": `bytes */${stat.size}`
        });
        return res.end();
      }

      let startByte;
      let endByte;

      if(match[1] === ""){
        // Suffix range: bytes=-500
        const suffixLength = Number(match[2]);
        if(!Number.isSafeInteger(suffixLength) || suffixLength <= 0){
          res.writeHead(416, {
            ...commonHeaders,
            "Content-Range": `bytes */${stat.size}`
          });
          return res.end();
        }
        startByte = Math.max(stat.size - suffixLength, 0);
        endByte = stat.size - 1;
      } else {
        startByte = Number(match[1]);
        endByte = match[2] === "" ? stat.size - 1 : Number(match[2]);

        if(
          !Number.isSafeInteger(startByte) ||
          !Number.isSafeInteger(endByte) ||
          startByte < 0 ||
          endByte < startByte ||
          startByte >= stat.size
        ){
          res.writeHead(416, {
            ...commonHeaders,
            "Content-Range": `bytes */${stat.size}`
          });
          return res.end();
        }

        endByte = Math.min(endByte, stat.size - 1);
      }

      const chunkSize = endByte - startByte + 1;

      res.writeHead(206, {
        ...commonHeaders,
        "Content-Length": chunkSize,
        "Content-Range": `bytes ${startByte}-${endByte}/${stat.size}`
      });

      const stream = fs.createReadStream(fullPath, {
        start: startByte,
        end: endByte
      });

      stream.on("error", () => {
        if(!res.headersSent){
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.destroy();
      });

      return stream.pipe(res);
    }

    commonHeaders["Content-Length"] = stat.size;
    res.writeHead(200, commonHeaders);

    fs.createReadStream(fullPath).on("error", () => {
      if(!res.headersSent){
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.destroy();
    }).pipe(res);
  });
}

// =============================================================================
// Router
// =============================================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if(url.pathname.startsWith("/api/")){
    const route = url.pathname.slice(5); // strip leading "/api/"
    res.allowOrigin = resolveAllowOrigin(req);

    // Respond to CORS preflight (OPTIONS) requests without running handlers.
    if(req.method === "OPTIONS"){
      res.writeHead(204, {
        "Access-Control-Allow-Origin": res.allowOrigin || "",
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600"
      });
      return res.end();
    }

    if(req.method !== "GET"){
      return sendJSON(res, 405, { error: "Method not allowed" });
    }

    // Live chat polling is periodic by design, so it is metered by its own dedicated
    // limiter (liveChatRateLimitAllowed) and must NOT spend the shared general
    // budget — otherwise merely watching a live stream would start returning 429
    // for search / trending / comments.
    if(route !== "liveChat" && !rateLimitAllowed(req)){
      return sendJSON(res, 429, { error: "Too many requests. Please slow down and try again shortly." });
    }

    try{
      if(route === "ping"){
        return handlePing(req, res);
      }
      if(route === "liveChat"){
        // Dedicated limiter, checked before any upstream work.
        if(!liveChatRateLimitAllowed(req)){
          return sendJSON(res, 429, {
            messages: [],
            status: "error",
            code: "RATE_LIMITED",
            error: "Too many live chat requests. Please slow down."
          });
        }
        return await handleLiveChat(req, res, url.searchParams);
      }
      if(route.startsWith("trending")){
        return await handleTrending(req, res, url.searchParams);
      }
      if(route.startsWith("search")){
        // search.list costs a flat 100 quota units per call, so it is metered
        // separately from the general limiter (mirrors worker.js).
        if(!searchRateLimitAllowed(req)){
          return sendJSON(res, 429, {
            videos: [],
            code: "SEARCH_RATE_LIMITED",
            error: "Too many searches. Please wait a moment and try again."
          });
        }
        return await handleSearch(req, res, url.searchParams);
      }
      if(route.startsWith("video")){
        return await handleVideo(req, res, url.searchParams);
      }
      if(route === "channelVideos"){
        return await handleChannelVideos(req, res, url.searchParams);
      }
      if(route.startsWith("channel")){
        return await handleChannel(req, res, url.searchParams);
      }
      if(route.startsWith("comments")){
        return await handleComments(req, res, url.searchParams);
      }
      if(route.startsWith("related")){
        return await handleRelated(req, res, url.searchParams);
      }
      return sendJSON(res, 404, { error: "Unknown API route" });
    }
    catch(err){
      console.error("API error:", err);
      return sendJSON(res, 500, { error: "Internal server error" });
    }
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  const mode = API_KEY
    ? "YouTube API key configured (from env)."
    : "YOUTUBE_API_KEY is NOT set — dynamic results will fall back to local videos.";
  console.log("MyTube server running: http://localhost:" + PORT);
  console.log("Serving site from: " + YT_ROOT);
  console.log(mode);
});
