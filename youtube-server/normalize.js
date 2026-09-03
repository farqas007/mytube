// =============================================================================
// NORMALIZATION LAYER (server-side)
// -----------------------------------------------------------------------------
// Converts the raw YouTube Data API responses into a clean, MyTube-compatible
// shape. The frontend never sees raw YouTube JSON. This keeps YouTube-specific
// field names (snippet.statistics.contentDetails) out of the rest of the app.
//
// A normalized video looks like the local videos found in videos.js so the
// existing card / watch-page logic can render it:
//   {
//     id: "yt:<videoId>",   // namespaced id used in watch.html?id=yt:<id>
//     sourceId: "<videoId>",// the raw YouTube video id (used for the embed)
//     type: "youtube",
//     title, channel, thumb, time, views, viewCount, date, description
//   }
// =============================================================================

// YouTube published dates look like "2024-01-05T18:22:00Z" -> "Jan 5, 2024".
function formatPublishedDate(iso){
  if(!iso){
    return "";
  }
  const d = new Date(iso);
  if(isNaN(d.getTime())){
    return "";
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// "PT2M31S" -> "2:31", "PT1H2M31S" -> "1:02:31"
function formatDuration(iso){
  if(!iso){
    return "";
  }
  let h = 0, m = 0, s = 0;
  const mRes = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if(mRes){
    h = parseInt(mRes[1] || "0", 10);
    m = parseInt(mRes[2] || "0", 10);
    s = parseInt(mRes[3] || "0", 10);
  }
  const strM = (h > 0 ? String(m).padStart(2, "0") : String(m));
  const strS = String(s).padStart(2, "0");
  return (h > 0) ? `${h}:${strM}:${strS}` : `${strM}:${strS}`;
}

// 1234567 -> "1.2M"
function formatCount(n){
  if(!Number.isFinite(n)){
    return "";
  }
  if(n >= 1000000){
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if(n >= 1000){
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return String(n);
}

// Pick the best available thumbnail URL.
function pickThumbnail(item){
  const t = item && item.snippet && item.snippet.thumbnails;
  if(!t){
    return "";
  }
  if(t.maxres){ return t.maxres.url; }
  if(t.high){ return t.high.url; }
  if(t.medium){ return t.medium.url; }
  if(t.default){ return t.default.url; }
  return "";
}

// Normalize a single search result item (has snippet + optional id).
function normalizeSearchItem(item, extra){
  const snippet = item.snippet || {};
  extra = extra || {};
  const date = formatPublishedDate(snippet.publishedAt);
  const channel = snippet.channelTitle || "Unknown channel";
  return {
    id: "yt:" + extra.videoId,
    sourceId: extra.videoId,
    type: "youtube",
    title: snippet.title || "Untitled",
    channel: channel,
    thumb: pickThumbnail(item),
    time: extra.duration ? formatDuration(extra.duration) : "•",
    views: extra.viewCount ? (formatCount(extra.viewCount) + " views") : "",
    viewCount: extra.viewCount || 0,
    date: date,
    description: snippet.description || ""
  };
}

// Normalize a single videos.list item — merges snippet/statistics/contentDetails
// (which live in the same item for videos.list, unlike search.list).
function normalizeVideoItem(item){
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const details = item.contentDetails || {};
  const videoId = item.id || "";

  const viewCountInt = parseInt(stats.viewCount, 10);
  const viewCount = Number.isFinite(viewCountInt) ? viewCountInt : 0;

  const likeCountInt = parseInt(stats.likeCount, 10);
  const likeCount = Number.isFinite(likeCountInt) && likeCountInt >= 0 ? likeCountInt : null;

  const commentCountInt = parseInt(stats.commentCount, 10);
  const commentCount = Number.isFinite(commentCountInt) && commentCountInt >= 0 ? commentCountInt : null;

  // status.embeddable is only present when the videos.list call requests the
  // "status" part. When it is absent (e.g. search/related results) we default to
  // true so the watch page never falsely treats a video as un-embeddable.
  const embeddable = (item.status && typeof item.status.embeddable === "boolean")
    ? item.status.embeddable
    : true;

  return {
    id: "yt:" + videoId,
    sourceId: videoId,
    type: "youtube",
    title: snippet.title || "Untitled",
    channel: snippet.channelTitle || "Unknown channel",
    channelId: snippet.channelId || "",
    thumb: pickThumbnail(item),
    time: formatDuration(details.duration),
    views: viewCount ? (formatCount(viewCount) + " views") : "",
    viewCount: viewCount,
    likeCount: likeCount,
    commentCount: commentCount,
    date: formatPublishedDate(snippet.publishedAt),
    description: snippet.description || "",
    embeddable: embeddable
  };
}

// =============================================================================
// PUBLIC API
// =============================================================================

// Convert a raw search.list response (with optional per-id duration/stat data)
// into an array of normalized video objects.
function normalizeSearchResponse(data){
  const items = (data && data.items) || [];
  const seen = new Set();
  const out = [];

  for(const item of items){
    if(!item || !item.snippet){
      continue;
    }
    const kind = item.id && item.id.kind;
    const videoId = item.id && item.id.videoId;
    // Only keep actual video results (ignore channels/playlists).
    if(kind === "youtube#video" && videoId){
      if(seen.has(videoId)){
        continue;
      }
      seen.add(videoId);
      out.push(normalizeSearchItem(item, { videoId }));
    }
  }

  return out;
}

// Convert a raw videos.list response into array of normalized video objects.
function normalizeVideosResponse(data){
  const items = (data && data.items) || [];
  const seen = new Set();
  const out = [];
  for(const item of items){
    if(!item || !item.id){
      continue;
    }
    if(seen.has(item.id)){
      continue;
    }
    seen.add(item.id);
    out.push(normalizeVideoItem(item));
  }
  return out;
}

// Normalize a channels.list response. subscriberCount may be hidden or rounded by
// YouTube; when hiddenSubscriberCount is true (or the number is absent) we return
// null so the frontend can show a truthful "—" instead of a made-up figure.
function normalizeChannelResponse(data){
  const item = (data && data.items && data.items[0]) || null;
  if(!item || !item.id){
    return null;
  }
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const hidden = stats.hiddenSubscriberCount === true;
  const subRaw = parseInt(stats.subscriberCount, 10);
  const subscriberCount = hidden || !Number.isFinite(subRaw) ? null : subRaw;
  return {
    id: item.id,
    title: snippet.title || "Unknown channel",
    thumb: pickThumbnail(item),
    subscriberCount: subscriberCount,
    subscribers: subscriberCount != null ? formatCount(subscriberCount) + " subscribers" : ""
  };
}

// Normalize a commentThreads.list response. Only top-level comments are mapped.
// We read textOriginal (plain text) — never build HTML from untrusted content.
function normalizeCommentsResponse(data){
  const items = (data && data.items) || [];
  const out = [];
  for(const t of items){
    const top = t && t.snippet && t.snippet.topLevelComment && t.snippet.topLevelComment.snippet;
    if(!top){
      continue;
    }
    out.push({
      id: (t && t.id) || "",
      author: top.authorDisplayName || "YouTube user",
      authorThumb: top.authorProfileImageUrl || "",
      text: top.textOriginal || "",
      publishedAt: top.publishedAt || ""
    });
  }
  return out;
}

module.exports = {
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse,
  formatCount,
  formatDuration,
  formatPublishedDate
};
