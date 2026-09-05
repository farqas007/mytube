// ================= SUBSCRIPTIONS PAGE =================
// Shows subscribed channels with their latest videos.
// Reads subscriptions from Firestore; fetches channel videos via backend API.

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSubscriptions, removeSubscription } from "./data.js";
import { channelVideos } from "./youtube.js";


const videos = window.MyTubeVideos || [];


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
    window.location.href = "watch.html?id=" + id;
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

async function loadChannelVideos(sub, forceRefresh){
    // YouTube channel: use the API endpoint with a localStorage cache.
    if(sub.channelId){
        const cached = cachedChannelVideos(sub.channelId);
        if(cached && !forceRefresh && !cached.stale){
            return cached.videos;
        }
        try{
            const result = await channelVideos(sub.channelId, 6);
            const videos = result.videos || [];
            setCachedChannelVideos(sub.channelId, videos);
            return videos;
        }
        catch(e){
            console.warn("Failed to load videos for channel:", sub.channelName, e);
            if(cached){
                return cached.videos;
            }
            return [];
        }
    }
    // Local channel: filter the local dataset.
    if(sub.channelName){
        return videos.filter(v => v.channel === sub.channelName).slice(0, 6);
    }
    return [];
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

    showState("content");
    if(sectionsEl){
        sectionsEl.replaceChildren();
    }

    // Load videos for each channel sequentially to avoid request storms.
    // Limit to 12 channels max.
    const limited = subs.slice(0, 12);
    for(const sub of limited){
        const channelVids = await loadChannelVideos(sub, forceRefresh);
        if(sectionsEl){
            sectionsEl.appendChild(buildChannelSection(sub, channelVids));
        }
    }
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
        Promise.resolve(loadSubscriptions(user.uid, true)).finally(() => {
            btn.disabled = false;
            btn.textContent = "Refresh";
        });
    });
}


// ================= AUTH STATE =================

onAuthStateChanged(auth, (user) => {
    if(user){
        setupRefreshButton();
        loadSubscriptions(user.uid);
    }
    else{
        showState("loggedOut");
    }
});
