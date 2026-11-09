// ================= FIREBASE AUTH =================
import { auth } from "./firebase.js";

// ================= PHASE 7: YOUTUBE CLIENT =================
import { getVideo, related, channel, comments, liveChat } from "./youtube.js";

// ================= FIRESTORE DATA LAYER =================
import {
    getSubscriptions, addSubscription, removeSubscription, isSubscribedByChannel,
    addToHistory,
    getSaved as fsGetSaved, addToSaved, removeFromSaved, isSavedVideo,
    getLiked as fsGetLiked, addToLiked, removeFromLiked, isLikedVideo,
    getPlaylists, createPlaylist, addToPlaylist, removeFromPlaylist, getPlaylistItems,
    subscribeComments, addCommentToStore, removeCommentById
} from "./data.js";


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

// A YouTube video id is always exactly 11 URL-safe base64 characters.
// https://www.youtube.com/watch?v=dQw4w9WgXcQ
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Canonicalize the `?id=` value once, at page init.
//
// `/watch?id=<videoId>` (a plain YouTube video id) must behave exactly like
// `/watch?id=yt:<videoId>`, so a bare, valid video id is promoted to the
// internal "yt:" representation here. Everything downstream (isYouTubeId,
// ytSourceId, the embed, getVideo(), liveChat(), canonical URL, storage keys)
// keeps reading `rawId` unchanged, so this is the only place that has to know
// about the shorthand. Anything already "yt:"-prefixed — or anything that is
// not a valid video id — is passed through untouched and keeps failing exactly
// as it did before.
function normalizeWatchId(raw){
    const str = String(raw === null || raw === undefined ? "" : raw).trim();
    if(!str || isYouTubeId(str)){
        return str;
    }
    return YT_VIDEO_ID_RE.test(str) ? "yt:" + str : str;
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


// The `?id=` value, already canonicalized to the "yt:" representation when it is
// a bare YouTube video id (see normalizeWatchId). Everything below — the load
// flow, the embed, the API calls, the storage keys and the canonical URL — is
// written against that single form, so `?id=<videoId>` and `?id=yt:<videoId>`
// are indistinguishable from here on.
const rawId = normalizeWatchId(getRawId());
// MyTube is YouTube-only: no local dataset exists, so an id that is not a
// "yt:" id (e.g. an old local-video record or a malformed id) never resolves to
// a playable video. `current` stays null and `renderers` read the
// asynchronously-populated `active` object (see loadYouTubeVideo).
const current = null;
// Fallback storage key used until a YouTube video's metadata loads.
const videoKey = "video";

// Phase 7: the actively-rendered video. For "yt:" ids `active` is populated
// asynchronously from the YouTube API backend. Renderers read `active`, never
// `current`, directly.
const isYt = isYouTubeId(rawId);
let active = current;
// Key used for localStorage-backed state (likes/saves/comments/etc). For
// YouTube videos this is derived from the yt: id once known.
let activeKey = videoKey;

const AUTOPLAY_STORAGE_KEY = "mytube_autoplay";

function getAutoplayPreference(){
    try{
        const val = localStorage.getItem(AUTOPLAY_STORAGE_KEY);
        if(val === null){
            return true;
        }
        return val === "true";
    }
    catch(e){
        return true;
    }
}

function setAutoplayPreference(enabled){
    try{
        localStorage.setItem(AUTOPLAY_STORAGE_KEY, enabled ? "true" : "false");
    }
    catch(e){
        // ignore
    }
}

// Resolve the storage key that should be used right now. For YouTube videos
// `activeKey` is set once the video metadata loads; before that we fall back to
// the safe placeholder key so nothing ever dereferences undefined.
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
    // A dead/unavailable watch URL must not be indexed.
    setVideoPageMetaNoIndex();
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

    // MyTube is YouTube-only: the legacy local MP4 dataset is gone, so an id
    // that did not normalize to "yt:" (e.g. a stored local-video record or a
    // malformed id) can never resolve to a playable video. Show the clean "not
    // found" panel instead of attempting to load a nonexistent
    // /videos/*.mp4 file.
    renderErrorState();
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
    ytEmbedEnabled = true;
    ytTargetSourceId = sourceId;
    if(frame){
        // enablejsapi + origin lets the IFrame Player API upgrade this embed so
        // YouTube videos get the same auto-advance and keyboard support as local
        // videos. The embed still plays on its own if the API never loads.
        frame.src = "https://www.youtube-nocookie.com/embed/" +
            encodeURIComponent(sourceId) +
            "?rel=0&modestbranding=1&enablejsapi=1&origin=" +
            encodeURIComponent(window.location.origin);
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
    // Upgrade to the IFrame Player API for auto-advance and keyboard control.
    loadYouTubeIframeApi();
}


// Show an honest fallback for a video whose owner has disabled embedding. This
// is only invoked when the backend reported embeddable === false, so it never
// fires for every iframe error — only when YouTube tells us embedding is off.
function showYtEmbedFallback(sourceId){
    // Cancel the IFrame Player API upgrade; the plain embed takes over.
    teardownYtPlayer();
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
    teardownYtPlayer();
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


// ================= YOUTUBE IFRAME PLAYER API =================
// Upgrades the embed with the official IFrame Player API so YouTube videos get
// the same auto-advance and keyboard behavior as local videos. The plain embed
// (already set in setupYtEmbed) keeps playing if the API script cannot load.

let relatedItems = [];
let ytTargetSourceId = "";
let ytEmbedEnabled = false;
let ytPlayer = null;
let ytPlayerReady = false;
let ytApiScriptLoading = false;


// Keyboard/auto-advance shortcuts should only touch the YouTube player when it
// is actually present and ready; otherwise they fall through to the native
// <video> path (or no-op).
function ytKeyControlAvailable(){
    return isYt && ytPlayer && ytPlayerReady;
}


// Destroy any active API player and reset the embed-upgrade state.
function teardownYtPlayer(){
    if(ytPlayer){
        try{
            ytPlayer.destroy();
        }
        catch(error){
            console.warn("Could not destroy YouTube player:", error);
        }
        ytPlayer = null;
    }
    ytPlayerReady = false;
    ytEmbedEnabled = false;
    ytTargetSourceId = "";
}


// Create the API player on the existing <iframe id="ytPlayer">. Called only for
// the currently active YouTube embed (the page shows one video at a time).
function initYtApiPlayer(sourceId){
    if(!isYt || !ytEmbedEnabled || !sourceId){
        return;
    }
    if(ytSourceId(rawId) !== sourceId){
        return; // stale API callback for a replaced embed.
    }
    const frame = document.getElementById("ytPlayer");
    if(!frame || typeof YT === "undefined" || !YT.Player){
        return;
    }
    if(ytPlayer){
        return; // already upgraded.
    }
    try{
        ytPlayer = new YT.Player(frame, {
            videoId: sourceId,
            playerVars: {
                rel: 0,
                modestbranding: 1,
                origin: window.location.origin
            },
            events: {
                onReady: function(){
                    ytPlayerReady = true;
                },
                onStateChange: handleYtPlayerState
            }
        });
    }
    catch(error){
        console.warn("YouTube IFrame API could not initialize:", error);
        ytPlayer = null;
        ytPlayerReady = false;
    }
}


// Inject the IFrame Player API script exactly once. Appending a script tag is
// required for the API to attach to the ready callback on a static page.
function loadYouTubeIframeApi(){
    if(typeof YT !== "undefined" && YT && YT.Player){
        initYtApiPlayer(ytTargetSourceId);
        return;
    }
    if(ytApiScriptLoading){
        return;
    }
    ytApiScriptLoading = true;
    window.onYouTubeIframeAPIReady = function(){
        ytApiScriptLoading = false;
        initYtApiPlayer(ytTargetSourceId);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = function(){
        // API failed to load (e.g. network/CSP) — the plain embed still plays.
        ytApiScriptLoading = false;
    };
    document.head.appendChild(tag);
}


// Auto-advance: when a YouTube video ends, trigger the existing next-video flow.
function handleYtPlayerState(event){
    if(!isYt || !ytEmbedEnabled || !ytPlayerReady){
        return;
    }
    if(!(event && typeof event.data === "number" && event.data === YT.PlayerState.ENDED)){
        return;
    }
    if(!getAutoplayPreference()){
        return;
    }
    nextVideo();
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
        // Must survive the rebuild: maybeStartLiveChat() reads it to decide
        // whether to reveal the YouTube Live Chat panel for this video.
        isLive: Boolean(info.isLive),
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
function setPageMetaDescription(v){
    const descEl = document.querySelector('meta[name="description"]');
    if(!descEl){
        return;
    }
    const text = v && v.description ? v.description : "Watch videos on MyTube";
    descEl.setAttribute("content", text.slice(0, 160));
}


// ================= PAGE METADATA (client-side) =================
// worker.js renders the per-video <title>/description/canonical/og head for
// /watch?id=... before the response leaves the edge, from the same index-first /
// YouTube-fallback lookup /api/video performs. Everything below re-applies that
// same metadata after hydration: it is idempotent for a page the server already
// enriched (the values it computes are byte-identical), and it is what still
// produces the correct head when the SSR pass could not resolve the video —
// most importantly setVideoPageMetaNoIndex(), which decides the error state.
//
// Keep the formats here identical to renderWatchSeoHtml() in worker.js, and to
// watchUrl() in scripts/generate-sitemap.mjs: the sitemap loc, the page's own
// canonical and these rewrites must all be the same string.

const WATCH_ORIGIN = "https://mytube.farqas007.workers.dev";
const ROBOTS_INDEXABLE = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
const ROBOTS_NOINDEX = "noindex, follow";


function setMetaContent(selector, value){
    if(!value){
        return;
    }
    const el = document.querySelector(selector);
    if(el){
        el.setAttribute("content", String(value));
    }
}


// Ensure the page has exactly one robots meta and point it at `content`.
function setRobotsMeta(content){
    let el = document.querySelector('meta[name="robots"]');
    if(!el){
        el = document.createElement("meta");
        el.setAttribute("name", "robots");
        document.head.appendChild(el);
    }
    el.setAttribute("content", content);
}


// Point the single canonical link (the one shipped in watch.html) at `url`.
function setCanonicalUrl(url){
    let el = document.getElementById("pageCanonical");
    if(!el){
        el = document.createElement("link");
        el.id = "pageCanonical";
        el.setAttribute("rel", "canonical");
        document.head.appendChild(el);
    }
    el.setAttribute("href", url);
}


// A video actually rendered: make canonical + OG describe that video.
function setVideoPageMeta(v){
    const id = v && v.id ? String(v.id) : String(rawId || "");
    if(!id){
        return;
    }
    const url = WATCH_ORIGIN + "/watch?id=" + encodeURIComponent(id);

    setCanonicalUrl(url);
    setRobotsMeta(ROBOTS_INDEXABLE);
    setMetaContent('meta[property="og:url"]', url);

    if(v && v.title){
        setMetaContent('meta[property="og:title"]', v.title + " - MyTube");
        setMetaContent('meta[name="twitter:title"]', v.title + " - MyTube");
    }

    const desc = v && v.description ? String(v.description).slice(0, 160) : "";
    if(desc){
        setMetaContent('meta[property="og:description"]', desc);
        setMetaContent('meta[name="twitter:description"]', desc);
    }

    if(v && v.thumb){
        setMetaContent('meta[property="og:image"]', v.thumb);
    }
}


// Invalid or unavailable video: keep the page out of the search index.
function setVideoPageMetaNoIndex(){
    setRobotsMeta(ROBOTS_NOINDEX);
}


function renderYtSubViews(v){
    const titleEl = document.getElementById("videoTitle");
    if(titleEl){
        titleEl.textContent = v.title;
    }
    document.title = (v && v.title ? v.title : "Watch") + " - MyTube";
    setPageMetaDescription(v);
    setVideoPageMeta(v);

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
        // Reveal + start the real YouTube Live Chat only if this video is live.
        maybeStartLiveChat(v);
    }
    else{
        liveChatStop(true);
    }

    // Ensure Like/Dislike reflects public count and, for YouTube videos, load
    // the actual rating from the connected YouTube account (never local/library).
    renderLikeDislike();
    if(isYt){
        void loadYoutubeRating({ force: true });
    }

    renderSave();
    renderSubscribe();
    // Recompute saved/subscribed state for the now-current YouTube video.
    isSaved = localStorage.getItem(saveKey()) === "1";
    refreshSubscribeState();
    // Read-only: fetch actual YouTube account subscription status for this channel.
    // Never auto-subscribes/unsubscribes; mutations require explicit confirmation.
    syncYtAccountSubscriptionForCurrentVideo(true);
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
    const mytubeChannelLink = document.getElementById("myTubeChannelLink");
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

    // The channel endpoint already returns the official YouTube thumbnail.
    // Store it on the active video and re-render the existing channel UI.
    if(c && active && active.channelId === channelId){
        active.channelThumb = c.thumb || "";
        renderChannel();
    }
    if(link){
        link.href = "https://www.youtube.com/channel/" + encodeURIComponent(channelId);
        link.setAttribute("aria-label", "Open " + (c ? c.title : "channel") + " on YouTube");
    }
    // MyTube's own channel page for the same channel. Kept separate from the
    // external YouTube link above so both entry points stay available.
    if(mytubeChannelLink){
        mytubeChannelLink.href = "/channel.html?id=" + encodeURIComponent(channelId);
        mytubeChannelLink.setAttribute("aria-label", "View " + (c ? c.title : "channel") + " on MyTube");
        mytubeChannelLink.style.display = "";
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
    appendSafeLineContent(text, c.text || "");

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
        avatarEl.setAttribute("aria-hidden", "true");
        avatarEl.replaceChildren();

        if(v.channelThumb){
            const img = document.createElement("img");
            img.src = v.channelThumb;
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.style.width = "100%";
            img.style.height = "100%";
            img.style.objectFit = "cover";
            img.style.borderRadius = "inherit";

            img.addEventListener("error", () => {
                avatarEl.replaceChildren();
                avatarEl.textContent = getInitials(v.channel);
            }, { once: true });

            avatarEl.appendChild(img);
        }
        else{
            avatarEl.textContent = getInitials(v.channel);
        }
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
function timestampToSeconds(ts){
    if(typeof ts !== "string"){
        return null;
    }

    const parts = ts.split(":");
    if(parts.length !== 2 && parts.length !== 3){
        return null;
    }

    if(!parts.every(part => /^\d+$/.test(part))){
        return null;
    }

    const nums = parts.map(Number);
    if(!nums.every(Number.isSafeInteger)){
        return null;
    }

    let seconds;

    if(parts.length === 2){
        const [minutes, secs] = nums;
        if(secs > 59){
            return null;
        }
        seconds = minutes * 60 + secs;
    } else {
        const [hours, minutes, secs] = nums;
        if(minutes > 59 || secs > 59){
            return null;
        }
        seconds = hours * 3600 + minutes * 60 + secs;
    }

    return Number.isSafeInteger(seconds) ? seconds : null;
}

// Seek video to timestamp in seconds
function seekToTime(seconds){
    if(ytKeyControlAvailable()){
        try{
            ytPlayer.seekTo(seconds, true);
            return;
        }
        catch(e){
            // fall through
        }
    }
    if(video){
        try{
            video.currentTime = seconds;
        }
        catch(e){
            // ignore
        }
    }
}

function appendSafeLineContent(lineEl, line){
    // Match URLs and timestamps. Timestamps like 1:23, 10:45, 1:23:45
    // Use word boundaries to avoid matching inside larger numbers
    const combinedRe = /(https?:\/\/[^\s]+)|\b[0-9]+:[0-5][0-9](?::[0-5][0-9])?\b/g;
    let lastIndex = 0;
    let match;

    while((match = combinedRe.exec(line)) !== null){
        if(match.index > lastIndex){
            lineEl.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
        }
        const matched = match[0];

        // Check if it's a URL
        if(/^https?:\/\//.test(matched)){
            const url = matched;
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
        else{
            // It's a timestamp
            const ts = matched;
            const a = document.createElement("a");
            a.href = "#";
            a.className = "desc-link desc-timestamp";
            a.textContent = ts;
            a.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const seconds = timestampToSeconds(ts);
                if(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0){
                    seekToTime(seconds);
                }
            });
            lineEl.appendChild(a);
            lastIndex = match.index + ts.length;
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
    // Real anchor so crawlers can follow the suggestion into the watch page.
    // Click/keyboard behavior is unchanged: the click still bubbles to the
    // item's own handler.
    const h4Link = document.createElement("a");
    h4Link.className = "suggest-title-link";
    h4Link.href = "/watch?id=" + encodeURIComponent(v.id);
    h4Link.textContent = v.title;
    h4.appendChild(h4Link);

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
    relatedItems = Array.isArray(items) ? items.slice() : [];
    listEl.replaceChildren();
    items.forEach(v => {
        listEl.appendChild(buildSuggestedItem(v));
    });
    // YouTube Next/auto-advance depends on this list; refresh its button state.
    if(isYt){
        renderPrevNext();
    }
}


function renderRelatedSection(){
    const listEl = document.getElementById("relatedList");
    if(!listEl){
        return;
    }

    if(!isYt){
        return;
    }

    // Fetch genuinely related YouTube videos via the backend.
    const sourceId = ytSourceId(rawId);
    listEl.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "comment-empty";
    loading.textContent = "Loading related videos...";
    listEl.appendChild(loading);
    loadRelatedFromYouTube(sourceId, listEl);
}


// Phase 7: use the official YouTube API to suggest related/up-next videos.
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

    listEl.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "comment-empty";
    empty.textContent = apiError ? ("Related unavailable: " + apiError) : "No related videos.";
    listEl.appendChild(empty);
}


function navigateToVideo(videoId){
    window.location.href = "/watch?id=" + encodeURIComponent(videoId);
}


// ================= PREVIOUS / NEXT VIDEO =================


// The first "Up Next" suggestion is the next video for YouTube videos.
function getUpNextVideoId(){
    const first = relatedItems[0];
    return first && first.id ? first.id : "";
}


function setupAutoplayToggle(){
    const toggleBtn = document.getElementById("autoplayToggle");
    if(!toggleBtn){
        return;
    }
    const enabled = getAutoplayPreference();
    toggleBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    toggleBtn.addEventListener("click", () => {
        const current = getAutoplayPreference();
        const next = !current;
        setAutoplayPreference(next);
        toggleBtn.setAttribute("aria-pressed", next ? "true" : "false");
    });
}

function renderPrevNext(){
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    let hasPrev = false;
    let hasNext = false;

    if(isYt){
        // YouTube videos have no bounded play order on this page, so Previous
        // stays disabled. Next maps to the first Up Next suggestion and also
        // drives auto-advance.
        hasPrev = false;
        hasNext = Boolean(getUpNextVideoId());
    }

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
    // YouTube-only: Previous is disabled on every video (no bounded play order).
    return;
};


window.nextVideo = function(){
    if(!isYt){
        return;
    }
    const upNextId = getUpNextVideoId();
    if(upNextId){
        navigateToVideo(upNextId);
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


// ================= YOUTUBE LIVE CHAT (read + opt-in sending) =================
// The REAL YouTube Live Chat for the video currently being watched.
//
// Scope, deliberately narrow:
//   * Reading is always available. Sending is off unless the server reports it
//     enabled for this request; the server re-checks on every POST.
//   * A sent message goes to YouTube as the signed-in user's OWN connected
//     YouTube account. Nothing is written to Firestore, and MyTube does not keep
//     a copy of the message.
//   * Separate from video comments. MyTube comments and YouTube's public
//     commentThreads are untouched by this code and keep their own rendering.
//   * Shown only while the backend reports the video is actually live.
//
// The server owns one shared upstream poll per stream and tells us how long to
// wait (YouTube's own `pollingIntervalMillis`), so this loop stays cheap even
// with many viewers.

const LIVE_CHAT_MIN_INTERVAL_MS = 3000;
const LIVE_CHAT_MAX_INTERVAL_MS = 10000;
const LIVE_CHAT_MAX_MESSAGES = 200;

const liveChatState = {
    panel: null,
    list: null,
    status: null,
    meta: null,
    badge: null,
    attrib: null,
    // Id of the video whose chat we are currently following.
    sourceId: "",
    // Message ids already rendered, so a re-poll or an overlapping server delta
    // can never double-post a message.
    seen: new Set(),
    timer: null,
    // The active poll loop, so a hidden-tab pause can be resumed.
    tick: null,
    paused: false,
    // Monotonic token: any async result from a previous video is ignored.
    run: 0,
    stopped: false,
    // --- sending (server-gated, hidden unless both flags are true) ---
    form: null,
    input: null,
    sendBtn: null,
    note: null,
    // True only when the live-chat payload says the server has sending enabled.
    sendEnabled: false,
    // True only after /api/oauth/status reports a usable YouTube scope.
    sendScopeReady: false,
    // null = unknown/temporary failure, true = confirmed ready, false = confirmed not ready (200 response)
    sendScopeConfirmedReady: null,
    // Retry state for temporary initial verification failures
    scopeVerifyRetryCount: 0,
    scopeVerifyTimer: null,
    scopeVerifyExhausted: false,
    // One in-flight submit at a time per tab.
    sendInFlight: false,
    // One OAuth scope recheck at a time.
    scopeRecheckInFlight: false,
    scopeRecheckRun: 0,
    // Subscriber-only / restricted chat (user-confirmed actions only)
    restriction: null,
    restrictionBox: null,
    restrictionText: null,
    restrictionActions: null,
    restrictionState: "idle", // idle | checking | checked
    subscriptionSubscribed: null, // null unknown/unavailable, true, false
    chatRestrictionConfirmed: false, // confirmed send restriction (e.g. CHAT_FORBIDDEN); do not assume subscriber-only
    subscriptionCheckState: "idle", // idle | checking | ok | error
    subscriptionActionInFlight: false,
    preserveRestrictionOnce: false
};


// Poll interval comes from YouTube but is clamped so a bad/huge value cannot
// hammer the backend (or spin the CPU).
function liveChatInterval(value){
    const n = Number(value);

    if(!Number.isFinite(n) || n <= 0){
        return 5000;
    }

    return Math.min(Math.max(Math.round(n), LIVE_CHAT_MIN_INTERVAL_MS), LIVE_CHAT_MAX_INTERVAL_MS);
}


function liveChatEls(){
    if(!liveChatState.panel){
        liveChatState.panel = document.getElementById("liveChatPanel");
        liveChatState.list = document.getElementById("liveChatList");
        liveChatState.status = document.getElementById("liveChatStatus");
        liveChatState.meta = document.getElementById("liveChatMeta");
        liveChatState.badge = document.getElementById("liveChatBadge");
        liveChatState.attrib = document.getElementById("liveChatAttrib");
        liveChatState.form = document.getElementById("liveChatForm");
        liveChatState.input = document.getElementById("liveChatInput");
        liveChatState.sendBtn = document.getElementById("liveChatSend");
        liveChatState.note = document.getElementById("liveChatNote");
        liveChatState.restriction = document.getElementById("liveChatRestriction");
        liveChatState.restrictionText = document.getElementById("liveChatRestrictionText");
        liveChatState.restrictionActions = document.getElementById("liveChatRestrictionActions");
    }

    return liveChatState;
}


// Point the attribution link at THIS stream's chat instead of YouTube's generic
// live-chat landing page. YouTube's supported live-chat URL accepts the video id
// as `?v=<id>`, so the link is only rewritten once a REAL video id is known -
// never blindly. With no valid id the href is left as the generic fallback.
function liveChatSetAttrib(sourceId){
    const els = liveChatEls();

    if(!els.attrib){
        return;
    }

    const id = String(sourceId || "").trim();

    // Video ids are [A-Za-z0-9_-]{1,64} (the same shape the backend accepts).
    if(/^[A-Za-z0-9_-]{1,64}$/.test(id)){
        els.attrib.href = "https://www.youtube.com/live_chat?v=" + encodeURIComponent(id);
        els.attrib.setAttribute("aria-label", "Open this stream's chat on YouTube");
    }
    else{
        els.attrib.href = "https://www.youtube.com/live_chat";
        els.attrib.removeAttribute("aria-label");
    }
}


function liveChatSetStatus(text){
    const els = liveChatEls();

    if(!els.status){
        return;
    }

    els.status.textContent = text || "";
    els.status.hidden = !text;
}


function liveChatSetBadge(label, ended){
    const els = liveChatEls();

    if(!els.badge){
        return;
    }

    els.badge.textContent = label || "";
    els.badge.classList.toggle("is-ended", Boolean(ended));
}


function liveChatFormatViewers(count){
    const n = Number(count);

    if(!Number.isFinite(n) || n <= 0){
        return "";
    }

    if(n >= 1000000){
        return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "M watching";
    }

    if(n >= 1000){
        return Math.round(n / 1000) + "K watching";
    }

    return n + " watching";
}


// "12s ago" style relative stamp. Live chat is a live feed, so relative time is
// more useful than an absolute timestamp here.
function liveChatTimeAgo(iso){
    const then = Date.parse(iso || "");

    if(!Number.isFinite(then)){
        return "";
    }

    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));

    if(secs < 60){
        return secs + "s ago";
    }

    if(secs < 3600){
        return Math.round(secs / 60) + "m ago";
    }

    if(secs < 86400){
        return Math.round(secs / 3600) + "h ago";
    }

    return Math.round(secs / 86400) + "d ago";
}


// Build one message row. EVERY piece of YouTube-supplied text goes in through
// textContent: chat text is untrusted user input and must never be parsed as
// HTML.
function liveChatMessageEl(msg){
    const row = document.createElement("div");
    row.className = "live-chat-msg";
    // Tracked so trimming from the front can also forget the dedupe id.
    row.dataset.msgId = msg.id || "";

    if(msg.authorThumb){
        const avatar = document.createElement("img");
        avatar.className = "live-chat-avatar";
        avatar.src = msg.authorThumb;
        avatar.alt = "";
        avatar.loading = "lazy";
        avatar.referrerPolicy = "no-referrer";
        row.appendChild(avatar);
    }

    const body = document.createElement("div");
    body.className = "live-chat-body";

    const authorRow = document.createElement("div");
    authorRow.className = "live-chat-author";

    const author = document.createElement("span");
    author.textContent = msg.author || "Unknown";
    authorRow.appendChild(author);

    if(msg.isChatOwner){
        authorRow.appendChild(liveChatRoleEl("OWNER", "is-owner"));
    }
    else if(msg.isChatModerator){
        authorRow.appendChild(liveChatRoleEl("MOD", "is-moderator"));
    }
    else if(msg.isChatSponsor){
        authorRow.appendChild(liveChatRoleEl("MEMBER", ""));
    }

    if(msg.superChatAmount){
        const amount = document.createElement("span");
        amount.className = "live-chat-superc";
        amount.textContent = msg.superChatAmount;
        authorRow.appendChild(amount);
    }

    body.appendChild(authorRow);

    // textMessageDetails for real messages, userComment for a Super Chat.
    const text = msg.text || msg.superChatUserComment || "";

    if(text){
        const textEl = document.createElement("p");
        textEl.className = "live-chat-text";
        textEl.textContent = text;
        body.appendChild(textEl);
    }

    const stamp = liveChatTimeAgo(msg.publishedAt);

    if(stamp){
        const timeEl = document.createElement("div");
        timeEl.className = "live-chat-time";
        timeEl.textContent = stamp;
        body.appendChild(timeEl);
    }

    row.appendChild(body);

    return row;
}


function liveChatRoleEl(label, modifier){
    const el = document.createElement("span");
    el.className = "live-chat-role" + (modifier ? " " + modifier : "");
    el.textContent = label;

    return el;
}


function liveChatPollEl(poll){
    const card = document.createElement("div");
    card.className = "live-chat-poll";

    const q = document.createElement("p");
    q.className = "live-chat-poll-q";
    q.textContent = poll.text || "";
    card.appendChild(q);

    if(poll.total){
        const meta = document.createElement("p");
        meta.className = "live-chat-poll-meta";
        meta.textContent = poll.total + " vote" + (poll.total === 1 ? "" : "s");
        card.appendChild(meta);
    }

    return card;
}


// Append newly-seen messages and trim to the cap. Returns how many were added.
function liveChatRender(messages, poll){
    const els = liveChatEls();

    if(!els.list){
        return 0;
    }

    const items = Array.isArray(messages) ? messages : [];
    let added = 0;

    for(const msg of items){
        if(!msg || !msg.id || liveChatState.seen.has(msg.id)){
            continue;
        }

        liveChatState.seen.add(msg.id);

        const wasEmpty = els.list.childElementCount === 0;

        if(wasEmpty){
            // An active poll belongs at the top of the feed, like YouTube's.
            if(poll && poll.text){
                els.list.appendChild(liveChatPollEl(poll));
            }
        }

        els.list.appendChild(liveChatMessageEl(msg));
        added++;
    }

    // Trim from the front, keeping the newest window and the ids in step with it.
    while(els.list.childElementCount > LIVE_CHAT_MAX_MESSAGES){
        const first = els.list.firstElementChild;

        if(!first){
            break;
        }

        // The poll card has no id, so it is never "seen"-tracked: drop it here.
        if(first.classList.contains("live-chat-msg")){
            const id = first.dataset.msgId;

            if(id){
                liveChatState.seen.delete(id);
            }
        }

        first.remove();
    }

    if(added > 0){
        // Stick to the newest messages while the user is already at the bottom;
        // never yank the view if they scrolled up to read something.
        const nearBottom =
            els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 120;

        if(nearBottom){
            els.list.scrollTop = els.list.scrollHeight;
        }
    }

    return added;
}


function liveChatClearRestriction(options){
    const opts = options && typeof options === "object" ? options : {};
    if(liveChatState.preserveRestrictionOnce && !opts.force){
        liveChatState.preserveRestrictionOnce = false;
        return;
    }
    liveChatState.preserveRestrictionOnce = false;
    const els = liveChatEls();
    liveChatState.restrictionState = "idle";
    liveChatState.subscriptionSubscribed = null;
    liveChatState.chatRestrictionConfirmed = false;
    liveChatState.subscriptionCheckState = "idle";
    if(els.restrictionText){ els.restrictionText.textContent = ""; }
    if(els.restrictionActions){ els.restrictionActions.textContent = ""; }
    if(els.restriction){ els.restriction.hidden = true; }
}

function liveChatReset(){
    const els = liveChatEls();

    if(els.list){
        els.list.textContent = "";
    }

    liveChatState.seen.clear();
    liveChatSetStatus("");
    liveChatSetMeta("");
    liveChatClearRestriction();
}


// Stop polling entirely and clear the panel. Used on navigation away and when the
// next video turns out not to be live.
function liveChatStop(hidePanel){
    liveChatState.stopped = true;
    liveChatState.paused = false;
    liveChatState.tick = null;
    liveChatState.run++;

    if(liveChatState.timer){
        clearTimeout(liveChatState.timer);
        liveChatState.timer = null;
    }

    liveChatState.sourceId = "";
    liveChatReset();

    if(hidePanel && liveChatState.panel){
        liveChatState.panel.hidden = true;
    }

    // Never leave a previous stream's chat link behind once we are no longer
    // following that stream.
    liveChatSetAttrib("");

    // Sending is per-stream and per-account: start hidden next time.
    if(liveChatState.scopeVerifyTimer){
        clearTimeout(liveChatState.scopeVerifyTimer);
        liveChatState.scopeVerifyTimer = null;
    }
    liveChatState.scopeVerifyRetryCount = 0;
    liveChatState.scopeVerifyExhausted = false;
    liveChatState.sendEnabled = false;
    liveChatState.sendScopeReady = false;
    liveChatState.sendScopeConfirmedReady = null;
    liveChatState.sendInFlight = false;
    liveChatState.scopeRecheckInFlight = false;
    liveChatState.scopeRecheckRun = 0;
    liveChatState.subscriptionActionInFlight = false;
    liveChatState.preserveRestrictionOnce = false;
    liveChatSetSendVisible(false);
}


function liveChatSetMeta(text){
    const els = liveChatEls();

    if(els.meta){
        els.meta.textContent = text || "";
    }
}


// Terminal states: the chat is over for good, so stop polling and leave a clear
// note in place of a permanently empty box.
function liveChatFinish(status){
    liveChatState.stopped = true;

    if(liveChatState.timer){
        clearTimeout(liveChatState.timer);
        liveChatState.timer = null;
    }

    if(status === "ended"){
        liveChatSetBadge("ENDED", true);
        liveChatSetStatus("This live chat has ended.");
    }
    else if(status === "disabled"){
        liveChatSetBadge("OFF", true);
        liveChatSetStatus("Live chat is turned off for this broadcast.");
    }
    else if(status === "not_found"){
        liveChatSetBadge("OFF", true);
        liveChatSetStatus("This live chat is unavailable.");
    }

    // Keep any messages already rendered on screen: the history is still useful.
    liveChatState.sourceId = "";
    // Terminal: never resume, even after a hidden/visible tab cycle.
    liveChatState.tick = null;
    liveChatState.paused = false;

    // Cancel pending OAuth capability retries and invalidate in-flight verification
    // results so no async verification mutates state after chat has ended.
    // Preserve rendered history and panel/composer visibility behavior.
    if(liveChatState.scopeVerifyTimer){
        clearTimeout(liveChatState.scopeVerifyTimer);
        liveChatState.scopeVerifyTimer = null;
    }
    liveChatState.scopeVerifyRetryCount = 0;
    liveChatState.scopeVerifyExhausted = false;
    liveChatState.scopeRecheckInFlight = false;

    // A finished/ended chat cannot be posted to.
    liveChatState.sendEnabled = false;
    liveChatSetSendVisible(false);
}


// --- Sending (hidden unless the server says it is enabled) ------------------
// The composer is a convenience, never the gate. Every rule below is enforced
// again by POST /api/liveChat/send; a stale tab can only produce a clean error.

function liveChatSendNote(text, tone){
    const els = liveChatEls();

    if(!els.note){
        return;
    }

    els.note.textContent = text || "";
    els.note.classList.toggle("is-error", tone === "error");
    els.note.classList.toggle("is-ok", tone === "ok");
    els.note.hidden = !text;
}


// Visibility requires a live stream id AND both server facts. Called after
// every poll and after the account probe, so a capability change hides the
// composer without a reload.
function liveChatSetSendVisible(show){
    const els = liveChatEls();

    if(!els.form){
        return;
    }

    const panel = els.panel || liveChatState.panel;
    const panelActive = panel ? !panel.hidden : true;
    const hasSource = Boolean(liveChatState.sourceId);
    const stopped = liveChatState.stopped === true;

    const user = typeof currentUser === "function" ? currentUser() : null;
    const canSendEnabled =
        Boolean(show) &&
        panelActive &&
        hasSource &&
        !stopped &&
        Boolean(user) &&
        liveChatState.sendEnabled === true &&
        liveChatState.sendScopeReady === true &&
        liveChatState.chatRestrictionConfirmed !== true;

    const composerVisible =
        panelActive &&
        hasSource &&
        !stopped;

    // On confirmed send restriction (e.g. CHAT_FORBIDDEN), hide actual composer
    // controls; restriction explanation/actions are rendered outside the form.
    const formVisible = composerVisible && liveChatState.chatRestrictionConfirmed !== true;
    els.form.hidden = !formVisible;

    if(els.attrib){
        els.attrib.style.display = composerVisible ? "none" : "";
    }

    if(els.input){
        els.input.disabled = !canSendEnabled || liveChatState.sendInFlight === true;
    }

    if(els.sendBtn){
        els.sendBtn.disabled = !canSendEnabled || liveChatState.sendInFlight === true;
    }
}


function liveChatApplySendVisibility(){
    const user = typeof currentUser === "function" ? currentUser() : null;
    const els = liveChatEls();

    liveChatSetSendVisible(true);

    if(!els.form || els.form.hidden){
        return;
    }

    if(liveChatState.stopped || !liveChatState.sourceId){
        liveChatSendNote("", "");
        if(els.input){
            els.input.disabled = true;
        }
        if(els.sendBtn){
            els.sendBtn.disabled = true;
        }
        return;
    }

    if(!user){
        liveChatSendNote("Sign in to send messages.", "error");
        if(els.input){
            els.input.disabled = true;
        }
        if(els.sendBtn){
            els.sendBtn.disabled = true;
        }
        return;
    }

    if(liveChatState.sendEnabled !== true){
        liveChatSendNote("Chat sending is currently unavailable.", "error");
        if(els.input){
            els.input.disabled = true;
        }
        if(els.sendBtn){
            els.sendBtn.disabled = true;
        }
        return;
    }

    if(liveChatState.sendScopeReady !== true){
        // Only show Connect when server explicitly confirmed scopeReady is false in a 200 response.
        if(liveChatState.sendScopeConfirmedReady === false){
            liveChatSendNote("Connect your YouTube account to send messages.", "error");
        }
        else if(liveChatState.scopeVerifyExhausted){
            liveChatSendNote("Couldn't verify connection. Please try again.", "error");
        }
        else{
            liveChatSendNote("Verifying YouTube connection...", "");
        }
        if(els.input){
            els.input.disabled = true;
        }
        if(els.sendBtn){
            els.sendBtn.disabled = true;
        }
        return;
    }

    if(liveChatState.sendInFlight === true){
        liveChatSendNote("Sending...", "");
        if(els.input){
            els.input.disabled = true;
        }
        if(els.sendBtn){
            els.sendBtn.disabled = true;
        }
        return;
    }

    liveChatSendNote("", "");
}


// Safe, closed copy for every server code. Unknown codes fall back to a generic
// sentence; the server's own `error` string is never rendered here.
function liveChatSendErrorMessage(code, status){
    switch(String(code || "")){
        case "RATE_LIMITED":
            return "You're sending messages too quickly. Please wait a moment.";
        case "CHAT_RATE_LIMITED":
            return "YouTube is asking for a slower pace. Please wait a moment.";
        case "SEND_IN_PROGRESS":
            return "Your previous message is still being sent.";
        case "YOUTUBE_NOT_CONNECTED":
            return "Connect your YouTube account on your profile to send messages.";
        case "YOUTUBE_SCOPE_REQUIRED":
        case "YOUTUBE_REAUTH_REQUIRED":
            return "Reconnect your YouTube account on your profile to send messages.";
        case "NOT_LIVE":
            return "This stream is not live.";
        case "CHAT_DISABLED":
            return "Live chat is turned off for this broadcast.";
        case "LIVE_CHAT_ENDED":
            return "This live chat has ended.";
        case "LIVE_CHAT_NOT_FOUND":
            return "This live chat is unavailable.";
        case "CHAT_FORBIDDEN":
            return "You can't send messages in this chat.";
        case "INVALID_MESSAGE":
            return "That message can't be sent. Check the text and try again.";
        case "CHAT_SEND_DISABLED":
            return "Sending chat messages is not available yet.";
        case "QUOTA_EXCEEDED":
            return "YouTube's daily limit has been reached. Please try again later.";
        default:
            return status === 401
                ? "Sign in to send messages."
                : "We couldn't send your message. Please try again.";
    }
}


function liveChatBindSendForm(){
    const els = liveChatEls();

    if(!els.form || els.form.dataset.bound === "1"){
        return;
    }

    els.form.dataset.bound = "1";
    els.form.addEventListener("submit", liveChatSubmit);

    // Typing dismisses "Sent."/"error" so the note never looks stale.
    if(els.input){
        els.input.addEventListener("input", () => {
            if(!liveChatState.sendInFlight){
                liveChatSendNote("", "");
            }
        });
    }
}


async function liveChatAuthedFetch(path, init){
    const user = currentUser();
    if(!user || typeof user.getIdToken !== "function"){
        return { ok: false, status: 401, code: "UNAUTHENTICATED", body: null };
    }
    if(auth && typeof auth.authStateReady === "function"){
        await auth.authStateReady();
    }
    const freshUser = currentUser() || user;
    const token = await freshUser.getIdToken();
    const res = await fetch(path, {
        ...(init || {}),
        headers: {
            ...((init && init.headers) || {}),
            Authorization: "Bearer " + token
        },
        cache: "no-store"
    });
    let body = null;
    try{ body = await res.json(); } catch(e){ body = null; }
    return { ok: res.ok, status: res.status, body, code: body && body.code ? String(body.code) : "" };
}

function liveChatRestrictionText(base, subscribed){
    if(subscribed === true){
        return base + " Your account appears subscribed to this channel, but you still can't send messages in this chat. Other restrictions or subscription-duration requirements may apply.";
    }
    if(subscribed === false){
        return base + " You can check whether your connected YouTube account is subscribed to this channel.";
    }
    return base + " This may happen if the chat is subscriber-only, members-only, or has other restrictions.";
}

async function liveChatCheckSubscription(){
    const els = liveChatEls();
    const run = liveChatState.run;
    const sourceId = liveChatState.sourceId;
    if(!sourceId || liveChatState.stopped || run !== liveChatState.run){ return; }
    if(liveChatState.restrictionState === "checking" || liveChatState.subscriptionCheckState === "checking"){ return; }

    liveChatState.restrictionState = "checking";
    liveChatState.subscriptionCheckState = "checking";
    if(els.restrictionActions){ els.restrictionActions.textContent = "Checking subscription..."; }

    const result = await liveChatAuthedFetch("/api/liveChat/subscriptionStatus?videoId=" + encodeURIComponent(sourceId));
    if(liveChatState.stopped || run !== liveChatState.run || sourceId !== liveChatState.sourceId){ return; }

    if(!result.ok || !result.body || result.body.available !== true){
        liveChatState.restrictionState = "checked";
        liveChatState.subscriptionCheckState = "error";
        liveChatState.subscriptionSubscribed = null;
        liveChatState.chatRestrictionConfirmed = true;
        if(els.restrictionText){
            els.restrictionText.textContent = "Unable to verify your chat eligibility. Please try again.";
        }
        if(els.restrictionActions){ els.restrictionActions.textContent = ""; }
        liveChatApplySendVisibility();
        liveChatRenderRestrictionActions();
        return;
    }

    liveChatState.restrictionState = "checked";
    liveChatState.subscriptionCheckState = "ok";
    liveChatState.subscriptionSubscribed = result.body.subscribed === true;
    liveChatState.chatRestrictionConfirmed = true;
    if(els.restrictionText){
        if(liveChatState.subscriptionSubscribed === false){
            els.restrictionText.textContent = "You may need to subscribe to this channel to join the chat.";
        } else {
            els.restrictionText.textContent = "You are subscribed, but this chat may have additional restrictions.";
        }
    }
    liveChatApplySendVisibility();
    liveChatRenderRestrictionActions();
}

async function liveChatSubscribeAction(){
    const run = liveChatState.run;
    const sourceId = liveChatState.sourceId;
    if(!sourceId || liveChatState.stopped || run !== liveChatState.run){ return; }
    if(liveChatState.subscriptionActionInFlight){ return; }

    const confirmed = window.confirm("Subscribe to this channel with your connected YouTube account? This action happens only because you confirmed it.");
    if(!confirmed){ return; }
    if(liveChatState.stopped || run !== liveChatState.run || sourceId !== liveChatState.sourceId){ return; }

    liveChatState.subscriptionActionInFlight = true;
    const els = liveChatEls();
    liveChatRenderRestrictionActions();

    try{
        const result = await liveChatAuthedFetch("/api/liveChat/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: sourceId })
        });

        if(liveChatState.stopped || run !== liveChatState.run || sourceId !== liveChatState.sourceId){ return; }

        if(result.ok && result.body && result.body.subscribed === true){
            liveChatState.subscriptionSubscribed = true;
            liveChatState.restrictionState = "checked";
            liveChatState.chatRestrictionConfirmed = true;
            if(els.restrictionText){
                els.restrictionText.textContent = "Subscription completed. Refreshing chat eligibility...";
            }
            if(els.restrictionActions){ els.restrictionActions.textContent = ""; }
            // Refresh subscription status and chat state. Do not automatically resend.
            await liveChatCheckSubscription();
            if(!liveChatState.stopped && run === liveChatState.run && sourceId === liveChatState.sourceId){
                // Preserve valid restriction feedback across the restart when possible.
                const preserved = {
                    state: liveChatState.restrictionState,
                    subscribed: liveChatState.subscriptionSubscribed,
                    checkState: liveChatState.subscriptionCheckState,
                    confirmed: liveChatState.chatRestrictionConfirmed === true,
                    text: els.restrictionText ? els.restrictionText.textContent : ""
                };
                liveChatState.subscriptionActionInFlight = false;
                liveChatState.preserveRestrictionOnce = Boolean(preserved && preserved.text);
                liveChatStart(sourceId, true);
                if(preserved && preserved.text){
                    const elsAfter = liveChatEls();
                    liveChatState.restrictionState = preserved.state || "checked";
                    liveChatState.subscriptionSubscribed = preserved.subscribed;
                    liveChatState.subscriptionCheckState = preserved.checkState || "idle";
                    liveChatState.chatRestrictionConfirmed = preserved.confirmed === true;
                    if(elsAfter.restrictionText){ elsAfter.restrictionText.textContent = preserved.text; }
                    if(elsAfter.restriction){ elsAfter.restriction.hidden = false; }
                    liveChatApplySendVisibility();
                    liveChatRenderRestrictionActions();
                }
            }
            return;
        }

        if(liveChatState.stopped || run !== liveChatState.run || sourceId !== liveChatState.sourceId){ return; }
        liveChatState.restrictionState = "checked";
        liveChatState.subscriptionCheckState = "error";
        liveChatState.chatRestrictionConfirmed = true;
        if(els.restrictionText){
            const msg = (result.body && result.body.error) ? String(result.body.error) : "Couldn't subscribe right now.";
            els.restrictionText.textContent = "Unable to verify your chat eligibility. Please try again. " + msg;
        }
        liveChatApplySendVisibility();
        liveChatRenderRestrictionActions();
    }
    finally{
        if(run === liveChatState.run && sourceId === liveChatState.sourceId){
            liveChatState.subscriptionActionInFlight = false;
        }
        else if(liveChatState.stopped){
            liveChatState.subscriptionActionInFlight = false;
        }
        liveChatRenderRestrictionActions();
    }
}

function liveChatRenderRestrictionActions(){
    const els = liveChatEls();
    if(!els.restrictionActions) return;
    if(liveChatState.restrictionState === "checking") return;
    if(liveChatState.stopped) return;
    els.restrictionActions.textContent = "";

    if(liveChatState.subscriptionActionInFlight){
        const note = document.createElement("span");
        note.textContent = "Subscribing...";
        els.restrictionActions.appendChild(note);
        return;
    }

    const user = currentUser();
    if(!user){
        const note = document.createElement("span");
        note.textContent = "Sign in and connect your YouTube account to check subscription status.";
        els.restrictionActions.appendChild(note);
        return;
    }

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "live-chat-restriction-btn";
    checkBtn.textContent = "Check subscription";
    checkBtn.disabled = liveChatState.subscriptionActionInFlight === true;
    checkBtn.addEventListener("click", liveChatCheckSubscription);
    els.restrictionActions.appendChild(checkBtn);

    if(liveChatState.subscriptionSubscribed === false){
        const subBtn = document.createElement("button");
        subBtn.type = "button";
        subBtn.className = "live-chat-restriction-btn live-chat-restriction-btn--primary";
        subBtn.textContent = "Subscribe";
        subBtn.disabled = liveChatState.subscriptionActionInFlight === true;
        subBtn.addEventListener("click", liveChatSubscribeAction);
        els.restrictionActions.appendChild(subBtn);
    }
}

function liveChatShowRestriction(code){
    const els = liveChatEls();
    if(!els.restriction || !els.restrictionText) return;
    liveChatState.restrictionState = "idle";
    liveChatState.subscriptionSubscribed = null;
    liveChatState.chatRestrictionConfirmed = true;
    liveChatState.subscriptionCheckState = "idle";
    const isForbidden = String(code || "") === "CHAT_FORBIDDEN";
    if(els.restrictionText){
        els.restrictionText.textContent = isForbidden
            ? "You can't send messages in this chat. This may be due to subscriber-only mode, members-only mode, or other restrictions. Chat eligibility is not verified yet."
            : "You can't send messages in this chat right now. Chat eligibility is not verified yet.";
    }
    els.restriction.hidden = false;
    liveChatApplySendVisibility();
    liveChatRenderRestrictionActions();
}

// Does this account hold a usable YouTube scope? The send capability itself
// comes from the live-chat payload, so this probe only decides whether showing
// the composer is even meaningful. Failure leaves it hidden.
const SCOPE_VERIFY_MAX_RETRIES = 3;

function scheduleScopeVerifyRetry(run, isRecheck){
    if(liveChatState.stopped || run !== liveChatState.run){
        return;
    }
    if(liveChatState.scopeVerifyTimer){
        return;
    }
    if(liveChatState.scopeVerifyRetryCount >= SCOPE_VERIFY_MAX_RETRIES){
        // Retries exhausted - show temporary error, do not claim confirmed disconnect.
        liveChatState.sendScopeConfirmedReady = null;
        liveChatState.sendScopeReady = false;
        liveChatState.scopeVerifyExhausted = true;
        liveChatSendNote("Couldn't verify connection. Please try again.", "error");
        const els = liveChatEls();
        if(els && els.input){ els.input.disabled = true; }
        if(els && els.sendBtn){ els.sendBtn.disabled = true; }
        return;
    }
    const delay = Math.min(1500 * Math.pow(2, liveChatState.scopeVerifyRetryCount), 6000);
    liveChatState.scopeVerifyRetryCount += 1;
    liveChatState.scopeVerifyTimer = setTimeout(() => {
        liveChatState.scopeVerifyTimer = null;
        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }
        liveChatLoadSendCapability(run, { recheck: isRecheck, fromRetry: true });
    }, delay);
}

async function liveChatLoadSendCapability(run, options){
    const opts = options && typeof options === "object" ? options : {};
    const recheck = opts.recheck === true;
    const fromRetry = opts.fromRetry === true;

    if(recheck){
        if(liveChatState.scopeRecheckInFlight){
            return;
        }
        liveChatState.scopeRecheckInFlight = true;
        liveChatState.scopeRecheckRun = run;
    }

    try{
        if(!recheck){
            // Initial load: don't mark as confirmed not-ready. Keep unknown until confirmed.
            liveChatState.sendScopeReady = false;
            liveChatState.sendScopeConfirmedReady = null;
            if(!fromRetry){
                if(liveChatState.scopeVerifyTimer){
                    clearTimeout(liveChatState.scopeVerifyTimer);
                    liveChatState.scopeVerifyTimer = null;
                }
                liveChatState.scopeVerifyRetryCount = 0;
                liveChatState.scopeVerifyExhausted = false;
            }
            liveChatApplySendVisibility();
        }
        else{
            // During recheck, show temporary state without treating as confirmed disconnect.
            liveChatSendNote("Checking YouTube connection...", "");
            const els = liveChatEls();
            if(els && els.input){ els.input.disabled = true; }
            if(els && els.sendBtn){ els.sendBtn.disabled = true; }
        }

        const user = currentUser();

        if(!user || typeof user.getIdToken !== "function"){
            // No Firebase user/token: could be signed out or auth still initializing.
            // Do not confirm disconnect. Initial checks get bounded retries.
            liveChatState.sendScopeReady = false;
            liveChatState.sendScopeConfirmedReady = null;
            if(recheck){
                liveChatSendNote("Couldn't verify connection. Please try again.", "error");
                const els = liveChatEls();
                if(els && els.input){ els.input.disabled = true; }
                if(els && els.sendBtn){ els.sendBtn.disabled = true; }
            }
            else{
                liveChatSendNote("Verifying YouTube connection...", "");
                const els = liveChatEls();
                if(els && els.input){ els.input.disabled = true; }
                if(els && els.sendBtn){ els.sendBtn.disabled = true; }
                scheduleScopeVerifyRetry(run, false);
            }
            return;
        }

        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        if(auth && typeof auth.authStateReady === "function"){
            await auth.authStateReady();
        }

        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        const freshUser = currentUser() || user;
        if(!freshUser || typeof freshUser.getIdToken !== "function"){
            throw new Error("No user token available");
        }
        const token = await freshUser.getIdToken();

        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        const res = await fetch("/api/oauth/status", {
            headers: { Authorization: "Bearer " + token },
            cache: "no-store"
        });

        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        let body = null;
        if(res.ok){
            try{
                body = await res.json();
            }
            catch(e){
                body = null;
            }
        }

        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        if(res.ok && body && typeof body === "object"){
            // Only a valid 200 response can confirm scope state.
            const scopeReady = body.scopeReady === true;
            liveChatState.sendScopeReady = scopeReady;
            liveChatState.sendScopeConfirmedReady = scopeReady;
            liveChatState.scopeVerifyRetryCount = 0;
            liveChatState.scopeVerifyExhausted = false;
            if(liveChatState.scopeVerifyTimer){
                clearTimeout(liveChatState.scopeVerifyTimer);
                liveChatState.scopeVerifyTimer = null;
            }
            liveChatApplySendVisibility();
            return;
        }

        // Temporary failure (non-200, auth error, parse error, etc.) - do NOT claim confirmed disconnect.
        liveChatState.sendScopeConfirmedReady = null;
        if(!recheck){
            // Keep sendScopeReady false (not confirmed ready) but show temporary message and retry.
            liveChatState.sendScopeReady = false;
            liveChatSendNote("Checking YouTube connection...", "");
            const els = liveChatEls();
            if(els && els.input){ els.input.disabled = true; }
            if(els && els.sendBtn){ els.sendBtn.disabled = true; }
            scheduleScopeVerifyRetry(run, false);
        }
        else{
            liveChatSendNote("Couldn't verify connection. Please try again.", "error");
            const els = liveChatEls();
            if(els && els.input){ els.input.disabled = true; }
            if(els && els.sendBtn){ els.sendBtn.disabled = true; }
        }
    }
    catch(e){
        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }
        // Temporary failure (token/network/etc.) - do NOT claim confirmed disconnect.
        liveChatState.sendScopeConfirmedReady = null;
        if(!recheck){
            liveChatState.sendScopeReady = false;
            liveChatSendNote("Checking YouTube connection...", "");
            const els = liveChatEls();
            if(els && els.input){ els.input.disabled = true; }
            if(els && els.sendBtn){ els.sendBtn.disabled = true; }
            scheduleScopeVerifyRetry(run, false);
        }
        else{
            liveChatSendNote("Couldn't verify connection. Please try again.", "error");
            const els = liveChatEls();
            if(els && els.input){ els.input.disabled = true; }
            if(els && els.sendBtn){ els.sendBtn.disabled = true; }
        }
    }
    finally{
        if(recheck && liveChatState.scopeRecheckRun === run){
            liveChatState.scopeRecheckInFlight = false;
        }
    }
}


async function liveChatSubmit(event){
    if(event){
        event.preventDefault();
    }

    const els = liveChatEls();

    if(!els.input || !els.sendBtn || liveChatState.sendInFlight){
        return;
    }

    // A stale form (capability revoked server-side) must not fire a request.
    if(liveChatState.sendEnabled !== true || liveChatState.sendScopeReady !== true){
        liveChatApplySendVisibility();
        return;
    }

    const text = String(els.input.value || "");
    const sourceId = liveChatState.sourceId;
    const run = liveChatState.run;
    const user = currentUser();

    if(!sourceId || !user){
        liveChatSendNote("This live chat is no longer available.", "error");
        return;
    }

    if(text.trim() === ""){
        liveChatSendNote("Type a message first.", "error");
        els.input.focus();
        return;
    }

    // Count code points, matching the server's 200-character rule (an emoji is
    // one character, not two).
    if(Array.from(text).length > 200){
        liveChatSendNote("Messages can be up to 200 characters.", "error");
        els.input.focus();
        return;
    }

    liveChatState.sendInFlight = true;
    els.input.disabled = true;
    els.sendBtn.disabled = true;
    liveChatSendNote("Sending...", "");

    const ownsCurrentStream = () => (
        !liveChatState.stopped &&
        run === liveChatState.run &&
        sourceId === liveChatState.sourceId
    );

    try{
        const token = await user.getIdToken();
        if(!ownsCurrentStream()){
            return;
        }

        const requestId =
            (window.crypto && typeof window.crypto.randomUUID === "function")
                ? window.crypto.randomUUID()
                : ("r" + Date.now() + Math.floor(Math.random() * 1000000));

        const res = await fetch("/api/liveChat/send", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
            },
            body: JSON.stringify({
                videoId: sourceId,
                text: text,
                requestId: requestId
            })
        });

        if(!ownsCurrentStream()){
            return;
        }

        let body = null;

        try{
            body = await res.json();
        }
        catch(e){
            body = null;
        }

        if(!ownsCurrentStream()){
            return;
        }

        if(res.ok && body && body.ok === true){
            // Show the confirmed message immediately; the next poll will also
            // return it, and the dedupe set keeps it from appearing twice.
            if(body.message && body.message.id){
                liveChatRender([body.message], null);
            }

            els.input.value = "";
            liveChatSendNote("Sent.", "ok");
            return;
        }

        const code = String((body && body.code) || "");

        liveChatSendNote(liveChatSendErrorMessage(code, res.status), "error");

        if(code === "LIVE_CHAT_ENDED" || code === "CHAT_DISABLED" || code === "LIVE_CHAT_NOT_FOUND"){
            liveChatClearRestriction();
            liveChatSetSendVisible(false);
        }
        else if(code === "CHAT_FORBIDDEN"){
            liveChatShowRestriction(code);
        }
        else if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
            liveChatClearRestriction();
            // Don't mark as confirmed disconnect. Recheck OAuth status.
            liveChatSendNote("Verifying YouTube connection...", "");
            liveChatLoadSendCapability(liveChatState.run, { recheck: true });
            return;
        }
        else if(code === "CHAT_SEND_DISABLED"){
            liveChatClearRestriction();
            liveChatState.sendEnabled = false;
            liveChatSetSendVisible(false);
        }
        else {
            liveChatClearRestriction();
        }
    }
    catch(e){
        if(!ownsCurrentStream()){
            return;
        }
        liveChatSendNote("We couldn't reach MyTube. Check your connection and try again.", "error");
    }
    finally{
        if(ownsCurrentStream()){
            liveChatState.sendInFlight = false;
            if(!liveChatState.scopeRecheckInFlight){
                liveChatApplySendVisibility();
            }

            if(els.form && !els.form.hidden && els.input && !liveChatState.scopeRecheckInFlight){
                els.input.focus();
            }
        }
    }
}


