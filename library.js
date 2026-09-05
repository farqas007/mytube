// ================= LIBRARY PAGE =================
// Tabbed view of History, Saved, Liked, and Playlists.
// Reads from Firestore when logged in, falls back to localStorage.

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getHistory, clearHistory, removeFromHistory,
    getSaved, removeFromSaved,
    getLiked, removeFromLiked,
    getPlaylists, createPlaylist, deletePlaylist,
    getPlaylistItems, removeFromPlaylist
} from "./data.js";


const videos = window.MyTubeVideos || [];


// ================= ELEMENTS =================

const loggedOutEl = document.getElementById("libLoggedOut");
const contentEl = document.getElementById("libContent");
const historyListEl = document.getElementById("historyList");
const savedListEl = document.getElementById("savedList");
const likedListEl = document.getElementById("likedList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const tabs = document.querySelectorAll(".lib-tab");
const sections = {
    history: document.getElementById("libHistory"),
    saved: document.getElementById("libSaved"),
    liked: document.getElementById("libLiked"),
    playlists: document.getElementById("libPlaylists")
};
const playlistsListView = document.getElementById("playlistsListView");
const playlistDetailView = document.getElementById("playlistDetailView");
const playlistDetailTitle = document.getElementById("playlistDetailTitle");
const playlistsListContainer = document.getElementById("playlistsListContainer");
const playlistDetailItems = document.getElementById("playlistDetailItems");
const playlistLibraryName = document.getElementById("playlistLibraryName");
const playlistLibraryCreateBtn = document.getElementById("playlistLibraryCreateBtn");
const playlistsBackBtn = document.getElementById("playlistsBackBtn");
const playlistDetailBackBtn = document.getElementById("playlistDetailBackBtn");

let currentTab = "history";
let currentUid = null;
let playlistDetailId = null;
let playlistDetailName = "";


// ================= HELPERS =================

function openVideo(id){
    window.location.href = "watch.html?id=" + id;
}


function buildVideoItem(v, options){
    options = options || {};
    const link = document.createElement("a");
    link.className = "profile-video";
    link.href = "watch.html?id=" + v.id;
    link.setAttribute("aria-label", "Watch " + v.title);

    const img = document.createElement("img");
    img.src = v.thumb;
    img.alt = "";
    img.loading = "lazy";

    const info = document.createElement("div");
    info.className = "profile-video-info";

    const title = document.createElement("h4");
    title.textContent = v.title;

    const meta = document.createElement("p");
    const parts = [];
    if(v.channel){
        parts.push(v.channel);
    }
    if(v.views){
        parts.push(v.views);
    }
    if(v.date){
        parts.push(v.date);
    }
    meta.textContent = parts.join(" \u2022 ");

    info.appendChild(title);
    info.appendChild(meta);

    link.appendChild(img);
    link.appendChild(info);

    // Remove button
    if(options.onRemove){
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "lib-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.setAttribute("aria-label", "Remove " + v.title);
        removeBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeBtn.disabled = true;
            removeBtn.textContent = "Removing...";
            await options.onRemove(v);
            link.remove();
            // Check if list is now empty.
            const listEl = link.parentElement;
            if(listEl && listEl.children.length === 0){
                renderEmptyMessage(listEl, options.emptyMsg || "No videos here yet.");
            }
        });
        link.appendChild(removeBtn);
    }

    return link;
}


function renderEmptyMessage(container, msg){
    const p = document.createElement("p");
    p.className = "profile-empty";
    p.textContent = msg;
    container.appendChild(p);
}


// ================= TABS =================

