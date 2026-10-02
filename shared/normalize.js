// =============================================================================
// MyTube — Shared YouTube Data API normalizer
// -----------------------------------------------------------------------------
// THE single source of truth for converting raw YouTube Data API v3 responses
// into the clean, MyTube-compatible shape. Used by BOTH the Cloudflare Worker
// (production) and the local Node server (development). Keeping one module here
// guarantees identical JSON shapes across environments.
//
// Canonical video shape (mirrors the local videos in videos.js):
//   {
//     id: "yt:<videoId>",   // namespaced id for /watch?id=yt%3A<id>
//     sourceId: "<videoId>",// the raw YouTube video id (used for the embed)
//     type: "youtube",
//     title, channel, channelId, thumb, time, views, viewCount,
//     likeCount, commentCount, date, description, embeddable,
//     isLive, liveChatId, concurrentViewers
//   }
//
// The three live fields are additive and always present (booleans/strings/numbers
// with safe fallbacks), so existing consumers that ignore them are unaffected.
//
// List endpoints always return { videos: [...], nextPageToken: "..." } (an empty
// string when there is no next page). Comments return { comments, nextPageToken }
// and channels return { channel }.
// =============================================================================

function formatPublishedDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diff = Date.now() - date.getTime();
  const seconds = Math.max(0, Math.floor(diff / 1000));

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

