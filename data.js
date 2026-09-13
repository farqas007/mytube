// ================= FIRESTORE DATA LAYER =================
// Central module for all Firestore CRUD operations.
// Every document path is scoped to the authenticated user: users/{uid}/...
// When the user is not logged in, callers fall back to localStorage.

import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
  onSnapshot,
  writeBatch
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";


// ================= HELPERS =================

function userCollection(uid, name){
  return collection(db, "users", uid, name);
}

function userDocRef(uid, col, docId){
  return doc(db, "users", uid, col, docId);
}

function safeId(str){
  return (str || "unknown").replace(/[\/\.\#\$\[\]]/g, "_");
}


// ================= SUBSCRIPTIONS =================
// Document path: users/{uid}/subscriptions/{channelKey}
// channelKey = channelId (for YouTube) or safeId(channelName) (for local)

function subKey(channelId, channelName){
  if(channelId){
    return channelId;
  }
  return safeId(channelName);
}

export async function getSubscriptions(uid){
  try{
    const snap = await getDocs(userCollection(uid, "subscriptions"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getSubscriptions failed:", e);
    return [];
  }
}

export async function addSubscription(uid, sub){
  try{
    const key = subKey(sub.channelId, sub.channelName);
    await setDoc(userDocRef(uid, "subscriptions", key), {
      channelId: sub.channelId || "",
      channelName: sub.channelName || "",
      channelThumb: sub.channelThumb || "",
      subscriberCount: sub.subscriberCount || "",
      subscribedAt: serverTimestamp()
    });
    return true;
  }
  catch(e){
    console.warn("Firestore addSubscription failed:", e);
    return false;
  }
}

export async function removeSubscription(uid, channelId, channelName){
  try{
    const key = subKey(channelId, channelName);
    await deleteDoc(userDocRef(uid, "subscriptions", key));
    return true;
  }
  catch(e){
    console.warn("Firestore removeSubscription failed:", e);
    return false;
  }
}

export async function isSubscribedByChannel(uid, channelId, channelName){
  try{
    const key = subKey(channelId, channelName);
    const snap = await getDoc(userDocRef(uid, "subscriptions", key));
    return snap.exists();
  }
  catch(e){
    console.warn("Firestore isSubscribedByChannel failed:", e);
    return null;
  }
}


// ================= WATCH HISTORY =================
// Document path: users/{uid}/history/{videoKey}
// Updated (not duplicated) on each view — setDoc with merge:true.

export async function getHistory(uid, maxCount){
  try{
    const q = query(
      userCollection(uid, "history"),
      orderBy("timestamp", "desc"),
      limit(maxCount || 50)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getHistory failed:", e);
    return [];
  }
}

export async function addToHistory(uid, entry){
  try{
    const docId = safeId(entry.videoId || entry.id);
    await setDoc(userDocRef(uid, "history", docId), {
      videoId: entry.videoId || entry.id,
      type: entry.type || "local",
      title: entry.title || "",
      thumb: entry.thumb || "",
      channel: entry.channel || "",
      duration: entry.duration || "",
      progress: entry.progress || 0,
      timestamp: serverTimestamp()
    }, { merge: true });
    return true;
  }
  catch(e){
    console.warn("Firestore addToHistory failed:", e);
    return false;
  }
}

export async function removeFromHistory(uid, videoId){
  try{
    await deleteDoc(userDocRef(uid, "history", safeId(videoId)));
    return true;
  }
  catch(e){
    console.warn("Firestore removeFromHistory failed:", e);
    return false;
  }
}

export async function clearHistory(uid){
  try{
    const snap = await getDocs(userCollection(uid, "history"));
    if(snap.empty){
      return true;
    }
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return true;
  }
  catch(e){
    console.warn("Firestore clearHistory failed:", e);
    return false;
  }
}


// ================= SAVED / WATCH LATER =================
// Document path: users/{uid}/saved/{videoKey}

export async function getSaved(uid){
  try{
    const q = query(
      userCollection(uid, "saved"),
      orderBy("savedAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getSaved failed:", e);
    return [];
  }
}

export async function addToSaved(uid, entry){
  try{
    const docId = safeId(entry.videoId || entry.id);
    await setDoc(userDocRef(uid, "saved", docId), {
      videoId: entry.videoId || entry.id,
      type: entry.type || "local",
      title: entry.title || "",
      thumb: entry.thumb || "",
      channel: entry.channel || "",
      views: entry.views || "",
      duration: entry.duration || "",
      savedAt: serverTimestamp()
    });
    return true;
  }
  catch(e){
    console.warn("Firestore addToSaved failed:", e);
    return false;
  }
}

export async function removeFromSaved(uid, videoId){
  try{
    await deleteDoc(userDocRef(uid, "saved", safeId(videoId)));
    return true;
  }
  catch(e){
    console.warn("Firestore removeFromSaved failed:", e);
    return false;
  }
}

export async function isSavedVideo(uid, videoId){
  try{
    const key = safeId(videoId);
    const snap = await getDoc(userDocRef(uid, "saved", key));
    return snap.exists();
  }
  catch(e){
    console.warn("Firestore isSavedVideo failed:", e);
    return null;
  }
}


// ================= LIKED VIDEOS =================
// Document path: users/{uid}/liked/{videoKey}

export async function getLiked(uid){
  try{
    const q = query(
      userCollection(uid, "liked"),
      orderBy("likedAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getLiked failed:", e);
    return [];
  }
}

export async function addToLiked(uid, entry){
  try{
    const docId = safeId(entry.videoId || entry.id);
    await setDoc(userDocRef(uid, "liked", docId), {
      videoId: entry.videoId || entry.id,
      type: entry.type || "local",
      title: entry.title || "",
      thumb: entry.thumb || "",
      channel: entry.channel || "",
      views: entry.views || "",
      duration: entry.duration || "",
      likeCount: entry.likeCount || 0,
      likedAt: serverTimestamp()
    });
    return true;
  }
  catch(e){
    console.warn("Firestore addToLiked failed:", e);
    return false;
  }
}

export async function removeFromLiked(uid, videoId){
  try{
    await deleteDoc(userDocRef(uid, "liked", safeId(videoId)));
    return true;
  }
  catch(e){
    console.warn("Firestore removeFromLiked failed:", e);
    return false;
  }
}

export async function isLikedVideo(uid, videoId){
  try{
    const key = safeId(videoId);
    const snap = await getDoc(userDocRef(uid, "liked", key));
    return snap.exists();
  }
  catch(e){
    console.warn("Firestore isLikedVideo failed:", e);
    return null;
  }
}


// ================= PLAYLISTS =================
// Playlist metadata:  users/{uid}/playlists/{playlistId}
// Playlist items:     users/{uid}/playlistItems/{playlistId}/{videoKey}
// Item doc ids are stable per video (safeId(videoId)), so adding the same
// video twice updates the same document instead of creating duplicates.

function playlistItemsCol(uid, playlistId){
  return collection(db, "users", uid, "playlistItems", playlistId);
}

function playlistItemRef(uid, playlistId, videoKey){
  return doc(db, "users", uid, "playlistItems", playlistId, safeId(videoKey));
}

export async function getPlaylists(uid){
  try{
    const q = query(
      userCollection(uid, "playlists"),
      orderBy("createdAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getPlaylists failed:", e);
    return [];
  }
}

export async function createPlaylist(uid, name){
  try{
    const clean = String(name || "").trim();
    if(!clean){
      return null;
    }
    const playlistId = "pl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    await setDoc(userDocRef(uid, "playlists", playlistId), {
      name: clean.slice(0, 80),
      createdAt: serverTimestamp()
    });
    return playlistId;
  }
  catch(e){
    console.warn("Firestore createPlaylist failed:", e);
    return null;
  }
}

export async function deletePlaylist(uid, playlistId){
  try{
    const itemsSnap = await getDocs(playlistItemsCol(uid, playlistId));
    const batch = writeBatch(db);
    itemsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(userDocRef(uid, "playlists", playlistId));
    await batch.commit();
    return true;
  }
  catch(e){
    console.warn("Firestore deletePlaylist failed:", e);
    return false;
  }
}

export async function getPlaylistItems(uid, playlistId){
  try{
    const q = query(
      playlistItemsCol(uid, playlistId),
      orderBy("addedAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  catch(e){
    console.warn("Firestore getPlaylistItems failed:", e);
    return [];
  }
}

export async function addToPlaylist(uid, playlistId, entry){
  try{
    const docId = safeId(entry.videoId || entry.id);
    await setDoc(playlistItemRef(uid, playlistId, docId), {
      videoId: entry.videoId || entry.id,
      type: entry.type || "local",
      title: entry.title || "",
      thumb: entry.thumb || "",
      channel: entry.channel || "",
      views: entry.views || "",
      duration: entry.duration || "",
      addedAt: serverTimestamp()
    });
    return true;
  }
  catch(e){
    console.warn("Firestore addToPlaylist failed:", e);
    return false;
  }
}

export async function removeFromPlaylist(uid, playlistId, videoId){
  try{
    await deleteDoc(playlistItemRef(uid, playlistId, videoId));
    return true;
  }
  catch(e){
    console.warn("Firestore removeFromPlaylist failed:", e);
    return false;
  }
}

export async function isInPlaylist(uid, playlistId, videoId){
  try{
    const snap = await getDoc(playlistItemRef(uid, playlistId, videoId));
    return snap.exists();
  }
  catch(e){
    console.warn("Firestore isInPlaylist failed:", e);
    return null;
  }
}


// ================= COMMENTS =================
// Collection: comments/{doc} — one doc per comment, shared across all users
// (public reads; only the authenticated owner may create/update/delete).
// `createdAt` is a client-side Timestamp so order sortable without a composite
// index (where + client sort keeps the query simple).

function commentsCollection(){
  return collection(db, "comments");
}

function tsToMs(t){
  if(!t){
    return 0;
  }
  if(typeof t === "number"){
    return t;
  }
  if(typeof t.toMillis === "function"){
    return t.toMillis();
  }
  if(typeof t.seconds === "number"){
    return t.seconds * 1000;
  }
  return 0;
}

// Live-subscribe to comments for one video. `callback(list)` is called with the
// array of comments (normalized to the localStorage shape, newest first). If the
// subscription fails (disconnected, rules/permissions) `callback(null)` fires so
// callers can fall back to localStorage. Returns the onSnapshot unsubscribe.
export function subscribeComments(videoIdKey, callback){
  const q = query(
    commentsCollection(),
    where("videoId", "==", videoIdKey)
  );
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map(d => ({
      id: d.id,
      userId: d.data().userId || "",
      author: d.data().author || "User",
      text: d.data().text || "",
      timestamp: tsToMs(d.data().createdAt)
    }));
    list.sort((a, b) => b.timestamp - a.timestamp);
    callback(list);
  }, (err) => {
    console.warn("Firestore subscribeComments failed:", err);
    callback(null);
  });
}

// Create a comment owned by the caller. Returns the new doc id, or null on error.
export async function addCommentToStore(videoIdKey, comment){
  try{
    const ref = doc(commentsCollection());
    await setDoc(ref, {
      videoId: videoIdKey,
      userId: comment.userId,
      author: comment.author || "User",
      text: comment.text,
      createdAt: Timestamp.now()
    });
    return ref.id;
  }
  catch(e){
    console.warn("Firestore addComment failed:", e);
    return null;
  }
}

// Delete a comment the caller owns. Returns true on success.
export async function removeCommentById(commentId){
  try{
    await deleteDoc(doc(commentsCollection(), commentId));
    return true;
  }
  catch(e){
    console.warn("Firestore removeComment failed:", e);
    return false;
  }
}