// Start following the live chat for a video. `isLive` comes from the video's own
// liveStreamingDetails, so a non-live video never triggers any chat traffic.
function liveChatStart(sourceId, isLive){
    if(!sourceId || !isLive){
        liveChatStop(true);
        return;
    }

    const els = liveChatEls();

    if(!els.panel){
        return;
    }

    // Already following this stream: nothing to do.
    if(liveChatState.sourceId === sourceId && !liveChatState.stopped){
        return;
    }

    liveChatStop(false);

    const run = ++liveChatState.run;
    liveChatState.stopped = false;
    liveChatState.sourceId = sourceId;

    els.panel.hidden = false;
    // Aim the "Chat provided by YouTube" link at this exact stream.
    liveChatSetAttrib(sourceId);
    liveChatSetBadge("LIVE", false);
    liveChatSetMeta("");
    liveChatSetStatus("Connecting to live chat...");

    // Wire the composer once, keep it hidden, and check the account's YouTube
    // scope in parallel with the first poll. The poll result supplies the
    // server-side send capability.
    liveChatBindSendForm();
    liveChatSetSendVisible(false);
    liveChatLoadSendCapability(run);

    // Poll one batch. The server decides whether this is the first fetch (it then
    // returns recent history) or a follow-up (it returns only new messages), so
    // the client does not have to know. `isFirstPoll` asks for the history on our
    // opening request, which also covers joining a stream another viewer already
    // has open - the server then serves cached history instead of an empty delta.
    let isFirstPoll = true;

    const poll = async () => {
        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        // A hidden tab must not keep spending the shared upstream poll.
        if(document.visibilityState === "hidden"){
            liveChatState.paused = true;
            liveChatState.timer = null;
            return;
        }

        const result = await liveChat(sourceId, "", isFirstPoll);
        isFirstPoll = false;

        // A newer video took over while this request was in flight.
        if(liveChatState.stopped || run !== liveChatState.run){
            return;
        }

        if(document.visibilityState === "hidden"){
            liveChatState.paused = true;
            liveChatState.timer = null;
            return;
        }

        if(!result.ok){
            // Transient failure: back off and retry rather than showing an error.
            liveChatSetStatus("Live chat is reconnecting...");
            liveChatSetSendVisible(false);
            liveChatState.timer = setTimeout(poll, 10000);
            return;
        }

        if(!result.isLive){
            // The stream ended (or never really started) between renders.
            liveChatFinish("ended");
            return;
        }

        if(result.concurrentViewers){
            liveChatSetMeta(liveChatFormatViewers(result.concurrentViewers));
        }

        const added = liveChatRender(result.messages, result.activePoll);
        const els2 = liveChatEls();

        if(result.chatStatus === "ended" || result.chatStatus === "disabled" || result.chatStatus === "not_found"){
            liveChatFinish(result.chatStatus);
            return;
        }

        // Live, but YouTube reports no active chat: the broadcaster has chat
        // off, or the chat has not opened yet. Say so plainly instead of waiting
        // forever behind a "waiting" message; keep a slow poll in case it opens.
        if(result.chatStatus === "no_chat"){
            if(els2.list && els2.list.childElementCount === 0){
                liveChatSetStatus(
                    "Live chat is turned off for this broadcast, or has not started yet."
                );
            }
            liveChatSetSendVisible(false);
            liveChatState.timer = setTimeout(poll, 15000);
            return;
        }

        // The broadcast stopped being live between renders.
        if(result.chatStatus === "not_live"){
            liveChatFinish("ended");
            return;
        }

        if(result.chatStatus === "error"){
            liveChatSetStatus("Live chat is temporarily unavailable. Retrying...");
            liveChatSetSendVisible(false);
            liveChatState.timer = setTimeout(poll, 10000);
            return;
        }

        // The payload is the only source of truth for the server kill switch.
        // `undefined` (older payload) is treated as off, never as on.
        liveChatState.sendEnabled = result.chatSendEnabled === true;
        liveChatApplySendVisibility();

        // Status is "live" here. Say something only when there is genuinely
        // nothing to show, so a busy chat is not cluttered with text.
        if(added === 0 && els2.list && els2.list.childElementCount === 0){
            liveChatSetStatus("Waiting for chat messages...");
        }
        else{
            liveChatSetStatus("");
        }

        liveChatState.timer = setTimeout(poll, liveChatInterval(result.pollingIntervalMillis));
    };

    // Kept so a hidden-tab pause can be resumed by the visibilitychange handler.
    liveChatState.tick = poll;
    liveChatState.timer = setTimeout(poll, 0);
}


