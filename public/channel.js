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
import { createYoutubeAccountIdentity, onYoutubeGrantChange } from "./youtube-account.js";
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
const ytAccountSubRoot = document.getElementById("channelYtAccountSubRoot");
const ytAccountSubStatusEl = document.getElementById("channelYtAccountSubStatus");
const ytAccountSubBtn = document.getElementById("channelYtAccountSubBtn");


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


// ================= YOUTUBE ACCOUNT SUBSCRIPTION (explicit, confirmed, separate) =================
// Actual connected YouTube account subscription status/actions for this channel.
// Completely separate from MyTube-local subscription (Firestore) handled below.
// Never auto-subscribes/unsubscribes. Mutations require explicit user action +
// clear confirmation and update UI only after confirmed backend success.
// On uncertain mutation timeout/error, refreshes read-only status via GET; never
// blindly retries or aborts an already-sent mutation.
const ytAccountSubState = {
    seq: 0,
    mutationSeq: 0,
    channelId: (typeof channelId === "string" ? channelId.trim() : ""),
    uid: "",
    status: "idle", // idle | signed_out | disconnected | loading | ready | unavailable | mutating
    subscribed: null, // true | false | null
    statusInFlight: false,
    mutationInFlight: false,
    lastError: ""
};

// Read-only identity of the account that will perform YouTube actions.
const ytIdentity = createYoutubeAccountIdentity({
    getUid: () => ytAccountSubAuthUid(),
    getToken: () => getFirebaseIdTokenForYtAccountSub(),
    onChange: () => {
        renderYtAccountSub();
    }
});

