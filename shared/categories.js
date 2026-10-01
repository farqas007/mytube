// =============================================================================
// MyTube — YouTube category + option catalogues
// -----------------------------------------------------------------------------
// Static, zero-quota reference data shared by the browser UI and both backends.
//
// The ids in VIDEO_CATEGORIES are YouTube's own official `videoCategoryId`
// taxonomy, the same ids `videoCategories.list` returns. They are kept here
// rather than fetched so the search filter row can render instantly and cost
// nothing; the values sent to YouTube are still validated against
// search.list's numeric contract in shared/search.js.
//
// FEED_TOPICS are the derived homepage labels that can appear on a feed card.
// They come from real `videos.list snippet.tags` (see shared/feed.js) — the
// homepage only renders the topics that actually occur in the current pool.
// =============================================================================

// Official YouTube video categories (id -> display title).
const VIDEO_CATEGORIES = [
  { id: "1", title: "Film & Animation" },
  { id: "2", title: "Autos & Vehicles" },
  { id: "3", title: "Music" },
  { id: "4", title: "Pets & Animals" },
  { id: "5", title: "Sports" },
  { id: "6", title: "Travel & Events" },
  { id: "7", title: "Gaming" },
  { id: "8", title: "People & Blogs" },
  { id: "9", title: "Comedy" },
  { id: "10", title: "Entertainment" },
  { id: "11", title: "News & Politics" },
  { id: "12", title: "Howto & Style" },
  { id: "13", title: "Education" },
  { id: "14", title: "Science & Technology" },
  { id: "15", title: "Nonprofits & Activism" },
  { id: "16", title: "Movies" },
  { id: "17", title: "Anime/Animation" },
  { id: "18", title: "Action/Adventure" },
  { id: "19", title: "Classics" },
  { id: "20", title: "Comedy" },
  { id: "21", title: "Documentary" },
  { id: "22", title: "Drama" },
  { id: "23", title: "Family" },
  { id: "24", title: "Foreign" },
  { id: "25", title: "Horror" },
  { id: "26", title: "Thriller" },
  { id: "27", title: "Shows" },
  { id: "28", title: "Trailers" }
];

function categoryTitle(id){
  const value = String(id || "");
  const match = VIDEO_CATEGORIES.find(entry => entry.id === value);

  return match ? match.title : "";
}

// Sort options offered by the search filter row. Each one is a real
// search.list `order` value.
const SEARCH_ORDER_OPTIONS = [
  { id: "relevance", title: "Relevance" },
  { id: "viewCount", title: "Most viewed" },
  { id: "date", title: "Newest" },
  { id: "rating", title: "Top rated" }
];

const SEARCH_DURATION_OPTIONS = [
  { id: "any", title: "Any length" },
  { id: "short", title: "Under 4 min" },
  { id: "medium", title: "4-20 min" },
  { id: "long", title: "Over 20 min" }
];

const SEARCH_UPLOAD_DATE_OPTIONS = [
  { id: "any", title: "Any time" },
  { id: "hour", title: "Last hour" },
  { id: "day", title: "Today" },
  { id: "week", title: "This week" },
  { id: "month", title: "This month" },
  { id: "year", title: "This year" }
];

// Feed topics that can be derived from real video tags. Kept in sync with the
// keyword table in shared/feed.js.
const FEED_TOPICS = [
  "Popular",
  "Music",
  "Gaming",
  "Sports",
  "News",
  "Comedy",
  "Tech",
  "Food",
  "Travel",
  "Education",
  "Entertainment",
  "Automotive",
  "Fitness"
];

export {
  VIDEO_CATEGORIES,
  categoryTitle,
  SEARCH_ORDER_OPTIONS,
  SEARCH_DURATION_OPTIONS,
  SEARCH_UPLOAD_DATE_OPTIONS,
  FEED_TOPICS
};