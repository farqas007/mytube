// ================= PROFILE PAGE =================
// Profile view: Firebase auth for identity, Firestore for saved videos and
// subscriptions (with localStorage fallback) for resilience when logged out.

import { auth } from "./firebase.js";
import {
    onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSaved, getSubscriptions } from "./data.js";


const loggedOutEl = document.getElementById("profileLoggedOut");
const contentEl = document.getElementById("profileContent");
const avatarEl = document.getElementById("profileAvatar");
const nameEl = document.getElementById("profileName");
const emailEl = document.getElementById("profileEmail");
const savedListEl = document.getElementById("savedList");
const subsListEl = document.getElementById("subsList");


function getInitials(name){
    return (name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(word => word.charAt(0).toUpperCase())
        .join("") || "?";
}


function safeDisplayName(user){
    if(user.displayName){
        return user.displayName;
    }
    if(user.email){
        const local = user.email.split("@")[0];
        return local || "User";
    }
    return "User";
}


// ================= YOUTUBE-ONLY FILTER =================

// Only YouTube-hosted records are renderable. Old records from the legacy local
// MP4 dataset have videoId like "ghajini" (and type "local"), which would
// resolve to broken watch links, so they are silently skipped.
function isYouTubeVideo(item){
    const id = String(item.videoId || item.id || "");
    return id.indexOf("yt:") === 0 || item.type === "youtube";
}


function renderSavedList(saved){
    savedListEl.replaceChildren();

    if(saved.length === 0){
        const empty = document.createElement("p");
        empty.className = "profile-empty";
        empty.textContent = "No saved videos yet. Tap the Save button on a video to add it here.";
        savedListEl.appendChild(empty);
        return;
    }

    saved.forEach(v => {
        const link = document.createElement("a");
        link.className = "profile-video";
        link.href = "watch.html?id=" + v.id;
        link.setAttribute("aria-label", "Watch " + v.title);

        const img = document.createElement("img");
        img.src = v.thumb;
        img.alt = "";

        const info = document.createElement("div");
        info.className = "profile-video-info";

        const title = document.createElement("h4");
        title.textContent = v.title;

        const meta = document.createElement("p");
        meta.textContent = (v.channel || "") + (v.views ? (" \u2022 " + v.views) : "");

        info.appendChild(title);
        info.appendChild(meta);

        link.appendChild(img);
        link.appendChild(info);
        savedListEl.appendChild(link);
    });
}


async function renderSavedVideos(){
    if(!savedListEl){
        return;
    }

    const user = (auth && auth.currentUser) || null;

    let savedItems = [];

    // Logged in: read from Firestore.
    if(user){
        try{
            const fsSaved = await getSaved(user.uid);
            savedItems = fsSaved
                .map(s => ({
                    id: s.videoId || s.id,
                    title: s.title || "",
                    thumb: s.thumb || "",
                    channel: s.channel || "",
                    views: s.views || ""
                }))
                .filter(isYouTubeVideo);
        }
        catch(error){
            console.warn("Could not load saved from Firestore:", error);
        }
    }

    renderSavedList(savedItems);
}


async function renderSubscribedChannels(){
    if(!subsListEl){
        return;
    }
    subsListEl.replaceChildren();

    const user = (auth && auth.currentUser) || null;

    let channels = [];

    // Logged in: read subscriptions from Firestore. Only records with a real
    // YouTube channelId are shown — legacy local-channel subscriptions from the
    // old dataset carried no channelId and are skipped.
    if(user){
        try{
            const subs = await getSubscriptions(user.uid);
            channels = subs
                .filter(s => Boolean(s.channelId))
                .map(s => s.channelName || s.id)
                .filter(Boolean);
        }
        catch(error){
            console.warn("Could not load subscriptions from Firestore:", error);
        }
    }

    if(channels.length === 0){
        const empty = document.createElement("p");
        empty.className = "profile-empty";
        empty.textContent = "Not subscribed to any channels yet.";
        subsListEl.appendChild(empty);
        return;
    }

    channels.forEach(channel => {
        const item = document.createElement("div");
        item.className = "profile-channel";

        const avatar = document.createElement("div");
        avatar.className = "channel-avatar";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = getInitials(channel);

        const label = document.createElement("span");
        label.textContent = channel;

        item.appendChild(avatar);
        item.appendChild(label);
        subsListEl.appendChild(item);
    });
}


function renderLoggedIn(user){
    if(loggedOutEl){
        loggedOutEl.style.display = "none";
    }
    if(contentEl){
        contentEl.style.display = "block";
    }

    if(avatarEl){
        avatarEl.textContent = getInitials(safeDisplayName(user));
    }
    if(nameEl){
        nameEl.textContent = safeDisplayName(user);
    }
    if(emailEl){
        emailEl.textContent = user.email || "";
    }

    renderSavedVideos();
    renderSubscribedChannels();
}


function renderLoggedOut(){
    if(contentEl){
        contentEl.style.display = "none";
    }
    if(loggedOutEl){
        loggedOutEl.style.display = "block";
    }
}


onAuthStateChanged(auth, (user) => {
    if(user){
        renderLoggedIn(user);
    }
    else{
        renderLoggedOut();
    }
});
