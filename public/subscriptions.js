// ================= SUBSCRIPTIONS PAGE =================
// Shows subscribed channels with their latest videos.
// Reads subscriptions from Firestore; fetches channel videos via backend API.

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSubscriptions, removeSubscription } from "./data.js";
import { channelVideos, channel } from "./youtube.js";
import { attachHoverPreview } from "./shared/hoverPreview.js";


// ================= ELEMENTS =================

const loggedOutEl = document.getElementById("subsLoggedOut");
const loadingEl = document.getElementById("subsLoading");
const emptyEl = document.getElementById("subsEmpty");
const errorEl = document.getElementById("subsError");
const errorTextEl = document.getElementById("subsErrorText");
const contentEl = document.getElementById("subsContent");
const sectionsEl = document.getElementById("channelSections");


// ================= STATE DISPLAY =================

function showState(state){
    [loggedOutEl, loadingEl, emptyEl, errorEl, contentEl].forEach(el => {
        if(el){
            el.style.display = "none";
        }
    });
    const target = {
        loggedOut: loggedOutEl,
        loading: loadingEl,
        empty: emptyEl,
        error: errorEl,
        content: contentEl
    }[state];
    if(target){
        target.style.display = state === "content" ? "block" : "";
    }
}


function showError(msg){
    if(errorTextEl){
        errorTextEl.textContent = msg || "Could not load subscriptions.";
    }
    showState("error");
}


// ================= HELPERS =================

function getInitials(name){
    return (name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(w => w.charAt(0).toUpperCase())
        .join("") || "?";
}


function openVideo(id){
    window.location.href = "/watch?id=" + encodeURIComponent(id);
}


function buildVideoCard(v){
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "link");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "Watch " + v.title);
    card.addEventListener("click", () => openVideo(v.id));
    card.addEventListener("keydown", (e) => {
        if(e.key === "Enter" || e.key === " "){
            e.preventDefault();
            openVideo(v.id);
        }
    });

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = v.thumb;
    img.alt = v.title;
    img.loading = "lazy";
    const badge = document.createElement("span");
    badge.textContent = v.time || "";
    thumb.appendChild(img);
    thumb.appendChild(badge);

    // Desktop-only muted hover preview; nothing loads until a real hover.
    attachHoverPreview(thumb, v.id);

    const title = document.createElement("h3");
    title.textContent = v.title;

    const meta = document.createElement("p");
    const parts = [v.channel];
    if(v.views){
        parts.push(v.views);
    }
    if(v.date){
        parts.push(v.date);
    }
    meta.textContent = parts.join(" \u2022 ");

    card.appendChild(thumb);
    card.appendChild(title);
    card.appendChild(meta);
    return card;
}


// ================= CHANNEL SECTION =================