function isValidYoutubeChannelIdClient(value){
    const id = String(value || "").trim();
    return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

function currentChannelPageYoutubeId(){
    return isValidYoutubeChannelIdClient(channelId) ? String(channelId).trim() : "";
}

function ytAccountSubAuthUid(){
    const user = (auth && auth.currentUser) || null;
    return user && user.uid ? String(user.uid) : "";
}

async function getFirebaseIdTokenForYtAccountSub(){
    const user = (auth && auth.currentUser) || null;
    if(!user || typeof user.getIdToken !== "function"){
        return null;
    }
    if(auth && typeof auth.authStateReady === "function"){
        try{ await auth.authStateReady(); } catch(e){}
    }
    const freshUser = (auth && auth.currentUser) || user;
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

function renderYtAccountSub(){
    if(!ytAccountSubRoot) return;
    const id = currentChannelPageYoutubeId();
    const show = Boolean(id);
    ytAccountSubRoot.style.display = show ? "" : "none";
    if(!show) return;

    const labelEl = ytAccountSubRoot.querySelector(".channel-yt-account-sub-label");
    if(labelEl){
        const acting = ytIdentity.label();
        labelEl.textContent = acting
            ? ("YouTube account: acting as " + acting)
            : "YouTube account";
    }

    const s = ytAccountSubState;
    const uid = ytAccountSubAuthUid();
    const busy = s.statusInFlight || s.mutationInFlight || s.status === "loading" || s.status === "mutating";
    const identityStatus = ytIdentity.state.status;
    const identityBlocked = ytIdentity.isBlocked()
        || identityStatus === "loading"
        || identityStatus === "error"
        || identityStatus === "idle";
    let statusText = "Status unavailable.";
    let btnText = "Check status";
    let btnDisabled = busy || identityBlocked;
    let showBtn = true;

    if(identityBlocked){
        statusText = ytIdentity.identityMessage();
        btnText = "Check status";
        btnDisabled = busy;
    } else if(!uid){
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

    if(ytAccountSubStatusEl) ytAccountSubStatusEl.textContent = statusText;
    if(ytAccountSubBtn){
        ytAccountSubBtn.textContent = btnText;
        ytAccountSubBtn.disabled = Boolean(btnDisabled);
        ytAccountSubBtn.style.display = showBtn ? "" : "none";
    }
}

function ytAccountSubSetUnavailable(msg, status){
    ytAccountSubState.status = status || "unavailable";
    ytAccountSubState.lastError = msg || "";
    renderYtAccountSub();
}

async function fetchYtAccountSubscriptionStatus(options = {}){
    const opts = options || {};
    const id = currentChannelPageYoutubeId();
    if(!id) return;

    const uid = ytAccountSubAuthUid();

    if(!uid){
        // Intentional status/state transition: invalidate stale in-flight status
        // response and clear status in-flight only. Never clear mutationInFlight:
        // an already-sent subscribe/unsubscribe POST may still be unresolved server-side.
        ytAccountSubState.seq += 1;
        ytAccountSubState.channelId = id;
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
    if(ytAccountSubState.statusInFlight || ytAccountSubState.mutationInFlight){
        return;
    }
    if(
        !opts.force
        && ytAccountSubState.status === "ready"
        && ytAccountSubState.channelId === id
        && ytAccountSubState.uid === uid
    ){
        return;
    }

    const seq = ++ytAccountSubState.seq;
    ytAccountSubState.channelId = id;
    ytAccountSubState.uid = uid;
    ytAccountSubState.statusInFlight = true;
    ytAccountSubState.status = "loading";
    ytAccountSubState.lastError = "";
    renderYtAccountSub();

    let result;
    try{
        const token = await getFirebaseIdTokenForYtAccountSub();
        if(!token){
            result = { ok: false, status: 401, body: { code: "UNAUTHENTICATED" } };
        } else {
            const res = await fetch("/api/youtube/subscription-status?channelId=" + encodeURIComponent(id), {
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
    if(
        seq !== ytAccountSubState.seq
        || ytAccountSubState.statusInFlight !== true
        || currentChannelPageYoutubeId() !== id
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
    const id = currentChannelPageYoutubeId();
    if(!id) return;
    if(action !== "subscribe" && action !== "unsubscribe") return;
    if(ytAccountSubState.mutationInFlight || ytAccountSubState.statusInFlight) return;

    const uid = ytAccountSubAuthUid();
    if(!uid){
        ytAccountSubState.status = "signed_out";
        renderYtAccountSub();
        return;
    }
    if(ytAccountSubState.status === "disconnected"){
        renderYtAccountSub();
        return;
    }

    // Capture the identity the user is currently shown. It must survive the
    // immediate pre-write refresh, and the backend verifies it again.
    const expected = ytIdentity.mutationGuard();
    if(!expected.uid || !expected.channelId){
        ytAccountSubState.lastError = ytIdentity.identityMessage();
        renderYtAccountSub();
        return;
    }

    const chName = (nameEl && nameEl.textContent && nameEl.textContent !== "Channel") ? nameEl.textContent : "this channel";
    const confirmText = action === "subscribe"
        ? ("Subscribe to \"" + chName + "\" using your connected YouTube account?")
        : ("Unsubscribe from \"" + chName + "\" using your connected YouTube account?");
    if(!window.confirm(confirmText)){
        return;
    }

    // Separate mutation ownership: status/auth/channel seq changes must not release
    // a pending mutation lock or allow a second mutation while unresolved.
    const mutationSeqToken = ++ytAccountSubState.mutationSeq;
    ytAccountSubState.channelId = id;
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
        return;
    }

    let result;
    try{
        const token = await getFirebaseIdTokenForYtAccountSub();
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
                body: JSON.stringify({ channelId: id, expectedChannelId: expected.channelId, expectedUid: expected.uid }),
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

    const uiStale = (currentChannelPageYoutubeId() !== id || ytAccountSubAuthUid() !== uid);
    // Original owner releases its lock exactly once when settled.
    ytAccountSubState.mutationInFlight = false;
    if(uiStale){
        // Stale auth/channel context: never apply subscribed/error/success from the old
        // mutation. Derive safe UI from the CURRENT context only.
        const currentId = currentChannelPageYoutubeId();
        const currentUid = ytAccountSubAuthUid();
        ytAccountSubState.channelId = currentId;
        ytAccountSubState.uid = currentUid;
        ytAccountSubState.subscribed = null;
        ytAccountSubState.lastError = "";
        if(!currentUid){
            ytAccountSubState.status = "signed_out";
            renderYtAccountSub();
            return;
        }
        if(!currentId){
            ytAccountSubState.status = "idle";
            renderYtAccountSub();
            return;
        }
        // Signed in with valid channel: unknown state, then fresh read-only GET.
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
        return;
    }

    // Uncertain timeout/error: refresh status via GET for current context.
    // Never blindly repeat mutation.
    if(result.uncertain || code === "UPSTREAM_TIMEOUT" || code === "UPSTREAM_ERROR"){
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
}

function setupYtAccountSubUi(){
    if(!ytAccountSubBtn || ytAccountSubBtn.dataset.ytAccountSubWired === "1") return;
    ytAccountSubBtn.dataset.ytAccountSubWired = "1";
    ytAccountSubBtn.addEventListener("click", () => {
        const uid = ytAccountSubAuthUid();
        if(!uid){
            // Use existing sign-in navigation flow.
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
            ytAccountSubState.lastError = ytIdentity.identityMessage();
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

function resetYtAccountSubscriptionState(){
    // Invalidate stale status responses only. Never release a pending mutation lock.
    ytAccountSubState.seq += 1;
    ytAccountSubState.channelId = currentChannelPageYoutubeId();
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
    else if(!currentChannelPageYoutubeId()) ytAccountSubState.status = "idle";
    else ytAccountSubState.status = "idle";
    renderYtAccountSub();
}

function syncYtAccountSubscriptionForChannelPage(force = false){
    setupYtAccountSubUi();
    renderYtAccountSub();
    if(!currentChannelPageYoutubeId()){
        return;
    }
    void fetchYtAccountSubscriptionStatus({ force: Boolean(force) });
}

// ================= SUBSCRIBE (MyTube-local; existing behavior preserved) =================

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
        renderYtAccountSub();
        return;
    }

    if(sortEl){
        sortEl.addEventListener("change", renderGrid);
    }
    if(moreBtn){
        moreBtn.addEventListener("click", loadMore);
    }

    setupYtAccountSubUi();
    renderYtAccountSub();

    // Auth can resolve after the first render; re-check local button and
    // refresh read-only YouTube account status (no auto mutations; mutation lock preserved).
    onAuthStateChanged(auth, () => {
        const user = (auth && auth.currentUser) || null;
        if(!user){
            ytIdentity.clear("signed_out");
        }
        else{
            void ytIdentity.load({ force: true });
        }
        syncSubscriptionState();
        if(currentChannelPageYoutubeId()){
            void fetchYtAccountSubscriptionStatus({ force: true });
        } else {
            resetYtAccountSubscriptionState();
        }
    });

    onYoutubeGrantChange(() => {
        ytIdentity.clear("idle");
        void ytIdentity.load({ force: true });
        if(currentChannelPageYoutubeId()){
            void fetchYtAccountSubscriptionStatus({ force: true });
        }
    });

    if(currentChannelPageYoutubeId()){
        syncYtAccountSubscriptionForChannelPage(true);
    }

    loadFirstPage();
}

init();
