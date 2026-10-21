// =============================================================================
// MyTube — top-right account menu + cached notifications + local avatar
// -----------------------------------------------------------------------------
// A single self-contained, additive module shared by every page that already
// renders a <header>. It NEVER rewrites the existing header markup and never
// touches #loginBtn / #logoutBtn, so auth.js keeps working unchanged.
//
// Design contract (do not break):
//   * No new backend endpoint, no Firestore read beyond the subscriptions the
//     page already loads, and NO YouTube API/network fetch of its own.
//   * Notifications are a pure read-only projection over the SAME per-channel
//     video cache the Subscriptions page writes (mytube_subs_videos_cache_v1).
//     A cold cache shows a clear "unavailable" state instead of a fetch storm.
//   * Only non-sensitive data is persisted: a per-UID "seen" timestamp in
//     localStorage, and a per-UID avatar as a data URL in IndexedDB. Image
//     bytes NEVER go into localStorage, and no passwords, tokens, cookies or
//     credentials are ever written anywhere.
//   * Everything is scoped to the currently authenticated UID.
//
// This module lives in public/shared/ so it can be imported as an ES module
// from any page; the pure helpers are deliberately dependency-free so the tests
// can evaluate the REAL shipped bodies in a sandbox (mirroring
// tests/testHoverPreview.js).
// =============================================================================

import { auth } from "../firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getSubscriptions } from "../data.js";

// -----------------------------------------------------------------------------
// Constants — shared with subscriptions.js so the cache contract cannot drift.
// -----------------------------------------------------------------------------

// Same key subscriptions.js writes. Read-only here: this module NEVER writes it.
const SUBS_CACHE_KEY = "mytube_subs_videos_cache_v1";

// Per-UID "notifications seen" marker. New key, localStorage only, non-sensitive.
const NOTIF_SEEN_KEY = "mytube_notifications_seen_v1";

// How many notifications the panel will ever show at once.
const NOTIF_MAX = 20;

// The subscription channel cap used by the feed, kept identical here so the two
// views agree on which channels count.
const NOTIF_CHANNEL_CAP = 12;

// -----------------------------------------------------------------------------
// Avatar constants (local-only profile picture / logo)
// -----------------------------------------------------------------------------

// IndexedDB database + store that holds ONE small avatar record per uid. The
// records are keyed by uid and hold a resized `data:image/...;base64,...` URL.
// Image bytes deliberately live here, NOT in localStorage.
const AVATAR_DB_NAME = "mytube_avatars_v1";
const AVATAR_DB_VERSION = 1;
const AVATAR_STORE = "avatars";

// Longest edge of the stored avatar. Anything larger is downscaled in-canvas.
const AVATAR_MAX_DIM = 256;

// Hard ceiling on the picked file BEFORE decoding (10 MiB) and on the encoded
// data URL we are willing to persist (340 KiB ≈ a 256px WebP/PNG thumbnail).
const AVATAR_MAX_FILE_BYTES = 10 * 1024 * 1024;
const AVATAR_MAX_STORED_BYTES = 340 * 1024;

// Formats we accept. `image/*` is advertised to the picker, but a picked file is
// re-validated against this list because `accept` is only a hint.
const AVATAR_MIME_ALLOW = Object.freeze([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp"
]);

// Human-friendly validation messages, returned (not thrown) so the UI can show
// them inline and the tests can assert on exact behaviour.
const AVATAR_MSG = Object.freeze({
    unsupported: "That file type isn\u2019t supported. Choose a JPEG, PNG or WebP image.",
    corrupt: "That image couldn\u2019t be read. It may be corrupt \u2014 try another file.",
    tooLarge: "That image is too large. Please choose one under 10 MB.",
    empty: "That file is empty. Please choose a different image.",
    noUid: "Sign in to set a profile picture.",
    encode: "That image couldn\u2019t be processed. Please try a different one.",
    store: "Couldn\u2019t save your picture on this device. It will work this time only."
});

// -----------------------------------------------------------------------------
// Pure helpers (sandboxable, no DOM/window access)
// -----------------------------------------------------------------------------

// Uppercase initials from a display name, falling back to the email local part.
// Always returns at least one character; never returns an email address.
function initialsFrom(name, email){
    const source = String(name || "").trim() || String(email || "").split("@")[0] || "";
    const cleaned = source.replace(/[^A-Za-z0-9]+/g, " ").trim();
    if(!cleaned){
        return "?";
    }
    return cleaned
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(word => word.charAt(0).toUpperCase())
        .join("") || "?";
}

// A safe, human display name from a Firebase user-like object. Never invents an
// email when one is absent, and never returns undefined.
function displayNameFrom(user){
    if(!user){
        return "";
    }
    if(user.displayName){
        return String(user.displayName);
    }
    if(user.email){
        const local = String(user.email).split("@")[0];
        return local || "User";
    }
    return "User";
}

