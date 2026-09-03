import {
  normalizeSearchItem,
  normalizeVideoItem,
  normalizeSearchResponse,
  normalizeVideosResponse,
  normalizeChannelResponse,
  normalizeCommentsResponse
} from "./worker-normalize.js";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const memoryCache = new Map();

function json(data, status = 200, request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };

  const origin = request?.headers?.get("Origin");

  if (
    origin === "http://localhost:5504" ||
    origin === "http://127.0.0.1:5504" ||
    origin === "https://mytube.farqas007.workers.dev"
  ) {
    headers["Access-Control-Allow-Origin"] = origin;
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

  return {
    error: error?.message || "YouTube API request failed.",
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

async function ytFetch(pathname, params, apiKey) {
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

  const cached = cacheGet(cacheKey);

  if (cached) {
    return cached;
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

  cacheSet(cacheKey, result);

  return result;
}

async function getVideoDetails(videoId, apiKey) {
  const result = await ytFetch(
    "videos",
    {
      part: "snippet,contentDetails,statistics,status",
      id: videoId
    },
    apiKey
  );

  return result.data?.items?.[0] || null;
}

async function searchYouTube(query, max, apiKey) {
  const searchResult = await ytFetch(
    "search",
    {
      part: "snippet",
      type: "video",
      q: query,
      maxResults: Math.min(Math.max(Number(max) || 20, 1), 50)
    },
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
        part: "snippet,contentDetails,statistics,status",
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

async function getTrending(max, region, apiKey) {
  const result = await ytFetch(
    "videos",
    {
      part: "snippet,contentDetails,statistics,status",
      chart: "mostPopular",
      regionCode: region || "PK",
      maxResults: Math.min(Math.max(Number(max) || 12, 1), 50)
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

async function getComments(videoId, max, apiKey) {
  const result = await ytFetch(
    "commentThreads",
    {
      part: "snippet",
      videoId,
      maxResults: Math.min(Math.max(Number(max) || 20, 1), 100),
      order: "relevance",
      textFormat: "plainText"
    },
    apiKey
  );

  return normalizeCommentsResponse(result.data);
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
  const title = targetSnippet.title || "";

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

  if (results.length < Number(max || 12)) {
    const keywords = title
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 6)
      .join(" ");

    if (keywords) {
      const keywordSearch = await ytFetch(
        "search",
        {
          part: "snippet",
          type: "video",
          q: keywords,
          maxResults: Math.min(
            Math.max(Number(max) || 12, 1),
            25
          )
        },
        apiKey
      );

      for (const item of keywordSearch.data?.items || []) {
        const id = item?.id?.videoId;

        if (!id || seen.has(id)) continue;

        seen.add(id);

        results.push(
          normalizeSearchItem(item)
        );

        if (results.length >= Number(max || 12)) {
          break;
        }
      }
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
        part: "snippet,contentDetails,statistics,status",
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

async function handleAPI(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, "");
  const apiKey = env.YOUTUBE_API_KEY || "";

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
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

      const result = await searchYouTube(
        q,
        max,
        apiKey
      );

      return json(result, 200, request);
    }

    if (route === "trending") {
      const max = url.searchParams.get("max") || "12";
      const region = url.searchParams.get("region") || "PK";

      const result = await getTrending(
        max,
        region,
        apiKey
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

      const result = await getComments(
        id,
        max,
        apiKey
      );

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

    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
