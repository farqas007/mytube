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
//                              -> 200 { connected: boolean, scope: string }
//   POST /api/oauth/disconnect Authorization: Bearer <Firebase ID token>
//                              -> 200 { connected: false, revoked: boolean }
// A 401 means the Firebase session needs re-login; 503 means the server's Google
// OAuth env is not configured yet. Both are shown as safe, generic messages.
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


const statusEl = document.getElementById("ytConnectStatus");
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

// Whether the current request could even reach a configured backend. When the
// server reports "not configured" we stop offering the Connect button.
let connectAvailable = true;

// The signed-in user, kept so button handlers always use a fresh token.
let currentUser = null;


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
            setStatus("Please sign in again to manage your YouTube connection.", "error");
            return;
        }

        if(response.status === 503){
            connectAvailable = false;
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
            setStatus("Could not check your YouTube connection. Please try again.", "error");
            return;
        }

        connectAvailable = true;

        const connected = Boolean(body && body.connected);

        if(connected){
            setStatus("YouTube account connected.", "ok");
            if(connectBtn){
                connectBtn.style.display = "none";
            }
            if(disconnectBtn){
                disconnectBtn.style.display = "";
            }
        }
        else{
            setStatus("No YouTube account connected.", "muted");
            if(connectBtn){
                connectBtn.style.display = "";
            }
            if(disconnectBtn){
                disconnectBtn.style.display = "none";
            }
        }
    }
    catch(error){
        if(error && error.message === "not_authenticated"){
            return;
        }
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
            setStatus("Please sign in again to disconnect YouTube.", "error");
            return;
        }

        if(!response.ok){
            setStatus("Could not disconnect YouTube. Please try again.", "error");
            return;
        }

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
        // #profileContent, but keep state clean for a later re-login.
        connectAvailable = true;
        setStatus("", "");
        if(connectBtn){
            connectBtn.style.display = "";
        }
        if(disconnectBtn){
            disconnectBtn.style.display = "none";
        }
        if(helpEl){
            helpEl.style.display = "";
        }
        return;
    }

    // Show the callback result first (it explains a just-finished flow), then
    // reconcile with the authoritative server state.
    const callbackStatus = consumeCallbackStatus();

    if(callbackStatus){
        setStatus(callbackStatus.text, callbackStatus.kind);
    }

    refreshStatus(user);
});