function buildChannelSection(sub, channelVids){
    const section = document.createElement("div");
    section.className = "channel-section";

    // Channel header
    const header = document.createElement("div");
    header.className = "channel-section-header";

    const avatar = document.createElement("div");
    avatar.className = "channel-avatar";
    avatar.setAttribute("aria-hidden", "true");
    if(sub.channelThumb){
        const avatarImg = document.createElement("img");
        avatarImg.src = sub.channelThumb;
        avatarImg.alt = "";
        avatarImg.style.width = "100%";
        avatarImg.style.height = "100%";
        avatarImg.style.borderRadius = "50%";
        avatarImg.style.objectFit = "cover";
        avatar.textContent = "";
        avatar.appendChild(avatarImg);
    }
    else{
        avatar.textContent = getInitials(sub.channelName);
    }

    const info = document.createElement("div");
    info.className = "channel-section-info";

    const name = document.createElement("h3");
    name.textContent = sub.channelName || "Unknown channel";

    const subCount = document.createElement("p");
    subCount.textContent = sub.subscriberCount || "";
    subCount.className = "channel-section-subs";

    info.appendChild(name);
    info.appendChild(subCount);

    const unsubBtn = document.createElement("button");
    unsubBtn.type = "button";
    unsubBtn.className = "channel-section-unsub";
    unsubBtn.textContent = "Unsubscribe";
    unsubBtn.setAttribute("aria-label", "Unsubscribe from " + sub.channelName);
    unsubBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const user = auth && auth.currentUser;
        if(!user){
            return;
        }
        unsubBtn.disabled = true;
        unsubBtn.textContent = "Unsubscribing...";
        const ok = await removeSubscription(user.uid, sub.channelId || "", sub.channelName || "");
        if(ok){
            section.remove();
            // Keep the unified Feed consistent with the subscription list: drop
            // this channel's videos from the in-memory Feed without any API call.
            removeChannelFromFeed(sub.channelId || "");
            // If no more sections, show empty state.
            if(sectionsEl && sectionsEl.children.length === 0){
                showState("empty");
            }
        }
        else{
            unsubBtn.disabled = false;
            unsubBtn.textContent = "Unsubscribe";
        }
    });

    header.appendChild(avatar);
    header.appendChild(info);
    header.appendChild(unsubBtn);

    // Video grid
    const grid = document.createElement("div");
    grid.className = "channel-section-grid";

    if(channelVids.length === 0){
        const empty = document.createElement("p");
        empty.className = "comment-empty";
        empty.textContent = "No recent videos found.";
        grid.appendChild(empty);
    }
    else{
        channelVids.forEach(v => {
            grid.appendChild(buildVideoCard(v));
        });
    }

    section.appendChild(header);
    section.appendChild(grid);
    return section;
}


// ================= LOAD CHANNEL VIDEOS =================
// Channel videos are cached in localStorage for 10 minutes so revisiting the
// Subscriptions page does not re-fire ~N YouTube API calls (up to 24 on a full
// page). The cache is best-effort; fetch errors fall back to stale cache data.

const SUBS_CACHE_KEY = "mytube_subs_videos_cache_v1";
const SUBS_CACHE_TTL_MS = 10 * 60 * 1000;

