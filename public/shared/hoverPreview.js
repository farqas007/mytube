// =============================================================================
// MyTube — desktop thumbnail hover preview (muted, IFrame Player API)
// -----------------------------------------------------------------------------
// A small, dependency-free helper that shows a SHORT MUTED inline preview of a
// YouTube video when a desktop pointer rests on a card's thumbnail.
//
// This is deliberately NOT a copy of YouTube's own three-second preview. That
// feature is generated and served by YouTube inside YouTube's own surfaces and
// is not exposed through the Data API or the IFrame Player API. What this does
// is legally embed the public player, muted, for a few seconds. It may still
// count toward playback traffic / data usage / YouTube view accounting.
//
// Rules this module keeps:
//   * Desktop pointers only  — `(pointer: fine)` and a real mouse event.
//   * Motion-sensitive users — `(prefers-reduced-motion: reduce)` disables it.
//   * Intent, not accident  — a ~350 ms dwell before anything network-heavy
//     happens; leaving first cancels the pending preview.
//   * Silent by construction — the player is created with `mute=1` and we also
//     call `mute()` before `playVideo()`.
//   * One at a time         — a single shared player is moved between cards; no
//     per-card iframes are created up front.
//   * Fail soft             — if the API is missing or throws, the static
//     thumbnail simply stays exactly as it was.
//   * No leaks              — timers and listeners are cleaned up on leave,
//     on card switch, and when the document is hidden.
// =============================================================================

// How long the pointer must rest on a thumbnail before a preview is requested.
const HOVER_PREVIEW_DELAY_MS = 350;

// How long a preview plays before it parks itself (muted, paused) on its own.
// Not a hard cap on usefulness — the user can still click through to watch.
const HOVER_PREVIEW_MAX_MS = 5000;

// The single shared preview player. Only ever one of these exists.
let previewPlayer = null;
let previewApiLoading = false;
let previewReady = false;

// The thumbnail element currently showing (or waiting to show) a preview, and
// the bare YouTube id it should be playing.
let activeThumb = null;
let activeSourceId = "";

// Pending/live timers. Cleared together so nothing survives a mouseleave.
let pendingStartTimer = null;
let pendingStopTimer = null;

// Set once a genuine mouse interaction is seen, so we can distinguish a real
// pointer from a synthetic/assistive event stream.
let sawPointerEvent = false;

// -----------------------------------------------------------------------------
// Capability gates
// -----------------------------------------------------------------------------

// True when previews are allowed at all: a fine pointer (mouse/trackpad), no
// reduced-motion preference, and a real hover-capable event source. Evaluated
// lazily per interaction so a user changing their OS settings is respected
// without a reload.
function hoverPreviewEnabled(){
    try{
        if(typeof window === "undefined" || typeof window.matchMedia !== "function"){
            return false;
        }
        if(window.matchMedia("(pointer: fine)").matches !== true){
            return false;
        }
        if(window.matchMedia("(prefers-reduced-motion: reduce)").matches === true){
            return false;
        }
    }
    catch(e){
        return false;
    }
    return true;
}

// The card ids are namespaced (`yt:<videoId>`); the IFrame API only accepts the
// bare id. Anything that is not a plain `yt:` id is not previewable.
function hoverPreviewSourceId(videoId){
    const str = String(videoId || "");
    return str.startsWith("yt:") ? str.slice(3) : "";
}

// -----------------------------------------------------------------------------
// Shared player
// -----------------------------------------------------------------------------