// Called once real YouTube metadata has loaded. Reveals the panel only for a
// live broadcast.
function maybeStartLiveChat(video){
    if(!video || !isYt){
        liveChatStop(true);
        return;
    }

    const sourceId = ytSourceId(rawId);

    liveChatStart(sourceId, Boolean(video.isLive));
}


window.addEventListener("pagehide", () => {
    unsubFirestoreComments();
    liveChatStop(false);
});


// Don't poll a chat nobody is looking at. A hidden tab stops the loop entirely
// (saving the shared upstream poll); returning to the tab resumes the same
// stream where it left off.
document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden"){
        if(liveChatState.timer){
            clearTimeout(liveChatState.timer);
            liveChatState.timer = null;
        }

        liveChatState.paused = Boolean(liveChatState.sourceId);
        return;
    }

    if(liveChatState.paused && liveChatState.tick && !liveChatState.stopped){
        liveChatState.paused = false;
        liveChatState.timer = setTimeout(liveChatState.tick, 0);
    }

    // Refresh actual YouTube rating when returning to the tab (throttled per video).
    if(isYoutubeRatingVideo()){
        void loadYoutubeRating({ force: false });
    }
});


function renderComments(){
    const container = document.getElementById("comments");
    const countEl = document.getElementById("commentCount");

    if(!container){
        return;
    }

    // For YouTube videos, public comments (async) and MyTube comments are shown
    // together in this one section, clearly distinguished by sub-headings.
    renderMergedComments(container, countEl);
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
    appendSafeLineContent(text, comment.text || "");

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
    if(ytKeyControlAvailable()){
        if(ytPlayer.isMuted()){
            ytPlayer.unMute();
        }
        else{
            ytPlayer.mute();
        }
        return;
    }
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
    if(ytKeyControlAvailable()){
        if(ytPlayer.getPlayerState() === YT.PlayerState.PLAYING){
            ytPlayer.pauseVideo();
        }
        else{
            ytPlayer.playVideo();
        }
        return;
    }
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
    if(ytKeyControlAvailable()){
        const duration = ytPlayer.getDuration();
        if(!duration || !isFinite(duration)){
            return;
        }
        const next = Math.min(Math.max(ytPlayer.getCurrentTime() + amount, 0), duration);
        ytPlayer.seekTo(next, true);
        return;
    }
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

// ================= YOUTUBE RATING SYNC (Phase 2) =================
// For YouTube videos, the connected YouTube account's actual rating is the
// source of truth (GET/POST /api/youtube/rating). MyTube Liked Library is
// independent and must never be presented as actual YouTube rating. Local vote
// storage is preserved for non-YouTube/local behavior only.
const YT_RATING_REFRESH_MIN_MS = 45 * 1000;
let ytRatingState = "none"; // last confirmed: like | dislike | none
let ytRatingStatus = "idle"; // idle | loading | ready | stale | unavailable | auth_required | connect_required | error
let ytRatingConfirmed = false; // true only after a successful GET/POST confirmation for current context
let ytRatingSeq = 0;
let ytRatingActiveVideoId = "";
let ytRatingWriteInFlight = false;
let ytRatingReadController = null;
const ytRatingLastFetchAt = new Map(); // videoId -> ms

function currentYoutubeSourceId(){
    if(!isYt){
        return "";
    }
    const sid = typeof ytSourceId === "function" ? ytSourceId(rawId) : "";
    if(/^[A-Za-z0-9_-]{11}$/.test(String(sid || ""))){
        return String(sid);
    }
    const activeSid = active && (active.sourceId || (typeof active.id === "string" && active.id.startsWith("yt:") ? active.id.slice(3) : ""));
    return /^[A-Za-z0-9_-]{11}$/.test(String(activeSid || "")) ? String(activeSid) : "";
}

function normalizeYoutubeRatingValue(value){
    const rating = String(value || "").trim().toLowerCase();
    if(rating === "like" || rating === "dislike" || rating === "none") return rating;
    return "none";
}

function isYoutubeRatingVideo(){
    return Boolean(isYt && currentYoutubeSourceId());
}

function resetYoutubeRatingState(status = "idle"){
    ytRatingSeq += 1;
    if(ytRatingReadController){
        try{ ytRatingReadController.abort(); } catch(e){}
        ytRatingReadController = null;
    }
    ytRatingWriteInFlight = false;
    ytRatingStatus = status;
    ytRatingState = "none";
    ytRatingConfirmed = false;
    ytRatingActiveVideoId = currentYoutubeSourceId();
}

// ================= CONNECTED YOUTUBE ACCOUNT IDENTITY =================
// Read-only identity of the account that will perform YouTube actions. It is
// resolved from the same OAuth grant used by the rating/subscription endpoints,
// never from the video's channel or a locally stored name.
const ytIdentity = createYoutubeAccountIdentity({
    getUid: () => {
        const user = typeof currentUser === "function" ? currentUser() : null;
        return user && user.uid ? String(user.uid) : "";
    },
    getToken: () => getFirebaseIdTokenForYoutube(),
    onChange: () => {
        renderYtActingAccount();
        renderLikeDislike();
        renderYtAccountSub();
    }
});

function ensureYtActingAccountEl(){
    if(!isYt){
        return null;
    }
    let el = document.getElementById("ytActingAccount");
    if(el){
        return el;
    }
    const anchor = dislikeBtn || likeBtn;
    if(!anchor || !anchor.parentElement || !anchor.parentElement.parentElement){
        return null;
    }
    const actionsRow = anchor.parentElement;
    el = document.createElement("div");
    el.id = "ytActingAccount";
    el.className = "yt-acting-account";
    el.style.fontSize = "12px";
    el.style.color = "#aaa";
    el.style.marginTop = "6px";
    el.style.lineHeight = "1.4";
    el.setAttribute("aria-live", "polite");
    // Place the label below the whole action row, not inside the flex row.
    actionsRow.parentElement.insertBefore(el, actionsRow.nextSibling);
    return el;
}

function renderYtActingAccount(){
    const el = ensureYtActingAccountEl();
    if(!el){
        return;
    }
    el.style.display = "";
    const s = ytIdentity.state;
    if(s.status === "ready" && s.channel && s.channel.title){
        el.textContent = "Acting as " + s.channel.title + " on YouTube";
    }
    else if(s.status === "multiple"){
        el.textContent = ytIdentity.blockedMessage();
    }
    else if(s.status === "none"){
        el.textContent = ytIdentity.blockedMessage();
    }
    else if(s.status === "signed_out"){
        el.textContent = "Sign in to use YouTube actions.";
    }
    else if(s.status === "disconnected"){
        el.textContent = "Connect your YouTube account in Profile to use YouTube actions.";
    }
    else if(s.status === "error"){
        el.textContent = s.lastError || "Could not identify your connected YouTube account.";
    }
    else if(s.status === "loading"){
        el.textContent = "Checking connected YouTube account...";
    }
    else{
        el.textContent = "";
        el.style.display = "none";
    }
}

function loadYoutubeAccountIdentity(options = {}){
    return ytIdentity.load(options);
}

async function getFirebaseIdTokenForYoutube(){
    const user = currentUser ? currentUser() : (auth && auth.currentUser);
    if(!user || typeof user.getIdToken !== "function"){
        return null;
    }
    if(auth && typeof auth.authStateReady === "function"){
        try{ await auth.authStateReady(); } catch(e){}
    }
    const freshUser = (currentUser ? currentUser() : null) || (auth && auth.currentUser) || user;
    if(!freshUser || typeof freshUser.getIdToken !== "function"){
        return null;
    }
    try{
        return await freshUser.getIdToken();
    }
    catch(e){
        return null;
    }
}

async function fetchYoutubeRatingApi(videoId, signal){
    const token = await getFirebaseIdTokenForYoutube();
    if(!token){
        return { ok: false, status: 401, code: "UNAUTHENTICATED", body: null };
    }
    const res = await fetch("/api/youtube/rating?videoId=" + encodeURIComponent(videoId), {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
        signal
    });
    let body = null;
    try{ body = await res.json(); } catch(e){ body = null; }
    return { ok: res.ok, status: res.status, code: body && body.code ? String(body.code) : "", body };
}

async function postYoutubeRatingApi(videoId, rating, expectedChannelId, expectedUid){
    const token = await getFirebaseIdTokenForYoutube();
    if(!token){
        return { ok: false, status: 401, code: "UNAUTHENTICATED", body: null };
    }
    const res = await fetch("/api/youtube/rating", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ videoId, rating, expectedChannelId, expectedUid }),
        cache: "no-store"
    });
    let body = null;
    try{ body = await res.json(); } catch(e){ body = null; }
    return { ok: res.ok, status: res.status, code: body && body.code ? String(body.code) : "", body };
}

