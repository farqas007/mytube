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

async function apiRequest(route, params, signal){
  let cacheKey = null;
  const base = await resolveBackendBase();
  if(!base){
    return { ok: false, error: "Backend not reachable." };
  }

  const qs = new URLSearchParams(params).toString();
  const url = base + "/" + route + (qs ? ("?" + qs) : "");
  cacheKey = url;

  const cached = cacheGet(cacheKey);
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
      error: (payload && payload.error) ? payload.error : ""
    };
    if(res.ok){
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

// Search YouTube. Returns { videos, error, ok }.
// Never resolves to null; on any failure it returns an empty array so the
// caller can safely fall back to local videos.
async function search(query, max, signal){
  const { videos, error, ok } = await apiRequest("search", { q: query, max: String(max || 20) }, signal);
  return { videos: videos || [], error: error || "", ok: ok };
}

// Official YouTube trending / "most popular" feed.
async function trending(max, bustCache){
  const params = { max: String(max || 20) };
  if(bustCache){ params._t = String(Date.now()); }
  const { videos, error, ok } = await apiRequest("trending", params);
  return { videos: videos || [], error: error || "", ok: ok };
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
async function comments(id, max){
  const res = await apiRequest("comments", { id: String(id), max: String(max || 20) });
  return { comments: res.comments || [], error: res.error || "", ok: res.ok };
}

// Whether the dynamic source is considered available (backend reachable).
async function isAvailable(){
  const base = await resolveBackendBase();
  return Boolean(base);
}

export { search, getVideo, related, channel, comments, trending, isAvailable };
