// ================= YOUTUBE CONNECT (profile page) =================
// Client half of the existing OAuth foundation in worker.js. This module only
// talks to the three already-shipped endpoints; it never sees the Google client
// secret, the refresh token, or the encryption key — those live server-side and
// are never sent to the browser.
//
// Contract it relies on (see worker.js):
//   GET  /api/oauth/start      Authorization: Bearer <Firebase ID token>
//                              -> 200 { authorizationUrl }
//   GET  /api/oauth/status     Authorization: Bearer <Firebase ID token>
//                              -> 200 { connected: boolean, scope: string,
//                                      connectEnabled: boolean }
//   POST /api/oauth/disconnect Authorization: Bearer <Firebase ID token>
//                              -> 200 { connected: false, revoked: boolean }
// A 401 means the Firebase session needs re-login; 503 means the server's Google
// OAuth env is not configured yet, or the Connect flow is switched off. Both are
// shown as safe, generic messages.
//
// The Connect flow is switched OFF on the server right now: /api/oauth/status
// reports connectEnabled: false. The module removes the Connect button and its
// help text as soon as it sees that flag. An existing connection stays visible
// and stays revocable, because the user must always be able to remove a grant
// from MyTube.
//
// The callback lands back on /profile.html?youtube=connected|cancelled|error;
// that status is consumed here, shown once, and then stripped from the address
// bar so a refresh does not repeat the message.
//
// No new dependency: native fetch + the existing Firebase auth module only.

