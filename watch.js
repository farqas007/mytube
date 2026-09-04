// ================= FIREBASE AUTH =================
import { auth } from "./firebase.js";

// ================= PHASE 7: YOUTUBE CLIENT =================
import { getVideo, related, channel, comments } from "./youtube.js";

// ================= FIRESTORE DATA LAYER =================
import {
    getSubscriptions, addSubscription, removeSubscription, isSubscribedByChannel,
    addToHistory, getHistory,
    getSaved as fsGetSaved, addToSaved, removeFromSaved, isSavedVideo,
    getLiked as fsGetLiked, addToLiked, removeFromLiked, isLikedVideo,
    getPlaylists, createPlaylist, addToPlaylist, removeFromPlaylist, getPlaylistItems,
    subscribeComments, addCommentToStore, removeCommentById
} from "./data.js";


// ================= VIDEO DATABASE =================
// Single source of truth shared with the homepage (see videos.js).
// Stable string ids are used for watch.html?id=<id>.
// Legacy numeric ids (?id=0,1,2...) are still supported by array index.
// YouTube video ids use the namespaced form "yt:<videoId>".

const videos = window.MyTubeVideos || [];


// ================= HELPERS =================


function getRawId(){
    return new URLSearchParams(window.location.search).get("id");
}


// A "yt:" prefixed id identifies a YouTube-hosted video (played via embed).
function isYouTubeId(raw){
    return Boolean(raw) && String(raw).startsWith("yt:");
}

// Extract the raw YouTube video id from "yt:<videoId>".
function ytSourceId(raw){
    const str = String(raw || "");
    return str.startsWith("yt:") ? str.slice(3) : "";
}


function getVideoById(raw){
    // missing id defaults to the first video
    if(raw === null || raw === undefined || raw === ""){
        return videos[0] || null;
    }
    const str = String(raw);
    // 1) stable string id
    const byStr = videos.find(v => v.id === str);
    if(byStr){
        return byStr;
    }
    // 2) legacy numeric index (backward compatibility with watch.html?id=<n>)
    const n = Number(str);
    if(!Number.isNaN(n) && Number.isInteger(n) && n >= 0 && n < videos.length){
        return videos[n];
    }
    return null;
}


function getIndexById(raw){
    const v = getVideoById(raw);
    return v ? videos.indexOf(v) : -1;
}


function formatCommentTime(ts){
    const date = new Date(ts);
    if(isNaN(date.getTime())){
        return "";
    }
    return date.toLocaleString();
}