// Epoch ms for a video's publication instant, preferring the raw RFC 3339
// `publishedAt` and falling back to the lossy "3d ago" label. Mirrors
// publishedAtMs() in subscriptions.js; duplicated here so the module stays
// standalone (the tests assert the two stay in sync).
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

// Read the SAME per-channel cache subscriptions.js maintains. Returns a plain
// object keyed by channelId, or {} when nothing usable exists. Pure: no writes,
// no network, never throws.
function readVideosCache(store){
    const raw = store && typeof store.getItem === "function"
        ? store.getItem(SUBS_CACHE_KEY)
        : null;
    if(!raw){
        return {};
    }
    try{
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    }
    catch(e){
        return {};
    }
}

// Build the unread notification list purely from CACHED data.
//
// `subs`   — subscriptions from data.js (already scoped to the uid)
// `cache`  — the parsed per-channel video cache
// `seenMs` — the per-uid seen marker (0 = never seen => show nothing as "new")
//
// Returns { items, unavailable, total, unread }.
//   * unavailable: true only when the user HAS channels but NO usable cached
//     data exists at all. That is the honest "we have nothing to show without
//     fetching" state — it is never reported as "no new videos".
//   * items: newest-first, at most NOTIF_MAX, each carrying unread:boolean.
//   * unread: count of items published strictly after seenMs.
function computeNotifications(subs, cache, seenMs){
    const channels = (Array.isArray(subs) ? subs : [])
        .filter(s => s && s.channelId)
        .slice(0, NOTIF_CHANNEL_CAP);

    if(channels.length === 0){
        return { items: [], unavailable: false, total: 0, unread: 0 };
    }

    const seen = Number(seenMs) || 0;
    const seenKeys = new Set();
    const all = [];

    let cachedChannels = 0;
    for(const sub of channels){
        const entry = cache ? cache[sub.channelId] : null;
        const videos = entry && Array.isArray(entry.videos) ? entry.videos : null;
        if(videos){
            cachedChannels++;
        }
        for(const v of videos || []){
            if(!v){
                continue;
            }
            const key = v.sourceId || v.id;
            if(!key || seenKeys.has(key)){
                continue;
            }
            seenKeys.add(key);
            const age = publishedAtMs(v);
            all.push({
                key,
                title: v.title || "",
                thumb: v.thumb || "",
                channel: v.channel || sub.channelName || "",
                channelId: sub.channelId || "",
                date: v.date || "",
                age,
                unread: seen > 0 && age !== Infinity && age > seen
            });
        }
    }

    // Nothing cached at all, but the user does have channels: not "no news",
    // simply "cannot know without fetching", which we refuse to do.
    if(cachedChannels === 0){
        return { items: [], unavailable: true, total: 0, unread: 0 };
    }

    // Newest first; unknown ages last. Stable for equal ages.
    all.sort((a, b) => {
        const aUnknown = a.age === Infinity;
        const bUnknown = b.age === Infinity;
        if(aUnknown !== bUnknown){
            return aUnknown ? 1 : -1;
        }
        if(a.age !== b.age){
            return b.age - a.age;
        }
        return 0;
    });

    const items = all.slice(0, NOTIF_MAX);
    const unread = items.filter(i => i.unread).length;
    return { items, unavailable: false, total: all.length, unread };
}

// -----------------------------------------------------------------------------
// Seen-marker storage (per uid, non-sensitive, localStorage only)
// -----------------------------------------------------------------------------

function readSeenStore(store){
    if(!store || typeof store.getItem !== "function"){
        return {};
    }
    const raw = store.getItem(NOTIF_SEEN_KEY);
    if(!raw){
        return {};
    }
    try{
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    }
    catch(e){
        return {};
    }
}

function notificationsSeenFor(store, uid){
    if(!uid){
        return 0;
    }
    return Number(readSeenStore(store)[uid]) || 0;
}

function advanceNotificationsSeen(store, uid, whenMs){
    if(!uid || !store || typeof store.setItem !== "function"){
        return false;
    }
    const all = readSeenStore(store);
    all[uid] = Number(whenMs) || Date.now();
    try{
        store.setItem(NOTIF_SEEN_KEY, JSON.stringify(all));
        return true;
    }
    catch(e){
        return false;
    }
}

// -----------------------------------------------------------------------------
// Avatar helpers — validation + geometry (pure, sandboxable)
// -----------------------------------------------------------------------------