function youtubeRatingCodeToStatus(code){
    if(code === "UNAUTHENTICATED") return "auth_required";
    if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED") return "connect_required";
    return "unavailable";
}

function showYoutubeRatingGuidance(){
    if(!isYoutubeRatingVideo()) return;
    if(ytRatingStatus === "auth_required"){
        setActionMsg("Sign in to rate this video on YouTube.");
        return;
    }
    if(ytRatingStatus === "connect_required"){
        setActionMsg("Connect your YouTube account in Profile to rate videos.");
        return;
    }
    if(ytRatingStatus === "unavailable"){
        setActionMsg("YouTube rating is unavailable right now.");
    }
}

function canRefreshYoutubeRating(videoId, force){
    if(force) return true;
    const last = ytRatingLastFetchAt.get(videoId) || 0;
    return (Date.now() - last) >= YT_RATING_REFRESH_MIN_MS;
}

async function loadYoutubeRating(options = {}){
    if(!isYoutubeRatingVideo()){
        return;
    }
    const videoId = currentYoutubeSourceId();
    if(!videoId){
        return;
    }
    if(!options.force && !canRefreshYoutubeRating(videoId, false)){
        return;
    }

    // Non-blocking: never delays the rating read or Live Chat initialization.
    void loadYoutubeAccountIdentity({ force: false });

    const user = currentUser ? currentUser() : (auth && auth.currentUser);
    if(!user){
        ytRatingSeq += 1;
        ytRatingActiveVideoId = videoId;
        // Preserve last confirmed rating; show sign-in guidance truthfully.
        ytRatingStatus = "auth_required";
        renderLikeDislike();
        setActionMsg("Sign in to rate this video on YouTube.");
        return;
    }

    const seq = ++ytRatingSeq;
    ytRatingActiveVideoId = videoId;
    ytRatingStatus = "loading";
    if(ytRatingReadController){
        try{ ytRatingReadController.abort(); } catch(e){}
    }
    const controller = new AbortController();
    ytRatingReadController = controller;
    renderLikeDislike();

    let result;
    try{
        result = await fetchYoutubeRatingApi(videoId, controller.signal);
    }
    catch(e){
        if(e && e.name === "AbortError") return;
        result = { ok: false, code: "UPSTREAM_ERROR", body: null };
    }
    finally{
        if(ytRatingReadController === controller){
            ytRatingReadController = null;
        }
    }

    if(seq !== ytRatingSeq || currentYoutubeSourceId() !== videoId){
        return;
    }

    ytRatingLastFetchAt.set(videoId, Date.now());

    if(result && result.ok && result.body && result.body.ok === true){
        ytRatingState = normalizeYoutubeRatingValue(result.body.rating);
        ytRatingConfirmed = true;
        ytRatingStatus = "ready";
        renderLikeDislike();
        return;
    }

    const code = result && (result.code || (result.body && result.body.code)) ? String(result.code || result.body.code) : "UPSTREAM_ERROR";
    const mappedStatus = youtubeRatingCodeToStatus(code);

    if(mappedStatus === "auth_required" || mappedStatus === "connect_required"){
        // Preserve last confirmed rating; show guidance without silently changing it.
        ytRatingStatus = mappedStatus;
        if(mappedStatus === "auth_required"){
            ytIdentity.clear("signed_out");
        }
        else{
            ytIdentity.clear("disconnected");
        }
        renderLikeDislike();
        if(mappedStatus === "auth_required"){
            setActionMsg("Sign in to rate this video on YouTube.");
        }
        else{
            setActionMsg("Connect or reconnect your YouTube account in Profile to rate videos.");
        }
        return;
    }

    if(ytRatingConfirmed){
        // Preserve last confirmed rating on temporary refresh failures (network,
        // timeout, quota, rate limits, upstream). Keep UI truthful.
        ytRatingStatus = "stale";
        renderLikeDislike();
        if(code === "QUOTA_EXCEEDED"){
            setActionMsg("Couldn't refresh your YouTube rating (quota reached). Showing your last confirmed rating.");
        }
        else if(code === "RATE_LIMITED" || code === "CHAT_RATE_LIMITED"){
            setActionMsg("Couldn't refresh your YouTube rating right now. Showing your last confirmed rating.");
        }
        else{
            setActionMsg("Couldn't refresh your YouTube rating. Showing your last confirmed rating.");
        }
        return;
    }

    // No previously confirmed rating: show unavailable truthfully.
    ytRatingState = "none";
    ytRatingConfirmed = false;
    ytRatingStatus = "unavailable";
    renderLikeDislike();
}


