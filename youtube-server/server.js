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

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const normalize = require("./normalize.js");

const PORT = parseInt(process.env.PORT || "3456", 10);
const API_KEY = process.env.YOUTUBE_API_KEY || "";

// Project root = parent of the youtube-server directory.
const YT_ROOT = process.env.YT_ROOT
  ? path.resolve(process.env.YT_ROOT)
  : path.resolve(__dirname, "..");

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

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
  "http://localhost:5504"
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
async function ytFetch(cacheKey, url){
  const cached = cacheGet(cacheKey);
  if(cached){
    return cached;
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

  cacheSet(cacheKey, data);
  return data;
}

// =============================================================================
// API handlers
// =============================================================================

// GET /api/ping
// A lightweight health check. Returns the exact expected JSON so the frontend
// can reliably distinguish our API server from any other server (e.g. Live
// Server) that might respond with a plain 404 for /api/ping.
function handlePing(req, res){
  return sendJSON(res, 200, { ok: true, service: "mytube-api" });
}

// GET /api/trending?max=<n>&region=<code>
// Uses the official YouTube Data API "videos?chart=mostPopular" endpoint, which
// is the closest official equivalent to a YouTube "Trending" / homepage feed.
async function handleTrending(req, res, params){
  if(!API_KEY){
    return sendJSON(res, 503, {
      error: "YouTube API key not configured.",
      videos: []
    });
  }

  const maxResults = Math.min(Math.max(parseInt(params.get("max") || "20", 10) || 20, 1), 50);
  const region = (params.get("region") || "US").toString().toUpperCase().slice(0, 2);
  const cacheKey = "trending:" + region + ":" + maxResults;

  try{
    const url = YT_API_BASE + "/videos?part=snippet,contentDetails,statistics&chart=mostPopular" +
      "&regionCode=" + encodeURIComponent(region) + "&maxResults=" + maxResults;
    const data = await ytFetch(cacheKey, url);
    const videos = normalize.normalizeVideosResponse(data);
    return sendJSON(res, 200, { videos });
  }
  catch(err){
    logYouTubeError(err);
    return sendJSON(res, 502, {
      error: normalizeError(err, "Could not load trending videos."),
      videos: []
    });
  }
}

// GET /api/search?q=<query>&max=<n>
// Returns an array of normalized video objects.
async function handleSearch(req, res, params){
  const q = (params.get("q") || "").trim();
  if(!q){
    return sendJSON(res, 400, { error: "Missing query", videos: [] });
  }
  if(!API_KEY){
    return sendJSON(res, 503, {
      error: "YouTube API key not configured.",
      videos: []
    });
  }

  const maxResults = Math.min(Math.max(parseInt(params.get("max") || "20", 10) || 20, 1), 50);
  const cacheKey = "search:" + q.toLowerCase() + ":" + maxResults;

  try{
    const url = YT_API_BASE + "/search?part=snippet&type=video&maxResults=" + maxResults +
      "&q=" + encodeURIComponent(q);
    const data = await ytFetch(cacheKey, url);
    const videos = normalize.normalizeSearchResponse(data);

    // Optionally enrich with durations & view counts from videos.list.
    try{
      await enrichWithStats(videos);
    }
    catch(e){
      // Non-fatal: we can still return results without stats/durations.
    }

    return sendJSON(res, 200, { videos });
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
    const url = YT_API_BASE + "/videos?part=snippet,contentDetails,statistics,status&id=" + encodeURIComponent(id);
    const data = await ytFetch(cacheKey, url);
    const videos = normalize.normalizeVideosResponse(data);
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
  const cacheKey = "comments:" + id + ":" + maxResults;

  try{
    const url = YT_API_BASE + "/commentThreads?part=snippet&videoId=" + encodeURIComponent(id) +
      "&maxResults=" + maxResults + "&order=relevance&textFormat=plainText";
    const data = await ytFetch(cacheKey, url);
    const comments = normalize.normalizeCommentsResponse(data);
    return sendJSON(res, 200, { comments });
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
    const title = snippet.title || "";

    // 2) Query for videos from the same channel plus a related keyword search,
    //    then merge and dedupe. This is the official, allowed approach.
    const results = [];

    const channelCacheKey = "channel:" + channelId + ":" + maxResults;
    if(channelId){
      try{
        const chanUrl = YT_API_BASE + "/search?part=snippet&type=video&channelId=" +
          encodeURIComponent(channelId) + "&maxResults=" + maxResults;
        const chanData = await ytFetch(channelCacheKey, chanUrl);
        const chanVideos = normalize.normalizeSearchResponse(chanData);
        results.push(...chanVideos);
      }
      catch(e){ /* ignore */ }
    }

    // 3) Also search by the video title's first few meaningful words.
    const keywords = (title || "").split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(" ");
    if(results.length < maxResults && keywords){
      try{
        const searchUrl = YT_API_BASE + "/search?part=snippet&type=video&maxResults=" +
          maxResults + "&q=" + encodeURIComponent(keywords);
        const searchData = await ytFetch("relatedsearch:" + keywords + ":" + maxResults, searchUrl);
        const searchVideos = normalize.normalizeSearchResponse(searchData);
        results.push(...searchVideos);
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

    return sendJSON(res, 200, { videos: deduped });
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
  const url = YT_API_BASE + "/videos?part=contentDetails,statistics&id=" + encodeURIComponent(ids) +
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
    const viewCountInt = parseInt(stats.viewCount, 10);
    if(Number.isFinite(viewCountInt)){
      v.viewCount = viewCountInt;
      v.views = viewCountInt ? (normalize.formatCount(viewCountInt) + " views") : "";
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

  // Never serve sensitive files (env, git metadata).
  const SENSITIVE = [".env", ".env.example", ".git", ".gitignore", "package-lock.json"];
  for(const name of SENSITIVE){
    if(filePath === name || filePath.startsWith(name + "/")){
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
    try{
      if(route === "ping"){
        return handlePing(req, res);
      }
      if(route.startsWith("trending")){
        return await handleTrending(req, res, url.searchParams);
      }
      if(route.startsWith("search")){
        return await handleSearch(req, res, url.searchParams);
      }
      if(route.startsWith("video")){
        return await handleVideo(req, res, url.searchParams);
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
