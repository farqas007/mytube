// ================= SUBSCRIPTIONS PAGE =================
// Shows local MyTube subscribed channels (existing behavior) and the actual
// subscriptions of the connected YouTube account (read-only, explicit page load).
// Local/MyTube subscriptions remain separate from YouTube account subscriptions.

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSubscriptions, removeSubscription } from "./data.js";
import { channelVideos, channel } from "./youtube.js";
import { createYoutubeAccountIdentity, onYoutubeGrantChange } from "./youtube-account.js";
import { attachHoverPreview } from "./shared/hoverPreview.js";


// ================= ELEMENTS =================

const loggedOutEl = document.getElementById("subsLoggedOut");
const contentEl = document.getElementById("subsContent");
const sectionsEl = document.getElementById("channelSections");

// Local (MyTube) subscriptions UI — scoped so it does not affect the
// YouTube Account Subscriptions section.
const localLoadingEl = document.getElementById("localSubsLoading");
const localEmptyEl = document.getElementById("localSubsEmpty");
const localErrorEl = document.getElementById("localSubsError");
const localErrorTextEl = document.getElementById("localSubsErrorText");
const localViewsEl = document.getElementById("localSubsViews");
// Backward-compatible aliases for existing local logic.
const loadingEl = localLoadingEl;
const emptyEl = localEmptyEl;
const errorEl = localErrorEl;
const errorTextEl = localErrorTextEl;


// ================= STATE DISPLAY =================

function showLocalState(state){
    if(contentEl){
        contentEl.style.display = "block";
    }
    [localLoadingEl, localEmptyEl, localErrorEl].forEach(el => {
        if(el){ el.style.display = "none"; }
    });
    if(localViewsEl){
        localViewsEl.style.display = state === "content" ? "" : "none";
    }
    const target = {
        loading: localLoadingEl,
        empty: localEmptyEl,
        error: localErrorEl
    }[state];
    if(target){
        target.style.display = "";
    }
}

function showState(state){
    // Preserve existing call sites/behavior for local MyTube subscriptions.
    if(state === "loggedOut"){
        if(loggedOutEl){ loggedOutEl.style.display = ""; }
        if(contentEl){ contentEl.style.display = "none"; }
        [localLoadingEl, localEmptyEl, localErrorEl].forEach(el => {
            if(el){ el.style.display = "none"; }
        });
        if(localViewsEl){ localViewsEl.style.display = "none"; }
        renderYoutubeAccountSignedOut();
        return;
    }
    if(loggedOutEl){ loggedOutEl.style.display = "none"; }
    if(state === "content"){
        showLocalState("content");
        return;
    }
    if(state === "loading"){
        showLocalState("loading");
        return;
    }
    if(state === "empty"){
        showLocalState("empty");
        return;
    }
    if(state === "error"){
        showLocalState("error");
    }
}


function showError(msg){
    if(errorTextEl){
        errorTextEl.textContent = msg || "Could not load subscriptions.";
    }
    showState("error");
}


// ================= YOUTUBE ACCOUNT SUBSCRIPTIONS =================
// Fetches actual subscriptions from the connected YouTube account via the
// authenticated backend endpoint (read-only list). First page only on page
// open/auth load. Per-item YT account status/subscribe/unsubscribe controls are
// explicit, confirmed, and separate from MyTube-local subscriptions. Never
// auto-subscribes/unsubscribes. Status fetches occur only on explicit user
// request or uncertain-mutation recovery (read-only GET).

const ytSubsEls = {
    section: document.getElementById("youtubeAccountSubsSection"),
    subtitle: document.querySelector("#youtubeAccountSubsSection .yt-account-subs-subtitle"),
    status: document.getElementById("ytAccountSubsStatus"),
    countWrap: document.getElementById("ytAccountSubsControls"),
    count: document.getElementById("ytAccountSubsCount"),
    loading: document.getElementById("ytAccountSubsLoading"),
    state: document.getElementById("ytAccountSubsState"),
    stateText: document.getElementById("ytAccountSubsStateText"),
    actionBtn: document.getElementById("ytAccountSubsActionBtn"),
    list: document.getElementById("ytAccountSubsList"),
    loadMore: document.getElementById("ytAccountSubsLoadMore")
};

const ytSubsState = {
    uid: "",
    items: [],
    nextPageToken: null,
    totalResults: null,
    requestInFlight: false,
    seq: 0,
    loadedFirstPage: false,
    lastPageToken: "",
    channelIds: new Set()
};

// Read-only identity of the account whose subscriptions are shown and whose
// account will perform any per-item YouTube subscribe/unsubscribe action.
const ytIdentity = createYoutubeAccountIdentity({
    getUid: () => ytItemCurrentUid(),
    getToken: () => getFirebaseIdTokenForYoutubeSubs(),
    onChange: () => {
        renderYoutubeAccountIdentity();
        renderAllYtItemControls();
    }
});

function renderYoutubeAccountIdentity(){
    if(!ytSubsEls.subtitle){
        return;
    }
    const base = "Subscriptions from your connected YouTube account. This list is separate from MyTube local subscriptions.";
    const acting = ytIdentity.label();
    if(acting){
        ytSubsEls.subtitle.textContent = "Acting as " + acting + ". " + base;
    }
    else if(ytIdentity.state.status === "multiple" || ytIdentity.state.status === "none"){
        ytSubsEls.subtitle.textContent = ytIdentity.blockedMessage() + " " + base;
    }
    else{
        ytSubsEls.subtitle.textContent = base;
    }
}

function ytSubsSetStatus(msg){
    if(ytSubsEls.status){ ytSubsEls.status.textContent = msg || ""; }
}

function ytSubsShowLoading(show){
    if(ytSubsEls.loading){ ytSubsEls.loading.style.display = show ? "" : "none"; }
}

function ytSubsShowState(show, msg, actionLabel, actionHref){
    if(ytSubsEls.state){ ytSubsEls.state.style.display = show ? "" : "none"; }
    if(ytSubsEls.stateText){ ytSubsEls.stateText.textContent = show ? (msg || "") : ""; }
    if(ytSubsEls.actionBtn){
        if(show && actionLabel){
            ytSubsEls.actionBtn.style.display = "";
            ytSubsEls.actionBtn.textContent = actionLabel;
            ytSubsEls.actionBtn.onclick = actionHref ? () => { window.location.href = actionHref; } : null;
        } else {
            ytSubsEls.actionBtn.style.display = "none";
            ytSubsEls.actionBtn.textContent = "";
            ytSubsEls.actionBtn.onclick = null;
        }
    }
}

function ytSubsUpdateCount(){
    if(!ytSubsEls.countWrap || !ytSubsEls.count){ return; }
    if(ytSubsState.totalResults == null){
        ytSubsEls.countWrap.style.display = "none";
        ytSubsEls.count.textContent = "";
        return;
    }
    const n = Number(ytSubsState.totalResults);
    ytSubsEls.countWrap.style.display = "";
    ytSubsEls.count.textContent = Number.isFinite(n)
        ? ("Total YouTube subscriptions: " + n.toLocaleString())
        : "Total YouTube subscriptions: unavailable";
}