function restoreVoteState(){
    // For YouTube videos, actual rating comes from the connected YouTube account
    // via the backend API. Never use local/library state as YouTube rating truth.
    if(isYt){
        voteState = "neutral";
        isLiked = false;
        isDisliked = false;
        resetYoutubeRatingState("loading");
        renderLikeDislike();
        return;
    }

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
    if(isYoutubeRatingVideo()){
        // Reflect last confirmed rating (truthful). "ready" means freshly confirmed;
        // "stale"/guidance/error states may still show a previously confirmed rating.
        const hasConfirmed = ytRatingConfirmed === true;
        const liked = hasConfirmed && ytRatingState === "like";
        const disliked = hasConfirmed && ytRatingState === "dislike";
        const busy = ytRatingStatus === "loading" || ytRatingWriteInFlight;
        const identityStatus = ytIdentity.state.status;
        const identityBlocked = ytIdentity.isBlocked()
            || identityStatus === "loading"
            || identityStatus === "error"
            || identityStatus === "idle";
        const disableActions = busy || identityBlocked; // allow clicks for auth/connect guidance when not busy

        function ytRatingTitle(defaultTitle){
            if(identityBlocked){
                return ytIdentity.identityMessage();
            }
            if(ytRatingStatus === "auth_required"){
                return "Sign in to rate this video on YouTube";
            }
            if(ytRatingStatus === "connect_required"){
                return "Connect your YouTube account to rate videos";
            }
            if(busy){
                return "Updating rating...";
            }
            if(ytRatingStatus === "stale" && hasConfirmed){
                return "Showing your last confirmed YouTube rating (refresh failed)";
            }
            if((ytRatingStatus === "unavailable" || ytRatingStatus === "error") && !hasConfirmed){
                return "YouTube rating unavailable";
            }
            if((ytRatingStatus === "unavailable" || ytRatingStatus === "error") && hasConfirmed){
                return "Couldn't refresh YouTube rating; showing last confirmed rating";
            }
            return defaultTitle || "";
        }

        if(likeBtn){
            likeBtn.classList.toggle("active", liked);
            likeBtn.textContent = "👍 " + (liked ? "Liked" : "Like") + ytLikeCountSuffix();
            likeBtn.setAttribute("aria-pressed", liked ? "true" : "false");
            likeBtn.disabled = Boolean(disableActions);
            likeBtn.title = ytRatingTitle("");
        }
        if(dislikeBtn){
            dislikeBtn.classList.toggle("active", disliked);
            dislikeBtn.textContent = "👎 " + (disliked ? "Disliked" : "Dislike");
            dislikeBtn.setAttribute("aria-pressed", disliked ? "true" : "false");
            dislikeBtn.disabled = Boolean(disableActions);
            dislikeBtn.title = ytRatingTitle("");
        }
        return;
    }

    // Local/non-YouTube behavior (preserved).
    if(likeBtn){
        likeBtn.classList.toggle("active", isLiked);
        likeBtn.textContent = "👍 " + (isLiked ? "Liked" : "Like") + ytLikeCountSuffix();
        likeBtn.setAttribute("aria-pressed", isLiked ? "true" : "false");
        likeBtn.disabled = false;
        likeBtn.title = "";
    }
    if(dislikeBtn){
        dislikeBtn.classList.toggle("active", isDisliked);
        dislikeBtn.textContent = "👎 " + (isDisliked ? "Disliked" : "Dislike");
        dislikeBtn.setAttribute("aria-pressed", isDisliked ? "true" : "false");
        dislikeBtn.disabled = false;
        dislikeBtn.title = "";
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


function setLocalVote(next){
    // Existing local/non-YouTube behavior (preserved).
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

    // Persist liked state to Firestore when logged in (existing behavior).
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

async function setYoutubeVote(next){
    // next: "like" | "dislike" (user intent). Actual rating sent to YouTube is
    // like/dislike/none based on confirmed current state.
    if(!isYoutubeRatingVideo()){
        return;
    }

    if(ytRatingStatus === "auth_required"){
        setActionMsg("Sign in to rate this video on YouTube.");
        renderLikeDislike();
        return;
    }
    if(ytRatingStatus === "connect_required"){
        setActionMsg("Connect your YouTube account in Profile to rate videos.");
        renderLikeDislike();
        return;
    }
    if(ytRatingWriteInFlight || ytRatingStatus === "loading"){
        return;
    }

    const videoId = currentYoutubeSourceId();
    if(!videoId){
        return;
    }

    // Capture the identity the user is currently shown, then force-refresh it
    // immediately before the write. A changed user/channel blocks the action;
    // the backend also re-verifies the expected channel independently.
    const expected = ytIdentity.mutationGuard();
    if(!expected.uid || !expected.channelId){
        setActionMsg(ytIdentity.identityMessage());
        renderLikeDislike();
        return;
    }

    const seq = ++ytRatingSeq;
    ytRatingWriteInFlight = true;
    renderLikeDislike();

    const guard = await ytIdentity.verifyForMutation(expected);
    if(seq !== ytRatingSeq){
        ytRatingWriteInFlight = false;
        renderLikeDislike();
        return;
    }
    if(!guard.ok){
        ytRatingWriteInFlight = false;
        setActionMsg(ytIdentity.mutationFailureMessage(guard.reason));
        renderLikeDislike();
        return;
    }

    // Determine target rating from last confirmed state only.
    const confirmed = ytRatingConfirmed === true ? ytRatingState : "none";
    let target = "none";
    if(next === "like"){
        target = confirmed === "like" ? "none" : "like";
    }
    else if(next === "dislike"){
        target = confirmed === "dislike" ? "none" : "dislike";
    }
    else{
        ytRatingWriteInFlight = false;
        renderLikeDislike();
        return;
    }

    let result;
    try{
        result = await postYoutubeRatingApi(videoId, target, expected.channelId, expected.uid);
    }
    catch(e){
        result = { ok: false, code: "UPSTREAM_ERROR", body: null };
    }

    if(seq !== ytRatingSeq || currentYoutubeSourceId() !== videoId){
        // Stale response/video changed; do not apply.
        ytRatingWriteInFlight = false;
        renderLikeDislike();
        return;
    }

    ytRatingWriteInFlight = false;

    if(result && result.ok && result.body && result.body.ok === true){
        ytRatingState = normalizeYoutubeRatingValue(result.body.rating || target);
        ytRatingConfirmed = true;
        ytRatingStatus = "ready";
        ytRatingLastFetchAt.set(videoId, Date.now());

        // MyTube Liked Library is independent from actual YouTube rating.
        // Successful YouTube like may add; dislike/none must NOT delete.
        const uid = uidOrNull();
        if(uid && active && ytRatingState === "like"){
            try{
                await addToLiked(uid, {
                    videoId: active.id || ("yt:" + videoId),
                    type: "youtube",
                    title: active.title || "",
                    thumb: active.thumb || "",
                    channel: active.channel || "",
                    views: active.views || "",
                    duration: active.time || "",
                    likeCount: (typeof active.likeCount === "number") ? active.likeCount : 0
                });
            }
            catch(e){
                console.warn("Failed to add YouTube-liked video to MyTube library:", e);
            }
        }

        renderLikeDislike();
        return;
    }

    // Preserve previous confirmed state on failure. Never silently fall back.
    const code = result && (result.code || (result.body && result.body.code)) ? String(result.code || result.body.code) : "UPSTREAM_ERROR";
    const mappedStatus = youtubeRatingCodeToStatus(code);
    if(mappedStatus === "auth_required" || mappedStatus === "connect_required"){
        // Preserve stored last-confirmed rating; show guidance and drop the
        // stale identity so the next action cannot use an invalid grant.
        ytRatingStatus = mappedStatus;
        if(mappedStatus === "auth_required"){
            ytIdentity.clear("signed_out");
        }
        else{
            ytIdentity.clear("disconnected");
        }
    }
    else if(code === "YOUTUBE_IDENTITY_CHANGED" || code === "MULTIPLE_CHANNELS" || code === "YOUTUBE_IDENTITY_UNVERIFIED"){
        // The grant no longer matches what the user saw. Drop the stale view and
        // re-read the current grant so the next action starts from the truth.
        ytIdentity.clear("idle");
        void ytIdentity.load({ force: true });
    }
    // Otherwise keep ytRatingConfirmed/ytRatingState unchanged.
    renderLikeDislike();
    if(code === "UNAUTHENTICATED"){
        setActionMsg("Sign in to rate this video on YouTube.");
    }
    else if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
        setActionMsg("Connect or reconnect your YouTube account in Profile to rate videos.");
    }
    else if(code === "YOUTUBE_IDENTITY_CHANGED"){
        setActionMsg("Your connected YouTube channel changed. Reconnect your YouTube account using the intended channel and try again.");
    }
    else if(code === "MULTIPLE_CHANNELS"){
        setActionMsg("Multiple YouTube channels are available for this Google account. Reconnect using the intended channel before rating videos.");
    }
    else if(code === "YOUTUBE_IDENTITY_UNVERIFIED"){
        setActionMsg("Could not verify your connected YouTube channel. Reload the page and try again.");
    }
    else if(code === "QUOTA_EXCEEDED"){
        setActionMsg("YouTube's daily limit has been reached. Please try again later.");
    }
    else if(code === "RATE_LIMITED" || code === "CHAT_RATE_LIMITED"){
        setActionMsg("You're making requests too quickly. Please wait a moment.");
    }
    else{
        setActionMsg("Could not update your YouTube rating. Please try again.");
    }
}

function setVote(next){
    if(isYoutubeRatingVideo()){
        void setYoutubeVote(next);
        return;
    }
    setLocalVote(next);
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


// ================= YOUTUBE ACCOUNT SUBSCRIPTION (explicit, confirmed, separate) =================
// Actual connected YouTube account subscription status/actions for the current
// channel. Completely separate from MyTube-local subscription (localStorage/Firestore)
// handled below. Never auto-subscribes/unsubscribes. Mutations require explicit
// user action + clear confirmation and update UI only after confirmed backend success.
// On uncertain mutation timeout/error, refreshes status via GET; never blindly retries.
const ytAccountSubState = {
    seq: 0,
    mutationSeq: 0,
    channelId: "",
    uid: "",
    status: "idle", // idle | signed_out | disconnected | loading | ready | unavailable | mutating
    subscribed: null, // true | false | null (unknown/unavailable)
    statusInFlight: false,
    mutationInFlight: false,
    lastError: ""
};

let ytAccountSubUi = null;

function isValidYoutubeChannelIdClient(value){
    const channelId = String(value || "").trim();
    return channelId.length > 0 && channelId.length <= 128 && /^[A-Za-z0-9_-]+$/.test(channelId);
}

function currentYtAccountChannelId(){
    if(!isYt) return "";
    const v = active || current || null;
    const cid = v && typeof v.channelId === "string" ? v.channelId.trim() : "";
    return isValidYoutubeChannelIdClient(cid) ? cid : "";
}

function ensureYtAccountSubUi(){
    if(ytAccountSubUi && ytAccountSubUi.root && ytAccountSubUi.root.isConnected){
        return ytAccountSubUi;
    }
    if(!subscribeBtn || !subscribeBtn.parentElement){
        return null;
    }
    let root = document.getElementById("ytAccountSubRoot");
    if(!root){
        root = document.createElement("div");
        root.id = "ytAccountSubRoot";
        root.className = "yt-account-sub-watch";
        root.style.marginTop = "8px";
        root.style.display = "none";
        root.style.maxWidth = "360px";

        const label = document.createElement("div");
        label.className = "yt-account-sub-watch-label";
        label.style.fontSize = "12px";
        label.style.color = "#aaa";
        label.style.marginBottom = "4px";
        label.textContent = "YouTube account";

        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.flexWrap = "wrap";

        const status = document.createElement("span");
        status.id = "ytAccountSubStatus";
        status.style.fontSize = "13px";
        status.style.color = "#ddd";
        status.setAttribute("aria-live", "polite");

        const btn = document.createElement("button");
        btn.id = "ytAccountSubBtn";
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.style.fontSize = "13px";
        btn.style.padding = "6px 10px";

        row.appendChild(status);
        row.appendChild(btn);
        root.appendChild(label);
        root.appendChild(row);
        subscribeBtn.parentElement.insertBefore(root, subscribeBtn.nextSibling);
    }
    ytAccountSubUi = {
        root,
        label: root.querySelector(".yt-account-sub-watch-label"),
        status: root.querySelector("#ytAccountSubStatus"),
        btn: root.querySelector("#ytAccountSubBtn")
    };
    return ytAccountSubUi;
}

function ytAccountSubAuthUid(){
    const user = (typeof currentUser === "function" ? currentUser() : null) || (auth && auth.currentUser) || null;
    return user && user.uid ? String(user.uid) : "";
}

function renderYtAccountSub(){
    const ui = ensureYtAccountSubUi();
    if(!ui) return;
    const channelId = currentYtAccountChannelId();
    const show = Boolean(isYt && channelId);
    ui.root.style.display = show ? "" : "none";
    if(!show) return;

    if(ui.label){
        const acting = ytIdentity.label();
        ui.label.textContent = acting
            ? ("YouTube account: acting as " + acting)
            : "YouTube account";
    }

    const s = ytAccountSubState;
    const busy = s.statusInFlight || s.mutationInFlight || s.status === "loading" || s.status === "mutating";
    const identityStatus = ytIdentity.state.status;
    const identityBlocked = ytIdentity.isBlocked()
        || identityStatus === "loading"
        || identityStatus === "error"
        || identityStatus === "idle";
    let statusText = "Status unavailable.";
    let btnText = "Check status";
    let btnDisabled = busy || identityBlocked;

    if(identityBlocked){
        statusText = ytIdentity.identityMessage();
        btnText = "Check status";
        btnDisabled = busy;
    } else if(!ytAccountSubAuthUid()){
        statusText = "Sign in to check your YouTube account subscription.";
        btnText = "Sign in";
        btnDisabled = false;
    } else if(s.status === "loading"){
        statusText = "Checking YouTube account status...";
        btnText = "Checking...";
    } else if(s.status === "mutating"){
        statusText = "Updating YouTube account subscription...";
        btnText = "Updating...";
    } else if(s.status === "disconnected"){
        statusText = "Connect your YouTube account in Profile to manage subscriptions.";
        btnText = "Open Profile";
        btnDisabled = false;
    } else if(s.status === "ready"){
        if(s.subscribed === true){
            statusText = "Subscribed on your YouTube account.";
            btnText = "Unsubscribe on YouTube";
            btnDisabled = busy;
        } else if(s.subscribed === false){
            statusText = "Not subscribed on your YouTube account.";
            btnText = "Subscribe on YouTube";
            btnDisabled = busy;
        } else {
            statusText = "YouTube account status unavailable.";
            btnText = "Check status";
            btnDisabled = busy;
        }
    } else if(s.status === "unavailable"){
        statusText = s.lastError || "YouTube account status unavailable.";
        btnText = "Refresh status";
        btnDisabled = busy;
    } else {
        statusText = "Check your YouTube account subscription status.";
        btnText = "Check status";
        btnDisabled = busy;
    }

    if(ui.status) ui.status.textContent = statusText;
    if(ui.btn){
        ui.btn.textContent = btnText;
        ui.btn.disabled = Boolean(btnDisabled);
    }
}

function ytAccountSubSetUnavailable(msg, status){
    ytAccountSubState.status = status || "unavailable";
    ytAccountSubState.lastError = msg || "";
    renderYtAccountSub();
}

async function fetchYtAccountSubscriptionStatus(options = {}){
    const opts = options || {};
    const channelId = currentYtAccountChannelId();
    if(!isYt || !channelId) return;

    const uid = ytAccountSubAuthUid();

    if(!uid){
        // Intentional status/state transition: invalidate any stale in-flight status
        // response and clear status in-flight only. Never clear mutationInFlight here:
        // an already-sent subscribe/unsubscribe POST may still be unresolved server-side,
        // and releasing that lock would allow a second mutation.
        ytAccountSubState.seq += 1;
        ytAccountSubState.channelId = channelId;
        ytAccountSubState.uid = "";
        ytAccountSubState.statusInFlight = false;
        if(ytAccountSubState.mutationInFlight){
            ytAccountSubState.status = "mutating";
            ytAccountSubState.lastError = "";
            renderYtAccountSub();
            return;
        }
        ytAccountSubState.status = "signed_out";
        ytAccountSubState.subscribed = null;
        ytAccountSubState.lastError = "";
        renderYtAccountSub();
        return;
    }

    // Preserve running request ownership: do NOT increment seq before guards.
    // A duplicate/overlapping call must not invalidate an active request.
    if(ytAccountSubState.statusInFlight || ytAccountSubState.mutationInFlight){
        return;
    }
    if(
        !opts.force
        && ytAccountSubState.status === "ready"
        && ytAccountSubState.channelId === channelId
        && ytAccountSubState.uid === uid
    ){
        return;
    }

    const seq = ++ytAccountSubState.seq;
    ytAccountSubState.channelId = channelId;
    ytAccountSubState.uid = uid;
    ytAccountSubState.statusInFlight = true;
    ytAccountSubState.status = "loading";
    ytAccountSubState.lastError = "";
    renderYtAccountSub();

    let result;
    try{
        const token = await getFirebaseIdTokenForYoutube();
        if(!token){
            result = { ok: false, status: 401, body: { code: "UNAUTHENTICATED" } };
        } else {
            const res = await fetch("/api/youtube/subscription-status?channelId=" + encodeURIComponent(channelId), {
                method: "GET",
                headers: { Authorization: "Bearer " + token },
                cache: "no-store"
            });
            let body = null;
            try{ body = await res.json(); } catch(e){ body = null; }
            result = { ok: res.ok, status: res.status, body };
        }
    } catch(e){
        result = { ok: false, status: 0, body: { code: "UPSTREAM_ERROR" } };
    }

    // Only the owning request may clear statusInFlight/apply state.
    // Superseded requests (channel/auth/explicit takeover) must not touch shared state.
    if(
        seq !== ytAccountSubState.seq
        || ytAccountSubState.statusInFlight !== true
        || currentYtAccountChannelId() !== channelId
        || ytAccountSubAuthUid() !== uid
    ){
        return;
    }

    ytAccountSubState.statusInFlight = false;
    const body = result && result.body ? result.body : {};
    const code = String(body.code || "");

    if(result.ok && body.ok === true && body.available === true && (body.subscribed === true || body.subscribed === false)){
        ytAccountSubState.status = "ready";
        ytAccountSubState.subscribed = body.subscribed === true;
        ytAccountSubState.lastError = "";
        renderYtAccountSub();
        return;
    }

    if(result.status === 401 || code === "UNAUTHENTICATED"){
        ytAccountSubState.status = "signed_out";
        ytAccountSubState.subscribed = null;
        ytAccountSubState.lastError = "Sign in required.";
        ytIdentity.clear("signed_out");
    } else if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
        ytAccountSubState.status = "disconnected";
        ytAccountSubState.subscribed = null;
        ytAccountSubState.lastError = "";
        ytIdentity.clear("disconnected");
    } else if(code === "RATE_LIMITED" || code === "CHAT_RATE_LIMITED"){
        ytAccountSubSetUnavailable("You're making requests too quickly. Please wait a moment and refresh status.");
        return;
    } else if(code === "QUOTA_EXCEEDED"){
        ytAccountSubSetUnavailable("YouTube's daily limit has been reached. Please try again later.");
        return;
    } else {
        ytAccountSubSetUnavailable((body && body.error) ? String(body.error) : "Could not check YouTube account subscription status.");
        return;
    }
    renderYtAccountSub();
}

async function mutateYtAccountSubscription(action){
    const channelId = currentYtAccountChannelId();
    if(!isYt || !channelId) return;
    if(action !== "subscribe" && action !== "unsubscribe") return;
    if(ytAccountSubState.mutationInFlight || ytAccountSubState.statusInFlight) return;

    const uid = ytAccountSubAuthUid();
    if(!uid){
        ytAccountSubState.status = "signed_out";
        renderYtAccountSub();
        setActionMsg("Sign in to manage your YouTube account subscription.");
        return;
    }
    if(ytAccountSubState.status === "disconnected"){
        setActionMsg("Connect your YouTube account in Profile to manage subscriptions.");
        renderYtAccountSub();
        return;
    }

    // Capture the identity the user is currently shown. It must survive the
    // immediate pre-write refresh, and the backend verifies it again.
    const expected = ytIdentity.mutationGuard();
    if(!expected.uid || !expected.channelId){
        setActionMsg(ytIdentity.identityMessage());
        renderYtAccountSub();
        return;
    }

    const channelName = (active && active.channel) || (current && current.channel) || "this channel";
    const confirmText = action === "subscribe"
        ? ("Subscribe to \"" + channelName + "\" using your connected YouTube account?")
        : ("Unsubscribe from \"" + channelName + "\" using your connected YouTube account?");
    if(!window.confirm(confirmText)){
        return;
    }

    // Separate mutation ownership: status/auth/channel seq changes must not release
    // a pending mutation lock or allow a second mutation while unresolved.
    const mutationSeqToken = ++ytAccountSubState.mutationSeq;
    ytAccountSubState.channelId = channelId;
    ytAccountSubState.uid = uid;
    ytAccountSubState.mutationInFlight = true;
    ytAccountSubState.status = "mutating";
    ytAccountSubState.lastError = "";
    renderYtAccountSub();

    // Refresh and verify immediately before the write. If the grant, user or
    // channel changed, block instead of silently acting on another account.
    const guard = await ytIdentity.verifyForMutation(expected);
    if(mutationSeqToken !== ytAccountSubState.mutationSeq){
        return;
    }
    if(!guard.ok){
        ytAccountSubState.mutationInFlight = false;
        ytAccountSubState.status = "unavailable";
        ytAccountSubState.lastError = ytIdentity.mutationFailureMessage(guard.reason);
        renderYtAccountSub();
        setActionMsg(ytAccountSubState.lastError);
        return;
    }

    let result;
    try{
        const token = await getFirebaseIdTokenForYoutube();
        if(!token){
            result = { ok: false, status: 401, body: { code: "UNAUTHENTICATED" }, uncertain: false };
        } else {
            const endpoint = action === "subscribe" ? "/api/youtube/subscribe" : "/api/youtube/unsubscribe";
            // Do not abort or blindly retry an already-sent mutation request.
            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Authorization: "Bearer " + token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ channelId, expectedChannelId: expected.channelId, expectedUid: expected.uid }),
                cache: "no-store"
            });
            let body = null;
            try{ body = await res.json(); } catch(e){ body = null; }
            const code = body && body.code ? String(body.code) : "";
            const uncertain = (code === "UPSTREAM_TIMEOUT" || code === "UPSTREAM_ERROR" || res.status >= 500 || res.status === 504);
            result = { ok: res.ok, status: res.status, body, uncertain };
        }
    } catch(e){
        result = { ok: false, status: 0, body: { code: "UPSTREAM_ERROR" }, uncertain: true };
    }

    // Original owner must always release its own lock when settled.
    if(mutationSeqToken !== ytAccountSubState.mutationSeq){
        return;
    }

    const uiStale = (currentYtAccountChannelId() !== channelId || ytAccountSubAuthUid() !== uid);
    // Original owner releases its lock exactly once when settled.
    ytAccountSubState.mutationInFlight = false;
    if(uiStale){
        // Stale auth/channel context: never apply subscribed/error/success from the old
        // mutation. Derive safe UI from the CURRENT context only.
        const currentChannelId = currentYtAccountChannelId();
        const currentUid = ytAccountSubAuthUid();
        ytAccountSubState.channelId = currentChannelId;
        ytAccountSubState.uid = currentUid;
        ytAccountSubState.subscribed = null;
        ytAccountSubState.lastError = "";
        if(!currentUid){
            ytAccountSubState.status = "signed_out";
            renderYtAccountSub();
            return;
        }
        if(!isYt || !currentChannelId){
            ytAccountSubState.status = "idle";
            renderYtAccountSub();
            return;
        }
        // Signed in with valid YouTube channel: unknown state, then fresh read-only GET.
        // mutationInFlight is already released, so status fetch may start.
        ytAccountSubState.status = "idle";
        renderYtAccountSub();
        void fetchYtAccountSubscriptionStatus({ force: true });
        return;
    }

    const body = result && result.body ? result.body : {};
    const code = String(body.code || "");

    if(result.ok && body.ok === true && body.available === true && (body.subscribed === true || body.subscribed === false)){
        ytAccountSubState.status = "ready";
        ytAccountSubState.subscribed = body.subscribed === true;
        ytAccountSubState.lastError = "";
        renderYtAccountSub();
        setActionMsg(body.alreadySubscribed ? "Already subscribed on your YouTube account." : (body.alreadyUnsubscribed ? "Already unsubscribed on your YouTube account." : (body.subscribed ? "Subscribed on your YouTube account." : "Unsubscribed on your YouTube account.")));
        return;
    }

    // Uncertain timeout/error: refresh status via GET for current context.
    // Never blindly repeat mutation.
    if(result.uncertain || code === "UPSTREAM_TIMEOUT" || code === "UPSTREAM_ERROR"){
        setActionMsg("Could not confirm the YouTube account change. Refreshing status...");
        void fetchYtAccountSubscriptionStatus({ force: true });
        return;
    }

    if(result.status === 401 || code === "UNAUTHENTICATED"){
        ytAccountSubState.status = "signed_out";
        ytAccountSubState.subscribed = null;
        ytIdentity.clear("signed_out");
    } else if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
        ytAccountSubState.status = "disconnected";
        ytAccountSubState.subscribed = null;
        ytIdentity.clear("disconnected");
    } else if(code === "YOUTUBE_IDENTITY_CHANGED" || code === "MULTIPLE_CHANNELS" || code === "YOUTUBE_IDENTITY_UNVERIFIED"){
        ytAccountSubState.status = "unavailable";
        ytAccountSubState.lastError = (body && body.error) ? String(body.error) : "Could not verify your connected YouTube channel.";
        ytIdentity.clear("idle");
        void ytIdentity.load({ force: true });
    } else if(code === "RATE_LIMITED" || code === "CHAT_RATE_LIMITED"){
        ytAccountSubState.status = "unavailable";
        ytAccountSubState.lastError = "You're making requests too quickly. Please wait a moment.";
    } else if(code === "QUOTA_EXCEEDED"){
        ytAccountSubState.status = "unavailable";
        ytAccountSubState.lastError = "YouTube's daily limit has been reached. Please try again later.";
    } else {
        ytAccountSubState.status = "unavailable";
        ytAccountSubState.lastError = (body && body.error) ? String(body.error) : "Could not update YouTube account subscription.";
    }
    renderYtAccountSub();
    if(ytAccountSubState.lastError) setActionMsg(ytAccountSubState.lastError);
}

