// ================= CONNECTED YOUTUBE ACCOUNT IDENTITY =================
// Read-only helper shared by the profile, watch, channel and subscriptions
// pages. It fetches the channel that belongs to the signed-in user's existing
// OAuth grant through GET /api/youtube/account and never selects an account.
//
// The state is intentionally not persisted: a reconnect, disconnect, sign-out
// or authorization failure clears it, and a fresh page load re-reads it from
// the grant. When YouTube returns more than one channel the state is "multiple"
// and callers must block YouTube mutations until the user resolves it.

import { youtubeAccount } from "./youtube.js";

const IDENTITY_TTL_MS = 60 * 1000;
const GRANT_CHANGE_EVENT = "mytube-youtube-grant-change";
const GRANT_CHANGE_CHANNEL = "mytube-youtube-grant";
const GRANT_CHANGE_STORAGE_KEY = "mytube-youtube-grant-change";
let grantChangeChannel = null;
let grantChangeChannelReady = false;

function getGrantChangeChannel(){
  if(typeof window === "undefined" || typeof window.BroadcastChannel !== "function"){
    return null;
  }
  if(!grantChangeChannelReady){
    grantChangeChannelReady = true;
    try{ grantChangeChannel = new window.BroadcastChannel(GRANT_CHANGE_CHANNEL); }
    catch(e){ grantChangeChannel = null; }
  }
  return grantChangeChannel;
}

// Cross-tab signal only. No tokens, credentials or channel identity are written
// to BroadcastChannel or localStorage; every receiver re-reads the grant itself.
export function broadcastYoutubeGrantChange(){
  if(typeof window === "undefined"){
    return;
  }
  try{ window.dispatchEvent(new CustomEvent(GRANT_CHANGE_EVENT)); }
  catch(e){}
  const channel = getGrantChangeChannel();
  if(channel){
    try{ channel.postMessage({ type: "grant-change" }); }
    catch(e){}
  }
  try{
    const nonce = String(Date.now()) + ":" + Math.random().toString(36).slice(2);
    window.localStorage.setItem(GRANT_CHANGE_STORAGE_KEY, nonce);
  }
  catch(e){}
}