function getInitials(name){
    return (name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(word => word.charAt(0).toUpperCase())
        .join("") || "?";
}


function currentUser(){
    // Authoritative source is Firebase; localStorage is a sync fallback.
    return (auth && auth.currentUser) || null;
}


function currentUserId(){
    const user = currentUser();
    if(user){
        return user.uid || "";
    }
    return localStorage.getItem("mytube_comment_user") || "";
}


function currentUserName(){
    const user = currentUser();
    if(user){
        return user.displayName || (user.email ? user.email.split("@")[0] : "User");
    }
    return localStorage.getItem("mytube_comment_name") || "";
}


// ================= PAGE STATE =================


const rawId = getRawId();
const current = getVideoById(rawId);
// stable storage key derived from the resolved video's stable string id.
// Fully safe: never dereferences .id on undefined.
const videoKey = current ? current.id : (videos[0] ? videos[0].id : "video");

// Phase 7: an actively-rendered video. For local MP4s this equals `current`.
// For yt: ids `current` is null and `active` is populated asynchronously from
// the YouTube API backend. Renderers read `active`, never `current`, directly.
const isYt = isYouTubeId(rawId);
let active = current;
// Key used for localStorage-backed state (likes/saves/comments/etc). For
// YouTube videos this is derived from the yt: id once known.
let activeKey = videoKey;

// Resolve the storage key that should be used right now. For YouTube videos
// `activeKey` is set once the video metadata loads; before that we fall back to
// the resolved local key so nothing ever dereferences undefined.
function storageKey(){
    return activeKey || videoKey;
}


// ================= ELEMENT REFERENCES =================


const pageLoading = document.getElementById("pageLoading");
const pageContent = document.getElementById("pageContent");
const pageError = document.getElementById("pageError");
const video = document.getElementById("videoPlayer");


// ================= ERROR / LOADING STATE =================


function renderLoadingState(){
    if(pageLoading){
        pageLoading.style.display = "block";
    }
    if(pageContent){
        pageContent.style.display = "none";
    }
    if(pageError){
        pageError.style.display = "none";
    }
}


function renderErrorState(){
    if(pageLoading){
        pageLoading.style.display = "none";
    }
    if(pageContent){
        pageContent.style.display = "none";
    }
    if(pageError){
        pageError.style.display = "block";
    }
    console.warn("Video not found for id:", rawId);
}


function renderContentState(){
    if(pageLoading){
        pageLoading.style.display = "none";
    }
    if(pageContent){
        pageContent.style.display = "";
    }
    if(pageError){
        pageError.style.display = "none";
    }
}


function showVideoError(show, message){
    const err = document.getElementById("videoErrorMsg");
    if(!err){
        return;
    }
    if(typeof message === "string"){
        err.textContent = message;
    }
    err.style.display = show ? "flex" : "none";
}


function showBuffering(show){
    const buf = document.getElementById("bufferingIndicator");
    if(buf){
        buf.style.display = show ? "flex" : "none";
    }
}


function formatTime(sec){
    if(!isFinite(sec) || sec < 0){
        return "0:00";
    }
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = (h > 0) ? String(m).padStart(2, "0") : String(m);
    const ss = String(s).padStart(2, "0");
    return (h > 0) ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}


function renderTimeDisplay(){
    const el = document.getElementById("timeDisplay");
    if(!el){
        return;
    }
    const cur = video ? video.currentTime : 0;
    const dur = video && video.duration && isFinite(video.duration) ? video.duration : 0;
    el.textContent = formatTime(cur) + " / " + formatTime(dur);
}


// ================= VIDEO LOAD =================


function loadVideo(){
    if(isYt){
        loadYouTubeVideo();
        return;
    }

    if(!current){
        renderErrorState();
        return;
    }

    renderContentState();

    const v = current;

    if(video){
        video.src = v.file;
        video.poster = v.thumb;
        video.load();
        video.addEventListener("error", () => {
            console.log("Video file load failed:", v.file);
            showVideoError(true, "This video isn't available right now — missing file: " + (v.file || "?") + ". Add the file to the videos/ folder to enable playback.");
            showBuffering(false);
        });
        video.addEventListener("waiting", () => {
            showBuffering(true);
        });
        video.addEventListener("playing", () => {
            showVideoError(false);
            showBuffering(false);
        });
        video.addEventListener("canplay", () => {
            showBuffering(false);
        });
        video.addEventListener("pause", () => {
            showVideoError(false);
            showBuffering(false);
        });
        video.addEventListener("loadedmetadata", () => {
            showBuffering(false);
            renderTimeDisplay();
            maybeResumePlayback();
        });
        video.addEventListener("timeupdate", () => {
            renderTimeDisplay();
        });
    }

    const titleEl = document.getElementById("videoTitle");
    if(titleEl){
        titleEl.textContent = v.title;
    }

    renderVideoDetails();
    renderChannel();
    renderDescription();
    renderRelatedSection();
    renderComments();
    syncFirestoreComments();
}


// ================= PHASE 7: YOUTUBE VIDEO LOAD =================


// External watch URL for a raw YouTube video id. Never uses the yt: namespace
// inside the real URL — only the plain video id is acceptable to YouTube.
function ytWatchUrl(sourceId){
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(sourceId);
}


function setupYtEmbed(sourceId){
    // Show iframe player; hide the native <video> player and its custom chrome.
    const wrap = document.getElementById("ytPlayerWrap");
    const frame = document.getElementById("ytPlayer");
    const fallback = document.getElementById("ytEmbedFallback");
    if(wrap){
        wrap.style.display = "block";
    }
    if(frame){
        frame.src = "https://www.youtube-nocookie.com/embed/" +
            encodeURIComponent(sourceId) + "?rel=0&modestbranding=1&enablejsapi=0";
    }
    if(fallback){
        fallback.style.display = "none";
    }
    if(video){
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.style.display = "none";
    }
    // Hide local custom controls / buffering overlays (the embed has its own).
    const controls = document.querySelector(".controls");
    if(controls){
        controls.style.display = "none";
    }
    showVideoError(false);
    showBuffering(false);
}


// Show an honest fallback for a video whose owner has disabled embedding. This
// is only invoked when the backend reported embeddable === false, so it never
// fires for every iframe error — only when YouTube tells us embedding is off.
function showYtEmbedFallback(sourceId){
    const wrap = document.getElementById("ytPlayerWrap");
    const frame = document.getElementById("ytPlayer");
    const fallback = document.getElementById("ytEmbedFallback");
    if(frame){
        frame.src = "about:blank";
    }
    if(wrap){
        wrap.style.display = "none";
    }
    if(video){
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.style.display = "none";
    }
    const controls = document.querySelector(".controls");
    if(controls){
        controls.style.display = "none";
    }
    showVideoError(false);
    showBuffering(false);
    if(fallback){
        fallback.style.display = "flex";
        const link = document.getElementById("ytWatchOnYoutube");
        if(link){
            link.href = ytWatchUrl(sourceId);
        }
        const titleEl = fallback.querySelector(".yt-fallback-title");
        if(titleEl){
            titleEl.textContent = active ? active.title : "This video";
        }
    }
}


function teardownYtEmbed(){
    const wrap = document.getElementById("ytPlayerWrap");
    const frame = document.getElementById("ytPlayer");
    if(frame){
        frame.src = "about:blank";
    }
    if(wrap){
        wrap.style.display = "none";
    }
    if(video){
        video.style.display = "";
    }
    const controls = document.querySelector(".controls");
    if(controls){
        controls.style.display = "";
    }
}


async function loadYouTubeVideo(){
    const sourceId = ytSourceId(rawId);
    if(!sourceId){
        renderErrorState();
        return;
    }

    // Keep the loading panel visible while metadata loads so the user never
    // sees stale info from a previous state. renderContentState() is only
    // called once the fetch settles (success or a definitive failure).
    let info = null;
    let apiError = "";
    let apiStatus = null;
    try{
        const result = await getVideo(sourceId);
        info = result.video;
        apiError = result.error || "";
        apiStatus = result.status;
    }
    catch(e){
        apiError = "Could not load this YouTube video.";
        console.warn("YouTube video load failed:", e);
    }

    // If the video simply does not exist (e.g. removed or invalid id) the backend
    // replies 404. Show a friendly error rather than an empty black embed.
    if(!info){
        if(apiStatus === 404){
            renderYoutubeErrorState("Video unavailable", "This video may have been removed or is no longer available on YouTube.");
            return;
        }
        // Any other failure (backend down / network / API error): best effort —
        // show the embed with generic info so the video can still play. We still
        // render the metadata sub-views with clean fallbacks so the page is never
        // left permanently stuck on the "Loading..." placeholders.
        const fallbackV = {
            id: "yt:" + sourceId,
            file: null,
            thumb: "",
            title: "YouTube video",
            channel: "Unknown channel",
            subscribers: "",
            views: "",
            viewCount: 0,
            date: "",
            description: "",
            category: ""
        };
        active = fallbackV;
        activeKey = fallbackV.id;
        renderContentState();
        setupYtEmbed(sourceId);
        if(apiError){
            console.warn(apiError);
        }
        renderYtSubViews(fallbackV);
        return;
    }

    renderContentState();

    // Normalize object into the shape renderers expect.
    const v = {
        id: info.id || ("yt:" + sourceId),
        sourceId: sourceId,
        file: null,
        thumb: info.thumb || "",
        title: info.title || "Untitled",
        channel: info.channel || "Unknown channel",
        channelId: info.channelId || "",
        subscribers: "",
        views: info.views || "",
        viewCount: info.viewCount || 0,
        likeCount: (typeof info.likeCount === "number") ? info.likeCount : null,
        commentCount: (typeof info.commentCount === "number") ? info.commentCount : null,
        date: info.date || "",
        description: info.description || "",
        category: ""
    };
    active = v;
    activeKey = v.id;

    // Only show the "cannot embed" fallback when the backend explicitly reports
    // embeddable === false. This avoids false positives on transient iframe errors.
    if(info.embeddable === false){
        showYtEmbedFallback(sourceId);
    }
    else{
        setupYtEmbed(sourceId);
    }

    renderYtSubViews(v);
}


// Render the title and all metadata sub-views for the currently-active YouTube
// video (or the clean fallback object on metadata failure). Shared by both the
// success and the failure paths so neither leaves "Loading..." placeholders.
function renderYtSubViews(v){
    const titleEl = document.getElementById("videoTitle");
    if(titleEl){
        titleEl.textContent = v.title;
    }

    renderVideoDetails();
    renderChannel();
    renderDescription();
    renderRelatedSection();
    renderComments();
    syncFirestoreComments();

    if(isYt){
        const sourceId = ytSourceId(rawId);
        if(v.channelId){
            loadYoutubeChannel(v.channelId);
        }
        loadYoutubeComments(sourceId);
    }

    // Ensure the single Like/Dislike controls show the real YouTube like count
    // once metadata has loaded (for YouTube videos) — no duplicate stats row.
    renderLikeDislike();

    renderSave();
    renderSubscribe();
    // Recompute saved/subscribed state for the now-current YouTube video.
    isSaved = localStorage.getItem(saveKey()) === "1";
    refreshSubscribeState();
    // Arm watch-history recording now that the active YouTube video is known.
    // (The DOMContentLoaded recordHistory() call runs before YouTube metadata
    // is available and would otherwise return early for yt: videos.)
    recordHistory();
}


// Fetch and display the real public subscriber count for the active channel.
// Uses the official channels.list endpoint via the backend. Falls back to "—".
async function loadYoutubeChannel(channelId){
    const subsEl = document.getElementById("channelSubs");
    const link = document.getElementById("ytChannelLink");
    if(!subsEl || !channelId){
        return;
    }
    subsEl.textContent = "—";
    let res;
    try{
        res = await channel(channelId);
    }
    catch(e){
        console.warn("YouTube channel load failed:", e);
        res = null;
    }
    if(!document.body.contains(subsEl)){
        return;
    }
    const c = res && res.channel;
    if(c && subsEl){
        subsEl.textContent = c.subscribers || "—";
    }
    else if(subsEl){
        subsEl.textContent = "—";
    }
    if(link){
        link.href = "https://www.youtube.com/channel/" + encodeURIComponent(channelId);
        link.setAttribute("aria-label", "Open " + (c ? c.title : "channel") + " on YouTube");
    }
}


// Fetch the real public YouTube comments and merge them into the single comments
// area. Uses official commentThreads.list via the backend. Only one in-flight
// request per video to avoid duplicate API calls. Fails gracefully to a message.
async function loadYoutubeComments(sourceId){
    if(!isYt || !sourceId){
        return;
    }
    // Guard: don't start a second fetch while the previous one is still running.
    if(ytCommentsLoading && ytCommentsSourceId === sourceId){
        return;
    }
    ytCommentsSourceId = sourceId;
    ytCommentsLoading = true;
    ytCommentsError = "";
    ytCommentsData = [];
    ytCommentsNextToken = "";
    renderComments();

    try{
        const result = await comments(sourceId, 20);
        ytCommentsData = result.comments || [];
        ytCommentsNextToken = result.nextPageToken || "";
        ytCommentsError = result.error || "";
    }
    catch(e){
        ytCommentsError = "could not load";
        console.warn("YouTube comments load failed:", e);
    }

    // Guard against the section being torn down between request and reply.
    const container = document.getElementById("comments");
    if(!document.body.contains(container)){
        return;
    }

    ytCommentsLoading = false;
    renderComments();
}


// Load the next page of public YouTube comments and append them to the merged
// comments area. Only appears while ytCommentsNextToken is set.
async function loadMoreYtComments(){
    if(!isYt || !ytCommentsNextToken || ytCommentsLoading || ytCommentsLoadingMore){
        return;
    }
    const sourceId = ytSourceId(rawId);
    if(!sourceId){
        return;
    }
    ytCommentsLoadingMore = true;
    renderComments();

    try{
        const result = await comments(sourceId, 20, ytCommentsNextToken);
        const page = result.comments || [];
        if(page.length){
            ytCommentsData = ytCommentsData.concat(page);
        }
        ytCommentsNextToken = result.nextPageToken || "";
        ytCommentsError = result.error || "";
    }
    catch(e){
        ytCommentsError = "could not load";
        console.warn("YouTube comments load-more failed:", e);
    }

    const container = document.getElementById("comments");
    if(!document.body.contains(container)){
        return;
    }
    ytCommentsLoadingMore = false;
    renderComments();
}


function buildYtComment(c){
    const div = document.createElement("div");
    div.className = "yt-comment";

    const head = document.createElement("div");
    head.className = "yt-comment-head";

    // Only render an avatar when a real thumbnail URL exists (avoids a broken
    // empty-src <img> when the uploader/author has no profile picture).
    if(c.authorThumb){
        const avatar = document.createElement("img");
        avatar.className = "yt-comment-avatar";
        avatar.alt = "";
        avatar.loading = "lazy";
        avatar.src = c.authorThumb;
        head.appendChild(avatar);
    }

    const name = document.createElement("strong");
    name.textContent = c.author || "YouTube user";

    head.appendChild(name);

    const text = document.createElement("p");
    text.className = "yt-comment-text";
    text.textContent = c.text || "";

    const time = document.createElement("span");
    time.className = "yt-comment-time";
    time.textContent = formatCommentTime(c.publishedAt);

    div.appendChild(head);
    div.appendChild(text);
    div.appendChild(time);
    return div;
}


// Friendly, content-visible error state for valid-format but unavailable videos.
function renderYoutubeErrorState(title, text){
    const titleEl = document.getElementById("pageErrorTitle");
    const textEl = document.getElementById("pageErrorText");
    if(titleEl){
        titleEl.textContent = title;
    }
    if(textEl){
        textEl.textContent = text;
    }
    renderErrorState();
}


// ================= VIDEO DETAILS (per-video info) =================


function renderVideoDetails(){
    const v = active;
    const meta = document.getElementById("videoMeta");
    if(meta && v){
        const parts = [];
        if(v.views){
            parts.push(v.views);
        }
        if(v.date){
            parts.push(v.date);
        }
        meta.textContent = parts.join(" • ");
    }
}


// ================= CHANNEL / AVATAR =================


function renderChannel(){
    const v = active;
    const nameEl = document.getElementById("channelName");
    const subsEl = document.getElementById("channelSubs");
    const avatarEl = document.getElementById("channelAvatar");

    if(nameEl && v){
        nameEl.textContent = v.channel;
    }
    if(subsEl && v){
        subsEl.textContent = v.subscribers || "";
    }
    if(avatarEl && v){
        avatarEl.textContent = getInitials(v.channel);
        avatarEl.setAttribute("aria-hidden", "true");
    }
}


// ================= DESCRIPTION EXPAND / COLLAPSE =================


const FULL_DESC_CLASS = "desc-expanded";


// Render the description preserving its original line breaks and making URLs
// clickable, without ever injecting raw API content via innerHTML. We build a
// safe DOM tree: each line becomes its own block, and URLs become <a> links.
function renderDescription(){
    const v = active;
    const box = document.getElementById("descriptionBox");
    const textEl = document.getElementById("descriptionText");
    const toggleBtn = document.getElementById("descToggle");

    if(!box || !textEl || !v){
        return;
    }

    const desc = v.description || "";

    // clear previous content and states
    textEl.replaceChildren();
    box.classList.remove(FULL_DESC_CLASS);

    // Split on newlines so blank lines produce real paragraph/line spacing.
    const lines = desc.split(/\r?\n/);

    lines.forEach((line) => {
        const lineEl = document.createElement("div");
        lineEl.className = "desc-line";
        appendSafeLineContent(lineEl, line);
        textEl.appendChild(lineEl);
    });

    if(lines.length === 0 || (desc.trim() === "")){
        const lineEl = document.createElement("div");
        lineEl.className = "desc-line";
        lineEl.textContent = "No description provided.";
        textEl.appendChild(lineEl);
    }

    // Use character-length heuristics (unchanged behavior) to decide whether to
    // offer the expand/collapse toggle.
    const SHORT_LIMIT = 120;

    if(desc.length <= SHORT_LIMIT){
        box.classList.add("desc-short");
        if(toggleBtn){
            toggleBtn.style.display = "none";
        }
        return;
    }

    box.classList.add("desc-short");

    if(toggleBtn){
        toggleBtn.style.display = "";
        toggleBtn.textContent = "Show more";
        toggleBtn.setAttribute("aria-expanded", "false");
    }
}


// Append the text of one description line as text nodes plus clickable <a>
// elements for http(s) URLs, all created with safe DOM APIs (never innerHTML).
function appendSafeLineContent(lineEl, line){
    const urlRe = /(https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match;

    while((match = urlRe.exec(line)) !== null){
        if(match.index > lastIndex){
            lineEl.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
        }
        const url = match[0];

        // Strip a single trailing punctuation char if it was captured with the URL.
        let cleanUrl = url;
        const lastChar = url.charAt(url.length - 1);
        if(/[.,;:!?)]/.test(lastChar)){
            cleanUrl = url.slice(0, -1);
            if(cleanUrl.length < 8){
                cleanUrl = url;
            }
        }

        const a = document.createElement("a");
        a.href = cleanUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "desc-link";
        a.textContent = cleanUrl.length > 60 ? cleanUrl.slice(0, 60) + "…" : cleanUrl;

        if(cleanUrl !== url){
            const tailIdx = match.index + cleanUrl.length;
            lineEl.appendChild(a);
            lineEl.appendChild(document.createTextNode(line.slice(tailIdx, match.index + url.length)));
            lastIndex = match.index + url.length;
        }
        else{
            lineEl.appendChild(a);
            lastIndex = match.index + url.length;
        }
    }

    if(lastIndex < line.length){
        lineEl.appendChild(document.createTextNode(line.slice(lastIndex)));
    }

    if(lineEl.childNodes.length === 0){
        // blank line / empty segment — keep the vertical spacing with a nbsp
        lineEl.appendChild(document.createTextNode("\u00A0"));
    }
}


function toggleDescription(){
    const box = document.getElementById("descriptionBox");
    const toggleBtn = document.getElementById("descToggle");

    if(!box || !toggleBtn){
        return;
    }

    const expanded = box.classList.toggle(FULL_DESC_CLASS);

    if(toggleBtn){
        toggleBtn.textContent = expanded ? "Show less" : "Show more";
        toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
}


function setupDescriptionToggle(){
    const toggleBtn = document.getElementById("descToggle");
    if(toggleBtn){
        toggleBtn.addEventListener("click", toggleDescription);
    }
}


// ================= RELATED VIDEOS + UP NEXT =================


function pickRelated(max = 6){
    const v = active || current;
    if(!v){
        return [];
    }

    const sameCategory = videos.filter(x => x.id !== v.id && x.category === v.category);

    const fallback = videos.filter(x => x.id !== v.id && x.category !== v.category);

    const all = sameCategory.concat(fallback);

    return all.slice(0, max);
}


// Build one suggested-video list item.
function buildSuggestedItem(v){
    const item = document.createElement("div");
    item.className = "suggest-video";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", "Watch " + v.title);
    item.addEventListener("click", () => { navigateToVideo(v.id); });
    item.addEventListener("keydown", (e) => {
        if(e.key === "Enter" || e.key === " "){
            e.preventDefault();
            navigateToVideo(v.id);
        }
    });

    const img = document.createElement("img");
    img.src = v.thumb;
    img.alt = v.title;

    const info = document.createElement("div");

    const h4 = document.createElement("h4");
    h4.textContent = v.title;

    const p = document.createElement("p");
    p.textContent = v.channel;

    const span = document.createElement("span");
    const metaBits = [];
    if(v.views){
        metaBits.push(v.views);
    }
    if(v.date){
        metaBits.push(v.date);
    }
    span.textContent = metaBits.join(" • ");

    info.appendChild(h4);
    info.appendChild(p);
    info.appendChild(span);

    item.appendChild(img);
    item.appendChild(info);
    return item;
}


function renderSuggestedList(items){
    const listEl = document.getElementById("relatedList");
    if(!listEl){
        return;
    }
    listEl.replaceChildren();
    items.forEach(v => {
        listEl.appendChild(buildSuggestedItem(v));
    });
}


// For local videos: same-category-then-fallback ranking (existing behavior).
function renderRelatedSection(){
    const listEl = document.getElementById("relatedList");
    if(!listEl){
        return;
    }

    if(isYt){
        // Fetch genuinely related YouTube videos via the backend.
        const sourceId = ytSourceId(rawId);
        listEl.replaceChildren();
        const loading = document.createElement("p");
        loading.className = "comment-empty";
        loading.textContent = "Loading related videos...";
        listEl.appendChild(loading);
        loadRelatedFromYouTube(sourceId, listEl);
        return;
    }

    const related = pickRelated(6);
    renderSuggestedList(related);
}


// Phase 7: use the official YouTube API to suggest related/up-next videos.
// On any failure we fall back to the existing local suggestions.
async function loadRelatedFromYouTube(sourceId, listEl){
    let remote = [];
    let apiError = "";
    try{
        const result = await related(sourceId, 12);
        remote = result.videos || [];
        apiError = result.error || "";
    }
    catch(e){
        apiError = "Could not load related videos.";
        console.warn("YouTube related load failed:", e);
    }

    // Guard against the list being replaced/teardown between request and reply.
    if(!listEl || !document.body.contains(listEl)){
        return;
    }

    if(remote.length){
        renderSuggestedList(remote.slice(0, 8));
        return;
    }

    // Fallback to local suggestions (existing behavior).
    const local = pickRelated(6);
    if(local.length){
        renderSuggestedList(local);
    }
    else{
        listEl.replaceChildren();
        const empty = document.createElement("p");
        empty.className = "comment-empty";
        empty.textContent = apiError ? ("Related unavailable: " + apiError) : "No related videos.";
        listEl.appendChild(empty);
    }
}


function navigateToVideo(videoId){
    window.location.href = "watch.html?id=" + videoId;
}


// ================= PREVIOUS / NEXT VIDEO =================


function renderPrevNext(){
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    const idx = getIndexById(rawId);
    const hasPrev = idx > 0;
    const hasNext = idx >= 0 && idx < videos.length - 1;

    if(prevBtn){
        prevBtn.disabled = !hasPrev;
        prevBtn.setAttribute("aria-disabled", hasPrev ? "false" : "true");
    }
    if(nextBtn){
        nextBtn.disabled = !hasNext;
        nextBtn.setAttribute("aria-disabled", hasNext ? "false" : "true");
    }
}


window.prevVideo = function(){
    const idx = getIndexById(rawId);
    if(idx > 0){
        navigateToVideo(videos[idx - 1].id);
    }
};


window.nextVideo = function(){
    const idx = getIndexById(rawId);
    if(idx >= 0 && idx < videos.length - 1){
        navigateToVideo(videos[idx + 1].id);
    }
};


// ================= COMMENTS (localStorage) =================


function commentsKey(videoId){
    return "mytube_comments_" + videoId;
}


function loadComments(videoId){
    try{
        const raw = localStorage.getItem(commentsKey(videoId));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    }
    catch(error){
        console.warn("Failed to load comments:", error);
        return [];
    }
}


function saveComments(videoId, comments){
    localStorage.setItem(commentsKey(videoId), JSON.stringify(comments));
}


// State for the single, merged comments area (YouTube public + MyTube local).
// YouTube public comments are read-only; MyTube comments remain interactive.
let ytCommentsLoading = false;
let ytCommentsError = "";
let ytCommentsData = [];
let ytCommentsSourceId = "";
let ytCommentsNextToken = "";
let ytCommentsLoadingMore = false;

// Firestore-backed MyTube comments for the current video. null means the live
// subscription is not active (loading, failed, or logged-out fallback), in which
// case rendering falls back to the localStorage copy. When active it holds the
// normalized [{id,userId,author,text,timestamp}] list, newest first.
let fsComments = null;
let fsCommentsUnsub = null;
let fsCommentsActiveKey = "";


// MyTube comments for this video: Firestore-first (live), else localStorage.
function getCommentsSource(){
    if(Array.isArray(fsComments)){
        return fsComments.slice();
    }
    return loadComments(storageKey()).slice().sort((a, b) => b.timestamp - a.timestamp);
}


// Subscribe (once per page load) to the Firestore comments for this video.
// Public reads work while logged out; posting still requires a signed-in user.
// The rules deny access when the deployed Firestore rules are not updated yet,
// which is caught by the onSnapshot error callback → localStorage fallback.
function syncFirestoreComments(){
    unsubFirestoreComments();
    const key = storageKey();
    fsCommentsActiveKey = key;
    fsComments = null;
    try{
        fsCommentsUnsub = subscribeComments(key, (list) => {
            if(fsCommentsActiveKey !== key){
                return; // stale callback from a previous video — ignore
            }
            if(Array.isArray(list)){
                fsComments = list;
            }
            else{
                fsComments = null; // subscription failed → localStorage fallback
            }
            renderComments();
        });
    }
    catch(e){
        console.warn("Failed to start Firestore comment subscription:", e);
        fsComments = null;
    }
}


function unsubFirestoreComments(){
    if(fsCommentsUnsub){
        try{
            fsCommentsUnsub();
        }
        catch(e){ /* ignore */ }
        fsCommentsUnsub = null;
    }
    fsComments = null;
    fsCommentsActiveKey = "";
}


window.addEventListener("pagehide", () => {
    unsubFirestoreComments();
});


function renderComments(){
    const container = document.getElementById("comments");
    const countEl = document.getElementById("commentCount");

    if(!container){
        return;
    }

    // For YouTube videos, public comments (async) and MyTube comments are shown
    // together in this one section, clearly distinguished by sub-headings.
    if(isYt){
        renderMergedComments(container, countEl);
        return;
    }

    // --- local/MyTube path (local MP4 videos) ---
    const sorted = getCommentsSource().sort((a, b) => b.timestamp - a.timestamp);

    if(countEl){
        countEl.textContent = `Comments (${sorted.length})`;
    }

    container.replaceChildren();

    if(sorted.length === 0){
        const empty = document.createElement("p");
        empty.className = "comment-empty";
        empty.textContent = "No comments yet. Be the first to comment!";
        container.appendChild(empty);
        return;
    }

    sorted.forEach(comment => {
        container.appendChild(buildLocalCommentNode(comment));
    });
}


// One merged comments area for YouTube videos: real public YouTube comments
// (read-only) plus the user's MyTube comments (interactive), both clearly
// labeled instead of being split into separate duplicate sections.
function renderMergedComments(container, countEl){
    const local = getCommentsSource().sort((a, b) => b.timestamp - a.timestamp);
    const publicList = ytCommentsData;

    // Prefer the real total comment count from statistics.commentCount when the
    // API provides it; otherwise report the number of public comments we loaded.
    const publicTotal = (active && typeof active.commentCount === "number" && active.commentCount >= 0)
        ? active.commentCount
        : publicList.length;
    const total = local.length + publicTotal;

    if(countEl){
        countEl.textContent = `Comments (${total})`;
    }

    container.replaceChildren();

    if(ytCommentsLoading && ytCommentsData.length === 0){
        const p = document.createElement("p");
        p.className = "comment-empty";
        p.textContent = "Loading comments...";
        container.appendChild(p);
        return;
    }

    // Public YouTube comments (read-only). Shown directly under the single
    // "Comments (n)" heading. A sub-heading is only added when MyTube comments
    // also exist, so we can tell them apart without creating a second section.
    if(publicList.length){
        if(local.length){
            const heading = document.createElement("h4");
            heading.className = "comments-subheading";
            heading.textContent = "Public YouTube comments";
            container.appendChild(heading);
        }
        publicList.forEach(c => {
            container.appendChild(buildYtComment(c));
        });
    }

    // MyTube comments (interactive) share the same single area. A sub-heading is
    // shown only when public YouTube comments are also present, so the two kinds
    // are distinguishable without a second comments section.
    if(local.length){
        if(publicList.length){
            const heading = document.createElement("h4");
            heading.className = "comments-subheading";
            heading.textContent = "MyTube comments";
            container.appendChild(heading);
        }
        local.forEach(comment => {
            container.appendChild(buildLocalCommentNode(comment));
        });
    }

    if(publicList.length && ytCommentsNextToken){
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "load-more comment-load-more";
        moreBtn.textContent = ytCommentsLoadingMore ? "Loading..." : "Load more comments";
        moreBtn.disabled = ytCommentsLoadingMore;
        moreBtn.addEventListener("click", (e) => {
            e.preventDefault();
            loadMoreYtComments();
        });
        container.appendChild(moreBtn);
    }

    // Truthful fallback when no public or local comments are available.
    if(local.length === 0 && publicList.length === 0){
        const empty = document.createElement("p");
        empty.className = "comment-empty";
        empty.textContent = ytCommentsError
            ? "No public or MyTube comments to show."
            : "No comments yet. Be the first to comment!";
        container.appendChild(empty);
    }
}


// Build one interactive MyTube comment node (with delete when owned by the user).
function buildLocalCommentNode(comment){
    const div = document.createElement("div");
    div.className = "comment";
    div.setAttribute("data-comment-id", comment.id);

    const head = document.createElement("div");
    head.className = "comment-head";

    const author = document.createElement("strong");
    author.textContent = comment.author || "Anonymous";

    head.appendChild(author);

    // Ownership is by the authenticated user's UID (comment.userId),
    // NOT by display name. Legacy comments without a userId can never be
    // deleted (we cannot prove ownership), and they are rendered safely.
    const uid = currentUserId();
    if(uid && comment.userId && comment.userId === uid){
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "comment-delete";
        delBtn.textContent = "Delete";
        delBtn.setAttribute("aria-label", "Delete your comment");
        delBtn.addEventListener("click", () => {
            deleteComment(comment.id);
        });
        head.appendChild(delBtn);
    }

    const text = document.createElement("p");
    text.className = "comment-text";
    text.textContent = comment.text;

    const time = document.createElement("span");
    time.className = "comment-time";
    time.textContent = formatCommentTime(comment.timestamp);

    div.appendChild(head);
    div.appendChild(text);
    div.appendChild(time);

    return div;
}


function addComment(text){
    const uid = currentUserId();
    if(!uid){
        return false;
    }

    const name = currentUserName() || "User";

    // Firestore-first when the live subscription for this video is active.
    // Optimistically append a temp comment; the onSnapshot refresh replaces it
    // with the server copy once the write lands.
    if(Array.isArray(fsComments)){
        const tmpId = "tmp_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        const optimistic = {
            id: tmpId,
            userId: uid,
            text: text,
            author: name,
            timestamp: Date.now()
        };
        fsComments = [optimistic].concat(fsComments.filter(c => c.id !== tmpId));
        renderComments();

        addCommentToStore(storageKey(), {
            userId: uid,
            text: text,
            author: name
        }).then(res => {
            if(res){
                return; // onSnapshot will refresh the list with the real doc.
            }
            // Firestore write failed (e.g. deployed rules not updated yet) →
            // persist locally instead so the comment is not lost.
            const localComments = loadComments(storageKey());
            localComments.push({
                id: "c_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
                userId: uid,
                text: text,
                author: name,
                timestamp: Date.now()
            });
            saveComments(storageKey(), localComments);
            fsComments = null; // revert this video to the localStorage source
            renderComments();
        });
        return true;
    }

    // Fallback: localStorage-aligned path.
    const comments = loadComments(storageKey());
    const newComment = {
        id: "c_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        userId: uid,
        text: text,
        author: name,
        timestamp: Date.now()
    };

    comments.push(newComment);
    saveComments(storageKey(), comments);
    renderComments();
    return true;
}


function deleteComment(commentId){
    const uid = currentUserId();
    if(!uid){
        return;
    }

    // Firestore-first: remove the comment doc; onSnapshot refreshes the list.
    if(Array.isArray(fsComments)){
        const target = fsComments.find(c => c.id === commentId);
        if(!target || target.userId !== uid){
            return;
        }
        const wasRemote = !String(commentId).startsWith("tmp_");
        if(wasRemote){
            removeCommentById(commentId).then(ok => {
                if(ok){
                    return; // onSnapshot will refresh
                }
                // Firestore delete failed → remove from localStorage as fallback.
                const comments = loadComments(storageKey()).filter(c => c.id !== commentId);
                saveComments(storageKey(), comments);
            });
        }
        fsComments = fsComments.filter(c => c.id !== commentId);
        renderComments();
        return;
    }

    // Only remove the comment that belongs to the current user.
    const comments = loadComments(storageKey()).filter(c => c.id !== commentId || c.userId !== uid);
    saveComments(storageKey(), comments);
    renderComments();
}


// ================= COMMENT FORM =================


function setupCommentForm(){
    const form = document.getElementById("commentForm");
    const input = document.getElementById("commentInput");
    const msg = document.getElementById("commentAuthMsg");
    const submit = form ? form.querySelector(".comment-submit") : null;

    if(!form || !input){
        return;
    }

    // wire the submit listener exactly once
    if(!form.dataset.commentWired){
        form.dataset.commentWired = "1";
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            let text = input.value.trim();
            if(!text){
                return;
            }
            // Hard cap even if the browser maxlength is bypassed.
            if(text.length > 2000){
                text = text.slice(0, 2000);
            }
            const added = addComment(text);
            if(added){
                input.value = "";
            }
            else{
                // success path only clears input; preserve the typed draft.
                input.focus();
            }
        });
    }

    if(!currentUserName()){
        input.disabled = true;
        input.setAttribute("disabled", "disabled");
        if(submit){
            submit.disabled = true;
            submit.setAttribute("disabled", "disabled");
        }
        if(msg){
            msg.textContent = "Please log in to comment.";
        }
        return;
    }

    input.disabled = false;
    input.removeAttribute("disabled");
    if(submit){
        submit.disabled = false;
        submit.removeAttribute("disabled");
    }

    if(msg){
        msg.textContent = "Commenting as " + currentUserName();
    }
}