function switchTab(tab){
    currentTab = tab;
    tabs.forEach(t => {
        const active = t.dataset.tab === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.keys(sections).forEach(key => {
        if(sections[key]){
            sections[key].style.display = key === tab ? "" : "none";
        }
    });
}


// ================= RENDER: HISTORY =================

async function renderHistory(){
    if(!historyListEl){
        return;
    }
    historyListEl.replaceChildren();

    if(!currentUid){
        renderEmptyMessage(historyListEl, "Log in to see your watch history.");
        if(clearHistoryBtn){
            clearHistoryBtn.style.display = "none";
        }
        return;
    }

    let items = [];
    try{
        items = await getHistory(currentUid, 50);
    }
    catch(e){
        console.warn("Failed to load history:", e);
    }

    if(clearHistoryBtn){
        clearHistoryBtn.style.display = items.length > 0 ? "" : "none";
    }

    if(items.length === 0){
        renderEmptyMessage(historyListEl, "No watch history yet. Start watching videos!");
        return;
    }

    items.forEach(item => {
        const v = {
            id: item.videoId || item.id,
            title: item.title || "Untitled",
            thumb: item.thumb || "",
            channel: item.channel || "",
            views: "",
            date: ""
        };
        historyListEl.appendChild(buildVideoItem(v, {
            emptyMsg: "No watch history yet.",
            onRemove: async (video) => {
                await removeFromHistory(currentUid, video.id);
            }
        }));
    });
}


// ================= RENDER: SAVED =================

async function renderSaved(){
    if(!savedListEl){
        return;
    }
    savedListEl.replaceChildren();

    if(!currentUid){
        // Fall back to localStorage.
        const localSaved = getLocalSaved();
        if(localSaved.length === 0){
            renderEmptyMessage(savedListEl, "No saved videos. Tap Save on any video to add it here.");
            return;
        }
        localSaved.forEach(v => {
            savedListEl.appendChild(buildVideoItem(v));
        });
        return;
    }

    let items = [];
    try{
        items = await getSaved(currentUid);
    }
    catch(e){
        console.warn("Failed to load saved:", e);
    }

    if(items.length === 0){
        renderEmptyMessage(savedListEl, "No saved videos. Tap Save on any video to add it here.");
        return;
    }

    items.forEach(item => {
        const v = {
            id: item.videoId || item.id,
            title: item.title || "Untitled",
            thumb: item.thumb || "",
            channel: item.channel || "",
            views: item.views || "",
            date: ""
        };
        savedListEl.appendChild(buildVideoItem(v, {
            emptyMsg: "No saved videos.",
            onRemove: async (video) => {
                await removeFromSaved(currentUid, video.id);
                // Also clear localStorage mirror.
                try{
                    localStorage.removeItem("mytube_saved_" + video.id);
                }
                catch(e){ /* ignore */ }
            }
        }));
    });
}


// ================= RENDER: LIKED =================

async function renderLiked(){
    if(!likedListEl){
        return;
    }
    likedListEl.replaceChildren();

    if(!currentUid){
        // Fall back to localStorage.
        const localLiked = getLocalLiked();
        if(localLiked.length === 0){
            renderEmptyMessage(likedListEl, "No liked videos. Like a video to add it here.");
            return;
        }
        localLiked.forEach(v => {
            likedListEl.appendChild(buildVideoItem(v));
        });
        return;
    }

    let items = [];
    try{
        items = await getLiked(currentUid);
    }
    catch(e){
        console.warn("Failed to load liked:", e);
    }

    if(items.length === 0){
        renderEmptyMessage(likedListEl, "No liked videos. Like a video to add it here.");
        return;
    }

    items.forEach(item => {
        const v = {
            id: item.videoId || item.id,
            title: item.title || "Untitled",
            thumb: item.thumb || "",
            channel: item.channel || "",
            views: item.views || "",
            date: ""
        };
        likedListEl.appendChild(buildVideoItem(v, {
            emptyMsg: "No liked videos.",
            onRemove: async (video) => {
                await removeFromLiked(currentUid, video.id);
            }
        }));
    });
}


// ================= RENDER: PLAYLISTS =================

async function renderPlaylists(){
    if(!playlistsListView || !playlistsListContainer){
        return;
    }
    playlistDetailId = null;
    playlistDetailName = "";
    if(playlistDetailView){
        playlistDetailView.style.display = "none";
    }
    if(playlistsListView){
        playlistsListView.style.display = "";
    }

    playlistsListContainer.replaceChildren();

    if(!currentUid){
        renderEmptyMessage(playlistsListContainer, "Log in to create playlists and organize your videos.");
        return;
    }

    let playlists = [];
    try{
        playlists = await getPlaylists(currentUid);
    }
    catch(e){
        console.warn("Failed to load playlists:", e);
    }

    if(playlists.length === 0){
        renderEmptyMessage(playlistsListContainer, "No playlists yet. Create one to start organizing videos.");
        return;
    }

    playlists.forEach(pl => {
        playlistsListContainer.appendChild(buildPlaylistCard(pl));
    });
}


function buildPlaylistCard(pl){
    const card = document.createElement("div");
    card.className = "playlist-card";

    const info = document.createElement("div");
    info.className = "playlist-card-info";

    const name = document.createElement("h4");
    name.textContent = pl.name || "Untitled playlist";

    const count = document.createElement("p");
    count.textContent = (pl.videoCount ? pl.videoCount + " videos" : "0 videos");

    info.appendChild(name);
    info.appendChild(count);
    card.appendChild(info);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "lib-remove-btn";
    openBtn.textContent = "Open";
    openBtn.setAttribute("aria-label", "Open playlist " + name.textContent);
    openBtn.addEventListener("click", () => {
        openPlaylistDetail(pl.id, pl.name || "Untitled playlist");
    });
    card.appendChild(openBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "lib-remove-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", "Delete playlist " + name.textContent);
    deleteBtn.addEventListener("click", async () => {
        if(!currentUid){
            return;
        }
        if(!window.confirm("Delete this playlist?")){
            return;
        }
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Deleting...";
        await deletePlaylist(currentUid, pl.id);
        renderPlaylists();
    });
    card.appendChild(deleteBtn);

    return card;
}


async function openPlaylistDetail(playlistId, playlistName){
    if(!currentUid){
        return;
    }
    playlistDetailId = playlistId;
    playlistDetailName = playlistName;
    if(playlistsListView){
        playlistsListView.style.display = "none";
    }
    if(playlistDetailView){
        playlistDetailView.style.display = "";
    }
    if(playlistDetailTitle){
        playlistDetailTitle.textContent = playlistName;
    }
    if(playlistDetailItems){
        playlistDetailItems.replaceChildren();
    }

    let items = [];
    try{
        items = await getPlaylistItems(currentUid, playlistId);
    }
    catch(e){
        console.warn("Failed to load playlist items:", e);
    }

    if(!playlistDetailItems){
        return;
    }
    if(items.length === 0){
        renderEmptyMessage(playlistDetailItems, "This playlist is empty. Use the Playlist button on any video to add it here.");
        return;
    }

    items.forEach(item => {
        const v = {
            id: item.videoId || item.id,
            title: item.title || "Untitled",
            thumb: item.thumb || "",
            channel: item.channel || "",
            views: item.views || "",
            date: ""
        };
        playlistDetailItems.appendChild(buildVideoItem(v, {
            emptyMsg: "No videos in this playlist.",
            onRemove: async (video) => {
                if(!currentUid){
                    return false;
                }
                const ok = await removeFromPlaylist(currentUid, playlistId, video.id);
                if(ok){
                    const remaining = await getPlaylistItems(currentUid, playlistId);
                    if(remaining.length === 0){
                        playlistDetailItems.replaceChildren();
                        renderEmptyMessage(playlistDetailItems, "This playlist is empty. Use the Playlist button on any video to add it here.");
                    }
                }
            }
        }));
    });
}


function closePlaylistDetail(){
    renderPlaylists();
}


// ================= LOCAL STORAGE FALLBACK =================

function getLocalSaved(){
    return videos.filter(v => {
        try{
            return localStorage.getItem("mytube_saved_" + v.id) === "1";
        }
        catch(e){
            return false;
        }
    });
}


function getLocalLiked(){
    return videos.filter(v => {
        try{
            const state = localStorage.getItem("mytube_like_state_" + v.id);
            return state === "1";
        }
        catch(e){
            return false;
        }
    });
}


// ================= RENDER CURRENT TAB =================

function renderCurrentTab(){
    if(currentTab === "history"){
        renderHistory();
    }
    else if(currentTab === "saved"){
        renderSaved();
    }
    else if(currentTab === "liked"){
        renderLiked();
    }
    else if(currentTab === "playlists"){
        renderPlaylists();
    }
}


// ================= INIT =================

tabs.forEach(tab => {
    tab.addEventListener("click", () => {
        switchTab(tab.dataset.tab);
        renderCurrentTab();
    });
});


if(clearHistoryBtn){
    clearHistoryBtn.addEventListener("click", async () => {
        if(!currentUid){
            return;
        }
        clearHistoryBtn.disabled = true;
        clearHistoryBtn.textContent = "Clearing...";
        await clearHistory(currentUid);
        renderHistory();
        clearHistoryBtn.disabled = false;
        clearHistoryBtn.textContent = "Clear all history";
    });
}


if(playlistDetailBackBtn){
    playlistDetailBackBtn.addEventListener("click", closePlaylistDetail);
}

if(playlistsBackBtn){
    playlistsBackBtn.addEventListener("click", closePlaylistDetail);
}


if(playlistLibraryCreateBtn && playlistLibraryName){
    playlistLibraryCreateBtn.addEventListener("click", async () => {
        if(!currentUid){
            return;
        }
        const name = playlistLibraryName.value.trim();
        if(!name){
            return;
        }
        playlistLibraryCreateBtn.disabled = true;
        playlistLibraryCreateBtn.textContent = "Creating...";
        await createPlaylist(currentUid, name);
        playlistLibraryName.value = "";
        playlistLibraryCreateBtn.disabled = false;
        playlistLibraryCreateBtn.textContent = "Create playlist";
        renderPlaylists();
    });
}


// ================= AUTH STATE =================

onAuthStateChanged(auth, (user) => {
    if(user){
        currentUid = user.uid;
        if(loggedOutEl){
            loggedOutEl.style.display = "none";
        }
        if(contentEl){
            contentEl.style.display = "block";
        }
    }
    else{
        currentUid = null;
        if(contentEl){
            contentEl.style.display = "none";
        }
        if(loggedOutEl){
            loggedOutEl.style.display = "";
        }
    }
    renderCurrentTab();
});
