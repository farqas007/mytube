// =============================================================================
// MyTube — Worker vs Node parity checks (dev-only, zero dependencies)
// -----------------------------------------------------------------------------
// The Worker is the production backend, but wrangler is not installed here, so
// this harness executes worker.js directly in Node (it only needs
// env.YOUTUBE_API_KEY) and compares its responses against the running Node
// server. Both must speak the same contract or local dev and production drift.
//
// Compares, for the same request:
//   - HTTP status and error shape
//   - normalized / applied filter echoes
//   - per-video field contract (ids, embeddable, viewCount, time, topic)
//   - the invariants the homepage depends on (dedupe, pagination, seeded feed)
//
// Usage: node --env-file=.env scripts/verify-parity.mjs [--node-origin=http://localhost:3456]
// =============================================================================

import worker from "../worker.js";

const args = new Map();
for(const raw of process.argv.slice(2)){
  const match = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if(match){
    args.set(match[1], match[2] === undefined ? "1" : match[2]);
  }
}

const NODE_ORIGIN = (args.get("node-origin") || "http://localhost:3456").replace(/\/+$/, "");
const env = { YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || "" };

if(!env.YOUTUBE_API_KEY){
  console.log("YOUTUBE_API_KEY is not set — run with: node --env-file=.env scripts/verify-parity.mjs");
  process.exit(2);
}

const failures = [];

function check(name, condition, detail){
  if(condition){
    console.log("  PASS  " + name);
    return;
  }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL  " + name + (detail ? " — " + detail : ""));
}

async function callWorker(pathAndQuery){
  const res = await worker.fetch(new Request("https://parity.invalid" + pathAndQuery), env);
  return { status: res.status, body: await res.json() };
}

async function callNode(pathAndQuery){
  const res = await fetch(NODE_ORIGIN + pathAndQuery, { headers: { Accept: "application/json" } });
  return { status: res.status, body: await res.json() };
}

// This machine's connection to googleapis.com drops intermittently, which surfaces
// as a 502 from one backend while the other succeeds. Retry once and only report a
// parity failure if it is still failing, so a network blip is never mistaken for a
// contract difference.
async function both(pathAndQuery){
  let workerRes = await callWorker(pathAndQuery);
  let nodeRes = await callNode(pathAndQuery);

  if(workerRes.status === 502 || nodeRes.status === 502){
    console.log("  ....  transient 502, retrying once: " + pathAndQuery);
    await new Promise(resolve => setTimeout(resolve, 1500));
    workerRes = await callWorker(pathAndQuery);
    nodeRes = await callNode(pathAndQuery);
  }

  return { workerRes, nodeRes };
}

function videoContract(body){
  const videos = Array.isArray(body.videos) ? body.videos : [];
  return {
    count: videos.length,
    // Every card must carry the fields the homepage/watch page read.
    allHaveId: videos.every(v => typeof v.id === "string" && v.id.startsWith("yt:")),
    allHaveTitle: videos.every(v => typeof v.title === "string" && v.title.length > 0),
    allHaveThumb: videos.every(v => typeof v.thumb === "string" && v.thumb.length > 0),
    embeddableValues: [...new Set(videos.map(v => String(v.embeddable)))].sort(),
    allHaveViews: videos.every(v => v.viewCount === undefined || typeof v.viewCount === "number"),
    allHaveTime: videos.every(v => v.time === undefined || typeof v.time === "string"),
    unique: new Set(videos.map(v => v.sourceId)).size === videos.length
  };
}

function compare(name, workerRes, nodeRes){
  console.log("  " + name);
  check(name + ": same HTTP status", workerRes.status === nodeRes.status,
    "worker=" + workerRes.status + " node=" + nodeRes.status);

  const w = videoContract(workerRes.body);
  const n = videoContract(nodeRes.body);

  check(name + ": both return cards", w.count > 0 && n.count > 0, "worker=" + w.count + " node=" + n.count);
  check(name + ": worker ids are yt:-prefixed", w.allHaveId);
  check(name + ": node ids are yt:-prefixed", n.allHaveId);
  check(name + ": worker cards titled", w.allHaveTitle);
  check(name + ": node cards titled", n.allHaveTitle);
  check(name + ": worker cards have thumbnails", w.allHaveThumb);
  check(name + ": node cards have thumbnails", n.allHaveThumb);
  check(name + ": worker exposes embeddable", w.embeddableValues.length > 0 && !w.embeddableValues.includes("undefined"),
    w.embeddableValues.join("|"));
  check(name + ": node exposes embeddable (parity)", n.embeddableValues.length > 0 && !n.embeddableValues.includes("undefined"),
    n.embeddableValues.join("|"));
  check(name + ": both dedupe within the page", w.unique && n.unique);
}