function readVideosCache(){
    try{
        const raw = localStorage.getItem(SUBS_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return (parsed && typeof parsed === "object") ? parsed : {};
    }
    catch(e){
        return {};
    }
}

function writeVideosCache(cache){
    try{
        localStorage.setItem(SUBS_CACHE_KEY, JSON.stringify(cache));
    }
    catch(e){ /* quota exceeded — cache is best-effort */ }
}

function cachedChannelVideos(channelId){
    const cache = readVideosCache();
    const entry = cache[channelId];
    if(!entry || !Array.isArray(entry.videos)){
        return null;
    }
    if(Date.now() - entry.at > SUBS_CACHE_TTL_MS){
        return { stale: true, videos: entry.videos };
    }
    return { stale: false, videos: entry.videos };
}

function setCachedChannelVideos(channelId, videos){
    const cache = readVideosCache();
    cache[channelId] = { at: Date.now(), videos };
    const keys = Object.keys(cache);
    if(keys.length > 100){
        delete cache[keys[0]];
    }
    writeVideosCache(cache);
}

function clearVideosCache(){
    try{
        localStorage.removeItem(SUBS_CACHE_KEY);
    }
    catch(e){ /* ignore */ }
}

// Fetch a channel's recent videos and report whether the FETCH failed.
//
// `videos: []` with `failed: false` means the channel simply has nothing recent
// — a real, successful answer. `failed: true` means the request (or a usable
// fallback) never produced data, so an empty list is not trustworthy. The Feed
// needs the difference to avoid reporting "no videos" as a network error and
// vice versa; the shelves only need the list, so loadChannelVideos() below wraps
// this into the original array-only contract.
async function loadChannelVideosResult(sub, forceRefresh){
    // Not a YouTube channel (legacy local subscription): nothing to fetch, and
    // that is a successful empty answer rather than a failure.
    if(!sub || !sub.channelId){
        return { videos: [], failed: false };
    }

    const cached = cachedChannelVideos(sub.channelId);
    if(cached && !forceRefresh && !cached.stale){
        return { videos: cached.videos, failed: false };
    }

    try{
        const result = await channelVideos(sub.channelId, 6);
        // A malformed payload (missing/!array `videos`) is an unusable answer,
        // never a silent success: treat it the same as a thrown error so the
        // Feed can report a partial/total failure truthfully.
        if(!result || !Array.isArray(result.videos)){
            console.warn("Malformed channelVideos response for channel:", sub.channelName);
            if(cached){
                return { videos: cached.videos, failed: false };
            }
            return { videos: [], failed: true };
        }
        const videos = result.videos;
        setCachedChannelVideos(sub.channelId, videos);
        return { videos, failed: false };
    }
    catch(e){
        console.warn("Failed to load videos for channel:", sub.channelName, e);
        if(cached){
            // Stale cache is a usable answer, so this is not a failure.
            return { videos: cached.videos, failed: false };
        }
        return { videos: [], failed: true };
    }
}

// The original contract, preserved for the Channels/shelves view and any other
// caller: a plain array, empty on either "nothing recent" or a failed fetch.
async function loadChannelVideos(sub, forceRefresh){
    const result = await loadChannelVideosResult(sub, forceRefresh);
    return result.videos;
}



// ================= UNIFIED FEED =================
// A newest-first merge of every subscribed channel's recent uploads, built on
// the SAME fetch path as the shelves (loadChannelVideos -> 10-minute cache).
// The shelves remain the source of truth for per-channel browsing; the feed is
// a read-only projection over the same cached data.

const FEED_CHANNEL_CAP = 12;    // identical to the shelves' cap (quota envelope)
const FEED_INITIAL_COUNT = 24;  // cards revealed by the first load
const FEED_MORE_COUNT = 24;     // cards revealed per "Load more"

// Curated limits so the two views agree; banners etc. are out of scope.
const feedWrapEl = document.getElementById("feedView");
const feedGridEl = document.getElementById("subscriptionsFeed");
const feedMoreEl = document.getElementById("feedMoreBtn");
const feedStatusEl = document.getElementById("feedStatus");
const shelvesWrapEl = document.getElementById("shelvesView");
const feedTabEl = document.getElementById("subsViewFeed");
const channelsTabEl = document.getElementById("subsViewChannels");


// ================= AGE / SORT HELPERS =================

// The single source of truth for "when was this video published?".
// Prefers the raw RFC 3339 publishedAt; falls back to the lossy human label
// ("3d ago") so cached videos written before this field existed still sort.
// Returns a finite epoch ms, or Infinity when nothing is usable, so callers
// that sort ascending-on-Infinity push unknown-age videos to the end.
function publishedAtMs(v){
    const raw = v && v.publishedAt;
    if(raw){
        const ms = Date.parse(raw);
        if(Number.isFinite(ms)){
            return ms;
        }
    }
    return parseAgoDate(v && v.date);
}

function parseAgoDate(label){
    const m = /^(\d+)\s*(s|m|h|d|mo|y)\s*ago$/.exec(String(label || "").trim());
    if(!m){
        return Infinity;
    }
    const n = Number(m[1]);
    if(!Number.isFinite(n)){
        return Infinity;
    }
    const unitMs = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    }[m[2]];
    return Date.now() - n * unitMs;
}

// Deduplicate by stable identity, then order newest-first.
//
// A video can legitimately appear in more than one channel's uploads (a collab
// or a repost), so the feed collapses duplicates by sourceId || id. The first
// occurrence wins, but a later occurrence carrying a usable timestamp replaces
// an undated one, so a card never loses its sort position.
//
// Sorting is stable: equal (or unknown) ages keep their original order. Unknown
// ages (Infinity) sort last and are never dropped.
function mergeFeed(lists){
    const seen = new Map();

    for(const list of lists || []){
        for(const v of list || []){
            if(!v){
                continue;
            }
            const key = v.sourceId || v.id;
            if(!key){
                continue;
            }
            const existing = seen.get(key);
            if(!existing){
                seen.set(key, v);
                continue;
            }
            if(publishedAtMs(existing) === Infinity && publishedAtMs(v) !== Infinity){
                seen.set(key, v);
            }
        }
    }

    return Array.from(seen.values())
        .map((v, index) => ({ v, index, age: publishedAtMs(v) }))
        .sort((a, b) => {
            // Newest first. Unknown ages (Infinity) must still land last, so an
            // infinity check runs before the plain descending comparison —
            // a naive `b.age - a.age` would sort Infinity to the front.
            const aUnknown = a.age === Infinity;
            const bUnknown = b.age === Infinity;

            if(aUnknown !== bUnknown){
                return aUnknown ? 1 : -1;
            }
            if(a.age !== b.age){
                return b.age - a.age;
            }
            return a.index - b.index;
        })
        .map(entry => entry.v);
}