function formatDuration(value) {
  if (!value) {
    return "";
  }

  const match = String(value).match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );

  if (!match) {
    return "";
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatCount(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) return "0";
  if (number >= 1_000_000_000) {
    return `${(number / 1_000_000_000).toFixed(number >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  }
  if (number >= 1_000) {
    return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  }

  return String(number);
}

function pickThumbnail(thumbnails) {
  if (!thumbnails) {
    return "";
  }

  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

// -----------------------------------------------------------------------------
// Live streaming state
// -----------------------------------------------------------------------------
// Derives the "is this broadcast live right now" state from the official
// `liveStreamingDetails` part of a videos.list item.
//
// YouTube's own signals, in priority order:
//   * snippet.liveBroadcastContent === "live"  -> definitively live
//   * liveStreamingDetails.actualStartTime present AND actualEndTime absent
//     -> started but not finished (covers the brief window where
//     liveBroadcastContent has not flipped yet)
//   * anything else -> not live
//
// `activeLiveChatId` is only populated by YouTube WHILE a broadcast is live, so
// its presence is itself a strong live signal (used as a tie-breaker).
//
// Never throws: every field has a safe fallback so non-live videos and search
// results without a `details` payload keep the exact same shape as before.
function readLiveState(item) {
  const snippet = item?.snippet || {};
  const live = item?.liveStreamingDetails || {};

  const started = Boolean(live.actualStartTime);
  const ended = Boolean(live.actualEndTime);
  const liveChatId = live.activeLiveChatId || "";
  const broadcastSaysLive = snippet.liveBroadcastContent === "live";

  let isLive = false;

  if (broadcastSaysLive) {
    isLive = true;
  } else if (started && !ended) {
    isLive = true;
  } else if (!started && liveChatId) {
    // activeLiveChatId without any start timestamp: treat as live, YouTube only
    // emits it for an active broadcast.
    isLive = true;
  }

  if (ended) {
    isLive = false;
  }

  const viewers = Number(live.concurrentViewers);

  return {
    isLive,
    liveChatId: isLive ? liveChatId : "",
    concurrentViewers:
      isLive && Number.isFinite(viewers) && viewers > 0 ? viewers : 0,
    liveChatDisabled: isLive ? live.liveChatDisabled === true : false,
    actualStartTime: live.actualStartTime || "",
    actualEndTime: live.actualEndTime || ""
  };
}

// Normalize a single video (search items, videos.list items, etc.).
// `details` (optional) is the matching videos.list item when the caller fetched
// statistics/contentDetails/status separately (search results don't include them).
function normalizeSearchItem(item, details = null) {
  const snippet = item?.snippet || {};
  const stats = details?.statistics || {};
  const contentDetails = details?.contentDetails || {};
  const status = details?.status || {};

  // `details` is the only payload that can carry liveStreamingDetails, but
  // snippet.liveBroadcastContent (and therefore isLive) is often available on a
  // bare search item too. readLiveState() handles both.
  const live = readLiveState(details || item);

  const videoId =
    item?.id?.videoId ||
    item?.id ||
    details?.id ||
    "";

  if (!videoId) return null;

  const viewCount = Number(stats.viewCount || 0);
  const likeCount = Number(stats.likeCount || 0);
  const commentCount = Number(stats.commentCount || 0);

  return {
    id: `yt:${videoId}`,
    sourceId: videoId,
    type: "youtube",
    title: snippet.title || "",
    channel: snippet.channelTitle || "",
    channelId: snippet.channelId || "",
    thumb: pickThumbnail(snippet.thumbnails),
    time: formatDuration(contentDetails.duration),
    views: `${formatCount(viewCount)} views`,
    viewCount,
    likeCount,
    commentCount,
    date: formatPublishedDate(snippet.publishedAt),
    description: snippet.description || "",
    embeddable: status.embeddable !== false,
    isLive: live.isLive,
    liveChatId: live.liveChatId,
    concurrentViewers: live.concurrentViewers,
    liveChatDisabled: live.liveChatDisabled,
    actualStartTime: live.actualStartTime,
    actualEndTime: live.actualEndTime
  };
}

function normalizeVideoItem(item) {
  if (!item) {
    return null;
  }

  return normalizeSearchItem(
    {
      id: item.id,
      snippet: item.snippet
    },
    item
  );
}

function normalizeSearchResponse(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const seen = new Set();
  const videos = [];

  for (const item of items) {
    const video = normalizeSearchItem(item);

    if (!video || seen.has(video.sourceId)) continue;

    seen.add(video.sourceId);
    videos.push(video);
  }

  return {
    videos,
    nextPageToken: data?.nextPageToken || ""
  };
}

function normalizeVideosResponse(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const seen = new Set();
  const videos = [];

  for (const item of items) {
    const video = normalizeVideoItem(item);

    if (!video || seen.has(video.sourceId)) continue;

    seen.add(video.sourceId);
    videos.push(video);
  }

  return {
    videos,
    nextPageToken: data?.nextPageToken || ""
  };
}

function normalizeChannelResponse(data) {
  const item = data?.items?.[0];

  if (!item) {
    return {
      channel: null
    };
  }

  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const countHidden = stats.hiddenSubscriberCount === true;
  const subscriberCount = countHidden
    ? null
    : Number(stats.subscriberCount || 0);

  return {
    channel: {
      id: item.id || "",
      title: snippet.title || "",
      description: snippet.description || "",
      thumb: pickThumbnail(snippet.thumbnails),
      subscriberCount,
      subscriberCountHidden: countHidden,
      viewCount: Number(stats.viewCount || 0),
      videoCount: Number(stats.videoCount || 0),
      subscribers:
        subscriberCount == null
          ? ""
          : `${formatCount(subscriberCount)} subscribers`
    }
  };
}

function normalizeCommentsResponse(data) {
  const items = Array.isArray(data?.items) ? data.items : [];

  const comments = items
    .map(item => {
      const thread = item?.snippet?.topLevelComment;
      const snippet = thread?.snippet;

      if (!snippet) return null;

      return {
        id: thread?.id || item?.id || "",
        author: snippet.authorDisplayName || "",
        authorChannelId: snippet.authorChannelId?.value || "",
        authorThumb: snippet.authorProfileImageUrl || "",
        text: snippet.textOriginal || "",
        likeCount: Number(snippet.likeCount || 0),
        publishedAt: snippet.publishedAt || "",
        updatedAt: snippet.updatedAt || ""
      };
    })
    .filter(Boolean);

  return {
    comments,
    nextPageToken: data?.nextPageToken || ""
  };
}

// -----------------------------------------------------------------------------
// YouTube Live Chat (liveChatMessages.list)
// -----------------------------------------------------------------------------
// YouTube live chat is a completely different resource from video comments: it
// only exists while a broadcast is live, it is not paginated by "relevance", and
// it is polled (not paginated) using `nextPageToken` + `pollingIntervalMillis`.
//
// Normalize a single liveChatMessage. Every field has a safe fallback and only
// plain strings/booleans leave this function, so the frontend can render it with
// textContent only (never innerHTML).
function normalizeLiveChatMessage(item) {
  const snippet = item?.snippet || {};
  const author = item?.authorDetails || {};

  const id = item?.id || "";

  if (!id) return null;

  // Chat messages carry their text in one of two places depending on the event
  // type: textMessageDetails for real messages, displayMessage for the rest.
  const text =
    snippet.textMessageDetails?.messageText ||
    snippet.displayMessage ||
    "";

  // When a message is retracted/tombstoned YouTube replaces the text with an
  // empty displayMessage. Treat "no text at all" as not renderable.
  if (!text) return null;

  const superChat = snippet.superChatEventDetails || null;
  const superSticker = snippet.superStickerEventDetails || null;
  const funding = superChat || superSticker || null;

  return {
    id,
    author: author.displayName || "",
    authorChannelId: author.channelId || "",
    authorThumb: author.profileImageUrl || "",
    text,
    publishedAt: snippet.publishedAt || "",
    type: snippet.type || "",
    isChatOwner: author.isChatOwner === true,
    isChatModerator: author.isChatModerator === true,
    isChatSponsor: author.isChatSponsor === true,
    isVerified: author.isVerified === true,
    superChatAmount: funding?.amountDisplayString || "",
    superChatUserComment: funding?.userComment || ""
  };
}

// Normalize a full liveChatMessages.list response.
//
// `offlineAt` is set by YouTube only when the underlying stream has already
// gone offline — the authoritative "this live chat is over" signal.
function normalizeLiveChatResponse(data) {
  const items = Array.isArray(data?.items) ? data.items : [];

  const messages = items
    .map(item => normalizeLiveChatMessage(item))
    .filter(Boolean);

  const rawInterval = Number(data?.pollingIntervalMillis);
  const interval = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.round(rawInterval)
    : 5000;

  const rawTotal = Number(data?.pageInfo?.totalResults);

  return {
    messages,
    nextPageToken: data?.nextPageToken || "",
    pollingIntervalMillis: interval,
    offlineAt: data?.offlineAt || "",
    activePoll: data?.activePollItem
      ? normalizeLiveChatMessage(data.activePollItem)
      : null,
    totalResults: Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 0
  };
}

export {
  formatPublishedDate,
  formatDuration,
  formatCount,
  pickThumbnail,
  readLiveState,
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse,
  normalizeLiveChatMessage,
  normalizeLiveChatResponse
};