// ================= PLAYER CONTROLS =================


// Keep the custom play/pause button in sync with the real player state.
// Previously the button was a static "▶" that never reflected playback.
function syncPlayButton(){
    const btn = document.getElementById("playBtn");
    if(!btn){
        return;
    }
    const paused = !video || video.paused;
    btn.textContent = paused ? "▶" : "⏸";
    btn.setAttribute("aria-label", paused ? "Play" : "Pause");
    btn.setAttribute("aria-pressed", paused ? "false" : "true");
}


// Restore playback position from watch history (stored as a 0-100 percentage)
// for local videos. YouTube embeds are not resumed (no JS API wired).
async function maybeResumePlayback(){
    if(isYt || !video || !video.duration || video.dataset.resumeDone === "1"){
        return;
    }
    const uid = uidOrNull();
    if(!uid){
        return;
    }
    const videoId = (current && current.id) || storageKey();
    try{
        const items = await getHistory(uid, 25);
        const entry = items.find(i =>
            i.videoId === videoId &&
            typeof i.progress === "number" &&
            i.progress > 1
        );
        if(!entry){
            return;
        }
        // Never resume at the very end of a video — treat "finished" as done.
        const pct = Math.min(entry.progress, 98);
        const target = (pct / 100) * video.duration;
        if(isFinite(target) && target > 1){
            video.dataset.resumeDone = "1";
            video.currentTime = target;
            renderTimeDisplay();
        }
    }
    catch(e){
        console.warn("Resume lookup failed:", e);
    }
}


