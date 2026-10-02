// =============================================================================
// MyTube — Phase 7 YouTube API client (frontend)
// -----------------------------------------------------------------------------
// Thin client that talks to the small backend proxy (youtube-server/server.js)
// using native fetch. The backend keeps YOUTUBE_API_KEY hidden from the browser
// and normalizes responses into the MyTube video shape:
//
//   { id: "yt:<videoId>", sourceId, type: "youtube", title, channel,
//     thumb, time, views, viewCount, date, description }
//
// The client:
//   * works whether the site is served from the backend (same origin) or from a
//     Live Server (different origin) by trying a relative /api path first, then
//     falling back to http://localhost:3456/api.
//   * caches results for the current page session to avoid spamming the API.
//   * never throws on failure — callers get { videos: [] } / { video: null }.
// =============================================================================

import {
  FEED_TOPICS,
  SEARCH_ORDER_OPTIONS,
  SEARCH_DURATION_OPTIONS,
  SEARCH_UPLOAD_DATE_OPTIONS,
  VIDEO_CATEGORIES
} from "./shared/categories.js";

// Persistent, session-scoped cache keyed by request, so the same search is not
// requested twice on one page session.
const sessionCache = new Map();

let BACKEND_BASE = null;

function log(level, msg){
  if(window.console && typeof window.console[level] === "function"){
    window.console[level](msg);
  }
}

// Try a relative request first (works when served by the backend). The response
// is accepted ONLY if it is the expected JSON from our API server. This prevents
// a generic static server (e.g. Live Server) from being falsely detected as the
// API backend just because it answers /api/ping with a 404.
async function resolveBackendBase(){
  if(BACKEND_BASE){
    return BACKEND_BASE;
  }
  const isLocalDevelopment =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

  const tryUrls = isLocalDevelopment
    ? [
        "/api/ping",
        "http://localhost:3456/api/ping"
      ]
    : [
        "/api/ping"
      ];
  for(const url of tryUrls){
    try{
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if(res.ok){
        let payload = null;
        try{
          payload = await res.json();
        }
        catch(e){ /* not JSON */ }
        // Accept both the local Node backend marker and the production
        // Cloudflare Worker marker.
        if(
          payload &&
          payload.ok === true &&
          (
            payload.service === "mytube-api" ||
            payload.service === "mytube-youtube-api"
          )
        ){
          BACKEND_BASE = url.replace(/\/ping$/, "");
          return BACKEND_BASE;
        }
      }
      // A 404 (or any other non-matching response) is NOT treated as our API.
    }
    catch(e){ /* try next */ }
  }
  BACKEND_BASE = "";
  return "";
}

