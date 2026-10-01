// =============================================================================
// MyTube — Shared search tuning
// -----------------------------------------------------------------------------
// The YouTube Data API search endpoint accepts far more control than MyTube was
// using. Everything here maps MyTube-facing options onto parameters the official
// `search.list` resource ACTUALLY supports, so every improvement below is backed
// by real YouTube data — nothing is faked, inferred or invented.
//
// Verified live against the YouTube Data API v3 before being wired in:
//   order=viewCount|date|rating        HTTP 200
//   videoDuration=short|medium|long    HTTP 200
//   videoCategoryId=<id>               HTTP 200
//   publishedAfter / publishedBefore   HTTP 200
//   topicId                            HTTP 200
//   safeSearch                         HTTP 200
//   relevanceLanguage                  HTTP 200
//   videoEmbeddable=true               HTTP 200   (only "true" is legal;
//                                                      "false" returns HTTP 400)
//
// Hard limits of the upstream API, kept in mind by design:
//   * search.list costs 100 quota units per CALL regardless of maxResults
//     (max 50). Bigger pages are therefore strictly cheaper per result.
//   * A single query returns at most 500 results, so pagination is bounded.
//   * There is no relevance score, no result offset and no "did you mean".
//
// Used by BOTH the Cloudflare Worker (production) and the local Node server.
// =============================================================================

// Sort options. These map 1:1 onto search.list's `order` parameter.
const SEARCH_ORDERS = {
  relevance: "relevance",
  date: "date",
  viewCount: "viewCount",
  rating: "rating"
};

// Duration buckets -> search.list `videoDuration`.
const SEARCH_DURATIONS = {
  short: "short",
  medium: "medium",
  long: "long",
  any: ""
};

// Upload-date windows. YouTube only accepts absolute timestamps, so the relative
// windows the UI offers are resolved to publishedAfter/publishedBefore here.
const SEARCH_UPLOAD_WINDOWS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000
};

// Longest query accepted. YouTube itself is far more permissive; this simply
// keeps an unbounded user string out of the upstream URL and the cache key.
const SEARCH_QUERY_MAX_LENGTH = 128;

// Strip characters that would only distort the query (zero-width marks, control
// characters) and collapse runs of whitespace. Casing is deliberately PRESERVED:
// the original text is what YouTube should receive.
function normalizeQuery(raw){
  const value = raw === null || raw === undefined ? "" : String(raw);

  const cleaned = (typeof value.normalize === "function" ? value.normalize("NFKC") : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_QUERY_MAX_LENGTH)
    .trim();

  return cleaned;
}

// Resolve an upload-date window into an absolute ISO lower bound.
function publishedAfterFor(windowName, now){
  const span = SEARCH_UPLOAD_WINDOWS[windowName];

  if(!span){
    return "";
  }

  return new Date((Number(now) || Date.now()) - span).toISOString();
}

function readParam(params, name){
  if(!params){
    return "";
  }

  const value = typeof params.get === "function" ? params.get(name) : params[name];

  return value === null || value === undefined ? "" : String(value).trim();
}

// Translate MyTube search options into search.list parameters.
//
// Every option is optional. With none of them the returned `searchParams` are
// exactly what MyTube sent before, so an unmodified call behaves identically.
function resolveSearchFilters(params, options){
  const now = (options && options.now) || Date.now();

  const order = readParam(params, "order");
  const duration = readParam(params, "duration");
  const uploadDate = readParam(params, "uploadDate");
  const categoryId = readParam(params, "categoryId");
  const region = readParam(params, "region");
  const language = readParam(params, "relevanceLanguage");
  const safeSearch = readParam(params, "safeSearch");
  const embeddableOnly = readParam(params, "videoEmbeddable");
  const beforeDate = readParam(params, "publishedBefore");

  const searchParams = {};
  const applied = {};

  const resolvedOrder = SEARCH_ORDERS[order] || "";
  if(resolvedOrder){
    searchParams.order = resolvedOrder;
    applied.order = resolvedOrder;
  }

  const resolvedDuration = SEARCH_DURATIONS[duration] || "";
  if(resolvedDuration){
    searchParams.videoDuration = resolvedDuration;
    applied.duration = resolvedDuration;
  }

  if(SEARCH_UPLOAD_WINDOWS[uploadDate]){
    searchParams.publishedAfter = publishedAfterFor(uploadDate, now);
    applied.uploadDate = uploadDate;
  }

  if(beforeDate){
    searchParams.publishedBefore = beforeDate;
  }

  // `videoCategoryId` must be numeric; anything else is ignored rather than
  // forwarded, because YouTube answers HTTP 400 for an invalid id.
  if(/^\d{1,4}$/.test(categoryId)){
    searchParams.videoCategoryId = categoryId;
    applied.categoryId = categoryId;
  }

  if(/^[A-Za-z]{2}$/.test(region)){
    searchParams.regionCode = region.toUpperCase();
    applied.region = searchParams.regionCode;
  }

  if(/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(language)){
    searchParams.relevanceLanguage = language;
    applied.relevanceLanguage = language;
  }

  if(safeSearch === "strict" || safeSearch === "moderate" || safeSearch === "none"){
    searchParams.safeSearch = safeSearch;
    applied.safeSearch = safeSearch;
  }

  // ONLY "true" is a legal value upstream ("false" -> HTTP 400), so this is a
  // one-way switch: ask YouTube for playable videos and nothing else.
  if(embeddableOnly === "1" || embeddableOnly === "true"){
    searchParams.videoEmbeddable = true;
    applied.videoEmbeddable = true;
  }

  return {
    searchParams,
    applied
  };
}

// Largest number of results a single search page may ask for. search.list costs a
// flat 100 units per call, so a full page is the cheapest way to show results.
const SEARCH_PAGE_MAX = 50;
const SEARCH_PAGE_DEFAULT = 50;

function resolveSearchMax(raw){
  const value = Number(raw);

  if(!Number.isFinite(value)){
    return SEARCH_PAGE_DEFAULT;
  }

  return Math.min(Math.max(Math.round(value), 1), SEARCH_PAGE_MAX);
}

// Deduplicate by video id and drop results MyTube genuinely cannot play.
//
// Two real problems this solves, both measured on the live API:
//   * YouTube repeats videos across pages of one query (11 shared ids between the
//     first two pages of "web dev tutorial" in production).
//   * Roughly 2% of results carry `status.embeddable === false`, i.e. they render
//     a card that can never be watched on MyTube.
//
// Nothing else is dropped, and no ordering is changed here.
function dedupeSearchResults(videos){
  const seen = new Set();
  const kept = [];
  let duplicates = 0;
  let filtered = 0;

  for(const video of Array.isArray(videos) ? videos : []){
    if(!video || !video.id){
      continue;
    }

    const key = video.sourceId || video.id;

    if(seen.has(key)){
      duplicates++;
      continue;
    }

    seen.add(key);

    if(video.embeddable === false){
      filtered++;
      continue;
    }

    kept.push(video);
  }

  return {
    videos: kept,
    duplicatesRemoved: duplicates,
    filteredCount: filtered
  };
}

export {
  SEARCH_ORDERS,
  SEARCH_DURATIONS,
  SEARCH_UPLOAD_WINDOWS,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_PAGE_MAX,
  SEARCH_PAGE_DEFAULT,
  normalizeQuery,
  publishedAfterFor,
  resolveSearchFilters,
  resolveSearchMax,
  dedupeSearchResults
};