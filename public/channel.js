// ================= CHANNEL PAGE =================
// A single channel view addressed by /channel.html?id=<channelId>.
//
// Reuses the existing backend channel APIs (youtube.js) and the same card /
// avatar / state patterns as the Subscriptions page. No new backend route and
// no new Firestore collection: subscriptions still live in
// users/{uid}/subscriptions/{channelId} through data.js.

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { channel, channelVideos } from "./youtube.js";
import { addSubscription, removeSubscription, isSubscribedByChannel } from "./data.js";
import { attachHoverPreview } from "./shared/hoverPreview.js";


// Page size for the first load and each "Load more" page. The backend caps an
// individual channelVideos page at 25.
const PAGE_SIZE = 24;


// ================= ELEMENTS =================

const stateEls = {
    invalid: document.getElementById("channelInvalid"),
    loading: document.getElementById("channelLoading"),
    error: document.getElementById("channelError"),
    empty: document.getElementById("channelEmpty"),
    content: document.getElementById("channelContent")
};

const avatarEl = document.getElementById("channelPageAvatar");
const nameEl = document.getElementById("channelPageName");
const subsEl = document.getElementById("channelPageSubs");
const statusEl = document.getElementById("channelPageStatus");
const subscribeBtn = document.getElementById("channelPageSubscribeBtn");
const gridEl = document.getElementById("channelVideoGrid");
const sortEl = document.getElementById("channelSort");
const moreBtn = document.getElementById("channelMoreBtn");
const errorTextEl = document.getElementById("channelErrorText");


// ================= STATE =================

// The raw channel id from ?id=, unchanged. The backend resolves it via
// channels.list.
const channelId = new URLSearchParams(window.location.search).get("id") || "";

// Every video fetched so far, in the order the backend returned it
// (uploads playlist = reverse chronological). `allVideos` is the sort source;
// sorting never re-fetches.
let allVideos = [];
let nextPageToken = "";
// Once the API says there are no more pages, stop offering "Load more" even if
// a previous response happened to carry a token.
let reachedEnd = false;
let subscribed = false;

// A per-channel fallback avatar letter set, reused from the watch page so the
// two surfaces agree.
function getInitials(name){
    return (name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(w => w.charAt(0).toUpperCase())
        .join("") || "?";
}


// ================= STATE DISPLAY =================

function showState(state){
    Object.values(stateEls).forEach(el => {
        if(el){
            el.style.display = "none";
        }
    });
    const target = stateEls[state];
    if(target){
        target.style.display = state === "content" ? "block" : "";
    }
}

function showError(msg){
    if(errorTextEl){
        errorTextEl.textContent = msg || "Could not load this channel.";
    }
    showState("error");
}

function setStatus(msg){
    if(statusEl){
        statusEl.textContent = msg || "";
    }
}


// ================= VIDEO CARDS =================
// Same markup/behaviour as the Subscriptions page card so a video looks
// identical wherever it appears. Cards always open MyTube's own watch page.

function openVideo(id){
    window.location.href = "/watch?id=" + encodeURIComponent(id);
}

function buildVideoCard(v){
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "link");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "Watch " + (v.title || "video"));
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
    img.alt = v.title || "";
    img.loading = "lazy";
    img.decoding = "async";
    const badge = document.createElement("span");
    badge.textContent = v.time || "";
    thumb.appendChild(img);
    thumb.appendChild(badge);

    // Desktop-only muted hover preview; nothing loads until a real hover.
    attachHoverPreview(thumb, v.id);

    const title = document.createElement("h3");
    title.textContent = v.title || "";

    const meta = document.createElement("p");
    const parts = [v.channel];
    if(v.views){
        parts.push(v.views);
    }
    if(v.date){
        parts.push(v.date);
    }
    meta.textContent = parts.filter(Boolean).join(" \u2022 ");

    card.appendChild(thumb);
    card.appendChild(title);
    card.appendChild(meta);
    return card;
}


// ================= SORTING =================
// Newest / Oldest only. Both are exact over whatever the page has already
// fetched: the backend returns the uploads playlist newest-first, so reversing
// it gives a true oldest-first order for the loaded set. A "Most viewed" sort is
// deliberately NOT offered — that would only be correct once every video is
// loaded, and the loaded set is a paged window, not the whole channel.