function setupYtAccountSubUi(){
    const ui = ensureYtAccountSubUi();
    if(!ui || !ui.btn || ui.btn.dataset.ytAccountSubWired === "1") return;
    ui.btn.dataset.ytAccountSubWired = "1";
    ui.btn.addEventListener("click", () => {
        const uid = ytAccountSubAuthUid();
        if(!uid){
            // Use existing sign-in navigation flow (matches auth header behavior).
            window.location.href = "login.html";
            return;
        }
        if(ytAccountSubState.status === "disconnected"){
            window.location.href = "profile.html";
            return;
        }
        if(ytAccountSubState.statusInFlight || ytAccountSubState.mutationInFlight) return;

        // Read-only status checks stay available even when identity is ambiguous
        // or temporarily unavailable; only the mutation path is gated.
        const guard = ytIdentity.mutationGuard();
        if(!guard.uid || !guard.channelId){
            setActionMsg(ytIdentity.identityMessage());
            void fetchYtAccountSubscriptionStatus({ force: true });
            return;
        }
        if(ytAccountSubState.status === "ready" && ytAccountSubState.subscribed === true){
            void mutateYtAccountSubscription("unsubscribe");
            return;
        }
        if(ytAccountSubState.status === "ready" && ytAccountSubState.subscribed === false){
            void mutateYtAccountSubscription("subscribe");
            return;
        }
        void fetchYtAccountSubscriptionStatus({ force: true });
    });
}