function setupPlayerControls(){
    if(!video){
        return;
    }

    syncPlayButton();

    const progress = document.getElementById("progress");
    const volume = document.getElementById("volume");
    const speed = document.getElementById("speed");

    video.addEventListener("play", syncPlayButton);
    video.addEventListener("pause", syncPlayButton);

    // Auto-advance to the next local video when the current one ends.
    video.addEventListener("ended", () => {
        const idx = getIndexById(rawId);
        if(idx >= 0 && idx < videos.length - 1){
            navigateToVideo(videos[idx + 1].id);
        }
    });

    video.addEventListener("timeupdate", () => {
        if(progress && video.duration){
            progress.value = (video.currentTime / video.duration) * 100;
        }
    });

    if(progress){
        progress.oninput = function(){
            if(video.duration){
                video.currentTime = (video.duration * this.value) / 100;
            }
        };
    }

    if(volume){
        volume.oninput = function(){
            video.volume = Number(this.value);
            // Raising volume above zero restores sound (syncs mute state).
            if(Number(this.value) > 0 && video.muted){
                video.muted = false;
                renderMute();
            }
        };
        video.addEventListener("volumechange", () => {
            // Keep the slider in sync with the actual volume level.
            if(!video.muted){
                volume.value = video.volume;
            }
        });
    }

    if(speed){
        speed.onchange = function(){
            video.playbackRate = Number(this.value);
        };
    }
}


