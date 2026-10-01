// =============================================================================
// MyTube — feed / search verification harness (dev-only, zero dependencies)
//
// -----------------------------------------------------------------------------
// Measures the *actual* behaviour of a MyTube API backend (production Worker by
// default, or a local `node youtube-server/server.js`) so feed/search changes can
// be judged on numbers instead of impressions.
//
// What it measures
//   HOMEPAGE FEED
//     poolSize        distinct videos reachable by paginating the whole feed
//     refreshDistinct distinct videos seen across N simulated refreshes
//     repeatPctFirst  % of first-page cards that were already shown in an
//                     earlier refresh (lower is better; 100% == static feed)
//     meanOverlapPct  mean pairwise first-page overlap between refreshes
//     dupWithinPage   duplicate video ids inside a single page (want 0)
//     pageDisjoint    intersection between consecutive pages (want 0)
//     channelConcen   largest single-channel share of a page (lower is better)
//     topicSpread     distinct topic labels in one page (more == more diverse)
//
//   SEARCH
//     firstPage       results in page 1
//     distinctChannels/ topChannel in page 1 (channel concentration)
//     dupesAcrossPages duplicates between consecutive pages (want 0)
//     embeddablePct   % of results that MyTube can actually embed/play
//     nextPage        whether pagination continued
//     filters         whether the filter params changed the returned ordering
//
// Usage
//   node scripts/verify-feed.mjs
//   node scripts/verify-feed.mjs --origin=http://localhost:3456
//   node scripts/verify-feed.mjs --seeded            (passes seed= per refresh)
//   node scripts/verify-feed.mjs --refreshes=8 --query="lofi hip hop" --json
//   node scripts/verify-feed.mjs --skip-search        (feed only, 0 quota spent
//                                                      on search.list calls)
//
// Safety contract: read-only. It only issues GET requests against the API and
// never writes files, never mutates Firestore and never touches the sitemap.
// =============================================================================

const args = new Map();

for(const raw of process.argv.slice(2)){
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if(!match){
    continue;
  }
  args.set(match[1], match[2] === undefined ? "1" : match[2]);
}

const ORIGIN = (args.get("origin") || "https://mytube.farqas007.workers.dev").replace(/\/+$/, "");
const REFRESHES = Math.min(Math.max(parseInt(args.get("refreshes") || "8", 10) || 8, 2), 30);
const PAGE_SIZE = Math.min(Math.max(parseInt(args.get("page-size") || "12", 10) || 12, 1), 50);
const MAX_PAGES = Math.min(Math.max(parseInt(args.get("max-pages") || "12", 10) || 12, 1), 40);
const QUERY = args.get("query") || "web dev tutorial";
const FILTER_QUERY = args.get("filter-query") || "music";
const SEEDED = args.get("seeded") === "1";
const SKIP_SEARCH = args.has("skip-search");
const AS_JSON = args.get("json") === "1";
const REQUEST_TIMEOUT_MS = 30000;

function log(line){
  if(!AS_JSON){
    console.log(line);
  }
}

async function api(route, params){
  const url = new URL(ORIGIN + route);

  for(const [key, value] of Object.entries(params)){
    if(value !== undefined && value !== null && value !== ""){
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try{
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });

    let payload = null;
    try{
      payload = await res.json();
    }
    catch{
      payload = null;
    }

    return { status: res.status, payload };
  }
  finally{
    clearTimeout(timer);
  }
}

function ids(videos){
  return (Array.isArray(videos) ? videos : [])
    .map(v => (v && (v.sourceId || v.id)) || "")
    .filter(Boolean);
}

function overlap(a, b){
  const set = new Set(a);
  let count = 0;
  for(const id of b){
    if(set.has(id)){
      count++;
    }
  }
  return count;
}

function channelCounts(videos){
  const counts = new Map();

  for(const video of videos || []){
    const channel = (video && video.channel) || "";
    counts.set(channel, (counts.get(channel) || 0) + 1);
  }

  return counts;
}

function topChannelCount(videos){
  const counts = channelCounts(videos);
  let top = 0;
  for(const value of counts.values()){
    if(value > top){
      top = value;
    }
  }

  return top;
}

// Share of the page taken by its most frequent channel. The raw count is what
// makes the percentage readable, so it is reported alongside it — a ratio on its
// own invites off-by-one readings (1/12 is 8.3%, 2/12 is 16.7%).
function topChannelShare(videos){
  if(!videos || !videos.length){
    return 0;
  }

  return topChannelCount(videos) / videos.length;
}

function embeddablePct(videos){
  const list = videos || [];
  if(!list.length){
    return null;
  }

  const ok = list.filter(v => v && v.embeddable !== false).length;
  return ok / list.length;
}

function topicOf(video){
  return (video && (video.topic || video.category || "")) || "";
}