// ================= FEED STATE =================
// `pool` is the whole deduped/ordered result so far; `shown` is how many of it
// is currently in the DOM. `pending` is the forward-only guard that drops a
// stale response's late arrival, and `token` invalidates a superseded load.

const feed = {
    subs: [],
    pool: [],
    shown: 0,
    exhaused: false,
    pending: false,
    token: 0
};

// pageToken -> per channel, so "Load more" continues each channel's uploads
// playlist exactly where the previous page stopped. A channel with no cursor is
// simply skipped: there is genuinely nothing else to request for it.
const feedCursors = new Map();

// Channels whose uploads playlist has been paged at least once, so an empty
// cursor afterwards is read as "exhausted" rather than "not started".
const feedPagedChannels = new Set();

let currentUid = "";

function setFeedStatus(msg){
    if(feedStatusEl){
        feedStatusEl.textContent = msg || "";
    }
}


// ================= "NEW SINCE LAST VISIT" =================
// Per-uid, localStorage-only. The marker stores the epoch ms at which the user
// last LEFT the page. A video is "New" only when it was published after that
// instant, so the badge always means "arrived since your previous visit" and can
// never re-mark an old video. A first visit has no marker and therefore shows no
// badges; the marker is created when the user leaves.

const FEED_SEEN_KEY = "mytube_feed_last_seen_v1";
let feedSeenStore = null;

function loadFeedSeenStore(){
    feedSeenStore = {};
    try{
        const parsed = JSON.parse(localStorage.getItem(FEED_SEEN_KEY) || "{}");
        if(parsed && typeof parsed === "object" && !Array.isArray(parsed)){
            feedSeenStore = parsed;
        }
    }
    catch(e){ /* unreadable store: treat every visit as a first visit */ }
}

function feedSeenFor(uid){
    if(feedSeenStore === null){
        loadFeedSeenStore();
    }
    return Number(feedSeenStore[uid]) || 0;
}

function advanceFeedSeen(uid, whenMs){
    if(!uid){
        return;
    }
    if(feedSeenStore === null){
        loadFeedSeenStore();
    }
    feedSeenStore[uid] = whenMs;
    try{
        localStorage.setItem(FEED_SEEN_KEY, JSON.stringify(feedSeenStore));
    }
    catch(e){ /* quota exceeded — marker is best-effort */ }
}


// ================= FEED RENDERING =================

function buildFeedCard(v){
    const card = buildVideoCard(v);
    card.classList.add("feed-card");

    const age = publishedAtMs(v);
    const seen = feedSeenFor(currentUid);
    // seen === 0 means a first visit: no marker, so nothing is badged.
    if(seen > 0 && age !== Infinity && age > seen){
        const badge = document.createElement("span");
        badge.className = "feed-new";
        badge.textContent = "New";
        const thumb = card.querySelector(".thumb");
        if(thumb){
            thumb.appendChild(badge);
        }
    }

    return card;
}

// Reveal up to `count` more cards from the pool, in order. Returns how many were
// appended, so callers can tell "there was more" from "the pool is exhausted".
function revealFeed(count){
    if(!feedGridEl){
        return 0;
    }
    const target = Math.min(feed.shown + count, feed.pool.length);
    while(feed.shown < target){
        feedGridEl.appendChild(buildFeedCard(feed.pool[feed.shown]));
        feed.shown++;
    }
    return feed.shown;
}

function updateFeedMoreButton(){
    if(!feedMoreEl){
        return;
    }
    const hasMore = !feed.exhaused && feed.shown < feed.pool.length;
    if(!hasMore){
        // The upstream playlists are the boundary here, not the UI. Say so
        // plainly instead of offering a button that would do nothing.
        feedMoreEl.style.display = "none";
        return;
    }
    feedMoreEl.style.display = "";
    feedMoreEl.disabled = false;
    feedMoreEl.textContent = "Load more";
}