function syncYtAccountSubscriptionForCurrentVideo(force = false){
    setupYtAccountSubUi();
    renderYtAccountSub();
    if(!isYt || !currentYtAccountChannelId()){
        return;
    }
    void fetchYtAccountSubscriptionStatus({ force: Boolean(force) });
}

function resetYtAccountSubscriptionState(){
    // Invalidate stale status responses only. Never release a pending mutation lock:
    // auth/channel changes cannot allow a second mutation while the first unresolved
    // request may still complete server-side.
    ytAccountSubState.seq += 1;
    ytAccountSubState.channelId = currentYtAccountChannelId();
    ytAccountSubState.uid = ytAccountSubAuthUid();
    ytAccountSubState.statusInFlight = false;
    if(ytAccountSubState.mutationInFlight){
        ytAccountSubState.status = "mutating";
        ytAccountSubState.lastError = "";
        renderYtAccountSub();
        return;
    }
    ytAccountSubState.subscribed = null;
    ytAccountSubState.lastError = "";
    if(!ytAccountSubAuthUid()) ytAccountSubState.status = "signed_out";
    else if(!isYt || !currentYtAccountChannelId()) ytAccountSubState.status = "idle";
    else ytAccountSubState.status = "idle";
    renderYtAccountSub();
}

// ================= SUBSCRIBE (MyTube-local; existing behavior preserved) =================

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
// 30-second window. YouTube embeds don't expose playback progress, so the
// percentage is always recorded as 0.

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
        const progress = 0;
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
    setupYtAccountSubUi();
    renderYtAccountSub();
    setupPlaylistUI();
    setupCommentForm();
    renderMute();
    renderPrevNext();
    setupAutoplayToggle();
    setupKeyboardShortcuts();
    renderTimeDisplay();
    loadVideo();
    recordHistory();
});