window.playPause = function(){
    if(!video) return;
    if(video.paused){
        video.play().catch(error => {
            console.log("Play error:", error);
        });
    }
    else{
        video.pause();
    }
    syncPlayButton();
};


window.muteVideo = function(){
    if(!video){
        return;
    }
    video.muted = !video.muted;
    renderMute();
};


function renderMute(){
    if(!video){
        return;
    }
    const muteBtn = document.getElementById("muteBtn");
    if(muteBtn){
        const muted = video.muted;
        muteBtn.textContent = muted ? "🔇" : "🔊";
        muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
        muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
    }
}


window.fullscreen = function(){
    const box = document.querySelector(".video-box");
    if(!box) return;

    if(!document.fullscreenElement){
        if(box.requestFullscreen){
            box.requestFullscreen();
        }
        else if(box.webkitRequestFullscreen){
            box.webkitRequestFullscreen();
        }
    }
    else{
        document.exitFullscreen();
    }
};


// ================= KEYBOARD SHORTCUTS =================


function isEditableTarget(el){
    if(!el){
        return false;
    }
    const tag = el.tagName && el.tagName.toLowerCase();
    if(tag === "input" || tag === "textarea" || tag === "select"){
        return true;
    }
    if(el.isContentEditable){
        return true;
    }
    return false;
}