// Load the IFrame Player API exactly once and resolve when `YT.Player` exists.
// Rejects (never throws) when the script cannot load, so callers can keep the
// static thumbnail without any try/catch noise.
function ensurePreviewApi(){
    if(typeof YT !== "undefined" && YT && YT.Player){
        return Promise.resolve();
    }
    if(previewApiLoading){
        if(ensurePreviewApi._pending){
            return ensurePreviewApi._pending;
        }
        return Promise.reject(new Error("YouTube IFrame API is loading"));
    }

    previewApiLoading = true;

    const pending = new Promise((resolve, reject) => {
        // A prior page-level callback may already be queued; chain rather than
        // clobber it, because watch.js also uses `onYouTubeIframeAPIReady`.
        const prior = window.onYouTubeIframeAPIReady;

        window.onYouTubeIframeAPIReady = function(){
            previewApiLoading = false;
            ensurePreviewApi._pending = null;
            if(typeof prior === "function"){
                try{
                    prior();
                }
                catch(e){ /* a page-level callback must not break previews */ }
            }
            resolve();
        };

        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.async = true;
        tag.onerror = function(){
            // Let a later hover retry rather than caching the failure forever.
            previewApiLoading = false;
            ensurePreviewApi._pending = null;
            reject(new Error("YouTube IFrame API failed to load"));
        };
        document.head.appendChild(tag);
    });

    ensurePreviewApi._pending = pending;
    return pending;
}
ensurePreviewApi._pending = null;

// The single persistent preview overlay, created on first use and then MOVED
// between thumbnails. The iframe inside it is never destroyed while the page
// lives, so the shared player stays attached to a live element.
let previewOverlay = null;

// Build the overlay once. It is absolutely positioned and clipped by CSS, so
// re-parenting it into any `.thumb` keeps the preview inside that card's box.
function ensureOverlay(){
    if(previewOverlay){
        return previewOverlay;
    }
    const overlay = document.createElement("div");
    overlay.className = "thumb-preview";
    overlay.setAttribute("aria-hidden", "true");

    const target = document.createElement("div");
    overlay.appendChild(target);

    previewOverlay = { overlay, target };
    return previewOverlay;
}

function clearPendingStart(){
    if(pendingStartTimer !== null){
        clearTimeout(pendingStartTimer);
        pendingStartTimer = null;
    }
}

function clearPendingStop(){
    if(pendingStopTimer !== null){
        clearTimeout(pendingStopTimer);
        pendingStopTimer = null;
    }
}

// Detach the shared overlay from whichever thumbnail currently holds it. The
// overlay (and the player inside it) survives, so the next hover is cheap.
function clearOverlay(){
    if(previewOverlay && previewOverlay.overlay.parentNode){
        previewOverlay.overlay.parentNode.removeChild(previewOverlay.overlay);
    }
    activeThumb = null;
    activeSourceId = "";
}

// Stop playback and tear the preview down. The shared player itself is kept
// (recreating it per hover is wasteful and leaks listeners), but it is muted,
// paused, and blanked so nothing continues in the background.
function stopHoverPreview(){
    clearPendingStart();
    clearPendingStop();

    if(previewPlayer){
        try{
            previewPlayer.stopVideo();
        }
        catch(e){ /* player may already be torn down */ }
    }

    clearOverlay();
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

// Attach hover-preview behaviour to a thumbnail element. `videoId` is the card's
// namespaced id (`yt:<videoId>`). This only wires listeners; nothing is fetched
// or created until a qualifying hover actually happens.
function attachHoverPreview(thumb, videoId){
    if(!thumb || !videoId){
        return;
    }

    const sourceId = hoverPreviewSourceId(videoId);
    if(!sourceId){
        return;
    }

    // Mark the element so the test suite (and future CSS) can see the feature
    // is wired, without changing any existing class or layout.
    thumb.classList.add("has-hover-preview");

    thumb.addEventListener("mouseenter", (event) => {
        if(event && event.pointerType && event.pointerType !== "mouse"){
            return;
        }
        sawPointerEvent = true;
        if(!hoverPreviewEnabled()){
            return;
        }
        scheduleHoverPreview(thumb, sourceId);
    });

    // mouseleave is the single teardown path: it cancels the pending start (so
    // a quick pass-through never starts a preview) and stops any live preview.
    thumb.addEventListener("mouseleave", () => {
        stopHoverPreview();
    });
}

// Wait out the intent delay, then start the preview. Any earlier pending start
// for a different card is abandoned first, which keeps "one player at a time".
function scheduleHoverPreview(thumb, sourceId){
    if(!sawPointerEvent){
        return;
    }

    // A different card was hovered while one was pending/live: move over.
    if(activeThumb && activeThumb !== thumb){
        stopHoverPreview();
    }

    clearPendingStart();

    pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        startHoverPreview(thumb, sourceId);
    }, HOVER_PREVIEW_DELAY_MS);
}