function resetFeedView(subs, forceRefresh){
    feed.subs = subs.slice(0, FEED_CHANNEL_CAP);
    feed.pool = [];
    feed.shown = 0;
    feed.exhaused = false;
    feed.pending = false;
    feedCursors.clear();
    feedPagedChannels.clear();
    if(feedGridEl){
        feedGridEl.replaceChildren();
    }
    setFeedStatus("");
    showState("content");
}

// Drop a channel from the Feed after a successful unsubscribe, without touching
// the network. Everything else in the Feed is preserved: the remaining videos,
// their order, the revealed count, the per-channel cursors, and the Load-more
// state. Only this channel's subscription, videos, and cursors are removed.
//
// When nothing is left the feed shows its empty message rather than a blank
// grid, but it does NOT change the page state — the shelves path owns the
// page-level empty state, and switching views must not fight over it.
function removeChannelFromFeed(channelId){
    if(!channelId){
        return;
    }

    feed.subs = feed.subs.filter(s => s.channelId !== channelId);
    feedCursors.delete(channelId);
    feedPagedChannels.delete(channelId);

    const before = feed.pool.length;
    // Preserve feed order: filter in place rather than re-sorting, so pagination
    // and "what the user has already seen" stay exactly consistent.
    feed.pool = feed.pool.filter(v => v && v.channelId !== channelId);
    const removed = before - feed.pool.length;

    if(removed > 0){
        // Re-render the visible cards in place so the removed channel disappears
        // immediately and every remaining card keeps its position.
        if(feedGridEl){
            feedGridEl.replaceChildren();
        }
        const alreadyShown = Math.min(feed.shown, feed.pool.length);
        feed.shown = 0;
        if(alreadyShown > 0){
            revealFeed(alreadyShown);
        }
    }

    if(feed.pool.length === 0){
        setFeedStatus("You're not subscribed to any channels yet.");
    }

    updateFeedMoreButton();
}

async function loadFeed(uid, forceRefresh){
    currentUid = uid || "";
    const loadId = ++feed.token;

    let subs = [];
    try{
        subs = await getSubscriptions(uid);
    }
    catch(e){
        console.warn("Failed to load subscriptions:", e);
        showError("Could not load your subscriptions. Please try again.");
        return;
    }

    const withChannel = (subs || []).filter(s => s.channelId);
    if(withChannel.length === 0){
        showState("empty");
        return;
    }

    resetFeedView(withChannel, forceRefresh);

    // Fetch every channel in parallel. The per-channel cache makes repeat loads
    // cheap; a channel that errors is reported as failed rather than aborting the
    // whole feed, and a channel that succeeds with no videos is NOT a failure.
    const results = await Promise.all(
        feed.subs.map(async (sub) => ({ sub, ...(await loadChannelVideosResult(sub, forceRefresh)) }))
    );

    if(loadId !== feed.token){
        return;   // a newer load superseded this one
    }

    let failures = 0;
    const lists = [];
    for(const { sub, videos, failed } of results){
        const list = Array.isArray(videos) ? videos : [];
        lists.push(list);
        if(failed){
            failures++;
        }
        // No cursor yet: the shelf fetch did not expose a page token, so the
        // first "Load more" will request page 2 for every channel explicitly.
        feedCursors.set(sub.channelId, "");
    }

    feed.pool = mergeFeed(lists);

    if(feed.pool.length === 0){
        // "Nothing recent" and "every request failed" are different outcomes and
        // must not share a message.
        setFeedStatus(failures > 0
            ? "Could not load videos from your subscriptions right now. Try Refresh."
            : "No recent videos found from your subscriptions.");
        updateFeedMoreButton();
        return;
    }

    revealFeed(FEED_INITIAL_COUNT);
    updateFeedMoreButton();

    if(failures > 0){
        setFeedStatus("Some channels could not be loaded.");
    }
    else{
        setFeedStatus("");
    }
}