import { auth } from "./firebase.js";
import {
    onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { createYoutubeAccountIdentity, broadcastYoutubeGrantChange } from "./youtube-account.js";


const statusEl = document.getElementById("ytConnectStatus");
const identityEl = document.getElementById("ytChannelIdentity");
const connectBtn = document.getElementById("ytConnectBtn");
const disconnectBtn = document.getElementById("ytDisconnectBtn");
const helpEl = document.getElementById("ytConnectHelp");

// The exact query param the worker's callback uses (OAUTH_STATUS_PARAM).
const STATUS_PARAM = "youtube";

// The only values the backend ever puts there. Anything else is ignored.
const CALLBACK_STATUSES = {
    connected: { text: "YouTube account connected.", kind: "ok" },
    cancelled: { text: "YouTube connection was cancelled.", kind: "muted" },
    error: { text: "Could not connect YouTube. Please try again.", kind: "error" }
};

// Whether the current request could even reach a configured backend, and
// whether the server allows a new connection at all. When the server reports
// "not configured" or "connect disabled" we stop offering the Connect button.
let connectAvailable = true;

// The signed-in user, kept so button handlers always use a fresh token.
let currentUser = null;

// Read-only identity resolved from the same grant as the rest of the YouTube
// actions. Never inferred from the status endpoint or a cached name.
const ytIdentity = createYoutubeAccountIdentity({
    getUid: () => currentUser && currentUser.uid ? String(currentUser.uid) : "",
    getToken: () => idToken(currentUser),
    onChange: renderChannelIdentity
});


// ================= SAFE STATUS RENDERING =================

function setStatus(text, kind){
    if(!statusEl){
        return;
    }

    statusEl.textContent = text || "";
    statusEl.className = "yt-connect-status" + (kind ? (" " + kind) : "");
}


function setBusy(busy){
    if(connectBtn){
        connectBtn.disabled = busy;
    }
    if(disconnectBtn){
        disconnectBtn.disabled = busy;
    }
}


function renderChannelIdentity(){
    if(!identityEl){
        return;
    }

    const s = ytIdentity.state;

    if(s.status === "ready" && s.channel){
        identityEl.style.display = "flex";
        identityEl.style.alignItems = "center";
        identityEl.style.gap = "10px";
        identityEl.style.marginTop = "8px";
        identityEl.replaceChildren();

        if(s.channel.thumbnail){
            const img = document.createElement("img");
            img.src = s.channel.thumbnail;
            img.alt = "";
            img.loading = "lazy";
            img.decoding = "async";
            img.referrerPolicy = "no-referrer";
            img.style.width = "32px";
            img.style.height = "32px";
            img.style.borderRadius = "50%";
            img.style.objectFit = "cover";
            identityEl.appendChild(img);
        }

        const text = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = s.channel.title || "YouTube channel";
        const id = document.createElement("span");
        id.textContent = "Channel ID: " + s.channel.id;
        id.style.display = "block";
        id.style.fontSize = "12px";
        id.style.color = "#888";
        text.appendChild(title);
        text.appendChild(id);
        identityEl.appendChild(text);
        return;
    }

    if(s.status === "multiple" || s.status === "none"){
        identityEl.style.display = "block";
        identityEl.style.marginTop = "8px";
        identityEl.textContent = ytIdentity.blockedMessage();
        return;
    }

    if(s.status === "error"){
        identityEl.style.display = "block";
        identityEl.style.marginTop = "8px";
        identityEl.textContent = s.lastError || "Could not identify your connected YouTube account.";
        return;
    }

    if(s.status === "disconnected"){
        identityEl.style.display = "block";
        identityEl.style.marginTop = "8px";
        identityEl.textContent = "Reconnect your YouTube account to read its channel identity.";
        return;
    }

    if(s.status === "loading"){
        identityEl.style.display = "block";
        identityEl.style.marginTop = "8px";
        identityEl.textContent = "Checking connected YouTube account...";
        return;
    }

    identityEl.style.display = "none";
    identityEl.replaceChildren();
}


// Read + remove the ?youtube=... status the worker's callback added. Returns the
// message descriptor or null. Stripping the param via replaceState keeps the
// fixed landing URL working (same path) while preventing a repeated message on
// refresh.
function consumeCallbackStatus(){
    if(typeof window === "undefined" || !window.location){
        return null;
    }

    let params;
    try{
        params = new URLSearchParams(window.location.search);
    }
    catch(error){
        return null;
    }

    const raw = params.get(STATUS_PARAM);

    if(!raw){
        return null;
    }

    const result = Object.prototype.hasOwnProperty.call(CALLBACK_STATUSES, raw)
        ? CALLBACK_STATUSES[raw]
        : null;

    // Remove the param from the address bar regardless of whether it was known,
    // so an unexpected value is not left visible or re-handled on reload.
    try{
        params.delete(STATUS_PARAM);
        const query = params.toString();
        const cleanUrl = window.location.pathname + (query ? ("?" + query) : "") + window.location.hash;
        window.history.replaceState(null, "", cleanUrl);
    }
    catch(error){
        // replaceState can be blocked in exotic contexts; the message still shows.
    }

    return result;
}


// ================= BACKEND CALLS =================

// Grab a fresh Firebase ID token. Throws if there is no session.
async function idToken(user){
    if(!user){
        throw new Error("not_authenticated");
    }
    return user.getIdToken();
}


// GET /api/oauth/status — never exposes a token, only connected + scope.
async function fetchStatus(user){
    const token = await idToken(user);
    const response = await fetch("/api/oauth/status", {
        method: "GET",
        headers: { Authorization: "Bearer " + token }
    });
    const body = await response.json().catch(() => null);
    return { response, body };
}


async function refreshStatus(user){
    setBusy(true);

    try{
        const { response, body } = await fetchStatus(user);

        if(response.status === 401){
            connectAvailable = false;
            ytIdentity.clear("signed_out");
            setStatus("Please sign in again to manage your YouTube connection.", "error");
            return;
        }

        if(response.status === 503){
            connectAvailable = false;
            ytIdentity.clear("idle");
            if(connectBtn){
                connectBtn.style.display = "none";
            }
            if(helpEl){
                helpEl.style.display = "none";
            }
            setStatus("YouTube connection is not available yet.", "muted");
            return;
        }

        if(!response.ok){
            ytIdentity.clear("idle");
            setStatus("Could not check your YouTube connection. Please try again.", "error");
            return;
        }

        const connected = Boolean(body && body.connected);

        // The server is the only authority on whether a NEW connection may be
        // started. Only an explicit `true` enables it; a missing or malformed
        // flag fails closed, so an older backend can never silently turn the
        // button back on. An existing connection is still shown, and Disconnect
        // still works.
        const connectEnabled = Boolean(body && body.connectEnabled === true);

        connectAvailable = connectEnabled;

        if(connected){
            setStatus("YouTube account connected.", "ok");
            // Resolve the actual channel from the grant before showing it.
            // Non-blocking so the connect/disconnect controls stay responsive.
            void ytIdentity.load({ force: true });
            if(connectBtn){
                connectBtn.style.display = "none";
            }
            if(disconnectBtn){
                disconnectBtn.style.display = "";
            }
        }
        else{
            ytIdentity.clear("disconnected");
            setStatus(
                connectEnabled
                    ? "No YouTube account connected."
                    : "No YouTube account connected. YouTube connection is not available yet.",
                "muted"
            );
            if(connectBtn){
                connectBtn.style.display = connectEnabled ? "" : "none";
            }
            if(disconnectBtn){
                disconnectBtn.style.display = "none";
            }
        }

        if(helpEl){
            helpEl.style.display = connectEnabled ? "" : "none";
        }
    }
    catch(error){
        if(error && error.message === "not_authenticated"){
            ytIdentity.clear("signed_out");
            return;
        }
        ytIdentity.clear("idle");
        setStatus("Could not check your YouTube connection. Please try again.", "error");
    }
    finally{
        setBusy(false);
    }
}


// Connect: fetch the authorization URL, then navigate the browser to it. The
// URL carries only the public client id, redirect_uri, PKCE challenge and state.
async function handleConnect(){
    if(!currentUser){
        return;
    }

    setBusy(true);

    try{
        const token = await idToken(currentUser);
        const response = await fetch("/api/oauth/start", {
            method: "GET",
            headers: { Authorization: "Bearer " + token }
        });
        const body = await response.json().catch(() => null);

        if(response.status === 401){
            setStatus("Please sign in again to connect YouTube.", "error");
            setBusy(false);
            return;
        }

        if(response.status === 503){
            connectAvailable = false;
            if(connectBtn){
                connectBtn.style.display = "none";
            }
            setStatus("YouTube connection is not available yet.", "muted");
            setBusy(false);
            return;
        }

        const authorizationUrl = body && body.authorizationUrl;

        if(!response.ok || !authorizationUrl || typeof authorizationUrl !== "string"){
            setStatus("Could not start the YouTube connection. Please try again.", "error");
            setBusy(false);
            return;
        }

        // Leave the busy state on purpose: the browser is navigating away.
        setStatus("Redirecting to YouTube...", "muted");
        window.location.assign(authorizationUrl);
    }
    catch(error){
        setStatus("Could not start the YouTube connection. Please try again.", "error");
        setBusy(false);
    }
}


// Disconnect: always tells the truth about whether Google's revoke succeeded.
async function handleDisconnect(){
    if(!currentUser){
        return;
    }

    setBusy(true);

    try{
        const token = await idToken(currentUser);
        const response = await fetch("/api/oauth/disconnect", {
            method: "POST",
            headers: { Authorization: "Bearer " + token }
        });
        const body = await response.json().catch(() => null);

        if(response.status === 401){
            ytIdentity.clear("signed_out");
            setStatus("Please sign in again to disconnect YouTube.", "error");
            return;
        }

        if(!response.ok){
            setStatus("Could not disconnect YouTube. Please try again.", "error");
            return;
        }

        // The grant is gone locally: drop the cached identity immediately and
        // let any other open page/tab re-read the grant.
        ytIdentity.clear("disconnected");
        broadcastYoutubeGrantChange();

        // The local grant is gone either way; `revoked` says whether Google's
        // side was actually revoked, so the message stays honest.
        if(body && body.revoked === false){
            setStatus("Disconnected locally. YouTube could not be reached to fully revoke access; you can also remove access from your Google account.", "muted");
        }
        else{
            setStatus("YouTube account disconnected.", "ok");
        }

        if(connectBtn){
            connectBtn.style.display = connectAvailable ? "" : "none";
        }
        if(disconnectBtn){
            disconnectBtn.style.display = "none";
        }
    }
    catch(error){
        setStatus("Could not disconnect YouTube. Please try again.", "error");
    }
    finally{
        setBusy(false);
    }
}


// ================= WIRING =================

if(connectBtn){
    connectBtn.addEventListener("click", handleConnect);
}

if(disconnectBtn){
    disconnectBtn.addEventListener("click", handleDisconnect);
}


onAuthStateChanged(auth, (user) => {
    currentUser = user || null;

    if(!user){
        // Logged out: the profile page already hides this section via
        // #profileContent, but keep state clean for a later re-login. The
        // Connect button stays hidden — a signed-out visitor could not use it
        // anyway, and the server decides when it may be shown.
        connectAvailable = false;
        ytIdentity.clear("signed_out");
        setStatus("", "");
        if(connectBtn){
            connectBtn.style.display = "none";
        }
        if(disconnectBtn){
            disconnectBtn.style.display = "none";
        }
        if(helpEl){
            helpEl.style.display = "none";
        }
        return;
    }

    // Show the callback result first (it explains a just-finished flow), then
    // reconcile with the authoritative server state.
    const callbackStatus = consumeCallbackStatus();

    if(callbackStatus){
        setStatus(callbackStatus.text, callbackStatus.kind);
        // A completed connect/reconnect changes the grant. Notify other pages
        // and tabs; the signal contains no tokens or channel identity.
        if(callbackStatus === CALLBACK_STATUSES.connected){
            broadcastYoutubeGrantChange();
        }
    }

    refreshStatus(user);
});
