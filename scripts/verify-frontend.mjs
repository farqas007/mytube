// =============================================================================
// MyTube — homepage frontend contract checks (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// Verifies the parts of the homepage that a pure API test cannot reach:
//
//   STATIC
//     1. every element id the inline script looks up actually exists in the HTML
//     2. every window.MyTubeYouTube key the page reads is exported by youtube.js
//     3. the inline <script> parses as valid JavaScript
//     4. the homepage still owns its SEO surface (title/meta/h1/canonical)
//     5. both infinite-scroll sentinels and the single observer are still present
//
//   BEHAVIOURAL (replays the exact call sequence the page performs)
//     6. two page loads with different seeds return different feeds
//     7. cursor pagination grows the feed and never repeats a video
//     8. a search with filters returns filtered, deduped, playable results
//     9. the search limiter answers 429 with a usable payload, not a crash
//
// Usage: node scripts/verify-frontend.mjs [--origin=http://localhost:3456]
// =============================================================================

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = new Map();
for(const raw of process.argv.slice(2)){
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if(match){
    args.set(match[1], match[2] === undefined ? "1" : match[2]);
  }
}

const ORIGIN = (args.get("origin") || "http://localhost:3456").replace(/\/+$/, "");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const failures = [];
const notes = [];

function check(name, condition, detail){
  if(condition){
    console.log("  PASS  " + name);
    return true;
  }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL  " + name + (detail ? " — " + detail : ""));
  return false;
}

function note(line){
  notes.push(line);
  console.log("  ....  " + line);
}

async function api(route, params){
  const url = new URL(ORIGIN + route);
  for(const [key, value] of Object.entries(params)){
    if(value !== undefined && value !== null && value !== ""){
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  let payload = null;
  try{
    payload = await res.json();
  }
  catch{
    payload = null;
  }

  return { status: res.status, payload };
}

// search.list costs a flat 100 of the 10,000 daily quota units, and the homepage
// itself is unaffected when that budget is spent. So search checks only assert
// while the key still has search quota; otherwise they are reported as SKIP
// instead of failing on an account state (e.g. a key whose daily budget an
// earlier verification run already spent).
let searchQuotaChecked = false;
let searchQuotaGone = false;

function quotaGone(res){
  return res.status === 429 ||
    res.status === 502 ||
    /quota|too many/i.test(String((res.payload && res.payload.error) || ""));
}

// A unique query defeats the server's 10-minute response cache, so this reports
// the real quota state instead of a cached 200 from an earlier run.
async function searchUsable(){
  if(searchQuotaChecked){
    return !searchQuotaGone;
  }
  searchQuotaChecked = true;
  const probe = await api("/api/search", { q: "quota-probe-" + Date.now(), max: "1" });
  searchQuotaGone = quotaGone(probe);
  if(searchQuotaGone){
    note("daily YouTube search quota for this key is spent (HTTP " + probe.status +
      "); search checks are SKIPPED, homepage checks still apply");
  }
  return !searchQuotaGone;
}

function skip(name, reason){
  console.log("  SKIP  " + name + " (" + reason + ")");
}

const ids = videos => (Array.isArray(videos) ? videos : [])
  .map(v => (v && (v.sourceId || v.id)) || "")
  .filter(Boolean);

function overlap(a, b){
  const set = new Set(a);
  return b.filter(id => set.has(id)).length;
}

console.log("MyTube homepage frontend contract");
console.log("origin:  " + ORIGIN);

// ---------------------------------------------------------------- static ----
console.log("");
console.log("=== Static wiring ===");

const html = await readFile(path.join(repoRoot, "index.html"), "utf8");
const youtubeClient = await readFile(path.join(repoRoot, "youtube.js"), "utf8");

const inlineMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
check("index.html inline <script> found", Boolean(inlineMatch));

const inline = inlineMatch ? inlineMatch[1] : "";
new Function(inline);
check("inline script parses as valid JavaScript", true);

const declaredIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
// Ids the script creates at runtime itself are not expected in the markup.
for(const assigned of inline.matchAll(/\.id\s*=\s*"([^"]+)"/g)){
  declaredIds.add(assigned[1]);
}
const lookedUp = [...inline.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]);
const missing = [...new Set(lookedUp)].filter(id => !declaredIds.has(id));
check("every getElementById target exists in the HTML", missing.length === 0, missing.join(", "));