function ytSubsRenderLoadMore(){
    if(!ytSubsEls.loadMore){ return; }
    const hasMore = typeof ytSubsState.nextPageToken === "string" && ytSubsState.nextPageToken.length > 0;
    ytSubsEls.loadMore.style.display = hasMore ? "" : "none";
    ytSubsEls.loadMore.disabled = ytSubsState.requestInFlight;
    ytSubsEls.loadMore.textContent = ytSubsState.requestInFlight ? "Loading..." : "Load more";
}

function ytSubsThumbUrl(thumbnails){
    if(!thumbnails || typeof thumbnails !== "object"){ return ""; }
    const pick = thumbnails.medium || thumbnails.default || thumbnails.high || null;
    return pick && typeof pick.url === "string" ? pick.url : "";
}

function ytSubsRenderItem(item){
    if(!item || !item.channelId){ return null; }
    const channelId = String(item.channelId);
    const itemTitle = item.title || "YouTube channel";
    const row = document.createElement("article");
    row.className = "yt-account-sub-card";
    row.setAttribute("data-channel-id", channelId);

    const link = document.createElement("a");
    link.className = "yt-account-sub-link";
    link.href = "channel.html?id=" + encodeURIComponent(channelId);
    link.setAttribute("aria-label", "Open channel " + (itemTitle || "on YouTube"));

    const avatar = document.createElement("div");
    avatar.className = "yt-account-sub-avatar";
    const thumbUrl = ytSubsThumbUrl(item.thumbnails);
    if(thumbUrl){
        const img = document.createElement("img");
        img.src = thumbUrl;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        avatar.appendChild(img);
    } else {
        avatar.textContent = getInitials(itemTitle || "C");
    }

    const info = document.createElement("div");
    info.className = "yt-account-sub-info";
    const title = document.createElement("h3");
    title.className = "yt-account-sub-title";
    title.textContent = itemTitle || "YouTube channel";
    info.appendChild(title);
    if(item.description){
        const desc = document.createElement("p");
        desc.className = "yt-account-sub-desc";
        desc.textContent = String(item.description).slice(0, 140);
        info.appendChild(desc);
    }

    link.appendChild(avatar);
    link.appendChild(info);
    row.appendChild(link);

    // Explicit YT account controls (separate from MyTube-local). No auto status fetch.
    if(isValidYoutubeChannelIdClient(channelId)){
        row.appendChild(createYtItemActions(channelId, itemTitle));
        renderYtItemControl(channelId, row);
    }

    return row;
}

function ytSubsAppendItems(items){
    if(!ytSubsEls.list || !Array.isArray(items)){ return; }
    for(const item of items){
        const channelId = item && item.channelId ? String(item.channelId) : "";
        if(!channelId || ytSubsState.channelIds.has(channelId)){ continue; }
        ytSubsState.channelIds.add(channelId);
        ytSubsState.items.push(item);
        const row = ytSubsRenderItem(item);
        if(row){ ytSubsEls.list.appendChild(row); }
    }
}

function resetYtItemControlsForViewReset(){
    // Preserve pending mutation locks across auth/list resets. Only the original
    // mutation owner may release its lock after settlement.
    for(const [channelId, state] of ytItemControlStates.entries()){
        if(state && state.mutationInFlight){
            state.status = "mutating";
            state.lastError = "";
            // Keep mutationSeq/mutationInFlight/uid/channelId ownership intact.
            continue;
        }
        ytItemControlStates.delete(channelId);
    }
}

function ytSubsResetView(){
    ytSubsState.items = [];
    ytSubsState.nextPageToken = null;
    ytSubsState.totalResults = null;
    ytSubsState.loadedFirstPage = false;
    ytSubsState.lastPageToken = "";
    ytSubsState.channelIds = new Set();
    if(ytSubsEls.list){ ytSubsEls.list.replaceChildren(); }
    resetYtItemControlsForViewReset();
    ytSubsUpdateCount();
    ytSubsRenderLoadMore();
    ytSubsSetStatus("");
    ytSubsShowLoading(false);
    ytSubsShowState(false);
}

async function getFirebaseIdTokenForYoutubeSubs(){
    const user = auth && auth.currentUser;
    if(!user || typeof user.getIdToken !== "function"){
        return null;
    }
    try{
        if(typeof auth.authStateReady === "function"){
            await auth.authStateReady();
        }
    } catch(e){ /* ignore */ }
    const freshUser = (auth && auth.currentUser) || user;
    if(!freshUser || typeof freshUser.getIdToken !== "function"){
        return null;
    }
    try{
        return await freshUser.getIdToken();
    } catch(e){
        return null;
    }
}

function ytSubsSafeErrorMessage(result){
    const code = result && result.body && result.body.code ? String(result.body.code) : "";
    const fallback = "Could not load YouTube account subscriptions right now. Please try again.";
    if(!result){
        return fallback;
    }
    if(result.status === 401 || code === "UNAUTHENTICATED"){
        return "Sign in to view your YouTube account subscriptions.";
    }
    if(code === "YOUTUBE_NOT_CONNECTED"){
        return "Connect your YouTube account in Profile to view your YouTube subscriptions here.";
    }
    if(code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
        return "Reconnect your YouTube account in Profile to view your YouTube subscriptions.";
    }
    if(code === "QUOTA_EXCEEDED"){
        return "YouTube's daily limit has been reached. Please try again later.";
    }
    if(code === "RATE_LIMITED"){
        return "You're making requests too quickly. Please wait a moment and try again.";
    }
    if(code === "UPSTREAM_TIMEOUT" || code === "UPSTREAM_ERROR" || code === "TOKEN_EXCHANGE_FAILED" || code === "OAUTH_UNAVAILABLE"){
        return "YouTube account subscriptions are temporarily unavailable. Please try again.";
    }
    if(code === "INVALID_PAGE_TOKEN" || code === "INVALID_REQUEST"){
        return "Could not load more YouTube subscriptions. Please refresh and try again.";
    }
    if(result.body && typeof result.body.error === "string" && result.body.error){
        return result.body.error;
    }
    return fallback;
}

function ytSubsIsConnectState(result){
    const code = result && result.body && result.body.code ? String(result.body.code) : "";
    return code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED";
}

// Per-item YouTube account controls (explicit, confirmed; separate from MyTube-local).
// State keyed by channelId. Never auto-subscribes/unsubscribes. Status GET occurs
// only on explicit user request or uncertain-mutation recovery. Pending mutation
// locks are never released by auth/list resets; only the original mutation owner
// releases its lock on settlement. Stale results must not update other contexts.
const ytItemControlStates = new Map();

function isValidYoutubeChannelIdClient(value){
    const id = String(value || "").trim();
    return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id);
}