// "Load more" advances every channel that can still supply another page, then
// merges and re-sorts the whole pool so a just-fetched newer video lands in its
// correct chronological slot. It only reports success after real data arrives.
//
// Cursor semantics: the first page came from loadChannelVideos(), which does not
// expose a nextPageToken — so a channel with no cursor and never-yet-paged is
// fetched from page 2 explicitly. Once paged, an empty cursor means that
// channel's uploads playlist is exhausted and it is skipped.
async function loadMoreFeed(){
    if(feed.pending || feed.exhaused || !feed.subs.length){
        return;
    }

    feed.pending = true;
    const loadId = feed.token;
    if(feedMoreEl){
        feedMoreEl.disabled = true;
        feedMoreEl.textContent = "Loading more...";
    }

    const newLists = [];
    let requestFailed = false;

    for(const sub of feed.subs){
        const token = feedCursors.get(sub.channelId) || "";
        const started = feedPagedChannels.has(sub.channelId);
        if(started && token === ""){
            continue;   // exhausted
        }
        try{
            const result = await channelVideos(sub.channelId, 12, token);
            feedPagedChannels.add(sub.channelId);
            const videos = (result && result.videos) || [];
            if(videos.length > 0){
                newLists.push(videos);
            }
            feedCursors.set(sub.channelId, (result && result.nextPageToken) || "");
        }
        catch(e){
            console.warn("Failed to load more for channel:", sub.channelName, e);
            requestFailed = true;
        }
    }

    feed.pending = false;

    if(loadId !== feed.token){
        return;   // superseded by a newer load
    }

    if(newLists.length === 0){
        // No channel produced another page. Only claim "caught up" when every
        // request actually succeeded; a network failure must not be dressed up
        // as "there is nothing more".
        feed.exhaused = true;
        setFeedStatus(requestFailed
            ? "Could not load more videos. Please try again."
            : "You're all caught up on recent videos.");
        updateFeedMoreButton();
        return;
    }

    const before = feed.pool.length;
    feed.pool = mergeFeed([feed.pool, ...newLists]);
    revealFeed(Math.max(FEED_MORE_COUNT, feed.pool.length - feed.shown));

    setFeedStatus(feed.pool.length === before
        ? "No new videos from your subscriptions right now."
        : "");

    updateFeedMoreButton();
}

// ================= FEED / CHANNELS TOGGLE =================

const FEED_VIEW_KEY = "mytube_subs_view_v1";

function readFeedView(){
    try{
        return localStorage.getItem(FEED_VIEW_KEY) === "channels" ? "channels" : "feed";
    }
    catch(e){
        return "feed";
    }
}

function setFeedView(view){
    const isFeed = view !== "channels";
    if(feedWrapEl){
        feedWrapEl.hidden = !isFeed;
    }
    if(shelvesWrapEl){
        shelvesWrapEl.hidden = isFeed;
    }
    if(feedTabEl){
        feedTabEl.classList.toggle("active", isFeed);
        feedTabEl.setAttribute("aria-selected", isFeed ? "true" : "false");
    }
    if(channelsTabEl){
        channelsTabEl.classList.toggle("active", !isFeed);
        channelsTabEl.setAttribute("aria-selected", !isFeed ? "true" : "false");
    }
    try{
        localStorage.setItem(FEED_VIEW_KEY, isFeed ? "feed" : "channels");
    }
    catch(e){ /* ignore */ }
}

function setupFeedToggle(){
    if(feedTabEl && feedTabEl.dataset.wired !== "1"){
        feedTabEl.dataset.wired = "1";
        feedTabEl.addEventListener("click", () => setFeedView("feed"));
    }
    if(channelsTabEl && channelsTabEl.dataset.wired !== "1"){
        channelsTabEl.dataset.wired = "1";
        channelsTabEl.addEventListener("click", () => setFeedView("channels"));
    }
    setFeedView(readFeedView());
}


// ================= MAIN LOAD =================