// Validate a picked file-like object BEFORE any decoding happens.
//
// Accepts anything with `type` and `size` (a real File, or a plain object in the
// tests). Returns { ok:true } or { ok:false, reason, message }. Never throws, and
// never inspects file contents here — decoding is a separate, guarded step.
function validateAvatarFile(file){
    if(!file || typeof file !== "object"){
        return { ok: false, reason: "unsupported", message: AVATAR_MSG.unsupported };
    }
    const type = String(file.type || "").toLowerCase();
    const size = Number(file.size);

    if(!Number.isFinite(size) || size <= 0){
        return { ok: false, reason: "empty", message: AVATAR_MSG.empty };
    }
    if(size > AVATAR_MAX_FILE_BYTES){
        return { ok: false, reason: "tooLarge", message: AVATAR_MSG.tooLarge };
    }
    // `accept="image/*"` is advisory only, so the MIME type is re-checked. We
    // also accept any image/* whose subtype we recognise, which covers JPEG,
    // PNG, WebP, GIF and BMP.
    if(AVATAR_MIME_ALLOW.indexOf(type) === -1){
        return { ok: false, reason: "unsupported", message: AVATAR_MSG.unsupported };
    }
    return { ok: true };
}

// Work out the downscaled drawing box for an image so that the LONGEST edge is
// at most `max`, preserving the aspect ratio. Never upscales a smaller image.
// Returns { width, height } in whole pixels (>=1), or null for bad input.
function fitAvatarDimensions(width, height, max){
    const w = Number(width);
    const h = Number(height);
    const limit = Number(max) || AVATAR_MAX_DIM;
    if(!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0){
        return null;
    }
    const scale = Math.min(1, limit / Math.max(w, h));
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale))
    };
}

// Reject an encoded avatar that somehow ballooned past the storage ceiling, so a
// pathological image can never bloat the IndexedDB record.
function isAvatarWithinBudget(dataUrl){
    return typeof dataUrl === "string"
        && dataUrl.length > 0
        && dataUrl.length <= AVATAR_MAX_STORED_BYTES;
}