export function onYoutubeGrantChange(handler){
  if(typeof window === "undefined" || typeof handler !== "function"){
    return () => {};
  }
  let lastAt = 0;
  const fire = (source) => {
    const now = Date.now();
    if(now - lastAt < 50){
      return;
    }
    lastAt = now;
    try{ handler(source); }
    catch(e){}
  };
  const onCustom = () => fire("document");
  const onMessage = (event) => {
    if(event && event.data && event.data.type === "grant-change"){
      fire("broadcast");
    }
  };
  const onStorage = (event) => {
    if(event && event.key === GRANT_CHANGE_STORAGE_KEY){
      fire("storage");
    }
  };
  window.addEventListener(GRANT_CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  const channel = getGrantChangeChannel();
  if(channel){
    channel.addEventListener("message", onMessage);
  }
  return () => {
    window.removeEventListener(GRANT_CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
    if(channel){
      channel.removeEventListener("message", onMessage);
    }
  };
}

export function createYoutubeAccountIdentity(options = {}){
  const getUid = typeof options.getUid === "function" ? options.getUid : () => "";
  const getToken = typeof options.getToken === "function" ? options.getToken : async () => null;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};

  const state = {
    seq: 0,
    uid: "",
    status: "idle", // idle | loading | ready | none | multiple | signed_out | disconnected | error
    channel: null,  // { id, title, thumbnail } only when status === "ready"
    channels: [],
    multiple: false,
    lastError: "",
    fetchedAt: 0
  };

  function notify(){
    try{ onChange(state); } catch(e){ /* rendering must never break auth flow */ }
  }

  function clear(status = "idle"){
    state.seq += 1;
    state.uid = "";
    state.status = status;
    state.channel = null;
    state.channels = [];
    state.multiple = false;
    state.lastError = "";
    state.fetchedAt = 0;
    notify();
  }

  function currentUid(){
    return String(getUid() || "");
  }

  async function load(opts = {}){
    const force = opts.force === true;
    const uid = currentUid();

    if(!uid){
      clear("signed_out");
      return state;
    }

    const now = Date.now();
    if(
      !force
      && state.uid === uid
      && state.status === "ready"
      && now - state.fetchedAt < IDENTITY_TTL_MS
    ){
      return state;
    }
    if(state.uid === uid && state.status === "loading"){
      return state;
    }

    const seq = ++state.seq;
    state.uid = uid;
    state.status = "loading";
    state.channel = null;
    state.channels = [];
    state.multiple = false;
    state.lastError = "";
    notify();

    let result;
    try{
      const token = await getToken();
      if(!token){
        result = { ok: false, status: 401, code: "UNAUTHENTICATED", body: null };
      }
      else{
        result = await youtubeAccount(token);
      }
    }
    catch(e){
      result = { ok: false, status: 0, code: "UPSTREAM_ERROR", body: null };
    }

    // Only the owning request may settle; auth/account changes supersede it.
    if(seq !== state.seq || currentUid() !== uid){
      return state;
    }

    const body = result && result.body ? result.body : {};
    const code = String((result && result.code) || body.code || "");
    state.fetchedAt = Date.now();

    if(result && result.ok && body.ok === true && body.connected === true && body.channel && body.channel.id){
      state.status = "ready";
      state.channel = {
        id: String(body.channel.id),
        title: String(body.channel.title || ""),
        thumbnail: String(body.channel.thumbnail || "")
      };
      state.channels = Array.isArray(body.channels) && body.channels.length
        ? body.channels
        : [state.channel];
      state.multiple = false;
      state.lastError = "";
    }
    else if(result && result.ok && body.ok === true && body.multiple === true){
      state.status = "multiple";
      state.channel = null;
      state.channels = Array.isArray(body.channels) ? body.channels : [];
      state.multiple = true;
      state.lastError = "";
    }
    else if(result && result.ok && body.ok === true && code === "NO_YOUTUBE_CHANNEL"){
      state.status = "none";
      state.channel = null;
      state.channels = [];
      state.multiple = false;
      state.lastError = "";
    }
    else if(result && (result.status === 401 || code === "UNAUTHENTICATED")){
      state.status = "signed_out";
      state.channel = null;
      state.channels = [];
      state.multiple = false;
      state.lastError = "";
    }
    else if(code === "YOUTUBE_NOT_CONNECTED" || code === "YOUTUBE_SCOPE_REQUIRED" || code === "YOUTUBE_REAUTH_REQUIRED"){
      state.status = "disconnected";
      state.channel = null;
      state.channels = [];
      state.multiple = false;
      state.lastError = "";
    }
    else{
      state.status = "error";
      state.channel = null;
      state.channels = [];
      state.multiple = false;
      state.lastError = (body && body.error)
        ? String(body.error)
        : "Could not identify your connected YouTube account.";
    }

    notify();
    return state;
  }

  function label(){
    return state.status === "ready" && state.channel && state.channel.title
      ? state.channel.title
      : "";
  }

  // Mutations are unsafe when the grant maps to no channel or to more than one
  // channel: the API has no way to choose one without another OAuth decision.
  function isBlocked(){
    return state.status === "multiple"
      || state.status === "none"
      || state.multiple === true
      || (Array.isArray(state.channels) && state.channels.length > 1);
  }

  function isFresh(){
    return state.status === "ready"
      && state.fetchedAt > 0
      && (Date.now() - state.fetchedAt) < IDENTITY_TTL_MS;
  }

  // Stricter gate for actual writes: only a verified, fresh, single channel
  // owned by the current Firebase user may act.
  function canMutate(){
    const uid = currentUid();
    return isFresh()
      && Boolean(uid)
      && state.uid === uid
      && Boolean(state.channel && state.channel.id)
      && state.multiple !== true
      && (!Array.isArray(state.channels) || state.channels.length <= 1);
  }

  // Capture the identity the user is currently shown. A mutation must still
  // match this after an immediate refresh, otherwise the grant changed.
  function mutationGuard(){
    return {
      uid: state.status === "ready" ? String(state.uid || "") : "",
      channelId: state.status === "ready" && state.channel && state.channel.id
        ? String(state.channel.id)
        : ""
    };
  }

  // Force-refresh immediately before a write and require the same user and
  // channel. This is defense in depth: the backend independently re-verifies
  // the expected channel against the current grant.
  async function verifyForMutation(expected){
    const exp = expected || {};
    const expectedUid = String(exp.uid || "");
    const expectedChannelId = String(exp.channelId || "");
    if(!expectedUid || !expectedChannelId){
      return { ok: false, reason: "unverified" };
    }
    await load({ force: true });
    if(currentUid() !== expectedUid || state.uid !== expectedUid){
      return { ok: false, reason: "changed" };
    }
    if(!canMutate()){
      return { ok: false, reason: "unverified" };
    }
    if(!state.channel || String(state.channel.id) !== expectedChannelId){
      return { ok: false, reason: "changed" };
    }
    return { ok: true, uid: expectedUid, channelId: expectedChannelId };
  }

  function mutationFailureMessage(reason){
    if(reason === "changed"){
      return "Your connected YouTube channel changed. Reconnect your YouTube account using the intended channel and try again.";
    }
    return identityMessage() || "Could not verify your connected YouTube channel. Reload the page and try again.";
  }

  function blockedMessage(){
    if(
      state.status === "multiple"
      || state.multiple === true
      || (Array.isArray(state.channels) && state.channels.length > 1)
    ){
      return "Multiple YouTube channels are available for this Google account. Reconnect your YouTube account using the intended channel before using YouTube actions.";
    }
    if(state.status === "none"){
      return "This Google account has no YouTube channel.";
    }
    return "";
  }

  function identityMessage(){
    if(isBlocked()){
      return blockedMessage();
    }
    if(state.status === "ready"){
      return canMutate()
        ? ""
        : "Your connected YouTube account needs to be re-verified. Reload the page and try again.";
    }
    if(state.status === "signed_out"){
      return "Sign in to use YouTube actions.";
    }
    if(state.status === "disconnected"){
      return "Connect your YouTube account in Profile to use YouTube actions.";
    }
    if(state.status === "error"){
      return state.lastError || "Could not identify your connected YouTube account.";
    }
    return "Checking connected YouTube account before using YouTube actions...";
  }

  return {
    state,
    load,
    clear,
    label,
    isBlocked,
    canMutate,
    mutationGuard,
    verifyForMutation,
    mutationFailureMessage,
    blockedMessage,
    identityMessage
  };
}