const SEEK_AMOUNT = 10;


function handlePlayerKeydown(e){
    if(isEditableTarget(e.target)){
        return;
    }

    const key = e.key;
    const handler = {
        " ": toggleShortcut,
        "k": toggleShortcut,
        "K": toggleShortcut,
        "m": () => muteVideo(),
        "M": () => muteVideo(),
        "f": () => fullscreen(),
        "F": () => fullscreen(),
        "j": () => seekShortcut(-SEEK_AMOUNT),
        "J": () => seekShortcut(-SEEK_AMOUNT),
        "l": () => seekShortcut(SEEK_AMOUNT),
        "L": () => seekShortcut(SEEK_AMOUNT),
        "ArrowLeft": () => seekShortcut(-SEEK_AMOUNT),
        "ArrowRight": () => seekShortcut(SEEK_AMOUNT)
    };

    let fn = handler[key];
    if(!fn){
        return;
    }

    // Avoid hijacking Space when a button is focused but not mid-edit.
    e.preventDefault();
    fn();
}


function toggleShortcut(){
    if(!video){
        return;
    }
    if(video.paused){
        video.play().catch(error => {
            console.log("Play error:", error);
        });
    }
    else{
        video.pause();
    }
    syncPlayButton();
}


function seekShortcut(amount){
    if(!video){
        return;
    }
    if(!video.duration || !isFinite(video.duration)){
        return;
    }
    const next = Math.min(Math.max(video.currentTime + amount, 0), video.duration);
    video.currentTime = next;
}


function setupKeyboardShortcuts(){
    document.addEventListener("keydown", handlePlayerKeydown);
}


// ================= ACTIONS (LIKE / DISLIKE / SHARE / SAVE / SUBSCRIBE) =================


const likeBtn = document.getElementById("likeBtn");
const dislikeBtn = document.getElementById("dislikeBtn");
const shareBtn = document.getElementById("shareBtn");
const saveBtn = document.getElementById("saveBtn");
const subscribeBtn = document.getElementById("subscribeBtn");
const actionMsg = document.getElementById("actionMsg");


// Toast-style feedback for the action row. Defined here (it was previously
// called but never implemented) and auto-cleared so repeated actions always
// surface the latest message.
let actionMsgTimer = null;
function setActionMsg(text){
    if(!actionMsg){
        return;
    }
    actionMsg.textContent = text || "";
    clearTimeout(actionMsgTimer);
    actionMsgTimer = setTimeout(() => {
        actionMsg.textContent = "";
    }, 3000);
}


let isLiked = false;
let isDisliked = false;
let isSaved = false;
let isSubscribed = false;
let currentSubCount = "";


// ================= LIKE / DISLIKE (local per-video persistence) =================
// State is stored per video keyed by the stable video id (see videoKey), so legacy
// numeric ?id=<n> URLs still resolve to the same storage slot as their string id.
// Counts are local/demo approximations, not server-wide YouTube figures.

// Base demo counts derived from the dataset; the user's own +1 is applied locally.
const baseLikeCount = Math.max(1, Math.round((current ? (current.viewCount || 1000) : 1000) / 100));
const baseDislikeCount = Math.max(0, Math.round(baseLikeCount / 25));

const likeStateKey = () => "mytube_like_state_" + storageKey();
const likeCountKey = () => "mytube_like_count_" + storageKey();
const dislikeStateKey = () => "mytube_dislike_state_" + storageKey();
const dislikeCountKey = () => "mytube_dislike_count_" + storageKey();

// The state is one of "neutral" | "liked" | "disliked" (mutually exclusive).
let voteState = "neutral";
// Actual stored counts include the user's own contribution.
let storedLikeCount = baseLikeCount;
let storedDislikeCount = baseDislikeCount;


function restoreVoteState(){
    try{
        const likeState = localStorage.getItem(likeStateKey());
        const dislikeState = localStorage.getItem(dislikeStateKey());
        if(likeState === "1"){
            voteState = "liked";
        }
        else if(dislikeState === "1"){
            voteState = "disliked";
        }
        else{
            voteState = "neutral";
        }

        const likeRaw = parseInt(localStorage.getItem(likeCountKey()), 10);
        const dislikeRaw = parseInt(localStorage.getItem(dislikeCountKey()), 10);
        storedLikeCount = Number.isFinite(likeRaw) && likeRaw >= 0 ? likeRaw : baseLikeCount;
        storedDislikeCount = Number.isFinite(dislikeRaw) && dislikeRaw >= 0 ? dislikeRaw : baseDislikeCount;
    }
    catch(error){
        console.warn("Failed to restore like/dislike state:", error);
        voteState = "neutral";
    }

    isLiked = voteState === "liked";
    isDisliked = voteState === "disliked";
    renderLikeDislike();
}


function persistVoteState(){
    try{
        localStorage.setItem(likeStateKey(), isLiked ? "1" : "0");
        localStorage.setItem(dislikeStateKey(), isDisliked ? "1" : "0");
        localStorage.setItem(likeCountKey(), String(storedLikeCount));
        localStorage.setItem(dislikeCountKey(), String(storedDislikeCount));
    }
    catch(error){
        console.warn("Failed to save like/dislike state:", error);
    }
}


function formatCount(n){
    if(n >= 1000000){
        return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    }
    if(n >= 1000){
        return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    }
    return String(n);
}


function renderLikeDislike(){
    // For YouTube videos the Like button shows the real public like count
    // (statistics.likeCount) from the API — no invented count and no duplicate
    // stats row. Local videos keep their existing counts.
    if(likeBtn){
        likeBtn.classList.toggle("active", isLiked);
        likeBtn.textContent = isYt
            ? "👍 " + (isLiked ? "Liked" : "Like") + ytLikeCountSuffix()
            : "👍 " + (isLiked ? "Liked" : "Like") + " " + formatCount(storedLikeCount);
        likeBtn.setAttribute("aria-pressed", isLiked ? "true" : "false");
    }
    if(dislikeBtn){
        dislikeBtn.classList.toggle("active", isDisliked);
        // YouTube's public Data API does not expose dislike counts, so the
        // Dislike control is shown truthfully with no fake number.
        dislikeBtn.textContent = isYt
            ? "👎 " + (isDisliked ? "Disliked" : "Dislike")
            : "👎 " + (isDisliked ? "Disliked" : "Dislike") + " " + formatCount(storedDislikeCount);
        dislikeBtn.setAttribute("aria-pressed", isDisliked ? "true" : "false");
    }
}


// Real public YouTube like count (statistics.likeCount), truthful or omitted.
function ytLikeCountSuffix(){
    const v = active;
    if(!isYt || !v || typeof v.likeCount !== "number" || v.likeCount < 0){
        return "";
    }
    return " " + formatCount(v.likeCount);
}


