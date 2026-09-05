// ================= PROFILE PAGE =================
// Profile view: Firebase auth for identity, Firestore for saved videos and
// subscriptions (with localStorage fallback) for resilience when logged out.

import { auth } from "./firebase.js";
import {
    onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSaved, getSubscriptions } from "./data.js";


const videos = window.MyTubeVideos || [];


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


function getSavedVideosLocal(){
    return videos.filter(v => {
        try{
            return localStorage.getItem("mytube_saved_" + v.id) === "1";
        }
        catch(error){
            console.warn("Could not read saved state:", error);
            return false;
        }
    });
}


function getSubscribedChannelsLocal(){
    const subscribed = [];
    videos.forEach(v => {
        try{
            if(localStorage.getItem("mytube_subscribed_" + v.channel) === "1"){
                if(!subscribed.includes(v.channel)){
                    subscribed.push(v.channel);
                }
            }
        }
        catch(error){
            console.warn("Could not read subscription state:", error);
        }
    });
    return subscribed;
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

    // Logged in: prefer Firestore.
    if(user){
        try{
            const fsSaved = await getSaved(user.uid);
            savedItems = fsSaved.map(s => ({
                id: s.videoId || s.id,
                title: s.title || "",
                thumb: s.thumb || "",
                channel: s.channel || "",
                views: s.views || ""
            }));
        }
        catch(error){
            console.warn("Could not load saved from Firestore:", error);
        }
    }

    // Fall back to localStorage if Firestore gave nothing.
    if(savedItems.length === 0){
        const localSaved = getSavedVideosLocal();
        if(localSaved.length > 0){
            renderSavedList(localSaved);
            return;
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

    // Logged in: prefer Firestore.
    if(user){
        try{
            const subs = await getSubscriptions(user.uid);
            channels = subs
                .map(s => s.channelName || s.id)
                .filter(Boolean);
        }
        catch(error){
            console.warn("Could not load subscriptions from Firestore:", error);
        }
    }

    // Fall back to localStorage if Firestore gave nothing.
    if(channels.length === 0){
        channels = getSubscribedChannelsLocal();
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