window.addEventListener("mytube-auth-change", () => {
    // Re-read the connected account identity on every auth/account transition.
    // Sign-out clears synchronously so no stale account label can remain; a
    // signed-in transition re-reads the current grant.
    const authUser = typeof currentUser === "function" ? currentUser() : null;
    if(!authUser){
        ytIdentity.clear("signed_out");
    }
    else{
        void loadYoutubeAccountIdentity({ force: true });
    }
    // A YouTube video has `active` populated but `current` is null, so we must
    // NOT key off `current` here — otherwise the comment form would never
    // refresh its logged-in state while watching a YouTube video.
    if(!active && !current){
        resetYtAccountSubscriptionState();
        renderYtAccountSub();
        return;
    }
    setupCommentForm();
    renderComments();
    // Record history now that we know the auth state.
    recordHistory();
    // Sync save/like/subscribe state from Firestore.
    syncStateFromFirestore();

    // Refresh actual YouTube rating on auth/connect state changes.
    if(isYoutubeRatingVideo()){
        void loadYoutubeRating({ force: true });
    }
    // Refresh read-only YouTube account subscription status (no auto mutations).
    if(isYt && currentYtAccountChannelId()){
        void fetchYtAccountSubscriptionStatus({ force: true });
    } else {
        resetYtAccountSubscriptionState();
    }
});


// Grant changes (connect/disconnect/reconnect) invalidate the identity
// immediately. The signal is also delivered across tabs by the shared helper;
// no tokens or channel identity are stored in the notification.
onYoutubeGrantChange(() => {
    ytIdentity.clear("idle");
    void loadYoutubeAccountIdentity({ force: true });
    if(isYoutubeRatingVideo()){
        void loadYoutubeRating({ force: true });
    }
    if(isYt && currentYtAccountChannelId()){
        void fetchYtAccountSubscriptionStatus({ force: true });
    }
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


// Imported last so the protected Live Chat block above keeps its exact bytes
// and line positions. ES module imports are hoisted before the module body.
import { createYoutubeAccountIdentity, onYoutubeGrantChange } from "./youtube-account.js";