function setVote(next){
    // next: "like" | "dislike"
    const wasLiked = voteState === "liked";
    const wasDisliked = voteState === "disliked";

    // Restore base counts before reapplying, so switching like->dislike does not
    // double-count or permanently skew the numbers across repeated toggles.
    storedLikeCount = baseLikeCount;
    storedDislikeCount = baseDislikeCount;

    if(next === "like"){
        // Neutral -> Liked, or Disliked -> Liked, or Liked -> Neutral (toggle off).
        isLiked = !wasLiked;
        isDisliked = false;
        voteState = wasLiked ? "neutral" : "liked";
    }
    else{
        // Neutral -> Disliked, or Liked -> Disliked, or Disliked -> Neutral (toggle off).
        isDisliked = !wasDisliked;
        isLiked = false;
        voteState = wasDisliked ? "neutral" : "disliked";
    }

    if(voteState === "liked"){
        storedLikeCount += 1;
    }
    else if(voteState === "disliked"){
        storedDislikeCount += 1;
    }

    persistVoteState();
    renderLikeDislike();

    // Persist liked state to Firestore when logged in. Any state other than
    // "liked" (neutral OR disliked) must clear the Firestore record, otherwise
    // switching a previously-liked video to Dislike leaves a stale entry in
    // the Liked Videos library. deleteDoc on a missing doc is a no-op.
    const uid = uidOrNull();
    if(uid && active){
        if(voteState === "liked"){
            addToLiked(uid, {
                videoId: active.id || storageKey(),
                type: isYt ? "youtube" : "local",
                title: active.title || "",
                thumb: active.thumb || "",
                channel: active.channel || "",
                views: active.views || "",
                duration: active.time || "",
                likeCount: active.likeCount || 0
            });
        }
        else{
            removeFromLiked(uid, active.id || storageKey());
        }
    }
}


function setupVoteButtons(){
    if(likeBtn){
        likeBtn.onclick = function(){
            setVote("like");
        };
    }
    if(dislikeBtn){
        dislikeBtn.onclick = function(){
            setVote("dislike");
        };
    }
}


if(shareBtn){
    shareBtn.onclick = async function(){
        const shareTitle = active ? active.title : (current ? current.title : "MyTube");
        // For YouTube videos share the real YouTube URL, not the MyTube page.
        const shareUrl = isYt
            ? "https://www.youtube.com/watch?v=" + encodeURIComponent(ytSourceId(rawId))
            : window.location.href;
        const shareData = {
            title: shareTitle,
            url: shareUrl
        };
        try{
            if(navigator.share){
                await navigator.share(shareData);
                setActionMsg("Shared ✅");
            }
            else{
                await navigator.clipboard.writeText(shareUrl);
                setActionMsg("Link copied to clipboard ✅");
            }
        }
        catch(error){
            // User cancelling the native share sheet is not a failure.
            if(error && (error.name === "AbortError" || error.name === "NotAllowedError")){
                return;
            }
            setActionMsg("Sharing failed");
        }
    };
}


// ================= SAVE =================


const saveKey = () => "mytube_saved_" + storageKey();
isSaved = localStorage.getItem(saveKey()) === "1";


function renderSave(){
    if(!saveBtn) return;
    saveBtn.classList.toggle("active", isSaved);
    saveBtn.textContent = isSaved ? "💾 Saved" : "💾 Save";
    saveBtn.setAttribute("aria-pressed", isSaved ? "true" : "false");
}


if(saveBtn){
    saveBtn.onclick = function(){
        isSaved = !isSaved;
        if(isSaved){
            localStorage.setItem(saveKey(), "1");
        }
        else{
            localStorage.removeItem(saveKey());
        }
        renderSave();
        // Persist to Firestore when logged in.
        const uid = uidOrNull();
        if(uid && active){
            if(isSaved){
                addToSaved(uid, {
                    videoId: active.id || storageKey(),
                    type: isYt ? "youtube" : "local",
                    title: active.title || "",
                    thumb: active.thumb || "",
                    channel: active.channel || "",
                    views: active.views || "",
                    duration: active.time || ""
                });
            }
            else{
                removeFromSaved(uid, active.id || storageKey());
            }
        }
    };
}


// ================= SUBSCRIBE =================

// Per-channel subscription state: each channel has its own key so that
// subscribing to one channel does not affect another.
function subscribedChannel(){
    const v = active || current;
    return v ? (v.channel || "") : "";
}

// Recompute subscription state for the currently active video/channel.
function refreshSubscribeState(){
    isSubscribed = localStorage.getItem("mytube_subscribed_" + subscribedChannel()) === "1";
    renderSubscribe();
}

const subscribeKey = () => "mytube_subscribed_" + subscribedChannel();
isSubscribed = localStorage.getItem(subscribeKey()) === "1";


function renderSubscribe(){
    if(!subscribeBtn) return;
    subscribeBtn.classList.toggle("active", isSubscribed);
    subscribeBtn.textContent = isSubscribed ? "Subscribed" : "Subscribe";
    subscribeBtn.setAttribute("aria-pressed", isSubscribed ? "true" : "false");
}


if(subscribeBtn){
    subscribeBtn.onclick = function(){
        const v = active || current;
        if(!v){
            return;
        }
        const uid = uidOrNull();
        if(!uid){
            setActionMsg("Please log in to subscribe.");
            return;
        }
        isSubscribed = !isSubscribed;
        if(isSubscribed){
            localStorage.setItem(subscribeKey(), "1");
        }
        else{
            localStorage.removeItem(subscribeKey());
        }
        renderSubscribe();
        // Persist to Firestore.
        if(isSubscribed){
            addSubscription(uid, {
                channelId: v.channelId || "",
                channelName: v.channel || "",
                channelThumb: v.channelThumb || "",
                subscriberCount: v.subscribers || ""
            });
        }
        else{
            removeSubscription(uid, v.channelId || "", v.channel || "");
        }
    };
}


// ================= PLAYLISTS (ADD TO PLAYLIST) =================
// Playlists live per-user in Firestore only (no localStorage fallback for this
// feature). The watch-page popover lets a logged-in user create a playlist and
// add/remove the current video.

const playlistBtn = document.getElementById("playlistBtn");
const playlistPopover = document.getElementById("playlistPopover");
const playlistChoices = document.getElementById("playlistChoices");
const playlistNewName = document.getElementById("playlistNewName");
const playlistCreateBtn = document.getElementById("playlistCreateBtn");
const playlistMsg = document.getElementById("playlistMsg");

let cachedPlaylists = null;

function setPlaylistMsg(text){
    if(playlistMsg){
        playlistMsg.textContent = text || "";
    }
}

function currentPlaylistEntry(){
    const v = active || current;
    if(!v){
        return null;
    }
    return {
        videoId: v.id || storageKey(),
        type: isYt ? "youtube" : "local",
        title: v.title || "",
        thumb: v.thumb || "",
        channel: v.channel || "",
        views: v.views || "",
        duration: v.time || ""
    };
}

async function loadPlaylists(){
    const uid = uidOrNull();
    if(!uid){
        return [];
    }
    if(cachedPlaylists !== null){
        return cachedPlaylists;
    }
    cachedPlaylists = await getPlaylists(uid);
    return cachedPlaylists;
}

function emptyPlaylistChoices(message){
    if(!playlistChoices){
        return;
    }
    playlistChoices.replaceChildren();
    const p = document.createElement("p");
    p.className = "comment-empty";
    p.textContent = message;
    playlistChoices.appendChild(p);
}

async function renderPlaylistChoices(){
    if(!playlistChoices){
        return;
    }
    const uid = uidOrNull();
    const entry = currentPlaylistEntry();
    if(!uid){
        emptyPlaylistChoices("Log in to use playlists.");
        return;
    }
    if(!entry){
        emptyPlaylistChoices("No video to add yet.");
        return;
    }

    emptyPlaylistChoices("Loading playlists...");
    const playlists = await loadPlaylists();
    if(!playlists.length){
        emptyPlaylistChoices("No playlists yet — create one below.");
        return;
    }

    // Determine membership for this video across all playlists in parallel.
    const membership = {};
    await Promise.all(playlists.map(async (pl) => {
        const items = await getPlaylistItems(uid, pl.id);
        membership[pl.id] = items.some(item => (item.videoId || item.id) === entry.videoId);
    }));

    playlistChoices.replaceChildren();
    playlists.forEach((pl) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "playlist-choice";
        row.setAttribute("aria-pressed", membership[pl.id] ? "true" : "false");
        const label = () => (row.getAttribute("aria-pressed") === "true" ? "✓ " : "+ ") + (pl.name || "Untitled playlist");
        row.textContent = label();
        row.onclick = async () => {
            row.disabled = true;
            const has = row.getAttribute("aria-pressed") === "true";
            const ok = has
                ? await removeFromPlaylist(uid, pl.id, entry.videoId)
                : await addToPlaylist(uid, pl.id, entry);
            row.disabled = false;
            if(ok){
                const nowIn = !has;
                row.setAttribute("aria-pressed", nowIn ? "true" : "false");
                row.textContent = label();
                setPlaylistMsg((nowIn ? "Added to " : "Removed from ") + (pl.name || "playlist"));
            }
            else{
                setPlaylistMsg("Could not update the playlist — check your connection.");
            }
        };
        playlistChoices.appendChild(row);
    });
}