function sortedVideos(){
    const mode = sortEl ? sortEl.value : "newest";
    const list = allVideos.slice();
    if(mode === "oldest"){
        list.reverse();
    }
    return list;
}

function renderGrid(){
    if(!gridEl){
        return;
    }
    gridEl.replaceChildren();

    const videos = sortedVideos();

    if(videos.length === 0){
        const empty = document.createElement("p");
        empty.className = "comment-empty";
        empty.textContent = "No videos found.";
        gridEl.appendChild(empty);
        return;
    }

    videos.forEach(v => gridEl.appendChild(buildVideoCard(v)));
}

function updateMoreButton(){
    if(!moreBtn){
        return;
    }
    moreBtn.style.display = (!reachedEnd && nextPageToken) ? "" : "none";
    moreBtn.disabled = false;
    moreBtn.textContent = "Load more";
}


// ================= CHANNEL IDENTITY =================

// The subscriber label exactly as the channel endpoint returned it ("" when the
// channel hides its count), kept so the subscription doc matches what the watch
// page stores — avoiding a DOM scrape that would capture the &nbsp; fallback.
// Declared before renderChannelHeader() so the first write can never hit the
// temporal dead zone regardless of how the page is initialised.
let channelSubsLabel = "";

function renderChannelHeader(info){
    if(nameEl){
        nameEl.textContent = (info && info.title) || "Channel";
    }
    if(subsEl){
        channelSubsLabel = (info && info.subscribers) || "";
        subsEl.textContent = channelSubsLabel;
        // Keep the line from collapsing when the channel hides its count.
        if(!channelSubsLabel){
            subsEl.innerHTML = "&nbsp;";
        }
    }
    if(avatarEl){
        avatarEl.replaceChildren();
        const thumb = info && info.thumb;
        const name = (info && info.title) || "Channel";
        if(thumb){
            const img = document.createElement("img");
            img.src = thumb;
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.style.width = "100%";
            img.style.height = "100%";
            img.style.objectFit = "cover";
            img.style.borderRadius = "inherit";
            img.addEventListener("error", () => {
                avatarEl.replaceChildren();
                avatarEl.textContent = getInitials(name);
            }, { once: true });
            avatarEl.appendChild(img);
        }
        else{
            avatarEl.textContent = getInitials(name);
        }
    }
    // The page title reflects the real channel name once it is known.
    if(info && info.title){
        document.title = info.title + " - MyTube";
    }
}


// ================= SUBSCRIBE =================

function renderSubscribe(){
    if(!subscribeBtn){
        return;
    }
    subscribeBtn.classList.toggle("active", subscribed);
    subscribeBtn.textContent = subscribed ? "Subscribed" : "Subscribe";
    subscribeBtn.setAttribute("aria-pressed", subscribed ? "true" : "false");
    subscribeBtn.setAttribute("aria-label",
        (subscribed ? "Unsubscribe from " : "Subscribe to ") + (nameEl ? nameEl.textContent : "channel"));
}

// Which channel name to persist alongside the id, so the Subscriptions page and
// sidebar can show a label without an extra API call.
function channelNameForStorage(){
    return (nameEl && nameEl.textContent && nameEl.textContent !== "Channel")
        ? nameEl.textContent
        : "";
}

function channelThumbForStorage(){
    // channel() returns `thumb`; keep it on the subscription doc, matching what
    // the watch page stores, so the sidebar avatar keeps working.
    const img = avatarEl ? avatarEl.querySelector("img") : null;
    return img ? (img.getAttribute("src") || "") : "";
}