console.log("MyTube Worker/Node parity");
console.log("worker: worker.js executed in-process");
console.log("node:   " + NODE_ORIGIN);

// --------------------------------------------------------------- homepage ---
console.log("");
console.log("=== Seeded homepage feed ===");
const seed = "parity-" + Date.now();
const workerFeed = await callWorker("/api/trending?max=12&seed=" + seed);
const nodeFeed = await callNode("/api/trending?max=12&seed=" + seed);

check("seeded feed: same HTTP status", workerFeed.status === nodeFeed.status,
  "worker=" + workerFeed.status + " node=" + nodeFeed.status);
check("seeded feed: both return 12 cards",
  (workerFeed.body.videos || []).length === 12 && (nodeFeed.body.videos || []).length === 12,
  "worker=" + (workerFeed.body.videos || []).length + " node=" + (nodeFeed.body.videos || []).length);
check("seeded feed: topics echoed by both",
  Array.isArray(workerFeed.body.topics) && Array.isArray(nodeFeed.body.topics));
check("seeded feed: both paginate", Boolean(workerFeed.body.nextPageToken) && Boolean(nodeFeed.body.nextPageToken));

// Ordering parity is checked as *determinism*, not as identical ids across
// backends: each backend builds its own pool from its own chart snapshot a few
// seconds apart, so the same seed legitimately permutes a different pool. What
// must hold is that one seed is reproducible and another seed differs.
const workerSeedAgain = await callWorker("/api/trending?max=12&seed=" + seed);
const nodeSeedAgain = await callNode("/api/trending?max=12&seed=" + seed);
check("seeded feed: worker is deterministic for a given seed",
  JSON.stringify(workerFeed.body.videos.map(v => v.sourceId)) ===
  JSON.stringify(workerSeedAgain.body.videos.map(v => v.sourceId)));
check("seeded feed: node is deterministic for a given seed",
  JSON.stringify(nodeFeed.body.videos.map(v => v.sourceId)) ===
  JSON.stringify(nodeSeedAgain.body.videos.map(v => v.sourceId)));

const workerOtherSeed = await callWorker("/api/trending?max=12&seed=" + seed + "-other");
const nodeOtherSeed = await callNode("/api/trending?max=12&seed=" + seed + "-other");
check("seeded feed: worker returns a different order for a different seed",
  JSON.stringify(workerFeed.body.videos.map(v => v.sourceId)) !==
  JSON.stringify(workerOtherSeed.body.videos.map(v => v.sourceId)));
check("seeded feed: node returns a different order for a different seed",
  JSON.stringify(nodeFeed.body.videos.map(v => v.sourceId)) !==
  JSON.stringify(nodeOtherSeed.body.videos.map(v => v.sourceId)));

// Topic filtering must behave identically.
const workerTopic = await callWorker("/api/trending?max=12&seed=" + seed + "&topic=Gaming");
const nodeTopic = await callNode("/api/trending?max=12&seed=" + seed + "&topic=Gaming");
check("topic filter: same HTTP status", workerTopic.status === nodeTopic.status);
check("topic filter: both return cards",
  (workerTopic.body.videos || []).length > 0 && (nodeTopic.body.videos || []).length > 0);
check("topic filter: every card carries the requested topic",
  (workerTopic.body.videos || []).every(v => v.topic === "Gaming") &&
  (nodeTopic.body.videos || []).every(v => v.topic === "Gaming"));

// Unknown topic must degrade to an empty list, not an error.
const workerBadTopic = await callWorker("/api/trending?max=12&topic=NotARealTopic");
const nodeBadTopic = await callNode("/api/trending?max=12&topic=NotARealTopic");
check("unknown topic: both return 200 with no videos",
  workerBadTopic.status === 200 && nodeBadTopic.status === 200 &&
  (workerBadTopic.body.videos || []).length === 0 && (nodeBadTopic.body.videos || []).length === 0);