// Create/reuse the shared player and begin muted playback inside `thumb`.
function startHoverPreview(thumb, sourceId){
    // Re-check the gate: preferences or pointer type may have changed, or the
    // pointer may have left during the async API load below.
    if(!hoverPreviewEnabled() || !thumb.isConnected){
        return;
    }

    activeThumb = thumb;
    activeSourceId = sourceId;

    ensurePreviewApi().then(() => {
        // The hover may have ended (or moved on) while the script loaded.
        if(activeThumb !== thumb || !thumb.isConnected){
            return;
        }

        const { overlay, target } = ensureOverlay();

        // Move the persistent overlay into the hovered thumbnail. The player
        // (if any) rides along, so it is never detached from the document.
        if(overlay.parentNode !== thumb){
            thumb.appendChild(overlay);
        }

        try{
            // Build the shared player exactly once. Every later hover just
            // re-points it at the new video id.
            if(!previewPlayer){
                previewPlayer = new YT.Player(target, {
                    videoId: sourceId,
                    playerVars: {
                        autoplay: 0,
                        controls: 0,
                        disablekb: 1,
                        modestbranding: 1,
                        playsinline: 1,
                        rel: 0,
                        mute: 1
                    },
                    events: {
                        onReady: () => {
                            previewReady = true;
                            // Play whatever is CURRENTLY active, not the id this
                            // player happened to be constructed with: the pointer
                            // may have moved to another card while YT was loading.
                            playActiveSource();
                        },
                        onError: () => {
                            // Private/removed/embed-blocked video: fall back to
                            // the static thumbnail rather than a broken player.
                            stopHoverPreview();
                        }
                    }
                });
                return;
            }

            // Reuse the warm player. `mute()` is called first and again after
            // the load command so audio can never leak, even momentarily.
            previewPlayer.mute();
            previewPlayer.loadVideoById(activeSourceId);
            previewPlayer.mute();
            previewPlayer.playVideo();
            armAutoStop();
        }
        catch(e){
            // Any API failure means "no preview"; never break the card.
            stopHoverPreview();
        }
    }).catch(() => {
        // API unavailable — keep the static thumbnail, already visible.
        stopHoverPreview();
    });
}

// Called once the fresh player reports ready. The muted flags are set here and
// again on every reuse, so playback is silent from the first frame.
function playActiveSource(){
    if(!previewPlayer || activeThumb === null || !previewReady){
        return;
    }
    try{
        previewPlayer.mute();
        // Re-point at whatever is currently hovered; the pointer may have moved
        // to a different card while the API/player was initialising.
        if(activeSourceId){
            previewPlayer.loadVideoById(activeSourceId);
            previewPlayer.mute();
        }
        previewPlayer.playVideo();
        armAutoStop();
    }
    catch(e){
        stopHoverPreview();
    }
}

// Park the preview after a few seconds so a forgotten pointer does not stream
// endlessly. Cancelled by any mouseleave.
function armAutoStop(){
    clearPendingStop();
    pendingStopTimer = setTimeout(() => {
        pendingStopTimer = null;
        if(activeThumb === null){
            return;
        }
        try{
            if(previewPlayer){
                previewPlayer.pauseVideo();
            }
        }
        catch(e){ /* ignore */ }
        clearOverlay();
    }, HOVER_PREVIEW_MAX_MS);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

// A hidden tab must not keep playing. This is intentionally passive: it stops
// previews, it does not start them.
if(typeof document !== "undefined" && typeof document.addEventListener === "function"){
    document.addEventListener("visibilitychange", () => {
        if(document.hidden){
            stopHoverPreview();
        }
    });
}

export {
    attachHoverPreview,
    hoverPreviewEnabled,
    hoverPreviewSourceId,
    HOVER_PREVIEW_DELAY_MS,
    HOVER_PREVIEW_MAX_MS
};