if(subscribeBtn){
    subscribeBtn.onclick = async () => {
        const user = auth && auth.currentUser;
        if(!user){
            setStatus("Please log in to subscribe.");
            return;
        }
        subscribeBtn.disabled = true;
        const wasSubscribed = subscribed;
        try{
            if(wasSubscribed){
                await removeSubscription(user.uid, channelId, channelNameForStorage());
                subscribed = false;
            }
            else{
                await addSubscription(user.uid, {
                    channelId: channelId,
                    channelName: channelNameForStorage(),
                    channelThumb: channelThumbForStorage(),
                    subscriberCount: channelSubsLabel
                });
                subscribed = true;
            }
            renderSubscribe();
            setStatus(wasSubscribed ? "Unsubscribed." : "Subscribed.");
        }
        catch(e){
            // data.js already swallows failures and returns false; this guard is
            // only for the unexpected case where it rethrows.
            console.warn("Subscription change failed:", e);
            setStatus("Could not update your subscription. Please try again.");
        }
        finally{
            subscribeBtn.disabled = false;
        }
    };
}

async function syncSubscriptionState(){
    const user = auth && auth.currentUser;
    if(!user){
        // Logged out: the button is shown but tapping it prompts for login.
        subscribed = false;
        renderSubscribe();
        return;
    }
    // Tri-state: true / false / null (null = the read failed, so leave the
    // current state alone rather than silently unsubscribing the UI).
    const result = await isSubscribedByChannel(user.uid, channelId, channelNameForStorage());
    if(result !== null){
        subscribed = result;
        renderSubscribe();
    }
}


// ================= LOADING =================

async function loadFirstPage(){
    showState("loading");
    setStatus("");

    const [infoRes, videosRes] = await Promise.all([
        channel(channelId),
        channelVideos(channelId, PAGE_SIZE)
    ]);

    const info = infoRes && infoRes.channel ? infoRes.channel : null;

    // A completely unreachable backend (network error) leaves both results
    // !ok with no data. A reachable backend that simply has no such channel
    // returns ok with channel:null. Distinguish them for a truthful message.
    if(!info && !(videosRes && videosRes.ok)){
        showError("Could not load this channel. Please try again.");
        return;
    }

    renderChannelHeader(info);

    allVideos = (videosRes && Array.isArray(videosRes.videos)) ? videosRes.videos : [];
    nextPageToken = (videosRes && videosRes.nextPageToken) || "";
    // The uploads-playlist endpoint returns an empty token once exhausted, but a
    // short page is also a reliable "no more" signal.
    reachedEnd = !nextPageToken || allVideos.length < PAGE_SIZE;

    if(allVideos.length === 0){
        // Still show the header so the user knows the channel was found.
        showState("content");
        renderGrid();
        updateMoreButton();
        // The empty panel is more informative than an empty grid, but we keep
        // the header visible by using the in-content empty message instead of
        // swapping to the standalone empty state.
        setStatus("");
        return;
    }

    showState("content");
    renderGrid();
    updateMoreButton();
}

async function loadMore(){
    if(!moreBtn || !nextPageToken || reachedEnd){
        return;
    }
    moreBtn.disabled = true;
    moreBtn.textContent = "Loading...";

    try{
        const res = await channelVideos(channelId, PAGE_SIZE, nextPageToken);
        const fresh = (res && Array.isArray(res.videos)) ? res.videos : [];
        nextPageToken = (res && res.nextPageToken) || "";

        if(fresh.length === 0){
            reachedEnd = true;
        }
        else{
            // De-duplicate on sourceId: playlist paging can repeat an item if the
            // channel uploads between requests.
            const seen = new Set(allVideos.map(v => v.sourceId || v.id));
            for(const v of fresh){
                const key = v.sourceId || v.id;
                if(key && !seen.has(key)){
                    seen.add(key);
                    allVideos.push(v);
                }
            }
            if(allVideos.length >= 500 || fresh.length < PAGE_SIZE){
                reachedEnd = true;
            }
        }

        renderGrid();
    }
    catch(e){
        console.warn("Failed to load more channel videos:", e);
        setStatus("Could not load more videos. Please try again.");
    }
    finally{
        updateMoreButton();
    }
}


// ================= INIT =================

function init(){
    if(!channelId){
        showState("invalid");
        return;
    }

    if(sortEl){
        sortEl.addEventListener("change", renderGrid);
    }
    if(moreBtn){
        moreBtn.addEventListener("click", loadMore);
    }

    // Auth can resolve after the first render; re-check the button when it does.
    onAuthStateChanged(auth, () => {
        syncSubscriptionState();
    });

    loadFirstPage();
}

init();
