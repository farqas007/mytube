// =============================================================================
// MyTube — Shared homepage feed engine
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
// The official YouTube Data API has no recommendation/personalization endpoint,
// and its only "homepage-like" resource — `videos.list?chart=mostPopular` — is a
// single, region-scoped, slowly rotating list that accepts NO ordering, no
// randomization and no seed. Measured in production it exposes only ~197 videos
// for regionCode=PK, and its first page never changes between refreshes.
//
// So MyTube builds its own feed instead of pretending YouTube randomizes:
//   1. Collect a LARGER pool of genuinely popular videos from several cheap
//      `videos.list?chart=mostPopular` calls (1 quota unit each, one per region).
//   2. Order that pool with a deterministic SEEDED permutation, so every refresh
//      gets a different ordering of real videos at ZERO extra quota.
//   3. Page through that permutation with an opaque cursor, which makes
//      consecutive pages provably disjoint.
//
// Everything in this module is pure and deterministic: given the same pool, seed,
// topic and offset it always returns the same videos. That is what lets an opaque
// cursor be a stable continuation instead of a guess.
//
// Used by BOTH the Cloudflare Worker (production) and the local Node server so the
// two backends stay in parity.
// =============================================================================

// How long a built pool stays usable. Long enough that every visitor in a busy
// window reuses the same pool (1 unit per region), short enough that the feed
// still moves as YouTube's charts rotate.
const FEED_POOL_TTL_MS = 15 * 60 * 1000;

// Regions for the pool, primary region first. Verified in production: different
// region charts are essentially disjoint sets of videos, so several regions give
// real breadth for 1 quota unit each. The first region keeps the pool in the same
// "what is popular here" shape MyTube showed before this change.
const FEED_POOL_REGIONS = ["PK", "IN", "US", "GB", "SA", "AE", "CA", "AU"];

// One page per region. 50 is the API maximum and costs the same single unit.
const FEED_POOL_PAGE_SIZE = 50;

// Never allow more than this many videos from one channel inside any window of
// FEED_CHANNEL_WINDOW items of a page, so a single channel cannot dominate a
// screenful (the stock chart occasionally does this).
const FEED_MAX_PER_CHANNEL = 3;
const FEED_CHANNEL_WINDOW = 12;

// Topic labels are derived from real `videos.list snippet.tags`, which arrive for
// free with the pool fetch. They are honest derived labels — NOT YouTube's own
// video categories (those come from the search filters in shared/search.js).
const TOPIC_KEYWORDS = [
  ["Music", ["music", "song", "songs", "official video", "audio", "lyrics", "remix", "cover", "band", "singer"]],
  ["Gaming", ["gaming", "gameplay", "gamer", "minecraft", "fortnite", "pubg", "free fire", "gameplayvideo", "gta", "gameplay walkthrough"]],
  ["Sports", ["sports", "football", "cricket", "soccer", "basketball", "match", "highlights", "wrestling", "boxing", "tennis"]],
  ["News", ["news", "breaking news", "politics", "current affairs", "election"]],
  ["Comedy", ["comedy", "funny", "humor", "hilarious", "prank", "fun"]],
  ["Tech", ["tech", "technology", "coding", "programming", "computer", "software", "tutorial tech", "ai", "gadgets"]],
  ["Food", ["food", "cooking", "recipe", "recipes", "food recipe", "bakery", "street food", "mutton", "bbq"]],
  ["Travel", ["travel", "tourism", "vlog", "explore", "destination", "road trip"]],
  ["Education", ["education", "tutorial", "science", "learn", "lecture", "facts", "science and technology", "how to"]],
  ["Entertainment", ["entertainment", "movie", "trailer", "full movie", "episode", "serial", "drama"]],
  ["Automotive", ["car", "cars", "auto", "motorcycle", "bike", "driving", "automotive"]],
  ["Fitness", ["fitness", "workout", "gym", "health", "yoga", "sport"]]
];

const TOPIC_FALLBACK = "Popular";

