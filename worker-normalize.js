function formatPublishedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

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
  if (!value) return "";

  const match = String(value).match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
  );

  if (!match) return "";

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
  if (!thumbnails) return "";

  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

function normalizeSearchItem(item, details = null) {
  const snippet = item?.snippet || {};
  const stats = details?.statistics || {};
  const contentDetails = details?.contentDetails || {};

  const videoId =
    item?.id?.videoId ||
    item?.id ||
    details?.id ||
    "";

  if (!videoId) return null;

  return {
    id: `yt:${videoId}`,
    sourceId: videoId,
    type: "youtube",
    title: snippet.title || "",
    channel: snippet.channelTitle || "",
    channelId: snippet.channelId || "",
    thumb: pickThumbnail(snippet.thumbnails),
    time: formatDuration(contentDetails.duration),
    views: formatCount(stats.viewCount),
    viewCount: Number(stats.viewCount || 0),
    likeCount: Number(stats.likeCount || 0),
    commentCount: Number(stats.commentCount || 0),
    date: formatPublishedDate(snippet.publishedAt),
    description: snippet.description || "",
    embeddable: details?.status?.embeddable !== false
  };
}

function normalizeVideoItem(item) {
  if (!item) return null;

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

  return {
    channel: {
      id: item.id || "",
      title: snippet.title || "",
      description: snippet.description || "",
      thumb: pickThumbnail(snippet.thumbnails),
      subscriberCount:
        stats.hiddenSubscriberCount
          ? null
          : Number(stats.subscriberCount || 0),
      viewCount: Number(stats.viewCount || 0),
      videoCount: Number(stats.videoCount || 0)
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
        authorPhoto: snippet.authorProfileImageUrl || "",
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

export {
  formatPublishedDate,
  formatDuration,
  formatCount,
  pickThumbnail,
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse
};