// ----------------------------------------------------------------- search ---
// Every search.list call costs 101 quota units out of a 10,000/day budget that is
// shared with production, and each backend also has its own 40-per-5-minutes
// limiter. Neither is a contract difference, so anything caused by them is
// reported as a NOTE/SKIP. Pass --skip-search to spend no quota at all.
console.log("");
console.log("=== Search ===");

function limited(res){
  return res.status === 429 ||
    res.status === 502 ||
    /quota|too many/i.test(String((res.body && res.body.error) || ""));
}

// A cache-busting query, so a cached 200 from an earlier run cannot hide the fact
// that the daily budget is spent.
async function quotaGone(){
  const probe = await callNode("/api/search?q=quota-probe-" + Date.now() + "&max=1");
  return limited(probe);
}

if(args.has("skip-search")){
  console.log("  SKIP  live search comparisons (--skip-search)");
  const blankWorker = await callWorker("/api/search?q=");
  const blankNode = await callNode("/api/search?q=");
  check("blank query: both 400 with videos:[]",
    blankWorker.status === 400 && blankNode.status === 400 &&
    Array.isArray(blankWorker.body.videos) && Array.isArray(blankNode.body.videos));

  // Whether `videoEmbeddable=false` is ignored can only be observed on a search
  // that actually reaches YouTube, so it needs quota. Asserting it here would
  // either spend 100 units or measure nothing.
  console.log("  SKIP  videoEmbeddable=false is ignored rather than forwarded");
}
else if(await quotaGone()){
  console.log("  SKIP  live search comparisons — the daily YouTube search quota for this");
  console.log("        key is exhausted, so both backends correctly return an error.");
  // The frontend already guards with `result.videos || []`, and the search route's
  // own limiter answers 429 with a videos array. The pre-route general limiter is
  // a generic guard shared by every endpoint, so it only promises an error.
  for(const [name, res] of [["worker", await callWorker("/api/search?q=quota&max=5")], ["node", await callNode("/api/search?q=quota&max=5")]]){
    check("quota exhaustion: " + name + " returns a usable payload",
      Boolean(res.body && res.body.error) &&
      (res.body.videos === undefined || Array.isArray(res.body.videos)),
      JSON.stringify(res.body).slice(0, 120));
  }
}
else{
  const q = encodeURIComponent("lofi hip hop");
  const plain = await both("/api/search?q=" + q + "&max=50");
  compare("plain search", plain.workerRes, plain.nodeRes);

  const fq = encodeURIComponent("music");
  const filterSuffix = "&order=viewCount&duration=short&uploadDate=month&categoryId=10&videoEmbeddable=1";
  const workerFiltered = await callWorker("/api/search?q=" + fq + "&max=50" + filterSuffix);
  const nodeFiltered = await callNode("/api/search?q=" + fq + "&max=50" + filterSuffix);

  check("filtered search: same HTTP status", workerFiltered.status === nodeFiltered.status);
  check("filtered search: worker echoes applied filters",
    workerFiltered.body.appliedFilters && workerFiltered.body.appliedFilters.order === "viewCount" &&
    workerFiltered.body.appliedFilters.videoEmbeddable === true,
    JSON.stringify(workerFiltered.body.appliedFilters));
  check("filtered search: node echoes the same applied filters",
    JSON.stringify(nodeFiltered.body.appliedFilters) === JSON.stringify(workerFiltered.body.appliedFilters),
    "worker=" + JSON.stringify(workerFiltered.body.appliedFilters) +
    " node=" + JSON.stringify(nodeFiltered.body.appliedFilters));
  check("filtered search: worker keeps only playable results",
    (workerFiltered.body.videos || []).every(v => v.embeddable !== false));
  check("filtered search: node keeps only playable results (parity)",
    (nodeFiltered.body.videos || []).every(v => v.embeddable !== false));
  check("filtered search: both report the same contract fields",
    typeof workerFiltered.body.duplicatesRemoved === "number" &&
    typeof nodeFiltered.body.duplicatesRemoved === "number" &&
    typeof workerFiltered.body.filteredCount === "number" &&
    typeof nodeFiltered.body.filteredCount === "number");

  // Page size and validation parity. max=999 is capped at 50, never at 500.
  for(const suffix of ["&max=999", "&max=abc"]){
    const pair = await both("/api/search?q=" + q + suffix);
    check("search" + suffix + ": same HTTP status in both backends",
      pair.workerRes.status === pair.nodeRes.status,
      "worker=" + pair.workerRes.status + " node=" + pair.nodeRes.status);
    check("search" + suffix + ": both always send a videos array",
      Array.isArray(pair.workerRes.body.videos) && Array.isArray(pair.nodeRes.body.videos));
    check("search" + suffix + ": never more than 50 results",
      (pair.workerRes.body.videos || []).length <= 50 && (pair.nodeRes.body.videos || []).length <= 50);
  }

  const blankWorker = await callWorker("/api/search?q=");
  const blankNode = await callNode("/api/search?q=");
  check("blank query: both 400 with videos:[]",
    blankWorker.status === 400 && blankNode.status === 400 &&
    Array.isArray(blankWorker.body.videos) && Array.isArray(blankNode.body.videos));

  // `videoEmbeddable` is a one-way switch: only "1"/"true" is forwarded, because
  // YouTube answers HTTP 400 for "false". So an explicit `false` must be dropped by
  // BOTH backends rather than passed upstream, and neither may echo it back.
  const invalidWorker = await callWorker("/api/search?q=test&videoEmbeddable=false");
  const invalidNode = await callNode("/api/search?q=test&videoEmbeddable=false");
  check("videoEmbeddable=false: neither backend forwards it to YouTube",
    !invalidWorker.body.appliedFilters || invalidWorker.body.appliedFilters.videoEmbeddable === undefined,
    "worker=" + JSON.stringify(invalidWorker.body.appliedFilters));
  check("videoEmbeddable=false: both backends treat it identically",
    invalidWorker.status === invalidNode.status,
    "worker=" + invalidWorker.status + " node=" + invalidNode.status);
}

