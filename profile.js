// ================= PROFILE PAGE =================
// Local-only profile view (Firebase auth for identity, localStorage for saved
// videos and subscriptions). No Firestore, no server-side data.

import { auth } from "./firebase.js";
import {
    onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


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


function getSavedVideos(){
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


function getSubscribedChannels(){
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


function renderSavedVideos(){
    if(!savedListEl){
        return;
    }
    savedListEl.replaceChildren();

    const saved = getSavedVideos();

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
        meta.textContent = v.channel + " • " + v.views;

        info.appendChild(title);
        info.appendChild(meta);

        link.appendChild(img);
        link.appendChild(info);
        savedListEl.appendChild(link);
    });
}


function renderSubscribedChannels(){
    if(!subsListEl){
        return;
    }
    subsListEl.replaceChildren();

    const channels = getSubscribedChannels();

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