async function loadSubscriptions(uid, forceRefresh){
    // On manual refresh keep the existing content visible while it reloads
    // rather than flashing a full-page loading spinner.
    if(forceRefresh && sectionsEl && sectionsEl.children.length > 0){
        showState("content");
    }
    else{
        showState("loading");
    }

    let subs = [];
    try{
        subs = await getSubscriptions(uid);
    }
    catch(e){
        console.warn("Failed to load subscriptions:", e);
        showError("Could not load your subscriptions. Please try again.");
        return;
    }

    if(!subs || subs.length === 0){
        showState("empty");
        return;
    }

    // Legacy local subscriptions (no channelId) were skipped at the data
    // layer; if none remain, show the empty state.
    const withChannel = subs.filter(s => s.channelId);
    if(withChannel.length === 0){
        showState("empty");
        return;
    }

    showState("content");
    if(sectionsEl){
        sectionsEl.replaceChildren();
    }

    // Load videos for each channel sequentially to avoid request storms.
    // Limit to 12 channels max.
    const limited = withChannel.slice(0, 12);
    for(const sub of limited){
        const channelVids = await loadChannelVideos(sub, forceRefresh);
        if(sectionsEl){
            sectionsEl.appendChild(buildChannelSection(sub, channelVids));
        }
    }
}


// Reload whichever view is currently visible. Refresh in the Feed view clears
// the same per-channel cache the shelves use, so both views see fresh data.
async function refreshActiveView(uid){
    if(readFeedView() === "channels"){
        await loadSubscriptions(uid, true);
        return;
    }
    await loadFeed(uid, true);
}

function setupRefreshButton(){
    const btn = document.getElementById("subsRefreshBtn");
    if(!btn || btn.dataset.refreshWired === "1"){
        return;
    }
    btn.dataset.refreshWired = "1";
    btn.addEventListener("click", () => {
        const user = auth && auth.currentUser;
        if(!user){
            return;
        }
        clearVideosCache();
        btn.disabled = true;
        btn.textContent = "Refreshing...";
        Promise.resolve(refreshActiveView(user.uid)).finally(() => {
            btn.disabled = false;
            btn.textContent = "Refresh";
        });
    });
}

function setupFeedMoreButton(){
    if(!feedMoreEl || feedMoreEl.dataset.wired === "1"){
        return;
    }
    feedMoreEl.dataset.wired = "1";
    feedMoreEl.addEventListener("click", () => {
        if(feed.pending){
            return;
        }
        Promise.resolve(loadMoreFeed()).catch(e => {
            console.warn("Load more failed:", e);
        });
    });
}

// Switching to Feed for the first time (or after an unsubscribe) may need a
// load; switching to Channels is served by the unconditional shelf load below.
function setupFeedViewSwitch(){
    if(!feedTabEl || feedTabEl.dataset.loadWired === "1"){
        return;
    }
    feedTabEl.dataset.loadWired = "1";
    feedTabEl.addEventListener("click", () => {
        const user = auth && auth.currentUser;
        if(user && feed.pool.length === 0 && !feed.pending){
            refreshActiveView(user.uid);
        }
    });
}

// The marker advances to "now" only when the user leaves the page, so videos
// viewed during this visit are not re-badged on the next one.
function setupFeedSeenMarker(){
    if(window.__mytubeFeedSeenWired){
        return;
    }
    window.__mytubeFeedSeenWired = true;
    const remember = () => {
        const user = auth && auth.currentUser;
        if(user){
            advanceFeedSeen(user.uid, Date.now());
        }
    };
    window.addEventListener("pagehide", remember);
    document.addEventListener("visibilitychange", () => {
        if(document.visibilityState === "hidden"){
            remember();
        }
    });
}


// ================= AUTH STATE =================

onAuthStateChanged(auth, (user) => {
    if(user){
        setupRefreshButton();
        setupFeedMoreButton();
        setupFeedToggle();
        setupFeedViewSwitch();
        setupFeedSeenMarker();
        // Load both views' data through the one shared fetch path. The shelves
        // render into their (hidden) container so switching is instant; the feed
        // renders when it is the active view.
        if(readFeedView() === "channels"){
            loadSubscriptions(user.uid);
        }
        else{
            loadFeed(user.uid);
        }
    }
    else{
        showState("loggedOut");
    }
});