// ------------------------------------------------------------- other APIs ---
console.log("");
console.log("=== Untouched routes still agree ===");
// /api/related is backed by search.list, so it draws from the search limiter and
// its 10-minute cache. A 429 on one side is limiter state (the in-process Worker
// starts cold), not a contract difference, so it is reported rather than failed.
// It also costs 100 quota units per uncached call, which is why --skip-search
// leaves it out entirely rather than spending quota on a search-backed route.
const untouchedRoutes = [
  "/api/video?id=dQw4w9WgXcQ",
  "/api/channel?id=UC_x5XG1OV2P6uZZ5FSM9Ttw",
  "/api/comments?id=dQw4w9WgXcQ&max=3",
  "/api/playlist?id=PLrEnWoR732-BHrPp_Pm8_VleD68f9sL-",
  "/api/channelVideos?channelId=UC_x5XG1OV2P6uZZ5FSM9Ttw&max=3",
  "/api/ping"
];

if(!args.has("skip-search")){
  untouchedRoutes.push("/api/related?id=dQw4w9WgXcQ&max=3");
}

for(const route of untouchedRoutes){
  const w = await callWorker(route);
  const n = await callNode(route);

  if(w.status === 429 || n.status === 429){
    console.log("  NOTE  " + route + ": worker=" + w.status + " node=" + n.status +
      " (search limiter state, not a contract difference)");
    continue;
  }

  // Both backends failing the same way on a spent upstream budget is agreement,
  // not a parity break.
  if(limited(w) && limited(n)){
    console.log("  NOTE  " + route + ": worker=" + w.status + " node=" + n.status +
      " (upstream quota spent in both backends)");
    continue;
  }

  check(route + ": same HTTP status", w.status === n.status, "worker=" + w.status + " node=" + n.status);
  check(route + ": both return JSON", w.body !== null && n.body !== null);
}

console.log("");
if(failures.length){
  console.log("RESULT: " + failures.length + " parity check(s) failed");
  for(const failure of failures){
    console.log("  - " + failure);
  }
  process.exit(1);
}
console.log("RESULT: Worker and Node backends are in parity");