async function handleCreatePlaylist(){
    const uid = uidOrNull();
    const entry = currentPlaylistEntry();
    if(!uid){
        setActionMsg("Please log in to use playlists.");
        return;
    }
    if(!entry){
        return;
    }
    const name = (playlistNewName ? playlistNewName.value : "").trim();
    if(!name){
        setPlaylistMsg("Enter a playlist name first.");
        if(playlistNewName){
            playlistNewName.focus();
        }
        return;
    }
    if(playlistCreateBtn){
        playlistCreateBtn.disabled = true;
    }
    const playlistId = await createPlaylist(uid, name);
    cachedPlaylists = null;
    if(playlistNewName){
        playlistNewName.value = "";
    }
    if(!playlistId){
        if(playlistCreateBtn){
            playlistCreateBtn.disabled = false;
        }
        setPlaylistMsg("Could not create that playlist.");
        return;
    }
    const added = await addToPlaylist(uid, playlistId, entry);
    if(playlistCreateBtn){
        playlistCreateBtn.disabled = false;
    }
    setPlaylistMsg(added
        ? "Playlist \"" + name + "\" created and this video was added."
        : "Playlist created, but adding this video failed.");
    renderPlaylistChoices();
}

async function openPlaylistPopover(){
    if(!playlistPopover){
        return;
    }
    playlistPopover.style.display = "block";
    if(playlistBtn){
        playlistBtn.setAttribute("aria-expanded", "true");
    }
    setPlaylistMsg("");
    await renderPlaylistChoices();
    const firstChoice = playlistChoices ? playlistChoices.querySelector("button") : null;
    if(firstChoice){
        firstChoice.focus();
    }
    else if(playlistNewName){
        playlistNewName.focus();
    }
}

function closePlaylistPopover(){
    if(!playlistPopover){
        return;
    }
    playlistPopover.style.display = "none";
    if(playlistBtn){
        playlistBtn.setAttribute("aria-expanded", "false");
    }
    setPlaylistMsg("");
}

function togglePlaylistPopover(){
    if(playlistPopover && playlistPopover.style.display === "block"){
        closePlaylistPopover();
        return;
    }
    if(!uidOrNull()){
        setActionMsg("Please log in to use playlists.");
        return;
    }
    openPlaylistPopover();
}

function setupPlaylistUI(){
    if(playlistBtn){
        playlistBtn.onclick = togglePlaylistPopover;
    }
    if(playlistCreateBtn){
        playlistCreateBtn.onclick = handleCreatePlaylist;
    }
    if(playlistNewName){
        playlistNewName.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){
                e.preventDefault();
                handleCreatePlaylist();
            }
        });
    }
    // Close on Escape or when clicking/tapping outside the popover.
    document.addEventListener("keydown", (e) => {
        if(e.key === "Escape"){
            closePlaylistPopover();
        }
    });
    document.addEventListener("click", (e) => {
        if(playlistPopover && playlistBtn
            && playlistPopover.style.display === "block"
            && !playlistPopover.contains(e.target)
            && !playlistBtn.contains(e.target)){
            closePlaylistPopover();
        }
    });
}


// ================= WATCH HISTORY =================
// Records video views to Firestore when logged in. Debounced to avoid
// excessive writes — a new record is created or updated at most once per
// 30-second window. Progress is tracked for local videos.

let historyTimer = null;
const HISTORY_DEBOUNCE_MS = 30000;

function recordHistory(){
    const uid = uidOrNull();
    if(!uid){
        return;
    }
    const v = active;
    if(!v){
        return;
    }
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
        const progress = (!isYt && video && video.duration)
            ? Math.round((video.currentTime / video.duration) * 100)
            : 0;
        addToHistory(uid, {
            videoId: v.id || storageKey(),
            type: isYt ? "youtube" : "local",
            title: v.title || "",
            thumb: v.thumb || "",
            channel: v.channel || "",
            duration: v.time || "",
            progress: progress
        });
    }, HISTORY_DEBOUNCE_MS);
}


// ================= FIRESTORE SYNC HELPERS =================
// When logged in, write to both Firestore and localStorage for resilience.
// When logged out, localStorage only (existing behavior).

function uidOrNull(){
    const user = auth && auth.currentUser;
    return user ? user.uid : null;
}


// ================= INIT =================

window.addEventListener("DOMContentLoaded", () => {
    renderLoadingState();
    setupPlayerControls();
    setupDescriptionToggle();
    restoreVoteState();
    setupVoteButtons();
    renderSave();
    renderSubscribe();
    setupPlaylistUI();
    setupCommentForm();
    renderMute();
    renderPrevNext();
    setupKeyboardShortcuts();
    renderTimeDisplay();
    loadVideo();
    recordHistory();
});


window.addEventListener("mytube-auth-change", () => {
    // A YouTube video has `active` populated but `current` is null, so we must
    // NOT key off `current` here — otherwise the comment form would never
    // refresh its logged-in state while watching a YouTube video.
    if(!active && !current){
        return;
    }
    setupCommentForm();
    renderComments();
    // Record history now that we know the auth state.
    recordHistory();
    // Sync save/like/subscribe state from Firestore.
    syncStateFromFirestore();
});


// When the user logs in, mirror Firestore state (save/like/subscribe) into
// localStorage so the existing buttons reflect the persisted state immediately.
// If Firestore has no record but localStorage does, migrate the local value up
// so previously-saved/subscribed/liked items are preserved across devices.
async function syncStateFromFirestore(){
    const uid = uidOrNull();
    if(!uid || !active){
        return;
    }
    const v = active;
    const videoId = v.id || storageKey();
    try{
        const [saved, liked, subscribed] = await Promise.all([
            isSavedVideo(uid, videoId),
            isLikedVideo(uid, videoId),
            isSubscribedByChannel(uid, v.channelId || "", v.channel || "")
        ]);

        // --- SAVED ---
        const localSaved = localStorage.getItem(saveKey()) === "1";
        if(saved === true){
            isSaved = true;
            localStorage.setItem(saveKey(), "1");
        }
        else if(saved === false && localSaved){
            // Migrate legacy local save to Firestore.
            addToSaved(uid, {
                videoId: videoId,
                type: isYt ? "youtube" : "local",
                title: v.title || "",
                thumb: v.thumb || "",
                channel: v.channel || "",
                views: v.views || "",
                duration: v.time || ""
            });
        }
        else if(saved !== null){
            isSaved = localSaved;
            if(!isSaved){
                localStorage.removeItem(saveKey());
            }
        }
        renderSave();

        // --- LIKED ---
        const localLiked = localStorage.getItem(likeStateKey()) === "1";
        if(liked === true){
            if(voteState !== "liked"){
                voteState = "liked";
                isLiked = true;
                localStorage.setItem(likeStateKey(), "1");
            }
        }
        else if(liked === false && localLiked){
            // Migrate legacy local like to Firestore.
            addToLiked(uid, {
                videoId: videoId,
                type: isYt ? "youtube" : "local",
                title: v.title || "",
                thumb: v.thumb || "",
                channel: v.channel || "",
                views: v.views || "",
                duration: v.time || "",
                likeCount: v.likeCount || 0
            });
            voteState = "liked";
            isLiked = true;
        }
        else if(liked !== null){
            voteState = localLiked ? "liked" : "neutral";
            isLiked = voteState === "liked";
            isDisliked = false;
            localStorage.setItem(likeStateKey(), isLiked ? "1" : "0");
        }
        renderLikeDislike();

        // --- SUBSCRIBED ---
        const localSub = localStorage.getItem(subscribeKey()) === "1";
        if(subscribed === true){
            isSubscribed = true;
            localStorage.setItem(subscribeKey(), "1");
        }
        else if(subscribed === false && localSub){
            // Migrate legacy local subscription to Firestore.
            addSubscription(uid, {
                channelId: v.channelId || "",
                channelName: v.channel || "",
                channelThumb: v.channelThumb || "",
                subscriberCount: v.subscribers || ""
            });
        }
        else if(subscribed !== null){
            isSubscribed = localSub;
        }
        renderSubscribe();
    }
    catch(e){
        console.warn("Failed to sync state from Firestore:", e);
    }
}


console.log("MyTube Watch JS Loaded ✅");