function cacheGet(key){
  const entry = sessionCache.get(key);
  if(!entry){
    return null;
  }
  // Session-scoped: keep value for up to 10 minutes regardless of page actions.
  if(Date.now() - entry.at > 10 * 60 * 1000){
    sessionCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value){
  if(sessionCache.size > 300){
    const first = sessionCache.keys().next().value;
    if(first !== undefined){
      sessionCache.delete(first);
    }
  }
  sessionCache.set(key, { at: Date.now(), value });
}

async function apiRequest(route, params, signal, options = {}){
  let cacheKey = null;
  const base = await resolveBackendBase();
  if(!base){
    return { ok: false, error: "Backend not reachable." };
  }

  const qs = new URLSearchParams(params).toString();
  const url = base + "/" + route + (qs ? ("?" + qs) : "");
  cacheKey = url;

  // Live chat is polled repeatedly and must never be served from the 10-minute
  // session cache — a stale chat payload would be wrong, not merely old.
  const cacheable = !options.noCache;
  const cached = cacheable ? cacheGet(cacheKey) : null;
  if(cached){
    return cached;
  }

  try{
    const res = await fetch(url, { signal: signal || AbortSignal.timeout(15000) });
    let payload = null;
    try{
      payload = await res.json();
    }
    catch(e){ /* ignore json errors */ }
    const result = {
      ok: res.ok,
      status: res.status,
      videos: (payload && Array.isArray(payload.videos)) ? payload.videos : [],
      video: (payload && payload.video) ? payload.video : null,
      channel: (payload && payload.channel) ? payload.channel : null,
      comments: (payload && Array.isArray(payload.comments)) ? payload.comments : [],
      nextPageToken: (payload && payload.nextPageToken) ? String(payload.nextPageToken) : "",
      // Additive fields. Anything not present simply stays falsy, so a backend
      // without them keeps working unchanged.
      query: (payload && payload.query) ? String(payload.query) : "",
      appliedFilters: (payload && payload.appliedFilters) ? payload.appliedFilters : {},
      filteredCount: (payload && typeof payload.filteredCount === "number") ? payload.filteredCount : 0,
      duplicatesRemoved: (payload && typeof payload.duplicatesRemoved === "number") ? payload.duplicatesRemoved : 0,
      totalResultsEstimate: (payload && typeof payload.totalResultsEstimate === "number") ? payload.totalResultsEstimate : 0,
      topics: (payload && Array.isArray(payload.topics)) ? payload.topics : [],
      totalAvailable: (payload && typeof payload.totalAvailable === "number") ? payload.totalAvailable : 0,
      error: (payload && payload.error) ? payload.error : ""
    };

    // Live-chat response contract (see getLiveChat() in worker.js).
    if(route === "liveChat"){
      result.messages = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
      result.chatStatus = (payload && payload.status) ? String(payload.status) : "error";
      result.isLive = Boolean(payload && payload.isLive);
      result.liveChatId = (payload && payload.liveChatId) ? String(payload.liveChatId) : "";
      result.concurrentViewers = Number(payload && payload.concurrentViewers) || 0;
      result.pollingIntervalMillis = Number(payload && payload.pollingIntervalMillis) || 5000;
      result.offlineAt = (payload && payload.offlineAt) ? String(payload.offlineAt) : "";
      result.code = (payload && payload.code) ? String(payload.code) : "";
    }

    if(res.ok && cacheable){
      cacheSet(cacheKey, result);
    }
    return result;
  }
  catch(err){
    if(err && err.name === "AbortError"){
      throw err;
    }
    log("warn", "YouTube API request failed:", err);
    return { ok: false, status: 0, videos: [], video: null, error: "Network error." };
  }
}

// =============================================================================
// Public API
// =============================================================================

// Search YouTube. Returns { videos, nextPageToken, error, ok }.
// Never resolves to null; on any failure it returns an empty array so the
// caller can safely fall back to local videos.
//
// `filters` is optional and maps 1:1 onto parameters the official YouTube
// search.list resource supports (order, duration, uploadDate, categoryId,
// region, relevanceLanguage, safeSearch, videoEmbeddable). Unsupported values
// are dropped server-side, because YouTube answers HTTP 400 for invalid ones.
async function search(query, max, pageToken, signal, filters){
  const params = { q: query, max: String(max || 50) };
  if(pageToken){
    params.pageToken = String(pageToken);
  }
  if(filters && typeof filters === "object"){
    for(const [key, value] of Object.entries(filters)){
      if(value !== undefined && value !== null && value !== ""){
        params[key] = String(value);
      }
    }
  }
  const res = await apiRequest("search", params, signal);
  return {
    videos: res.videos || [],
    nextPageToken: res.nextPageToken || "",
    appliedFilters: res.appliedFilters || {},
    query: res.query || query,
    filteredCount: res.filteredCount || 0,
    duplicatesRemoved: res.duplicatesRemoved || 0,
    totalResultsEstimate: res.totalResultsEstimate || 0,
    error: res.error || "",
    ok: res.ok,
    status: res.status
  };
}

// A fresh seed per page load is what makes each homepage refresh show a different
// ordering of the same large pool of real videos. It costs nothing: the server
// permutes videos it has already paid for.
function newFeedSeed(){
  try{
    if(window.crypto && typeof window.crypto.getRandomValues === "function"){
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return "s" + buffer[0].toString(36);
    }
  }
  catch(e){ /* fall through */ }
  return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// Homepage feed.
//
// `seed`    picks an ordering of the server's pool of popular videos. Omit it and
//           the server returns its deterministic order (unchanged behaviour).
// `topic`   optional derived-topic filter (Music, Gaming, ...) driven by the
//           homepage category bar.
// `pageToken` is the opaque continuation cursor from the previous page; it
//           carries the seed/offset internally so the caller stores nothing.
//
// Preserves `nextPageToken` ("" when there are no more pages), so the existing
// infinite-scroll code works untouched.
async function trending(max, pageToken, options = {}){
  const params = { max: String(max || 12) };
  if(pageToken){
    params.pageToken = String(pageToken);
  }
  if(options.seed){
    params.seed = String(options.seed);
  }
  if(options.topic){
    params.topic = String(options.topic);
  }
  if(options.region){
    params.region = String(options.region);
  }
  const res = await apiRequest("trending", params);
  return {
    videos: res.videos || [],
    nextPageToken: res.nextPageToken || "",
    // Additive: the topics actually present in the current pool, most common
    // first, so the category bar reflects real data instead of a static list.
    topics: Array.isArray(res.topics) ? res.topics : [],
    totalAvailable: Number(res.totalAvailable) || 0,
    error: res.error || "",
    ok: res.ok,
    status: res.status
  };
}

// Fetch a single YouTube video by its source id.
async function getVideo(id){
  const res = await apiRequest("video", { id: String(id) });
  return {
    video: res.video || null,
    error: res.error || "",
    ok: res.ok,
    status: res.status
  };
}

// Fetch related/discovery videos for a YouTube id.
async function related(id, max){
  const { videos, error, ok } = await apiRequest("related", { id: String(id), max: String(max || 15) });
  return { videos: videos || [], error: error || "", ok: ok };
}

// Fetch real public channel info (title + subscriber count) for a YouTube channel.
async function channel(id){
  const res = await apiRequest("channel", { id: String(id) });
  return { channel: res.channel || null, error: res.error || "", ok: res.ok };
}

// Fetch real public top-level comments for a YouTube video.
async function comments(id, max, pageToken){
  const params = { id: String(id), max: String(max || 20) };
  if(pageToken){
    params.pageToken = String(pageToken);
  }
  const res = await apiRequest("comments", params);
  return { comments: res.comments || [], nextPageToken: res.nextPageToken || "", error: res.error || "", ok: res.ok };
}

// Fetch the REAL YouTube Live Chat for a currently-live video.
//
// This is read-only and it is genuinely YouTube's own chat: it is never stored
// by MyTube, and no MyTube chat/messages endpoint exists.
//
// `id` is a VIDEO id, never a liveChatId — the backend resolves the active chat
// itself so this cannot be pointed at another stream. Deliberately uncached:
// the caller polls it on YouTube's own interval, and the server fans a single
// upstream request out to every viewer of the same stream.
//
// Always resolves. Returns:
//   { ok, status, chatStatus, messages, isLive, concurrentViewers,
//     pollingIntervalMillis, offlineAt, nextPageToken, error }
// where chatStatus is one of:
//   live | not_live | no_chat | ended | disabled | not_found | error
//
// `initial` should be true only for a viewer's FIRST poll of a stream. The server
// uses it to hand back the recent history (so the panel is never empty) without
// ever touching the server-owned cursor.
async function liveChat(id, pageToken, initial){
  const params = { id: String(id) };
  if(initial){
    params.initial = "1";
  }
  if(pageToken){
    params.pageToken = String(pageToken);
  }

  const res = await apiRequest("liveChat", params, null, { noCache: true });

  return {
    ok: Boolean(res.ok),
    status: Number(res.status) || 0,
    chatStatus: res.chatStatus || (res.ok ? "error" : "error"),
    messages: Array.isArray(res.messages) ? res.messages : [],
    isLive: Boolean(res.isLive),
    liveChatId: res.liveChatId || "",
    concurrentViewers: Number(res.concurrentViewers) || 0,
    pollingIntervalMillis: Number(res.pollingIntervalMillis) || 5000,
    offlineAt: res.offlineAt || "",
    nextPageToken: res.nextPageToken || "",
    code: res.code || "",
    error: res.error || ""
  };
}

// Fetch recent videos from a specific YouTube channel.
async function channelVideos(channelId, max, pageToken){
  const params = { channelId: String(channelId), max: String(max || 8) };
  if(pageToken){
    params.pageToken = String(pageToken);
  }
  const { videos, error, ok, nextPageToken } = await apiRequest("channelVideos", params);
  return { videos: videos || [], nextPageToken: nextPageToken || "", error: error || "", ok: ok };
}

// Whether the dynamic source is considered available (backend reachable).
async function isAvailable(){
  const base = await resolveBackendBase();
  return Boolean(base);
}

export {
  search,
  getVideo,
  related,
  channel,
  comments,
  trending,
  channelVideos,
  liveChat,
  isAvailable,
  newFeedSeed,
  FEED_TOPICS,
  VIDEO_CATEGORIES,
  SEARCH_ORDER_OPTIONS,
  SEARCH_DURATION_OPTIONS,
  SEARCH_UPLOAD_DATE_OPTIONS
};