function ytItemCurrentUid(){
    const user = (auth && auth.currentUser) || null;
    return user && user.uid ? String(user.uid) : "";
}

function getYtItemControlState(channelId, title){
    const id = String(channelId || "").trim();
    if(!id) return null;
    let state = ytItemControlStates.get(id);
    if(!state){
        state = {
            seq: 0,
            mutationSeq: 0,
            channelId: id,
            uid: ytItemCurrentUid(),
            title: String(title || ""),
            status: "unknown", // unknown | signed_out | disconnected | loading | ready | unavailable | mutating
            subscribed: null,
            statusInFlight: false,
            mutationInFlight: false,
            lastError: ""
        };
        ytItemControlStates.set(id, state);
    }
    if(title) state.title = String(title);
    return state;
}

function findYtItemRow(channelId){
    if(!ytSubsEls.list || !channelId) return null;
    return ytSubsEls.list.querySelector('.yt-account-sub-card[data-channel-id="' + String(channelId).replace(/"/g, '\\"') + '"]');
}

function renderYtItemControl(channelId, rowOverride){
    const state = getYtItemControlState(channelId);
    if(!state) return;
    const row = rowOverride || findYtItemRow(channelId);
    if(!row) return;
    const statusEl = row.querySelector(".yt-account-sub-action-status");
    const btn = row.querySelector(".yt-account-sub-action-btn");
    if(!statusEl || !btn) return;

    const uid = ytItemCurrentUid();
    const busy = state.statusInFlight || state.mutationInFlight || state.status === "loading" || state.status === "mutating";
    const identityStatus = ytIdentity.state.status;
    const identityBlocked = ytIdentity.isBlocked()
        || identityStatus === "loading"
        || identityStatus === "error"
        || identityStatus === "idle";
    let statusText = "YouTube status unknown.";
    let btnText = "Check YouTube status";
    let btnDisabled = busy || identityBlocked;

    if(identityBlocked){
        statusText = ytIdentity.identityMessage();
        btnText = "Check YouTube status";
        btnDisabled = busy;
    } else if(!uid){
        statusText = "Sign in to manage YouTube account.";
        btnText = "Sign in";
        btnDisabled = false;
    } else if(state.status === "loading"){
        statusText = "Checking status...";
        btnText = "Checking...";
    } else if(state.status === "mutating"){
        statusText = "Updating YouTube subscription...";
        btnText = "Updating...";
    } else if(state.status === "disconnected"){
        statusText = "YouTube account not connected.";
        btnText = "Open Profile";
        btnDisabled = false;
    } else if(state.status === "ready"){
        if(state.subscribed === true){
            statusText = "Subscribed on YouTube.";
            btnText = "Unsubscribe on YouTube";
            btnDisabled = busy;
        } else if(state.subscribed === false){
            statusText = "Not subscribed on YouTube.";
            btnText = "Subscribe on YouTube";
            btnDisabled = busy;
        } else {
            statusText = "Status unavailable.";
            btnText = "Check YouTube status";
            btnDisabled = busy;
        }
    } else if(state.status === "unavailable"){
        statusText = state.lastError || "Status unavailable.";
        btnText = "Retry check";
        btnDisabled = busy;
    } else if(state.status === "signed_out"){
        statusText = "Sign in to manage YouTube account.";
        btnText = "Sign in";
        btnDisabled = false;
    } else { // unknown
        statusText = "Check your YouTube account status.";
        btnText = "Check YouTube status";
        btnDisabled = busy;
    }

    statusEl.textContent = statusText;
    btn.textContent = btnText;
    btn.disabled = Boolean(btnDisabled);
}

function renderAllYtItemControls(){
    if(!ytSubsEls.list) return;
    const rows = ytSubsEls.list.querySelectorAll(".yt-account-sub-card[data-channel-id]");
    rows.forEach(row => {
        const channelId = row.getAttribute("data-channel-id");
        if(channelId) renderYtItemControl(channelId);
    });
}

function ytItemIsListContextCurrent(uid){
    const currentUid = ytItemCurrentUid();
    // Stale if auth changed or the list is no longer for this signed-in user.
    if(!currentUid || !uid || currentUid !== uid) return false;
    if(ytSubsState.uid && ytSubsState.uid !== currentUid) return false;
    return true;
}

function ytItemSetUnavailable(channelId, msg){
    const state = getYtItemControlState(channelId);
    if(!state) return;
    state.status = "unavailable";
    state.lastError = msg || "";
    renderYtItemControl(channelId);
}

async function fetchYtItemSubscriptionStatus(channelId, options){
    const opts = options || {};
    const id = String(channelId || "").trim();
    if(!isValidYoutubeChannelIdClient(id)) return;
    const state = getYtItemControlState(id);
    if(!state) return;

    const uid = ytItemCurrentUid();
    if(!uid){
        // Mutate existing state in place (do not replace object): preserves owner
        // references held by in-flight requests and avoids stale-map overwrites.
        state.seq += 1; // Invalidate prior status-request ownership.
        state.channelId = id;
        state.uid = "";
        state.statusInFlight = false; // Old status request no longer owns state.
        // Never release mutationInFlight on auth/status transitions.
        state.mutationSeq = state.mutationSeq;
        state.mutationInFlight = state.mutationInFlight;
        state.status = state.mutationInFlight ? "mutating" : "signed_out";
        state.subscribed = state.mutationInFlight ? state.subscribed : null;
        state.lastError = "";
        renderYtItemControl(id);
        return;
    }

    if(state.statusInFlight || state.mutationInFlight) return;
    if(!opts.force && state.status === "ready" && state.uid === uid) return;

    const seq = ++state.seq;
    state.uid = uid;
    state.channelId = id;
    state.statusInFlight = true;
    state.status = "loading";
    state.lastError = "";
    renderYtItemControl(id);

    let result;
    try{
        const token = await getFirebaseIdTokenForYoutubeSubs();
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

    // Only owner may settle; guard against stale account/channel/list context.
    if(seq !== state.seq || state.statusInFlight !== true || !ytItemIsListContextCurrent(uid) || ytItemCurrentUid() !== uid){
        return;
    }

    state.statusInFlight = false;
    const body = result && result.body ? result.body : {};
    const code = String(body.code || "");

    if(result.ok && body.ok === true && body.available === true && (body.subscribed === true || body.subscribed === false)){
        state.status = "ready";
        state.subscribed = body.subscribed === true;
        state.lastError = "";
        renderYtItemControl(id);
        return;
    }

    if(result.status === 401 || code === "UNAUTHENTICATED"){
        state.status = "signed_out";
        state.subscribed = null;
        state.lastError = "";
        ytIdentity.clear("signed_out");
    } else if(ytSubsIsConnectState(result)){
        state.status = "disconnected";
        state.subscribed = null;
        state.lastError = "";
        ytIdentity.clear("disconnected");
    } else if(code === "RATE_LIMITED"){
        ytItemSetUnavailable(id, "Requests are too fast. Please wait and retry.");
        return;
    } else if(code === "QUOTA_EXCEEDED"){
        ytItemSetUnavailable(id, "YouTube daily limit reached. Try again later.");
        return;
    } else {
        ytItemSetUnavailable(id, (body && body.error) ? String(body.error) : "Could not check YouTube status.");
        return;
    }
    renderYtItemControl(id);
}

async function mutateYtItemSubscription(channelId, action){
    const id = String(channelId || "").trim();
    if(!isValidYoutubeChannelIdClient(id)) return;
    if(action !== "subscribe" && action !== "unsubscribe") return;
    const state = getYtItemControlState(id);
    if(!state) return;
    if(state.mutationInFlight || state.statusInFlight) return;

    const uid = ytItemCurrentUid();
    if(!uid){
        state.status = "signed_out";
        state.subscribed = null;
        renderYtItemControl(id);
        return;
    }
    if(!ytItemIsListContextCurrent(uid)){
        renderYtItemControl(id);
        return;
    }
    if(state.status === "disconnected"){
        renderYtItemControl(id);
        return;
    }

    // Capture the identity the user is currently shown. It must survive the
    // immediate pre-write refresh, and the backend verifies it again.
    const expected = ytIdentity.mutationGuard();
    if(!expected.uid || !expected.channelId){
        state.status = "unavailable";
        state.lastError = ytIdentity.identityMessage();
        renderYtItemControl(id);
        return;
    }

    const chName = state.title || "this channel";
    const confirmText = action === "subscribe"
        ? ("Subscribe to \"" + chName + "\" using your connected YouTube account?")
        : ("Unsubscribe from \"" + chName + "\" using your connected YouTube account?");
    if(!window.confirm(confirmText)){
        return;
    }

    // Separate mutation ownership: auth/list resets/status seq must not release lock.
    const mutationSeqToken = ++state.mutationSeq;
    state.uid = uid;
    state.channelId = id;
    state.mutationInFlight = true;
    state.status = "mutating";
    state.lastError = "";
    renderYtItemControl(id);

    // Refresh and verify immediately before the write. If the grant, user or
    // channel changed, block instead of silently acting on another account.
    const guard = await ytIdentity.verifyForMutation(expected);
    if(mutationSeqToken !== state.mutationSeq){
        return;
    }
    if(!guard.ok){
        state.mutationInFlight = false;
        state.status = "unavailable";
        state.lastError = ytIdentity.mutationFailureMessage(guard.reason);
        renderYtItemControl(id);
        return;
    }

    let result;
    try{
        const token = await getFirebaseIdTokenForYoutubeSubs();
        if(!token){
            result = { ok: false, status: 401, body: { code: "UNAUTHENTICATED" }, uncertain: false };
        } else {
            const endpoint = action === "subscribe" ? "/api/youtube/subscribe" : "/api/youtube/unsubscribe";
            // Never abort or blindly retry an already-sent mutation request.
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
    if(mutationSeqToken !== state.mutationSeq){
        return;
    }

    const uiStale = !ytItemIsListContextCurrent(uid) || ytItemCurrentUid() !== uid;
    state.mutationInFlight = false;
    if(uiStale){
        // Never apply subscribed/error/success to another account/channel/list context.
        state.uid = ytItemCurrentUid();
        state.subscribed = null;
        state.lastError = "";
        if(!ytItemCurrentUid()){
            state.status = "signed_out";
            renderYtItemControl(id);
            return;
        }
        // Signed-in current context unknown for this item; fresh read-only GET only
        // after lock release, and only if row still exists in current list.
        state.status = "unknown";
        renderYtItemControl(id);
        if(findYtItemRow(id)){
            void fetchYtItemSubscriptionStatus(id, { force: true });
        }
        return;
    }

    const body = result && result.body ? result.body : {};
    const code = String(body.code || "");

    if(result.ok && body.ok === true && body.available === true && (body.subscribed === true || body.subscribed === false)){
        state.status = "ready";
        state.subscribed = body.subscribed === true;
        state.lastError = "";
        renderYtItemControl(id);
        return;
    }

    // Uncertain outcome: read-only status check for this channel; never retry mutation.
    if(result.uncertain || code === "UPSTREAM_TIMEOUT" || code === "UPSTREAM_ERROR"){
        state.status = "unknown";
        state.lastError = "";
        renderYtItemControl(id);
        void fetchYtItemSubscriptionStatus(id, { force: true });
        return;
    }

    if(result.status === 401 || code === "UNAUTHENTICATED"){
        state.status = "signed_out";
        state.subscribed = null;
        state.lastError = "";
        ytIdentity.clear("signed_out");
    } else if(ytSubsIsConnectState(result)){
        state.status = "disconnected";
        state.subscribed = null;
        state.lastError = "";
        ytIdentity.clear("disconnected");
    } else if(code === "YOUTUBE_IDENTITY_CHANGED" || code === "MULTIPLE_CHANNELS" || code === "YOUTUBE_IDENTITY_UNVERIFIED"){
        state.status = "unavailable";
        state.lastError = (body && body.error) ? String(body.error) : "Could not verify your connected YouTube channel.";
        ytIdentity.clear("idle");
        void ytIdentity.load({ force: true });
    } else if(code === "RATE_LIMITED"){
        state.status = "unavailable";
        state.lastError = "Requests are too fast. Please wait and retry.";
    } else if(code === "QUOTA_EXCEEDED"){
        state.status = "unavailable";
        state.lastError = "YouTube daily limit reached. Try again later.";
    } else {
        state.status = "unavailable";
        state.lastError = (body && body.error) ? String(body.error) : "Could not update YouTube subscription.";
    }
    renderYtItemControl(id);
}

function handleYtItemControlClick(channelId){
    const id = String(channelId || "").trim();
    if(!isValidYoutubeChannelIdClient(id)) return;
    const uid = ytItemCurrentUid();
    if(!uid){
        window.location.href = "login.html";
        return;
    }
    const state = getYtItemControlState(id);
    if(!state) return;
    if(state.statusInFlight || state.mutationInFlight) return;
    if(state.status === "disconnected"){
        window.location.href = "profile.html";
        return;
    }

    // Read-only status checks stay available even when identity is ambiguous
    // or temporarily unavailable; only the mutation path is gated.
    const guard = ytIdentity.mutationGuard();
    if(!guard.uid || !guard.channelId){
        state.lastError = ytIdentity.identityMessage();
        void fetchYtItemSubscriptionStatus(id, { force: true });
        return;
    }
    if(state.status === "ready" && state.subscribed === true){
        void mutateYtItemSubscription(id, "unsubscribe");
        return;
    }
    if(state.status === "ready" && state.subscribed === false){
        void mutateYtItemSubscription(id, "subscribe");
        return;
    }
    // Explicit status check (only on user request) / retry.
    void fetchYtItemSubscriptionStatus(id, { force: true });
}

function createYtItemActions(channelId, title){
    const actions = document.createElement("div");
    actions.className = "yt-account-sub-actions";

    const status = document.createElement("span");
    status.className = "yt-account-sub-action-status";
    status.setAttribute("aria-live", "polite");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yt-account-sub-action-btn channel-section-unsub";
    btn.setAttribute("aria-label", "Manage YouTube account subscription for " + (title || "channel"));
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleYtItemControlClick(channelId);
    });

    actions.appendChild(status);
    actions.appendChild(btn);

    // Initialize state/UI (no status fetch - explicit request only).
    getYtItemControlState(channelId, title);
    return actions;
}

async function fetchYoutubeAccountSubscriptions(pageToken){
    const token = await getFirebaseIdTokenForYoutubeSubs();
    if(!token){
        return { ok: false, status: 401, body: { code: "UNAUTHENTICATED" } };
    }
    const qs = new URLSearchParams();
    if(pageToken){
        qs.set("pageToken", String(pageToken));
    }
    const path = "/api/youtube/subscriptions" + (qs.toString() ? ("?" + qs.toString()) : "");
    const res = await fetch(path, {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        cache: "no-store"
    });
    let body = null;
    try{ body = await res.json(); } catch(e){ body = null; }
    return { ok: res.ok, status: res.status, body };
}

async function loadYoutubeAccountSubscriptions(options){
    const opts = options || {};
    const pageToken = typeof opts.pageToken === "string" ? opts.pageToken : "";
    const user = auth && auth.currentUser;
    if(!user){
        renderYoutubeAccountSignedOut();
        return;
    }
    if(ytSubsState.requestInFlight){
        return;
    }
    if(pageToken && (!ytSubsState.nextPageToken || ytSubsState.nextPageToken !== pageToken)){
        return;
    }

    const seq = ++ytSubsState.seq;
    ytSubsState.uid = user.uid;
    ytSubsState.requestInFlight = true;
    ytSubsRenderLoadMore();
    ytSubsShowState(false);
    ytSubsSetStatus("");
    if(!pageToken){
        ytSubsShowLoading(true);
        // Clear stale items only when loading first page explicitly.
        // Preserve pending mutation locks (owner-only release on settlement).
        if(ytSubsEls.list){ ytSubsEls.list.replaceChildren(); }
        resetYtItemControlsForViewReset();
        ytSubsState.items = [];
        ytSubsState.channelIds = new Set();
        ytSubsState.nextPageToken = null;
        ytSubsState.totalResults = null;
        ytSubsUpdateCount();
    }

    let result;
    try{
        result = await fetchYoutubeAccountSubscriptions(pageToken);
    } catch(e){
        result = { ok: false, status: 0, body: { code: "UPSTREAM_ERROR" } };
    }

    // Request ownership: only the request that started this load may settle or
    // mutate YT subscriptions UI/state. Auth resets/new requests supersede it.
    if(seq !== ytSubsState.seq || ytSubsState.uid !== (auth && auth.currentUser && auth.currentUser.uid)){
        if(seq === ytSubsState.seq){
            // Same sequence but no longer valid for current auth/user context;
            // settle only if we still own the in-flight state.
            ytSubsState.requestInFlight = false;
            ytSubsShowLoading(false);
            ytSubsRenderLoadMore();
        }
        return;
    }

    ytSubsState.requestInFlight = false;
    ytSubsShowLoading(false);

    if(result.ok && result.body && result.body.ok === true && result.body.available === true){
        ytSubsState.loadedFirstPage = true;
        ytSubsState.nextPageToken = typeof result.body.nextPageToken === "string" && result.body.nextPageToken
            ? result.body.nextPageToken
            : null;
        ytSubsState.totalResults = result.body.pageInfo && Number.isFinite(Number(result.body.pageInfo.totalResults))
            ? Number(result.body.pageInfo.totalResults)
            : (Array.isArray(result.body.items) ? result.body.items.length : 0);
        ytSubsAppendItems(Array.isArray(result.body.items) ? result.body.items : []);
        ytSubsUpdateCount();
        ytSubsRenderLoadMore();
        if(ytSubsState.items.length === 0){
            ytSubsShowState(true, "No YouTube account subscriptions were found for this connected account.");
        } else {
            ytSubsShowState(false);
        }
        return;
    }

    ytSubsRenderLoadMore();
    if(ytSubsState.items.length > 0 && pageToken){
        ytSubsSetStatus(ytSubsSafeErrorMessage(result));
        return;
    }

    const msg = ytSubsSafeErrorMessage(result);
    if(ytSubsIsConnectState(result)){
        ytIdentity.clear("disconnected");
        ytSubsShowState(true, msg, "Open Profile", "profile.html");
    } else if(result && (result.status === 401 || (result.body && result.body.code === "UNAUTHENTICATED"))){
        ytSubsShowState(true, msg, "Log In", "login.html");
    } else {
        ytSubsShowState(true, msg);
    }
}

function renderYoutubeAccountSignedOut(){
    ytSubsState.seq += 1;
    ytSubsState.requestInFlight = false;
    ytSubsState.loadedFirstPage = false;
    ytIdentity.clear("signed_out");
    ytSubsResetView();
    ytSubsShowState(true, "Sign in to view subscriptions from your connected YouTube account.", "Log In", "login.html");
}

function initYoutubeAccountSubscriptions(user){
    if(!ytSubsEls.section){ return; }
    ytSubsState.uid = user && user.uid ? user.uid : "";
    ytSubsState.seq += 1;
    ytSubsState.requestInFlight = false;
    ytSubsResetView();
    if(!user){
        renderYoutubeAccountSignedOut();
        return;
    }
    // Fetch first page only on page open/auth load; identity is read-only.
    void ytIdentity.load({ force: true });
    loadYoutubeAccountSubscriptions();
}

function setupYoutubeAccountSubscriptionsUi(){
    if(!ytSubsEls.loadMore || ytSubsEls.loadMore.dataset.ytSubsWired === "1"){ return; }
    ytSubsEls.loadMore.dataset.ytSubsWired = "1";
    ytSubsEls.loadMore.addEventListener("click", () => {
        if(ytSubsState.requestInFlight){ return; }
        if(!ytSubsState.nextPageToken){ return; }
        void loadYoutubeAccountSubscriptions({ pageToken: ytSubsState.nextPageToken });
    });
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
    window.location.href = "/watch?id=" + encodeURIComponent(id);
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

    // Desktop-only muted hover preview; nothing loads until a real hover.
    attachHoverPreview(thumb, v.id);

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
            // Keep the unified Feed consistent with the subscription list: drop
            // this channel's videos from the in-memory Feed without any API call.
            removeChannelFromFeed(sub.channelId || "");
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

// Fetch a channel's recent videos and report whether the FETCH failed.
//
// `videos: []` with `failed: false` means the channel simply has nothing recent
// — a real, successful answer. `failed: true` means the request (or a usable
// fallback) never produced data, so an empty list is not trustworthy. The Feed
// needs the difference to avoid reporting "no videos" as a network error and
// vice versa; the shelves only need the list, so loadChannelVideos() below wraps
// this into the original array-only contract.
async function loadChannelVideosResult(sub, forceRefresh){
    // Not a YouTube channel (legacy local subscription): nothing to fetch, and
    // that is a successful empty answer rather than a failure.
    if(!sub || !sub.channelId){
        return { videos: [], failed: false };
    }

    const cached = cachedChannelVideos(sub.channelId);
    if(cached && !forceRefresh && !cached.stale){
        return { videos: cached.videos, failed: false };
    }

    try{
        const result = await channelVideos(sub.channelId, 6);
        // A malformed payload (missing/!array `videos`) is an unusable answer,
        // never a silent success: treat it the same as a thrown error so the
        // Feed can report a partial/total failure truthfully.
        if(!result || !Array.isArray(result.videos)){
            console.warn("Malformed channelVideos response for channel:", sub.channelName);
            if(cached){
                return { videos: cached.videos, failed: false };
            }
            return { videos: [], failed: true };
        }
        const videos = result.videos;
        setCachedChannelVideos(sub.channelId, videos);
        return { videos, failed: false };
    }
    catch(e){
        console.warn("Failed to load videos for channel:", sub.channelName, e);
        if(cached){
            // Stale cache is a usable answer, so this is not a failure.
            return { videos: cached.videos, failed: false };
        }
        return { videos: [], failed: true };
    }
}

// The original contract, preserved for the Channels/shelves view and any other
// caller: a plain array, empty on either "nothing recent" or a failed fetch.
async function loadChannelVideos(sub, forceRefresh){
    const result = await loadChannelVideosResult(sub, forceRefresh);
    return result.videos;
}



// ================= UNIFIED FEED =================
// A newest-first merge of every subscribed channel's recent uploads, built on
// the SAME fetch path as the shelves (loadChannelVideos -> 10-minute cache).
// The shelves remain the source of truth for per-channel browsing; the feed is
// a read-only projection over the same cached data.

const FEED_CHANNEL_CAP = 12;    // identical to the shelves' cap (quota envelope)
const FEED_INITIAL_COUNT = 24;  // cards revealed by the first load
const FEED_MORE_COUNT = 24;     // cards revealed per "Load more"

// Curated limits so the two views agree; banners etc. are out of scope.
const feedWrapEl = document.getElementById("feedView");
const feedGridEl = document.getElementById("subscriptionsFeed");
const feedMoreEl = document.getElementById("feedMoreBtn");
const feedStatusEl = document.getElementById("feedStatus");
const shelvesWrapEl = document.getElementById("shelvesView");
const feedTabEl = document.getElementById("subsViewFeed");
const channelsTabEl = document.getElementById("subsViewChannels");


// ================= AGE / SORT HELPERS =================

// The single source of truth for "when was this video published?".
// Prefers the raw RFC 3339 publishedAt; falls back to the lossy human label
// ("3d ago") so cached videos written before this field existed still sort.
// Returns a finite epoch ms, or Infinity when nothing is usable, so callers
// that sort ascending-on-Infinity push unknown-age videos to the end.
function publishedAtMs(v){
    const raw = v && v.publishedAt;
    if(raw){
        const ms = Date.parse(raw);
        if(Number.isFinite(ms)){
            return ms;
        }
    }
    return parseAgoDate(v && v.date);
}

function parseAgoDate(label){
    const m = /^(\d+)\s*(s|m|h|d|mo|y)\s*ago$/.exec(String(label || "").trim());
    if(!m){
        return Infinity;
    }
    const n = Number(m[1]);
    if(!Number.isFinite(n)){
        return Infinity;
    }
    const unitMs = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    }[m[2]];
    return Date.now() - n * unitMs;
}

// Deduplicate by stable identity, then order newest-first.
//
// A video can legitimately appear in more than one channel's uploads (a collab
// or a repost), so the feed collapses duplicates by sourceId || id. The first
// occurrence wins, but a later occurrence carrying a usable timestamp replaces
// an undated one, so a card never loses its sort position.
//
// Sorting is stable: equal (or unknown) ages keep their original order. Unknown
// ages (Infinity) sort last and are never dropped.
function mergeFeed(lists){
    const seen = new Map();

    for(const list of lists || []){
        for(const v of list || []){
            if(!v){
                continue;
            }
            const key = v.sourceId || v.id;
            if(!key){
                continue;
            }
            const existing = seen.get(key);
            if(!existing){
                seen.set(key, v);
                continue;
            }
            if(publishedAtMs(existing) === Infinity && publishedAtMs(v) !== Infinity){
                seen.set(key, v);
            }
        }
    }

    return Array.from(seen.values())
        .map((v, index) => ({ v, index, age: publishedAtMs(v) }))
        .sort((a, b) => {
            // Newest first. Unknown ages (Infinity) must still land last, so an
            // infinity check runs before the plain descending comparison —
            // a naive `b.age - a.age` would sort Infinity to the front.
            const aUnknown = a.age === Infinity;
            const bUnknown = b.age === Infinity;

            if(aUnknown !== bUnknown){
                return aUnknown ? 1 : -1;
            }
            if(a.age !== b.age){
                return b.age - a.age;
            }
            return a.index - b.index;
        })
        .map(entry => entry.v);
}


// ================= FEED STATE =================
// `pool` is the whole deduped/ordered result so far; `shown` is how many of it
// is currently in the DOM. `pending` is the forward-only guard that drops a
// stale response's late arrival, and `token` invalidates a superseded load.

const feed = {
    subs: [],
    pool: [],
    shown: 0,
    exhaused: false,
    pending: false,
    token: 0
};

// pageToken -> per channel, so "Load more" continues each channel's uploads
// playlist exactly where the previous page stopped. A channel with no cursor is
// simply skipped: there is genuinely nothing else to request for it.
const feedCursors = new Map();

// Channels whose uploads playlist has been paged at least once, so an empty
// cursor afterwards is read as "exhausted" rather than "not started".
const feedPagedChannels = new Set();

let currentUid = "";

function setFeedStatus(msg){
    if(feedStatusEl){
        feedStatusEl.textContent = msg || "";
    }
}


// ================= "NEW SINCE LAST VISIT" =================
// Per-uid, localStorage-only. The marker stores the epoch ms at which the user
// last LEFT the page. A video is "New" only when it was published after that
// instant, so the badge always means "arrived since your previous visit" and can
// never re-mark an old video. A first visit has no marker and therefore shows no
// badges; the marker is created when the user leaves.

const FEED_SEEN_KEY = "mytube_feed_last_seen_v1";
let feedSeenStore = null;

function loadFeedSeenStore(){
    feedSeenStore = {};
    try{
        const parsed = JSON.parse(localStorage.getItem(FEED_SEEN_KEY) || "{}");
        if(parsed && typeof parsed === "object" && !Array.isArray(parsed)){
            feedSeenStore = parsed;
        }
    }
    catch(e){ /* unreadable store: treat every visit as a first visit */ }
}

function feedSeenFor(uid){
    if(feedSeenStore === null){
        loadFeedSeenStore();
    }
    return Number(feedSeenStore[uid]) || 0;
}

function advanceFeedSeen(uid, whenMs){
    if(!uid){
        return;
    }
    if(feedSeenStore === null){
        loadFeedSeenStore();
    }
    feedSeenStore[uid] = whenMs;
    try{
        localStorage.setItem(FEED_SEEN_KEY, JSON.stringify(feedSeenStore));
    }
    catch(e){ /* quota exceeded — marker is best-effort */ }
}


// ================= FEED RENDERING =================

function buildFeedCard(v){
    const card = buildVideoCard(v);
    card.classList.add("feed-card");

    const age = publishedAtMs(v);
    const seen = feedSeenFor(currentUid);
    // seen === 0 means a first visit: no marker, so nothing is badged.
    if(seen > 0 && age !== Infinity && age > seen){
        const badge = document.createElement("span");
        badge.className = "feed-new";
        badge.textContent = "New";
        const thumb = card.querySelector(".thumb");
        if(thumb){
            thumb.appendChild(badge);
        }
    }

    return card;
}

// Reveal up to `count` more cards from the pool, in order. Returns how many were
// appended, so callers can tell "there was more" from "the pool is exhausted".
function revealFeed(count){
    if(!feedGridEl){
        return 0;
    }
    const target = Math.min(feed.shown + count, feed.pool.length);
    while(feed.shown < target){
        feedGridEl.appendChild(buildFeedCard(feed.pool[feed.shown]));
        feed.shown++;
    }
    return feed.shown;
}

function updateFeedMoreButton(){
    if(!feedMoreEl){
        return;
    }
    const hasMore = !feed.exhaused && feed.shown < feed.pool.length;
    if(!hasMore){
        // The upstream playlists are the boundary here, not the UI. Say so
        // plainly instead of offering a button that would do nothing.
        feedMoreEl.style.display = "none";
        return;
    }
    feedMoreEl.style.display = "";
    feedMoreEl.disabled = false;
    feedMoreEl.textContent = "Load more";
}

function resetFeedView(subs, forceRefresh){
    feed.subs = subs.slice(0, FEED_CHANNEL_CAP);
    feed.pool = [];
    feed.shown = 0;
    feed.exhaused = false;
    feed.pending = false;
    feedCursors.clear();
    feedPagedChannels.clear();
    if(feedGridEl){
        feedGridEl.replaceChildren();
    }
    setFeedStatus("");
    showState("content");
}

// Drop a channel from the Feed after a successful unsubscribe, without touching
// the network. Everything else in the Feed is preserved: the remaining videos,
// their order, the revealed count, the per-channel cursors, and the Load-more
// state. Only this channel's subscription, videos, and cursors are removed.
//
// When nothing is left the feed shows its empty message rather than a blank
// grid, but it does NOT change the page state — the shelves path owns the
// page-level empty state, and switching views must not fight over it.
function removeChannelFromFeed(channelId){
    if(!channelId){
        return;
    }

    feed.subs = feed.subs.filter(s => s.channelId !== channelId);
    feedCursors.delete(channelId);
    feedPagedChannels.delete(channelId);

    const before = feed.pool.length;
    // Preserve feed order: filter in place rather than re-sorting, so pagination
    // and "what the user has already seen" stay exactly consistent.
    feed.pool = feed.pool.filter(v => v && v.channelId !== channelId);
    const removed = before - feed.pool.length;

    if(removed > 0){
        // Re-render the visible cards in place so the removed channel disappears
        // immediately and every remaining card keeps its position.
        if(feedGridEl){
            feedGridEl.replaceChildren();
        }
        const alreadyShown = Math.min(feed.shown, feed.pool.length);
        feed.shown = 0;
        if(alreadyShown > 0){
            revealFeed(alreadyShown);
        }
    }

    if(feed.pool.length === 0){
        setFeedStatus("You're not subscribed to any channels yet.");
    }

    updateFeedMoreButton();
}

async function loadFeed(uid, forceRefresh){
    currentUid = uid || "";
    const loadId = ++feed.token;

    let subs = [];
    try{
        subs = await getSubscriptions(uid);
    }
    catch(e){
        console.warn("Failed to load subscriptions:", e);
        showError("Could not load your subscriptions. Please try again.");
        return;
    }

    const withChannel = (subs || []).filter(s => s.channelId);
    if(withChannel.length === 0){
        showState("empty");
        return;
    }

    resetFeedView(withChannel, forceRefresh);

    // Fetch every channel in parallel. The per-channel cache makes repeat loads
    // cheap; a channel that errors is reported as failed rather than aborting the
    // whole feed, and a channel that succeeds with no videos is NOT a failure.
    const results = await Promise.all(
        feed.subs.map(async (sub) => ({ sub, ...(await loadChannelVideosResult(sub, forceRefresh)) }))
    );

    if(loadId !== feed.token){
        return;   // a newer load superseded this one
    }

    let failures = 0;
    const lists = [];
    for(const { sub, videos, failed } of results){
        const list = Array.isArray(videos) ? videos : [];
        lists.push(list);
        if(failed){
            failures++;
        }
        // No cursor yet: the shelf fetch did not expose a page token, so the
        // first "Load more" will request page 2 for every channel explicitly.
        feedCursors.set(sub.channelId, "");
    }

    feed.pool = mergeFeed(lists);

    if(feed.pool.length === 0){
        // "Nothing recent" and "every request failed" are different outcomes and
        // must not share a message.
        setFeedStatus(failures > 0
            ? "Could not load videos from your subscriptions right now. Try Refresh."
            : "No recent videos found from your subscriptions.");
        updateFeedMoreButton();
        return;
    }

    revealFeed(FEED_INITIAL_COUNT);
    updateFeedMoreButton();

    if(failures > 0){
        setFeedStatus("Some channels could not be loaded.");
    }
    else{
        setFeedStatus("");
    }
}

// "Load more" advances every channel that can still supply another page, then
// merges and re-sorts the whole pool so a just-fetched newer video lands in its
// correct chronological slot. It only reports success after real data arrives.
//
// Cursor semantics: the first page came from loadChannelVideos(), which does not
// expose a nextPageToken — so a channel with no cursor and never-yet-paged is
// fetched from page 2 explicitly. Once paged, an empty cursor means that
// channel's uploads playlist is exhausted and it is skipped.
async function loadMoreFeed(){
    if(feed.pending || feed.exhaused || !feed.subs.length){
        return;
    }

    feed.pending = true;
    const loadId = feed.token;
    if(feedMoreEl){
        feedMoreEl.disabled = true;
        feedMoreEl.textContent = "Loading more...";
    }

    const newLists = [];
    let requestFailed = false;

    for(const sub of feed.subs){
        const token = feedCursors.get(sub.channelId) || "";
        const started = feedPagedChannels.has(sub.channelId);
        if(started && token === ""){
            continue;   // exhausted
        }
        try{
            const result = await channelVideos(sub.channelId, 12, token);
            feedPagedChannels.add(sub.channelId);
            const videos = (result && result.videos) || [];
            if(videos.length > 0){
                newLists.push(videos);
            }
            feedCursors.set(sub.channelId, (result && result.nextPageToken) || "");
        }
        catch(e){
            console.warn("Failed to load more for channel:", sub.channelName, e);
            requestFailed = true;
        }
    }

    feed.pending = false;

    if(loadId !== feed.token){
        return;   // superseded by a newer load
    }

    if(newLists.length === 0){
        // No channel produced another page. Only claim "caught up" when every
        // request actually succeeded; a network failure must not be dressed up
        // as "there is nothing more".
        feed.exhaused = true;
        setFeedStatus(requestFailed
            ? "Could not load more videos. Please try again."
            : "You're all caught up on recent videos.");
        updateFeedMoreButton();
        return;
    }

    const before = feed.pool.length;
    feed.pool = mergeFeed([feed.pool, ...newLists]);
    revealFeed(Math.max(FEED_MORE_COUNT, feed.pool.length - feed.shown));

    setFeedStatus(feed.pool.length === before
        ? "No new videos from your subscriptions right now."
        : "");

    updateFeedMoreButton();
}

// ================= FEED / CHANNELS TOGGLE =================

const FEED_VIEW_KEY = "mytube_subs_view_v1";

function readFeedView(){
    try{
        return localStorage.getItem(FEED_VIEW_KEY) === "channels" ? "channels" : "feed";
    }
    catch(e){
        return "feed";
    }
}

function setFeedView(view){
    const isFeed = view !== "channels";
    if(feedWrapEl){
        feedWrapEl.hidden = !isFeed;
    }
    if(shelvesWrapEl){
        shelvesWrapEl.hidden = isFeed;
    }
    if(feedTabEl){
        feedTabEl.classList.toggle("active", isFeed);
        feedTabEl.setAttribute("aria-selected", isFeed ? "true" : "false");
    }
    if(channelsTabEl){
        channelsTabEl.classList.toggle("active", !isFeed);
        channelsTabEl.setAttribute("aria-selected", !isFeed ? "true" : "false");
    }
    try{
        localStorage.setItem(FEED_VIEW_KEY, isFeed ? "feed" : "channels");
    }
    catch(e){ /* ignore */ }
}

function setupFeedToggle(){
    if(feedTabEl && feedTabEl.dataset.wired !== "1"){
        feedTabEl.dataset.wired = "1";
        feedTabEl.addEventListener("click", () => setFeedView("feed"));
    }
    if(channelsTabEl && channelsTabEl.dataset.wired !== "1"){
        channelsTabEl.dataset.wired = "1";
        channelsTabEl.addEventListener("click", () => setFeedView("channels"));
    }
    setFeedView(readFeedView());
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

    // Legacy local subscriptions (no channelId) were skipped at the data
    // layer; if none remain, show the empty state.
    const withChannel = subs.filter(s => s.channelId);
    if(withChannel.length === 0){
        showState("empty");
        return;
    }

    showState("content");
    if(sectionsEl){
        sectionsEl.replaceChildren();
    }

    // Load videos for each channel sequentially to avoid request storms.
    // Limit to 12 channels max.
    const limited = withChannel.slice(0, 12);
    for(const sub of limited){
        const channelVids = await loadChannelVideos(sub, forceRefresh);
        if(sectionsEl){
            sectionsEl.appendChild(buildChannelSection(sub, channelVids));
        }
    }
}


// Reload whichever view is currently visible. Refresh in the Feed view clears
// the same per-channel cache the shelves use, so both views see fresh data.
async function refreshActiveView(uid){
    if(readFeedView() === "channels"){
        await loadSubscriptions(uid, true);
        return;
    }
    await loadFeed(uid, true);
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
        Promise.resolve(refreshActiveView(user.uid)).finally(() => {
            btn.disabled = false;
            btn.textContent = "Refresh";
        });
    });
}

function setupFeedMoreButton(){
    if(!feedMoreEl || feedMoreEl.dataset.wired === "1"){
        return;
    }
    feedMoreEl.dataset.wired = "1";
    feedMoreEl.addEventListener("click", () => {
        if(feed.pending){
            return;
        }
        Promise.resolve(loadMoreFeed()).catch(e => {
            console.warn("Load more failed:", e);
        });
    });
}

// Switching to Feed for the first time (or after an unsubscribe) may need a
// load; switching to Channels is served by the unconditional shelf load below.
function setupFeedViewSwitch(){
    if(!feedTabEl || feedTabEl.dataset.loadWired === "1"){
        return;
    }
    feedTabEl.dataset.loadWired = "1";
    feedTabEl.addEventListener("click", () => {
        const user = auth && auth.currentUser;
        if(user && feed.pool.length === 0 && !feed.pending){
            refreshActiveView(user.uid);
        }
    });
}

// The marker advances to "now" only when the user leaves the page, so videos
// viewed during this visit are not re-badged on the next one.
function setupFeedSeenMarker(){
    if(window.__mytubeFeedSeenWired){
        return;
    }
    window.__mytubeFeedSeenWired = true;
    const remember = () => {
        const user = auth && auth.currentUser;
        if(user){
            advanceFeedSeen(user.uid, Date.now());
        }
    };
    window.addEventListener("pagehide", remember);
    document.addEventListener("visibilitychange", () => {
        if(document.visibilityState === "hidden"){
            remember();
        }
    });
}


// ================= AUTH STATE =================

setupYoutubeAccountSubscriptionsUi();

// Grant changes (connect/disconnect/reconnect) invalidate identity immediately
// and re-read the account list. The cross-tab signal carries no tokens or
// channel identity.
onYoutubeGrantChange(() => {
    ytIdentity.clear("idle");
    initYoutubeAccountSubscriptions(auth && auth.currentUser ? auth.currentUser : null);
});

onAuthStateChanged(auth, (user) => {
    if(user){
        setupYoutubeAccountSubscriptionsUi();
        setupRefreshButton();
        setupFeedMoreButton();
        setupFeedToggle();
        setupFeedViewSwitch();
        setupFeedSeenMarker();
        // Actual connected YouTube account subscriptions (read-only). First page
        // only on page open/auth load; separate from local MyTube subscriptions.
        initYoutubeAccountSubscriptions(user);
        // Load both views' data through the one shared fetch path. The shelves
        // render into their (hidden) container so switching is instant; the feed
        // renders when it is the active view.
        if(readFeedView() === "channels"){
            loadSubscriptions(user.uid);
        }
        else{
            loadFeed(user.uid);
        }
    }
    else{
        initYoutubeAccountSubscriptions(null);
        showState("loggedOut");
    }
});