// A data URL is the ONLY thing we ever hand to the avatar element. This guard
// keeps any stray value (or a malicious `javascript:`/`http:` string) from ever
// reaching an <img src>, which is what makes stored avatars safe to render.
function isSafeAvatarDataUrl(value){
    return typeof value === "string"
        && /^data:image\/(png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

// -----------------------------------------------------------------------------
// Avatar storage — IndexedDB, per uid, error-tolerant
// -----------------------------------------------------------------------------
// The IDB mechanics are isolated behind two tiny async functions that take the
// factory explicitly (`idbFactory`), so they can be driven with a fake in tests
// and so a missing/blocked IndexedDB degrades to a no-op rather than a throw.
// Nothing here is ever called from localStorage.

// Open (and, on first use, create) the avatar database. Resolves with the db, or
// null when IndexedDB is unavailable/blocked/errored. Never rejects.
function openAvatarDb(idbFactory){
    return new Promise(resolve => {
        if(!idbFactory || typeof idbFactory.open !== "function"){
            resolve(null);
            return;
        }
        let request;
        try{
            request = idbFactory.open(AVATAR_DB_NAME, AVATAR_DB_VERSION);
        }
        catch(e){
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if(db && !db.objectStoreNames.contains(AVATAR_STORE)){
                db.createObjectStore(AVATAR_STORE, { keyPath: "uid" });
            }
        };
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

// Run one request against the avatar store. Resolves with the request result, or
// null on ANY failure (no db, blocked, quota, abort). Never rejects, never
// throws synchronously.
function avatarTx(db, mode, run){
    return new Promise(resolve => {
        if(!db || typeof db.transaction !== "function"){
            resolve(null);
            return;
        }
        let tx;
        try{
            tx = db.transaction(AVATAR_STORE, mode);
        }
        catch(e){
            resolve(null);
            return;
        }
        let request;
        try{
            const store = tx.objectStore(AVATAR_STORE);
            request = run(store);
        }
        catch(e){
            resolve(null);
            return;
        }
        // A completed transaction is the success signal for writes/deletes; the
        // request result is only meaningful for reads. `failed` flips on any
        // error so an aborted quota-exceeded write can never look successful.
        let failed = false;
        const settle = () => resolve(failed ? null : (request && request.result !== undefined ? request.result : null));
        tx.oncomplete = settle;
        tx.onabort = () => { failed = true; resolve(null); };
        tx.onerror = () => { failed = true; resolve(null); };
        if(request){
            request.onsuccess = () => { /* wait for tx.oncomplete */ };
            request.onerror = () => { failed = true; resolve(null); };
        }
    });
}

// Read the stored data URL for a uid. Resolves with a safe data URL, or "" when
// there is none / the uid is missing / anything failed. Never rejects.
async function readAvatar(idbFactory, uid){
    if(!uid){
        return "";
    }
    const db = await openAvatarDb(idbFactory);
    if(!db){
        return "";
    }
    const record = await avatarTx(db, "readonly", store => store.get(uid));
    const value = record && typeof record === "object" ? record.dataUrl : null;
    return isSafeAvatarDataUrl(value) ? value : "";
}

// Persist (or, with a falsy dataUrl, delete) the avatar for a uid. Resolves with
// true only when the write definitely committed. Never rejects.
async function writeAvatar(idbFactory, uid, dataUrl){
    if(!uid){
        return false;
    }
    const db = await openAvatarDb(idbFactory);
    if(!db){
        return false;
    }
    if(!dataUrl){
        await avatarTx(db, "readwrite", store => store.delete(uid));
        return true;
    }
    if(!isSafeAvatarDataUrl(dataUrl) || !isAvatarWithinBudget(dataUrl)){
        return false;
    }
    const result = await avatarTx(db, "readwrite", store =>
        store.put({ uid, dataUrl, at: Date.now() })
    );
    return !!result;
}

// -----------------------------------------------------------------------------
// Browser-only rendering (not exercised by the Node tests)
// -----------------------------------------------------------------------------

function el(tag, className, text){
    const node = document.createElement(tag);
    if(className){
        node.className = className;
    }
    if(text !== undefined && text !== null){
        node.textContent = text;
    }
    return node;
}

const state = {
    cells: null,
    bellPanel: null,
    accountPanel: null,
    currentUid: "",
    lastFocus: null,
    wired: false,
    built: false,
    avatarUrl: "",
    avatarBusy: false,
    avatarMessage: "",
    avatarMessageError: false
};

// -----------------------------------------------------------------------------
// Avatar pipeline (browser only — needs createImageBitmap/canvas)
// -----------------------------------------------------------------------------

// Turn a validated File into a small, safe data URL:
//   1. decode via createImageBitmap (falls back to an <img> + object URL);
//   2. downscale to AVATAR_MAX_DIM on the long edge, preserving aspect ratio;
//   3. re-encode as image/webp (or image/png when webp is unsupported).
// Any failure resolves with { ok:false, reason:"corrupt"/"encode", message } —
// it never rejects and never throws. Selected files are only ever DECODED as
// images; they are never evaluated or executed as code.
function processAvatarFile(file){
    const check = validateAvatarFile(file);
    if(!check.ok){
        return Promise.resolve(check);
    }
    return decodeAvatar(file).then(bitmap => {
        if(!bitmap){
            return { ok: false, reason: "corrupt", message: AVATAR_MSG.corrupt };
        }
        let dataUrl = "";
        try{
            dataUrl = drawAvatarToDataUrl(bitmap);
        }
        catch(e){
            dataUrl = "";
        }
        if(bitmap.close && typeof bitmap.close === "function"){
            try{ bitmap.close(); }catch(e){ /* ignore */ }
        }
        if(!dataUrl){
            return { ok: false, reason: "encode", message: AVATAR_MSG.encode };
        }
        if(!isAvatarWithinBudget(dataUrl)){
            return { ok: false, reason: "tooLarge", message: AVATAR_MSG.tooLarge };
        }
        return { ok: true, dataUrl };
    }).catch(() => ({ ok: false, reason: "corrupt", message: AVATAR_MSG.corrupt }));
}

function decodeAvatar(file){
    if(typeof createImageBitmap === "function"){
        return createImageBitmap(file).catch(() => null);
    }
    if(typeof Image !== "function" || typeof URL === "undefined" || !URL.createObjectURL){
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

function drawAvatarToDataUrl(bitmap){
    const sw = bitmap.width;
    const sh = bitmap.height;
    const box = fitAvatarDimensions(sw, sh, AVATAR_MAX_DIM);
    if(!box){
        return "";
    }
    const canvas = document.createElement("canvas");
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext("2d");
    if(!ctx){
        return "";
    }
    ctx.drawImage(bitmap, 0, 0, sw, sh, 0, 0, box.width, box.height);
    // Prefer WebP for size; fall back to PNG. Both are on the accepted list.
    const webp = canvas.toDataURL("image/webp", 0.85);
    if(isSafeAvatarDataUrl(webp) && webp.indexOf("image/webp") !== -1){
        return webp;
    }
    return canvas.toDataURL("image/png");
}

function closePanels(restoreFocus){
    if(state.bellPanel){
        state.bellPanel.hidden = true;
    }
    if(state.accountPanel){
        state.accountPanel.hidden = true;
    }
    if(state.cells){
        if(state.cells.bellBtn){
            state.cells.bellBtn.setAttribute("aria-expanded", "false");
        }
        if(state.cells.avatarBtn){
            state.cells.avatarBtn.setAttribute("aria-expanded", "false");
        }
    }
    // When a panel was open and the close came from the keyboard (Escape) or a
    // trigger press, return focus to the control that opened it. An outside
    // click must NOT steal focus back, so callers opt in via restoreFocus.
    const target = state.lastFocus;
    state.lastFocus = null;
    if(restoreFocus && target && typeof target.focus === "function"){
        target.focus();
    }
}

function togglePanel(which){
    if(!state.cells){
        return;
    }
    const panel = which === "bell" ? state.bellPanel : state.accountPanel;
    const btn = which === "bell" ? state.cells.bellBtn : state.cells.avatarBtn;
    if(!panel || !btn){
        return;
    }
    const willOpen = panel.hidden;
    closePanels();
    if(willOpen){
        panel.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        state.lastFocus = btn;
        const first = panel.querySelector("button, a[href]");
        if(first && typeof first.focus === "function"){
            first.focus();
        }
    }
}

function wireGlobalListeners(){
    if(state.wired){
        return;
    }
    state.wired = true;

    document.addEventListener("click", (e) => {
        if(!state.cells || !state.cells.root){
            return;
        }
        if(state.cells.root.contains(e.target)){
            return;
        }
        closePanels();
    });

    document.addEventListener("keydown", (e) => {
        if(e.key === "Escape"){
            closePanels(true);
        }
    });
}

function buildCells(){
    if(state.built){
        return state.cells;
    }
    const header = document.querySelector("header");
    if(!header){
        return null;
    }

    const root = el("div", "mytube-account-area");

    // Notifications ---------------------------------------------------------
    const bellWrap = el("div", "mytube-menu");
    const bellBtn = el("button", "mytube-icon-btn");
    bellBtn.type = "button";
    bellBtn.setAttribute("aria-label", "Notifications");
    bellBtn.setAttribute("aria-haspopup", "true");
    bellBtn.setAttribute("aria-expanded", "false");
    bellBtn.appendChild(el("span", "mytube-bell-icon", "\uD83D\uDD14"));
    const bellBadge = el("span", "mytube-badge");
    bellBadge.hidden = true;
    bellBtn.appendChild(bellBadge);

    const bellPanel = el("div", "mytube-panel mytube-panel-notif");
    bellPanel.hidden = true;
    bellPanel.setAttribute("role", "dialog");
    bellPanel.setAttribute("aria-label", "Notifications");

    bellWrap.appendChild(bellBtn);
    bellWrap.appendChild(bellPanel);

    // Account ---------------------------------------------------------------
    const acctWrap = el("div", "mytube-menu");
    const avatarBtn = el("button", "mytube-avatar-btn");
    avatarBtn.type = "button";
    avatarBtn.setAttribute("aria-label", "Account menu");
    avatarBtn.setAttribute("aria-haspopup", "true");
    avatarBtn.setAttribute("aria-expanded", "false");
    const avatarInitials = el("span", "mytube-avatar-initials", "?");
    avatarBtn.appendChild(avatarInitials);
    const avatarImg = document.createElement("img");
    avatarImg.className = "mytube-avatar-img";
    avatarImg.alt = "";
    avatarImg.decoding = "async";
    avatarImg.hidden = true;
    avatarBtn.appendChild(avatarImg);

    const avatarFileInput = document.createElement("input");
    avatarFileInput.type = "file";
    avatarFileInput.accept = "image/*";
    avatarFileInput.className = "mytube-visually-hidden";
    avatarFileInput.setAttribute("tabindex", "-1");
    avatarFileInput.setAttribute("aria-hidden", "true");

    const accountPanel = el("div", "mytube-panel mytube-panel-account");
    accountPanel.hidden = true;
    accountPanel.setAttribute("role", "menu");

    acctWrap.appendChild(avatarBtn);
    acctWrap.appendChild(accountPanel);
    acctWrap.appendChild(avatarFileInput);

    root.appendChild(bellWrap);
    root.appendChild(acctWrap);
    header.appendChild(root);

    state.cells = { root, bellBtn, bellBadge, bellPanel, avatarBtn, avatarInitials, avatarImg, avatarFileInput, accountPanel };
    state.bellPanel = bellPanel;
    state.accountPanel = accountPanel;
    state.built = true;

    bellBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel("bell"); });
    avatarBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePanel("account"); });

    avatarFileInput.addEventListener("change", () => {
        const file = avatarFileInput.files && avatarFileInput.files[0];
        // Reset immediately so picking the SAME file twice still fires a change.
        avatarFileInput.value = "";
        handlePickedAvatar(file);
    });

    wireGlobalListeners();
    return state.cells;
}

function menuLink(label, href, onClick){
    const a = el("a", "mytube-menu-item", label);
    a.href = href;
    a.setAttribute("role", "menuitem");
    if(onClick){
        a.addEventListener("click", (e) => {
            e.preventDefault();
            closePanels();
            onClick();
        });
    }
    return a;
}

function menuButton(label, onClick, danger){
    const b = el("button", "mytube-menu-item" + (danger ? " mytube-menu-danger" : ""), label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
        closePanels();
        onClick();
    });
    return b;
}

// Sign out through the EXISTING auth entry point, then guarantee arrival at the
// login flow. auth.js's logoutUser() already navigates, but its internal catch
// swallows a failed signOut without redirecting, which would leave the menu
// looking inert. Awaiting it and then setting location is idempotent: if it
// already navigated this is a no-op, and if it failed we finish the job.
function leaveToLogin(){
    const target = "login.html";

    const fallback = () => {
        try{
            signOut(auth);
        }
        catch(e){
            /* ignore: signing out is best-effort here */
        }
        window.location.href = target;
    };

    if(typeof window.logoutUser === "function"){
        try{
            const result = window.logoutUser();
            if(result && typeof result.then === "function"){
                result.then(() => {
                    window.location.href = target;
                }).catch(fallback);
                return;
            }
        }
        catch(e){
            /* fall through to the direct path below */
        }
    }
    fallback();
}

// Show EITHER the picture or the initials on the avatar button. `url` must be a
// previously validated data URL; anything else silently falls back to initials,
// which is the safe default and also the signed-out state.
function renderAvatar(url, initials){
    const cells = state.cells;
    if(!cells){
        return;
    }
    const safe = isSafeAvatarDataUrl(url) ? url : "";
    state.avatarUrl = safe;
    if(cells.avatarInitials){
        cells.avatarInitials.textContent = initials || "?";
    }
    if(cells.avatarImg){
        if(safe){
            cells.avatarImg.src = safe;
            cells.avatarImg.hidden = false;
        }
        else{
            cells.avatarImg.removeAttribute("src");
            cells.avatarImg.hidden = true;
        }
    }
    if(cells.avatarBtn){
        cells.avatarBtn.classList.toggle("mytube-has-avatar", !!safe);
    }
}

// Load whatever this uid previously stored and paint it. Never throws; a miss or
// a storage failure simply leaves the initials in place.
async function applyAvatar(user){
    const name = user ? displayNameFrom(user) : "";
    const email = user && user.email ? String(user.email) : "";
    const initials = initialsFrom(name, email);
    const uid = state.currentUid;
    if(!uid){
        renderAvatar("", "?");
        return;
    }
    // Paint the initials first so there is never a blank avatar while IDB reads.
    renderAvatar("", initials);
    let url = "";
    try{
        url = await readAvatar(avatarIdbFactory(), uid);
    }
    catch(e){
        url = "";
    }
    // Guard against a race: the account may have changed while IDB was reading.
    if(state.currentUid !== uid){
        return;
    }
    renderAvatar(url, initials);
    // The stored picture is now known, so the menu's Add/Remove entry is correct.
    renderAccountMenu(auth && auth.currentUser);
}

function avatarIdbFactory(){
    try{
        return typeof indexedDB !== "undefined" ? indexedDB : null;
    }
    catch(e){
        return null;
    }
}

// A one-line status/error row inside the account panel, announced politely. The
// last message is kept in state so a menu repaint (which clears the panel) can
// restore it instead of silently dropping the user's feedback.
function avatarFeedback(message, isError){
    state.avatarMessage = message ? String(message) : "";
    state.avatarMessageError = !!isError;
    paintAvatarFeedback();
}

function paintAvatarFeedback(){
    const cells = state.cells;
    if(!cells || !cells.accountPanel){
        return;
    }
    let row = cells.accountPanel.querySelector(".mytube-avatar-feedback");
    if(!state.avatarMessage){
        if(row){
            row.remove();
        }
        return;
    }
    if(!row){
        row = el("p", "mytube-avatar-feedback");
        row.setAttribute("role", "status");
        row.setAttribute("aria-live", "polite");
        cells.accountPanel.appendChild(row);
    }
    row.textContent = state.avatarMessage;
    row.classList.toggle("mytube-avatar-feedback-error", state.avatarMessageError);
}

// Initials for the CURRENT session, used as the always-present fallback.
function currentInitials(){
    const user = auth && auth.currentUser;
    return initialsFrom(displayNameFrom(user), user && user.email ? String(user.email) : "");
}

// Decode+downscale+persist a picked file for the CURRENT uid, then repaint.
async function handlePickedAvatar(file){
    if(state.avatarBusy){
        return;
    }
    const uid = state.currentUid;
    if(!uid){
        avatarFeedback(AVATAR_MSG.noUid, true);
        return;
    }
    state.avatarBusy = true;
    try{
        const result = await processAvatarFile(file);
        if(!result.ok){
            avatarFeedback(result.message, true);
            return;
        }
        // Another account signed in while we were decoding: do not write.
        if(state.currentUid !== uid){
            return;
        }
        let saved = false;
        try{
            saved = await writeAvatar(avatarIdbFactory(), uid, result.dataUrl);
        }
        catch(e){
            saved = false;
        }
        if(state.currentUid !== uid){
            return;
        }
        // Paint regardless so the user sees the picture this session; warn when
        // it could not be persisted for next time.
        renderAvatar(result.dataUrl, currentInitials());
        avatarFeedback(saved ? "Profile picture updated." : AVATAR_MSG.store, !saved);
        // Keep the menu's Add/Remove entry in step with the new state.
        renderAccountMenu(auth && auth.currentUser);
    }
    finally{
        state.avatarBusy = false;
    }
}

// Return to the initials avatar: delete the uid's record, then repaint.
async function removeAvatar(){
    const uid = state.currentUid;
    if(!uid){
        avatarFeedback(AVATAR_MSG.noUid, true);
        return;
    }
    let removed = false;
    try{
        removed = await writeAvatar(avatarIdbFactory(), uid, "");
    }
    catch(e){
        removed = false;
    }
    if(state.currentUid !== uid){
        return;
    }
    renderAvatar("", currentInitials());
    avatarFeedback(removed ? "Profile picture removed." : AVATAR_MSG.store, !removed);
    renderAccountMenu(auth && auth.currentUser);
}

function openAvatarPicker(){
    const cells = state.cells;
    if(!cells || !cells.avatarFileInput){
        return;
    }
    if(state.cells.avatarFileInput.click){
        cells.avatarFileInput.click();
    }
}

function renderAccountMenu(user){
    const panel = state.accountPanel;
    const cells = state.cells;
    if(!panel || !cells){
        return;
    }
    panel.replaceChildren();

    if(!user){
        const head = el("div", "mytube-menu-head");
        head.appendChild(el("p", "mytube-menu-title", "Not signed in"));
        head.appendChild(el("p", "mytube-menu-sub", "Sign in to see your subscriptions and history."));
        panel.appendChild(head);

        panel.appendChild(menuLink("Log in", "login.html"));
        panel.appendChild(menuLink("Sign up", "signup.html"));
        cells.avatarInitials.textContent = "?";
        cells.avatarBtn.setAttribute("aria-label", "Account menu, not signed in");
        renderAvatar("", "?");
        return;
    }

    const name = displayNameFrom(user);
    const email = user.email ? String(user.email) : "";
    cells.avatarInitials.textContent = initialsFrom(name, email);
    cells.avatarBtn.setAttribute("aria-label", "Account menu for " + name);

    const head = el("div", "mytube-menu-head");
    head.appendChild(el("p", "mytube-menu-title", name));
    if(email){
        head.appendChild(el("p", "mytube-menu-sub", email));
    }
    panel.appendChild(head);

    panel.appendChild(menuLink("Your profile", "profile.html"));
    panel.appendChild(menuLink("Subscriptions", "subscriptions.html"));
    panel.appendChild(menuLink("Library", "library.html"));

    panel.appendChild(el("div", "mytube-menu-sep"));

    // Local profile picture -------------------------------------------------
    // A menu item (keyboard reachable like every other item) that opens the
    // native picker. Only shown when signed in, since pictures are per-uid.
    panel.appendChild(menuButton(
        state.avatarUrl ? "Change profile picture" : "Add profile picture",
        () => openAvatarPicker()
    ));
    if(state.avatarUrl){
        panel.appendChild(menuButton("Remove profile picture", () => {
            removeAvatar();
        }));
    }

    panel.appendChild(el("div", "mytube-menu-sep"));

    panel.appendChild(menuButton("Switch account", () => {
        leaveToLogin();
    }));

    panel.appendChild(menuButton("Log out", () => {
        leaveToLogin();
    }, true));

    // Restore any in-flight status/error message that a repaint would otherwise
    // have erased (e.g. after the picture is replaced or removed).
    paintAvatarFeedback();
}

function renderBellBadge(count){
    const cells = state.cells;
    if(!cells){
        return;
    }
    if(count > 0){
        cells.bellBadge.textContent = count > 99 ? "99+" : String(count);
        cells.bellBadge.hidden = false;
        cells.bellBtn.setAttribute("aria-label", "Notifications, " + count + " unread");
    }
    else{
        cells.bellBadge.hidden = true;
        cells.bellBtn.setAttribute("aria-label", "Notifications");
    }
}

function notifEmptyRow(message){
    return el("p", "mytube-notif-empty", message);
}

function renderNotifications(result){
    const panel = state.bellPanel;
    if(!panel){
        return;
    }
    panel.replaceChildren();

    const head = el("div", "mytube-panel-head");
    head.appendChild(el("p", "mytube-menu-title", "Notifications"));
    const markBtn = el("button", "mytube-mark-read", "Mark all as read");
    markBtn.type = "button";
    markBtn.addEventListener("click", () => {
        advanceNotificationsSeen(window.localStorage, state.currentUid, Date.now());
        loadNotifications();
    });
    head.appendChild(markBtn);
    panel.appendChild(head);

    if(!state.currentUid){
        panel.appendChild(notifEmptyRow("Sign in to see new videos from your subscriptions."));
        renderBellBadge(0);
        return;
    }

    if(result.unavailable){
        panel.appendChild(notifEmptyRow(
            "No recent activity available yet. Open Subscriptions to load your channels."
        ));
        renderBellBadge(0);
    }
    else if(result.items.length === 0){
        panel.appendChild(notifEmptyRow("No new videos from your subscriptions."));
        renderBellBadge(0);
    }
    else{
        const list = el("div", "mytube-notif-list");
        result.items.forEach(item => {
            const a = el("a", "mytube-notif-item");
            a.href = "/watch?id=" + encodeURIComponent(item.key);
            a.setAttribute("aria-label", "Watch " + item.title);

            const thumb = el("div", "mytube-notif-thumb");
            if(item.thumb){
                const img = document.createElement("img");
                img.src = item.thumb;
                img.alt = "";
                img.loading = "lazy";
                thumb.appendChild(img);
            }
            a.appendChild(thumb);

            const info = el("div", "mytube-notif-info");
            info.appendChild(el("p", "mytube-notif-title", item.title));
            const meta = el("p", "mytube-notif-meta", [item.channel, item.date].filter(Boolean).join(" \u2022 "));
            info.appendChild(meta);
            a.appendChild(info);

            if(item.unread){
                a.appendChild(el("span", "mytube-notif-dot"));
            }
            a.addEventListener("click", () => closePanels());
            list.appendChild(a);
        });
        panel.appendChild(list);
        renderBellBadge(result.unread);
    }

    panel.appendChild(menuLink("See all on Subscriptions", "subscriptions.html"));
}

async function loadNotifications(){
    const uid = state.currentUid;
    if(!uid){
        renderNotifications({ items: [], unavailable: false, total: 0, unread: 0 });
        return;
    }

    let subs = [];
    try{
        subs = await getSubscriptions(uid);
    }
    catch(e){
        subs = [];
    }

    const cache = readVideosCache(window.localStorage);
    const seen = notificationsSeenFor(window.localStorage, uid);
    renderNotifications(computeNotifications(subs, cache, seen));
}

function applyUser(user){
    state.currentUid = user ? (user.uid || "") : "";
    // A new (or absent) account starts with a clean slate: no feedback from the
    // previous account and, crucially, no leftover picture.
    state.avatarMessage = "";
    state.avatarMessageError = false;
    buildCells();
    // Clear any avatar immediately on account change so one account's picture can
    // never linger into another's session.
    renderAvatar("", user ? initialsFrom(displayNameFrom(user), user.email || "") : "?");
    renderAccountMenu(user);
    loadNotifications();
    // applyAvatar() repaints the menu itself once the stored picture is known.
    applyAvatar(user);
}

function init(){
    if(!document.querySelector("header")){
        return;
    }
    buildCells();
    // Reflect the current session immediately when the SDK already resolved it.
    applyUser(auth && auth.currentUser);
    if(!state.built){
        return;
    }
    onAuthStateChanged(auth, applyUser);
}

// Exported for the tests (pure helpers only); the side effects stay in init().
export {
    initialsFrom,
    displayNameFrom,
    publishedAtMs,
    parseAgoDate,
    readVideosCache,
    computeNotifications,
    notificationsSeenFor,
    advanceNotificationsSeen,
    validateAvatarFile,
    fitAvatarDimensions,
    isAvatarWithinBudget,
    isSafeAvatarDataUrl,
    openAvatarDb,
    avatarTx,
    readAvatar,
    writeAvatar,
    NOTIF_SEEN_KEY,
    SUBS_CACHE_KEY,
    AVATAR_DB_NAME,
    AVATAR_STORE,
    AVATAR_MAX_DIM,
    AVATAR_MAX_FILE_BYTES,
    AVATAR_MAX_STORED_BYTES,
    AVATAR_MIME_ALLOW,
    AVATAR_MSG
};

// Auto-start in a browser only; the Node sandbox never calls this.
if(typeof document !== "undefined" && document.querySelector){
    if(document.readyState === "loading"){
        document.addEventListener("DOMContentLoaded", init);
    }
    else{
        init();
    }
}