function hashString(value){
  let hash = 2166136261;

  for(let i = 0; i < value.length; i++){
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

// Small deterministic PRNG. Same seed => same sequence, on every platform.
function mulberry32(seed){
  let state = seed >>> 0;

  return function next(){
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(items, seed){
  const list = items.slice();
  const rand = mulberry32(hashString(String(seed || "")));

  for(let i = list.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }

  return list;
}

// Stable identifier for the current pool, embedded in every cursor as diagnostic
// metadata. Nothing rejects a cursor on a version mismatch: a 15-minute pool
// rebuild mid-scroll is expected, and the browser dedupes ids as it appends, so
// the safe response to a moved pool is to keep serving pages rather than error.
function poolVersion(pool){
  const items = Array.isArray(pool) ? pool : [];
  const first = items[0];
  const last = items[items.length - 1];

  return hashString(
    String(items.length) + ":" + ((first && first.sourceId) || "") + ":" +
    ((last && last.sourceId) || "")
  ).toString(36);
}

// Opaque cursor: base64url of UTF-8 JSON. The client stores and echoes it
// verbatim, so it carries the seed (stable ordering), the offset, the topic filter
// and the pool version without the frontend understanding any of it.
//
// The bytes are always UTF-8 on both sides. `btoa`/`atob` operate on code units
// rather than bytes, so a caller-supplied `seed` containing any character above
// ASCII has to be encoded/decoded through TextEncoder/TextDecoder to round-trip.
// ASCII seeds (what the frontend generates) produce byte-identical cursors either
// way, so cursors stay valid across this change.
function encodeFeedCursor(payload){
  const bytes = new TextEncoder().encode(JSON.stringify(payload || {}));

  let base64;

  if(typeof Buffer === "function"){
    base64 = Buffer.from(bytes).toString("base64");
  }
  else{
    let binary = "";

    for(const byte of bytes){
      binary += String.fromCharCode(byte);
    }

    base64 = btoa(binary);
  }

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeFeedCursor(token){
  if(typeof token !== "string" || !token){
    return null;
  }

  let json = "";

  try{
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");

    // The payload is UTF-8 JSON, so it must be decoded as UTF-8. `atob` alone
    // yields a Latin-1 string, which silently mangles any non-ASCII seed and
    // would reorder the next page instead of continuing it.
    if(typeof Buffer === "function"){
      json = Buffer.from(base64, "base64").toString("utf8");
    }
    else{
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));

      json = new TextDecoder().decode(bytes);
    }
  }
  catch{
    return null;
  }

  let parsed = null;

  try{
    parsed = JSON.parse(json);
  }
  catch{
    return null;
  }

  if(!parsed || typeof parsed !== "object"){
    return null;
  }

  return {
    seed: String(parsed.seed || ""),
    topic: String(parsed.topic || ""),
    offset: Number.isFinite(Number(parsed.offset)) ? Math.max(0, Number(parsed.offset)) : 0,
    version: String(parsed.version || "")
  };
}

// Pick one derived topic label for a video from its real tags (lowercased).
function topicFromTags(tags){
  const list = Array.isArray(tags) ? tags : [];

  for(const [topic, keywords] of TOPIC_KEYWORDS){
    for(const tag of list){
      const value = String(tag || "").toLowerCase().trim();
      if(!value){
        continue;
      }
      for(const keyword of keywords){
        if(value === keyword || value.includes(keyword)){
          return topic;
        }
      }
    }
  }

  return TOPIC_FALLBACK;
}

// Order items so no channel owns too much of any screenful of the feed.
//
// This is a deterministic re-order, never a deletion: every video in the pool is
// still reachable, only the sequence changes. Videos that would break the rule are
// parked and re-inserted later, after the cap frees up.
function diversifyOrder(items, options){
  const list = Array.isArray(items) ? items : [];
  const maxPerChannel = Number(options && options.maxPerChannel) || FEED_MAX_PER_CHANNEL;
  const windowSize = Number(options && options.windowSize) || FEED_CHANNEL_WINDOW;

  const result = [];
  const parked = [];

  const wouldExceed = (channel) => {
    if(!channel){
      return false;
    }

    const cutoff = Math.max(0, result.length - windowSize);
    let count = 0;

    for(let i = result.length - 1; i >= cutoff; i--){
      if(result[i].channel === channel){
        count++;
      }
    }

    return count >= maxPerChannel;
  };

  for(const item of list){
    const channel = (item && item.channel) || "";

    if(wouldExceed(channel)){
      parked.push(item);
      continue;
    }

    result.push(item);
  }

  // Second pass: anything parked goes back in wherever the rule now allows it.
  const leftover = [];

  for(const item of parked){
    if(wouldExceed((item && item.channel) || "")){
      leftover.push(item);
      continue;
    }

    result.push(item);
  }

  // A channel dominating the ENTIRE pool cannot be spaced out any further. Append
  // those in order rather than dropping them, so no real video is ever lost.
  result.push(...leftover);

  return result;
}

// Choose the topic labels that actually occur in this pool, most common first.
// The homepage category bar renders these, so the chips always reflect real data
// instead of a hard-coded list that may match nothing.
function availableTopics(pool){
  const counts = new Map();

  for(const video of Array.isArray(pool) ? pool : []){
    const topic = (video && video.topic) || "";
    if(!topic){
      continue;
    }
    counts.set(topic, (counts.get(topic) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(entry => entry[0]);
}

// Build one feed page out of an already-built pool.
//
// `seed`  ""  -> pool order exactly as collected (deterministic; what the sitemap
//                 generator and any pre-existing caller sees)
//         "x" -> seeded permutation, so every refresh with a fresh seed shows a
//                 different ordering of the same real videos, at zero API cost
//
// `offset` comes from the opaque cursor. Because a seeded ordering is a
// permutation of one fixed list, distinct offsets are guaranteed disjoint.
function buildFeedPage(pool, options){
  const settings = options || {};
  const size = Math.min(Math.max(Number(settings.size) || 12, 1), 50);
  const seed = String(settings.seed || "");
  const topic = String(settings.topic || "");
  const offset = Math.max(0, Number(settings.offset) || 0);

  let items = Array.isArray(pool) ? pool.filter(Boolean) : [];

  if(topic){
    items = items.filter(video => (video.topic || "") === topic);
  }

  const ordered = seed
    ? diversifyOrder(shuffleWithSeed(items, seed))
    : items;

  const slice = ordered.slice(offset, offset + size);
  const nextOffset = offset + slice.length;
  const version = poolVersion(pool);

  return {
    videos: slice,
    nextPageToken: nextOffset < ordered.length
      ? encodeFeedCursor({ seed, topic, offset: nextOffset, version })
      : "",
    // Additive diagnostics. Harmless extra fields; existing consumers ignore them.
    totalAvailable: ordered.length,
    offset,
    nextOffset,
    seeded: Boolean(seed),
    topic,
    poolVersion: version
  };
}

export {
  FEED_POOL_TTL_MS,
  FEED_POOL_REGIONS,
  FEED_POOL_PAGE_SIZE,
  FEED_MAX_PER_CHANNEL,
  FEED_CHANNEL_WINDOW,
  TOPIC_FALLBACK,
  hashString,
  mulberry32,
  shuffleWithSeed,
  poolVersion,
  encodeFeedCursor,
  decodeFeedCursor,
  topicFromTags,
  diversifyOrder,
  availableTopics,
  buildFeedPage
};