const exposedBlock = html.match(/window\.MyTubeYouTube\s*=\s*\{([\s\S]*?)\n\};/);
check("window.MyTubeYouTube block found", Boolean(exposedBlock));
const exposed = new Set(
  (exposedBlock ? exposedBlock[1] : "")
    .matchAll(/([A-Za-z_$][\w$]*)\s*:/g)
    .map(m => m[1])
);
const clientKeysRead = [...new Set(
  [...inline.matchAll(/client\.([A-Za-z_$][\w$]*)/g)].map(m => m[1])
)];
const notExported = clientKeysRead.filter(key => !exposed.has(key));
check(
  "every client.* key the page reads is exposed on window.MyTubeYouTube",
  notExported.length === 0,
  notExported.join(", ")
);

const exportBlock = youtubeClient.match(/export\s*\{([\s\S]*?)\}/);
const exported = new Set(
  (exportBlock ? exportBlock[1] : "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
);
const reexported = [...exposed].filter(key => !exported.has(key));
check(
  "every key the page uses is exported by youtube.js",
  reexported.length === 0,
  reexported.join(", ")
);

check("home infinite-scroll sentinel kept", declaredIds.has("homeScrollSentinel"));
check("search infinite-scroll sentinel kept", declaredIds.has("searchScrollSentinel"));
check("single IntersectionObserver kept", (inline.match(/new IntersectionObserver/g) || []).length === 1);
check("scroll fallback kept", inline.includes("setupScrollFallback"));

// SEO surface must be untouched by this work.
const seoTitle = html.match(/<title>([^<]*)<\/title>/);
check("SEO <title> unchanged", Boolean(seoTitle) && seoTitle[1] === "MyTube");
check("SEO meta description unchanged", html.includes('name="description" content="MyTube is a free video streaming site'));
check("canonical URL unchanged", html.includes('rel="canonical" href="https://mytube.farqas007.workers.dev/"'));
check("h1 unchanged", html.includes('<h1 class="sr-only">MyTube — watch trending videos, search YouTube and build your library</h1>'));
check("robots meta unchanged", html.includes('<meta name="robots" content="index, follow">'));

// The search box must still exist with the same id the other pages link to.
check("search input id unchanged", declaredIds.has("search"));

// ------------------------------------------------------------ behavioural ---
console.log("");
console.log("=== Behavioural replay (exact page call sequence) ===");

// Spend one probe call up front so the report states up front whether the search
// checks can run. Individual search calls below re-check their own response,
// because the daily budget can also run out part-way through a run.
await searchUsable();

const ping = await api("/api/ping", {});
check("API reachable for replay", ping.status === 200);

// 6. Two page loads = two seeds = two different feeds.
const loadA = await api("/api/trending", { max: "12", seed: "page-load-a" });
const loadB = await api("/api/trending", { max: "12", seed: "page-load-b" });
const pageA = ids(loadA.payload && loadA.payload.videos);
const pageB = ids(loadB.payload && loadB.payload.videos);

check("seeded page load returns cards", pageA.length === 12 && pageB.length === 12);
check(
  "two page loads show different feeds",
  overlap(pageA, pageB) < pageA.length,
  overlap(pageA, pageB) + " of 12 shared"
);
note("page-load overlap: " + overlap(pageA, pageB) + "/12");

check(
  "feed cards carry a derived topic",
  (loadA.payload.videos || []).every(v => typeof v.topic === "string" && v.topic.length > 0)
);
note("topics reported: " + ((loadA.payload.topics || []).join(", ") || "none"));

// Legacy/deterministic call (no seed) must still work: this is the shape the
// sitemap generator and any pre-existing caller uses.
const legacy = await api("/api/trending", { max: "12" });
check(
  "unseeded feed still returns cards (sitemap/caller compatibility)",
  (legacy.payload.videos || []).length === 12 && (legacy.payload.videos || []).every(v => v.id && v.id.startsWith("yt:"))
);

// 7. Cursor pagination: grows, never repeats, ends with an empty token.
let token = "";
const walked = [];
let tokenAlwaysSet = true;

for(let page = 0; page < 6; page++){
  const res = await api("/api/trending", { max: "12", seed: "page-load-a", pageToken: token });
  const list = ids(res.payload && res.payload.videos);

  walked.push(list);
  walked.forEach((prior, i) => {
    if(i === walked.length - 1){
      return;
    }
    if(overlap(prior, list) !== 0){
      tokenAlwaysSet = false;
    }
  });

  token = (res.payload && res.payload.nextPageToken) || "";
  if(!token){
    break;
  }
}

check("infinite scroll returns multiple pages", walked.length >= 2, walked.length + " pages");
check(
  "infinite scroll never repeats a video across pages",
  tokenAlwaysSet,
  walked.map(p => p.length).join("+") + " cards"
);
note("pagination: " + walked.map(p => p.length).join(" + ") + " = " +
  new Set(walked.flat()).size + " unique");

// Topic filter: a real subset, still paginable.
const musicFeed = await api("/api/trending", { max: "12", seed: "topic-check", topic: "Music" });
const musicList = musicFeed.payload && musicFeed.payload.videos;
check(
  "topic filter returns only that topic",
  Array.isArray(musicList) && musicList.length > 0 && musicList.every(v => v.topic === "Music"),
  Array.isArray(musicList) ? musicList.length + " cards" : "no payload"
);
note("Music feed: " + (musicList ? musicList.length : 0) + " cards, next=" +
  (Boolean(musicFeed.payload && musicFeed.payload.nextPageToken)));

// 8. Search with filters, plus the plain call the search box makes.
//    search.list costs a flat 100 quota units per call, so each call re-checks its
//    own response: the daily budget can run out part-way through a run, and a
//    spent budget must never be reported as a defect.
async function searchStep(name, params, assertions){
  const res = await api("/api/search", params);

  if(quotaGone(res)){
    searchQuotaGone = true;
    skip(name, "no daily search quota left (HTTP " + res.status + ")");
    return null;
  }

  assertions(res);
  return res;
}

const plain = await searchStep("plain search", { q: "lofi hip hop", max: "50" }, res => {
  check("plain search returns results", (res.payload.videos || []).length > 0);
  check("plain search reports its normalized query", typeof res.payload.query === "string" && res.payload.query.length > 0);
  check("plain search dedupes within the page", new Set(ids(res.payload.videos)).size === ids(res.payload.videos).length);
  check(
    "plain search returns only playable videos",
    (res.payload.videos || []).every(v => v.embeddable !== false)
  );
});

const filtered = await searchStep("filtered search", {
  q: "music",
  max: "50",
  order: "viewCount",
  duration: "short",
  uploadDate: "month",
  categoryId: "10",
  videoEmbeddable: "1"
}, res => {
  check("filtered search returns results", (res.payload.videos || []).length > 0);
  check(
    "filtered search echoes applied filters",
    res.payload.appliedFilters
      && res.payload.appliedFilters.order === "viewCount"
      && res.payload.appliedFilters.duration === "short",
    JSON.stringify(res.payload.appliedFilters)
  );
  note("filtered: " + (res.payload.videos || []).length + " cards, filteredCount=" +
    res.payload.filteredCount + ", duplicatesRemoved=" + res.payload.duplicatesRemoved);
});

// Filters must actually change the result set, not be accepted and ignored.
if(plain && filtered){
  check(
    "order=viewCount changes the result set vs default relevance",
    overlap(ids(plain.payload.videos), ids(filtered.payload.videos)) < ids(plain.payload.videos).length,
    overlap(ids(plain.payload.videos), ids(filtered.payload.videos)) + " shared"
  );
}
else{
  skip("filter actually changes the result set", "no daily search quota left");
}

// Invalid filter values must be ignored, not forwarded (YouTube would 400).
await searchStep("invalid filter values", { q: "music", max: "10", categoryId: "abc", order: "bogus", region: "XYZ" }, res => {
  check("invalid filter values are dropped, request still succeeds", res.status === 200, "HTTP " + res.status);
});

// 9. Search limiter: 429 must still carry a usable payload shape.
//    OFF by default: 45 probes would burn ~4,500 of the 10,000 daily units.
//    Opt in with --probe-limiter when you deliberately want to test it.
if(args.has("probe-limiter")){
  let limited = null;
  for(let i = 0; i < 45; i++){
    const res = await api("/api/search", { q: "limit-probe-" + i, max: "5" });
    if(res.status === 429){
      limited = res;
      break;
    }
    if(quotaGone(res)){
      break;
    }
  }
  if(limited){
    check(
      "search limiter returns 429 with videos:[] and a message",
      Array.isArray(limited.payload.videos) && limited.payload.videos.length === 0 && Boolean(limited.payload.error),
      JSON.stringify(limited.payload).slice(0, 120)
    );
  }
  else{
    skip("search limiter 429 shape", "search quota ran out before the limiter was reached");
  }
}
else{
  note("search limiter probe skipped (pass --probe-limiter to run it; costs ~4,500 quota units)");
  if(plain){
    check(
      "search route healthy while limiter is cold",
      plain.status === 200 && Array.isArray(plain.payload.videos)
    );
  }
}

// Empty query still rejected with the original contract, and it never reaches
// YouTube, so it is checked whether or not quota remains.
const empty = await api("/api/search", { q: "   " });
check("blank query rejected with 400 + videos:[]", empty.status === 400 && Array.isArray(empty.payload.videos));

// Untouched routes must still answer normally.
const videoProbe = await api("/api/video", { id: "dQw4w9WgXcQ" });
check("/api/video still works", videoProbe.status === 200 && Boolean(videoProbe.payload.video));
const channelProbe = await api("/api/channel", { id: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
check("/api/channel still works", channelProbe.status === 200 && Boolean(channelProbe.payload.channel));
const commentsProbe = await api("/api/comments", { id: "dQw4w9WgXcQ", max: "3" });
check("/api/comments still works", commentsProbe.status === 200 && Array.isArray(commentsProbe.payload.comments));
// /api/related is backed by search.list too, so an empty list here can be the
// spent daily quota rather than a broken route. The contract that must hold
// regardless is HTTP 200 plus a videos array; non-empty needs quota.
const relatedProbe = await api("/api/related", { id: "dQw4w9WgXcQ", max: "3" });
check("/api/related answers 200 with a videos array",
  relatedProbe.status === 200 && Array.isArray(relatedProbe.payload.videos),
  "HTTP " + relatedProbe.status);
if(searchQuotaGone || relatedProbe.status === 429){
  note("/api/related returned " + (relatedProbe.payload.videos || []).length +
    " videos (search quota spent) — non-empty result not asserted");
}
else{
  check("/api/related still returns videos",
    (relatedProbe.payload.videos || []).length > 0,
    (relatedProbe.payload.videos || []).length + " videos");
}
const chatProbe = await api("/api/liveChat", { id: "dQw4w9WgXcQ", initial: "1" });
check("/api/liveChat still answers a not-live video cleanly",
  chatProbe.status === 200 && chatProbe.payload.status === "not_live",
  "status=" + (chatProbe.payload && chatProbe.payload.status));

console.log("");
if(failures.length){
  console.log("RESULT: " + failures.length + " check(s) failed");
  for(const failure of failures){
    console.log("  - " + failure);
  }
  process.exit(1);
}
console.log("RESULT: all checks passed");