function meanOverlapPct(pages){
  if(pages.length < 2){
    return null;
  }

  let total = 0;
  let pairs = 0;

  for(let i = 0; i < pages.length; i++){
    for(let j = i + 1; j < pages.length; j++){
      const size = Math.min(pages[i].length, pages[j].length) || 1;
      total += overlap(pages[i], pages[j]) / size;
      pairs++;
    }
  }

  return pairs ? total / pairs : null;
}

function pct(value){
  if(value === null || value === undefined || !Number.isFinite(value)){
    return "n/a";
  }
  return (value * 100).toFixed(1) + "%";
}

function num(value){
  if(value === null || value === undefined || !Number.isFinite(value)){
    return "n/a";
  }
  return String(value);
}

function section(title){
  log("");
  log("=== " + title + " ===");
}

function row(label, value){
  log("  " + label.padEnd(22, ".") + " " + value);
}

// -----------------------------------------------------------------------------
// Homepage feed
// -----------------------------------------------------------------------------
async function measureFeed(){
  const refreshes = [];
  // Concentration is measured on the cards a visitor actually sees (PAGE_SIZE),
  // not on the oversized walk pages used to size the pool.
  let userPageChannelShare = 0;
  let userPageTopChannelCount = 0;
  let userPageCards = 0;
  let userPageTopicSpread = 0;

  for(let i = 0; i < REFRESHES; i++){
    const params = { max: PAGE_SIZE };
    if(SEEDED){
      params.seed = "verify-" + i;
    }

    const { status, payload } = await api("/api/trending", params);
    const list = ids(payload && payload.videos);
    const videos = (payload && payload.videos) || [];
    const topics = new Set();

    for(const video of videos){
      const topic = topicOf(video);
      if(topic){
        topics.add(topic);
      }
    }

    const share = topChannelShare(videos);
    if(share > userPageChannelShare){
      userPageChannelShare = share;
      userPageTopChannelCount = topChannelCount(videos);
      userPageCards = videos.length;
    }
    userPageTopicSpread = Math.max(userPageTopicSpread, topics.size);

    refreshes.push(list);
    log("  refresh " + (i + 1) + ": HTTP " + status + ", " + list.length + " cards" +
      (payload && payload.error ? ", error=" + payload.error : ""));
  }

  const pool = new Set();
  for(const page of refreshes){
    for(const id of page){
      pool.add(id);
    }
  }

  // Repeat rate: how many first-page cards were already shown in an earlier
  // refresh. 100% means every refresh showed exactly the same first page.
  let repeated = 0;
  let compared = 0;
  const seen = new Set();

  for(const page of refreshes){
    for(const id of page){
      compared++;
      if(seen.has(id)){
        repeated++;
      }
      seen.add(id);
    }
  }

  // Full pagination walk: pool size, duplicate rate, page disjointness.
  const pageSlices = [];
  let dupWithinPage = 0;
  let walkChannelShare = 0;
  let cursor = "";

  for(let page = 0; page < MAX_PAGES; page++){
    const params = { max: 50 };
    if(SEEDED){
      params.seed = "verify-walk";
    }
    if(cursor){
      params.pageToken = cursor;
    }

    const { payload } = await api("/api/trending", params);
    const list = ids(payload && payload.videos);

    pageSlices.push(list);
    dupWithinPage += list.length - new Set(list).size;
    walkChannelShare = Math.max(walkChannelShare, topChannelShare(payload && payload.videos));

    cursor = (payload && payload.nextPageToken) || "";
    if(!cursor){
      break;
    }
  }

  let pageOverlap = 0;
  for(let i = 1; i < pageSlices.length; i++){
    pageOverlap += overlap(pageSlices[i - 1], pageSlices[i]);
  }

  const allWalked = pageSlices.flat();
  const pagesWalked = pageSlices.length;

  return {
    refreshes: REFRESHES,
    pageSize: PAGE_SIZE,
    seeded: SEEDED,
    cardsPerRefresh: refreshes.map(list => list.length),
    refreshDistinct: pool.size,
    repeatPctFirst: compared ? repeated / compared : null,
    meanOverlapPct: meanOverlapPct(refreshes),
    pagesWalked,
    poolSize: new Set(allWalked).size,
    walkedTotal: allWalked.length,
    dupWithinPage,
    pageOverlap,
    maxChannelShare: userPageChannelShare,
    maxChannelTopCount: userPageTopChannelCount,
    maxChannelPageCards: userPageCards,
    walkChannelShare,
    topicSpread: userPageTopicSpread
  };
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------
async function measureSearch(query, extraParams){
  const first = await api("/api/search", Object.assign({ q: query, max: 50 }, extraParams || {}));
  const videos = (first.payload && first.payload.videos) || [];
  const list = ids(videos);

  const counts = channelCounts(videos);
  let topChannel = "";
  let topCount = 0;
  for(const [channel, count] of counts){
    if(count > topCount){
      topCount = count;
      topChannel = channel;
    }
  }

  const second = first.payload && first.payload.nextPageToken
    ? await api("/api/search", Object.assign(
        { q: query, max: 50, pageToken: first.payload.nextPageToken },
        extraParams || {}
      ))
    : { payload: null };

  const secondList = ids(second.payload && second.payload.videos);

  return {
    status: first.status,
    error: (first.payload && first.payload.error) || "",
    firstPage: list.length,
    distinctChannels: counts.size,
    topChannel,
    topChannelCount: topCount,
    topChannelShare: topChannelShare(videos),
    dupesAcrossPages: overlap(list, secondList),
    secondPageSize: secondList.length,
    embeddablePct: embeddablePct(videos),
    nextPage: Boolean(first.payload && first.payload.nextPageToken),
    filters: (first.payload && first.payload.appliedFilters) || null,
    normalizedQuery: (first.payload && first.payload.query) || null,
    filteredCount: (first.payload && first.payload.filteredCount) ?? null
  };
}

async function main(){
  log("MyTube feed/search verification");
  log("origin:  " + ORIGIN);
  log("mode:    " + (SEEDED ? "seeded (per-refresh seed)" : "no seed (legacy/deterministic)"));

  const ping = await api("/api/ping", {});
  log("ping:    HTTP " + ping.status + " " + JSON.stringify(ping.payload));
  if(ping.status !== 200){
    throw new Error("API not reachable at " + ORIGIN);
  }

  section("Homepage feed");
  const feed = await measureFeed();

  row("page size", String(feed.pageSize));
  row("cards/refresh", feed.cardsPerRefresh.join(", "));
  row("pool size", num(feed.poolSize) + " (walked " + num(feed.walkedTotal) + " over " + feed.pagesWalked + " pages)");
  row("refreshDistinct", num(feed.refreshDistinct) + " / " + feed.refreshes + " refreshes");
  row("repeatPctFirst", pct(feed.repeatPctFirst) + "  (lower is better)");
  row("meanOverlapPct", pct(feed.meanOverlapPct) + "  (lower is better)");
  row("dupWithinPage", num(feed.dupWithinPage) + "  (want 0)");
  row("pageOverlap", num(feed.pageOverlap) + "  (want 0)");
  row("maxChannelShare", pct(feed.maxChannelShare) + "  (top channel held " +
    num(feed.maxChannelTopCount) + " of " + num(feed.maxChannelPageCards) +
    " cards; lower is better)");
  row("topicSpread", num(feed.topicSpread) + " topics in one page (more is better)");

  section("Search" + (SKIP_SEARCH ? " SKIPPED (--skip-search)" : ""));
  let search = null;

  if(SKIP_SEARCH){
    log("skipped: search.list spends 100 quota units per call and the feed numbers");
    log("above are the subject of this run.");
  }
  else{
    log("");
    log("--- '" + QUERY + "' (no filters)");
    const plain = await measureSearch(QUERY);
    row("HTTP", String(plain.status));
    row("firstPage", num(plain.firstPage));
    row("distinctChannels", num(plain.distinctChannels));
    row("topChannel", plain.topChannel + " x" + plain.topChannelCount + " (" + pct(plain.topChannelShare) + ")");
    row("dupesAcrossPages", num(plain.dupesAcrossPages) + "  (want 0)");
    row("embeddablePct", pct(plain.embeddablePct));
    row("nextPage", String(plain.nextPage));
    row("normalizedQuery", plain.normalizedQuery === null ? "n/a" : JSON.stringify(plain.normalizedQuery));

    log("");
    log("--- '" + FILTER_QUERY + "' (with filters)");
    const filtered = await measureSearch(FILTER_QUERY, {
      order: "viewCount",
      duration: "short",
      uploadDate: "month",
      categoryId: "10",
      videoEmbeddable: "1"
    });
    row("HTTP", String(filtered.status));
    row("firstPage", num(filtered.firstPage));
    row("distinctChannels", num(filtered.distinctChannels));
    row("topChannel", filtered.topChannel + " x" + filtered.topChannelCount + " (" + pct(filtered.topChannelShare) + ")");
    row("dupesAcrossPages", num(filtered.dupesAcrossPages) + "  (want 0)");
    row("embeddablePct", pct(filtered.embeddablePct));
    row("filteredCount", num(filtered.filteredCount));
    row("filters", filtered.filters ? JSON.stringify(filtered.filters) : "n/a (route ignores filters)");
    row("error", filtered.error || "-");

    search = { plain, filtered };
  }

  const report = { origin: ORIGIN, mode: SEEDED ? "seeded" : "unseeded", feed, search };

  log("");
  if(AS_JSON){
    console.log(JSON.stringify(report, null, 2));
  }
  else{
    log("RESULT_JSON " + JSON.stringify(report));
  }
}

main().catch(error => {
  console.error("verify-feed failed:", error && error.message ? error.message : error);
  process.exit(1);
});